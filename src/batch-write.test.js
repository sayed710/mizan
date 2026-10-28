import { test } from 'node:test';
import assert from 'node:assert/strict';
import { read, search, write, writeMany } from './orm.js';
import { predictiveProbability, refreshProbabilities } from './models/crmteams.js';
import { seed } from './seed.js';

const strip = (db, model) => db.records[model];
const bodies = (db) => db.messages.map((m) => [m.model, m.res_id, m.body]);

test('writeMany gives the same records and tracking as one write per record', () => {
  const db = seed();
  const leads = search(db, 'crm.lead').slice(0, 3);
  const updates = new Map(leads.map((l, i) => [l.id, { name: `Batch ${i}`, priority: '2' }]));
  const one = [...updates].reduce((acc, [id, vals]) => write(acc, 'crm.lead', id, vals), db);
  const many = writeMany(db, 'crm.lead', updates);
  assert.deepEqual(strip(many, 'crm.lead'), strip(one, 'crm.lead'));
  assert.deepEqual(bodies(many), bodies(one));
  assert.strictEqual(writeMany(db, 'crm.lead', new Map()), db);
  assert.throws(() => writeMany(db, 'crm.lead', new Map([[999999, { name: 'x' }]])), /not found/);
  assert.throws(() => writeMany(db, 'crm.lead', new Map([[leads[0].id, { name: '' }]])), /required/);
});

test('the batched lead scoring matches scoring each lead on its own', () => {
  let base = seed();
  const leads = base.records['crm.lead'];
  // Enough history to score: three won and three lost leads.
  base = leads.slice(0, 3).reduce((acc, l) => write(acc, 'crm.lead', l.id, { stage_id: 'won' }), base);
  base = leads.slice(3, 6).reduce((acc, l) => write(acc, 'crm.lead', l.id, { active: false }), base);
  const db = refreshProbabilities(base);
  const open = search(db, 'crm.lead').filter((x) => x.stage_id !== 'won');
  assert.ok(open.length);
  for (const l of open) {
    assert.notEqual(predictiveProbability(base, l), null);
    assert.equal(read(db, 'crm.lead', l.id).automated_probability, predictiveProbability(base, l));
  }
});
