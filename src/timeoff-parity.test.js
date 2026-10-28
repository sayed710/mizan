import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { models } from './models/index.js';
import { create, emptyDb, read, write } from './orm.js';
import { setActor } from './models/authority.js';
import { applyDiff, diffDb } from './sync.js';
import { migrate } from './migrations.js';
import { remaining } from './models/timeoff.js';
import { workedDays } from './models/payroll.js';

afterEach(() => setActor(null));
function fixture(options = {}) {
  let db = emptyDb();
  for (const vals of [{ name: 'Manager', user_login: 'manager' }, { name: 'Officer', user_login: 'officer' }, { name: 'Worker', user_login: 'worker', parent_id: 1 }]) db = create(db, 'hr.employee', vals).db;
  db = create(db, 'hr.contract', { name: 'Schedule', employee_id: 3, state: 'running', date_start: '2000-01-01', work_days: '1,2,3,4,5', hours_per_day: 6, hour_from: 9 }).db;
  const type = create(db, 'hr.work.entry.type', { name: 'Holiday', request_unit: 'half_day', validation_type: 'both', time_off_officer_id: 2, requires_allocation: false, ...options });
  return { db: type.db, type: type.id };
}
const ask = (f, vals = {}) => create(f.db, 'hr.leave', { employee_id: 3, name: 'Away', work_entry_type_id: f.type, request_date_from: '2030-01-07', request_date_to: '2030-01-07', ...vals });
const press = (db, id, label, login) => {
  setActor(login ? { login } : null);
  return models['hr.leave'].form.buttons.find((b) => b.label === label).run(db, read(db, 'hr.leave', id)).db;
};
const save = (db, next, login) => applyDiff(db, diffDb(db, next), { isAdmin: false, login });

test('half-day boundaries count scheduled halves and enforce the type request unit', () => {
  const f = fixture();
  const a = ask(f, { request_unit: 'half_day', request_date_from_period: 'am', request_date_to_period: 'am' });
  assert.equal(read(a.db, 'hr.leave', a.id).number_of_days, 0.5);
  assert.equal(read(a.db, 'hr.leave', a.id).number_of_hours, 3);
  const b = ask(f, { request_unit: 'half_day', request_date_from_period: 'pm', request_date_to_period: 'am', request_date_to: '2030-01-08' });
  assert.equal(read(b.db, 'hr.leave', b.id).number_of_days, 1);
  assert.throws(() => ask(fixture({ request_unit: 'day' }), { request_unit: 'half_day' }), /unit|half.day/i);
  assert.throws(() => ask(f, { request_unit: 'half_day', request_date_from_period: 'pm', request_date_to_period: 'am' }), /period|end/i);
});

test('hours are clipped to the work schedule and converted to scheduled days', () => {
  const f = fixture({ request_unit: 'hour' });
  const a = ask(f, { request_unit: 'hour', request_hour_from: 8, request_hour_to: 12 });
  assert.equal(read(a.db, 'hr.leave', a.id).number_of_hours, 3);
  assert.equal(read(a.db, 'hr.leave', a.id).number_of_days, 0.5);
  assert.throws(() => ask(f, { request_unit: 'hour', request_hour_from: 12, request_hour_to: 10 }), /hour/i);
});

test('day requests exclude weekends and respect contract date boundaries', () => {
  const f = fixture();
  const a = ask(f, { request_date_from: '2030-01-04', request_date_to: '2030-01-07' });
  assert.equal(read(a.db, 'hr.leave', a.id).number_of_days, 2);
  assert.equal(read(a.db, 'hr.leave', a.id).number_of_hours, 12);
});

test('two-step approval requires manager then officer and disallows skipped steps and self approval', () => {
  const a = ask(fixture());
  assert.throws(() => press(a.db, a.id, 'Approve', 'worker'), /available|own request/i);
  assert.throws(() => press(a.db, a.id, 'Approve', 'officer'), /available|manager/i);
  assert.throws(() => write(a.db, 'hr.leave', a.id, { state: 'validate' }), /approval|transition/i);
  const first = press(a.db, a.id, 'Approve', 'manager');
  assert.equal(read(first, 'hr.leave', a.id).state, 'validate1');
  assert.throws(() => press(first, a.id, 'Validate', 'manager'), /available|officer/i);
  const done = press(first, a.id, 'Validate', 'officer');
  assert.equal(read(done, 'hr.leave', a.id).state, 'validate');
  setActor(null);
  assert.throws(() => save(a.db, write(a.db, 'hr.leave', a.id, { state: 'validate1' }), 'worker'), /own request/);
  assert.throws(() => save(first, write(first, 'hr.leave', a.id, { state: 'validate' }), 'manager'), /officer/);
});

test('Back to Approval works from validated and refused; cancellation belongs to employee before start', () => {
  const a = ask(fixture({ validation_type: 'manager' }));
  let db = press(a.db, a.id, 'Approve', 'manager');
  db = press(db, a.id, 'Back to Approval', 'manager');
  assert.equal(read(db, 'hr.leave', a.id).state, 'confirm');
  db = press(db, a.id, 'Refuse', 'manager');
  db = press(db, a.id, 'Back to Approval', 'manager');
  assert.equal(read(db, 'hr.leave', a.id).state, 'confirm');
  assert.throws(() => press(db, a.id, 'Cancel', 'manager'), /available|employee/i);
  assert.equal(read(press(db, a.id, 'Cancel', 'worker'), 'hr.leave', a.id).state, 'cancel');
  setActor(null);
  const past = ask(fixture(), { request_date_from: '2020-01-06', request_date_to: '2020-01-06' });
  assert.throws(() => press(past.db, past.id, 'Cancel', 'worker'), /available|start/i);
});

test('officer-only and no-validation policies enforce their respective decisions', () => {
  const a = ask(fixture({ validation_type: 'hr' }));
  assert.throws(() => press(a.db, a.id, 'Approve', 'manager'), /available|officer/i);
  assert.equal(read(press(a.db, a.id, 'Approve', 'officer'), 'hr.leave', a.id).state, 'validate');
  const b = ask(fixture({ validation_type: 'no_validation' }));
  assert.equal(read(b.db, 'hr.leave', b.id).can_approve, false);
  assert.equal(read(press(b.db, b.id, 'Submit Request', 'worker'), 'hr.leave', b.id).state, 'validate');
});

test('validated hours consume hourly allocations; overrun rejected and refusal releases balance', () => {
  let f = fixture({ request_unit: 'hour', validation_type: 'manager', requires_allocation: true });
  f.db = create(f.db, 'hr.leave.allocation', { name: 'Hours', employee_id: 3, work_entry_type_id: f.type, request_unit: 'hour', number_of_hours: 4, state: 'validate' }).db;
  const a = ask(f, { request_unit: 'hour', request_hour_from: 9, request_hour_to: 12 });
  const db = press(a.db, a.id, 'Approve', 'manager');
  assert.equal(remaining(db, 3, f.type), 1);
  setActor(null);
  assert.throws(() => ask({ ...f, db }, { request_unit: 'hour', request_date_from: '2030-01-08', request_date_to: '2030-01-08', request_hour_from: 9, request_hour_to: 11 }), /Not enough/);
  const freed = press(db, a.id, 'Refuse', 'manager');
  assert.equal(remaining(freed, 3, f.type), 4);
});

test('overlap rejects pending requests, allows adjacent hours and opposite half days, releases refused requests', () => {
  const f = fixture({ request_unit: 'hour' });
  const a = ask(f, { request_unit: 'hour', request_hour_from: 9, request_hour_to: 12 });
  assert.throws(() => ask({ ...f, db: a.db }, { request_unit: 'hour', request_hour_from: 11, request_hour_to: 13 }), /overlap/i);
  assert.ok(ask({ ...f, db: a.db }, { request_unit: 'hour', request_hour_from: 12, request_hour_to: 14 }).id);
  const refused = press(a.db, a.id, 'Refuse', 'manager');
  setActor(null);
  assert.ok(ask({ ...f, db: refused }).id);
  const half = fixture();
  const am = ask(half, { request_unit: 'half_day', request_date_from_period: 'am', request_date_to_period: 'am' });
  assert.ok(ask({ ...half, db: am.db }, { request_unit: 'half_day', request_date_from_period: 'pm', request_date_to_period: 'pm' }).id);
});

test('legacy migration adds defaults without mutating old records; smart buttons filter employee', () => {
  const old = { ...emptyDb(), schema_version: 4, records: { 'hr.leave': [{ id: 1, employee_id: 3, leave_type: 'sick', date_from: '2030-01-07', date_to: '2030-01-08', state: 'confirm' }] } };
  const db = migrate(old);
  assert.equal(db.records['hr.leave'][0].request_date_from, '2030-01-07');
  assert.equal(db.records['hr.leave'][0].request_unit, 'day');
  assert.ok(db.records['hr.leave'][0].work_entry_type_id);
  assert.equal(old.records['hr.leave'][0].request_unit, undefined);
  assert.equal(migrate(db), db);
  for (const s of models['hr.leave'].form.smart) {
    assert.equal(s.key, 'employee_id');
    assert.equal(s.field, 'employee_id');
  }
});

test('unpaid partial requests reduce payroll by the scheduled fraction and use request dates', () => {
  const f = fixture({ validation_type: 'manager', legacy_code: 'unpaid' });
  const a = ask(f, { request_unit: 'half_day', request_date_from_period: 'am', request_date_to_period: 'am' });
  const db = press(a.db, a.id, 'Approve', 'manager');
  assert.deepEqual(workedDays(db, { employee_id: 3, date_from: '2030-01-07', date_to: '2030-01-07' }), { working_days: 1, worked_days: 0.5, unpaid_days: 0.5, overtime_hours: 0 });
  const r = read(db, 'hr.leave', a.id);
  assert.equal(r.effective_date_from, '2030-01-07');
  assert.equal(models['hr.leave'].calendar.date, 'effective_date_from');
});

test('request dates, units and attachment survive server synchronization', () => {
  const f = fixture({ validation_type: 'manager' });
  const document = { name: 'note.txt', type: 'text/plain', size: 4, data: 'data:text/plain;base64,bm90ZQ==' };
  const a = ask(f, { supporting_document: document });
  const db = save(f.db, a.db, 'worker');
  const r = read(db, 'hr.leave', a.id);
  assert.equal(r.request_date_from, '2030-01-07');
  assert.equal(r.number_of_hours, 6);
  assert.deepEqual(r.supporting_document, document);
  const prepared = models['hr.leave'].form.prepare({ date_from: '2030-01-07', date_to: '2030-01-08' });
  assert.equal(prepared.request_date_from, '2030-01-07');
});

test('legacy requests share the migrated allocation balance with typed requests', () => {
  let f = fixture({ legacy_code: 'paid', requires_allocation: true, validation_type: 'manager' });
  f.db = create(f.db, 'hr.leave.allocation', { name: 'Half a day', employee_id: 3, work_entry_type_id: f.type, number_of_days: 0.5, state: 'validate' }).db;
  const a = ask(f, { request_unit: 'half_day', request_date_from_period: 'am', request_date_to_period: 'am' });
  const db = press(a.db, a.id, 'Approve', 'manager');
  assert.equal(remaining(db, 3, f.type), 0);
  setActor(null);
  assert.throws(() => create(db, 'hr.leave', { employee_id: 3, leave_type: 'paid', date_from: '2030-01-08', date_to: '2030-01-08' }), /Not enough/);
  f = fixture({ legacy_code: 'paid', requires_allocation: true });
  f.db = create(f.db, 'hr.leave.allocation', { name: 'One day', employee_id: 3, work_entry_type_id: f.type, number_of_days: 1, state: 'validate' }).db;
  f.db = create(f.db, 'hr.leave', { employee_id: 3, leave_type: 'paid', date_from: '2030-01-08', date_to: '2030-01-08' }).db;
  assert.throws(() => ask(f), /Not enough/);
});

test('server rejects simultaneous overlapping requests and unauthorized first approval', () => {
  const f = fixture();
  const a = ask(f);
  const first = write(a.db, 'hr.leave', a.id, { state: 'validate1' });
  assert.throws(() => save(a.db, first, 'officer'), /manager/);
  const r = a.db.records['hr.leave'].at(-1);
  assert.throws(() => applyDiff(f.db, { upserts: { 'hr.leave': [r, { ...r, id: r.id + 1 }] } }, { isAdmin: false, login: 'worker' }), /overlap/);
  assert.deepEqual(f.db.records['hr.leave'], undefined);
});
