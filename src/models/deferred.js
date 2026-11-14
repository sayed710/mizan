// Deferred revenue/expense: an invoiced amount recognised month by month over a period.
import { create, read, write } from '../orm.js';
import { addDays, amounts, companyRoundingMethod, today } from './common.js';
import { invoiceLineAccount, postEntry } from './ledger.js';
import { postAnalytic } from './analyticplus.js';
import { closedYearLock, lockDateFor } from './finance.js';
import { allocateCents, companyCurrencyRecord, documentCurrency, roundCurrency } from '../money.js';

const monthEnd = (y, m) => `${y}-${String(m).padStart(2, '0')}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
const DAY = 86400000;

export const DEFERRED_REVENUE_GENERATION_OPTIONS = [['on_validation', 'On invoice validation'], ['manual', 'Manually & Grouped']];
export const DEFERRED_EXPENSE_GENERATION_OPTIONS = [['on_validation', 'On bill validation'], ['manual', 'Manually & Grouped']];
export const DEFERRED_COMPUTATION_OPTIONS = [['day', 'By Days'], ['month', 'By Months'], ['full_months', 'By Full Months']];
export const DEFERRED_PERIODICITY_OPTIONS = [['month', 'Monthly'], ['year', 'Yearly']];

/** Normalize legacy and Odoo-20 deferral computation method keys to `day`, `month`, or `full_months`. */
export function normalizeDeferredComputationMethod(method) {
  if (method === 'full_months') return 'full_months';
  if (method === 'month' || method === 'months') return 'month';
  return 'day';
}

/** Map legacy company `deferred_generation_method` to Odoo-20 `generate_deferred_*_entries_method`. */
export function mapLegacyDeferredGenerationMethod(method) {
  if (method === 'on_validation') return 'on_validation';
  if (method === 'manual_grouped') return 'manual';
  return null;
}

/** Canonical `account.move.deferred_entry_type` value for a deferral schedule kind. */
export function deferredEntryTypeForKind(kind) {
  if (kind === 'revenue') return 'revenue';
  if (kind === 'expense') return 'expense';
  return 'misc';
}

/** Resolve and validate per-kind deferred accounting settings for a company. */
export function deferredSettings(db, companyId, kind) {
  const company = read(db, 'res.company', companyId ?? 1);
  const k = kind === 'expense' ? 'expense' : 'revenue';
  const perKindGen = company?.[k === 'revenue' ? 'generate_deferred_revenue_entries_method' : 'generate_deferred_expense_entries_method'];
  const perKindComp = company?.[k === 'revenue' ? 'deferred_revenue_amount_computation_method' : 'deferred_expense_amount_computation_method'];
  const perKindPeriodicity = company?.[k === 'revenue' ? 'deferred_revenue_periodicity' : 'deferred_expense_periodicity'];
  const legacyGen = company?.deferred_generation_method;
  const legacyComp = company?.deferred_amount_computation_method;
  const generationMethod = perKindGen || (legacyGen === 'manual_grouped' ? 'manual' : legacyGen === 'manual' ? 'manual_individual' : 'on_validation');
  const computationMethod = normalizeDeferredComputationMethod(perKindComp || legacyComp || 'day');
  const periodicity = perKindPeriodicity === 'year' ? 'year' : 'month';
  const journalId = company?.[k === 'revenue' ? 'deferred_revenue_journal_id' : 'deferred_expense_journal_id'] ?? null;
  const accountId = company?.[k === 'revenue' ? 'deferred_revenue_account_id' : 'deferred_expense_account_id'] ?? null;
  return {
    kind: k,
    generationMethod,
    computationMethod,
    periodicity,
    journalId,
    accountId,
    isGrouped: generationMethod === 'manual',
    isOnValidation: generationMethod === 'on_validation',
    isIndividualManual: generationMethod === 'manual_individual',
  };
}

/** Resolve and validate the journal spec to pass to `postEntry` for a company's deferral entries. */
export function deferredJournalSpec(db, companyId, kind) {
  const cid = companyId ?? 1;
  const company = read(db, 'res.company', cid);
  const settings = deferredSettings(db, cid, kind);
  if (settings.journalId) {
    const j = read(db, 'account.journal', settings.journalId);
    if (!j || j.active === false) throw new Error(`Configure an active deferred ${settings.kind} journal on the company`);
    if (j.company_id && j.company_id !== cid) throw new Error(`Deferred ${settings.kind} journal must belong to the company`);
    if (j.type !== 'general') throw new Error(`Deferred ${settings.kind} journal must be a Miscellaneous journal`);
    return { journal: j.id, journal_id: j.id };
  }
  const defaultGeneral = company?.default_general_journal_id && read(db, 'account.journal', company.default_general_journal_id);
  if (defaultGeneral && defaultGeneral.active !== false && defaultGeneral.type === 'general' && defaultGeneral.company_id === cid) {
    return { journal: defaultGeneral.id, journal_id: defaultGeneral.id };
  }
  return { journal: 'MISC', journal_id: null };
}

/** Whether deferral schedule `d` links directly to journal entry `moveId`. */
export const deferralLinksMove = (d, moveId) => Boolean(d && moveId) && (
  d.source_move_id === moveId
  || (d.board ?? []).some((l) => l.move_id === moveId || l.reversal_move_id === moveId)
  || (d.credit_adjustments ?? []).some((adj) => (adj.move_ids ?? []).includes(moveId))
);

export function effectivelyReversedEntryIds(moves) {
  const posted = (moves ?? []).filter((m) => m.state === 'posted');
  const reversalsBySource = new Map();
  for (const m of posted) {
    if (m.reversed_entry_id) {
      const list = reversalsBySource.get(m.reversed_entry_id) ?? [];
      list.push(m);
      reversalsBySource.set(m.reversed_entry_id, list);
    }
  }

  const memo = new Map();
  function isReversed(id, visited = new Set()) {
    if (!id || visited.has(id)) return false;
    if (memo.has(id)) return memo.get(id);
    visited.add(id);
    const reversals = reversalsBySource.get(id) ?? [];
    const reversed = reversals.some((rev) => !isReversed(rev.id, new Set(visited)));
    memo.set(id, reversed);
    return reversed;
  }

  const result = new Set();
  for (const m of posted) {
    if (isReversed(m.id)) result.add(m.id);
  }
  for (const sourceId of reversalsBySource.keys()) {
    if (isReversed(sourceId)) result.add(sourceId);
  }
  return result;
}

function groupedBoardLines(schedule, date, method, currency) {
  return (schedule.board ?? []).map((line, index) => {
    const amount = line.posted || line.cancelled ? 0 : recognitionTargetThroughDate(schedule, index, date, method, currency);
    return { line, index, amount };
  }).filter(({ amount }) => amount !== 0)
    .map(({ line, index, amount }) => ({ index, date: line.date, amount }));
}

function adjustedRecognitionOutstanding(line, currency) {
  const amount = roundCurrency(Math.abs(Number(line.amount) || 0), currency);
  const adjusted = roundCurrency(Math.abs(Number(line.credit_adjusted_amount) || 0), currency);
  if (adjusted > amount) throw new Error('Deferred recognition credit adjustments exceed the posted amount');
  return roundCurrency(amount - adjusted, currency);
}

function scheduleAccounts(db, schedule) {
  const company = schedule.company_id ?? 1;
  const recognition = schedule.recognition_account_id;
  const recognitionAccount = read(db, 'account.account', recognition);
  const deferred = schedule.deferred_account_id
    ?? recognitionAccount?.deferred_account_id
    ?? read(db, 'res.company', company)?.[schedule.kind === 'expense' ? 'deferred_expense_account_id' : 'deferred_revenue_account_id'];
  for (const [id, label] of [[deferred, `deferred ${schedule.kind} account on the company`], [recognition, 'recognition account on the source line']]) {
    const account = read(db, 'account.account', id);
    if (!account || account.active === false || (account.company_id && account.company_id !== company)) throw new Error(`Configure the ${label}`);
  }
  return { deferred, recognition };
}

/** Allocate company currency over inclusive monthly or yearly periods. */
function datedBoard(amount, start, end, method = 'day', currency = null, periodicity = 'month') {
  const valid = (date) => /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
  if (!valid(start) || !valid(end) || start > end) throw new Error('Set valid deferred start and end dates');
  const normMethod = normalizeDeferredComputationMethod(method);
  const rows = [];
  let cursor = start;
  while (cursor <= end) {
    const [year, month] = cursor.split('-').map(Number);
    const last = periodicity === 'year' ? `${year}-12-31` : monthEnd(year, month);
    const through = last < end ? last : end;
    const days = (Date.parse(through) - Date.parse(cursor)) / DAY + 1;
    const periodDays = periodicity === 'year'
      ? (Date.parse(`${year}-12-31`) - Date.parse(`${year}-01-01`)) / DAY + 1
      : Number(last.slice(-2));
    rows.push({ date: last, weight: normMethod === 'full_months' ? 1 : normMethod === 'month' ? days / periodDays : days });
    cursor = new Date(Date.parse(through) + DAY).toISOString().slice(0, 10);
  }
  const amounts = allocateCents(amount, rows.map((row) => row.weight), currency);
  return rows.map((row, index) => ({ date: row.date, amount: amounts[index], posted: false, move_id: null }));
}

/** Cumulative recognition for one board period through an inclusive cut-off date. */
function recognitionTargetThroughDate(schedule, index, date, method, currency) {
  const normMethod = normalizeDeferredComputationMethod(method);
  const line = schedule.board[index];
  const start = index === 0 ? (schedule.start_date ?? line.date) : addDays(schedule.board[index - 1].date, 1);
  const end = schedule.end_date && schedule.end_date < line.date ? schedule.end_date : line.date;
  if (date < start) return 0;
  const elapsedThrough = date < end ? date : end;
  if (normMethod === 'full_months' && elapsedThrough < end) return 0;
  const elapsedDays = Math.floor((Date.parse(elapsedThrough) - Date.parse(start)) / DAY) + 1;
  const periodDays = Math.floor((Date.parse(end) - Date.parse(start)) / DAY) + 1;
  if (periodDays <= 0) throw new Error(`Invalid deferred service period on ${schedule.name}`);
  return roundCurrency((Number(line.amount) || 0) * elapsedDays / periodDays, currency);
}

const isRefund = (move) => ['out_refund', 'in_refund'].includes(move.move_type);

function correctionDate(db, move) {
  const date = move.invoice_date ?? move.date ?? today();
  const company = read(db, 'res.company', move.company_id ?? 1);
  const journal = read(db, 'account.journal', move.journal_id);
  const lock = [lockDateFor(company, { move_type: 'entry' }, journal), closedYearLock(db, move.company_id ?? 1)].sort().at(-1);
  if (!lock || date > lock) return date;
  if (today() <= lock) throw new Error(`Cannot reverse deferred recognition: the period up to ${lock} is locked`);
  return today();
}

/** Make schedules from the protected posted company amounts, once per source line. */
export function createInvoiceDeferrals(db, move) {
  if (!['out_invoice', 'in_invoice', 'out_refund', 'in_refund'].includes(move.move_type)) return db;
  const refund = isRefund(move);
  const sourceInvoice = refund && move.reversed_entry_id ? read(db, 'account.move', move.reversed_entry_id) : null;
  let next = db;
  for (const line of move.invoice_line_ids ?? []) {
    if (!line.deferred_start_date && !line.deferred_end_date) continue;
    if (!line.line_id) throw new Error('Deferred invoice lines need a stable line ID before posting');
    const creditedSourceLine = line.source_line_id && sourceInvoice
      ? (sourceInvoice.invoice_line_ids ?? []).find((sourceLine) => String(sourceLine.line_id) === String(line.source_line_id))
      : null;
    const linkedDeferredLine = creditedSourceLine && (creditedSourceLine.deferred_start_date || creditedSourceLine.deferred_end_date);
    if (linkedDeferredLine) continue;
    const matches = (move.line_ids ?? []).flatMap((entryLine) => (entryLine.invoice_sources ?? [])
      .filter((sourceLine) => String(sourceLine.line_id ?? '') === String(line.line_id))
      .map((sourceLine) => ({ entryLine, sourceLine })));
    if (matches.length !== 1) throw new Error('Deferred invoice line needs one explicit posted journal source');
    const [{ entryLine, sourceLine: source }] = matches;
    if (!source.original_account_id || !(source.amount > 0)) throw new Error('Deferred line needs a positive posted amount and recognition account');
    const kind = move.move_type.startsWith('out') ? 'revenue' : 'expense';
    const settings = deferredSettings(next, move.company_id, kind);
    const board = datedBoard(source.amount, line.deferred_start_date, line.deferred_end_date, settings.computationMethod, companyCurrencyRecord(db, move.company_id), settings.periodicity);
    const created = create(next, 'account.deferral', { name: `${move.name} ${line.line_id}`, kind, amount: refund ? -source.amount : source.amount, start_date: line.deferred_start_date, end_date: line.deferred_end_date, months: board.length, board: refund ? board.map((r) => ({ ...r, amount: -r.amount })) : board, state: 'running', company_id: move.company_id ?? 1, partner_id: move.partner_id, source_move_id: move.id, source_line_id: line.line_id, deferred_account_id: entryLine.account_id, recognition_account_id: source.original_account_id, analytic_distribution: line.analytic_distribution });
    next = created.db;
    if (settings.isOnValidation) next = postDueEntries(next, read(next, 'account.deferral', created.id), '9999-12-31');
  }
  return next;
}

function documentLineAmount(db, move, line) {
  const currency = documentCurrency(db, move);
  return roundCurrency(amounts([line], currency, { roundingMethod: companyRoundingMethod(db, move.company_id) }).untaxed, currency);
}

/** Validate explicit credit-line links and return the source schedules they may adjust. */
export function validateInvoiceDeferralCredit(db, note, invoice = read(db, 'account.move', note.reversed_entry_id)) {
  const linkedLines = (note.invoice_line_ids ?? []).filter((line) => line.source_line_id != null && line.source_line_id !== '');
  if (!linkedLines.length) return [];
  if (!isRefund(note) || !note.reversed_entry_id) throw new Error('A source invoice line reference requires a linked credit note');
  if (!invoice || invoice.state !== 'posted') throw new Error('The source invoice for this credit note is not posted');

  const currency = documentCurrency(db, invoice);
  const groups = new Map();
  for (const line of linkedLines) {
    const sourceLineId = String(line.source_line_id);
    const matches = (invoice.invoice_line_ids ?? []).filter((sourceLine) => String(sourceLine.line_id ?? '') === sourceLineId);
    if (matches.length !== 1) throw new Error('A credit note line points to a source invoice line that is missing or ambiguous');
    const sourceLine = matches[0];
    const currentAmount = documentLineAmount(db, note, line);
    if (currentAmount < 0) throw new Error('A credit note line linked to an invoice line cannot have a negative untaxed amount');
    const group = groups.get(sourceLineId) ?? { sourceLine, currentAmount: 0, creditLineIds: [], creditLines: [] };
    group.currentAmount = roundCurrency(group.currentAmount + currentAmount, currency);
    if (line.line_id != null && line.line_id !== '') group.creditLineIds.push(String(line.line_id));
    group.creditLines.push(line);
    groups.set(sourceLineId, group);
  }

  const postedCredits = (db.records['account.move'] ?? []).filter((move) => move.id !== note.id
    && move.state === 'posted' && move.reversed_entry_id === invoice.id);
  const sourceSchedules = (db.records['account.deferral'] ?? []).filter((schedule) =>
    schedule.source_move_id === invoice.id && schedule.state !== 'cancel');
  const plan = [];
  for (const [sourceLineId, group] of groups) {
    const originalAmount = documentLineAmount(db, invoice, group.sourceLine);
    const deferred = group.sourceLine.deferred_start_date || group.sourceLine.deferred_end_date;
    if (!(originalAmount > 0) && !group.currentAmount && !deferred) continue;
    if (!(originalAmount > 0) || !(group.currentAmount > 0)) throw new Error('The referenced source invoice line must have positive untaxed amounts');
    const previousAmount = roundCurrency(postedCredits.flatMap((move) => (move.invoice_line_ids ?? [])
      .filter((line) => String(line.source_line_id ?? '') === sourceLineId)
      .map((line) => documentLineAmount(db, move, line)))
      .reduce((sum, amount) => sum + amount, 0), currency);
    const cumulativeAmount = roundCurrency(previousAmount + group.currentAmount, currency);
    if (cumulativeAmount > roundCurrency(originalAmount, currency)) {
      throw new Error(`Credit notes exceed the amount on source invoice line ${sourceLineId}`);
    }
    if (!deferred) continue;

    if (sourceSchedules.some((schedule) => !schedule.source_line_id)) {
      throw new Error('A legacy deferral schedule is missing its source-line reference; explicitly relink it before crediting this deferred invoice');
    }
    const schedules = sourceSchedules.filter((schedule) => String(schedule.source_line_id) === sourceLineId);
    if (schedules.length !== 1) {
      throw new Error('The deferred source invoice line must have exactly one explicitly linked recognition schedule');
    }
    if (!Array.isArray(schedules[0].board)) throw new Error('The linked deferral schedule has no recognition board');
    for (const creditLine of group.creditLines) {
      let lineAccount;
      try {
        lineAccount = invoiceLineAccount(db, note, creditLine);
      } catch {
        lineAccount = null;
      }
      if (lineAccount !== schedules[0].deferred_account_id) {
        throw new Error("A credit note line linked to a deferred invoice must book against the source schedule's deferred account");
      }
    }
    plan.push({
      schedule: schedules[0],
      sourceLineId,
      creditLineIds: group.creditLineIds,
      originalAmount,
      previousAmount,
      currentAmount: group.currentAmount,
      currentShare: group.currentAmount / originalAmount,
      previousShare: previousAmount / originalAmount,
      cumulativeShare: cumulativeAmount / originalAmount,
      full: cumulativeAmount >= roundCurrency(originalAmount, currency),
    });
  }
  return plan;
}

function recognitionCorrectionLines(schedule, amount, reverse = true) {
  const partnerId = schedule.partner_id ?? undefined;
  const analytic = schedule.analytic_distribution ? { analytic_distribution: schedule.analytic_distribution } : {};
  const original = schedule.kind === 'revenue'
    ? [
      { account_id: schedule.deferred_account_id, debit: amount, credit: 0, partner_id: partnerId },
      { account_id: schedule.recognition_account_id, debit: 0, credit: amount, partner_id: partnerId, ...analytic },
    ]
    : [
      { account_id: schedule.recognition_account_id, debit: amount, credit: 0, partner_id: partnerId, ...analytic },
      { account_id: schedule.deferred_account_id, debit: 0, credit: amount, partner_id: partnerId },
    ];
  return reverse ? original.map((line) => ({ ...line, debit: line.credit, credit: line.debit })) : original;
}

function postRecognitionCorrection(db, schedule, sourceMove, amount, date, note, reverse = true) {
  const currency = companyCurrencyRecord(db, schedule.company_id);
  const value = roundCurrency(Number(amount) || 0, currency);
  if (!(value > 0)) return { db, id: null };
  const posted = postEntry(db, {
    journal_id: sourceMove.journal_id,
    company: schedule.company_id,
    date,
    ref: `Deferred recognition adjustment for ${note.name}`,
    lines: recognitionCorrectionLines(schedule, value, reverse),
    deferred_adjustment_of_id: sourceMove.id,
    deferred_entry_type: deferredEntryTypeForKind(schedule.kind),
    archivedOriginIds: [sourceMove.id],
  });
  return { db: postAnalytic(posted.db, posted.id), id: posted.id };
}

function cancelScheduledReversals(db, sourceMove) {
  const scheduledReversalsBefore = [];
  let next = db;
  const pending = (next.records['account.move'] ?? []).filter((move) =>
    move.state === 'draft' && move.auto_post === 'at_date' && move.reversed_entry_id === sourceMove.id
  );
  for (const move of pending) {
    scheduledReversalsBefore.push({ move_id: move.id, state: move.state, auto_post: move.auto_post });
    next = write(next, 'account.move', move.id, { state: 'cancel', auto_post: 'no' });
  }
  return { db: next, scheduled_reversals_before: scheduledReversalsBefore };
}

function restoreScheduledReversals(db, scheduledReversalsBefore, autoPostMoveFn) {
  const restorations = (scheduledReversalsBefore ?? []).map((prior) => {
    const reversal = read(db, 'account.move', prior.move_id);
    if (!reversal) throw new Error('A scheduled deferral reversal is missing and cannot be restored');
    if (reversal.state !== 'cancel' && reversal.state !== prior.state) {
      throw new Error('A scheduled deferral reversal changed before it could be restored');
    }
    const sourceMove = read(db, 'account.move', reversal.reversed_entry_id);
    if (!sourceMove) throw new Error('A scheduled deferral reversal has no source entry and cannot be restored');
    const date = reversal.date ?? reversal.invoice_date;
    if (!date) throw new Error('A scheduled deferral reversal has no posting date and cannot be restored');
    return { prior, reversal, sourceMove, date };
  });
  const currentDate = today();
  if (restorations.some(({ prior, date }) => prior.state === 'draft' && prior.auto_post === 'at_date' && date <= currentDate)
    && typeof autoPostMoveFn !== 'function') {
    throw new Error('A posting service is required to restore a due scheduled deferral reversal');
  }

  let next = db;
  for (const { prior, reversal, sourceMove, date } of restorations) {
    next = write(next, 'account.move', reversal.id, { state: prior.state, auto_post: prior.auto_post });
    // A secured (hashed) source keeps its fields; the reversal still points at it through reversed_entry_id.
    if (!sourceMove.inalterable_hash) next = write(next, 'account.move', sourceMove.id, { reversal_move_id: reversal.id });
    if (prior.state === 'draft' && prior.auto_post === 'at_date' && date <= currentDate) {
      next = autoPostMoveFn(next, reversal.id);
    }
  }
  return next;
}

/** Apply only the deferral share explicitly referenced by a posted credit note. */
export function adjustInvoiceDeferralsForCreditNote(db, note, reverseEntryFn) {
  const plan = validateInvoiceDeferralCredit(db, note);
  if (!plan.length) return db;
  const noteDate = note.date ?? note.invoice_date ?? today();
  let next = db;
  for (const item of plan) {
    const schedule = read(next, 'account.deferral', item.schedule.id);
    const currency = companyCurrencyRecord(next, schedule.company_id);
    const board_before = structuredClone(schedule.board ?? []);
    const state_before = schedule.state;
    const board = structuredClone(board_before);
    const adjustmentMoveIds = [];
    const groupedContributionsBefore = [];

    const groupedMoves = (next.records['account.move'] ?? []).filter((m) =>
      m.is_deferred_grouped &&
      !m.reversed_entry_id &&
      m.state === 'posted' &&
      (m.deferred_contributions ?? []).some((c) => c.schedule_id === schedule.id)
    );
    const groupedIds = new Set(groupedMoves.map((m) => m.id));

    for (const sourceMove of groupedMoves) {
      groupedContributionsBefore.push({
        move_id: sourceMove.id,
        deferred_contributions: structuredClone(sourceMove.deferred_contributions),
      });
      if (sourceMove.reversal_move_id) {
        const revMove = read(next, 'account.move', sourceMove.reversal_move_id);
        if (revMove) {
          groupedContributionsBefore.push({
            move_id: revMove.id,
            deferred_contributions: structuredClone(revMove.deferred_contributions),
          });
        }
      }
      const contribution = (sourceMove.deferred_contributions ?? []).find((entry) => entry.schedule_id === schedule.id);
      if (!contribution || !Array.isArray(contribution.board_lines)) throw new Error('Cannot safely adjust a grouped deferral contribution');
      const contributedAmount = roundCurrency(contribution.board_lines.reduce((sum, line) => sum + (Number(line.amount) || 0), 0), currency);
      const remainingInvoiceAmount = roundCurrency(item.originalAmount - item.previousAmount, currency);
      const share = item.full || remainingInvoiceAmount <= 0 ? 1 : item.currentAmount / remainingInvoiceAmount;
      const adjustmentAmount = roundCurrency(contributedAmount * share, currency);
      if (!adjustmentAmount) continue;
      const sourceMoveDate = sourceMove.invoice_date ?? sourceMove.date ?? noteDate;
      const sourceCorrectionDate = noteDate < sourceMoveDate ? sourceMoveDate : noteDate;
      const sourceCorrection = postRecognitionCorrection(next, schedule, sourceMove, adjustmentAmount, sourceCorrectionDate, note, true);
      next = sourceCorrection.db;
      if (sourceCorrection.id) adjustmentMoveIds.push(sourceCorrection.id);

      const reversal = read(next, 'account.move', sourceMove.reversal_move_id);
      const reversedContribution = reversal && (reversal.deferred_contributions ?? []).find((entry) => entry.schedule_id === schedule.id);
      if (!reversal || reversal.state !== 'posted' || !reversedContribution) {
        throw new Error('The grouped deferral entry is missing its posted reversal contribution');
      }
      const reversedAmount = roundCurrency(reversedContribution.board_lines.reduce((sum, line) => sum + (Number(line.amount) || 0), 0), currency);
      if (roundCurrency(reversedAmount * share, currency) !== adjustmentAmount) {
        throw new Error('The grouped deferral reversal no longer matches its source contribution');
      }
      const revMoveDate = reversal.invoice_date ?? reversal.date ?? noteDate;
      const revCorrectionDate = noteDate < revMoveDate ? revMoveDate : noteDate;
      const revCorrection = postRecognitionCorrection(next, schedule, reversal, adjustmentAmount, revCorrectionDate, note, false);
      next = revCorrection.db;
      if (revCorrection.id) adjustmentMoveIds.push(revCorrection.id);
    }

    const reversed = effectivelyReversedEntryIds(next.records['account.move'] ?? []);
    const reversalByDate = new Map();
    const eligiblePosted = [];
    const scheduledReversalsBefore = [];

    for (let index = 0; index < board.length; index++) {
      const line = board[index];
      if (!line.posted || !line.move_id || groupedIds.has(line.move_id)) continue;
      const isReversed = reversed.has(line.move_id) || (line.reversal_move_id && !reversed.has(line.reversal_move_id));
      if (isReversed) continue;
      const recognitionMove = read(next, 'account.move', line.move_id);
      if (!recognitionMove || recognitionMove.state !== 'posted' || recognitionMove.move_type !== 'entry') {
        throw new Error('A posted deferral board line is missing its recognition entry');
      }
      const outstanding = adjustedRecognitionOutstanding(line, currency);
      if (outstanding <= 0) continue;
      eligiblePosted.push({ line, index, recognitionMove, outstanding });
    }

    if (item.full && item.previousAmount === 0) {
      if (typeof reverseEntryFn !== 'function') throw new Error('A reversal service is required to reverse posted recognition entries');
      for (const { line, recognitionMove, outstanding } of eligiblePosted) {
        const moveDate = recognitionMove.invoice_date ?? recognitionMove.date ?? noteDate;
        const date = noteDate < moveDate ? moveDate : noteDate;
        const cancelledReversals = cancelScheduledReversals(next, recognitionMove);
        next = cancelledReversals.db;
        scheduledReversalsBefore.push(...cancelledReversals.scheduled_reversals_before);
        const hasExistingReversal = (next.records['account.move'] ?? []).some((m) => m.state !== 'cancel' && m.reversed_entry_id === recognitionMove.id);
        const { db: stepDb, id: reversalId } = !hasExistingReversal
          ? reverseEntryFn(next, recognitionMove, { date, reason: `Credit note ${note.name}` })
          : postRecognitionCorrection(next, schedule, recognitionMove, outstanding, date, note, true);
        next = stepDb;
        if (reversalId) {
          reversalByDate.set(line.date, reversalId);
          adjustmentMoveIds.push(reversalId);
        }
      }
    } else if (eligiblePosted.length) {
      const totalOutstanding = roundCurrency(eligiblePosted.reduce((sum, lineItem) => sum + lineItem.outstanding, 0), currency);
      const remainingInvoiceAmount = roundCurrency(item.originalAmount - item.previousAmount, currency);
      const targetTotalCorrection = item.full || remainingInvoiceAmount <= 0
        ? totalOutstanding
        : roundCurrency(totalOutstanding * (item.currentAmount / remainingInvoiceAmount), currency);
      if (targetTotalCorrection > 0) {
        const allocatedAmounts = allocateCents(targetTotalCorrection, eligiblePosted.map((lineItem) => lineItem.outstanding), currency);
        for (let i = 0; i < eligiblePosted.length; i++) {
          const adjustmentAmount = allocatedAmounts[i];
          if (!adjustmentAmount) continue;
          const { line, recognitionMove } = eligiblePosted[i];
          const moveDate = recognitionMove.invoice_date ?? recognitionMove.date ?? noteDate;
          const date = noteDate < moveDate ? moveDate : noteDate;
          const correction = postRecognitionCorrection(next, schedule, recognitionMove, adjustmentAmount, date, note, true);
          next = correction.db;
          if (correction.id) adjustmentMoveIds.push(correction.id);
          line.credit_adjusted_amount = roundCurrency((Number(line.credit_adjusted_amount) || 0) + adjustmentAmount, currency);
          line.credit_adjustment_move_ids = [...(line.credit_adjustment_move_ids ?? []), correction.id];
        }
      }
    }

    const activeUnposted = board.filter((line) => !line.posted && !line.cancelled);
    const updatedBoard = board.map((line) => {
      let updatedLine = reversalByDate.has(line.date)
        ? { ...line, reversal_move_id: reversalByDate.get(line.date), credit_adjusted_amount: roundCurrency(Math.abs(Number(line.amount) || 0), currency) }
        : line;
      if (updatedLine.reversal_move_id && reversed.has(updatedLine.reversal_move_id)) {
        updatedLine = { ...updatedLine, reversal_move_id: null };
      }
      if (reversed.has(line.move_id) && !updatedLine.reversal_move_id) {
        const revMove = (next.records['account.move'] ?? []).find((m) => m.state === 'posted' && m.reversed_entry_id === line.move_id && !reversed.has(m.id));
        if (revMove) updatedLine = { ...updatedLine, reversal_move_id: revMove.id };
      }
      if (updatedLine.posted || updatedLine.cancelled) return updatedLine;
      if (item.full) return { ...updatedLine, amount: 0, cancelled: true };
      return updatedLine;
    });

    if (!item.full && activeUnposted.length) {
      const currentTotal = roundCurrency(activeUnposted.reduce((sum, line) => sum + (Number(line.amount) || 0), 0), currency);
      const previousRemainingShare = 1 - item.previousShare;
      const nextRemainingShare = 1 - item.cumulativeShare;
      const target = previousRemainingShare > 0
        ? roundCurrency(currentTotal * nextRemainingShare / previousRemainingShare, currency)
        : 0;
      const amounts = allocateCents(target, activeUnposted.map((line) => Number(line.amount) || 0), currency);
      const byDate = new Map(activeUnposted.map((line, index) => [line.date, amounts[index]]));
      for (let index = 0; index < updatedBoard.length; index++) {
        const line = updatedBoard[index];
        if (line.posted || line.cancelled) continue;
        const amount = byDate.get(line.date);
        if (amount == null) throw new Error('The deferred recognition board has duplicate or missing period dates');
        updatedBoard[index] = amount ? { ...line, amount } : { ...line, amount: 0, cancelled: true };
      }
    }

    const { computationMethod: method } = deferredSettings(next, schedule.company_id, schedule.kind);
    for (const sourceMove of groupedMoves) {
      const newBoardLines = groupedBoardLines({ ...schedule, board: updatedBoard }, sourceMove.deferral_date, method, currency);
      const updateContributions = (contributions) => {
        if (!newBoardLines.length) {
          return contributions.filter((c) => c.schedule_id !== schedule.id);
        }
        return contributions.map((c) => (c.schedule_id === schedule.id ? { ...c, board_lines: newBoardLines } : c));
      };
      next = write(next, 'account.move', sourceMove.id, {
        deferred_contributions: updateContributions(sourceMove.deferred_contributions ?? []),
      });
      if (sourceMove.reversal_move_id) {
        const rev = read(next, 'account.move', sourceMove.reversal_move_id);
        if (rev) {
          next = write(next, 'account.move', rev.id, {
            deferred_contributions: updateContributions(rev.deferred_contributions ?? []),
          });
        }
      }
    }

    const state = item.full ? 'cancel' : updatedBoard.every((line) => line.posted || line.cancelled) ? 'done' : 'running';
    const credit_adjustments = [
      ...(schedule.credit_adjustments ?? []),
      {
        note_id: note.id,
        board_before,
        state_before,
        move_ids: adjustmentMoveIds,
        scheduled_reversals_before: scheduledReversalsBefore,
        grouped_contributions_before: groupedContributionsBefore,
      },
    ];
    next = write(next, 'account.deferral', schedule.id, { board: updatedBoard, state, credit_adjustments });
  }
  return next;
}

/** Revert deferral schedule and move adjustments when a linked credit note leaves posted. */
export function revertInvoiceDeferralCreditAdjustment(db, note, reverseEntryFn, autoPostMoveFn) {
  if (!isRefund(note)) return db;
  const schedules = (db.records['account.deferral'] ?? []).filter((s) =>
    (s.credit_adjustments ?? []).some((adj) => adj.note_id === note.id)
  );
  if (!schedules.length) return db;
  let next = db;
  for (const schedule of schedules) {
    const adjustments = schedule.credit_adjustments ?? [];
    const adjustment = adjustments.find((adj) => adj.note_id === note.id);
    if (!adjustment) continue;
    // The board snapshot predates later credit notes, so only the latest adjustment can be undone.
    if (adjustments[adjustments.length - 1] !== adjustment) throw new Error('Reset the later credit notes for this deferred invoice line first');
    if (typeof reverseEntryFn !== 'function') throw new Error('A reversal service is required to reverse deferral corrections');
    const effectivelyReversed = effectivelyReversedEntryIds(next.records['account.move'] ?? []);
    for (const moveId of adjustment.move_ids ?? []) {
      const move = read(next, 'account.move', moveId);
      if (!move || move.state !== 'posted') continue;
      if (effectivelyReversed.has(move.id)) continue;
      next = reverseEntryFn(next, move, { date: correctionDate(next, move), reason: `Reset of credit note ${note.name}` }).db;
    }
    const beforeByDate = new Map((adjustment.board_before ?? []).map((l) => [l.date, l]));
    const postedSinceAdjustment = (schedule.board ?? []).filter((l) => {
      if (!l.posted || !l.move_id) return false;
      const before = beforeByDate.get(l.date);
      return !before || !before.posted;
    });
    for (const line of postedSinceAdjustment) {
      const move = read(next, 'account.move', line.move_id);
      if (!move || move.state !== 'posted') continue;
      const currentReversed = effectivelyReversedEntryIds(next.records['account.move'] ?? []);
      if (currentReversed.has(move.id)) continue;
      next = reverseEntryFn(next, move, { date: correctionDate(next, move), reason: `Reset of credit note ${note.name}` }).db;
    }
    for (const entry of adjustment.grouped_contributions_before ?? []) {
      const m = read(next, 'account.move', entry.move_id);
      if (m) {
        next = write(next, 'account.move', m.id, { deferred_contributions: entry.deferred_contributions });
      }
    }
    next = restoreScheduledReversals(next, adjustment.scheduled_reversals_before, autoPostMoveFn);
    const remainingAdjustments = (schedule.credit_adjustments ?? []).filter((adj) => adj.note_id !== note.id);
    next = write(next, 'account.deferral', schedule.id, {
      board: adjustment.board_before,
      state: adjustment.state_before,
      credit_adjustments: remainingAdjustments,
    });
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
        journal: move.journal_id, company: move.company_id, date: correctionDate(db, move),
        ref: `Grouped deferral adjustment ${move.name}`,
        deferred_entry_type: move.deferred_entry_type ?? deferredEntryTypeForKind(move.deferral_kind),
        lines: lines.map((line) => reverse ? { ...line, debit: line.credit, credit: line.debit } : line),
        archivedOriginIds: [move.id],
      });
      next = postAnalytic(correction.db, correction.id);
    }
  }
  for (const schedule of schedules) {
    const board = [];
    for (const line of schedule.board ?? []) {
      if (!line.move_id || line.reversal_move_id) { board.push(line); continue; }
      const original = read(next, 'account.move', line.move_id);
      const reversal = postEntry(next, { journal: original.journal_id, company: schedule.company_id, date: correctionDate(db, original), ref: `Reversal of ${original.name}`, deferred_entry_type: original.deferred_entry_type ?? deferredEntryTypeForKind(schedule.kind), archivedOriginIds: [original.id], lines: original.line_ids.map((l) => ({ account: l.account_id, debit: l.credit, credit: l.debit, partner_id: l.partner_id, analytic_distribution: l.analytic_distribution })) });
      next = postAnalytic(write(reversal.db, 'account.move', reversal.id, { reversed_entry_id: original.id }), reversal.id);
      board.push({ ...line, reversal_move_id: reversal.id });
    }
    next = write(next, 'account.deferral', schedule.id, { board, state: 'cancel' });
  }
  return next;
}

/** One line per period (`month` or `year`), dated at period end from `startDate`. */
export function deferralBoard(amount, startDate, months, currency = null, periodicity = 'month') {
  const [y, m] = startDate.split('-').map(Number);
  const shares = allocateCents(amount, Array(months).fill(1), currency);
  return Array.from({ length: months }, (_, i) => ({
    date: periodicity === 'year'
      ? `${y + i}-12-31`
      : monthEnd(y + Math.floor((m - 1 + i) / 12), ((m - 1 + i) % 12) + 1),
    amount: shares[i],
  }));
}

/** Build the recognition board and start the schedule. */
export function computeBoard(db, d) {
  if (!(Number(d.amount) > 0)) throw new Error('The amount must be positive');
  if (!d.end_date && (!Number.isInteger(Number(d.months)) || Number(d.months) < 1)) throw new Error('The number of months must be at least 1');
  if (!d.start_date) throw new Error('Set a start date');
  const settings = deferredSettings(db, d.company_id ?? 1, d.kind);
  const end = d.end_date || deferralBoard(d.amount, d.start_date, Number(d.months), null, settings.periodicity).at(-1).date;
  const board = datedBoard(d.amount, d.start_date, end, settings.computationMethod, companyCurrencyRecord(db, d.company_id), settings.periodicity);
  return write(db, 'account.deferral', d.id, { board, months: board.length, state: 'running' });
}

/** Post every unposted board line dated on or before `upTo`; the schedule is done once all are posted. */
export function postDueEntries(db, d, upTo = today()) {
  d = read(db, 'account.deferral', d.id) ?? d;
  if (deferredSettings(db, d.company_id, d.kind).isGrouped) {
    throw new Error('Individual posting is unavailable for grouped deferrals');
  }
  if (d.state === 'cancel') return db;
  const { deferred, recognition } = scheduleAccounts(db, d);
  const journalSpec = deferredJournalSpec(db, d.company_id, d.kind);
  const entryType = deferredEntryTypeForKind(d.kind);
  const debit = d.kind === 'expense' ? recognition : deferred;
  const credit = d.kind === 'expense' ? deferred : recognition;
  const { db: next, board } = (d.board ?? []).reduce((acc, l) => {
    if (l.posted || l.cancelled || l.date > upTo) return { ...acc, board: [...acc.board, l] };
    if (!l.amount) return { ...acc, board: [...acc.board, { ...l, posted: true, move_id: null }] };
    const absAmount = Math.abs(l.amount);
    const positive = l.amount >= 0;
    const lineDebit = positive ? debit : credit;
    const lineCredit = positive ? credit : debit;
    const { db: booked, id } = postEntry(acc.db, {
      ...journalSpec, company: d.company_id, date: l.date, ref: `${d.name} ${l.date.slice(0, 7)}`,
      deferred_entry_type: entryType,
      lines: [
        { account: lineDebit, debit: absAmount, partner_id: d.partner_id ?? undefined, ...(lineDebit === recognition ? { analytic_distribution: d.analytic_distribution } : {}) },
        { account: lineCredit, credit: absAmount, partner_id: d.partner_id ?? undefined, ...(lineCredit === recognition ? { analytic_distribution: d.analytic_distribution } : {}) },
      ],
    });
    return { db: postAnalytic(booked, id), board: [...acc.board, { ...l, posted: true, move_id: id }] };
  }, { db, board: [] });
  return write(next, 'account.deferral', d.id, { board, state: board.every((l) => l.posted || l.cancelled) ? 'done' : 'running' });
}

/**
 * Post ONE grouped entry per company and kind for a chosen period end date,
 * moving recognized-to-date amounts from the deferred account to each line's
 * original recognition account (carrying analytic distributions), plus its exact
 * next-day reversal.
 */
export function generateGroupedEntries(db, { date, company_id, kind } = {}) {
  const companyId = company_id ?? db.settings?.current_company_id ?? 1;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) {
    throw new Error('Set a valid period end date');
  }

  const currency = companyCurrencyRecord(db, companyId);
  const kindsToProcess = kind ? [kind] : ['revenue', 'expense'];
  for (const k of kindsToProcess) {
    if (!deferredSettings(db, companyId, k).isGrouped) {
      throw new Error('Grouped deferral generation requires a company configured for grouped posting');
    }
  }
  let currentDb = db;

  for (const k of kindsToProcess) {
    const settings = deferredSettings(currentDb, companyId, k);
    const method = settings.computationMethod;
    const entryType = deferredEntryTypeForKind(k);
    const journalSpec = deferredJournalSpec(currentDb, companyId, k);

    const existingMoves = (currentDb.records['account.move'] ?? []).filter((m) =>
      m.state === 'posted' &&
      m.is_deferred_grouped &&
      !m.reversed_entry_id &&
      m.deferral_kind === k &&
      m.deferral_date === date &&
      (m.company_id ?? 1) === companyId
    );
    const alreadyBySchedule = new Map();
    for (const m of existingMoves) {
      for (const c of m.deferred_contributions ?? []) {
        let schedMap = alreadyBySchedule.get(c.schedule_id);
        if (!schedMap) {
          schedMap = new Map();
          alreadyBySchedule.set(c.schedule_id, schedMap);
        }
        for (const bl of c.board_lines ?? []) {
          schedMap.set(bl.index, roundCurrency((schedMap.get(bl.index) ?? 0) + (Number(bl.amount) || 0), currency));
        }
      }
    }

    const schedules = (currentDb.records['account.deferral'] ?? []).filter((d) =>
      d.state !== 'cancel' &&
      (d.company_id ?? 1) === companyId &&
      d.kind === k &&
      (!d.source_move_id || read(currentDb, 'account.move', d.source_move_id)?.state === 'posted')
    );

    const recognizedItems = [];
    for (const s of schedules) {
      const targetByIndex = new Map();
      (s.board ?? []).forEach((line, index) => {
        const target = line.posted || line.cancelled ? 0 : recognitionTargetThroughDate(s, index, date, method, currency);
        if (target !== 0) targetByIndex.set(index, { date: line.date, amount: target });
      });
      const alreadyMap = alreadyBySchedule.get(s.id) ?? new Map();
      const allIndices = new Set([...targetByIndex.keys(), ...alreadyMap.keys()]);
      const deltaBoardLines = [];
      for (const index of [...allIndices].sort((a, b) => a - b)) {
        const targetEntry = targetByIndex.get(index);
        const deltaAmt = roundCurrency((targetEntry?.amount ?? 0) - (alreadyMap.get(index) ?? 0), currency);
        if (deltaAmt !== 0) {
          deltaBoardLines.push({
            index,
            date: targetEntry?.date ?? s.board?.[index]?.date ?? date,
            amount: deltaAmt,
          });
        }
      }
      const deltaTotal = roundCurrency(deltaBoardLines.reduce((sum, bl) => sum + bl.amount, 0), currency);
      if (deltaTotal !== 0) {
        const { deferred: deferredAcc, recognition: recognitionAcc } = scheduleAccounts(currentDb, s);
        recognizedItems.push({
          schedule: s,
          boardLines: deltaBoardLines,
          amount: deltaTotal,
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
    const deferredBuckets = new Map();
    for (const item of recognizedItems) {
      const sign = item.amount >= 0 ? 'pos' : 'neg';
      const key = `${item.deferred_account_id}:${sign}`;
      const prev = deferredBuckets.get(key) ?? {
        key,
        deferred_account_id: item.deferred_account_id,
        positive: item.amount >= 0,
        absTotal: 0,
      };
      prev.absTotal = roundCurrency(prev.absTotal + Math.abs(item.amount), currency);
      deferredBuckets.set(key, prev);
    }

    const bucketList = [...deferredBuckets.values()];
    const bucketKeys = bucketList.map((b) => b.key);

    const lines = [
      ...bucketList.map((bucket) => {
        const debitSide = isRev ? bucket.positive : !bucket.positive;
        return {
          account_id: bucket.deferred_account_id,
          debit: debitSide ? bucket.absTotal : 0,
          credit: debitSide ? 0 : bucket.absTotal,
          name: `Deferred ${isRev ? 'Revenues' : 'Expenses'} ${date}`,
        };
      }),
      ...recognizedItems.map((item) => {
        const positive = item.amount >= 0;
        const absAmt = Math.abs(item.amount);
        const creditSide = isRev ? positive : !positive;
        return {
          account_id: item.recognition_account_id,
          debit: creditSide ? 0 : absAmt,
          credit: creditSide ? absAmt : 0,
          analytic_distribution: item.analytic_distribution,
          partner_id: item.partner_id ?? null,
          name: item.name,
        };
      }),
    ];

    const ref = `Deferred ${isRev ? 'Revenues' : 'Expenses'}: ${date}`;
    const entryRes = postEntry(currentDb, {
      ...journalSpec,
      date,
      ref,
      deferred_entry_type: entryType,
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
      ...journalSpec,
      date: revDate,
      ref: revRef,
      deferred_entry_type: entryType,
      lines: revLines,
      company: companyId,
    });
    currentDb = postAnalytic(revRes.db, revRes.id);

    const contributions = recognizedItems.map((item, index) => ({
      schedule_id: item.schedule.id,
      board_lines: item.boardLines,
      deferred_line_index: bucketKeys.indexOf(`${item.deferred_account_id}:${item.amount >= 0 ? 'pos' : 'neg'}`),
      recognition_line_index: bucketList.length + index,
    }));
    currentDb = write(currentDb, 'account.move', entryRes.id, {
      deferred_contributions: contributions,
      reversal_move_id: revRes.id,
      deferral_date: date,
      deferral_kind: k,
      deferred_entry_type: entryType,
      is_deferred_grouped: true,
    });
    currentDb = write(currentDb, 'account.move', revRes.id, {
      deferred_contributions: contributions,
      reversed_entry_id: entryRes.id,
      deferral_date: revDate,
      deferral_kind: k,
      deferred_entry_type: entryType,
      is_deferred_grouped: true,
    });
  }

  return currentDb;
}

/** Generate all due schedules of one company for a chosen period end. */
export function postCompanyDeferrals(db, companyId, upTo = today()) {
  let current = db;
  for (const k of ['revenue', 'expense']) {
    const settings = deferredSettings(current, companyId, k);
    if (settings.isGrouped) {
      current = generateGroupedEntries(current, { company_id: companyId, kind: k, date: upTo });
    } else {
      current = (current.records['account.deferral'] ?? [])
        .filter((d) => d.state === 'running' && (d.company_id ?? 1) === companyId && d.kind === k)
        .reduce((next, schedule) => postDueEntries(next, schedule, upTo), current);
    }
  }
  return current;
}

/**
 * A schedule cancels only once its own posted recognition is reversed. With `grouped`, open grouped entries also
 * block (manual cancel); resetting the source document instead corrects grouped contributions with adjustment entries.
 */
function cancelDeferralError(db, schedule, { grouped = false } = {}) {
  const moves = db.records['account.move'] ?? [];
  // A board entry reversed through the journal-entry action counts as reversed (Qodo 48). A grouped entry's own
  // next-day reversal is part of its period snapshot, so grouped recognition still blocks until it is handled.
  const reversed = effectivelyReversedEntryIds(moves);
  const openGrouped = grouped && moves.some((move) => move.is_deferred_grouped && !move.reversed_entry_id && move.state === 'posted' && (move.deferred_contributions ?? []).some((c) => c.schedule_id === schedule.id));
  const currency = companyCurrencyRecord(db, schedule.company_id);
  const unreversedBoard = (schedule.board ?? []).some((line) => {
    if (!line.move_id) return false;
    const isReversed = reversed.has(line.move_id) || (line.reversal_move_id && !reversed.has(line.reversal_move_id));
    if (isReversed) return false;
    return adjustedRecognitionOutstanding(line, currency) > 0;
  });
  return openGrouped || unreversedBoard ? 'Reverse the recognition entries before cancelling this deferral' : null;
}

export const deferredModels = {
  'account.deferral': {
    label: 'Deferrals',
    // Enforced on every write path, not only the Cancel button (Qodo 12).
    guard: (db, before, after) => (after.state === 'cancel' && before?.state !== 'cancel' ? cancelDeferralError(db, after) : null),
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
      source_line_id: { type: 'char', label: 'Source Document', readonly: true, hidden: true },
      deferred_account_id: { type: 'many2one', relation: 'account.account', label: 'Deferred Account' },
      recognition_account_id: { type: 'many2one', relation: 'account.account', label: 'Recognition Account' },
      company_id: { type: 'many2one', relation: 'res.company', label: 'Company' },
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Partner' },
      analytic_distribution: { type: 'distribution', label: 'Analytic Distribution' },
      state: { type: 'selection', label: 'Status', tracking: true, options: [['draft', 'Draft'], ['running', 'Running'], ['done', 'Done'], ['cancel', 'Cancelled']] },
      credit_adjustments: { type: 'json', readonly: true, hidden: true },
      board: {
        type: 'one2many',
        label: 'Recognition Board',
        fields: {
          date: { type: 'date', label: 'Date' },
          amount: { type: 'monetary', label: 'Amount' },
          posted: { type: 'boolean', label: 'Posted' },
          cancelled: { type: 'boolean', label: 'Cancelled' },
          move_id: { type: 'many2one', relation: 'account.move', label: 'Entry' },
          reversal_move_id: { type: 'many2one', relation: 'account.move', label: 'Reversal Entry' },
          credit_adjusted_amount: { type: 'monetary', readonly: true, hidden: true },
          credit_adjustment_move_ids: { type: 'json', readonly: true, hidden: true },
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
        { label: 'Cancel', when: (r) => ['draft', 'running'].includes(r.state), run: (db, r) => {
          const error = cancelDeferralError(db, read(db, 'account.deferral', r.id), { grouped: true });
          if (error) throw new Error(error);
          return { db: write(db, 'account.deferral', r.id, { state: 'cancel' }) };
        } },
      ],
      title: 'name',
      groups: [['kind', 'partner_id', 'company_id', 'amount', 'analytic_distribution'], ['start_date', 'end_date', 'months']],
      tabs: [{ label: 'Recognition Board', fields: ['board'] }],
      chatter: true,
    },
  },
};
