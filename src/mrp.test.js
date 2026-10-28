import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { accountId, isBalanced } from './models/ledger.js';
import { confirmMo, produce } from './models/more.js';
import { unbuild, validateScrap } from './models/mrp.js';
import { seed } from './seed.js';

/** A product with a two-component BoM, components stocked. */
const setup = () => {
  let db = seed();
  const mk = (vals) => { const r = create(db, 'product', { type: 'goods', list_price: 10, ...vals }); db = r.db; return r.id; };
  const a = mk({ name: 'Leg', cost: 2, qty_available: 100 });
  const b = mk({ name: 'Top', cost: 20, qty_available: 100 });
  const table = mk({ name: 'Table', cost: 30, qty_available: 0 });
  const bom = create(db, 'mrp.bom', { name: 'Table BoM', product_id: table, product_qty: 1, components: [{ product_id: a, qty: 4 }, { product_id: b, qty: 1 }] });
  return { db: bom.db, a, b, table, bom: bom.id };
};

test('producing part of an MO consumes proportionally and leaves a confirmed backorder for the rest', () => {
  const { db, a, b, table, bom } = setup();
  const mo = create(db, 'mrp.production', { product_id: table, bom_id: bom, product_qty: 5 });
  const confirmed = confirmMo(mo.db, read(mo.db, 'mrp.production', mo.id));
  const partial = write(confirmed, 'mrp.production', mo.id, { qty_producing: 2 });
  const out = produce(partial, read(partial, 'mrp.production', mo.id));
  assert.equal(read(out.db, 'product', table).qty_available, 2);
  assert.equal(read(out.db, 'product', a).qty_available, 92);
  assert.equal(read(out.db, 'product', b).qty_available, 98);
  const done = read(out.db, 'mrp.production', mo.id);
  assert.deepEqual([done.state, done.product_qty], ['done', 2]);
  const rest = search(out.db, 'mrp.production').find((m) => m.backorder_of === mo.id);
  assert.deepEqual([rest.state, rest.product_qty, rest.origin], ['confirmed', 3, done.name]);
  assert.deepEqual(rest.move_raw.map((m) => m.to_consume), [12, 3]);
  const all = produce(out.db, rest);
  assert.equal(read(all.db, 'product', table).qty_available, 5);
  assert.equal(search(all.db, 'mrp.production').filter((m) => m.backorder_of === rest.id).length, 0);
});

test('scrap writes stock off at cost with a balanced entry, and refuses more than on hand', () => {
  const { db, b } = setup();
  const sc = create(db, 'stock.scrap', { product_id: b, scrap_qty: 3, reason: 'Damaged' });
  const done = validateScrap(sc.db, read(sc.db, 'stock.scrap', sc.id));
  assert.equal(read(done, 'product', b).qty_available, 97);
  const s = read(done, 'stock.scrap', sc.id);
  assert.deepEqual([s.state, s.scrap_value], ['done', 60]);
  const entry = read(done, 'account.move', s.move_id);
  assert.ok(isBalanced(entry.line_ids));
  assert.equal(entry.line_ids.find((l) => l.credit).account_id, accountId(done, '110100'));
  assert.throws(() => validateScrap(done, s), /already done/);
  const big = create(db, 'stock.scrap', { product_id: b, scrap_qty: 1000 });
  assert.throws(() => validateScrap(big.db, read(big.db, 'stock.scrap', big.id)), /in stock/);
});

test('unbuild turns finished products back into their components', () => {
  const { db, a, b, table, bom } = setup();
  const stocked = write(db, 'product', table, { qty_available: 2 });
  const ub = create(stocked, 'mrp.unbuild', { product_id: table, bom_id: bom, product_qty: 2 });
  const done = unbuild(ub.db, read(ub.db, 'mrp.unbuild', ub.id));
  assert.equal(read(done, 'product', table).qty_available, 0);
  assert.equal(read(done, 'product', a).qty_available, 108);
  assert.equal(read(done, 'product', b).qty_available, 102);
  assert.throws(() => unbuild(ub.db, { ...read(ub.db, 'mrp.unbuild', ub.id), product_qty: 9 }), /in stock/);
});
