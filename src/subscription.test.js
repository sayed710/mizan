import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from './orm.js';
import { models } from './models/index.js';
import { nextPeriod, runRecurring } from './models/more.js';
import { seed } from './seed.js';

test('periods advance by calendar months, clamped to month end', () => {
  assert.equal(nextPeriod('2026-01-31', 'monthly'), '2026-02-28');
  assert.equal(nextPeriod('2026-11-15', 'quarterly'), '2027-02-15');
  assert.equal(nextPeriod('2028-02-29', 'yearly'), '2029-02-28');
  assert.equal(nextPeriod('2026-03-01', 'weekly'), '2026-03-08');
});

test('MRR comes from the recurring lines; recurring invoicing bills due subscriptions and closes at the end date', () => {
  const { db, id } = create(seed(), 'sale.subscription', {
    partner_id: 3, plan: 'quarterly', stage: 'progress', next_invoice_date: '2026-01-10', end_date: '2026-03-31',
    order_line: [{ product_id: 1, qty: 1, price_unit: 300, tax: 14 }],
  });
  assert.equal(read(db, 'sale.subscription', id).recurring_monthly, 100);
  const billed = runRecurring(db, '2026-01-15');
  const sub = read(billed, 'sale.subscription', id);
  assert.equal(sub.next_invoice_date, '2026-04-10');
  assert.equal(sub.stage, 'closed');
  const inv = search(billed, 'account.move').find((m) => m.subscription_id === id);
  assert.equal(inv.invoice_line_ids[0].price_unit, 300);
  assert.equal(search(runRecurring(billed, '2026-12-31'), 'account.move').filter((m) => m.subscription_id === id).length, 1);
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
