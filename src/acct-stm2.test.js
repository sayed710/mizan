import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

import { create, read, search, unlink, write } from './orm.js';
import { seed } from './seed.js';
import { menusFor } from './models/index.js';
import { postMove } from './models/accounting.js';
import { reconcileWith } from './models/bank.js';
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
