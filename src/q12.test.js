import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyFilters, create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { models } from './models/index.js';
import { creditNote, postAutoPostMoves, postMove } from './models/accounting.js';
import { postDueEntries } from './models/deferred.js';
import { isStatementLineWithoutJournal, statementLinesWithoutJournal } from './models/bank.js';
import { journalCards } from './models/finance.js';
import { reverseEntry } from './models/pay.js';
import { importStatement, statementImportJournalChoices, withSelectedStatementJournal } from './models/statements.js';

const only = (records, label) => {
  assert.equal(records.length, 1, `${label} must have exactly one match`);
  return records[0];
};

const defaultBankJournal = (db) => only(search(db, 'account.journal').filter((journal) =>
  journal.type === 'bank' && journal.default_for_payments === true && (journal.company_id ?? 1) === 1
), 'company 1 default bank journal');

const move = (db, id) => read(db, 'account.move', id);
const noteId = (result) => result.credit_note_id ?? result.id;

function deferredInvoice(amount = 120) {
  const configured = write(seed(), 'res.company', 1, {
    deferred_generation_method: 'manual',
    deferred_amount_computation_method: 'full_months',
  });
  const created = create(configured, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 2,
    invoice_date: '2026-01-01',
    invoice_date_due: '2026-01-01',
    invoice_line_ids: [{
      name: 'Service', qty: 1, price_unit: amount, tax: 0,
      deferred_start_date: '2026-01-01', deferred_end_date: '2026-03-31',
    }],
  });
  const db = postMove(created.db, created.id);
  const schedule = only(search(db, 'account.deferral').filter((record) => record.source_move_id === created.id), 'invoice deferral schedule');
  return { db, invoiceId: created.id, schedule };
}

const netAccount = (db, accountId) => (db.records['account.move'] ?? [])
  .filter((entry) => entry.state === 'posted')
  .flatMap((entry) => entry.line_ids ?? [])
  .filter((line) => line.account_id === accountId)
  .reduce((sum, line) => sum + (Number(line.credit) || 0) - (Number(line.debit) || 0), 0);

test('Qodo 1: explicit journal selection is passed into the ordinary statement import flow', () => {
  const db = seed();
  const journal = defaultBankJournal(db);
  const choices = statementImportJournalChoices(db);
  assert.ok(choices.some((choice) => choice.id === journal.id));
  assert.ok(choices.every((choice) => ['bank', 'cash'].includes(choice.type)));

  const defaults = withSelectedStatementJournal({}, String(journal.id));
  assert.equal(defaults.journal_id, journal.id);
  const file = '<BANKTRANLIST><STMTTRN><DTPOSTED>20260502<TRNAMT>10<FITID>q12-import-1<NAME>Receipt</STMTTRN></BANKTRANLIST>';
  const imported = importStatement(db, 'bank.ofx', file, defaults);
  assert.equal(imported.count, 1);
  const line = only(search(imported.db, 'account.bank.statement.line').filter((record) => record.unique_import_id === 'q12-import-1'), 'imported statement line');
  assert.equal(line.journal_id, journal.id);
});

test('Qodo 4: re-import ignores a same-company legacy line whose journal is still unset', () => {
  const db = seed();
  const journal = defaultBankJournal(db);
  const legacy = {
    id: 905001,
    date: '2025-01-15',
    payment_ref: 'Legacy imported transaction',
    amount: 25,
    state: 'to_check',
    company_id: 1,
    unique_import_id: 'q12-legacy-import',
  };
  const withLegacy = {
    ...db,
    records: {
      ...db.records,
      'account.bank.statement.line': [...(db.records['account.bank.statement.line'] ?? []), legacy],
    },
  };
  const file = '<BANKTRANLIST><STMTTRN><DTPOSTED>20250115<TRNAMT>25<FITID>q12-legacy-import<NAME>Legacy imported transaction</STMTTRN></BANKTRANLIST>';
  const imported = importStatement(withLegacy, 'bank.ofx', file, { journal_id: journal.id });

  assert.equal(imported.count, 0);
  assert.equal(search(imported.db, 'account.bank.statement.line').filter((line) => line.unique_import_id === legacy.unique_import_id).length, 1);
});

test('Qodo 3: a full credit cancels a future scheduled reversal before posting its single recognition offset', () => {
  const source = deferredInvoice();
  let db = postDueEntries(source.db, source.schedule, '2026-01-31');
  const postedSchedule = read(db, 'account.deferral', source.schedule.id);
  const recognitionMoveId = postedSchedule.board[0].move_id;
  const recognitionMove = move(db, recognitionMoveId);
  const scheduled = reverseEntry(db, recognitionMove, { date: '2026-02-15', scheduled: true });
  const scheduledReversalId = scheduled.id;
  db = scheduled.db;
  const recognitionAccountId = read(db, 'account.deferral', source.schedule.id).recognition_account_id;
  const recognizedAmount = recognitionMove.line_ids
    .filter((line) => line.account_id === recognitionAccountId)
    .reduce((sum, line) => sum + (Number(line.credit) || 0) - (Number(line.debit) || 0), 0);
  const recognitionBeforeCredit = netAccount(db, recognitionAccountId);

  const drafted = creditNote(db, move(db, source.invoiceId), { date: '2026-02-15' });
  db = postMove(drafted.db, noteId(drafted));
  const cancelled = move(db, scheduledReversalId);
  assert.equal(cancelled.state, 'cancel');
  assert.equal(cancelled.auto_post, 'no');
  assert.equal(Math.round(netAccount(db, recognitionAccountId) * 100), Math.round((recognitionBeforeCredit - recognizedAmount) * 100));

  const postedReversals = () => search(db, 'account.move').filter((entry) => entry.state === 'posted' && entry.reversed_entry_id === recognitionMoveId);
  assert.equal(postedReversals().length, 1);
  db = postAutoPostMoves(db, '2026-12-31');
  assert.equal(move(db, scheduledReversalId).state, 'cancel');
  assert.equal(postedReversals().length, 1);
});

test('Qodo 10: the unassigned transactions filter opens legacy lines without adding them to journal cards', () => {
  const db = seed();
  const journal = defaultBankJournal(db);
  const unassigned = { id: 905101, date: '2025-02-01', payment_ref: 'Needs journal', amount: 40, state: 'to_check', company_id: 1 };
  const assigned = { id: 905102, date: '2025-02-02', payment_ref: 'Assigned', amount: 15, state: 'to_check', company_id: 1, journal_id: journal.id };
  const rows = [unassigned, assigned];
  const withLines = {
    ...db,
    records: {
      ...db.records,
      'account.bank.statement.line': [...(db.records['account.bank.statement.line'] ?? []), ...rows],
    },
  };

  assert.equal(models['account.bank.statement.line'].filters.flat().some((filter) => filter.id === 'unassigned'), true);
  assert.deepEqual(applyFilters('account.bank.statement.line', rows, ['open', 'unassigned']).map((line) => line.id), [unassigned.id]);
  assert.equal(isStatementLineWithoutJournal(unassigned), true);
  assert.ok(statementLinesWithoutJournal(withLines).some((line) => line.id === unassigned.id));

  const before = only(journalCards(db).filter((card) => card.journal.id === journal.id), 'bank journal card before legacy lines');
  const after = only(journalCards(withLines).filter((card) => card.journal.id === journal.id), 'bank journal card after legacy lines');
  assert.equal(after.toReconcile, before.toReconcile + 1);
});
