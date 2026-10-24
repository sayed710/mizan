import { test } from 'node:test';
import assert from 'node:assert/strict';
import { models } from './models/index.js';
import { priceFor } from './models/pricelist.js';
import { seed } from './seed.js';

test('pricelist rules: product-specific beats global, highest min qty wins, otherwise base price', () => {
  const db = seed();
  const wholesale = db.records['product.pricelist'][0].id;
  assert.equal(priceFor(db, wholesale, 1, 5, 210), 210); // below every min qty
  assert.equal(priceFor(db, wholesale, 1, 10, 210), 189); // global 10% from 10 units
  assert.equal(priceFor(db, wholesale, 1, 60, 210), 180); // fixed price for chairs from 50
  assert.equal(priceFor(db, null, 1, 60, 210), 210);
});

test('order line onchange applies the order pricelist', () => {
  const db = seed();
  const onchange = models['sale.order'].fields.order_line.onchange;
  const line = onchange({ product_id: 2, qty: 12 }, 'product_id', db, { pricelist_id: db.records['product.pricelist'][0].id });
  assert.equal(line.price_unit, 486); // 540 − 10%
  assert.equal(onchange({ product_id: 2, qty: 12 }, 'product_id', db, {}).price_unit, 540);
});
