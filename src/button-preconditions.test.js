import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from './orm.js';
import { models } from './models/index.js';
import { payMove } from './models/accounting.js';
import { confirmMo } from './models/more.js';
import { seed } from './seed.js';

const button = (model, label) => models[model].form.buttons.find((b) => b.label === label);
const press = (db, model, id, label) => button(model, label).run(db, read(db, model, id)).db;

test('confirming a sales order twice, even from a stale copy, creates one delivery', () => {
  const { db, id } = create(seed(), 'sale.order', { partner_id: 3, order_line: [{ product_id: 1, qty: 1, price_unit: 10 }] });
  const stale = read(db, 'sale.order', id);
  const confirmed = press(db, 'sale.order', id, 'Confirm');
  assert.throws(() => button('sale.order', 'Confirm').run(confirmed, stale), /not available/);
  assert.equal(search(confirmed, 'stock.picking').filter((p) => p.sale_id === id).length, 1);
});

test('a paid invoice cannot be cancelled and a draft invoice cannot be paid', () => {
  const { db, id } = create(seed(), 'account.move', { move_type: 'out_invoice', partner_id: 3, invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }] });
  assert.throws(() => payMove(db, id, 50), /Only posted/);
  assert.throws(() => press(db, 'account.move', id, 'Register Payment'), /not available/);
  const paid = payMove(press(db, 'account.move', id, 'Confirm'), id, 100);
  assert.throws(() => press(paid, 'account.move', id, 'Cancel'), /not available/);
  assert.throws(() => press(paid, 'account.move', id, 'Reset to Draft'), /not available/);
  assert.equal(read(paid, 'account.move', id).state, 'posted');
});

test('a manufacturing order is confirmed once', () => {
  const db0 = seed();
  const bom = search(db0, 'mrp.bom')[0];
  const { db, id } = create(db0, 'mrp.production', { product_id: bom.product_id, bom_id: bom.id, product_qty: 1 });
  const confirmed = press(db, 'mrp.production', id, 'Confirm');
  assert.throws(() => press(confirmed, 'mrp.production', id, 'Confirm'), /not available/);
  assert.throws(() => confirmMo(confirmed, read(confirmed, 'mrp.production', id)), /Only draft/);
});
