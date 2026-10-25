import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { dueDate, earlyDiscount, installments, termModels } from './models/terms.js';

const db = seed();
const line = (value, value_type = 'percent', nb_days = 0, delay_type = 'days_after') => ({ value, value_type, nb_days, delay_type });
const term = (...line_ids) => ({ line_ids });

test('a single 30-day term is due 30 days after the invoice date', () => {
  assert.ok(db.records);
  const schedule = installments(term(line(100, 'percent', 30)), 250, '2025-01-01');
  assert.deepEqual(schedule, [{ date: '2025-01-31', amount: 250 }]);
  assert.equal(dueDate(term(line(100, 'percent', 30)), '2025-01-01'), '2025-01-31');
});

test('30% now and 70% in 60 days round to the exact invoice total', () => {
  const schedule = installments(term(line(30), line(70, 'percent', 60)), 100.01, '2025-01-01');
  assert.deepEqual(schedule, [
    { date: '2025-01-01', amount: 30 },
    { date: '2025-03-02', amount: 70.01 },
  ]);
  assert.equal(schedule.reduce((sum, row) => sum + row.amount, 0), 100.01);
  const halves = installments(term(line(50), line(50)), 100.01, '2025-01-01');
  assert.deepEqual(halves.map((row) => row.amount), [50.01, 50]);
});

test('a fixed installment and a percentage balance sum to the total', () => {
  const schedule = installments(term(line(125, 'fixed'), line(87.5, 'percent', 15)), 1000.01, '2025-05-01');
  assert.deepEqual(schedule.map((row) => row.amount), [125, 875.01]);
  assert.equal(schedule.reduce((sum, row) => sum + row.amount, 0), 1000.01);
});

test('end-of-month delays start from the month end, including February', () => {
  const january = installments(term(line(100, 'percent', 30, 'days_end_of_month')), 100, '2024-01-15');
  const february = installments(term(line(100, 'percent', 0, 'days_end_of_month')), 100, '2024-02-10');
  assert.equal(january[0].date, '2024-03-01');
  assert.equal(february[0].date, '2024-02-29');
});

test('early discount applies inside the inclusive window and is zero outside it', () => {
  const discounted = { early_discount: true, discount_percent: 2.5, discount_days: 10 };
  assert.equal(earlyDiscount(discounted, 1000, '2025-06-01', '2025-06-11'), 25);
  assert.equal(earlyDiscount(discounted, 1000, '2025-06-01', '2025-06-12'), 0);
  assert.equal(earlyDiscount({ ...discounted, early_discount: false }, 1000, '2025-06-01', '2025-06-02'), 0);
});

test('fixed amounts above the invoice total throw a readable error', () => {
  assert.throws(() => installments(term(line(60, 'fixed'), line(50, 'fixed')), 100, '2025-01-01'), /Fixed amounts exceed the total/);
  assert.throws(() => installments(term(), 100, '2025-01-01'), /at least one due term/);
});

test('the unregistered model defaults to one 100% due line', () => {
  assert.deepEqual(termModels['account.payment.term'].defaults().line_ids, [line(100)]);
});

test('preview lists the example and dated installment', () => {
  const preview = termModels['account.payment.term'].fields.preview.compute({ line_ids: [line(100, 'percent', 30)] });
  assert.match(preview, /^Example: 1,000\.00 on \d{4}-\d{2}-\d{2}\n1,000\.00 on \d{4}-\d{2}-\d{2}$/);
});

test('an invoice takes the partner term, gets its due date and books the early-payment discount', async () => {
  const { seed } = await import('./seed.js');
  const { create, read, search, write } = await import('./orm.js');
  const { models } = await import('./models/index.js');
  const { payWithDiscount, discountAvailable } = await import('./models/accounting.js');
  const { isBalanced } = await import('./models/ledger.js');
  const { addDays: add, today: now } = await import('./models/common.js');
  const db0 = seed();
  const { db: withInv, id } = create(db0, 'account.move', { move_type: 'out_invoice', invoice_date: '2026-03-01', invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 1000, tax: 0 }] });
  const termed = write(withInv, 'account.move', id, { partner_id: 3 });
  assert.equal(read(termed, 'account.move', id).invoice_date_due, '2026-03-31');

  const net = search(db0, 'account.payment.term').find((t) => t.name === '2/7 Net 30').id;
  const { db, id: inv } = create(db0, 'account.move', { move_type: 'out_invoice', partner_id: 5, invoice_date: add(now(), -3), invoice_payment_term_id: net, invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 1000, tax: 0 }] });
  const posted = models['account.move'].form.buttons.find((b) => b.label === 'Confirm').run(db, read(db, 'account.move', inv)).db;
  assert.equal(discountAvailable(posted, read(posted, 'account.move', inv)), 20);
  const paid = payWithDiscount(posted, inv, 980);
  assert.equal(read(paid, 'account.move', inv).amount_residual, 0);
  assert.ok(search(paid, 'account.move').filter((m) => m.move_type === 'entry').every((m) => isBalanced(m.line_ids)));
  assert.equal(discountAvailable(posted, read(posted, 'account.move', inv), add(now(), 10)), 0);
});
