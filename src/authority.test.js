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
  assert.throws(() => save(db, planted, as('karim')), /your own request/);
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
  assert.throws(() => save(pending, approved, as('karim')), /pending approver/);
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
