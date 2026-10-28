import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { models } from './models/index.js';

const button = (model, label) => models[model].form.buttons.find((b) => b.label === label);
const press = (db, model, id, label) => button(model, label).run(db, read(db, model, id));
const product = 7;

function confirmedSale(qty = 10) {
  const so = create(seed(), 'sale.order', { partner_id: 2, order_line: [{ product_id: product, qty, price_unit: 100, tax: 0 }] });
  const db = press(so.db, 'sale.order', so.id, 'Confirm').db;
  const picking = search(db, 'stock.picking').find((p) => p.sale_id === so.id);
  return { db, so: so.id, picking: picking.id };
}
const delivered = (db, so) => read(db, 'sale.order', so).order_line[0].qty_delivered;
const setQty = (db, id, qty) => write(db, 'stock.picking', id, { move_ids: read(db, 'stock.picking', id).move_ids.map((l) => ({ ...l, qty, quantity: qty })) });

test('a delivery cannot ship more than its order still has to deliver (FLOW-006)', () => {
  const { db, so, picking } = confirmedSale(10);
  assert.throws(() => press(setQty(db, picking, 15), 'stock.picking', picking, 'Validate'), /Delivering 15 .* more than .* still has to deliver \(10\)/);
  const done = press(db, 'stock.picking', picking, 'Validate').db;
  assert.equal(delivered(done, so), 10);
});

test('a delivery is returned at most once in total, and returns reduce the delivered quantity', () => {
  const { db, so, picking } = confirmedSale(10);
  let next = press(db, 'stock.picking', picking, 'Validate').db;
  // First return: 4 of the 10.
  const first = press(next, 'stock.picking', picking, 'Return');
  next = setQty(first.db, Number(first.go.split('/').at(-1)), 4);
  const firstId = Number(first.go.split('/').at(-1));
  assert.equal(read(next, 'stock.picking', firstId).sale_id, so);
  next = press(next, 'stock.picking', firstId, 'Validate').db;
  assert.equal(delivered(next, so), 6);
  // The next return offers only what is left, and cannot be raised above it.
  const second = press(next, 'stock.picking', picking, 'Return');
  const secondId = Number(second.go.split('/').at(-1));
  assert.equal(read(second.db, 'stock.picking', secondId).move_ids[0].qty, 6);
  assert.throws(() => press(setQty(second.db, secondId, 7), 'stock.picking', secondId, 'Validate'), /Returning 7 .* more than .* has left to return \(6\)/);
  next = press(second.db, 'stock.picking', secondId, 'Validate').db;
  assert.equal(delivered(next, so), 0);
  assert.throws(() => press(next, 'stock.picking', picking, 'Return'), /already been returned/);
});

const unitId = (db, name) => search(db, 'uom.uom').find((u) => u.name === name).id;
const returnOf = (db, picking, qty) => {
  const out = press(db, 'stock.picking', picking, 'Return');
  const id = Number(out.go.split('/').at(-1));
  return { id, db: qty == null ? out.db : setQty(out.db, id, qty) };
};

test('returning stock units takes back the matching amount of a line sold in dozens', () => {
  const base = create(seed(), 'product', { name: 'Dozen goods', type: 'goods', route: 'stock', qty_available: 100, list_price: 5, cost: 2, uom_id: unitId(seed(), 'Units') });
  const dz = unitId(base.db, 'Dozens');
  const so = create(base.db, 'sale.order', { partner_id: 2, order_line: [{ product_id: base.id, qty: 2, uom_id: dz, price_unit: 60, tax: 0 }] });
  const confirmed = press(so.db, 'sale.order', so.id, 'Confirm').db;
  const picking = search(confirmed, 'stock.picking').find((p) => p.sale_id === so.id).id;
  const done = press(confirmed, 'stock.picking', picking, 'Validate').db;
  assert.equal(delivered(done, so.id), 2);
  const ret = returnOf(done, picking, 12);
  assert.equal(delivered(press(ret.db, 'stock.picking', ret.id, 'Validate').db, so.id), 1);
});

test('the rest of a partly validated return is still a return, and a return cannot itself be returned', () => {
  const { db, so, picking } = confirmedSale(10);
  const done = press(db, 'stock.picking', picking, 'Validate').db;
  const ret = returnOf(done, picking, 10);
  const half = write(ret.db, 'stock.picking', ret.id, { move_ids: read(ret.db, 'stock.picking', ret.id).move_ids.map((l) => ({ ...l, quantity: 4 })) });
  const first = press(half, 'stock.picking', ret.id, 'Validate').db;
  assert.equal(delivered(first, so), 6);
  const backorder = search(first, 'stock.picking').find((p) => p.backorder_id === ret.id);
  assert.equal(backorder.return_of, picking);
  assert.equal(delivered(press(first, 'stock.picking', backorder.id, 'Validate').db, so), 0);
  assert.throws(() => press(first, 'stock.picking', ret.id, 'Return'), /cannot be returned/);
});

test('returns go back to the order line they were delivered from, and the next return offers the lot still out', () => {
  const so = create(seed(), 'sale.order', { partner_id: 2, order_line: [{ product_id: product, qty: 3, price_unit: 100, tax: 0 }, { product_id: product, qty: 5, price_unit: 90, tax: 0 }] });
  const confirmed = press(so.db, 'sale.order', so.id, 'Confirm').db;
  const picking = search(confirmed, 'stock.picking').find((p) => p.sale_id === so.id).id;
  const lots = write(confirmed, 'stock.picking', picking, { move_ids: read(confirmed, 'stock.picking', picking).move_ids.map((l, i) => ({ ...l, lot_name: i ? 'B' : 'A' })) });
  const done = press(lots, 'stock.picking', picking, 'Validate').db;
  assert.deepEqual(read(done, 'sale.order', so.id).order_line.map((l) => l.qty_delivered), [3, 5]);
  // Return lot A (3 units, the first line): the first line drops, the second stays.
  const ret = returnOf(done, picking);
  const onlyA = write(ret.db, 'stock.picking', ret.id, { move_ids: read(ret.db, 'stock.picking', ret.id).move_ids.map((l) => ({ ...l, quantity: l.lot_name === 'A' ? l.qty : 0 })) });
  globalThis.confirm = () => false; // no backorder: the return is complete with lot A alone
  let first;
  try { first = press(onlyA, 'stock.picking', ret.id, 'Validate').db; } finally { delete globalThis.confirm; }
  assert.deepEqual(read(first, 'sale.order', so.id).order_line.map((l) => l.qty_delivered), [0, 5]);
  // A further return offers exactly lot B (5), never lot A again.
  const second = returnOf(first, picking);
  const offered = read(second.db, 'stock.picking', second.id).move_ids;
  assert.deepEqual(offered.map((l) => [l.lot_name, l.qty]), [['B', 5]]);
});

test('a delivery whose stock demand was rounded up can still be validated', () => {
  const whole = (() => { const db = seed(); return write(db, 'uom.uom', unitId(db, 'Units'), { rounding: 1 }); })();
  const base = create(whole, 'product', { name: 'Rounded goods', type: 'goods', route: 'stock', qty_available: 100, list_price: 5, cost: 2, uom_id: unitId(whole, 'Units') });
  const so = create(base.db, 'sale.order', { partner_id: 2, order_line: [{ product_id: base.id, qty: 0.3, uom_id: unitId(base.db, 'Dozens'), price_unit: 60, tax: 0 }] });
  const confirmed = press(so.db, 'sale.order', so.id, 'Confirm').db;
  const picking = search(confirmed, 'stock.picking').find((p) => p.sale_id === so.id);
  assert.equal(picking.move_ids[0].qty, 4); // 3.6 units, rounded up to whole units
  const done = press(confirmed, 'stock.picking', picking.id, 'Validate').db;
  assert.equal(read(done, 'stock.picking', picking.id).state, 'done');
});
