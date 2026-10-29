// Double-entry core: chart of accounts, journals, and helpers that turn business documents into balanced entries.
import { create, read, search } from '../orm.js';
import { amounts, nextName, subtotal, today } from './common.js';
import { companyCurrency, rateAt } from './currency.js';
import { TRANSITION, mapAccount, taxGroups } from './taxes.js';
import { round } from '../money.js';

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

export const accountId = (db, code, company) => {
  const matches = (db.records['account.account'] ?? []).filter((a) => a.code === code);
  return (company ? matches.find((a) => a.company_id === company) ?? matches.find((a) => !a.company_id) : matches[0])?.id ?? null;
};
export const journalId = (db, code) => (db.records['account.journal'] ?? []).find((j) => j.code === code)?.id ?? null;

/** Whether any line has a negative debit or credit. */
export const badLineSign = (lines = []) => lines.some((l) => (Number(l.debit) || 0) < 0 || (Number(l.credit) || 0) < 0);
export const isBalanced = (lines = []) =>
  lines.length >= 2 && round(lines.reduce((s, l) => s + (Number(l.debit) || 0) - (Number(l.credit) || 0), 0)) === 0;

/** Resolve exactly the account used for an invoice product line, including stock and fiscal-position rules. */
export function invoiceLineAccount(db, move, line) {
  const sale = !['in_invoice', 'in_refund'].includes(move?.move_type);
  const product = (db.records.product ?? []).find((p) => p.id === line.product_id);
  const productAccount = !sale && product?.type === 'goods' && product.valuation !== 'manual_periodic'
    ? accountId(db, '110200')
    : product?.[sale ? 'property_account_income_id' : 'property_account_expense_id'];
  return mapAccount(db, move?.fiscal_position_id, line.account_id || productAccount || accountId(db, sale ? '400000' : '600000'));
}

/** Journal items for a customer invoice / vendor bill (positive amounts only, rounded to cents). */
export function invoiceLines(db, move) {
  // Customer side for invoices and credit notes; a credit note mirrors the invoice (debits ↔ credits).
  const sale = !['in_invoice', 'in_refund'].includes(move.move_type);
  const refund = ['out_refund', 'in_refund'].includes(move.move_type);
  // Foreign-currency invoices are booked in the company currency at the invoice-date rate.
  const rate = rateAt(db, move.currency_id, move.invoice_date ?? today(), move.company_id);
  const counterpart = accountId(db, sale ? '121000' : '211000');
  // Each line may override the income/expense account; amounts are grouped per account.
  const byAccount = new Map();
  for (const l of move.invoice_line_ids ?? []) {
    const account = invoiceLineAccount(db, move, l);
    byAccount.set(account, (byAccount.get(account) ?? 0) + subtotal(l));
  }
  // Each group keeps its amount in the document currency beside its company-currency amount: the foreign amount of a
  // journal item is the invoiced one, never reconstructed from the rounded conversion.
  const bases = [...byAccount].map(([account_id, amount]) => [account_id, round(amount / rate), round(amount)]);
  // Tax lines per tax account; cash-basis taxes wait on a transition account until payment.
  const taxAcc = accountId(db, sale ? '251000' : '131000');
  // Tax lines are kept apart per tax so the tax return can read tax and base straight from the ledger.
  const taxes = taxGroups(move.invoice_line_ids, (l) => (l.tax_cash_basis ? accountId(db, TRANSITION[sale ? 'sale' : 'purchase']) : l.tax_account_id || taxAcc), rate);
  const totalDoc = round(amounts(move.invoice_line_ids).total);
  // The receivable/payable is the document total; cents lost rounding each account go to the largest base line.
  const total = round(amounts(move.invoice_line_ids).total / rate);
  const gap = round(total - bases.reduce((s, [, a]) => s + a, 0) - taxes.reduce((s, g) => s + g.amount, 0));
  if (gap && bases.length) {
    const largest = bases.reduce((best, b, i) => (Math.abs(b[1]) > Math.abs(bases[best][1]) ? i : best), 0);
    bases[largest] = [bases[largest][0], round(bases[largest][1] + gap), bases[largest][2]];
  }

  // A document is foreign when its currency is not the company's (an equal rate on the day does not change that).
  const own = companyCurrency(db, move.company_id) ?? (db.records['res.currency'] ?? []).find((c) => c.name === db.settings?.currency)?.id ?? null;
  const foreign = !!move.currency_id && move.currency_id !== own;
  const side = (amount, debit, doc) => {
    const sign = (debit !== refund) !== (amount < 0) ? 1 : -1;
    return { debit: sign > 0 ? round(Math.abs(amount)) : 0, credit: sign > 0 ? 0 : round(Math.abs(amount)), ...(foreign ? { currency_id: move.currency_id, amount_currency: round(sign * Math.abs(doc)) } : {}) };
  };
  return [
    { account_id: counterpart, partner_id: move.partner_id, name: move.name, ...side(total, sale, totalDoc) },
    ...bases.map(([account_id, amount, doc]) => ({ account_id, partner_id: move.partner_id, name: sale ? 'Sales' : 'Purchases', ...side(amount, !sale, doc) })),
    ...taxes.map((g) => ({ account_id: g.account_id, partner_id: move.partner_id, name: g.tax_name, ...side(g.amount, !sale, g.document_amount), tax_name: g.tax_name, tax_base: g.base })),
  ].filter((l) => l.debit || l.credit);
}

/**
 * Create and post a miscellaneous entry.
 * Tax lines may carry `tax_name` and `tax_base` (company currency) for the tax return.
 * @param {{journal: string, date?: string, ref?: string, lines: {account: string, debit?: number, credit?: number, partner_id?: number, name?: string, tax_name?: string, tax_base?: number}[]}} spec
 */
export function postEntry(db, { journal, date = today(), ref = '', lines, company = null, is_tax_closing = false, is_tax_payment = false, tax_return_id = null }) {
  const line_ids = lines.map((l) => {
    // Keep both columns non-negative: a negative debit is a credit and vice versa.
    const net = round((l.debit ?? 0) - (l.credit ?? 0));
    return { account_id: accountId(db, l.account, company), partner_id: l.partner_id ?? null, name: l.name ?? ref, debit: Math.max(0, net), credit: Math.max(0, -net), ...(l.tax_name ? { tax_name: l.tax_name, tax_base: round(l.tax_base ?? 0) } : {}) };
  });
  if (!isBalanced(line_ids)) throw new Error('Journal entry is not balanced');
  const prefix = `${journal}/${date.slice(0, 4)}/`;
  return create(db, 'account.move', {
    move_type: 'entry', state: 'posted', journal_id: journalId(db, journal), invoice_date: date, date, ref, ...(company ? { company_id: company } : {}),
    name: nextName(db, 'account.move', prefix), line_ids, partner_id: lines.find((l) => l.partner_id)?.partner_id ?? null,
    ...(is_tax_closing ? { is_tax_closing: true } : {}),
    ...(is_tax_payment ? { is_tax_payment: true } : {}),
    ...(tax_return_id ? { tax_return_id } : {}),
  });
}

/** Bank or cash journal code and its default account code (BNK1 / 101401 when unset or not a payment journal). */
export function paymentJournal(db, journalId) {
  const j = read(db, 'account.journal', journalId);
  const account = j && ['bank', 'cash'].includes(j.type) ? read(db, 'account.account', j.default_account_id)?.code : null;
  return account ? { code: j.code, account } : { code: 'BNK1', account: '101401' };
}

/** Posted journal items with their move date, optionally limited to [from, to] and company. */
export function journalItems(db, { from, to, company_id, company } = {}) {
  const targetCompany = company_id ?? company;
  const closingMoves = new Set((db.records?.['account.return'] ?? []).flatMap((r) => r.closing_move_ids ?? []));
  const settlementMoves = new Set((db.records?.['account.payment'] ?? []).filter((p) => p.is_tax_payment || p.return_id).map((p) => p.move_id).filter(Boolean));
  return search(db, 'account.move')
    .filter((m) => m.state === 'posted'
      && (!from || (m.invoice_date ?? m.date) >= from)
      && (!to || (m.invoice_date ?? m.date) <= to)
      && (!targetCompany || (m.company_id ?? 1) === targetCompany))
    .flatMap((m) => {
      const isTaxClosing = !!m.is_tax_closing || closingMoves.has(m.id) || (typeof m.ref === 'string' && m.ref.startsWith('Tax Closing:'));
      const isTaxSettlement = !!m.is_tax_payment || settlementMoves.has(m.id) || (typeof m.ref === 'string' && (m.ref.startsWith('Tax Return Payment:') || m.ref.startsWith('Tax Return Refund:')));
      return (m.line_ids ?? []).map((l) => ({
        ...l,
        move_id: m.id,
        move_name: m.name,
        date: m.invoice_date ?? m.date,
        is_closing: !!m.is_closing,
        is_tax_closing: isTaxClosing,
        is_tax_payment: isTaxSettlement,
      }));
    });
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
