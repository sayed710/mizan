import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditEntries } from './audit.js';
import { authorityRules, authorityDeleteRules } from './models/authority.js';

const db = { records: { 'hr.employee': [{ id: 1, user_login: 'owner', parent_id: 2 }, { id: 2, user_login: 'manager' }, { id: 3, user_login: 'peer', parent_id: 2 }], 'approval.category': [{ id: 1, approval_minimum: 1 }] } };
const ctx = (login) => ({ isAdmin: false, login, name: login });
const request = { id: 1, name: 'Laptop', amount: 100, category_id: 1, request_owner_id: 1, request_status: 'pending', approver_ids: [{ employee_id: 2, required: true, sequence: 1, status: 'pending' }, { employee_id: 3, required: true, sequence: 2, status: 'new' }] };

test('audit redacts employee PINs and loyalty credentials on every operation, including nested values', () => {
  for (const [model, key] of [['hr.employee', 'pin'], ['loyalty.card', 'code']]) {
    const before = { records: { [model]: [{ id: 1, [key]: 'credential-old', nested: { [key]: 'credential-nested' } }] } };
    const after = { records: { [model]: [{ id: 1, [key]: 'credential-new' }] } };
    for (const [a, b] of [[{ records: {} }, before], [before, after], [before, { records: {} }]]) {
      assert.ok(!JSON.stringify(auditEntries(a, b)).includes('credential-'));
    }
  }
});

test('only the stored request owner may withdraw a pending request', () => {
  const withdrawn = { ...request, request_status: 'new', approver_ids: [] };
  assert.match(authorityRules['approval.request'](db, request, withdrawn, ctx('peer')) ?? '', /owner/);
  assert.equal(authorityRules['approval.request'](db, request, withdrawn, ctx('owner')), null);
});

test('pending request business fields cannot be rewritten before or during approval', () => {
  for (const field of ['name', 'amount']) {
    assert.match(authorityRules['approval.request'](db, request, { ...request, [field]: field === 'name' ? 'Changed' : 10000 }, ctx('owner')) ?? '', /submitted request cannot change/);
  }
});

test('an approval decision cannot remove another approver requirement', () => {
  const forged = { ...request, request_status: 'approved', approver_ids: request.approver_ids.map((a) => a.employee_id === 2 ? { ...a, status: 'approved' } : { ...a, required: false }) };
  assert.match(authorityRules['approval.request'](db, request, forged, ctx('manager')) ?? '', /approvers.*cannot change/);
});

test('submitted and decided approval requests cannot be deleted by non-admins', () => {
  for (const request_status of ['pending', 'approved', 'refused', 'cancel']) {
    assert.match(authorityDeleteRules['approval.request']?.(db, { ...request, request_status }, ctx('owner')) ?? '', /cannot be deleted/);
  }
});

test('timesheet validation cannot swap between two employees managed by the actor', () => {
  assert.match(authorityRules['account.analytic.line'](db, { employee_id: 1, validated: false }, { employee_id: 3, validated: true, validated_by: 'manager' }, ctx('manager')) ?? '', /cannot.*employee/);
});

test('posting an approved expense report still requires its manager', () => {
  const before = { employee_id: 1, manager_id: 2, state: 'approve' };
  for (const state of ['post', 'done']) {
    assert.match(authorityRules['hr.expense.sheet'](db, before, { ...before, state }, ctx('owner')) ?? '', /own request/);
  }
});
