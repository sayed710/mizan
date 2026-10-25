import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { maintPlusModels, mtbf, mttr, nextPreventiveDate, schedulePreventive, equipmentStats, calendarLoad } from './models/maintplus.js';

const equipment = (vals = {}) => create(seed(), 'maintenance.equipment', { name: 'Test machine', effective_date: '2026-01-01', ...vals });
const request = (db, id, vals = {}) => create(db, 'maintenance.request', { name: 'Service', equipment_id: id, request_date: '2026-01-01', ...vals });
const run = (db, id, label) => maintPlusModels['maintenance.request'].form.buttons.find((b) => b.label === label).run(db, read(db, 'maintenance.request', id)).db;

test('maintenance seed loads with its original equipment, requests and stage', () => {
  const db = seed();
  assert.equal(search(db, 'maintenance.equipment').length, 2);
  const press = search(db, 'maintenance.equipment').find((r) => r.serial_no === 'CNC-2291');
  assert.equal(press.name, 'CNC Router');
  assert.equal(equipmentStats(db, press.id).requests, 2);
  assert.equal(search(db, 'maintenance.request').find((r) => r.name === 'Spindle vibration').stage_id, 'progress');
  assert.ok(maintPlusModels['maintenance.equipment'].fields.category.options.some(([key]) => key === 'tool'));
});

test('MTBF averages chronological corrective gaps and MTTR averages elapsed repaired hours', () => {
  const { db: base, id } = equipment();
  assert.equal(mtbf(base, id), null);
  assert.equal(mttr(base, id), null);
  const first = request(base, id, { request_date: '2026-01-21', stage: 'repaired', close_date: '2026-01-23' }).db;
  assert.equal(mtbf(first, id), null);
  let db = request(first, id, { request_date: '2026-01-01', stage_id: 'repaired', close_date: '2026-01-02' }).db;
  db = request(db, id, { request_date: '2026-01-07', stage_id: 'progress' }).db;
  db = request(db, id, { maintenance_type: 'preventive', request_date: '2026-01-04', stage_id: 'repaired', close_date: '2026-01-09' }).db;
  assert.equal(mtbf(db, id), 10); // (6 + 14) / 2 days
  assert.equal(mttr(db, id), 36); // (24 + 48) / 2 hours
  assert.equal(mtbf(base, id), null);
});

test('preventive due date uses effective date then last completed service, not open work', () => {
  const { db: base, id } = equipment({ period_days: 10 });
  assert.equal(nextPreventiveDate(base, read(base, 'maintenance.equipment', id)), '2026-01-11');
  let db = request(base, id, { maintenance_type: 'preventive', stage_id: 'repaired', close_date: '2026-01-15' }).db;
  db = request(db, id, { maintenance_type: 'preventive', schedule_date: '2026-02-01' }).db;
  db = request(db, id, { stage_id: 'repaired', close_date: '2026-01-30' }).db;
  assert.equal(nextPreventiveDate(db, read(db, 'maintenance.equipment', id)), '2026-01-25');
  const disabled = write(db, 'maintenance.equipment', id, { period_days: 0 });
  assert.equal(nextPreventiveDate(disabled, read(disabled, 'maintenance.equipment', id)), null);
});

test('preventive scheduling includes day seven, excludes day eight, is immutable and idempotent', () => {
  const { db: base, id } = equipment({ period_days: 10, technician_id: 4, maintenance_duration: 2 });
  const { db, id: later } = create(base, 'maintenance.equipment', { name: 'Later', period_days: 11, effective_date: '2026-01-01' });
  const once = schedulePreventive(db, '2026-01-04');
  const generated = search(once, 'maintenance.request').filter((r) => r.equipment_id === id);
  assert.equal(generated.length, 1);
  assert.equal(generated[0].schedule_date, '2026-01-11');
  assert.equal(generated[0].request_date, '2026-01-04');
  assert.equal(generated[0].technician_id, 4);
  assert.equal(generated[0].duration, 2);
  assert.equal(search(once, 'maintenance.request').filter((r) => r.equipment_id === later).length, 0);
  assert.equal(search(db, 'maintenance.request').filter((r) => r.equipment_id === id).length, 0);
  assert.strictEqual(schedulePreventive(once, '2026-01-04'), once);
  const repaired = write(once, 'maintenance.request', generated[0].id, { stage_id: 'repaired', close_date: '2026-01-11' });
  const rescheduled = schedulePreventive(repaired, '2026-01-14');
  assert.deepEqual(search(rescheduled, 'maintenance.request').filter((r) => r.equipment_id === id).map((r) => r.schedule_date), ['2026-01-11', '2026-01-21']);
});

test('legacy preventive function remains compatible with period, next_maintenance and open stages', async () => {
  const legacy = await import('./models/apps2.js');
  const { db, id } = equipment({ period: 30, next_maintenance: '2026-05-01' });
  assert.equal(nextPreventiveDate(db, read(db, 'maintenance.equipment', id)), '2026-05-01');
  const once = legacy.schedulePreventive(db, '2026-05-03');
  assert.equal(read(once, 'maintenance.equipment', id).next_maintenance, '2026-05-31');
  assert.equal(search(legacy.schedulePreventive(once, '2026-06-05'), 'maintenance.request').filter((r) => r.equipment_id === id).length, 1);
});

test('Start and Repaired synchronize stages, close the request and reject repeated transitions', () => {
  const { db: base, id } = equipment();
  const { db, id: rid } = request(base, id, { request_date: '2020-01-01' });
  const started = run(db, rid, 'Start');
  assert.equal(read(started, 'maintenance.request', rid).stage, 'progress');
  assert.equal(read(started, 'maintenance.request', rid).stage_id, 'progress');
  assert.throws(() => run(started, rid, 'Start'), /Only new/);
  const repaired = run(started, rid, 'Repaired');
  const record = read(repaired, 'maintenance.request', rid);
  assert.equal(record.stage, 'repaired');
  assert.equal(record.kanban_state, 'done');
  assert.match(record.close_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.throws(() => run(repaired, rid, 'Scrap'), /Only open/);
  assert.equal(read(db, 'maintenance.request', rid).stage_id, 'new');
});

test('Scrap archives only its equipment and prevents future preventive scheduling', () => {
  const { db: base, id } = equipment({ period_days: 1 });
  const { db, id: rid } = request(base, id);
  const scrapped = run(db, rid, 'Scrap');
  assert.equal(read(scrapped, 'maintenance.equipment', id).active, false);
  assert.equal(read(scrapped, 'maintenance.request', rid).stage_id, 'scrap');
  assert.equal(read(db, 'maintenance.equipment', id).active, true);
  assert.equal(search(scrapped, 'maintenance.equipment').length, 2);
  assert.strictEqual(schedulePreventive(scrapped, '2026-01-01'), scrapped);
  const orphan = request(base, null);
  assert.throws(() => run(orphan.db, orphan.id, 'Scrap'), /Select equipment/);
});

test('stats provide a function-backed smart count, open count, reliability and acquisition cost', () => {
  const { db: base, id } = equipment({ cost: 1250 });
  let db = request(base, id, { stage_id: 'repaired', close_date: '2026-01-02' }).db;
  db = request(db, id, { request_date: '2026-01-11' }).db;
  db = request(db, id, { maintenance_type: 'preventive', stage_id: 'scrap' }).db;
  assert.deepEqual(equipmentStats(db, id), { requests: 3, open: 1, mtbf: 10, mttr: 24, cost: 1250 });
  assert.equal(maintPlusModels['maintenance.equipment'].form.smart[0].field, 'equipment_id');
  assert.equal(maintPlusModels['maintenance.equipment'].fields.request_count, undefined);
  assert.throws(() => equipmentStats(db, -1), /Equipment not found/);
});

test('calendar load sums scheduled hours by technician and day within inclusive bounds', () => {
  const { db: base, id } = equipment();
  let db = base;
  for (const vals of [
    { schedule_date: '2026-01-10', technician_id: 4, duration: 1.5 },
    { schedule_date: '2026-01-10', technician_id: 4, duration: 2, stage_id: 'repaired' },
    { schedule_date: '2026-01-12', technician_id: 4, duration: 3 },
    { schedule_date: '2026-01-09', technician_id: 4, duration: 8 },
    { schedule_date: '2026-01-10', technician_id: 5, duration: 9 },
    { schedule_date: '2026-01-11', technician_id: 4, duration: 7, stage_id: 'scrap' },
  ]) db = request(db, id, vals).db;
  assert.deepEqual(calendarLoad(db, 4, { from: '2026-01-10', to: '2026-01-12' }), { '2026-01-10': 3.5, '2026-01-12': 3 });
  assert.deepEqual(calendarLoad(db, -1, { from: '2026-01-10', to: '2026-01-12' }), {});
  assert.throws(() => calendarLoad(db, 4, { from: '2026-01-12', to: '2026-01-10' }), /valid calendar/);
});

test('elapsed repair hours preserve fractions and duplicate failure dates have zero-day gaps', () => {
  const { db: base, id } = equipment();
  let db = request(base, id, { request_date: '2026-01-01T10:00:00Z', close_date: '2026-01-01T11:30:00Z', stage_id: 'repaired' }).db;
  db = request(db, id, { request_date: '2026-01-01T10:00:00Z' }).db;
  assert.equal(mtbf(db, id), 0);
  assert.equal(mttr(db, id), 1.5);
});

test('overdue preventive work is scheduled and a blocked open request still prevents duplicates', () => {
  const { db: base, id } = equipment({ period_days: 1 });
  const once = schedulePreventive(base, '2026-02-01');
  const generated = search(once, 'maintenance.request').find((r) => r.equipment_id === id);
  assert.equal(generated.schedule_date, '2026-01-02');
  const blocked = write(once, 'maintenance.request', generated.id, { kanban_state: 'blocked' });
  assert.strictEqual(schedulePreventive(blocked, '2026-03-01'), blocked);
});

test('invalid durations, intervals and close dates fail with readable errors', () => {
  assert.throws(() => equipment({ period_days: -1 }), /cannot be negative/);
  const { db, id } = equipment();
  assert.throws(() => request(db, id, { duration: -1 }), /cannot be negative/);
  assert.throws(() => request(db, id, { close_date: '2025-12-31' }), /cannot precede/);
  assert.throws(() => schedulePreventive(db, 'invalid'), /valid scheduling date/);
});
