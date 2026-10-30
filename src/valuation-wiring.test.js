import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { salesModels, moveStock } from './models/sales.js';
import { postMove } from './models/accounting.js';
import { accountId, invoiceLines, isBalanced, journalItems } from './models/ledger.js';
import { receive, deliver, valuationReport } from './models/valuation.js';
import { payOrder, refundOrder, sessionTotals, startSession } from './models/pos.js';
import { payWithMethods } from './models/posplus.js';
import { confirmMo, produce } from './models/more.js';
import { unbuild, validateScrap } from './models/mrp.js';
import { applyLandedCost } from './models/routes.js';
import { postOperationCost, workorderModels } from './models/workorder.js';

const run = (db, model, id, label) => salesModels[model].form.buttons.find((b) => b.label === label).run(db, read(db, model, id)).db;
const balance = (db, code) => journalItems(db).filter((l) => l.account_id === accountId(db, code)).reduce((s, l) => s + l.debit - l.credit, 0);
const delta = (before, after, code) => Math.round((balance(after, code) - balance(before, code)) * 100) / 100;
const qty = (db, id) => read(db, 'product', id).qty_available;
const product = (db = seed(), vals = {}) => create(db, 'product', { name: 'Wiring widget', type: 'goods', cost: 10, cost_method: 'fifo', valuation: 'real_time', qty_available: 0, ...vals });
const line = (id, qty, price_unit = 20) => ({ product_id: id, qty, price_unit, tax: 0 });
const picking = (db, id, count, type = 'incoming', extra = {}) => {
  const out = create(db, 'stock.picking', { picking_type: type, state: 'ready', move_ids: [{ product_id: id, qty: count }], ...extra });
  return { db: run(out.db, 'stock.picking', out.id, 'Validate'), id: out.id };
};
const layers = (db, id) => search(db, 'stock.valuation.layer').filter((l) => l.product_id === id && !l.opening);

test('PO receipt clears interim against the bill, credits payable once, and moves stock once', () => {
  for (const method of ['fifo', 'average', 'standard']) {
    const f = product(seed(), { cost_method: method });
    const po = create(f.db, 'purchase.order', { partner_id: 2, order_line: [line(f.id, 5, 13)] });
    const confirmed = run(po.db, 'purchase.order', po.id, 'Confirm Order');
    const pick = search(confirmed, 'stock.picking').find((p) => p.purchase_id === po.id);
    const received = run(confirmed, 'stock.picking', pick.id, 'Validate');
    assert.equal(qty(received, f.id), qty(moveStock(confirmed, pick.move_ids, 1), f.id));
    assert.equal(delta(confirmed, received, '110100'), method === 'standard' ? 50 : 65);
    assert.equal(delta(confirmed, received, '110200'), -65);
    assert.equal(delta(confirmed, received, '211000'), 0);
    const draft = run(received, 'purchase.order', po.id, 'Create Bill');
    const bill = search(draft, 'account.move').find((m) => m.purchase_id === po.id);
    const posted = postMove(draft, bill.id);
    assert.equal(delta(confirmed, posted, '110200'), 0);
    assert.equal(delta(confirmed, posted, '211000'), -65);
    assert.equal(delta(confirmed, posted, '110100'), method === 'standard' ? 50 : 65);
    assert.equal(qty(posted, f.id), 5);
    assert.equal(read(confirmed, 'product', f.id).qty_available, 0);
  }
});

test('PO origin resolves receipt cost; vendor refunds clear interim and explicit accounts still win', () => {
  const f = product();
  const po = create(f.db, 'purchase.order', { partner_id: 2, order_line: [line(f.id, 2, 17)] });
  const received = picking(po.db, f.id, 2, 'incoming', { origin: read(po.db, 'purchase.order', po.id).name }).db;
  assert.equal(layers(received, f.id)[0].value, 34);
  const move = { move_type: 'in_refund', invoice_line_ids: [line(f.id, 2, 17)] };
  assert.equal(invoiceLines(received, move).find((l) => l.account_id === accountId(received, '110200')).credit, 34);
  const override = invoiceLines(received, { ...move, invoice_line_ids: [{ ...line(f.id, 2, 17), account_id: accountId(received, '600000') }] });
  assert.equal(override.find((l) => l.account_id === accountId(received, '600000')).credit, 34);
  const service = product(received, { type: 'service' });
  assert.ok(invoiceLines(service.db, { move_type: 'in_invoice', invoice_line_ids: [line(service.id, 1)] }).some((l) => l.account_id === accountId(service.db, '600000')));
});

test('duplicate PO product lines keep their individual purchase costs through partial receipts', () => {
  const f = product();
  const po = create(f.db, 'purchase.order', { partner_id: 2, order_line: [line(f.id, 2, 13), line(f.id, 3, 17)] });
  let db = run(po.db, 'purchase.order', po.id, 'Confirm Order');
  const pick = search(db, 'stock.picking').find((p) => p.purchase_id === po.id);
  db = write(db, 'stock.picking', pick.id, { move_ids: pick.move_ids.map((m, i) => ({ ...m, quantity: i ? 1 : 2 })) });
  db = run(db, 'stock.picking', pick.id, 'Validate');
  assert.deepEqual(layers(db, f.id).map((l) => [l.quantity, l.unit_cost]), [[2, 13], [1, 17]]);
  const rest = search(db, 'stock.picking').find((p) => p.backorder_id === pick.id);
  db = run(db, 'stock.picking', rest.id, 'Validate');
  assert.deepEqual(layers(db, f.id).at(-1).unit_cost, 17);
  assert.equal(qty(db, f.id), 5);
  const bill = create(db, 'account.move', { move_type: 'in_invoice', partner_id: 2, invoice_line_ids: read(db, 'purchase.order', po.id).order_line.map(({ purchase_method, qty_delivered, ...l }) => l) });
  assert.equal(delta(f.db, postMove(bill.db, bill.id), '110200'), 0);
});

test('sales deliveries book FIFO/average COGS and customer returns reverse delivered value once', () => {
  for (const method of ['fifo', 'average']) {
    const f = product(seed(), { cost_method: method });
    let db = receive(receive(f.db, f.id, 2, 10), f.id, 2, 20);
    const sale = create(db, 'sale.order', { partner_id: 1, order_line: [line(f.id, 3)] });
    db = run(sale.db, 'sale.order', sale.id, 'Confirm');
    const p = search(db, 'stock.picking').find((p) => p.sale_id === sale.id);
    const before = structuredClone(db);
    const done = run(db, 'stock.picking', p.id, 'Validate');
    assert.equal(delta(db, done, '500000'), method === 'fifo' ? 40 : 45);
    assert.equal(delta(db, done, '400000'), 0);
    assert.equal(qty(done, f.id), qty(moveStock(db, p.move_ids, -1), f.id));
    assert.deepEqual(db, before);
    const returned = run(done, 'stock.picking', p.id, 'Return');
    const reverse = search(returned, 'stock.picking').find((r) => r.return_of === p.id);
    const restored = run(returned, 'stock.picking', reverse.id, 'Validate');
    assert.equal(qty(restored, f.id), 4);
    assert.equal(delta(db, restored, '500000'), 0);
    assert.equal(delta(done, restored, '110200'), 0);
    const invoice = run(done, 'sale.order', sale.id, 'Create Invoice');
    const move = search(invoice, 'account.move').find((m) => m.sale_id === sale.id);
    const posted = postMove(invoice, move.id);
    assert.equal(delta(invoice, posted, '400000'), -60);
    assert.equal(delta(invoice, posted, '500000'), 0);
  }
});

test('partial receipts value only done quantities; backorders and vendor returns never double stock', () => {
  const f = product();
  const pick = create(f.db, 'stock.picking', { picking_type: 'incoming', state: 'ready', move_ids: [{ product_id: f.id, qty: 5, quantity: 2 }] });
  let db = run(pick.db, 'stock.picking', pick.id, 'Validate');
  assert.equal(qty(db, f.id), 2);
  const backorder = search(db, 'stock.picking').find((p) => p.backorder_id === pick.id);
  db = run(db, 'stock.picking', backorder.id, 'Validate');
  assert.equal(qty(db, f.id), 5);
  const before = db;
  db = run(db, 'stock.picking', pick.id, 'Return');
  const reverse = search(db, 'stock.picking').find((p) => p.return_of === pick.id);
  db = run(db, 'stock.picking', reverse.id, 'Validate');
  assert.equal(qty(db, f.id), 3);
  assert.equal(delta(before, db, '110200'), 20);
  assert.equal(delta(before, db, '500000'), 0);
});

test('POS sale/refund restore original FIFO cost despite a changed current cost and preserve session totals', () => {
  const f = product();
  let db = receive(receive(f.db, f.id, 2, 10), f.id, 2, 20);
  db = startSession(db, 100).db;
  const before = db;
  const sale = payOrder(db, { lines: [line(f.id, 3)], method: 'cash' });
  assert.equal(qty(sale.db, f.id), 1);
  assert.equal(delta(before, sale.db, '500000'), 40);
  const changed = write(sale.db, 'product', f.id, { cost: 99 });
  const refund = refundOrder(changed, read(changed, 'pos.order', sale.id));
  assert.equal(qty(refund.db, f.id), 4);
  assert.equal(delta(before, refund.db, '500000'), 0);
  assert.equal(delta(before, refund.db, '110100'), 0);
  assert.equal(delta(changed, refund.db, '110200'), 0);
  const session = search(refund.db, 'pos.session').find((s) => s.state === 'opened');
  assert.equal(sessionTotals(refund.db, session).cash, 0);
  assert.equal(sessionTotals(refund.db, session).expected, 100);
  assert.throws(() => refundOrder(refund.db, read(sale.db, 'pos.order', sale.id)), /already refunded/);
});

test('split POS tenders deliver exactly the original quantity and preserve the total COGS', () => {
  const f = product();
  const stocked = startSession(receive(f.db, f.id, 5, 10)).db;
  const draft = create(stocked, 'pos.order', { state: 'draft', lines: [line(f.id, 3, 20)] });
  const out = payWithMethods(draft.db, draft.id, [{ method: 'cash', amount: 20 }, { method: 'bank', amount: 40 }]);
  assert.equal(qty(out.db, f.id), 2);
  assert.equal(delta(draft.db, out.db, '500000'), 30);
  assert.equal(layers(out.db, f.id).filter((l) => l.kind === 'out').reduce((s, l) => s - l.quantity, 0), 3);
});

test('production transfers actual FIFO component value into finished stock with no interim debt', () => {
  const component = product();
  const finished = product(receive(component.db, component.id, 10, 12), { name: 'Finished', cost: 99 });
  const bom = create(finished.db, 'mrp.bom', { name: 'Wiring BOM', product_id: finished.id, product_qty: 1, components: [{ product_id: component.id, qty: 2 }] });
  const mo = create(bom.db, 'mrp.production', { product_id: finished.id, bom_id: bom.id, product_qty: 2 });
  const confirmed = confirmMo(mo.db, read(mo.db, 'mrp.production', mo.id));
  const snapshot = structuredClone(confirmed);
  const done = produce(confirmed, read(confirmed, 'mrp.production', mo.id)).db;
  assert.equal(qty(done, component.id), 6);
  assert.equal(qty(done, finished.id), 2);
  assert.equal(layers(done, component.id).at(-1).value, -48);
  assert.equal(layers(done, finished.id).at(-1).value, 48);
  assert.equal(deliver(done, finished.id, 1).value, 24);
  for (const code of ['110100', '110200', '211000', '600000']) assert.equal(delta(confirmed, done, code), 0);
  assert.deepEqual(confirmed, snapshot);
  assert.throws(() => produce(done, read(done, 'mrp.production', mo.id)), /already processed/);
  const ub = create(done, 'mrp.unbuild', { product_id: finished.id, bom_id: bom.id, product_qty: 1 });
  const reversed = unbuild(ub.db, read(ub.db, 'mrp.unbuild', ub.id));
  assert.equal(qty(reversed, finished.id), 1);
  assert.equal(qty(reversed, component.id), 8);
  assert.equal(valuationReport(reversed)[component.id].qty, 8);
});

test('operation capitalization occurs once and later delivery consumes component plus operation value', () => {
  const component = product();
  const finished = product(receive(component.db, component.id, 2, 10));
  const wc = create(finished.db, 'mrp.workcenter', { name: 'Wiring assembly', costs_hour: 30 });
  const bom = create(wc.db, 'mrp.bom', { name: 'Wiring operations BOM', product_id: finished.id, product_qty: 1, components: [{ product_id: component.id, qty: 2 }] });
  const mo = create(bom.db, 'mrp.production', { product_id: finished.id, bom_id: bom.id, product_qty: 1, state: 'confirmed' });
  const wo = create(mo.db, 'mrp.workorder', { name: 'Assembly', production_id: mo.id, workcenter_id: wc.id, state: 'done', time_ids: [{ minutes: 60, date_start: '2026-10-25T08:00:00Z', date_end: '2026-10-25T09:00:00Z' }] });
  const button = workorderModels['mrp.production'].form.buttons.find((b) => b.label === 'Produce');
  const done = button.run(wo.db, read(wo.db, 'mrp.production', mo.id)).db;
  assert.equal(delta(wo.db, done, '110100'), 30);
  assert.equal(valuationReport(done)[finished.id].value, 50);
  assert.strictEqual(postOperationCost(done, mo.id), done);
  assert.equal(deliver(done, finished.id, 1).value, 50);
});

test('scrap uses FIFO loss value, books expenses instead of COGS, and changes quantities once', () => {
  const f = product();
  const stocked = receive(receive(f.db, f.id, 2, 10), f.id, 2, 20);
  const scrap = create(stocked, 'stock.scrap', { product_id: f.id, scrap_qty: 3 });
  const done = validateScrap(scrap.db, read(scrap.db, 'stock.scrap', scrap.id));
  assert.equal(qty(done, f.id), 1);
  assert.equal(read(done, 'stock.scrap', scrap.id).scrap_value, 40);
  assert.equal(delta(scrap.db, done, '600000'), 40);
  assert.equal(delta(scrap.db, done, '110100'), -40);
  assert.equal(delta(scrap.db, done, '500000'), 0);
  assert.ok(read(done, 'stock.scrap', scrap.id).move_id);
  assert.throws(() => validateScrap(done, read(done, 'stock.scrap', scrap.id)), /already done/);
});

test('landed value reaches subsequent FIFO deliveries without a duplicate capitalization entry', () => {
  const f = product();
  const received = picking(f.db, f.id, 5);
  const lc = create(received.db, 'stock.landed.cost', { name: 'Wiring freight', picking_id: received.id, cost_lines: [{ name: 'Freight', amount: 25 }] });
  const done = applyLandedCost(lc.db, read(lc.db, 'stock.landed.cost', lc.id));
  assert.equal(delta(lc.db, done, '110100'), 25);
  assert.equal(qty(done, f.id), 5);
  assert.equal(valuationReport(done)[f.id].value, 75);
  assert.equal(deliver(done, f.id, 5).value, 75);
  assert.throws(() => applyLandedCost(done, read(done, 'stock.landed.cost', lc.id)), /already posted/);
});

test('periodic receipts, deliveries, production, unbuild and scrap remain quantities-only', () => {
  const f = product(seed(), { valuation: 'manual_periodic', qty_available: 10 });
  const start = search(f.db, 'account.move').length;
  let db = picking(f.db, f.id, 3).db;
  db = picking(db, f.id, 2, 'outgoing').db;
  assert.equal(qty(db, f.id), 11);
  const finished = product(db, { valuation: 'manual_periodic' });
  const bom = create(finished.db, 'mrp.bom', { name: 'Periodic BOM', product_id: finished.id, product_qty: 1, components: [{ product_id: f.id, qty: 2 }] });
  const mo = create(bom.db, 'mrp.production', { product_id: finished.id, bom_id: bom.id, product_qty: 2 });
  db = produce(mo.db, read(mo.db, 'mrp.production', mo.id)).db;
  const ub = create(db, 'mrp.unbuild', { product_id: finished.id, bom_id: bom.id, product_qty: 1 });
  db = unbuild(ub.db, read(ub.db, 'mrp.unbuild', ub.id));
  const scrap = create(db, 'stock.scrap', { product_id: f.id, scrap_qty: 1 });
  db = validateScrap(scrap.db, read(scrap.db, 'stock.scrap', scrap.id));
  assert.equal(qty(db, f.id), 8);
  assert.equal(qty(db, finished.id), 1);
  assert.equal(search(db, 'account.move').length, start);
  assert.equal(layers(db, f.id).length, 0);
  assert.ok(invoiceLines(db, { move_type: 'in_invoice', invoice_line_ids: [line(f.id, 1)] }).some((l) => l.account_id === accountId(db, '600000')));
  db = startSession(db).db;
  const sale = payOrder(db, { lines: [line(f.id, 1)], method: 'cash' });
  const refunded = refundOrder(sale.db, read(sale.db, 'pos.order', sale.id)).db;
  assert.equal(qty(refunded, f.id), 8);
  assert.equal(search(refunded, 'account.move').length, start + 4); // sale and tender, plus their reversals
  assert.equal(layers(refunded, f.id).length, 0);
  assert.ok(search(refunded, 'account.move').filter((m) => m.state === 'posted').every((m) => isBalanced(m.line_ids)));
});
