import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { payOrder, refundOrder, sessionTotals, startSession } from './models/pos.js';
import { receive } from './models/valuation.js';
import { migrate } from './migrations.js';
import { applyDiff, diffDb, remapDiff } from './sync.js';

test('schema 10 historical return without valuation provenance fails safely', () => {
  let db = seed();
  const product = create(db, 'product', { name: 'Historical returned goods', type: 'goods', valuation: 'automated', cost_method: 'fifo', cost: 20, sale_ok: true });
  db = receive(product.db, product.id, 1, 10, { reference: 'Earlier stock' });
  db = receive(db, product.id, 2, 20, { reference: 'Historical return' });
  const config = search(db, 'pos.config')[0];
  db = startSession(db, 0, config.id).db;
  const session = search(db, 'pos.session').find((s) => s.state === 'opened');
  // A schema 10 order record, not a new order stripped of just its snapshot.
  const id = (db.seq['pos.order'] ?? 0) + 1;
  const historical = { id, name: 'Historical return', company_id: 1, config_id: config.id, session_id: session.id,
    state: 'paid', payment_method: 'cash', payment_ids: [{ method: 'cash', amount: -100 }],
    lines: [{ product_id: product.id, qty: -2, price_unit: 50, tax: 0 }], stock_costs: [] };
  db = migrate({ ...db, schema_version: 10, seq: { ...db.seq, 'pos.order': id },
    records: { ...db.records, 'pos.order': [...(db.records['pos.order'] ?? []), historical] } });
  const order = read(db, 'pos.order', id);
  assert.equal(order.preset_snapshot, undefined);
  assert.equal(order.return_layers, undefined);
  assert.equal(order.accounting_entries, undefined);
  const before = structuredClone(db);
  const layers = db.records['stock.valuation.layer'].filter((l) => l.product_id === product.id);
  assert.deepEqual(layers.map((l) => l.value), [10, 40]);
  assert.throws(() => refundOrder(db, order), /return valuation provenance.*historical orders require manual refund/i);
  assert.deepEqual(db, before, 'failed cancellation must not change stock, valuation, accounting or order state');
});

test('return with a missing valuation layer link fails safely', () => {
  let db = seed();
  const product = create(db, 'product', { name: 'Unlinked return', type: 'goods', valuation: 'automated', cost: 20, sale_ok: true });
  const config = search(product.db, 'pos.config')[0];
  const preset = create(product.db, 'pos.preset', { name: 'Return', is_return: true, identification: 'none' });
  db = write(preset.db, 'pos.config', config.id, { available_preset_ids: [preset.id], default_preset_id: preset.id });
  db = startSession(db, 0, config.id).db;
  const paid = payOrder(db, { lines: [{ product_id: product.id, qty: -1, price_unit: 50, tax: 0 }], method: 'cash' });
  db = write(paid.db, 'pos.order', paid.id, { return_layers: [{ index: 0, layer_id: null }] });
  const before = structuredClone(db);
  assert.throws(() => refundOrder(db, read(db, 'pos.order', paid.id)), /return valuation provenance/i);
  assert.deepEqual(db, before);
});

test('sale and return reversals survive edited archived presets, including missing snapshots', () => {
  for (const isReturn of [false, true]) for (const legacy of [false, true]) {
    let db = seed();
    const product = create(db, 'product', { name: 'Preset stock', type: 'goods', valuation: 'automated', cost: 20, sale_ok: true });
    db = product.db;
    if (!isReturn) db = receive(db, product.id, 2, 20);
    const config = search(db, 'pos.config')[0];
    const preset = create(db, 'pos.preset', { name: 'Original', is_return: isReturn, identification: 'none', pricelist_id: 123, fiscal_position_id: null });
    db = write(preset.db, 'pos.config', config.id, { available_preset_ids: [preset.id], default_preset_id: preset.id });
    db = startSession(db, 10, config.id).db;
    const session = search(db, 'pos.session').find((s) => s.state === 'opened');
    const qty = (state) => (state.records['stock.quant'] ?? []).filter((q) => q.product_id === product.id).reduce((s, q) => s + q.quantity, 0);
    const value = (state) => (state.records['stock.valuation.layer'] ?? []).filter((l) => l.product_id === product.id).reduce((s, l) => s + l.value, 0);
    const initial = [qty(db), value(db)];
    const paid = payOrder(db, { lines: [{ product_id: product.id, qty: isReturn ? -1 : 1, price_unit: 50, tax: 0 }], method: 'cash' });
    let order = read(paid.db, 'pos.order', paid.id);
    assert.deepEqual(order.preset_snapshot, { is_return: isReturn, identification: 'none', pricelist_id: 123, fiscal_position_id: null });
    assert.equal(sessionTotals(paid.db, session).cash, isReturn ? -50 : 50);
    db = write(paid.db, 'pos.preset', preset.id, { is_return: !isReturn, identification: 'address', active: false, pricelist_id: null });
    db = write(db, 'pos.config', config.id, { available_preset_ids: [], default_preset_id: null });
    if (legacy) db = write(db, 'pos.order', order.id, { preset_snapshot: null });
    order = read(db, 'pos.order', order.id);
    const reversed = refundOrder(db, order);
    assert.deepEqual([qty(reversed.db), value(reversed.db)], initial);
    assert.deepEqual([sessionTotals(reversed.db, session).cash, sessionTotals(reversed.db, session).expected], [0, 10]);
    assert.equal(read(reversed.db, 'pos.order', reversed.id).preset_snapshot.is_return, isReturn);
  }
});

test('return_layers follow remapped stock.valuation.layer ids in diffDb and queued bases immutably', () => {
  let db = seed();
  const product = create(db, 'product', { name: 'Remapped return', type: 'goods', valuation: 'real_time', cost: 20, sale_ok: true });
  const config = search(product.db, 'pos.config')[0];
  const preset = create(product.db, 'pos.preset', { name: 'Return', is_return: true, identification: 'none' });
  db = write(preset.db, 'pos.config', config.id, { available_preset_ids: [preset.id], default_preset_id: preset.id });
  db = startSession(db, 0, config.id).db;
  const returned = payOrder(db, { lines: [{ product_id: product.id, qty: -1, price_unit: 50, tax: 0 }], method: 'cash' });
  const order = read(returned.db, 'pos.order', returned.id);
  const originalLayerId = order.return_layers[0].layer_id;
  assert.ok(originalLayerId);

  const diff = diffDb(db, returned.db);
  const remapped = remapDiff(diff, { 'stock.valuation.layer': { [originalLayerId]: 88888 } });
  assert.equal(remapped.upserts['pos.order'][0].return_layers[0].layer_id, 88888);
  assert.equal(order.return_layers[0].layer_id, originalLayerId);
});

test('automated return committed through diffDb/applyDiff preserves return_layers and cancellation restores stock, valuation and drawer totals', () => {
  let db = seed();
  const product = create(db, 'product', { name: 'Persisted return', type: 'goods', valuation: 'real_time', cost: 20, sale_ok: true });
  const config = search(product.db, 'pos.config')[0];
  const preset = create(product.db, 'pos.preset', { name: 'Return', is_return: true, identification: 'none' });
  db = write(preset.db, 'pos.config', config.id, { available_preset_ids: [preset.id], default_preset_id: preset.id });
  db = startSession(db, 50, config.id).db;
  const session = search(db, 'pos.session').find((s) => s.state === 'opened');

  const returned = payOrder(db, { lines: [{ product_id: product.id, qty: -2, price_unit: 50, tax: 0 }], method: 'cash' });
  const committed = applyDiff(db, diffDb(db, returned.db), { author: 'test', isAdmin: false, allowed: null });
  const reloaded = JSON.parse(JSON.stringify(committed));
  const order = read(reloaded, 'pos.order', returned.id);

  assert.ok(order.return_layers?.length > 0);
  assert.equal(order.preset_snapshot?.is_return, true);

  const reversed = refundOrder(reloaded, order);
  const finalCommitted = applyDiff(reloaded, diffDb(reloaded, reversed.db), { author: 'test', isAdmin: false, allowed: null });
  const finalDb = JSON.parse(JSON.stringify(finalCommitted));

  const qty = (state) => (state.records['stock.quant'] ?? []).filter((q) => q.product_id === product.id).reduce((s, q) => s + q.quantity, 0);
  const val = (state) => (state.records['stock.valuation.layer'] ?? []).filter((l) => l.product_id === product.id).reduce((s, l) => s + l.value, 0);

  assert.equal(qty(finalDb), 0);
  assert.equal(val(finalDb), 0);
  assert.deepEqual(sessionTotals(finalDb, session), { orders: 2, cash: 0, card: 0, expected: 50 });
});
