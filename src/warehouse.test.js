import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { models } from './models/index.js';
import { createPicking } from './models/sales.js';
import { locationStock } from './models/routes.js';
import { seed } from './seed.js';
import { warehouseModels, ensureMainWarehouse, ensureWarehouseLocations, planTransfers, createOrderTransfers, validateWarehousePicking, resupplyTransfer, warehouseQty } from './models/warehouse.js';

// The orchestrator installs these definitions in production; keep registration local to this test process.
Object.assign(models, warehouseModels);
const line = (qty) => [{ product_id: 7, qty }];
const whId = (db) => search(db, 'stock.warehouse').find((w) => w.code === 'WH').id;
const transfers = (db, origin) => search(db, 'stock.picking').filter((p) => p.origin === origin);
const validate = (db, id) => warehouseModels['stock.picking'].form.buttons.find((b) => b.label === 'Validate').run(db, read(db, 'stock.picking', id)).db;
const countEntries = (db) => search(db, 'account.move').length;
const located = (db, product, location) => locationStock(db, product).find((l) => l.location_id === location)?.qty ?? 0;
function configured(vals = {}) {
  const db = ensureMainWarehouse(seed());
  return write(db, 'stock.warehouse', whId(db), vals);
}
function receipt(db, qty = 10, origin = 'Warehouse receipt') {
  const next = createOrderTransfers(db, { type: 'incoming', warehouse_id: whId(db), origin, lines: line(qty) });
  return validate(next, transfers(next, origin)[0].id);
}

test('seed loads and main warehouse initialization is immutable and idempotent', () => {
  const base = seed();
  const snapshot = structuredClone(base);
  const db = ensureMainWarehouse(base);
  assert.deepEqual(base, snapshot);
  assert.strictEqual(ensureMainWarehouse(db), db);
  assert.equal(search(db, 'stock.warehouse').length, 1);
  const wh = read(db, 'stock.warehouse', whId(db));
  assert.equal(search(db, 'stock.location').filter((l) => l.name === 'WH/Stock').length, 1);
  for (const field of ['lot_stock_id', 'wh_input_stock_loc_id', 'wh_qc_stock_loc_id', 'wh_pack_stock_loc_id', 'wh_output_stock_loc_id']) {
    assert.equal(read(db, 'stock.location', wh[field]).usage, 'internal');
  }
  assert.throws(() => create(db, 'stock.warehouse', { name: 'Duplicate', code: 'wh' }), /unique/);
  assert.throws(() => ensureWarehouseLocations(db, -1), /warehouse/);
});

test('without a warehouse the order hook preserves the legacy ready transfer exactly', () => {
  const s = seed(); const db = { ...s, records: { ...s.records, 'stock.warehouse': [] } };
  const args = { type: 'outgoing', partner_id: 1, origin: 'Legacy', lines: [...line(2), { product_id: 6, qty: 1 }], link: { sale_id: 1 } };
  const next = createPicking(db, args);
  const expected = create(db, 'stock.picking', { picking_type: 'outgoing', partner_id: 1, origin: 'Legacy', move_ids: line(2), state: 'ready', carrier_id: null, sale_id: 1 }).db;
  assert.deepEqual(next.records, expected.records);
  assert.deepEqual(next.seq, expected.seq);
});

test('one-step warehouse receipt and delivery each value stock exactly once', () => {
  const db = configured();
  const qty = read(db, 'product', 7).qty_available;
  const received = receipt(db);
  assert.equal(read(received, 'product', 7).qty_available, qty + 10);
  assert.equal(transfers(received, 'Warehouse receipt').length, 1);
  const planned = createPicking(received, { type: 'outgoing', origin: 'One ship', lines: line(4) });
  const done = validate(planned, transfers(planned, 'One ship')[0].id);
  assert.equal(read(done, 'product', 7).qty_available, qty + 6);
  assert.equal(warehouseQty(done, 7, whId(done)), 6);
  assert.equal(countEntries(done), countEntries(db) + 2);
});

test('two-step receipt values at Input only, then moves to Stock without another entry', () => {
  const db = configured({ reception_steps: 'two_steps' });
  const start = createOrderTransfers(db, { type: 'incoming', warehouse_id: whId(db), origin: 'Two receive', lines: line(10) });
  const [input, stock] = transfers(start, 'Two receive');
  assert.deepEqual([input.state, stock.state], ['ready', 'waiting']);
  assert.throws(() => validate(start, stock.id), /preceding/);
  const received = validate(start, input.id);
  const wh = read(received, 'stock.warehouse', whId(received));
  assert.equal(located(received, 7, wh.wh_input_stock_loc_id), 10);
  assert.equal(warehouseQty(received, 7, wh.id), 10);
  assert.equal(read(received, 'stock.picking', stock.id).state, 'ready');
  const done = validate(received, stock.id);
  assert.equal(located(done, 7, wh.wh_input_stock_loc_id), 0);
  assert.equal(located(done, 7, wh.lot_stock_id), 10);
  assert.equal(countEntries(done), countEntries(db) + 1);
  assert.equal(read(done, 'product', 7).qty_available, read(db, 'product', 7).qty_available + 10);
});

test('three-step delivery releases pick/pack/ship in order and only shipment values stock', () => {
  const db = receipt(configured({ delivery_steps: 'pick_pack_ship' }));
  const qty = read(db, 'product', 7).qty_available;
  const start = createOrderTransfers(db, { type: 'outgoing', origin: 'Three ship', lines: line(6) });
  const chain = transfers(start, 'Three ship');
  assert.deepEqual(chain.map((p) => p.picking_type), ['internal', 'internal', 'outgoing']);
  assert.deepEqual(chain.map((p) => p.state), ['ready', 'waiting', 'waiting']);
  const picked = validate(start, chain[0].id);
  const packed = validate(picked, chain[1].id);
  assert.equal(read(packed, 'product', 7).qty_available, qty);
  assert.equal(countEntries(packed), countEntries(db));
  assert.equal(warehouseQty(packed, 7, whId(db)), 10);
  const done = validate(packed, chain[2].id);
  assert.equal(read(done, 'product', 7).qty_available, qty - 6);
  assert.equal(warehouseQty(done, 7, whId(db)), 4);
  assert.equal(countEntries(done), countEntries(db) + 1);
  assert.throws(() => validate(done, chain[2].id), /processed/);
});

test('partial pick releases only done quantities and gives the remainder its own first-step backorder chain', () => {
  const db = receipt(configured({ delivery_steps: 'pick_pack_ship' }));
  const start = createOrderTransfers(db, { type: 'outgoing', origin: 'Partial ship', lines: line(10) });
  const chain = transfers(start, 'Partial ship');
  const partial = write(start, 'stock.picking', chain[0].id, { move_ids: [{ product_id: 7, qty: 10, quantity: 4 }] });
  let next = validate(partial, chain[0].id);
  const bo = transfers(next, 'Partial ship').find((p) => p.backorder_id === chain[0].id);
  assert.equal(bo.move_ids[0].qty, 6);
  assert.equal(bo.warehouse_id, whId(db));
  assert.equal(bo.state, 'ready');
  assert.equal(read(next, 'stock.picking', chain[1].id).move_ids[0].qty, 4);
  const remainderPack = search(next, 'stock.picking').find((p) => p.move_orig_picking_id === bo.id);
  assert.equal(remainderPack.state, 'waiting');
  assert.equal(remainderPack.move_ids[0].qty, 6);
  next = validate(validate(next, chain[1].id), chain[2].id);
  assert.equal(read(next, 'product', 7).qty_available, read(db, 'product', 7).qty_available - 4);
  next = validate(next, bo.id);
  next = validate(next, remainderPack.id);
  const ship = search(next, 'stock.picking').find((p) => p.move_orig_picking_id === remainderPack.id);
  next = validate(next, ship.id);
  assert.equal(read(next, 'product', 7).qty_available, read(db, 'product', 7).qty_available - 10);
  assert.equal(warehouseQty(next, 7, whId(db)), 0);
});

test('three-step receipts pass through quality and stock with one valuation', () => {
  const db = configured({ reception_steps: 'three_steps' });
  const start = createOrderTransfers(db, { type: 'incoming', origin: 'QC receipt', lines: line(5) });
  const chain = transfers(start, 'QC receipt');
  let next = start;
  for (const p of chain) next = validate(next, p.id);
  const wh = read(next, 'stock.warehouse', whId(next));
  assert.equal(located(next, 7, wh.wh_input_stock_loc_id), 0);
  assert.equal(located(next, 7, wh.wh_qc_stock_loc_id), 0);
  assert.equal(located(next, 7, wh.lot_stock_id), 5);
  assert.equal(countEntries(next), countEntries(db) + 1);
});

test('the order hook reads its linked warehouse and only shipment updates sale delivered quantities', () => {
  const db = receipt(configured({ delivery_steps: 'pick_pack_ship' }));
  const sale = create(db, 'sale.order', { partner_id: 1, warehouse_id: whId(db), order_line: [{ product_id: 7, qty: 2, price_unit: 10 }] });
  const start = createPicking(sale.db, { type: 'outgoing', partner_id: 1, origin: 'Linked warehouse', lines: line(2), link: { sale_id: sale.id } });
  const chain = transfers(start, 'Linked warehouse');
  const picked = validate(start, chain[0].id);
  const packed = validate(picked, chain[1].id);
  assert.equal(Number(read(packed, 'sale.order', sale.id).order_line[0].qty_delivered) || 0, 0);
  const shipped = validate(packed, chain[2].id);
  assert.equal(read(shipped, 'sale.order', sale.id).order_line[0].qty_delivered, 2);
});

test('resupply validation moves per-location stock between warehouses without valuation or company quantity changes', () => {
  const db = receipt(configured());
  const added = create(db, 'stock.warehouse', { name: 'Branch', code: 'BR' });
  const start = resupplyTransfer(added.db, whId(db), added.id, line(3));
  const p = search(start, 'stock.picking').find((r) => r.origin === 'Inter-warehouse resupply');
  assert.match(p.name, /^WH\/INT\//);
  const done = validate(start, p.id);
  assert.equal(warehouseQty(done, 7, whId(db)), 7);
  assert.equal(warehouseQty(done, 7, added.id), 3);
  assert.equal(read(done, 'product', 7).qty_available, read(db, 'product', 7).qty_available);
  assert.equal(countEntries(done), countEntries(db));
  assert.throws(() => resupplyTransfer(db, whId(db), whId(db), line(1)), /different/);
});

test('warehouseQty includes child locations; planning covers QC and pick/ship and rejects invalid routes', () => {
  const db = receipt(configured({ reception_steps: 'three_steps', delivery_steps: 'pick_ship' }));
  const wh = read(db, 'stock.warehouse', whId(db));
  const specs = planTransfers(db, wh.id, 'incoming', line(2));
  assert.deepEqual(specs.map((p) => p.location_dest_id), [wh.wh_input_stock_loc_id, wh.wh_qc_stock_loc_id, wh.lot_stock_id]);
  assert.equal(planTransfers(db, wh.id, 'outgoing', line(2)).length, 2);
  const shelf = search(db, 'stock.location').find((l) => l.name === 'WH/Stock/Shelf A');
  const added = create(db, 'stock.picking', { picking_type: 'internal', state: 'done', location_id: wh.wh_input_stock_loc_id, location_dest_id: shelf.id, move_ids: line(3) });
  assert.equal(warehouseQty(added.db, 7, wh.id), 10);
  assert.equal(located(added.db, 7, shelf.id), 3);
  assert.throws(() => planTransfers(db, wh.id, 'internal', line(1)), /receipt or delivery/);
  assert.throws(() => planTransfers(db, wh.id, 'incoming', line(NaN)), /finite/);
  assert.throws(() => validateWarehousePicking(db, { id: -1 }), /not found/);
});
