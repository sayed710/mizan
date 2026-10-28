import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { isBalanced } from './models/ledger.js';
import { payMove } from './models/accounting.js';
import { autoClose, invoiceDue, kpis, mrr, nextDate, renew, subscriptionJobs, subscriptionPlusModels, upsell } from './models/subscriptionplus.js';
import { addDays, today } from './models/common.js';

const model = 'sale.subscription';
const baseDb = () => {
  const db = seed();
  return search(db, model).reduce((next, s) => write(next, model, s.id, { stage: 'draft' }), db);
};
const addSub = (db, vals = {}) => create(db, model, {
  partner_id: 1, product_id: 12, plan: 'monthly', recurring_amount: 100, stage: 'progress',
  start_date: '2024-01-01', next_invoice_date: '2024-01-01', ...vals,
});
const invoices = (db, id) => search(db, 'account.move').filter((r) => r.subscription_id === id && r.move_type === 'out_invoice');

test('nextDate clamps calendar months and leap years, supports intervals and weeks, and rejects invalid plans', () => {
  assert.equal(nextDate('2023-01-31', { interval: 1, unit: 'month' }), '2023-02-28');
  assert.equal(nextDate('2024-01-31', { interval: 1, unit: 'month' }), '2024-02-29');
  assert.equal(nextDate('2024-02-29', { interval: 1, unit: 'year' }), '2025-02-28');
  assert.equal(nextDate('2024-11-30', { interval: 3, unit: 'month' }), '2025-02-28');
  assert.equal(nextDate('2024-12-28', { interval: 2, unit: 'week' }), '2025-01-11');
  for (const interval of [0, -1, 1.5]) assert.throws(() => nextDate('2024-01-01', { interval, unit: 'month' }), /positive/);
  assert.throws(() => nextDate('2024-02-30', { interval: 1, unit: 'month' }), /valid invoice date/);
});

test('invoiceDue catches up two months, posts linked balanced invoices, stays immutable and is idempotent', () => {
  const { db, id } = addSub(baseDb(), { next_invoice_date: '2024-02-01' });
  const snapshot = structuredClone(db);
  const billed = invoiceDue(db, '2024-03-15');
  assert.deepEqual(db, snapshot);
  // Late periods are issued on the run date, not back-dated; each invoice still names its period.
  assert.deepEqual(invoices(billed, id).map((r) => [r.subscription_period, r.invoice_date]), [['2024-02-01', '2024-03-15'], ['2024-03-01', '2024-03-15']]);
  assert.ok(invoices(billed, id).every((r) => r.state === 'posted' && isBalanced(r.line_ids)));
  const sub = read(billed, model, id);
  assert.equal(sub.next_invoice_date, '2024-04-01');
  assert.equal(sub.last_invoice_date, '2024-03-15');
  assert.deepEqual(sub.invoice_ids.map((r) => r.invoice_id), invoices(billed, id).map((r) => r.id));
  // Just issued, so not overdue yet.
  assert.equal(sub.health, 'normal');
  assert.strictEqual(invoiceDue(billed, '2024-03-15'), billed);
  assert.equal(invoices(invoiceDue(write(billed, model, id, { stage: 'paused' }), '2025-01-01'), id).length, 2);
});

test('invoiceDue respects custom plans and the exclusive end date; automatic payment books no receipt without a provider', () => {
  const plan = create(baseDb(), 'sale.subscription.plan', { name: 'Two weeks', interval: 2, unit: 'week' });
  const { db, id } = addSub(plan.db, { plan_id: plan.id, payment_token: true, end_date: '2024-01-29' });
  const billed = invoiceDue(db, '2024-03-01');
  assert.deepEqual(invoices(billed, id).map((r) => r.subscription_period), ['2024-01-01', '2024-01-15']);
  // FLOW-012: no payment provider charges the customer, so the invoices stay due, with a note to collect them.
  assert.ok(invoices(billed, id).every((r) => r.amount_residual > 0 && r.payment_state === 'not_paid'));
  assert.equal(search(billed, 'account.payment').length, search(db, 'account.payment').length);
  assert.ok(invoices(billed, id).every((r) => billed.messages.some((m) => m.res_id === r.id && m.model === 'account.move' && /no payment provider/.test(m.body))));
  assert.equal(read(billed, model, id).stage, 'closed');
  assert.equal(read(billed, model, id).closed_date, '2024-01-29');
  assert.equal(read(billed, model, id).recurring_monthly, mrr({ recurring_amount: 100, recurring_plan: { interval: 2, unit: 'week' } }));
  assert.equal(read(plan.db, 'sale.subscription.plan', plan.id).auto_close_days, 15);
  assert.throws(() => create(plan.db, 'sale.subscription.plan', { name: 'Bad', interval: 0 }), /positive interval/);
});

test('autoClose uses the oldest unpaid posted invoice, strict grace threshold and ignores fully paid invoices', () => {
  const plan = create(baseDb(), 'sale.subscription.plan', { name: 'Grace', auto_close_days: 20 });
  const a = addSub(plan.db, { plan_id: plan.id });
  const b = addSub(a.db, { plan_id: plan.id });
  const billed = invoiceDue(b.db, '2024-01-01');
  const paid = payMove(billed, invoices(billed, b.id)[0].id, 114, '2024-01-05');
  // Grace days count from the due date (2024-01-16), not the invoice date.
  assert.equal(read(autoClose(paid, '2024-02-05'), model, a.id).stage, 'progress');
  const closed = autoClose(paid, '2024-02-06');
  assert.equal(read(closed, model, a.id).stage, 'closed');
  assert.equal(read(closed, model, a.id).close_reason, 'unpaid');
  assert.equal(read(closed, model, a.id).health, 'done');
  assert.equal(read(closed, model, b.id).stage, 'progress');
  assert.equal(read(closed, model, b.id).health, 'normal');
  const draft = create(a.db, 'account.move', { move_type: 'out_invoice', partner_id: 1, subscription_id: a.id, invoice_date: '2023-01-01', invoice_line_ids: [{ product_id: 12, qty: 1, price_unit: 100 }] });
  assert.equal(read(autoClose(draft.db, '2024-01-22'), model, a.id).stage, 'progress');
});

test('upsell drafts a prorated origin-linked quotation without changing the parent recurring price', () => {
  const { db, id } = addSub(baseDb());
  const lines = [{ product_id: 12, qty: 2, price_unit: 310, tax: 14 }];
  const result = upsell(db, id, lines, '2024-01-16');
  const quote = read(result.db, model, result.id);
  assert.equal(quote.stage, 'draft');
  assert.equal(quote.origin_id, id);
  assert.equal(quote.order_line[0].price_unit, 160);
  assert.equal(quote.order_line[0].qty, 2);
  assert.equal(lines[0].price_unit, 310);
  assert.equal(read(db, model, id).upsell_ids, undefined);
  assert.throws(() => upsell(db, id, [{ product_id: 12, qty: 1, price_unit: NaN }], '2024-01-16'), /non-negative price/);
  assert.equal(read(result.db, model, id).recurring_amount, 100);
  assert.deepEqual(read(result.db, model, id).upsell_ids, [{ subscription_id: result.id }]);
  assert.equal(invoices(result.db, id).length, 0);
  assert.throws(() => upsell(db, id, [], '2024-01-16'), /at least one/);
  assert.throws(() => upsell(db, id, lines, '2023-12-31'), /inside/);
  assert.throws(() => upsell(db, 99999, lines, '2024-01-16'), /not found/);
});

test('renew creates reciprocal links and a clean draft successor starting at end_date or the requested date', () => {
  const { db, id } = addSub(baseDb(), { end_date: '2024-04-01', payment_token: true });
  const result = renew(db, id, { date: '2024-03-20' });
  const old = read(result.db, model, id);
  const successor = read(result.db, model, result.id);
  assert.equal(read(db, model, id).stage, 'progress');
  assert.equal(old.stage, 'closed');
  assert.equal(old.renewal_id, result.id);
  assert.equal(old.closed_date, '2024-03-20');
  assert.equal(successor.origin_id, id);
  assert.equal(successor.start_date, '2024-04-01');
  assert.equal(successor.next_invoice_date, '2024-04-01');
  assert.equal(successor.stage, 'draft');
  assert.equal(successor.end_date, undefined);
  assert.equal(successor.payment_token, true);
  assert.equal(successor.recurring_amount, 100);
  assert.throws(() => renew(result.db, id, { date: '2024-03-20' }), /already/);
  const open = addSub(db);
  const renewed = renew(open.db, open.id, { date: '2024-03-20' });
  assert.equal(read(renewed.db, model, renewed.id).start_date, '2024-03-20');
});

test('kpis measures opening-cohort churn, new MRR, expansion and retention without counting drafts or upsells', () => {
  const first = addSub(baseDb());
  const second = addSub(first.db);
  let db = invoiceDue(second.db, '2024-01-01');
  db = write(db, model, first.id, { recurring_amount: 150 });
  db = write(db, model, second.id, { stage: 'closed', closed_date: '2024-02-10' });
  db = addSub(db, { start_date: '2024-02-05', recurring_amount: 50 }).db;
  db = addSub(db, { start_date: '2024-02-05', stage: 'draft', recurring_amount: 900 }).db;
  db = upsell(db, first.id, [{ product_id: 12, qty: 1, price_unit: 100 }], '2024-02-15').db;
  assert.deepEqual(kpis(db, '2024-02-15'), { mrr: 200, arr: 2400, activeCount: 2, churnRate: 0.5, newMrr: 50, churnedMrr: 100, netRevenueRetention: 0.75 });
  assert.equal(mrr({ plan: 'yearly', recurring_amount: 1200 }), 100);
  assert.equal(mrr({ recurring_plan: { interval: 3, unit: 'month' }, order_line: [{ qty: 2, price_unit: 150, tax: 14 }] }), 100);
  assert.equal(kpis(baseDb(), '2020-01-01').netRevenueRetention, 0);
});

test('manual billing invoices only the selected subscription and preserves invoice navigation', () => {
  const first = addSub(baseDb());
  const second = addSub(first.db);
  const button = subscriptionPlusModels[model].form.buttons.find((b) => b.label === 'Generate Invoice');
  const billed = button.run(second.db, read(second.db, model, first.id));
  assert.equal(invoices(billed.db, first.id).length, 1);
  assert.equal(invoices(billed.db, second.id).length, 0);
  assert.equal(billed.go, `#/accounting/invoices/${invoices(billed.db, first.id)[0].id}`);
  assert.equal(read(billed.db, model, first.id).next_invoice_date, '2024-02-01');
});

test('plan onchange normalizes MRR and close/reopen actions preserve reason prompting and cancellation', () => {
  const plan = create(baseDb(), 'sale.subscription.plan', { name: 'Annual', interval: 1, unit: 'year' });
  const sub = addSub(plan.db, { recurring_amount: 1200 });
  const changed = write(sub.db, model, sub.id, { plan_id: plan.id });
  assert.equal(read(changed, model, sub.id).recurring_monthly, 100);
  const fallback = write(write(changed, model, sub.id, { plan_id: null }), model, sub.id, { plan: 'quarterly' });
  assert.equal(read(fallback, model, sub.id).recurring_monthly, 400);
  const close = subscriptionPlusModels[model].form.buttons.find((b) => b.label === 'Close');
  const prompt = globalThis.prompt;
  try {
    globalThis.prompt = () => null;
    assert.strictEqual(close.run(changed, read(changed, model, sub.id)).db, changed);
    globalThis.prompt = () => '1';
    const closed = close.run(changed, read(changed, model, sub.id)).db;
    assert.equal(read(closed, model, sub.id).close_reason, 'price');
    assert.ok(read(closed, model, sub.id).closed_date);
    const reopen = subscriptionPlusModels[model].form.buttons.find((b) => b.label === 'Reopen');
    const reopened = reopen.run(closed, read(closed, model, sub.id)).db;
    assert.equal(read(reopened, model, sub.id).stage, 'progress');
    assert.equal(read(reopened, model, sub.id).close_reason, null);
    assert.equal(read(reopened, model, sub.id).closed_date, null);
    assert.ok(read(reopened, model, sub.id).next_invoice_date >= today());
  } finally {
    if (prompt === undefined) delete globalThis.prompt;
    else globalThis.prompt = prompt;
  }
});

test('subscriptionJobs composes billing and closure; the seed and original model surfaces remain available', () => {
  const db = seed();
  assert.equal(search(db, model).length, 3);
  assert.ok(subscriptionPlusModels[model].fields.plan);
  assert.ok(subscriptionPlusModels[model].filters[0].some((f) => f.id === 'due'));
  for (const label of ['Start', 'Generate Invoice', 'Pause', 'Resume', 'Close', 'Upsell', 'Renew', 'Reopen']) assert.ok(subscriptionPlusModels[model].form.buttons.some((b) => b.label === label));
  assert.equal(subscriptionPlusModels[model].kanban.badge, 'health');
  const sub = addSub(baseDb());
  // The catch-up run bills without closing the customer in the same breath.
  const result = subscriptionJobs(sub.db, '2024-01-22');
  assert.equal(invoices(result, sub.id).length, 1);
  assert.equal(read(result, model, sub.id).stage, 'progress');
  assert.equal(read(subscriptionJobs(result, '2024-02-22'), model, sub.id).close_reason, 'unpaid');
});

test('reopening a closed subscription bills from the reopen date, not the months it was closed', () => {
  const sub = addSub(baseDb(), { next_invoice_date: addDays(today(), -120), stage: 'closed', close_reason: 'unpaid', closed_date: addDays(today(), -120) });
  const reopen = subscriptionPlusModels[model].form.buttons.find((b) => b.label === 'Reopen');
  const reopened = reopen.run(sub.db, read(sub.db, model, sub.id)).db;
  const billed = invoiceDue(reopened, today());
  assert.deepEqual(invoices(billed, sub.id).map((r) => r.subscription_period), [today()]);
});
