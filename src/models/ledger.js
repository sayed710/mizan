// Double-entry core: chart of accounts, journals, and helpers that turn business documents into balanced entries.
import { create, read, search } from '../orm.js';
import { amounts, nextName, today } from './common.js';
import { rateAt } from './currency.js';

export const ACCOUNT_TYPES = [
  ['asset_receivable', 'Receivable'], ['asset_cash', 'Bank and Cash'], ['asset_current', 'Current Assets'], ['asset_fixed', 'Fixed Assets'],
  ['liability_payable', 'Payable'], ['liability_current', 'Current Liabilities'], ['equity', 'Equity'],
  ['income', 'Income'], ['income_other', 'Other Income'], ['expense_direct_cost', 'Cost of Revenue'], ['expense', 'Expenses'], ['expense_other', 'Other Expenses'],
];

/** Default chart of accounts (codes follow a common 6-digit layout). */
export const CHART = [
  ['101401', 'Bank', 'asset_cash'], ['101501', 'Cash', 'asset_cash'], ['121000', 'Account Receivable', 'asset_receivable'],
  ['131000', 'Tax Receivable (VAT input)', 'asset_current'], ['110100', 'Stock Valuation', 'asset_current'], ['151000', 'Fixed Assets', 'asset_fixed'],
  ['211000', 'Account Payable', 'liability_payable'], ['251000', 'Tax Payable (VAT output)', 'liability_current'],
  ['212000', 'Deferred Revenue', 'liability_current'], ['132000', 'Prepaid Expenses', 'asset_current'], ['230000', 'Salaries Payable', 'liability_current'], ['240000', 'Social Insurance Payable', 'liability_current'], ['250100', 'Payroll Tax Payable', 'liability_current'],
  ['301000', 'Capital', 'equity'], ['400000', 'Product Sales', 'income'], ['410000', 'Subscription Revenue', 'income'], ['450000', 'Other Income', 'income_other'],
  ['500000', 'Cost of Goods Sold', 'expense_direct_cost'], ['600000', 'Expenses', 'expense'], ['610000', 'Travel & Meals', 'expense'],
  ['620000', 'Salaries & Wages', 'expense'], ['630000', 'Rent', 'expense'], ['690000', 'Bank Fees', 'expense_other'],
  ['450100', 'Foreign Exchange Gain', 'income_other'], ['690100', 'Foreign Exchange Loss', 'expense_other'],
  ['450200', 'Cash Discount Gain', 'income_other'], ['690200', 'Cash Discount Loss', 'expense_other'],
];

export const JOURNALS = [
  ['INV', 'Customer Invoices', 'sale', '400000'], ['BILL', 'Vendor Bills', 'purchase', '600000'], ['BNK1', 'Bank', 'bank', '101401'],
  ['CSH1', 'Cash', 'cash', '101501'], ['MISC', 'Miscellaneous Operations', 'general', null], ['SAL', 'Salaries', 'general', '620000'],
  ['POSS', 'Point of Sale', 'sale', '400000'],
];

export const accountId = (db, code) => (db.records['account.account'] ?? []).find((a) => a.code === code)?.id ?? null;
export const journalId = (db, code) => (db.records['account.journal'] ?? []).find((j) => j.code === code)?.id ?? null;

const round = (n) => Math.round(n * 100) / 100;
export const isBalanced = (lines = []) =>
  lines.length >= 2 && round(lines.reduce((s, l) => s + (Number(l.debit) || 0) - (Number(l.credit) || 0), 0)) === 0;

/** Journal items for a customer invoice / vendor bill (positive amounts only, rounded to cents). */
export function invoiceLines(db, move) {
  // Customer side for invoices and credit notes; a credit note mirrors the invoice (debits ↔ credits).
  const sale = move.move_type !== 'in_invoice';
  const refund = move.move_type === 'out_refund';
  // Foreign-currency invoices are booked in the company currency at the invoice-date rate.
  const rate = rateAt(db, move.currency_id, move.invoice_date ?? today());
  const { untaxed: u, tax: t } = amounts(move.invoice_line_ids);
  const untaxed = round(u / rate);
  const tax = round(t / rate);
  const total = round(untaxed + tax);
  const counterpart = accountId(db, sale ? '121000' : '211000');
  const base = accountId(db, sale ? '400000' : '600000');
  const taxAcc = accountId(db, sale ? '251000' : '131000');
  const side = (amount, debit) => ((debit !== refund) ? { debit: round(amount), credit: 0 } : { debit: 0, credit: round(amount) });
  return [
    { account_id: counterpart, partner_id: move.partner_id, name: move.name, ...side(total, sale) },
    { account_id: base, partner_id: move.partner_id, name: sale ? 'Sales' : 'Purchases', ...side(untaxed, !sale) },
    ...(tax ? [{ account_id: taxAcc, partner_id: move.partner_id, name: 'VAT 14%', ...side(tax, !sale) }] : []),
  ].filter((l) => l.debit || l.credit);
}

/**
 * Create and post a miscellaneous entry.
 * @param {{journal: string, date?: string, ref?: string, lines: {account: string, debit?: number, credit?: number, partner_id?: number, name?: string}[]}} spec
 */
export function postEntry(db, { journal, date = today(), ref = '', lines }) {
  const line_ids = lines.map((l) => ({
    account_id: accountId(db, l.account), partner_id: l.partner_id ?? null, name: l.name ?? ref, debit: round(l.debit ?? 0), credit: round(l.credit ?? 0),
  }));
  if (!isBalanced(line_ids)) throw new Error('Journal entry is not balanced');
  const prefix = `${journal}/${date.slice(0, 4)}/`;
  return create(db, 'account.move', {
    move_type: 'entry', state: 'posted', journal_id: journalId(db, journal), invoice_date: date, ref,
    name: nextName(db, 'account.move', prefix), line_ids, partner_id: lines.find((l) => l.partner_id)?.partner_id ?? null,
  });
}

/** Posted journal items with their move date, optionally limited to [from, to]. */
export function journalItems(db, { from, to } = {}) {
  return search(db, 'account.move')
    .filter((m) => m.state === 'posted' && (!from || m.invoice_date >= from) && (!to || m.invoice_date <= to))
    .flatMap((m) => (m.line_ids ?? []).map((l) => ({ ...l, move_id: m.id, move_name: m.name, date: m.invoice_date })));
}

/** Balance per account (debit − credit) over the given items. */
export function balances(db, items) {
  const map = new Map();
  for (const l of items) map.set(l.account_id, (map.get(l.account_id) ?? 0) + (Number(l.debit) || 0) - (Number(l.credit) || 0));
  return [...map].map(([id, balance]) => ({ account: read(db, 'account.account', id), balance: round(balance) })).filter((b) => b.account);
}

const sumTypes = (rows, types, sign = 1) => round(rows.filter((r) => types.includes(r.account.account_type)).reduce((s, r) => s + sign * r.balance, 0));

/** Profit & loss figures (income shown positive). */
export function profitAndLoss(db, period) {
  const rows = balances(db, journalItems(db, period));
  const revenue = sumTypes(rows, ['income'], -1);
  const cost = sumTypes(rows, ['expense_direct_cost']);
  const expense = sumTypes(rows, ['expense']);
  const otherIncome = sumTypes(rows, ['income_other'], -1);
  const otherExpense = sumTypes(rows, ['expense_other']);
  const lines = (types, sign) => rows.filter((r) => types.includes(r.account.account_type)).map((r) => ({ ...r, balance: round(sign * r.balance) }));
  return {
    revenue, cost, gross: round(revenue - cost), expense, operating: round(revenue - cost - expense),
    otherIncome, otherExpense, net: round(revenue - cost - expense + otherIncome - otherExpense),
    detail: { revenue: lines(['income'], -1), cost: lines(['expense_direct_cost'], 1), expense: lines(['expense'], 1) },
  };
}

/** Balance sheet at a date; current-year earnings close into equity so assets = liabilities + equity. */
export function balanceSheet(db, at = today()) {
  const rows = balances(db, journalItems(db, { to: at }));
  const pick = (types, sign) => rows.filter((r) => types.includes(r.account.account_type)).map((r) => ({ ...r, balance: round(sign * r.balance) }));
  const assets = pick(['asset_receivable', 'asset_cash', 'asset_current', 'asset_fixed'], 1);
  const liabilities = pick(['liability_payable', 'liability_current'], -1);
  const equity = pick(['equity'], -1);
  const earnings = profitAndLoss(db, { to: at }).net;
  const total = (list) => round(list.reduce((s, r) => s + r.balance, 0));
  return {
    assets, liabilities, equity, earnings,
    totalAssets: total(assets), totalLiabilities: total(liabilities), totalEquity: round(total(equity) + earnings),
  };
}

