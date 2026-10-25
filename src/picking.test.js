import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { models } from './models/index.js';
import { freeQty, pickingAvailability, reservePicking, returnPicking } from './models/picking.js';
import { seed } from './seed.js';

const button = (label) => models['stock.picking'].form.buttons.find((b) => b.label === label);
const goods = (db) => search(db, 'product').find((p) => p.type === 'goods' && Number(p.qty_available) >= 5);
const delivery = (db, product, qty, vals = {}) => create(db, 'stock.picking', { picking_type: 'outgoing', state: 'draft', move_ids: [{ product_id: product.id, qty }], ...vals });

test('Mark as Todo reserves when the stock is there, otherwise the transfer waits', () => {
  const db = seed();
  const p = goods(db);
  const ok = delivery(db, p, 1);
  assert.equal(read(button('Mark as Todo').run(ok.db, read(ok.db, 'stock.picking', ok.id)).db, 'stock.picking', ok.id).state, 'ready');
  const short = delivery(db, p, p.qty_available + 10);
  assert.equal(pickingAvailability(short.db, read(short.db, 'stock.picking', short.id)), 'partial');
  assert.equal(read(reservePicking(short.db, read(short.db, 'stock.picking', short.id)), 'stock.picking', short.id).state, 'waiting');
});

test('stock reserved by other ready deliveries is not free for a new one', () => {
  const db = seed();
  const p = goods(db);
  const first = delivery(db, p, p.qty_available, { state: 'ready' });
  assert.equal(freeQty(first.db, p.id), 0);
  const second = delivery(first.db, p, 1);
  assert.equal(read(reservePicking(second.db, read(second.db, 'stock.picking', second.id)), 'stock.picking', second.id).state, 'waiting');
});

test('validating a partial quantity moves only what was done and creates a backorder for the rest', () => {
  const db = seed();
  const p = goods(db);
  const before = p.qty_available;
  const { db: d1, id } = delivery(db, p, 4, { state: 'ready' });
  const partial = write(d1, 'stock.picking', id, { move_ids: [{ product_id: p.id, qty: 4, quantity: 3 }] });
  const done = button('Validate').run(partial, read(partial, 'stock.picking', id)).db;
  assert.equal(read(done, 'product', p.id).qty_available, before - 3);
  const original = read(done, 'stock.picking', id);
  assert.equal(original.state, 'done');
  assert.deepEqual(original.move_ids.map((m) => m.qty), [3]);
  const backorder = search(done, 'stock.picking').find((x) => x.backorder_id === id);
  assert.deepEqual(backorder.move_ids.map((m) => m.qty), [1]);
  assert.ok(['ready', 'waiting'].includes(backorder.state));
});

test('validating everything creates no backorder; a zero quantity is refused', () => {
  const db = seed();
  const p = goods(db);
  const { db: d1, id } = delivery(db, p, 2, { state: 'ready' });
  const done = button('Validate').run(d1, read(d1, 'stock.picking', id)).db;
  assert.equal(search(done, 'stock.picking').some((x) => x.backorder_id === id), false);
  const zero = write(d1, 'stock.picking', id, { move_ids: [{ product_id: p.id, qty: 2, quantity: 0 }] });
  assert.throws(() => button('Validate').run(zero, read(zero, 'stock.picking', id)), /quantities done/);
});

test('a done delivery can be returned: the return brings the stock back', () => {
  const db = seed();
  const p = goods(db);
  const before = p.qty_available;
  const { db: d1, id } = delivery(db, p, 2, { state: 'ready' });
  const done = button('Validate').run(d1, read(d1, 'stock.picking', id)).db;
  const ret = returnPicking(done, read(done, 'stock.picking', id));
  const back = read(ret.db, 'stock.picking', ret.id);
  assert.deepEqual([back.picking_type, back.return_of, back.origin], ['incoming', id, `Return of ${read(done, 'stock.picking', id).name}`]);
  const received = button('Validate').run(ret.db, back).db;
  assert.equal(read(received, 'product', p.id).qty_available, before);
  assert.throws(() => returnPicking(d1, read(d1, 'stock.picking', id)), /Only done/);
});

test('Mark as Todo creates the quality checks and Validate waits for them', () => {
  const db = seed();
  const p = goods(db);
  const point = create(db, 'quality.point', { name: 'Inspect', operation: 'delivery', test_type: 'pass_fail', frequency: 'all', product_id: p.id });
  const d = delivery(point.db, p, 1);
  const todo = button('Mark as Todo').run(d.db, read(d.db, 'stock.picking', d.id)).db;
  const check = search(todo, 'quality.check').find((c) => c.picking_id === d.id);
  assert.equal(check.result, 'none');
  assert.throws(() => button('Validate').run(todo, read(todo, 'stock.picking', d.id)), /quality check/);
  const passed = write(todo, 'quality.check', check.id, { result: 'pass' });
  assert.equal(read(button('Validate').run(passed, read(passed, 'stock.picking', d.id)).db, 'stock.picking', d.id).state, 'done');
});
