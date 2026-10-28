import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apps, modelsForApps, redactForApps, writableModelsForApps } from './models/index.js';
import { seed } from './seed.js';
import { applyDiff } from './sync.js';

const PROTECTED = ['account.move', 'account.payment', 'hr.employee', 'hr.contract', 'hr.payslip', 'res.company'];

test('a To-do user can read employee names but not change employees, invoices or companies', () => {
  const write = writableModelsForApps(['todo']);
  for (const m of PROTECTED) assert.equal(write.has(m), false, m);
  assert.ok(modelsForApps(['todo']).has('hr.employee'));
  assert.ok(write.has('project.task') || write.has(apps.find((a) => a.id === 'todo').menus[0].model));
});

test('peripheral apps can no longer write invoices; their own apps still can', () => {
  for (const app of ['appointments', 'rental', 'timesheets', 'events', 'inventory', 'repairs', 'fieldservice', 'expenses']) {
    assert.equal(writableModelsForApps([app]).has('account.move'), false, app);
  }
  assert.ok(writableModelsForApps(['accounting']).has('account.move'));
  assert.ok(writableModelsForApps(['employees']).has('hr.employee'));
  assert.ok(writableModelsForApps(['payroll']).has('hr.payslip'));
});

test('every app writes only models it can read', () => {
  for (const app of apps) {
    const read = modelsForApps([app.id]);
    for (const m of writableModelsForApps([app.id])) assert.ok(read.has(m), `${app.id}: ${m}`);
  }
});

test('private employee fields are hidden outside HR apps', () => {
  const db = seed();
  const emp = (d) => d.records['hr.employee'][0];
  const todo = emp(redactForApps(db, ['todo']));
  for (const f of ['wage', 'bank_account', 'passport_id', 'pin', 'private_address']) assert.equal(f in todo, false, f);
  assert.equal(todo.name, emp(db).name);
  assert.equal(emp(redactForApps(db, ['employees'])).wage, emp(db).wage);
  assert.equal(emp(redactForApps(db, ['payroll'])).wage, emp(db).wage);
  const attendance = emp(redactForApps(db, ['attendances']));
  assert.equal('wage' in attendance, false);
  assert.equal(attendance.pin, emp(db).pin);
});

test('the server refuses a To-do user rewriting an employee bank account or forging an invoice', () => {
  const db = seed();
  const allowed = writableModelsForApps(['todo']);
  const e = db.records['hr.employee'][0];
  assert.throws(() => applyDiff(db, { upserts: { 'hr.employee': [{ ...e, bank_account: 'XX00 ATTACKER 0001' }] } }, { isAdmin: false, allowed }), /No access to hr.employee/);
  assert.throws(() => applyDiff(db, { upserts: { 'account.move': [{ id: 999, move_type: 'out_invoice', state: 'draft' }] } }, { isAdmin: false, allowed }), /No access to account.move/);
});
