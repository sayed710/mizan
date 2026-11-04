import { test } from 'node:test';
import assert from 'node:assert/strict';
import { read, unlink, write } from './orm.js';
import { seed } from './seed.js';
import { applyDiff, diffDb } from './sync.js';

const lead = (db) => db.records['crm.lead'][0].id;
const save = (server, client, next) => applyDiff(server, diffDb(client, next), { author: 'test' });

test('two users editing different fields of one record both keep their change', () => {
  const base = seed();
  const id = lead(base);
  let server = save(base, base, write(base, 'crm.lead', id, { expected_revenue: 777777 }));
  server = save(server, base, write(base, 'crm.lead', id, { priority: 3 }));
  assert.equal(read(server, 'crm.lead', id).expected_revenue, 777777);
  assert.equal(read(server, 'crm.lead', id).priority, 3);
});

test('an edit on top of a value someone else changed is refused, not silently lost', () => {
  const base = seed();
  const id = lead(base);
  const server = save(base, base, write(base, 'crm.lead', id, { priority: 3 }));
  assert.throws(() => save(server, base, write(base, 'crm.lead', id, { priority: 2 })), (e) => e.conflict && /changed by someone else \(priority\)/.test(e.message));
  assert.equal(read(server, 'crm.lead', id).priority, 3);
});

test('two stock moves from the same snapshot cannot both land on the old quantity', () => {
  const base = seed();
  const p = base.records.product.find((r) => Number(r.qty_available) > 10);
  const alice = write(base, 'product', p.id, { qty_available: p.qty_available - 2 });
  const bob = write(base, 'product', p.id, { qty_available: p.qty_available - 3 });
  const server = save(base, base, alice);
  assert.throws(() => save(server, base, bob), /changed by someone else/);
  assert.equal(read(server, 'product', p.id).qty_available, p.qty_available - 2);
});

test('replaying an old change set is refused', () => {
  const base = seed();
  const id = lead(base);
  const first = diffDb(base, write(base, 'crm.lead', id, { priority: 2 }));
  let server = applyDiff(base, first, {});
  server = save(server, server, write(server, 'crm.lead', id, { priority: 3 }));
  assert.throws(() => applyDiff(server, first, {}), /changed by someone else/);
});

test('a slow server action keeps a colleague edit made while it ran', () => {
  const base = seed();
  const order = base.records['sale.order'][0];
  const colleague = save(base, base, write(base, 'sale.order', order.id, { note: 'Customer asked for delivery on Friday' }));
  const sent = save(colleague, base, write(base, 'sale.order', order.id, { state: 'sent' }));
  assert.equal(read(sent, 'sale.order', order.id).state, 'sent');
  assert.equal(read(sent, 'sale.order', order.id).note, 'Customer asked for delivery on Friday');
});

test('editing a record someone else deleted is refused instead of bringing it back', () => {
  const base = seed();
  const id = lead(base);
  const server = save(base, base, unlink(base, 'crm.lead', [id]));
  assert.throws(() => save(server, base, write(base, 'crm.lead', id, { priority: 2 })), /deleted by someone else/);
});

test('a change set without bases (older client) applies whole records as before', () => {
  const base = seed();
  const id = lead(base);
  const { bases, ...legacy } = diffDb(base, write(base, 'crm.lead', id, { priority: 2 }));
  assert.ok(bases['crm.lead'][id]);
  assert.equal(read(applyDiff(base, legacy, {}), 'crm.lead', id).priority, 2);
});
