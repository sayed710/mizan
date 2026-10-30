import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write, setActiveCompany } from './orm.js';
import { seed } from './seed.js';
import { createCompany } from './models/company.js';
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
  db = create(db, 'stock.picking', { picking_type: 'outgoing', state: 'ready', move_ids: [{ product_id: product, qty: 3 }, { product_id: product, qty: 3 }] }).db;
  const qs = quants(db, product);
  assert.equal(qs.reduce((s, q) => s + q.reserved_quantity, 0), 6);
  assert.equal(qs.reduce((s, q) => s + q.available_quantity, 0), 1);
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
  const company = createCompany(db, { name: 'Company two' });
  const loc = create(company.db, 'stock.location', { name: 'Company two', company_id: company.id });
  db = { ...loc.db, settings: { ...loc.db.settings, current_company_id: company.id } };
  setActiveCompany(company.id);
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
