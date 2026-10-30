// Double-entry core: chart of accounts, journals, and helpers that turn business documents into balanced entries.
import { create, read, search } from '../orm.js';
import { amounts, nextName, subtotal, today } from './common.js';
import { companyCurrency, rateAt } from './currency.js';
import { TRANSITION, lineTaxOf, mapAccount, taxGroups } from './taxes.js';
import { cashRound, round } from '../money.js';
import { productProperty } from './productconfig-helpers.js';
import { installments } from './terms.js';

export const ACCOUNT_TYPES = [
  ['asset_receivable', 'Receivable'], ['asset_cash', 'Bank and Cash'], ['asset_current', 'Current Assets'], ['asset_fixed', 'Fixed Assets'],
  ['liability_payable', 'Payable'], ['liability_current', 'Current Liabilities'], ['equity', 'Equity'],
  ['income', 'Income'], ['income_other', 'Other Income'], ['expense_direct_cost', 'Cost of Revenue'], ['expense', 'Expenses'], ['expense_other', 'Other Expenses'],
];

/** Default chart of accounts (codes follow a common 6-digit layout). */
export const CHART = [
  ['101401', 'Bank', 'asset_cash'], ['101501', 'Cash', 'asset_cash'], ['121000', 'Account Receivable', 'asset_receivable'],
  ['131000', 'Tax Receivable (VAT input)', 'asset_current'], ['110100', 'Stock Valuation', 'asset_current'], ['110200', 'Stock Interim (Received)', 'asset_current'], ['151000', 'Fixed Assets', 'asset_fixed'],
  ['211000', 'Account Payable', 'liability_payable'], ['251000', 'Tax Payable (VAT output)', 'liability_current'],
  ['212000', 'Deferred Revenue', 'liability_current'], ['132000', 'Prepaid Expenses', 'asset_current'], ['230000', 'Salaries Payable', 'liability_current'], ['230100', 'Employee Expenses Payable', 'liability_current'], ['240000', 'Social Insurance Payable', 'liability_current'], ['250100', 'Payroll Tax Payable', 'liability_current'],
  ['301000', 'Capital', 'equity'], ['400000', 'Product Sales', 'income'], ['410000', 'Subscription Revenue', 'income'], ['450000', 'Other Income', 'income_other'],
  ['500000', 'Cost of Goods Sold', 'expense_direct_cost'], ['600000', 'Expenses', 'expense'], ['610000', 'Travel & Meals', 'expense'],
  ['620000', 'Salaries & Wages', 'expense'], ['630000', 'Rent', 'expense'], ['690000', 'Bank Fees', 'expense_other'],
  ['450100', 'Foreign Exchange Gain', 'income_other'], ['690100', 'Foreign Exchange Loss', 'expense_other'],
  ['450200', 'Cash Discount Gain', 'income_other'], ['690200', 'Cash Discount Loss', 'expense_other'],
  ['152000', 'Accumulated Depreciation', 'asset_fixed'], ['680000', 'Depreciation Expense', 'expense'],
  ['251100', 'Tax Received (Cash Basis Transition)', 'liability_current'], ['131100', 'Tax Paid (Cash Basis Transition)', 'asset_current'],
  ['260000', 'Loans Payable', 'liability_current'], ['690400', 'Interest Expense', 'expense_other'],
  ['450300', 'Gain on Asset Disposal', 'income_other'], ['690300', 'Loss on Asset Disposal', 'expense_other'],
];

export const JOURNALS = [
  ['INV', 'Customer Invoices', 'sale', '400000'], ['BILL', 'Vendor Bills', 'purchase', '600000'], ['BNK1', 'Bank', 'bank', '101401'],
  ['CSH1', 'Cash', 'cash', '101501'], ['MISC', 'Miscellaneous Operations', 'general', null], ['SAL', 'Salaries', 'general', '620000'],
  ['POSS', 'Point of Sale', 'sale', '400000'],
];

const idByCode = (db, model, code, company) => {
  const records = db.records[model] ?? [];
  if (company) {
    const match = records.find((record) => record.code === code && record.company_id === company);
    if (match) return match.id;
  }
  return records.find((record) => record.code === code && (!company || !record.company_id || record.company_id === company))?.id ?? records.find((record) => record.code === code)?.id ?? null;
};

export const accountId = (db, code, company = null) => idByCode(db, 'account.account', code, company);
export const journalId = (db, code, company = null) => idByCode(db, 'account.journal', code, company);

/** Whether any line has a negative debit or credit. */
export const badLineSign = (lines = []) => lines.some((l) => (Number(l.debit) || 0) < 0 || (Number(l.credit) || 0) < 0);
export const isBalanced = (lines = []) =>
  lines.length >= 2 && round(lines.reduce((s, l) => s + (Number(l.debit) || 0) - (Number(l.credit) || 0), 0)) === 0;

/** Invoice base groups, including the source lines used to allocate a posted group. */
export function invoiceBaseGroups(db, move) {
  const sale = !['in_invoice', 'in_refund'].includes(move.move_type);
  const base = accountId(db, sale ? '400000' : '600000', move.company_id);
  const byAccount = new Map();
  const productAccount = (l) => {
    const p = (db.records.product ?? []).find((p) => p.id === l.product_id);
    if (!sale && p?.type === 'goods' && !['manual_periodic', 'periodic'].includes(productProperty(db, p, 'property_valuation'))) return accountId(db, '110200', move.company_id);
    return productProperty(db, p, sale ? 'property_account_income_id' : 'property_account_expense_id');
  };
  for (const [index, l] of (move.invoice_line_ids ?? []).entries()) {
    const account = mapAccount(db, move.fiscal_position_id, l.account_id || productAccount(l) || base);
    const zero = !lineTaxOf(l) && l.tax_name ? l.tax_name : '';
    const key = `${account}:${zero}`;
    const group = byAccount.get(key) ?? { account, zero, amount: 0, lines: [] };
    group.amount += subtotal(l);
    group.lines.push({ index, amount: subtotal(l) });
    byAccount.set(key, group);
  }
  return [...byAccount.values()];
}

/** Allocate a booked base group's cents across its source lines. */
export function allocateInvoiceGroup(group, amount) {
  const cents = Math.round(amount * 100);
  let cumulative = 0;
  let allocated = 0;
  return group.lines.map(({ index, amount: lineAmount }) => {
    cumulative += lineAmount;
    const through = group.amount ? Math.round(cents * cumulative / group.amount) : 0;
    const value = (through - allocated) / 100;
    allocated = through;
    return { index, value };
  });
}

/** Journal items for a customer invoice / vendor bill (positive amounts only, rounded to cents). */
export function invoiceLines(db, move) {
  // Customer side for invoices and credit notes; a credit note mirrors the invoice (debits ↔ credits).
  const sale = !['in_invoice', 'in_refund'].includes(move.move_type);
  const refund = ['out_refund', 'in_refund'].includes(move.move_type);
  const rate = rateAt(db, move.currency_id, move.invoice_date ?? today(), move.company_id);
  const counterpart = accountId(db, sale ? '121000' : '211000', move.company_id);
  // Each group keeps its amount in the document currency beside its company-currency amount: the foreign amount of a
  // journal item is the invoiced one, never reconstructed from the rounded conversion.
  const bases = invoiceBaseGroups(db, move).map(({ account, amount, zero }) => [account, round(amount / rate), round(amount), zero]);
  const rounding = move.invoice_cash_rounding_id ? read(db, 'account.cash.rounding', move.invoice_cash_rounding_id) : null;
  const rawTotalDoc = round(amounts(move.invoice_line_ids).total);
  const totalDoc = rounding ? cashRound(rawTotalDoc, rounding.rounding, rounding.rounding_method) : rawTotalDoc;
  const diffDoc = round(totalDoc - rawTotalDoc);
  const total = round(totalDoc / rate);
  const diff = round(diffDoc / rate);
  // Tax lines per tax account; cash-basis taxes wait on a transition account until payment.
  const taxAcc = accountId(db, sale ? '251000' : '131000', move.company_id);
  // Tax lines are kept apart per tax so the tax return can read tax and base straight from the ledger.
  const taxes = taxGroups(move.invoice_line_ids, (l) => (l.tax_cash_basis ? accountId(db, TRANSITION[sale ? 'sale' : 'purchase'], move.company_id) : l.tax_account_id || taxAcc), rate);
  const actualTaxes = taxes.filter((g) => g.amount !== 0 || g.document_amount !== 0);
  const adjustTax = Boolean(rounding && rounding.strategy === 'biggest_tax' && actualTaxes.length && diffDoc !== 0);
  if (adjustTax) {
    const largest = taxes.reduce((best, g, i) => (Math.abs(g.amount) > Math.abs(taxes[best].amount) ? i : best), 0);
    taxes[largest] = { ...taxes[largest], amount: round(taxes[largest].amount + diff), document_amount: round(taxes[largest].document_amount + diffDoc) };
  }

  // The receivable/payable is the document total; cents lost rounding each account go to the largest base line.
  const gap = round(total - bases.reduce((s, [, a]) => s + a, 0) - taxes.reduce((s, g) => s + g.amount, 0) - (rounding && !adjustTax && diff ? diff : 0));
  if (gap && bases.length) {
    const largest = bases.reduce((best, b, i) => (Math.abs(b[1]) > Math.abs(bases[best][1]) ? i : best), 0);
    bases[largest] = [bases[largest][0], round(bases[largest][1] + gap), bases[largest][2], bases[largest][3]];
  }

  // A document is foreign when its currency is not the company's (an equal rate on the day does not change that).
  const own = companyCurrency(db, move.company_id) ?? (db.records['res.currency'] ?? []).find((c) => c.name === db.settings?.currency)?.id ?? null;
  const foreign = !!move.currency_id && move.currency_id !== own;
  const side = (amount, debit, doc) => {
    const sign = (debit !== refund) !== ((amount || doc) < 0) ? 1 : -1;
    return { debit: sign > 0 ? round(Math.abs(amount)) : 0, credit: sign > 0 ? 0 : round(Math.abs(amount)), ...(foreign ? { currency_id: move.currency_id, amount_currency: round(sign * Math.abs(doc)) } : {}) };
  };

  const roundingLines = [];
  if (rounding && !adjustTax && diffDoc !== 0) {
    const isProfit = (sale !== refund) ? diffDoc > 0 : diffDoc < 0;
    const profitAcc = rounding.profit_account_id ? (read(db, 'account.account', rounding.profit_account_id)?.id || rounding.profit_account_id) : accountId(db, '450000', move.company_id);
    const lossAcc = rounding.loss_account_id ? (read(db, 'account.account', rounding.loss_account_id)?.id || rounding.loss_account_id) : accountId(db, '690000', move.company_id);
    const acc = isProfit ? profitAcc : lossAcc;
    roundingLines.push({
      account_id: acc,
      partner_id: move.partner_id,
      name: 'Cash Rounding',
      ...side(diff, !sale, diffDoc),
    });
  }

  const term = move.invoice_payment_term_id && read(db, 'account.payment.term', move.invoice_payment_term_id);
  const schedule = term ? installments(term, totalDoc, move.invoice_date ?? today()) : [{ date: move.invoice_date_due, amount: totalDoc }];
  let allocated = 0;
  let cumDoc = 0;
  const counterparts = schedule.map((item, index) => {
    cumDoc = round(cumDoc + item.amount);
    const targetCompany = index === schedule.length - 1 ? total : (totalDoc !== 0 ? round(total * (cumDoc / totalDoc)) : 0);
    const amount = round(targetCompany - allocated);
    allocated = round(allocated + amount);
    return { account_id: counterpart, partner_id: move.partner_id, name: move.name, ...side(amount, sale, item.amount), ...(item.date ? { date_maturity: item.date } : {}) };
  });
  return [
    ...counterparts,
    ...bases.map(([account_id, amount, doc, zero]) => ({ account_id, partner_id: move.partner_id, name: sale ? 'Sales' : 'Purchases', ...side(amount, !sale, doc), ...(zero ? { tax_name: zero, tax_base: refund ? -amount : amount, tax_side: sale ? 'sale' : 'purchase', tax_zero: true } : {}) })),
    ...taxes.map((g) => ({ account_id: g.account_id, partner_id: move.partner_id, name: g.tax_name, ...side(g.amount, !sale, g.document_amount), tax_name: g.tax_name, tax_base: g.base, ...(g.account_id !== accountId(db, TRANSITION[sale ? 'sale' : 'purchase'], move.company_id) ? { tax_side: sale ? 'sale' : 'purchase' } : {}) })),
    ...roundingLines,
  ].filter((l) => l.debit || l.credit || l.amount_currency);
}

/**
 * Create and post a miscellaneous entry.
 * Tax lines may carry `tax_name` and `tax_base` (company currency) for the tax return.
 * @param {{journal: string, date?: string, ref?: string, lines: {account: string, debit?: number, credit?: number, partner_id?: number, name?: string, tax_name?: string, tax_base?: number}[]}} spec
 */
export function postEntry(db, { journal, journal_id = null, date = today(), ref = '', lines, company = null, fx_payment_move_id = null, fx_invoice_id = null }) {
  if (fx_payment_move_id || fx_invoice_id) throw new Error('Exchange provenance cannot be supplied to postEntry');
  if (company && !read(db, 'res.company', company)) throw new Error('Company does not exist');
  const jId = journal_id ?? (typeof journal === 'number' ? journal : (journalId(db, journal, company) ?? journalId(db, journal)));
  if (!jId) throw new Error(`Journal not found: ${journal}`);
  const j = read(db, 'account.journal', jId);
  if (!j) throw new Error(`Journal not found: ${journal}`);
  if (j.company_id && company && j.company_id !== company) throw new Error(`Journal ${j.name || j.code} belongs to another company`);

  const line_ids = lines.map((l) => {
    let accId = null;
    if (l.account_id) accId = l.account_id;
    else if (typeof l.account === 'number') accId = l.account;
    else if (l.account) accId = accountId(db, l.account, company) ?? accountId(db, l.account);
    if (!accId) throw new Error(`Account not found: ${l.account}`);
    const acc = read(db, 'account.account', accId);
    if (!acc) throw new Error(`Account not found: ${accId}`);
    if (acc.company_id && company && acc.company_id !== company) throw new Error(`Account ${acc.code || acc.name} belongs to another company`);

    // Keep both columns non-negative: a negative debit is a credit and vice versa.
    const net = round((l.debit ?? 0) - (l.credit ?? 0));
    return { account_id: accId, partner_id: l.partner_id ?? null, name: l.name ?? ref, debit: Math.max(0, net), credit: Math.max(0, -net), ...(l.tax_name ? { tax_name: l.tax_name, tax_base: round(l.tax_base ?? 0), ...(l.tax_zero ? { tax_zero: true } : {}), ...(l.tax_side ? { tax_side: l.tax_side } : {}) } : {}) };
  });
  if (!isBalanced(line_ids)) throw new Error('Journal entry is not balanced');
  const journalCode = j?.code ?? journal;
  const prefix = `${journalCode}/${date.slice(0, 4)}/`;
  return create(db, 'account.move', {
    move_type: 'entry', state: 'posted', journal_id: jId, invoice_date: date, ref, ...(company ? { company_id: company } : {}),
    name: nextName(db, 'account.move', prefix), line_ids, partner_id: lines.find((l) => l.partner_id)?.partner_id ?? null,
  });
}

/** Bank or cash journal code and its default account code (BNK1 / 101401 when unset or not a payment journal). */
export function paymentJournal(db, journalId) {
  const j = read(db, 'account.journal', journalId);
  const account = j && ['bank', 'cash'].includes(j.type) ? read(db, 'account.account', j.default_account_id)?.code : null;
  return account ? { code: j.code, account } : { code: 'BNK1', account: '101401' };
}

/** Posted journal items with their move date, optionally limited to [from, to]. */
export function journalItems(db, { from, to } = {}) {
  return search(db, 'account.move')
    .filter((m) => m.state === 'posted' && (!from || m.invoice_date >= from) && (!to || m.invoice_date <= to))
    .flatMap((m) => (m.line_ids ?? []).map((l) => ({ ...l, move_id: m.id, move_name: m.name, date: m.invoice_date, is_closing: !!m.is_closing })));
}

/** Balance per account (debit − credit) over the given items. */
export function balances(db, items) {
  const map = new Map();
  for (const l of items) map.set(l.account_id, (map.get(l.account_id) ?? 0) + (Number(l.debit) || 0) - (Number(l.credit) || 0));
  return [...map].map(([id, balance]) => ({ account: read(db, 'account.account', id), balance: round(balance) })).filter((b) => b.account);
}

const sumTypes = (rows, types, sign = 1) => round(rows.filter((r) => types.includes(r.account.account_type)).reduce((s, r) => s + sign * r.balance, 0));

/** Profit & loss figures (income shown positive); year-end closing entries are left out unless asked for. */
export function profitAndLoss(db, period, { includeClosing = false } = {}) {
  const rows = balances(db, journalItems(db, period).filter((l) => includeClosing || !l.is_closing));
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
  // Closed years already sit in retained earnings, so their closing entries count here.
  const earnings = profitAndLoss(db, { to: at }, { includeClosing: true }).net;
  const total = (list) => round(list.reduce((s, r) => s + r.balance, 0));
  return {
    assets, liabilities, equity, earnings,
    totalAssets: total(assets), totalLiabilities: total(liabilities), totalEquity: round(total(equity) + earnings),
  };
}

