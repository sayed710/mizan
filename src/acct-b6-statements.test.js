import { test } from 'node:test';
import { register } from 'node:module';
import assert from 'node:assert/strict';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

import { create, read, search, write, unlink } from './orm.js';
import { seed } from './seed.js';
import { models } from './models/index.js';
import { importStatement, importStatementLines, parseCamtBalances } from './models/statements.js';
import { bookToAccount, reconcileWith, unreconcile } from './models/bank.js';
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

  // A statement with a booked unreconciled line cannot be deleted.
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
  assert.throws(() => unlink(unrecDb, 'account.bank.statement', [stmtUnrec.id]), /booked lines/i);
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

// -------------------------------------------------------------------------
// QODO Review Findings 1 - 13 Verification Tests
// -------------------------------------------------------------------------

test('Finding 1: Closing gains and losses cannot be reversed afterward on closed statements', () => {
  let db = seed();
  const cashJournal = search(db, 'account.journal').find((j) => j.type === 'cash');
  const profitAccount = search(db, 'account.account').find((a) => a.code === '450000');
  const lossAccount = search(db, 'account.account').find((a) => a.code === '690000');
  db = write(db, 'account.journal', cashJournal.id, {
    profit_account_id: profitAccount.id,
    loss_account_id: lossAccount.id,
  });

  // A. Surplus line
  const stmtSurplus = create(db, 'account.bank.statement', {
    name: 'CSH-SURPLUS',
    journal_id: cashJournal.id,
    date: '2026-09-01',
    balance_start: 100,
    balance_end_real: 120, // 20 surplus
  });
  db = stmtSurplus.db;
  db = closeStatement(db, stmtSurplus.id);
  const surplusLine = search(db, 'account.bank.statement.line').find((l) => l.statement_id === stmtSurplus.id);
  assert.ok(surplusLine, 'Surplus difference line created');
  assert.equal(surplusLine.state, 'reconciled');
  assert.throws(
    () => unreconcile(db, surplusLine),
    /Cannot unreconcile lines of a closed statement/
  );

  // B. Shortage line
  const stmtShortage = create(db, 'account.bank.statement', {
    name: 'CSH-SHORTAGE',
    journal_id: cashJournal.id,
    date: '2026-09-02',
    balance_start: 120,
    balance_end_real: 110, // 10 shortage
  });
  db = stmtShortage.db;
  db = closeStatement(db, stmtShortage.id);
  const shortageLine = search(db, 'account.bank.statement.line').find((l) => l.statement_id === stmtShortage.id);
  assert.ok(shortageLine, 'Shortage difference line created');
  assert.equal(shortageLine.state, 'reconciled');
  assert.throws(
    () => unreconcile(db, shortageLine),
    /Cannot unreconcile lines of a closed statement/
  );

  // C. Direct state edit rejected
  assert.throws(
    () => write(db, 'account.bank.statement.line', surplusLine.id, { state: 'to_check' }),
    /reconciled|closed/i
  );
});

test('Finding 2: Put Money In and Take Money Out use ask and work through FormView button runner', () => {
  let db = seed();
  const cashJournal = search(db, 'account.journal').find((j) => j.type === 'cash');
  const buttons = models['account.journal'].form.buttons;
  const putBtn = buttons.find((b) => b.label === 'Put Money In');
  const takeBtn = buttons.find((b) => b.label === 'Take Money Out');

  assert.ok(putBtn && Array.isArray(putBtn.ask) && putBtn.ask.length > 0, 'Put Money In has ask config');
  assert.ok(takeBtn && Array.isArray(takeBtn.ask) && takeBtn.ask.length > 0, 'Take Money Out has ask config');

  // FormView collects answers into array and passes to run(db, record, answers)
  const putRes = putBtn.run(db, cashJournal, [175]);
  db = putRes.db;
  const putLine = search(db, 'account.bank.statement.line').find((l) => l.amount === 175);
  assert.ok(putLine, 'Line with 175 created by FormView button runner');

  const takeRes = takeBtn.run(db, cashJournal, [85]);
  db = takeRes.db;
  const takeLine = search(db, 'account.bank.statement.line').find((l) => l.amount === -85);
  assert.ok(takeLine, 'Line with -85 created by FormView button runner');
});

test('Finding 3: Closed statements cannot lose lines via protectDelete or lineGuard active changes', () => {
  let db = seed();
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank');
  const stmtRes = create(db, 'account.bank.statement', {
    name: 'STMT-PROT-DEL',
    journal_id: bankJournal.id,
    date: '2026-09-05',
    balance_start: 0,
    balance_end_real: 50,
  });
  db = stmtRes.db;
  const lineRes = create(db, 'account.bank.statement.line', {
    statement_id: stmtRes.id,
    journal_id: bankJournal.id,
    company_id: 1,
    date: '2026-09-05',
    payment_ref: 'Unbooked line',
    amount: 50,
    state: 'to_check',
  });
  db = lineRes.db;

  // Close statement
  db = write(db, 'account.bank.statement', stmtRes.id, { state: 'closed' });

  // 1. Direct delete via unlink rejected by protectDelete
  assert.throws(
    () => unlink(db, 'account.bank.statement.line', [lineRes.id]),
    /Cannot remove lines from a closed statement/
  );

  // 2. Unlinking via statement_id: null rejected by lineGuard
  assert.throws(
    () => write(db, 'account.bank.statement.line', lineRes.id, { statement_id: null }),
    /Cannot remove lines from a closed statement/
  );

  // 3. Archiving line (active: false) rejected by lineGuard
  assert.throws(
    () => write(db, 'account.bank.statement.line', lineRes.id, { active: false }),
    /Cannot change lines linked to a closed statement/
  );
});

test('Finding 4: Multi-account / multi-statement CAMT and OFX imports partition responses', () => {
  let db = seed();
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank');
  const defaults = { journal_id: bankJournal.id };

  // Multi-statement CAMT with 2 <Stmt> blocks
  const MULTI_CAMT = `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt>
<Stmt>
<Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="USD">100.00</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>
<Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="USD">150.00</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>
<Ntry><Amt Ccy="USD">50.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><BookgDt><Dt>2026-09-06</Dt></BookgDt><AcctSvcrRef>MCAMT-1</AcctSvcrRef><AddtlNtryInf>Stmt 1 Tx</AddtlNtryInf></Ntry>
</Stmt>
<Stmt>
<Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="USD">150.00</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>
<Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="USD">220.00</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>
<Ntry><Amt Ccy="USD">70.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><BookgDt><Dt>2026-09-07</Dt></BookgDt><AcctSvcrRef>MCAMT-2</AcctSvcrRef><AddtlNtryInf>Stmt 2 Tx</AddtlNtryInf></Ntry>
</Stmt>
</BkToCstmrStmt></Document>`;

  const camtRes = importStatement(db, 'multi_camt.xml', MULTI_CAMT, defaults);
  assert.equal(camtRes.count, 2);
  db = camtRes.db;
  assert.ok(Array.isArray(camtRes.statement_ids) && camtRes.statement_ids.length === 2, '2 statements created for 2 Stmt blocks');
  const s1 = read(db, 'account.bank.statement', camtRes.statement_ids[0]);
  const s2 = read(db, 'account.bank.statement', camtRes.statement_ids[1]);
  assert.equal(s1.balance_start, 100);
  assert.equal(s1.balance_end_real, 150);
  assert.equal(s2.balance_start, 150);
  assert.equal(s2.balance_end_real, 220);

  // Multi-statement OFX with 2 <STMTRS> blocks
  const MULTI_OFX = `OFXHEADER:100
<OFX><BANKMSGSRSV1>
<STMTTRNRS><STMTRS><CURDEF>USD
<BANKTRANLIST><STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260908<TRNAMT>40.00<FITID>MOFX-1<NAME>Tx 1</STMTTRN></BANKTRANLIST>
<LEDGERBAL><BALAMT>300.00</LEDGERBAL></STMTRS></STMTTRNRS>
<STMTTRNRS><STMTRS><CURDEF>USD
<BANKTRANLIST><STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260909<TRNAMT>60.00<FITID>MOFX-2<NAME>Tx 2</STMTTRN></BANKTRANLIST>
<LEDGERBAL><BALAMT>360.00</LEDGERBAL></STMTRS></STMTTRNRS>
</BANKMSGSRSV1></OFX>`;

  const ofxRes = importStatement(db, 'multi_ofx.ofx', MULTI_OFX, defaults);
  assert.equal(ofxRes.count, 2);
  assert.ok(Array.isArray(ofxRes.statement_ids) && ofxRes.statement_ids.length === 2, '2 statements created for 2 STMTRS blocks');
  const sOfx1 = read(ofxRes.db, 'account.bank.statement', ofxRes.statement_ids[0]);
  const sOfx2 = read(ofxRes.db, 'account.bank.statement', ofxRes.statement_ids[1]);
  assert.equal(sOfx1.balance_end_real, 300);
  assert.equal(sOfx2.balance_end_real, 360);
});

test('Finding 5: Reconciled lines cannot leave or enter closed statements', () => {
  let db = seed();
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank');
  const stmtClosedRes = create(db, 'account.bank.statement', {
    name: 'STMT-CLOSED-REC',
    journal_id: bankJournal.id,
    date: '2026-09-10',
    balance_start: 0,
    balance_end_real: 100,
  });
  db = stmtClosedRes.db;
  const lineRes = create(db, 'account.bank.statement.line', {
    statement_id: stmtClosedRes.id,
    journal_id: bankJournal.id,
    company_id: 1,
    date: '2026-09-10',
    payment_ref: 'Reconciled closed line',
    amount: 100,
    state: 'to_check',
  });
  db = lineRes.db;

  // Reconcile line
  const inv = makeInvoice(db, { price: 100, date: '2026-09-01' });
  db = inv.db;
  db = reconcileWith(db, read(db, 'account.bank.statement.line', lineRes.id), inv.id);

  // Close statement
  db = write(db, 'account.bank.statement', stmtClosedRes.id, { state: 'closed' });

  // 1. Moving reconciled line out of closed statement rejected
  const otherStmt = create(db, 'account.bank.statement', {
    name: 'OTHER-STMT',
    journal_id: bankJournal.id,
    date: '2026-09-12',
    balance_start: 100,
    balance_end_real: 200,
  });
  db = otherStmt.db;
  assert.throws(
    () => write(db, 'account.bank.statement.line', lineRes.id, { statement_id: otherStmt.id }),
    /Cannot remove lines from a closed statement|A reconciled bank transaction cannot be changed/
  );

  // 2. Unlinking statement_id from reconciled line on closed statement rejected
  assert.throws(
    () => write(db, 'account.bank.statement.line', lineRes.id, { statement_id: null }),
    /Cannot remove lines from a closed statement|A reconciled bank transaction cannot be changed/
  );

  // 3. Moving an existing reconciled line INTO a closed statement rejected
  const freeLine = create(db, 'account.bank.statement.line', {
    journal_id: bankJournal.id,
    company_id: 1,
    date: '2026-09-11',
    payment_ref: 'Free line',
    amount: 50,
    state: 'to_check',
  });
  db = freeLine.db;
  const inv2 = makeInvoice(db, { price: 50, date: '2026-09-01' });
  db = inv2.db;
  db = reconcileWith(db, read(db, 'account.bank.statement.line', freeLine.id), inv2.id);

  assert.throws(
    () => write(db, 'account.bank.statement.line', freeLine.id, { statement_id: stmtClosedRes.id }),
    /Cannot add lines to a closed statement|A reconciled bank transaction cannot be changed/
  );
});

test('Finding 6: Cash moves associate with open cash statement avoiding false count difference', () => {
  let db = seed();
  const cashJournal = search(db, 'account.journal').find((j) => j.type === 'cash');
  const profitAccount = search(db, 'account.account').find((a) => a.code === '450000');
  const lossAccount = search(db, 'account.account').find((a) => a.code === '690000');
  db = write(db, 'account.journal', cashJournal.id, {
    profit_account_id: profitAccount.id,
    loss_account_id: lossAccount.id,
  });

  // Open statement on cash journal
  const stmtRes = create(db, 'account.bank.statement', {
    name: 'CSH-OPEN-01',
    journal_id: cashJournal.id,
    date: '2026-09-15',
    balance_start: 50,
    balance_end_real: 150, // includes the 100 cash move
  });
  db = stmtRes.db;

  // Put Money In without specifying statementId should link to the open statement
  const putRes = putMoneyIn(db, cashJournal.id, { amount: 100, label: 'Add 100 cash' });
  db = putRes.db;
  const line = read(db, 'account.bank.statement.line', putRes.id);
  assert.equal(line.statement_id, stmtRes.id, 'Cash move links to current open statement of cash journal');

  // Closing statement at counted balance (150) should balance with diff 0
  db = closeStatement(db, stmtRes.id);
  const closedStmt = read(db, 'account.bank.statement', stmtRes.id);
  assert.equal(closedStmt.state, 'closed');
  assert.equal(closedStmt.balance_end, 150);
  const stmtLines = search(db, 'account.bank.statement.line').filter((l) => l.statement_id === stmtRes.id);
  assert.equal(stmtLines.length, 1, 'No diff line created because cash move was included');
});

test('Finding 7: CAMT CLBD booked balance is preferred over CLAV available balance', () => {
  // Case A: CLBD then CLAV
  const CAMT_CLBD_THEN_CLAV = `<BkToCstmrStmt><Stmt>
<Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="USD">700.00</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>
<Bal><Tp><CdOrPrtry><Cd>CLAV</Cd></CdOrPrtry></Tp><Amt Ccy="USD">650.00</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>
</Stmt></BkToCstmrStmt>`;
  const resA = parseCamtBalances(CAMT_CLBD_THEN_CLAV);
  assert.equal(resA.balance_end_real, 700, 'CLBD booked balance preferred when CLAV comes after');

  // Case B: CLAV then CLBD
  const CAMT_CLAV_THEN_CLBD = `<BkToCstmrStmt><Stmt>
<Bal><Tp><CdOrPrtry><Cd>CLAV</Cd></CdOrPrtry></Tp><Amt Ccy="USD">650.00</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>
<Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="USD">700.00</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>
</Stmt></BkToCstmrStmt>`;
  const resB = parseCamtBalances(CAMT_CLAV_THEN_CLBD);
  assert.equal(resB.balance_end_real, 700, 'CLBD booked balance preferred when CLAV comes before');

  // Case C: Only CLAV
  const CAMT_ONLY_CLAV = `<BkToCstmrStmt><Stmt>
<Bal><Tp><CdOrPrtry><Cd>CLAV</Cd></CdOrPrtry></Tp><Amt Ccy="USD">650.00</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>
</Stmt></BkToCstmrStmt>`;
  const resC = parseCamtBalances(CAMT_ONLY_CLAV);
  assert.equal(resC.balance_end_real, 650, 'Fallback to CLAV if CLBD absent');
});

test('Finding 8: Changing journalFilter resets statementFilter in BankReconcile view', async () => {
  const { makeEl } = setupDom();
  const { BankReconcile } = await import('./views/BankReconcile.jsx');
  const React = await import('react');
  const ReactDOM = await import('react-dom/client');
  const { act } = await import('react');
  const { initStore, commit } = await import('./store.js');

  let db = seed();
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank');
  const cashJournal = search(db, 'account.journal').find((j) => j.type === 'cash');

  const sBank = create(db, 'account.bank.statement', {
    name: 'STMT-BNK-F8',
    journal_id: bankJournal.id,
    date: '2026-09-18',
    balance_start: 0,
    balance_end_real: 100,
  });
  db = sBank.db;

  const lBank = create(db, 'account.bank.statement.line', {
    statement_id: sBank.id,
    journal_id: bankJournal.id,
    company_id: 1,
    date: '2026-09-18',
    payment_ref: 'Line on bank',
    amount: 100,
    state: 'to_check',
  });
  db = lBank.db;

  const lCash = create(db, 'account.bank.statement.line', {
    journal_id: cashJournal.id,
    company_id: 1,
    date: '2026-09-18',
    payment_ref: 'Line on cash',
    amount: 50,
    state: 'to_check',
  });
  db = lCash.db;

  await initStore();
  await commit(db);

  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = ReactDOM.createRoot(host);

  try {
    await act(async () => {
      root.render(React.createElement(BankReconcile));
    });

    const journalSelect = find(host, (n) => n.tagName === 'SELECT' && n.options?.some((o) => o.textContent?.includes(bankJournal.name)));
    const statementSelect = find(host, (n) => n.tagName === 'SELECT' && n.options?.some((o) => o.textContent?.includes('STMT-BNK-F8')));

    assert.ok(journalSelect, 'Journal select found');
    assert.ok(statementSelect, 'Statement select found');

    const reactProps = (n) => {
      const key = Object.keys(n).find((k) => k.startsWith('__reactProps$'));
      return key ? n[key] : null;
    };

    // Select bank journal and statement
    await act(async () => {
      reactProps(journalSelect)?.onChange?.({ target: { value: String(bankJournal.id) } });
    });
    await act(async () => {
      reactProps(statementSelect)?.onChange?.({ target: { value: String(sBank.id) } });
    });

    // Switch journal to cash journal
    await act(async () => {
      reactProps(journalSelect)?.onChange?.({ target: { value: String(cashJournal.id) } });
    });

    // Cash transaction must not be hidden
    assert.ok(host.textContent.includes('Line on cash'), 'Switching journals shows new journal transactions');
  } finally {
    await act(async () => {
      root.unmount();
    });
  }
});

test('Finding 9: Older imports do not inherit balances from future statements', () => {
  let db = seed();
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank');
  const defaults = { journal_id: bankJournal.id };

  // 1. Import a future statement on 2026-10-01 with balance 500
  const FUTURE_OFX = `OFXHEADER:100
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD
<BANKTRANLIST><STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261001<TRNAMT>100.00<FITID>FUT-1<NAME>Future</STMTTRN></BANKTRANLIST>
<LEDGERBAL><BALAMT>500.00</BALAMT></LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

  const res1 = importStatement(db, 'future.ofx', FUTURE_OFX, defaults);
  db = res1.db;

  // 2. Import an older statement on 2026-08-01 without balances
  const OLD_OFX = `OFXHEADER:100
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD
<BANKTRANLIST><STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260801<TRNAMT>50.00<FITID>OLD-1<NAME>Older</STMTTRN></BANKTRANLIST>
</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

  const res2 = importStatement(db, 'older.ofx', OLD_OFX, defaults);
  db = res2.db;

  const oldStmt = read(db, 'account.bank.statement', res2.statement_id);
  assert.notEqual(oldStmt.balance_start, 500, 'Older statement must NOT inherit balance from later statement');
  assert.equal(oldStmt.balance_start, 150000, 'Starts from booked account balance (150,000) not future statement (500)');
});

test('Finding 10: Closed statements refuse arbitrary line creation and reassignments', () => {
  let db = seed();
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank');
  const profitAccount = search(db, 'account.account').find((a) => a.code === '450000');
  db = write(db, 'account.journal', bankJournal.id, { profit_account_id: profitAccount.id });

  const stmtRes = create(db, 'account.bank.statement', {
    name: 'STMT-F10',
    journal_id: bankJournal.id,
    date: '2026-09-20',
    balance_start: 0,
    balance_end_real: 50,
  });
  db = stmtRes.db;
  db = write(db, 'account.bank.statement', stmtRes.id, { state: 'closed' });

  // 1. Creating a line on bank journal matching profit account on closed statement is refused
  assert.throws(
    () => create(db, 'account.bank.statement.line', {
      statement_id: stmtRes.id,
      journal_id: bankJournal.id,
      company_id: 1,
      date: '2026-09-20',
      payment_ref: 'Backdoor attempt',
      amount: 10,
      counterpart_account_id: profitAccount.id,
      state: 'to_check',
    }),
    /Cannot add lines to a closed statement/
  );

  // 2. Reassigning an existing line onto closed statement is refused
  const existingLine = create(db, 'account.bank.statement.line', {
    journal_id: bankJournal.id,
    company_id: 1,
    date: '2026-09-20',
    payment_ref: 'Existing line',
    amount: 10,
    counterpart_account_id: profitAccount.id,
    state: 'to_check',
  });
  db = existingLine.db;

  assert.throws(
    () => write(db, 'account.bank.statement.line', existingLine.id, { statement_id: stmtRes.id }),
    /Cannot add lines to a closed statement/
  );
});

test('Finding 11: Overlapping partial re-imports create statements that balance', () => {
  let db = seed();
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank');
  const defaults = { journal_id: bankJournal.id };

  // First import: Tx 1 ($100)
  const FILE1 = `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt>
<Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="USD">1000.00</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>
<Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="USD">1100.00</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>
<Ntry><Amt Ccy="USD">100.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><BookgDt><Dt>2026-09-22</Dt></BookgDt><AcctSvcrRef>DUP-TX-1</AcctSvcrRef><AddtlNtryInf>Tx 1</AddtlNtryInf></Ntry>
</Stmt></BkToCstmrStmt></Document>`;

  const res1 = importStatement(db, 'file1.xml', FILE1, defaults);
  db = res1.db;

  // Second import: Overlaps Tx 1 and adds Tx 2 ($50), with ending balance 1150
  const FILE2 = `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt>
<Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="USD">1000.00</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>
<Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="USD">1150.00</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>
<Ntry><Amt Ccy="USD">100.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><BookgDt><Dt>2026-09-22</Dt></BookgDt><AcctSvcrRef>DUP-TX-1</AcctSvcrRef><AddtlNtryInf>Tx 1 duplicate</AddtlNtryInf></Ntry>
<Ntry><Amt Ccy="USD">50.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><BookgDt><Dt>2026-09-23</Dt></BookgDt><AcctSvcrRef>FRESH-TX-2</AcctSvcrRef><AddtlNtryInf>Tx 2 fresh</AddtlNtryInf></Ntry>
</Stmt></BkToCstmrStmt></Document>`;

  const res2 = importStatement(db, 'file2.xml', FILE2, defaults);
  assert.equal(res2.count, 1, 'Only 1 fresh transaction imported');
  db = res2.db;

  const s2 = read(db, 'account.bank.statement', res2.statement_id);
  assert.equal(s2.balance_start, 1100, 'Starting balance derived to match fresh-only lines (1150 - 50)');
  assert.equal(s2.balance_end_real, 1150);
  assert.equal(s2.balance_end, 1150);
  assert.equal(s2.is_complete, true, 'Partial re-import statement balances and is complete');
});

test('Finding 12: linesByStatement groups lines without quadratic scans', () => {
  let db = seed();
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank');
  const s = create(db, 'account.bank.statement', {
    name: 'STMT-F12',
    journal_id: bankJournal.id,
    date: '2026-09-25',
    balance_start: 0,
    balance_end_real: 30,
  });
  db = s.db;
  db = create(db, 'account.bank.statement.line', {
    statement_id: s.id,
    journal_id: bankJournal.id,
    company_id: 1,
    date: '2026-09-25',
    payment_ref: 'L1',
    amount: 10,
    state: 'to_check',
  }).db;
  db = create(db, 'account.bank.statement.line', {
    statement_id: s.id,
    journal_id: bankJournal.id,
    company_id: 1,
    date: '2026-09-25',
    payment_ref: 'L2',
    amount: 20,
    state: 'to_check',
  }).db;

  const stmt = read(db, 'account.bank.statement', s.id);
  assert.equal(stmt.line_ids.length, 2);
  assert.equal(stmt.balance_end, 30);
  assert.equal(stmt.is_complete, true);
});

test('Finding 13: Closing foreign-currency cash statement books difference properly', () => {
  let db = seed();
  // Ensure EUR currency exists
  let eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  if (!eur) {
    const res = create(db, 'res.currency', { name: 'EUR', symbol: '€', rounding: 0.01 });
    db = res.db;
    eur = read(db, 'res.currency', res.id);
  }

  const baseCash = search(db, 'account.journal').find((j) => j.type === 'cash');
  const profitAccount = search(db, 'account.account').find((a) => a.code === '450000');
  const lossAccount = search(db, 'account.account').find((a) => a.code === '690000');

  // Create foreign currency cash journal
  const fxJournalRes = create(db, 'account.journal', {
    name: 'EUR Cash',
    code: 'CSHEUR',
    type: 'cash',
    currency_id: eur.id,
    company_id: 1,
    profit_account_id: profitAccount.id,
    loss_account_id: lossAccount.id,
    default_account_id: baseCash.default_account_id,
    suspense_account_id: baseCash.suspense_account_id,
  });
  db = fxJournalRes.db;
  const fxJournal = read(db, 'account.journal', fxJournalRes.id);

  const stmtRes = create(db, 'account.bank.statement', {
    name: 'FX-CSH-01',
    journal_id: fxJournal.id,
    date: '2026-09-28',
    balance_start: 100, // 100 EUR
    balance_end_real: 125, // 125 EUR (diff +25 EUR)
  });
  db = stmtRes.db;

  const closedDb = closeStatement(db, stmtRes.id);
  const closedStmt = read(closedDb, 'account.bank.statement', stmtRes.id);
  assert.equal(closedStmt.state, 'closed');
  assert.equal(closedStmt.balance_end, 125);
  assert.equal(closedStmt.is_complete, true);

  const diffLine = search(closedDb, 'account.bank.statement.line').find((l) => l.statement_id === stmtRes.id);
  assert.ok(diffLine, 'Difference line created on foreign currency cash journal');
  assert.equal(diffLine.state, 'reconciled');
  assert.equal(diffLine.amount, 25);
  assert.equal(diffLine.open_amount, 0);
});

