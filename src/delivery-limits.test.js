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
