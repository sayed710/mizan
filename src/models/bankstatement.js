// Bank statements (account.bank.statement) tracking opening, ending, and computed balances across statement lines.
import { create, read, search, unlink, write } from '../orm.js';
import { isLiquidityJournal, paymentJournal, statementCompanyAmount } from './ledger.js';
import { bookToAccount, untouchedBankEntry } from './bank.js';
import { monthFilters, today } from './common.js';
import { currentCompany } from './company.js';
import { t } from '../i18n.js';
import { companyCurrencyRecord, findCompanyCurrencyRecord, formatCurrency, roundCurrency } from '../money.js';

const statementLinesCache = new WeakMap();

/** Canonical display and running-balance order of bank statement lines: date, then sequence, then id. */
export const statementLineOrder = (a, b) =>
  String(a.date ?? '').localeCompare(String(b.date ?? '')) || (a.sequence ?? 10) - (b.sequence ?? 10) || (a.id ?? 0) - (b.id ?? 0);

/** Whether a statement line is reconciled or matched/booked beyond its initial suspense entry. */
export const isStatementLineLocked = (line) => Boolean(
  line && (
    line.state === 'reconciled'
    || line.move_id
    || (line.allocations ?? []).length > 0
    || line.payment_move_id
    || line.writeoff_move_id
  ),
);

export function linesByStatement(db) {
  if (!db) return new Map();
  let map = statementLinesCache.get(db);
  if (map) return map;
  map = new Map();
  const lines = search(db, 'account.bank.statement.line');
  for (const l of lines) {
    if (!l.statement_id) continue;
    let list = map.get(l.statement_id);
    if (!list) {
      list = [];
      map.set(l.statement_id, list);
    }
    list.push(l);
  }
  statementLinesCache.set(db, map);
  return map;
}

/** Whether `statementOrId` currently owns any reconciled or booked line in `db`. */
export function statementHasReconciledLines(db, statementOrId) {
  const statementId = typeof statementOrId === 'object' ? statementOrId?.id : statementOrId;
  if (!db || !statementId) return false;
  // Archived lines still count: archiving must not unlock the statement.
  return (db.records?.['account.bank.statement.line'] ?? []).some((l) => l.statement_id === statementId && isStatementLineLocked(l));
}

/** Currency record of `statement` from its journal, falling back to company currency. */
export function statementCurrency(db, statement) {
  if (!db) return null;
  const journal = statement?.journal_id ? read(db, 'account.journal', statement.journal_id) : null;
  const companyId = statement?.company_id ?? journal?.company_id ?? currentCompany(db);
  const currencyId = journal?.currency_id ?? read(db, 'res.company', companyId)?.currency_id;
  return (currencyId ? read(db, 'res.currency', currencyId) : null) ?? findCompanyCurrencyRecord(db, companyId);
}

export function roundStatementAmount(db, statement, amount) {
  if (amount == null) return 0;
  const num = Number(amount) || 0;
  if (!db || !statement?.journal_id) return num;
  const currency = statementCurrency(db, statement);
  return currency ? roundCurrency(num, currency) : num;
}

const statementLines = (r, db) => (Array.isArray(r?.line_ids) ? r.line_ids : (linesByStatement(db).get(r?.id) ?? []));

/** Computed ending balance: balance_start + sum of its lines' amounts. */
export function computeBalanceEnd(r, db) {
  const lines = statementLines(r, db);
  const linesSum = lines.reduce((acc, l) => acc + (Number(l?.amount) || 0), 0);
  const total = (Number(r?.balance_start) || 0) + linesSum;
  return roundStatementAmount(db, r, total);
}

/** Computed completeness: has lines and balance_end equals balance_end_real at the journal currency rounding. */
export function computeIsComplete(r, db) {
  const lines = statementLines(r, db);
  if (!lines.length) return false;
  const balanceEnd = computeBalanceEnd(r, db);
  const balanceEndReal = roundStatementAmount(db, r, r?.balance_end_real);
  return balanceEnd === balanceEndReal;
}

const statementIsComplete = (r, db) => (typeof r?.is_complete === 'boolean' ? r.is_complete : (db ? computeIsComplete(r, db) : false));
const statementIsValid = (r, db) => (typeof r?.is_valid === 'boolean' ? r.is_valid : (db ? computeIsValid(r, db) : true));

/** List row decoration matching Odoo 20 `view_bank_statement_tree`: danger when invalid or (journal-linked and incomplete), muted without a journal. */
export function statementListDecoration(r, db = null) {
  const isComplete = statementIsComplete(r, db);
  const isValid = statementIsValid(r, db);
  if ((r?.journal_id && !isComplete) || !isValid) return 'danger';
  if (!r?.journal_id) return 'muted';
  return null;
}

let inComputeIsValid = false;
/** Computed validity: balance_start equals previous statement's balance_end_real in same journal, by date then id; true for first statement. */
export function computeIsValid(r, db) {
  if (!db || !r?.journal_id || inComputeIsValid) return true;
  inComputeIsValid = true;
  try {
    const rawStatements = search(db, 'account.bank.statement')
      .filter((s) => s.journal_id === r.journal_id)
      .sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')) || a.id - b.id);
    let prev = null;
    if (r.id) {
      const withoutSelf = rawStatements.filter((s) => s.id !== r.id);
      const combined = [...withoutSelf, r].sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')) || (a.id ?? 0) - (b.id ?? 0));
      const idx = combined.findIndex((s) => s.id === r.id);
      prev = idx > 0 ? combined[idx - 1] : null;
    } else {
      const date = String(r.date ?? '');
      const preceding = date ? rawStatements.filter((s) => String(s.date ?? '') <= date) : rawStatements;
      prev = preceding.at(-1) ?? null;
    }
    if (!prev) return true;
    return roundStatementAmount(db, r, r.balance_start) === roundStatementAmount(db, prev, prev.balance_end_real);
  } finally {
    inComputeIsValid = false;
  }
}

/** Compute inline one2many rows for `line_ids` on `account.bank.statement`. */
export function computeStatementLines(r, db) {
  if (!r?.id || !db) return Array.isArray(r?.line_ids) ? r.line_ids : [];
  return [...(linesByStatement(db).get(r.id) ?? [])]
    .sort(statementLineOrder)
    .map((l) => ({
      id: l.id,
      sequence: l.sequence ?? 10,
      date: l.date ?? '',
      payment_ref: l.payment_ref ?? '',
      partner_id: l.partner_id ?? null,
      amount: l.amount ?? 0,
      ref: l.ref ?? '',
      state: l.state ?? 'to_check',
    }));
}

const formatStatementAmount = (db, r, amount) => {
  const currency = statementCurrency(db, r);
  return currency ? formatCurrency(amount, currency) : String(amount ?? 0);
};

/** Problem summary matching Odoo 20 `_compute_problem_description`, or null when valid and complete. */
export function computeProblemDescription(r, db) {
  if (!r || !db) return null;
  if (!statementIsValid(r, db)) {
    return t('Initial balance ({amount}) does not match previous statement', {
      amount: formatStatementAmount(db, r, roundStatementAmount(db, r, r.balance_start)),
    });
  }
  if (!statementIsComplete(r, db)) {
    return t('Incorrect ending balance, expected {amount}', {
      amount: formatStatementAmount(db, r, computeBalanceEnd(r, db)),
    });
  }
  return null;
}

/** Form warning banner for invalid opening balance continuity or running balance mismatch against `balance_end_real`. */
export function statementWarning(r, db) {
  if (!r || !db) return null;
  const warnings = [];
  if (!computeIsValid(r, db)) {
    warnings.push(t('Invalid statement: starting balance does not match the previous statement ending balance.'));
  }
  const balanceEnd = computeBalanceEnd(r, db);
  const balanceEndReal = roundStatementAmount(db, r, r.balance_end_real);
  if (balanceEnd !== balanceEndReal) {
    warnings.push(t('Running balance ({balanceEnd}) does not match the ending balance ({balanceEndReal}).', {
      balanceEnd: formatStatementAmount(db, r, balanceEnd),
      balanceEndReal: formatStatementAmount(db, r, balanceEndReal),
    }));
  }
  return warnings.length ? warnings.join(' ') : null;
}

const lineEditableKey = (l) => JSON.stringify({
  id: l?.id ?? null,
  date: l?.date ?? '',
  payment_ref: l?.payment_ref ?? '',
  partner_id: l?.partner_id || null,
  amount: Number(l?.amount) || 0,
  ref: l?.ref ?? '',
  sequence: l?.sequence ?? 10,
});

function statementLinesError(db, statement, lines, before) {
  if (!Array.isArray(lines)) return 'Invalid statement lines';
  const existing = before?.id
    ? (db.records?.['account.bank.statement.line'] ?? []).filter((l) => l.statement_id === before.id && l.active !== false)
    : [];
  const existingSnapshot = [...existing].sort(statementLineOrder).map(lineEditableKey);
  const submittedSnapshot = lines.map((l, idx) => lineEditableKey({ ...l, sequence: l?.sequence ?? (idx + 1) * 10 }));
  const unchanged = existingSnapshot.length === submittedSnapshot.length
    && existingSnapshot.every((row, idx) => row === submittedSnapshot[idx]);

  if (before?.state === 'closed' || statement.state === 'closed') {
    if (!unchanged) return 'Cannot change lines linked to a closed statement';
    return null;
  }
  if (before && statementHasReconciledLines(db, before.id) && !unchanged) {
    return 'Lines of a statement with reconciled lines cannot be edited or deleted';
  }

  const company = statement.company_id ?? read(db, 'account.journal', statement.journal_id)?.company_id ?? 1;
  const existingIds = new Set(existing.map((l) => l.id));
  const seenIds = new Set();
  for (const line of lines) {
    if (!line || typeof line !== 'object' || Array.isArray(line)) return 'Invalid statement line';
    if (line.id != null && line.id !== '' && line.id !== false) {
      if (!Number.isInteger(line.id) || line.id < 1 || !existingIds.has(line.id)) {
        return 'Statement line does not belong to this statement';
      }
      if (seenIds.has(line.id)) return 'Duplicate statement line';
      seenIds.add(line.id);
    }
    if (!line.date) return 'Date is required';
    if (typeof line.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(line.date)) return 'Invalid date';
    if (!String(line.payment_ref ?? '').trim()) return 'Label is required';
    if (line.amount == null || line.amount === '') return 'Amount is required';
    const amt = Number(line.amount);
    if (!Number.isFinite(amt)) return 'Invalid amount';
    if (line.partner_id != null && line.partner_id !== '') {
      const partner = read(db, 'res.partner', Number(line.partner_id));
      if (!partner) return 'Partner does not exist';
      if (partner.company_id && partner.company_id !== company) return 'Partner belongs to another company';
    }
  }
  for (const oldLine of existing) {
    if (!seenIds.has(oldLine.id) && isStatementLineLocked(oldLine)) {
      return 'Lines of a statement with reconciled lines cannot be edited or deleted';
    }
  }
  return null;
}

const stripStatementLineIdsField = (db, statementId) => ({
  ...db,
  records: {
    ...db.records,
    'account.bank.statement': (db.records?.['account.bank.statement'] ?? []).map((s) => {
      if (s.id !== statementId || !Object.hasOwn(s, 'line_ids')) return s;
      const { line_ids: _ignored, ...rest } = s;
      return rest;
    }),
  },
});

/** Synchronize `account.bank.statement.line` records after creating or writing `account.bank.statement` with `line_ids`. */
export function syncStatementLines(db, statement, submittedLines, before = null) {
  let next = stripStatementLineIdsField(db, statement.id);
  if (!Array.isArray(submittedLines)) return next;
  const err = statementLinesError(next, statement, submittedLines, before);
  if (err) throw new Error(err);

  const existing = (next.records?.['account.bank.statement.line'] ?? [])
    .filter((l) => l.statement_id === statement.id && l.active !== false);
  const existingById = new Map(existing.map((l) => [l.id, l]));
  const keepIds = new Set(submittedLines.map((l) => l.id).filter(Boolean));
  const removeIds = existing.filter((l) => !keepIds.has(l.id)).map((l) => l.id);
  if (removeIds.length) next = unlink(next, 'account.bank.statement.line', removeIds);

  const journal = read(next, 'account.journal', statement.journal_id);
  const company = statement.company_id ?? journal?.company_id ?? 1;
  const currencyId = journal?.currency_id ?? read(next, 'res.company', company)?.currency_id ?? null;

  for (const [idx, line] of submittedLines.entries()) {
    const payload = {
      date: line.date,
      payment_ref: line.payment_ref,
      partner_id: line.partner_id ? Number(line.partner_id) : null,
      ref: line.ref ?? '',
      amount: Number(line.amount),
      sequence: line.sequence ?? (idx + 1) * 10,
    };
    if (line.id) {
      const prev = existingById.get(line.id);
      const changed = Object.keys(payload).some((k) => (prev?.[k] ?? null) !== (payload[k] ?? null) && String(prev?.[k] ?? '') !== String(payload[k] ?? ''));
      if (changed) next = write(next, 'account.bank.statement.line', line.id, payload);
    } else {
      next = create(next, 'account.bank.statement.line', {
        ...payload,
        statement_id: statement.id,
        journal_id: statement.journal_id,
        company_id: company,
        currency_id: currencyId,
        state: 'to_check',
      }).db;
    }
  }
  return next;
}

function statementGuard(db, before, after, _ctx = null, vals = null) {
  if (before && before.state === 'closed') {
    if (after.state !== 'closed') return 'A closed statement cannot be reopened';
    if (
      before.balance_start !== after.balance_start ||
      before.balance_end_real !== after.balance_end_real ||
      before.journal_id !== after.journal_id ||
      (before.company_id ?? 1) !== (after.company_id ?? 1) ||
      before.date !== after.date
    ) {
      return 'A closed statement cannot be modified';
    }
  }

  if (!after.journal_id) return 'Bank or cash journal is required';
  const journal = read(db, 'account.journal', after.journal_id);
  if (!journal) return 'The journal does not exist';
  if (!isLiquidityJournal(journal)) return 'Choose a bank or cash journal';
  const company = after.company_id ?? journal.company_id ?? 1;
  if (journal.company_id && journal.company_id !== company) return 'The bank journal belongs to another company';

  const lines = linesByStatement(db).get(after.id) ?? [];
  if (lines.some((l) => l.journal_id !== after.journal_id || (l.company_id ?? 1) !== company)) {
    return 'Statement lines must belong to the statement journal and company';
  }

  if (before && lines.some(isStatementLineLocked)) {
    if (before.journal_id !== after.journal_id || (before.company_id ?? 1) !== company) {
      return 'A statement with reconciled lines cannot change its journal or company';
    }
  }

  const hasSubmittedLines = vals ? Object.hasOwn(vals, 'line_ids') : (!before && Array.isArray(after?.line_ids));
  if (hasSubmittedLines) {
    const lineErr = statementLinesError(db, after, vals?.line_ids ?? after.line_ids, before);
    if (lineErr) return lineErr;
  }

  return null;
}

function statementProtectDelete(db, statement, staged = db) {
  if (statement.state === 'closed') return 'A closed statement cannot be deleted';
  if (statementHasReconciledLines(db, statement.id) || statementHasReconciledLines(staged, statement.id)) {
    return 'Cannot delete a statement with reconciled lines';
  }
  const hasBooked = (source) => (source?.records?.['account.bank.statement.line'] ?? []).some(
    (l) => l.statement_id === statement.id && l.bank_move_id && !untouchedBankEntry(source, l),
  );
  if (hasBooked(db) || hasBooked(staged)) {
    return 'Cannot delete a statement with booked lines';
  }
  return null;
}

const CASH_DIFFERENCE_CONTEXT = Symbol('cashDifferenceClose');
const SYNC_CASH_DIFFERENCE_CONTEXT = Symbol('syncCashDifferenceClose');

/** Whether `ctx` comes from an internal `closeStatement` call or a verified server sync close. */
export function isCashDifferenceCloseContext(ctx, lineId = null) {
  return Boolean(ctx && (ctx[CASH_DIFFERENCE_CONTEXT] === true || (lineId != null && ctx[SYNC_CASH_DIFFERENCE_CONTEXT]?.has(lineId))));
}

/**
 * Validate that `line` is a valid closing-generated cash difference line for `statement`
 * without mistaking ordinary lines using the profit/loss accounts for an existing adjustment.
 */
export function validateCashDifferenceLine(db, statement, line) {
  if (!db || !statement || !line || line.statement_id !== statement.id) return { ok: false };
  if (line.active === false) return { ok: false };
  if (!line.counterpart_account_id || !line.amount) return { ok: false };
  const journal = read(db, 'account.journal', line.journal_id);
  if (journal?.type !== 'cash' || statement.journal_id !== journal.id) return { ok: false };
  const expectedAccount = line.amount > 0 ? journal.profit_account_id : journal.loss_account_id;
  if (!expectedAccount || line.counterpart_account_id !== expectedAccount) return { ok: false };
  const otherLines = (db.records?.['account.bank.statement.line'] ?? []).filter(
    (l) => l.statement_id === statement.id && l.id !== line.id && l.active !== false,
  );
  if (otherLines.some((l) => l.is_cash_difference === true)) return { ok: false };
  const otherSum = otherLines.reduce((acc, l) => acc + (Number(l.amount) || 0), 0);
  const expectedDiff = roundStatementAmount(
    db,
    statement,
    Number(statement.balance_end_real || 0) - (Number(statement.balance_start || 0) + otherSum),
  );
  if (expectedDiff === 0 || roundStatementAmount(db, statement, line.amount) !== expectedDiff) {
    return { ok: false };
  }
  return { ok: true, journal, expectedAccount };
}

/**
 * Verify cash difference lines submitted in a sync diff: must be newly created with `is_cash_difference`,
 * transition the cash statement to `closed`, match the exact count difference with no prior cash-difference
 * adjustment, and be booked and reconciled to a newly posted move on the configured profit/loss account.
 */
export function authorizeSyncCashDifferenceLines(seen, original, changed, requestedIds) {
  const verifiedIds = new Set();
  const seenStatements = new Map();
  const origLines = new Set((original.records?.['account.bank.statement.line'] ?? []).map((l) => l.id));
  const origMoves = new Set((original.records?.['account.move'] ?? []).map((m) => m.id));
  const origStatements = new Map((original.records?.['account.bank.statement'] ?? []).map((s) => [s.id, s]));

  for (const [model, line] of changed) {
    if (model !== 'account.bank.statement.line' || !requestedIds.has(line.id) || origLines.has(line.id)) continue;
    const afterStmt = line.statement_id ? read(seen, 'account.bank.statement', line.statement_id) : null;
    const beforeStmt = line.statement_id ? origStatements.get(line.statement_id) ?? null : null;
    if (!afterStmt || afterStmt.state !== 'closed' || beforeStmt?.state === 'closed') continue;
    if (seenStatements.has(afterStmt.id)) {
      verifiedIds.delete(seenStatements.get(afterStmt.id));
      continue;
    }
    const valid = validateCashDifferenceLine(seen, afterStmt, line);
    if (!valid.ok) continue;
    if (line.state !== 'reconciled' || line.open_amount !== 0 || !line.move_id || line.move_id !== line.bank_move_id) continue;
    if (origMoves.has(line.bank_move_id)) continue;
    const bankMove = read(seen, 'account.move', line.bank_move_id);
    const company = line.company_id ?? 1;
    if (!bankMove || bankMove.state !== 'posted' || bankMove.journal_id !== valid.journal.id || (bankMove.company_id ?? 1) !== company) continue;
    const round = (n) => roundCurrency(n, companyCurrencyRecord(seen, company));
    const expectedCompanyAmount = statementCompanyAmount(seen, line);
    const via = paymentJournal(seen, valid.journal.id, company);
    if (!via?.accountId || via.accountId === valid.expectedAccount) continue;
    const moveLines = bankMove.line_ids ?? [];
    const liqLines = moveLines.filter((ml) => ml.account_id === via.accountId);
    const cpLines = moveLines.filter((ml) => ml.account_id === valid.expectedAccount);
    if (moveLines.length !== 2 || liqLines.length !== 1 || cpLines.length !== 1) continue;
    const incoming = line.amount > 0;
    if (
      round(incoming ? liqLines[0].debit : liqLines[0].credit) !== expectedCompanyAmount
      || round(incoming ? liqLines[0].credit : liqLines[0].debit) !== 0
      || round(incoming ? cpLines[0].credit : cpLines[0].debit) !== expectedCompanyAmount
      || round(incoming ? cpLines[0].debit : cpLines[0].credit) !== 0
    ) continue;
    if (
      !Array.isArray(line.allocations)
      || line.allocations.length !== 1
      || line.allocations[0].payment_move_id !== bankMove.id
      || round(line.allocations[0].amount) !== expectedCompanyAmount
    ) continue;
    seenStatements.set(afterStmt.id, line.id);
    verifiedIds.add(line.id);
  }
  return { verifiedIds, ctx: { [SYNC_CASH_DIFFERENCE_CONTEXT]: verifiedIds } };
}

/**
 * Close a cash or bank statement. On cash statements with a difference between ending balance and
 * computed ending balance, posts the difference to the cash journal's profit_account_id (surplus)
 * or loss_account_id (shortage).
 */
export function closeStatement(db, statementId) {
  const statement = read(db, 'account.bank.statement', statementId);
  if (!statement) throw new Error('Statement does not exist');
  if (statement.state === 'closed') throw new Error('This statement is already closed');
  const journal = read(db, 'account.journal', statement.journal_id);
  if (!journal) throw new Error('Journal does not exist');
  const balanceEndReal = roundStatementAmount(db, statement, statement.balance_end_real);
  const balanceEnd = roundStatementAmount(db, statement, computeBalanceEnd(statement, db));
  const diff = roundStatementAmount(db, statement, balanceEndReal - balanceEnd);

  let currentDb = db;
  if (diff !== 0) {
    if (journal.type !== 'cash') {
      throw new Error('Cannot close bank statement with a difference between ending balance and computed balance');
    }
    const isSurplus = diff > 0;
    const accountId = isSurplus ? journal.profit_account_id : journal.loss_account_id;
    if (!accountId) {
      throw new Error(isSurplus
        ? 'Configure a profit account on the cash journal to record cash count difference'
        : 'Configure a loss account on the cash journal to record cash count difference');
    }
    const lineRes = create(currentDb, 'account.bank.statement.line', {
      journal_id: journal.id,
      company_id: statement.company_id ?? journal.company_id ?? 1,
      currency_id: journal.currency_id ?? read(currentDb, 'res.company', statement.company_id ?? journal.company_id ?? 1)?.currency_id ?? null,
      date: statement.date || today(),
      payment_ref: isSurplus ? 'Cash Difference Gain' : 'Cash Difference Loss',
      amount: diff,
      statement_id: statement.id,
      counterpart_account_id: accountId,
      state: 'to_check',
      is_cash_difference: true,
    }, { [CASH_DIFFERENCE_CONTEXT]: true });
    currentDb = lineRes.db;
    const createdLine = read(currentDb, 'account.bank.statement.line', lineRes.id);
    const booked = bookToAccount(currentDb, createdLine, {
      label: isSurplus ? 'Cash Difference Gain' : 'Cash Difference Loss',
    });
    currentDb = booked.db;
  }

  return write(currentDb, 'account.bank.statement', statement.id, {
    state: 'closed',
  });
}

export const bankStatementModels = {
  'account.bank.statement': {
    label: 'Bank Statements',
    guard: statementGuard,
    protectDelete: statementProtectDelete,
    onCreate: (db, after, _before, vals) => syncStatementLines(db, after, vals?.line_ids),
    onWrite: (db, after, before, vals) => syncStatementLines(db, after, vals?.line_ids, before),
    onUnlink: (db, statement) => {
      const err = statementProtectDelete(db, statement);
      if (err) throw new Error(err);
      const lines = search(db, 'account.bank.statement.line').filter((l) => l.statement_id === statement.id);
      let currentDb = db;
      for (const l of lines) {
        currentDb = write(currentDb, 'account.bank.statement.line', l.id, { statement_id: null });
      }
      return currentDb;
    },
    fields: {
      name: { type: 'char', label: 'Reference', required: true },
      journal_id: {
        type: 'many2one',
        relation: 'account.journal',
        label: 'Journal',
        required: true,
        domain: (j) => isLiquidityJournal(j),
        readonly: (r, db) => r?.state === 'closed' || statementHasReconciledLines(db, r),
      },
      company_id: { type: 'many2one', relation: 'res.company', label: 'Company', readonly: true, multiCompanyOnly: true },
      currency_id: { type: 'many2one', relation: 'res.currency', label: 'Currency', readonly: true, hidden: true, compute: (r, db) => statementCurrency(db, r)?.id ?? null },
      date: { type: 'date', label: 'Date', required: true },
      balance_start: { type: 'monetary', label: 'Starting Balance' },
      balance_end_real: { type: 'monetary', label: 'Ending Balance' },
      balance_end: { type: 'monetary', label: 'Computed Ending Balance', readonly: true, compute: computeBalanceEnd },
      line_ids: {
        type: 'one2many',
        relation: 'account.bank.statement.line',
        label: 'Statement Lines',
        editable: true,
        copy: false,
        readonly: (r, db) => r?.state === 'closed' || statementHasReconciledLines(db, r),
        fields: {
          id: { type: 'integer', label: 'ID', hidden: true },
          sequence: { type: 'integer', label: 'Sequence', hidden: true },
          date: { type: 'date', label: 'Date', required: true },
          payment_ref: { type: 'char', label: 'Label', required: true },
          partner_id: { type: 'many2one', relation: 'res.partner', label: 'Partner' },
          amount: { type: 'monetary', label: 'Amount', required: true },
          ref: { type: 'char', label: 'Reference' },
          state: { type: 'selection', label: 'Status', readonly: true, hidden: true, options: [['to_check', 'Not Matched'], ['reconciled', 'Matched']] },
        },
        newLine: (r) => ({ date: r?.date || today(), payment_ref: '', partner_id: null, amount: 0, ref: '' }),
        compute: computeStatementLines,
      },
      is_complete: { type: 'boolean', label: 'Complete', readonly: true, compute: computeIsComplete },
      is_valid: { type: 'boolean', label: 'Valid', readonly: true, compute: computeIsValid },
      // Declared after is_complete and is_valid so materialization reuses them without rescanning statements.
      problem_description: { type: 'text', label: 'Problem Description', readonly: true, hidden: true, compute: computeProblemDescription },
      state: { type: 'selection', label: 'Status', options: [['open', 'Open'], ['closed', 'Closed']], default: 'open' },
    },
    defaults: () => ({ date: today(), balance_start: 0, balance_end_real: 0, state: 'open' }),
    createDefaults: (db, vals) => ({ company_id: read(db, 'account.journal', vals.journal_id)?.company_id ?? vals.company_id ?? 1 }),
    onchange: (r, key, db, ctx) => {
      if (key === 'journal_id') {
        const journal = read(db, 'account.journal', r.journal_id);
        const companyId = journal?.company_id ?? 1;
        const currencyId = journal?.currency_id ?? read(db, 'res.company', companyId)?.currency_id ?? null;
        const patch = { company_id: companyId, currency_id: currencyId };
        if (!r.id && journal && !ctx?.editedFields?.has('balance_start')) {
          const prev = search(db, 'account.bank.statement')
            .filter((s) => s.journal_id === journal.id && (!r.date || String(s.date ?? '') <= String(r.date)))
            .sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')) || a.id - b.id)
            .at(-1);
          if (prev) patch.balance_start = roundStatementAmount(db, r, prev.balance_end_real);
        }
        return patch;
      }
      return {};
    },
    sort: (a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')) || b.id - a.id,
    searchFields: ['name', 'journal_id', 'date'],
    filters: [
      [
        { id: 'empty', label: 'Empty', fn: (r, db) => statementLines(r, db).length === 0 },
        { id: 'invalid', label: 'Invalid', fn: (r, db) => !statementIsValid(r, db) || !statementIsComplete(r, db) },
      ],
      monthFilters('date', 'Date'),
    ],
    groupBys: ['journal_id', 'date'],
    listDecoration: statementListDecoration,
    list: ['name', 'date', 'journal_id', 'company_id', 'balance_start', 'balance_end_real'],
    form: {
      title: 'name',
      statusbar: 'state',
      lockedWhen: (r) => r.state === 'closed',
      warning: statementWarning,
      groups: [['name', 'journal_id', 'date'], ['balance_start', 'balance_end_real', 'balance_end']],
      tabs: [{ label: 'Transactions', fields: ['line_ids'] }],
      buttons: [
        {
          label: 'Close',
          primary: true,
          when: (s) => s.state !== 'closed',
          run: (db, s) => ({ db: closeStatement(db, s.id) }),
        },
      ],
    },
  },
};
