import { test } from 'node:test';
import { register } from 'node:module';
import assert from 'node:assert/strict';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

import { create, read, search, write, unlink } from './orm.js';
import { seed } from './seed.js';
import { models } from './models/index.js';
import { importStatement, importStatementLines } from './models/statements.js';
import { bookToAccount, reconcileWith } from './models/bank.js';
import { closeStatement, roundStatementAmount } from './models/bankstatement.js';
import { cashMove, postMove, putMoneyIn, takeMoneyOut } from './models/accounting.js';
import { applyDiff, diffDb } from './sync.js';
import { t } from './i18n.js';
import { find, setupDom } from './test-support/dom.js';

// -------------------------------------------------------------------------
// Helper: create a simple posted invoice
// -------------------------------------------------------------------------
function makeInvoice(db, { partnerId = 1, price = 200, companyId = 1, date = '2026-10-01' } = {}) {
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partnerId,
    company_id: companyId,
    invoice_date: date,
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: price, tax: 0 }],
  });
  const postedDb = postMove(inv.db, inv.id);
  return { db: postedDb, id: inv.id };
}

// -------------------------------------------------------------------------
// BANK-19: account.bank.statement model, fields, computed fields, and validation
// -------------------------------------------------------------------------

test('BANK-19: account.bank.statement model is registered and computes balance_end, is_complete, and is_valid', () => {
  let db = seed();
  assert.ok(models['account.bank.statement'], 'account.bank.statement must be registered in models');

  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  assert.ok(bankJournal, 'Bank journal must exist');

  // 1. Create first statement on the journal: is_valid must be true for first statement
  const stmt1Res = create(db, 'account.bank.statement', {
    name: 'STMT/2026/001',
    journal_id: bankJournal.id,
    date: '2026-04-01',
    balance_start: 100,
    balance_end_real: 250,
  });
  db = stmt1Res.db;
  let stmt1 = read(db, 'account.bank.statement', stmt1Res.id);
  assert.equal(stmt1.company_id, bankJournal.company_id ?? 1, 'company_id must be inherited from journal');
  assert.equal(stmt1.balance_end, 100, 'With no lines, balance_end equals balance_start');
  assert.equal(stmt1.is_complete, false, 'Incomplete because it has no lines and 100 !== 250');
  assert.equal(stmt1.is_valid, true, 'First statement is valid by definition');

  // 2. Add statement lines linking to statement 1
  const line1Res = create(db, 'account.bank.statement.line', {
    statement_id: stmt1.id,
    journal_id: bankJournal.id,
    company_id: bankJournal.company_id ?? 1,
    date: '2026-04-02',
    payment_ref: 'Customer transfer',
    amount: 150,
    state: 'to_check',
  });
  db = line1Res.db;

  stmt1 = read(db, 'account.bank.statement', stmt1.id);
  assert.equal(stmt1.balance_end, 250, 'balance_end is balance_start (100) + line amount (150) = 250');
  assert.equal(stmt1.is_complete, true, 'is_complete is true when balance_end === balance_end_real and lines exist');
  assert.equal(stmt1.line_ids.length, 1, 'line_ids contains the statement line');

  // 3. Create second statement on same journal with matching starting balance
  const stmt2Res = create(db, 'account.bank.statement', {
    name: 'STMT/2026/002',
    journal_id: bankJournal.id,
    date: '2026-04-10',
    balance_start: 250, // equals stmt1's balance_end_real
    balance_end_real: 300,
  });
  db = stmt2Res.db;
  const stmt2 = read(db, 'account.bank.statement', stmt2Res.id);
  assert.equal(stmt2.is_valid, true, 'Statement 2 is valid because balance_start matches statement 1 balance_end_real');

  // 4. Create third statement on same journal with non-matching starting balance (gap)
  const stmt3Res = create(db, 'account.bank.statement', {
    name: 'STMT/2026/003',
    journal_id: bankJournal.id,
    date: '2026-04-20',
    balance_start: 280, // does NOT equal stmt2's balance_end_real (300)
    balance_end_real: 400,
  });
  db = stmt3Res.db;
  const stmt3 = read(db, 'account.bank.statement', stmt3Res.id);
  assert.equal(stmt3.is_valid, false, 'Statement 3 is invalid because balance_start does not match previous statement ending balance');

  // Currency rounding helper verifies precision
  assert.equal(roundStatementAmount(db, stmt1, 123.456), 123.46);
});

test('BANK-19: guards enforce company and journal matching, line unlinking on delete, and editing rules', () => {
  let db = seed();
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  const cashJournal = search(db, 'account.journal').find((j) => j.type === 'cash' && (j.company_id ?? 1) === 1);

  const stmtRes = create(db, 'account.bank.statement', {
    name: 'STMT/BNK/01',
    journal_id: bankJournal.id,
    date: '2026-05-01',
    balance_start: 50,
    balance_end_real: 150,
  });
  db = stmtRes.db;

  // Guard: line must belong to the statement journal
  assert.throws(
    () => {
      create(db, 'account.bank.statement.line', {
        statement_id: stmtRes.id,
        journal_id: cashJournal.id, // mismatch!
        company_id: 1,
        date: '2026-05-01',
        payment_ref: 'Wrong journal line',
        amount: 100,
        state: 'to_check',
      });
    },
    /Statement lines must belong to the statement journal and company/
  );

  // Valid line creation
  const lineRes = create(db, 'account.bank.statement.line', {
    statement_id: stmtRes.id,
    journal_id: bankJournal.id,
    company_id: 1,
    date: '2026-05-01',
    payment_ref: 'Correct line',
    amount: 100,
    state: 'to_check',
  });
  db = lineRes.db;

  // Lines can also exist without a statement
  const standaloneLine = create(db, 'account.bank.statement.line', {
    journal_id: bankJournal.id,
    company_id: 1,
    date: '2026-05-02',
    payment_ref: 'No statement line',
    amount: 50,
    state: 'to_check',
  });
  assert.equal(read(standaloneLine.db, 'account.bank.statement.line', standaloneLine.id).statement_id ?? null, null);

  // Reconcile the line
  const inv = makeInvoice(db, { price: 100, date: '2026-04-15' });
  db = inv.db;
  db = reconcileWith(db, read(db, 'account.bank.statement.line', lineRes.id), inv.id);
  assert.equal(read(db, 'account.bank.statement.line', lineRes.id).state, 'reconciled');

  // A statement whose lines are reconciled can still be edited in balance fields
  const updatedStmtDb = write(db, 'account.bank.statement', stmtRes.id, {
    balance_start: 60,
    balance_end_real: 160,
  });
  assert.equal(read(updatedStmtDb, 'account.bank.statement', stmtRes.id).balance_start, 60);

  // But NOT in journal or company
  assert.throws(
    () => {
      write(db, 'account.bank.statement', stmtRes.id, {
        journal_id: cashJournal.id,
      });
    },
    /journal|company/i
  );

  // Deleting a statement that has reconciled lines is refused
  assert.throws(
    () => unlink(db, 'account.bank.statement', [stmtRes.id]),
    /Cannot delete a statement with reconciled lines/
  );

  // Unreconciled statement deletion unlinks its lines via ORM
  const stmtUnrec = create(db, 'account.bank.statement', {
    name: 'STMT/UNREC',
    journal_id: bankJournal.id,
    date: '2026-05-10',
    balance_start: 0,
    balance_end_real: 50,
  });
  let unrecDb = stmtUnrec.db;
  const unrecLine = create(unrecDb, 'account.bank.statement.line', {
    statement_id: stmtUnrec.id,
    journal_id: bankJournal.id,
    company_id: 1,
    date: '2026-05-10',
    payment_ref: 'Unreconciled line',
    amount: 50,
    state: 'to_check',
  });
  unrecDb = unrecLine.db;
  const unlinkedDb = unlink(unrecDb, 'account.bank.statement', [stmtUnrec.id]);
  const preservedLine = read(unlinkedDb, 'account.bank.statement.line', unrecLine.id);
  assert.equal(preservedLine.statement_id, null, 'Deleting statement unlinks its lines via ORM');
});

test('BANK-19: statement import (statements.js) creates one statement per imported file with balances', () => {
  let db = seed();
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  const defaults = { journal_id: bankJournal.id };

  // 1. CAMT with OPBD and CLBD balances
  const CAMT_WITH_BALANCES = `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt>
<Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="USD">500.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-05-01</Dt></Dt></Bal>
<Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="USD">650.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-05-02</Dt></Dt></Bal>
<Ntry><Amt Ccy="USD">150.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><BookgDt><Dt>2026-05-02</Dt></BookgDt><AcctSvcrRef>CAMT-B1</AcctSvcrRef><AddtlNtryInf>Wire transfer</AddtlNtryInf></Ntry>
</Stmt></BkToCstmrStmt></Document>`;

  const camtRes = importStatement(db, 'statement_may.xml', CAMT_WITH_BALANCES, defaults);
  assert.equal(camtRes.count, 1);
  db = camtRes.db;

  const stmts = search(db, 'account.bank.statement').filter((s) => s.journal_id === bankJournal.id);
  assert.ok(stmts.length >= 1, 'Statement must be created by importStatement');
  const camtStmt = stmts.find((s) => s.name === 'statement_may.xml');
  assert.ok(camtStmt, 'Statement with file name must exist');
  assert.equal(camtStmt.balance_start, 500, 'balance_start extracted from OPBD');
  assert.equal(camtStmt.balance_end_real, 650, 'balance_end_real extracted from CLBD');
  assert.equal(camtStmt.balance_end, 650, 'Computed balance_end is 500 + 150 = 650');
  assert.equal(camtStmt.is_complete, true, 'Statement is complete');
  assert.equal(camtStmt.is_valid, true, 'First statement is valid');

  const importedLine = search(db, 'account.bank.statement.line').find((l) => l.unique_import_id === 'CAMT-B1');
  assert.equal(importedLine.statement_id, camtStmt.id, 'Imported line must link to the created statement');

  // Re-importing duplicate transactions must be a no-op: returns count 0, creates no orphan statement
  const stmtCountBefore = search(db, 'account.bank.statement').length;
  const dupRes = importStatement(db, 'statement_may.xml', CAMT_WITH_BALANCES, defaults);
  assert.equal(dupRes.count, 0, 'Duplicate import returns count 0');
  assert.equal(search(dupRes.db, 'account.bank.statement').length, stmtCountBefore, 'No orphan statement created on duplicate import');

  // 2. OFX without explicit balance tags: gets balance_start from previous statement (650) and computed end
  const OFX_WITHOUT_BALANCES = `OFXHEADER:100
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD<BANKTRANLIST>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260505<TRNAMT>100.00<FITID>OFX-B2<NAME>Client payment</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

  const ofxRes = importStatement(db, 'statement_next.ofx', OFX_WITHOUT_BALANCES, defaults);
  assert.equal(ofxRes.count, 1);
  db = ofxRes.db;

  const ofxStmt = search(db, 'account.bank.statement').find((s) => s.name === 'statement_next.ofx');
  assert.ok(ofxStmt, 'OFX statement record must be created');
  assert.equal(ofxStmt.balance_start, 650, 'balance_start inherited from previous statement balance_end_real (650)');
  assert.equal(ofxStmt.balance_end, 750, 'Computed balance_end is 650 + 100 = 750');
  assert.equal(ofxStmt.balance_end_real, 750, 'balance_end_real defaulted from computed end');
  assert.equal(ofxStmt.is_complete, true, 'is_complete is true');
  assert.equal(ofxStmt.is_valid, true, 'is_valid is true');

  // 3. Verify importStatementLines returns line_ids
  const linesDirect = importStatementLines(db, [{ date: '2026-05-06', amount: 25, payment_ref: 'Direct test line' }], defaults);
  assert.equal(linesDirect.count, 1);
  assert.ok(Array.isArray(linesDirect.line_ids) && linesDirect.line_ids.length === 1);
});

// -------------------------------------------------------------------------
// BANK-18: Cash Control on Cash Journals (Put Money In / Take Money Out)
// -------------------------------------------------------------------------

test('BANK-18: cashMove, Put Money In and Take Money Out create statement lines on cash journal', () => {
  let db = seed();
  const cashJournal = search(db, 'account.journal').find((j) => j.type === 'cash' && (j.company_id ?? 1) === 1);
  assert.ok(cashJournal, 'Cash journal must exist');

  // 1. cashMove directly
  const moveRes = cashMove(db, cashJournal.id, { amount: 300, label: 'Float transfer' }, 1);
  assert.equal(read(moveRes.db, 'account.bank.statement.line', moveRes.id).amount, 300);

  // 2. Put Money In creates a positive statement line in to_check
  const putRes = putMoneyIn(db, cashJournal.id, { amount: 200, label: 'Opening cash float' });
  db = putRes.db;
  const putLine = read(db, 'account.bank.statement.line', putRes.id);
  assert.equal(putLine.amount, 200);
  assert.equal(putLine.payment_ref, 'Opening cash float');
  assert.equal(putLine.journal_id, cashJournal.id);
  assert.equal(putLine.state, 'to_check');

  // Reconcile via bookToAccount (manual operation path)
  const expenseAccount = search(db, 'account.account').find((a) => a.code === '600000' && (a.company_id ?? 1) === 1);
  const bookedPutDb = bookToAccount(db, {
    ...putLine,
    counterpart_account_id: expenseAccount.id,
  }, { amount: 200, label: 'Float reconciled' }).db;
  assert.equal(read(bookedPutDb, 'account.bank.statement.line', putLine.id).state, 'reconciled');

  // 3. Take Money Out creates a negative statement line in to_check
  const takeRes = takeMoneyOut(db, cashJournal.id, { amount: 50, label: 'Bank safe deposit' });
  db = takeRes.db;
  const takeLine = read(db, 'account.bank.statement.line', takeRes.id);
  assert.equal(takeLine.amount, -50);
  assert.equal(takeLine.payment_ref, 'Bank safe deposit');
  assert.equal(takeLine.journal_id, cashJournal.id);
  assert.equal(takeLine.state, 'to_check');

  // 4. Validation: rejects non-cash journal or non-positive amount
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank');
  assert.throws(() => putMoneyIn(db, bankJournal.id, { amount: 100 }), /cash journal/i);
  assert.throws(() => putMoneyIn(db, cashJournal.id, { amount: -10 }), /amount/i);
});

test('BANK-18: Closing a cash statement posts count difference to profit_account_id or loss_account_id and guards closed statement', () => {
  let db = seed();
  const cashJournal = search(db, 'account.journal').find((j) => j.type === 'cash' && (j.company_id ?? 1) === 1);

  // Set explicit profit and loss accounts on the cash journal (never chosen by code/name)
  const profitAccount = search(db, 'account.account').find((a) => a.code === '450000' && (a.company_id ?? 1) === 1);
  const lossAccount = search(db, 'account.account').find((a) => a.code === '690000' && (a.company_id ?? 1) === 1);
  db = write(db, 'account.journal', cashJournal.id, {
    profit_account_id: profitAccount.id,
    loss_account_id: lossAccount.id,
  });

  // Case A: Surplus: balance_end_real (170) > balance_end (150) -> diff +20
  const stmtSurplusRes = create(db, 'account.bank.statement', {
    name: 'CSH-STMT/01',
    journal_id: cashJournal.id,
    date: '2026-06-01',
    balance_start: 100,
    balance_end_real: 170, // $20 surplus over 100 + 50
  });
  db = stmtSurplusRes.db;
  const lineA = create(db, 'account.bank.statement.line', {
    statement_id: stmtSurplusRes.id,
    journal_id: cashJournal.id,
    company_id: 1,
    date: '2026-06-01',
    payment_ref: 'Daily sales cash',
    amount: 50,
    state: 'to_check',
  });
  db = lineA.db;

  const closedSurplusDb = closeStatement(db, stmtSurplusRes.id);
  const closedSurplusStmt = read(closedSurplusDb, 'account.bank.statement', stmtSurplusRes.id);
  assert.equal(closedSurplusStmt.state, 'closed');
  assert.equal(closedSurplusStmt.balance_end, 170, 'Ending balance adjusted to 170 after posting surplus');
  assert.equal(closedSurplusStmt.is_complete, true, 'Statement is now complete');

  // Verify difference line was created and booked to profit_account_id
  const surplusLines = search(closedSurplusDb, 'account.bank.statement.line').filter((l) => l.statement_id === stmtSurplusRes.id);
  assert.equal(surplusLines.length, 2);
  const diffSurplusLine = surplusLines.find((l) => l.id !== lineA.id);
  assert.equal(diffSurplusLine.amount, 20);
  assert.equal(diffSurplusLine.counterpart_account_id, profitAccount.id);
  assert.equal(diffSurplusLine.state, 'reconciled');
  assert.ok(diffSurplusLine.move_id, 'Difference line has a posted entry');

  // Closed statement guard checks:
  // 1. Refuse modifying balances, journal, date
  assert.throws(
    () => write(closedSurplusDb, 'account.bank.statement', stmtSurplusRes.id, { balance_start: 999 }),
    /A closed statement cannot be modified/
  );
  assert.throws(
    () => write(closedSurplusDb, 'account.bank.statement', stmtSurplusRes.id, { date: '2026-09-01' }),
    /A closed statement cannot be modified/
  );
  // 2. Refuse reopening
  assert.throws(
    () => write(closedSurplusDb, 'account.bank.statement', stmtSurplusRes.id, { state: 'open' }),
    /A closed statement cannot be reopened/
  );
  // 3. Refuse deleting closed statement
  assert.throws(
    () => unlink(closedSurplusDb, 'account.bank.statement', [stmtSurplusRes.id]),
    /A closed statement cannot be deleted/
  );
  // 4. Refuse adding new lines to a closed statement
  assert.throws(
    () => create(closedSurplusDb, 'account.bank.statement.line', {
      statement_id: stmtSurplusRes.id,
      journal_id: cashJournal.id,
      company_id: 1,
      date: '2026-06-01',
      payment_ref: 'Late line',
      amount: 10,
      state: 'to_check',
    }),
    /Cannot add lines to a closed statement/
  );
  // 5. Refuse editing existing lines linked to closed statement
  assert.throws(
    () => write(closedSurplusDb, 'account.bank.statement.line', lineA.id, { amount: 60 }),
    /Cannot change lines linked to a closed statement/
  );
  // 6. Refuse removing lines from closed statement
  assert.throws(
    () => write(closedSurplusDb, 'account.bank.statement.line', lineA.id, { statement_id: null }),
    /Cannot remove lines from a closed statement/
  );

  // Case B: Shortage: balance_end_real (130) < balance_end (150) -> diff -20
  const stmtShortageRes = create(closedSurplusDb, 'account.bank.statement', {
    name: 'CSH-STMT/02',
    journal_id: cashJournal.id,
    date: '2026-06-02',
    balance_start: 170,
    balance_end_real: 190, // computed would be 170 + 40 = 210 -> $20 shortage
  });
  db = stmtShortageRes.db;
  const lineB = create(db, 'account.bank.statement.line', {
    statement_id: stmtShortageRes.id,
    journal_id: cashJournal.id,
    company_id: 1,
    date: '2026-06-02',
    payment_ref: 'Daily sales cash 2',
    amount: 40,
    state: 'to_check',
  });
  db = lineB.db;

  const closedShortageDb = closeStatement(db, stmtShortageRes.id);
  const closedShortageStmt = read(closedShortageDb, 'account.bank.statement', stmtShortageRes.id);
  assert.equal(closedShortageStmt.state, 'closed');
  assert.equal(closedShortageStmt.balance_end, 190);
  assert.equal(closedShortageStmt.is_complete, true);

  const shortageLines = search(closedShortageDb, 'account.bank.statement.line').filter((l) => l.statement_id === stmtShortageRes.id);
  assert.equal(shortageLines.length, 2);
  const diffShortageLine = shortageLines.find((l) => l.id !== lineB.id);
  assert.equal(diffShortageLine.amount, -20);
  assert.equal(diffShortageLine.counterpart_account_id, lossAccount.id);
  assert.equal(diffShortageLine.state, 'reconciled');

  // Case C: Clear failure when profit or loss account is missing
  const journalWithoutAccounts = write(db, 'account.journal', cashJournal.id, {
    profit_account_id: null,
    loss_account_id: null,
  });
  assert.throws(
    () => closeStatement(journalWithoutAccounts, stmtShortageRes.id),
    /profit|loss/i
  );
});

test('BANK-18 & BANK-19: guards replay cleanly through diffDb + applyDiff', () => {
  let db = seed();
  const cashJournal = search(db, 'account.journal').find((j) => j.type === 'cash' && (j.company_id ?? 1) === 1);
  const profitAccount = search(db, 'account.account').find((a) => a.code === '450000' && (a.company_id ?? 1) === 1);
  const lossAccount = search(db, 'account.account').find((a) => a.code === '690000' && (a.company_id ?? 1) === 1);

  db = write(db, 'account.journal', cashJournal.id, {
    profit_account_id: profitAccount.id,
    loss_account_id: lossAccount.id,
  });

  // 1. Create statement and line through diffDb + applyDiff
  const stmtRes = create(db, 'account.bank.statement', {
    name: 'DIFF-TEST/01',
    journal_id: cashJournal.id,
    date: '2026-07-01',
    balance_start: 0,
    balance_end_real: 100,
  });
  db = applyDiff(db, diffDb(db, stmtRes.db), { isAdmin: true });

  const lineRes = create(db, 'account.bank.statement.line', {
    statement_id: stmtRes.id,
    journal_id: cashJournal.id,
    company_id: 1,
    date: '2026-07-01',
    payment_ref: 'Cash in',
    amount: 80,
    state: 'to_check',
  });
  db = applyDiff(db, diffDb(db, lineRes.db), { isAdmin: true });

  // 2. Close statement with $20 difference through diffDb + applyDiff
  const closedDb = closeStatement(db, stmtRes.id);
  db = applyDiff(db, diffDb(db, closedDb), { isAdmin: true });

  const finalStmt = read(db, 'account.bank.statement', stmtRes.id);
  assert.equal(finalStmt.state, 'closed');
  assert.equal(finalStmt.balance_end, 100);
  assert.equal(finalStmt.is_complete, true);
});

// -------------------------------------------------------------------------
// View tests: BankReconcile.jsx and Dashboard.jsx
// -------------------------------------------------------------------------

test('BANK-19 & BANK-18: BankReconcile shows statement details, badges, and statement filter', async () => {
  const { makeEl } = setupDom();
  const { BankReconcile } = await import('./views/BankReconcile.jsx');
  const React = await import('react');
  const ReactDOM = await import('react-dom/client');
  const { act } = await import('react');

  let db = seed();
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank');

  // Statement with non-matching balance_end_real (incomplete)
  const stmtRes = create(db, 'account.bank.statement', {
    name: 'STMT-VIEW-01',
    journal_id: bankJournal.id,
    date: '2026-08-01',
    balance_start: 100,
    balance_end_real: 300,
  });
  db = stmtRes.db;

  const lineRes = create(db, 'account.bank.statement.line', {
    statement_id: stmtRes.id,
    journal_id: bankJournal.id,
    company_id: 1,
    date: '2026-08-01',
    payment_ref: 'View test line',
    amount: 50,
    state: 'to_check',
  });
  db = lineRes.db;
  const { initStore, commit } = await import('./store.js');
  await initStore();
  await commit(db);

  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = ReactDOM.createRoot(host);

  try {
    await act(async () => {
      root.render(React.createElement(BankReconcile));
    });
    await act(async () => {});

    // Verify statement filter exists in control panel
    const statementSelect = find(host, (n) => n.tagName === 'SELECT' && n.options?.some((o) => o.textContent?.includes('STMT-VIEW-01')));
    assert.ok(statementSelect, 'Statement filter dropdown must exist');

    // Verify statement information and "Incomplete" badge are rendered
    const text = host.textContent;
    assert.ok(text.includes('STMT-VIEW-01'), 'Selected line statement name rendered');
    assert.ok(text.includes(t('Incomplete')) || text.includes('Incomplete'), 'Incomplete badge rendered');

    // Verify badge classes are used without inline styles
    const badgeEl = find(host, (n) => n.className?.includes('badge-warning'));
    assert.ok(badgeEl, 'Badge with class badge-warning is rendered');
    assert.equal(badgeEl.style?.color ?? '', '', 'No inline style color on badge');
  } finally {
    await act(async () => {
      root.unmount();
    });
  }
});

test('BANK-18: Dashboard cash journal card renders Put Money In and Take Money Out links to journal form', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { Dashboard } = await import('./views/Dashboard.jsx');
  const React = await import('react');
  const { initStore, commit } = await import('./store.js');

  let db = seed();
  const cashJournal = search(db, 'account.journal').find((j) => j.type === 'cash');
  await initStore();
  await commit(db);

  const html = renderToStaticMarkup(React.createElement(Dashboard));
  assert.match(html, /Put Money In|إيداع أموال/, 'Put Money In link exists on dashboard cash card');
  assert.match(html, /Take Money Out|سحب أموال/, 'Take Money Out link exists on dashboard cash card');
  assert.match(html, new RegExp(`#/open/account\\.journal/${cashJournal.id}`), 'Links point directly to the cash journal form');
});
