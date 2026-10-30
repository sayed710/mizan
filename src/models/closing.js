// Fiscal closing and reversing exchange adjustments (comparative reports live in views/reportCompare.js).
import { create, read, search, updateSettings, write } from '../orm.js';
import { addDays, today } from './common.js';
import { accountId, balances, balanceSheet, journalItems, postEntry, profitAndLoss } from './ledger.js';
import { companyCurrency, toCompany } from './currency.js';
import { round } from '../money.js';
import { applicationEffectiveDate, settlementCompanyAllocations } from './settlement.js';

const pnlTypes = ['income', 'income_other', 'expense', 'expense_direct_cost', 'expense_other'];
const validDate = (date) => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
  && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
const checkDate = (date) => { if (!validDate(date)) throw new Error('Enter a valid date'); };
const side = (amount) => ({ debit: Math.max(0, round(amount)), credit: Math.max(0, round(-amount)) });

function ensureAccount(db, code, name, type) {
  const account = read(db, 'account.account', accountId(db, code));
  if (account && account.account_type !== type) throw new Error(`${code} must be an ${type} account`);
  return account ? db : create(db, 'account.account', { code, name, account_type: type }).db;
}

const sameLines = (a, b) => a.length === b.length && a.every((l, i) => l.account_id === b[i].account_id && round(l.debit) === round(b[i].credit) && round(l.credit) === round(b[i].debit));

/** The genuine closing entry of a year: posted on its end date, named for it, touching only P&L accounts and equity. */
function isClosingEntry(db, year, move) {
  if (!move || move.state !== 'posted' || move.move_type !== 'entry' || move.ref !== `Fiscal closing: ${year.name}`) return false;
  const closable = new Set([...pnlTypes, 'equity']);
  return (move.line_ids ?? []).every((l) => closable.has(read(db, 'account.account', l.account_id)?.account_type));
}

/** The genuine reopening entry: posted, named for the year, and the exact mirror of its closing entry. */
function isReopeningEntry(db, year, move) {
  const closing = read(db, 'account.move', year.closing_move_id);
  return !!move && !!closing && move.state === 'posted' && move.move_type === 'entry' && move.ref === `Reopen fiscal year: ${year.name}`
    && sameLines(closing.line_ids ?? [], move.line_ids ?? []);
}

function yearGuard(db, before, after) {
  if (!validDate(after.date_from) || !validDate(after.date_to) || after.date_from > after.date_to) return 'Enter a valid fiscal year date range';
  if (before?.state === 'closed' && (before.date_from !== after.date_from || before.date_to !== after.date_to)) return 'Reopen the fiscal year before changing its dates';
  // Closing and reopening entries leave the P&L, so a year names them only as it closes or reopens, on its end date.
  const entryOff = (id) => { const m = id && read(db, 'account.move', id); return m && (m.invoice_date ?? m.date) !== after.date_to; };
  const closes = after.state === 'closed' && before?.state !== 'closed';
  if ((before?.closing_move_id ?? null) !== (after.closing_move_id ?? null) && !(closes && after.closing_move_id)) return 'The closing entry is set by closing the fiscal year';
  if (closes && !after.closing_move_id) return 'Close the fiscal year with its closing entry';
  if (after.opening_move_id && after.opening_move_id !== before?.opening_move_id && (before?.opening_move_id || after.state !== 'open')) return 'The reopening entry is set by reopening the fiscal year';
  if (entryOff(after.closing_move_id) || entryOff(after.opening_move_id)) return 'Closing entries are dated on the fiscal year end';
  // Only the real entries made by closing or reopening may be named: an ordinary entry would vanish from the P&L.
  if (closes && !isClosingEntry(db, after, read(db, 'account.move', after.closing_move_id))) return 'The closing entry must be the one made by closing this fiscal year';
  if (after.opening_move_id && after.opening_move_id !== before?.opening_move_id && !isReopeningEntry(db, after, read(db, 'account.move', after.opening_move_id))) return 'The reopening entry must be the one made by reopening this fiscal year';
  if (search(db, 'account.fiscal.year').some((y) => y.id !== after.id && [after.closing_move_id, after.opening_move_id].filter(Boolean).some((m) => y.closing_move_id === m || y.opening_move_id === m))) return 'That entry already belongs to another fiscal year';
  return search(db, 'account.fiscal.year').some((y) => y.id !== after.id && y.date_from <= after.date_to && y.date_to >= after.date_from)
    ? 'Fiscal years must not overlap' : null;
}

function getYear(db, id) {
  const year = read(db, 'account.fiscal.year', id);
  if (!year) throw new Error('Fiscal year not found');
  const error = yearGuard(db, year, year);
  if (error) throw new Error(error);
  return year;
}

/** Close P&L balances into retained earnings and lock the fiscal year. */
export function closeFiscalYear(db, yearId, { retainedEarningsCode = '302000', date } = {}) {
  const year = getYear(db, yearId);
  if (year.state === 'closed') throw new Error('This fiscal year is already closed');
  if (date && date !== year.date_to) throw new Error('Close the fiscal year on its end date');
  if (search(db, 'account.move').some((m) => m.state === 'draft' && (m.invoice_date ?? m.date) >= year.date_from && (m.invoice_date ?? m.date) <= year.date_to)) {
    throw new Error('Post or cancel draft moves inside this fiscal year before closing');
  }
  const next = ensureAccount(db, retainedEarningsCode, 'Retained Earnings', 'equity');
  const rows = balances(next, journalItems(next, { from: year.date_from, to: year.date_to }))
    .filter((r) => pnlTypes.includes(r.account.account_type) && r.balance);
  const lines = rows.map((r) => ({ account: r.account.code, ...side(-r.balance) }));
  lines.push({ account: retainedEarningsCode, ...side(round(rows.reduce((s, r) => s + r.balance, 0))) });
  if (lines.length === 1) lines.push({ account: retainedEarningsCode, debit: 0, credit: 0 });
  const entry = postEntry(next, { journal: 'MISC', date: year.date_to, ref: `Fiscal closing: ${year.name}`, lines });
  // The year references its closing entry first: only such an entry may carry the closing flag.
  const closed = write(entry.db, 'account.fiscal.year', yearId, { state: 'closed', closing_move_id: entry.id, opening_move_id: null });
  return updateSettings(write(closed, 'account.move', entry.id, { is_closing: true }), {
    lock_date: [db.settings?.lock_date, year.date_to].filter(Boolean).sort().at(-1),
  });
}

/** Reverse the closing on the year end, clearing only that year's fiscal lock. */
export function reopenFiscalYear(db, yearId) {
  const year = getYear(db, yearId);
  if (year.state !== 'closed') throw new Error('This fiscal year is already open');
  const closing = read(db, 'account.move', year.closing_move_id);
  if (!closing || closing.state !== 'posted') throw new Error('The posted closing entry is missing');
  // Fall back to the latest other closed year rather than unlocking everything.
  const previous = search(db, 'account.fiscal.year').filter((y) => y.id !== yearId && y.state === 'closed').map((y) => y.date_to).sort().at(-1) ?? '';
  const unlocked = db.settings?.lock_date === year.date_to ? updateSettings(db, { lock_date: previous }) : db;
  // Open the year before booking into it: a closed year locks its period.
  const next = write(unlocked, 'account.fiscal.year', yearId, { state: 'open' });
  const entry = postEntry(next, {
    journal: 'MISC', date: year.date_to, ref: `Reopen fiscal year: ${year.name}`,
    lines: closing.line_ids.map((l) => ({ account: read(next, 'account.account', l.account_id).code, debit: l.credit, credit: l.debit, partner_id: l.partner_id })),
  });
  return write(write(entry.db, 'account.fiscal.year', yearId, { opening_move_id: entry.id }), 'account.move', entry.id, { is_closing: true });
}

const pnlRows = [['revenue', 'Revenue'], ['cost', 'Cost of Revenue'], ['gross', 'Gross Profit'], ['expense', 'Expenses'],
  ['operating', 'Net Operating Income'], ['otherIncome', 'Other Income'], ['otherExpense', 'Other Expenses'], ['net', 'Net Income']];
const sheetRows = [['totalAssets', 'Assets'], ['totalLiabilities', 'Liabilities'], ['equity', 'Equity'],
  ['earnings', 'Current Year Earnings'], ['liabilitiesEquity', 'Liabilities + Equity']];

function comparison(columns, reports, definitions) {
  const rows = definitions.map(([key, label]) => ({ key, label, values: reports.map((r) => r[key]) }));
  const variance = rows.map(({ key, values }) => {
    const previous = values.at(-2);
    const amount = values.length < 2 ? null : round(values.at(-1) - previous);
    return { key, amount, percent: amount == null || !previous ? null : round(amount / Math.abs(previous) * 100) };
  });
  return { columns, rows, variance };
}

/** P&L comparison in caller order; variance compares the last two columns. */
export function compareProfitAndLoss(db, periods) {
  return comparison(periods, periods.map((period) => profitAndLoss(db, period)), pnlRows);
}

/** Balance sheet comparison using the totals displayed by Reports. */
export function compareBalanceSheet(db, dates) {
  return comparison(dates, dates.map((date) => {
    checkDate(date);
    const sheet = balanceSheet(db, date);
    return { ...sheet, equity: round(sheet.totalEquity - sheet.earnings), liabilitiesEquity: round(sheet.totalLiabilities + sheet.totalEquity) };
  }), sheetRows);
}

function shiftMonth(date, months) {
  const source = new Date(`${date}T00:00:00Z`);
  const target = new Date(Date.UTC(source.getUTCFullYear(), source.getUTCMonth() + months, 1));
  const end = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  const sourceEnd = new Date(Date.UTC(source.getUTCFullYear(), source.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(source.getUTCDate() === sourceEnd ? end : Math.min(source.getUTCDate(), end));
  return target.toISOString().slice(0, 10);
}

/** Previous periods, oldest first, excluding the supplied period and preserving month ends. */
export function comparePeriods(period, { count = 1, unit = 'month' } = {}) {
  checkDate(period.from);
  checkDate(period.to);
  const months = { month: 1, quarter: 3, year: 12 }[unit];
  if (!months || !Number.isInteger(count) || count < 0 || period.from > period.to) throw new Error('Choose a valid comparison unit, count and period');
  return Array.from({ length: count }, (_, i) => ({ from: shiftMonth(period.from, -(count - i) * months), to: shiftMonth(period.to, -(count - i) * months) }));
}

/** Name of the currency the move's company keeps its books in. */
const ownCurrency = (db, m) => read(db, 'res.currency', companyCurrency(db, m.company_id))?.name ?? db.settings?.currency;

/** Open foreign invoices/bills at a date; positive difference increases the absolute balance. */
export function unrealizedExchange(db, date) {
  checkDate(date);
  return search(db, 'account.move').filter((m) => m.state === 'posted' && ['out_invoice', 'in_invoice'].includes(m.move_type)
    && m.invoice_date <= date && m.currency_id && read(db, 'res.currency', m.currency_id)?.name !== ownCurrency(db, m)).flatMap((m) => {
    const payments = m.payments ?? [];
    const activePaid = payments.filter((p) => !p.reversed).reduce((s, p) => s + p.amount, 0);
    const untrackedPaid = Math.max(0, round((Number(m.amount_paid) || 0) - activePaid));
    const allocations = settlementCompanyAllocations(db, m);
    const paid = allocations.filter(({ row: p }) => {
      const effDate = applicationEffectiveDate(p, m);
      if (!effDate || effDate > date) return false;
      if (!p.reversed) return true;
      const revDate = (p.reversal_move_id ? read(db, 'account.move', p.reversal_move_id)?.invoice_date : null) || p.reversal_date;
      return revDate ? revDate > date : false;
    });
    const paidForeign = round(paid.reduce((s, a) => s + Number(a.row.amount || 0), 0));
    const residual = round(m.amount_total - untrackedPaid - paidForeign);
    if (residual <= 0) return [];
    const account = m.move_type === 'out_invoice' ? '121000' : '211000';
    const sign = m.move_type === 'out_invoice' ? 1 : -1;
    const original = (m.line_ids ?? []).filter((l) => l.account_id === accountId(db, account, m.company_id))
      .reduce((s, l) => s + sign * ((Number(l.debit) || 0) - (Number(l.credit) || 0)), 0);
    const paidBooked = round(paid.reduce((s, a) => s + a.value, 0));
    const booked = round(original - toCompany(db, m.currency_id, untrackedPaid, m.invoice_date, m.company_id) - paidBooked);
    const value = toCompany(db, m.currency_id, residual, date, m.company_id);
    return [{ invoice_id: m.id, company_id: m.company_id ?? 1, partner_id: m.partner_id, currency_id: m.currency_id, account, residual, booked, value, difference: round(value - booked) }];
  });
}

/** Post one exchange adjustment and its next-day reversal, once per date. */
export function revalueForeignBalances(db, date, { gainCode = '450100', lossCode = '650100' } = {}) {
  checkDate(date);
  const rows = unrealizedExchange(db, date).filter((r) => r.difference);
  let next = db;
  // Each company adjusts its own books, so rows are grouped by company and posted with that company.
  for (const company of [...new Set(rows.map((r) => r.company_id))]) {
    const ref = `Foreign currency revaluation: ${date}`;
    if (search(next, 'account.move').some((m) => (m.company_id ?? 1) === company && (m.revaluation_date === date || m.ref === ref) && m.state === 'posted')) continue;
    next = ensureAccount(next, gainCode, 'Foreign Exchange Gain', 'income_other');
    next = ensureAccount(next, lossCode, 'Foreign Exchange Loss', 'expense_other');
    let gain = 0;
    let loss = 0;
    const lines = rows.filter((r) => r.company_id === company).map((r) => {
      const amount = round(r.difference * (r.account === '121000' ? 1 : -1));
      if (amount > 0) gain = round(gain + amount);
      else loss = round(loss - amount);
      return { account: r.account, partner_id: r.partner_id, ...side(amount) };
    });
    if (gain) lines.push({ account: gainCode, credit: gain });
    if (loss) lines.push({ account: lossCode, debit: loss });
    const entry = postEntry(next, { journal: 'MISC', date, ref, lines, company });
    const reversal = postEntry(entry.db, {
      journal: 'MISC', date: addDays(date, 1), ref: `Reversal of ${read(entry.db, 'account.move', entry.id).name}`, company,
      lines: lines.map((l) => ({ ...l, debit: l.credit ?? 0, credit: l.debit ?? 0 })),
    });
    next = write(reversal.db, 'account.move', entry.id, { revaluation_date: date, reversal_move_id: reversal.id });
  }
  return next;
}

export const closingModels = {
  'account.fiscal.year': {
    label: 'Fiscal Years',
    fields: {
      name: { type: 'char', label: 'Fiscal Year', required: true },
      date_from: { type: 'date', label: 'Start Date', required: true },
      date_to: { type: 'date', label: 'End Date', required: true },
      state: { type: 'selection', label: 'Status', tracking: true, options: [['open', 'Open'], ['closed', 'Closed']] },
      closing_move_id: { type: 'many2one', relation: 'account.move', label: 'Closing Entry', readonly: true },
      opening_move_id: { type: 'many2one', relation: 'account.move', label: 'Reopening Entry', readonly: true },
    },
    defaults: () => ({ state: 'open', date_from: `${today().slice(0, 4)}-01-01`, date_to: `${today().slice(0, 4)}-12-31` }),
    guard: yearGuard,
    protectDelete: (db, r) => r.closing_move_id ? 'Keep fiscal years with closing entries for the audit trail' : null,
    list: ['name', 'date_from', 'date_to', 'state'],
    kanban: { title: 'name', lines: ['date_from', 'date_to'], badge: 'state' },
    form: {
      title: 'name', statusbar: 'state', lockedWhen: (r) => r.state === 'closed',
      groups: [['date_from', 'date_to'], ['closing_move_id', 'opening_move_id']],
      buttons: [
        { label: 'Close Year', primary: true, when: (r) => r.state === 'open', run: (db, r) => ({ db: closeFiscalYear(db, r.id) }) },
        { label: 'Reopen', when: (r) => r.state === 'closed', run: (db, r) => ({ db: reopenFiscalYear(db, r.id) }) },
        {
          label: 'Revalue Foreign Currency', when: (r) => r.state === 'open',
          ask: [{ label: 'Revaluation date (YYYY-MM-DD)', default: (r) => (today() < r.date_from ? r.date_from : today() < r.date_to ? today() : r.date_to) }],
          run: (db, r, [date]) => {
            const year = getYear(db, r.id);
            checkDate(date);
            if (year.state !== 'open' || date < year.date_from || date > year.date_to) throw new Error('Select a revaluation date inside this open fiscal year');
            return { db: revalueForeignBalances(db, date) };
          },
        },
      ],
      chatter: true,
    },
  },
};
