import test from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { create, read, search, unlink, write } from './orm.js';
import { postMove, payMove } from './models/accounting.js';
import { postPayment } from './models/pay.js';
import { reconcileWith, matchPayment, unreconcile, bookToAccount } from './models/bank.js';
import { importStatement } from './models/statements.js';
import { applyDiff, diffDb } from './sync.js';
import { migrate, SCHEMA_VERSION } from './migrations.js';
import { createCompanyWithDefaultInvoiceJournals } from './test-support/accounting-company.js';
import { applyRule } from './models/reconcile.js';

const LINE_MODEL = 'account.bank.statement.line';
const MOVE_MODEL = 'account.move';

function setupBankTestDb() {
  let db = seed();
  const suspenseAccount = search(db, 'account.account').find((a) => a.code === '101404');
  const outstandingAccount = search(db, 'account.account').find((a) => a.code === '101402');
  const bankAccountRes = create(db, 'account.account', {
    name: 'Test Bank Account',
    code: '101499',
    account_type: 'asset_cash',
    company_id: 1,
  });
  db = bankAccountRes.db;
  const bankAccount = read(db, 'account.account', bankAccountRes.id);
  const bankJournalRes = create(db, 'account.journal', {
    name: 'Test Bank',
    code: 'TBK',
    type: 'bank',
    default_account_id: bankAccount.id,
    suspense_account_id: suspenseAccount.id,
    outstanding_receipts_account_id: outstandingAccount.id,
    outstanding_payments_account_id: outstandingAccount.id,
    company_id: 1,
  });
  db = bankJournalRes.db;
  const bankJournal = read(db, 'account.journal', bankJournalRes.id);
  return { db, bankJournal, suspenseAccount, bankAccount, outstandingAccount };
}

test('an unallocated statement line cannot link an unrelated posted entry', () => {
  const { db, bankJournal } = setupBankTestDb();
  const first = create(db, LINE_MODEL, { journal_id: bankJournal.id, company_id: 1, date: '2026-05-01', payment_ref: 'First', amount: 100 });
  const moveId = read(first.db, LINE_MODEL, first.id).bank_move_id;
  assert.throws(() => create(first.db, LINE_MODEL, {
    journal_id: bankJournal.id, company_id: 1, date: '2026-05-01', payment_ref: 'Forged', amount: 50, bank_move_id: moveId, open_amount: 50,
  }), /bank entry cannot be supplied/i);
  assert.throws(() => create(first.db, LINE_MODEL, {
    journal_id: bankJournal.id, company_id: 1, date: '2026-05-01', payment_ref: 'Duplicate', amount: 100, bank_move_id: moveId, open_amount: 100,
  }), /bank entry cannot be supplied/i);
  const forged = { ...first.db, records: { ...first.db.records, [LINE_MODEL]: [...first.db.records[LINE_MODEL], {
    ...read(first.db, LINE_MODEL, first.id), id: 999999, bank_move_id: moveId, state: 'reconciled', move_id: moveId,
    open_amount: 0, allocations: [{ payment_move_id: moveId, amount: 100 }],
  }] } };
  assert.throws(() => applyDiff(first.db, diffDb(first.db, forged), { isAdmin: true }), /bank entry|already linked/i);
});

test('untouched booked transactions can be corrected and deleted with reversal entries', () => {
  const { db, bankJournal } = setupBankTestDb();
  const created = create(db, LINE_MODEL, { journal_id: bankJournal.id, company_id: 1, date: '2026-05-01', payment_ref: 'Mistyped', amount: 100 });
  const oldId = read(created.db, LINE_MODEL, created.id).bank_move_id;
  const corrected = write(created.db, LINE_MODEL, created.id, { amount: 75, payment_ref: 'Corrected' });
  const line = read(corrected, LINE_MODEL, created.id);
  assert.notEqual(line.bank_move_id, oldId);
  assert.ok(search(corrected, MOVE_MODEL).some((move) => move.reversed_entry_id === oldId));
  assert.doesNotThrow(() => applyDiff(created.db, diffDb(created.db, corrected), { isAdmin: true }));
  const deleted = unlink(corrected, LINE_MODEL, [created.id]);
  assert.ok(search(deleted, MOVE_MODEL).some((move) => move.reversed_entry_id === line.bank_move_id));
  assert.doesNotThrow(() => applyDiff(corrected, diffDb(corrected, deleted), { isAdmin: true }));
});

test('migration books a company-less legacy line using its journal company currency', () => {
  const base = seed();
  const eur = search(base, 'res.currency').find((currency) => currency.name === 'EUR');
  const usd = search(base, 'res.currency').find((currency) => currency.name === 'USD');
  const withRate = write(base, 'res.currency', eur.id, { rate_ids: [{ date: '2026-01-01', rate: 0.5 }] });
  const company = createCompanyWithDefaultInvoiceJournals(withRate, { name: 'Migration company', currency_id: eur.id });
  const journal = search(company.db, 'account.journal').find((item) => item.company_id === company.id && item.type === 'bank');
  const db = write(company.db, 'account.journal', journal.id, { currency_id: usd.id });
  const line = { id: 90001, journal_id: journal.id, date: '2026-01-02', payment_ref: 'Legacy foreign', amount: 100, state: 'to_check' };
  const legacy = { ...db, schema_version: 61, records: { ...db.records, [LINE_MODEL]: [...db.records[LINE_MODEL], line] } };
  const migrated = migrate(legacy);
  const result = read(migrated, LINE_MODEL, line.id);
  assert.equal(result.company_id, company.id);
  assert.equal(result.open_amount, 50);
  const move = read(migrated, MOVE_MODEL, result.bank_move_id);
  assert.equal(move.company_id, company.id);
  assert.equal(move.line_ids.find((item) => item.account_id === journal.default_account_id).debit, 50);
});

test('BANK-2: importing statement lines immediately posts an entry in the bank journal (bank vs suspense) and GL bank balance equals statement', () => {
  const { db: baseDb, bankJournal, suspenseAccount, bankAccount } = setupBankTestDb();

  const qifContent = `!Type:Bank
D2026-05-01
T500.00
PCustomer deposit
^
D2026-05-02
T-100.00
PVendor payment
^
`;

  const { db: importedDb, count, statement_id } = importStatement(baseDb, 'test.qif', qifContent, {
    journal_id: bankJournal.id,
    company_id: 1,
  });

  assert.equal(count, 2, 'Two transactions imported');
  const lines = search(importedDb, LINE_MODEL).filter((l) => l.statement_id === statement_id);
  assert.equal(lines.length, 2);

  // Line 1: +500. Must have bank_move_id immediately.
  const line1 = lines.find((l) => Number(l.amount) === 500);
  assert.ok(line1.bank_move_id, 'Line 1 must have bank_move_id at creation');
  const move1 = read(importedDb, MOVE_MODEL, line1.bank_move_id);
  assert.equal(move1.state, 'posted');
  assert.equal(move1.journal_id, bankJournal.id);
  // Bank account: debit 500; Suspense account: credit 500
  const m1BankLine = move1.line_ids.find((l) => l.account_id === bankAccount.id);
  const m1SuspenseLine = move1.line_ids.find((l) => l.account_id === suspenseAccount.id);
  assert.ok(m1BankLine, 'Move 1 must have bank line');
  assert.ok(m1SuspenseLine, 'Move 1 must have suspense line');
  assert.equal(m1BankLine.debit, 500);
  assert.equal(m1BankLine.credit, 0);
  assert.equal(m1SuspenseLine.debit, 0);
  assert.equal(m1SuspenseLine.credit, 500);

  // Line 2: -100. Must have bank_move_id immediately.
  const line2 = lines.find((l) => Number(l.amount) === -100);
  assert.ok(line2.bank_move_id, 'Line 2 must have bank_move_id at creation');
  const move2 = read(importedDb, MOVE_MODEL, line2.bank_move_id);
  assert.equal(move2.state, 'posted');
  const m2BankLine = move2.line_ids.find((l) => l.account_id === bankAccount.id);
  const m2SuspenseLine = move2.line_ids.find((l) => l.account_id === suspenseAccount.id);
  assert.ok(m2BankLine, 'Move 2 must have bank line');
  assert.ok(m2SuspenseLine, 'Move 2 must have suspense line');
  assert.equal(m2BankLine.debit, 0);
  assert.equal(m2BankLine.credit, 100);
  assert.equal(m2SuspenseLine.debit, 100);
  assert.equal(m2SuspenseLine.credit, 0);

  // GL bank balance for bank account equals statement lines sum (500 - 100 = 400)
  const allMoves = search(importedDb, MOVE_MODEL).filter((m) => m.state === 'posted');
  const glBankLines = allMoves.flatMap((m) => m.line_ids ?? []).filter((l) => l.account_id === bankAccount.id);
  const glBankBalance = glBankLines.reduce((sum, l) => sum + (Number(l.debit) || 0) - (Number(l.credit) || 0), 0);
  const statement = read(importedDb, 'account.bank.statement', statement_id);
  assert.equal(glBankBalance, 400, 'GL bank balance matches statement net movement before reconciliation');
  assert.equal(glBankBalance, statement.balance_end_real, 'GL bank balance equals statement ending balance');

  // Verify diffDb + applyDiff
  assert.doesNotThrow(() => applyDiff(baseDb, diffDb(baseDb, importedDb), { isAdmin: true }));
});

test('BANK-2: manual statement line creation immediately posts bank vs suspense entry', () => {
  const { db: baseDb, bankJournal, suspenseAccount, bankAccount } = setupBankTestDb();

  const created = create(baseDb, LINE_MODEL, {
    journal_id: bankJournal.id,
    amount: 250,
    date: '2026-06-01',
    payment_ref: 'Manual receipt 250',
    company_id: 1,
  });

  const line = read(created.db, LINE_MODEL, created.id);
  assert.ok(line.bank_move_id, 'Manual statement line creation must post bank_move_id immediately');
  assert.equal(line.open_amount, 250);

  const move = read(created.db, MOVE_MODEL, line.bank_move_id);
  assert.equal(move.state, 'posted');
  assert.equal(move.journal_id, bankJournal.id);
  const bankLine = move.line_ids.find((l) => l.account_id === bankAccount.id);
  const suspenseLine = move.line_ids.find((l) => l.account_id === suspenseAccount.id);
  assert.equal(bankLine.debit, 250);
  assert.equal(suspenseLine.credit, 250);

  assert.doesNotThrow(() => applyDiff(baseDb, diffDb(baseDb, created.db), { isAdmin: true }));
});

test('BANK-2: missing suspense account on both journal and company auto-creates suspense account via ensureBankSuspense', () => {
  const { db: baseDb, bankJournal } = setupBankTestDb();

  // Remove suspense_account_id from journal, company, and clear account 101404
  const noSuspenseDb = {
    ...baseDb,
    records: {
      ...baseDb.records,
      'account.journal': (baseDb.records['account.journal'] ?? []).map((j) =>
        j.id === bankJournal.id ? { ...j, suspense_account_id: null } : j
      ),
      'res.company': (baseDb.records['res.company'] ?? []).map((c) =>
        c.id === 1 ? { ...c, account_journal_suspense_account_id: null } : c
      ),
      'account.account': (baseDb.records['account.account'] ?? []).filter((a) => a.code !== '101404'),
    },
  };

  // Manual create succeeds by auto-creating company suspense account
  const created = create(noSuspenseDb, LINE_MODEL, {
    journal_id: bankJournal.id,
    amount: 100,
    date: '2026-06-01',
    payment_ref: 'Auto suspense line',
    company_id: 1,
  });
  const line = read(created.db, LINE_MODEL, created.id);
  assert.ok(line.bank_move_id, 'Bank move is created and linked');
  const move = read(created.db, MOVE_MODEL, line.bank_move_id);
  assert.equal(move.state, 'posted');
  const company = read(created.db, 'res.company', 1);
  assert.ok(company.account_journal_suspense_account_id, 'Company has suspense account assigned');
  const suspAccount = read(created.db, 'account.account', company.account_journal_suspense_account_id);
  assert.equal(suspAccount.name, 'Bank Suspense Account');

  // File import also succeeds
  const imported = importStatement(noSuspenseDb, 'test.qif', '!Type:Bank\nD2026-05-01\nT100.00\nPDeposit\n^\n', {
    journal_id: bankJournal.id,
    company_id: 1,
  });
  assert.equal(imported.count, 1);
});

test('BANK-3: reconciling with invoice replaces suspense line on the same move (bank vs receivable, no suspense left, invoice paid)', () => {
  const { db: baseDb, bankJournal, suspenseAccount, bankAccount } = setupBankTestDb();

  // Create an open customer invoice of 200
  const invRes = create(baseDb, MOVE_MODEL, {
    move_type: 'out_invoice',
    partner_id: 3,
    invoice_date: '2026-06-01',
    invoice_line_ids: [{ qty: 1, price_unit: 200, tax: 0 }],
  });
  let db = postMove(invRes.db, invRes.id);
  const invoice = read(db, MOVE_MODEL, invRes.id);
  const receivableAccount = invoice.line_ids.find((l) => l.account_id !== 400000 && l.debit === 200).account_id;

  // Create statement line of 200
  const lineRes = create(db, LINE_MODEL, {
    journal_id: bankJournal.id,
    amount: 200,
    date: '2026-06-02',
    payment_ref: 'Invoice 200 settlement',
    company_id: 1,
  });
  db = lineRes.db;
  const initialLine = read(db, LINE_MODEL, lineRes.id);
  const initialBankMoveId = initialLine.bank_move_id;
  assert.ok(initialBankMoveId, 'Initial bank_move_id exists');

  // Reconcile statement line with invoice
  db = reconcileWith(db, initialLine, invoice.id);
  const reconciledLine = read(db, LINE_MODEL, lineRes.id);

  assert.equal(reconciledLine.state, 'reconciled');
  assert.equal(reconciledLine.open_amount, 0);
  assert.equal(reconciledLine.bank_move_id, initialBankMoveId, 'BANK-3: same entry move is rewritten');

  // Inspect the entry: it now has bank vs receivable, NO suspense line
  const rewrittenMove = read(db, MOVE_MODEL, initialBankMoveId);
  assert.equal(rewrittenMove.state, 'posted');
  const bankLine = rewrittenMove.line_ids.find((l) => l.account_id === bankAccount.id);
  const recLine = rewrittenMove.line_ids.find((l) => l.account_id === receivableAccount);
  const suspLine = rewrittenMove.line_ids.find((l) => l.account_id === suspenseAccount.id);

  assert.ok(bankLine, 'Bank liquidity line preserved');
  assert.equal(bankLine.debit, 200);
  assert.ok(recLine, 'Receivable line added');
  assert.equal(recLine.credit, 200);
  assert.equal(recLine.partner_id, 3);
  assert.equal(suspLine, undefined, 'No suspense line left after full reconciliation');

  // Invoice is paid
  const paidInvoice = read(db, MOVE_MODEL, invoice.id);
  assert.equal(paidInvoice.amount_residual, 0);

  // Guard validation through diffDb + applyDiff
  assert.doesNotThrow(() => applyDiff(lineRes.db, diffDb(lineRes.db, db), { isAdmin: true }));
});

test('BANK-3: partial match leaves remainder on suspense on the same move', () => {
  const { db: baseDb, bankJournal, suspenseAccount, bankAccount } = setupBankTestDb();

  // Create customer invoice for 60
  const invRes = create(baseDb, MOVE_MODEL, {
    move_type: 'out_invoice',
    partner_id: 3,
    invoice_date: '2026-06-01',
    invoice_line_ids: [{ qty: 1, price_unit: 60, tax: 0 }],
  });
  let db = postMove(invRes.db, invRes.id);
  const invoice = read(db, MOVE_MODEL, invRes.id);
  const receivableAccount = invoice.line_ids.find((l) => l.debit === 60).account_id;

  // Statement line for 100
  const lineRes = create(db, LINE_MODEL, {
    journal_id: bankJournal.id,
    amount: 100,
    date: '2026-06-02',
    payment_ref: 'Partial 100 for 60 inv',
    company_id: 1,
  });
  db = lineRes.db;
  const initialLine = read(db, LINE_MODEL, lineRes.id);
  const initialBankMoveId = initialLine.bank_move_id;

  // Reconcile with 60 invoice
  db = reconcileWith(db, initialLine, invoice.id);
  const partialLine = read(db, LINE_MODEL, lineRes.id);

  assert.equal(partialLine.state, 'to_check');
  assert.equal(partialLine.open_amount, 40);
  assert.equal(partialLine.bank_move_id, initialBankMoveId, 'Same entry preserved');

  // Move has: bank 100 debit, receivable 60 credit, suspense 40 credit
  const rewrittenMove = read(db, MOVE_MODEL, initialBankMoveId);
  const bankLine = rewrittenMove.line_ids.find((l) => l.account_id === bankAccount.id);
  const recLine = rewrittenMove.line_ids.find((l) => l.account_id === receivableAccount);
  const suspLine = rewrittenMove.line_ids.find((l) => l.account_id === suspenseAccount.id);

  assert.equal(bankLine.debit, 100);
  assert.equal(recLine.credit, 60);
  assert.ok(suspLine, 'Suspense line remains for open balance');
  assert.equal(suspLine.credit, 40);

  // Invoice residual is 0
  const paidInvoice = read(db, MOVE_MODEL, invoice.id);
  assert.equal(paidInvoice.amount_residual, 0);

  assert.doesNotThrow(() => applyDiff(lineRes.db, diffDb(lineRes.db, db), { isAdmin: true }));
});

test('BANK-4: unreconciling restores suspense line on same move, unlinks matching, restores invoice, no reversals created', () => {
  const { db: baseDb, bankJournal, suspenseAccount, bankAccount } = setupBankTestDb();

  // Create invoice of 150
  const invRes = create(baseDb, MOVE_MODEL, {
    move_type: 'out_invoice',
    partner_id: 3,
    invoice_date: '2026-06-01',
    invoice_line_ids: [{ qty: 1, price_unit: 150, tax: 0 }],
  });
  let db = postMove(invRes.db, invRes.id);
  const invoice = read(db, MOVE_MODEL, invRes.id);

  // Statement line of 150
  const lineRes = create(db, LINE_MODEL, {
    journal_id: bankJournal.id,
    amount: 150,
    date: '2026-06-02',
    payment_ref: 'Inv 150 full match',
    company_id: 1,
  });
  db = lineRes.db;
  const initialBankMoveId = read(db, LINE_MODEL, lineRes.id).bank_move_id;

  // Reconcile
  db = reconcileWith(db, read(db, LINE_MODEL, lineRes.id), invoice.id);
  const reconciledLine = read(db, LINE_MODEL, lineRes.id);
  assert.equal(reconciledLine.state, 'reconciled');
  assert.equal(read(db, MOVE_MODEL, invoice.id).amount_residual, 0);

  const reconciledDb = db;

  // Unreconcile
  const unreconciled = unreconcile(db, reconciledLine);
  db = unreconciled.db;
  const afterLine = read(db, LINE_MODEL, lineRes.id);

  assert.equal(afterLine.state, 'to_check');
  assert.equal(afterLine.open_amount, 150);
  assert.equal(afterLine.bank_move_id, initialBankMoveId, 'Entry link is kept on statement line');
  assert.deepEqual(afterLine.allocations, []);

  // Check the entry lines: back to bank 150 debit vs suspense 150 credit
  const restoredMove = read(db, MOVE_MODEL, initialBankMoveId);
  const bankLine = restoredMove.line_ids.find((l) => l.account_id === bankAccount.id);
  const suspLine = restoredMove.line_ids.find((l) => l.account_id === suspenseAccount.id);
  assert.equal(bankLine.debit, 150);
  assert.equal(suspLine.credit, 150);
  assert.equal(restoredMove.line_ids.length, 2, 'Only bank and suspense lines remain');

  // Invoice residual is restored to 150
  const restoredInvoice = read(db, MOVE_MODEL, invoice.id);
  assert.equal(restoredInvoice.amount_residual, 150);

  // No reversal entries created!
  const reversalMoves = search(db, MOVE_MODEL).filter((m) => m.reversed_entry_id === initialBankMoveId);
  assert.equal(reversalMoves.length, 0, 'No reversing entries created when unreconciling');

  // diffDb + applyDiff succeeds
  assert.doesNotThrow(() => applyDiff(reconciledDb, diffDb(reconciledDb, db), { isAdmin: true }));
});

test('BANK-4: unreconciling a line matched to existing payment keeps the payment posted', () => {
  const { db: baseDb, bankJournal } = setupBankTestDb();

  // Create and confirm a payment of 100
  const payRes = create(baseDb, 'account.payment', {
    partner_id: 3,
    payment_type: 'inbound',
    partner_type: 'customer',
    amount: 100,
    date: '2026-06-01',
    journal_id: bankJournal.id,
  });
  let db = postPayment(payRes.db, read(payRes.db, 'account.payment', payRes.id));
  const payment = read(db, 'account.payment', payRes.id);
  assert.equal(payment.state, 'posted');

  // Statement line of 100
  const lineRes = create(db, LINE_MODEL, {
    journal_id: bankJournal.id,
    amount: 100,
    date: '2026-06-02',
    payment_ref: 'Match existing payment',
    company_id: 1,
  });
  db = lineRes.db;
  const initialBankMoveId = read(db, LINE_MODEL, lineRes.id).bank_move_id;

  // Match payment
  const lineWithPay = write(db, LINE_MODEL, lineRes.id, { payment_id: payment.id });
  const matched = matchPayment(lineWithPay, read(lineWithPay, LINE_MODEL, lineRes.id));
  db = applyDiff(lineWithPay, diffDb(lineWithPay, matched.db), { isAdmin: true });
  const matchedDb = db;
  const matchedLine = read(db, LINE_MODEL, lineRes.id);
  assert.equal(matchedLine.state, 'reconciled');

  // Unreconcile
  const unreconciled = unreconcile(db, matchedLine);
  db = unreconciled.db;

  const afterLine = read(db, LINE_MODEL, lineRes.id);
  assert.equal(afterLine.state, 'to_check');
  assert.equal(afterLine.bank_move_id, initialBankMoveId);

  // The matched payment keeps its posted state
  const afterPayment = read(db, 'account.payment', payment.id);
  assert.equal(afterPayment.state, 'posted', 'Existing payment must remain posted');

  assert.doesNotThrow(() => applyDiff(matchedDb, diffDb(matchedDb, db), { isAdmin: true }));
});

test('BANK-4: unreconciling refuses when entry is in locked period', () => {
  const { db: baseDb, bankJournal } = setupBankTestDb();

  // Create invoice and line
  const invRes = create(baseDb, MOVE_MODEL, {
    move_type: 'out_invoice',
    partner_id: 3,
    invoice_date: '2026-01-10',
    invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }],
  });
  let db = postMove(invRes.db, invRes.id);

  const lineRes = create(db, LINE_MODEL, {
    journal_id: bankJournal.id,
    amount: 100,
    date: '2026-01-15',
    payment_ref: 'Locked line',
    company_id: 1,
  });
  db = lineRes.db;
  db = reconcileWith(db, read(db, LINE_MODEL, lineRes.id), invRes.id);
  const reconciledLine = read(db, LINE_MODEL, lineRes.id);

  // Set lock date past the line date
  db = write(db, 'res.company', 1, { lock_date: '2026-01-31' });

  // Unreconcile must refuse
  assert.throws(() => {
    unreconcile(db, reconciledLine);
  }, /period up to 2026-01-31 is locked/i);
});

test('Migration: version 64 gives existing unreconciled statement lines their suspense entry while leaving reconciled and journal-less lines untouched', () => {
  const { db: baseDb, bankJournal, suspenseAccount, bankAccount } = setupBankTestDb();

  // Create an unreconciled line directly in records (simulating legacy data with schema_version: 61 and no bank_move_id)
  const legacyUnrecLine = {
    id: 991,
    journal_id: bankJournal.id,
    amount: 300,
    date: '2026-02-01',
    payment_ref: 'Legacy unrec line',
    company_id: 1,
    state: 'to_check',
    bank_move_id: null,
    open_amount: null,
  };

  const legacyRecLine = {
    id: 992,
    journal_id: bankJournal.id,
    amount: 50,
    date: '2026-02-01',
    payment_ref: 'Legacy rec line',
    company_id: 1,
    state: 'reconciled',
    bank_move_id: 888,
    open_amount: 0,
  };

  // Line with amount but no journal is left as it is (cannot book without a journal)
  const legacyNoJournalLine = {
    id: 993,
    journal_id: null,
    amount: 75,
    date: '2026-02-01',
    payment_ref: 'Legacy line without journal',
    company_id: 1,
    state: 'to_check',
    bank_move_id: null,
    open_amount: null,
  };

  let legacyDb = {
    ...baseDb,
    schema_version: 61,
    records: {
      ...baseDb.records,
      [LINE_MODEL]: [...(baseDb.records[LINE_MODEL] ?? []), legacyUnrecLine, legacyRecLine, legacyNoJournalLine],
    },
  };

  // Run migration
  const migratedDb = migrate(legacyDb, SCHEMA_VERSION);
  assert.equal(migratedDb.schema_version, 64);

  const migratedUnrec = read(migratedDb, LINE_MODEL, 991);
  assert.ok(migratedUnrec.bank_move_id, 'Migration gave unreconciled line a bank_move_id');
  assert.equal(migratedUnrec.open_amount, 300);

  const move = read(migratedDb, MOVE_MODEL, migratedUnrec.bank_move_id);
  assert.equal(move.state, 'posted');
  const bLine = move.line_ids.find((l) => l.account_id === bankAccount.id);
  const sLine = move.line_ids.find((l) => l.account_id === suspenseAccount.id);
  assert.equal(bLine.debit, 300);
  assert.equal(sLine.credit, 300);

  const migratedRec = read(migratedDb, LINE_MODEL, 992);
  assert.equal(migratedRec.bank_move_id, 888, 'Reconciled line left as it was');
  assert.equal(migratedRec.open_amount, 0);

  const migratedNoJournal = read(migratedDb, LINE_MODEL, 993);
  assert.equal(migratedNoJournal.bank_move_id, null, 'Journal-less line is left untouched without a bank entry');
  assert.equal(migratedNoJournal.open_amount, null);

  assert.doesNotThrow(() => applyDiff(legacyDb, diffDb(legacyDb, migratedDb), { isAdmin: true }));
});

test('BANK-3: directBank shortcut for statement lines is refused in payMove', () => {
  const { db: baseDb, bankJournal } = setupBankTestDb();

  const invRes = create(baseDb, MOVE_MODEL, {
    move_type: 'out_invoice',
    partner_id: 3,
    invoice_date: '2026-06-01',
    invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }],
  });
  let db = postMove(invRes.db, invRes.id);

  const lineRes = create(db, LINE_MODEL, {
    journal_id: bankJournal.id,
    amount: 100,
    date: '2026-06-02',
    payment_ref: 'Test directBank refusal',
    company_id: 1,
  });
  db = lineRes.db;

  assert.throws(() => {
    payMove(db, invRes.id, 100, '2026-06-02', {
      journalId: bankJournal.id,
      statementLineId: lineRes.id,
      directBank: true,
    });
  }, /direct bank/i);
});

test('moveGuard: general statement entry rewrites are rejected via diffDb + applyDiff', () => {
  const { db: baseDb, bankJournal, bankAccount } = setupBankTestDb();

  const otherAccountRes = create(baseDb, 'account.account', {
    name: 'Consulting Expense',
    code: '600123',
    account_type: 'expense',
    company_id: 1,
  });
  let db = otherAccountRes.db;
  const otherAccount = read(db, 'account.account', otherAccountRes.id);

  const lineRes = create(db, LINE_MODEL, {
    journal_id: bankJournal.id,
    amount: 100,
    date: '2026-06-01',
    payment_ref: 'Guard test line',
    company_id: 1,
  });
  db = lineRes.db;
  const line = read(db, LINE_MODEL, lineRes.id);
  const bankMove = read(db, MOVE_MODEL, line.bank_move_id);

  // A balanced counterpart substitution without reconciliation is rejected.
  const validRewrittenMove = {
    ...bankMove,
    line_ids: [
      bankMove.line_ids.find((l) => l.account_id === bankAccount.id),
      { account_id: otherAccount.id, debit: 0, credit: 100, name: 'Expense counterpart' },
    ],
  };
  const validDb = {
    ...db,
    records: {
      ...db.records,
      [MOVE_MODEL]: db.records[MOVE_MODEL].map((m) => (m.id === bankMove.id ? validRewrittenMove : m)),
    },
  };
  assert.throws(() => applyDiff(db, diffDb(db, validDb), { isAdmin: true }), /Posted entries cannot be edited/i);

  // 2. Refused rewrite: changing the bank liquidity line (e.g. debit 150 instead of 100)
  const invalidBankLineMove = {
    ...bankMove,
    line_ids: [
      { account_id: bankAccount.id, debit: 150, credit: 0, name: '/' },
      { account_id: otherAccount.id, debit: 0, credit: 150, name: 'Expense counterpart' },
    ],
  };
  const invalidBankDb = {
    ...db,
    records: {
      ...db.records,
      [MOVE_MODEL]: db.records[MOVE_MODEL].map((m) => (m.id === bankMove.id ? invalidBankLineMove : m)),
    },
  };
  assert.throws(
    () => applyDiff(db, diffDb(db, invalidBankDb), { isAdmin: true }),
    /Posted entries cannot be edited/i
  );

  // 3. Refused rewrite: unbalanced rewrite
  const unbalancedMove = {
    ...bankMove,
    line_ids: [
      bankMove.line_ids.find((l) => l.account_id === bankAccount.id),
      { account_id: otherAccount.id, debit: 0, credit: 80, name: 'Unbalanced counterpart' },
    ],
  };
  const unbalancedDb = {
    ...db,
    records: {
      ...db.records,
      [MOVE_MODEL]: db.records[MOVE_MODEL].map((m) => (m.id === bankMove.id ? unbalancedMove : m)),
    },
  };
  assert.throws(
    () => applyDiff(db, diffDb(db, unbalancedDb), { isAdmin: true }),
    /Posted entries cannot be edited/i
  );
});

test('a forged counterpart cannot accompany a reconciliation allocation', () => {
  const { db, bankJournal } = setupBankTestDb();
  const first = create(db, 'account.account', { name: 'Selected expense', code: '799810', account_type: 'expense', company_id: 1 });
  const second = create(first.db, 'account.account', { name: 'Other expense', code: '799811', account_type: 'expense', company_id: 1 });
  const line = create(second.db, LINE_MODEL, { journal_id: bankJournal.id, company_id: 1, date: '2026-06-01', payment_ref: 'Expense', amount: -100, counterpart_account_id: first.id });
  const matched = bookToAccount(line.db, read(line.db, LINE_MODEL, line.id)).db;
  const moveId = read(matched, LINE_MODEL, line.id).bank_move_id;
  const forged = { ...matched, records: { ...matched.records, [MOVE_MODEL]: matched.records[MOVE_MODEL].map((move) => move.id === moveId
    ? { ...move, line_ids: move.line_ids.map((item) => item.account_id === first.id ? { ...item, account_id: second.id } : item) } : move) } };
  assert.throws(() => applyDiff(line.db, diffDb(line.db, forged), { isAdmin: true }), /counterpart|match|reconcil/i);
  const splitForged = { ...matched, records: { ...matched.records, [MOVE_MODEL]: matched.records[MOVE_MODEL].map((move) => move.id === moveId
    ? { ...move, line_ids: move.line_ids.flatMap((item) => item.account_id === first.id
      ? [{ ...item, debit: 1 }, { ...item, account_id: second.id, debit: 99 }] : [item]) } : move) } };
  assert.throws(() => applyDiff(line.db, diffDb(line.db, splitForged), { isAdmin: true }), /counterpart|match|reconcil/i);
  const taxId = search(line.db, 'account.tax')[0].id;
  const forgedTax = { ...matched, records: { ...matched.records, [MOVE_MODEL]: matched.records[MOVE_MODEL].map((move) => move.id === moveId
    ? { ...move, line_ids: move.line_ids.flatMap((item) => item.account_id === first.id
      ? [{ ...item, debit: 1 }, { ...item, account_id: second.id, debit: 99, tax_id: taxId }] : [item]) } : move) } };
  assert.throws(() => applyDiff(line.db, diffDb(line.db, forgedTax), { isAdmin: true }), /counterpart|match|reconcil|tax/i);
});

test('a rule allocation cannot authorize substituted journal items', () => {
  const { db, bankJournal } = setupBankTestDb();
  const first = create(db, 'account.account', { name: 'Rule expense', code: '799812', account_type: 'expense', company_id: 1 });
  const second = create(first.db, 'account.account', { name: 'Unrelated expense', code: '799813', account_type: 'expense', company_id: 1 });
  const rule = create(second.db, 'account.reconcile.model', { name: 'Expense rule', rule_type: 'writeoff_button', line_ids: [{ account_id: first.id, amount_type: 'percentage', amount: 100 }] });
  const line = create(rule.db, LINE_MODEL, { journal_id: bankJournal.id, company_id: 1, date: '2026-06-01', payment_ref: 'Rule', amount: -100 });
  const matched = applyRule(line.db, read(line.db, 'account.reconcile.model', rule.id), read(line.db, LINE_MODEL, line.id));
  assert.doesNotThrow(() => applyDiff(line.db, diffDb(line.db, matched), { isAdmin: true }));
  const moveId = read(matched, LINE_MODEL, line.id).bank_move_id;
  const forged = { ...matched, records: { ...matched.records, [MOVE_MODEL]: matched.records[MOVE_MODEL].map((move) => move.id === moveId
    ? { ...move, line_ids: move.line_ids.map((item) => item.account_id === first.id ? { ...item, account_id: second.id } : item) } : move) } };
  assert.throws(() => applyDiff(line.db, diffDb(line.db, forged), { isAdmin: true }), /reconciliation model/i);
});

test('rule matching retains an account created while resolving suspense', () => {
  const { db, bankJournal, suspenseAccount } = setupBankTestDb();
  const expense = create(db, 'account.account', { name: 'Rule expense', code: '799814', account_type: 'expense', company_id: 1 });
  const rule = create(expense.db, 'account.reconcile.model', { name: 'Full rule', rule_type: 'writeoff_button', line_ids: [{ account_id: expense.id, amount_type: 'percentage', amount: 100 }] });
  const line = create(rule.db, LINE_MODEL, { journal_id: bankJournal.id, company_id: 1, date: '2026-06-01', payment_ref: 'Legacy rule', amount: -100 });
  const moveId = read(line.db, LINE_MODEL, line.id).bank_move_id;
  const futureId = (line.db.seq['account.account'] ?? 0) + 1;
  const legacy = { ...line.db, records: { ...line.db.records,
    'res.company': line.db.records['res.company'].map((company) => company.id === 1 ? { ...company, account_journal_suspense_account_id: null } : company),
    'account.journal': line.db.records['account.journal'].map((journal) => journal.id === bankJournal.id ? { ...journal, suspense_account_id: null } : journal),
    [MOVE_MODEL]: line.db.records[MOVE_MODEL].map((move) => move.id === moveId ? { ...move, line_ids: move.line_ids.map((item) => item.account_id === suspenseAccount.id ? { ...item, account_id: futureId } : item) } : move),
  } };
  const matched = applyRule(legacy, read(legacy, 'account.reconcile.model', rule.id), read(legacy, LINE_MODEL, line.id));
  assert.ok(read(matched, 'account.account', futureId));
  assert.equal(read(matched, LINE_MODEL, line.id).state, 'reconciled');
});

test('BANK-3 & BANK-6: multi-invoice reconcileWith rewrites suspense line on existing bank entry', () => {
  const { db: baseDb, bankJournal, bankAccount } = setupBankTestDb();

  // Create two customer invoices: 80 and 120 (total 200)
  const inv1Res = create(baseDb, MOVE_MODEL, {
    move_type: 'out_invoice',
    partner_id: 3,
    invoice_date: '2026-06-01',
    invoice_line_ids: [{ qty: 1, price_unit: 80, tax: 0 }],
  });
  let db = postMove(inv1Res.db, inv1Res.id);

  const inv2Res = create(db, MOVE_MODEL, {
    move_type: 'out_invoice',
    partner_id: 3,
    invoice_date: '2026-06-01',
    invoice_line_ids: [{ qty: 1, price_unit: 120, tax: 0 }],
  });
  db = postMove(inv2Res.db, inv2Res.id);

  // Statement line for 200
  const lineRes = create(db, LINE_MODEL, {
    journal_id: bankJournal.id,
    amount: 200,
    date: '2026-06-02',
    payment_ref: 'Multi-invoice match 200',
    company_id: 1,
  });
  db = lineRes.db;
  const initialLine = read(db, LINE_MODEL, lineRes.id);
  const initialBankMoveId = initialLine.bank_move_id;

  // Reconcile with both invoices
  db = reconcileWith(db, initialLine, [inv1Res.id, inv2Res.id]);
  const reconciledLine = read(db, LINE_MODEL, lineRes.id);

  assert.equal(reconciledLine.state, 'reconciled');
  assert.equal(reconciledLine.open_amount, 0);
  assert.equal(reconciledLine.bank_move_id, initialBankMoveId, 'Same entry is preserved');

  // Both invoices are paid
  assert.equal(read(db, MOVE_MODEL, inv1Res.id).amount_residual, 0);
  assert.equal(read(db, MOVE_MODEL, inv2Res.id).amount_residual, 0);

  // Bank entry has bank debit 200, and counterpart credit lines
  const move = read(db, MOVE_MODEL, initialBankMoveId);
  const bankLine = move.line_ids.find((l) => l.account_id === bankAccount.id);
  assert.equal(bankLine.debit, 200);

  assert.doesNotThrow(() => applyDiff(lineRes.db, diffDb(lineRes.db, db), { isAdmin: true }));
  const expense = search(db, 'account.account').find((account) => account.account_type === 'expense' && (account.company_id ?? 1) === 1);
  const forged = { ...db, records: { ...db.records, [MOVE_MODEL]: db.records[MOVE_MODEL].map((item) => item.id === move.id
    ? { ...item, line_ids: [...item.line_ids, { account_id: expense.id, debit: 1, credit: 0 }, { account_id: expense.id, debit: 0, credit: 1 }] } : item) } };
  assert.throws(() => applyDiff(lineRes.db, diffDb(lineRes.db, forged), { isAdmin: true }), /counterpart|match|reconcil/i);
});

test('BANK-3 & BANK-6: bookToAccount rewrites suspense line on existing bank entry', () => {
  const { db: baseDb, bankJournal, suspenseAccount, bankAccount } = setupBankTestDb();

  const expenseRes = create(baseDb, 'account.account', {
    name: 'Bank Fee Expense',
    code: '600555',
    account_type: 'expense',
    company_id: 1,
  });
  let db = expenseRes.db;
  const expenseAccount = read(db, 'account.account', expenseRes.id);

  // Statement line for -30 (fee)
  const lineRes = create(db, LINE_MODEL, {
    journal_id: bankJournal.id,
    amount: -30,
    date: '2026-06-02',
    payment_ref: 'Monthly fee',
    company_id: 1,
  });
  db = lineRes.db;
  const initialLine = read(db, LINE_MODEL, lineRes.id);
  const initialBankMoveId = initialLine.bank_move_id;

  // Set counterpart account and bookToAccount
  const withAcc = write(db, LINE_MODEL, initialLine.id, { counterpart_account_id: expenseAccount.id });
  const booked = bookToAccount(withAcc, read(withAcc, LINE_MODEL, initialLine.id));
  db = booked.db;

  const afterLine = read(db, LINE_MODEL, initialLine.id);
  assert.equal(afterLine.state, 'reconciled');
  assert.equal(afterLine.open_amount, 0);
  assert.equal(afterLine.bank_move_id, initialBankMoveId, 'Same entry is preserved');

  // Move has bank credit 30, fee expense debit 30, NO suspense line
  const move = read(db, MOVE_MODEL, initialBankMoveId);
  const bLine = move.line_ids.find((l) => l.account_id === bankAccount.id);
  const expLine = move.line_ids.find((l) => l.account_id === expenseAccount.id);
  const sLine = move.line_ids.find((l) => l.account_id === suspenseAccount.id);

  assert.equal(bLine.credit, 30);
  assert.equal(expLine.debit, 30);
  assert.equal(sLine, undefined, 'Suspense line replaced by expense counterpart');

  assert.doesNotThrow(() => applyDiff(lineRes.db, diffDb(lineRes.db, db), { isAdmin: true }));
});
