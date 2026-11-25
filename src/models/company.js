import { create, read, updateSettings, write } from '../orm.js';
import { fiscalPositionFor, lineTaxOf, productTax, taxAmount, taxGroups, taxSnapshot } from './taxes.js';
import { DEFERRED_COMPUTATION_OPTIONS, DEFERRED_EXPENSE_GENERATION_OPTIONS, DEFERRED_PERIODICITY_OPTIONS, DEFERRED_REVENUE_GENERATION_OPTIONS, mapLegacyDeferredGenerationMethod, normalizeDeferredComputationMethod, postCompanyDeferrals } from './deferred.js';
import { companyRoundingMethod, today, validDate } from './common.js';
import { companyCurrencyRecord, documentCurrency } from '../money.js';
import { ensureReturnTypes } from './taxreturn.js';
import { ensureStatementReports } from './statementReports.js';
import { defaultPayrollRules } from './payroll.js';
import { STOCK_CHART_ROLES } from './stock-accounts.js';
import { returnCompanies, returnTaxLock } from './finance.js';
import { TAX_RETURN_TEMPLATE_OPTIONS } from './taxTemplates.js';
import { LOCK_DATE_FIELDS } from './auditRules.js';
import { refreshDraftEntryTaxes, taxUnitCompatibilityError } from './accounting.js';
import { fiscalYearStart } from './ledger.js';

// Integration: initialize with ensureMainCompany(seed()) so existing partner/currency IDs stay stable.
// After Confirm returns its new database, call interCompanyRules(next, saleId).
// Apply companyFilter to list data and many2one candidates before rendering.
// A switcher needs active res.company records, a current ID and checked allowed IDs; persist setCompanies' result.
// The legacy ORM lacks database-aware defaults/create hooks: use createForCompany and createCompany until extended.
// Keep its process-global setActiveCompany(null) when using allowed-company filtering.

const scoped = new Set(['account.budget', 'account.fiscal.category', 'account.report', 'account.report.horizontal.group', 'account.partial.reconcile', 'sale.order', 'purchase.order', 'account.move', 'account.payment', 'account.payment.method.line', 'account.journal', 'account.online.link', 'account.online.account', 'account.asset', 'payment.transaction', 'stock.picking', 'stock.quant', 'stock.warehouse.orderpoint', 'hr.employee', 'project.project', 'crm.lead', 'helpdesk.ticket', 'product']);
// Mirrors the ORM's shared master data (importing SHARED_MODELS here would be circular: orm.js loads this registry).
const sharedScoped = new Set(['product', 'account.journal']);
const companyField = { type: 'many2one', relation: 'res.company', label: 'Company' };
const record = (db, model, id) => (db.records[model] ?? []).find((r) => r.id === id);
const shared = (id) => id == null || id === false || id === '';

/** Current company ID, defaulting to the main company before initialization. */
export const currentCompany = (db) => db.settings?.current_company_id ?? 1;

/** Resolve the company for a document or a single-company batch without consulting the active UI company. */
export function documentCompany(db, document) {
  if (!document) return null;
  let companyIds;
  if (document.company_id != null) {
    companyIds = new Set([document.company_id]);
  } else if (Array.isArray(document.lines)) {
    companyIds = new Set(document.lines.map((line) => {
      const move = line.move_id ? read(db, 'account.move', line.move_id) : null;
      const payment = line.payment_id ? read(db, 'account.payment', line.payment_id) : null;
      return move?.company_id ?? payment?.company_id ?? 1;
    }));
  } else {
    companyIds = new Set([1]);
  }
  if (companyIds.size !== 1) return null;
  const company = read(db, 'res.company', [...companyIds][0]);
  if (!company) return null;
  const currency = company.currency_id ? read(db, 'res.currency', company.currency_id) : null;
  return { ...company, currency: currency?.name ?? null };
}

/** Postal address lines for a company or contact, in print order; blank parts are omitted. */
export function addressLines(record, taxIdLabel = 'Tax ID') {
  if (!record) return [];
  return [
    record.street,
    [record.zip, record.city].filter(Boolean).join(' '),
    record.country,
    record.vat ? `${taxIdLabel}: ${record.vat}` : '',
  ].filter(Boolean);
}

/**
 * Per-tax base and amount for a document's lines, from their stored tax snapshots.
 * Shared by the printed document and the emailed copy so both show the same detail.
 */
export function documentTaxBreakdown(db, record, lines = []) {
  const currency = documentCurrency(db, record);
  return taxGroups(lines, () => null, 1, currency, currency, { roundingMethod: companyRoundingMethod(db, record?.company_id) })
    .map(({ invoice_label, tax_name, base, amount }) => ({ label: invoice_label || tax_name, base, amount }));
}

/** Select active companies without changing the caller's database or selection. */
export function setCompanies(db, { current, allowed }) {
  if (!Array.isArray(allowed) || !allowed.length || !allowed.includes(current)) throw new Error('Select at least one company including the current company');
  const ids = [...new Set(allowed)];
  if (ids.some((id) => !Number.isInteger(id) || !record(db, 'res.company', id) || record(db, 'res.company', id).active === false)) throw new Error('Select existing active companies');
  return updateSettings(db, { current_company_id: current, allowed_company_ids: ids });
}

// Configuration is shared even when older ORM versions stamped it with company 1.
// Accounting configuration belongs to its company; other configuration is readable across companies.
const COMPANY_CONFIG = new Set(['account.tax', 'account.payment.term', 'account.fiscal.position', 'account.cash.rounding', 'account.analytic.account']);
const CONFIG_MODELS = new Set(['account.tax', 'uom.category', 'uom.uom', 'product.packaging', 'account.payment.term', 'account.fiscal.position', 'delivery.carrier', 'crm.team', 'hr.payroll.structure', 'hr.payslip.input.type', 'product.public.category',
  'account.incoterm', 'account.account.tag', 'account.asset.model', 'account.cash.rounding', 'account.analytic.plan', 'account.analytic.account', 'account.payment.method', 'res.country.group', 'res.partner.category']);
// Mirrors the ORM's shared master data (see orm.js SHARED_MODELS): only these may have no company.
const SHARED_MODELS = new Set(['res.bank', 'res.partner', 'res.partner.category', 'product', 'account.account', 'account.journal', 'res.currency', 'product.pricelist', 'discuss.channel',
  'mail.activity', 'hr.department', 'website.page', 'mailing.list', 'mailing.contact', 'lunch.product', 'room.room', 'appointment.type', ...CONFIG_MODELS]);
/** Group-wide reports hold every company's figures, so only users without a company limit may use them. */
const GROUP_WIDE = new Set(['consolidation.chart', 'consolidation.period']);

/**
 * Whether a user limited to the `companies` ids (null = every company) may see or change this record: companies by
 * their own id; shared master data without a company; anything else when its company (missing = company 1, as in the
 * ORM) is one of those companies. Pass `db` to also hide the contact record of a company the user may not use.
 */
export function visibleTo(companies, model, r, db = null) {
  if (!companies) return true;
  if (model === 'res.company') return companies.has(r?.id);
  if (GROUP_WIDE.has(model)) return false;
  if (CONFIG_MODELS.has(model)) return !COMPANY_CONFIG.has(model) || shared(r?.company_id) || companies.has(r?.company_id);
  if (model === 'res.partner' && db && r && (db.records['res.company'] ?? []).some((c) => c.partner_id === r.id && !companies.has(c.id))) return false;
  if (shared(r?.company_id)) return SHARED_MODELS.has(model) || companies.has(1);
  return companies.has(r.company_id);
}

export const NESTED_COMPANY_FIELDS = {
  'account.journal': ['secure_chain_heads'],
  'res.partner': ['followup_lines'],
  'consolidation.chart': ['company_ids'],
  'consolidation.period': ['rate_ids'],
};

const nestedCompany = (model, field, line) => line?.company_id ?? (line && model === 'res.partner' && field === 'followup_lines' ? 1 : null);

/**
 * Scopes nested per-company arrays within a record:
 * - When reading (write=false): filters nested arrays to only entries belonging to allowed companies.
 * - When writing (write=true): rejects writes that include entries for foreign companies, and preserves hidden entries from `prior`.
 */
export function scopeNestedCompanyArrays(model, rec, companies, { prior = null, submitted = null, write = false } = {}) {
  const fields = NESTED_COMPANY_FIELDS[model];
  if (!companies || !fields || !rec) return rec;

  if (write) {
    const checkSource = submitted ?? rec;
    for (const field of fields) {
      if (submitted && !(field in submitted)) continue;
      const lines = checkSource[field];
      if (Array.isArray(lines)) {
        for (const line of lines) {
          const company = nestedCompany(model, field, line);
          if (company != null && !companies.has(company)) {
            throw new Error(`No access to this company's ${model} records`);
          }
        }
      }
    }

    if (prior) {
      for (const field of fields) {
        if (Array.isArray(prior[field])) {
          const hidden = prior[field].filter((line) => nestedCompany(model, field, line) != null && !companies.has(nestedCompany(model, field, line)));
          if (hidden.length) {
            const userLines = Array.isArray(rec[field])
              ? rec[field].filter((line) => companies.has(nestedCompany(model, field, line)))
              : (prior[field] ?? []).filter((line) => companies.has(nestedCompany(model, field, line)));
            rec[field] = [...hidden, ...userLines];
          }
        }
      }
    }
    return rec;
  }

  let modified = false;
  const out = { ...rec };
  for (const field of fields) {
    if (Array.isArray(rec[field])) {
      out[field] = rec[field].filter((line) => companies.has(nestedCompany(model, field, line)));
      modified = true;
    }
  }
  return modified ? out : rec;
}

/**
 * Scopes an audit entry's changes dictionary: filters nested per-company arrays in old and new values.
 */
export function scopeAuditChanges(model, changes, companies) {
  if (!companies || !NESTED_COMPANY_FIELDS[model] || !changes) return changes;
  const oldVals = {};
  const newVals = {};
  for (const [k, v] of Object.entries(changes)) {
    if (Array.isArray(v) && v.length === 2) {
      oldVals[k] = v[0];
      newVals[k] = v[1];
    }
  }
  const scopedOld = scopeNestedCompanyArrays(model, oldVals, companies);
  const scopedNew = scopeNestedCompanyArrays(model, newVals, companies);
  const out = {};
  for (const [k, v] of Object.entries(changes)) {
    if (Array.isArray(v) && v.length === 2) {
      out[k] = [
        scopedOld[k] === undefined ? null : scopedOld[k],
        scopedNew[k] === undefined ? null : scopedNew[k],
      ];
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** A records view that filters each model to the user's companies only when that model is first read. */
export function lazyRestrictedRecords(db, companies) {
  const cache = new Map();
  const view = (model) => {
    if (!cache.has(model)) {
      const list = db.records[model];
      cache.set(model, list && list.filter((r) => visibleTo(companies, model, r, db)).map((r) => scopeNestedCompanyArrays(model, r, companies)));
    }
    return cache.get(model);
  };
  return new Proxy(db.records, {
    get: (target, model) => (typeof model === 'string' && Object.hasOwn(target, model) ? view(model) : target[model]),
    getOwnPropertyDescriptor: (target, model) => {
      const desc = Reflect.getOwnPropertyDescriptor(target, model);
      return desc && typeof model === 'string' ? { configurable: true, enumerable: desc.enumerable, writable: false, value: view(model) } : desc;
    },
  });
}

/** The records of `db` a user limited to `companies` may see (everything for null), and the `model:id` keys left out. */
export function restrictRecords(db, companies) {
  if (!companies) return { records: db.records, hidden: new Set() };
  const records = {};
  const hidden = new Set();
  for (const [model, list] of Object.entries(db.records)) {
    const filtered = list
      .filter((r) => visibleTo(companies, model, r, db))
      .map((r) => scopeNestedCompanyArrays(model, r, companies));
    records[model] = filtered;
    if (records[model].length < list.length) list.filter((r) => !visibleTo(companies, model, r, db)).forEach((r) => hidden.add(`${model}:${r.id}`));
  }
  return { records, hidden };
}

/** Keep shared records and records belonging to an allowed company. */
export function companyFilter(db, records, model = null) {
  const allowed = db.settings?.allowed_company_ids ?? [currentCompany(db)];
  if (CONFIG_MODELS.has(model)) return COMPANY_CONFIG.has(model) ? records.filter((r) => shared(r.company_id) || allowed.includes(r.company_id)) : records;
  return records.filter((r) => shared(r.company_id) || allowed.includes(r.company_id));
}

const RECIPIENT_BANK_FIELDS = {
  partner_bank_id: { type: 'many2one', relation: 'res.partner.bank', label: 'Recipient Bank Account' },
};

export function recipientBankCompanyError(db, record, company = record?.company_id ?? 1) {
  if (!record?.partner_bank_id) return null;
  return checkCompany(db, RECIPIENT_BANK_FIELDS, record, company);
}

function checkCompany(db, fields, r, company) {
  if (shared(company)) return null;
  for (const [key, field] of Object.entries(fields)) {
    if (field.type === 'one2many') {
      for (const line of r[key] ?? []) {
        const error = checkCompany(db, field.fields ?? {}, line, company);
        if (error) return error;
      }
    }
    if (field.type !== 'many2one' || !['res.partner', 'product', 'account.journal', 'res.partner.bank'].includes(field.relation)) continue;
    const linked = record(db, field.relation, r[key]);
    if (linked && !shared(linked.company_id) && linked.company_id !== company) return `${field.label}: select a record shared with or belonging to this company`;
  }
  return null;
}

/** Add company fields and consistency checks while preserving model behavior. */
export function withCompany(models) {
  return Object.fromEntries(Object.entries(models).map(([name, model]) => {
    if (!scoped.has(name)) return [name, model];
    const link = name === 'sale.order' ? { auto_purchase_id: { type: 'many2one', relation: 'purchase.order', label: 'Inter-Company Purchase', readonly: true } }
      : name === 'purchase.order' ? { auto_sale_id: { type: 'many2one', relation: 'sale.order', label: 'Inter-Company Sale', readonly: true } } : {};
    return [name, {
      ...model,
      fields: { ...model.fields, ...link, company_id: { ...companyField, ...model.fields.company_id, ...(sharedScoped.has(name) ? {} : { default: currentCompany }) } },
      defaults: sharedScoped.has(name) ? model.defaults : (id, db) => ({ ...model.defaults?.(id, db), company_id: db ? currentCompany(db) : 1 }),
      guard: (db, before, r, ctx, vals) => model.guard?.(db, before, r, ctx, vals) ?? checkCompany(db, model.fields, r, r.company_id),
    }];
  }));
}

// Accounting settings shown in General Settings are company controls and can only be changed by administrators over sync.
const CONTROL_FIELDS = [
  'lock_date', 'sale_lock_date', 'purchase_lock_date', 'tax_lock_date', 'hard_lock_date',
  'group_analytic_accounting', 'audit_trail', 'three_way_matching', 'autopost_bills', 'invoice_qr', 'quick_edit_mode', 'vat', 'company_iban', 'tax_periodicity', 'tax_start_date', 'tax_return_template',
  'fiscalyear_last_day', 'fiscalyear_last_month',
  'currency_provider', 'currency_interval_unit', 'currency_next_execution_date',
  'account_sale_tax_id', 'account_purchase_tax_id', 'account_price_include', 'tax_calculation_rounding_method', 'tax_cash_basis_journal_id',
  'currency_exchange_journal_id',
  'deferred_revenue_journal_id', 'deferred_expense_journal_id',
  'deferred_revenue_account_id', 'deferred_expense_account_id',
  'generate_deferred_revenue_entries_method', 'generate_deferred_expense_entries_method',
  'deferred_revenue_amount_computation_method', 'deferred_expense_amount_computation_method',
  'deferred_revenue_periodicity', 'deferred_expense_periodicity',
  'transfer_account_id', 'account_storno', 'account_check_printing_layout',
  'account_use_credit_limit', 'account_default_credit_limit',
  'use_invoice_terms', 'invoice_terms', 'incoterm_id',
];

/**
 * A tax-lock change the return workflow makes for a non-admin: raising the lock to the submitted-return floor,
 * or lowering it to that floor from the period end of a return that has been reset.
 */
function returnLockChange(db, companyId, from, to) {
  const floor = returnTaxLock(db, companyId) || null;
  if (to !== floor) return false;
  if (!from || (to && to > from)) return true;
  return (db.records['account.return'] ?? []).some((ret) => ret.date_to === from && !['submitted', 'paid'].includes(ret.state) && returnCompanies(db, ret).includes(companyId));
}

function companyGuard(db, before, r, ctx) {
  if (r.account_check_printing_layout != null && r.account_check_printing_layout !== '' && !['none', 'top', 'middle', 'bottom'].includes(r.account_check_printing_layout)) return 'Select a valid check layout';
  for (const field of LOCK_DATE_FIELDS) {
    if (r[field] != null && r[field] !== '' && !validDate(r[field])) return `${companyModels['res.company'].fields[field].label} must be a valid date`;
  }
  if (r.tax_start_date != null && r.tax_start_date !== '' && !validDate(r.tax_start_date)) return 'Tax Period Start must be a valid date';
  if (r.tax_periodicity != null && r.tax_periodicity !== '' && !['monthly', 'trimester', 'semester', 'year'].includes(r.tax_periodicity)) return 'Select a valid tax periodicity';
  if (r.tax_calculation_rounding_method != null && r.tax_calculation_rounding_method !== '' && !['round_per_line', 'round_globally'].includes(r.tax_calculation_rounding_method)) return 'Select a valid tax rounding method';
  if (r.account_price_include != null && r.account_price_include !== '' && !['tax_included', 'tax_excluded'].includes(r.account_price_include)) return 'Select a valid default sales price include setting';
  if (r.invoice_qr != null && r.invoice_qr !== '' && !['zatca', 'epc'].includes(r.invoice_qr)) return 'Select a valid payment QR format';
  if (r.quick_edit_mode != null && r.quick_edit_mode !== '' && !['out_invoices', 'in_invoices', 'out_and_in_invoices'].includes(r.quick_edit_mode)) {
    return 'Select a valid quick encoding mode';
  }
  const lastMonth = r.fiscalyear_last_month != null && r.fiscalyear_last_month !== '' ? Number(r.fiscalyear_last_month) : null;
  const lastDay = r.fiscalyear_last_day != null && r.fiscalyear_last_day !== '' ? Number(r.fiscalyear_last_day) : null;
  if (lastMonth != null) {
    if (!Number.isInteger(lastMonth) || lastMonth < 1 || lastMonth > 12) {
      return 'Fiscal year end month must be between 1 and 12';
    }
  }
  if (lastDay != null) {
    const month = lastMonth ?? 12;
    const maxDays = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month] ?? 31;
    if (!Number.isInteger(lastDay) || lastDay < 1 || lastDay > maxDays) {
      return 'Fiscal year end day is invalid for the selected month';
    }
  }
  if (r.currency_provider != null && r.currency_provider !== '' && !['none', 'ecb'].includes(r.currency_provider)) {
    return 'Select a valid currency provider';
  }
  if (r.currency_interval_unit != null && r.currency_interval_unit !== '' && !['manually', 'daily', 'weekly', 'monthly'].includes(r.currency_interval_unit)) {
    return 'Select a valid currency interval unit';
  }
  if (r.currency_next_execution_date != null && r.currency_next_execution_date !== '' && !validDate(r.currency_next_execution_date)) {
    return 'Currency next execution date must be a valid date';
  }
  if (r.account_default_credit_limit != null && r.account_default_credit_limit !== '') {
    const n = Number(r.account_default_credit_limit);
    if (!Number.isFinite(n) || n < 0) return 'Default Credit Limit must be non-negative';
  }
  if (before?.hard_lock_date && (!r.hard_lock_date || r.hard_lock_date < before.hard_lock_date)) return 'The hard lock date cannot be moved back or removed';
  if (before?.audit_trail && !r.audit_trail) return 'The audit trail cannot be disabled once enabled';
  if (ctx && !ctx.isAdmin && CONTROL_FIELDS.some((field) => (
    JSON.stringify(before?.[field] ?? null) !== JSON.stringify(r[field] ?? null)
    && !(field === 'tax_lock_date' && returnLockChange(db, r.id, before?.tax_lock_date || null, r.tax_lock_date || null))
  ))) {
    return 'Only administrators can change lock dates or the audit trail or other company accounting settings';
  }
  const parent = r.parent_id && record(db, 'res.company', r.parent_id);
  if (r.parent_id && !parent) return 'Select an existing parent company';
  const visited = new Set([r.id]);
  for (let p = parent; p; p = record(db, 'res.company', p.parent_id)) {
    if (visited.has(p.id)) return 'A company cannot be its own ancestor';
    visited.add(p.id);
  }
  if (parent && r.currency_id !== parent.currency_id) return 'A branch must use its parent company currency';
  if ((db.records['res.company'] ?? []).some((c) => c.parent_id === r.id && c.currency_id !== r.currency_id)) return 'Branches must share their parent company currency';
  if (r.currency_id && !record(db, 'res.currency', r.currency_id)) return 'Select an existing currency';
  if (r.incoterm_id) {
    const incoterm = record(db, 'account.incoterm', r.incoterm_id);
    if (!incoterm) return 'Select an active incoterm';
    const incotermChanged = !before || (before.incoterm_id ?? null) !== (r.incoterm_id ?? null);
    if (incotermChanged && incoterm.active === false) return 'Select an active incoterm';
  }
  const countryChanged = before && (r.country ?? '') !== (before.country ?? '');
  const currencyChanged = before && (r.currency_id ?? null) !== (before.currency_id ?? null);
  if (countryChanged || currencyChanged) {
    const staged = {
      ...db,
      records: {
        ...db.records,
        'res.company': (db.records['res.company'] ?? []).map((c) => (c.id === r.id ? r : c)),
      },
    };
    const units = (db.records['account.tax.unit'] ?? []).filter((u) => (u.company_ids ?? []).includes(r.id));
    for (const unit of units) {
      const err = taxUnitCompatibilityError(staged, unit);
      if (err) return err;
    }
  }
  for (const [field, type, label] of [
    ['default_sale_journal_id', 'sale', 'Default Sales Journal'],
    ['default_purchase_journal_id', 'purchase', 'Default Purchase Journal'],
    ['default_general_journal_id', 'general', 'Default General Journal'],
    ['currency_exchange_journal_id', 'general', 'Exchange Difference Journal'],
    ['deferred_revenue_journal_id', 'general', 'Deferred Revenue Journal'],
    ['deferred_expense_journal_id', 'general', 'Deferred Expense Journal'],
    ['tax_cash_basis_journal_id', 'general', 'Cash Basis Journal'],
  ]) {
    if (!r[field]) continue;
    const journal = record(db, 'account.journal', r[field]);
    const requiresActive = field.startsWith('deferred_') || field === 'tax_cash_basis_journal_id' || field === 'currency_exchange_journal_id';
    if (!journal || (requiresActive && journal.active === false) || journal.type !== type || (!shared(journal.company_id) && journal.company_id !== r.id)) {
      return `${label} must be ${requiresActive ? 'an active ' : 'a '}${type} journal shared with or belonging to this company`;
    }
  }
  for (const field of ['generate_deferred_revenue_entries_method', 'generate_deferred_expense_entries_method']) {
    if (r[field] != null && r[field] !== '' && !['on_validation', 'manual'].includes(r[field])) {
      return `Select a valid ${companyModels['res.company'].fields[field]?.label ?? field}`;
    }
  }
  for (const field of ['deferred_revenue_amount_computation_method', 'deferred_expense_amount_computation_method']) {
    if (r[field] != null && r[field] !== '' && !['day', 'month', 'full_months'].includes(r[field])) {
      return `Select a valid ${companyModels['res.company'].fields[field]?.label ?? field}`;
    }
  }
  for (const field of ['deferred_revenue_periodicity', 'deferred_expense_periodicity']) {
    if (r[field] != null && r[field] !== '' && !['month', 'year'].includes(r[field])) {
      return `Select a valid ${companyModels['res.company'].fields[field]?.label ?? field}`;
    }
  }
  for (const [field, use, label] of [
    ['account_sale_tax_id', 'sale', 'Default Sales Tax'],
    ['account_purchase_tax_id', 'purchase', 'Default Purchase Tax'],
  ]) {
    // Only a default being set in this write is validated; one already stored may have aged (archived, retyped) without blocking other edits.
    if (!r[field] || (before && (before[field] ?? null) === (r[field] ?? null))) continue;
    const tax = record(db, 'account.tax', r[field]);
    if (!tax || tax.active === false || tax.type_tax_use !== use || (!shared(tax.company_id) && tax.company_id !== r.id)) {
      return `${label} must be an active ${use} tax shared with or belonging to this company`;
    }
  }
  for (const [field, type, label] of [['account_default_receivable_id', 'asset_receivable', 'receivable'], ['account_default_payable_id', 'liability_payable', 'payable']]) {
    if (!r[field]) continue;
    const account = record(db, 'account.account', r[field]);
    if (!account || account.company_id !== r.id || account.account_type !== type || account.active === false) return `Select an active ${label} account belonging to this company`;
  }
  if (r.transfer_account_id) {
    const account = record(db, 'account.account', r.transfer_account_id);
    if (!account || account.active === false || (!shared(account.company_id) && account.company_id !== r.id) || account.account_type !== 'asset_current' || !account.reconcile) {
      return 'Internal Transfer Account must be an active, reconcilable current-asset account belonging to this company';
    }
    const companyCurrencyId = r.currency_id ?? record(db, 'res.company', r.id)?.currency_id;
    if (account.currency_id && account.currency_id !== companyCurrencyId) {
      return 'Internal Transfer Account currency must match the company currency';
    }
  }
  if (r.down_payment_account_id) {
    const account = record(db, 'account.account', r.down_payment_account_id);
    if (!account || account.active === false || (!shared(account.company_id) && account.company_id !== r.id)) return 'Select an active down payment account for this company';
  }
  for (const field of ['deferred_revenue_account_id', 'deferred_expense_account_id', 'gain_account_id', 'loss_account_id', 'income_currency_exchange_account_id', 'expense_currency_exchange_account_id', 'income_early_payment_discount_account_id', 'expense_early_payment_discount_account_id', 'rental_deposit_account_id', 'rental_withheld_deposit_account_id']) {
    if (!r[field]) continue;
    const account = record(db, 'account.account', r[field]);
    if (!account || account.active === false || (!shared(account.company_id) && account.company_id !== r.id)) return `Select an active ${companyModels['res.company'].fields[field]?.label ?? field} belonging to this company`;
  }
  if (r.current_year_earnings_account_id) {
    const account = record(db, 'account.account', r.current_year_earnings_account_id);
    if (!account || !['equity', 'equity_unaffected'].includes(account.account_type)
      || (!shared(account.company_id) && account.company_id !== r.id)) return 'Select an equity earnings account shared with or belonging to this company';
  }
  if (r.default_payroll_structure_id) {
    const structure = record(db, 'hr.payroll.structure', r.default_payroll_structure_id);
    if (!structure || (structure.company_id && structure.company_id !== r.id)) return 'Select a payroll structure belonging to this company';
  }
  if (r.partner_id && !record(db, 'res.partner', r.partner_id)) return 'Select an existing company contact';
  if (r.partner_id && (db.records['res.company'] ?? []).some((c) => c.id !== r.id && c.partner_id === r.partner_id)) return 'Each company needs its own contact';
  // Guard account_opening_move_id: once set, cannot change or be cleared (except back to same id).
  if (before?.account_opening_move_id && r.account_opening_move_id !== before.account_opening_move_id) {
    return 'The opening entry cannot be changed or cleared';
  }
  if (r.account_opening_move_id) {
    const move = record(db, 'account.move', r.account_opening_move_id);
    if (!move) return 'Select an existing opening entry';
    if (move.move_type !== 'entry') return 'The opening entry must be a journal entry';
    if ((move.company_id ?? 1) !== r.id) return 'The opening entry must belong to this company';

    if (move.state === 'posted') {
      if (before && (before.account_opening_date ?? null) !== (r.account_opening_date ?? null)) {
        return 'The opening move is posted; reset it to draft to change the opening date';
      }
      if (before && before.opening_equity_account_id !== r.opening_equity_account_id) {
        return 'The opening move is posted; reset it to draft to change the opening equity account';
      }
    } else {
      const effectiveDate = r.account_opening_date || fiscalYearStart(db, today(), r.id);
      if (move.date !== effectiveDate) {
        return 'The opening move date must match the company opening date';
      }
      const balLine = (move.line_ids ?? []).find((l) => l.is_opening_balancing);
      if (balLine && r.opening_equity_account_id && balLine.account_id !== r.opening_equity_account_id) {
        return 'The opening balancing line must use the company opening equity account';
      }
    }
  }
  return null;
}

/** Prepare res.company writes: update draft opening move on date or equity account changes. */
function prepareCompanyWrite(db, vals, before) {
  let nextDb = db;
  if (vals && 'account_opening_date' in vals && before.account_opening_move_id) {
    const move = record(nextDb, 'account.move', before.account_opening_move_id);
    if (move && move.state !== 'posted') {
      const effectiveDate = vals.account_opening_date || fiscalYearStart(nextDb, today(), before.id);
      nextDb = write(nextDb, 'account.move', move.id, { date: effectiveDate });
    }
  }
  if (vals && 'opening_equity_account_id' in vals && vals.opening_equity_account_id !== before.opening_equity_account_id && before.account_opening_move_id) {
    const move = record(nextDb, 'account.move', before.account_opening_move_id);
    if (move && move.state !== 'posted') {
      const balLine = (move.line_ids ?? []).find((l) => l.is_opening_balancing);
      if (balLine && vals.opening_equity_account_id) {
        const nextLines = move.line_ids.map((l) =>
          l.is_opening_balancing ? { ...l, account_id: vals.opening_equity_account_id } : l,
        );
        nextDb = write(nextDb, 'account.move', move.id, { line_ids: nextLines });
      }
    }
  }
  return { db: nextDb, vals };
}

/** Build per-kind deferred field overrides when legacy shared deferred fields are provided without explicit per-kind values. */
function legacyDeferredFieldPatch(after, vals = {}) {
  const patch = {};
  if ('deferred_generation_method' in vals) {
    const mapped = mapLegacyDeferredGenerationMethod(after.deferred_generation_method);
    for (const field of ['generate_deferred_revenue_entries_method', 'generate_deferred_expense_entries_method']) {
      if (!(field in vals) && (after[field] ?? null) !== mapped) patch[field] = mapped;
    }
  }
  if ('deferred_amount_computation_method' in vals) {
    const mapped = normalizeDeferredComputationMethod(after.deferred_amount_computation_method);
    for (const field of ['deferred_revenue_amount_computation_method', 'deferred_expense_amount_computation_method']) {
      if (!(field in vals) && (after[field] ?? null) !== mapped) patch[field] = mapped;
    }
  }
  return patch;
}

/** Sync legacy shared deferred fields and tax return types after writing `res.company`. */
function onCompanyWrite(db, after, before, vals) {
  let next = vals && (vals.tax_periodicity !== undefined || vals.tax_start_date !== undefined) ? ensureReturnTypes(db) : db;
  if (vals) {
    const patch = legacyDeferredFieldPatch(after, vals);
    if (Object.keys(patch).length) next = write(next, 'res.company', after.id, patch);
  }
  if (vals && vals.account_price_include !== undefined && vals.account_price_include !== before?.account_price_include) {
    next = refreshDraftEntryTaxes(next, after.id);
  }
  return next;
}

/** Create a company and its shared contact, inheriting the parent's currency. */
export function createCompany(db, vals) {
  if (!vals.name?.trim()) throw new Error('Company name is required');
  let next = db;
  const parent = vals.parent_id && record(next, 'res.company', vals.parent_id);
  let currencyId = parent ? parent.currency_id : (vals.currency_id ?? null);
  if (!currencyId) {
    try {
      currencyId = companyCurrencyRecord(next, null)?.id;
    } catch {
      throw new Error('Configure the company currency before creating a company');
    }
  }
  if (!currencyId) throw new Error('Configure the company currency before creating a company');
  const baseValues = { ...vals, currency_id: currencyId };
  const legacyPatch = legacyDeferredFieldPatch(baseValues, vals);
  const values = { ...baseValues, ...legacyPatch };
  if (!values.partner_id) {
    const partner = create(next, 'res.partner', { name: values.name, is_company: true,
      ...Object.fromEntries(['email', 'phone', 'vat', 'street', 'city', 'country'].filter((k) => k in values).map((k) => [k, values[k]])) });
    next = partner.db;
    values.partner_id = partner.id;
  }
  const res = create(next, 'res.company', values);
  next = res.db;
  const accounts = {};
  for (const [field, code, name, account_type] of [['current_year_earnings_account_id', '302000', 'Retained Earnings', 'equity'], ['account_default_receivable_id', '121000', 'Account Receivable', 'asset_receivable'], ['account_default_payable_id', '211000', 'Account Payable', 'liability_payable'], ['deferred_revenue_account_id', '212000', 'Deferred Revenue', 'liability_current'], ['deferred_expense_account_id', '132000', 'Prepaid Expenses', 'asset_current']]) {
    if (values[field]) continue;
    const account = create(next, 'account.account', { code, name, account_type, company_id: res.id, reconcile: ['asset_receivable', 'liability_payable'].includes(account_type) });
    next = account.db;
    accounts[field] = account.id;
  }
  const installed = new Map();
  installed.set('212000:liability_current', accounts.deferred_revenue_account_id ?? values.deferred_revenue_account_id);
  for (const [field, [code, account_type, name]] of Object.entries(STOCK_CHART_ROLES)) {
    if (values[field]) continue;
    const key = `${code}:${account_type}`;
    if (!installed.has(key)) {
      const account = create(next, 'account.account', { code, name, account_type, company_id: res.id });
      next = account.db;
      installed.set(key, account.id);
    }
    accounts[field] = installed.get(key);
  }
  for (const [field, code, name, account_type] of [
    ['gain_account_id', '450300', 'Gain on Asset Disposal', 'income_other'], ['loss_account_id', '690300', 'Loss on Asset Disposal', 'expense_other'],
    ['income_currency_exchange_account_id', '450100', 'Foreign Exchange Gain', 'income_other'], ['expense_currency_exchange_account_id', '690100', 'Foreign Exchange Loss', 'expense_other'],
    ['income_early_payment_discount_account_id', '450200', 'Cash Discount Gain', 'income_other'], ['expense_early_payment_discount_account_id', '690200', 'Cash Discount Loss', 'expense_other'],
    ['rental_deposit_account_id', '230100', 'Rental Deposits', 'liability_current'], ['rental_withheld_deposit_account_id', '450000', 'Other Income', 'income_other'],
    ['down_payment_account_id', '212000', 'Deferred Revenue', 'liability_current'],
  ]) {
    if (values[field]) continue;
    const key = `${code}:${account_type}`;
    if (!installed.get(key)) {
      const account = create(next, 'account.account', { code, name, account_type, company_id: res.id });
      next = account.db;
      installed.set(key, account.id);
    }
    accounts[field] = installed.get(key);
  }
  if (!values.opening_equity_account_id) accounts.opening_equity_account_id = accounts.current_year_earnings_account_id ?? values.current_year_earnings_account_id;
  if (!values.default_payroll_structure_id) {
    const payroll = {};
    for (const [role, code, name, account_type] of [['expense', '620000', 'Salaries & Wages', 'expense'], ['payable', '230000', 'Salaries Payable', 'liability_current'], ['insurance', '240000', 'Social Insurance Payable', 'liability_current'], ['tax', '250100', 'Payroll Tax Payable', 'liability_current']]) {
      const account = create(next, 'account.account', { code, name, account_type, company_id: res.id });
      next = account.db; payroll[role] = account.id;
    }
    const journal = create(next, 'account.journal', { name: 'Salaries', code: 'SAL', type: 'general', company_id: res.id, default_account_id: payroll.expense });
    const structure = create(journal.db, 'hr.payroll.structure', { name: 'Employees', company_id: res.id, journal_id: journal.id, salary_expense_account_id: payroll.expense, salary_payable_account_id: payroll.payable, rules: defaultPayrollRules({ insurance: payroll.insurance, tax: payroll.tax }) });
    next = structure.db;
    accounts.default_payroll_structure_id = structure.id;
  }
  return { ...res, db: ensureStatementReports(ensureReturnTypes(write(next, 'res.company', res.id, accounts)), res.id) };
}

/** Create a business record with database-local company defaults using the current ORM. */
export function createForCompany(db, model, vals) {
  return create(db, model, { ...(scoped.has(model) ? { company_id: currentCompany(db) } : {}), ...vals });
}

/** Initialize the demo's main company once; call after seed to preserve existing IDs. */
export function ensureMainCompany(db, accounts = {}) {
  if (record(db, 'res.company', 1)) return ensureStatementReports(ensureReturnTypes(db), 1);
  if ((db.seq['res.company'] ?? 0) !== 0) throw new Error('Cannot initialize main company: company ID 1 is already reserved');
  const currencyId = accounts.currency_id ?? db.settings?.base_currency_id;
  const currency = currencyId ? (db.records['res.currency'] ?? []).find((c) => c.id === currencyId) : null;
  if (!currency) throw new Error('Configure the base currency before initializing the company');
  const configured = updateSettings(db, { base_currency_id: currency.id });
  const created = createCompany(configured, { name: 'Mizan Demo Co', currency_id: currency.id, ...accounts }).db;
  return ensureStatementReports(ensureReturnTypes(created), 1);
}

/** Rename a company; the main company's name is mirrored into the legacy setting older screens still read. */
export function renameCompany(db, companyId, name) {
  const company = read(db, 'res.company', companyId);
  const partner = read(db, 'res.partner', company?.partner_id);
  let next = write(db, 'res.company', companyId, { name });
  if (partner?.name === company.name) next = write(next, 'res.partner', partner.id, { name });
  return companyId === 1 ? { ...next, settings: { ...next.settings, company: name } } : next;
}

/** Ensure a currency record exists by code, creating it when missing. */
export function ensureCurrencyRecord(db, code) {
  if (!code) return { db, id: null };
  const found = (db.records['res.currency'] ?? []).find((c) => c.name === code);
  return found ? { db, id: found.id } : create(db, 'res.currency', { name: code, rate_ids: [] });
}

/** Set a company's currency by code, creating the currency record when missing. */
export function setCompanyCurrency(db, companyId, code) {
  const currency = ensureCurrencyRecord(db, code);
  return write(currency.db, 'res.company', companyId, { currency_id: currency.id });
}

const TAX_KEYS = [...Object.keys(taxSnapshot(null)), 'tax_source_id', 'tax_ids', 'tax_include_base_amount', 'tax_is_base_affected', 'tax_sequence', 'tax_breakdown'];

/**
 * The buyer's purchase line for a sold line: same product, quantity, discount and net price,
 * but the buyer's purchase tax (through the seller's fiscal position) instead of the seller's output VAT.
 */
function purchaseLine(db, line, fpId, companyId) {
  const { qty_delivered, qty_invoiced, ...rest } = line;
  const kept = Object.fromEntries(Object.entries(rest).filter(([k]) => !TAX_KEYS.includes(k)));
  const qty = Number(line.qty) || 0;
  const factor = qty * (1 - (Number(line.discount) || 0) / 100);
  const included = line.tax_include && factor ? lineTaxOf(line) / factor : 0;
  const net = Math.round(((Number(line.price_unit) || 0) - included) * 1e6) / 1e6;
  const tax = productTax(db, read(db, 'product', line.product_id), 'purchase', fpId, companyId) ?? taxSnapshot(null);
  // A price-included tax is part of the price: a percentage or division tax adds its amount on the net price, a fixed amount per unit is added back (it sits
  // inside the discounted price, so the discount is undone for it).
  const kept_share = 1 - (Number(line.discount) || 0) / 100;
  const price_unit = !tax.tax_include ? net
    : tax.tax_type === 'fixed' ? Math.round((net + (kept_share > 0 ? (Number(tax.tax) || 0) / kept_share : 0)) * 1e6) / 1e6
      : Math.round((net + taxAmount(net, tax)) * 1e6) / 1e6;
  return { ...kept, price_unit, ...tax };
}

/** Draft one linked purchase in the enabled customer company after sale confirmation. */
export function interCompanyRules(db, saleOrderId) {
  const sale = read(db, 'sale.order', saleOrderId);
  if (!sale) throw new Error('Sales order not found');
  if (sale.state !== 'sale') throw new Error('Confirm the sales order before applying inter-company rules');
  if (sale.auto_purchase_id) return db;
  const seller = record(db, 'res.company', sale.company_id);
  const buyer = (db.records['res.company'] ?? []).find((c) => c.partner_id === sale.partner_id && c.id !== sale.company_id && c.active !== false);
  if (!buyer || buyer.intercompany_rule !== 'sale_purchase') return db;
  if (!seller?.partner_id) throw new Error('Set the selling company and its contact first');
  const existing = (db.records['purchase.order'] ?? []).find((p) => p.auto_sale_id === sale.id);
  if (existing) return write(db, 'sale.order', sale.id, { auto_purchase_id: existing.id });
  const fpId = fiscalPositionFor(db, seller.partner_id, buyer.id);
  const purchase = create(db, 'purchase.order', {
    company_id: buyer.id, partner_id: seller.partner_id, auto_sale_id: sale.id, origin: sale.name, fiscal_position_id: fpId ?? null,
    order_line: (sale.order_line ?? []).map((line) => purchaseLine(db, line, fpId, buyer.id)),
    ...(sale.currency_id ? { currency_id: sale.currency_id } : {}),
  });
  return write(purchase.db, 'sale.order', sale.id, { auto_purchase_id: purchase.id });
}

export const companyModels = {
  'res.company': {
    label: 'Companies',
    fields: {
      name: { type: 'char', label: 'Company Name', required: true },
      group_analytic_accounting: { type: 'boolean', label: 'Analytic Accounting' },
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Company Contact' },
      account_default_receivable_id: { type: 'many2one', relation: 'account.account', label: 'Default Receivable Account' },
      account_default_payable_id: { type: 'many2one', relation: 'account.account', label: 'Default Payable Account' },
      transfer_account_id: { type: 'many2one', relation: 'account.account', label: 'Internal Transfer Account' },
      ...Object.fromEntries(Object.entries({ account_stock_valuation_id: 'Stock Valuation Account', account_stock_input_id: 'Stock Input Account', account_stock_output_id: 'Stock Output Account', account_cogs_id: 'Cost of Goods Sold Account', account_price_difference_id: 'Price Difference Account', account_production_id: 'Production Cost Account' }).map(([field, label]) => [field, { type: 'many2one', relation: 'account.account', label }])),
      intercompany_journal_id: { type: 'many2one', relation: 'account.journal', label: 'Inter-company Purchase Journal' },
      domestic_fiscal_position_id: { type: 'many2one', relation: 'account.fiscal.position', label: 'Domestic Fiscal Position' },
      currency_id: { type: 'many2one', relation: 'res.currency', label: 'Currency' },
      default_sale_journal_id: { type: 'many2one', relation: 'account.journal', label: 'Default Sales Journal' },
      default_purchase_journal_id: { type: 'many2one', relation: 'account.journal', label: 'Default Purchase Journal' },
      default_general_journal_id: { type: 'many2one', relation: 'account.journal', label: 'Default General Journal' },
      currency_exchange_journal_id: { type: 'many2one', relation: 'account.journal', label: 'Exchange Difference Journal' },
      default_payroll_structure_id: { type: 'many2one', relation: 'hr.payroll.structure', label: 'Default Payroll Structure' },
      current_year_earnings_account_id: { type: 'many2one', relation: 'account.account', label: 'Current Year Earnings Account' },
      opening_equity_account_id: { type: 'many2one', relation: 'account.account', label: 'Opening Balance Equity Account' },
      account_opening_date: { type: 'date', label: 'Opening Date' },
      account_opening_move_id: { type: 'many2one', relation: 'account.move', label: 'Opening Entry', readonly: true },
      outstanding_receipts_account_id: { type: 'many2one', relation: 'account.account', label: 'Outstanding Receipts' },
      outstanding_payments_account_id: { type: 'many2one', relation: 'account.account', label: 'Outstanding Payments' },
      company_iban: { type: 'char', label: 'Company IBAN for Payment QR' },
      use_invoice_terms: { type: 'boolean', label: 'Default Terms & Conditions' },
      invoice_terms: { type: 'text', label: 'Terms and Conditions' },
      incoterm_id: { type: 'many2one', relation: 'account.incoterm', label: 'Default Incoterm', domain: (r) => r.active !== false },
      invoice_qr: { type: 'selection', label: 'Invoice Payment QR', options: [['zatca', 'ZATCA'], ['epc', 'EPC / SEPA']] },
      quick_edit_mode: {
        type: 'selection',
        label: 'Quick encoding',
        options: [
          ['out_invoices', 'Customer Invoices'],
          ['in_invoices', 'Vendor Bills'],
          ['out_and_in_invoices', 'Customer Invoices and Vendor Bills'],
        ],
      },
      account_check_printing_layout: {
        type: 'selection',
        label: 'Check Layout',
        options: [
          ['none', 'None'],
          ['top', 'Check on top'],
          ['middle', 'Check in middle'],
          ['bottom', 'Check in bottom'],
        ],
      },
      down_payment_account_id: { type: 'many2one', relation: 'account.account', label: 'Down Payment Account' },
      gain_account_id: { type: 'many2one', relation: 'account.account', label: 'Asset Disposal Gain Account' },
      loss_account_id: { type: 'many2one', relation: 'account.account', label: 'Asset Disposal Loss Account' },
      rental_deposit_account_id: { type: 'many2one', relation: 'account.account', label: 'Rental Deposit Liability Account' },
      rental_withheld_deposit_account_id: { type: 'many2one', relation: 'account.account', label: 'Withheld Deposit Income Account' },
      deferred_revenue_journal_id: { type: 'many2one', relation: 'account.journal', label: 'Deferred Revenue Journal' },
      deferred_expense_journal_id: { type: 'many2one', relation: 'account.journal', label: 'Deferred Expense Journal' },
      deferred_revenue_account_id: { type: 'many2one', relation: 'account.account', label: 'Deferred Revenue Account' },
      deferred_expense_account_id: { type: 'many2one', relation: 'account.account', label: 'Deferred Expense Account' },
      generate_deferred_revenue_entries_method: { type: 'selection', label: 'Generate Revenue Entries', options: DEFERRED_REVENUE_GENERATION_OPTIONS },
      generate_deferred_expense_entries_method: { type: 'selection', label: 'Generate Expense Entries', options: DEFERRED_EXPENSE_GENERATION_OPTIONS },
      deferred_revenue_amount_computation_method: { type: 'selection', label: 'Revenue Amount Computation', options: DEFERRED_COMPUTATION_OPTIONS },
      deferred_expense_amount_computation_method: { type: 'selection', label: 'Expense Amount Computation', options: DEFERRED_COMPUTATION_OPTIONS },
      deferred_revenue_periodicity: { type: 'selection', label: 'Revenue Periodicity', options: DEFERRED_PERIODICITY_OPTIONS },
      deferred_expense_periodicity: { type: 'selection', label: 'Expense Periodicity', options: DEFERRED_PERIODICITY_OPTIONS },
      deferred_generation_method: { type: 'selection', label: 'Deferred Entry Generation', hidden: true, options: [['on_validation', 'On Validation'], ['manual', 'Manual'], ['manual_grouped', 'Manually & Grouped']] },
      deferred_amount_computation_method: { type: 'selection', label: 'Based on', hidden: true, options: [['months', 'Months'], ['full_months', 'Full Months'], ['days', 'Days']] },
      income_currency_exchange_account_id: { type: 'many2one', relation: 'account.account', label: 'Currency Exchange Gain Account' },
      expense_currency_exchange_account_id: { type: 'many2one', relation: 'account.account', label: 'Currency Exchange Loss Account' },
      expense_early_payment_discount_account_id: { type: 'many2one', relation: 'account.account', label: 'Early Payment Discount Expense Account' },
      income_early_payment_discount_account_id: { type: 'many2one', relation: 'account.account', label: 'Early Payment Discount Income Account' },
      resource_calendar_id: { type: 'many2one', relation: 'resource.calendar', label: 'Default Working Calendar' },
      parent_id: { type: 'many2one', relation: 'res.company', label: 'Parent Company' },
      email: { type: 'char', label: 'Email' }, phone: { type: 'char', label: 'Phone' },
      lock_date: { type: 'date', label: 'Lock Date', tracking: true },
      sale_lock_date: { type: 'date', label: 'Sales Lock Date', tracking: true },
      purchase_lock_date: { type: 'date', label: 'Purchase Lock Date', tracking: true },
      tax_lock_date: { type: 'date', label: 'Tax Return Lock Date', tracking: true },
      hard_lock_date: { type: 'date', label: 'Hard Lock Date', readonly: true, tracking: true },
      vat: { type: 'char', label: 'Tax ID' }, street: { type: 'char', label: 'Street' },
      city: { type: 'char', label: 'City' }, country: { type: 'char', label: 'Country' },
      report_footer: { type: 'text', label: 'Report Footer' },
      logo: { type: 'text', label: 'Logo' }, active: { type: 'boolean', label: 'Active' },
      intercompany_rule: { type: 'selection', label: 'Inter-Company Rule', options: [['none', 'None'], ['sale_purchase', 'Create Purchase from Sale'], ['invoice_bill', 'Synchronize invoices/bills']] },
      tax_calculation_rounding_method: { type: 'selection', label: 'Tax Calculation Rounding Method', options: [['round_per_line', 'Round per Line'], ['round_globally', 'Round Globally']] },
      tax_periodicity: { type: 'selection', label: 'Tax Periodicity', options: [['monthly', 'Monthly'], ['trimester', 'Trimester'], ['semester', 'Semester'], ['year', 'Year']] },
      tax_start_date: { type: 'date', label: 'Tax Period Start' },
      tax_return_template: { type: 'selection', label: 'Tax Return Template', options: TAX_RETURN_TEMPLATE_OPTIONS },
      account_sale_tax_id: { type: 'many2one', relation: 'account.tax', label: 'Default Sales Tax' },
      account_purchase_tax_id: { type: 'many2one', relation: 'account.tax', label: 'Default Purchase Tax' },
      account_price_include: { type: 'selection', label: 'Default Sales Price Include', options: [['tax_included', 'Tax Included'], ['tax_excluded', 'Tax Excluded']] },
      tax_cash_basis_journal_id: { type: 'many2one', relation: 'account.journal', label: 'Cash Basis Journal' },
      account_storno: { type: 'boolean', label: 'Storno accounting', default: false },
      three_way_matching: { type: 'boolean', label: 'Three-Way Matching' },
      autopost_bills: { type: 'boolean', label: 'Auto-post bills', default: false },
      audit_trail: { type: 'boolean', label: 'Restrictive Audit Trail' },
      account_use_credit_limit: { type: 'boolean', label: 'Sales Credit Limit' },
      account_default_credit_limit: { type: 'monetary', label: 'Default Credit Limit' },
      fiscalyear_last_day: { type: 'integer', label: 'Fiscal Year End Day' },
      fiscalyear_last_month: { type: 'integer', label: 'Fiscal Year End Month' },
      currency_provider: {
        type: 'selection',
        label: 'Currency Provider',
        options: [['none', 'None'], ['ecb', 'European Central Bank']],
      },
      currency_interval_unit: {
        type: 'selection',
        label: 'Currency Interval Unit',
        options: [['manually', 'Manually'], ['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly']],
      },
      currency_next_execution_date: { type: 'date', label: 'Next Currency Rates Execution Date' },
    },
    defaults: () => ({
      active: true,
      group_analytic_accounting: false,
      fiscalyear_last_day: 31,
      fiscalyear_last_month: 12,
      currency_provider: 'none',
      currency_interval_unit: 'manually',
      currency_next_execution_date: null,
      intercompany_rule: 'none',
      account_price_include: 'tax_excluded',
      tax_periodicity: 'monthly',
      deferred_amount_computation_method: 'days',
      generate_deferred_revenue_entries_method: 'on_validation',
      generate_deferred_expense_entries_method: 'on_validation',
      deferred_revenue_amount_computation_method: 'day',
      deferred_expense_amount_computation_method: 'day',
      deferred_revenue_periodicity: 'month',
      deferred_expense_periodicity: 'month',
    }),
    prepareWrite: prepareCompanyWrite,
    guard: companyGuard,
    onWrite: onCompanyWrite,
    onchange: (r, key, db) => key === 'parent_id' && r.parent_id ? { currency_id: record(db, 'res.company', r.parent_id)?.currency_id } : {},
    list: ['name', 'parent_id', 'currency_id', 'email', 'active'],
    kanban: { title: 'name', lines: ['parent_id', 'currency_id', 'email'] },
    form: {
      buttons: [{ label: 'Generate Company Deferrals', wizard: () => ({ title: 'Generate Company Deferrals', fields: [
        { name: 'date', type: 'date', label: 'Period End Date', required: true, default: today() },
      ] }), run: (db, r, values = {}) => {
        const date = values.date;
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw new Error('Set a valid period end date');
        return { db: postCompanyDeferrals(db, r.id, date) };
      } }],
      title: 'name', groups: [['partner_id', 'parent_id', 'currency_id', 'default_sale_journal_id', 'default_purchase_journal_id', 'default_general_journal_id', 'currency_exchange_journal_id', 'default_payroll_structure_id', 'current_year_earnings_account_id', 'opening_equity_account_id', 'account_opening_date', 'account_opening_move_id', 'account_default_receivable_id', 'account_default_payable_id', 'transfer_account_id', 'resource_calendar_id', 'down_payment_account_id', 'income_currency_exchange_account_id', 'expense_currency_exchange_account_id', 'expense_early_payment_discount_account_id', 'income_early_payment_discount_account_id', 'active'], Object.keys(STOCK_CHART_ROLES), ['deferred_revenue_journal_id', 'deferred_revenue_account_id', 'generate_deferred_revenue_entries_method', 'deferred_revenue_amount_computation_method', 'deferred_revenue_periodicity', 'deferred_expense_journal_id', 'deferred_expense_account_id', 'generate_deferred_expense_entries_method', 'deferred_expense_amount_computation_method', 'deferred_expense_periodicity'], ['email', 'phone', 'vat', 'company_iban', 'invoice_qr', 'quick_edit_mode', 'tax_periodicity', 'tax_start_date', 'tax_return_template', 'account_sale_tax_id', 'account_purchase_tax_id', 'tax_cash_basis_journal_id', 'domestic_fiscal_position_id'], ['street', 'city', 'country', 'report_footer']],
      tabs: [{ label: 'Inter-Company', fields: ['intercompany_rule', 'intercompany_journal_id'] }, { label: 'Logo', fields: ['logo'] }],
      smart: [{ label: 'Branches', model: 'res.company', field: 'parent_id' }], chatter: true,
    },
  },
};
