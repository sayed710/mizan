import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from './orm.js';
import { confirmMo, produce } from './models/more.js';
import { receive } from './models/valuation.js';
import { accountId, journalItems } from './models/ledger.js';
import { seed } from './seed.js';

const goods = (db, vals) => create(db, 'product', { type: 'goods', valuation: 'real_time', qty_available: 0, list_price: 10, ...vals });
const balance = (db, code) => Math.round(journalItems(db).filter((l) => l.account_id === accountId(db, code)).reduce((s, l) => s + l.debit - l.credit, 0) * 100) / 100;

test('producing a standard-cost product keeps its standard and books the gap as a variance', () => {
  const part = goods(seed(), { name: 'Panel', cost: 10, cost_method: 'fifo' });
  const desk = goods(receive(part.db, part.id, 10, 12), { name: 'Desk', cost: 30, cost_method: 'standard' });
  const bom = create(desk.db, 'mrp.bom', { name: 'Desk BoM', product_id: desk.id, product_qty: 1, components: [{ product_id: part.id, qty: 2 }] });
  const mo = create(bom.db, 'mrp.production', { product_id: desk.id, bom_id: bom.id, product_qty: 2 });
  const confirmed = confirmMo(mo.db, read(mo.db, 'mrp.production', mo.id));
  const done = produce(confirmed, read(confirmed, 'mrp.production', mo.id)).db;
  assert.equal(read(done, 'product', desk.id).cost, 30);
  const layer = search(done, 'stock.valuation.layer').filter((l) => l.product_id === desk.id).at(-1);
  // 2 desks in at 30 = 60 while the panels cost 48: a favourable variance of 12.
  assert.deepEqual([layer.value, layer.price_difference], [60, -12]);
  assert.equal(Math.round((balance(done, '110100') - balance(confirmed, '110100')) * 100) / 100, 12);
  assert.equal(Math.round((balance(done, '600000') - balance(confirmed, '600000')) * 100) / 100, -12);
});

test('consuming nothing for an MO is refused unless confirmed', () => {
  const part = goods(seed(), { name: 'Panel', cost: 10, cost_method: 'fifo', qty_available: 5 });
  const desk = goods(part.db, { name: 'Desk', cost: 30 });
  const bom = create(desk.db, 'mrp.bom', { name: 'Desk BoM', product_id: desk.id, product_qty: 1, components: [{ product_id: part.id, qty: 2 }] });
  const mo = create(bom.db, 'mrp.production', { product_id: desk.id, bom_id: bom.id, product_qty: 1 });
  const confirmed = confirmMo(mo.db, read(mo.db, 'mrp.production', mo.id));
  const zero = { ...read(confirmed, 'mrp.production', mo.id) };
  zero.move_raw = zero.move_raw.map((m) => ({ ...m, consumed: 0 }));
  assert.throws(() => produce(confirmed, zero), /Less than the bill of materials is consumed for Panel/);
  const forced = produce(confirmed, zero, { allowUnderConsumption: true }).db;
  assert.equal(read(forced, 'product', part.id).qty_available, 5);
});
