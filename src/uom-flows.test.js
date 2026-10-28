import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { salesModels, createPicking } from './models/sales.js';
import { productLines } from './models/common.js';
import { payOrder, priceLines, refundOrder, startSession } from './models/pos.js';
import { confirmMo, explode, produce } from './models/more.js';

const unit = (db, name) => search(db, 'uom.uom').find((u) => u.name === name).id;
const run = (db, model, id, label) => salesModels[model].form.buttons.find((b) => b.label === label).run(db, read(db, model, id)).db;
const product = (db, vals = {}) => create(db, 'product', { name: 'UoM goods', type: 'goods', route: 'stock', qty_available: 100, list_price: 5, cost: 2, ...vals });
const picking = (db, field, id) => search(db, 'stock.picking').find((p) => p[field] === id);

test('selling two dozens delivers 24 stock units and invoices two dozens at twelve times the price', () => {
  const base = seed();
  const made = product(base, { uom_id: unit(base, 'Units'), invoice_policy: 'delivery' });
  const fields = productLines('Sales', 'list_price');
  const defaulted = fields.onchange({ product_id: made.id, qty: 2 }, 'product_id', made.db);
  assert.equal(defaulted.uom_id, unit(base, 'Units'));
  const line = fields.onchange({ ...defaulted, uom_id: unit(base, 'Dozens') }, 'uom_id', made.db);
  assert.equal(line.price_unit, 60);
  const order = create(made.db, 'sale.order', { partner_id: 1, order_line: [line] });
  const snapshot = structuredClone(order.db);
  const confirmed = run(order.db, 'sale.order', order.id, 'Confirm');
  const transfer = picking(confirmed, 'sale_id', order.id);
  assert.equal(transfer.move_ids[0].qty, 24);
  const done = run(confirmed, 'stock.picking', transfer.id, 'Validate');
  assert.equal(read(done, 'product', made.id).qty_available, 76);
  assert.equal(read(done, 'sale.order', order.id).order_line[0].qty_delivered, 2);
  const billed = run(done, 'sale.order', order.id, 'Create Invoice');
  const invoice = search(billed, 'account.move').find((m) => m.sale_id === order.id);
  assert.equal(invoice.invoice_line_ids[0].qty, 2);
  assert.equal(invoice.invoice_line_ids[0].uom_id, line.uom_id);
  assert.equal(invoice.invoice_line_ids[0].price_unit, 60);
  assert.equal(invoice.amount_untaxed, 120);
  assert.equal(read(billed, 'sale.order', order.id).order_line[0].qty_invoiced, 2);
  assert.deepEqual(order.db, snapshot);
});

test('buying kg for gram stock converts quantities and purchase prices before valuation', () => {
  const base = seed();
  const made = product(base, { qty_available: 0, uom_id: unit(base, 'g'), uom_po_id: unit(base, 'kg'), cost: 0.02, cost_method: 'average' });
  const line = productLines('Purchase', 'cost').onchange({ product_id: made.id, qty: 2 }, 'product_id', made.db);
  assert.equal(line.uom_id, unit(base, 'kg'));
  assert.equal(line.price_unit, 20);
  const order = create(made.db, 'purchase.order', { partner_id: 2, order_line: [{ ...line, price_unit: 30 }] });
  const confirmed = run(order.db, 'purchase.order', order.id, 'Confirm Order');
  const transfer = picking(confirmed, 'purchase_id', order.id);
  assert.equal(transfer.move_ids[0].qty, 2000);
  const done = run(confirmed, 'stock.picking', transfer.id, 'Validate');
  assert.equal(read(done, 'product', made.id).qty_available, 2000);
  assert.equal(read(done, 'product', made.id).cost, 0.03);
  assert.equal(read(done, 'purchase.order', order.id).order_line[0].qty_delivered, 2);
  const layer = search(done, 'stock.valuation.layer').find((l) => l.picking_id === transfer.id);
  assert.equal(layer.quantity, 2000);
  assert.equal(layer.value, 60);
  const billed = run(done, 'purchase.order', order.id, 'Create Bill');
  const bill = search(billed, 'account.move').find((m) => m.purchase_id === order.id);
  assert.equal(bill.invoice_line_ids[0].qty, 2);
  assert.equal(bill.invoice_line_ids[0].price_unit, 30);
});

test('product guard refuses purchase units in another category, including legacy stock-unit fallback', () => {
  const db = seed();
  const vals = { name: 'Invalid', uom_id: unit(db, 'Units'), uom_po_id: unit(db, 'kg') };
  assert.match(salesModels.product.guard(db, null, vals), /same category/);
  assert.throws(() => create(db, 'product', vals), /same category/);
  const made = product(db, { uom_id: unit(db, 'kg'), uom_po_id: unit(db, 'g') });
  assert.throws(() => write(made.db, 'product', made.id, { uom_id: unit(db, 'Units') }), /same category/);
  assert.throws(() => product(db, { uom: 'unit', uom_po_id: unit(db, 'kg') }), /same category/);
});

test('POS dozen sales and refunds move 24 units and reverse the original stock value', () => {
  const base = seed();
  // FIFO: the refund comes back at the original cost (standard-cost products come back at standard).
  const made = product(base, { uom_id: unit(base, 'Units'), cost_method: 'fifo' });
  const opened = startSession(made.db).db;
  const lines = priceLines(opened, [{ product_id: made.id, qty: 2, uom_id: unit(base, 'Dozens') }]);
  assert.equal(lines[0].price_unit, 60);
  const paid = payOrder(opened, { lines, method: 'cash' });
  assert.equal(read(paid.db, 'product', made.id).qty_available, 76);
  assert.equal(read(paid.db, 'pos.order', paid.id).stock_costs[0].unit_cost, 2);
  const changed = write(paid.db, 'product', made.id, { cost: 9 });
  const refunded = refundOrder(changed, read(changed, 'pos.order', paid.id));
  assert.equal(read(refunded.db, 'product', made.id).qty_available, 100);
  const layers = search(refunded.db, 'stock.valuation.layer').filter((l) => l.product_id === made.id && !l.opening);
  assert.deepEqual(layers.map((l) => [l.quantity, l.value]), [[-24, -48], [24, 48]]);
});

test('a gram BoM component consumes kilogram stock, scaling before stock-unit rounding', () => {
  const base = seed();
  const raw = product(base, { name: 'Raw kg', uom_id: unit(base, 'kg'), qty_available: 10, cost: 4 });
  const finished = product(raw.db, { qty_available: 0 });
  const bom = create(finished.db, 'mrp.bom', { name: 'Gram components', product_id: finished.id, product_qty: 1, components: [{ product_id: raw.id, qty: 250, uom_id: unit(base, 'g') }] });
  const mo = create(bom.db, 'mrp.production', { product_id: finished.id, bom_id: bom.id, product_qty: 2 });
  assert.equal(explode(mo.db, read(mo.db, 'mrp.production', mo.id)).move_raw[0].to_consume, 0.5);
  const confirmed = confirmMo(mo.db, read(mo.db, 'mrp.production', mo.id));
  const done = produce(confirmed, read(confirmed, 'mrp.production', mo.id)).db;
  assert.equal(read(done, 'product', raw.id).qty_available, 9.5);
  assert.equal(read(done, 'product', finished.id).qty_available, 2);
});

test('legacy products and lines keep quantity and price semantics without explicit units', () => {
  const made = product(seed(), { uom: 'box' });
  const line = productLines('Sales', 'list_price').onchange({ product_id: made.id, qty: 3 }, 'product_id', made.db);
  assert.equal(line.uom_id, undefined);
  assert.equal(line.price_unit, 5);
  const db = createPicking(made.db, { type: 'outgoing', lines: [line], origin: 'Legacy' });
  const transfer = search(db, 'stock.picking').at(-1);
  assert.equal(transfer.move_ids[0].qty, 3);
  assert.equal(read(run(db, 'stock.picking', transfer.id, 'Validate'), 'product', made.id).qty_available, 97);
  const explicit = createPicking(made.db, { type: 'outgoing', lines: [{ ...line, qty: 2, uom_id: unit(db, 'Dozens') }] });
  assert.equal(search(explicit, 'stock.picking').at(-1).move_ids[0].qty, 24);
});

test('partial receipts allocate mixed order units without rounding delivered dozens up', () => {
  const base = seed();
  const made = product(base, { qty_available: 0, uom_id: unit(base, 'Units'), cost_method: 'average' });
  const order = create(made.db, 'purchase.order', { partner_id: 2, order_line: [
    { product_id: made.id, qty: 1, uom_id: unit(base, 'Dozens'), price_unit: 24, tax: 0 },
    { product_id: made.id, qty: 6, uom_id: unit(base, 'Units'), price_unit: 3, tax: 0 },
  ] });
  const confirmed = run(order.db, 'purchase.order', order.id, 'Confirm Order');
  const transfer = picking(confirmed, 'purchase_id', order.id);
  const partial = write(confirmed, 'stock.picking', transfer.id, { move_ids: [{ product_id: made.id, qty: 18, quantity: 5 }] });
  const received = run(partial, 'stock.picking', transfer.id, 'Validate');
  assert.equal(read(received, 'purchase.order', order.id).order_line[0].qty_delivered, 5 / 12);
  const backorder = search(received, 'stock.picking').find((p) => p.backorder_id === transfer.id);
  const done = run(received, 'stock.picking', backorder.id, 'Validate');
  assert.deepEqual(read(done, 'purchase.order', order.id).order_line.map((l) => l.qty_delivered), [1, 6]);
  assert.equal(search(done, 'stock.valuation.layer').filter((l) => l.product_id === made.id).reduce((s, l) => s + l.value, 0), 42);
});
