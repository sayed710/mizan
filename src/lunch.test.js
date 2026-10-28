import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { activeAlerts, balance, cancelOrder, canOrder, confirmOrders, orderLunch, receiveOrders, vendorSummary } from './models/lunch.js';
import { seed } from './seed.js';

// 2026-10-26 is a Monday, 2026-10-31 a Saturday.
const MON_9 = new Date(2026, 9, 26, 9, 0);
const MON_11 = new Date(2026, 9, 26, 11, 0);
const SAT_9 = new Date(2026, 9, 31, 9, 0);
const DAY = '2026-10-26';

function setup() {
  let db = seed();
  const s1 = create(db, 'lunch.supplier', { name: 'Nile Grill' });
  const s2 = create(s1.db, 'lunch.supplier', { name: 'Pizza Corner', order_deadline: '12:00' });
  const p1 = create(s2.db, 'lunch.product', { name: 'Kofta', supplier_id: s1.id, price: 7 });
  const p2 = create(p1.db, 'lunch.product', { name: 'Pepperoni', supplier_id: s2.id, price: 10 });
  db = create(p2.db, 'lunch.cashmove', { employee_id: 2, amount: 50, description: 'Top-up' }).db;
  return { db, nile: s1.id, pizza: s2.id, kofta: p1.id, pepperoni: p2.id };
}

test('balance sums the employee cash moves', () => {
  const { db } = setup();
  const next = create(db, 'lunch.cashmove', { employee_id: 2, amount: -12.5 }).db;
  assert.equal(balance(next, 2), 37.5);
  assert.equal(balance(next, 3), 0);
});

test('canOrder checks the vendor weekday and deadline', () => {
  const { db, kofta, pepperoni } = setup();
  const product = (id) => read(db, 'lunch.product', id);
  assert.deepEqual(canOrder(db, product(kofta), MON_9), { ok: true, reason: null });
  assert.equal(canOrder(db, product(kofta), MON_11).ok, false);
  assert.equal(canOrder(db, product(pepperoni), MON_11).ok, true);
  assert.match(canOrder(db, product(kofta), SAT_9).reason, /does not deliver today/);
  assert.equal(canOrder(db, product(kofta), new Date(2026, 9, 26, 10, 30)).ok, false);
});

test('orders are refused beyond the overdraft', () => {
  const { db, pepperoni } = setup();
  const { db: d1, id } = orderLunch(db, { employeeId: 2, productId: pepperoni, quantity: 4, at: MON_9 });
  assert.equal(read(d1, 'lunch.order', id).stage_id, 'new');
  assert.equal(read(d1, 'lunch.order', id).price, 40);
  assert.throws(() => orderLunch(d1, { employeeId: 2, productId: pepperoni, quantity: 2, at: MON_9 }), /not have enough money/);
  const loose = { ...d1, settings: { ...d1.settings, lunch_overdraft: 20 } };
  assert.ok(orderLunch(loose, { employeeId: 2, productId: pepperoni, quantity: 2, at: MON_9 }).id);
  assert.throws(() => orderLunch(db, { employeeId: 2, productId: pepperoni, at: SAT_9 }), /does not deliver/);
});

test('quantity must be positive', () => {
  const { db, kofta } = setup();
  assert.throws(() => create(db, 'lunch.order', { product_id: kofta, quantity: 0 }), /greater than zero/);
});

test('confirm sends a vendor\'s orders and receive pays exactly once', () => {
  const { db, kofta, pepperoni, nile } = setup();
  const a = orderLunch(db, { employeeId: 2, productId: kofta, quantity: 2, at: MON_9 });
  const b = orderLunch(a.db, { employeeId: 2, productId: pepperoni, at: MON_9 });
  const sent = confirmOrders(b.db, nile, DAY);
  assert.equal(read(sent, 'lunch.order', a.id).stage_id, 'ordered');
  assert.equal(read(sent, 'lunch.order', b.id).stage_id, 'new');
  const once = receiveOrders(sent, [a.id]);
  const twice = receiveOrders(once, [a.id]);
  assert.equal(read(twice, 'lunch.order', a.id).stage_id, 'confirmed');
  const moves = search(twice, 'lunch.cashmove').filter((m) => m.order_id === a.id);
  assert.deepEqual(moves.map((m) => m.amount), [-14]);
  assert.equal(balance(twice, 2), 36);
  assert.throws(() => cancelOrder(twice, a.id), /cannot be cancelled/);
});

test('cancelling refunds a linked payment', () => {
  const { db, kofta } = setup();
  const o = orderLunch(db, { employeeId: 2, productId: kofta, at: MON_9 });
  const paid = create(o.db, 'lunch.cashmove', { employee_id: 2, amount: -7, order_id: o.id }).db;
  const done = cancelOrder(paid, o.id);
  assert.equal(read(done, 'lunch.order', o.id).stage_id, 'cancelled');
  assert.equal(balance(done, 2), 50);
  assert.equal(balance(cancelOrder(o.db, o.id), 2), 50);
});

test('alerts follow the weekday and the show-until date', () => {
  let db = setup().db;
  db = create(db, 'lunch.alert', { name: 'Weekdays' }).db;
  db = create(db, 'lunch.alert', { name: 'Expired', show_until: '2026-10-25' }).db;
  db = create(db, 'lunch.alert', { name: 'Weekend', mon: false, sat: true }).db;
  const off = create(db, 'lunch.alert', { name: 'Off' });
  db = write(off.db, 'lunch.alert', off.id, { active: false });
  assert.deepEqual(activeAlerts(db, MON_9).map((a) => a.name), ['Weekdays']);
  assert.deepEqual(activeAlerts(db, SAT_9).map((a) => a.name), ['Weekend']);
});

test('vendorSummary lists products and quantities per vendor', () => {
  const { db, kofta, pepperoni, nile, pizza } = setup();
  let d = orderLunch(db, { employeeId: 2, productId: kofta, quantity: 2, at: MON_9 }).db;
  d = orderLunch(d, { employeeId: 2, productId: kofta, at: MON_9 }).db;
  const c = orderLunch(d, { employeeId: 2, productId: pepperoni, at: MON_9 });
  d = orderLunch(cancelOrder(c.db, c.id), { employeeId: 2, productId: pepperoni, at: MON_9 }).db;
  const summary = vendorSummary(d, DAY);
  // The seed has its own orders dated today; check only this test's suppliers.
  assert.deepEqual(summary.filter((g) => [nile, pizza].includes(g.supplier_id)).map((g) => [g.supplier_id, g.vendor, g.lines.map((l) => [l.product, l.quantity]), g.total]), [
    [nile, 'Nile Grill', [['Kofta', 3]], 21],
    [pizza, 'Pizza Corner', [['Pepperoni', 1]], 10],
  ]);
});

test('the seed still loads its lunch data', () => {
  const db = seed();
  assert.equal(search(db, 'lunch.product').length, 4);
  const orders = search(db, 'lunch.order');
  assert.equal(orders.length, 2);
  assert.deepEqual(orders.map((o) => o.stage_id), ['ordered', 'new']);
  assert.ok(vendorSummary(db).some((g) => g.vendor === 'Cairo Kitchen'));
});
