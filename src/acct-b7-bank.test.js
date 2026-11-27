import test from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { create, read, search, unlink, write } from './orm.js';
import { postMove, payMove } from './models/accounting.js';
import { postPayment } from './models/pay.js';
import { reconcileWith, matchPayment, unreconcile, bookToAccount, paymentOutstandingAccountId } from './models/bank.js';
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

test('sync rejects unallocated bank entry substitutions with partner or state changes', () => {
  const { db, bankJournal, suspenseAccount } = setupBankTestDb();
  const account = create(db, 'account.account', { name: 'Other expense', code: '600999', account_type: 'expense', company_id: 1 });
  const created = create(account.db, LINE_MODEL, { journal_id: bankJournal.id, company_id: 1, date: '2026-05-01', payment_ref: 'Deposit', amount: 100 });
  const line = read(created.db, LINE_MODEL, created.id);
  const move = read(created.db, MOVE_MODEL, line.bank_move_id);
  for (const changes of [{ partner_id: 3, state: 'reconciled', move_id: move.id, open_amount: null }, { state: 'reconciled', move_id: move.id, open_amount: null }]) {
    const partner = changes.partner_id ?? null;
    const forgedMove = { ...move, ...(changes.partner_id ? { partner_id: partner } : {}), line_ids: move.line_ids.map((item) => ({ ...item, ...(changes.partner_id ? { partner_id: partner } : {}), account_id: item.account_id === suspenseAccount.id ? account.id : item.account_id })) };
    const forged = { ...created.db, records: { ...created.db.records, [LINE_MODEL]: created.db.records[LINE_MODEL].map((item) => item.id === line.id ? { ...item, ...changes } : item), [MOVE_MODEL]: created.db.records[MOVE_MODEL].map((item) => item.id === move.id ? forgedMove : item) } };
    assert.throws(() => applyDiff(created.db, diffDb(created.db, forged), { isAdmin: true }));
  }
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

test('deleting a statement detaches its untouched booked transactions', () => {
  const { db, bankJournal } = setupBankTestDb();
  const statement = create(db, 'account.bank.statement', { name: 'Statement', journal_id: bankJournal.id, company_id: 1, date: '2026-05-01' });
  const created = create(statement.db, LINE_MODEL, { statement_id: statement.id, journal_id: bankJournal.id, company_id: 1, date: '2026-05-01', payment_ref: 'Deposit', amount: 100 });
  const bankMoveId = read(created.db, LINE_MODEL, created.id).bank_move_id;
  const result = unlink(created.db, 'account.bank.statement', [statement.id]);
  assert.equal(read(result, 'account.bank.statement', statement.id), undefined);
  assert.equal(read(result, LINE_MODEL, created.id).statement_id, null);
  assert.equal(read(result, LINE_MODEL, created.id).bank_move_id, bankMoveId);
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

test('migration records booking failures and continues with other statement lines', () => {
  const { db, bankJournal, bankAccount } = setupBankTestDb();
  const invalidJournal = { ...bankJournal, id: 90002, suspense_account_id: bankAccount.id };
  const foreign = search(db, 'res.currency').find((currency) => currency.id !== read(db, 'res.company', 1).currency_id);
  const noRate = { ...foreign, rate_ids: [] };
  const lines = [
    { id: 90003, journal_id: invalidJournal.id, company_id: 1, date: '1900-01-01', payment_ref: 'Invalid', amount: 10, state: 'to_check' },
    { id: 90004, journal_id: bankJournal.id, company_id: 1, currency_id: foreign.id, date: '1900-01-01', payment_ref: 'Foreign', amount: 20, open_amount: 20, state: 'to_check' },
    { id: 90005, journal_id: bankJournal.id, company_id: 1, date: '2026-05-01', payment_ref: 'Valid', amount: 30, state: 'to_check' },
  ];
  const legacy = { ...db, schema_version: 80, records: { ...db.records, 'account.journal': [...db.records['account.journal'], invalidJournal], 'res.currency': db.records['res.currency'].map((c) => c.id === noRate.id ? noRate : c), [LINE_MODEL]: [...db.records[LINE_MODEL], ...lines] } };
  const migrated = migrate(legacy);
  assert.ok(!read(migrated, LINE_MODEL, 90003).bank_move_id);
  assert.ok(!read(migrated, LINE_MODEL, 90004).bank_move_id);
  assert.ok(read(migrated, LINE_MODEL, 90005).bank_move_id);
  assert.ok(migrated.messages.some((message) => message.res_id === 90003));
  assert.ok(migrated.messages.some((message) => message.model === LINE_MODEL && message.res_id === 90004 && /historical currency rate.*unavailable/i.test(message.body)));
  assert.deepEqual(read(migrated, LINE_MODEL, 90004), lines[1]);
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

test('Migration: version 66 gives existing unreconciled statement lines their suspense entry while leaving reconciled and journal-less lines untouched', () => {
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
  assert.equal(migratedDb.schema_version, 81);

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

test('legacy invoice match restores its payment move to bank suspense', () => {
  const { db: base, bankJournal, suspenseAccount } = setupBankTestDb();
  const journal = create(base, 'account.journal', { name: 'Legacy Direct', code: 'LDR', type: 'bank', company_id: 1, default_account_id: bankJournal.default_account_id, suspense_account_id: suspenseAccount.id, outstanding_receipts_account_id: null, outstanding_payments_account_id: null });
  const invoice = create(journal.db, MOVE_MODEL, { move_type: 'out_invoice', partner_id: 3, invoice_date: '2026-06-01', invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }] });
  let db = postMove(invoice.db, invoice.id);
  db = payMove(db, invoice.id, 100, '2026-06-02', { journalId: journal.id });
  const payment = search(db, 'account.payment').find((item) => item.invoice_id === invoice.id);
  assert.ok(payment?.move_id);
  const line = { id: 90006, journal_id: journal.id, company_id: 1, date: '2026-06-02', payment_ref: 'Legacy', amount: 100, state: 'reconciled', move_id: invoice.id, bank_move_id: payment.move_id, open_amount: 0, allocations: [{ invoice_id: invoice.id, payment_move_id: payment.move_id, amount: 100 }] };
  db = { ...db, records: { ...db.records, [LINE_MODEL]: [...db.records[LINE_MODEL], line] } };
  const released = unreconcile(db, line).db;
  const result = read(released, LINE_MODEL, line.id);
  assert.equal(result.state, 'to_check');
  assert.equal(result.bank_move_id, payment.move_id);
  assert.equal(result.open_amount, 100);
  assert.ok(read(released, MOVE_MODEL, payment.move_id).line_ids.some((item) => item.account_id === suspenseAccount.id && item.credit === 100));
  assert.ok(read(released, MOVE_MODEL, invoice.id).payments.every((row) => row.reversed));
  assert.doesNotThrow(() => applyDiff(db, diffDb(db, released), { isAdmin: true }));
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

test('full coverage rule applies analytic defaults and requires mandatory plans', () => {
  const { db: base, bankJournal } = setupBankTestDb();
  const enabled = write(base, 'res.company', 1, { group_analytic_accounting: true });
  const plan = create(enabled, 'account.analytic.plan', { name: 'Rule allocation', default_applicability: 'mandatory' });
  const analytic = create(plan.db, 'account.analytic.account', { name: 'Rule cost', plan_id: plan.id });
  const expense = search(analytic.db, 'account.account').find((account) => account.code === '600000');
  const rule = create(analytic.db, 'account.reconcile.model', { name: 'Full expense', rule_type: 'writeoff_button', line_ids: [{ account_id: expense.id, amount_type: 'percentage', amount: 100 }] });
  const line = create(rule.db, LINE_MODEL, { journal_id: bankJournal.id, company_id: 1, date: '2026-06-01', payment_ref: 'Rule fee', amount: -100 });
  assert.throws(() => applyRule(line.db, read(line.db, 'account.reconcile.model', rule.id), read(line.db, LINE_MODEL, line.id)), /mandatory.*Rule allocation/i);
  const configured = create(line.db, 'account.analytic.distribution.model', { account_prefix: expense.code, company_id: 1, analytic_distribution: { [analytic.id]: 100 } }).db;
  const booked = applyRule(configured, read(configured, 'account.reconcile.model', rule.id), read(configured, LINE_MODEL, line.id));
  const moveId = read(booked, LINE_MODEL, line.id).bank_move_id;
  assert.deepEqual(read(booked, MOVE_MODEL, moveId).line_ids.find((item) => item.account_id === expense.id).analytic_distribution, { [analytic.id]: 100 });
  assert.ok(search(booked, 'account.analytic.line').some((item) => item.move_id === moveId && item.account_id === analytic.id));
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

test('manual bank booking applies analytic defaults and enforces mandatory plans', () => {
  const { db: base, bankJournal } = setupBankTestDb();
  const expense = search(base, 'account.account').find((account) => account.code === '600000');
  const enabled = write(base, 'res.company', 1, { group_analytic_accounting: true });
  const plan = create(enabled, 'account.analytic.plan', { name: 'Bank allocation', default_applicability: 'mandatory' });
  const analytic = create(plan.db, 'account.analytic.account', { name: 'Bank cost', plan_id: plan.id });
  const line = create(analytic.db, LINE_MODEL, { journal_id: bankJournal.id, company_id: 1, date: '2026-06-02', payment_ref: 'Fee', amount: -30 });
  const withAccount = write(line.db, LINE_MODEL, line.id, { counterpart_account_id: expense.id });
  assert.throws(() => bookToAccount(withAccount, read(withAccount, LINE_MODEL, line.id)), /mandatory.*Bank allocation/i);
  const configured = create(withAccount, 'account.analytic.distribution.model', { account_prefix: expense.code, company_id: 1, analytic_distribution: { [analytic.id]: 100 } }).db;
  const booked = bookToAccount(configured, read(configured, LINE_MODEL, line.id)).db;
  const moveId = read(booked, LINE_MODEL, line.id).bank_move_id;
  assert.deepEqual(read(booked, MOVE_MODEL, moveId).line_ids.find((item) => item.account_id === expense.id).analytic_distribution, { [analytic.id]: 100 });
  assert.ok(search(booked, 'account.analytic.line').some((item) => item.move_id === moveId && item.account_id === analytic.id));
});

test('Changing journal or company suspense account is allowed while open lines exist and does not strand already booked statement lines', () => {
  const { db: baseDb, bankJournal, suspenseAccount, bankAccount } = setupBankTestDb();

  // Create a second suspense account
  const newSuspRes = create(baseDb, 'account.account', {
    name: 'New Suspense Account',
    code: '101409',
    account_type: 'asset_current',
    company_id: 1,
    reconcile: true,
  });
  let db = newSuspRes.db;
  const newSuspense = read(db, 'account.account', newSuspRes.id);

  // Create two booked statement lines on bankJournal (booked against suspenseAccount)
  const line1Res = create(db, LINE_MODEL, {
    journal_id: bankJournal.id,
    amount: 100,
    date: '2026-06-05',
    payment_ref: 'Line 1 before suspense change',
    company_id: 1,
  });
  const line2Res = create(line1Res.db, LINE_MODEL, {
    journal_id: bankJournal.id,
    amount: 80,
    date: '2026-06-05',
    payment_ref: 'Line 2 before suspense change',
    company_id: 1,
  });
  db = line2Res.db;

  // Changing company suspense account while fallback journal has open lines succeeds (Odoo 20)
  const fallbackJournalDb = {
    ...db,
    records: {
      ...db.records,
      'account.journal': db.records['account.journal'].map((j) => (j.id === bankJournal.id ? { ...j, suspense_account_id: null } : j)),
    },
  };
  const companyChangedDb = write(fallbackJournalDb, 'res.company', 1, { account_journal_suspense_account_id: newSuspense.id });
  assert.equal(read(companyChangedDb, 'res.company', 1).account_journal_suspense_account_id, newSuspense.id);
  assert.doesNotThrow(() => applyDiff(fallbackJournalDb, diffDb(fallbackJournalDb, companyChangedDb), { isAdmin: true }));

  // Changing journal suspense_account_id while open booked lines exist also succeeds (Odoo 20)
  const shiftedConfigDb = write(db, 'account.journal', bankJournal.id, { suspense_account_id: newSuspense.id });
  assert.equal(read(shiftedConfigDb, 'account.journal', bankJournal.id).suspense_account_id, newSuspense.id);
  assert.doesNotThrow(() => applyDiff(db, diffDb(db, shiftedConfigDb), { isAdmin: true }));

  // New lines created after the change book to the new suspense account
  const newLineRes = create(shiftedConfigDb, LINE_MODEL, {
    journal_id: bankJournal.id,
    amount: 40,
    date: '2026-06-06',
    payment_ref: 'Line after suspense change',
    company_id: 1,
  });
  const newMove = read(newLineRes.db, MOVE_MODEL, read(newLineRes.db, LINE_MODEL, newLineRes.id).bank_move_id);
  assert.ok(newMove.line_ids.some((l) => l.account_id === newSuspense.id && l.credit === 40), 'New line uses updated suspense account');

  // 1. Editing partner_id on line 1 succeeds and passes diffDb + applyDiff
  const edited = write(newLineRes.db, LINE_MODEL, line1Res.id, { partner_id: 3 });
  assert.equal(read(edited, LINE_MODEL, line1Res.id).partner_id, 3);
  assert.doesNotThrow(() => applyDiff(newLineRes.db, diffDb(newLineRes.db, edited), { isAdmin: true }));

  // 2. Reconciling line 1 with an invoice replaces the historical suspense line cleanly without leaving an unbalanced old suspense line
  const invRes = create(edited, MOVE_MODEL, {
    move_type: 'out_invoice',
    partner_id: 3,
    invoice_date: '2026-06-05',
    invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }],
  });
  let matchDb = postMove(invRes.db, invRes.id);
  const beforeReconcileDb = matchDb;
  matchDb = reconcileWith(matchDb, read(matchDb, LINE_MODEL, line1Res.id), invRes.id);
  const move1 = read(matchDb, MOVE_MODEL, read(matchDb, LINE_MODEL, line1Res.id).bank_move_id);
  assert.equal(move1.line_ids.find((l) => l.account_id === suspenseAccount.id), undefined, 'Old suspense line was removed');
  assert.equal(move1.line_ids.find((l) => l.account_id === bankAccount.id).debit, 100);
  assert.doesNotThrow(() => applyDiff(beforeReconcileDb, diffDb(beforeReconcileDb, matchDb), { isAdmin: true }));

  // 3. Deleting untouched line 2 succeeds and reverses its entry
  const deletedDb = unlink(matchDb, LINE_MODEL, [line2Res.id]);
  assert.equal(read(deletedDb, LINE_MODEL, line2Res.id), undefined);
  assert.doesNotThrow(() => applyDiff(matchDb, diffDb(matchDb, deletedDb), { isAdmin: true }));
});

test('Migration: version 66 tolerates to_check statement lines whose journal has no default_account_id', () => {
  const { db: baseDb } = setupBankTestDb();
  const incompleteJournal = {
    id: 850,
    name: 'Unconfigured Bank',
    code: 'UBK',
    type: 'bank',
    default_account_id: null,
    suspense_account_id: null,
    company_id: 1,
  };
  const unbookedLine = {
    id: 995,
    journal_id: 850,
    amount: 120,
    date: '2026-02-01',
    payment_ref: 'Unconfigured journal line',
    company_id: null,
    state: 'to_check',
    bank_move_id: null,
    open_amount: null,
  };
  const legacyDb = {
    ...baseDb,
    schema_version: 61,
    records: {
      ...baseDb.records,
      'account.journal': [...(baseDb.records['account.journal'] ?? []), incompleteJournal],
      [LINE_MODEL]: [...(baseDb.records[LINE_MODEL] ?? []), unbookedLine],
    },
  };

  const migratedDb = migrate(legacyDb, SCHEMA_VERSION);
  const migratedLine = read(migratedDb, LINE_MODEL, 995);
  assert.equal(migratedLine.bank_move_id, null);
  assert.equal(migratedLine.company_id, 1);
  assert.equal(migratedLine.open_amount, 120);
});

test('Migration: foreign-currency unconfigured statement line without a rate is preserved with inferred company', () => {
  const base = seed();
  const eur = search(base, 'res.currency').find((c) => c.name === 'EUR');
  const baseCurrId = base.settings.base_currency_id;
  const eurNoRate = write(base, 'res.currency', eur.id, { rate_ids: [] });
  const gbp = create(eurNoRate, 'res.currency', { name: 'GBP', rate_ids: [{ date: '2026-01-01', rate: 0.5 }] });
  const company = createCompanyWithDefaultInvoiceJournals(gbp.db, { name: 'No-Rate Co', currency_id: baseCurrId });
  const unconfiguredJournal = {
    id: 851,
    name: 'Unconfigured EUR Bank',
    code: 'UEUR',
    type: 'bank',
    default_account_id: null,
    suspense_account_id: null,
    currency_id: eur.id,
    company_id: company.id,
  };
  const unconfiguredRatedJournal = {
    id: 852,
    name: 'Unconfigured GBP Bank',
    code: 'UGBP',
    type: 'bank',
    default_account_id: null,
    suspense_account_id: null,
    currency_id: gbp.id,
    company_id: company.id,
  };
  const lineNoOpen = {
    id: 996,
    journal_id: 851,
    amount: 100,
    date: '2026-02-01',
    payment_ref: 'Foreign line without rate or open_amount',
    company_id: null,
    state: 'to_check',
    bank_move_id: null,
  };
  const lineWithOpen = {
    id: 997,
    journal_id: 851,
    amount: 200,
    date: '2026-02-01',
    payment_ref: 'Foreign line without rate with open_amount',
    company_id: null,
    state: 'to_check',
    bank_move_id: null,
    open_amount: 42,
  };
  const lineWithRate = {
    id: 998,
    journal_id: 852,
    amount: 50,
    date: '2026-02-01',
    payment_ref: 'Foreign line with rate but no bank account',
    company_id: null,
    state: 'to_check',
    bank_move_id: null,
  };
  const legacyDb = {
    ...company.db,
    schema_version: 61,
    records: {
      ...company.db.records,
      'account.journal': [...(company.db.records['account.journal'] ?? []), unconfiguredJournal, unconfiguredRatedJournal],
      [LINE_MODEL]: [...(company.db.records[LINE_MODEL] ?? []), lineNoOpen, lineWithOpen, lineWithRate],
    },
  };

  const migratedDb = migrate(legacyDb, SCHEMA_VERSION);
  assert.equal(migratedDb.schema_version, 81);

  const migratedNoOpen = read(migratedDb, LINE_MODEL, 996);
  assert.equal(migratedNoOpen.bank_move_id, null);
  assert.equal(migratedNoOpen.company_id, company.id);
  assert.equal(migratedNoOpen.open_amount, undefined);

  const migratedWithOpen = read(migratedDb, LINE_MODEL, 997);
  assert.equal(migratedWithOpen.bank_move_id, null);
  assert.equal(migratedWithOpen.company_id, company.id);
  assert.equal(migratedWithOpen.open_amount, 42);
  for (const id of [996, 997]) {
    assert.ok(migratedDb.messages.some((message) => message.model === LINE_MODEL && message.res_id === id && /historical currency rate.*unavailable/i.test(message.body)));
  }

  const migratedWithRate = read(migratedDb, LINE_MODEL, 998);
  assert.equal(migratedWithRate.bank_move_id, null);
  assert.equal(migratedWithRate.company_id, company.id);
  assert.equal(migratedWithRate.open_amount, 100);

  assert.doesNotThrow(() => applyDiff(legacyDb, diffDb(legacyDb, migratedDb), { isAdmin: true }));
});

test('Unreconciling a line matched to a direct payment unlinks without attempting to reverse the payment entry', () => {
  const { db: baseDb, bankJournal } = setupBankTestDb();

  // Create a bank journal without outstanding accounts so payments are direct
  const directJournalRes = create(baseDb, 'account.journal', {
    name: 'Direct Bank',
    code: 'DIR',
    type: 'bank',
    default_account_id: bankJournal.default_account_id,
    suspense_account_id: bankJournal.suspense_account_id,
    outstanding_receipts_account_id: null,
    outstanding_payments_account_id: null,
    company_id: 1,
  });
  let db = directJournalRes.db;
  const directJournal = read(db, 'account.journal', directJournalRes.id);

  // Create and post a direct customer payment
  const payRes = create(db, 'account.payment', {
    partner_id: 3,
    payment_type: 'inbound',
    partner_type: 'customer',
    amount: 150,
    date: '2026-06-03',
    journal_id: directJournal.id,
  });
  db = postPayment(payRes.db, read(payRes.db, 'account.payment', payRes.id));
  const directPayment = read(db, 'account.payment', payRes.id);
  assert.equal(directPayment.state, 'posted');
  assert.equal(paymentOutstandingAccountId(db, directPayment), null);

  // Directly matched line whose bank_move_id is the direct payment move
  const directLine = {
    id: 994,
    journal_id: directJournal.id,
    amount: 150,
    date: '2026-06-03',
    payment_ref: 'Direct matched line',
    company_id: 1,
    state: 'reconciled',
    move_id: directPayment.move_id,
    payment_id: directPayment.id,
    payment_ids: [directPayment.id],
    bank_move_id: null,
    open_amount: 0,
    allocations: [],
  };
  db = {
    ...db,
    records: {
      ...db.records,
      [LINE_MODEL]: [...(db.records[LINE_MODEL] ?? []), directLine],
    },
  };
  const matchedDb = db;
  const reconciledLine = read(db, LINE_MODEL, directLine.id);

  // Unreconcile
  const unreconciled = unreconcile(db, reconciledLine);
  db = unreconciled.db;

  const afterLine = read(db, LINE_MODEL, directLine.id);
  assert.equal(afterLine.state, 'to_check');
  assert.equal(afterLine.bank_move_id, null);
  assert.equal(afterLine.move_id, null);
  assert.equal(afterLine.payment_id, null);

  // The direct payment remains posted and unreversed
  const afterPayment = read(db, 'account.payment', directPayment.id);
  assert.equal(afterPayment.state, 'posted');
  const reversalMoves = search(db, MOVE_MODEL).filter((m) => m.reversed_entry_id === directPayment.move_id);
  assert.equal(reversalMoves.length, 0, 'No reversal move created for direct payment');

  assert.doesNotThrow(() => applyDiff(matchedDb, diffDb(matchedDb, db), { isAdmin: true }));
});

