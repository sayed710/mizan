import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { analyticPlusModels } from './models/analyticplus.js';
import { startTimer, stopTimer, validateTimesheets, timesheetGuard, weeklyGrid, billableHours, syncDelivered, employeeUtilization, timesheetPlusModels } from './models/timesheetplus.js';

const model = 'account.analytic.line';
const entry = (db, vals = {}) => create(db, model, { employee_id: 1, project_id: 1, task_id: 1, date: '2026-10-19', unit_amount: 2, ...vals });
const approve = (db, ids) => validateTimesheets(db, ids, { user: 'Manager', date: '2026-10-23' });

test('timers round to the nearest quarter hour with a minimum and refuse concurrent employee timers', () => {
  const base = write(seed(), 'hr.employee', 1, { timesheet_cost: 40 });
  for (const [minutes, hours] of [[0, 0.25], [7, 0.25], [22, 0.25], [23, 0.5], [38, 0.75]]) {
    const started = startTimer(base, { employeeId: 1, projectId: 1, taskId: 1, now: '2026-10-19T09:00:00Z' });
    assert.equal(read(started.db, model, started.id).unit_amount, 0);
    assert.throws(() => startTimer(started.db, { employeeId: 1, projectId: 2, now: '2026-10-19T09:01:00Z' }), /running timer/i);
    const stopped = stopTimer(started.db, started.id, `2026-10-19T09:${String(minutes).padStart(2, '0')}:00Z`);
    const line = read(stopped, model, started.id);
    assert.equal(line.unit_amount, hours);
    assert.equal(line.amount, -hours * 40);
    assert.equal(line.timer_start, null);
    assert.equal(read(started.db, model, started.id).unit_amount, 0);
    assert.throws(() => stopTimer(stopped, started.id, '2026-10-19T10:00:00Z'), /not running/i);
  }
  assert.equal(search(base, model).some((r) => r.timer_start), false);
});

test('invalid timer timestamps, backwards time and task/project mismatch are rejected', () => {
  const db = seed();
  assert.throws(() => startTimer(db, { employeeId: 9999, now: '2026-10-19T09:00:00Z' }), /employee/i);
  assert.throws(() => startTimer(db, { employeeId: 1, now: 'invalid' }), /time/i);
  assert.throws(() => startTimer(db, { employeeId: 1, projectId: 2, taskId: 1, now: '2026-10-19T09:00:00Z' }), /project/i);
  const running = startTimer(db, { employeeId: 1, projectId: 1, now: '2026-10-19T09:00:00Z' });
  assert.throws(() => stopTimer(running.db, running.id, '2026-10-19T08:59:00Z'), /before/i);
  assert.throws(() => approve(running.db, [running.id]), /timer/i);
  assert.throws(() => entry(running.db, { timer_start: '2026-10-19T10:00:00Z' }), /running timer/i);
  assert.ok(startTimer(running.db, { employeeId: 2, now: '2026-10-19T09:00:00Z' }).id);
});

test('form timers resume on the same line and validation asks for the approver without stamping a fake user', () => {
  const made = entry(write(seed(), 'hr.employee', 1, { hourly_cost: 20 }));
  const buttons = timesheetPlusModels[model].form.buttons;
  const started = buttons.find((b) => b.label === 'Start Timer').run(made.db, read(made.db, model, made.id)).db;
  const start = read(started, model, made.id).timer_start;
  const stopped = stopTimer(started, made.id, new Date(Date.parse(start) + 900000).toISOString());
  assert.equal(read(stopped, model, made.id).unit_amount, 2.25);
  assert.equal(read(stopped, model, made.id).amount, -45);
  const original = globalThis.prompt;
  const validate = buttons.find((b) => b.label === 'Validate');
  try {
    globalThis.prompt = () => null;
    assert.equal(validate.run(stopped, read(stopped, model, made.id)).db, stopped);
    globalThis.prompt = () => 'Team Lead';
    const validated = validate.run(stopped, read(stopped, model, made.id)).db;
    assert.equal(read(validated, model, made.id).validated_by, 'Team Lead');
  } finally {
    if (original === undefined) delete globalThis.prompt;
    else globalThis.prompt = original;
  }
});

test('validation stamps and costs entries, locks edits and allows only a standalone reset', () => {
  const base = write(seed(), 'hr.employee', 1, { timesheet_cost: 35 });
  const made = entry(base);
  const db = approve(made.db, [made.id]);
  const line = read(db, model, made.id);
  assert.equal(line.validated, true);
  assert.equal(line.validated_by, 'Manager');
  assert.equal(line.validated_on, '2026-10-23');
  assert.equal(line.amount, -70);
  assert.equal(read(made.db, model, made.id).validated, false);
  for (const vals of [{ unit_amount: 3 }, { date: '2026-10-20' }, { task_id: 2 }, { employee_id: 2 }, { billable: 'billable_time' }, { validated: false, unit_amount: 3 }]) {
    assert.throws(() => write(db, model, made.id, vals), /validated/i);
  }
  assert.match(timesheetGuard(db, line, { ...line, unit_amount: 3 }), /validated/i);
  const reset = write(db, model, made.id, { validated: false });
  const edited = write(reset, model, made.id, { unit_amount: 3 });
  assert.equal(read(edited, model, made.id).amount, -105);
  const button = timesheetPlusModels[model].form.buttons.find((b) => b.label === 'Reset to Draft');
  assert.equal(button.admin, true);
  assert.equal(read(button.run(db, line).db, model, made.id).validated_by, '');
});

test('weekly grid aggregates seven dates by project/task and excludes other employees and accounting lines', () => {
  let db = seed();
  for (const vals of [
    { unit_amount: 2 }, { unit_amount: 3 }, { date: '2026-10-25', unit_amount: 4 },
    { task_id: 2, unit_amount: 1 }, { date: '2026-10-26', unit_amount: 99 },
    { employee_id: 2, unit_amount: 99 }, { category: 'invoice', unit_amount: 99 }, { move_id: 1, unit_amount: 99 },
  ]) db = entry(db, vals).db;
  const rows = weeklyGrid(db, 1, '2026-10-19');
  assert.deepEqual(rows.map((r) => [r.project_id, r.task_id, r.days, r.total]), [
    [1, 1, [5, 0, 0, 0, 0, 0, 4], 9], [1, 2, [1, 0, 0, 0, 0, 0, 0], 1],
  ]);
});

test('delivery sync counts only validated time-billed hours on eligible service lines and is idempotent', () => {
  const service = create(seed(), 'product', { name: 'Consulting', type: 'service', invoice_policy: 'delivery' });
  const ordered = create(service.db, 'product', { name: 'Fixed service', type: 'service', invoice_policy: 'order' });
  const order = create(ordered.db, 'sale.order', { partner_id: 1, order_line: [
    { product_id: service.id, qty: 10, qty_delivered: 99 },
    { product_id: service.id, qty: 10, qty_delivered: 99 },
    { product_id: 1, qty: 10, qty_delivered: 7 },
    { product_id: ordered.id, qty: 10, qty_delivered: 8 },
  ] });
  let db = order.db;
  for (const [index, hours, billable, validated, extra] of [
    [0, 2, 'billable_time', true, {}], [0, 3, 'billable_time', false, {}],
    [0, 5, 'billable_fixed', true, {}], [0, 7, 'non_billable', true, {}],
    [1, 4, 'billable_time', true, { invoiced: true }], [2, 6, 'billable_time', true, {}],
    [0, 90, 'billable_time', false, { category: 'invoice', move_id: 1 }],
  ]) {
    const made = entry(db, { so_id: order.id, so_line_index: index, unit_amount: hours, billable, ...extra });
    db = validated ? approve(made.db, [made.id]) : made.db;
  }
  assert.deepEqual(billableHours(db, order.id), [2, 4, 0, 0]);
  const synced = syncDelivered(db, order.id);
  assert.deepEqual(read(synced, 'sale.order', order.id).order_line.map((l) => l.qty_delivered), [2, 4, 7, 8]);
  assert.deepEqual(syncDelivered(synced, order.id), synced);
  assert.equal(read(db, 'sale.order', order.id).order_line[0].qty_delivered, 2); // validation already synced it
  const line = search(db, model).find((r) => r.so_id === order.id && r.so_line_index === 0 && r.validated && r.billable === 'billable_time');
  const reset = write(synced, model, line.id, { validated: false });
  assert.equal(read(syncDelivered(reset, order.id), 'sale.order', order.id).order_line[0].qty_delivered, 0);
});

test('utilization uses inclusive weekdays, includes fixed billable work and handles zero capacity', () => {
  let db = seed();
  for (const vals of [{ unit_amount: 8, billable: 'billable_time' }, { unit_amount: 4, billable: 'billable_fixed' }, { unit_amount: 8 }, { unit_amount: 100, category: 'other' }, { unit_amount: 100, move_id: 1 }]) db = entry(db, vals).db;
  assert.deepEqual(employeeUtilization(db, 1, { from: '2026-10-19', to: '2026-10-25' }), { logged: 20, billable: 12, capacity: 40, utilization: 50, billableRate: 60 });
  assert.equal(employeeUtilization(db, 1, { from: '2026-10-24', to: '2026-10-25' }).utilization, 0);
  assert.equal(employeeUtilization(db, 1, { from: '2026-10-19', to: '2026-10-25' }, 4).capacity, 20);
  assert.throws(() => employeeUtilization(db, 1, { from: '2026-10-25', to: '2026-10-19' }), /date|period/i);
});

test('seed and inherited analytic fields and views survive; accounting amounts are not recosted', () => {
  const db = seed();
  assert.ok(search(db, model).length >= 4);
  const def = timesheetPlusModels[model];
  for (const key of Object.keys(analyticPlusModels[model].fields)) assert.ok(def.fields[key]);
  for (const view of analyticPlusModels[model].views) assert.ok(def.views.includes(view));
  const made = entry(db, { category: 'vendor_bill', move_id: 1, amount: -123 });
  const edited = write(made.db, model, made.id, { unit_amount: 9 });
  assert.equal(read(edited, model, made.id).amount, -123);
  assert.throws(() => approve(edited, [made.id]), /timesheet/i);
  assert.throws(() => entry(db, { unit_amount: -1 }), /hours/i);
});
