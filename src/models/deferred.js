// Deferred revenue/expense: an invoiced amount recognised month by month over a period.
import { create, read, write } from '../orm.js';
import { addDays, today } from './common.js';
import { postEntry } from './ledger.js';
import { postAnalytic } from './analyticplus.js';
import { allocateCents, companyCurrencyRecord, roundCurrency } from '../money.js';

const monthEnd = (y, m) => `${y}-${String(m).padStart(2, '0')}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
const ACCOUNTS = { revenue: ['212000', '400000'], expense: ['600000', '132000'] };
const DAY = 86400000;

/** Allocate company currency over inclusive monthly periods. */
function datedBoard(amount, start, end, method = 'days', currency = null) {
  const valid = (date) => /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
  if (!valid(start) || !valid(end) || start > end) throw new Error('Set valid deferred start and end dates');
  const rows = [];
  let cursor = start;
  while (cursor <= end) {
    const [year, month] = cursor.split('-').map(Number);
    const last = monthEnd(year, month);
    const through = last < end ? last : end;
    const days = (Date.parse(through) - Date.parse(cursor)) / DAY + 1;
    const monthDays = Number(last.slice(-2));
    rows.push({ date: last, weight: method === 'full_months' ? 1 : method === 'months' ? days / monthDays : days });
    cursor = new Date(Date.parse(through) + DAY).toISOString().slice(0, 10);
  }
  const amounts = allocateCents(amount, rows.map((row) => row.weight), currency);
  return rows.map((row, index) => ({ date: row.date, amount: amounts[index], posted: false, move_id: null }));
}

/** Cumulative recognition for one board period through an inclusive cut-off date. */
function recognitionTargetThroughDate(schedule, index, date, method, currency) {
  const line = schedule.board[index];
  const start = index === 0 ? (schedule.start_date ?? line.date) : addDays(schedule.board[index - 1].date, 1);
  const end = schedule.end_date && schedule.end_date < line.date ? schedule.end_date : line.date;
  if (date < start) return 0;
  const elapsedThrough = date < end ? date : end;
  if (method === 'full_months' && elapsedThrough < end) return 0;
  const elapsedDays = Math.floor((Date.parse(elapsedThrough) - Date.parse(start)) / DAY) + 1;
  const periodDays = Math.floor((Date.parse(end) - Date.parse(start)) / DAY) + 1;
  if (periodDays <= 0) throw new Error(`Invalid deferred service period on ${schedule.name}`);
  return roundCurrency((Number(line.amount) || 0) * elapsedDays / periodDays, currency);
}

const isRefund = (move) => ['out_refund', 'in_refund'].includes(move.move_type);

/** Make schedules from the protected posted company amounts, once per source line. */
export function createInvoiceDeferrals(db, move) {
  if (!['out_invoice', 'in_invoice', 'out_refund', 'in_refund'].includes(move.move_type)) return db;
  const company = read(db, 'res.company', move.company_id ?? 1);
  const refund = isRefund(move);
  let next = db;
  for (const [index, line] of (move.invoice_line_ids ?? []).entries()) {
    if (!line.deferred_start_date && !line.deferred_end_date) continue;
    const entryLine = (move.line_ids ?? []).find((l) => (l.invoice_sources ?? []).some((s) => s.index === index));
    const source = entryLine?.invoice_sources.find((s) => s.index === index);
    if (!source?.original_account_id || !(source.amount > 0)) throw new Error('Deferred line needs a positive posted amount and recognition account');
    const board = datedBoard(source.amount, line.deferred_start_date, line.deferred_end_date, company?.deferred_amount_computation_method, companyCurrencyRecord(db, move.company_id));
    const created = create(next, 'account.deferral', { name: `${move.name} ${index + 1}`, kind: move.move_type.startsWith('out') ? 'revenue' : 'expense', amount: refund ? -source.amount : source.amount, start_date: line.deferred_start_date, end_date: line.deferred_end_date, months: board.length, board: refund ? board.map((r) => ({ ...r, amount: -r.amount })) : board, state: 'running', company_id: move.company_id ?? 1, partner_id: move.partner_id, source_move_id: move.id, source_line: index, deferred_account_id: entryLine.account_id, recognition_account_id: source.original_account_id, analytic_distribution: line.analytic_distribution });
    next = created.db;
    if (company?.deferred_generation_method === 'on_validation') next = postDueEntries(next, read(next, 'account.deferral', created.id), '9999-12-31');
  }
  return next;
}

/** Reverse every recognition entry when the originating document is reset. */
export function reverseInvoiceDeferrals(db, source) {
  const schedules = (db.records['account.deferral'] ?? []).filter((d) => d.source_move_id === source.id && d.state !== 'cancel');
  const scheduleIds = new Set(schedules.map((schedule) => schedule.id));
  const corrections = [];
  for (const original of db.records['account.move'] ?? []) {
    if (!original.is_deferred_grouped || original.reversed_entry_id || original.state !== 'posted') continue;
    const contributions = original.deferred_contributions ?? [];
    for (const contribution of contributions) {
      if (!scheduleIds.has(contribution.schedule_id)) continue;
      const reversal = read(db, 'account.move', original.reversal_move_id);
      const amount = roundCurrency((contribution.board_lines ?? []).reduce((sum, line) => sum + line.amount, 0), companyCurrencyRecord(db, original.company_id));
      const absAmount = Math.abs(amount);
      const deferred = original.line_ids?.[contribution.deferred_line_index];
      const recognized = original.line_ids?.[contribution.recognition_line_index];
      if (!reversal || reversal.state !== 'posted' || reversal.reversed_entry_id !== original.id || !deferred || !recognized || !absAmount
        || Math.max(deferred.debit, deferred.credit) < absAmount || Math.max(recognized.debit, recognized.credit) !== absAmount
        || (deferred.debit > 0) === (recognized.debit > 0)) {
        throw new Error('Cannot safely reverse grouped deferral contribution');
      }
      const lines = [deferred, recognized].map((line) => ({
        account_id: line.account_id, debit: line.credit > 0 ? absAmount : 0, credit: line.debit > 0 ? absAmount : 0,
        partner_id: line.partner_id, analytic_distribution: line.analytic_distribution,
      }));
      corrections.push({ original, reversal, lines });
    }
  }
  let next = db;
  for (const { original, reversal, lines } of corrections) {
    for (const [move, reverse] of [[original, false], [reversal, true]]) {
      const correction = postEntry(next, {
        journal: move.journal_id, company: move.company_id, date: move.invoice_date ?? move.date,
        ref: `Grouped deferral adjustment ${move.name}`,
        lines: lines.map((line) => reverse ? { ...line, debit: line.credit, credit: line.debit } : line),
      });
      next = postAnalytic(correction.db, correction.id);
    }
  }
  for (const schedule of schedules) {
    const board = [];
    for (const line of schedule.board ?? []) {
      if (!line.move_id || line.reversal_move_id) { board.push(line); continue; }
      const original = read(next, 'account.move', line.move_id);
      const reversal = postEntry(next, { journal: original.journal_id, company: schedule.company_id, date: original.invoice_date ?? original.date ?? today(), ref: `Reversal of ${original.name}`, lines: original.line_ids.map((l) => ({ account: l.account_id, debit: l.credit, credit: l.debit, partner_id: l.partner_id, analytic_distribution: l.analytic_distribution })) });
      next = postAnalytic(write(reversal.db, 'account.move', reversal.id, { reversed_entry_id: original.id }), reversal.id);
      board.push({ ...line, reversal_move_id: reversal.id });
    }
    next = write(next, 'account.deferral', schedule.id, { board, state: 'cancel' });
  }
  return next;
}

/** One line per month, dated at month end from `startDate`'s month. */
export function deferralBoard(amount, startDate, months, currency = null) {
  const [y, m] = startDate.split('-').map(Number);
  const shares = allocateCents(amount, Array(months).fill(1), currency);
  return Array.from({ length: months }, (_, i) => ({
    date: monthEnd(y + Math.floor((m - 1 + i) / 12), ((m - 1 + i) % 12) + 1),
    amount: shares[i],
  }));
}

/** Build the recognition board and start the schedule. */
export function computeBoard(db, d) {
  if (!(Number(d.amount) > 0)) throw new Error('The amount must be positive');
  if (!d.end_date && (!Number.isInteger(Number(d.months)) || Number(d.months) < 1)) throw new Error('The number of months must be at least 1');
  if (!d.start_date) throw new Error('Set a start date');
  const company = read(db, 'res.company', d.company_id ?? 1);
  const end = d.end_date || deferralBoard(d.amount, d.start_date, Number(d.months)).at(-1).date;
  const board = datedBoard(d.amount, d.start_date, end, company?.deferred_amount_computation_method, companyCurrencyRecord(db, d.company_id));
  return write(db, 'account.deferral', d.id, { board, months: board.length, state: 'running' });
}

/** Post every unposted board line dated on or before `upTo`; the schedule is done once all are posted. */
export function postDueEntries(db, d, upTo = today()) {
  d = read(db, 'account.deferral', d.id) ?? d;
  if (read(db, 'res.company', d.company_id ?? 1)?.deferred_generation_method === 'manual_grouped') {
    throw new Error('Individual posting is unavailable for grouped deferrals');
  }
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

/**
 * Post ONE grouped entry per company and kind for a chosen period end date,
 * moving recognized-to-date amounts from the deferred account to each line's
 * original recognition account (carrying analytic distributions), plus its exact
 * next-day reversal.
 */
export function generateGroupedEntries(db, { date, company_id, kind } = {}) {
  const companyId = company_id ?? db.settings?.current_company_id ?? 1;
  if (read(db, 'res.company', companyId)?.deferred_generation_method !== 'manual_grouped') {
    throw new Error('Grouped deferral generation requires a company configured for grouped posting');
  }

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) {
    throw new Error('Set a valid period end date');
  }

  const currency = companyCurrencyRecord(db, companyId);
  const method = read(db, 'res.company', companyId)?.deferred_amount_computation_method ?? 'days';
  const kindsToProcess = kind ? [kind] : ['revenue', 'expense'];
  let currentDb = db;

  for (const k of kindsToProcess) {
    const existing = (currentDb.records['account.move'] ?? []).some((m) =>
      m.is_deferred_grouped &&
      !m.reversed_entry_id &&
      m.deferral_kind === k &&
      m.deferral_date === date &&
      (m.company_id ?? 1) === companyId
    );
    if (existing) continue;

    const schedules = (currentDb.records['account.deferral'] ?? []).filter((d) =>
      d.state !== 'cancel' &&
      (d.company_id ?? 1) === companyId &&
      d.kind === k &&
      (!d.source_move_id || read(currentDb, 'account.move', d.source_move_id)?.state === 'posted')
    );

    const recognizedItems = [];
    for (const s of schedules) {
      const boardLines = (s.board ?? []).map((line, index) => ({ line, index }))
        .map(({ line, index }) => {
          const target = line.posted ? 0 : recognitionTargetThroughDate(s, index, date, method, currency);
          return { line, index, amount: target };
        })
        .filter(({ amount }) => amount !== 0);
      const recognized = roundCurrency(boardLines.reduce((sum, { amount }) => sum + amount, 0), currency);
      if (recognized !== 0) {
        const [defaultDebit, defaultCredit] = ACCOUNTS[k] ?? ACCOUNTS.revenue;
        const deferredAcc = s.deferred_account_id ?? (k === 'expense' ? defaultCredit : defaultDebit);
        const recognitionAcc = s.recognition_account_id ?? (k === 'expense' ? defaultDebit : defaultCredit);
        recognizedItems.push({
          schedule: s,
          boardLines: boardLines.map(({ line, index, amount }) => ({ index, date: line.date, amount })),
          amount: recognized,
          recognition_account_id: recognitionAcc,
          deferred_account_id: deferredAcc,
          analytic_distribution: s.analytic_distribution,
          partner_id: s.partner_id,
          name: s.name,
        });
      }
    }

    if (!recognizedItems.length) continue;

    const isRev = k === 'revenue';
    const deferredTotals = new Map();
    for (const item of recognizedItems) {
      deferredTotals.set(item.deferred_account_id, roundCurrency((deferredTotals.get(item.deferred_account_id) ?? 0) + item.amount, currency));
    }

    const lines = [
      ...[...deferredTotals.entries()].map(([defAcc, totalAmt]) => ({
        account_id: defAcc,
        debit: isRev ? totalAmt : 0,
        credit: isRev ? 0 : totalAmt,
        name: `Deferred ${isRev ? 'Revenues' : 'Expenses'} ${date}`,
      })),
      ...recognizedItems.map((item) => ({
        account_id: item.recognition_account_id,
        debit: isRev ? 0 : item.amount,
        credit: isRev ? item.amount : 0,
        analytic_distribution: item.analytic_distribution,
        partner_id: item.partner_id ?? null,
        name: item.name,
      })),
    ];

    const ref = `Deferred ${isRev ? 'Revenues' : 'Expenses'}: ${date}`;
    const entryRes = postEntry(currentDb, {
      journal: 'MISC',
      date,
      ref,
      lines,
      company: companyId,
    });
    currentDb = postAnalytic(entryRes.db, entryRes.id);

    const revDate = addDays(date, 1);
    const revRef = `Reversal of ${read(currentDb, 'account.move', entryRes.id).name}`;
    const revLines = lines.map((l) => ({
      account_id: l.account_id,
      debit: l.credit ?? 0,
      credit: l.debit ?? 0,
      analytic_distribution: l.analytic_distribution,
      partner_id: l.partner_id,
      name: l.name,
    }));
    const revRes = postEntry(currentDb, {
      journal: 'MISC',
      date: revDate,
      ref: revRef,
      lines: revLines,
      company: companyId,
    });
    currentDb = postAnalytic(revRes.db, revRes.id);

    const deferredAccounts = [...deferredTotals.keys()];
    const contributions = recognizedItems.map((item, index) => ({
      schedule_id: item.schedule.id, board_lines: item.boardLines,
      deferred_line_index: deferredAccounts.indexOf(item.deferred_account_id),
      recognition_line_index: deferredAccounts.length + index,
    }));
    currentDb = write(currentDb, 'account.move', entryRes.id, {
      deferred_contributions: contributions,
      reversal_move_id: revRes.id,
      deferral_date: date,
      deferral_kind: k,
      is_deferred_grouped: true,
    });
    currentDb = write(currentDb, 'account.move', revRes.id, {
      deferred_contributions: contributions,
      reversed_entry_id: entryRes.id,
      deferral_date: revDate,
      deferral_kind: k,
      is_deferred_grouped: true,
    });
  }

  return currentDb;
}

/** Generate all due schedules of one company for a chosen period end. */
export function postCompanyDeferrals(db, companyId, upTo = today()) {
  const company = read(db, 'res.company', companyId);
  if (company?.deferred_generation_method === 'manual_grouped') {
    return generateGroupedEntries(db, { company_id: companyId, date: upTo });
  }
  return (db.records['account.deferral'] ?? []).filter((d) => d.state === 'running' && (d.company_id ?? 1) === companyId)
    .reduce((next, schedule) => postDueEntries(next, schedule, upTo), db);
}

export const deferredModels = {
  'account.deferral': {
    label: 'Deferrals',
    actions: {
      postDueEntries,
      postCompanyDeferrals,
      generateGroupedEntries,
    },
    listActions: [
      {
        label: 'Generate Entries',
        noSelection: true,
        ask: { label: 'Period End Date', default: today },
        // A kind-filtered menu (Deferred Revenues/Expenses) generates only its own kind.
        run: (db, ids, date, { defaults = {} } = {}) => generateGroupedEntries(db, { date, kind: defaults.kind }),
      },
    ],
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
      groups: [['kind', 'partner_id', 'company_id', 'amount', 'analytic_distribution'], ['start_date', 'end_date', 'months']],
      tabs: [{ label: 'Recognition Board', fields: ['board'] }],
      chatter: true,
    },
  },
};
