import { create, read, updateSettings, write } from '../orm.js';
import { fiscalPositionFor, lineTaxOf, productTax, taxSnapshot } from './taxes.js';

// Integration: initialize with ensureMainCompany(seed()) so existing partner/currency IDs stay stable.
// After Confirm returns its new database, call interCompanyRules(next, saleId).
// Apply companyFilter to list data and many2one candidates before rendering.
// A switcher needs active res.company records, a current ID and checked allowed IDs; persist setCompanies' result.
// The legacy ORM lacks database-aware defaults/create hooks: use createForCompany and createCompany until extended.
// Keep its process-global setActiveCompany(null) when using allowed-company filtering.

const scoped = new Set(['sale.order', 'purchase.order', 'account.move', 'account.payment', 'account.journal', 'stock.picking', 'hr.employee', 'project.project', 'crm.lead', 'helpdesk.ticket', 'product']);
// Mirrors the ORM's shared master data (importing SHARED_MODELS here would be circular: orm.js loads this registry).
const sharedScoped = new Set(['product', 'account.journal']);
const companyField = { type: 'many2one', relation: 'res.company', label: 'Company' };
const record = (db, model, id) => (db.records[model] ?? []).find((r) => r.id === id);
const shared = (id) => id == null || id === false || id === '';

/** Current company ID, defaulting to the main company before initialization. */
export const currentCompany = (db) => db.settings?.current_company_id ?? 1;

/** Select active companies without changing the caller's database or selection. */
export function setCompanies(db, { current, allowed }) {
  if (!Array.isArray(allowed) || !allowed.length || !allowed.includes(current)) throw new Error('Select at least one company including the current company');
  const ids = [...new Set(allowed)];
  if (ids.some((id) => !Number.isInteger(id) || !record(db, 'res.company', id) || record(db, 'res.company', id).active === false)) throw new Error('Select existing active companies');
  return updateSettings(db, { current_company_id: current, allowed_company_ids: ids });
}

/** Keep shared records and records belonging to an allowed company. */
export function companyFilter(db, records) {
  const allowed = db.settings?.allowed_company_ids ?? [currentCompany(db)];
  return records.filter((r) => shared(r.company_id) || allowed.includes(r.company_id));
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
    if (field.type !== 'many2one' || !['res.partner', 'product', 'account.journal'].includes(field.relation)) continue;
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
      guard: (db, before, r) => model.guard?.(db, before, r) ?? checkCompany(db, model.fields, r, r.company_id),
    }];
  }));
}

function companyGuard(db, before, r) {
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
  if (r.partner_id && !record(db, 'res.partner', r.partner_id)) return 'Select an existing company contact';
  if (r.partner_id && (db.records['res.company'] ?? []).some((c) => c.id !== r.id && c.partner_id === r.partner_id)) return 'Each company needs its own contact';
  return null;
}

/** Create a company and its shared contact, inheriting the parent's currency. */
export function createCompany(db, vals) {
  if (!vals.name?.trim()) throw new Error('Company name is required');
  const parent = vals.parent_id && record(db, 'res.company', vals.parent_id);
  const values = { ...vals, ...(parent ? { currency_id: parent.currency_id } : {}) };
  let next = db;
  if (!values.partner_id) {
    const partner = create(next, 'res.partner', { name: values.name, is_company: true, company_id: null,
      ...Object.fromEntries(['email', 'phone', 'vat', 'street', 'city', 'country'].filter((k) => k in values).map((k) => [k, values[k]])) });
    next = partner.db;
    return create(next, 'res.company', { ...values, partner_id: partner.id });
  }
  return create(next, 'res.company', values);
}

/** Create a business record with database-local company defaults using the current ORM. */
export function createForCompany(db, model, vals) {
  return create(db, model, { ...(scoped.has(model) ? { company_id: currentCompany(db) } : {}), ...vals });
}

/** Initialize the demo's main company once; call after seed to preserve existing IDs. */
export function ensureMainCompany(db) {
  if (record(db, 'res.company', 1)) return db;
  if ((db.seq['res.company'] ?? 0) !== 0) throw new Error('Cannot initialize main company: company ID 1 is already reserved');
  const code = db.settings?.currency ?? 'USD';
  const currency = (db.records['res.currency'] ?? []).find((c) => c.name === code);
  const base = currency ? { db, id: currency.id } : create(db, 'res.currency', { name: code, rate_ids: [] });
  return createCompany(base.db, { name: 'Mizan Demo Co', currency_id: base.id }).db;
}

/** Set a company's currency by code, creating the currency record when missing. */
export function setCompanyCurrency(db, companyId, code) {
  const found = (db.records['res.currency'] ?? []).find((c) => c.name === code);
  const currency = found ? { db, id: found.id } : create(db, 'res.currency', { name: code, rate_ids: [] });
  return write(currency.db, 'res.company', companyId, { currency_id: currency.id });
}

const TAX_KEYS = Object.keys(taxSnapshot(null));

/**
 * The buyer's purchase line for a sold line: same product, quantity, discount and net price,
 * but the buyer's purchase tax (through the seller's fiscal position) instead of the seller's output VAT.
 */
function purchaseLine(db, line, fpId) {
  const { qty_delivered, qty_invoiced, ...rest } = line;
  const kept = Object.fromEntries(Object.entries(rest).filter(([k]) => !TAX_KEYS.includes(k)));
  const qty = Number(line.qty) || 0;
  const factor = qty * (1 - (Number(line.discount) || 0) / 100);
  const included = line.tax_include && factor ? lineTaxOf(line) / factor : 0;
  const net = Math.round(((Number(line.price_unit) || 0) - included) * 1e6) / 1e6;
  const tax = productTax(db, read(db, 'product', line.product_id), 'purchase', fpId) ?? taxSnapshot(null);
  // A price-included tax is part of the price: a percentage scales it, a fixed amount per unit is added back (it sits
  // inside the discounted price, so the discount is undone for it).
  const kept_share = 1 - (Number(line.discount) || 0) / 100;
  const price_unit = !tax.tax_include ? net
    : tax.tax_type === 'fixed' ? Math.round((net + (kept_share > 0 ? (Number(tax.tax) || 0) / kept_share : 0)) * 1e6) / 1e6
      : Math.round(net * (1 + tax.tax / 100) * 1e6) / 1e6;
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
  const fpId = fiscalPositionFor(db, seller.partner_id);
  const purchase = create(db, 'purchase.order', {
    company_id: buyer.id, partner_id: seller.partner_id, auto_sale_id: sale.id, origin: sale.name, fiscal_position_id: fpId ?? null,
    order_line: (sale.order_line ?? []).map((line) => purchaseLine(db, line, fpId)),
    ...(sale.currency_id ? { currency_id: sale.currency_id } : {}),
  });
  return write(purchase.db, 'sale.order', sale.id, { auto_purchase_id: purchase.id });
}

export const companyModels = {
  'res.company': {
    label: 'Companies',
    fields: {
      name: { type: 'char', label: 'Company Name', required: true },
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Company Contact' },
      currency_id: { type: 'many2one', relation: 'res.currency', label: 'Currency' },
      parent_id: { type: 'many2one', relation: 'res.company', label: 'Parent Company' },
      email: { type: 'char', label: 'Email' }, phone: { type: 'char', label: 'Phone' },
      vat: { type: 'char', label: 'Tax ID' }, street: { type: 'char', label: 'Street' },
      city: { type: 'char', label: 'City' }, country: { type: 'char', label: 'Country' },
      logo: { type: 'text', label: 'Logo' }, active: { type: 'boolean', label: 'Active' },
      intercompany_rule: { type: 'selection', label: 'Inter-Company Rule', options: [['none', 'None'], ['sale_purchase', 'Create Purchase from Sale']] },
    },
    defaults: () => ({ active: true, intercompany_rule: 'none' }),
    guard: companyGuard,
    onchange: (r, key, db) => key === 'parent_id' && r.parent_id ? { currency_id: record(db, 'res.company', r.parent_id)?.currency_id } : {},
    list: ['name', 'parent_id', 'currency_id', 'email', 'active'],
    kanban: { title: 'name', lines: ['parent_id', 'currency_id', 'email'] },
    form: {
      title: 'name', groups: [['partner_id', 'parent_id', 'currency_id', 'active'], ['email', 'phone', 'vat'], ['street', 'city', 'country']],
      tabs: [{ label: 'Inter-Company', fields: ['intercompany_rule'] }, { label: 'Logo', fields: ['logo'] }],
      smart: [{ label: 'Branches', model: 'res.company', field: 'parent_id' }], chatter: true,
    },
  },
};
