import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, write } from './orm.js';
import { seed } from './seed.js';
import { applyDiff, diffDb } from './sync.js';
import { approvalError, employeeFor, manages } from './models/authority.js';
import { approveSheet, createSheet, submitSheet } from './models/expenseplus.js';
import { approve, submitRequest } from './models/approvalsplus.js';
import { validateTimesheets } from './models/timesheetplus.js';

// Seed chain: Admin(1) manages Mona(2) and Hana(4); Mona manages Youssef(3); Hana manages Karim(5) and Laila(6).
const linked = () => [[2, 'mona'], [3, 'youssef'], [4, 'hana'], [5, 'karim']].reduce((db, [id, login]) => write(db, 'hr.employee', id, { user_login: login }), seed());
const as = (login, name = login) => ({ isAdmin: false, login, author: name });
const save = (db, next, who) => applyDiff(db, diffDb(db, next), who);

test('managers are found up the chain; nobody manages themselves', () => {
  const db = linked();
  assert.ok(manages(db, 2, 3));
  assert.ok(manages(db, 1, 3));
  assert.ok(!manages(db, 3, 3));
  assert.ok(!manages(db, 4, 3));
  assert.equal(employeeFor(db, 'hana').id, 4);
  assert.equal(approvalError(db, { isAdmin: true }, 3), null);
  assert.match(approvalError(db, { isAdmin: false, login: 'nobody' }, 3), /link your user/);
});

test('time off is approved by the manager only, never by the employee or a peer', () => {
  const db = linked();
  const approved = write(db, 'hr.leave', 1, { state: 'validate' }); // leave 1 belongs to Youssef (3)
  assert.throws(() => save(db, approved, as('youssef')), /your own request/);
  assert.throws(() => save(db, approved, as('hana')), /manager can approve/);
  assert.equal(read(save(db, approved, as('mona')), 'hr.leave', 1).state, 'validate');
  // An approved leave cannot be quietly edited by its owner either.
  const stretched = write(db, 'hr.leave', 2, { name: 'Longer' }); // leave 2: Karim (5), approved
  assert.throws(() => save(db, stretched, as('karim')), /your own request/);
  // A new leave cannot be created already approved.
  const planted = create(db, 'hr.leave', { name: 'Free days', employee_id: 5, state: 'validate', leave_type: 'unpaid' }).db;
  assert.throws(() => save(db, planted, as('karim')), /must start as To Approve/);
  assert.throws(() => save(db, planted, as('mona')), /must start as To Approve/, 'not even a manager creates it already approved');
});

test("expense reports are approved by the report's manager", () => {
  const made = create(linked(), 'hr.expense', { name: 'Taxi', employee_id: 3, total_amount: 50, tax: 0 });
  const sheet = createSheet(made.db, [made.id], { name: 'June' });
  const submitted = submitSheet(sheet.db, sheet.id);
  const approved = approveSheet(submitted, sheet.id, 2);
  assert.throws(() => save(submitted, approved, as('youssef')), /your own request/);
  assert.throws(() => save(submitted, approved, as('hana')), /manager can approve/);
  assert.equal(read(save(submitted, approved, as('mona')), 'hr.expense.sheet', sheet.id).state, 'approve');
  // A single expense's Approve button is a plain state write: same rule.
  const single = create(linked(), 'hr.expense', { name: 'Lunch', employee_id: 5, total_amount: 10, tax: 0, state: 'submitted' });
  assert.throws(() => save(single.db, write(single.db, 'hr.expense', single.id, { state: 'approved' }), as('karim')), /your own request/);
});

test('timesheets are validated by the manager under their own name, and only admins reset them', () => {
  const line = create(linked(), 'account.analytic.line', { name: 'Work', employee_id: 3, unit_amount: 2, date: '2026-10-01' });
  const byMona = validateTimesheets(line.db, [line.id], { user: 'Mona Adel' });
  assert.throws(() => save(line.db, byMona, as('youssef', 'Youssef Nabil')), /your own request/);
  assert.throws(() => save(line.db, byMona, as('mona', 'Someone Else')), /your own name/);
  const validated = save(line.db, byMona, as('mona', 'Mona Adel'));
  const reset = write(validated, 'account.analytic.line', line.id, { validated: false, validated_by: '', validated_on: null });
  assert.throws(() => save(validated, reset, as('mona', 'Mona Adel')), /Only administrators/);
  assert.equal(read(save(validated, reset, { isAdmin: true }), 'account.analytic.line', line.id).validated, false);
});

test('approval request lines are decided only by their own approver', () => {
  const type = create(linked(), 'approval.category', { name: 'Equipment', approver_ids: [{ employee_id: 2, sequence: 10, required: true }] });
  const req = create(type.db, 'approval.request', { name: 'Laptop', category_id: type.id, request_owner_id: 5 });
  const pending = submitRequest(req.db, read(req.db, 'approval.request', req.id));
  const approved = approve(pending, read(pending, 'approval.request', req.id), 2);
  assert.throws(() => save(pending, approved, as('karim')), /approver line/);
  assert.equal(read(save(pending, approved, as('mona')), 'approval.request', req.id).state, 'approved');
  const forced = write(pending, 'approval.request', req.id, { request_status: 'approved' });
  assert.throws(() => save(pending, forced, as('karim')), /approver line/);
});

test('only admins link users to employees, one employee per user', () => {
  const db = seed();
  assert.throws(() => save(db, write(db, 'hr.employee', 3, { user_login: 'youssef' }), as('youssef')), /Only administrators/);
  const one = save(db, write(db, 'hr.employee', 3, { user_login: 'youssef' }), { isAdmin: true });
  assert.throws(() => save(one, write(one, 'hr.employee', 4, { user_login: 'youssef' }), { isAdmin: true }), /already linked/);
});

test('a requester cannot forge an expense approval by editing who owns the expense or who manages the report', () => {
  const made = create(linked(), 'hr.expense', { name: 'Taxi', employee_id: 5, total_amount: 50, tax: 0 });
  const sheet = createSheet(made.db, [made.id], { name: 'July' });
  const submitted = submitSheet(sheet.db, sheet.id);
  // Karim (5) names a subordinate-looking employee and approves in the same step.
  const forged = write(submitted, 'hr.expense', made.id, { state: 'approved' });
  assert.throws(() => save(submitted, forged, as('karim')), /your own request|manager can approve/);
  const swapped = write(submitted, 'hr.expense.sheet', sheet.id, { state: 'approve', employee_id: 6, manager_id: 5 });
  assert.throws(() => save(submitted, swapped, as('karim')), /cannot change while its status does/);
});

test('expense reports only move along their steps, and the owner may take a submitted report back', () => {
  const made = create(linked(), 'hr.expense', { name: 'Taxi', employee_id: 3, total_amount: 50, tax: 0 });
  const sheet = createSheet(made.db, [made.id], { name: 'June' });
  for (const state of ['approve', 'post', 'done']) {
    assert.throws(() => save(sheet.db, write(sheet.db, 'hr.expense.sheet', sheet.id, { state }), as('youssef')), /cannot go from draft/, state);
  }
  const submitted = submitSheet(sheet.db, sheet.id);
  assert.throws(() => save(submitted, write(submitted, 'hr.expense.sheet', sheet.id, { state: 'post' }), as('youssef')), /cannot go from submit/);
  assert.equal(read(save(submitted, write(submitted, 'hr.expense.sheet', sheet.id, { state: 'draft' }), as('youssef')), 'hr.expense.sheet', sheet.id).state, 'draft');
  assert.throws(() => save(submitted, write(submitted, 'hr.expense.sheet', sheet.id, { state: 'draft' }), as('hana')), /manager can approve/);
});

test('approved time off cannot be deleted by its owner or moved onto the approver', () => {
  const db = linked();
  const mine = write(db, 'hr.leave', 2, { employee_id: 5 }); // leave 2: Karim (5), approved
  assert.throws(() => applyDiff(db, { upserts: {}, deletes: { 'hr.leave': [2] } }, as('karim')), /your own request/);
  assert.equal(applyDiff(db, { upserts: {}, deletes: { 'hr.leave': [2] } }, as('hana')).records['hr.leave'].some((l) => l.id === 2), false);
  // Hana (manages Karim) approves a pending leave of Karim, then tries to move it onto herself.
  const pending = create(db, 'hr.leave', { name: 'Trip', employee_id: 5, leave_type: 'paid', state: 'confirm' });
  const approved = save(pending.db, write(pending.db, 'hr.leave', pending.id, { state: 'validate' }), as('hana'));
  assert.throws(() => save(approved, write(approved, 'hr.leave', pending.id, { employee_id: 4 }), as('hana')), /your own request/);
  assert.throws(() => save(pending.db, write(pending.db, 'hr.leave', pending.id, { state: 'validate', employee_id: 4 }), as('hana')), /your own request/);
  assert.ok(mine);
});

test('a timesheet cannot be validated while being moved to another employee', () => {
  const line = create(linked(), 'account.analytic.line', { name: 'Work', employee_id: 5, unit_amount: 2, date: '2026-10-01' });
  // Mona manages Youssef (3) but not Karim (5): she cannot validate Karim's hours by swapping the employee.
  const swapped = write(line.db, 'account.analytic.line', line.id, { employee_id: 3, validated: true, validated_by: 'Mona Adel' });
  assert.throws(() => save(line.db, swapped, as('mona', 'Mona Adel')), /manager can approve/);
});

test('approval requests: no self-added lines, no jumping the queue, no owner swap, minimum approvals respected', () => {
  const sequential = create(linked(), 'approval.category', { name: 'Seq', approver_sequence: true, approval_minimum: 2, approver_ids: [{ employee_id: 2, sequence: 10 }, { employee_id: 4, sequence: 20 }] });
  const req = create(sequential.db, 'approval.request', { name: 'Chair', category_id: sequential.id, request_owner_id: 5 });
  const pending = submitRequest(req.db, read(req.db, 'approval.request', req.id));
  const line = (employee_id, status) => ({ employee_id, status, required: false, sequence: 0 });
  const stored = read(pending, 'approval.request', req.id);
  const set = (vals) => write(pending, 'approval.request', req.id, vals);
  // Hana (4) is still 'new': she cannot decide before Mona (2).
  assert.throws(() => save(pending, set({ approver_ids: stored.approver_ids.map((a) => (a.employee_id === 4 ? { ...a, status: 'approved' } : a)) }), as('hana')), /next approver|pending approver/);
  // Karim (owner) adds himself and approves his own line.
  assert.throws(() => save(pending, set({ approver_ids: [...stored.approver_ids, line(5, 'approved')] }), as('karim')), /cannot change/);
  // Mona approves and swaps the owner to herself in the same step.
  assert.throws(() => save(pending, set({ request_owner_id: 2, approver_ids: stored.approver_ids.map((a) => (a.employee_id === 2 ? { ...a, status: 'approved' } : a)) }), as('mona')), /cannot change/);
  // Mona's single approval cannot complete a two-approver request.
  const oneOfTwo = approve(pending, stored, 2);
  assert.throws(() => save(pending, write(oneOfTwo, 'approval.request', req.id, { request_status: 'approved' }), as('mona')), /more approvals/);
  assert.equal(read(save(pending, oneOfTwo, as('mona')), 'approval.request', req.id).request_status ?? 'pending', 'pending');
});

test('expense report completion requires posted expense and reimbursement entries', async () => {
  const { postSheet, registerPayment } = await import('./models/expenseplus.js');
  for (const payment_mode of ['own_account', 'company_account']) {
    const made = create(linked(), 'hr.expense', { name: 'Taxi', employee_id: 3, total_amount: 50, tax: 0, payment_mode });
    const sheet = createSheet(made.db, [made.id]);
    const submitted = submitSheet(sheet.db, sheet.id);
    const approved = approveSheet(submitted, sheet.id, 2);
    assert.throws(() => save(approved, write(approved, 'hr.expense.sheet', sheet.id, { state: 'done', amount_paid: 50 }), as('mona')), /posted.*expense|accounting entry/);
    const posted = postSheet(approved, sheet.id);
    const stored = save(approved, posted, as('mona'));
    if (payment_mode === 'own_account') {
      const forged = write(write(stored, 'hr.expense', made.id, { state: 'paid' }), 'hr.expense.sheet', sheet.id, { state: 'done', amount_paid: 50 });
      assert.throws(() => save(stored, forged, as('mona')), /reimbursement/);
      assert.equal(read(save(stored, registerPayment(stored, sheet.id, 50), as('mona')), 'hr.expense.sheet', sheet.id).state, 'done');
    } else assert.equal(read(stored, 'hr.expense.sheet', sheet.id).state, 'done');
  }
});

test('only administrators change who reports to whom', () => {
  const db = linked();
  assert.throws(() => save(db, write(db, 'hr.employee', 6, { parent_id: 5 }), as('karim')), /Only administrators can change who/);
  assert.equal(read(save(db, write(db, 'hr.employee', 6, { parent_id: 5 }), { isAdmin: true }), 'hr.employee', 6).parent_id, 5);
  assert.equal(read(save(db, write(db, 'hr.employee', 6, { mobile_phone: '1' }), as('karim')), 'hr.employee', 6).mobile_phone, '1');
});
