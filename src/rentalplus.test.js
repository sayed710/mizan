import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, unlink, write } from './orm.js';
import { models } from './models/index.js';
import { accountId, isBalanced } from './models/ledger.js';
import { extraModels } from './models/extra.js';
import { availability, bestPrice, holdDeposit, pickupPicking, rentalHours, rentalPlusModels, rentalSchedule, returnPicking, settleDeposit } from './models/rentalplus.js';
import { seed } from './seed.js';
import { migrate } from './migrations.js';

const rental = (db, vals = {}) => create(db, 'sale.rental', {
  partner_id: 1, product_id: 4, qty: 2, pickup_date: '2035-01-10', return_date: '2035-01-15', price_per_day: 20, ...vals,
});
const pricing = (db, period, price, duration = 1) => create(db, 'rental.pricing', { product_id: 4, period, duration, price }).db;
const balance = (db, moves, code) => moves.flatMap((m) => m.line_ids).filter((l) => l.account_id === accountId(db, code)).reduce((sum, l) => sum + l.debit - l.credit, 0);

test('a legacy rental with counters is flagged and its counters are unchanged after migration', () => {
  const order = rental(seed(), { state: 'returned', invoiced: true, late_fee_invoiced: 40 });
  const upgraded = migrate({ ...order.db, schema_version: 10 });
  const record = read(upgraded, 'sale.rental', order.id);
  assert.equal(record.invoiced, true);
  assert.equal(record.late_fee_invoiced, 40);
  assert.equal(record.billing_invoiced, true);
  assert.equal(record.billing_late_fee, 40);
  assert.equal(record.legacy_billing_review, true);
  const buttons = models['sale.rental'].form.buttons;
  assert.equal(buttons.find((b) => b.label === 'Create Invoice').when(record), false);
  assert.equal(buttons.find((b) => b.label === 'Invoice Late Fee').when(record), false);
  const review = buttons.find((b) => b.label === 'Reconcile Legacy Billing');
  assert.equal(review.when(record), true);
  const resolved = review.run(upgraded, record, { invoiced: 'yes', late_fee_invoiced: 20, note: 'Audited billing' }).db;
  const current = read(resolved, 'sale.rental', order.id);
  assert.equal(current.legacy_billing_review, false);
  assert.equal(current.invoiced, true);
  assert.equal(current.late_fee_invoiced, 20);
  assert.equal(current.billing_invoiced, true);
  assert.equal(current.billing_late_fee, 20);
  assert.equal(current.legacy_billing_review_note, 'Audited billing');
});

for (const operation of ['cancel', 'delete']) test(`cancelling or deleting an unrelated invoice whose text resembles a rental never changes any rental counter (${operation})`, () => {
  const order = rental(seed(), { state: 'returned', invoiced: true, late_fee_invoiced: 40 });
  const rentalRecord = read(order.db, 'sale.rental', order.id);
  const invoice = create(order.db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: rentalRecord.partner_id,
    invoice_origin: rentalRecord.name,
    invoice_line_ids: [
      { product_id: rentalRecord.product_id, name: 'Rental', qty: 1, price_unit: 20 },
      { product_id: rentalRecord.product_id, name: 'Late return (2 day(s))', qty: 1, price_unit: 40 },
    ],
  });
  const action = (db, model, id, label) => models[model].form.buttons.find((b) => b.label === label).run(db, read(db, model, id)).db;
  const next = operation === 'cancel' ? action(invoice.db, 'account.move', invoice.id, 'Cancel') : unlink(invoice.db, 'account.move', [invoice.id]);
  const current = read(next, 'sale.rental', order.id);
  assert.equal(current.invoiced, true);
  assert.equal(current.late_fee_invoiced, 40);
  assert.equal(current.billing_invoiced, true);
  assert.equal(current.billing_late_fee, 40);
});

test('a new rental invoice still updates the counters', () => {
  const order = rental(seed(), { state: 'picked', pickup_date: '2035-01-01', return_date: '2035-01-05', qty: 2 });
  const button = (label) => models['sale.rental'].form.buttons.find((b) => b.label === label);
  assert.equal(read(order.db, 'sale.rental', order.id).billing_invoiced, false);
  const invoiced = button('Create Invoice').run(order.db, read(order.db, 'sale.rental', order.id)).db;
  assert.equal(read(invoiced, 'sale.rental', order.id).billing_invoiced, true);
});

test('cancelled or deleted rental invoices and late fees become invoiceable again', () => {
  const order = rental(seed(), { state: 'returned', pickup_date: '2035-01-01', return_date: '2035-01-05', actual_return_date: '2035-01-07', qty: 1, late_fee_factor: 1 });
  const action = (db, model, id, label) => models[model].form.buttons.find((b) => b.label === label).run(db, read(db, model, id)).db;
  const rentalButton = (label) => models['sale.rental'].form.buttons.find((b) => b.label === label);
  let db = action(order.db, 'sale.rental', order.id, 'Create Invoice');
  let invoice = search(db, 'account.move').find((m) => m.invoice_origin === read(db, 'sale.rental', order.id).name);
  assert.equal(read(db, 'sale.rental', order.id).billing_late_fee, 40);
  db = action(db, 'account.move', invoice.id, 'Cancel');
  assert.equal(rentalButton('Create Invoice').when(read(db, 'sale.rental', order.id)), true);
  assert.equal(read(db, 'sale.rental', order.id).billing_late_fee, 0);
  db = action(db, 'sale.rental', order.id, 'Create Invoice');
  invoice = search(db, 'account.move').filter((m) => m.invoice_origin === read(db, 'sale.rental', order.id).name).at(-1);
  db = unlink(db, 'account.move', [invoice.id]);
  assert.equal(rentalButton('Create Invoice').when(read(db, 'sale.rental', order.id)), true);
  db = action(db, 'sale.rental', order.id, 'Create Invoice');
  db = write(db, 'sale.rental', order.id, { actual_return_date: '2035-01-08' });
  db = action(db, 'sale.rental', order.id, 'Invoice Late Fee');
  const late = search(db, 'account.move').filter((m) => m.invoice_origin === read(db, 'sale.rental', order.id).name).at(-1);
  assert.equal(read(db, 'sale.rental', order.id).billing_late_fee, 60);
  db = action(db, 'account.move', late.id, 'Cancel');
  assert.equal(read(db, 'sale.rental', order.id).billing_late_fee, 40);
  assert.equal(rentalButton('Invoice Late Fee').when(read(db, 'sale.rental', order.id)), true);
  db = action(db, 'sale.rental', order.id, 'Invoice Late Fee');
  const replacement = search(db, 'account.move').filter((m) => m.invoice_origin === read(db, 'sale.rental', order.id).name).at(-1);
  assert.equal(replacement.invoice_line_ids[0].price_unit, 20);
  db = unlink(db, 'account.move', [replacement.id]);
  assert.equal(read(db, 'sale.rental', order.id).billing_late_fee, 40);
});

test('rental quotation and invoice use the cheapest intermediate rule combination', () => {
  const db = pricing(pricing(seed(), 'hour', 6, 4), 'hour', 4, 3);
  const order = rental(db, { qty: 2, pickup_date: '2035-01-01T00:00:00Z', return_date: '2035-01-01T10:00:00Z' });
  const button = (label) => models['sale.rental'].form.buttons.find((b) => b.label === label);
  assert.equal(read(order.db, 'sale.rental', order.id).amount_total, 28);
  const reserved = button('Confirm').run(order.db, read(order.db, 'sale.rental', order.id)).db;
  const picked = button('Pickup').run(reserved, read(reserved, 'sale.rental', order.id)).db;
  const invoiced = button('Create Invoice').run(picked, read(picked, 'sale.rental', order.id)).db;
  const invoice = search(invoiced, 'account.move').find((m) => m.invoice_origin === read(invoiced, 'sale.rental', order.id).name);
  assert.equal(invoice.amount_untaxed, 28);
});

test('rental quotation and invoice preserve the agreed duration price for each unit', () => {
  const db = pricing(pricing(seed(), 'day', 20), 'week', 100);
  const order = rental(db, { qty: 2, pickup_date: '2035-01-01', return_date: '2035-01-10' });
  const button = (label) => rentalPlusModels['sale.rental'].form.buttons.find((b) => b.label === label);
  assert.equal(read(order.db, 'sale.rental', order.id).amount_total, 280);
  const reserved = button('Confirm').run(order.db, read(order.db, 'sale.rental', order.id)).db;
  const changed = pricing(reserved, 'week', 10);
  const picked = button('Pickup').run(changed, read(changed, 'sale.rental', order.id)).db;
  const invoiced = button('Create Invoice').run(picked, read(picked, 'sale.rental', order.id)).db;
  const invoice = search(invoiced, 'account.move').find((m) => m.invoice_origin === read(invoiced, 'sale.rental', order.id).name);
  assert.equal(invoice.amount_untaxed, 280);
});

test('rental pricing combines weeks and days, rounds up when cheaper, and considers shorter rules alone', () => {
  const db = pricing(pricing(seed(), 'day', 20), 'week', 100);
  const snapshot = structuredClone(db);
  assert.deepEqual(bestPrice(db, 4, 9 * 24), { price: 140, breakdown: [
    { period: 'week', duration: 1, qty: 1, price: 100 },
    { period: 'day', duration: 1, qty: 2, price: 40 },
  ] });
  assert.deepEqual(bestPrice(db, 4, 6 * 24), { price: 100, breakdown: [{ period: 'week', duration: 1, qty: 1, price: 100 }] });
  assert.equal(bestPrice(pricing(db, 'month', 150), 4, 13 * 24).price, 150);
  const costlyWeek = pricing(pricing(seed(), 'day', 20), 'week', 200);
  assert.equal(bestPrice(costlyWeek, 4, 9 * 24).price, 180);
  assert.deepEqual(db, snapshot);
});

test('pricing respects multi-period durations and hourly rules and validates rule inputs', () => {
  const db = pricing(pricing(seed(), 'hour', 8), 'day', 30, 2);
  assert.deepEqual(bestPrice(db, 4, 49), { price: 38, breakdown: [
    { period: 'day', duration: 2, qty: 1, price: 30 }, { period: 'hour', duration: 1, qty: 1, price: 8 },
  ] });
  assert.equal(bestPrice(pricing(db, 'week', 0), 4, 12).price, 0);
  for (const vals of [{ duration: 0 }, { duration: 1.5 }, { period: 'year' }, { price: -1 }, { price: NaN }]) {
    assert.throws(() => create(db, 'rental.pricing', { product_id: 4, price: 20, ...vals }), /period|duration|Price/);
  }
  assert.throws(() => bestPrice(db, 4, Infinity), /duration/);
});

test('pricing without rules uses the matching rental daily price and rounds partial days up', () => {
  const { db } = rental(seed());
  assert.deepEqual(bestPrice(db, 4, 25), { price: 40, breakdown: [{ period: 'day', duration: 1, qty: 2, price: 40 }] });
  assert.equal(bestPrice(db, 4, 0).price, 20);
  assert.throws(() => bestPrice(db, 8, 24), /daily price/);
});

test('rental hours supports ISO dates and datetimes, whole-hour billing and invalid windows', () => {
  assert.equal(rentalHours('2035-01-01', '2035-01-10'), 216);
  assert.equal(rentalHours('2035-01-01T10:00:00Z', '2035-01-01T11:01:00Z'), 2);
  assert.equal(rentalHours('2035-01-01T10:00:00Z', '2035-01-01T12:00:00+02:00'), 1);
  assert.equal(rentalHours('2035-01-01', '2035-01-01'), 1);
  assert.throws(() => rentalHours('bad', '2035-01-01'), /valid/);
  assert.throws(() => rentalHours('2035-01-02', '2035-01-01'), /after/);
});

test('availability subtracts overlapping reservations, ignores inactive rentals and avoids double-counting picked stock', () => {
  let db = write(seed(), 'product', 4, { qty_available: 8 });
  db = rental(db, { state: 'reserved', qty: 3 }).db;
  db = rental(db, { state: 'picked', qty: 2, pickup_date: '2035-01-01', return_date: '2035-01-02' }).db;
  for (const state of ['quotation', 'cancel', 'returned']) db = rental(db, { state, qty: 50 }).db;
  db = rental(db, { state: 'reserved', qty: 50, pickup_date: '2035-02-01', return_date: '2035-02-02' }).db;
  const snapshot = structuredClone(db);
  assert.equal(availability(db, 4, '2035-01-12', '2035-01-13'), 5);
  assert.equal(availability(db, 4, '2035-01-15T00:00:00Z', '2035-01-16'), 5);
  assert.equal(availability(db, 4, '2035-01-16', '2035-01-17'), 8);
  assert.equal(availability(db, 4, '2034-12-01', '2034-12-02'), 10);
  assert.deepEqual(db, snapshot);
  assert.throws(() => availability(db, 99999, '2035-01-01', '2035-01-02'), /Product not found/);
});

for (const damage of [0, 35.25, 100]) {
  test(`deposit hold and settlement with damage ${damage} balance the liability, bank and income`, () => {
    const base = rental(seed());
    const snapshot = structuredClone(base.db);
    const held = holdDeposit(base.db, base.id, 100);
    const deposit = read(held.db, 'rental.deposit', held.id);
    assert.equal(deposit.state, 'held');
    assert.equal(deposit.amount, 100);
    const holdMove = read(held.db, 'account.move', deposit.move_id);
    assert.equal(holdMove.state, 'posted');
    assert.equal(balance(held.db, [holdMove], '101401'), 100);
    assert.equal(balance(held.db, [holdMove], '230100'), -100);
    const after = settleDeposit(held.db, held.id, { damage, note: 'Inspection complete' });
    const settled = read(after, 'rental.deposit', held.id);
    assert.equal(settled.state, damage ? 'withheld' : 'refunded');
    assert.equal(settled.withheld_amount, damage);
    assert.equal(settled.note, 'Inspection complete');
    assert.equal(settled.move_id, deposit.move_id);
    const moves = [holdMove, read(after, 'account.move', settled.settlement_move_id)];
    assert.ok(moves.every((m) => m.state === 'posted' && isBalanced(m.line_ids)));
    assert.ok(moves.every((m) => m.line_ids.every((l) => l.account_id && l.partner_id === 1)));
    assert.equal(balance(after, moves, '230100'), 0);
    assert.equal(balance(after, moves, '101401'), damage);
    assert.equal(balance(after, moves, '450000'), damage ? -damage : 0);
    assert.throws(() => settleDeposit(after, held.id), /already been settled/);
    assert.equal(read(held.db, 'rental.deposit', held.id).state, 'held');
    assert.deepEqual(base.db, snapshot);
  });
}

test('deposits reject missing records, nonpositive holds and invalid damage without changing the db', () => {
  const base = rental(seed());
  for (const amount of [0, -1, NaN, Infinity, 0.001]) assert.throws(() => holdDeposit(base.db, base.id, amount), /positive/);
  assert.throws(() => holdDeposit(base.db, 99999, 100), /Rental not found/);
  const held = holdDeposit(base.db, base.id, 100);
  const snapshot = structuredClone(held.db);
  for (const damage of [-1, 101, NaN, Infinity]) assert.throws(() => settleDeposit(held.db, held.id, { damage }), /Damage/);
  assert.throws(() => settleDeposit(held.db, 99999), /Deposit not found/);
  assert.deepEqual(held.db, snapshot);
});

test('pickup and return transfers are linked, draft, and idempotent even when passed a stale rental', () => {
  const base = rental(seed());
  const r = read(base.db, 'sale.rental', base.id);
  const snapshot = structuredClone(base.db);
  const picked = pickupPicking(base.db, r);
  assert.equal(pickupPicking(picked, r), picked);
  const returned = returnPicking(picked, r);
  assert.equal(returnPicking(returned, r), returned);
  const linked = read(returned, 'sale.rental', r.id);
  const pickings = [linked.pickup_picking_id, linked.return_picking_id].map((id) => read(returned, 'stock.picking', id));
  assert.deepEqual(pickings.map((p) => p.picking_type), ['outgoing', 'incoming']);
  for (const p of pickings) {
    assert.equal(p.state, 'draft');
    assert.equal(p.partner_id, r.partner_id);
    assert.equal(p.origin, r.name);
    assert.deepEqual(p.move_ids, [{ product_id: 4, qty: 2 }]);
  }
  assert.equal(search(returned, 'stock.picking').length, search(base.db, 'stock.picking').length + 2);
  assert.equal(read(returned, 'product', 4).qty_available, read(base.db, 'product', 4).qty_available);
  assert.equal(linked.state, r.state);
  assert.deepEqual(base.db, snapshot);
});

test('schedule groups overlapping rentals by product, sorts them and preserves actual return dates and states', () => {
  const a = rental(seed(), { state: 'reserved' });
  const b = rental(a.db, { state: 'returned', pickup_date: '2035-01-08', actual_return_date: '2035-01-12' });
  const c = rental(b.db, { product_id: 8, state: 'quotation' });
  const d = rental(c.db, { pickup_date: '2035-02-01', return_date: '2035-02-05' });
  const schedule = rentalSchedule(d.db, { from: '2035-01-12', to: '2035-01-13' });
  assert.deepEqual(schedule.map((row) => row.product_id), [4, 8]);
  assert.deepEqual(schedule[0].rentals.map((r) => [r.id, r.start, r.end, r.state]), [
    [b.id, '2035-01-08', '2035-01-12', 'returned'], [a.id, '2035-01-10', '2035-01-15', 'reserved'],
  ]);
  assert.deepEqual(schedule[1].rentals.map((r) => [r.id, r.state]), [[c.id, 'quotation']]);
  assert.deepEqual(rentalSchedule(d.db, { from: '2036-01-01', to: '2036-01-02' }), []);
});

test('new model definitions expose forms and lists, and sale.rental only gains a deposit button', () => {
  assert.deepEqual(Object.keys(rentalPlusModels), ['rental.pricing', 'rental.deposit', 'sale.rental']);
  const base = extraModels['sale.rental'];
  const rental = rentalPlusModels['sale.rental'];
  assert.equal(rental.fields, base.fields);
  assert.deepEqual(rental.form.buttons.map((b) => b.label), [...base.form.buttons.map((b) => b.label), 'Hold Deposit']);
  for (const model of Object.values(rentalPlusModels)) {
    assert.ok(model.form.title);
    assert.ok(model.list.every((field) => model.fields[field]));
    assert.ok(model.form.groups.flat().every((field) => model.fields[field]));
  }
});
