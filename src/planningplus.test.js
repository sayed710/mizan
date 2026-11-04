import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { planningPlusModels, generateRecurringSlots, availableEmployees, autoPlan, publishPeriod, requestSwap, acceptSwap, planningAnalysis } from './models/planningplus.js';

const from = '2032-01-05';
const to = '2032-01-09';
const shift = (db, vals = {}) => create(db, 'planning.slot', { start: from, end: from, role: 'support', allocated_hours: 8, ...vals });
const employees = (db) => {
  const a = create(db, 'hr.employee', { name: 'Planner A', job_title: 'Support', working_hours: '40' });
  const b = create(a.db, 'hr.employee', { name: 'Planner B', job_title: 'Support', working_hours: '20' });
  return { db: b.db, a: a.id, b: b.id };
};
const leave = (db, employee_id, date_from, date_to = date_from, state = 'validate') => create(db, 'hr.leave', { employee_id, date_from, date_to, state, leave_type: 'sick' }).db;

test('recurring shifts preserve duration, stop at the earlier bound and are idempotent', () => {
  const { db, id } = shift(seed(), { end: '2032-01-06', employee_id: 1, repeat: true, repeat_interval: 2, repeat_unit: 'week', repeat_until: '2032-02-20' });
  const snapshot = structuredClone(db);
  const next = generateRecurringSlots(db, read(db, 'planning.slot', id), '2032-02-02');
  const copies = search(next, 'planning.slot').filter((s) => s.recurring_source_id === id);
  assert.deepEqual(copies.map((s) => [s.start, s.end]), [['2032-01-19', '2032-01-20'], ['2032-02-02', '2032-02-03']]);
  assert.ok(copies.every((s) => s.was_copied && !s.repeat && s.state === 'draft' && s.employee_id === 1));
  assert.deepEqual(db, snapshot);
  assert.equal(generateRecurringSlots(next, read(next, 'planning.slot', id), '2032-02-02'), next);
  const extended = generateRecurringSlots(next, read(next, 'planning.slot', id), '2032-03-01');
  assert.equal(search(extended, 'planning.slot').filter((s) => s.recurring_source_id === id).length, 3);
});

test('monthly recurrence clamps month ends without drifting and rejects an invalid interval', () => {
  const { db, id } = shift(seed(), { start: '2032-01-31', end: '2032-01-31', repeat: true, repeat_interval: 1, repeat_unit: 'month', repeat_until: '2032-03-31' });
  const next = generateRecurringSlots(db, read(db, 'planning.slot', id));
  assert.deepEqual(search(next, 'planning.slot').filter((s) => s.recurring_source_id === id).map((s) => s.start), ['2032-02-29', '2032-03-31']);
  const invalid = write(db, 'planning.slot', id, { repeat_interval: 0 });
  assert.throws(() => generateRecurringSlots(invalid, read(invalid, 'planning.slot', id)), /positive repeat interval/);
});

test('availability excludes approved leave and overlapping times but permits adjoining shifts and pending leave', () => {
  const { db: base, a, b } = employees(seed());
  const { db } = shift(base, { employee_id: a, start_time: '09:00', end_time: '12:00' });
  const approved = leave(db, b, from);
  const available = (source, start, end) => availableEmployees(source, { start, end, role: 'support' }).map((e) => e.id);
  assert.ok(!available(approved, from, from).includes(a));
  assert.ok(!available(approved, from, from).includes(b));
  assert.ok(available(approved, `${from}T12:00`, `${from}T14:00`).includes(a));
  assert.ok(!available(approved, `${from}T11:59`, `${from}T14:00`).includes(a));
  assert.ok(available(leave(db, b, from, from, 'confirm'), from, from).includes(b));
  assert.equal(availableEmployees(approved, { start: from, role: 'unmatched' }).length, 0);
});

test('auto-plan balances existing period hours, updates availability between shifts and leaves impossible shifts open', () => {
  const { db: base, a, b } = employees(seed());
  const { db: existing } = shift(base, { employee_id: a, allocated_hours: 12 });
  const one = shift(existing, { start: '2032-01-06', end: '2032-01-06', department_id: null });
  const two = shift(one.db, { start: '2032-01-07', end: '2032-01-07', allocated_hours: 16 });
  const three = shift(two.db, { start: '2032-01-08', end: '2032-01-08' });
  const impossible = shift(three.db, { role: 'unmatched' });
  const baseOnly = search(impossible.db, 'hr.employee').filter((e) => e.id !== a && e.id !== b).reduce((db, e) => write(db, 'hr.employee', e.id, { active: false }), impossible.db);
  const snapshot = structuredClone(baseOnly);
  const next = autoPlan(baseOnly, { from, to });
  assert.equal(read(next, 'planning.slot', one.id).employee_id, b);
  assert.equal(read(next, 'planning.slot', two.id).employee_id, b);
  assert.equal(read(next, 'planning.slot', three.id).employee_id, a);
  assert.ok(!read(next, 'planning.slot', impossible.id).employee_id);
  assert.equal(read(next, 'planning.slot', one.id).allocated_percentage, 200);
  assert.deepEqual(baseOnly, snapshot);
  assert.deepEqual(autoPlan(next, { from, to }), next);
});

test('auto-plan leaves overlapping excess shifts open when every matching resource is occupied', () => {
  const { db: base, a, b } = employees(seed());
  const restricted = search(base, 'hr.employee').filter((e) => e.id !== a && e.id !== b).reduce((db, e) => write(db, 'hr.employee', e.id, { active: false }), base);
  const one = shift(restricted);
  const two = shift(one.db);
  const three = shift(two.db);
  const next = autoPlan(three.db, { from, to });
  assert.equal(read(next, 'planning.slot', one.id).employee_id, a);
  assert.equal(read(next, 'planning.slot', two.id).employee_id, b);
  assert.ok(!read(next, 'planning.slot', three.id).employee_id);
});

test('publishing only changes drafts in the period and posts one employee note, without repeat notifications', () => {
  const first = shift(seed(), { employee_id: 1 });
  const second = shift(first.db, { employee_id: 1 });
  const outside = shift(second.db, { start: '2032-02-01', end: '2032-02-01' });
  const next = publishPeriod(outside.db, from, to);
  assert.equal(read(next, 'planning.slot', first.id).state, 'published');
  assert.equal(read(next, 'planning.slot', second.id).state, 'published');
  assert.equal(read(next, 'planning.slot', outside.id).state, 'draft');
  assert.equal(next.messages.filter((m) => m.model === 'hr.employee' && m.res_id === 1 && m.kind === 'note' && m.body.includes(from)).length, 1);
  assert.equal(read(outside.db, 'planning.slot', first.id).state, 'draft');
  assert.deepEqual(publishPeriod(next, from, to), next);
});

test('switch requests require the owner and published state; acceptance refuses busy resources and clears the request', () => {
  const { db: base, a, b } = employees(seed());
  const original = shift(base, { employee_id: a, state: 'published' });
  assert.throws(() => requestSwap(original.db, original.id, b), /assigned employee/);
  assert.throws(() => acceptSwap(original.db, original.id, b), /not awaiting/);
  const requested = requestSwap(original.db, original.id, a);
  assert.equal(read(requested, 'planning.slot', original.id).swap_requested, true);
  const busy = shift(requested, { employee_id: b });
  assert.throws(() => acceptSwap(busy.db, original.id, b), /not available/);
  assert.throws(() => acceptSwap(leave(requested, b, from), original.id, b), /not available/);
  assert.throws(() => acceptSwap(requested, original.id, a), /different employee/);
  const accepted = acceptSwap(requested, original.id, b);
  assert.equal(read(accepted, 'planning.slot', original.id).employee_id, b);
  assert.equal(read(accepted, 'planning.slot', original.id).swap_requested, false);
  assert.equal(read(requested, 'planning.slot', original.id).employee_id, a);
  assert.ok(accepted.messages.some((m) => m.model === 'planning.slot' && m.res_id === original.id && m.body.includes('accepted')));
});

test('analysis uses weekdays and employee working hours, counts leave once and prorates boundary shifts', () => {
  const { db: base, a, b } = employees(seed());
  const historical = leave(base, a, '2032-01-06', '2032-01-07');
  // Historical imports can contain overlaps; new requests now reject them. Keep testing deduplication of old data.
  const original = historical.records['hr.leave'].at(-1);
  const withLeave = { ...historical, records: { ...historical.records, 'hr.leave': [...historical.records['hr.leave'], { ...original, id: original.id + 1, date_from: '2032-01-07' }] }, seq: { ...historical.seq, 'hr.leave': original.id + 1 } };
  const first = shift(withLeave, { employee_id: a, allocated_hours: 12 });
  const second = shift(first.db, { employee_id: b, start: '2032-01-04', end: '2032-01-05', allocated_hours: 8 });
  const report = planningAnalysis(second.db, from, to);
  assert.deepEqual(report[a], { planned: 12, capacity: 24, ratio: 0.5 });
  assert.deepEqual(report[b], { planned: 4, capacity: 20, ratio: 0.2 });
  const noCapacity = planningAnalysis(leave(second.db, b, from, to), from, to);
  assert.deepEqual(noCapacity[b], { planned: 4, capacity: 0, ratio: 0 });
});

test('seed and original planning fields, templates, filters and views remain usable', () => {
  const db = seed();
  const model = planningPlusModels['planning.slot'];
  assert.ok(search(db, 'planning.slot').length > 0);
  assert.ok(search(db, 'planning.slot').every((s) => Number.isFinite(s.allocated_percentage)));
  assert.deepEqual(model.views, ['gantt', 'calendar', 'kanban', 'list', 'pivot']);
  assert.ok(model.filters[0].some((f) => f.id === 'open'));
  assert.ok(planningPlusModels['planning.template'].fields.duration);
  for (const label of ['Publish', 'Ask to Switch', 'Accept Switch', 'Repeat', 'Copy to Next Week', 'Take Shift']) assert.ok(model.form.buttons.some((b) => b.label === label));
  const created = shift(db);
  assert.throws(() => write(created.db, 'planning.slot', created.id, { start_time: '25:00' }), /HH:MM/);
  assert.throws(() => publishPeriod(db, to, from), /end date/);
  const copied = model.form.buttons.find((b) => b.label === 'Copy to Next Week').run(created.db, read(created.db, 'planning.slot', created.id));
  assert.equal(read(copied.db, 'planning.slot', copied.db.seq['planning.slot']).was_copied, true);
  const changed = write(created.db, 'planning.slot', created.id, { employee_id: 1, allocated_hours: 4 });
  assert.equal(read(changed, 'planning.slot', created.id).allocated_percentage, 50);
  const published = model.form.buttons.find((b) => b.label === 'Publish').run(changed, read(changed, 'planning.slot', created.id)).db;
  assert.ok(published.messages.some((m) => m.model === 'hr.employee' && m.res_id === 1 && m.kind === 'note' && m.body.includes(from)));
});
