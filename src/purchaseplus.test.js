import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { salesModels } from './models/sales.js';
import { models } from './models/index.js';
import { purchasePlusModels, vendorPrice, applyVendorPrices, confirmRequisition, newQuotationFromRequisition, remainingQty, compareAlternatives, chooseAlternative, closeRequisition, blanketExpiryCheck } from './models/purchaseplus.js';

const req = (db, vals = {}) => create(db, 'purchase.requisition', { date_start: '2026-01-01', date_end: '2026-12-31', vendor_id: 2, line_ids: [{ product_id: 1, product_qty: 10, price_unit: 25 }], ...vals });
const confirm = (db, id) => purchasePlusModels['purchase.order'].form.buttons.find((b) => b.label === 'Confirm Order').run(db, read(db, 'purchase.order', id)).db;
const info = (db, vals = {}) => create(db, 'product.supplierinfo', { partner_id: 2, product_id: 1, price: 30, delay: 4, ...vals }).db;

test('vendor prices use the order currency, date and units in purchase and tender actions', () => {
  let db = seed();
  const eur = create(db, 'res.currency', { name: 'TEST-EUR', rate_ids: [{ date: '2020-01-01', rate: 2 }, { date: '2021-01-01', rate: 4 }] });
  const foreign = create(eur.db, 'res.currency', { name: 'TEST-USD', rate_ids: [{ date: '2020-01-01', rate: 1 }] });
  const unit = search(foreign.db, 'uom.uom').find((u) => u.name === 'Units');
  const dozen = search(foreign.db, 'uom.uom').find((u) => u.name === 'Dozens');
  db = create(foreign.db, 'product.supplierinfo', { partner_id: 2, product_id: 1, price: 120, currency_id: foreign.id, uom_id: dozen.id, min_qty: 1 }).db;
  const po = create(db, 'purchase.order', { partner_id: 2, currency_id: eur.id, date_order: '2020-06-01', order_line: [{ product_id: 1, qty: 12, uom_id: unit.id, price_unit: 0 }] });
  const button = models['purchase.order'].form.buttons.find((b) => b.label === 'Apply Vendor Prices');
  db = button.run(po.db, read(po.db, 'purchase.order', po.id)).db;
  assert.equal(read(db, 'purchase.order', po.id).order_line[0].price_unit, 20);
  const agreement = create(db, 'purchase.requisition', { type: 'tender', currency_id: eur.id, line_ids: [{ product_id: 1, product_qty: 12 }] });
  const confirmButton = models['purchase.requisition'].form.buttons.find((b) => b.label === 'Confirm');
  db = confirmButton.run(agreement.db, read(agreement.db, 'purchase.requisition', agreement.id)).db;
  const newButton = models['purchase.requisition'].form.buttons.find((b) => b.label === 'New Quotation');
  const previousPrompt = globalThis.prompt;
  try { globalThis.prompt = () => '2'; db = newButton.run(db, read(db, 'purchase.requisition', agreement.id)).db; } finally { globalThis.prompt = previousPrompt; }
  const quotation = search(db, 'purchase.order').find((p) => p.requisition_id === agreement.id);
  assert.equal(quotation.currency_id, eur.id);
  assert.equal(quotation.order_line[0].price_unit, 40);
});

test('Apply Vendor Prices converts a legacy supplier currency name', () => {
  const source = create(seed(), 'res.currency', { name: 'LEGACY-FX', rate_ids: [{ date: '2020-01-01', rate: 2 }] });
  const target = create(source.db, 'res.currency', { name: 'ORDER-FX', rate_ids: [{ date: '2020-01-01', rate: 4 }] });
  const supplier = create(target.db, 'product.supplierinfo', { partner_id: 2, product_id: 1, price: 30, currency: 'LEGACY-FX' });
  const order = create(supplier.db, 'purchase.order', { partner_id: 2, currency_id: target.id, date_order: '2020-06-01', order_line: [{ product_id: 1, qty: 1, price_unit: 0 }] });
  const button = models['purchase.order'].form.buttons.find((b) => b.label === 'Apply Vendor Prices');
  const db = button.run(order.db, read(order.db, 'purchase.order', order.id)).db;
  assert.equal(read(db, 'purchase.order', order.id).order_line[0].price_unit, 60);
});

test('supplier prices filter vendor, product, inclusive dates and minimum quantity, then sequence and price', () => {
  let db = info(seed(), { date_start: '2026-02-01', date_end: '2026-02-28' });
  db = info(db, { price: 1, sequence: 0, date_end: '2026-01-31' });
  db = info(db, { price: 2, sequence: 0, date_start: '2026-03-01' });
  db = info(db, { price: 3, sequence: 0, min_qty: 20 });
  db = info(db, { price: 5, sequence: 20 });
  db = info(db, { price: 25, delay: 7 });
  db = info(db, { partner_id: 7, price: 10, sequence: 1 });
  const options = { partnerId: 2, qty: 10, date: '2026-02-01' };
  assert.deepEqual(vendorPrice(db, 1, options), { price: 25, delay: 7, partner_id: 2 });
  assert.equal(vendorPrice(db, 1, { ...options, qty: 20 }).price, 3);
  assert.equal(vendorPrice(db, 1, { ...options, partnerId: 7 }).price, 10);
  assert.equal(vendorPrice(db, 99, options), null);
  assert.equal(vendorPrice(db, 1, { ...options, partnerId: 99 }), null);
  const bounded = info(seed(), { date_start: '2026-02-01', date_end: '2026-02-28' });
  assert.equal(vendorPrice(bounded, 1, { ...options, date: '2026-02-28' }).price, 30);
  assert.equal(vendorPrice(bounded, 1, { ...options, date: '2026-03-01' }), null);
});

test('repricing preserves unmatched prices and inputs without changing the database', () => {
  const db = info(seed());
  const order = { partner_id: 2, date_order: '2026-02-01', order_line: [{ product_id: 1, qty: 5, price_unit: 99, tax: 14 }, { product_id: 2, qty: 1, price_unit: 77 }] };
  const snapshot = structuredClone(db);
  const out = applyVendorPrices(db, order);
  assert.deepEqual(out.order_line.map((l) => l.price_unit), [30, 77]);
  assert.equal(order.order_line[0].price_unit, 99);
  assert.equal(out.order_line[0].tax, 14);
  assert.deepEqual(db, snapshot);
});

test('blanket confirmation requires a vendor, prices, positive unique product quantities and valid dates', () => {
  for (const [vals, error] of [
    [{ vendor_id: null }, /vendor/],
    [{ line_ids: [{ product_id: 1, product_qty: 1 }] }, /prices/],
    [{ line_ids: [] }, /products/],
    [{ line_ids: [{ product_id: 1, product_qty: 0, price_unit: 2 }] }, /quantities/],
    [{ date_end: '2025-01-01' }, /date/],
    [{ line_ids: [{ product_id: 1, product_qty: 1, price_unit: 2 }, { product_id: 1, product_qty: 2, price_unit: 2 }] }, /one agreement line/],
  ]) {
    const out = req(seed(), vals);
    assert.throws(() => confirmRequisition(out.db, out.id), error);
    assert.equal(read(out.db, 'purchase.requisition', out.id).state, 'draft');
  }
});

test('blanket quotations use remaining confirmed quantities, agreement prices and existing receipt flow', () => {
  const base = req(seed());
  assert.throws(() => newQuotationFromRequisition(base.db, base.id), /Confirm/);
  const ongoing = confirmRequisition(base.db, base.id);
  assert.throws(() => newQuotationFromRequisition(ongoing, base.id, { partnerId: 7 }), /vendor/);
  const first = newQuotationFromRequisition(ongoing, base.id);
  assert.equal(read(first.db, 'purchase.order', first.id).order_line[0].price_unit, 25);
  const partial = write(first.db, 'purchase.order', first.id, { order_line: [{ product_id: 1, qty: 4, price_unit: 25, tax: 14 }] });
  const confirmed = confirm(partial, first.id);
  assert.equal(remainingQty(confirmed, base.id)[0].remaining, 6);
  assert.equal(read(confirmed, 'purchase.requisition', base.id).line_ids[0].qty_ordered, 4);
  assert.equal(read(partial, 'purchase.requisition', base.id).line_ids[0].qty_ordered, 0);
  assert.ok(search(confirmed, 'stock.picking').some((p) => p.purchase_id === first.id));
  const second = newQuotationFromRequisition(confirmed, base.id);
  const third = newQuotationFromRequisition(second.db, base.id);
  assert.equal(read(second.db, 'purchase.order', second.id).order_line[0].qty, 6);
  const done = confirm(third.db, second.id);
  assert.equal(remainingQty(done, base.id)[0].qty_ordered, 10);
  assert.throws(() => confirm(done, third.id), /remaining quantity/);
  assert.throws(() => newQuotationFromRequisition(done, base.id), /No quantity/);
  assert.equal(read(done, 'purchase.requisition', base.id).purchase_ids.length, 3);
});

test('tenders compare two vendor offers and choosing one confirms it and cancels draft alternatives', () => {
  const base = req(info(info(seed(), { price: 20, delay: 3 }), { partner_id: 7, price: 18, delay: 8 }), { type: 'tender', vendor_id: null });
  const ongoing = confirmRequisition(base.db, base.id);
  assert.throws(() => newQuotationFromRequisition(ongoing, base.id), /vendor/);
  const first = newQuotationFromRequisition(ongoing, base.id, { partnerId: 2 });
  const second = newQuotationFromRequisition(first.db, base.id, { partnerId: 7 });
  const compared = compareAlternatives(second.db, base.id)[0];
  assert.deepEqual(compared.alternatives.map((a) => [a.partner_id, a.price, a.total, a.delay, a.best]), [[2, 20, 228, 3, false], [7, 18, 205.2, 8, true]]);
  const sent = write(second.db, 'purchase.order', first.id, { state: 'sent' });
  const chosen = chooseAlternative(sent, second.id);
  assert.equal(read(chosen, 'purchase.order', second.id).state, 'purchase');
  assert.equal(read(chosen, 'purchase.order', first.id).state, 'cancel');
  assert.equal(read(sent, 'purchase.order', first.id).state, 'sent');
  assert.throws(() => chooseAlternative(chosen, first.id), /already/);
  assert.equal(newQuotationFromRequisition(chosen, base.id, { partnerId: 2 }).db.records['purchase.order'].at(-1).order_line[0].qty, 10);
});

test('blanket close refuses open RFQs unless forced; expiry closes only ongoing expired agreements', () => {
  const base = req(seed(), { date_end: '2026-06-01' });
  assert.throws(() => closeRequisition(base.db, base.id), /ongoing/);
  const ongoing = confirmRequisition(base.db, base.id);
  const quote = newQuotationFromRequisition(ongoing, base.id);
  assert.throws(() => closeRequisition(quote.db, base.id), /draft quotations/);
  assert.equal(read(closeRequisition(quote.db, base.id, { force: true }), 'purchase.requisition', base.id).state, 'done');
  assert.equal(read(blanketExpiryCheck(quote.db, '2026-06-01'), 'purchase.requisition', base.id).state, 'ongoing');
  const draftReq = req(quote.db, { date_end: '2026-01-01' });
  const expired = blanketExpiryCheck(draftReq.db, '2026-06-02');
  assert.equal(read(expired, 'purchase.requisition', base.id).state, 'done');
  assert.equal(read(expired, 'purchase.requisition', draftReq.id).state, 'draft');
  assert.equal(read(closeRequisition(ongoing, base.id), 'purchase.requisition', base.id).state, 'done');
});

test('seed still loads and the purchase override preserves fields, buttons and receipt/bill relations', () => {
  const db = seed();
  assert.ok(search(db, 'purchase.order').length >= 2);
  const original = salesModels['purchase.order'];
  const model = purchasePlusModels['purchase.order'];
  for (const key of Object.keys(original.fields)) assert.equal(model.fields[key], original.fields[key]);
  for (const button of original.form.buttons) assert.ok(model.form.buttons.some((b) => b.label === button.label));
  assert.deepEqual(model.form.smart.slice(0, 2), original.form.smart);
  assert.equal(model.form.smart.at(-1).key, 'requisition_id');
  assert.equal(purchasePlusModels['product.supplierinfo'].label, 'Vendor Pricelists');
});

test('replenishment orders from the best vendor pricelist line', async () => {
  const { replenish } = await import('./models/routes.js');
  let db = seed();
  const product = search(db, 'product').find((p) => p.type === 'goods');
  const vendor = search(db, 'res.partner').at(-1);
  const wh = search(db, 'stock.warehouse').find((w) => w.code === 'WH') ?? search(db, 'stock.warehouse')[0];
  db = write(db, 'product', product.id, { vendor_id: null });
  const q = search(db, 'stock.quant').find((x) => x.product_id === product.id && x.location_id === wh.lot_stock_id);
  const onHand = q ? q.quantity : Number(product.qty_available) || 0;
  db = create(db, 'stock.warehouse.orderpoint', {
    product_id: product.id, warehouse_id: wh.id, location_id: wh.lot_stock_id,
    product_min_qty: onHand + 5, product_max_qty: onHand + 5, trigger: 'auto', route_id: 'buy',
  }).db;
  db = create(db, 'product.supplierinfo', { partner_id: vendor.id, product_id: product.id, min_qty: 0, price: 7.5 }).db;
  const before = search(db, 'purchase.order').length;
  const rfq = search(replenish(db), 'purchase.order').slice(before).find((po) => po.order_line.some((l) => l.product_id === product.id));
  assert.equal(rfq.partner_id, vendor.id);
  assert.equal(rfq.order_line.find((l) => l.product_id === product.id).price_unit, 7.5);
});

test('replenishment rounds up to a vendor minimum and skips products without a valid vendor', async () => {
  const { replenish } = await import('./models/routes.js');
  let db = seed();
  const product = search(db, 'product').find((p) => p.type === 'goods');
  const vendor = search(db, 'res.partner').at(-1);
  const wh = search(db, 'stock.warehouse').find((w) => w.code === 'WH') ?? search(db, 'stock.warehouse')[0];
  db = write(db, 'product', product.id, { vendor_id: null, qty_available: 0.5 });
  const q = search(db, 'stock.quant').find((x) => x.product_id === product.id && x.location_id === wh.lot_stock_id);
  if (q) db = write(db, 'stock.quant', q.id, { quantity: 0.5 });
  db = create(db, 'stock.warehouse.orderpoint', {
    product_id: product.id, warehouse_id: wh.id, location_id: wh.lot_stock_id,
    product_min_qty: 1, product_max_qty: 1, trigger: 'auto', route_id: 'buy',
  }).db;
  db = create(db, 'product.supplierinfo', { partner_id: vendor.id, product_id: product.id, min_qty: 10, price: 4 }).db;
  const before = search(db, 'purchase.order').length;
  const line = search(replenish(db), 'purchase.order').slice(before).flatMap((po) => po.order_line).find((l) => l.product_id === product.id);
  assert.equal(line.qty, 10);
  assert.equal(line.price_unit, 4);
  const expired = write(db, 'product.supplierinfo', search(db, 'product.supplierinfo').at(-1).id, { date_end: '2000-01-01' });
  assert.doesNotThrow(() => replenish(expired));
});
