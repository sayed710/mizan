// Deferred revenue/expense: an invoiced amount recognised month by month over a period.
import { read, write } from '../orm.js';
import { today } from './common.js';
import { postEntry } from './ledger.js';

const cents = (n) => Math.round((Number(n) || 0) * 100);
const monthEnd = (y, m) => `${y}-${String(m).padStart(2, '0')}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
const ACCOUNTS = { revenue: ['212000', '400000'], expense: ['600000', '132000'] };

/** One line per month, dated at month end from `startDate`'s month; the last line absorbs rounding. */
export function deferralBoard(amount, startDate, months) {
  const [y, m] = startDate.split('-').map(Number);
  const share = Math.round(cents(amount) / months);
  return Array.from({ length: months }, (_, i) => ({
    date: monthEnd(y + Math.floor((m - 1 + i) / 12), ((m - 1 + i) % 12) + 1),
    amount: (i === months - 1 ? cents(amount) - share * (months - 1) : share) / 100,
  }));
}

/** Build the recognition board and start the schedule. */
export function computeBoard(db, d) {
  if (!(Number(d.amount) > 0)) throw new Error('The amount must be positive');
  if (!Number.isInteger(Number(d.months)) || Number(d.months) < 1) throw new Error('The number of months must be at least 1');
  if (!d.start_date) throw new Error('Set a start date');
  const board = deferralBoard(d.amount, d.start_date, Number(d.months)).map((l) => ({ ...l, posted: false, move_id: null }));
  return write(db, 'account.deferral', d.id, { board, state: 'running' });
}

/** Post every unposted board line dated on or before `upTo`; the schedule is done once all are posted. */
export function postDueEntries(db, d, upTo = today()) {
  const [debit, credit] = ACCOUNTS[d.kind] ?? ACCOUNTS.revenue;
  const { db: next, board } = (d.board ?? []).reduce((acc, l) => {
    if (l.posted || l.date > upTo) return { ...acc, board: [...acc.board, l] };
    const { db: booked, id } = postEntry(acc.db, {
      journal: 'MISC', date: l.date, ref: `${d.name} ${l.date.slice(0, 7)}`,
      lines: [{ account: debit, debit: l.amount, partner_id: d.partner_id ?? undefined }, { account: credit, credit: l.amount, partner_id: d.partner_id ?? undefined }],
    });
    return { db: booked, board: [...acc.board, { ...l, posted: true, move_id: id }] };
  }, { db, board: [] });
  return write(next, 'account.deferral', d.id, { board, state: board.every((l) => l.posted) ? 'done' : 'running' });
}

export const deferredModels = {
  'account.deferral': {
    label: 'Deferrals',
    fields: {
      name: { type: 'char', label: 'Name', required: true },
      kind: { type: 'selection', label: 'Type', options: [['revenue', 'Deferred Revenue'], ['expense', 'Deferred Expense']] },
      amount: { type: 'monetary', label: 'Amount' },
      start_date: { type: 'date', label: 'Start Date' },
      months: { type: 'integer', label: 'Months' },
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Partner' },
      state: { type: 'selection', label: 'Status', tracking: true, options: [['draft', 'Draft'], ['running', 'Running'], ['done', 'Done'], ['cancel', 'Cancelled']] },
      board: {
        type: 'one2many',
        label: 'Recognition Board',
        fields: {
          date: { type: 'date', label: 'Date' },
          amount: { type: 'monetary', label: 'Amount' },
          posted: { type: 'boolean', label: 'Posted' },
          move_id: { type: 'many2one', relation: 'account.move', label: 'Entry' },
        },
        newLine: () => ({ date: today(), amount: 0, posted: false, move_id: null }),
      },
    },
    defaults: () => ({ kind: 'revenue', start_date: today(), months: 12, state: 'draft', board: [] }),
    groupBys: ['kind', 'state'],
    kanban: { title: 'name', lines: ['kind', 'amount', 'months'], badge: 'state' },
    list: ['name', 'kind', 'partner_id', 'start_date', 'months', 'amount', 'state'],
    form: {
      statusbar: 'state',
      lockedWhen: (r) => ['done', 'cancel'].includes(r.state),
      buttons: [
        { label: 'Compute', primary: true, when: (r) => r.state === 'draft', run: (db, r) => ({ db: computeBoard(db, r) }) },
        { label: 'Post Due Entries', primary: true, when: (r) => r.state === 'running', run: (db, r) => ({ db: postDueEntries(db, read(db, 'account.deferral', r.id)) }) },
        { label: 'Cancel', when: (r) => ['draft', 'running'].includes(r.state), vals: { state: 'cancel' } },
      ],
      title: 'name',
      groups: [['kind', 'partner_id', 'amount'], ['start_date', 'months']],
      tabs: [{ label: 'Recognition Board', fields: ['board'] }],
      chatter: true,
    },
  },
};
