import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { statementLinesWithoutJournal } from './models/bank.js';
import { importStatement } from './models/statements.js';

test('Qodo 22: bank statement line requires an explicit bank or cash journal', () => {
  const db = seed();
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);

  // Missing journal_id on creation is refused with a user-readable error
  assert.throws(
    () => create(db, 'account.bank.statement.line', {
      date: '2026-05-01',
      payment_ref: 'Unassigned transaction',
      amount: 150,
      state: 'to_check',
    }),
    /Bank Journal is required/i
  );

  // Supplying an explicit valid bank journal succeeds
  const created = create(db, 'account.bank.statement.line', {
    journal_id: bankJournal.id,
    date: '2026-05-01',
    payment_ref: 'Assigned transaction',
    amount: 150,
    state: 'to_check',
  });
  assert.equal(read(created.db, 'account.bank.statement.line', created.id).journal_id, bankJournal.id);

  // Clearing journal_id on write is refused
  assert.throws(
    () => write(created.db, 'account.bank.statement.line', created.id, { journal_id: null }),
    /Bank Journal is required/i
  );
});

test('Qodo 22: importing statement files requires an explicit bank journal', () => {
  const db = seed();
  const file = '<BANKTRANLIST><STMTTRN><DTPOSTED>20260502<TRNAMT>10<FITID>q22-1<NAME>Receipt</STMTTRN></BANKTRANLIST>';

  // Importing without journal_id is refused explicitly
  assert.throws(
    () => importStatement(db, 'bank.ofx', file),
    /Bank Journal is required/i
  );
});

test('Qodo 22: legacy journal-less statement lines are listed for the dashboard instead of vanishing', () => {
  const db = seed();
  const legacyLine = { id: 999123, date: '2025-01-15', payment_ref: 'Ambiguous older transaction', amount: 250, state: 'to_check', company_id: 1 };
  const withLegacy = { ...db, records: { ...db.records, 'account.bank.statement.line': [...(db.records['account.bank.statement.line'] ?? []), legacyLine] } };
  assert.deepEqual(statementLinesWithoutJournal(db), []);
  assert.deepEqual(statementLinesWithoutJournal(withLegacy).map((line) => line.id), [999123]);
});
