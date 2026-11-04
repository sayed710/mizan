import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appOpen, myEmployeeId } from './access.js';
import { seed } from './seed.js';

test('an app opens only when installed and, for restricted users, on their allow-list', () => {
  const db = { ...seed(), settings: { ...seed().settings, uninstalled: ['fleet'] } };
  assert.equal(appOpen(db, null, 'crm'), true);
  assert.equal(appOpen(db, null, 'fleet'), false);
  assert.equal(appOpen(db, { apps: ['crm'] }, 'crm'), true);
  assert.equal(appOpen(db, { apps: ['crm'] }, 'sales'), false);
  assert.equal(appOpen(db, { apps: ['crm'] }, 'settings'), true);
});

test('administrators may open installed apps omitted from their app list', () => {
  const db = seed();
  assert.equal(appOpen(db, { isAdmin: true, apps: ['crm'] }, 'sales'), true);
  assert.equal(appOpen({ ...db, settings: { ...db.settings, uninstalled: ['sales'] } }, { isAdmin: true, apps: ['crm'] }, 'sales'), false);
});

test('the signed-in user maps to the employee linked to their login, or to nobody', () => {
  const base = seed();
  const employee = base.records['hr.employee'][1];
  const db = { ...base, records: { ...base.records, 'hr.employee': base.records['hr.employee'].map((e) => (e.id === employee.id ? { ...e, user_login: 'mona' } : e)) } };
  assert.equal(myEmployeeId(db, { login: 'mona' }), employee.id);
  assert.equal(myEmployeeId(db, { login: 'someone-else' }), null);
  assert.equal(myEmployeeId(db, null), null);
});
