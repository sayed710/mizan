import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create } from './orm.js';
import { seed } from './seed.js';
import { applyDiff, assignIds, diffDb, remapDiff } from './sync.js';

const save = (server, client, next) => {
  const { diff, remapped } = assignIds(server, diffDb(client, next));
  return { db: applyDiff(server, diff, { author: 'test' }), remapped };
};

test('two users creating from the same snapshot both keep their record', () => {
  const base = seed();
  const a = create(base, 'res.partner', { name: 'From Alice' });
  const b = create(base, 'res.partner', { name: 'From Bob' });
  assert.equal(a.id, b.id);
  let server = save(base, base, a.db).db;
  const second = save(server, base, b.db);
  server = second.db;
  const names = server.records['res.partner'].map((p) => p.name);
  assert.ok(names.includes('From Alice') && names.includes('From Bob'));
  assert.deepEqual(second.remapped, { 'res.partner': { [b.id]: b.id + 1 } });
  assert.equal(server.records['res.partner'].find((p) => p.name === 'From Bob').id, b.id + 1);
  assert.equal(server.seq['res.partner'], b.id + 1);
});

test('references and chatter in the same change set follow the new id', () => {
  const base = seed();
  const rival = save(base, base, create(base, 'res.partner', { name: 'Rival' }).db).db;
  const partner = create(base, 'res.partner', { name: 'Linked' });
  const lead = create(partner.db, 'crm.lead', { name: 'Deal', partner_id: partner.id });
  const next = { ...lead.db, messages: [...lead.db.messages, { id: 'm-new', model: 'res.partner', res_id: partner.id, body: 'hi', date: '2026-10-26' }] };
  const { db, remapped } = save(rival, base, next);
  const moved = remapped['res.partner'][partner.id];
  assert.ok(moved > partner.id);
  assert.equal(db.records['crm.lead'].find((l) => l.name === 'Deal').partner_id, moved);
  assert.equal(db.messages.find((m) => m.id === 'm-new').res_id, moved);
  assert.equal(db.records['res.partner'].find((p) => p.id === partner.id).name, 'Rival');
});

test('client-chosen ids far above the counter are replaced by the next free id', () => {
  const base = seed();
  const top = Math.max(...base.records['res.partner'].map((p) => p.id), base.seq['res.partner'] ?? 0);
  const forged = { ...base, records: { ...base.records, 'res.partner': [...base.records['res.partner'], { ...create(base, 'res.partner', { name: 'Huge' }).db.records['res.partner'].at(-1), id: 9_000_000 }] } };
  const { db } = save(base, base, forged);
  assert.equal(db.records['res.partner'].find((p) => p.name === 'Huge').id, top + 1);
});

test('edits to existing records keep their ids', () => {
  const base = seed();
  const p = base.records['res.partner'][0];
  const next = { ...base, records: { ...base.records, 'res.partner': base.records['res.partner'].map((r) => (r.id === p.id ? { ...r, name: 'Renamed' } : r)) } };
  const { db, remapped } = save(base, base, next);
  assert.deepEqual(remapped, {});
  assert.equal(db.records['res.partner'].find((r) => r.id === p.id).name, 'Renamed');
});

test('a change queued against a local id is rewritten through the remap', () => {
  const d = { upserts: { 'res.partner': [{ id: 5, name: 'x' }] }, deletes: { 'res.partner': [5] }, messages: [{ id: 'm', model: 'res.partner', res_id: 5 }] };
  const out = remapDiff(d, { 'res.partner': { 5: 8 } });
  assert.equal(out.upserts['res.partner'][0].id, 8);
  assert.deepEqual(out.deletes['res.partner'], [8]);
  assert.equal(out.messages[0].res_id, 8);
});
