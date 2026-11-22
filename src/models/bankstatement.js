// Bank statements (account.bank.statement) tracking opening, ending, and computed balances across statement lines.
import { create, read, search, unlink, write } from '../orm.js';
import { isLiquidityJournal } from './ledger.js';
import { bookToAccount } from './bank.js';
import { today } from './common.js';
import { roundCurrency } from '../money.js';
import { resolveStatementCompany } from './statements.js';

const statementLinesCache = new WeakMap();

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

export function roundStatementAmount(db, statement, amount) {
  if (amount == null) return 0;
  const num = Number(amount) || 0;
  if (!db || !statement?.journal_id) return num;
  const journal = read(db, 'account.journal', statement.journal_id);
  const companyId = resolveStatementCompany(db, statement, journal);
  const currencyId = journal?.currency_id ?? read(db, 'res.company', companyId)?.currency_id;
  const currency = currencyId ? read(db, 'res.currency', currencyId) : null;
  return currency ? roundCurrency(num, currency) : num;
}

/** Computed ending balance: balance_start + sum of its lines' amounts. */
export function computeBalanceEnd(r, db) {
  const lines = Array.isArray(r?.line_ids) ? r.line_ids : (linesByStatement(db).get(r?.id) ?? []);
  const linesSum = lines.reduce((acc, l) => acc + (Number(l.amount) || 0), 0);
  const total = (Number(r?.balance_start) || 0) + linesSum;
  return roundStatementAmount(db, r, total);
}

/** Computed completeness: has lines and balance_end equals balance_end_real at the journal currency rounding. */
export function computeIsComplete(r, db) {
  const lines = Array.isArray(r?.line_ids) ? r.line_ids : (linesByStatement(db).get(r?.id) ?? []);
  if (!lines.length) return false;
  const balanceEnd = computeBalanceEnd(r, db);
  const balanceEndReal = roundStatementAmount(db, r, r?.balance_end_real);
  return balanceEnd === balanceEndReal;
}

let inComputeIsValid = false;
/** Computed validity: balance_start equals previous statement's balance_end_real in same journal, by date then id; true for first statement. */
export function computeIsValid(r, db) {
  if (!db || !r.journal_id || inComputeIsValid) return true;
  inComputeIsValid = true;
  try {
    const rawStatements = search(db, 'account.bank.statement')
      .filter((s) => s.journal_id === r.journal_id)
      .sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')) || a.id - b.id);
    const idx = rawStatements.findIndex((s) => s.id === r.id);
    const prev = idx > 0 ? rawStatements[idx - 1] : null;
    if (!prev) return true;
    return roundStatementAmount(db, r, r.balance_start) === roundStatementAmount(db, prev, prev.balance_end_real);
  } finally {
    inComputeIsValid = false;
  }
}

/** Previous statement's ending balance of the same journal, by date then id; 0 when none. */
export function previousStatementEndingBalance(db, journalId, statementDate = null, excludeId = null) {
  if (!db || !journalId) return 0;
  const rawStatements = search(db, 'account.bank.statement')
    .filter((s) => s.journal_id === journalId && (excludeId ? s.id !== excludeId : true) && (statementDate ? String(s.date ?? '') <= String(statementDate) : true))
    .sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')) || a.id - b.id);
  const prev = rawStatements.at(-1);
  return prev ? Number(prev.balance_end_real) || 0 : 0;
}

/** Strip in-memory line_ids field from stored account.bank.statement record so virtual field is not persisted. */
export function stripStatementLineIds(db, statementId) {
  if (!db?.records?.['account.bank.statement']) return db;
  return {
    ...db,
    records: {
      ...db.records,
      'account.bank.statement': (db.records['account.bank.statement'] ?? []).map((r) => {
        if (r.id !== statementId || !Object.hasOwn(r, 'line_ids')) return r;
        const { line_ids: _omitted, ...rest } = r;
        return rest;
      }),
    },
  };
}

/** Synchronize inline account.bank.statement.line rows after statement create or write. */
export function syncStatementLines(db, statement, lineVals) {
  let next = stripStatementLineIds(db, statement.id);
  if (!Array.isArray(lineVals)) return next;
  const existing = (linesByStatement(next).get(statement.id) ?? []);
  const existingById = new Map(existing.map((l) => [l.id, l]));
  const keepIds = new Set(lineVals.map((l) => l.id).filter(Boolean));
  const removeIds = existing.filter((l) => !keepIds.has(l.id)).map((l) => l.id);

  if (removeIds.length) {
    next = unlink(next, 'account.bank.statement.line', removeIds);
  }

  const journal = statement.journal_id ? read(next, 'account.journal', statement.journal_id) : null;
  const companyId = resolveStatementCompany(next, statement, journal);
  const editableFields = ['date', 'payment_ref', 'partner_id', 'amount', 'ref'];
  for (const row of lineVals) {
    if (row.id && existingById.has(row.id)) {
      const current = existingById.get(row.id);
      const changes = {};
      for (const f of editableFields) {
        if (Object.hasOwn(row, f) && row[f] !== current[f]) {
          changes[f] = row[f];
        }
      }
      if (Object.keys(changes).length) {
        next = write(next, 'account.bank.statement.line', row.id, changes);
      }
    } else {
      const newLinePayload = {
        date: row.date || statement.date || today(),
        payment_ref: row.payment_ref || '/',
        partner_id: row.partner_id ?? null,
        amount: Number(row.amount) || 0,
        ref: row.ref ?? '',
        statement_id: statement.id,
        journal_id: statement.journal_id,
        company_id: companyId,
        state: 'to_check',
      };
      const res = create(next, 'account.bank.statement.line', newLinePayload);
      next = res.db;
    }
  }
  return next;
}

function statementGuard(db, before, after) {
  if (before && before.state === 'closed') {
    if (after.state !== 'closed') return 'A closed statement cannot be reopened';
    if (
      before.balance_start !== after.balance_start ||
      before.balance_end_real !== after.balance_end_real ||
      before.journal_id !== after.journal_id ||
      resolveStatementCompany(db, before, read(db, 'account.journal', before.journal_id)) !== resolveStatementCompany(db, after, read(db, 'account.journal', after.journal_id)) ||
      before.date !== after.date
    ) {
      return 'A closed statement cannot be modified';
    }
  }

  if (!after.journal_id) return 'Bank or cash journal is required';
  const journal = read(db, 'account.journal', after.journal_id);
  if (!journal) return 'The journal does not exist';
  if (!isLiquidityJournal(journal)) return 'Choose a bank or cash journal';
  const company = resolveStatementCompany(db, after, journal);
  if (journal.company_id && journal.company_id !== company) return 'The bank journal belongs to another company';

  const lines = linesByStatement(db).get(after.id) ?? [];
  if (lines.some((l) => l.journal_id !== after.journal_id || resolveStatementCompany(db, l, journal) !== company)) {
    return 'Statement lines must belong to the statement journal and company';
  }

  if (before && lines.some((l) => l.state === 'reconciled' || Boolean(l.bank_move_id))) {
    if (before.journal_id !== after.journal_id || resolveStatementCompany(db, before, journal) !== company) {
      return 'A statement with reconciled lines cannot change its journal or company';
    }
  }

  return null;
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
      company_id: resolveStatementCompany(currentDb, statement, journal),
      currency_id: journal.currency_id ?? read(currentDb, 'res.company', resolveStatementCompany(currentDb, statement, journal))?.currency_id ?? null,
      date: statement.date || today(),
      payment_ref: isSurplus ? 'Cash Difference Gain' : 'Cash Difference Loss',
      amount: diff,
      statement_id: statement.id,
      counterpart_account_id: accountId,
      state: 'to_check',
    });
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
    onUnlink: (db, statement) => {
      if (statement.state === 'closed') {
        throw new Error('A closed statement cannot be deleted');
      }
      const lines = search(db, 'account.bank.statement.line').filter((l) => l.statement_id === statement.id);
      if (lines.some((l) => l.state === 'reconciled' || (l.allocations ?? []).length > 0)) {
        throw new Error('Cannot delete a statement with reconciled lines');
      }
      if (lines.some((l) => l.bank_move_id)) throw new Error('Cannot delete a statement with booked lines');
      let currentDb = db;
      for (const l of lines) {
        currentDb = write(currentDb, 'account.bank.statement.line', l.id, { statement_id: null });
      }
      return currentDb;
    },
    fields: {
      name: { type: 'char', label: 'Reference', required: true },
      journal_id: { type: 'many2one', relation: 'account.journal', label: 'Journal', required: true, domain: (j) => isLiquidityJournal(j) },
      company_id: { type: 'many2one', relation: 'res.company', label: 'Company', readonly: true },
      date: { type: 'date', label: 'Date', required: true },
      balance_start: { type: 'monetary', label: 'Starting Balance' },
      balance_end_real: { type: 'monetary', label: 'Ending Balance' },
      balance_end: { type: 'monetary', label: 'Computed Ending Balance', readonly: true, compute: computeBalanceEnd },
      line_ids: {
        type: 'one2many',
        relation: 'account.bank.statement.line',
        label: 'Transactions',
        editable: true,
        readonly: (r) => r?.state === 'closed',
        fields: {
          id: { type: 'integer', label: 'ID', hidden: true },
          date: { type: 'date', label: 'Date', required: true, readonly: (l) => l?.state === 'reconciled' },
          payment_ref: { type: 'char', label: 'Label', required: true, readonly: (l) => l?.state === 'reconciled' },
          partner_id: { type: 'many2one', relation: 'res.partner', label: 'Partner', readonly: (l) => l?.state === 'reconciled' },
          amount: { type: 'monetary', label: 'Amount', required: true, readonly: (l) => l?.state === 'reconciled' },
          ref: { type: 'char', label: 'Reference', readonly: (l) => l?.state === 'reconciled' },
          journal_id: { type: 'many2one', relation: 'account.journal', label: 'Journal', hidden: true },
          company_id: { type: 'many2one', relation: 'res.company', label: 'Company', hidden: true },
          statement_id: { type: 'many2one', relation: 'account.bank.statement', label: 'Statement', hidden: true },
          state: { type: 'selection', label: 'Status', hidden: true },
          bank_move_id: { type: 'many2one', relation: 'account.move', label: 'Bank Entry', hidden: true },
        },
        newLine: (r, db) => {
          const journal = r?.journal_id && db ? read(db, 'account.journal', r.journal_id) : null;
          const companyId = db ? resolveStatementCompany(db, r, journal) : (r?.company_id ?? null);
          return {
            date: r?.date || today(),
            payment_ref: '',
            partner_id: null,
            amount: 0,
            ref: '',
            journal_id: r?.journal_id ?? null,
            ...(companyId != null ? { company_id: companyId } : {}),
          };
        },
        compute: (r, db) => linesByStatement(db).get(r.id) ?? [],
      },
      is_complete: { type: 'boolean', label: 'Complete', readonly: true, compute: computeIsComplete },
      is_valid: { type: 'boolean', label: 'Valid', readonly: true, compute: computeIsValid },
      state: { type: 'selection', label: 'Status', options: [['open', 'Open'], ['closed', 'Closed']], default: 'open' },
    },
    defaults: () => ({ date: today(), balance_end_real: 0, state: 'open' }),
    createDefaults: (db, vals) => {
      const journal = vals?.journal_id ? read(db, 'account.journal', vals.journal_id) : null;
      const company_id = resolveStatementCompany(db, vals, journal);
      const prevBalance = previousStatementEndingBalance(db, vals?.journal_id, vals?.date, vals?.id);
      return {
        company_id,
        balance_start: prevBalance,
      };
    },
    onchange: (r, key, db) => {
      if (key === 'journal_id') {
        const journal = read(db, 'account.journal', r.journal_id);
        const company_id = journal?.company_id ?? resolveStatementCompany(db, r, journal);
        const prevBalance = previousStatementEndingBalance(db, r.journal_id, r.date, r.id);
        return {
          company_id,
          balance_start: prevBalance,
        };
      }
      return {};
    },
    onCreate: (db, after, _before, vals) => syncStatementLines(db, after, vals?.line_ids),
    onWrite: (db, after, _before, vals) => syncStatementLines(db, after, vals?.line_ids),
    sort: (a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')) || b.id - a.id,
    list: ['name', 'date', 'journal_id', 'balance_start', 'balance_end', 'balance_end_real', 'state'],
    form: {
      title: 'name',
      statusbar: 'state',
      lockedWhen: (r) => r.state === 'closed',
      ribbon: (r) => (r?.is_complete ? 'Complete' : null),
      warning: (r, db) => (!computeIsComplete(r, db) ? 'The computed ending balance does not match the entered ending balance.' : null),
      groups: [['name', 'journal_id', 'date'], ['balance_start', 'balance_end_real', 'balance_end']],
      tabs: [{ label: 'Transactions', fields: ['line_ids'] }],
      buttons: [
        {
          label: 'Close',
          primary: true,
          when: (s) => s.state !== 'closed',
          run: (db, s) => ({ db: closeStatement(db, s.id) }),
        },
        {
          label: 'Import',
          when: (s) => s.state !== 'closed',
          importFile: {
            model: 'account.bank.statement.line',
            defaults: (s) => ({
              statement_id: s.id,
              ...(s.journal_id ? { journal_id: s.journal_id } : {}),
              ...(s.company_id != null ? { company_id: s.company_id } : {}),
            }),
          },
        },
      ],
    },
  },
};
