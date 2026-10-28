import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { approvalsPlusModels, submitRequest, approve, refuse, withdraw, pendingFor } from './models/approvalsplus.js';

const request = (db, id) => read(db, 'approval.request', id);
const act = (fn, db, id, ...args) => fn(db, request(db, id), ...args);
function fixture(category = {}, vals = {}) {
  const type = create(seed(), 'approval.category', { name: 'Equipment', approver_ids: [
    { employee_id: 1, sequence: 10, required: false },
    { employee_id: 2, sequence: 20, required: false },
    { employee_id: 3, sequence: 30, required: true },
  ], ...category });
  return create(type.db, 'approval.request', { name: 'New equipment', category_id: type.id, request_owner_id: 5, ...vals });
}

test('approval types expose defaults and forms; legacy approval seed still loads unchanged', () => {
  const db = seed();
  const rows = search(db, 'approval.request');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.state), ['pending', 'approved']);
  assert.deepEqual(rows.map((r) => [r.category, r.request_owner_id, r.approver_id, r.amount, r.request_status]), [['purchase', 5, 4, 1200, 'pending'], ['travel', 2, 1, 900, 'approved']]);
  const type = approvalsPlusModels['approval.category'];
  assert.equal(type.label, 'Approval Types');
  assert.equal(type.defaults().approval_minimum, 1);
  assert.deepEqual(type.form.tabs[0].fields, ['approver_ids']);
  const form = approvalsPlusModels['approval.request'].form;
  assert.equal(form.statusbar, 'state');
  assert.deepEqual(form.buttons.map((b) => b.label), ['Submit', 'Approve', 'Refuse', 'Withdraw', 'Cancel']);
  assert.ok(form.tabs.some((t) => t.fields.includes('approver_ids')));
});

test('submission validates each category-required field without changing the input database', () => {
  for (const [flag, vals, message] of [
    ['has_amount', { amount: 0 }, /Amount/],
    ['has_amount', { amount: -4 }, /Amount/],
    ['has_date', { date: '' }, /Date/],
    ['has_partner', { partner_id: 99999 }, /Partner/],
    ['has_product', { product_lines: [] }, /Products/],
    ['has_product', { product_lines: [{ product_id: 1, qty: 0 }] }, /Products/],
  ]) {
    const { db, id } = fixture({ [flag]: 'required' }, vals);
    const before = JSON.stringify(db);
    assert.throws(() => act(submitRequest, db, id), message);
    assert.equal(JSON.stringify(db), before);
  }
  const { db, id } = fixture({ has_amount: 'required', has_date: 'required', has_partner: 'required', has_product: 'required' }, { amount: 10, date: '2026-08-01', partner_id: 2, product_lines: [{ product_id: 1, qty: 1, price: 10 }] });
  assert.equal(request(act(submitRequest, db, id), id).state, 'pending');
  const missing = write(db, 'approval.request', id, { category_id: null });
  assert.throws(() => act(submitRequest, missing, id), /approval type/);
});

test('submission adds the owner manager using parent_id and deduplicates an existing manager', () => {
  for (const mode of ['approver', 'required']) {
    const { db, id } = fixture({ manager_approval: mode, approver_ids: [{ employee_id: 2, sequence: 10 }] });
    const managerId = read(db, 'hr.employee', 5).parent_id;
    const before = JSON.stringify(db);
    const submitted = act(submitRequest, db, id);
    const lines = request(submitted, id).approver_ids;
    assert.equal(lines.length, managerId === 2 ? 1 : 2);
    assert.equal(lines.find((a) => a.employee_id === managerId).required, mode === 'required');
    assert.ok(lines.every((a) => a.status === 'pending'));
    assert.equal(JSON.stringify(db), before);
    assert.throws(() => act(submitRequest, submitted, id), /Only a new/);
    const again = fixture({ manager_approval: mode, approver_ids: [{ employee_id: managerId, sequence: 20 }] });
    assert.equal(request(act(submitRequest, again.db, again.id), again.id).approver_ids.length, 1);
  }
});

test('submission rejects impossible rosters, invalid employees, missing required managers and reversed dates', () => {
  for (const [category, vals, pattern] of [
    [{ approval_minimum: 4 }, {}, /minimum/],
    [{ approval_minimum: 0 }, {}, /minimum/],
    [{ approver_ids: [{ employee_id: 99999 }] }, {}, /every approver/],
    [{ approver_ids: [{ employee_id: 1 }, { employee_id: 1 }] }, {}, /only be listed once/],
    [{ manager_approval: 'required' }, { request_owner_id: 1 }, /manager/],
    [{}, { date: '2026-08-02', date_end: '2026-08-01' }, /End date/],
  ]) {
    const { db, id } = fixture(category, vals);
    assert.throws(() => act(submitRequest, db, id), pattern);
  }
});

test('both the minimum and every required approval must be met; stale requests cannot replay approval', () => {
  const { db, id } = fixture({ approval_minimum: 2 });
  assert.equal(request(db, id).state, 'new');
  const pending = act(submitRequest, db, id);
  const stale = request(pending, id);
  assert.throws(() => act(approve, pending, id, 6), /pending approver/);
  const once = approve(pending, stale, 1);
  assert.equal(request(once, id).state, 'pending');
  assert.throws(() => approve(once, stale, 1), /pending approver/);
  const twice = act(approve, once, id, 2);
  assert.equal(request(twice, id).state, 'pending');
  const done = act(approve, twice, id, 3);
  assert.equal(request(done, id).state, 'approved');
  assert.equal(request(done, id).request_status, 'approved');
  assert.equal(request(pending, id).approver_ids[0].status, 'pending');
  assert.deepEqual(pendingFor(done, 2).filter((r) => r.id === id), []);
  assert.throws(() => act(refuse, done, id, 2, 'No'), /pending approver/);
  const other = fixture({ approval_minimum: 2 });
  const one = act(approve, act(submitRequest, other.db, other.id), other.id, 3);
  assert.equal(request(one, other.id).state, 'pending');
  assert.equal(request(act(approve, one, other.id, 1), other.id).state, 'approved');
});

test('sequence mode sorts approvers, exposes just the current approver and advances one at a time', () => {
  const { db, id } = fixture({ approver_sequence: true, approval_minimum: 2, approver_ids: [
    { employee_id: 3, sequence: 30, required: true }, { employee_id: 2, sequence: 20 }, { employee_id: 1, sequence: 10 },
  ] });
  const submitted = act(submitRequest, db, id);
  assert.deepEqual(request(submitted, id).approver_ids.map((a) => [a.employee_id, a.status]), [[1, 'pending'], [2, 'new'], [3, 'new']]);
  assert.ok(pendingFor(submitted, 1).some((r) => r.id === id));
  assert.ok(!pendingFor(submitted, 2).some((r) => r.id === id));
  assert.throws(() => act(approve, submitted, id, 2), /pending approver/);
  assert.throws(() => act(refuse, submitted, id, 3, 'No'), /pending approver/);
  const one = act(approve, submitted, id, 1);
  assert.ok(pendingFor(one, 2).some((r) => r.id === id));
  const two = act(approve, one, id, 2);
  assert.equal(request(two, id).state, 'pending');
  assert.ok(pendingFor(two, 3).some((r) => r.id === id));
  assert.equal(request(act(approve, two, id, 3), id).state, 'approved');
});

test('sequence may finish at its minimum without waiting for optional approvers', () => {
  const { db, id } = fixture({ approver_sequence: true, approver_ids: [
    { employee_id: 1, sequence: 10 }, { employee_id: 2, sequence: 20 },
  ] });
  const pending = act(submitRequest, db, id);
  const done = act(approve, pending, id, 1);
  assert.equal(request(done, id).state, 'approved');
  assert.equal(request(done, id).approver_ids[1].status, 'new');
  assert.ok(!pendingFor(done, 2).some((r) => r.id === id));
});

test('pendingFor returns all and only requests currently waiting for the given employee', () => {
  const first = fixture({ approver_sequence: true });
  const second = create(first.db, 'approval.request', { name: 'Second request', category_id: request(first.db, first.id).category_id });
  const pending = act(submitRequest, act(submitRequest, second.db, first.id), second.id);
  assert.deepEqual(pendingFor(pending, 1).map((r) => r.id), [first.id, second.id]);
  assert.deepEqual(pendingFor(pending, 2), []);
  const advanced = act(approve, pending, first.id, 1);
  assert.deepEqual(pendingFor(advanced, 1).map((r) => r.id), [second.id]);
  assert.deepEqual(pendingFor(advanced, 2).map((r) => r.id), [first.id]);
  assert.deepEqual(pendingFor(advanced, 99999), []);
});

test('any pending approver can refuse; a nonempty reason is logged and the workflow stops', () => {
  const { db, id } = fixture();
  const pending = act(submitRequest, db, id);
  assert.throws(() => act(refuse, pending, id, 2, '  '), /reason/);
  const refused = act(refuse, pending, id, 2, ' Not in budget ');
  assert.equal(request(refused, id).state, 'refused');
  assert.equal(request(refused, id).approver_ids.find((a) => a.employee_id === 2).status, 'refused');
  assert.ok(refused.messages.some((m) => m.res_id === id && m.model === 'approval.request' && m.body === 'Not in budget'));
  assert.ok(!pendingFor(refused, 1).some((r) => r.id === id));
  assert.throws(() => act(approve, refused, id, 1), /pending approver/);
});

test('purchase approval creates exactly one linked draft RFQ with mapped prices and 14 percent tax', () => {
  const { db, id } = fixture({ approval_type: 'purchase', approver_ids: [{ employee_id: 1, required: true }] }, { partner_id: 2, product_lines: [{ product_id: 1, qty: 2, price: 95 }] });
  const initialCount = search(db, 'purchase.order').length;
  const pending = act(submitRequest, db, id);
  assert.equal(search(pending, 'purchase.order').length, initialCount);
  const stale = request(pending, id);
  const done = approve(pending, stale, 1);
  const po = read(done, 'purchase.order', request(done, id).purchase_id);
  assert.equal(search(done, 'purchase.order').length, initialCount + 1);
  assert.equal(po.state, 'draft');
  assert.equal(po.partner_id, 2);
  assert.deepEqual(po.order_line, [{ product_id: 1, qty: 2, price_unit: 95, tax: 14 }]);
  assert.throws(() => approve(done, stale, 1), /pending approver/);
});

test('leave approval creates a linked draft time off for the owner with matching dates', () => {
  const { db, id } = fixture({ approval_type: 'leave', approver_ids: [{ employee_id: 1 }] }, { date: '2026-08-01', date_end: '2026-08-03' });
  const done = act(approve, act(submitRequest, db, id), id, 1);
  const leave = read(done, 'hr.leave', request(done, id).leave_id);
  assert.equal(leave.state, 'confirm');
  assert.equal(leave.employee_id, 5);
  assert.equal(leave.name, 'New equipment');
  assert.equal(leave.date_from, '2026-08-01');
  assert.equal(leave.date_to, '2026-08-03');
});

test('generic, borrow, payment and travel approvals create no purchasing or leave records', () => {
  for (const approval_type of ['generic', 'borrow', 'payment', 'travel']) {
    const { db, id } = fixture({ approval_type, approver_ids: [{ employee_id: 1 }] });
    const done = act(approve, act(submitRequest, db, id), id, 1);
    assert.equal(request(done, id).state, 'approved');
    for (const model of ['purchase.order', 'hr.leave']) assert.deepEqual(done.records[model], db.records[model]);
  }
});

test('withdraw resets a submitted roster but is forbidden after even one approval', () => {
  const { db, id } = fixture();
  const submitted = act(submitRequest, db, id);
  const back = act(withdraw, submitted, id);
  assert.equal(request(back, id).state, 'new');
  assert.deepEqual(request(back, id).approver_ids, []);
  assert.ok(!pendingFor(back, 1).some((r) => r.id === id));
  assert.equal(request(act(submitRequest, back, id), id).state, 'pending');
  assert.throws(() => act(withdraw, act(approve, submitted, id, 1), id), /before any approval/);
  assert.throws(() => act(withdraw, db, id), /submitted request/);
});

test('form actions prompt for the employee and refusal reason, support dismissal and cancel safely', (t) => {
  const { db, id } = fixture();
  const buttons = approvalsPlusModels['approval.request'].form.buttons;
  const run = (label, next) => buttons.find((b) => b.label === label).run(next, request(next, id)).db;
  const pending = run('Submit', db);
  const answers = ['2', 'UI refusal'];
  const original = Object.getOwnPropertyDescriptor(globalThis, 'prompt');
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'prompt', original);
    else delete globalThis.prompt;
  });
  globalThis.prompt = () => answers.shift();
  assert.equal(request(run('Refuse', pending), id).state, 'refused');
  globalThis.prompt = () => null;
  assert.equal(run('Approve', pending), pending);
  globalThis.prompt = () => '1';
  assert.equal(request(run('Approve', pending), id).approver_ids[0].status, 'approved');
  const cancelled = run('Cancel', pending);
  assert.equal(request(cancelled, id).state, 'cancel');
  assert.ok(!pendingFor(cancelled, 1).some((r) => r.id === id));
  assert.throws(() => act(submitRequest, cancelled, id), /Only a new/);
});
