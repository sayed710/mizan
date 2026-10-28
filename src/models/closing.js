// Fiscal closing and reversing exchange adjustments (comparative reports live in views/reportCompare.js).
import { create, read, search, updateSettings, write } from '../orm.js';
import { addDays, today } from './common.js';
import { accountId, balances, journalItems, postEntry } from './ledger.js';
import { toCompany } from './currency.js';

const round = (n) => Math.round(n * 100) / 100;
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

function yearGuard(db, before, after) {
  if (!validDate(after.date_from) || !validDate(after.date_to) || after.date_from > after.date_to) return 'Enter a valid fiscal year date range';
  if (before?.state === 'closed' && (before.date_from !== after.date_from || before.date_to !== after.date_to)) return 'Reopen the fiscal year before changing its dates';
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
  const marked = write(entry.db, 'account.move', entry.id, { is_closing: true });
  return updateSettings(write(marked, 'account.fiscal.year', yearId, { state: 'closed', closing_move_id: entry.id, opening_move_id: null }), {
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
  const next = db.settings?.lock_date === year.date_to ? updateSettings(db, { lock_date: previous }) : db;
  const entry = postEntry(next, {
    journal: 'MISC', date: year.date_to, ref: `Reopen fiscal year: ${year.name}`,
    lines: closing.line_ids.map((l) => ({ account: read(next, 'account.account', l.account_id).code, debit: l.credit, credit: l.debit, partner_id: l.partner_id })),
  });
  return write(write(entry.db, 'account.move', entry.id, { is_closing: true }), 'account.fiscal.year', yearId, { state: 'open', opening_move_id: entry.id });
}

/** Open foreign invoices/bills at a date; positive difference increases the absolute balance. */
export function unrealizedExchange(db, date) {
  checkDate(date);
  return search(db, 'account.move').filter((m) => m.state === 'posted' && ['out_invoice', 'in_invoice'].includes(m.move_type)
    && m.invoice_date <= date && m.currency_id && read(db, 'res.currency', m.currency_id)?.name !== db.settings?.currency).flatMap((m) => {
    const payments = m.payments ?? [];
    const untrackedPaid = Math.max(0, round((Number(m.amount_paid) || 0) - payments.reduce((s, p) => s + p.amount, 0)));
    const paid = payments.filter((p) => p.date <= date);
    const residual = round(m.amount_total - untrackedPaid - paid.reduce((s, p) => s + p.amount, 0));
    if (residual <= 0) return [];
    const account = m.move_type === 'out_invoice' ? '121000' : '211000';
    const sign = m.move_type === 'out_invoice' ? 1 : -1;
    const original = (m.line_ids ?? []).filter((l) => l.account_id === accountId(db, account))
      .reduce((s, l) => s + sign * ((Number(l.debit) || 0) - (Number(l.credit) || 0)), 0);
    const booked = round(original - toCompany(db, m.currency_id, untrackedPaid, m.invoice_date)
      - paid.reduce((s, p) => s + toCompany(db, m.currency_id, p.amount, m.invoice_date), 0));
    const value = toCompany(db, m.currency_id, residual, date);
    return [{ invoice_id: m.id, partner_id: m.partner_id, currency_id: m.currency_id, account, residual, booked, value, difference: round(value - booked) }];
  });
}

/** Post one exchange adjustment and its next-day reversal, once per date. */
export function revalueForeignBalances(db, date, { gainCode = '450100', lossCode = '650100' } = {}) {
  checkDate(date);
  const ref = `Foreign currency revaluation: ${date}`;
  if (search(db, 'account.move').some((m) => (m.revaluation_date === date || m.ref === ref) && m.state === 'posted')) return db;
  const rows = unrealizedExchange(db, date).filter((r) => r.difference);
  if (!rows.length) return db;
  let next = ensureAccount(db, gainCode, 'Foreign Exchange Gain', 'income_other');
  next = ensureAccount(next, lossCode, 'Foreign Exchange Loss', 'expense_other');
  let gain = 0;
  let loss = 0;
  const lines = rows.map((r) => {
    const amount = round(r.difference * (r.account === '121000' ? 1 : -1));
    if (amount > 0) gain = round(gain + amount);
    else loss = round(loss - amount);
    return { account: r.account, partner_id: r.partner_id, ...side(amount) };
  });
  if (gain) lines.push({ account: gainCode, credit: gain });
  if (loss) lines.push({ account: lossCode, debit: loss });
  const entry = postEntry(next, { journal: 'MISC', date, ref, lines });
  const reversal = postEntry(entry.db, {
    journal: 'MISC', date: addDays(date, 1), ref: `Reversal of ${read(entry.db, 'account.move', entry.id).name}`,
    lines: lines.map((l) => ({ ...l, debit: l.credit ?? 0, credit: l.debit ?? 0 })),
  });
  return write(reversal.db, 'account.move', entry.id, { revaluation_date: date, reversal_move_id: reversal.id });
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
          ask: [{ label: 'Revaluation date (YYYY-MM-DD)', default: (r) => (today() < r.date_to ? today() : r.date_to) }],
          run: (db, r, [date]) => ({ db: revalueForeignBalances(db, date) }),
        },
      ],
      chatter: true,
    },
  },
};
