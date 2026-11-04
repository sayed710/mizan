import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { MAX_ID, applyDiff, repairSeq } from './sync.js';
import { create } from './orm.js';

const contactsOnly = { isAdmin: false, allowed: new Set(['res.partner']) };

test('client id counters are ignored: a user cannot poison the next id of any model', () => {
  const db = seed();
  const before = db.seq['sale.order'];
  const next = applyDiff(db, { upserts: {}, seq: { 'sale.order': 1e300, 'res.partner': Number.MAX_SAFE_INTEGER } }, contactsOnly);
  assert.equal(next.seq['sale.order'], before);
  assert.equal(next.seq['res.partner'], db.seq['res.partner']);
});

test('counters follow the records stored, so creates keep getting fresh ids', () => {
  const { db: local, id } = create(seed(), 'res.partner', { name: 'New contact' });
  const next = applyDiff(seed(), { upserts: { 'res.partner': [local.records['res.partner'].find((p) => p.id === id)] } }, contactsOnly);
  assert.equal(next.seq['res.partner'], id);
});

test('record ids beyond the safe range are refused', () => {
  for (const id of [1e300, MAX_ID + 1, 1.5]) {
    assert.throws(() => applyDiff(seed(), { upserts: { 'res.partner': [{ id, name: 'X' }] } }, contactsOnly), /Invalid res.partner record/);
  }
});

test('a restricted user cannot delete chatter messages of models outside their access', () => {
  const db = seed();
  const foreign = db.messages.find((m) => m.model !== 'res.partner');
  const own = db.messages.find((m) => m.model === 'res.partner');
  assert.ok(foreign, 'seed has messages on other models');
  const ids = [foreign.id, ...(own ? [own.id] : [])];
  const next = applyDiff(db, { upserts: {}, removedMessages: ids }, contactsOnly);
  assert.ok(next.messages.some((m) => m.id === foreign.id), 'foreign message kept');
  if (own) assert.ok(!next.messages.some((m) => m.id === own.id), 'own-model message removed');
});

test('repairSeq resets poisoned or lagging counters and leaves healthy ones alone', () => {
  const db = seed();
  const top = Math.max(...db.records['sale.order'].map((r) => r.id));
  const poisoned = { ...db, seq: { ...db.seq, 'sale.order': 1e300, 'res.partner': 0 } };
  const fixed = repairSeq(poisoned);
  assert.equal(fixed.seq['sale.order'], top);
  assert.equal(fixed.seq['res.partner'], Math.max(...db.records['res.partner'].map((r) => r.id)));
  assert.equal(repairSeq(db), db);
});

test('a new id far past the counter is refused, so one record cannot exhaust the id space', async () => {
  const { ID_WINDOW } = await import('./sync.js');
  const db = seed();
  const top = db.seq['res.partner'];
  assert.throws(() => applyDiff(db, { upserts: { 'res.partner': [{ id: top + ID_WINDOW + 1, name: 'Far' }] } }, contactsOnly), /Invalid res.partner record/);
  const next = applyDiff(db, { upserts: { 'res.partner': [{ id: top + 3, name: 'Queued offline' }] } }, contactsOnly);
  const { id } = create(next, 'res.partner', { name: 'After' });
  assert.equal(id, top + 4);
  applyDiff(next, { upserts: { 'res.partner': [{ id, name: 'After' }] } }, contactsOnly);
});

test('counters work on models with more records than a function call can take as arguments', async () => {
  const { maxId } = await import('./sync.js');
  const many = Array.from({ length: 300_000 }, (_, i) => ({ id: i + 1 }));
  assert.equal(maxId(many), 300_000);
  const db = { ...seed(), seq: { 'res.partner': 0 }, records: { 'res.partner': many } };
  assert.equal(repairSeq(db).seq['res.partner'], 300_000);
});

test('startup preserves a safe historical counter even after many records were deleted', () => {
  const db = seed();
  const historical = { ...db, seq: { ...db.seq, 'res.partner': 2000000 } };
  const repaired = repairSeq(historical);
  assert.equal(repaired.seq['res.partner'], 2000000);
  assert.equal(create(repaired, 'res.partner', { name: 'Never reuse an id' }).id, 2000001);
});

test('legacy records with ids above MAX_ID keep accepting new records after a repair', () => {
  const db = seed();
  const big = MAX_ID * 2;
  const legacy = repairSeq({ ...db, seq: { ...db.seq, 'res.partner': 5 }, records: { ...db.records, 'res.partner': [...db.records['res.partner'], { id: big, name: 'Old' }] } });
  assert.equal(legacy.seq['res.partner'], big);
  const next = applyDiff(legacy, { upserts: { 'res.partner': [{ id: big + 1, name: 'New' }] } }, contactsOnly);
  assert.equal(next.seq['res.partner'], big + 1);
});
