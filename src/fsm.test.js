import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from './orm.js';
import { createInvoice, fsmModels, markDone, planTasks, startTimer, stopTimer, technicianLoad } from './models/fsm.js';
import { seed } from './seed.js';

const DAY = '2026-11-02';
const task = (vals) => {
  const { db, id } = create(seed(), 'fsm.task', { name: 'Repair', partner_id: 3, technician_id: 4, date: DAY, ...vals });
  return { db, id, r: () => read(db, 'fsm.task', id) };
};

test('the timer rounds up to 15 minutes, logs at least 15, and refuses a double start', () => {
  const { db: db0, id } = task({});
  const started = startTimer(db0, read(db0, 'fsm.task', id), `${DAY}T09:00:00.000Z`);
  assert.equal(read(started, 'fsm.task', id).stage_id, 'progress');
  assert.throws(() => startTimer(started, read(started, 'fsm.task', id), `${DAY}T09:05:00.000Z`), /already running/);
  const stopped = stopTimer(started, read(started, 'fsm.task', id), `${DAY}T09:31:00.000Z`, 'Swapped motor');
  const after = read(stopped, 'fsm.task', id);
  assert.equal(after.timer_start, null);
  assert.deepEqual(after.timesheet_ids, [{ date: DAY, technician_id: 4, hours: 0.75, description: 'Swapped motor' }]);
  const again = startTimer(stopped, after, `${DAY}T10:00:00.000Z`);
  const short = read(stopTimer(again, read(again, 'fsm.task', id), `${DAY}T10:02:00.000Z`), 'fsm.task', id);
  assert.equal(short.timesheet_ids[1].hours, 0.25);
  assert.equal(short.total_hours, 1);
});

test('total_hours sums timesheets, falling back to legacy hours when there are none', () => {
  assert.equal(task({ hours: 1.5 }).r().total_hours, 1.5);
  assert.equal(task({ hours: 1.5, timesheet_ids: [{ hours: 2 }, { hours: 0.5 }] }).r().total_hours, 2.5);
});

test('done needs a complete, signed worksheet (unless empty) and solves the linked ticket', () => {
  const { db: withTicket, id: ticket } = create(seed(), 'helpdesk.ticket', { name: 'Broken desk', partner_id: 3 });
  const { db, id } = create(withTicket, 'fsm.task', { name: 'Fix', partner_id: 3, helpdesk_ticket_id: ticket, worksheet: [{ label: 'Test motor', done: false }] });
  assert.throws(() => markDone(db, read(db, 'fsm.task', id)), /worksheet/);
  const checked = { ...read(db, 'fsm.task', id), worksheet: [{ label: 'Test motor', done: true }] };
  assert.throws(() => markDone(db, checked), /sign/);
  const done = markDone(db, { ...checked, customer_signature: 'Sara' }, { date: DAY });
  assert.equal(read(done, 'fsm.task', id).stage_id, 'done');
  assert.deepEqual([read(done, 'helpdesk.ticket', ticket).stage_id, read(done, 'helpdesk.ticket', ticket).close_date], ['solved', DAY]);
  const { db: db2, r } = task({});
  assert.equal(read(markDone(db2, r()), 'fsm.task', r().id).stage_id, 'done');
});

test('the invoice bills materials plus hours at the rate, once only', () => {
  const service = search(seed(), 'product').find((p) => p.name === 'Installation (per hour)');
  const { db, r } = task({ timesheet_ids: [{ hours: 2 }], material_ids: [{ product_id: 4, qty: 2, price_unit: 35, discount: 0, tax: 14 }] });
  assert.equal(r().amount_materials, 79.8);
  const { db: invoiced, id } = createInvoice(db, r(), { serviceProductId: service.id, hourlyRate: 60 });
  const inv = read(invoiced, 'account.move', id);
  assert.equal(inv.move_type, 'out_invoice');
  assert.deepEqual(inv.invoice_line_ids.map((l) => [l.product_id, l.qty, l.price_unit, l.tax]), [[4, 2, 35, 14], [service.id, 2, 60, 14]]);
  assert.equal(inv.amount_total, 216.6);
  const after = read(invoiced, 'fsm.task', r().id);
  assert.equal(after.invoice_id, id);
  assert.throws(() => createInvoice(invoiced, after, { serviceProductId: service.id }), /already invoiced/);
  const empty = task({});
  assert.throws(() => createInvoice(empty.db, empty.r()), /Nothing to invoice/);
});

test('technicianLoad and planTasks group the day by technician', () => {
  const db0 = seed();
  const db = [[4, 3], [4, 6], [5, 2]].reduce((acc, [technician_id, planned_hours]) => create(acc, 'fsm.task', { name: 'Job', technician_id, planned_hours, date: DAY }).db, db0);
  assert.equal(technicianLoad(db, 4, DAY), 9);
  assert.equal(technicianLoad(db, 4, '2026-11-03'), 0);
  const plan = planTasks(db, { date: DAY });
  assert.deepEqual(plan.map((p) => [p.technician_id, p.tasks.length, p.hours]), [[4, 2, 9], [5, 1, 2]]);
});

test('the seed field service tasks still load with the richer model', () => {
  const tasks = search(seed(), 'fsm.task');
  assert.ok(tasks.length >= 2);
  const motor = tasks.find((t) => t.name === 'Fix desk motor');
  assert.equal(motor.total_hours, 1.5);
  assert.equal(motor.stage_id, 'progress');
  assert.ok(fsmModels['fsm.task'].form.tabs.map((t) => t.label).join() === 'Timesheets,Products,Worksheet,Description');
});
