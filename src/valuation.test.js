import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { accountId, isBalanced } from './models/ledger.js';
import { salesModels } from './models/sales.js';
import { applyCount, costMethod, deliver, postValuation, receive, revalue, startCount, valuationModels, valuationReport } from './models/valuation.js';
import { addDays, today } from './models/common.js';

const date = '2026-10-01';
const setup = (method = 'fifo', valuation = 'real_time') => create(seed(), 'product', {
  name: 'Valued widget', type: 'goods', cost: 10, qty_available: 0, cost_method: method, valuation,
});
const layers = (db, id) => search(db, 'stock.valuation.layer').filter((l) => l.product_id === id);
const report = (db, id, at = addDays(today(), 365)) => valuationReport(db, { at })[id];
const entryFor = (db, layer) => read(db, 'account.move', layer.move_id);
const balance = (db, entry, code) => entry.line_ids.filter((l) => l.account_id === accountId(db, code)).reduce((s, l) => s + l.debit - l.credit, 0);
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test('FIFO consumes two receipts in date/id order over three deliveries with a partial remaining layer', () => {
  const { db: base, id } = setup();
  const original = structuredClone(base);
  let db = receive(base, id, 10, 10, { date, reference: 'First' });
  db = receive(db, id, 10, 20, { date: '2026-10-02', reference: 'Second' });
  const first = deliver(db, id, 6, { date: '2026-10-03' });
  const second = deliver(first.db, id, 7, { date: '2026-10-04' });
  const third = deliver(second.db, id, 2, { date: '2026-10-05' });
  assert.deepEqual([first.value, second.value, third.value], [60, 100, 40]);
  assert.deepEqual(layers(third.db, id).filter((l) => l.kind === 'in').map((l) => [l.remaining_qty, l.remaining_value]), [[0, 0], [5, 100]]);
  assert.deepEqual(report(third.db, id), { qty: 5, value: 100, unitCost: 20 });
  assert.equal(read(third.db, 'product', id).qty_available, 5);
  assert.deepEqual(base, original);
});

test('average recomputes weighted on-hand cost on each receipt and costs subsequent deliveries', () => {
  const { db: base, id } = setup('average');
  let db = receive(base, id, 10, 10, { date });
  assert.equal(read(db, 'product', id).cost, 10);
  db = receive(db, id, 10, 20, { date });
  assert.equal(read(db, 'product', id).cost, 15);
  const out = deliver(db, id, 4, { date });
  assert.equal(out.value, 60);
  db = receive(out.db, id, 4, 30, { date });
  assert.equal(read(db, 'product', id).cost, 18);
  const again = deliver(db, id, 5, { date });
  assert.equal(again.value, 90);
  assert.deepEqual(report(again.db, id), { qty: 15, value: 270, unitCost: 18 });
  assert.equal(layers(again.db, id).reduce((s, l) => s + l.remaining_value, 0), 270);
});

test('standard receipts use standard value and book positive and negative price differences', () => {
  const { db: base, id } = setup('standard');
  let db = receive(base, id, 5, 13, { date });
  const l = layers(db, id)[0];
  assert.deepEqual([l.unit_cost, l.value, l.price_difference], [10, 50, 15]);
  const entry = entryFor(db, l);
  assert.equal(balance(db, entry, '110100'), 50);
  assert.equal(balance(db, entry, '110200'), -65);
  assert.equal(balance(db, entry, '600000'), 15);
  db = receive(db, id, 5, 8, { date });
  assert.equal(balance(db, entryFor(db, layers(db, id)[1]), '600000'), -10);
  assert.equal(read(db, 'product', id).cost, 10);
  assert.equal(deliver(db, id, 3, { date }).value, 30);
});

test('fractional average deliveries use the current average and full depletion clears all remaining value', () => {
  const { db: base, id } = setup('average');
  let db = receive(base, id, 1, 0.01, { date });
  db = receive(db, id, 1, 0.01, { date });
  db = receive(db, id, 1, 0.01, { date });
  const half = deliver(db, id, 1.5, { date });
  assert.equal(half.value, 0.02);
  const rest = deliver(half.db, id, 1.5, { date });
  assert.equal(rest.value, 0.01);
  assert.deepEqual(report(rest.db, id), { qty: 0, value: 0, unitCost: 0 });
  assert.ok(layers(rest.db, id).every((l) => l.remaining_qty === 0 && l.remaining_value === 0));
});

test('automated layer entries are posted and balanced, delivery uses COGS, and reposting is a no-op', () => {
  const { db: base, id } = setup();
  const db = deliver(receive(base, id, 10, 10, { date }), id, 3, { date }).db;
  for (const l of layers(db, id)) {
    const entry = entryFor(db, l);
    assert.equal(entry.state, 'posted');
    assert.equal(entry.invoice_date, date);
    assert.ok(isBalanced(entry.line_ids));
    assert.strictEqual(postValuation(db, l.id), db);
  }
  const entry = entryFor(db, layers(db, id).at(-1));
  assert.equal(balance(db, entry, '500000'), 30);
  assert.equal(balance(db, entry, '110100'), -30);
});

test('manual periodic receipts, deliveries, revaluation and counts post no journal entries', () => {
  const { db: base, id } = setup('average', 'manual_periodic');
  const before = search(base, 'account.move').length;
  let db = receive(base, id, 10, 15, { date });
  db = deliver(db, id, 2, { date }).db;
  db = revalue(db, id, 20, { date });
  const count = startCount(db, { productIds: [id], date });
  db = write(count.db, 'stock.inventory.count', count.id, { line_ids: [{ product_id: id, theoretical_qty: 8, counted_qty: 9 }] });
  db = applyCount(db, count.id);
  assert.equal(search(db, 'account.move').length, before);
  for (const l of layers(db, id)) {
    assert.ok(!l.move_id);
    assert.strictEqual(postValuation(db, l.id), db);
  }
});

test('FIFO revaluation scales remaining values proportionally and preserves historical report totals', () => {
  const { db: base, id } = setup();
  let db = receive(base, id, 10, 10, { date });
  db = receive(db, id, 10, 20, { date });
  db = revalue(db, id, 30, { date: '2026-10-02' });
  const ls = layers(db, id);
  assert.deepEqual(ls.slice(0, 2).map((l) => [l.value, l.remaining_value]), [[100, 200], [200, 400]]);
  assert.deepEqual([ls[2].quantity, ls[2].value, ls[2].kind], [0, 300, 'revaluation']);
  assert.ok(isBalanced(entryFor(db, ls[2]).line_ids));
  assert.deepEqual(report(db, id, date), { qty: 20, value: 300, unitCost: 15 });
  assert.deepEqual(report(db, id), { qty: 20, value: 600, unitCost: 30 });
  const out = deliver(db, id, 12, { date: '2026-10-03' });
  assert.equal(out.value, 280);
  assert.deepEqual(report(out.db, id), { qty: 8, value: 320, unitCost: 40 });
});

test('average and standard revaluation update product cost and cost future deliveries at the new rate', () => {
  for (const method of ['average', 'standard']) {
    const { db: base, id } = setup(method);
    let db = receive(base, id, 10, 10, { date });
    db = revalue(db, id, 7, { date: '2026-10-02' });
    assert.equal(layers(db, id).at(-1).value, -30);
    assert.equal(read(db, 'product', id).cost, 7);
    const out = deliver(db, id, 3, { date: '2026-10-02' });
    assert.equal(out.value, 21);
    assert.deepEqual(report(out.db, id), { qty: 7, value: 49, unitCost: 7 });
  }
});

test('small revaluations allocate cents without negative remaining values, including zero-cost stock', () => {
  const { db: base, id } = setup('average');
  let db = base;
  for (let i = 0; i < 4; i++) db = receive(db, id, 1, 0, { date });
  db = revalue(db, id, 0.005, { date });
  assert.equal(report(db, id).value, 0.02);
  assert.ok(layers(db, id).every((l) => l.remaining_value >= 0));
  assert.equal(layers(db, id).reduce((s, l) => s + l.remaining_value, 0), 0.02);
  const out = deliver(db, id, 4, { date });
  assert.equal(out.value, 0.02);
  assert.deepEqual(report(out.db, id), { qty: 0, value: 0, unitCost: 0 });
});

test('physical inventory snapshots quantities and posts gains and FIFO losses once', () => {
  const { db: base, id } = setup();
  const stocked = receive(base, id, 10, 10, { date });
  const gain = startCount(stocked, { productIds: [id], date });
  assert.deepEqual(read(gain.db, 'stock.inventory.count', gain.id).line_ids, [{ product_id: id, theoretical_qty: 10, counted_qty: 10 }]);
  let db = write(gain.db, 'stock.inventory.count', gain.id, { line_ids: [{ product_id: id, theoretical_qty: 10, counted_qty: 12 }] });
  db = applyCount(db, gain.id);
  assert.equal(read(db, 'stock.inventory.count', gain.id).state, 'done');
  assert.equal(read(db, 'product', id).qty_available, 12);
  assert.equal(balance(db, entryFor(db, layers(db, id).at(-1)), '600000'), -20);
  assert.throws(() => applyCount(db, gain.id), /in progress/);
  const loss = startCount(db, { productIds: [id], date });
  db = write(loss.db, 'stock.inventory.count', loss.id, { line_ids: [{ product_id: id, theoretical_qty: 12, counted_qty: 8 }] });
  db = applyCount(db, loss.id);
  const l = layers(db, id).at(-1);
  assert.deepEqual([l.kind, l.quantity, l.value], ['adjustment', -4, -40]);
  assert.equal(balance(db, entryFor(db, l), '600000'), 40);
  assert.deepEqual(report(db, id), { qty: 8, value: 80, unitCost: 10 });
  const lineFields = valuationModels['stock.inventory.count'].fields.line_ids.fields;
  assert.equal(lineFields.theoretical_qty.readonly, true);
  assert.equal(lineFields.difference.compute({ theoretical_qty: 12, counted_qty: 8 }), -4);
});

test('inventory refuses stale snapshots, duplicate products and negative counts', () => {
  const { db: base, id } = setup();
  const db = receive(base, id, 10, 10, { date });
  const count = startCount(db, { productIds: [id], date });
  const changed = receive(count.db, id, 1, 10, { date });
  assert.throws(() => applyCount(changed, count.id), /Stock changed/);
  assert.throws(() => startCount(db, { productIds: [id, id], date }), /distinct/);
  const invalid = write(count.db, 'stock.inventory.count', count.id, { line_ids: [{ product_id: id, theoretical_qty: 10, counted_qty: -1 }] });
  assert.throws(() => applyCount(invalid, count.id), /nonnegative/);
});

test('invalid valuation actions refuse safely, including overselling and backdated FIFO operations', () => {
  const { db: base, id } = setup();
  const db = receive(base, id, 1, 10, { date });
  const snapshot = structuredClone(db);
  assert.throws(() => deliver(db, id, 2, { date }), /Not enough stock/);
  assert.throws(() => receive(db, id, 0, 10, { date }), /positive/);
  assert.throws(() => receive(db, id, 1, Infinity, { date }), /nonnegative/);
  assert.throws(() => receive(db, id, 1, 10, { date: '2026-09-30' }), /precede/);
  assert.throws(() => receive(db, id, 1, 10, { date: '2026-02-30' }), /valid valuation date/);
  assert.throws(() => revalue(db, id, -1, { date }), /nonnegative/);
  assert.throws(() => costMethod(db, -1), /stockable/);
  assert.deepEqual(db, snapshot);
});

test('seed loads with preserved product fields, defaults, opening quantities and historical report cutoff', () => {
  const base = seed();
  for (const field of Object.keys(salesModels.product.fields)) assert.ok(valuationModels.product.fields[field]);
  assert.equal(valuationModels.product.defaults(1).cost_method, 'standard');
  assert.equal(valuationModels.product.defaults(1).valuation, 'real_time');
  for (const p of search(base, 'product').filter((p) => p.type === 'goods')) close(report(base, p.id).qty, p.qty_available);
  const p = search(base, 'product').find((p) => p.type === 'goods' && p.qty_available > 0 && !layers(base, p.id).length);
  const db = receive(base, p.id, 3, p.cost, { date });
  assert.equal(layers(db, p.id)[0].opening, true);
  assert.ok(!layers(db, p.id)[0].move_id);
  assert.equal(report(db, p.id, '2026-09-30').qty, p.qty_available);
  assert.equal(report(db, p.id).qty, read(db, 'product', p.id).qty_available);
});
