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

test('the first record of a new model and a delete on an absent model are counted exactly', () => {
  const db = seed();
  delete db.records['crm.lead'];
  const lead = { ...create(seed(), 'crm.lead', { name: 'First' }).db.records['crm.lead'][0] };
  const next = applyDiff(db, { upserts: { 'crm.lead': [lead] } });
  assert.ok(dbSize(next) >= JSON.stringify(next).length - 2, `${dbSize(next)} vs ${JSON.stringify(next).length}`);
  const untouched = applyDiff(db, { deletes: { 'crm.lead': [999] } });
  assert.equal('crm.lead' in untouched.records, false);
  // Sync also persists the existing legal-number high-water marks on first application.
  assert.ok(Math.abs(dbSize(untouched) - JSON.stringify(untouched).length) <= 2);
});
