import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from './orm.js';
import { models } from './models/index.js';
import { createOrderTransfers } from './models/warehouse.js';
import { moveValued } from './models/valuation.js';
import { confirmMo } from './models/more.js';
import { seed } from './seed.js';

const goods = (db, vals) => create(db, 'product', { type: 'goods', list_price: 10, cost: 5, ...vals });
const deliveries = (db, origin) => search(db, 'stock.picking').filter((p) => p.origin === origin);
const validate = (db, id) => models['stock.picking'].form.buttons.find((b) => b.label === 'Validate').run(db, read(db, 'stock.picking', id)).db;
const ship = (db, product_id, qty, origin) => createOrderTransfers(db, { type: 'outgoing', origin, lines: [{ product_id, qty }] });

test('a delivery is ready only when its stock is free; a waiting one cannot take reserved stock', () => {
  const p = goods(seed(), { name: 'Lamp', qty_available: 20 });
  let db = ship(ship(p.db, p.id, 15, 'D1'), p.id, 15, 'D2');
  const [d1] = deliveries(db, 'D1');
  const [d2] = deliveries(db, 'D2');
  assert.deepEqual([d1.state, d2.state], ['ready', 'waiting']);
  // The waiting delivery cannot ship the 15 reserved for the first one.
  assert.throws(() => validate(db, d2.id), /reserved for other operations/);
  db = validate(db, d1.id);
  assert.equal(read(db, 'product', p.id).qty_available, 5);
});

test('periodic products cannot be delivered below zero', () => {
  const p = goods(seed(), { name: 'Bolt', valuation: 'manual_periodic', qty_available: 0 });
  assert.throws(() => moveValued(p.db, [{ product_id: p.id, qty: 50 }], -1), /Not enough stock/);
  assert.equal(read(moveValued(p.db, [{ product_id: p.id, qty: 50 }], 1), 'product', p.id).qty_available, 50);
});

test('components reserved by one manufacturing order are not available to the next', () => {
  let db = seed();
  const frame = goods(db, { name: 'Frame', qty_available: 25 });
  const bike = goods(frame.db, { name: 'Bike', qty_available: 0 });
  const bom = create(bike.db, 'mrp.bom', { name: 'Bike BoM', product_id: bike.id, product_qty: 1, components: [{ product_id: frame.id, qty: 1 }] });
  db = bom.db;
  const mo = (qty) => { const r = create(db, 'mrp.production', { product_id: bike.id, bom_id: bom.id, product_qty: qty }); db = confirmMo(r.db, read(r.db, 'mrp.production', r.id)); return r.id; };
  const first = mo(20);
  const second = mo(25);
  assert.equal(read(db, 'mrp.production', first).components_availability, 'available');
  assert.equal(read(db, 'mrp.production', second).components_availability, 'waiting');
  // A delivery of the reserved frames waits too.
  db = ship(db, frame.id, 10, 'D3');
  assert.equal(deliveries(db, 'D3')[0].state, 'waiting');
});
