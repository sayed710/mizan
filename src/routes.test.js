import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { models } from './models/index.js';
import { isBalanced } from './models/ledger.js';
import { round } from './money.js';
import { seed } from './seed.js';

const run = (db, model, id, label) => models[model].form.buttons.find((b) => b.label === label).run(db, read(db, model, id)).db;

test('buy-on-order creates an RFQ for the ordered quantity; make-on-order a manufacturing order', () => {
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
  assert.deepEqual(rfq.order_line.map((l) => [l.product_id, l.qty]), [[4, lamp.qty_available + 10]]);
  assert.equal(rfq.partner_id, 2);
  const mo = search(after, 'mrp.production').find((m) => m.origin === so.name);
  assert.equal(mo.product_qty, desk.qty_available + 3);
  assert.equal(mo.sale_id, id);
  assert.ok(search(after, 'stock.picking').some((p) => p.sale_id === id)); // still delivered from stock
});

test('dropship lines skip our warehouse and create a direct vendor to customer operation', () => {
  const db0 = write(seed(), 'product', 3, { route: 'dropship', vendor_id: 7 });
  const { db, id } = create(db0, 'sale.order', { partner_id: 6, order_line: [{ product_id: 3, qty: 2, price_unit: 1250, tax: 14 }] });
  const confirmed = run(db, 'sale.order', id, 'Confirm');
  assert.ok(!search(confirmed, 'stock.picking').some((p) => p.sale_id === id));
  const rfq = search(confirmed, 'purchase.order').find((p) => p.dropship_partner_id === 6);
  const po = run(confirmed, 'purchase.order', rfq.id, 'Confirm Order');
  const shipment = search(po, 'stock.picking').find((p) => p.purchase_id === rfq.id);
  assert.equal(shipment.picking_type, 'dropship');
  assert.equal(read(po, 'stock.location', shipment.location_id).name, 'Vendors');
  assert.equal(read(po, 'stock.location', shipment.location_dest_id).name, 'Customers');
  assert.equal(shipment.sale_id, id);
  assert.equal(read(po, 'purchase.order', rfq.id).receipt_done, false);
});

test('landed costs raise average product cost by quantity share and post a balanced entry', () => {
  const db0 = write(write(seed(), 'product', 7, { cost_method: 'average' }), 'product', 8, { cost_method: 'average' });
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

test('landed cost and recognized bill shares use nonnegative largest remainders', () => {
  for (const [amount, count, expected] of [[0.02, 4, [0.01, 0.01, 0, 0]], [0.10, 3, [0.04, 0.03, 0.03]]]) {
    let { db, id: product } = create(seed(), 'product', { name: 'Periodic rounding', type: 'goods', valuation: 'manual_periodic', cost: 10, qty_available: 0 });
    const original = search(db, 'account.account').find((a) => a.code === '500000');
    const selected = search(db, 'account.account').find((a) => a.code === '600000');
    const receipts = [];
    for (let i = 0; i < count; i++) {
      let id;
      ({ db, id } = create(db, 'stock.picking', { picking_type: 'incoming', state: 'ready', move_ids: [{ product_id: product, qty: 1 }] }));
      db = run(db, 'stock.picking', id, 'Validate');
      receipts.push(id);
    }
    let service, bill;
    ({ db, id: service } = create(db, 'product', { name: 'Rounding freight', type: 'service', landed_cost_ok: true, property_account_expense_id: original.id }));
    ({ db, id: bill } = create(db, 'account.move', { move_type: 'in_invoice', partner_id: 2, invoice_line_ids: [{ product_id: service, account_id: original.id, qty: 1, price_unit: amount, tax: 0 }] }));
    db = run(db, 'account.move', bill, 'Confirm');
    db = run(db, 'account.move', bill, 'Create Landed Costs');
    const landed = search(db, 'stock.landed.cost').find((lc) => lc.bill_id === bill);
    // A separate manual cost exposes cost allocation; reclassification exposes recognized allocation.
    db = write(db, 'stock.landed.cost', landed.id, { picking_ids: receipts, cost_lines: [{ ...landed.cost_lines[0], account_id: selected.id }, { name: 'Manual', amount, account_id: original.id, split_method: 'equal' }] });
    db = run(db, 'stock.landed.cost', landed.id, 'Validate');
    const shares = receipts.map((id) => {
      const entry = search(db, 'account.move').find((m) => m.ref === `Landed costs ${read(db, 'stock.picking', id).name}`);
      const lines = entry?.line_ids ?? [];
      return [lines.filter((l) => l.account_id === selected.id).reduce((sum, l) => sum + (l.debit || 0) - (l.credit || 0), 0), lines.filter((l) => l.account_id === original.id).reduce((sum, l) => sum + (l.debit || 0), 0)];
    });
    assert.deepEqual(shares.map(([recognized]) => recognized), expected);
    assert.deepEqual(shares.map(([, manual]) => manual), expected);
  }
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

test('replenishment drafts one RFQ per vendor up to the maximum, counting what is already on order', async () => {
  const { replenish } = await import('./models/routes.js');
  let db0 = write(seed(), 'product', 1, { qty_available: 5, vendor_id: 2 });
  const wh = search(db0, 'stock.warehouse').find((w) => w.code === 'WH') ?? search(db0, 'stock.warehouse')[0];
  const q1 = search(db0, 'stock.quant').find((q) => q.product_id === 1);
  if (q1) db0 = write(db0, 'stock.quant', q1.id, { quantity: 5 });
  const locId = q1?.location_id ?? wh.lot_stock_id;
  db0 = create(db0, 'stock.warehouse.orderpoint', {
    product_id: 1, warehouse_id: wh.id, location_id: locId,
    product_min_qty: 20, product_max_qty: 50, trigger: 'auto', route_id: 'buy',
  }).db;
  const once = replenish(db0);
  const rfq = search(once, 'purchase.order').find((p) => p.origin === 'Replenishment');
  assert.deepEqual(rfq.order_line.map((l) => [l.product_id, l.qty]), [[1, 45]]);
  assert.equal(search(replenish(once), 'purchase.order').filter((p) => p.origin === 'Replenishment').length, 1);
});

test('dropship validation supports partial delivery, invoicing and returns without changing stock', () => {
  let db = write(seed(), 'product', 3, { route: 'dropship', vendor_id: 7, invoice_policy: 'delivery' });
  const before = read(db, 'product', 3).qty_available;
  let sale;
  ({ db, id: sale } = create(db, 'sale.order', { partner_id: 6, order_line: [{ product_id: 3, qty: 2, price_unit: 1250, tax: 0 }] }));
  db = run(db, 'sale.order', sale, 'Confirm');
  const po = search(db, 'purchase.order').find((p) => p.origin === read(db, 'sale.order', sale).name);
  db = run(db, 'purchase.order', po.id, 'Confirm Order');
  const picking = search(db, 'stock.picking').find((p) => p.purchase_id === po.id);
  assert.ok(picking);
  assert.equal(read(db, 'purchase.order', po.id).receipt_done, false);
  assert.throws(() => run(db, 'sale.order', sale, 'Create Invoice'), /Nothing left/);
  db = write(db, 'stock.picking', picking.id, { move_ids: [{ ...picking.move_ids[0], quantity: 1 }] });
  db = run(db, 'stock.picking', picking.id, 'Validate');
  assert.equal(read(db, 'sale.order', sale).order_line[0].qty_delivered, 1);
  assert.equal(read(db, 'purchase.order', po.id).order_line[0].qty_delivered, 1);
  assert.equal(read(db, 'product', 3).qty_available, before);
  db = run(db, 'sale.order', sale, 'Create Invoice');
  assert.equal(search(db, 'account.move').find((m) => m.sale_id === sale).invoice_line_ids[0].qty, 1);
  db = run(db, 'stock.picking', picking.id, 'Return');
  const ret = search(db, 'stock.picking').find((p) => p.return_of === picking.id);
  db = run(db, 'stock.picking', ret.id, 'Validate');
  assert.equal(read(db, 'sale.order', sale).order_line[0].qty_delivered, 0);
  assert.equal(read(db, 'purchase.order', po.id).order_line[0].qty_delivered, 0);
  assert.equal(read(db, 'product', 3).qty_available, before);
});

test('landed cost follows receipt remaining layers after consumption and later receipts', () => {
  let { db, id: productId } = create(seed(), 'product', { name: 'Freight FIFO', type: 'goods', cost: 10, cost_method: 'fifo', valuation: 'real_time', qty_available: 0 });
  let receipt;
  ({ db, id: receipt } = create(db, 'stock.picking', { picking_type: 'incoming', state: 'ready', move_ids: [{ product_id: productId, qty: 10 }] }));
  db = run(db, 'stock.picking', receipt, 'Validate');
  let delivery;
  ({ db, id: delivery } = create(db, 'stock.picking', { picking_type: 'outgoing', state: 'ready', move_ids: [{ product_id: productId, qty: 8 }] }));
  db = run(db, 'stock.picking', delivery, 'Validate');
  let later;
  ({ db, id: later } = create(db, 'stock.picking', { picking_type: 'incoming', state: 'ready', move_ids: [{ product_id: productId, qty: 5 }] }));
  db = run(db, 'stock.picking', later, 'Validate');
  const before = search(db, 'stock.valuation.layer').find((l) => l.picking_id === later).remaining_value;
  let landed;
  ({ db, id: landed } = create(db, 'stock.landed.cost', { name: 'Freight', picking_id: receipt, cost_lines: [{ name: 'Freight', amount: 100 }] }));
  db = run(db, 'stock.landed.cost', landed, 'Validate');
  assert.equal(search(db, 'stock.valuation.layer').find((l) => l.picking_id === receipt).remaining_value, 40);
  assert.equal(search(db, 'stock.valuation.layer').find((l) => l.picking_id === later).remaining_value, before);
  const entry = search(db, 'account.move').find((m) => m.ref === `Landed costs ${read(db, 'stock.picking', receipt).name}`);
  assert.equal(entry.line_ids.find((l) => read(db, 'account.account', l.account_id)?.code === '500000').debit, 80);
});

test('delivery cannot reserve or consume stock from an empty source location', () => {
  let db = seed();
  let productId, a, b, incoming, outgoing;
  ({ db, id: productId } = create(db, 'product', { name: 'Located', type: 'goods', qty_available: 0, cost: 10, valuation: 'manual_periodic' }));
  ({ db, id: a } = create(db, 'stock.location', { name: 'A', usage: 'internal' }));
  ({ db, id: b } = create(db, 'stock.location', { name: 'B', usage: 'internal' }));
  ({ db, id: incoming } = create(db, 'stock.picking', { picking_type: 'incoming', state: 'ready', location_dest_id: a, move_ids: [{ product_id: productId, qty: 10 }] }));
  db = run(db, 'stock.picking', incoming, 'Validate');
  ({ db, id: outgoing } = create(db, 'stock.picking', { picking_type: 'outgoing', state: 'draft', location_id: b, move_ids: [{ product_id: productId, qty: 5 }] }));
  db = run(db, 'stock.picking', outgoing, 'Mark as Todo');
  assert.equal(read(db, 'stock.picking', outgoing).state, 'waiting');
  assert.throws(() => run(db, 'stock.picking', outgoing, 'Validate'), /stock/i);
});

test('make to order procures full demand and links replenishment to its sale', () => {
  let db = write(seed(), 'product', 4, { route: 'mto_buy', vendor_id: 2 });
  let sale;
  ({ db, id: sale } = create(db, 'sale.order', { partner_id: 1, order_line: [{ product_id: 4, qty: 5, price_unit: 35, tax: 0 }] }));
  db = run(db, 'sale.order', sale, 'Confirm');
  const rfq = search(db, 'purchase.order').find((p) => p.sale_id === sale);
  assert.ok(rfq);
  assert.equal(rfq.order_line[0].qty, 5);
  assert.equal(rfq.order_line[0].so_line, 0);
  const pick = search(db, 'stock.picking').find((p) => p.sale_id === sale);
  assert.equal(pick.state, 'waiting');
  assert.throws(() => run(db, 'stock.picking', pick.id, 'Validate'), /procure|replenish/i);
  db = run(db, 'purchase.order', rfq.id, 'Confirm Order');
  const receipt = search(db, 'stock.picking').find((p) => p.purchase_id === rfq.id);
  db = run(db, 'stock.picking', receipt.id, 'Validate');
  assert.equal(read(db, 'stock.picking', pick.id).state, 'ready');
  db = run(db, 'stock.picking', pick.id, 'Validate');
  assert.equal(read(db, 'sale.order', sale).order_line[0].qty_delivered, 5);
});

test('landed costs allocate by weight across selected receipts through the model action', () => {
  let { db, id: a } = create(seed(), 'product', { name: 'Weight A', type: 'goods', weight: 1, cost: 10, cost_method: 'fifo', qty_available: 0 });
  let b, r1, r2, landed;
  ({ db, id: b } = create(db, 'product', { name: 'Weight B', type: 'goods', weight: 3, cost: 10, cost_method: 'fifo', qty_available: 0 }));
  ({ db, id: r1 } = create(db, 'stock.picking', { picking_type: 'incoming', state: 'ready', move_ids: [{ product_id: a, qty: 2 }] }));
  db = run(db, 'stock.picking', r1, 'Validate');
  ({ db, id: r2 } = create(db, 'stock.picking', { picking_type: 'incoming', state: 'ready', move_ids: [{ product_id: b, qty: 2 }] }));
  db = run(db, 'stock.picking', r2, 'Validate');
  ({ db, id: landed } = create(db, 'stock.landed.cost', { name: 'Weight freight', picking_ids: [r1, r2], cost_lines: [{ name: 'Freight', amount: 40, split_method: 'weight' }] }));
  db = run(db, 'stock.landed.cost', landed, 'Validate');
  assert.equal(search(db, 'stock.valuation.layer').find((l) => l.picking_id === r1 && l.kind === 'in').remaining_value, 30);
  assert.equal(search(db, 'stock.valuation.layer').find((l) => l.picking_id === r2 && l.kind === 'in').remaining_value, 50);
});

test('a posted vendor bill can create landed costs from flagged service lines', () => {
  let { db, id: service } = create(seed(), 'product', { name: 'Freight service', type: 'service', landed_cost_ok: true });
  let bill;
  ({ db, id: bill } = create(db, 'account.move', { move_type: 'in_invoice', partner_id: 2, invoice_line_ids: [{ product_id: service, qty: 1, price_unit: 25, tax: 0 }] }));
  db = run(db, 'account.move', bill, 'Confirm');
  db = run(db, 'account.move', bill, 'Create Landed Costs');
  const lc = search(db, 'stock.landed.cost').find((r) => r.bill_id === bill);
  assert.equal(lc.state, 'draft');
  assert.equal(lc.cost_lines[0].amount, 25);
  assert.throws(() => run(db, 'account.move', bill, 'Create Landed Costs'), /already/i);
});



test('mixed-sign splits cannot make an individual receipt product layer negative', () => {
  let { db, id: a } = create(seed(), 'product', { name: 'Split A', type: 'goods', cost: 10, cost_method: 'fifo', valuation: 'real_time', qty_available: 0, weight: 0 });
  let b, service, receipt, bill;
  ({ db, id: b } = create(db, 'product', { name: 'Split B', type: 'goods', cost: 10, cost_method: 'fifo', valuation: 'real_time', qty_available: 0, weight: 1 }));
  ({ db, id: service } = create(db, 'product', { name: 'Split freight', type: 'service', landed_cost_ok: true }));
  ({ db, id: receipt } = create(db, 'stock.picking', { picking_type: 'incoming', state: 'ready', move_ids: [{ product_id: a, qty: 1 }, { product_id: b, qty: 1 }] }));
  db = run(db, 'stock.picking', receipt, 'Validate');
  ({ db, id: bill } = create(db, 'account.move', { move_type: 'in_invoice', partner_id: 2, invoice_line_ids: [100, -80].map((price_unit) => ({ product_id: service, qty: 1, price_unit, tax: 0 })) }));
  db = run(db, 'account.move', bill, 'Confirm');
  db = run(db, 'account.move', bill, 'Create Landed Costs');
  const landed = search(db, 'stock.landed.cost').find((lc) => lc.bill_id === bill);
  db = write(db, 'stock.landed.cost', landed.id, { picking_id: receipt, cost_lines: [{ ...landed.cost_lines[0], split_method: 'equal' }, { ...landed.cost_lines[1], split_method: 'weight' }] });
  assert.throws(() => run(db, 'stock.landed.cost', landed.id, 'Validate'), /valuation layer negative/i);
  assert.equal(read(db, 'stock.landed.cost', landed.id).state, 'draft');
  assert.equal(search(db, 'stock.valuation.layer').find((l) => l.picking_id === receipt && l.product_id === b && l.kind === 'in').remaining_value, 10);
});

test('periodic freight bill retains its expense and clears interim after landed cost validation', () => {
  let db = seed();
  const freightAccount = search(db, 'account.account').find((a) => a.code === '610000');
  const interim = search(db, 'account.account').find((a) => a.code === '110200');
  let product, service, receipt, bill;
  ({ db, id: product } = create(db, 'product', { name: 'Periodic goods', type: 'goods', valuation: 'manual_periodic', cost: 20, qty_available: 0 }));
  ({ db, id: service } = create(db, 'product', { name: 'Freight', type: 'service', landed_cost_ok: true, property_account_expense_id: freightAccount.id }));
  ({ db, id: receipt } = create(db, 'stock.picking', { picking_type: 'incoming', state: 'ready', move_ids: [{ product_id: product, qty: 10 }] }));
  db = run(db, 'stock.picking', receipt, 'Validate');
  const before = db;
  ({ db, id: bill } = create(db, 'account.move', { move_type: 'in_invoice', partner_id: 2, invoice_line_ids: [{ product_id: service, account_id: freightAccount.id, qty: 1, price_unit: 50, tax: 0 }] }));
  db = run(db, 'account.move', bill, 'Confirm');
  db = run(db, 'account.move', bill, 'Create Landed Costs');
  const landed = search(db, 'stock.landed.cost').find((lc) => lc.bill_id === bill);
  assert.equal(landed.cost_lines[0].account_id, freightAccount.id);
  db = write(db, 'stock.landed.cost', landed.id, { picking_id: receipt });
  db = run(db, 'stock.landed.cost', landed.id, 'Validate');
  assert.equal(read(db, 'stock.landed.cost', landed.id).state, 'done');
  const balance = (state, account) => search(state, 'account.move').filter((m) => m.state === 'posted').flatMap((m) => m.line_ids ?? []).filter((l) => l.account_id === account).reduce((sum, l) => sum + (l.debit || 0) - (l.credit || 0), 0);
  assert.equal(balance(db, freightAccount.id) - balance(before, freightAccount.id), 50);
  assert.equal(balance(db, interim.id) - balance(before, interim.id), 0);
});

test('bill-linked periodic costs post edited differences and added lines', () => {
  let { db, id: product } = create(seed(), 'product', { name: 'Periodic goods provenance', type: 'goods', valuation: 'manual_periodic', cost: 20, qty_available: 0 });
  const expense = search(db, 'account.account').find((a) => a.code === '610000');
  let service, receipt, bill;
  ({ db, id: service } = create(db, 'product', { name: 'Bill freight', type: 'service', landed_cost_ok: true, property_account_expense_id: expense.id }));
  ({ db, id: receipt } = create(db, 'stock.picking', { picking_type: 'incoming', state: 'ready', move_ids: [{ product_id: product, qty: 10 }] }));
  db = run(db, 'stock.picking', receipt, 'Validate');
  ({ db, id: bill } = create(db, 'account.move', { move_type: 'in_invoice', partner_id: 2, invoice_line_ids: [{ product_id: service, account_id: expense.id, qty: 1, price_unit: 50, tax: 0 }] }));
  db = run(db, 'account.move', bill, 'Confirm');
  db = run(db, 'account.move', bill, 'Create Landed Costs');
  const landed = search(db, 'stock.landed.cost').find((lc) => lc.bill_id === bill);
  assert.equal(landed.cost_lines[0].source_bill_line, 0);
  assert.equal(landed.cost_lines[0].source_bill_amount, 50);
  const validate = (amount, extra = []) => {
    const draft = write(db, 'stock.landed.cost', landed.id, { picking_id: receipt, cost_lines: [{ ...landed.cost_lines[0], amount }, ...extra] });
    const done = run(draft, 'stock.landed.cost', landed.id, 'Validate');
    const entry = search(done, 'account.move').find((m) => m.ref === `Landed costs ${read(done, 'stock.picking', receipt).name}`);
    assert.equal(entry.line_ids.reduce((s, l) => s + (l.debit || 0) - (l.credit || 0), 0), 0);
    return entry.line_ids.filter((l) => l.account_id === expense.id).reduce((s, l) => s + (l.debit || 0) - (l.credit || 0), 0);
  };
  assert.equal(validate(100, [{ name: 'Added freight', amount: 30, account_id: expense.id }]), 80);
  assert.equal(validate(20), -30);
  assert.throws(() => validate(50, [{ ...landed.cost_lines[0] }]), /duplicate/i);
});

test('perpetual bill costs post edited and added amounts and reclassify the original account', () => {
  let { db, id: product } = create(seed(), 'product', { name: 'Perpetual freight goods', type: 'goods', valuation: 'real_time', cost_method: 'fifo', cost: 20, qty_available: 0 });
  const original = search(db, 'account.account').find((a) => a.code === '610000');
  const selected = search(db, 'account.account').find((a) => a.code === '600000');
  let service, receipt, bill;
  ({ db, id: service } = create(db, 'product', { name: 'Perpetual freight', type: 'service', landed_cost_ok: true }));
  ({ db, id: receipt } = create(db, 'stock.picking', { picking_type: 'incoming', state: 'ready', move_ids: [{ product_id: product, qty: 1 }] }));
  db = run(db, 'stock.picking', receipt, 'Validate');
  const before = db;
  ({ db, id: bill } = create(db, 'account.move', { move_type: 'in_invoice', partner_id: 2, invoice_line_ids: [{ product_id: service, account_id: original.id, qty: 1, price_unit: 50, tax: 0 }] }));
  db = run(db, 'account.move', bill, 'Confirm');
  db = run(db, 'account.move', bill, 'Create Landed Costs');
  const landed = search(db, 'stock.landed.cost').find((lc) => lc.bill_id === bill);
  const balance = (state, code) => search(state, 'account.move').filter((m) => m.state === 'posted').flatMap((m) => m.line_ids ?? []).filter((l) => read(state, 'account.account', l.account_id)?.code === code).reduce((s, l) => s + l.debit - l.credit, 0);
  for (const [amount, account, extra, total] of [[100, original.id, [], 100], [50, original.id, [{ name: 'Additional', amount: 30, account_id: original.id }], 80], [50, selected.id, [], 50]]) {
    const draft = write(db, 'stock.landed.cost', landed.id, { picking_id: receipt, cost_lines: [{ ...landed.cost_lines[0], amount, account_id: account }, ...extra] });
    const done = run(draft, 'stock.landed.cost', landed.id, 'Validate');
    assert.equal(balance(done, '110100') - balance(before, '110100'), total);
    assert.equal(balance(done, '211000') - balance(before, '211000'), -total);
    assert.equal(balance(done, '610000') - balance(before, '610000'), 0);
    assert.equal(balance(done, '600000') - balance(before, '600000'), 0);
    assert.equal(search(done, 'stock.valuation.layer').find((l) => l.picking_id === receipt && l.kind === 'in').remaining_value, 20 + total);
  }
});

test('periodic bill-derived costs reclassify the posted expense when account and amount change', () => {
  let { db, id: product } = create(seed(), 'product', { name: 'Periodic reclassification goods', type: 'goods', valuation: 'manual_periodic', cost: 20 });
  const original = search(db, 'account.account').find((a) => a.code === '610000');
  const selected = search(db, 'account.account').find((a) => a.code === '600000');
  let service, receipt, bill;
  ({ db, id: service } = create(db, 'product', { name: 'Reclassified freight', type: 'service', landed_cost_ok: true, property_account_expense_id: original.id }));
  ({ db, id: receipt } = create(db, 'stock.picking', { picking_type: 'incoming', state: 'ready', move_ids: [{ product_id: product, qty: 1 }] }));
  db = run(db, 'stock.picking', receipt, 'Validate');
  const before = db;
  ({ db, id: bill } = create(db, 'account.move', { move_type: 'in_invoice', partner_id: 2, invoice_line_ids: [{ product_id: service, account_id: original.id, qty: 1, price_unit: 50, tax: 0 }] }));
  db = run(db, 'account.move', bill, 'Confirm');
  db = run(db, 'account.move', bill, 'Create Landed Costs');
  const landed = search(db, 'stock.landed.cost').find((lc) => lc.bill_id === bill);
  const balance = (state, id) => search(state, 'account.move').filter((m) => m.state === 'posted').flatMap((m) => m.line_ids ?? []).filter((l) => l.account_id === id).reduce((s, l) => s + (l.debit || 0) - (l.credit || 0), 0);
  for (const amount of [50, 80, 20, 0]) {
    // Keep total positive for the zero-amount case with a separate manual line.
    const extra = amount === 0 ? [{ name: 'Other', amount: 1, account_id: selected.id }] : [];
    const draft = write(db, 'stock.landed.cost', landed.id, { picking_id: receipt, cost_lines: [{ ...landed.cost_lines[0], account_id: selected.id, amount }, ...extra] });
    const done = run(draft, 'stock.landed.cost', landed.id, 'Validate');
    assert.equal(balance(done, original.id) - balance(before, original.id), 0, `original expense, amount ${amount}`);
    assert.equal(balance(done, selected.id) - balance(before, selected.id), amount + (amount === 0 ? 1 : 0), `selected expense, amount ${amount}`);
  }
});

test('bill-linked landed costs require an account and reclassify to non-expense accounts', () => {
  let { db, id: product } = create(seed(), 'product', { name: 'Periodic account selection', type: 'goods', valuation: 'manual_periodic', cost: 20 });
  const original = search(db, 'account.account').find((a) => a.code === '610000');
  const selected = search(db, 'account.account').find((a) => a.code === '110100');
  const payable = search(db, 'account.account').find((a) => a.code === '211000');
  let service, receipt, bill;
  ({ db, id: service } = create(db, 'product', { name: 'Account selection freight', type: 'service', landed_cost_ok: true }));
  ({ db, id: receipt } = create(db, 'stock.picking', { picking_type: 'incoming', state: 'ready', move_ids: [{ product_id: product, qty: 1 }] }));
  db = run(db, 'stock.picking', receipt, 'Validate');
  const before = db;
  ({ db, id: bill } = create(db, 'account.move', { move_type: 'in_invoice', partner_id: 2, invoice_line_ids: [{ product_id: service, account_id: original.id, qty: 1, price_unit: 50, tax: 0 }] }));
  db = run(db, 'account.move', bill, 'Confirm');
  db = run(db, 'account.move', bill, 'Create Landed Costs');
  const landed = search(db, 'stock.landed.cost').find((lc) => lc.bill_id === bill);
  const draft = (account, amount = 50) => write(db, 'stock.landed.cost', landed.id, { picking_id: receipt, cost_lines: [{ ...landed.cost_lines[0], account_id: account, amount }] });
  assert.throws(() => run(draft(null), 'stock.landed.cost', landed.id, 'Validate'), /account/i);
  const balance = (state, id) => search(state, 'account.move').filter((m) => m.state === 'posted').flatMap((m) => m.line_ids ?? []).filter((l) => l.account_id === id).reduce((s, l) => s + (l.debit || 0) - (l.credit || 0), 0);
  for (const [account, amount] of [[original.id, 50], [selected.id, 50], [selected.id, 80], [selected.id, 20]]) {
    const done = run(draft(account, amount), 'stock.landed.cost', landed.id, 'Validate');
    assert.equal(balance(done, original.id) - balance(before, original.id), account === original.id ? amount : 0);
    assert.equal(balance(done, selected.id) - balance(before, selected.id), account === selected.id ? amount : 0);
    assert.equal(balance(done, payable.id) - balance(before, payable.id), -amount);
    const entry = search(done, 'account.move').find((m) => m.ref === `Landed costs ${read(done, 'stock.picking', receipt).name}`);
    if (account === original.id) assert.equal(entry, undefined);
    else {
      assert.ok(entry.line_ids.some((l) => l.account_id === original.id && l.credit === 50));
      assert.ok(entry.line_ids.some((l) => l.account_id === selected.id && l.debit === 50));
      assert.equal(entry.line_ids.reduce((s, l) => s + (l.debit || 0) - (l.credit || 0), 0), 0);
    }
  }
});

test('small foreign bill sources remain nonnegative through landed cost validation', () => {
  let { db, id: product } = create(seed(), 'product', { name: 'Periodic receipt', type: 'goods', valuation: 'manual_periodic', cost: 20 });
  let service, receipt, currency, bill;
  ({ db, id: service } = create(db, 'product', { name: 'Tiny freight', type: 'service', landed_cost_ok: true }));
  ({ db, id: receipt } = create(db, 'stock.picking', { picking_type: 'incoming', state: 'ready', move_ids: [{ product_id: product, qty: 1 }] }));
  db = run(db, 'stock.picking', receipt, 'Validate');
  ({ db, id: currency } = create(db, 'res.currency', { name: 'TINYFX', rate_ids: [{ date: '2020-01-01', rate: 2 }] }));
  ({ db, id: bill } = create(db, 'account.move', { move_type: 'in_invoice', partner_id: 2, currency_id: currency, invoice_date: '2026-01-01', invoice_line_ids: Array.from({ length: 4 }, () => ({ product_id: service, qty: 1, price_unit: 0.01, tax: 0 })) }));
  db = run(db, 'account.move', bill, 'Confirm');
  assert.deepEqual(read(db, 'account.move', bill).line_ids.find((l) => l.invoice_sources).invoice_sources.map((s) => s.amount), [0.01, 0.01, 0, 0]);
  db = run(db, 'account.move', bill, 'Create Landed Costs');
  const landed = search(db, 'stock.landed.cost').find((lc) => lc.bill_id === bill);
  assert.deepEqual(landed.cost_lines.map((l) => l.amount), [0.01, 0.01, 0, 0]);
  db = write(db, 'stock.landed.cost', landed.id, { picking_id: receipt });
  db = run(db, 'stock.landed.cost', landed.id, 'Validate');
  assert.equal(read(db, 'stock.landed.cost', landed.id).state, 'done');
});

test('negative foreign refund group allocates signed source cents exactly', () => {
  let { db, id: currency } = create(seed(), 'res.currency', { name: 'NEGFX', rate_ids: [{ date: '2020-01-01', rate: 2 }] });
  let bill;
  ({ db, id: bill } = create(db, 'account.move', { move_type: 'in_refund', partner_id: 2, currency_id: currency, invoice_date: '2026-01-01', invoice_line_ids: [...Array.from({ length: 4 }, () => ({ qty: 1, price_unit: -0.01, tax: 0 })), { qty: 1, price_unit: 1, tax: 0, account_id: search(db, 'account.account').find((a) => a.code === '610000').id }] }));
  db = run(db, 'account.move', bill, 'Confirm');
  const sources = read(db, 'account.move', bill).line_ids.find((l) => l.invoice_sources).invoice_sources;
  assert.deepEqual(sources.map((s) => s.amount), [-0.01, -0.01, 0, 0]);
});

test('mixed-sign same-account bill lines record signed source shares for landed costs', () => {
  let { db, id: service } = create(seed(), 'product', { name: 'Freight adjustment', type: 'service', landed_cost_ok: true });
  let bill;
  ({ db, id: bill } = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 2,
    invoice_date: '2026-01-01',
    invoice_line_ids: [
      { product_id: service, qty: 1, price_unit: 100, tax: 0 },
      { product_id: service, qty: 1, price_unit: -50, tax: 0 },
    ],
  }));
  db = run(db, 'account.move', bill, 'Confirm');
  const postedSources = read(db, 'account.move', bill).line_ids.find((l) => l.invoice_sources).invoice_sources;
  assert.deepEqual(postedSources.map((s) => s.amount), [100, -50]);
  db = run(db, 'account.move', bill, 'Create Landed Costs');
  const landed = search(db, 'stock.landed.cost').find((lc) => lc.bill_id === bill);
  assert.deepEqual(landed.cost_lines.map((l) => l.amount), [100, -50]);
});

test('mixed-sign bill costs validate and capitalize only their net after consumption', () => {
  let { db, id: product } = create(seed(), 'product', { name: 'Signed FIFO', type: 'goods', cost: 10, cost_method: 'fifo', valuation: 'real_time', qty_available: 0 });
  let service, receipt, delivery, bill;
  ({ db, id: service } = create(db, 'product', { name: 'Signed freight', type: 'service', landed_cost_ok: true }));
  ({ db, id: receipt } = create(db, 'stock.picking', { picking_type: 'incoming', state: 'ready', move_ids: [{ product_id: product, qty: 10 }] }));
  db = run(db, 'stock.picking', receipt, 'Validate');
  ({ db, id: delivery } = create(db, 'stock.picking', { picking_type: 'outgoing', state: 'ready', move_ids: [{ product_id: product, qty: 4 }] }));
  db = run(db, 'stock.picking', delivery, 'Validate');
  ({ db, id: bill } = create(db, 'account.move', { move_type: 'in_invoice', partner_id: 2, invoice_line_ids: [100, -50].map((price_unit) => ({ product_id: service, qty: 1, price_unit, tax: 0 })) }));
  db = run(db, 'account.move', bill, 'Confirm');
  db = run(db, 'account.move', bill, 'Create Landed Costs');
  const landed = search(db, 'stock.landed.cost').find((lc) => lc.bill_id === bill);
  db = write(db, 'stock.landed.cost', landed.id, { picking_id: receipt });
  db = run(db, 'stock.landed.cost', landed.id, 'Validate');
  assert.equal(read(db, 'stock.landed.cost', landed.id).amount_total, 50);
  assert.equal(search(db, 'stock.valuation.layer').find((l) => l.picking_id === receipt && l.kind === 'in').remaining_value, 90);
  const entry = search(db, 'account.move').find((m) => m.ref === `Landed costs ${read(db, 'stock.picking', receipt).name}`);
  const net = (code) => entry.line_ids.filter((l) => read(db, 'account.account', l.account_id)?.code === code).reduce((s, l) => s + l.debit - l.credit, 0);
  assert.equal(net('110100'), 30);
  assert.equal(net('500000'), 20);
  assert.equal(net('600000'), -50);
  assert.ok(isBalanced(entry.line_ids));
});

test('zero-net bill sources survive posting and validate landed costs', () => {
  let { db, id: product } = create(seed(), 'product', { name: 'Zero net FIFO', type: 'goods', cost: 10, cost_method: 'fifo', valuation: 'real_time', qty_available: 0 });
  let service, receipt, bill;
  ({ db, id: service } = create(db, 'product', { name: 'Offset freight', type: 'service', landed_cost_ok: true }));
  ({ db, id: receipt } = create(db, 'stock.picking', { picking_type: 'incoming', state: 'ready', move_ids: [{ product_id: product, qty: 1 }] }));
  db = run(db, 'stock.picking', receipt, 'Validate');
  const other = search(db, 'account.account').find((a) => a.code === '610000').id;
  ({ db, id: bill } = create(db, 'account.move', { move_type: 'in_invoice', partner_id: 2, invoice_line_ids: [...[100, -100].map((price_unit) => ({ product_id: service, qty: 1, price_unit, tax: 0 })), { qty: 1, price_unit: 10, tax: 0, account_id: other }] }));
  db = run(db, 'account.move', bill, 'Confirm');
  const item = read(db, 'account.move', bill).line_ids.find((l) => l.invoice_sources?.some((s) => s.index === 0));
  assert.deepEqual(item.invoice_sources.map((s) => s.amount), [100, -100]);
  assert.equal(item.debit, 0);
  assert.equal(item.credit, 0);
  db = run(db, 'account.move', bill, 'Create Landed Costs');
  const landed = search(db, 'stock.landed.cost').find((lc) => lc.bill_id === bill);
  db = write(db, 'stock.landed.cost', landed.id, { picking_id: receipt });
  db = run(db, 'stock.landed.cost', landed.id, 'Validate');
  assert.equal(read(db, 'stock.landed.cost', landed.id).state, 'done');
  assert.equal(read(db, 'stock.landed.cost', landed.id).amount_total, 0);
  assert.equal(search(db, 'stock.valuation.layer').find((l) => l.picking_id === receipt && l.kind === 'in').remaining_value, 10);
});

test('signed bill costs reject a negative receipt allocation and periodic costs reclassify signed shares', () => {
  let { db, id: product } = create(seed(), 'product', { name: 'Signed periodic', type: 'goods', valuation: 'manual_periodic', cost: 10, qty_available: 0 });
  let service, receipt, bill;
  ({ db, id: service } = create(db, 'product', { name: 'Periodic signed freight', type: 'service', landed_cost_ok: true }));
  ({ db, id: receipt } = create(db, 'stock.picking', { picking_type: 'incoming', state: 'ready', move_ids: [{ product_id: product, qty: 1 }] }));
  db = run(db, 'stock.picking', receipt, 'Validate');
  ({ db, id: bill } = create(db, 'account.move', { move_type: 'in_invoice', partner_id: 2, invoice_line_ids: [100, -50].map((price_unit) => ({ product_id: service, qty: 1, price_unit, tax: 0 })) }));
  db = run(db, 'account.move', bill, 'Confirm');
  db = run(db, 'account.move', bill, 'Create Landed Costs');
  const landed = search(db, 'stock.landed.cost').find((lc) => lc.bill_id === bill);
  const selected = search(db, 'account.account').find((a) => a.code === '610000').id;
  const lines = landed.cost_lines.map((line) => ({ ...line, account_id: selected }));
  db = write(db, 'stock.landed.cost', landed.id, { picking_id: receipt, cost_lines: lines });
  const negative = write(db, 'stock.landed.cost', landed.id, { cost_lines: [{ ...lines[0], amount: 20 }, lines[1]] });
  assert.throws(() => run(negative, 'stock.landed.cost', landed.id, 'Validate'), /net for each receipt must be nonnegative/i);
  db = run(db, 'stock.landed.cost', landed.id, 'Validate');
  const entry = search(db, 'account.move').find((m) => m.ref === `Landed costs ${read(db, 'stock.picking', receipt).name}`);
  const net = (code) => entry.line_ids.filter((l) => read(db, 'account.account', l.account_id)?.code === code).reduce((s, l) => s + l.debit - l.credit, 0);
  assert.equal(net('600000'), -50);
  assert.equal(net('610000'), 50);
  assert.ok(isBalanced(entry.line_ids));
});

test('mixed-sign foreign bill sources reconcile fractional cents by largest remainder', () => {
  let { db, id: service } = create(seed(), 'product', { name: 'Foreign freight adjustment', type: 'service', landed_cost_ok: true });
  let currency, bill;
  ({ db, id: currency } = create(db, 'res.currency', { name: 'MIXFX', rate_ids: [{ date: '2020-01-01', rate: 2 }] }));
  ({ db, id: bill } = create(db, 'account.move', { move_type: 'in_invoice', partner_id: 2, currency_id: currency, invoice_date: '2026-01-01', invoice_line_ids: [
    { product_id: service, qty: 1, price_unit: 1.01, tax: 0 },
    { product_id: service, qty: 1, price_unit: -0.02, tax: 0 },
  ] }));
  db = run(db, 'account.move', bill, 'Confirm');
  db = run(db, 'account.move', bill, 'Create Landed Costs');
  const landed = search(db, 'stock.landed.cost').find((lc) => lc.bill_id === bill);
  assert.deepEqual(landed.cost_lines.map((l) => l.amount), [0.51, -0.01]);
});

test('bill landed costs use posted line shares after rate and account configuration changes', () => {
  let { db, id: product } = create(seed(), 'product', { name: 'Periodic receipt', type: 'goods', valuation: 'manual_periodic', cost: 20 });
  const expense = search(db, 'account.account').find((a) => a.code === '610000');
  const other = search(db, 'account.account').find((a) => a.code === '600000');
  let service, receipt, currency, fp, bill;
  ({ db, id: service } = create(db, 'product', { name: 'Freight', type: 'service', landed_cost_ok: true, property_account_expense_id: expense.id }));
  ({ db, id: receipt } = create(db, 'stock.picking', { picking_type: 'incoming', state: 'ready', move_ids: [{ product_id: product, qty: 1 }] }));
  db = run(db, 'stock.picking', receipt, 'Validate');
  ({ db, id: currency } = create(db, 'res.currency', { name: 'LCFX', rate_ids: [{ date: '2020-01-01', rate: 2 }] }));
  ({ db, id: fp } = create(db, 'account.fiscal.position', { name: 'Freight mapping', account_ids: [] }));
  ({ db, id: bill } = create(db, 'account.move', { move_type: 'in_invoice', partner_id: 2, currency_id: currency, invoice_date: '2026-01-01', fiscal_position_id: fp, invoice_line_ids: [{ product_id: service, qty: 1, price_unit: 50, tax: 0 }, { product_id: service, qty: 1, price_unit: 50, tax: 0 }] }));
  db = run(db, 'account.move', bill, 'Confirm');
  db = write(db, 'res.currency', currency, { rate_ids: [{ date: '2020-01-01', rate: 4 }] });
  db = run(db, 'account.move', bill, 'Create Landed Costs');
  const landed = search(db, 'stock.landed.cost').find((lc) => lc.bill_id === bill);
  assert.deepEqual(landed.cost_lines.map((l) => [l.amount, l.account_id]), [[25, expense.id], [25, expense.id]]);
  db = write(db, 'product', service, { property_account_expense_id: other.id });
  db = write(db, 'account.fiscal.position', fp, { account_ids: [{ account_src_id: expense.id, account_dest_id: other.id }] });
  db = write(db, 'stock.landed.cost', landed.id, { picking_id: receipt, cost_lines: [{ ...landed.cost_lines[0], amount: 35 }, landed.cost_lines[1]] });
  db = run(db, 'stock.landed.cost', landed.id, 'Validate');
  const entry = search(db, 'account.move').find((m) => m.ref === `Landed costs ${read(db, 'stock.picking', receipt).name}`);
  assert.equal(entry.line_ids.filter((l) => l.account_id === expense.id).reduce((sum, l) => sum + l.debit - l.credit, 0), 10);
});

test('manual periodic landed costs debit the selected expense without using stock interim', () => {
  let { db, id: product } = create(seed(), 'product', { name: 'Periodic manual freight goods', type: 'goods', valuation: 'manual_periodic', cost: 20, qty_available: 0 });
  const expense = search(db, 'account.account').find((a) => a.code === '610000');
  const interim = search(db, 'account.account').find((a) => a.code === '110200');
  let receipt, landed;
  ({ db, id: receipt } = create(db, 'stock.picking', { picking_type: 'incoming', state: 'ready', move_ids: [{ product_id: product, qty: 10 }] }));
  db = run(db, 'stock.picking', receipt, 'Validate');
  ({ db, id: landed } = create(db, 'stock.landed.cost', { name: 'Manual freight', picking_id: receipt, cost_lines: [{ name: 'Freight', amount: 50, account_id: expense.id }] }));
  db = run(db, 'stock.landed.cost', landed, 'Validate');
  assert.equal(read(db, 'stock.landed.cost', landed).state, 'done');
  const entry = search(db, 'account.move').find((m) => m.ref === `Landed costs ${read(db, 'stock.picking', receipt).name}`);
  assert.ok(entry);
  assert.equal(entry.line_ids.filter((l) => l.account_id === expense.id).reduce((s, l) => s + (l.debit || 0) - (l.credit || 0), 0), 50);
  assert.equal(entry.line_ids.filter((l) => l.account_id === interim.id).reduce((s, l) => s + (l.debit || 0) - (l.credit || 0), 0), 0);
  assert.equal(entry.line_ids.reduce((s, l) => s + (l.debit || 0) - (l.credit || 0), 0), 0);
});

test('sale-line route overrides product, package and category route rules', () => {
  let db = seed();
  const createRoute = (name, action) => create(db, 'stock.route', { name, rule_ids: [{ sequence: 10, action }] });
  let categoryRoute, productRoute, packageRoute, lineRoute, category, pkg, sale;
  ({ db, id: categoryRoute } = createRoute('Category buy', 'mto_buy'));
  ({ db, id: productRoute } = createRoute('Product stock', 'stock'));
  ({ db, id: packageRoute } = createRoute('Package stock', 'stock'));
  ({ db, id: lineRoute } = createRoute('Line dropship', 'dropship'));
  ({ db, id: category } = create(db, 'product.category', { name: 'Routing category', route_id: categoryRoute }));
  ({ db, id: pkg } = create(db, 'stock.quant.package', { route_id: packageRoute }));
  db = write(db, 'product', 4, { categ_id: category, route_id: productRoute, vendor_id: 2 });
  ({ db, id: sale } = create(db, 'sale.order', { partner_id: 1, order_line: [{ product_id: 4, qty: 5, price_unit: 35, tax: 0, package_id: pkg, route_id: lineRoute }] }));
  db = run(db, 'sale.order', sale, 'Confirm');
  const po = search(db, 'purchase.order').find((p) => p.sale_id === sale);
  assert.equal(po.dropship_partner_id, 1);
  assert.equal(po.order_line[0].qty, 5);
  assert.ok(!search(db, 'stock.picking').some((p) => p.sale_id === sale));
});

test('landed cost on fully consumed standard stock is expensed and leaves its standard price unchanged', () => {
  let { db, id: product } = create(seed(), 'product', { name: 'Standard landed', type: 'goods', qty_available: 0, cost: 10, cost_method: 'standard' });
  let receipt, delivery, landed;
  ({ db, id: receipt } = create(db, 'stock.picking', { picking_type: 'incoming', state: 'ready', move_ids: [{ product_id: product, qty: 2 }] }));
  db = run(db, 'stock.picking', receipt, 'Validate');
  ({ db, id: delivery } = create(db, 'stock.picking', { picking_type: 'outgoing', state: 'ready', move_ids: [{ product_id: product, qty: 2 }] }));
  db = run(db, 'stock.picking', delivery, 'Validate');
  const journal = search(db, 'account.journal').find((j) => j.code === 'SAL');
  const clearing = search(db, 'account.account').find((a) => a.code === '110200');
  ({ db, id: landed } = create(db, 'stock.landed.cost', { name: 'Late cost', picking_id: receipt, journal_id: journal.id, cost_lines: [{ name: 'Freight', amount: 20, account_id: clearing.id }] }));
  db = run(db, 'stock.landed.cost', landed, 'Validate');
  assert.equal(read(db, 'product', product).cost, 10);
  const entry = search(db, 'account.move').find((m) => m.ref === `Landed costs ${read(db, 'stock.picking', receipt).name}`);
  assert.equal(entry.journal_id, journal.id);
  assert.equal(entry.line_ids.find((l) => l.account_id === clearing.id).credit, 20);
  assert.equal(entry.line_ids.find((l) => read(db, 'account.account', l.account_id)?.code === '500000').debit, 20);
});

test('landed cost split methods allocate equal, quantity, value, weight and volume independently', () => {
  let { db, id: a } = create(seed(), 'product', { name: 'Allocation A', type: 'goods', weight: 1, volume: 2, cost: 10, cost_method: 'fifo', qty_available: 0 });
  let b, receipt, landed;
  ({ db, id: b } = create(db, 'product', { name: 'Allocation B', type: 'goods', weight: 3, volume: 1, cost: 20, cost_method: 'fifo', qty_available: 0 }));
  ({ db, id: receipt } = create(db, 'stock.picking', { picking_type: 'incoming', state: 'ready', move_ids: [{ product_id: a, qty: 1 }, { product_id: b, qty: 2 }] }));
  db = run(db, 'stock.picking', receipt, 'Validate');
  const cost_lines = [['equal', 40], ['quantity', 30], ['value', 50], ['weight', 70], ['volume', 40]].map(([split_method, amount]) => ({ name: split_method, split_method, amount }));
  ({ db, id: landed } = create(db, 'stock.landed.cost', { name: 'Multiple methods', picking_id: receipt, cost_lines }));
  db = run(db, 'stock.landed.cost', landed, 'Validate');
  assert.equal(search(db, 'stock.valuation.layer').find((l) => l.picking_id === receipt && l.product_id === a && l.kind === 'in').remaining_value, 80);
  assert.equal(search(db, 'stock.valuation.layer').find((l) => l.picking_id === receipt && l.product_id === b && l.kind === 'in').remaining_value, 200);
});

test('route rules honor sequence and package, product and inherited category precedence', () => {
  let db = seed();
  let categoryRoute, productRoute, packageRoute, parent, child, pkg, sale;
  ({ db, id: categoryRoute } = create(db, 'stock.route', { name: 'Inherited buy', rule_ids: [{ sequence: 20, action: 'stock' }, { sequence: 5, action: 'mto_buy', product_id: 4 }] }));
  ({ db, id: productRoute } = create(db, 'stock.route', { name: 'Product stock', rule_ids: [{ action: 'stock' }] }));
  ({ db, id: packageRoute } = create(db, 'stock.route', { name: 'Package drop', rule_ids: [{ action: 'dropship' }] }));
  ({ db, id: parent } = create(db, 'product.category', { name: 'Parent routes', route_id: categoryRoute }));
  ({ db, id: child } = create(db, 'product.category', { name: 'Child routes', parent_id: parent }));
  ({ db, id: pkg } = create(db, 'stock.quant.package', { route_id: packageRoute }));
  db = write(db, 'product', 4, { categ_id: child, vendor_id: 2, route: 'stock' });
  ({ db, id: sale } = create(db, 'sale.order', { partner_id: 1, order_line: [{ product_id: 4, qty: 1, price_unit: 35, tax: 0 }] }));
  db = run(db, 'sale.order', sale, 'Confirm');
  assert.ok(search(db, 'purchase.order').some((p) => p.sale_id === sale && !p.dropship_partner_id));
  db = write(db, 'product', 4, { route_id: productRoute });
  let stockSale;
  ({ db, id: stockSale } = create(db, 'sale.order', { partner_id: 1, order_line: [{ product_id: 4, qty: 1, price_unit: 35, tax: 0 }] }));
  db = run(db, 'sale.order', stockSale, 'Confirm');
  assert.ok(!search(db, 'purchase.order').some((p) => p.sale_id === stockSale));
  let packageSale;
  ({ db, id: packageSale } = create(db, 'sale.order', { partner_id: 1, order_line: [{ product_id: 4, qty: 1, price_unit: 35, tax: 0, package_id: pkg }] }));
  db = run(db, 'sale.order', packageSale, 'Confirm');
  assert.ok(search(db, 'purchase.order').some((p) => p.sale_id === packageSale && p.dropship_partner_id === 1));
});

test('a confirmed dropship retains its route if the product routing later changes', () => {
  let db = write(seed(), 'product', 3, { route: 'dropship', vendor_id: 7, invoice_policy: 'delivery' });
  let sale;
  ({ db, id: sale } = create(db, 'sale.order', { partner_id: 6, order_line: [{ product_id: 3, qty: 1, price_unit: 1250, tax: 0 }] }));
  db = run(db, 'sale.order', sale, 'Confirm');
  const po = search(db, 'purchase.order').find((p) => p.sale_id === sale);
  db = write(db, 'product', 3, { route: 'stock' });
  db = run(db, 'purchase.order', po.id, 'Confirm Order');
  const shipment = search(db, 'stock.picking').find((p) => p.purchase_id === po.id);
  db = run(db, 'stock.picking', shipment.id, 'Validate');
  db = run(db, 'sale.order', sale, 'Create Invoice');
  const invoice = search(db, 'account.move').find((m) => m.sale_id === sale);
  db = run(db, 'account.move', invoice.id, 'Confirm');
  assert.equal(read(db, 'account.move', invoice.id).state, 'posted');
  assert.equal(read(db, 'sale.order', sale).invoice_status, 'invoiced');
});

test('dropship vendor bills use expense rather than stock interim', () => {
  let db = write(seed(), 'product', 3, { route: 'dropship', vendor_id: 7, invoice_policy: 'delivery' });
  let sale;
  ({ db, id: sale } = create(db, 'sale.order', { partner_id: 6, order_line: [{ product_id: 3, qty: 1, price_unit: 1250, tax: 0 }] }));
  db = run(db, 'sale.order', sale, 'Confirm');
  const po = search(db, 'purchase.order').find((p) => p.sale_id === sale);
  db = run(db, 'purchase.order', po.id, 'Confirm Order');
  const shipment = search(db, 'stock.picking').find((p) => p.purchase_id === po.id);
  db = run(db, 'stock.picking', shipment.id, 'Validate');
  db = run(db, 'purchase.order', po.id, 'Create Bill');
  const bill = search(db, 'account.move').find((m) => m.purchase_id === po.id);
  db = run(db, 'account.move', bill.id, 'Confirm');
  const lines = read(db, 'account.move', bill.id).line_ids;
  assert.ok(lines.some((l) => read(db, 'account.account', l.account_id)?.code === '600000' && l.debit > 0));
  assert.ok(!lines.some((l) => read(db, 'account.account', l.account_id)?.code === '110200'));
});

test('manufacture on order links and produces full sale demand despite existing stock', () => {
  let { db, id: product } = create(seed(), 'product', { name: 'MTO manufactured', type: 'goods', route: 'mto_make', qty_available: 10, cost: 20 });
  let bom, sale;
  ({ db, id: bom } = create(db, 'mrp.bom', { name: 'MTO BOM', product_id: product, product_qty: 1, components: [{ product_id: 7, qty: 1 }] }));
  ({ db, id: sale } = create(db, 'sale.order', { partner_id: 1, order_line: [{ product_id: product, qty: 3, price_unit: 30, tax: 0 }] }));
  db = run(db, 'sale.order', sale, 'Confirm');
  const mo = search(db, 'mrp.production').find((m) => m.sale_id === sale);
  assert.equal(mo.bom_id, bom);
  assert.equal(mo.product_qty, 3);
  const delivery = search(db, 'stock.picking').find((p) => p.sale_id === sale);
  assert.equal(delivery.state, 'waiting');
  db = run(db, 'mrp.production', mo.id, 'Confirm');
  db = run(db, 'mrp.production', mo.id, 'Produce');
  assert.equal(read(db, 'stock.picking', delivery.id).state, 'ready');
  db = run(db, 'stock.picking', delivery.id, 'Validate');
  assert.equal(read(db, 'sale.order', sale).order_line[0].qty_delivered, 3);
});

test('MTO and dropship RFQs propagate the sale company to generated purchase orders', () => {
  let db = write(seed(), 'product', 4, { route: 'mto_buy', vendor_id: 2 });
  db = write(db, 'product', 3, { route: 'dropship', vendor_id: 7 });
  let saleMto, saleDrop;
  ({ db, id: saleMto } = create(db, 'sale.order', { company_id: 2, partner_id: 1, order_line: [{ product_id: 4, qty: 3, price_unit: 35, tax: 0 }] }));
  db = run(db, 'sale.order', saleMto, 'Confirm');
  const rfqMto = search(db, 'purchase.order').find((p) => p.sale_id === saleMto);
  assert.ok(rfqMto);
  assert.equal(rfqMto.company_id, 2);

  ({ db, id: saleDrop } = create(db, 'sale.order', { company_id: 2, partner_id: 6, order_line: [{ product_id: 3, qty: 2, price_unit: 1250, tax: 0 }] }));
  db = run(db, 'sale.order', saleDrop, 'Confirm');
  const rfqDrop = search(db, 'purchase.order').find((p) => p.sale_id === saleDrop);
  assert.ok(rfqDrop);
  assert.equal(rfqDrop.company_id, 2);
});

test('tracked dropship shipment and return resolve or create company-scoped lot identity and links', () => {
  let { db, id: product } = create(seed(), 'product', { name: 'Tracked dropship', type: 'goods', tracking: 'lot', route: 'dropship', vendor_id: 7, invoice_policy: 'delivery', cost: 100 });
  let sale;
  ({ db, id: sale } = create(db, 'sale.order', { partner_id: 6, order_line: [{ product_id: product, qty: 2, price_unit: 200, tax: 0 }] }));
  db = run(db, 'sale.order', sale, 'Confirm');
  const po = search(db, 'purchase.order').find((p) => p.sale_id === sale);
  db = run(db, 'purchase.order', po.id, 'Confirm Order');
  const picking = search(db, 'stock.picking').find((p) => p.purchase_id === po.id);
  assert.ok(picking);

  assert.throws(() => run(db, 'stock.picking', picking.id, 'Validate'), /tracked.*lot/i);

  db = write(db, 'stock.picking', picking.id, { move_ids: [{ ...picking.move_ids[0], lot_name: 'DROP-LOT-1' }] });
  db = run(db, 'stock.picking', picking.id, 'Validate');

  const lot = search(db, 'stock.lot').find((l) => l.product_id === product && l.name === 'DROP-LOT-1');
  assert.ok(lot);
  assert.equal(lot.company_id ?? 1, read(db, 'stock.picking', picking.id).company_id ?? 1);

  const donePicking = read(db, 'stock.picking', picking.id);
  assert.equal(donePicking.move_ids[0].lot_id, lot.id);

  db = run(db, 'stock.picking', picking.id, 'Return');
  const ret = search(db, 'stock.picking').find((p) => p.return_of === picking.id);
  assert.ok(ret);
  assert.equal(ret.move_ids[0].lot_name, 'DROP-LOT-1');
  assert.equal(ret.move_ids[0].lot_id, lot.id);

  db = run(db, 'stock.picking', ret.id, 'Validate');
  const doneRet = read(db, 'stock.picking', ret.id);
  assert.equal(doneRet.move_ids[0].lot_id, lot.id);
});

test('landed costs allocate to periodic receipts through the public action with Odoo 20 accounting', () => {
  let { db, id: product } = create(seed(), 'product', { name: 'Periodic Landed', type: 'goods', valuation: 'manual_periodic', cost: 20, qty_available: 0 });
  let receipt, landed;
  ({ db, id: receipt } = create(db, 'stock.picking', { picking_type: 'incoming', state: 'ready', move_ids: [{ product_id: product, qty: 10 }] }));
  db = run(db, 'stock.picking', receipt, 'Validate');

  assert.equal(search(db, 'stock.valuation.layer').filter((l) => l.product_id === product).length, 0);

  ({ db, id: landed } = create(db, 'stock.landed.cost', {
    name: 'Freight Periodic',
    picking_id: receipt,
    cost_lines: [{ name: 'Freight', amount: 50, split_method: 'quantity' }],
  }));

  db = run(db, 'stock.landed.cost', landed, 'Validate');

  const postedLc = read(db, 'stock.landed.cost', landed);
  assert.equal(postedLc.state, 'done');
  assert.equal(postedLc.amount_total, 50);

  assert.equal(search(db, 'stock.valuation.layer').filter((l) => l.product_id === product).length, 0);

  const entry = search(db, 'account.move').find((m) => m.ref === `Landed costs ${read(db, 'stock.picking', receipt).name}`);
  assert.ok(entry);
  const expenseAcc = (db.records['account.account'] ?? []).find((a) => a.code === '500000')?.id;
  const inputAcc = (db.records['account.account'] ?? []).find((a) => a.code === '110200')?.id;
  assert.equal(entry.line_ids.find((l) => l.account_id === expenseAcc)?.debit, 50);
  assert.ok(!entry.line_ids.some((l) => l.account_id === inputAcc));
  assert.equal(entry.line_ids.find((l) => read(db, 'account.account', l.account_id)?.code === '211000')?.credit, 50);
});

test('any legacy bill (single or grouped lines) is skipped with the message; a bill with persisted provenance still imports; the manual landed cost validates', () => {
  let { db, id: product } = create(seed(), 'product', { name: 'Legacy regression goods', type: 'goods', valuation: 'real_time', cost_method: 'fifo', cost: 20, qty_available: 0 });
  let service, receipt, currency1, currency2;
  const expense = search(db, 'account.account').find((a) => a.code === '610000');

  ({ db, id: service } = create(db, 'product', { name: 'Regression freight', type: 'service', landed_cost_ok: true }));
  ({ db, id: receipt } = create(db, 'stock.picking', { picking_type: 'incoming', state: 'ready', move_ids: [{ product_id: product, qty: 1 }] }));
  db = run(db, 'stock.picking', receipt, 'Validate');

  // 1. Any legacy bill: single-line legacy bill is skipped with the manual-entry message
  ({ db, id: currency1 } = create(db, 'res.currency', { name: 'SingleFX', rate_ids: [{ date: '2020-01-01', rate: 2 }] }));
  let singleLegacyBill;
  ({ db, id: singleLegacyBill } = create(db, 'account.move', {
    move_type: 'in_invoice', partner_id: 2, currency_id: currency1, invoice_date: '2026-01-01',
    invoice_line_ids: [{ product_id: service, account_id: expense.id, qty: 1, price_unit: 50, tax: 0 }],
  }));
  db = run(db, 'account.move', singleLegacyBill, 'Confirm');
  db = { ...db, records: { ...db.records, 'account.move': db.records['account.move'].map((m) => m.id !== singleLegacyBill ? m : { ...m, line_ids: m.line_ids.map(({ invoice_sources, ...line }) => line) }) } };

  assert.throws(
    () => run(db, 'account.move', singleLegacyBill, 'Create Landed Costs'),
    /posted expense could not be identified unambiguously\. Record it as a manual landed cost instead\./i,
  );
  assert.equal(search(db, 'stock.landed.cost').filter((lc) => lc.bill_id === singleLegacyBill).length, 0);

  // 2. Any legacy bill: grouped-lines legacy bill is skipped with the manual-entry message
  ({ db, id: currency2 } = create(db, 'res.currency', { name: 'MixedFX', rate_ids: [{ date: '2020-01-01', rate: 3 }] }));
  let groupedLegacyBill;
  ({ db, id: groupedLegacyBill } = create(db, 'account.move', {
    move_type: 'in_invoice', partner_id: 2, currency_id: currency2, invoice_date: '2026-01-01',
    invoice_line_ids: [
      { product_id: service, account_id: expense.id, qty: 1, price_unit: 100, tax: 0 },
      { product_id: service, account_id: expense.id, qty: 1, price_unit: -99, tax: 0 },
    ],
  }));
  db = run(db, 'account.move', groupedLegacyBill, 'Confirm');
  db = { ...db, records: { ...db.records, 'account.move': db.records['account.move'].map((m) => m.id !== groupedLegacyBill ? m : { ...m, line_ids: m.line_ids.map(({ invoice_sources, ...line }) => line) }) } };

  assert.throws(
    () => run(db, 'account.move', groupedLegacyBill, 'Create Landed Costs'),
    /posted expense could not be identified unambiguously\. Record it as a manual landed cost instead\./i,
  );
  assert.equal(search(db, 'stock.landed.cost').filter((lc) => lc.bill_id === groupedLegacyBill).length, 0);

  // 3. A bill with persisted provenance still imports
  let provenanceBill;
  ({ db, id: provenanceBill } = create(db, 'account.move', {
    move_type: 'in_invoice', partner_id: 2, currency_id: currency1, invoice_date: '2026-01-01',
    invoice_line_ids: [{ product_id: service, account_id: expense.id, qty: 1, price_unit: 50, tax: 0 }],
  }));
  db = run(db, 'account.move', provenanceBill, 'Confirm');
  db = write(db, 'res.currency', currency1, { rate_ids: [{ date: '2020-01-01', rate: 4 }] });

  db = run(db, 'account.move', provenanceBill, 'Create Landed Costs');
  const provLanded = search(db, 'stock.landed.cost').find((lc) => lc.bill_id === provenanceBill);
  assert.ok(provLanded);
  assert.equal(provLanded.cost_lines.length, 1);
  assert.equal(provLanded.cost_lines[0].amount, 25);
  assert.equal(provLanded.cost_lines[0].source_bill_amount, 25);
  assert.ok(!provLanded.source_warning);

  db = write(db, 'stock.landed.cost', provLanded.id, { picking_id: receipt });
  db = run(db, 'stock.landed.cost', provLanded.id, 'Validate');
  assert.equal(read(db, 'stock.landed.cost', provLanded.id).state, 'done');
  assert.equal(read(db, 'stock.landed.cost', provLanded.id).amount_total, 25);

  // 4. The manual landed cost validates
  let manualLanded;
  ({ db, id: manualLanded } = create(db, 'stock.landed.cost', {
    name: 'Manual mixed LC',
    picking_id: receipt,
    cost_lines: [{ name: 'Manual freight', amount: 0.33, account_id: expense.id, split_method: 'quantity' }],
  }));
  db = run(db, 'stock.landed.cost', manualLanded, 'Validate');
  const postedManual = read(db, 'stock.landed.cost', manualLanded);
  assert.equal(postedManual.state, 'done');
  assert.equal(postedManual.amount_total, 0.33);

  const layer = search(db, 'stock.valuation.layer').find((l) => l.picking_id === receipt && l.kind === 'in');
  assert.equal(layer.remaining_value, round(20 + 25 + 0.33));
});

test('bill-line sources cannot be reused across validated landed costs, but cancelled sources can be reused', () => {
  let { db, id: product } = create(seed(), 'product', { name: 'Unique source goods', type: 'goods', valuation: 'real_time', cost_method: 'fifo', cost: 20, qty_available: 0 });
  let service, receipt, bill;
  ({ db, id: service } = create(db, 'product', { name: 'Unique freight', type: 'service', landed_cost_ok: true }));
  ({ db, id: receipt } = create(db, 'stock.picking', { picking_type: 'incoming', state: 'ready', move_ids: [{ product_id: product, qty: 1 }] }));
  db = run(db, 'stock.picking', receipt, 'Validate');
  ({ db, id: bill } = create(db, 'account.move', { move_type: 'in_invoice', partner_id: 2, invoice_line_ids: [50, 20].map((price_unit) => ({ product_id: service, qty: 1, price_unit, tax: 0 })) }));
  db = run(db, 'account.move', bill, 'Confirm');
  db = run(db, 'account.move', bill, 'Create Landed Costs');
  const first = search(db, 'stock.landed.cost').find((lc) => lc.bill_id === bill);
  const [source, otherSource] = first.cost_lines;
  db = write(db, 'stock.landed.cost', first.id, { picking_id: receipt, cost_lines: [source] });
  let duplicate, other;
  ({ db, id: duplicate } = create(db, 'stock.landed.cost', { name: 'Copied source', bill_id: bill, picking_id: receipt, cost_lines: [source] }));
  ({ db, id: other } = create(db, 'stock.landed.cost', { name: 'Other source', bill_id: bill, picking_id: receipt, cost_lines: [otherSource] }));
  db = run(db, 'stock.landed.cost', first.id, 'Validate');
  const before = db;
  assert.throws(() => run(db, 'stock.landed.cost', duplicate, 'Validate'), /duplicate|already.*(used|recognized)/i);
  assert.equal(read(db, 'stock.landed.cost', duplicate).state, 'draft');
  assert.equal(search(db, 'stock.valuation.layer').filter((l) => l.picking_id === receipt && l.kind === 'landed').length, 1);
  db = run(db, 'stock.landed.cost', other, 'Validate');
  assert.equal(read(db, 'stock.landed.cost', other).state, 'done');

  // Simulate an externally reversed historical document: this model has no cancellation action.
  const cancelled = { ...before, records: { ...before.records, 'stock.landed.cost': before.records['stock.landed.cost'].map((lc) => lc.id === first.id ? { ...lc, state: 'cancel' } : lc) } };
  const reused = run(cancelled, 'stock.landed.cost', duplicate, 'Validate');
  assert.equal(read(reused, 'stock.landed.cost', duplicate).state, 'done');
});

test('create landed costs, clear the flag, validate a draft with another line; the full amount is capitalized', () => {
  let { db, id: product } = create(seed(), 'product', { name: 'Regression goods', type: 'goods', valuation: 'real_time', cost_method: 'fifo', cost: 100, qty_available: 0 });
  const expense = search(db, 'account.account').find((a) => a.code === '610000');
  let service, receipt, bill;
  ({ db, id: service } = create(db, 'product', { name: 'Freight service', type: 'service', landed_cost_ok: true, property_account_expense_id: expense.id }));
  ({ db, id: receipt } = create(db, 'stock.picking', { picking_type: 'incoming', state: 'ready', move_ids: [{ product_id: product, qty: 1 }] }));
  db = run(db, 'stock.picking', receipt, 'Validate');

  ({ db, id: bill } = create(db, 'account.move', {
    move_type: 'in_invoice', partner_id: 2, invoice_date: '2026-01-01',
    invoice_line_ids: [{ product_id: service, account_id: expense.id, qty: 1, price_unit: 50, tax: 0 }],
  }));
  db = run(db, 'account.move', bill, 'Confirm');

  // 1. Create landed costs from the posted bill
  db = run(db, 'account.move', bill, 'Create Landed Costs');
  const landed = search(db, 'stock.landed.cost').find((lc) => lc.bill_id === bill);
  assert.ok(landed);
  assert.equal(landed.cost_lines.length, 1);
  assert.equal(landed.cost_lines[0].amount, 50);

  // 2. Add another cost line (e.g. manual customs cost of 30) and link to the receipt
  db = write(db, 'stock.landed.cost', landed.id, {
    picking_id: receipt,
    cost_lines: [
      landed.cost_lines[0],
      { name: 'Customs manual', amount: 30, account_id: expense.id, split_method: 'quantity' },
    ],
  });

  // 3. Clear the landed_cost_ok flag on the service product
  db = write(db, 'product', service, { landed_cost_ok: false });

  // 4. Validate the draft
  db = run(db, 'stock.landed.cost', landed.id, 'Validate');
  const postedLanded = read(db, 'stock.landed.cost', landed.id);
  assert.equal(postedLanded.state, 'done');
  assert.equal(postedLanded.amount_total, 80);

  // Check that the full amount (50 bill line + 30 manual line = 80) is capitalized into inventory value
  const layer = search(db, 'stock.valuation.layer').find((l) => l.picking_id === receipt && l.kind === 'in');
  assert.equal(layer.remaining_value, 180);

  const landedLayer = search(db, 'stock.valuation.layer').find((l) => l.picking_id === receipt && l.kind === 'landed');
  assert.ok(landedLayer);
  assert.equal(landedLayer.value, 80);
});

