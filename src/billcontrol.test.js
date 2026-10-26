import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { models } from './models/index.js';
import { billableLines, billControlModels, matchBill, checkBillMatch, priceDifferenceLines } from './models/billcontrol.js';
import { accountId, invoiceLines, isBalanced } from './models/ledger.js';

const run = (db, model, id, label) => (billControlModels[model] ?? models[model]).form.buttons.find((b) => b.label === label).run(db, read(db, model, id));
const line = (product_id, qty = 10, price_unit = 20) => ({ product_id, qty, price_unit, tax: 0 });
const order = (lines = [line(1)]) => create(seed(), 'purchase.order', { partner_id: 2, order_line: lines });
const bill = (db, po, lines) => create(db, 'account.move', { move_type: 'in_invoice', partner_id: 2, purchase_id: po, invoice_line_ids: lines });
const receipt = (db, po, qty) => {
  const picking = search(db, 'stock.picking').find((p) => p.purchase_id === po && p.state === 'ready');
  const next = qty == null ? db : write(db, 'stock.picking', picking.id, { move_ids: picking.move_ids.map((l) => ({ ...l, quantity: qty })) });
  return run(next, 'stock.picking', picking.id, 'Validate').db;
};

test('bill control: seed loads and overrides retain valuation and purchase agreement definitions', () => {
  const db = seed();
  assert.ok(search(db, 'product').length);
  assert.ok(billControlModels.product.fields.cost_method);
  assert.ok(billControlModels.product.fields.purchase_method);
  assert.equal(billControlModels.product.defaults().purchase_method, 'receive');
  assert.ok(billControlModels['purchase.order'].fields.requisition_id);
  assert.ok(billControlModels['purchase.order'].form.buttons.some((b) => b.label === 'Choose Alternative'));
  assert.equal(billControlModels.product.fields.purchase_method.options[1][0], 'receive');
});

test('billable quantities distinguish ordered and received policy across partial receipts without mutation', () => {
  const out = order([{ ...line(1), qty_delivered: 4, qty_invoiced: 1 }, { ...line(2), qty_delivered: 4, qty_invoiced: 1 }]);
  const db = write(out.db, 'product', 1, { purchase_method: 'purchase' });
  const before = JSON.stringify(db);
  assert.deepEqual(billableLines(db, out.id), [
    { product_id: 1, ordered: 10, received: 4, billed: 1, toBill: 9 },
    { product_id: 2, ordered: 10, received: 4, billed: 1, toBill: 3 },
  ]);
  assert.equal(JSON.stringify(db), before);
  const over = write(db, 'purchase.order', out.id, { order_line: [{ ...line(1), qty_invoiced: 15 }] });
  assert.equal(billableLines(over, out.id)[0].toBill, 0);
  assert.throws(() => billableLines(db, -1), /not found/);
});

test('billing status and Create Bill follow partial receipt, backorder, and full billing', () => {
  const out = order();
  const confirmed = run(out.db, 'purchase.order', out.id, 'Confirm Order').db;
  assert.equal(read(confirmed, 'purchase.order', out.id).invoice_status, 'no');
  assert.throws(() => run(confirmed, 'purchase.order', out.id, 'Create Bill'), /eligible/);
  const partial = receipt(confirmed, out.id, 4);
  assert.equal(read(partial, 'purchase.order', out.id).invoice_status, 'to_invoice');
  const first = run(partial, 'purchase.order', out.id, 'Create Bill');
  const firstBill = search(first.db, 'account.move').find((b) => b.purchase_id === out.id);
  assert.equal(firstBill.invoice_line_ids[0].qty, 4);
  assert.equal(firstBill.invoice_line_ids[0].price_unit, 20);
  assert.equal(firstBill.invoice_origin, read(first.db, 'purchase.order', out.id).name);
  assert.equal(read(first.db, 'purchase.order', out.id).invoice_status, 'no');
  assert.throws(() => run(first.db, 'purchase.order', out.id, 'Create Bill'), /eligible/);
  const received = receipt(first.db, out.id);
  assert.equal(read(received, 'purchase.order', out.id).invoice_status, 'to_invoice');
  const final = run(received, 'purchase.order', out.id, 'Create Bill').db;
  assert.deepEqual(search(final, 'account.move').filter((b) => b.purchase_id === out.id).map((b) => b.invoice_line_ids[0].qty), [4, 6]);
  assert.equal(read(final, 'purchase.order', out.id).invoice_status, 'invoiced');
  assert.equal(read(out.db, 'purchase.order', out.id).order_line[0].qty_delivered, undefined);
});

test('ordered policy bills before receipt and cancelled draft bills release quantities', () => {
  const out = order();
  const db = write(out.db, 'product', 1, { purchase_method: 'purchase' });
  const confirmed = run(db, 'purchase.order', out.id, 'Confirm Order').db;
  assert.equal(read(confirmed, 'purchase.order', out.id).invoice_status, 'to_invoice');
  const billed = run(confirmed, 'purchase.order', out.id, 'Create Bill').db;
  const move = search(billed, 'account.move').find((m) => m.purchase_id === out.id);
  assert.equal(move.invoice_line_ids[0].qty, 10);
  assert.equal(read(billed, 'purchase.order', out.id).invoice_status, 'invoiced');
  const cancelled = run(billed, 'account.move', move.id, 'Cancel').db;
  assert.equal(billableLines(cancelled, out.id)[0].toBill, 10);
});

test('three-way match reports exact, excess quantity and price mismatch, including origin links', () => {
  const out = order([{ ...line(1), qty_delivered: 5 }]);
  const exact = bill(out.db, out.id, [line(1, 3)]);
  assert.deepEqual(matchBill(exact.db, exact.id), [{ product_id: 1, billedQty: 3, receivedQty: 5, orderedQty: 10, priceDifference: 0, status: 'ok' }]);
  const excess = bill(out.db, out.id, [line(1, 6)]);
  assert.equal(matchBill(excess.db, excess.id)[0].status, 'qty_exceeds_received');
  const price = create(out.db, 'account.move', { move_type: 'in_invoice', origin: read(out.db, 'purchase.order', out.id).name, invoice_line_ids: [line(1, 3, 22)] });
  assert.equal(matchBill(price.db, price.id)[0].status, 'price_differs');
  assert.equal(checkBillMatch(price.db, read(price.db, 'account.move', price.id))[0].priceDifference, 6);
  assert.throws(() => matchBill(out.db, -1), /not found/);
});

test('matching guard rejects cumulative excess across duplicate lines and posted bills; force post overrides', () => {
  const out = order([{ ...line(1), qty_delivered: 5 }]);
  const first = bill(out.db, out.id, [line(1, 3)]);
  const posted = write(first.db, 'account.move', first.id, { state: 'posted' });
  const second = bill(posted, out.id, [line(1, 1), line(1, 2)]);
  const record = read(second.db, 'account.move', second.id);
  assert.equal(matchBill(second.db, second.id)[1].status, 'qty_exceeds_received');
  assert.throws(() => checkBillMatch(second.db, record), /exceeds received/);
  assert.doesNotThrow(() => checkBillMatch(second.db, { ...record, force_post: true }));
  const ordered = write(second.db, 'product', 1, { purchase_method: 'purchase' });
  assert.doesNotThrow(() => checkBillMatch(ordered, record));
  assert.deepEqual(checkBillMatch(second.db, { move_type: 'out_invoice' }), []);
});

test('price adjustments balance both directions and clear actual receipt interim value with standard costing', () => {
  for (const price of [25, 15]) {
    const out = order([line(1, 4)]);
    const configured = write(out.db, 'product', 1, { cost: 12, cost_method: 'standard', valuation: 'real_time' });
    const received = receipt(run(configured, 'purchase.order', out.id, 'Confirm Order').db, out.id);
    const invoiced = bill(received, out.id, [line(1, 4, price)]);
    const record = read(invoiced.db, 'account.move', invoiced.id);
    const before = JSON.stringify(invoiced.db);
    const extra = priceDifferenceLines(invoiced.db, record);
    assert.ok(isBalanced(extra));
    const lines = [...invoiceLines(invoiced.db, record), ...extra];
    assert.ok(isBalanced(lines));
    const interim = accountId(invoiced.db, '110200');
    assert.equal(lines.filter((l) => l.account_id === interim).reduce((s, l) => s + l.debit - l.credit, 0), 80);
    const valuation = search(invoiced.db, 'stock.valuation.layer').find((l) => l.kind === 'in' && l.picking_id);
    assert.equal(valuation.value + valuation.price_difference, 80);
    assert.equal(extra.find((l) => l.account_id === accountId(invoiced.db, '600000')).debit - extra.find((l) => l.account_id === accountId(invoiced.db, '600000')).credit, (price - 20) * 4);
    assert.equal(JSON.stringify(invoiced.db), before);
    assert.deepEqual(priceDifferenceLines(invoiced.db, { ...record, move_type: 'out_invoice' }), []);
  }
});

test('price adjustments consume receipt values once across partial bills and ignore periodic products', () => {
  const out = order([line(1, 4)]);
  const configured = write(out.db, 'product', 1, { valuation: 'real_time' });
  const received = receipt(run(configured, 'purchase.order', out.id, 'Confirm Order').db, out.id);
  const first = bill(received, out.id, [line(1, 2, 22)]);
  const firstRecord = read(first.db, 'account.move', first.id);
  const posted = write(first.db, 'account.move', first.id, { state: 'posted' });
  const second = bill(posted, out.id, [line(1, 2, 22)]);
  const secondRecord = read(second.db, 'account.move', second.id);
  const balance = (db, record) => [...invoiceLines(db, record), ...priceDifferenceLines(db, record)].filter((l) => l.account_id === accountId(db, '110200')).reduce((s, l) => s + l.debit - l.credit, 0);
  assert.equal(balance(first.db, firstRecord) + balance(second.db, secondRecord), 80);
  const periodic = write(second.db, 'product', 1, { valuation: 'manual_periodic' });
  assert.deepEqual(priceDifferenceLines(periodic, secondRecord), []);
});
