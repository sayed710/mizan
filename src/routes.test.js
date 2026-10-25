import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { models } from './models/index.js';
import { isBalanced } from './models/ledger.js';
import { seed } from './seed.js';

const run = (db, model, id, label) => models[model].form.buttons.find((b) => b.label === label).run(db, read(db, model, id)).db;

test('buy-on-order creates an RFQ for the missing quantity; make-on-order a manufacturing order', () => {
  const db0 = seed();
  const lamp = read(db0, 'product', 4);
  const desk = read(db0, 'product', 2);
  const { db, id } = create(db0, 'sale.order', { partner_id: 1, order_line: [
    { product_id: 4, qty: lamp.qty_available + 10, price_unit: 35, tax: 14 },
    { product_id: 2, qty: desk.qty_available + 3, price_unit: 540, tax: 14 },
  ] });
  const after = run(db, 'sale.order', id, 'Confirm');
  const so = read(after, 'sale.order', id);
  const rfq = search(after, 'purchase.order').find((p) => p.origin === so.name);
  assert.deepEqual(rfq.order_line.map((l) => [l.product_id, l.qty]), [[4, 10]]);
  assert.equal(rfq.partner_id, 2);
  const mo = search(after, 'mrp.production').find((m) => m.origin === so.name);
  assert.equal(mo.product_qty, 3);
  assert.ok(search(after, 'stock.picking').some((p) => p.sale_id === id)); // still delivered from stock
});

test('dropship lines skip our warehouse: vendor RFQ to the customer, no delivery, no receipt', () => {
  const db0 = write(seed(), 'product', 3, { route: 'dropship', vendor_id: 7 });
  const { db, id } = create(db0, 'sale.order', { partner_id: 6, order_line: [{ product_id: 3, qty: 2, price_unit: 1250, tax: 14 }] });
  const confirmed = run(db, 'sale.order', id, 'Confirm');
  assert.ok(!search(confirmed, 'stock.picking').some((p) => p.sale_id === id));
  const rfq = search(confirmed, 'purchase.order').find((p) => p.dropship_partner_id === 6);
  const po = run(confirmed, 'purchase.order', rfq.id, 'Confirm Order');
  assert.ok(!search(po, 'stock.picking').some((p) => p.purchase_id === rfq.id));
  assert.equal(read(po, 'purchase.order', rfq.id).receipt_done, true);
});

test('landed costs raise product cost by quantity share and post a balanced entry', () => {
  const db0 = seed();
  const { db: withReceipt, id: pick } = create(db0, 'stock.picking', { picking_type: 'incoming', state: 'ready', move_ids: [{ product_id: 7, qty: 10 }, { product_id: 8, qty: 30 }] });
  const received = run(withReceipt, 'stock.picking', pick, 'Validate');
  const costs = { top: read(received, 'product', 7).cost, frame: read(received, 'product', 8).cost };
  const { db, id } = create(received, 'stock.landed.cost', { name: 'Freight', picking_id: pick, cost_lines: [{ name: 'Freight', amount: 400 }] });
  const done = run(db, 'stock.landed.cost', id, 'Validate');
  const onHand = (pid) => read(received, 'product', pid).qty_available;
  assert.equal(read(done, 'product', 7).cost, Math.round((costs.top + 100 / onHand(7)) * 100) / 100);
  assert.equal(read(done, 'product', 8).cost, Math.round((costs.frame + 300 / onHand(8)) * 100) / 100);
  assert.ok(search(done, 'account.move').filter((m) => m.state === 'posted').every((m) => isBalanced(m.line_ids)));
});

test('a manufacturing order explodes its BoM into components and work orders, then produces a lot', () => {
  const db0 = seed();
  const bom = search(db0, 'mrp.bom')[0];
  const { db: withWc, id: wc } = create(db0, 'mrp.workcenter', { name: 'Assembly' });
  const withOps = write(withWc, 'mrp.bom', bom.id, { operations: [{ name: 'Assemble', workcenter_id: wc, duration: 30 }] });
  const tracked = write(withOps, 'product', bom.product_id, { tracking: 'lot' });
  const { db, id } = create(tracked, 'mrp.production', { product_id: bom.product_id, bom_id: bom.id, product_qty: 2 });
  const confirmed = run(db, 'mrp.production', id, 'Confirm');
  const mo = read(confirmed, 'mrp.production', id);
  assert.equal(mo.move_raw.length, bom.components.length);
  assert.equal(mo.move_raw[0].to_consume, bom.components[0].qty * 2 / (bom.product_qty || 1));
  assert.deepEqual(mo.workorders.map((w) => [w.name, w.duration_expected]), [['Assemble', 60 / (bom.product_qty || 1)]]);
  assert.throws(() => run(confirmed, 'mrp.production', id, 'Produce'), /lot\/serial/);
  const lotted = write(confirmed, 'mrp.production', id, { lot_name: 'LOT-77' });
  const before = read(lotted, 'product', bom.product_id).qty_available;
  const done = run(lotted, 'mrp.production', id, 'Produce');
  assert.equal(read(done, 'product', bom.product_id).qty_available, before + 2);
  assert.ok(search(done, 'stock.lot').some((l) => l.name === 'LOT-77' && l.qty === 2));
  assert.equal(read(done, 'mrp.production', id).workorders[0].state, 'done');
});
