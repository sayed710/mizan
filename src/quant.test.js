import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write, unlink, setActiveCompany } from './orm.js';
import { seed } from './seed.js';
import { models, apps } from './models/index.js';
import { receive } from './models/valuation.js';
import { applyInventory, clearInventory, requestCount, ensureQuants } from './models/quant.js';
import { applyDiff, diffDb } from './sync.js';
import { migrate } from './migrations.js';
import { today } from './models/common.js';

const date = today();
function setup(tracking = 'none') {
  const p = create(seed(), 'product', { name: 'Quant widget', type: 'goods', cost: 10, qty_available: 0, tracking });
  const a = create(p.db, 'stock.location', { name: 'Quant A' });
  const b = create(a.db, 'stock.location', { name: 'Quant B' });
  return { db: b.db, product: p.id, a: a.id, b: b.id };
}
function transfer(db, product, qty, type, source, dest, lot_name = '') {
  const p = create(db, 'stock.picking', { picking_type: type, state: 'ready', location_id: source, location_dest_id: dest, move_ids: [{ product_id: product, qty, lot_name }] });
  return models['stock.picking'].form.buttons.find((b) => b.label === 'Validate').run(p.db, read(p.db, 'stock.picking', p.id)).db;
}
const quants = (db, product) => search(db, 'stock.quant').filter((q) => q.product_id === product);
const total = (db, product) => quants(db, product).reduce((s, q) => s + q.quantity, 0);

test('quants follow done receipts, internal transfers, deliveries and lots immutably', () => {
  const { db: base, product, a, b } = setup('lot');
  const original = structuredClone(base);
  let db = transfer(base, product, 10, 'incoming', null, a, 'LOT-A');
  db = transfer(db, product, 4, 'internal', a, b, 'LOT-A');
  db = transfer(db, product, 1, 'outgoing', b, null, 'LOT-A');
  assert.deepEqual(quants(db, product).filter((q) => q.quantity).map((q) => [q.location_id, q.quantity]).sort(), [[a, 6], [b, 3]].sort());
  assert.ok(quants(db, product).filter((q) => q.quantity).every((q) => read(db, 'stock.lot', q.lot_id).name === 'LOT-A'));
  assert.equal(total(db, product), 9);
  assert.equal(read(db, 'product', product).qty_available, 9);
  assert.equal(search(db, 'stock.lot').find((l) => l.product_id === product).qty, 9);
  assert.deepEqual(base, original);
  assert.deepEqual(ensureQuants(db), db);
});

test('quant Apply posts located adjustment and valuation for gains, losses and zero counts', () => {
  const { db: base, product, a, b } = setup('lot');
  let db = transfer(base, product, 10, 'incoming', null, a, 'LOT-A');
  db = transfer(db, product, 2, 'internal', a, b, 'LOT-A');
  const q = quants(db, product).find((r) => r.location_id === a);
  db = write(db, 'stock.quant', q.id, { inventory_quantity: 11 });
  assert.equal(read(db, 'stock.quant', q.id).inventory_diff_quantity, 3);
  assert.equal(read(db, 'stock.quant', q.id).inventory_quantity_set, true);
  db = applyInventory(db, [q.id], { date });
  const move = search(db, 'stock.picking').at(-1);
  assert.equal(move.state, 'done');
  assert.equal(read(db, 'stock.location', move.location_id).usage, 'inventory');
  assert.equal(move.location_dest_id, a);
  assert.equal(move.move_ids[0].qty, 3);
  const layer = search(db, 'stock.valuation.layer').filter((l) => l.product_id === product).at(-1);
  assert.deepEqual([layer.quantity, layer.value, layer.kind], [3, 30, 'adjustment']);
  assert.equal(read(db, 'account.move', layer.move_id).state, 'posted');
  assert.equal(layer.picking_id, move.id);
  assert.equal(total(applyDiff(base, diffDb(base, db), { isAdmin: false }), product), 13);
  assert.equal(read(db, 'stock.quant', q.id).inventory_quantity_set, false);
  assert.equal(total(db, product), 13);
  db = applyInventory(write(db, 'stock.quant', q.id, { inventory_quantity: 0 }), [], { date });
  assert.equal(read(db, 'stock.quant', q.id).quantity, 0);
  assert.equal(read(db, 'product', product).qty_available, 2);
  assert.equal(search(db, 'stock.lot').find((l) => l.product_id === product).qty, 2);
  assert.equal(total(db, product), 2);
});

test('clear and request count preserve stock, filters distinguish unset counts and selected rows', () => {
  const { db: base, product, a } = setup();
  let db = transfer(base, product, 5, 'incoming', null, a);
  const q = quants(db, product).find((r) => r.location_id === a);
  db = requestCount(db, [q.id], { date, user_id: 1 });
  assert.equal(read(db, 'stock.quant', q.id).user_id, 1);
  assert.equal(read(db, 'stock.quant', q.id).inventory_date, date);
  assert.equal(models['stock.quant'].filters.flat().find((f) => f.label === 'To Count').fn(read(db, 'stock.quant', q.id)), true);
  db = write(db, 'stock.quant', q.id, { inventory_quantity: 0 });
  assert.equal(models['stock.quant'].filters.flat().find((f) => f.label === 'To Apply').fn(read(db, 'stock.quant', q.id)), true);
  db = clearInventory(db, [q.id]);
  assert.equal(read(db, 'stock.quant', q.id).inventory_quantity_set, false);
  assert.equal(total(db, product), 5);
});

test('locked count, including zero-valued stock, is refused without mutation', () => {
  const { db: base, product, a } = setup();
  let db = transfer(base, product, 5, 'incoming', null, a);
  const q = quants(db, product).find((r) => r.location_id === a);
  db = write(db, 'stock.quant', q.id, { inventory_quantity: 8 });
  db = { ...db, settings: { ...db.settings, lock_date: date } };
  const original = structuredClone(db);
  assert.throws(() => applyInventory(db, [q.id], { date }), /lock|closed/i);
  assert.deepEqual(db, original);
});

test('direct valuation receipts create quants and company actions refuse foreign selected ids', () => {
  const { db: base, product } = setup();
  let db = receive(base, product, 3, 10, { date });
  assert.equal(total(db, product), 3);
  const q = quants(db, product)[0];
  db = write(db, 'stock.quant', q.id, { inventory_quantity: 4 });
  setActiveCompany(2);
  try {
    assert.equal(search(db, 'stock.quant').length, 0);
    assert.throws(() => applyInventory(db, [q.id], { date }), /company|accessible/i);
  } finally { setActiveCompany(null); }
});

test('physical inventory menu and product On Hand smart button target quants', () => {
  const inventory = apps.find((a) => a.id === 'inventory');
  assert.equal(inventory.menus.flatMap((m) => m.children ?? [m]).find((m) => m.key === 'physical-inventory').model, 'stock.quant');
  assert.ok(models.product.form.smart.some((s) => s.label === 'On Hand' && s.model === 'stock.quant' && s.field === 'product_id'));
  assert.equal(models['stock.quant'].fields.company_id.default({ settings: { current_company_id: 2 } }), 2);
});

test('reservations allocate multiple lines once across locations and lots', () => {
  const { db: base, product, a, b } = setup('lot');
  let db = transfer(base, product, 4, 'incoming', null, a, 'A');
  db = transfer(db, product, 3, 'incoming', null, b, 'B');
  db = create(db, 'stock.picking', { picking_type: 'outgoing', state: 'ready', location_id: a, move_ids: [{ product_id: product, qty: 2 }, { product_id: product, qty: 2 }] }).db;
  db = create(db, 'stock.picking', { picking_type: 'outgoing', state: 'ready', location_id: b, move_ids: [{ product_id: product, qty: 2 }] }).db;
  const qs = quants(db, product);
  assert.equal(qs.reduce((s, q) => s + q.reserved_quantity, 0), 6);
  assert.equal(qs.reduce((s, q) => s + q.available_quantity, 0), 1);
});

test('unlocated multi-line picking reserves once across default-location quants', () => {
  const { db: base, product, a, b } = setup('lot');
  let db = transfer(base, product, 4, 'incoming', null, a, 'A');
  db = transfer(db, product, 3, 'incoming', null, a, 'B');
  db = transfer(db, product, 3, 'incoming', null, b, 'C');
  const warehouse = search(db, 'stock.warehouse').find((w) => (w.company_id ?? 1) === 1 && w.lot_stock_id);
  db = write(db, 'stock.warehouse', warehouse.id, { lot_stock_id: a });
  let picking;
  ({ db, id: picking } = create(db, 'stock.picking', { picking_type: 'outgoing', state: 'draft', move_ids: [{ product_id: product, qty: 3 }, { product_id: product, qty: 3 }] }));
  const todo = models['stock.picking'].form.buttons.find((button) => button.label === 'Mark as Todo');
  db = todo.run(db, read(db, 'stock.picking', picking)).db;
  assert.equal(read(db, 'stock.picking', picking).state, 'ready');
  assert.ok(!read(db, 'stock.picking', picking).location_id);
  const qs = quants(db, product);
  const defaultQuants = qs.filter((q) => q.location_id === a);
  const otherQuants = qs.filter((q) => q.location_id === b);
  assert.deepEqual(defaultQuants.map((q) => [read(db, 'stock.lot', q.lot_id).name, q.reserved_quantity, q.available_quantity]).sort(), [['A', 4, 0], ['B', 2, 1]]);
  assert.equal(defaultQuants.reduce((sum, q) => sum + q.reserved_quantity, 0), 6);
  assert.equal(defaultQuants.reduce((sum, q) => sum + q.available_quantity, 0), 1);
  assert.equal(otherQuants.reduce((sum, q) => sum + q.reserved_quantity, 0), 0);
  assert.equal(otherQuants.reduce((sum, q) => sum + q.available_quantity, 0), 3);
  let competing;
  ({ db, id: competing } = create(db, 'stock.picking', { picking_type: 'outgoing', state: 'draft', move_ids: [{ product_id: product, qty: 2 }] }));
  db = todo.run(db, read(db, 'stock.picking', competing)).db;
  assert.equal(read(db, 'stock.picking', competing).state, 'waiting');
});

test('migration derives done moves once and preserves unlocated opening quantities and lot identities', () => {
  const { db: base, product, a, b } = setup('lot');
  let db = transfer(base, product, 5, 'incoming', null, a, 'A');
  db = transfer(db, product, 2, 'internal', a, b, 'A');
  const old = { ...db, schema_version: 3, records: { ...db.records, 'stock.quant': [] } };
  const migrated = migrate(old);
  assert.equal(total(migrated, product), 5);
  assert.deepEqual(quants(migrated, product).map((q) => [q.location_id, q.quantity]), [[a, 3], [b, 2]]);
  assert.strictEqual(migrate(migrated), migrated);
  assert.ok(migrated.records.product.filter((p) => p.type === 'goods').every((p) => total(migrated, p.id) === p.qty_available));
});

test('legacy tracked opening stock keeps its existing lots when there are no located moves', () => {
  const { db: base, product } = setup('lot');
  let db = write(base, 'product', product, { qty_available: 6 });
  db = create(db, 'stock.lot', { name: 'Opening A', product_id: product, qty: 4 }).db;
  db = create(db, 'stock.lot', { name: 'Opening B', product_id: product, qty: 2 }).db;
  db = ensureQuants(db);
  assert.deepEqual(quants(db, product).map((q) => [read(db, 'stock.lot', q.lot_id)?.name, q.quantity]), [['Opening A', 4], ['Opening B', 2]]);
  assert.equal(total(db, product), 6);
});

test('quant counts validate negative/invalid input and selected Apply leaves other set rows alone', () => {
  const { db: base, product, a, b } = setup();
  let db = transfer(base, product, 5, 'incoming', null, a);
  db = transfer(db, product, 2, 'internal', a, b);
  const [qa, qb] = quants(db, product).filter((q) => q.quantity);
  assert.throws(() => write(db, 'stock.quant', qa.id, { inventory_quantity: -1 }), /nonnegative/);
  assert.throws(() => requestCount(db, [qa.id], { date: '2026-02-30' }), /valid count date/);
  assert.throws(() => write(db, 'stock.quant', qa.id, { location_id: b }), /identity|already exists/);
  const forged = write(db, 'stock.quant', qa.id, { quantity: qa.quantity + 1 });
  assert.throws(() => applyDiff(db, diffDb(db, forged), { isAdmin: false }), /quants.*on-hand|on-hand.*quants/i);
  db = write(db, 'stock.quant', qa.id, { inventory_quantity: qa.quantity });
  db = write(db, 'stock.quant', qb.id, { inventory_quantity: qb.quantity + 1 });
  const before = search(db, 'stock.picking').length;
  db = applyInventory(db, [qa.id], { date });
  assert.equal(search(db, 'stock.picking').length, before);
  assert.equal(read(db, 'stock.quant', qb.id).inventory_quantity_set, true);
  db = clearInventory(db, []);
  assert.ok(quants(db, product).every((q) => !q.inventory_quantity_set));
});

test('zero-value and periodic counts obey hard and closed fiscal-year locks', () => {
  const { db: base, product, a } = setup();
  let db = write(base, 'product', product, { cost: 0, valuation: 'manual_periodic' });
  db = transfer(db, product, 5, 'incoming', null, a);
  const q = quants(db, product).find((q) => q.quantity);
  db = write(db, 'stock.quant', q.id, { inventory_quantity: 6 });
  assert.throws(() => applyInventory({ ...db, settings: { ...db.settings, hard_lock_date: date } }, [q.id], { date }), /lock|closed/i);
  const closed = { ...db, records: { ...db.records, 'account.fiscal.year': [{ id: 1, company_id: 1, date_from: '2026-01-01', date_to: '2026-12-31', state: 'closed' }] } };
  assert.throws(() => applyInventory(closed, [q.id], { date }), /lock|closed/i);
});

test('company-two counts only change their own quants and post their entries in that company', () => {
  const { db: base, product, a } = setup();
  let db = transfer(base, product, 5, 'incoming', null, a);
  const first = quants(db, product).find((q) => q.quantity);
  const loc = create(db, 'stock.location', { name: 'Company two', company_id: 2 });
  db = { ...loc.db, settings: { ...loc.db.settings, current_company_id: 2 } };
  setActiveCompany(2);
  try {
    db = transfer(db, product, 3, 'incoming', null, loc.id);
    assert.equal(search(db, 'stock.valuation.layer').filter((l) => l.product_id === product).reduce((s, l) => s + l.quantity, 0), 3);
    const q = quants(db, product).find((q) => q.location_id === loc.id);
    db = applyInventory(write(db, 'stock.quant', q.id, { inventory_quantity: 4 }), [q.id], { date });
    const layer = search(db, 'stock.valuation.layer').at(-1);
    assert.equal(layer.company_id, 2);
    assert.equal(read(db, 'account.move', layer.move_id).company_id, 2);
    assert.equal(read(db, 'stock.quant', first.id).quantity, 5);
    assert.equal(read(db, 'product', product).qty_available, db.records['stock.quant'].filter((q) => q.product_id === product).reduce((s, q) => s + q.quantity, 0));
  } finally { setActiveCompany(null); }
});

test('FIFO counts consume receipt costs and isolate another lot at the same location', () => {
  const { db: base, product, a } = setup('lot');
  let db = write(base, 'product', product, { cost_method: 'fifo' });
  db = transfer(db, product, 4, 'incoming', null, a, 'A');
  db = write(db, 'product', product, { cost: 20 });
  db = transfer(db, product, 4, 'incoming', null, a, 'B');
  const qa = quants(db, product).find((q) => read(db, 'stock.lot', q.lot_id)?.name === 'A');
  const qb = quants(db, product).find((q) => read(db, 'stock.lot', q.lot_id)?.name === 'B');
  db = applyInventory(write(db, 'stock.quant', qa.id, { inventory_quantity: 1 }), [qa.id], { date });
  assert.equal(search(db, 'stock.valuation.layer').filter((l) => l.product_id === product).at(-1).value, -30);
  assert.equal(read(db, 'stock.quant', qb.id).quantity, 4);
  assert.equal(read(db, 'stock.lot', qb.lot_id).qty, 4);
  assert.equal(read(db, 'stock.lot', qa.lot_id).qty, 1);
  assert.equal(read(db, 'product', product).qty_available, 5);
});

test('a saved physical count rejects intervening stock movements until recounted', () => {
  const { db: base, product, a } = setup();
  let db = transfer(base, product, 10, 'incoming', null, a);
  const q = quants(db, product).find((row) => row.location_id === a);
  db = write(db, 'stock.quant', q.id, { inventory_quantity: 10 });
  db = transfer(db, product, 5, 'incoming', null, a);
  const action = models['stock.quant'].form.buttons.find((b) => b.label === 'Apply');
  assert.throws(() => action.run(db, read(db, 'stock.quant', q.id)), /changed|stale/i);
  assert.equal(read(db, 'stock.quant', q.id).quantity, 15);
  db = write(db, 'stock.quant', q.id, { inventory_quantity: 15 });
  db = action.run(db, read(db, 'stock.quant', q.id)).db;
  assert.equal(read(db, 'stock.quant', q.id).quantity, 15);
  assert.equal(read(db, 'stock.quant', q.id).inventory_quantity_set, false);
});

test('scrapping a serial consumes its selected location and lot through the scrap action', () => {
  let { db, id: product } = create(seed(), 'product', { name: 'Serial scrap', type: 'goods', tracking: 'serial', qty_available: 0, cost: 10, cost_method: 'fifo' });
  let location, receipt, scrap;
  ({ db, id: location } = create(db, 'stock.location', { name: 'Scrap source', usage: 'internal' }));
  ({ db, id: receipt } = create(db, 'stock.picking', { picking_type: 'incoming', state: 'ready', location_dest_id: location, move_ids: [{ product_id: product, qty: 1, lot_name: 'S1' }] }));
  db = models['stock.picking'].form.buttons.find((b) => b.label === 'Validate').run(db, read(db, 'stock.picking', receipt)).db;
  ({ db, id: scrap } = create(db, 'stock.scrap', { product_id: product, scrap_qty: 1, lot_name: 'S1', location_id: location }));
  db = models['stock.scrap'].form.buttons.find((b) => b.label === 'Validate').run(db, read(db, 'stock.scrap', scrap)).db;
  const lot = search(db, 'stock.lot').find((l) => l.product_id === product && l.name === 'S1');
  assert.equal(lot.qty, 0);
  assert.equal(search(db, 'stock.quant').find((q) => q.product_id === product && q.location_id === location && q.lot_id === lot.id).quantity, 0);
  assert.equal(read(db, 'product', product).qty_available, 0);
  assert.ok(search(db, 'stock.valuation.layer').some((l) => l.picking_id && l.product_id === product && l.quantity === -1));
});

test('periodic tracked scrap preserves its generated picking link and consumes lot and location', () => {
  let { db, id: product } = create(seed(), 'product', { name: 'Periodic tracked scrap', type: 'goods', tracking: 'lot', valuation: 'manual_periodic', qty_available: 0, cost: 10 });
  let location, receipt, scrap;
  ({ db, id: location } = create(db, 'stock.location', { name: 'Periodic scrap source', usage: 'internal' }));
  ({ db, id: receipt } = create(db, 'stock.picking', { picking_type: 'incoming', state: 'ready', location_dest_id: location, move_ids: [{ product_id: product, qty: 3, lot_name: 'LOT-P1' }] }));
  db = models['stock.picking'].form.buttons.find((b) => b.label === 'Validate').run(db, read(db, 'stock.picking', receipt)).db;
  ({ db, id: scrap } = create(db, 'stock.scrap', { product_id: product, scrap_qty: 2, lot_name: 'LOT-P1', location_id: location }));
  db = models['stock.scrap'].form.buttons.find((b) => b.label === 'Validate').run(db, read(db, 'stock.scrap', scrap)).db;

  const doneScrap = read(db, 'stock.scrap', scrap);
  assert.ok(doneScrap.picking_id);
  const picking = read(db, 'stock.picking', doneScrap.picking_id);
  assert.ok(picking);
  assert.equal(picking.state, 'done');
  assert.equal(picking.origin, doneScrap.name);
  assert.equal(picking.move_ids[0].lot_name, 'LOT-P1');
  assert.equal(picking.move_ids[0].qty, 2);

  const lot = search(db, 'stock.lot').find((l) => l.product_id === product && l.name === 'LOT-P1');
  assert.equal(lot.qty, 1);
  assert.equal(search(db, 'stock.quant').find((q) => q.product_id === product && q.location_id === location && q.lot_id === lot.id).quantity, 1);
  assert.equal(read(db, 'product', product).qty_available, 1);
  assert.equal(search(db, 'stock.valuation.layer').filter((l) => l.product_id === product).length, 0);
});

test('periodic tracked scrap retains both its source receipt and generated movement', () => {
  let { db, id: product } = create(seed(), 'product', { name: 'Periodic linked scrap', type: 'goods', tracking: 'lot', valuation: 'manual_periodic', qty_available: 0, cost: 10 });
  let location, receipt, scrap;
  ({ db, id: location } = create(db, 'stock.location', { name: 'Linked scrap source', usage: 'internal' }));
  ({ db, id: receipt } = create(db, 'stock.picking', { picking_type: 'incoming', state: 'ready', location_dest_id: location, move_ids: [{ product_id: product, qty: 3, lot_name: 'LINKED-LOT' }] }));
  db = models['stock.picking'].form.buttons.find((b) => b.label === 'Validate').run(db, read(db, 'stock.picking', receipt)).db;
  ({ db, id: scrap } = create(db, 'stock.scrap', { product_id: product, scrap_qty: 2, lot_name: 'LINKED-LOT', location_id: location, picking_id: receipt }));
  const entriesBefore = search(db, 'account.move').length;
  db = models['stock.scrap'].form.buttons.find((b) => b.label === 'Validate').run(db, read(db, 'stock.scrap', scrap)).db;
  const done = read(db, 'stock.scrap', scrap);
  assert.equal(done.picking_id, receipt);
  assert.ok(done.scrap_picking_id);
  assert.notEqual(done.scrap_picking_id, receipt);
  const movement = read(db, 'stock.picking', done.scrap_picking_id);
  assert.equal(movement.state, 'done');
  assert.equal(movement.origin, done.name);
  assert.equal(movement.location_id, location);
  assert.equal(read(db, 'stock.location', movement.location_dest_id).usage, 'inventory');
  assert.deepEqual(movement.move_ids.map(({ product_id, qty, lot_name }) => ({ product_id, qty, lot_name })), [{ product_id: product, qty: 2, lot_name: 'LINKED-LOT' }]);
  const lot = search(db, 'stock.lot').find((l) => l.product_id === product && l.name === 'LINKED-LOT');
  assert.equal(lot.qty, 1);
  assert.equal(search(db, 'stock.quant').find((q) => q.product_id === product && q.location_id === location && q.lot_id === lot.id).quantity, 1);
  assert.equal(search(db, 'stock.valuation.layer').filter((l) => l.product_id === product).length, 0);
  assert.equal(search(db, 'account.move').length, entriesBefore);
  assert.throws(() => write(db, 'stock.scrap', scrap, { scrap_picking_id: receipt }), /completed|done/i);
});

test('completed transfers cannot be deleted or edited through the model API', () => {
  const { db: base, product, a } = setup();
  let id;
  let db;
  ({ db, id } = create(base, 'stock.picking', { picking_type: 'incoming', state: 'ready', location_dest_id: a, move_ids: [{ product_id: product, qty: 2 }] }));
  db = models['stock.picking'].form.buttons.find((b) => b.label === 'Validate').run(db, read(db, 'stock.picking', id)).db;
  assert.throws(() => unlink(db, 'stock.picking', [id]), /completed|done/i);
  assert.throws(() => write(db, 'stock.picking', id, { move_ids: [{ product_id: product, qty: 8 }] }), /completed|done/i);
  assert.throws(() => write(db, 'stock.picking', id, { state: 'draft' }), /completed|done/i);
});

test('referenced open predecessor transfers cannot be deleted through the model API', () => {
  const { db: base, product, a } = setup();
  let first, db;
  ({ db, id: first } = create(base, 'stock.picking', { picking_type: 'incoming', state: 'ready', location_dest_id: a, move_ids: [{ product_id: product, qty: 2 }] }));
  ({ db } = create(db, 'stock.picking', { picking_type: 'internal', state: 'waiting', move_orig_picking_id: first, move_ids: [{ product_id: product, qty: 2 }] }));
  assert.throws(() => unlink(db, 'stock.picking', [first]), /referenced/i);
});



test('lot transfers use the matching company and cannot consume another location', () => {
  let { db, id: product } = create(seed(), 'product', { name: 'Shared lot', type: 'goods', tracking: 'lot', qty_available: 0, cost: 5 });
  let a, b;
  ({ db, id: a } = create(db, 'stock.location', { name: 'Company 1 lot stock', company_id: 1 }));
  ({ db, id: b } = create(db, 'stock.location', { name: 'Company 2 lot stock', company_id: 2 }));
  db = transfer(db, product, 5, 'incoming', null, a, 'SAME');
  const first = db.records['stock.lot'].find((l) => l.product_id === product && l.company_id === 1);
  const companyTransfer = (before, type, source, dest, qty) => {
    const created = create(before, 'stock.picking', { company_id: 2, picking_type: type, state: 'ready', location_id: source, location_dest_id: dest, move_ids: [{ product_id: product, qty, lot_name: 'SAME' }] });
    return models['stock.picking'].form.buttons.find((button) => button.label === 'Validate').run(created.db, read(created.db, 'stock.picking', created.id)).db;
  };
  db = companyTransfer(db, 'incoming', null, b, 3);
  const second = db.records['stock.lot'].find((l) => l.product_id === product && l.company_id === 2);
  assert.notEqual(first.id, second.id);
  db = companyTransfer(db, 'outgoing', b, null, 1);
  assert.equal(read(db, 'stock.lot', first.id).qty, 5);
  assert.equal(read(db, 'stock.lot', second.id).qty, 2);
  assert.equal(db.records['stock.valuation.layer'].filter((l) => l.product_id === product && l.company_id === 1).reduce((sum, l) => sum + l.quantity, 0), 5);
  assert.equal(db.records['stock.valuation.layer'].filter((l) => l.product_id === product && l.company_id === 2).reduce((sum, l) => sum + l.quantity, 0), 2);
  assert.equal(db.records['stock.quant'].find((q) => q.lot_id === second.id && q.location_id === b).quantity, 2);
  let empty;
  ({ db, id: empty } = create(db, 'stock.location', { name: 'Empty lot stock', company_id: 2 }));
  assert.throws(() => companyTransfer(db, 'outgoing', empty, null, 1), /stock/i);
});

test('reservation and validation exclude stock owned by another company', () => {
  let { db, id: product } = create(seed(), 'product', { name: 'Shared company stock', type: 'goods', qty_available: 0, cost: 5 });
  let foreign;
  ({ db, id: foreign } = create(db, 'stock.location', { name: 'Other company', company_id: 2 }));
  const input = create(db, 'stock.picking', { company_id: 2, picking_type: 'incoming', state: 'ready', location_dest_id: foreign, move_ids: [{ product_id: product, qty: 10 }] });
  db = models['stock.picking'].form.buttons.find((b) => b.label === 'Validate').run(input.db, read(input.db, 'stock.picking', input.id)).db;
  const output = create(db, 'stock.picking', { company_id: 1, picking_type: 'outgoing', state: 'draft', move_ids: [{ product_id: product, qty: 5 }] });
  db = models['stock.picking'].form.buttons.find((b) => b.label === 'Mark as Todo').run(output.db, read(output.db, 'stock.picking', output.id)).db;
  assert.equal(read(db, 'stock.picking', output.id).state, 'waiting');
  assert.throws(() => models['stock.picking'].form.buttons.find((b) => b.label === 'Validate').run(db, read(db, 'stock.picking', output.id)), /stock/i);
});

test('stock valuation history rejects direct model-layer edits and deletion', () => {
  const { db: base, product, a } = setup();
  const db = transfer(base, product, 2, 'incoming', null, a);
  const layer = search(db, 'stock.valuation.layer').find((l) => l.product_id === product && l.quantity === 2);
  assert.throws(() => write(db, 'stock.valuation.layer', layer.id, { value: 999 }), /history cannot/i);
  assert.throws(() => unlink(db, 'stock.valuation.layer', [layer.id]), /deleted/i);
});

test('completed scrap orders cannot be deleted or mutated through the model layer', () => {
  const { db: base, product, a } = setup();
  let db = transfer(base, product, 2, 'incoming', null, a);
  let scrap;
  ({ db, id: scrap } = create(db, 'stock.scrap', { product_id: product, scrap_qty: 1, location_id: a }));
  db = models['stock.scrap'].form.buttons.find((b) => b.label === 'Validate').run(db, read(db, 'stock.scrap', scrap)).db;
  assert.throws(() => unlink(db, 'stock.scrap', [scrap]), /completed|done/i);
  assert.throws(() => write(db, 'stock.scrap', scrap, { scrap_qty: 5 }), /completed|done/i);
});

test('a count remains stale after offsetting movements restore the same quantity', () => {
  const { db: base, product, a } = setup();
  let db = transfer(base, product, 10, 'incoming', null, a);
  const q = quants(db, product).find((row) => row.location_id === a);
  db = write(db, 'stock.quant', q.id, { inventory_quantity: 10 });
  db = transfer(db, product, 5, 'incoming', null, a);
  db = transfer(db, product, 5, 'outgoing', a, null);
  assert.equal(read(db, 'stock.quant', q.id).quantity, 10);
  assert.throws(() => models['stock.quant'].form.buttons.find((b) => b.label === 'Apply').run(db, read(db, 'stock.quant', q.id)), /changed|stale/i);
});

test('lot-specific reservation uses quants not occupied by an unspecified reservation', () => {
  const { db: base, product, a } = setup('lot');
  let db = transfer(base, product, 4, 'incoming', null, a, 'A');
  db = transfer(db, product, 4, 'incoming', null, a, 'B');
  let generic, specific;
  ({ db, id: generic } = create(db, 'stock.picking', { picking_type: 'outgoing', state: 'draft', location_id: a, move_ids: [{ product_id: product, qty: 3 }] }));
  db = models['stock.picking'].form.buttons.find((b) => b.label === 'Mark as Todo').run(db, read(db, 'stock.picking', generic)).db;
  ({ db, id: specific } = create(db, 'stock.picking', { picking_type: 'outgoing', state: 'draft', location_id: a, move_ids: [{ product_id: product, qty: 4, lot_name: 'B' }] }));
  db = models['stock.picking'].form.buttons.find((b) => b.label === 'Mark as Todo').run(db, read(db, 'stock.picking', specific)).db;
  assert.equal(read(db, 'stock.picking', specific).state, 'ready');
  db = models['stock.picking'].form.buttons.find((b) => b.label === 'Validate').run(db, read(db, 'stock.picking', specific)).db;
  assert.equal(search(db, 'stock.lot').find((l) => l.product_id === product && l.name === 'B').qty, 0);
});

test('Mark as Todo shares stock between specified and unspecified lot lines', () => {
  const { db: base, product, a } = setup('lot');
  let db = transfer(base, product, 5, 'incoming', null, a, 'A');
  let picking;
  ({ db, id: picking } = create(db, 'stock.picking', { picking_type: 'outgoing', state: 'draft', location_id: a, move_ids: [{ product_id: product, qty: 5 }, { product_id: product, qty: 5, lot_name: 'A' }] }));
  const todo = models['stock.picking'].form.buttons.find((b) => b.label === 'Mark as Todo');
  db = todo.run(db, read(db, 'stock.picking', picking)).db;
  assert.equal(read(db, 'stock.picking', picking).state, 'waiting');
  assert.throws(() => models['stock.picking'].form.buttons.find((b) => b.label === 'Validate').run(db, read(db, 'stock.picking', picking)), /not enough free stock/i);
  db = transfer(db, product, 5, 'incoming', null, a, 'B');
  db = models['stock.picking'].form.buttons.find((b) => b.label === 'Check Availability').run(db, read(db, 'stock.picking', picking)).db;
  assert.equal(read(db, 'stock.picking', picking).state, 'ready');
});

test('a transfer without a source reserves only its warehouse stock location', () => {
  let { db, product, a, b } = setup();
  db = transfer(db, product, 5, 'incoming', null, b);
  db = transfer(db, product, 5, 'incoming', null, a);
  const wh = search(db, 'stock.warehouse').find((w) => w.lot_stock_id);
  db = write(db, 'stock.warehouse', wh.id, { lot_stock_id: a });
  const todo = models['stock.picking'].form.buttons.find((button) => button.label === 'Mark as Todo');
  let first, second;
  ({ db, id: first } = create(db, 'stock.picking', { picking_type: 'outgoing', state: 'draft', move_ids: [{ product_id: product, qty: 5 }] }));
  db = todo.run(db, read(db, 'stock.picking', first)).db;
  ({ db, id: second } = create(db, 'stock.picking', { picking_type: 'outgoing', state: 'draft', location_id: a, move_ids: [{ product_id: product, qty: 5 }] }));
  db = todo.run(db, read(db, 'stock.picking', second)).db;
  assert.equal(read(db, 'stock.picking', second).state, 'waiting');
});

