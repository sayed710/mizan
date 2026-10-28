import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { confirmRepair, startRepair, endRepair, receiveProduct, sendQuotation, repairTotal, createInvoice, repairAnalysis, repairPlusModels } from './models/repairplus.js';
import { today } from './models/common.js';

const part = (extra = {}) => ({ product_id: 9, qty: 1, price_unit: 10, tax: 14, type: 'add', ...extra });
const order = (db = seed(), vals = {}) => create(db, 'repair.order', { product_id: 1, partner_id: 3, parts: [part()], ...vals });
const finish = (db, id, date = today()) => endRepair(startRepair(confirmRepair(db, id, date), id, date), id, date);

test('repair confirmation requires a matching lot and sufficient aggregate stock', () => {
  const base = write(seed(), 'product', 1, { tracking: 'serial' });
  const r = order(base);
  assert.throws(() => confirmRepair(r.db, r.id), /lot\/serial/);
  const lot = create(r.db, 'stock.lot', { name: 'REPAIR-1', product_id: 1 });
  const lotted = write(lot.db, 'repair.order', r.id, { lot_id: lot.id });
  assert.equal(read(confirmRepair(lotted, r.id), 'repair.order', r.id).state, 'confirmed');
  const wrong = create(lotted, 'stock.lot', { name: 'WRONG', product_id: 9 });
  assert.throws(() => confirmRepair(write(wrong.db, 'repair.order', r.id, { lot_id: wrong.id }), r.id), /belonging/);
  const qty = read(lotted, 'product', 9).qty_available;
  const short = write(lotted, 'repair.order', r.id, { parts: [part({ qty }), part()] });
  assert.throws(() => confirmRepair(short, r.id), /not enough stock/);
  assert.equal(read(r.db, 'repair.order', r.id).state, 'draft');
});

test('end repair values added and removed parts once and preserves the input database', () => {
  const r = order(seed(), { parts: [part({ qty: 2 }), part({ product_id: 8, type: 'remove', qty: 3 })] });
  const before = [9, 8].map((id) => read(r.db, 'product', id).qty_available);
  const snapshot = JSON.stringify(r.db);
  assert.throws(() => endRepair(r.db, r.id), /Start/);
  const done = finish(r.db, r.id);
  assert.equal(JSON.stringify(r.db), snapshot);
  assert.deepEqual([9, 8].map((id) => read(done, 'product', id).qty_available), [before[0] - 2, before[1] + 3]);
  const layers = search(done, 'stock.valuation.layer').filter((l) => l.reference === read(done, 'repair.order', r.id).name);
  assert.deepEqual(layers.map((l) => [l.product_id, l.quantity, l.kind]), [[9, -2, 'out'], [8, 3, 'in']]);
  assert.ok(layers.every((l) => l.move_id));
  assert.strictEqual(endRepair(done, r.id), done);
});

test('warranty covers parts and labour through the expiry date but not after it', () => {
  const r = order(seed(), { schedule_date: '2026-01-10', under_warranty: true, guarantee_limit: '2026-01-10',
    operations: [{ name: 'Labour', hours: 2, price_unit: 25, tax: 14 }] });
  assert.deepEqual(repairTotal(r.db, r.id), { parts: 0, operations: 0, untaxed: 0, tax: 0, total: 0 });
  const expired = write(r.db, 'repair.order', r.id, { schedule_date: '2026-01-11' });
  assert.deepEqual(repairTotal(expired, r.id), { parts: 10, operations: 50, untaxed: 60, tax: 8.4, total: 68.4 });
  const covered = write(expired, 'repair.order', r.id, { schedule_date: '2026-01-10' });
  assert.equal(read(covered, 'repair.order', r.id).parts[0].warranty_free, true);
  const off = write(covered, 'repair.order', r.id, { under_warranty: false });
  assert.equal(repairTotal(off, r.id).total, 68.4);
  assert.equal(read(off, 'repair.order', r.id).amount_total, 68.4);
});

test('invoice excludes free and removed parts, converts labour hours and is created once', () => {
  const r = order(seed(), { parts: [part(), part({ warranty_free: true }), part({ type: 'remove' })],
    operations: [{ name: 'Assembly', hours: 2, price_unit: 25, tax: 14 }] });
  assert.throws(() => createInvoice(r.db, r.id), /Finish/);
  const done = finish(r.db, r.id);
  const result = createInvoice(done, r.id);
  const invoice = read(result.db, 'account.move', result.invoiceId);
  assert.equal(invoice.state, 'draft');
  assert.equal(invoice.move_type, 'out_invoice');
  assert.equal(invoice.partner_id, 3);
  assert.deepEqual(invoice.invoice_line_ids.map((l) => [l.qty, l.price_unit]), [[1, 10], [2, 25]]);
  assert.equal(invoice.amount_total, repairTotal(done, r.id).total);
  assert.deepEqual(createInvoice(result.db, r.id), result);
  assert.equal(search(result.db, 'account.move').length, search(done, 'account.move').length + 1);
  const early = createInvoice(r.db, r.id, true);
  assert.equal(read(early.db, 'repair.order', r.id).state, 'draft');
  const freeOrder = order(seed(), { under_warranty: true });
  assert.throws(() => createInvoice(freeOrder.db, freeOrder.id, true), /no billable/);
});

test('customer receipt retains product and lot, links once and does not move stock until validated', () => {
  const base = write(seed(), 'product', 1, { tracking: 'lot' });
  const lot = create(base, 'stock.lot', { name: 'RETURN-1', product_id: 1 });
  const r = order(lot.db, { lot_id: lot.id });
  const received = receiveProduct(r.db, r.id);
  const picking = read(received, 'stock.picking', read(received, 'repair.order', r.id).picking_id);
  assert.equal(picking.picking_type, 'incoming');
  assert.equal(picking.state, 'ready');
  assert.equal(picking.partner_id, 3);
  assert.equal(picking.origin, read(r.db, 'repair.order', r.id).name);
  assert.deepEqual(picking.move_ids, [{ product_id: 1, qty: 1, lot_id: lot.id, lot_name: 'RETURN-1' }]);
  assert.strictEqual(receiveProduct(received, r.id), received);
  assert.equal(read(received, 'product', 1).qty_available, read(r.db, 'product', 1).qty_available);
});

test('analysis filters inclusive dates, counts states, averages confirm-to-done days and untaxed revenue', () => {
  const a = order(seed(), { schedule_date: today() });
  const confirmed = confirmRepair(a.db, a.id, '2020-01-01');
  const done = endRepair(startRepair(confirmed, a.id, '2020-01-02'), a.id);
  const b = order(done, { schedule_date: today() });
  const report = repairAnalysis(b.db, { from: today(), to: today() });
  assert.equal(report.counts.done, 1);
  assert.equal(report.counts.draft, 1);
  assert.equal(report.revenue, 10);
  assert.equal(report.averageDuration, (new Date(today()) - new Date('2020-01-01')) / 86400000);
  assert.deepEqual(repairAnalysis(b.db, { from: '1900-01-01', to: '1900-01-02' }), {
    counts: { draft: 0, confirmed: 0, progress: 0, done: 0, cancel: 0 }, averageDuration: 0, revenue: 0,
  });
});

test('seed repair stays compatible and the form exposes legacy and new actions', () => {
  const db = seed();
  assert.ok(search(db, 'repair.order').some((r) => r.state === 'confirmed' && r.parts.length));
  const model = repairPlusModels['repair.order'];
  assert.equal(model.kanban.groupBy, 'state');
  assert.deepEqual(model.form.buttons.map((b) => b.label), ['Send Quotation', 'Confirm Repair', 'Receive Product', 'Start Repair', 'End Repair', 'Create Invoice', 'Cancel']);
  assert.ok(model.fields.internal_notes);
  const r = order(db);
  const sent = sendQuotation(r.db, r.id);
  assert.equal(read(sent, 'repair.order', r.id).quotation_sent, true);
  assert.equal(sent.messages.filter((m) => m.model === 'repair.order' && m.res_id === r.id && m.kind === 'note').length, 1);
  assert.strictEqual(sendQuotation(sent, r.id), sent);
});
