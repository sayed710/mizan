import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { applyDiff, diffDb } from './sync.js';
import { cleanValue } from './validate.js';
import { dayOf, shiftDay, pickedInstant } from './models/common.js';
import { moreModels } from './models/more.js';
import { accountId, isBalanced, journalId } from './models/ledger.js';
import { generateWorkorders, startWorkorder, pauseWorkorder, finishWorkorder, blockWorkcenter, unblockWorkcenter, workorderCost, productionCost, postOperationCost, workcenterLoad, oee, workorderModels, migrateWorkorderTimes } from './models/workorder.js';

const at = (time) => `2026-10-19T${time}:00.000Z`;
const range = { from: '2026-10-19', to: '2026-10-25' };
const linked = (db, id) => search(db, 'mrp.workorder').filter((w) => w.production_id === id);
const fixture = () => {
  let db = seed();
  const bom = search(db, 'mrp.bom')[0];
  const wc = search(db, 'mrp.workcenter')[0].id;
  db = write(db, 'mrp.workcenter', wc, { capacity: 2, time_efficiency: 80, working_hours_per_day: 8, costs_hour: 30 });
  db = write(db, 'mrp.bom', bom.id, { product_qty: 2, operations: [{ name: 'Assembly', workcenter_id: wc, duration: 30 }, { name: 'Check', workcenter_id: wc, duration: 10 }] });
  const mo = create(db, 'mrp.production', { product_id: bom.product_id, bom_id: bom.id, product_qty: 4, state: 'confirmed', date_start: '2026-10-19' });
  return { db: mo.db, id: mo.id, wc, bom };
};
const completed = () => {
  const f = fixture();
  let db = generateWorkorders(f.db, f.id);
  const [a, b] = linked(db, f.id);
  db = startWorkorder(db, a.id, { employeeId: 1, at: at('08:00') });
  db = pauseWorkorder(db, a.id, { at: at('08:15'), loss: 'unplanned' });
  db = startWorkorder(db, a.id, { employeeId: 1, at: at('08:15') });
  db = finishWorkorder(db, a.id, { at: at('09:15'), qty: 4 });
  db = startWorkorder(db, b.id, { employeeId: 1, at: at('09:15') });
  db = finishWorkorder(db, b.id, { at: at('09:35'), qty: 4 });
  return { ...f, db, a: a.id, b: b.id };
};

test('work orders scale BOM durations, preserve sequence and generate idempotently without mutation', () => {
  const { db, id } = fixture();
  const before = structuredClone(db);
  const next = generateWorkorders(db, id);
  assert.deepEqual(db, before);
  assert.deepEqual(linked(next, id).map((w) => [w.name, w.sequence, w.duration_expected, w.state]), [['Assembly', 1, 60, 'ready'], ['Check', 2, 20, 'pending']]);
  assert.strictEqual(generateWorkorders(next, id), next);
  assert.throws(() => generateWorkorders(write(db, 'mrp.production', id, { state: 'done' }), id), /closed/);
  assert.throws(() => generateWorkorders(write(db, 'mrp.production', id, { bom_id: null }), id), /bill of materials/);
});

test('start, pause, resume and finish record exact minutes and release only the next operation', () => {
  const f = fixture();
  const planned = generateWorkorders(f.db, f.id);
  const [a, b] = linked(planned, f.id);
  assert.throws(() => startWorkorder(planned, b.id, { employeeId: 1, at: at('08:00') }), /ready/);
  const running = startWorkorder(planned, a.id, { employeeId: 1, at: at('08:00') });
  assert.equal(read(planned, 'mrp.workorder', a.id).state, 'ready');
  assert.equal(read(running, 'mrp.workorder', a.id).duration, 0);
  assert.throws(() => pauseWorkorder(running, a.id, { at: at('07:59') }), /End time/);
  assert.throws(() => pauseWorkorder(running, a.id, { at: at('08:30'), loss: 'wrong' }), /valid time loss/);
  const paused = pauseWorkorder(running, a.id, { at: at('08:30'), loss: 'reduced' });
  assert.equal(read(paused, 'mrp.workorder', a.id).duration, 30);
  assert.equal(read(paused, 'mrp.workorder', a.id).state, 'progress');
  assert.throws(() => pauseWorkorder(paused, a.id, { at: at('08:40') }), /No running/);
  const resumed = startWorkorder(paused, a.id, { employeeId: 1, at: at('08:45') });
  assert.throws(() => finishWorkorder(resumed, a.id, { at: at('09:00'), qty: -1 }), /nonnegative/);
  const done = finishWorkorder(resumed, a.id, { at: at('09:15'), qty: 4 });
  const wo = read(done, 'mrp.workorder', a.id);
  assert.deepEqual(wo.time_ids.map((l) => [l.minutes, l.loss]), [[30, 'reduced'], [30, 'productive']]);
  assert.equal(wo.duration, 60);
  assert.equal(wo.date_start, at('08:00'));
  assert.equal(wo.date_finished, at('09:15'));
  assert.equal(wo.qty_produced, 4);
  assert.equal(wo.state, 'done');
  assert.equal(read(done, 'mrp.workorder', b.id).state, 'ready');
  assert.throws(() => finishWorkorder(done, a.id, { at: at('10:00') }), /Start/);
});

test('blocked centers refuse starts; an employee cannot open another log until paused', () => {
  const f = fixture();
  const db = generateWorkorders(f.db, f.id);
  const [a] = linked(db, f.id);
  assert.throws(() => blockWorkcenter(db, f.wc, ''), /reason/);
  const blocked = blockWorkcenter(db, f.wc, 'Maintenance');
  assert.equal(read(db, 'mrp.workcenter', f.wc).blocked, false);
  assert.equal(read(blocked, 'mrp.workorder', a.id).blocked_reason, 'Maintenance');
  assert.throws(() => startWorkorder(blocked, a.id, { employeeId: 1 }), /blocked/);
  const free = unblockWorkcenter(blocked, f.wc);
  assert.equal(read(free, 'mrp.workorder', a.id).blocked_reason, '');
  const other = create(free, 'mrp.production', { product_id: f.bom.product_id, bom_id: f.bom.id, product_qty: 1 });
  const planned = generateWorkorders(other.db, other.id);
  const second = linked(planned, other.id)[0];
  const running = startWorkorder(planned, a.id, { employeeId: 1, at: at('08:00') });
  assert.throws(() => startWorkorder(running, second.id, { employeeId: 1, at: at('08:00') }), /already has an open/);
  assert.throws(() => startWorkorder(running, a.id, { employeeId: 1, at: at('08:00') }), /already has an open/);
  const paused = pauseWorkorder(running, a.id, { at: at('08:10') });
  assert.equal(read(startWorkorder(paused, second.id, { employeeId: 1, at: at('08:10') }), 'mrp.workorder', second.id).state, 'progress');
});

test('actual component and operation costs produce one balanced posted MISC entry', () => {
  const f = completed();
  assert.equal(workorderCost(f.db, f.a), 37.5);
  assert.equal(workorderCost(f.db, f.b), 10);
  const components = f.bom.components.reduce((s, c) => s + c.qty * 2 * read(f.db, 'product', c.product_id).cost, 0);
  assert.deepEqual(productionCost(f.db, f.id), { components, operations: 47.5, total: components + 47.5 });
  const consumed = write(f.db, 'mrp.production', f.id, { move_raw: [{ product_id: 7, to_consume: 10, consumed: 0 }, { product_id: 8, to_consume: 10, consumed: 2 }] });
  assert.equal(productionCost(consumed, f.id).components, read(consumed, 'product', 8).cost * 2);
  const unrecorded = write(f.db, 'mrp.production', f.id, { move_raw: [{ product_id: 7, to_consume: 2, consumed: '' }] });
  assert.equal(productionCost(unrecorded, f.id).components, read(unrecorded, 'product', 7).cost * 2);
  const fractional = write(f.db, 'mrp.workorder', f.b, { time_ids: [{ employee_id: 1, date_start: at('09:15'), date_end: '2026-10-19T09:16:01Z', minutes: 61 / 60, loss: 'productive' }] });
  assert.equal(workorderCost(fractional, f.b), 0.51);
  // The seeded product is standard-cost: its operation costs stay in expenses as variance, nothing is capitalized.
  assert.strictEqual(postOperationCost(f.db, f.id), f.db);
  const fifo = write(f.db, 'product', f.bom.product_id, { cost_method: 'fifo' });
  const booked = postOperationCost(fifo, f.id);
  assert.equal(search(booked, 'account.move').length, search(fifo, 'account.move').length + 1);
  const entry = read(booked, 'account.move', read(booked, 'mrp.production', f.id).operation_cost_move_id);
  assert.equal(entry.state, 'posted');
  assert.equal(entry.journal_id, journalId(booked, 'MISC'));
  assert.ok(isBalanced(entry.line_ids));
  assert.deepEqual(entry.line_ids.map((l) => [l.account_id, l.debit, l.credit]), [[accountId(booked, '110100'), 47.5, 0], [accountId(booked, '600000'), 0, 47.5]]);
  assert.strictEqual(postOperationCost(booked, f.id), booked);
  const fresh = fixture();
  assert.throws(() => postOperationCost(generateWorkorders(fresh.db, fresh.id), fresh.id), /Finish work orders/);
});

test('load uses scheduled operations and weekday capacity, efficiency and parallel units', () => {
  const f = fixture();
  const db = generateWorkorders(f.db, f.id);
  assert.deepEqual(workcenterLoad(db, f.wc, range), { plannedMinutes: 80, capacityMinutes: 3840, load: 2.08 });
  assert.deepEqual(workcenterLoad(db, f.wc, { from: '2026-10-24', to: '2026-10-25' }), { plannedMinutes: 0, capacityMinutes: 0, load: 0 });
  assert.throws(() => workcenterLoad(db, f.wc, { from: '2026-10-25', to: '2026-10-19' }), /valid date range/);
  assert.equal(workcenterLoad(write(db, 'mrp.workorder', linked(db, f.id)[0].id, { state: 'cancel' }), f.wc, range).plannedMinutes, 20);
});

test('OEE uses productive and loss minutes, expected time, scrap and clipped date ranges', () => {
  const f = completed();
  assert.deepEqual(oee(f.db, f.wc, range), { availability: 84.21, performance: 100, quality: 100, oee: 84.21 });
  const scrap = create(f.db, 'stock.scrap', { product_id: f.bom.product_id, production_id: f.id, scrap_qty: 1, state: 'done', date_done: '2026-10-19' }).db;
  assert.equal(oee(scrap, f.wc, range).quality, 80);
  assert.equal(oee(write(scrap, 'mrp.workorder', f.b, { qty_produced: 3 }), f.wc, range).quality, 75);
  assert.deepEqual(oee(f.db, f.wc, { from: '2026-10-20', to: '2026-10-20' }), { availability: 0, performance: 0, quality: 100, oee: 0 });
  const slower = write(f.db, 'mrp.workorder', f.a, { duration_expected: 30 });
  assert.equal(oee(slower, f.wc, range).performance, 62.5);
  const crossing = write(f.db, 'mrp.workorder', f.a, { time_ids: [{ employee_id: 1, date_start: '2026-10-18T23:30:00Z', date_end: '2026-10-19T00:30:00Z', minutes: 60, loss: 'productive' }] });
  assert.equal(oee(crossing, f.wc, range).availability, 100);
  assert.equal(oee(write(crossing, 'mrp.workorder', f.b, { state: 'cancel' }), f.wc, range).performance, 100);
});

test('seed and inherited manufacturing controls survive; forms expose tracking, grouping and gantt', () => {
  const db = seed();
  assert.ok(search(db, 'mrp.production').length >= 2);
  assert.ok(search(db, 'mrp.bom')[0].operations.length);
  assert.equal(search(db, 'mrp.workcenter')[0].working_hours_per_day, 8);
  assert.equal(workorderModels['mrp.workcenter'].defaults().time_efficiency, 100);
  assert.equal(workorderModels['mrp.workcenter'].defaults().capacity, 1);
  const model = workorderModels['mrp.production'];
  assert.deepEqual(model.fields, moreModels['mrp.production'].fields);
  for (const button of moreModels['mrp.production'].form.buttons) assert.ok(model.form.buttons.some((b) => b.label === button.label));
  assert.equal(model.form.smart[0].field, 'production_id');
  const f = fixture();
  const planned = model.form.buttons.find((b) => b.label === 'Plan Work Orders').run(f.db, read(f.db, 'mrp.production', f.id)).db;
  assert.equal(linked(planned, f.id).length, 2);
  const wo = workorderModels['mrp.workorder'];
  assert.equal(wo.gantt.row, 'workcenter_id');
  assert.equal(wo.groupBys[0], 'workcenter_id');
  assert.deepEqual(wo.form.buttons.map((b) => b.label), ['Start', 'Pause', 'Done', 'Block']);
  assert.deepEqual(wo.form.tabs[0].fields, ['time_ids']);
});

test('Produce waits for open work orders', () => {
  const produceButton = workorderModels['mrp.production'].form.buttons.find((b) => b.label === 'Produce');
  const f = fixture();
  const db = generateWorkorders(f.db, f.id);
  const mo = read(db, 'mrp.production', f.id);
  assert.throws(() => produceButton.run(db, mo), /Finish the work orders first/);
});

test('work order start, pause and finish times survive the server, so MOs with operations can be produced (FLOW-005)', () => {
  const f = fixture();
  let db = generateWorkorders(f.db, f.id);
  const [a] = linked(db, f.id);
  const steps = [
    (x) => startWorkorder(x, a.id, { employeeId: 1, at: at('08:00') }),
    (x) => pauseWorkorder(x, a.id, { at: at('08:15') }),
    (x) => startWorkorder(x, a.id, { employeeId: 1, at: at('08:20') }),
    (x) => finishWorkorder(x, a.id, { at: at('09:00'), qty: 4 }),
  ];
  for (const step of steps) db = applyDiff(db, diffDb(db, step(db)), { isAdmin: false, author: 'Operator' });
  const wo = read(db, 'mrp.workorder', a.id);
  assert.equal(wo.state, 'done');
  assert.equal(wo.date_start, at('08:00'));
  assert.equal(wo.date_finished, at('09:00'));
  assert.deepEqual(wo.time_ids.map((l) => l.minutes), [15, 40]);
  assert.throws(() => cleanValue({ type: 'datetime' }, '2026-10-19', 'x'), /Invalid value/);
  assert.throws(() => cleanValue({ type: 'datetime' }, '2026-13-45T99:00', 'x'), /Invalid value/);
});

test('a calendar day that does not exist is refused, not rolled into the next month', () => {
  assert.throws(() => cleanValue({ type: 'datetime' }, '2026-02-29T08:00Z', 'x'), /Invalid value/);
  assert.throws(() => cleanValue({ type: 'datetime' }, '2026-04-31T08:00:00.000Z', 'x'), /Invalid value/);
  assert.equal(cleanValue({ type: 'datetime' }, '2028-02-29T08:00Z', 'x'), '2028-02-29T08:00Z');
});

test('date-only work order times from older data become datetimes and the order can be edited again', () => {
  const f = fixture();
  let db = generateWorkorders(f.db, f.id);
  const [a] = linked(db, f.id);
  const legacy = { ...db, records: { ...db.records, 'mrp.workorder': db.records['mrp.workorder'].map((w) => (w.id === a.id
    ? { ...w, date_start: '2026-10-19', date_finished: '2026-10-20', time_ids: [{ employee_id: 1, date_start: '2026-10-19', date_end: '2026-10-20', minutes: 60, loss: 'productive' }] } : w)) } };
  assert.throws(() => applyDiff(legacy, diffDb(legacy, write(legacy, 'mrp.workorder', a.id, { blocked_reason: 'x' })), { isAdmin: false, author: 'Op' }), /Invalid value/);
  const migrated = migrateWorkorderTimes(legacy);
  const wo = read(migrated, 'mrp.workorder', a.id);
  assert.deepEqual([wo.date_start, wo.date_finished, wo.time_ids[0].date_start, wo.time_ids[0].date_end], ['2026-10-19T00:00:00.000Z', '2026-10-20T00:00:00.000Z', '2026-10-19T00:00:00.000Z', '2026-10-20T00:00:00.000Z']);
  assert.doesNotThrow(() => applyDiff(migrated, diffDb(migrated, write(migrated, 'mrp.workorder', a.id, { blocked_reason: 'x' })), { isAdmin: false, author: 'Op' }));
  assert.equal(migrateWorkorderTimes(migrated), migrated);
});

test('gantt helpers keep datetimes valid when a bar moves and place them on the viewer calendar day', () => {
  const local = new Date(2026, 0, 5, 23, 30).toISOString(); // 23:30 local, whatever the timezone
  assert.equal(dayOf(local), '2026-01-05');
  assert.equal(dayOf('2026-01-05'), '2026-01-05');
  const moved = shiftDay(local, 2);
  assert.equal(dayOf(moved), '2026-01-07');
  assert.equal(new Date(moved).getHours(), 23);
  assert.doesNotThrow(() => cleanValue({ type: 'datetime' }, moved, 'x'));
  assert.equal(shiftDay('2026-01-31', 1), '2026-02-01');
});

test('editing a datetime keeps its recorded seconds', () => {
  const old = new Date(2026, 5, 1, 8, 30, 45, 123).toISOString();
  const input = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  assert.equal(pickedInstant(input(new Date(old)), old), old);
  const later = pickedInstant(input(new Date(2026, 5, 1, 9, 0)), old);
  assert.equal(new Date(later).getSeconds(), 45);
  assert.equal(new Date(later).getMilliseconds(), 123);
  assert.equal(pickedInstant('', old), null);
});
