import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from './orm.js';
import { models } from './models/index.js';
import { orderWeight, shippingPrice } from './models/logistics.js';
import { seed } from './seed.js';

const run = (db, model, id, label) => models[model].form.buttons.find((b) => b.label === label).run(db, read(db, model, id)).db;
const carrier = (db, name) => search(db, 'delivery.carrier').find((c) => c.name === name);

test('shipping: fixed price, free threshold, weight rules', () => {
  const db = seed();
  const order = { order_line: [{ product_id: 1, qty: 3 }], amount_untaxed: 630 };
  assert.equal(orderWeight(db, order.order_line), 42);
  assert.equal(shippingPrice(db, carrier(db, 'Standard Delivery'), order), 25);
  assert.equal(shippingPrice(db, carrier(db, 'Standard Delivery'), { ...order, amount_untaxed: 5000 }), 0);
  assert.equal(shippingPrice(db, carrier(db, 'Freight by weight'), order), 40);
  assert.equal(shippingPrice(db, carrier(db, 'Freight by weight'), { order_line: [{ product_id: 2, qty: 5 }] }), 120);
});

test('Add Shipping puts a single SHIP line on the quotation', () => {
  const db0 = seed();
  const { db, id } = create(db0, 'sale.order', { partner_id: 1, carrier_id: carrier(db0, 'Freight by weight').id, order_line: [{ product_id: 2, qty: 2, price_unit: 540, tax: 14 }] });
  const once = run(db, 'sale.order', id, 'Add Shipping');
  const twice = run(once, 'sale.order', id, 'Add Shipping');
  const ship = search(twice, 'product').find((p) => p.default_code === 'SHIP');
  assert.equal(read(twice, 'sale.order', id).order_line.filter((l) => l.product_id === ship.id).length, 1);
  assert.equal(read(twice, 'sale.order', id).order_line.find((l) => l.product_id === ship.id).price_unit, 120);
});

test('serial-tracked products need unique serials on receipts and existing serials on deliveries', () => {
  const db0 = seed();
  const sdc = search(db0, 'product').find((p) => p.default_code === 'ELEC-001');
  const receipt = (lot) => create(db0, 'stock.picking', { picking_type: 'incoming', state: 'ready', move_ids: [{ product_id: sdc.id, qty: 1, lot_name: lot }] });
  const noLot = receipt('');
  assert.throws(() => run(noLot.db, 'stock.picking', noLot.id, 'Validate'), /enter a lot\/serial/);
  const dup = receipt('SDC-0001');
  assert.throws(() => run(dup.db, 'stock.picking', dup.id, 'Validate'), /already in stock/);
  const ok = receipt('SDC-0002');
  const db1 = run(ok.db, 'stock.picking', ok.id, 'Validate');
  assert.equal(search(db1, 'stock.lot').find((l) => l.name === 'SDC-0002').qty, 1);
  assert.equal(read(db1, 'product', sdc.id).qty_available, 1);
  const out = create(db1, 'stock.picking', { picking_type: 'outgoing', state: 'ready', move_ids: [{ product_id: sdc.id, qty: 1, lot_name: 'SDC-9999' }] });
  assert.throws(() => run(out.db, 'stock.picking', out.id, 'Validate'), /not in stock/);
});
