import { test } from 'node:test';
import { register } from 'node:module';
import assert from 'node:assert/strict';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { models } from './models/index.js';
import { fieldReadonly } from './field-metadata.js';
import { diffDb, applyDiff } from './sync.js';
import { importStatement } from './models/statements.js';
import { importCsvRows } from './csv.js';
import { bookToAccount } from './models/bank.js';
import { closeStatement, computeBalanceEnd, computeIsComplete, previousStatementEndingBalance } from './models/bankstatement.js';
import { find, setupDom } from './test-support/dom.js';

// Helper to get liquidity journal
function getBankJournal(db, companyId = 1) {
  return search(db, 'account.journal').find(
    (j) => j.type === 'bank' && (j.company_id ?? 1) === companyId
  );
}

function getExpenseAccount(db, companyId = 1) {
  return search(db, 'account.account').find(
    (a) => a.account_type === 'expense' && (!a.company_id || a.company_id === companyId) && a.active !== false
  );
}

// -----------------------------------------------------------------------------
// ST-1: Inline Transactions lines on bank statement form
// -----------------------------------------------------------------------------

test('ST-1: Transactions lines one2many is editable inline on bank statement with declared fields', () => {
  const stmtModel = models['account.bank.statement'];
  assert.ok(stmtModel, 'account.bank.statement model exists');
  const lineIdsField = stmtModel.fields.line_ids;
  assert.ok(lineIdsField, 'line_ids field exists on statement model');

  // Must be editable inline, not readonly
  assert.equal(lineIdsField.editable, true, 'line_ids must specify editable: true');
  assert.equal(lineIdsField.label, 'Transactions', 'line_ids label must be Transactions');

  // Fields: date, label (payment_ref), partner, amount, reference
  assert.ok(lineIdsField.fields.date, 'line_ids must have date field');
  assert.ok(lineIdsField.fields.payment_ref, 'line_ids must have payment_ref (Label) field');
  assert.ok(lineIdsField.fields.partner_id, 'line_ids must have partner_id field');
  assert.ok(lineIdsField.fields.amount, 'line_ids must have amount field');
  assert.ok(lineIdsField.fields.ref, 'line_ids must have ref (Reference) field');

  // Form tabs must include Transactions tab
  assert.ok(Array.isArray(stmtModel.form.tabs), 'statement form must have tabs');
  const txTab = stmtModel.form.tabs.find((t) => t.label === 'Transactions');
  assert.ok(txTab, 'statement form must have Transactions tab');
  assert.ok(txTab.fields.includes('line_ids'), 'Transactions tab must include line_ids');

  // Open statement line_ids is editable
  const openStmt = { state: 'open', is_complete: false };
  assert.equal(fieldReadonly(lineIdsField, openStmt, {}), false, 'line_ids must be editable on open statement');

  // Closed statement line_ids is readonly
  const closedStmt = { state: 'closed' };
  assert.equal(fieldReadonly(lineIdsField, closedStmt, {}), true, 'line_ids must be readonly on closed statement');
});

test('ST-1: Transactions lines can be added, updated, and deleted inline via statement create and write', () => {
  let db = seed();
  const bankJournal = getBankJournal(db);
  assert.ok(bankJournal, 'bank journal exists');
  const partner = search(db, 'res.partner')[0];

  // 1. Create statement with inline lines
  const createRes = create(db, 'account.bank.statement', {
    name: 'STMT-INLINE-01',
    journal_id: bankJournal.id,
    date: '2026-05-01',
    balance_start: 100,
    balance_end_real: 250,
    line_ids: [
      { date: '2026-05-01', payment_ref: 'First Line', amount: 100, partner_id: partner.id, ref: 'REF-001' },
      { date: '2026-05-02', payment_ref: 'Second Line', amount: 50, partner_id: null, ref: 'REF-002' },
    ],
  });
  db = createRes.db;
  const stmt = read(db, 'account.bank.statement', createRes.id);
  assert.equal(stmt.line_ids.length, 2, 'Statement must have 2 inline created lines');
  assert.equal(stmt.line_ids[0].payment_ref, 'First Line');
  assert.equal(stmt.line_ids[0].amount, 100);
  assert.equal(stmt.line_ids[0].ref, 'REF-001');
  assert.equal(stmt.line_ids[0].journal_id, bankJournal.id, 'New line takes statement journal');
  assert.equal(stmt.line_ids[0].company_id, stmt.company_id, 'New line takes statement company');

  // 2. Update statement inline: edit first line, remove second line, add third line
  const line1Id = stmt.line_ids[0].id;
  db = write(db, 'account.bank.statement', stmt.id, {
    balance_end_real: 220,
    line_ids: [
      { id: line1Id, date: '2026-05-01', payment_ref: 'First Line Updated', amount: 80, partner_id: partner.id, ref: 'REF-001-MOD' },
      { date: '2026-05-03', payment_ref: 'Third Line Added', amount: 40, partner_id: null, ref: 'REF-003' },
    ],
  });

  const updatedStmt = read(db, 'account.bank.statement', stmt.id);
  assert.equal(updatedStmt.line_ids.length, 2, 'Statement has 2 lines after update');
  const updatedLine1 = updatedStmt.line_ids.find((l) => l.id === line1Id);
  assert.ok(updatedLine1, 'Line 1 still exists');
  assert.equal(updatedLine1.payment_ref, 'First Line Updated');
  assert.equal(updatedLine1.amount, 80);
  assert.equal(updatedLine1.ref, 'REF-001-MOD');

  const addedLine = updatedStmt.line_ids.find((l) => l.payment_ref === 'Third Line Added');
  assert.ok(addedLine, 'Third line was created');
  assert.equal(addedLine.amount, 40);
  assert.equal(addedLine.journal_id, bankJournal.id, 'Added line takes statement journal');
  assert.equal(addedLine.company_id, stmt.company_id, 'Added line takes statement company');
  assert.equal(addedLine.statement_id, stmt.id);

  // Removed line must no longer exist in lines
  const lines = search(db, 'account.bank.statement.line').filter((l) => l.statement_id === stmt.id);
  assert.equal(lines.length, 2);
  assert.ok(!lines.some((l) => l.payment_ref === 'Second Line'), 'Removed line was unlinked');
});

test('ST-1: New lines take the statement journal and company on standalone line create and newLine helper', () => {
  let db = seed();
  const bankJournal = getBankJournal(db);
  const stmtRes = create(db, 'account.bank.statement', {
    name: 'STMT-DEFAULTS-01',
    journal_id: bankJournal.id,
    date: '2026-05-10',
    balance_start: 50,
    balance_end_real: 50,
  });
  db = stmtRes.db;
  const stmt = read(db, 'account.bank.statement', stmtRes.id);

  // newLine helper on line_ids
  const newLine = models['account.bank.statement'].fields.line_ids.newLine?.(stmt, db);
  assert.ok(newLine, 'newLine helper exists');
  assert.equal(newLine.journal_id, bankJournal.id, 'newLine takes statement journal');
  assert.equal(newLine.company_id, stmt.company_id, 'newLine takes statement company');

  // Creating account.bank.statement.line with statement_id but without journal_id / company_id
  const lineRes = create(db, 'account.bank.statement.line', {
    statement_id: stmt.id,
    payment_ref: 'Standalone line with statement_id',
    amount: 25,
    date: '2026-05-10',
  });
  db = lineRes.db;
  const createdLine = read(db, 'account.bank.statement.line', lineRes.id);
  assert.equal(createdLine.journal_id, bankJournal.id, 'Standalone line takes statement journal');
  assert.equal(createdLine.company_id, stmt.company_id, 'Standalone line takes statement company');
});

test('ST-1: Reconciled lines cannot be edited or deleted inline or via diff', () => {
  let db = seed();
  const bankJournal = getBankJournal(db);
  const expense = getExpenseAccount(db);
  assert.ok(expense, 'expense account exists');

  // Create statement with 2 lines
  const stmtRes = create(db, 'account.bank.statement', {
    name: 'STMT-REC-01',
    journal_id: bankJournal.id,
    date: '2026-05-15',
    balance_start: 0,
    balance_end_real: -150,
    line_ids: [
      { date: '2026-05-15', payment_ref: 'Line to reconcile', amount: -100 },
      { date: '2026-05-15', payment_ref: 'Line to stay open', amount: -50 },
    ],
  });
  db = stmtRes.db;
  let stmt = read(db, 'account.bank.statement', stmtRes.id);
  const recLine = stmt.line_ids.find((l) => l.payment_ref === 'Line to reconcile');
  const openLine = stmt.line_ids.find((l) => l.payment_ref === 'Line to stay open');

  // Reconcile line 1
  const booked = bookToAccount(db, { ...recLine, counterpart_account_id: expense.id });
  db = booked.db;
  const reconciled = read(db, 'account.bank.statement.line', recLine.id);
  assert.equal(reconciled.state, 'reconciled');

  // Check subfield readonly predicate
  const subfields = models['account.bank.statement'].fields.line_ids.fields;
  for (const f of ['date', 'payment_ref', 'amount', 'ref']) {
    assert.equal(fieldReadonly(subfields[f], reconciled, db), true, `${f} must be readonly for reconciled line`);
    assert.equal(fieldReadonly(subfields[f], openLine, db), false, `${f} must be editable for unreconciled line`);
  }

  // Attempting to edit reconciled line inline via statement write must throw (via lineGuard in syncStatementLines)
  assert.throws(
    () => write(db, 'account.bank.statement', stmt.id, {
      line_ids: [
        { id: recLine.id, date: '2026-05-15', payment_ref: 'Hacked Label', amount: -999 },
        { id: openLine.id, date: '2026-05-15', payment_ref: openLine.payment_ref, amount: openLine.amount },
      ],
    }),
    /reconciled.*cannot be changed/i
  );

  // Attempting to delete reconciled line inline via statement write must throw (via protectDelete in syncStatementLines)
  assert.throws(
    () => write(db, 'account.bank.statement', stmt.id, {
      line_ids: [
        { id: openLine.id, date: '2026-05-15', payment_ref: openLine.payment_ref, amount: openLine.amount },
      ],
    }),
    /reconciled.*cannot be deleted/i
  );

  // Server-side guard check through diffDb + applyDiff: editing reconciled line throws
  const forgedEditDb = {
    ...db,
    records: {
      ...db.records,
      'account.bank.statement.line': db.records['account.bank.statement.line'].map((l) =>
        l.id === recLine.id ? { ...l, amount: -500 } : l
      ),
    },
  };
  assert.throws(
    () => applyDiff(db, diffDb(db, forgedEditDb), { isAdmin: true }),
    /reconciled.*cannot be changed/i
  );

  // Server-side guard check through diffDb + applyDiff: deleting reconciled line throws
  const forgedDeleteDb = {
    ...db,
    records: {
      ...db.records,
      'account.bank.statement.line': db.records['account.bank.statement.line'].filter((l) => l.id !== recLine.id),
    },
  };
  assert.throws(
    () => applyDiff(db, diffDb(db, forgedDeleteDb), { isAdmin: true }),
    /reconciled.*cannot be deleted/i
  );

  // Editing an unreconciled line via statement write and syncing over diffDb + applyDiff succeeds
  const nextDb = write(db, 'account.bank.statement', stmt.id, {
    line_ids: [
      { id: recLine.id, date: reconciled.date, payment_ref: reconciled.payment_ref, partner_id: reconciled.partner_id, amount: reconciled.amount, ref: reconciled.ref },
      { id: openLine.id, date: '2026-05-15', payment_ref: 'Updated open label', amount: -60 },
    ],
  });
  const syncedDb = applyDiff(db, diffDb(db, nextDb), { isAdmin: true });
  const syncedOpen = read(syncedDb, 'account.bank.statement.line', openLine.id);
  assert.equal(syncedOpen.payment_ref, 'Updated open label');
  assert.equal(syncedOpen.amount, -60);
});

test('ST-1: Company defaults resolve to statement company, else journal company, else currentCompany (never hardcoded 1)', () => {
  let db = seed();
  const c2Res = create(db, 'res.company', { name: 'Branch Co', currency_id: 1 });
  db = c2Res.db;
  db = { ...db, settings: { ...db.settings, current_company_id: c2Res.id, allowed_company_ids: [1, c2Res.id] } };

  const sharedJournalRes = create(db, 'account.journal', { name: 'Shared Bank', code: 'SBNK', type: 'bank', company_id: null });
  db = sharedJournalRes.db;

  const stmtRes = create(db, 'account.bank.statement', {
    name: 'STMT-CO2',
    journal_id: sharedJournalRes.id,
    date: '2026-05-20',
    balance_start: 0,
    balance_end_real: 10,
  });
  db = stmtRes.db;
  const stmt = read(db, 'account.bank.statement', stmtRes.id);
  assert.equal(stmt.company_id, c2Res.id, 'Statement defaults company from currentCompany(db)');

  const newLine = models['account.bank.statement'].fields.line_ids.newLine(stmt, db);
  assert.equal(newLine.company_id, c2Res.id, 'newLine defaults company to statement/currentCompany');

  const lineRes = create(db, 'account.bank.statement.line', {
    statement_id: stmt.id,
    payment_ref: 'Line CO2',
    amount: 10,
    date: '2026-05-20',
  });
  db = lineRes.db;
  const line = read(db, 'account.bank.statement.line', lineRes.id);
  assert.equal(line.company_id, c2Res.id, 'Statement line inherits statement company');
});

// -----------------------------------------------------------------------------
// ST-2: Starting / ending balance, Complete indicator and warning
// -----------------------------------------------------------------------------

test('ST-2: Ending balance is computed as balance_start + sum of line amounts in real-time', () => {
  let db = seed();
  const bankJournal = getBankJournal(db);

  const stmtRes = create(db, 'account.bank.statement', {
    name: 'STMT-BAL-01',
    journal_id: bankJournal.id,
    date: '2026-06-01',
    balance_start: 500,
    balance_end_real: 650,
  });
  db = stmtRes.db;
  let stmt = read(db, 'account.bank.statement', stmtRes.id);
  assert.equal(stmt.balance_end, 500, 'Initial balance_end equals balance_start with no lines');

  // Compute with passed line_ids (real-time in-form computation)
  const inFormEnd = computeBalanceEnd({
    id: stmt.id,
    journal_id: bankJournal.id,
    balance_start: 500,
    line_ids: [
      { amount: 100 },
      { amount: 50 },
    ],
  }, db);
  assert.equal(inFormEnd, 650, 'computeBalanceEnd uses in-memory line_ids amounts');

  // Persist lines and check computed balance
  db = write(db, 'account.bank.statement', stmt.id, {
    line_ids: [
      { date: '2026-06-01', payment_ref: 'Deposit 1', amount: 100 },
      { date: '2026-06-02', payment_ref: 'Deposit 2', amount: 50 },
    ],
  });
  stmt = read(db, 'account.bank.statement', stmt.id);
  assert.equal(stmt.balance_end, 650, 'Persisted balance_end is 500 + 100 + 50 = 650');
});

test('ST-2: Starting balance defaults to previous statement ending balance of the same journal', () => {
  let db = seed();
  const bankJournal = getBankJournal(db);

  // Helper function test directly
  const initialPrev = previousStatementEndingBalance(db, bankJournal.id);
  assert.equal(initialPrev, 0, 'No previous statement returns 0');

  // Create first statement with balance_end_real: 420
  const stmt1Res = create(db, 'account.bank.statement', {
    name: 'STMT-PREV-01',
    journal_id: bankJournal.id,
    date: '2026-06-01',
    balance_start: 0,
    balance_end_real: 420,
  });
  db = stmt1Res.db;

  // previousStatementEndingBalance now returns 420
  assert.equal(previousStatementEndingBalance(db, bankJournal.id), 420);

  // Create second statement on same journal without specifying balance_start -> must default to 420
  const stmt2Res = create(db, 'account.bank.statement', {
    name: 'STMT-PREV-02',
    journal_id: bankJournal.id,
    date: '2026-06-15',
    balance_end_real: 500,
  });
  db = stmt2Res.db;
  const stmt2 = read(db, 'account.bank.statement', stmt2Res.id);
  assert.equal(stmt2.balance_start, 420, 'Statement 2 balance_start defaults to previous statement balance_end_real');

  // Onchange on journal_id also defaults balance_start
  const onchangeRes = models['account.bank.statement'].onchange?.(
    { journal_id: bankJournal.id, date: '2026-06-20' },
    'journal_id',
    db
  );
  assert.equal(onchangeRes?.balance_start, 500, 'onchange on journal_id defaults balance_start to latest ending balance');
});

test('ST-2: Statement shows Complete when computed ending balance equals entered ending balance, else warning', () => {
  let db = seed();
  const bankJournal = getBankJournal(db);
  const formDef = models['account.bank.statement'].form;

  // Case 1: Incomplete statement (ending balance does not match entered ending balance)
  const stmtIncompleteRes = create(db, 'account.bank.statement', {
    name: 'STMT-INCOMPLETE',
    journal_id: bankJournal.id,
    date: '2026-07-01',
    balance_start: 100,
    balance_end_real: 300,
    line_ids: [
      { date: '2026-07-01', payment_ref: 'Line 1', amount: 50 }, // computed end = 150 !== 300
    ],
  });
  db = stmtIncompleteRes.db;
  const stmtIncomplete = read(db, 'account.bank.statement', stmtIncompleteRes.id);

  assert.equal(computeIsComplete(stmtIncomplete, db), false);
  assert.equal(stmtIncomplete.is_complete, false);

  // Form warning must be present when incomplete
  const warningText = formDef.warning?.(stmtIncomplete, db);
  assert.ok(warningText, 'Warning must be shown when statement is not complete');
  assert.equal(formDef.ribbon?.(stmtIncomplete), null, 'Ribbon must not be Complete when incomplete');

  // Case 2: Complete statement (computed ending balance matches balance_end_real)
  const stmtCompleteRes = create(db, 'account.bank.statement', {
    name: 'STMT-COMPLETE',
    journal_id: bankJournal.id,
    date: '2026-07-05',
    balance_start: 100,
    balance_end_real: 250,
    line_ids: [
      { date: '2026-07-05', payment_ref: 'Line 1', amount: 150 }, // computed end = 250 === 250
    ],
  });
  db = stmtCompleteRes.db;
  const stmtComplete = read(db, 'account.bank.statement', stmtCompleteRes.id);

  assert.equal(computeIsComplete(stmtComplete, db), true);
  assert.equal(stmtComplete.is_complete, true);

  // Form shows Complete via ribbon and warning is cleared
  assert.equal(formDef.warning?.(stmtComplete, db), null, 'Warning must be null when statement is complete');
  assert.equal(formDef.ribbon?.(stmtComplete), 'Complete', 'Ribbon must show Complete');
});

// -----------------------------------------------------------------------------
// ST-3: Import action on statement form adds lines to this statement
// -----------------------------------------------------------------------------

test('ST-3: CSV cannot override the statement import target', () => {
  let db = seed();
  const journal = getBankJournal(db);
  const stmt = create(db, 'account.bank.statement', { name: 'CSV statement', journal_id: journal.id, date: '2026-08-01' });
  db = stmt.db;
  const result = importCsvRows(db, 'account.bank.statement.line', {
    statement_id: stmt.id, journal_id: journal.id, company_id: journal.company_id,
  }, [
    ['statement_id', 'journal_id', 'company_id', 'date', 'payment_ref', 'amount'],
    ['99999', '99999', '99999', '2026-08-01', 'CSV line', '25'],
  ]);
  const line = read(result.db, 'account.bank.statement', stmt.id).line_ids[0];
  assert.equal(line.journal_id, journal.id);
  assert.equal(read(result.db, 'account.move', line.bank_move_id).journal_id, journal.id);
});

test('ST-3: Statement form Import button opens file picker and imports lines into this statement journal and bank move', async () => {
  const { makeEl } = setupDom();
  const createdInputs = [];
  const origCreateElement = globalThis.document.createElement;
  globalThis.document.createElement = (tag) => {
    const el = origCreateElement(tag);
    if (tag === 'input') {
      el.click = () => { el.clicked = true; };
      createdInputs.push(el);
    }
    return el;
  };
  globalThis.document.createElementNS = (_ns, tag) => globalThis.document.createElement(tag);
  const reactProps = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];
  const origAlert = globalThis.alert;
  const alerts = [];
  globalThis.alert = (msg) => alerts.push(msg);
  globalThis.location = { hash: '#/accounting/statements/1' };

  const React = await import('react');
  const ReactDOM = await import('react-dom/client');
  const { act } = await import('react');
  const { initStore, commit, getDb } = await import('./store.js');
  const { FormView } = await import('./views/FormView.jsx');

  let db = seed();
  const bankJournal = getBankJournal(db);
  const stmtModel = models['account.bank.statement'];

  // Button exists on form with importFile config (no custom run bypass)
  const importBtnDef = stmtModel.form.buttons?.find((b) => b.label === 'Import');
  assert.ok(importBtnDef, 'Import button must exist on statement form');
  assert.ok(importBtnDef.importFile, 'Import button uses importFile handler');

  // Create a second bank journal with its own suspense & bank accounts to ensure lines/bank_move use THIS statement's journal
  const bankAcc2Res = create(db, 'account.account', { code: '101491', name: 'Bank 2 Account', account_type: 'asset_cash', company_id: 1 });
  const susp2Res = create(bankAcc2Res.db, 'account.account', { code: '101492', name: 'Bank 2 Suspense', account_type: 'asset_current', company_id: 1 });
  const journal2Res = create(susp2Res.db, 'account.journal', {
    name: 'Secondary Bank',
    code: 'BNK2',
    type: 'bank',
    company_id: 1,
    default_account_id: bankAcc2Res.id,
    suspense_account_id: susp2Res.id,
  });
  db = journal2Res.db;

  const stmtRes = create(db, 'account.bank.statement', {
    name: 'STMT-TARGET-01',
    journal_id: journal2Res.id,
    date: '2026-08-01',
    balance_start: 100,
    balance_end_real: 350,
  });
  db = stmtRes.db;
  const statementsBefore = search(db, 'account.bank.statement').length;

  await initStore();
  await commit(db);

  const root = makeEl('div');
  root.ownerDocument = globalThis.document;
  const reactRoot = ReactDOM.createRoot(root);
  try {
    await act(async () => {
      reactRoot.render(React.createElement(FormView, {
        leaf: { model: 'account.bank.statement', label: 'Bank Statements' },
        id: String(stmtRes.id),
        base: '#/accounting/statements',
        params: new URLSearchParams(),
      }));
    });

    const importButtonEl = find(root, (n) => n.tagName === 'BUTTON' && n.textContent === 'Import');
    assert.ok(importButtonEl, 'FormView renders the Import button on statement form');

    await act(async () => {
      await reactProps(importButtonEl).onClick();
    });

    const fileInput = createdInputs.find((i) => i.type === 'file' && i.clicked);
    assert.ok(fileInput, 'Clicking Import button opens a file picker (<input type="file">)');
    assert.match(fileInput.accept, /\.ofx/, 'File picker accepts statement extensions');

    const ofx = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEVER:NONE
NEWFILEVER:NONE

<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<CURDEF>USD
<BANKTRANLIST>
<DTSTART>20260801
<DTEND>20260802
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20260801
<TRNAMT>150.00
<FITID>OFX-ST3-001
<NAME>Client payment 1
</STMTTRN>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20260802
<TRNAMT>100.00
<FITID>OFX-ST3-002
<NAME>Client payment 2
</STMTTRN>
</BANKTRANLIST>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;

    await act(async () => {
      fileInput.files = [{ name: 'statement.ofx', text: async () => ofx }];
      await fileInput.onchange();
    });

    assert.equal(alerts[0], '2 record(s) imported.');
    const afterDb = getDb();

    // Verify NO new statement was created
    assert.equal(search(afterDb, 'account.bank.statement').length, statementsBefore, 'No new statement created');

    // Verify lines were added to THIS statement and booked on THIS statement's journal from the start
    const updatedStmt = read(afterDb, 'account.bank.statement', stmtRes.id);
    assert.equal(updatedStmt.line_ids.length, 2, 'Imported lines must be added to this statement');
    for (const line of updatedStmt.line_ids) {
      assert.equal(line.statement_id, stmtRes.id);
      assert.equal(line.journal_id, journal2Res.id, 'Line journal matches statement journal');
      assert.equal(line.company_id, updatedStmt.company_id);
      assert.ok(line.bank_move_id, 'Bank move must be booked');
      const bankMove = read(afterDb, 'account.move', line.bank_move_id);
      assert.equal(bankMove.journal_id, journal2Res.id, 'Bank move must be booked on statement journal');
    }

    assert.equal(updatedStmt.balance_end, 350);
    assert.equal(updatedStmt.is_complete, true, 'Statement is now complete');

    // Deduplication: re-importing the same file adds 0 lines
    const dupRes = importStatement(afterDb, 'statement.ofx', ofx, {
      statement_id: stmtRes.id,
      journal_id: updatedStmt.journal_id,
      company_id: updatedStmt.company_id,
    });
    assert.equal(dupRes.count, 0);
    assert.equal(read(dupRes.db, 'account.bank.statement', stmtRes.id).line_ids.length, 2);
  } finally {
    await act(async () => { reactRoot.unmount(); });
    globalThis.alert = origAlert;
    globalThis.document.createElement = origCreateElement;
  }
  assert.ok(bankJournal, 'primary bank journal present');
});

test('ST-3: Importing a file whose bank account belongs to another journal than the statement is rejected', () => {
  let db = seed();
  const bankJournal = getBankJournal(db);
  const companyPartnerId = read(db, 'res.company', 1).partner_id;

  const bank1Acct = create(db, 'res.partner.bank', { account_number: 'ACCT-MAIN-111', partner_id: companyPartnerId, company_id: 1 });
  db = write(bank1Acct.db, 'account.journal', bankJournal.id, { bank_account_id: bank1Acct.id });

  const bank2Acct = create(db, 'res.partner.bank', { account_number: 'ACCT-OTHER-999', partner_id: companyPartnerId, company_id: 1 });
  const bankAcc2Res = create(bank2Acct.db, 'account.account', { code: '101493', name: 'Other Bank Acc', account_type: 'asset_cash', company_id: 1 });
  const journal2Res = create(bankAcc2Res.db, 'account.journal', {
    name: 'Other Bank Journal',
    code: 'OBNK',
    type: 'bank',
    company_id: 1,
    default_account_id: bankAcc2Res.id,
    bank_account_id: bank2Acct.id,
  });
  db = journal2Res.db;

  const stmtRes = create(db, 'account.bank.statement', {
    name: 'STMT-MAIN-01',
    journal_id: bankJournal.id,
    date: '2026-08-01',
    balance_start: 0,
    balance_end_real: 100,
  });
  db = stmtRes.db;
  const lineCountBefore = search(db, 'account.bank.statement.line').length;

  const wrongAcctOfx = `<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<CURDEF>USD
<BANKACCTFROM><ACCTID>ACCT-OTHER-999</ACCTID></BANKACCTFROM>
<BANKTRANLIST>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260801<TRNAMT>100.00<FITID>MISMATCH-1<NAME>Wrong bank tx</STMTTRN>
</BANKTRANLIST>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;

  assert.throws(
    () => importStatement(db, 'other.ofx', wrongAcctOfx, { statement_id: stmtRes.id, journal_id: bankJournal.id }),
    /The file belongs to another bank account than this statement/
  );
  assert.equal(search(db, 'account.bank.statement.line').length, lineCountBefore, 'No lines created on account mismatch');
});

test('ST-3: Cannot import lines into a closed statement', () => {
  let db = seed();
  const bankJournal = getBankJournal(db);
  const stmtRes = create(db, 'account.bank.statement', {
    name: 'STMT-CLOSED-01',
    journal_id: bankJournal.id,
    date: '2026-08-01',
    balance_start: 100,
    balance_end_real: 200,
    line_ids: [
      { date: '2026-08-01', payment_ref: 'Closing line', amount: 100 },
    ],
  });
  db = stmtRes.db;

  // Close statement
  db = closeStatement(db, stmtRes.id);
  const closedStmt = read(db, 'account.bank.statement', stmtRes.id);
  assert.equal(closedStmt.state, 'closed');

  // Import button when predicate must hide button for closed statement
  const importBtn = models['account.bank.statement'].form.buttons?.find((b) => b.label === 'Import');
  assert.equal(importBtn.when(closedStmt), false, 'Import button must not be visible on closed statement');

  const qif = `!Type:Bank
D2026-08-02
T50.00
PTest Payee
^`;

  // Calling importStatement with closed statement_id must throw error
  assert.throws(
    () => importStatement(db, 'test.qif', qif, { statement_id: closedStmt.id }),
    /closed statement/i
  );
});
