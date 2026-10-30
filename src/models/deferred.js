// Deferred revenue/expense: an invoiced amount recognised month by month over a period.
import { create, read, write } from '../orm.js';
import { today } from './common.js';
import { postEntry } from './ledger.js';
import { postAnalytic } from './analyticplus.js';
import { allocateCents } from '../money.js';

const monthEnd = (y, m) => `${y}-${String(m).padStart(2, '0')}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
const ACCOUNTS = { revenue: ['212000', '400000'], expense: ['600000', '132000'] };
const DAY = 86400000;

/** Allocate posted company currency over inclusive calendar days in each month. */
function datedBoard(amount, start, end) {
  const valid = (date) => /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
  if (!valid(start) || !valid(end) || start > end) throw new Error('Set valid deferred start and end dates');
  const rows = [];
  let cursor = start;
  while (cursor <= end) {
    const [year, month] = cursor.split('-').map(Number);
    const last = monthEnd(year, month);
    const through = last < end ? last : end;
    rows.push({ date: last, days: (Date.parse(through) - Date.parse(cursor)) / DAY + 1 });
    cursor = new Date(Date.parse(through) + DAY).toISOString().slice(0, 10);
  }
  const amounts = allocateCents(amount, rows.map((row) => row.days));
  return rows.map((row, index) => ({ date: row.date, amount: amounts[index], posted: false, move_id: null }));
}

/** Make schedules from the protected posted company amounts, once per source line. */
export function createInvoiceDeferrals(db, move) {
  if (!['out_invoice', 'in_invoice'].includes(move.move_type)) return db;
  const company = read(db, 'res.company', move.company_id ?? 1);
  let next = db;
  for (const [index, line] of (move.invoice_line_ids ?? []).entries()) {
    if (!line.deferred_start_date && !line.deferred_end_date) continue;
    const entryLine = (move.line_ids ?? []).find((l) => (l.invoice_sources ?? []).some((s) => s.index === index));
    const source = entryLine?.invoice_sources.find((s) => s.index === index);
    if (!source?.original_account_id || !(source.amount > 0)) throw new Error('Deferred line needs a positive posted amount and recognition account');
    const board = datedBoard(source.amount, line.deferred_start_date, line.deferred_end_date);
    const created = create(next, 'account.deferral', { name: `${move.name} ${index + 1}`, kind: move.move_type === 'out_invoice' ? 'revenue' : 'expense', amount: source.amount, start_date: line.deferred_start_date, end_date: line.deferred_end_date, months: board.length, board, state: 'running', company_id: move.company_id ?? 1, partner_id: move.partner_id, source_move_id: move.id, source_line: index, deferred_account_id: entryLine.account_id, recognition_account_id: source.original_account_id, analytic_distribution: line.analytic_distribution });
    next = created.db;
    if (company?.deferred_generation_method === 'on_validation') next = postDueEntries(next, read(next, 'account.deferral', created.id), '9999-12-31');
  }
  return next;
}

/** Reverse every recognition entry when the originating document is reset. */
export function reverseInvoiceDeferrals(db, source) {
  let next = db;
  for (const schedule of (db.records['account.deferral'] ?? []).filter((d) => d.source_move_id === source.id && d.state !== 'cancel')) {
    const board = [];
    for (const line of schedule.board ?? []) {
      if (!line.move_id || line.reversal_move_id) { board.push(line); continue; }
      const original = read(next, 'account.move', line.move_id);
      const reversal = postEntry(next, { journal: original.journal_id, company: schedule.company_id, date: today(), ref: `Reversal of ${original.name}`, lines: original.line_ids.map((l) => ({ account: l.account_id, debit: l.credit, credit: l.debit, partner_id: l.partner_id })) });
      next = write(reversal.db, 'account.move', reversal.id, { reversed_entry_id: original.id });
      board.push({ ...line, reversal_move_id: reversal.id });
    }
    next = write(next, 'account.deferral', schedule.id, { board, state: 'cancel' });
  }
  return next;
}

/** One line per month, dated at month end from `startDate`'s month. */
export function deferralBoard(amount, startDate, months) {
  const [y, m] = startDate.split('-').map(Number);
  const shares = allocateCents(amount, Array(months).fill(1));
  return Array.from({ length: months }, (_, i) => ({
    date: monthEnd(y + Math.floor((m - 1 + i) / 12), ((m - 1 + i) % 12) + 1),
    amount: shares[i],
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
  d = read(db, 'account.deferral', d.id) ?? d;
  if (d.state === 'cancel') return db;
  const [defaultDebit, defaultCredit] = ACCOUNTS[d.kind] ?? ACCOUNTS.revenue;
  const debit = (d.kind === 'expense' ? d.recognition_account_id : d.deferred_account_id) ?? defaultDebit;
  const credit = (d.kind === 'expense' ? d.deferred_account_id : d.recognition_account_id) ?? defaultCredit;
  const { db: next, board } = (d.board ?? []).reduce((acc, l) => {
    if (l.posted || l.date > upTo) return { ...acc, board: [...acc.board, l] };
    if (!l.amount) return { ...acc, board: [...acc.board, { ...l, posted: true, move_id: null }] };
    const { db: booked, id } = postEntry(acc.db, {
      journal: 'MISC', company: d.company_id, date: l.date, ref: `${d.name} ${l.date.slice(0, 7)}`,
      lines: [{ account: debit, debit: l.amount, partner_id: d.partner_id ?? undefined, ...(d.kind === 'expense' ? { analytic_distribution: d.analytic_distribution } : {}) }, { account: credit, credit: l.amount, partner_id: d.partner_id ?? undefined, ...(d.kind === 'revenue' ? { analytic_distribution: d.analytic_distribution } : {}) }],
    });
    return { db: postAnalytic(booked, id), board: [...acc.board, { ...l, posted: true, move_id: id }] };
  }, { db, board: [] });
  return write(next, 'account.deferral', d.id, { board, state: board.every((l) => l.posted) ? 'done' : 'running' });
}

/** Generate all due schedules of one company for a chosen period end. */
export function postCompanyDeferrals(db, companyId, upTo = today()) {
  return (db.records['account.deferral'] ?? []).filter((d) => d.state === 'running' && (d.company_id ?? 1) === companyId)
    .reduce((next, schedule) => postDueEntries(next, schedule, upTo), db);
}

export const deferredModels = {
  'account.deferral': {
    label: 'Deferrals',
    actions: { postDueEntries, postCompanyDeferrals },
    fields: {
      name: { type: 'char', label: 'Name', required: true },
      kind: { type: 'selection', label: 'Type', options: [['revenue', 'Deferred Revenue'], ['expense', 'Deferred Expense']] },
      amount: { type: 'monetary', label: 'Amount' },
      start_date: { type: 'date', label: 'Start Date' },
      end_date: { type: 'date', label: 'End Date' },
      months: { type: 'integer', label: 'Months' },
      source_move_id: { type: 'many2one', relation: 'account.move', label: 'Source Document' },
      source_line: { type: 'integer', label: 'Source Line' },
      deferred_account_id: { type: 'many2one', relation: 'account.account', label: 'Deferred Account' },
      recognition_account_id: { type: 'many2one', relation: 'account.account', label: 'Recognition Account' },
      company_id: { type: 'many2one', relation: 'res.company', label: 'Company' },
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Partner' },
      analytic_distribution: { type: 'distribution', label: 'Analytic Distribution' },
      state: { type: 'selection', label: 'Status', tracking: true, options: [['draft', 'Draft'], ['running', 'Running'], ['done', 'Done'], ['cancel', 'Cancelled']] },
      board: {
        type: 'one2many',
        label: 'Recognition Board',
        fields: {
          date: { type: 'date', label: 'Date' },
          amount: { type: 'monetary', label: 'Amount' },
          posted: { type: 'boolean', label: 'Posted' },
          move_id: { type: 'many2one', relation: 'account.move', label: 'Entry' },
          reversal_move_id: { type: 'many2one', relation: 'account.move', label: 'Reversal Entry' },
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
        { label: 'Post Due Entries', primary: true, when: (r) => ['running', 'done'].includes(r.state), run: (db, r) => ({ db: postDueEntries(db, read(db, 'account.deferral', r.id)) }) },
        { label: 'Cancel', when: (r) => ['draft', 'running'].includes(r.state), vals: { state: 'cancel' } },
      ],
      title: 'name',
      groups: [['kind', 'partner_id', 'amount', 'analytic_distribution'], ['start_date', 'months']],
      tabs: [{ label: 'Recognition Board', fields: ['board'] }],
      chatter: true,
    },
  },
};
