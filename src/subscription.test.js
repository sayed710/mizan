import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from './orm.js';
import { models } from './models/index.js';
import { nextPeriod } from './models/more.js';
import { subscriptionJobs } from './models/subscriptionplus.js';
import { seed } from './seed.js';

test('periods advance by calendar months, clamped to month end', () => {
  assert.equal(nextPeriod('2026-01-31', 'monthly'), '2026-02-28');
  assert.equal(nextPeriod('2026-11-15', 'quarterly'), '2027-02-15');
  assert.equal(nextPeriod('2028-02-29', 'yearly'), '2029-02-28');
  assert.equal(nextPeriod('2026-03-01', 'weekly'), '2026-03-08');
});

test('MRR comes from the recurring lines; scheduled invoicing bills due subscriptions and closes at the end date', () => {
  const { db, id } = create(seed(), 'sale.subscription', {
    partner_id: 3, plan: 'quarterly', stage: 'progress', next_invoice_date: '2026-01-10', end_date: '2026-03-31',
    order_line: [{ product_id: 1, qty: 1, price_unit: 300, tax: 14 }],
  });
  assert.equal(read(db, 'sale.subscription', id).recurring_monthly, 100);
  const billed = subscriptionJobs(db, '2026-01-15');
  const sub = read(billed, 'sale.subscription', id);
  assert.equal(sub.next_invoice_date, '2026-04-10');
  const inv = search(billed, 'account.move').find((m) => m.subscription_id === id);
  assert.equal(inv.invoice_line_ids[0].price_unit, 300);
  const later = subscriptionJobs(billed, '2026-12-31');
  assert.equal(read(later, 'sale.subscription', id).stage, 'closed');
  assert.equal(search(later, 'account.move').filter((m) => m.subscription_id === id).length, 1);
  assert.ok(models['sale.subscription'].form.buttons.some((b) => b.label === 'Renew'));
});

test('scheduled jobs invoice due subscriptions and run accruals, and change nothing when nothing is due', async () => {
  const { runScheduledJobs } = await import('./models/scheduler.js');
  const { db, id } = create(seed(), 'hr.leave.allocation', { name: 'Accrual', employee_id: 1, allocation_type: 'accrual', accrual_days_per_month: 2, date_from: '2026-01-01', state: 'validate' });
  const ran = runScheduledJobs(db, '2026-04-02');
  assert.equal(read(ran, 'hr.leave.allocation', id).number_of_days, 6);
  const quiet = runScheduledJobs(seed(), '2000-01-01');
  assert.equal(quiet.records['account.move'].length, seed().records['account.move'].length);
});

test('preventive maintenance is requested when due, once, and the next date moves by the period', async () => {
  const { schedulePreventive } = await import('./models/apps2.js');
  const { db, id } = create(seed(), 'maintenance.equipment', { name: 'CNC', period: 30, next_maintenance: '2026-05-01', maintenance_duration: 2 });
  const once = schedulePreventive(db, '2026-05-03');
  const reqs = search(once, 'maintenance.request').filter((r) => r.equipment_id === id);
  assert.deepEqual(reqs.map((r) => [r.maintenance_type, r.schedule_date, r.duration]), [['preventive', '2026-05-01', 2]]);
  assert.equal(read(once, 'maintenance.equipment', id).next_maintenance, '2026-05-31');
  const again = schedulePreventive(once, '2026-06-05');
  assert.equal(search(again, 'maintenance.request').filter((r) => r.equipment_id === id).length, 1);
});

test('odometer readings update the vehicle and never go backwards', async () => {
  const { logOdometer } = await import('./models/apps2.js');
  const vehicle = search(seed(), 'fleet.vehicle')[0];
  const db = logOdometer(seed(), vehicle, 12000, '2026-05-01');
  assert.equal(read(db, 'fleet.vehicle', vehicle.id).odometer, 12000);
  assert.throws(() => logOdometer(db, vehicle, 11000, '2026-06-01'), /cannot go below 12000/);
});
