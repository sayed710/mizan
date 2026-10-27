import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read } from './orm.js';
import { seed } from './seed.js';
import { applyDiff, dbSize, diffDb } from './sync.js';

test('the size limit is tracked from each diff and stays close to the real serialized size', () => {
  let db = seed();
  const base = db;
  const partner = read(db, 'res.partner', 1);
  db = applyDiff(db, { upserts: { 'res.partner': [{ ...partner, name: 'A much longer partner name than before' }] } });
  const lead = create(db, 'crm.lead', { name: 'New lead' });
  db = applyDiff(db, diffDb(db, lead.db));
  db = applyDiff(db, { deletes: { 'crm.lead': [lead.id] }, messages: [{ id: 'm1', model: 'res.partner', res_id: 1, body: 'hello', kind: 'note', date: '2026-01-01' }] });
  for (const snapshot of [base, db]) assert.ok(Math.abs(dbSize(snapshot) - JSON.stringify(snapshot).length) <= 4, `${dbSize(snapshot)} vs ${JSON.stringify(snapshot).length}`);
});

test('a save only looks at the models that changed', () => {
  const db = seed();
  const next = applyDiff(db, { upserts: { 'res.partner': [{ ...read(db, 'res.partner', 1), name: 'Changed' }] } });
  for (const [model, list] of Object.entries(db.records)) if (model !== 'res.partner') assert.equal(next.records[model], list);
  assert.deepEqual(Object.keys(diffDb(db, next).upserts), ['res.partner']);
});
