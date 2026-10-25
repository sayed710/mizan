import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { accountId, isBalanced } from './models/ledger.js';
import { availability, bestPrice, holdDeposit, pickupPicking, rentalHours, rentalPlusModels, rentalSchedule, returnPicking, settleDeposit } from './models/rentalplus.js';
import { seed } from './seed.js';

const rental = (db, vals = {}) => create(db, 'sale.rental', {
  partner_id: 1, product_id: 4, qty: 2, pickup_date: '2035-01-10', return_date: '2035-01-15', price_per_day: 20, ...vals,
});
const pricing = (db, period, price, duration = 1) => create(db, 'rental.pricing', { product_id: 4, period, duration, price }).db;
const balance = (db, moves, code) => moves.flatMap((m) => m.line_ids).filter((l) => l.account_id === accountId(db, code)).reduce((sum, l) => sum + l.debit - l.credit, 0);

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

test('new model definitions expose forms and lists without replacing sale.rental', () => {
  assert.deepEqual(Object.keys(rentalPlusModels), ['rental.pricing', 'rental.deposit']);
  for (const model of Object.values(rentalPlusModels)) {
    assert.ok(model.form.title);
    assert.ok(model.list.every((field) => model.fields[field]));
    assert.ok(model.form.groups.flat().every((field) => model.fields[field]));
  }
});
