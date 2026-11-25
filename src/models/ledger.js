// Double-entry core: chart of accounts, journals, and helpers that turn business documents into balanced entries.
import { roundingAccount } from './configured-account.js';
import { create, read, search, write } from '../orm.js';
import { amounts, appliedCashRounding, companyRoundingMethod, invoiceTaxAmount, nextName, shiftMonth, today, addDays, total as moveTotal, validDate } from './common.js';
import { companyCurrency, conversionRate, rateAt, toCompany } from './currency.js';
import { cashBasisTransitionAccount, computeLineTaxes, isSectionOrNote, mapAccount, taxBaseTags, taxGroups, taxLabel, taxRepartitionLines, taxRepartitionSplits } from './taxes.js';
import { cashRound, companyCurrencyRecord, currencyUnits, documentCurrency, findCompanyCurrencyRecord, isCurrencyZero, round, roundCurrency } from '../money.js';
import { isPeriodicValuation, productProperty } from './productconfig-helpers.js';
import { discountTaxComputation, earlyDiscount, installments, mixedDiscountFactor } from './terms.js';
import { reportingBookedAmount } from './money.js';
import { configuredEarningsAccount } from './earnings.js';
import { resolveStockAccount } from './stock-accounts.js';
import { models } from '../registry.js';
import { normalizeDistribution } from '../analytic_distribution.js';
import { findAnalyticDistribution } from './analytic-distribution-models.js';
import { buildMatchingNumbers, entryMatchedAmounts, indexGlMatchings, lineKey } from './glMatchIndex.js';
import { DEFAULT_SEPA_PAIN_VERSION } from './sepa.js';
export { STOCK_CHART_ROLES } from './stock-accounts.js';

/** Whether `account` belongs to the income or expense account type family. */
export const isIncomeOrExpenseAccount = (account) => ['income', 'income_other', 'expense', 'expense_direct_cost', 'expense_depreciation', 'expense_other'].includes(account?.account_type);
export const analyticEligibleAccount = isIncomeOrExpenseAccount;
/** Whether journal items on `account` participate in reconciliation (AR, AP, or `reconcile` flag). */
export const isReconcilableAccount = (account) => Boolean(account?.reconcile === true || ['asset_receivable', 'liability_payable'].includes(account?.account_type));
let analyticPostingHooks = null;

export function registerAnalyticPostingHooks(hooks) {
  analyticPostingHooks = hooks;
}

export const ACCOUNT_TYPES = [
  ['asset_receivable', 'Receivable'], ['asset_cash', 'Bank and Cash'], ['asset_current', 'Current Assets'], ['asset_non_current', 'Non-current Assets'], ['asset_prepayments', 'Prepayments'], ['asset_fixed', 'Fixed Assets'],
  ['liability_payable', 'Payable'], ['liability_current', 'Current Liabilities'], ['liability_non_current', 'Non-current Liabilities'], ['liability_credit_card', 'Credit Card'], ['equity', 'Equity'], ['equity_unaffected', 'Current Year Earnings'], ['off_balance', 'Off-Balance Sheet'],
  ['income', 'Income'], ['income_other', 'Other Income'], ['expense_direct_cost', 'Cost of Revenue'], ['expense', 'Expenses'], ['expense_depreciation', 'Depreciation'], ['expense_other', 'Other Expenses'],
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
  { code: 'BNK1', name: 'Bank', type: 'bank', account: '101401', default_for_payments: true, payment_sequence: true, bank_statements_source: 'undefined', sepa_pain_version: DEFAULT_SEPA_PAIN_VERSION },
  { code: 'CSH1', name: 'Cash', type: 'cash', account: '101501', payment_sequence: true },
  { code: 'MISC', name: 'Miscellaneous Operations', type: 'general', company_default: 'general' },
  { code: 'SAL', name: 'Salaries', type: 'general', account: '620000' },
  { code: 'POSS', name: 'Point of Sale', type: 'sale', account: '400000', invoice_sequence_prefix: 'POS/', invoice_sequence_next_number: 1, refund_sequence: true, refund_sequence_prefix: 'RPOS/', refund_sequence_next_number: 1, invoice_reference_type: 'invoice', invoice_reference_model: 'odoo', company_default: 'pos' },
];

export const LIQUIDITY_JOURNAL_TYPES = ['bank', 'cash', 'credit'];
export const STATEMENT_JOURNAL_TYPES = ['bank', 'cash', 'credit'];
export const ONLINE_FEED_JOURNAL_TYPES = ['bank', 'credit'];
export const LIQUIDITY_ACCOUNT_TYPES = ['asset_cash', 'liability_credit_card'];
/** True when a journal (or journal type) acts as a liquidity journal (bank, cash, or credit card). */
export const isLiquidityJournal = (journalOrType) => LIQUIDITY_JOURNAL_TYPES.includes(typeof journalOrType === 'string' ? journalOrType : journalOrType?.type);
/** True when an account (or account type) is a liquidity account (bank, cash, or credit card). */
export const isLiquidityAccount = (accountOrType) => LIQUIDITY_ACCOUNT_TYPES.includes(typeof accountOrType === 'string' ? accountOrType : accountOrType?.account_type);
/** True when a journal (or journal type) supports bank/card statement reconciliation and outstanding payment accounts. */
export const isStatementJournal = (journalOrType) => STATEMENT_JOURNAL_TYPES.includes(typeof journalOrType === 'string' ? journalOrType : journalOrType?.type);
/** True when a journal (or journal type) supports online banking feeds (bank or credit card). */
export const isOnlineFeedJournal = (journalOrType) => ONLINE_FEED_JOURNAL_TYPES.includes(typeof journalOrType === 'string' ? journalOrType : journalOrType?.type);
/** Owning company ID of a journal; journals without `company_id` belong to company 1. */
export const journalCompany = (journal) => journal?.company_id ?? 1;

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

/** Verify storno provenance from the linked posted source and validate reversal lines. */
export function validStornoMove(db, move) {
  if (!move?.is_storno || !move?.reversed_entry_id) return false;
  const source = read(db, 'account.move', move.reversed_entry_id);
  const expected = { entry: 'entry', out_refund: 'out_invoice', in_refund: 'in_invoice' };
  if (!source || source.state !== 'posted' || source.id === move.id
    || (source.company_id ?? 1) !== (move.company_id ?? 1) || source.move_type !== expected[move.move_type]) {
    return false;
  }
  if ((move.partner_id ?? null) !== (source.partner_id ?? null)) return false;
  if ((move.currency_id ?? null) !== (source.currency_id ?? null)) return false;

  const lines = Array.isArray(move.line_ids) ? move.line_ids : [];
  if (!lines.length) return false;
  if (!lines.some((l) => (Number(l.debit) || 0) < 0 || (Number(l.credit) || 0) < 0)) return false;

  if (move.move_type === 'entry') {
    const sourceLines = source.line_ids ?? [];
    if (lines.length !== sourceLines.length) return false;
    const remaining = [...sourceLines];
    for (const line of lines) {
      const idx = remaining.findIndex((s) =>
        s.account_id === line.account_id
        && (Number(s.partner_id) || null) === (Number(line.partner_id) || null)
        && Math.abs((Number(line.debit) || 0) - (-(Number(s.debit) || 0))) < 1e-6
        && Math.abs((Number(line.credit) || 0) - (-(Number(s.credit) || 0))) < 1e-6
        && (s.currency_id ?? null) === (line.currency_id ?? null)
        && Math.abs((Number(line.amount_currency) || 0) - (s.currency_id ? -(Number(s.amount_currency) || 0) : 0)) < 1e-6
      );
      if (idx === -1) return false;
      remaining.splice(idx, 1);
    }
    return true;
  }

  if (['out_refund', 'in_refund'].includes(move.move_type)) {
    if (!Array.isArray(move.invoice_line_ids) || !move.invoice_line_ids.length) return false;
    const journal = move.journal_id ? read(db, 'account.journal', move.journal_id) : null;
    if (!journal) return false;
    const docCurr = documentCurrency(db, source);
    const docTotal = roundCurrency(moveTotal(move, db), docCurr);
    const srcTotal = roundCurrency(moveTotal(source, db), docCurr);
    const otherCredited = (db.records?.['account.move'] ?? [])
      .filter((m) => m.id !== move.id && m.state === 'posted' && m.reversed_entry_id === source.id)
      .reduce((sum, m) => sum + moveTotal(m, db), 0);
    if (!(docTotal > 0) || roundCurrency(otherCredited + docTotal, docCurr) > srcTotal) return false;
    const expectedLines = invoiceLines(db, { ...move, journal_id: journal.id });
    if (!expectedLines.length || lines.length !== expectedLines.length) return false;
    const remaining = [...expectedLines];
    for (const line of lines) {
      const idx = remaining.findIndex((exp) =>
        exp.account_id === line.account_id
        && (Number(exp.partner_id) || null) === (Number(line.partner_id) || null)
        && Math.abs((Number(line.debit) || 0) - (Number(exp.debit) || 0)) < 1e-6
        && Math.abs((Number(line.credit) || 0) - (Number(exp.credit) || 0)) < 1e-6
        && (exp.currency_id ?? null) === (line.currency_id ?? null)
        && Math.abs((Number(line.amount_currency) || 0) - (Number(exp.amount_currency) || 0)) < 1e-6
      );
      if (idx === -1) return false;
      remaining.splice(idx, 1);
    }
    return true;
  }

  return false;
}

/** Whether any line has a negative debit or credit. */
export const badLineSign = (lines = []) => lines.some((l) => (Number(l.debit) || 0) < 0 || (Number(l.credit) || 0) < 0);
/** Whether any line's amount_currency sign contradicts its debit/credit balance. */
export const badCurrencyAmountSign = (lines = []) => lines.some((l) => {
  const amount = Number(l.amount_currency) || 0;
  if (!amount) return false;
  const debit = Number(l.debit) || 0;
  const credit = Number(l.credit) || 0;
  return (amount > 0 && credit > debit) || (amount < 0 && debit > credit);
});
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

/**
 * Map an explicitly configured line account through the document's fiscal position exactly once.
 * Filled line accounts are stored already mapped, so posting never maps them a second time.
 */
export function mapLineAccount(db, move, accountId) {
  return accountId ? mapAccount(db, move?.fiscal_position_id, accountId) : null;
}

/**
 * Resolve the account a line posts to before any deferred-account substitution.
 * This is exactly the resolution `invoiceBaseGroups` uses; it returns the error message instead of throwing,
 * so forms can show the account without failing while the document is still incomplete.
 */
export function invoiceLineOriginalAccount(db, move, line, journal) {
  const sale = !['in_invoice', 'in_refund'].includes(move.move_type);
  const base = resolveCompanyAccount(db, journal?.default_account_id, move.company_id);
  const getSourceAccount = (l) => {
    // Provenance recorded when the source document was posted wins over current configuration.
    if (l.income_account_id) return { accountId: l.income_account_id, configured: true, type: 'line', recorded: true };
    if (l.account_id) return { accountId: l.account_id, configured: true, type: 'line' };
    const p = (db.records.product ?? []).find((p) => p.id === l.product_id);
    const dropship = !sale && read(db, 'purchase.order', move.purchase_id)?.dropship_partner_id;
    if (!sale && !dropship && p?.type === 'goods' && !isPeriodicValuation(db, p, move.company_id ?? 1)) {
      const stock = resolveStockAccount(db, p, 'input', move.company_id ?? 1);
      return stock.error ? { error: stock.error } : { accountId: stock.account, configured: true, type: 'valuation' };
    }
    const configured = productProperty(db, p, sale ? 'property_account_income_id' : 'property_account_expense_id', move.company_id ?? 1);
    if (configured) return { accountId: configured, configured: true, type: 'product' };
    if (!base) return { error: `Journal "${journal?.name || journal?.code}" has no default account configured for this company` };
    return { accountId: base, configured: true, type: 'journal default' };
  };
  const source = getSourceAccount(line);
  if (source.error) return { account: null, error: source.error };
  if (!source.accountId) return { account: null, error: `No ${source.type} account found` };
  // A line whose account was already mapped by the document's fiscal position posts as stored.
  // Every other stored account (from orders, manual selection, import/API, copies) is mapped through the fiscal position.
  // A line mapped by another fiscal position (a copy whose position changed) restarts from its product's account;
  // a line without a product keeps the account it was mapped to, since the unmapped original is not recorded.
  const mappedByOtherPosition = source.type === 'line' && Boolean(line.account_fiscal_position_id) && line.account_fiscal_position_id !== move?.fiscal_position_id;
  const productSource = mappedByOtherPosition && line.product_id ? getSourceAccount({ ...line, account_id: null, income_account_id: null }) : null;
  const alreadyMapped = Boolean(
    source.recorded ||
    (source.type === 'line' && move?.fiscal_position_id && line.account_fiscal_position_id === move.fiscal_position_id) ||
    (mappedByOtherPosition && !productSource?.accountId)
  );
  const rawAccountId = productSource?.accountId ?? source.accountId;
  const mapped = alreadyMapped ? source.accountId : mapLineAccount(db, move, rawAccountId);
  const mappedAccount = read(db, 'account.account', mapped);
  const selectedForeignAccount = mappedAccount?.company_id && mappedAccount.company_id !== (move.company_id ?? 1);
  const resolved = selectedForeignAccount && source.type !== 'journal default' ? null : resolveCompanyAccount(db, mapped, move.company_id);
  if (!resolved) {
    if (source.configured) return { account: null, error: `Configured ${source.type} account does not exist for the invoice company` };
    return { account: null, error: 'No valid account for the invoice company' };
  }
  return { account: resolved, error: null };
}

/**
 * Full per-line account resolution used by posting: the original account plus any deferred substitution.
 * Returns the error message instead of throwing, so form code can resolve the same account without failing.
 */
export function invoiceLineAccountResult(db, move, line, journal = resolveDocumentJournal(db, move)) {
  if (!journal) return { account: null, original: null, deferred: false, error: null };
  const sale = !['in_invoice', 'in_refund'].includes(move.move_type);
  const { account: original, error } = invoiceLineOriginalAccount(db, move, line, journal);
  if (error) return { account: null, original: null, deferred: false, error };
  const originalAccount = read(db, 'account.account', original);
  const deferred = Boolean(line.deferred_start_date || line.deferred_end_date || originalAccount?.is_deferred);
  if (deferred && (!line.deferred_start_date || !line.deferred_end_date || line.deferred_start_date > line.deferred_end_date)) {
    return { account: null, original, deferred, error: 'Set valid deferred start and end dates' };
  }
  const company = read(db, 'res.company', move.company_id ?? 1);
  const account = deferred ? (originalAccount?.deferred_account_id || company?.[sale ? 'deferred_revenue_account_id' : 'deferred_expense_account_id']) : original;
  if (deferred && !account) return { account: null, original, deferred, error: `Configure the deferred ${sale ? 'revenue' : 'expense'} account on the company` };
  const selected = read(db, 'account.account', account);
  if (deferred && (!selected || (selected.company_id && selected.company_id !== (move.company_id ?? 1)))) {
    return { account: null, original, deferred, error: 'Deferred account must belong to the document company' };
  }
  return { account, original, deferred, error: null };
}

/** Invoice base groups, including the source lines used to allocate a posted group. */
export function invoiceBaseGroups(db, move, roundingMethod = companyRoundingMethod(db, move.company_id)) {
  const journal = resolveDocumentJournal(db, move, { required: true });
  const byAccount = new Map();
  for (const [index, l] of (move.invoice_line_ids ?? []).entries()) {
    if (isSectionOrNote(l)) continue;
    const { account, original, deferred, error } = invoiceLineAccountResult(db, move, l, journal);
    if (error) throw new Error(error);
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
        const use_in_tax_closing = t.tax_cash_basis ? false : (row.use_in_tax_closing === true);
        const key = `${account_id}|${tax_id ?? ''}|${tax_tag_ids.join(',')}|${use_in_tax_closing}`;
        const g = by.get(key) ?? { account_id, tax_id, tax_name, tax_tag_ids, use_in_tax_closing, cash_basis: !!t.tax_cash_basis, document_base: 0, document_amount: 0 };
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

/**
 * Invoice tax breakdown grouped by `account.tax.group` with `preceding_subtotal` lines (Odoo 20 TaxTotals).
 * Totals stay identical to `amount_untaxed`, `amount_tax`, and `amount_total`.
 */
export function invoiceTaxTotals(db, move) {
  if (!move || !['out_invoice', 'out_refund', 'in_invoice', 'in_refund'].includes(move.move_type)) return null;
  let docCurrency;
  try {
    docCurrency = documentCurrency(db, move);
  } catch (err) {
    if (/configure.*currency/i.test(err?.message)) return null;
    throw err;
  }
  const roundingMethod = companyRoundingMethod(db, move.company_id);
  const side = ['out_refund', 'in_refund'].includes(move.move_type) ? 'refund' : 'invoice';
  const lines = move.invoice_line_ids ?? [];
  const untaxed = amounts(lines, docCurrency, { roundingMethod, side }).untaxed;
  const rawItems = taxGroups(lines, () => null, 1, docCurrency, docCurrency, { roundingMethod, side });
  const term = db && move.invoice_payment_term_id && read(db, 'account.payment.term', move.invoice_payment_term_id);
  const discountFactor = mixedDiscountFactor(term);
  const scaledItems = discountFactor === 1
    ? rawItems
    : rawItems.map((g) => ({ ...g, amount: roundCurrency(g.document_amount * discountFactor, docCurrency) }));
  const nonZeroItems = scaledItems.filter((g) => g.amount !== 0);
  // The stored tax (with any biggest-tax cash rounding) is canonical: the breakdown's rounding gap goes to its biggest tax.
  const storedTax = invoiceTaxAmount(move, db, roundingMethod) ?? 0;
  const diff = roundCurrency(storedTax - nonZeroItems.reduce((s, g) => s + g.amount, 0), docCurrency);
  if (diff !== 0 && nonZeroItems.length) {
    const largestIdx = nonZeroItems.reduce((best, g, i) => (Math.abs(g.amount) > Math.abs(nonZeroItems[best].amount) ? i : best), 0);
    nonZeroItems[largestIdx] = { ...nonZeroItems[largestIdx], amount: roundCurrency(nonZeroItems[largestIdx].amount + diff, docCurrency) };
  }

  const byGroup = new Map();
  for (const item of nonZeroItems) {
    const groupId = item.tax_group_id ?? (db && item.tax_id ? read(db, 'account.tax', item.tax_id)?.tax_group_id ?? null : null);
    const groupRec = db && groupId ? read(db, 'account.tax.group', groupId) : null;
    const key = groupRec ? groupRec.id : 'none';
    const existing = byGroup.get(key) ?? {
      tax_group_id: groupRec?.id ?? null,
      name: groupRec?.name ?? 'Taxes',
      sequence: groupRec ? Number(groupRec.sequence ?? 10) : Number.MAX_SAFE_INTEGER,
      id: groupRec?.id ?? Number.MAX_SAFE_INTEGER,
      preceding_subtotal: String(groupRec?.preceding_subtotal ?? '').trim(),
      amount: 0,
    };
    byGroup.set(key, { ...existing, amount: roundCurrency(existing.amount + item.amount, docCurrency) });
  }

  const orderedGroups = [...byGroup.values()]
    .filter((g) => g.amount !== 0)
    .sort((a, b) => (a.sequence - b.sequence) || (a.id - b.id));

  const subtotals = [];
  let runningTotal = untaxed;
  if (!orderedGroups.length) {
    subtotals.push({ name: 'Untaxed Amount', amount: untaxed, groups: [] });
  } else {
    for (const group of orderedGroups) {
      const label = group.preceding_subtotal || (subtotals.length === 0 ? 'Untaxed Amount' : null);
      if (subtotals.length === 0) {
        subtotals.push({ name: label, amount: untaxed, groups: [group] });
      } else if (label && label !== subtotals[subtotals.length - 1].name) {
        subtotals.push({ name: label, amount: runningTotal, groups: [group] });
      } else {
        subtotals[subtotals.length - 1].groups.push(group);
      }
      runningTotal = roundCurrency(runningTotal + group.amount, docCurrency);
    }
  }

  const taxTotal = roundCurrency(orderedGroups.reduce((s, g) => s + g.amount, 0), docCurrency);
  const totalAmount = moveTotal(move, db) ?? roundCurrency(untaxed + taxTotal, docCurrency);
  const roundingAmount = roundCurrency(totalAmount - roundCurrency(untaxed + taxTotal, docCurrency), docCurrency);
  return { untaxed, tax: taxTotal, total: totalAmount, rounding_amount: roundingAmount, subtotals };
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
  // Tax lines are kept apart per tax so the tax return can read tax and base straight from the ledger.
  const taxes = invoiceTaxGroups(db, move, roundingMethod);
  const netTaxDoc = docRound(taxes.reduce((s, g) => s + g.document_amount, 0));
  const rounding = appliedCashRounding(move.invoice_cash_rounding_id ? read(db, 'account.cash.rounding', move.invoice_cash_rounding_id) : null, netTaxDoc !== 0);

  const rawTotalDoc = mixedDiscountFactor(term) !== 1
    ? docRound(amounts(move.invoice_line_ids, docCurrency, { roundingMethod, side: refund ? 'refund' : 'invoice' }).untaxed + taxes.reduce((s, group) => s + group.document_amount, 0))
    : amounts(move.invoice_line_ids, docCurrency, { roundingMethod, side: refund ? 'refund' : 'invoice' }).total;
  const totalDoc = rounding ? docRound(cashRound(rawTotalDoc, rounding.rounding, rounding.rounding_method)) : rawTotalDoc;
  const diffDoc = docRound(totalDoc - rawTotalDoc);
  const total = companyRound(totalDoc / rate);
  const diff = companyRound(diffDoc / rate);

  const adjustTax = Boolean(rounding && rounding.strategy === 'biggest_tax' && netTaxDoc !== 0 && diffDoc !== 0);
  if (adjustTax) {
    const largest = taxes.reduce(
      (best, g, i) => (Math.abs(g.amount) > Math.abs(taxes[best].amount) || (Math.abs(g.amount) === Math.abs(taxes[best].amount) && Math.abs(g.document_amount) > Math.abs(taxes[best].document_amount)) ? i : best),
      0,
    );
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

  const baseDate = validDate(move.invoice_date) ? move.invoice_date : today();
  const schedule = term ? installments(term, totalDoc, baseDate, docCurrency) : [{ date: move.invoice_date_due, amount: totalDoc }];
  let allocated = 0;
  let cumDoc = 0;
  const discountDate = term?.early_discount ? addDays(baseDate, Number(term.discount_days) || 0) : null;
  const discountPercent = term?.early_discount ? Number(term.discount_percent) || 0 : 0;
  const counterparts = schedule.map((item, index) => {
    cumDoc = docRound(cumDoc + item.amount);
    const targetCompany = index === schedule.length - 1 ? total : (totalDoc !== 0 ? companyRound(total * (cumDoc / totalDoc)) : 0);
    const amount = companyRound(targetCompany - allocated);
    allocated = companyRound(allocated + amount);
    const discountDoc = term?.early_discount && index === 0
      ? docRound(earlyDiscount(term, ['excluded', 'mixed'].includes(discountTaxComputation(term)) ? bases.reduce((s, [, , a]) => s + a, 0) : totalDoc, baseDate, baseDate, docCurrency))
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
    ...taxes.map((g) => ({ account_id: g.account_id, partner_id: move.partner_id, name: g.tax_name, ...side(g.amount, !sale, g.document_amount), tax_id: g.tax_id, tax_name: g.tax_name, tax_base: refund && !g.amount ? -g.base : g.base, use_in_tax_closing: g.cash_basis ? false : (g.use_in_tax_closing === true), ...(!g.cash_basis ? { tax_side: sale ? 'sale' : 'purchase' } : {}), ...(g.tax_tag_ids.length ? { tax_tag_ids: g.tax_tag_ids } : {}) })),
    ...roundingLines,
  ].filter((l) => l.debit || l.credit || l.amount_currency || l.invoice_sources?.length || l.tax_base)
    .map((line) => stornoLine(line, move.is_storno));
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
 * Currency fields a journal item needs when it is stated in a foreign currency. An explicit line currency wins; an
 * account currency is applied to generated lines that do not choose one. The amount in that currency comes from the
 * company amount at the entry date, so every generator posts converted journal items through one helper.
 */
export function accountCurrencyFields(db, account, line, net, companyId, date) {
  const companyCurrency = companyCurrencyRecord(db, companyId);
  const explicit = line.currency_id ? read(db, 'res.currency', line.currency_id) : null;
  if (line.currency_id && !explicit) throw new Error('Journal item currency does not exist');
  const accountCurrency = account?.currency_id ? read(db, 'res.currency', account.currency_id) : null;
  if (account?.currency_id && !accountCurrency) throw new Error('Select an existing account currency');
  const applied = accountCurrency && accountCurrency.id !== companyCurrency.id ? accountCurrency : null;
  const currency = explicit ?? applied;
  if (!currency) return {};
  const amount = line.amount_currency == null && currency.id === applied?.id
    ? net * rateAt(db, currency.id, date, companyId)
    : line.amount_currency;
  return { currency_id: currency.id, amount_currency: roundCurrency(amount ?? 0, currency) };
}

/**
 * Currency fields for a line that only adjusts the company value (exchange difference, revaluation): on an account
 * forcing a foreign currency the line carries that currency with no foreign amount.
 */
export function valueOnlyCurrencyFields(db, account, companyId, currencyId = null) {
  const acc = read(db, 'account.account', typeof account === 'number' ? account : accountId(db, account, companyId));
  const companyCurrencyId = companyCurrencyRecord(db, companyId)?.id;
  const foreignId = acc?.currency_id && acc.currency_id !== companyCurrencyId ? acc.currency_id : currencyId;
  return foreignId && foreignId !== companyCurrencyId ? { currency_id: foreignId, amount_currency: 0 } : {};
}

/** Journal of realized exchange difference entries: the company's exchange journal, else its default general journal. */
export function exchangeJournal(db, companyId) {
  const company = companyId ?? 1;
  const journalId = read(db, 'res.company', company)?.currency_exchange_journal_id ?? null;
  return resolveDocumentJournal(db, { move_type: 'entry', company_id: company, journal_id: journalId }, { required: true });
}

// Convert ordinary reversal columns to the equivalent negative same-side columns.
export function stornoLine(line, enabled) {
  return enabled ? { ...line, debit: -(Number(line.credit) || 0) || 0, credit: -(Number(line.debit) || 0) || 0 } : line;
}

/**
 * Turn a posted journal item into a postEntry line for a reversing entry:
 * swaps debit and credit, preserves partner_id and analytic_distribution, and
 * keeps the same currency_id with amount_currency negated when present.
 */
export function reversalLine(line) {
  const accountId = line.account_id ?? line.account;
  return {
    account: accountId,
    account_id: accountId,
    debit: line.credit ?? 0,
    credit: line.debit ?? 0,
    partner_id: line.partner_id ?? null,
    ...(line.analytic_distribution != null ? { analytic_distribution: line.analytic_distribution } : {}),
    ...(line.currency_id ? {
      currency_id: line.currency_id,
      amount_currency: -(Number(line.amount_currency) || 0) || 0,
    } : {}),
  };
}

/**
 * Create and post a miscellaneous entry.
 * Tax lines may carry `tax_name` and `tax_base` (company currency) for the tax return.
 * @param {{journal: string, date?: string, ref?: string, lines: {account_id: number, debit?: number, credit?: number, partner_id?: number, name?: string, tax_name?: string, tax_base?: number}[]}} spec
 */
export function postEntry(db, { journal, journal_id = null, date = today(), ref = '', lines, company = null, state = 'posted', auto_post = null, fx_payment_move_id = null, fx_invoice_id = null, is_tax_payment = false, tax_return_id = null, deferred_adjustment_of_id = null, deferred_entry_type = null, system_generated = false, archivedOriginIds = [], includeCashBasisTargets = false }) {
  if (!['posted', 'draft'].includes(state)) throw new Error('Entry state must be posted or draft');
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
    const currencyFields = accountCurrencyFields(db, acc, l, net, company, date);
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
    return { account_id: accId, ...(l.product_id ? { product_id: l.product_id } : {}), ...(analyticDistribution != null ? { analytic_distribution: analyticDistribution } : {}), partner_id: l.partner_id ?? null, name: l.name ?? ref, debit: Math.max(0, net), credit: Math.max(0, -net), ...currencyFields, ...((l.tax_name || l.tax_grid_base) ? { ...(l.tax_id != null ? { tax_id: l.tax_id } : {}), ...(l.tax_name ? { tax_name: l.tax_name } : {}), tax_base: roundCurrency(l.tax_base ?? 0, ownCurrency), ...(l.tax_base_signed ? { tax_base_signed: true } : {}), ...(l.tax_zero ? { tax_zero: true } : {}), ...(l.tax_side ? { tax_side: l.tax_side } : {}) } : {}), ...(l.tax_side ? { tax_side: l.tax_side } : {}), ...(l.type_tax_use ? { type_tax_use: l.type_tax_use } : {}), ...(l.tax_tag_ids?.length ? { tax_tag_ids: [...l.tax_tag_ids] } : {}), ...(l.tax_grid_base ? { tax_grid_base: true, tax_side: l.tax_side } : {}), ...(l.tax_grid_release ? { tax_grid_release: true } : {}), ...(l.use_in_tax_closing != null ? { use_in_tax_closing: Boolean(l.use_in_tax_closing) } : {}) };
  });
  if (!isBalanced(line_ids, companyCurrencyRecord(db, company))) throw new Error('Journal entry is not balanced');
  if (analyticPostingHooks?.checkMandatoryPlans) {
    analyticPostingHooks.checkMandatoryPlans(db, { ...moveContext, line_ids }, { systemGenerated: system_generated });
  } else if (search(db, 'account.analytic.plan').length) {
    throw new Error('Analytic posting support is not loaded');
  }
  const isDraft = state === 'draft';
  const journalCode = j?.code ?? journal;
  const prefix = `${journalCode}/${date.slice(0, 4)}/`;
  const name = isDraft ? '/' : nextName(db, 'account.move', prefix);
  const made = create(db, 'account.move', {
    move_type: 'entry', state: isDraft ? 'draft' : 'posted', journal_id: jId, invoice_date: date, date, ref, ...(company ? { company_id: company } : {}),
    name, line_ids, partner_id: lines.find((l) => l.partner_id)?.partner_id ?? null,
    ...(auto_post ? { auto_post } : {}),
    ...(is_tax_payment ? { is_tax_payment: true } : {}),
    ...(tax_return_id ? { tax_return_id } : {}),
    ...(deferred_adjustment_of_id ? { deferred_adjustment_of_id } : {}),
    ...(deferred_entry_type ? { deferred_entry_type } : {}),
    ...(system_generated ? { system_generated: true } : {}),
  }, { archivedOriginIds, includeCashBasisTargets });
  if (isDraft) return made;
  if (analyticPostingHooks?.postAnalytic) return { ...made, db: analyticPostingHooks.postAnalytic(made.db, made.id) };
  if (line_ids.some((line) => Object.keys(line.analytic_distribution ?? {}).length)) throw new Error('Analytic posting support is not loaded');
  return made;
}

/**
 * Return the id of the company's unique active default_for_payments liquidity journal or null (no throw),
 * or throw when `throwErrors` is set.
 */
export function defaultPaymentJournalId(db, companyId = 1, { throwErrors = false } = {}) {
  const company = companyId ?? 1;
  const companies = db.records['res.company'] ?? [];
  const singleCompany = companies.length <= 1 && (!companies.length || companies[0].id === company);
  const defaults = search(db, 'account.journal').filter((candidate) => candidate.default_for_payments === true
    && (candidate.company_id === company || (singleCompany && candidate.company_id == null)));
  if (!defaults.length) {
    if (throwErrors) throw new Error('Select a payment journal or configure one default bank or cash journal');
    return null;
  }
  if (defaults.length !== 1) {
    if (throwErrors) throw new Error('Configure exactly one default payment journal for this company');
    return null;
  }
  const [journal] = defaults;
  if (journal.active === false || !isLiquidityJournal(journal)) {
    if (!throwErrors) return null;
  }
  return journal.id;
}

/** Resolve the unique payment default or an explicitly selected liquidity journal. */
export function paymentJournal(db, selectedJournalId = null, companyId = 1) {
  const company = companyId ?? 1;
  let journal = selectedJournalId ? read(db, 'account.journal', selectedJournalId) : null;
  if (selectedJournalId && !journal) throw new Error('Selected payment journal does not exist');
  if (!selectedJournalId) {
    const journalId = defaultPaymentJournalId(db, company, { throwErrors: true });
    journal = read(db, 'account.journal', journalId);
  }
  if (journal.active === false) throw new Error('The selected payment journal is archived');
  if (!isLiquidityJournal(journal)) throw new Error('Payment journal must be a bank or cash journal');
  if (journal.company_id && journal.company_id !== company) throw new Error('Payment journal belongs to another company');
  const id = assertCompanyAccount(db, journal.default_account_id, company, journal.type === 'credit' ? 'liability_credit_card' : 'asset_cash', 'The selected journal liquidity account');
  const account = read(db, 'account.account', id);
  return { id: journal.id, code: journal.code, accountId: id, account_id: id, account: account.code };
}

/** Resolve or create the bank suspense account for the company. */
export function ensureBankSuspense(db, company, journalId) {
  const compId = company ?? 1;
  const journal = journalId ? read(db, 'account.journal', journalId) : null;
  if (journal?.company_id && journal.company_id !== compId) throw new Error('The bank journal belongs to another company or does not exist');
  if (journal?.suspense_account_id && journal.suspense_account_id === journal.default_account_id) {
    throw new Error('Configure a bank suspense account on the journal or the company');
  }

  if (journal?.suspense_account_id && journal.suspense_account_id !== journal.default_account_id) {
    const account = read(db, 'account.account', journal.suspense_account_id);
    if (!account || account.active === false || (account.company_id && account.company_id !== compId)) {
      throw new Error('The suspense account must be active and belong to the statement company');
    }
    return { db, id: account.id };
  }

  const comp = read(db, 'res.company', compId);
  const compSuspenseId = comp?.account_journal_suspense_account_id;
  const compAccount = compSuspenseId ? read(db, 'account.account', compSuspenseId) : null;
  const hasValidCompAccount = compAccount && compAccount.active !== false && (!compAccount.company_id || compAccount.company_id === compId) && compAccount.id !== journal?.default_account_id;

  if (hasValidCompAccount) {
    return { db, id: compAccount.id };
  }

  // Odoo always has a suspense account; create one with the first free code when none is configured.
  const taken = new Set((db.records['account.account'] ?? []).filter((a) => !a.company_id || a.company_id === compId).map((a) => a.code));
  let code = 101404;
  while (taken.has(String(code))) code += 1;
  const created = create(db, 'account.account', {
    name: 'Bank Suspense Account',
    code: String(code),
    account_type: 'asset_current',
    company_id: compId,
    reconcile: true,
  });
  const nextDb = write(created.db, 'res.company', compId, { account_journal_suspense_account_id: created.id });
  return { db: nextDb, id: created.id };
}

/** Resolve a payment method line's override account, else the optional journal/company outstanding account. */
export function outstandingAccount(db, journal, company, inbound, methodLine = null) {
  const line = typeof methodLine === 'number' ? read(db, 'account.payment.method.line', methodLine) : methodLine;
  const field = inbound ? 'outstanding_receipts_account_id' : 'outstanding_payments_account_id';
  const id = line?.payment_account_id || journal?.[field] || read(db, 'res.company', company)?.[field];
  if (!id) return null;
  const account = read(db, 'account.account', id);
  if (!account || (account.company_id && account.company_id !== company)) throw new Error('Outstanding account must belong to the payment company');
  return id;
}

/** Statement amounts use the line's recorded currency or the journal currency; open allocations use company currency. */
export function statementCompanyAmount(db, line, amount = Math.abs(Number(line.amount)), { allowUnavailable = false } = {}) {
  const company = line.company_id ?? 1;
  if (allowUnavailable) {
    const own = findCompanyCurrencyRecord(db, company);
    const currencyId = line.currency_id ?? read(db, 'account.journal', line.journal_id)?.currency_id ?? own?.id;
    if (!own || !read(db, 'res.currency', currencyId)) return null;
    if (currencyId !== own.id) {
      const baseId = db?.settings?.base_currency_id;
      if (!baseId || !read(db, 'res.currency', baseId) || conversionRate(db, own.id, currencyId, line.date ?? today(), company) == null) return null;
    }
  }
  const currency = line.currency_id ?? read(db, 'account.journal', line.journal_id)?.currency_id ?? companyCurrencyRecord(db, company)?.id;
  return toCompany(db, currency, amount, line.date ?? today(), company);
}

/** IDs of active payments linked to a bank statement line (allocations, batch, multi-select, or single). */
export function statementPaymentIds(db, line) {
  if (!line) return [];
  const allocated = (line.allocations ?? []).flatMap((a) => a.payment_ids ?? []);
  let current = [];
  if (line.batch_payment_id) {
    current = (read(db, 'account.batch.payment', line.batch_payment_id)?.lines ?? [])
      .filter((l) => !l.cancelled && l.payment_id)
      .map((l) => l.payment_id);
  } else if (Array.isArray(line.payment_ids) && line.payment_ids.length > 0) {
    current = line.payment_ids.filter(Boolean);
  } else if (line.payment_id) {
    current = [line.payment_id];
  }
  return [...new Set([...allocated, ...current].filter(Boolean))];
}

/** Resolve the suspense account ID from an already booked bank entry, falling back to current journal/company configuration. */
export function bookedBankSuspenseAccountId(db, line, move = null) {
  if (!line?.bank_move_id) return null;
  const bankEntry = move ?? read(db, 'account.move', line.bank_move_id);
  const company = line.company_id ?? 1;
  const journalId = line.journal_id ?? bankEntry?.journal_id ?? paymentJournal(db, null, company).id;
  const journal = journalId ? read(db, 'account.journal', journalId) : null;
  const liquidity = journal?.default_account_id ?? paymentJournal(db, journalId, company)?.accountId;
  const lines = bankEntry?.line_ids ?? [];
  const nonLiquidity = lines.filter((l) => l.account_id !== liquidity);
  if (nonLiquidity.length === 1) {
    const acc = read(db, 'account.account', nonLiquidity[0].account_id);
    if (!acc || !['asset_receivable', 'liability_payable'].includes(acc.account_type)) {
      return nonLiquidity[0].account_id;
    }
  }
  const configured = journal?.suspense_account_id && journal.suspense_account_id !== liquidity
    ? journal.suspense_account_id
    : read(db, 'res.company', company)?.account_journal_suspense_account_id;
  if (configured && lines.some((l) => l.account_id === configured)) return configured;
  const candidate = nonLiquidity.find((l) => {
    const acc = read(db, 'account.account', l.account_id);
    return acc && !['asset_receivable', 'liability_payable'].includes(acc.account_type);
  });
  if (candidate) return candidate.account_id;
  return configured ?? nonLiquidity[0]?.account_id ?? null;
}

/** Whether a statement line's bank_move_id was booked through its journal's suspense account (not a direct-payment bank entry). */
export function isBookedToSuspense(db, line) {
  if (!line?.bank_move_id) return false;
  const suspenseId = bookedBankSuspenseAccountId(db, line);
  if (!suspenseId) return false;
  const bankEntry = read(db, 'account.move', line.bank_move_id);
  return (bankEntry?.line_ids ?? []).some((l) => l.account_id === suspenseId);
}

/** Company amount of a statement line: what its bank entry booked, or a fresh conversion before booking. */
export function bookedStatementAmount(db, line) {
  if (!line.bank_move_id) return statementCompanyAmount(db, line);
  const company = line.company_id ?? 1;
  const account = paymentJournal(db, line.journal_id, company).accountId;
  const sign = line.amount > 0 ? 1 : -1;
  const bankEntry = read(db, 'account.move', line.bank_move_id);
  const liquidityLines = (bankEntry?.line_ids ?? []).filter((item) => item.account_id === account);
  const signedLiquidity = liquidityLines.map((item) => sign * ((Number(item.debit) || 0) - (Number(item.credit) || 0)));
  if (signedLiquidity.some((amount) => amount < 0)) {
    return roundCurrency(signedLiquidity.filter((amount) => amount > 0).reduce((sum, amount) => sum + amount, 0), companyCurrencyRecord(db, company));
  }
  const directMoves = !isBookedToSuspense(db, line) && line.state === 'reconciled' && (line.allocations ?? []).every((a) => !a.invoice_id && !a.reconcile_model_id)
    ? statementPaymentIds(db, line)
        .map((id) => read(db, 'account.payment', id))
        .filter((p) => p && !p.outstanding_account_id && p.move_id)
        .map((p) => p.move_id)
    : [];
  const moveIds = new Set([line.bank_move_id, ...directMoves]);
  const total = [...moveIds].reduce((sum, moveId) => {
    const entry = read(db, 'account.move', moveId);
    return sum + (entry?.line_ids ?? [])
      .filter((l) => l.account_id === account)
      .reduce((s, l) => s + sign * ((Number(l.debit) || 0) - (Number(l.credit) || 0)), 0);
  }, 0);
  return roundCurrency(total, companyCurrencyRecord(db, company));
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
      for (const paymentId of allocation.payment_ids ?? []) markPaymentId(paymentId, statement.id);
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
      const journal = read(db, 'account.journal', statement.journal_id);
      const suspense = journal?.suspense_account_id && journal.suspense_account_id !== journal.default_account_id
        ? journal.suspense_account_id
        : read(db, 'res.company', statement.company_id ?? journal?.company_id ?? 1)?.account_journal_suspense_account_id;
      for (const moveId of new Set([statement.bank_move_id, ...(statement.allocations ?? []).map((a) => a.payment_move_id)].filter(Boolean))) push(settledSuspense, moveId, suspense);
    }
  }
  const glMatchings = indexGlMatchings(db);
  const index = { applications, payments, matchedPaymentMoves, paymentLinesById, paymentLinesByMove, settledSuspense, glMatchings, matchingNumbers: new Map() };
  reconcileIndexes.set(db.records, index);
  const lineCache = new Map();
  const isLineReconciled = (moveId, lineIdx) => {
    if (!lineCache.has(moveId)) {
      const m = read(db, 'account.move', moveId);
      lineCache.set(moveId, m ? computeReconciledItems(db, m, index) : []);
    }
    return Boolean(lineCache.get(moveId)?.[lineIdx]?.reconciled);
  };
  index.matchingNumbers = buildMatchingNumbers(db, index, isLineReconciled);
  return index;
}

const cleanSignedZero = (value) => (value == null ? null : Math.abs(value) < 1e-12 ? 0 : value);

/** Compute per-line residual amounts in company currency and line currency for reconcilable items. */
export function journalItemResidual(db, move, line, { reconciled = false, ownCurrency = findCompanyCurrencyRecord(db, move?.company_id ?? 1) } = {}) {
  const account = read(db, 'account.account', line?.account_id);
  if (!isReconcilableAccount(account)) return { amount_residual: null, amount_residual_currency: null };
  const roundOwn = (value) => cleanSignedZero(ownCurrency ? roundCurrency(value, ownCurrency) : round(value));
  const lineBalance = roundOwn((Number(line.debit) || 0) - (Number(line.credit) || 0));
  const foreign = Boolean(line.currency_id && ownCurrency && line.currency_id !== ownCurrency.id);
  const foreignCurr = foreign ? read(db, 'res.currency', line.currency_id) : null;
  const roundLine = (value) => cleanSignedZero(foreignCurr ? roundCurrency(value, foreignCurr) : roundOwn(value));
  const lineAmountCurr = foreign ? roundLine(Number(line.amount_currency) || 0) : lineBalance;
  if (move?.state === 'cancel' || reconciled) return { amount_residual: 0, amount_residual_currency: 0 };
  return { amount_residual: lineBalance, amount_residual_currency: foreign ? lineAmountCurr : 0 };
}

/**
 * Distribute targeted (`line_index`-scoped) and untargeted (earliest due date first) settlement amounts
 * across counterpart items, returning remaining balances per index, untargeted-touched indices, and
 * bipartite settlement edges between installment indices and source keys.
 */
export function distributeInstallmentSettlements(items, targetedAdjustments, untargeted, { roundAmount = (v) => round(v) } = {}) {
  const remaining = new Map(items.map((item) => [item.index, item.total]));
  const sourcesByIndex = new Map();
  const indicesBySource = new Map();
  const addEdge = (idx, key) => {
    if (!key) return;
    if (!sourcesByIndex.has(idx)) sourcesByIndex.set(idx, new Set());
    sourcesByIndex.get(idx).add(key);
    if (!indicesBySource.has(key)) indicesBySource.set(key, new Set());
    indicesBySource.get(key).add(idx);
  };
  const untargetedEntries = [];
  for (const entry of targetedAdjustments) {
    const [index, amount, key = null] = entry;
    if (!remaining.has(index) || !(amount > 0)) {
      const overflow = Math.max(0, Number(amount) || 0);
      if (overflow > 0) untargetedEntries.push({ key, amount: overflow });
      continue;
    }
    const current = remaining.get(index);
    const applied = Math.min(current, Number(amount) || 0);
    remaining.set(index, roundAmount(current - applied));
    if (applied > 1e-9) addEdge(index, key);
    if (amount > applied) untargetedEntries.push({ key, amount: roundAmount(amount - applied) });
  }
  if (typeof untargeted === 'number') {
    if (untargeted > 0) untargetedEntries.push({ key: null, amount: untargeted });
  } else {
    for (const entry of untargeted ?? []) {
      if ((entry?.amount ?? 0) > 0) untargetedEntries.push({ key: entry.key ?? null, amount: entry.amount });
    }
  }
  const untargetedTouched = new Set();
  const byDueDate = [...items].sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')) || a.index - b.index);
  for (const entry of untargetedEntries) {
    let left = Math.max(0, roundAmount(entry.amount));
    for (const item of byDueDate) {
      if (!(left > 1e-9)) break;
      const current = remaining.get(item.index);
      if (!(current > 1e-9)) continue;
      const applied = Math.min(current, left);
      left = roundAmount(left - applied);
      remaining.set(item.index, roundAmount(current - applied));
      if (applied > 1e-9) {
        untargetedTouched.add(item.index);
        addEdge(item.index, entry.key);
      }
    }
  }
  return { remaining, untargetedTouched, sourcesByIndex, indicesBySource };
}

const DOCUMENT_TYPES = ['out_invoice', 'out_refund', 'in_invoice', 'in_refund'];
const localSettlementCache = new WeakMap();

function localInstallmentSettlement(db, move) {
  let byMove = localSettlementCache.get(db.records);
  if (!byMove) {
    byMove = new Map();
    localSettlementCache.set(db.records, byMove);
  }
  const cached = move?.id != null ? byMove.get(move.id) : null;
  if (cached) return cached;
  const document = DOCUMENT_TYPES.includes(move?.move_type);
  const ownCurrency = findCompanyCurrencyRecord(db, move?.company_id ?? 1);
  const docCurr = document ? (move.currency_id ? read(db, 'res.currency', move.currency_id) : ownCurrency) : ownCurrency;
  const rawLines = move?.line_ids ?? [];
  const docResidual = document ? models['account.move'].fields.amount_residual.compute(move, db) : null;
  const docLineTotal = (l) => {
    const bal = (Number(l.debit) || 0) - (Number(l.credit) || 0);
    const foreign = Boolean(l.currency_id && ownCurrency && l.currency_id !== ownCurrency.id);
    return Math.abs(foreign ? (Number(l.amount_currency) || 0) : bal);
  };
  const isCounterpart = (l) => ['asset_receivable', 'liability_payable'].includes(read(db, 'account.account', l.account_id)?.account_type);
  if (!document || docResidual == null) {
    const empty = {
      docResidual, docCurr, docLineTotal, isCounterpart,
      remainingByIndex: new Map(), untargetedTouched: new Set(),
      sourcesByIndex: new Map(), indicesBySource: new Map(),
    };
    if (move?.id != null) byMove.set(move.id, empty);
    return empty;
  }
  const counterparts = rawLines.map((l, index) => ({
    l,
    index,
    total: docLineTotal(l),
    date: String(l.date_maturity ?? move.invoice_date_due ?? move.date ?? ''),
  })).filter(({ l }) => isCounterpart(l));
  const totalPaid = Math.max(0, counterparts.reduce((sum, { total }) => sum + total, 0) - docResidual);
  const activeRows = (move.payments ?? []).filter((p) => !p.reversed);
  const lineIndexByPayMove = new Map(activeRows.filter((r) => !r.discount && Number.isInteger(r.line_index)).map((r) => [r.move_id, r.line_index]));
  const counterpartIndices = new Set(counterparts.map((c) => c.index));
  const targetedEntries = [];
  const untargetedRows = [];
  let targetedTotal = 0;
  activeRows.forEach((row, rowIdx) => {
    const targetIndex = Number.isInteger(row.line_index) ? row.line_index : (row.discount ? lineIndexByPayMove.get(row.payment_move_id) : null);
    const amt = Number(row.amount) || 0;
    const sourceMoveId = row.discount ? (row.payment_move_id ?? row.move_id) : row.move_id;
    const key = sourceMoveId != null ? `move:${sourceMoveId}` : `row:${rowIdx}`;
    if (Number.isInteger(targetIndex) && counterpartIndices.has(targetIndex) && amt > 0) {
      targetedEntries.push([targetIndex, amt, key]);
      targetedTotal += amt;
    } else if (amt > 0) {
      untargetedRows.push({ key, amount: amt });
    }
  });
  const roundAmount = (v) => cleanSignedZero(docCurr ? roundCurrency(v, docCurr) : round(v));
  let untargetedBudget = Math.max(0, roundAmount(totalPaid - targetedTotal));
  const untargetedEntries = [];
  for (const entry of untargetedRows) {
    if (!(untargetedBudget > 1e-9)) break;
    const take = Math.min(entry.amount, untargetedBudget);
    untargetedBudget = roundAmount(untargetedBudget - take);
    if (take > 1e-9) untargetedEntries.push({ key: entry.key, amount: take });
  }
  if (untargetedBudget > 1e-9) {
    untargetedEntries.push({ key: 'legacy', amount: untargetedBudget });
  }
  const {
    remaining: remainingByIndex,
    untargetedTouched,
    sourcesByIndex,
    indicesBySource,
  } = distributeInstallmentSettlements(counterparts, targetedEntries, untargetedEntries, { roundAmount });
  const result = {
    docResidual, docCurr, docLineTotal, isCounterpart,
    remainingByIndex, untargetedTouched, sourcesByIndex, indicesBySource,
  };
  if (move?.id != null) byMove.set(move.id, result);
  return result;
}

/** True iff `startIndex` and its entire connected reconciliation group (Odoo full_reconcile_id semantics) are settled. */
function isInstallmentGroupSettled(db, move, startLocal, startIndex) {
  if ((startLocal.remainingByIndex.get(startIndex) ?? 0) > 1e-9) return false;
  if (!(startLocal.sourcesByIndex.get(startIndex)?.size)) return startLocal.docResidual === 0;
  const { applications, payments } = reconcileIndex(db);
  const visitedInstallments = new Set([`${move.id}:${startIndex}`]);
  const visitedSources = new Set();
  const queue = [{ kind: 'installment', move, local: startLocal, index: startIndex }];
  while (queue.length) {
    const cur = queue.shift();
    if (cur.kind === 'installment') {
      if ((cur.local.remainingByIndex.get(cur.index) ?? 0) > 1e-9) return false;
      for (const srcKey of cur.local.sourcesByIndex.get(cur.index) ?? []) {
        if (!visitedSources.has(srcKey)) {
          visitedSources.add(srcKey);
          queue.push({ kind: 'source', srcKey });
        }
      }
      continue;
    }
    const { srcKey } = cur;
    if (!srcKey.startsWith('move:')) continue;
    const srcMoveId = Number(srcKey.slice(5));
    const srcPay = payments.get(srcMoveId);
    const srcMove = read(db, 'account.move', srcMoveId);
    // payMove excess splits out a separate 'Outstanding credit' line, so the matched line itself has no open residual.
    const hasSplitExcessLine = (srcMove?.line_ids ?? []).some((l) => l.name === 'Outstanding credit');
    if (srcPay && !hasSplitExcessLine && Number(srcPay.unapplied) > 1e-9) return false;
    if (DOCUMENT_TYPES.includes(srcMove?.move_type)) {
      const srcRes = models['account.move'].fields.amount_residual.compute(srcMove, db);
      if (srcRes == null || srcRes > 1e-9) return false;
    }
    for (const { invoice: otherInv, row } of applications.get(srcMoveId) ?? []) {
      if (row.reversed || row.unapplied || !DOCUMENT_TYPES.includes(otherInv?.move_type)) continue;
      const otherLocal = localInstallmentSettlement(db, otherInv);
      const touched = otherLocal.indicesBySource.get(srcKey);
      if (!touched?.size) {
        if (otherLocal.docResidual == null || otherLocal.docResidual > 1e-9) return false;
        continue;
      }
      for (const otherIdx of touched) {
        const key = `${otherInv.id}:${otherIdx}`;
        if (!visitedInstallments.has(key)) {
          visitedInstallments.add(key);
          queue.push({ kind: 'installment', move: otherInv, local: otherLocal, index: otherIdx });
        }
      }
    }
  }
  return true;
}

/**
 * Compute per-line remaining amounts, untargeted-touched indices, and full matching-group reconciliation flags.
 * @param {object} db
 * @param {object} move
 * @returns {{ docResidual: number|null, docCurr: object|null, docLineTotal: (l: object) => number, isCounterpart: (l: object) => boolean, remainingByIndex: Map<number, number>, untargetedTouched: Set<number>, fullyReconciledByIndex: Map<number, boolean> }}
 */
export function installmentSettlementState(db, move) {
  const local = localInstallmentSettlement(db, move);
  const fullyReconciledByIndex = new Map();
  if (DOCUMENT_TYPES.includes(move?.move_type) && local.docResidual != null) {
    for (const idx of local.remainingByIndex.keys()) {
      fullyReconciledByIndex.set(idx, isInstallmentGroupSettled(db, move, local, idx));
    }
  }
  return {
    docResidual: local.docResidual,
    docCurr: local.docCurr,
    docLineTotal: local.docLineTotal,
    isCounterpart: local.isCounterpart,
    remainingByIndex: local.remainingByIndex,
    untargetedTouched: local.untargetedTouched,
    fullyReconciledByIndex,
  };
}

/** Compute line reconciliation flags and residuals from settlement index (without attaching group numbers yet). */
function computeReconciledItems(db, move, index) {
  const { applications: byMove, payments, matchedPaymentMoves, settledSuspense } = index;
  const applications = byMove.get(move.id) ?? [];
  const payment = payments.get(move.id);
  const posted = move.state === 'posted';
  const document = DOCUMENT_TYPES.includes(move.move_type);
  const ownCurrency = findCompanyCurrencyRecord(db, move.company_id ?? 1);
  const rawLines = move.line_ids ?? [];
  // Targeted installment rows settle their specific line; untargeted payments settle earliest due date first.
  const { docResidual, docLineTotal, remainingByIndex, fullyReconciledByIndex } = installmentSettlementState(db, move);
  const entryMatched = !document && posted ? entryMatchedAmounts(db, move, index) : [];
  const roundOwn = (v) => cleanSignedZero(ownCurrency ? roundCurrency(v, ownCurrency) : round(v));
  /** Scale a line's residuals by the share still open, rounded in each amount's own currency. */
  const scaleResidual = (line, residual, residualCurrency, ratio) => {
    const foreign = Boolean(line.currency_id && ownCurrency && line.currency_id !== ownCurrency.id);
    const foreignCurr = foreign ? read(db, 'res.currency', line.currency_id) : null;
    return {
      amount_residual: roundOwn(residual * ratio),
      amount_residual_currency: foreign
        ? cleanSignedZero(foreignCurr ? roundCurrency(residualCurrency * ratio, foreignCurr) : roundOwn(residualCurrency * ratio))
        : 0,
    };
  };
  let unappliedLeft = Math.max(0, Number(payment?.unapplied) || 0);
  return rawLines.map((line, indexNumber) => {
    const account = read(db, 'account.account', line.account_id);
    const matchedInfo = entryMatched[indexNumber];
    let reconciled = false;
    if (posted) {
      if (['asset_receivable', 'liability_payable'].includes(account?.account_type)) {
        if (document) {
          reconciled = fullyReconciledByIndex.get(indexNumber) ?? (docResidual === 0);
        } else if (payment) {
          reconciled = applications.some(({ invoice, row }) => invoice.partner_id === line.partner_id
            && (invoice.company_id ?? 1) === (move.company_id ?? 1)
            && (invoice.line_ids ?? []).some((item) => item.account_id === line.account_id)
            && (row.reversed || !payment?.unapplied));
        } else if (matchedInfo?.hasAnyLink) {
          reconciled = !isCurrencyZero(matchedInfo.absBal, ownCurrency)
            && (matchedInfo.matchedTotal >= matchedInfo.absBal || isCurrencyZero(matchedInfo.absBal - matchedInfo.matchedTotal, ownCurrency));
        }
      } else if (account?.reconcile === true && !document && matchedInfo?.hasAnyLink) {
        reconciled = !isCurrencyZero(matchedInfo.absBal, ownCurrency)
          && (matchedInfo.matchedTotal >= matchedInfo.absBal || isCurrencyZero(matchedInfo.absBal - matchedInfo.matchedTotal, ownCurrency));
      }
      if (payment?.outstanding_account_id === line.account_id) {
        reconciled = matchedPaymentMoves.has(move.id)
          || Boolean(
            matchedInfo?.hasAnyLink
            && !isCurrencyZero(matchedInfo.absBal, ownCurrency)
            && (matchedInfo.matchedTotal >= matchedInfo.absBal || isCurrencyZero(matchedInfo.absBal - matchedInfo.matchedTotal, ownCurrency))
          );
      }
      if ((settledSuspense.get(move.id) ?? []).includes(line.account_id)) reconciled = true;
    }
    const base = journalItemResidual(db, move, line, { reconciled, ownCurrency });
    let { amount_residual, amount_residual_currency } = base;
    if (amount_residual != null && move.state !== 'cancel' && !reconciled) {
      const counterpart = ['asset_receivable', 'liability_payable'].includes(account?.account_type);
      if (document && counterpart && docResidual == null) {
        // The document cannot price its residual, so its receivable/payable lines cannot either.
        amount_residual = null;
        amount_residual_currency = null;
      } else if (document && counterpart && remainingByIndex.has(indexNumber)) {
        const lineDoc = docLineTotal(line);
        ({ amount_residual, amount_residual_currency } = scaleResidual(line, amount_residual, amount_residual_currency, lineDoc > 1e-9 ? remainingByIndex.get(indexNumber) / lineDoc : 0));
      } else if (posted && !document && payment?.unapplied != null && counterpart && Math.abs(amount_residual) > 1e-9) {
        // The payment's unapplied amount is open once, shared across its counterpart lines in order.
        const share = Math.min(unappliedLeft, Math.abs(amount_residual));
        unappliedLeft -= share;
        ({ amount_residual, amount_residual_currency } = scaleResidual(line, amount_residual, amount_residual_currency, share / Math.abs(amount_residual)));
      } else if (posted && !document && matchedInfo?.hasAnyLink && matchedInfo.absBal > 1e-9) {
        const remaining = Math.max(0, roundOwn(matchedInfo.absBal - matchedInfo.matchedTotal));
        const sign = amount_residual >= 0 ? 1 : -1;
        if (matchedInfo.hasCurrencyLinks && line.currency_id && ownCurrency && line.currency_id !== ownCurrency.id) {
          const foreignCurr = read(db, 'res.currency', line.currency_id);
          const origCurrAbs = Math.abs(Number(line.amount_currency) || 0);
          const totalMatchedCurrency = (matchedInfo.glMatchedCurrency ?? 0) + (matchedInfo.legacyMatchedCurrency ?? 0);
          const remainingCurr = Math.max(0, cleanSignedZero(foreignCurr ? roundCurrency(origCurrAbs - totalMatchedCurrency, foreignCurr) : roundOwn(origCurrAbs - totalMatchedCurrency)));
          const currSign = (Number(line.amount_currency) || 0) >= 0 ? 1 : -1;
          amount_residual = cleanSignedZero(roundOwn(sign * remaining));
          amount_residual_currency = cleanSignedZero(currSign * remainingCurr);
        } else {
          ({ amount_residual, amount_residual_currency } = scaleResidual(line, amount_residual, amount_residual_currency, remaining / matchedInfo.absBal));
        }
      }
    }
    return { ...line, reconciled, amount_residual, amount_residual_currency };
  });
}

/** Derive transitive partial matching numbers (P<minLinkId>) over connected components of active partial links. */
export function partialMatchingNumbers(db, index) {
  if (index.partialMatchingNumbers) return index.partialMatchingNumbers;
  const numbers = new Map();
  const { links } = index.glMatchings ?? {};
  if (!links?.length) {
    index.partialMatchingNumbers = numbers;
    return numbers;
  }
  const adj = new Map();
  const nodeLinks = new Map();
  const linkEdge = (a, b, linkId) => {
    if (!a || !b || a === b) return;
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a).add(b);
    adj.get(b).add(a);
    if (linkId != null) {
      if (!nodeLinks.has(a)) nodeLinks.set(a, []);
      if (!nodeLinks.has(b)) nodeLinks.set(b, []);
      nodeLinks.get(a).push(linkId);
      nodeLinks.get(b).push(linkId);
    }
  };
  for (const g of links) {
    linkEdge(lineKey(g.debit_move_id, g.debit_line_index), lineKey(g.credit_move_id, g.credit_line_index), g.id);
  }

  const visited = new Set();
  for (const start of adj.keys()) {
    if (visited.has(start)) continue;
    const comp = [];
    const compLinkIds = new Set();
    const queue = [start];
    visited.add(start);
    while (queue.length) {
      const cur = queue.shift();
      comp.push(cur);
      for (const lid of nodeLinks.get(cur) ?? []) compLinkIds.add(lid);
      for (const nxt of adj.get(cur) ?? []) {
        if (!visited.has(nxt)) {
          visited.add(nxt);
          queue.push(nxt);
        }
      }
    }
    if (comp.length && compLinkIds.size) {
      const code = `P${Math.min(...compLinkIds)}`;
      for (const k of comp) numbers.set(k, code);
    }
  }
  index.partialMatchingNumbers = numbers;
  return numbers;
}

/** Derive reconciliation and residual amounts from settlement links, never from labels or a second stored flag. */
export function reconciledJournalItems(db, move, { partialMatching = false } = {}) {
  const index = reconcileIndex(db);
  const partialNumbers = partialMatching ? partialMatchingNumbers(db, index) : null;
  return computeReconciledItems(db, move, index).map((item, lineIdx) => {
    const key = lineKey(move.id, lineIdx);
    const groupCode = item.reconciled ? (index.matchingNumbers.get(key) ?? null) : null;
    if (groupCode) return { ...item, matching_number: groupCode };
    if (!partialMatching) return item;
    const partialCode = partialNumbers?.get(key);
    return partialCode ? { ...item, matching_number: partialCode } : item;
  });
}

/** Move IDs connected to `moveId` through active settlements, payments, and bank reconciliations. */
export function matchedMoveIds(db, moveId) {
  const matched = new Set([moveId]);
  const queue = [moveId];
  const { applications, glMatchings } = reconcileIndex(db);
  const paymentRecords = db.records['account.payment'] ?? [];
  const statements = db.records['account.bank.statement.line'] ?? [];
  const enqueue = (id) => {
    if (id && !matched.has(id)) {
      matched.add(id);
      queue.push(id);
    }
  };
  while (queue.length) {
    const curId = queue.shift();
    for (const linkedId of glMatchings.byMove.get(curId) ?? []) enqueue(linkedId);
    const cur = read(db, 'account.move', curId);
    for (const row of cur?.payments ?? []) {
      if (row.reversed || row.unapplied) continue;
      enqueue(row.move_id);
      enqueue(row.payment_move_id);
      enqueue(row.payment_fx_move_id);
      enqueue(row.cash_basis_move_id);
    }
    for (const { invoice, row } of applications.get(curId) ?? []) {
      if (row.reversed || row.unapplied) continue;
      enqueue(invoice.id);
      enqueue(row.move_id);
      enqueue(row.payment_move_id);
      enqueue(row.payment_fx_move_id);
      enqueue(row.cash_basis_move_id);
    }
    for (const st of statements) {
      const allocs = st.allocations ?? [];
      const linkedPaymentIds = new Set([st.payment_id, ...(st.payment_ids ?? [])].filter(Boolean));
      const paymentMoveIds = paymentRecords.filter((p) => p.move_id && linkedPaymentIds.has(p.id)).map((p) => p.move_id);
      const allIds = [
        st.bank_move_id,
        st.move_id,
        st.payment_move_id,
        st.writeoff_move_id,
        ...allocs.flatMap((a) => [a.invoice_id, a.payment_move_id, a.writeoff_move_id]),
        ...paymentMoveIds,
      ].filter(Boolean);
      if (allIds.includes(curId)) allIds.forEach(enqueue);
    }
  }
  return matched;
}

/** Identity of an embedded journal line, independent of its position and derived matching or residual state. */
export function journalItemIdentity({ reconciled: _reconciled, matching_number: _matchingNumber, amount_residual: _amountResidual, amount_residual_currency: _amountResidualCurrency, ...line }) {
  return JSON.stringify(line);
}

/** Whether a move or journal item belongs in a report given `includeClosing` (shared by P&L, Trial Balance, and General Ledger). */
export const includeClosingItem = (item, includeClosing = false) => includeClosing || !item?.is_closing;

/** Journal items with their move date, optionally limited by review status, date, company, and closing flag. */
export function journalItems(db, { from, to, company_id, company, reviewMode = 'posted', includeClosing = true } = {}) {
  const targetCompany = company_id ?? company;
  const wantedState = reviewMode === 'draft' ? 'draft' : 'posted';
  const returns = new Map((db.records?.['account.return'] ?? []).map((r) => [r.id, r]));
  const settlementMoves = new Set((db.records?.['account.payment'] ?? []).filter((p) => p.is_tax_payment || p.return_id).map((p) => p.move_id).filter(Boolean));
  const rows = search(db, 'account.move')
    .filter((m) => {
      const date = m.date ?? m.invoice_date;
      const stateOk = reviewMode === 'all' ? (m.state === 'draft' || m.state === 'posted') : m.state === wantedState;
      return stateOk
      && includeClosingItem(m, includeClosing)
      && (!from || date >= from)
      && (!to || date <= to)
      && (!targetCompany || (m.company_id ?? 1) === targetCompany);
    })
    .flatMap((m) => {
      const isTaxClosing = !!m.tax_return_id && (returns.get(m.tax_return_id)?.closing_move_ids ?? []).includes(m.id);
      const isTaxSettlement = settlementMoves.has(m.id) || (!!m.is_tax_payment && !!m.tax_return_id);
      return reconciledJournalItems(db, m, { partialMatching: true }).map((l) => ({
        ...l,
        line_identity: journalItemIdentity(l),
        move_id: m.id,
        move_name: m.display_name ?? m.name,
        date: m.date ?? m.invoice_date,
        invoice_date: m.invoice_date ?? null,
        ref: m.ref ?? '',
        move_state: m.state,
        inalterable_hash: m.inalterable_hash ?? null,
        company_id: m.company_id ?? 1,
        journal_id: m.journal_id,
        is_closing: !!m.is_closing,
        is_tax_closing: isTaxClosing,
        is_tax_payment: isTaxSettlement,
      }));
    });
  if (reviewMode !== 'unreconciled') return rows;
  return rows.filter((line) => isReconcilableAccount(read(db, 'account.account', line.account_id)) && (line.amount_residual == null || Math.abs(line.amount_residual) > 1e-9));
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
export const weighted = (items, weight) => weight ? items.map((l) => { const w = weight(l); return { ...l, debit: (Number(l.debit) || 0) * w, credit: (Number(l.credit) || 0) * w }; }) : items;

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
  const items = filterByAnalytic(journalItems(db, period), analyticAccountIds).filter((l) => includeClosingItem(l, includeClosing));
  const rows = balances(db, weighted(items, weight));
  const revenue = sumTypes(rows, ['income'], -1);
  const cost = sumTypes(rows, ['expense_direct_cost']);
  const expense = sumTypes(rows, ['expense', 'expense_depreciation']);
  const otherIncome = sumTypes(rows, ['income_other'], -1);
  const otherExpense = sumTypes(rows, ['expense_other']);
  const lines = (types, sign) => rows.filter((r) => types.includes(r.account.account_type)).map((r) => ({ ...r, balance: round(sign * r.balance) }));
  return {
    revenue, cost, gross: round(revenue - cost), expense, operating: round(revenue - cost - expense),
    otherIncome, otherExpense, net: round(revenue - cost - expense + otherIncome - otherExpense),
    detail: { revenue: lines(['income'], -1), cost: lines(['expense_direct_cost'], 1), expense: lines(['expense', 'expense_depreciation'], 1), otherIncome: lines(['income_other'], -1), otherExpense: lines(['expense_other'], 1) },
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
  if (previous) {
    let start = previous.date_from;
    while (shiftMonth(start, 12) <= date) start = shiftMonth(start, 12);
    return start;
  }
  const company = read(db, 'res.company', companyId ?? db?.settings?.current_company_id ?? 1);
  const lastDay = Number(company?.fiscalyear_last_day) || 31;
  const lastMonth = Number(company?.fiscalyear_last_month) || 12;
  const year = Number(date.slice(0, 4));
  const monthStr = String(lastMonth).padStart(2, '0');
  const dayStr = String(lastDay).padStart(2, '0');
  const candidateEnd = `${year}-${monthStr}-${dayStr}`;
  const yearEndOnOrBefore = date <= candidateEnd
    ? `${year - 1}-${monthStr}-${dayStr}`
    : candidateEnd;
  return addDays(yearEndOnOrBefore, 1);
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
