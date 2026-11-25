import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

import { create, read, search, unlink, write, writeMany } from './orm.js';
import { seed } from './seed.js';
import { menusFor } from './models/index.js';
import { postMove } from './models/accounting.js';
import { bookToAccount, reconcileWith, setStatementLinePartner, bankModels } from './models/bank.js';
import { closeStatement } from './models/bankstatement.js';
import { autoReconcile, mapStatementPartner } from './models/reconcile.js';
import { runScheduledJobs } from './models/scheduler.js';
import { applyDiff, diffDb } from './sync.js';
import { setupDom, find } from './test-support/dom.js';

const props = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];
const allFind = (root, pred, out = []) => {
  if (!root) return out;
  if (pred(root)) out.push(root);
  for (const child of root.childNodes ?? []) allFind(child, pred, out);
  return out;
};

function findLeafByKey(items, key) {
  for (const item of items) {
    if (item.key === key) return item;
    if (item.children) {
      const found = findLeafByKey(item.children, key);
      if (found) return found;
    }
  }
  return null;
}

const statementsLeaf = () => findLeafByKey(menusFor('accounting'), 'statements');

async function mountForm(id, initialDb) {
  const prevStorage = globalThis.localStorage;
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
    clear: () => { mem.clear(); },
  };
  setupDom();
  const origCreate = globalThis.document.createElement;
  globalThis.document.createElement = (tag) => {
    const el = origCreate(tag);
    el.insertBefore = (child, before) => {
      const idx = before ? el.childNodes.indexOf(before) : -1;
      if (idx >= 0) el.childNodes.splice(idx, 0, child);
      else el.childNodes.push(child);
      child.parentNode = el;
      if (child.tagName === 'OPTION') el.options.push(child);
      return el;
    };
    return el;
  };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit, getDb } = await import('./store.js');
  const { FormView } = await import('./views/FormView.jsx');
  await initStore();
  await commit(initialDb);
  const host = globalThis.document.createElement('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  await React.act(async () => {
    root.render(React.createElement(FormView, {
      leaf: statementsLeaf(),
      id,
      base: '#/accounting/statements',
      params: new URLSearchParams('view=list'),
    }));
  });
  return {
    React,
    host,
    getDb,
    done: async () => {
      await React.act(async () => root.unmount());
      globalThis.localStorage = prevStorage;
    },
  };
}

function makePostedInvoice(db, { partnerId = 1, price = 150, date = '2026-05-01' } = {}) {
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partnerId,
    company_id: 1,
    invoice_date: date,
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: price, tax: 0 }],
  });
  return { db: postMove(inv.db, inv.id), id: inv.id };
}

test('STM2-1: Bank Statements form allows adding and editing lines on draft statements, computes balance_end, and shows running balance & invalid statement warnings', async () => {
  let db = seed();
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  const partner = search(db, 'res.partner')[0];

  // Previous statement ending at 500
  const prevStmt = create(db, 'account.bank.statement', {
    name: 'STMT/2026/001',
    journal_id: bankJournal.id,
    date: '2026-05-01',
    balance_start: 400,
    balance_end_real: 500,
  });
  db = prevStmt.db;

  // Draft statement with mismatched starting balance (450 != 500) and real ending balance 650
  const draftStmt = create(db, 'account.bank.statement', {
    name: 'STMT/2026/002',
    journal_id: bankJournal.id,
    date: '2026-05-10',
    balance_start: 450,
    balance_end_real: 650,
  });
  db = draftStmt.db;

  const ctx = await mountForm(draftStmt.id, db);
  try {
    const { host, React, getDb } = ctx;
    // 1. Both Odoo invalid-statement warning and running balance mismatch warning appear
    const warnBanner = find(host, (n) => props(n)?.role === 'status' && String(props(n)?.className ?? '').includes('alert-warning'));
    assert.ok(warnBanner, 'Warning banner must be rendered on the statement form');
    assert.match(warnBanner.textContent, /Invalid statement/i, 'Invalid statement warning shown when balance_start mismatches previous balance_end_real');
    assert.match(warnBanner.textContent, /Running balance.*650/i, 'Running balance check against balance_end_real shown');

    // 2. Statement lines table renders Date, Label, Partner, Amount, Reference columns and Add a line button
    const linesTable = find(host, (n) => n.tagName === 'TABLE' && String(props(n)?.className ?? '').includes('lines'));
    assert.ok(linesTable, 'Statement lines table must be rendered on statement form');
    const headers = allFind(linesTable, (n) => n.tagName === 'TH').map((th) => th.textContent.trim()).filter(Boolean);
    assert.deepEqual(headers, ['Date', 'Label', 'Partner', 'Amount', 'Reference']);

    const addBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.trim() === 'Add a line');
    assert.ok(addBtn, 'Add a line button must be available on draft statement');

    // 3. Add a line manually and fill Date, Label, Partner, Amount, Reference
    await React.act(async () => props(addBtn).onClick());
    const dateInput = find(linesTable, (n) => n.tagName === 'INPUT' && props(n)?.['aria-label'] === 'Date 1');
    const labelInput = find(linesTable, (n) => n.tagName === 'INPUT' && props(n)?.['aria-label'] === 'Label 1');
    const partnerSelect = find(linesTable, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === 'Partner 1');
    const amountInput = find(linesTable, (n) => n.tagName === 'INPUT' && props(n)?.['aria-label'] === 'Amount 1');
    const refInput = find(linesTable, (n) => n.tagName === 'INPUT' && props(n)?.['aria-label'] === 'Reference 1');

    assert.ok(dateInput && labelInput && partnerSelect && amountInput && refInput, 'All 5 line columns must be editable');

    await React.act(async () => props(dateInput).onChange({ target: { value: '2026-05-08' } }));
    await React.act(async () => props(labelInput).onChange({ target: { value: 'Customer Wire' } }));
    await React.act(async () => props(partnerSelect).onChange({ target: { value: String(partner.id) } }));
    await React.act(async () => props(amountInput).onChange({ target: { value: '200' } }));
    await React.act(async () => props(refInput).onChange({ target: { value: 'WIRE-001' } }));

    // Computed ending balance updates live: 450 + 200 = 650 === balance_end_real (650), so running balance warning clears
    const updatedWarn = find(host, (n) => props(n)?.role === 'status' && String(props(n)?.className ?? '').includes('alert-warning'));
    assert.ok(updatedWarn, 'Invalid statement warning still shown while balance_start is 450');
    assert.doesNotMatch(updatedWarn.textContent, /Running balance/i, 'Running balance warning clears once balance_end equals balance_end_real');

    // Fix balance_start to 500 and balance_end_real to 700 so statement is both valid and complete
    const startInput = find(host, (n) => n.tagName === 'INPUT' && props(n)?.id === 'f-balance_start');
    const endRealInput = find(host, (n) => n.tagName === 'INPUT' && props(n)?.id === 'f-balance_end_real');
    await React.act(async () => props(startInput).onChange({ target: { value: '500' } }));
    await React.act(async () => props(endRealInput).onChange({ target: { value: '700' } }));

    assert.equal(find(host, (n) => n.tagName === 'DIV' && String(props(n)?.className ?? '').includes('alert-warning')), null, 'No warning when statement is valid and balanced');

    // Save the form and verify persisted statement + line records
    const saveBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.trim() === 'Save');
    assert.ok(saveBtn, 'Save button must be visible');
    await React.act(async () => props(saveBtn).onClick());

    const savedDb = getDb();
    const savedStmt = read(savedDb, 'account.bank.statement', draftStmt.id);
    assert.equal(savedStmt.balance_start, 500);
    assert.equal(savedStmt.balance_end, 700);
    assert.equal(savedStmt.balance_end_real, 700);
    assert.equal(savedStmt.is_valid, true);
    assert.equal(savedStmt.is_complete, true);
    assert.equal(savedStmt.line_ids.length, 1);

    const createdLine = search(savedDb, 'account.bank.statement.line').find((l) => l.statement_id === draftStmt.id);
    assert.ok(createdLine, 'Statement line persisted as account.bank.statement.line');
    assert.equal(createdLine.date, '2026-05-08');
    assert.equal(createdLine.payment_ref, 'Customer Wire');
    assert.equal(createdLine.partner_id, partner.id);
    assert.equal(createdLine.amount, 200);
    assert.equal(createdLine.ref, 'WIRE-001');

    // Also verify editing an existing line on the draft statement via form save
    const editLabelInput = find(host, (n) => n.tagName === 'INPUT' && props(n)?.['aria-label'] === 'Label 1');
    const editAmountInput = find(host, (n) => n.tagName === 'INPUT' && props(n)?.['aria-label'] === 'Amount 1');
    await React.act(async () => props(editLabelInput).onChange({ target: { value: 'Updated Wire' } }));
    await React.act(async () => props(editAmountInput).onChange({ target: { value: '250' } }));
    const saveBtn2 = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.trim() === 'Save');
    await React.act(async () => props(saveBtn2).onClick());

    const afterEditDb = getDb();
    assert.equal(read(afterEditDb, 'account.bank.statement', draftStmt.id).balance_end, 750);
    assert.equal(read(afterEditDb, 'account.bank.statement.line', createdLine.id).payment_ref, 'Updated Wire');
    assert.equal(read(afterEditDb, 'account.bank.statement.line', createdLine.id).amount, 250);
  } finally {
    await ctx.done();
  }
});

test('STM2-2: Guards forbid editing or deleting lines of a statement with reconciled lines (diff-verifiable)', async () => {
  let db = seed();
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  const partner = search(db, 'res.partner')[0];

  // Create draft statement with two lines via diffDb + applyDiff
  const stmtCreated = create(db, 'account.bank.statement', {
    name: 'STMT/STM2/GUARD',
    journal_id: bankJournal.id,
    date: '2026-06-01',
    balance_start: 0,
    balance_end_real: 250,
    line_ids: [
      { date: '2026-06-01', payment_ref: 'Line One', partner_id: partner.id, amount: 150, ref: 'R-1' },
      { date: '2026-06-02', payment_ref: 'Line Two', partner_id: partner.id, amount: 100, ref: 'R-2' },
    ],
  });
  db = applyDiff(db, diffDb(db, stmtCreated.db), { author: 'Clerk', isAdmin: false });

  const lines = search(db, 'account.bank.statement.line').filter((l) => l.statement_id === stmtCreated.id);
  assert.equal(lines.length, 2);
  const line1 = lines.find((l) => l.payment_ref === 'Line One');
  const line2 = lines.find((l) => l.payment_ref === 'Line Two');

  // Reconcile line 1 only (statement stays open, now has a reconciled line)
  const inv1 = makePostedInvoice(db, { partnerId: partner.id, price: 150, date: '2026-06-01' });
  db = applyDiff(db, diffDb(db, inv1.db), { author: 'Clerk', isAdmin: false });
  const recDb = reconcileWith(db, read(db, 'account.bank.statement.line', line1.id), inv1.id);
  db = applyDiff(db, diffDb(db, recDb), { author: 'Clerk', isAdmin: false });

  assert.equal(read(db, 'account.bank.statement.line', line1.id).state, 'reconciled');
  assert.equal(read(db, 'account.bank.statement.line', line2.id).state, 'to_check');

  // 1. Direct edits on reconciled line1 through diffDb + applyDiff must fail
  for (const patch of [{ amount: 999 }, { payment_ref: 'Tampered' }, { ref: 'TAMPER' }, { date: '2026-06-15' }, { active: false }, { statement_id: null }]) {
    const forged = {
      upserts: {
        'account.bank.statement.line': [{ ...db.records['account.bank.statement.line'].find((l) => l.id === line1.id), ...patch }],
      },
    };
    assert.throws(() => applyDiff(db, forged, { author: 'Clerk', isAdmin: false }), /reconciled/i);
  }

  // 2. Direct edits on unreconciled line2 of the same statement through write() and diffDb + applyDiff must fail
  for (const patch of [{ amount: 555 }, { payment_ref: 'Tampered 2' }, { ref: 'TAMPER-2' }, { date: '2026-06-20' }, { active: false }, { statement_id: null }]) {
    assert.throws(() => write(db, 'account.bank.statement.line', line2.id, patch), /reconciled lines/i);
    const rawLine2 = db.records['account.bank.statement.line'].find((l) => l.id === line2.id);
    const forged = { upserts: { 'account.bank.statement.line': [{ ...rawLine2, ...patch }] } };
    assert.throws(() => applyDiff(db, forged, { author: 'Clerk', isAdmin: false }), /reconciled lines/i);
  }

  // 3. Deleting line1 or line2 directly via diffDb / applyDiff deletes must fail
  assert.throws(() => unlink(db, 'account.bank.statement.line', [line1.id]), /reconciled/i);
  assert.throws(() => unlink(db, 'account.bank.statement.line', [line2.id]), /reconciled lines/i);
  assert.throws(() => applyDiff(db, { deletes: { 'account.bank.statement.line': [line1.id] } }, { author: 'Clerk', isAdmin: false }), /reconciled/i);
  assert.throws(() => applyDiff(db, { deletes: { 'account.bank.statement.line': [line2.id] } }, { author: 'Clerk', isAdmin: false }), /reconciled lines/i);

  // 4. Editing or deleting lines via parent account.bank.statement line_ids through applyDiff must fail
  const rawStmt = db.records['account.bank.statement'].find((s) => s.id === stmtCreated.id);
  const currentLines = read(db, 'account.bank.statement', stmtCreated.id).line_ids;
  const editedParentDiff = {
    upserts: {
      'account.bank.statement': [{
        ...rawStmt,
        line_ids: currentLines.map((l) => (l.id === line2.id ? { ...l, amount: 777 } : l)),
      }],
    },
  };
  assert.throws(() => applyDiff(db, editedParentDiff, { author: 'Clerk', isAdmin: false }), /reconciled lines/i);

  const deletedLineParentDiff = {
    upserts: {
      'account.bank.statement': [{
        ...rawStmt,
        line_ids: currentLines.filter((l) => l.id !== line2.id),
      }],
    },
  };
  assert.throws(() => applyDiff(db, deletedLineParentDiff, { author: 'Clerk', isAdmin: false }), /reconciled lines/i);

  // 5. Deleting the statement itself via applyDiff must fail
  assert.throws(() => applyDiff(db, { deletes: { 'account.bank.statement': [stmtCreated.id] } }, { author: 'Clerk', isAdmin: false }), /reconciled lines/i);

  // 6. On the FormView UI, line_ids is read-only when the statement has reconciled lines (no Add a line or delete button)
  const ctx = await mountForm(stmtCreated.id, db);
  try {
    assert.equal(find(ctx.host, (n) => n.tagName === 'BUTTON' && n.textContent.trim() === 'Add a line'), null);
    assert.equal(find(ctx.host, (n) => n.tagName === 'BUTTON' && props(n)?.['aria-label'] === 'Delete'), null);
  } finally {
    await ctx.done();
  }

  // 7. Open statement WITHOUT reconciled lines still allows editing and deleting lines via diffDb + applyDiff
  const openStmtRes = create(db, 'account.bank.statement', {
    name: 'STMT/STM2/OPEN',
    journal_id: bankJournal.id,
    date: '2026-06-05',
    balance_start: 0,
    balance_end_real: 50,
    line_ids: [
      { date: '2026-06-05', payment_ref: 'Draft Line A', partner_id: partner.id, amount: 30, ref: 'DA' },
      { date: '2026-06-05', payment_ref: 'Draft Line B', partner_id: partner.id, amount: 20, ref: 'DB' },
    ],
  });
  db = applyDiff(db, diffDb(db, openStmtRes.db), { author: 'Clerk', isAdmin: false });
  const openLines = search(db, 'account.bank.statement.line').filter((l) => l.statement_id === openStmtRes.id);
  const editedOpenDb = write(db, 'account.bank.statement', openStmtRes.id, {
    line_ids: [{ ...read(db, 'account.bank.statement', openStmtRes.id).line_ids[0], amount: 50, payment_ref: 'Draft Line A Updated' }],
  });
  db = applyDiff(db, diffDb(db, editedOpenDb), { author: 'Clerk', isAdmin: false });
  const remainingOpenLines = search(db, 'account.bank.statement.line').filter((l) => l.statement_id === openStmtRes.id);
  assert.equal(remainingOpenLines.length, 1);
  assert.equal(remainingOpenLines[0].id, openLines[0].id);
  assert.equal(remainingOpenLines[0].amount, 50);

  // 8. Reconciling the remaining open line (line2) still succeeds
  const inv2 = makePostedInvoice(db, { partnerId: partner.id, price: 100, date: '2026-06-02' });
  db = applyDiff(db, diffDb(db, inv2.db), { author: 'Clerk', isAdmin: false });
  const rec2Db = reconcileWith(db, read(db, 'account.bank.statement.line', line2.id), inv2.id);
  db = applyDiff(db, diffDb(db, rec2Db), { author: 'Clerk', isAdmin: false });
  assert.equal(read(db, 'account.bank.statement.line', line2.id).state, 'reconciled');
});

test('STM2-3: Destination statement with reconciled lines rejects newly created transactions', async () => {
  let db = seed();
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  const partner = search(db, 'res.partner')[0];

  const stmtCreated = create(db, 'account.bank.statement', {
    name: 'STMT/STM2/F1',
    journal_id: bankJournal.id,
    date: '2026-06-01',
    balance_start: 0,
    balance_end_real: 150,
    line_ids: [
      { date: '2026-06-01', payment_ref: 'Line 1', partner_id: partner.id, amount: 150, ref: 'R-1' },
    ],
  });
  db = stmtCreated.db;
  const line1 = search(db, 'account.bank.statement.line').find((l) => l.statement_id === stmtCreated.id);

  // Reconcile line1
  const inv1 = makePostedInvoice(db, { partnerId: partner.id, price: 150, date: '2026-06-01' });
  db = inv1.db;
  db = reconcileWith(db, line1, inv1.id);
  assert.equal(read(db, 'account.bank.statement.line', line1.id).state, 'reconciled');

  // Attempting to create a new transaction attached to this statement must fail
  assert.throws(
    () => create(db, 'account.bank.statement.line', {
      statement_id: stmtCreated.id,
      journal_id: bankJournal.id,
      date: '2026-06-02',
      payment_ref: 'Unauthorized Line',
      amount: 50,
    }),
    /Cannot add lines to a statement with reconciled lines/
  );

  // Attempting to attach an existing line must also fail
  const standaloneLine = create(db, 'account.bank.statement.line', {
    journal_id: bankJournal.id,
    date: '2026-06-02',
    payment_ref: 'Standalone',
    amount: 50,
  });
  db = standaloneLine.db;
  assert.throws(
    () => write(db, 'account.bank.statement.line', standaloneLine.id, { statement_id: stmtCreated.id }),
    /reconciled lines/i
  );
});

test('STM2-4: autoReconcile and mapStatementPartner skip closed statements and runScheduledJobs tolerates errors', async () => {
  let db = seed();
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  const partner = search(db, 'res.partner')[0];

  // Create a partner mapping rule
  const rule = create(db, 'account.reconcile.model', {
    name: 'Test Partner Mapping Rule',
    rule_type: 'writeoff_button',
    sequence: 1,
    active: true,
    partner_mapping_line_ids: [{
      payment_ref_regex: 'MAP-.*',
      partner_id: partner.id,
    }],
    line_ids: [{ account_id: search(db, 'account.account').find((a) => a.code === '600000')?.id ?? 1, amount_type: 'percentage', amount: 100 }],
  });
  db = rule.db;

  // Closed statement with a to_check line matching the rule
  const closedStmt = create(db, 'account.bank.statement', {
    name: 'STMT/STM2/CLOSED',
    journal_id: bankJournal.id,
    date: '2026-06-01',
    state: 'closed',
    balance_start: 0,
    balance_end_real: 100,
  });
  db = closedStmt.db;

  db = {
    ...db,
    records: {
      ...db.records,
      'account.bank.statement.line': [
        ...(db.records['account.bank.statement.line'] ?? []),
        { id: 9988, statement_id: closedStmt.id, journal_id: bankJournal.id, date: '2026-06-01', payment_ref: 'MAP-Closed Line', amount: 100, state: 'to_check', partner_id: null },
      ],
    },
  };
  const targetClosedLine = read(db, 'account.bank.statement.line', 9988);

  // 1. mapStatementPartner on closed statement line returns db unchanged rather than throwing
  const mapped = mapStatementPartner(db, targetClosedLine);
  assert.equal(read(mapped, 'account.bank.statement.line', 9988).partner_id, null);

  // 2. autoReconcile runs without throwing
  assert.doesNotThrow(() => autoReconcile(db));

  // 3. runScheduledJobs does not abort
  assert.doesNotThrow(() => runScheduledJobs(db, '2026-06-01'));
});

test('STM2-5: Ordinary partner edits on locked statements are rejected while authorized reconciliation is preserved', async () => {
  let db = seed();
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  const partners = search(db, 'res.partner');
  const partnerA = partners[0];
  const partnerB = partners[1] ?? partners[0];

  const stmtCreated = create(db, 'account.bank.statement', {
    name: 'STMT/STM2/F3',
    journal_id: bankJournal.id,
    date: '2026-06-01',
    balance_start: 0,
    balance_end_real: 250,
    line_ids: [
      { date: '2026-06-01', payment_ref: 'Line 1', partner_id: partnerA.id, amount: 150 },
      { date: '2026-06-02', payment_ref: 'Line 2', partner_id: null, amount: 100 },
    ],
  });
  db = stmtCreated.db;
  const lines = search(db, 'account.bank.statement.line').filter((l) => l.statement_id === stmtCreated.id);
  const line1 = lines.find((l) => l.payment_ref === 'Line 1');
  const line2 = lines.find((l) => l.payment_ref === 'Line 2');

  // Reconcile line 1 so statement has reconciled lines
  const inv1 = makePostedInvoice(db, { partnerId: partnerA.id, price: 150, date: '2026-06-01' });
  db = reconcileWith(inv1.db, line1, inv1.id);

  // 1. setStatementLinePartner on line 2 must throw
  assert.throws(
    () => setStatementLinePartner(db, line2.id, partnerB.id),
    /Cannot change lines of a statement with reconciled lines/
  );

  // 2. Direct write of partner_id on line 2 must throw
  assert.throws(
    () => write(db, 'account.bank.statement.line', line2.id, { partner_id: partnerB.id }),
    /Cannot change lines of a statement with reconciled lines/
  );

  // Direct write of partner_id alongside an unrelated posted move on unreconciled line 2 must throw
  const unrelatedInv = makePostedInvoice(db, { partnerId: partnerA.id, price: 50, date: '2026-06-01' });
  db = unrelatedInv.db;
  assert.throws(
    () => write(db, 'account.bank.statement.line', line2.id, { partner_id: partnerB.id, move_id: unrelatedInv.id }),
    /Cannot change lines of a statement with reconciled lines/
  );

  // Direct write of partner_id on an unreconciled line with an existing bank booking must also throw
  const line2WithBooking = { ...read(db, 'account.bank.statement.line', line2.id), bank_move_id: unrelatedInv.id, open_amount: 100 };
  const dbWithBooking = {
    ...db,
    records: {
      ...db.records,
      'account.bank.statement.line': db.records['account.bank.statement.line'].map((l) => (l.id === line2.id ? line2WithBooking : l)),
    },
  };
  assert.throws(
    () => write(dbWithBooking, 'account.bank.statement.line', line2.id, { partner_id: partnerB.id }),
    /Cannot change lines of a statement with reconciled lines/
  );

  // 3. Model field partner_id is readonly for line 2
  const isReadonly = bankModels['account.bank.statement.line'].fields.partner_id.readonly(read(db, 'account.bank.statement.line', line2.id), db);
  assert.equal(isReadonly, true);

  // 4. Authorized reconciliation workflow succeeds and assigns invoice partner
  const inv2 = makePostedInvoice(db, { partnerId: partnerB.id, price: 100, date: '2026-06-02' });
  db = inv2.db;
  const recDb = reconcileWith(db, read(db, 'account.bank.statement.line', line2.id), inv2.id);
  const reconciledLine2 = read(recDb, 'account.bank.statement.line', line2.id);
  assert.equal(reconciledLine2.state, 'reconciled');
  assert.equal(reconciledLine2.partner_id, partnerB.id);
});

test('STM2-6: Reordering transactions updates sequence even when lines are reconciled or locked', async () => {
  let db = seed();
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  const partner = search(db, 'res.partner')[0];

  const stmtCreated = create(db, 'account.bank.statement', {
    name: 'STMT/STM2/F4',
    journal_id: bankJournal.id,
    date: '2026-06-01',
    balance_start: 0,
    balance_end_real: 200,
    line_ids: [
      { date: '2026-06-01', payment_ref: 'Line A', partner_id: partner.id, amount: 100, sequence: 10 },
      { date: '2026-06-01', payment_ref: 'Line B', partner_id: partner.id, amount: 100, sequence: 20 },
    ],
  });
  db = stmtCreated.db;
  const lines = search(db, 'account.bank.statement.line').filter((l) => l.statement_id === stmtCreated.id);
  const lineA = lines.find((l) => l.payment_ref === 'Line A');
  const lineB = lines.find((l) => l.payment_ref === 'Line B');

  // Reconcile line A
  const inv = makePostedInvoice(db, { partnerId: partner.id, price: 100, date: '2026-06-01' });
  db = reconcileWith(inv.db, lineA, inv.id);

  // Renumbering sequences across all bank lines (as generic List drag handler does) must succeed
  const updates = new Map([
    [lineA.id, { sequence: 20 }],
    [lineB.id, { sequence: 10 }],
  ]);
  const updatedDb = writeMany(db, 'account.bank.statement.line', updates);
  assert.equal(read(updatedDb, 'account.bank.statement.line', lineA.id).sequence, 20);
  assert.equal(read(updatedDb, 'account.bank.statement.line', lineB.id).sequence, 10);
});

test('STM2-7: Closing a cash statement with a reconciled line and a nonzero count difference books difference line', async () => {
  let db = seed();
  const cashJournal = search(db, 'account.journal').find((j) => j.type === 'cash' && (j.company_id ?? 1) === 1);
  const profitAccount = search(db, 'account.account').find((a) => a.code === '600000')?.id ?? 1;
  const lossAccount = search(db, 'account.account').find((a) => a.code === '600000')?.id ?? 1;
  db = write(db, 'account.journal', cashJournal.id, {
    profit_account_id: profitAccount,
    loss_account_id: lossAccount,
  });
  const partner = search(db, 'res.partner')[0];

  const cashStmt = create(db, 'account.bank.statement', {
    name: 'CASH/2026/001',
    journal_id: cashJournal.id,
    date: '2026-06-01',
    balance_start: 100,
    balance_end_real: 220,
    line_ids: [
      { date: '2026-06-01', payment_ref: 'Cash Sale 1', partner_id: partner.id, amount: 100 },
    ],
  });
  db = cashStmt.db;
  const lines = search(db, 'account.bank.statement.line').filter((l) => l.statement_id === cashStmt.id);
  const line1 = lines[0];

  // Reconcile line 1 so the cash statement has a reconciled line
  const inv = makePostedInvoice(db, { partnerId: partner.id, price: 100, date: '2026-06-01' });
  db = reconcileWith(inv.db, line1, inv.id);
  assert.equal(read(db, 'account.bank.statement.line', line1.id).state, 'reconciled');

  // Computed balance is 100 (start) + 100 (line1) = 200.
  // Counted ending balance is 220. Difference is +20 (surplus).
  // Ordinary new lines on this statement with reconciled lines are rejected
  assert.throws(
    () => create(db, 'account.bank.statement.line', {
      statement_id: cashStmt.id,
      journal_id: cashJournal.id,
      date: '2026-06-01',
      payment_ref: 'Unauthorized cash line',
      amount: 20,
    }),
    /Cannot add lines to a statement with reconciled lines/
  );

  // Closing the cash statement must succeed and create + book the cash difference line
  const closedDb = closeStatement(db, cashStmt.id);
  const closedStmt = read(closedDb, 'account.bank.statement', cashStmt.id);
  assert.equal(closedStmt.state, 'closed');

  const allLines = search(closedDb, 'account.bank.statement.line').filter((l) => l.statement_id === cashStmt.id);
  assert.equal(allLines.length, 2);
  const diffLine = allLines.find((l) => l.id !== line1.id);
  assert.ok(diffLine, 'Cash difference line must be created');
  assert.equal(diffLine.amount, 20);
  assert.equal(diffLine.counterpart_account_id, profitAccount);
  assert.ok(diffLine.bank_move_id, 'Cash difference line must be booked');
});

test('STM2-8: Escaping reconciliation error in runScheduledJobs reports identifiable job name autoReconcile', async () => {
  const db = seed();
  const reportedJobs = [];
  const faultyDb = {
    ...db,
    records: new Proxy(db.records, {
      get(target, prop) {
        if (prop === 'account.bank.statement.line') {
          throw new Error('Disk read error during bank statement line search');
        }
        return target[prop];
      },
    }),
  };
  runScheduledJobs(faultyDb, '2026-06-01', {
    onError: (job) => reportedJobs.push(job),
  });
  assert.ok(reportedJobs.includes('autoReconcile'), `Expected onError to report 'autoReconcile', got: ${reportedJobs}`);
  assert.ok(!reportedJobs.includes('job'), `onError must not fall back to generic 'job' name`);
});

test('STM2-9: Directly created cash-difference lines cannot bypass booking on open or closed statements (Finding 1 regression)', async () => {
  let db = seed();
  const cashJournal = search(db, 'account.journal').find((j) => j.type === 'cash' && (j.company_id ?? 1) === 1);
  const profitAccount = search(db, 'account.account').find((a) => a.code === '450000' && (a.company_id ?? 1) === 1);
  const lossAccount = search(db, 'account.account').find((a) => a.code === '690000' && (a.company_id ?? 1) === 1);
  db = write(db, 'account.journal', cashJournal.id, {
    profit_account_id: profitAccount.id,
    loss_account_id: lossAccount.id,
  });
  const partner = search(db, 'res.partner')[0];

  const cashStmt = create(db, 'account.bank.statement', {
    name: 'CASH/STM2/F1',
    journal_id: cashJournal.id,
    date: '2026-06-10',
    balance_start: 100,
    balance_end_real: 220,
    line_ids: [
      { date: '2026-06-10', payment_ref: 'Cash Sale', partner_id: partner.id, amount: 100 },
    ],
  });
  db = cashStmt.db;
  const line1 = search(db, 'account.bank.statement.line').find((l) => l.statement_id === cashStmt.id);
  const inv = makePostedInvoice(db, { partnerId: partner.id, price: 100, date: '2026-06-10' });
  db = reconcileWith(inv.db, line1, inv.id);

  // 1. Direct create with exact diff & profit_account_id (with or without forged fields/ctx) is rejected
  assert.throws(
    () => create(db, 'account.bank.statement.line', {
      statement_id: cashStmt.id,
      journal_id: cashJournal.id,
      company_id: 1,
      date: '2026-06-10',
      payment_ref: 'Direct Unbooked Diff',
      amount: 20,
      counterpart_account_id: profitAccount.id,
      state: 'to_check',
    }),
    /Cannot add lines to a statement with reconciled lines/
  );
  assert.throws(
    () => create(db, 'account.bank.statement.line', {
      statement_id: cashStmt.id,
      journal_id: cashJournal.id,
      company_id: 1,
      date: '2026-06-10',
      payment_ref: 'Forged Provenance',
      amount: 20,
      counterpart_account_id: profitAccount.id,
      state: 'to_check',
      is_cash_difference: true,
    }, { cashDifferenceClose: true }),
    /Cannot add lines to a statement with reconciled lines/
  );

  // 2. Sync diff trying to insert an unbooked line on open or closing statement is rejected
  const rawStmt = db.records['account.bank.statement'].find((s) => s.id === cashStmt.id);
  const forgedLineId = (db.seq['account.bank.statement.line'] ?? 0) + 1;
  const forgedOpenDiff = {
    upserts: {
      'account.bank.statement.line': [{
        id: forgedLineId,
        statement_id: cashStmt.id,
        journal_id: cashJournal.id,
        company_id: 1,
        date: '2026-06-10',
        payment_ref: 'Bypass Diff',
        amount: 20,
        counterpart_account_id: profitAccount.id,
        state: 'to_check',
      }],
    },
  };
  assert.throws(() => applyDiff(db, forgedOpenDiff, { author: 'Clerk', isAdmin: false }), /Cannot add lines to a statement with reconciled lines/);

  const forgedUnbookedCloseDiff = {
    upserts: {
      'account.bank.statement': [{ ...rawStmt, state: 'closed' }],
      'account.bank.statement.line': [{
        id: forgedLineId,
        statement_id: cashStmt.id,
        journal_id: cashJournal.id,
        company_id: 1,
        date: '2026-06-10',
        payment_ref: 'Unbooked Close Diff',
        amount: 20,
        counterpart_account_id: profitAccount.id,
        state: 'to_check',
        is_cash_difference: true,
      }],
    },
  };
  assert.throws(() => applyDiff(db, forgedUnbookedCloseDiff, { author: 'Clerk', isAdmin: false }), /Cash difference provenance can only be set when closing a cash statement/);

  // 3. Forging is_cash_difference on an ordinary unlocked statement or mutating an existing line is rejected
  const unlockedStmt = create(db, 'account.bank.statement', {
    name: 'CASH/STM2/UNLOCKED',
    journal_id: cashJournal.id,
    date: '2026-06-11',
    balance_start: 0,
    balance_end_real: 20,
  });
  assert.throws(
    () => create(unlockedStmt.db, 'account.bank.statement.line', {
      statement_id: unlockedStmt.id,
      journal_id: cashJournal.id,
      company_id: 1,
      date: '2026-06-11',
      payment_ref: 'Forged on unlocked',
      amount: 20,
      counterpart_account_id: profitAccount.id,
      is_cash_difference: true,
    }),
    /Cash difference provenance can only be set when closing a cash statement/
  );
  assert.throws(
    () => write(db, 'account.bank.statement.line', line1.id, { is_cash_difference: true }),
    /Cash difference provenance cannot be changed/
  );

  // 4. Legitimate closeStatement creates, books, and marks the difference line, and replays cleanly via applyDiff
  const closedDb = closeStatement(db, cashStmt.id);
  const syncedClosedDb = applyDiff(db, diffDb(db, closedDb), { author: 'Clerk', isAdmin: false });
  assert.equal(read(syncedClosedDb, 'account.bank.statement', cashStmt.id).state, 'closed');
  const diffLine = search(syncedClosedDb, 'account.bank.statement.line').find((l) => l.statement_id === cashStmt.id && l.id !== line1.id);
  assert.ok(diffLine);
  assert.equal(diffLine.amount, 20);
  assert.equal(diffLine.is_cash_difference, true);
  assert.equal(diffLine.state, 'reconciled');
  assert.ok(diffLine.bank_move_id);

  // 5. Already-closed statement with manual balance_end_real mismatch rejects direct line creation even with profit account
  const emptyClosed = create(db, 'account.bank.statement', {
    name: 'CASH/STM2/ALREADYCLOSED',
    journal_id: cashJournal.id,
    date: '2026-06-12',
    balance_start: 0,
    balance_end_real: 50,
  });
  const closedDirect = write(emptyClosed.db, 'account.bank.statement', emptyClosed.id, { state: 'closed' });
  assert.throws(
    () => create(closedDirect, 'account.bank.statement.line', {
      statement_id: emptyClosed.id,
      journal_id: cashJournal.id,
      company_id: 1,
      date: '2026-06-12',
      payment_ref: 'Sneak on closed',
      amount: 50,
      counterpart_account_id: profitAccount.id,
    }),
    /Cannot add lines to a closed statement/
  );
});

test('STM2-10: Cash statements with ordinary lines on profit/loss accounts close cleanly, while duplicate closing adjustments are blocked (Finding 2 regression)', async () => {
  let db = seed();
  const cashJournal = search(db, 'account.journal').find((j) => j.type === 'cash' && (j.company_id ?? 1) === 1);
  const profitAccount = search(db, 'account.account').find((a) => a.code === '450000' && (a.company_id ?? 1) === 1);
  const lossAccount = search(db, 'account.account').find((a) => a.code === '690000' && (a.company_id ?? 1) === 1);
  db = write(db, 'account.journal', cashJournal.id, {
    profit_account_id: profitAccount.id,
    loss_account_id: lossAccount.id,
  });

  // Statement with an ordinary cash transaction booked directly to loss_account_id (and another to profit_account_id)
  const cashStmt = create(db, 'account.bank.statement', {
    name: 'CASH/STM2/F2',
    journal_id: cashJournal.id,
    date: '2026-06-15',
    balance_start: 100,
    balance_end_real: 115, // 100 - 30 + 50 = 120 computed -> -5 shortage
    line_ids: [
      { date: '2026-06-15', payment_ref: 'Ordinary Expense on Loss Acct', amount: -30 },
      { date: '2026-06-15', payment_ref: 'Ordinary Income on Profit Acct', amount: 50 },
    ],
  });
  db = cashStmt.db;
  const lines = search(db, 'account.bank.statement.line').filter((l) => l.statement_id === cashStmt.id);
  const expLine = lines.find((l) => l.amount === -30);
  const incLine = lines.find((l) => l.amount === 50);

  db = write(db, 'account.bank.statement.line', expLine.id, { counterpart_account_id: lossAccount.id });
  db = bookToAccount(db, read(db, 'account.bank.statement.line', expLine.id)).db;
  db = write(db, 'account.bank.statement.line', incLine.id, { counterpart_account_id: profitAccount.id });
  db = bookToAccount(db, read(db, 'account.bank.statement.line', incLine.id)).db;

  assert.equal(read(db, 'account.bank.statement.line', expLine.id).state, 'reconciled');
  assert.equal(read(db, 'account.bank.statement.line', incLine.id).state, 'reconciled');
  assert.ok(!read(db, 'account.bank.statement.line', expLine.id).is_cash_difference);
  assert.ok(!read(db, 'account.bank.statement.line', incLine.id).is_cash_difference);

  // Closing must succeed and create + book the -5 shortage difference line
  const closedDb = closeStatement(db, cashStmt.id);
  const syncedDb = applyDiff(db, diffDb(db, closedDb), { author: 'Clerk', isAdmin: false });
  assert.equal(read(syncedDb, 'account.bank.statement', cashStmt.id).state, 'closed');
  const stmtLines = search(syncedDb, 'account.bank.statement.line').filter((l) => l.statement_id === cashStmt.id);
  assert.equal(stmtLines.length, 3);
  const diffLine = stmtLines.find((l) => l.id !== expLine.id && l.id !== incLine.id);
  assert.ok(diffLine, 'Cash difference line must be created even when ordinary lines use profit/loss accounts');
  assert.equal(diffLine.amount, -5);
  assert.equal(diffLine.counterpart_account_id, lossAccount.id);
  assert.equal(diffLine.is_cash_difference, true);
  assert.equal(diffLine.state, 'reconciled');
  assert.ok(diffLine.bank_move_id);

  // Duplicate closing-generated cash-difference line on an open statement must still be rejected
  const dupStmt = create(db, 'account.bank.statement', {
    name: 'CASH/STM2/DUP',
    journal_id: cashJournal.id,
    date: '2026-06-16',
    balance_start: 0,
    balance_end_real: 40,
  });
  let dupDb = dupStmt.db;
  const existingDiffLine = create(dupDb, 'account.bank.statement.line', {
    statement_id: dupStmt.id,
    journal_id: cashJournal.id,
    company_id: 1,
    date: '2026-06-16',
    payment_ref: 'Prior Diff',
    amount: 10,
    counterpart_account_id: profitAccount.id,
    state: 'to_check',
  });
  dupDb = existingDiffLine.db;
  dupDb = bookToAccount(dupDb, read(dupDb, 'account.bank.statement.line', existingDiffLine.id)).db;
  // Simulate pre-existing closing-generated provenance on that line
  dupDb = {
    ...dupDb,
    records: {
      ...dupDb.records,
      'account.bank.statement.line': dupDb.records['account.bank.statement.line'].map((l) => (
        l.id === existingDiffLine.id ? { ...l, is_cash_difference: true } : l
      )),
    },
  };
  assert.throws(() => closeStatement(dupDb, dupStmt.id), /Cannot add lines to a statement with reconciled lines/);
});
