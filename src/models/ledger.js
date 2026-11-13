// Double-entry core: chart of accounts, journals, and helpers that turn business documents into balanced entries.
import { roundingAccount } from './configured-account.js';
import { create, read, search } from '../orm.js';
import { amounts, companyRoundingMethod, nextName, shiftMonth, today, addDays } from './common.js';
import { companyCurrency, rateAt, toCompany } from './currency.js';
import { cashBasisTransitionAccount, computeLineTaxes, isSectionOrNote, mapAccount, taxBaseTags, taxLabel, taxRepartitionLines, taxRepartitionSplits } from './taxes.js';
import { cashRound, companyCurrencyRecord, currencyUnits, documentCurrency, round, roundCurrency } from '../money.js';
import { productProperty } from './productconfig-helpers.js';
import { discountTaxComputation, earlyDiscount, installments, mixedDiscountFactor } from './terms.js';
import { reportingBookedAmount } from './money.js';
import { configuredEarningsAccount } from './earnings.js';
import { stockAccount } from './stock-accounts.js';
import { models } from '../registry.js';
import { normalizeDistribution } from '../analytic_distribution.js';
import { findAnalyticDistribution } from './analytic-distribution-models.js';
export { STOCK_CHART_ROLES } from './stock-accounts.js';

export const analyticEligibleAccount = (account) => ['income', 'income_other', 'expense', 'expense_direct_cost', 'expense_other'].includes(account?.account_type);
let analyticPostingHooks = null;

export function registerAnalyticPostingHooks(hooks) {
  analyticPostingHooks = hooks;
}

export const ACCOUNT_TYPES = [
  ['asset_receivable', 'Receivable'], ['asset_cash', 'Bank and Cash'], ['asset_current', 'Current Assets'], ['asset_non_current', 'Non-current Assets'], ['asset_prepayments', 'Prepayments'], ['asset_fixed', 'Fixed Assets'],
  ['liability_payable', 'Payable'], ['liability_current', 'Current Liabilities'], ['liability_non_current', 'Non-current Liabilities'], ['liability_credit_card', 'Credit Card'], ['equity', 'Equity'], ['equity_unaffected', 'Current Year Earnings'], ['off_balance', 'Off-Balance Sheet'],
  ['income', 'Income'], ['income_other', 'Other Income'], ['expense_direct_cost', 'Cost of Revenue'], ['expense', 'Expenses'], ['expense_other', 'Other Expenses'],
];

/** Default chart of accounts (codes follow a common 6-digit layout). */
export const CHART = [
  ['101401', 'Bank', 'asset_cash', 'liquidity_bank'], ['101501', 'Cash', 'asset_cash', 'liquidity_cash'], ['101402', 'Outstanding Receipts', 'asset_current'], ['101403', 'Outstanding Payments', 'asset_current'], ['101404', 'Bank Suspense', 'asset_current'], ['121000', 'Account Receivable', 'asset_receivable', 'receivable'],
  ['131000', 'Tax Receivable (VAT input)', 'asset_current'], ['110100', 'Stock Valuation', 'asset_current'], ['110200', 'Stock Interim (Received)', 'asset_current'], ['151000', 'Fixed Assets', 'asset_fixed'],
  ['211000', 'Account Payable', 'liability_payable', 'payable'], ['251000', 'Tax Payable (VAT output)', 'liability_current'],
  ['212000', 'Deferred Revenue', 'liability_current'], ['132000', 'Prepaid Expenses', 'asset_current'], ['230000', 'Salaries Payable', 'liability_current'], ['230100', 'Employee Expenses Payable', 'liability_current'], ['240000', 'Social Insurance Payable', 'liability_current'], ['250100', 'Payroll Tax Payable', 'liability_current'],
  ['301000', 'Capital', 'equity'], ['400000', 'Product Sales', 'income', 'sales'], ['410000', 'Subscription Revenue', 'income'], ['450000', 'Other Income', 'income_other'],
  ['500000', 'Cost of Goods Sold', 'expense_direct_cost'], ['600000', 'Expenses', 'expense', 'purchases'], ['610000', 'Travel & Meals', 'expense'],
  ['620000', 'Salaries & Wages', 'expense', 'salary'], ['630000', 'Rent', 'expense'], ['690000', 'Bank Fees', 'expense_other'],
  ['450100', 'Foreign Exchange Gain', 'income_other'], ['690100', 'Foreign Exchange Loss', 'expense_other'],
  ['450200', 'Cash Discount Gain', 'income_other'], ['690200', 'Cash Discount Loss', 'expense_other'],
  ['152000', 'Accumulated Depreciation', 'asset_fixed'], ['680000', 'Depreciation Expense', 'expense'],
  ['251100', 'Tax Received (Cash Basis Transition)', 'liability_current'], ['131100', 'Tax Paid (Cash Basis Transition)', 'asset_current'],
  ['260000', 'Loans Payable', 'liability_current'], ['690400', 'Interest Expense', 'expense_other'],
  ['450300', 'Gain on Asset Disposal', 'income_other'], ['690300', 'Loss on Asset Disposal', 'expense_other'],
];


export const JOURNALS = [
  { code: 'INV', name: 'Customer Invoices', type: 'sale', account: '400000', invoice_sequence_prefix: 'INV/', invoice_sequence_next_number: 1, refund_sequence: true, refund_sequence_prefix: 'RINV/', refund_sequence_next_number: 1, invoice_reference_type: 'invoice', invoice_reference_model: 'odoo', company_default: 'sales' },
  { code: 'BILL', name: 'Vendor Bills', type: 'purchase', account: '600000', invoice_sequence_prefix: 'BILL/', invoice_sequence_next_number: 1, refund_sequence: true, refund_sequence_prefix: 'RBILL/', refund_sequence_next_number: 1, company_default: 'purchases' },
  { code: 'BNK1', name: 'Bank', type: 'bank', account: '101401', default_for_payments: true, payment_sequence: true, bank_statements_source: 'undefined' },
  { code: 'CSH1', name: 'Cash', type: 'cash', account: '101501', payment_sequence: true },
  { code: 'MISC', name: 'Miscellaneous Operations', type: 'general', company_default: 'general' },
  { code: 'SAL', name: 'Salaries', type: 'general', account: '620000' },
  { code: 'POSS', name: 'Point of Sale', type: 'sale', account: '400000', invoice_sequence_prefix: 'POS/', invoice_sequence_next_number: 1, refund_sequence: true, refund_sequence_prefix: 'RPOS/', refund_sequence_next_number: 1, invoice_reference_type: 'invoice', invoice_reference_model: 'odoo', company_default: 'pos' },
];

export const LIQUIDITY_JOURNAL_TYPES = ['bank', 'cash', 'credit'];
export const STATEMENT_JOURNAL_TYPES = ['bank', 'credit'];
/** True when a journal (or journal type) acts as a liquidity journal (bank, cash, or credit card). */
export const isLiquidityJournal = (journalOrType) => LIQUIDITY_JOURNAL_TYPES.includes(typeof journalOrType === 'string' ? journalOrType : journalOrType?.type);
/** True when a journal (or journal type) supports bank/card statement reconciliation and outstanding payment accounts. */
export const isStatementJournal = (journalOrType) => STATEMENT_JOURNAL_TYPES.includes(typeof journalOrType === 'string' ? journalOrType : journalOrType?.type);

/** Assign a dedicated P{code}/{year}/ payment number or share the journal's entry sequence. */
export function paymentName(db, journal, date, moveName = null) {
  if (journal?.payment_sequence) return nextName(db, 'account.payment', `P${journal.code}/${date.slice(0, 4)}/`);
  return moveName ?? nextName(db, 'account.move', `${journal.code}/${date.slice(0, 4)}/`);
}

const uniqueByCode = (records, model, code, predicate = () => true) => {
  const matches = records.filter((record) => record.code === code && predicate(record));
  if (matches.length > 1) throw new Error(`Multiple ${model} records use code ${code}; select a record explicitly`);
  return matches[0] ?? null;
};

const idByCode = (db, model, code, company) => {
  const records = db.records[model] ?? [];
  if (company) {
    const match = uniqueByCode(records, model, code, (record) => record.company_id === company);
    if (match) return match.id;
    return uniqueByCode(records, model, code, (record) => !record.company_id)?.id ?? null;
  }
  return (uniqueByCode(records, model, code, (record) => !record.company_id)
    ?? uniqueByCode(records, model, code))?.id ?? null;
};

export const accountId = (db, code, company = null) => idByCode(db, 'account.account', code, company);
export const journalId = (db, code, company = null) => idByCode(db, 'account.journal', code, company);

/** Validate an explicitly configured account without resolving it through its code or another account's identity. */
export function assertCompanyAccount(db, id, companyId, accountType, label) {
  if (!id) throw new Error(`${label} is not configured`);
  const account = read(db, 'account.account', id);
  if (!account) throw new Error(`${label} does not exist`);
  if (account.active === false) throw new Error(`${label} is archived`);
  if (account.account_type !== accountType) throw new Error(`${label} must be a ${accountType.replaceAll('_', ' ')} account`);
  if (account.company_id && account.company_id !== (companyId ?? 1)) throw new Error(`${label} must be shared with or belong to this company`);
  return account.id;
}

export function resolveCompanyAccount(db, accountId, companyId) {
  if (!accountId) return null;
  const acc = read(db, 'account.account', accountId);
  if (!acc) return null;
  const comp = companyId ?? 1;
  if (!acc.company_id || acc.company_id === comp) return acc.id;
  return null;
}

/** Whether any line has a negative debit or credit. */
export const badLineSign = (lines = []) => lines.some((l) => (Number(l.debit) || 0) < 0 || (Number(l.credit) || 0) < 0);
export const isBalanced = (lines = [], currency = null) =>
  lines.length >= 2 && lines.every((l) => ['debit', 'credit'].every((key) => {
    const value = Number(l[key] ?? 0);
    return Number.isFinite(value) && Math.abs(value - roundCurrency(value, currency)) < 1e-9;
  })) && lines.reduce((s, l) => s + currencyUnits(l.debit, currency) - currencyUnits(l.credit, currency), 0) === 0;

/** Accounts legitimately carried by linked posted documents (used when system workflows settle, copy, or reverse them). */
export function historicalOriginAccounts(db, originIds, { includeCashBasisTargets = false } = {}) {
  const allowed = new Set();
  const ids = Array.isArray(originIds) ? originIds : originIds ? [originIds] : [];
  const addId = (id) => { if (Number.isInteger(id)) allowed.add(id); };
  for (const originId of ids) {
    if (!Number.isInteger(originId)) continue;
    const origin = read(db, 'account.move', originId);
    if (!origin || origin.state !== 'posted') continue;
    for (const line of origin.line_ids ?? []) addId(line.account_id);
    for (const line of origin.invoice_line_ids ?? []) {
      addId(line.account_id);
      addId(line.income_account_id);
      addId(line.original_account_id);
      if (!includeCashBasisTargets) continue;
      for (const snap of [line, ...(line.tax_breakdown ?? [])]) {
        for (const row of [...(snap.invoice_repartition_line_ids ?? []), ...(snap.refund_repartition_line_ids ?? [])]) {
          if (row?.account_id) {
            addId(row.account_id);
            addId(mapAccount(db, origin.fiscal_position_id, row.account_id));
          }
        }
      }
      for (const taxId of [line.tax_id, ...(line.tax_ids ?? [])]) {
        const tax = taxId ? read(db, 'account.tax', taxId) : null;
        if (!tax) continue;
        addId(tax.cash_basis_transition_account_id);
        for (const row of [...taxRepartitionLines(tax, 'invoice'), ...taxRepartitionLines(tax, 'refund')]) {
          if (row?.account_id) {
            addId(row.account_id);
            addId(mapAccount(db, origin.fiscal_position_id, row.account_id));
          }
        }
      }
    }
  }
  return allowed;
}

/** A partner's receivable or payable account for a company: its valid property, else the company default. */
export function partnerAccount(db, partnerId, companyId, kind) {
  const company = read(db, 'res.company', companyId ?? 1);
  const type = kind === 'receivable' ? 'asset_receivable' : 'liability_payable';
  const valid = (id) => {
    const account = read(db, 'account.account', id);
    return account?.company_id === company?.id && account?.account_type === type && account?.active !== false;
  };
  const property = read(db, 'res.partner', partnerId)?.[`property_account_${kind}_id`];
  const id = valid(property) ? property : company?.[`account_default_${kind}_id`];
  if (!valid(id)) throw new Error(`Configure the default ${kind} account for ${company?.name ?? 'the company'}`);
  return id;
}

/** The receivable or payable account actually booked on an invoice. */
export function invoiceCounterpartAccount(db, invoice) {
  const type = ['in_invoice', 'in_refund'].includes(invoice.move_type) ? 'liability_payable' : 'asset_receivable';
  const ids = [...new Set((invoice.line_ids ?? []).filter((line) => read(db, 'account.account', line.account_id)?.account_type === type).map((line) => line.account_id))];
  if (ids.length !== 1) throw new Error('Invoice must have one receivable or payable account');
  return ids[0];
}

export function resolveDocumentJournal(db, move, { required = false } = {}) {
  if (!move) return null;
  const companyId = move.company_id ?? db.settings?.current_company_id ?? 1;
  const posContext = Boolean(move.session_id || move.pos_config_id || move.config_id);
  let journalId = move.journal_id;
  // Raw record: reading the computed move would resolve its journal again.
  if (!journalId && move.id) journalId = (db.records?.['account.move'] ?? []).find((m) => m.id === move.id)?.journal_id;
  if (!journalId && (move.session_id || move.pos_config_id || move.config_id)) {
    const session = move.session_id ? read(db, 'pos.session', move.session_id) : null;
    const configId = move.config_id ?? move.pos_config_id ?? session?.config_id;
    const config = configId ? read(db, 'pos.config', configId) : null;
    journalId = session?.journal_id || config?.journal_id || null;
  }
  if (!journalId && !posContext && ['out_invoice', 'out_refund', 'in_invoice', 'in_refund'].includes(move.move_type)) {
    const purchase = ['in_invoice', 'in_refund'].includes(move.move_type);
    const company = read(db, 'res.company', companyId);
    journalId = company?.[purchase ? 'default_purchase_journal_id' : 'default_sale_journal_id'] ?? null;
  }
  if (!journalId && move.move_type === 'entry') {
    journalId = read(db, 'res.company', companyId)?.default_general_journal_id ?? null;
  }
  const journal = journalId ? read(db, 'account.journal', journalId) : null;
  if (journalId && !journal) throw new Error('Selected journal does not exist');
  if (required && !journal) {
    const purchase = ['in_invoice', 'in_refund'].includes(move.move_type);
    if (purchase || ['out_invoice', 'out_refund'].includes(move.move_type)) {
      const kind = purchase ? 'purchase' : 'sales';
      const document = purchase ? 'vendor bill' : 'customer invoice';
      throw new Error(`No ${document} journal for this company; select a journal or configure a default ${kind} journal for company ${companyId}`);
    }
    if (posContext) throw new Error('Configure a journal on the point of sale session or configuration');
    throw new Error(`No general journal configured for company ${companyId}; select a journal or configure a default general journal`);
  }
  return journal;
}

/** Invoice base groups, including the source lines used to allocate a posted group. */
export function invoiceBaseGroups(db, move, roundingMethod = companyRoundingMethod(db, move.company_id)) {
  const sale = !['in_invoice', 'in_refund'].includes(move.move_type);
  const journal = resolveDocumentJournal(db, move, { required: true });
  const base = resolveCompanyAccount(db, journal.default_account_id, move.company_id);
  const byAccount = new Map();
  const getSourceAccount = (l) => {
    // Provenance recorded when the source document was posted wins over current configuration.
    if (l.income_account_id) return { accountId: l.income_account_id, configured: true, type: 'line', recorded: true };
    if (l.account_id) return { accountId: l.account_id, configured: true, type: 'line' };
    const p = (db.records.product ?? []).find((p) => p.id === l.product_id);
    const dropship = !sale && read(db, 'purchase.order', move.purchase_id)?.dropship_partner_id;
    if (!sale && !dropship && p?.type === 'goods' && !['manual_periodic', 'periodic'].includes(productProperty(db, p, 'property_valuation'))) {
      return { accountId: stockAccount(db, p, 'input', move.company_id ?? 1), configured: true, type: 'valuation' };
    }
    const configured = productProperty(db, p, sale ? 'property_account_income_id' : 'property_account_expense_id');
    if (configured) return { accountId: configured, configured: true, type: 'product' };
    if (!base) throw new Error(`Journal "${journal.name || journal.code}" has no default account configured for this company`);
    return { accountId: base, configured: true, type: 'journal default' };
  };
  for (const [index, l] of (move.invoice_line_ids ?? []).entries()) {
    if (isSectionOrNote(l)) continue;
    const source = getSourceAccount(l);
    if (!source.accountId) throw new Error(`No ${source.type} account found`);
    const mapped = source.recorded ? source.accountId : mapAccount(db, move.fiscal_position_id, source.accountId);
    const mappedAccount = read(db, 'account.account', mapped);
    const selectedForeignAccount = mappedAccount?.company_id && mappedAccount.company_id !== (move.company_id ?? 1);
    const resolved = selectedForeignAccount && source.type !== 'journal default' ? null : resolveCompanyAccount(db, mapped, move.company_id);
    if (!resolved) {
      if (source.configured) {
        throw new Error(`Configured ${source.type} account does not exist for the invoice company`);
      }
      throw new Error('No valid account for the invoice company');
    }
    const original = resolved;
    const deferred = l.deferred_start_date || l.deferred_end_date;
    if (deferred && (!l.deferred_start_date || !l.deferred_end_date || l.deferred_start_date > l.deferred_end_date)) throw new Error('Set valid deferred start and end dates');
    const company = read(db, 'res.company', move.company_id ?? 1);
    const account = deferred ? company?.[sale ? 'deferred_revenue_account_id' : 'deferred_expense_account_id'] : original;
    if (deferred && !account) throw new Error(`Configure the deferred ${sale ? 'revenue' : 'expense'} account on the company`);
    const selected = read(db, 'account.account', account);
    if (deferred && (!selected || (selected.company_id && selected.company_id !== (move.company_id ?? 1)))) throw new Error('Deferred account must belong to the document company');
    const docCurrency = documentCurrency(db, move);
    const computed = computeLineTaxes(l, { currency: docCurrency, roundingMethod, side: ['out_refund', 'in_refund'].includes(move.move_type) ? 'refund' : 'invoice' });
    const cashBasis = computed.taxes.length ? computed.taxes.some((t) => t.tax_cash_basis) : !!l.tax_cash_basis;
    const distribution = l.analytic_distribution ?? (l.analytic_account_id ? { [l.analytic_account_id]: 100 } : {});
    const distributionKey = JSON.stringify(Object.entries(distribution).sort(([a], [b]) => a.localeCompare(b)));
    const isRefund = ['out_refund', 'in_refund'].includes(move.move_type);
    const side = isRefund ? 'refund' : 'invoice';

    if (!computed.taxes.some((tax) => tax.amount) && !cashBasis) {
      const zeroTaxes = computed.taxes.length
        ? computed.taxes
        : [{ tax_id: l.tax_id ?? null, tax_name: l.tax_name || taxLabel(l), invoice_repartition_line_ids: l.invoice_repartition_line_ids, refund_repartition_line_ids: l.refund_repartition_line_ids }];
      for (const [compIndex, t] of zeroTaxes.entries()) {
        const zero = taxLabel(t);
        const zeroTaxId = t.tax_id ?? null;
        const tags = [...new Set(taxBaseTags(t, side, l))].sort((a, b) => a - b);
        const key = JSON.stringify([account, zero, zeroTaxId, tags, false, distributionKey]);
        const group = byAccount.get(key) ?? { account, zero, zeroTaxId, tags, cashBasis: false, distribution, amount: 0, base: 0, lines: [] };
        if (compIndex === 0) {
          group.amount += computed.untaxed;
          group.lines.push({ index, line_id: l.line_id, amount: computed.untaxed, ...(deferred ? { original_account_id: original } : {}) });
        }
        group.base += t.base ?? computed.untaxed;
        byAccount.set(key, group);
      }
    } else {
      const zero = '';
      const zeroTaxId = null;
      const tags = [...new Set(computed.taxes.length
        ? computed.taxes.filter((t) => !t.tax_cash_basis).flatMap((t) => taxBaseTags(t, side, l))
        : cashBasis ? [] : taxBaseTags(null, side, l))].sort((a, b) => a - b);
      const key = JSON.stringify([account, zero, zeroTaxId, tags, cashBasis, distributionKey]);
      const group = byAccount.get(key) ?? { account, zero, zeroTaxId, tags, cashBasis, distribution, amount: 0, base: 0, lines: [] };
      group.amount += computed.untaxed;
      group.base += computed.untaxed;
      group.lines.push({ index, line_id: l.line_id, amount: computed.untaxed, ...(deferred ? { original_account_id: original } : {}) });
      byAccount.set(key, group);
    }
  }
  return [...byAccount.values()];
}

/** Resolve the same account used by the journal grouping. */
export function invoiceLineAccount(db, move, line) {
  const journal = resolveDocumentJournal(db, move);
  return invoiceBaseGroups(db, { ...move, journal_id: journal?.id ?? move.journal_id, invoice_line_ids: [line] })[0]?.account ?? null;
}

/** Split a posted journal item's company units across its contributing lines. */
export function allocateJournalSources(amount, sources, rate = 1, currency = null) {
  if (!sources.length) return [];
  const factor = Number.isFinite(rate) && rate ? rate : 1;
  const step = Number(currency?.rounding ?? 0.01);
  const shares = sources.map((source, index) => {
    const exact = (Number(source.amount) || 0) * factor / step;
    const whole = Math.trunc(exact);
    return { index, whole, remainder: exact - whole };
  });
  const gap = currencyUnits(amount, currency) - shares.reduce((sum, share) => sum + share.whole, 0);
  const direction = Math.sign(gap);
  const ranked = [...shares].sort((a, b) => direction * (b.remainder - a.remainder) || a.index - b.index);
  for (let i = 0; i < Math.abs(gap); i++) ranked[i % ranked.length].whole += direction;
  return sources.map((source, i) => ({ index: source.index, line_id: source.line_id, amount: Number((shares[i].whole * step).toPrecision(15)) || 0, ...(source.original_account_id ? { original_account_id: source.original_account_id } : {}) }));
}

/** A plain-rate tax (no tax record) posts to the tax account of the company's configured default sales or purchase tax. */
function plainRateTaxAccount(db, move, sale, side) {
  const company = read(db, 'res.company', move.company_id ?? 1);
  const tax = read(db, 'account.tax', sale ? company?.account_sale_tax_id : company?.account_purchase_tax_id);
  const configured = tax ? taxRepartitionLines(tax, side).find((r) => r.repartition_type === 'tax' && r.account_id)?.account_id : null;
  const account = configured ? resolveCompanyAccount(db, mapAccount(db, move.fiscal_position_id, configured), move.company_id) : null;
  if (!account) throw new Error(`Configure the default ${sale ? 'sales' : 'purchase'} tax and its tax account on the company to post a plain-rate tax`);
  return account;
}

/** Tax groups for an invoice/bill, applying mixed early-payment discount rounding per group when present. */
export function invoiceTaxGroups(db, move, roundingMethod = companyRoundingMethod(db, move.company_id)) {
  const rate = rateAt(db, move.currency_id, move.invoice_date ?? today(), move.company_id);
  const docCurrency = documentCurrency(db, move);
  const ownCurrency = companyCurrencyRecord(db, move.company_id);
  const docRound = (n) => roundCurrency(n, docCurrency);
  const companyRound = (n) => roundCurrency(n, ownCurrency);
  const isRefund = ['out_refund', 'in_refund'].includes(move.move_type);
  const sale = !['in_invoice', 'in_refund'].includes(move.move_type);
  const side = isRefund ? 'refund' : 'invoice';
  const by = new Map();

  for (const l of move.invoice_line_ids ?? []) {
    if (isSectionOrNote(l)) continue;
    const computed = computeLineTaxes(l, { currency: docCurrency, roundingMethod, side });
    for (const t of computed.taxes) {
      if (t.amount === 0 && !t.tax_cash_basis) continue;
      const { explicit, splits } = taxRepartitionSplits(t, l, side, docCurrency);
      for (const { row, amount: docAmt, base: docBase } of splits) {
        let account_id;
        if (t.tax_cash_basis) {
          account_id = cashBasisTransitionAccount(db, t.tax_id, move.company_id);
        } else if (row.account_id) {
          const mapped = mapAccount(db, move.fiscal_position_id, row.account_id);
          const resolved = resolveCompanyAccount(db, mapped, move.company_id);
          if (!resolved) throw new Error('Configured tax account does not exist for the invoice company');
          account_id = resolved;
        } else if (explicit) {
          // A configured repartition row without an account books the tax on the base line's account.
          account_id = invoiceLineAccount(db, move, l);
        } else {
          account_id = plainRateTaxAccount(db, move, sale, side);
        }
        const tax_name = taxLabel(t);
        const tax_id = t.tax_id ?? null;
        const tax_tag_ids = [...(row.tag_ids ?? [])].sort((a, b) => a - b);
        const key = `${account_id}|${tax_id ?? ''}|${tax_tag_ids.join(',')}`;
        const g = by.get(key) ?? { account_id, tax_id, tax_name, tax_tag_ids, cash_basis: !!t.tax_cash_basis, document_base: 0, document_amount: 0 };
        by.set(key, { ...g, document_base: g.document_base + docBase, document_amount: g.document_amount + docAmt });
      }
    }
  }

  const rawTaxes = [...by.values()].map(({ document_base, document_amount, ...group }) => {
    const tax = docRound(document_amount);
    const base = docRound(document_base);
    return { ...group, document_amount: tax, amount: companyRound(tax / rate), base: companyRound(base / rate) };
  }).filter((g) => g.amount || g.base || g.document_amount || g.document_base);

  const term = move.invoice_payment_term_id && read(db, 'account.payment.term', move.invoice_payment_term_id);
  const discountFactor = mixedDiscountFactor(term);
  if (discountFactor === 1) return rawTaxes;
  return rawTaxes.map((g) => {
    const docBase = docRound(g.base * rate * discountFactor);
    const docAmt = docRound(g.document_amount * discountFactor);
    return { ...g, document_amount: docAmt, amount: companyRound(docAmt / rate), base: companyRound(docBase / rate) };
  });
}

/** Journal items for a customer invoice / vendor bill in document and company units. */
export function invoiceLines(db, move) {
  // Customer side for invoices and credit notes; a credit note mirrors the invoice (debits ↔ credits).
  const sale = !['in_invoice', 'in_refund'].includes(move.move_type);
  const refund = ['out_refund', 'in_refund'].includes(move.move_type);
  const rate = rateAt(db, move.currency_id, move.invoice_date ?? today(), move.company_id);
  const docCurrency = documentCurrency(db, move);
  const ownCurrency = companyCurrencyRecord(db, move.company_id);
  const docRound = (n) => roundCurrency(n, docCurrency);
  const companyRound = (n) => roundCurrency(n, ownCurrency);
  const kind = sale ? 'receivable' : 'payable';
  const type = sale ? 'asset_receivable' : 'liability_payable';
  const originId = move.reversed_entry_id ?? move.debit_origin_id ?? move.correction_of_id ?? null;
  const origin = originId ? read(db, 'account.move', originId) : null;
  const originCounterpart = origin?.state === 'posted' && ['out_invoice', 'in_invoice', 'out_refund', 'in_refund'].includes(origin.move_type)
    && (origin.company_id ?? 1) === (move.company_id ?? 1)
    ? invoiceCounterpartAccount(db, origin)
    : null;
  const company = read(db, 'res.company', move.company_id ?? 1);
  const partnerProp = read(db, 'res.partner', move.partner_id)?.[`property_account_${kind}_id`];
  const validActive = (id) => {
    const account = read(db, 'account.account', id);
    return account?.company_id === company?.id && account?.account_type === type && account?.active !== false;
  };
  const counterpart = move.reversed_entry_id && originCounterpart
    ? originCounterpart
    : (validActive(partnerProp) || validActive(company?.[`account_default_${kind}_id`]) || !originCounterpart)
      ? partnerAccount(db, move.partner_id, move.company_id, kind)
      : originCounterpart;
  const roundingMethod = companyRoundingMethod(db, move.company_id);
  // Each group keeps its amount in the document currency beside its company-currency amount: the foreign amount of a
  // journal item is the invoiced one, never reconstructed from the rounded conversion.
  const bases = invoiceBaseGroups(db, move, roundingMethod).map(({ account, amount, base, zero, lines, tags, zeroTaxId, distribution }) => [
    account,
    companyRound(docRound(amount) / rate),
    docRound(amount),
    zero,
    lines,
    tags,
    zeroTaxId,
    distribution,
    companyRound(docRound(base ?? amount) / rate),
  ]);
  const term = move.invoice_payment_term_id && read(db, 'account.payment.term', move.invoice_payment_term_id);
  const rounding = move.invoice_cash_rounding_id ? read(db, 'account.cash.rounding', move.invoice_cash_rounding_id) : null;
  // Tax lines are kept apart per tax so the tax return can read tax and base straight from the ledger.
  const taxes = invoiceTaxGroups(db, move, roundingMethod);

  const rawTotalDoc = mixedDiscountFactor(term) !== 1
    ? docRound(amounts(move.invoice_line_ids, docCurrency, { roundingMethod, side: refund ? 'refund' : 'invoice' }).untaxed + taxes.reduce((s, group) => s + group.document_amount, 0))
    : amounts(move.invoice_line_ids, docCurrency, { roundingMethod, side: refund ? 'refund' : 'invoice' }).total;
  const totalDoc = rounding ? docRound(cashRound(rawTotalDoc, rounding.rounding, rounding.rounding_method)) : rawTotalDoc;
  const diffDoc = docRound(totalDoc - rawTotalDoc);
  const total = companyRound(totalDoc / rate);
  const diff = companyRound(diffDoc / rate);

  const actualTaxes = taxes.filter((g) => g.amount !== 0 || g.document_amount !== 0);
  const adjustTax = Boolean(rounding && rounding.strategy === 'biggest_tax' && actualTaxes.length && diffDoc !== 0);
  if (adjustTax) {
    const largest = taxes.reduce((best, g, i) => (Math.abs(g.amount) > Math.abs(taxes[best].amount) ? i : best), 0);
    taxes[largest] = { ...taxes[largest], amount: companyRound(taxes[largest].amount + diff), document_amount: docRound(taxes[largest].document_amount + diffDoc) };
  }

  const docGap = docRound(totalDoc - bases.reduce((s, [, , a]) => s + a, 0) - taxes.reduce((s, g) => s + g.document_amount, 0) - (rounding && !adjustTax ? diffDoc : 0));
  if (docGap && bases.length) {
    const largest = bases.reduce((best, b, i) => Math.abs(b[2]) > Math.abs(bases[best][2]) ? i : best, 0);
    bases[largest][2] = docRound(bases[largest][2] + docGap);
  }

  // The receivable/payable is the document total; units lost rounding each account go to the largest base line.
  const gap = companyRound(total - bases.reduce((s, [, a]) => s + a, 0) - taxes.reduce((s, g) => s + g.amount, 0) - (rounding && !adjustTax && diff ? diff : 0));
  if (gap && bases.length) {
    const largest = bases.reduce((best, b, i) => (Math.abs(b[1]) > Math.abs(bases[best][1]) ? i : best), 0);
    bases[largest][1] = companyRound(bases[largest][1] + gap);
  }

  // A document is foreign when its currency is not the company's (an equal rate on the day does not change that).
  const own = companyCurrency(db, move.company_id);
  const foreign = !!move.currency_id && move.currency_id !== own;
  const side = (amount, debit, doc) => {
    const sign = (debit !== refund) !== ((amount || doc) < 0) ? 1 : -1;
    return { debit: sign > 0 ? companyRound(Math.abs(amount)) : 0, credit: sign > 0 ? 0 : companyRound(Math.abs(amount)), ...(foreign ? { currency_id: move.currency_id, amount_currency: docRound(sign * Math.abs(doc)) } : {}) };
  };

  const roundingLines = [];
  if (rounding && !adjustTax && diffDoc !== 0) {
    const isProfit = (sale !== refund) ? diffDoc > 0 : diffDoc < 0;
    const acc = roundingAccount(db, rounding, isProfit, move.company_id);
    roundingLines.push({
      account_id: acc,
      partner_id: move.partner_id,
      name: 'Cash Rounding',
      ...side(diff, !sale, diffDoc),
    });
  }

  const schedule = term ? installments(term, totalDoc, move.invoice_date ?? today(), docCurrency) : [{ date: move.invoice_date_due, amount: totalDoc }];
  let allocated = 0;
  let cumDoc = 0;
  const discountDate = term?.early_discount && (move.invoice_date || today()) ? addDays(move.invoice_date ?? today(), Number(term.discount_days) || 0) : null;
  const discountPercent = term?.early_discount ? Number(term.discount_percent) || 0 : 0;
  const counterparts = schedule.map((item, index) => {
    cumDoc = docRound(cumDoc + item.amount);
    const targetCompany = index === schedule.length - 1 ? total : (totalDoc !== 0 ? companyRound(total * (cumDoc / totalDoc)) : 0);
    const amount = companyRound(targetCompany - allocated);
    allocated = companyRound(allocated + amount);
    const discountDoc = term?.early_discount && index === 0
      ? docRound(earlyDiscount(term, ['excluded', 'mixed'].includes(discountTaxComputation(term)) ? bases.reduce((s, [, , a]) => s + a, 0) : totalDoc, move.invoice_date ?? today(), move.invoice_date ?? today(), docCurrency))
      : 0;
    const discountCompany = discountDoc ? companyRound(discountDoc / rate) : 0;
    return {
      account_id: counterpart,
      partner_id: move.partner_id,
      name: move.name,
      ...side(amount, sale, item.amount),
      ...(item.date ? { date_maturity: item.date } : {}),
      ...(discountDate ? {
        discount_date: discountDate,
        discount_amount_currency: discountDoc,
        discount_balance: discountCompany,
        discount_percentage: discountPercent,
      } : {}),
    };
  });
  return [
    ...counterparts,
    ...bases.map(([account_id, amount, doc, zero, sources, tags, zeroTaxId, distribution, baseCompany]) => ({ account_id, ...(Object.keys(distribution).length ? { analytic_distribution: distribution } : {}), partner_id: move.partner_id, name: sale ? 'Sales' : 'Purchases', ...side(amount, !sale, doc), invoice_sources: allocateJournalSources(amount, sources, 1 / rate, ownCurrency), ...(zero ? { tax_id: zeroTaxId, tax_name: zero, tax_base: refund ? -baseCompany : baseCompany, tax_zero: true, tax_side: sale ? 'sale' : 'purchase' } : {}), ...(tags.length ? { tax_tag_ids: tags, tax_grid_base: true, tax_side: sale ? 'sale' : 'purchase' } : {}) })),
    ...taxes.map((g) => ({ account_id: g.account_id, partner_id: move.partner_id, name: g.tax_name, ...side(g.amount, !sale, g.document_amount), tax_id: g.tax_id, tax_name: g.tax_name, tax_base: refund && !g.amount ? -g.base : g.base, ...(!g.cash_basis ? { tax_side: sale ? 'sale' : 'purchase' } : {}), ...(g.tax_tag_ids.length ? { tax_tag_ids: g.tax_tag_ids } : {}) })),
    ...roundingLines,
  ].filter((l) => l.debit || l.credit || l.amount_currency || l.invoice_sources?.length || l.tax_base);
}

/** Recover a bill line's share from its protected posted journal item, never current configuration. */
export function postedBillLine(move, index) {
  if (move?.state !== 'posted' || move.move_type !== 'in_invoice') return null;
  const matches = (move.line_ids ?? []).flatMap((line) => (line.invoice_sources ?? [])
    .filter((source) => source.index === index).map((source) => ({ line, source })));
  if (matches.length !== 1) return null;
  const { line, source } = matches[0];
  if (Math.abs((line.invoice_sources ?? []).reduce((sum, item) => sum + item.amount, 0) - ((Number(line.debit) || 0) - (Number(line.credit) || 0))) > 1e-9) return null;
  return { amount: source.amount, account: line.account_id };
}

/**
 * Create and post a miscellaneous entry.
 * Tax lines may carry `tax_name` and `tax_base` (company currency) for the tax return.
 * @param {{journal: string, date?: string, ref?: string, lines: {account_id: number, debit?: number, credit?: number, partner_id?: number, name?: string, tax_name?: string, tax_base?: number}[]}} spec
 */
export function postEntry(db, { journal, journal_id = null, date = today(), ref = '', lines, company = null, fx_payment_move_id = null, fx_invoice_id = null, is_tax_payment = false, tax_return_id = null, deferred_adjustment_of_id = null, system_generated = false, archivedOriginIds = [], includeCashBasisTargets = false }) {
  if (fx_payment_move_id || fx_invoice_id) throw new Error('Exchange provenance cannot be supplied to postEntry');
  if (company && !read(db, 'res.company', company)) throw new Error('Company does not exist');
  const jId = journal_id ?? (typeof journal === 'number' ? journal : (journalId(db, journal, company) ?? journalId(db, journal)));
  if (!jId) throw new Error(`Journal not found: ${journal}`);
  const j = read(db, 'account.journal', jId);
  if (!j) throw new Error(`Journal not found: ${journal}`);
  if (j.company_id && company && j.company_id !== company) throw new Error(`Journal ${j.name || j.code} belongs to another company`);
  const allowedArchived = historicalOriginAccounts(db, archivedOriginIds, { includeCashBasisTargets });

  const moveContext = {
    move_type: 'entry',
    company_id: company ?? 1,
    journal_id: jId,
    partner_id: lines.find((line) => line.partner_id)?.partner_id ?? null,
    date,
    ref,
    ...(system_generated ? { system_generated: true } : {}),
  };
  const line_ids = lines.map((l) => {
    let accId = null;
    if (l.account_id) accId = l.account_id;
    else if (typeof l.account === 'number') accId = l.account;
    else if (l.account) {
      // Chart-code lines are an import/fixture convenience only: runtime models pass account ids (see codesd.test.js).
      accId = accountId(db, l.account, company);
      if (!accId && company && (db.records['account.account'] ?? []).some((account) => account.code === l.account
        && account.company_id && account.company_id !== company)) {
        throw new Error(`Account ${l.account} belongs to another company`);
      }
    }
    if (!accId) throw new Error(`Account not found: ${l.account}`);
    const acc = read(db, 'account.account', accId);
    if (!acc) throw new Error(`Account not found: ${accId}`);
    if (acc.active === false && !allowedArchived.has(acc.id)) throw new Error('Archived accounts cannot be selected on journal items or invoice lines');
    if (acc.company_id && company && acc.company_id !== company) throw new Error(`Account ${acc.code || acc.name} belongs to another company`);

    // Keep both columns non-negative: a negative debit is a credit and vice versa.
    const ownCurrency = companyCurrencyRecord(db, company);
    const net = roundCurrency((l.debit ?? 0) - (l.credit ?? 0), ownCurrency);
    const foreignCurrency = l.currency_id ? read(db, 'res.currency', l.currency_id) : null;
    if (l.currency_id && !foreignCurrency) throw new Error('Journal item currency does not exist');
    // Callers pass an explicit allocation; business entries receive applicable defaults from distribution models.
    let distribution = l.analytic_distribution ?? (l.analytic_account_id != null ? { [l.analytic_account_id]: 100 } : null);
    if (distribution == null && !system_generated && analyticEligibleAccount(acc)) {
      const defaultDist = findAnalyticDistribution(db, {
        partner_id: l.partner_id ?? moveContext.partner_id,
        product_id: l.product_id,
        account_id: accId,
        company_id: company ?? 1,
      });
      if (defaultDist && Object.keys(defaultDist).length) {
        distribution = defaultDist;
      }
    }
    const analyticDistribution = distribution == null ? null : normalizeDistribution(distribution, db);
    return { account_id: accId, ...(l.product_id ? { product_id: l.product_id } : {}), ...(analyticDistribution != null ? { analytic_distribution: analyticDistribution } : {}), partner_id: l.partner_id ?? null, name: l.name ?? ref, debit: Math.max(0, net), credit: Math.max(0, -net), ...(foreignCurrency ? { currency_id: l.currency_id, amount_currency: roundCurrency(l.amount_currency, foreignCurrency) } : {}), ...((l.tax_name || l.tax_grid_base) ? { ...(l.tax_id != null ? { tax_id: l.tax_id } : {}), ...(l.tax_name ? { tax_name: l.tax_name } : {}), tax_base: roundCurrency(l.tax_base ?? 0, ownCurrency), ...(l.tax_base_signed ? { tax_base_signed: true } : {}), ...(l.tax_zero ? { tax_zero: true } : {}), ...(l.tax_side ? { tax_side: l.tax_side } : {}) } : {}), ...(l.tax_side ? { tax_side: l.tax_side } : {}), ...(l.type_tax_use ? { type_tax_use: l.type_tax_use } : {}), ...(l.tax_tag_ids?.length ? { tax_tag_ids: [...l.tax_tag_ids] } : {}), ...(l.tax_grid_base ? { tax_grid_base: true, tax_side: l.tax_side } : {}), ...(l.tax_grid_release ? { tax_grid_release: true } : {}) };
  });
  if (!isBalanced(line_ids, companyCurrencyRecord(db, company))) throw new Error('Journal entry is not balanced');
  if (analyticPostingHooks?.checkMandatoryPlans) {
    analyticPostingHooks.checkMandatoryPlans(db, { ...moveContext, line_ids }, { systemGenerated: system_generated });
  } else if (search(db, 'account.analytic.plan').length) {
    throw new Error('Analytic posting support is not loaded');
  }
  const journalCode = j?.code ?? journal;
  const prefix = `${journalCode}/${date.slice(0, 4)}/`;
  const made = create(db, 'account.move', {
    move_type: 'entry', state: 'posted', journal_id: jId, invoice_date: date, date, ref, ...(company ? { company_id: company } : {}),
    name: nextName(db, 'account.move', prefix), line_ids, partner_id: lines.find((l) => l.partner_id)?.partner_id ?? null,
    ...(is_tax_payment ? { is_tax_payment: true } : {}),
    ...(tax_return_id ? { tax_return_id } : {}),
    ...(deferred_adjustment_of_id ? { deferred_adjustment_of_id } : {}),
    ...(system_generated ? { system_generated: true } : {}),
  }, { archivedOriginIds, includeCashBasisTargets });
  if (analyticPostingHooks?.postAnalytic) return { ...made, db: analyticPostingHooks.postAnalytic(made.db, made.id) };
  if (line_ids.some((line) => Object.keys(line.analytic_distribution ?? {}).length)) throw new Error('Analytic posting support is not loaded');
  return made;
}

/** Resolve the unique payment default or an explicitly selected liquidity journal. */
export function paymentJournal(db, selectedJournalId = null, companyId = 1) {
  let journal = selectedJournalId ? read(db, 'account.journal', selectedJournalId) : null;
  if (selectedJournalId && !journal) throw new Error('Selected payment journal does not exist');
  if (!selectedJournalId) {
    const configured = search(db, 'account.journal').filter((candidate) => candidate.default_for_payments === true);
    const own = configured.filter((candidate) => candidate.company_id === companyId);
    const defaults = own.length ? own : configured.filter((candidate) => !candidate.company_id);
    if (!defaults.length) throw new Error('Select a payment journal or configure one default bank or cash journal');
    if (defaults.length !== 1) throw new Error('Configure exactly one default payment journal for this company');
    [journal] = defaults;
  }
  if (journal.active === false) throw new Error('The selected payment journal is archived');
  if (!isLiquidityJournal(journal)) throw new Error('Payment journal must be a bank or cash journal');
  if (companyId && journal.company_id && journal.company_id !== companyId) throw new Error('Payment journal belongs to another company');
  const id = assertCompanyAccount(db, journal.default_account_id, companyId, 'asset_cash', 'The selected journal liquidity account');
  const account = read(db, 'account.account', id);
  return { id: journal.id, code: journal.code, accountId: id, account_id: id, account: account.code };
}

/** Resolve the suspense account configured on the statement's journal. */
export function ensureBankSuspense(db, company, journalId) {
  const journal = read(db, 'account.journal', journalId ?? paymentJournal(db, null, company).id);
  const account = read(db, 'account.account', journal?.suspense_account_id);
  if (!account) throw new Error(`Configure the suspense account on journal ${journal?.name ?? journalId ?? '(not selected)'}`);
  if (journal?.company_id && journal.company_id !== company) throw new Error('Statement journal belongs to another company');
  if (account.active === false || (account.company_id && account.company_id !== company)) throw new Error('The suspense account must be active and belong to the statement company');
  return { db, id: account.id };
}

/** Resolve an optional journal outstanding account, falling back to the company setting. */
export function outstandingAccount(db, journal, company, inbound) {
  const field = inbound ? 'outstanding_receipts_account_id' : 'outstanding_payments_account_id';
  const id = journal?.[field] || read(db, 'res.company', company)?.[field];
  if (!id) return null;
  const account = read(db, 'account.account', id);
  if (!account || (account.company_id && account.company_id !== company)) throw new Error('Outstanding account must belong to the payment company');
  return id;
}

/** Statement amounts use the journal currency; open allocations use company currency. */
export function statementCompanyAmount(db, line, amount = Math.abs(Number(line.amount))) {
  const company = line.company_id ?? 1;
  const currency = read(db, 'account.journal', line.journal_id)?.currency_id ?? companyCurrencyRecord(db, company)?.id;
  return toCompany(db, currency, amount, line.date ?? today(), company);
}

/** Company amount of a statement line: what its bank entry booked, or a fresh conversion before booking. */
export function bookedStatementAmount(db, line) {
  if (!line.bank_move_id) return statementCompanyAmount(db, line);
  const company = line.company_id ?? 1;
  const entry = read(db, 'account.move', line.bank_move_id);
  const account = paymentJournal(db, line.journal_id, company).accountId;
  const item = (entry?.line_ids ?? []).find((l) => l.account_id === account);
  return roundCurrency(line.amount > 0 ? item?.debit : item?.credit, companyCurrencyRecord(db, company));
}

/** Check whether a payment is already matched by an active allocation or a reconciled statement line. */
export function isPaymentMatched(db, payment, excludeLineId = null) {
  const pId = typeof payment === 'object' && payment ? payment.id : payment;
  const pMoveId = typeof payment === 'object' && payment ? payment.move_id : (pId ? read(db, 'account.payment', pId)?.move_id : null);
  const { paymentLinesById, paymentLinesByMove } = reconcileIndex(db);
  const matches = [...(paymentLinesByMove.get(pMoveId) ?? []), ...(paymentLinesById.get(pId) ?? [])];
  return matches.some((lineId) => !excludeLineId || lineId !== excludeLineId);
}

/** Settlement links per move, built once per immutable records object (journalItems runs on every report). */
const reconcileIndexes = new WeakMap();
function reconcileIndex(db) {
  const cached = reconcileIndexes.get(db.records);
  if (cached) return cached;
  const push = (map, key, value) => map.set(key, [...(map.get(key) ?? []), value]);
  const applications = new Map();
  for (const invoice of db.records['account.move'] ?? []) {
    for (const row of (invoice.payments ?? []).filter((r) => !r.unapplied)) {
      push(applications, row.move_id, { invoice, row });
      if (row.reversed && row.reversal_move_id) push(applications, row.reversal_move_id, { invoice, row });
    }
  }
  const paymentRecords = db.records['account.payment'] ?? [];
  const payments = new Map(paymentRecords.filter((p) => p.move_id).map((p) => [p.move_id, p]));
  const paymentsById = new Map(paymentRecords.map((p) => [p.id, p]));
  const matchedPaymentMoves = new Set();
  const paymentLinesById = new Map();
  const paymentLinesByMove = new Map();
  const batches = new Map((db.records['account.batch.payment'] ?? []).map((batch) => [batch.id, batch]));
  const markPaymentMove = (moveId, statementId) => {
    if (!moveId) return;
    matchedPaymentMoves.add(moveId);
    push(paymentLinesByMove, moveId, statementId);
  };
  const markPaymentId = (id, statementId) => {
    if (!id) return;
    push(paymentLinesById, id, statementId);
    const payment = paymentsById.get(id);
    if (payment?.move_id) markPaymentMove(payment.move_id, statementId);
  };
  const settledSuspense = new Map();
  for (const statement of db.records['account.bank.statement.line'] ?? []) {
    for (const allocation of statement.allocations ?? []) {
      markPaymentMove(allocation.payment_move_id, statement.id);
    }
    if (statement.state === 'reconciled') {
      markPaymentMove(statement.payment_move_id, statement.id);
      markPaymentId(statement.payment_id, statement.id);
      for (const paymentId of statement.payment_ids ?? []) markPaymentId(paymentId, statement.id);
      if (statement.batch_payment_id) {
        for (const line of batches.get(statement.batch_payment_id)?.lines ?? []) {
          if (!line.cancelled && line.payment_id) markPaymentId(line.payment_id, statement.id);
        }
      }
    }
    if (statement.open_amount === 0) {
      const suspense = read(db, 'account.journal', statement.journal_id)?.suspense_account_id;
      for (const moveId of new Set([statement.bank_move_id, ...(statement.allocations ?? []).map((a) => a.payment_move_id)].filter(Boolean))) push(settledSuspense, moveId, suspense);
    }
  }
  const index = { applications, payments, matchedPaymentMoves, paymentLinesById, paymentLinesByMove, settledSuspense };
  reconcileIndexes.set(db.records, index);
  return index;
}

/** Derive reconciliation from settlement links, never from labels or a second stored flag. */
export function reconciledJournalItems(db, move) {
  const { applications: byMove, payments, matchedPaymentMoves, settledSuspense } = reconcileIndex(db);
  const applications = byMove.get(move.id) ?? [];
  const payment = payments.get(move.id);
  const posted = move.state === 'posted';
  const document = ['out_invoice', 'out_refund', 'in_invoice', 'in_refund'].includes(move.move_type);
  return (move.line_ids ?? []).map((line) => {
    if (!posted) return { ...line, reconciled: false };
    const account = read(db, 'account.account', line.account_id);
    let reconciled = false;
    if (['asset_receivable', 'liability_payable'].includes(account?.account_type)) {
      reconciled = document
        ? models['account.move'].fields.amount_residual.compute(move, db) === 0
        : applications.some(({ invoice, row }) => invoice.partner_id === line.partner_id
          && (invoice.company_id ?? 1) === (move.company_id ?? 1)
          && (invoice.line_ids ?? []).some((item) => item.account_id === line.account_id)
          && (row.reversed || !payment?.unapplied));
    }
    if (payment?.outstanding_account_id === line.account_id) reconciled = matchedPaymentMoves.has(move.id);
    if ((settledSuspense.get(move.id) ?? []).includes(line.account_id)) reconciled = true;
    return { ...line, reconciled };
  });
}

/** Identity of an embedded journal line, independent of its position and derived matching state. */
export function journalItemIdentity({ reconciled: _reconciled, ...line }) {
  return JSON.stringify(line);
}

/** Journal items with their move date, optionally limited by review status, date and company. */
export function journalItems(db, { from, to, company_id, company, reviewMode = 'posted' } = {}) {
  const targetCompany = company_id ?? company;
  const wantedState = reviewMode === 'draft' ? 'draft' : 'posted';
  const returns = new Map((db.records?.['account.return'] ?? []).map((r) => [r.id, r]));
  const settlementMoves = new Set((db.records?.['account.payment'] ?? []).filter((p) => p.is_tax_payment || p.return_id).map((p) => p.move_id).filter(Boolean));
  const rows = search(db, 'account.move')
    .filter((m) => {
      const date = m.date ?? m.invoice_date;
      return m.state === wantedState
      && (!from || date >= from)
      && (!to || date <= to)
      && (!targetCompany || (m.company_id ?? 1) === targetCompany)
    })
    .flatMap((m) => {
      const isTaxClosing = !!m.tax_return_id && (returns.get(m.tax_return_id)?.closing_move_ids ?? []).includes(m.id);
      const isTaxSettlement = settlementMoves.has(m.id) || (!!m.is_tax_payment && !!m.tax_return_id);
      return reconciledJournalItems(db, m).map((l) => ({
        ...l,
        line_identity: journalItemIdentity(l),
        move_id: m.id,
        move_name: m.name,
        date: m.date ?? m.invoice_date,
        move_state: m.state,
        company_id: m.company_id ?? 1,
        journal_id: m.journal_id,
        is_closing: !!m.is_closing,
        is_tax_closing: isTaxClosing,
        is_tax_payment: isTaxSettlement,
      }));
    });
  if (reviewMode !== 'unreconciled') return rows;
  return rows.filter((line) => {
    const account = read(db, 'account.account', line.account_id);
    const reconcilable = account?.reconcile === true || ['asset_receivable', 'liability_payable'].includes(account?.account_type);
    return reconcilable && line.reconciled !== true;
  });
}

/** Balance per account (debit − credit) over the given items. */
export function balances(db, items) {
  const map = new Map();
  for (const l of items) map.set(l.account_id, (map.get(l.account_id) ?? 0) + reportingBookedAmount(db, l, (Number(l.debit) || 0) - (Number(l.credit) || 0)));
  return [...map].map(([id, balance]) => ({ account: read(db, 'account.account', id), balance: round(balance) })).filter((b) => b.account);
}

/** Posted balance of `account` in its company currency (or the active company when shared). */
export function accountBalance(db, account) {
  if (!db || !account?.id) return 0;
  const companyId = account.company_id ?? db.settings?.current_company_id ?? 1;
  const scoped = (db.settings?.current_company_id ?? 1) === companyId ? db : { ...db, settings: { ...db.settings, current_company_id: companyId } };
  return balances(scoped, journalItems(scoped, { company_id: companyId })).find((b) => b.account.id === account.id)?.balance ?? 0;
}

const lineNet = (l) => (Number(l.debit) || 0) - (Number(l.credit) || 0);
export const hasAnalyticAllocation = (line) => line.analytic_distribution != null
  ? Object.keys(line.analytic_distribution).length > 0
  : !!line.analytic_account_id;
export const capAnalyticShare = (share) => Math.min(1, Math.max(0, Number(share) || 0));

const analyticShare = (line, selected) => {
  const rawShare = line.analytic_distribution
    ? Object.entries(line.analytic_distribution).reduce((total, [key, percent]) => (
      key.split(',').some((id) => selected.has(Number(id))) ? total + (Number(percent) || 0) : total
    ), 0) / 100
    : (selected.has(Number(line.analytic_account_id)) ? 1 : 0);
  return capAnalyticShare(rawShare);
};

/** Derive amount-weighted per-plan percentages from explicit allocations on source lines. */
export function analyticDistributionForLines(lines, analyticAccountIds) {
  const selected = analyticAccountIds?.length ? new Set(analyticAccountIds.map(Number)) : null;
  const contributions = new Map();
  const total = lines.filter(hasAnalyticAllocation).reduce((sum, line) => sum + Math.abs(lineNet(line)), 0);
  if (!total) return {};
  for (const line of lines) {
    if (!hasAnalyticAllocation(line)) continue;
    const amount = Math.abs(lineNet(line));
    if (!amount) continue;
    const distribution = line.analytic_distribution ?? { [line.analytic_account_id]: 100 };
    for (const [key, value] of Object.entries(distribution)) {
      const ids = key.split(',').map(Number).filter((id) => Number.isSafeInteger(id) && id > 0);
      const matched = selected ? ids.filter((id) => selected.has(id)) : ids;
      const percent = Number(value);
      if (!matched.length || !Number.isFinite(percent) || percent <= 0) continue;
      for (const id of matched) contributions.set(id, (contributions.get(id) ?? 0) + amount * percent / 100);
    }
  }
  return Object.fromEntries([...contributions].map(([id, amount]) => [id, amount / total * 100]));
}

/** Scale each item's debit and credit by an optional share (default 1), e.g. for a horizontal group column. */
const weighted = (items, weight) => weight ? items.map((l) => { const w = weight(l); return { ...l, debit: (Number(l.debit) || 0) * w, credit: (Number(l.credit) || 0) * w }; }) : items;

/** Journal items allocated to the selected analytic accounts; no selection keeps every item. */
export function filterByAnalytic(items, analyticAccountIds) {
  if (!analyticAccountIds?.length) return items;
  const selected = new Set(analyticAccountIds.map(Number));
  const shares = new Map();
  const filtered = items.filter((line) => {
    const share = analyticShare(line, selected);
    if (share <= 0) return false;
    shares.set(line, share);
    return true;
  });
  return weighted(filtered, (line) => shares.get(line));
}

/** Keep selected analytic lines and restore each move's untagged counterparts by the move's selected share, so filtered reports still balance. */
export function analyticMoveItems(items, analyticAccountIds) {
  if (!analyticAccountIds?.length) return items;
  const selected = filterByAnalytic(items, analyticAccountIds);
  const originalsByMove = new Map();
  const selectedByMove = new Map();
  for (const line of items) originalsByMove.set(line.move_id, [...(originalsByMove.get(line.move_id) ?? []), line]);
  for (const line of selected) selectedByMove.set(line.move_id, [...(selectedByMove.get(line.move_id) ?? []), line]);

  const output = [];
  for (const [moveId, matched] of selectedByMove) {
    const originals = originalsByMove.get(moveId) ?? [];
    const assigned = originals.filter(hasAnalyticAllocation);
    const assignedAmount = assigned.reduce((sum, line) => sum + Math.abs(lineNet(line)), 0);
    const matchedAmount = matched.filter(hasAnalyticAllocation).reduce((sum, line) => sum + Math.abs(lineNet(line)), 0);
    const share = assignedAmount ? Math.min(1, matchedAmount / assignedAmount) : 0;
    output.push(...matched);
    if (share) {
      const derivedDist = analyticDistributionForLines(matched, analyticAccountIds);
      output.push(...originals.filter((line) => !hasAnalyticAllocation(line)).map((line) => ({
        ...line,
        debit: (Number(line.debit) || 0) * share,
        credit: (Number(line.credit) || 0) * share,
        ...(Object.keys(derivedDist).length ? { analytic_distribution: derivedDist } : {}),
      })));
    }
  }
  return output;
}

const sumTypes = (rows, types, sign = 1) => round(rows.filter((r) => types.includes(r.account.account_type)).reduce((s, r) => s + sign * r.balance, 0));

/** Profit & loss figures (income shown positive); year-end closing entries are left out unless asked for. */
export function profitAndLoss(db, period, { includeClosing = false, weight, analyticAccountIds } = {}) {
  const items = filterByAnalytic(journalItems(db, period), analyticAccountIds).filter((l) => includeClosing || !l.is_closing);
  const rows = balances(db, weighted(items, weight));
  const revenue = sumTypes(rows, ['income'], -1);
  const cost = sumTypes(rows, ['expense_direct_cost']);
  const expense = sumTypes(rows, ['expense']);
  const otherIncome = sumTypes(rows, ['income_other'], -1);
  const otherExpense = sumTypes(rows, ['expense_other']);
  const lines = (types, sign) => rows.filter((r) => types.includes(r.account.account_type)).map((r) => ({ ...r, balance: round(sign * r.balance) }));
  return {
    revenue, cost, gross: round(revenue - cost), expense, operating: round(revenue - cost - expense),
    otherIncome, otherExpense, net: round(revenue - cost - expense + otherIncome - otherExpense),
    detail: { revenue: lines(['income'], -1), cost: lines(['expense_direct_cost'], 1), expense: lines(['expense'], 1), otherIncome: lines(['income_other'], -1), otherExpense: lines(['expense_other'], 1) },
  };
}

/**
 * First day of the fiscal year containing a date. Configured fiscal years decide it; after the last configured
 * year the same start repeats yearly, and a company without any year uses the calendar year (the app default).
 */
export function fiscalYearStart(db, date, companyId) {
  const years = search(db, 'account.fiscal.year').filter((y) => (y.company_id ?? 1) === companyId
    && y.date_from <= date && date <= y.date_to);
  if (years.length > 1) {
    const company = read(db, 'res.company', companyId)?.name ?? companyId;
    throw new Error(`Fiscal years overlap for company ${company} on ${date}`);
  }
  if (years.length === 1) return years[0].date_from;
  const previous = search(db, 'account.fiscal.year')
    .filter((y) => (y.company_id ?? 1) === companyId && y.date_to < date)
    .sort((a, b) => a.date_from.localeCompare(b.date_from)).at(-1);
  let start = previous?.date_from ?? `${date.slice(0, 4)}-01-01`;
  while (shiftMonth(start, 12) <= date) start = shiftMonth(start, 12);
  return start;
}

/** Balance sheet at a date; current-year earnings close into equity so assets = liabilities + equity. */
export function balanceSheet(db, at = today(), { weight, analyticAccountIds } = {}) {
  const filter = typeof at === 'object' && at !== null ? at : { to: at };
  const reportDate = filter.to ?? today();
  const items = analyticMoveItems(journalItems(db, { ...filter, to: reportDate }), analyticAccountIds);
  const rows = balances(db, weighted(items, weight));
  const pick = (types, sign) => rows.filter((r) => types.includes(r.account.account_type)).map((r) => ({ ...r, balance: round(sign * r.balance) }));
  const assets = pick(['asset_receivable', 'asset_cash', 'asset_current', 'asset_non_current', 'asset_prepayments', 'asset_fixed'], 1);
  const liabilities = pick(['liability_payable', 'liability_current', 'liability_non_current', 'liability_credit_card'], -1);
  let equity = pick(['equity', 'equity_unaffected'], -1);
  // Only a label here: an upgraded company without the setting still gets its balance sheet (Qodo 10).
  const reportCompanyId = filter.company_id ?? filter.company ?? db.settings?.current_company_id ?? 1;
  const earningsAccount = configuredEarningsAccount(db, reportCompanyId);
  // Closing entries carry no analytic allocation, so an analytic report keeps a closed year's P&L visible.
  // Split it from the current year and fold it into equity as prior unallocated earnings; their sum is unchanged.
  const targetCompany = filter.company_id ?? filter.company;
  // Each company splits its own earnings at its own fiscal-year start into its own earnings account.
  const companyIds = targetCompany != null ? [targetCompany] : search(db, 'res.company').map((c) => c.id);
  if (!companyIds.length) companyIds.push(reportCompanyId);
  let earnings = 0;
  for (const cId of companyIds) {
    const yearStart = fiscalYearStart(db, reportDate, cId);
    const cEarningsAccount = configuredEarningsAccount(db, cId);
    const currentFilter = { ...filter, company_id: cId, to: reportDate, from: filter.from && filter.from > yearStart ? filter.from : yearStart };
    const priorFilter = { ...filter, company_id: cId, to: addDays(yearStart, -1) };
    const cEarnings = profitAndLoss(db, currentFilter, { includeClosing: true, weight, analyticAccountIds }).net;
    const cPriorEarnings = profitAndLoss(db, priorFilter, { includeClosing: true, weight, analyticAccountIds }).net;
    earnings = round(earnings + cEarnings);
    if (cPriorEarnings) {
      const index = cEarningsAccount ? equity.findIndex((r) => r.account.id === cEarningsAccount.id) : -1;
      if (index >= 0) equity = equity.map((r, i) => (i === index ? { ...r, balance: round(r.balance + cPriorEarnings) } : r));
      else if (cEarningsAccount) equity.push({ account: cEarningsAccount, balance: round(cPriorEarnings) });
      else earnings = round(earnings + cPriorEarnings);
    }
  }
  const total = (list) => round(list.reduce((s, r) => s + r.balance, 0));
  return {
    assets, liabilities, equity, earnings, earningsAccount,
    totalAssets: total(assets), totalLiabilities: total(liabilities), totalEquity: round(total(equity) + earnings),
  };
}
