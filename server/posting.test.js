// Cashiers and payroll officers complete sales and payslips: the server books the journal entry for them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from '../src/orm.js';
import { modelsForApps } from '../src/models/index.js';
import { startSession } from '../src/models/pos.js';
import { applyDiff, diffDb } from '../src/sync.js';
import { seed } from '../src/seed.js';
import { runPosting } from './posting.js';

const moves = (db) => search(db, 'account.move').length;
const commitAsSystem = (db, next) => applyDiff(db, diffDb(db, next), { author: 'test', isAdmin: false, allowed: null });

test('POS refuses invalid quantities and discounts before posting', () => {
  const db = startSession(seed(), 0).db;
  for (const line of [{ qty: -1 }, { qty: 0 }, { qty: Infinity }, { qty: NaN }, { qty: 1, discount: 101 }, { qty: 1, discount: -1 }, { qty: 1, discount: Infinity }]) {
    assert.throws(() => runPosting(db, null, '/api/pos/pay', { lines: [{ product_id: 1, ...line }], method: 'cash' }), /Invalid cart/);
  }
});

test('POS refuses products outside the register catalog', () => {
  const db = startSession(seed(), 0).db;
  for (const vals of [{ active: false }, { available_in_pos: false }, { sale_ok: false }]) {
    const unavailable = write(db, 'product', 1, vals);
    assert.throws(() => runPosting(unavailable, null, '/api/pos/pay', { lines: [{ product_id: 1, qty: 1 }], method: 'cash' }), /not available in POS/);
  }
  assert.throws(() => runPosting(db, null, '/api/pos/pay', { lines: [{ product_id: 999999, qty: 1 }], method: 'cash' }), /not available in POS/);
});

test('a POS-only user pays an order: the server prices it and posts the entry', () => {
  const pos = modelsForApps(['pos']);
  assert.equal(pos.has('account.move'), false);
  const db = startSession(seed(), 100).db;
  const out = runPosting(db, pos, '/api/pos/pay', { lines: [{ product_id: 1, qty: 2, price_unit: 0.01 }], method: 'cash' });
  const saved = commitAsSystem(db, out.db);
  const order = read(saved, 'pos.order', out.body.id);
  assert.equal(order.name, out.body.name);
  assert.ok(order.lines[0].price_unit > 1, 'price comes from the product, not the request');
  assert.ok(moves(saved) > moves(db));
  const closed = commitAsSystem(saved, runPosting(saved, pos, '/api/pos/close', { session_id: order.session_id, counted: 0 }).db);
  assert.equal(read(closed, 'pos.session', order.session_id).state, 'closed');
});

test('server POS posting preserves split tenders and whole quantities', () => {
  const db = startSession(seed(), 0).db;
  const body = { lines: [{ product_id: 1, qty: 1 }], method: 'cash' };
  const single = runPosting(db, null, '/api/pos/pay', body);
  const due = read(single.db, 'pos.order', single.body.id).amount_total;
  const payments = [{ method: 'cash', amount: 10 }, { method: 'card', amount: due - 10 }];
  const out = runPosting(db, modelsForApps(['pos']), '/api/pos/pay', { ...body, payments });
  const saved = commitAsSystem(db, out.db);
  const order = read(saved, 'pos.order', out.body.id);
  assert.equal(order.lines[0].qty, 1);
  assert.deepEqual(order.payment_ids.map((p) => p.amount), payments.map((p) => p.amount));
  assert.throws(() => runPosting(db, null, '/api/pos/pay', { ...body, payments: [{ method: 'bitcoin', amount: due }] }), /Invalid payments/);
});

test('a payroll-only user confirms a payslip through the posting button', () => {
  const payroll = modelsForApps(['payroll']);
  const { db, id } = create(seed(), 'hr.payslip', { employee_id: 1 });
  const out = runPosting(db, payroll, '/api/button', { model: 'hr.payslip', id, label: 'Confirm' });
  const saved = commitAsSystem(db, out.db);
  assert.equal(read(saved, 'hr.payslip', id).state, 'done');
  assert.ok(moves(saved) > moves(db));
});

test('users without the business document, and buttons not marked as posting, are refused', () => {
  const { db, id } = create(seed(), 'hr.payslip', { employee_id: 1 });
  assert.throws(() => runPosting(db, modelsForApps(['crm']), '/api/button', { model: 'hr.payslip', id, label: 'Confirm' }), /No access/);
  assert.throws(() => runPosting(db, null, '/api/button', { model: 'hr.payslip', id, label: 'Cancel' }), /not available/);
  assert.throws(() => runPosting(db, null, '/api/button', { model: 'hr.payslip', id, label: 'Mark as Paid' }), /not available/);
  assert.throws(() => runPosting(startSession(db, 0).db, modelsForApps(['pos']), '/api/pos/pay', { lines: [{ product_id: 1, qty: 1 }], method: 'bitcoin' }), /payment method/);
});
