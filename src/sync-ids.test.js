import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create } from './orm.js';
import { seed } from './seed.js';
import { applyDiff, assignIds, diffDb, rebaseDiff, remapDiff } from './sync.js';

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

test('two quick saves keep their link when the first save moves onto the second one\'s local id', () => {
  const base = seed();
  // Someone else takes the next id on the server first.
  const server0 = save(base, base, create(base, 'hr.department', { name: 'Rival' }).db).db;
  // This browser creates a department, then (before the first save returns) a sub-department of it.
  const first = create(base, 'hr.department', { name: 'Mine' });
  const second = create(first.db, 'hr.department', { name: 'Child', parent_id: first.id });
  assert.equal(second.id, first.id + 1);
  const one = save(server0, base, first.db);
  assert.equal(one.remapped['hr.department'][first.id], first.id + 1, 'the first record now sits on the second one\'s local id');
  const queued = rebaseDiff(diffDb(first.db, second.db), one.remapped);
  const { diff } = assignIds(one.db, queued);
  const db = applyDiff(one.db, diff, { author: 'test' });
  const mine = db.records['hr.department'].find((p) => p.name === 'Mine');
  const child = db.records['hr.department'].find((p) => p.name === 'Child');
  assert.equal(child.parent_id, mine.id);
  assert.notEqual(child.id, mine.id);
});

test('client counters are ignored, so a huge counter cannot make creates share an id', () => {
  const base = seed();
  const poisoned = applyDiff(base, { upserts: {}, seq: { 'res.partner': 1e100 } }, { author: 'test' });
  assert.equal(poisoned.seq['res.partner'], base.seq['res.partner']);
  const a = save(poisoned, base, create(base, 'res.partner', { name: 'A' }).db).db;
  const b = save(a, base, create(base, 'res.partner', { name: 'B' }).db).db;
  const ids = b.records['res.partner'].filter((p) => p.name === 'A' || p.name === 'B').map((p) => p.id);
  assert.equal(new Set(ids).size, 2);
});

test('a queued company selection follows the new company id', () => {
  const out = remapDiff({ upserts: {}, settings: { current_company_id: 7, allowed_company_ids: [1, 7] } }, { 'res.company': { 7: 9 } });
  assert.equal(out.settings.current_company_id, 9);
  assert.deepEqual(out.settings.allowed_company_ids, [1, 9]);
});

test('invoice lines keep pointing at a tax account created in the same save', () => {
  const out = remapDiff({ upserts: { 'account.move': [{ id: 1, invoice_line_ids: [{ id: 1, tax_account_id: 50, product_id: null }] }] } }, { 'account.account': { 50: 60 } });
  assert.equal(out.upserts['account.move'][0].invoice_line_ids[0].tax_account_id, 60);
});
