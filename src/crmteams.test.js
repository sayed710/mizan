import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from './orm.js';
import { assignAllTeams, assignLeads, predictiveProbability } from './models/crmteams.js';
import { seed } from './seed.js';

const withHistory = () => {
  let db = seed();
  const add = (vals) => { db = create(db, 'crm.lead', { name: 'L', type: 'opportunity', ...vals }).db; };
  for (let i = 0; i < 4; i += 1) add({ country: 'Egypt', medium: 'referral', stage_id: 'won' });
  add({ country: 'Egypt', medium: 'website', stage_id: 'won' });
  for (let i = 0; i < 4; i += 1) add({ country: 'UAE', medium: 'website', stage_id: 'qualified', active: false, lost_reason: 'price' });
  add({ country: 'Egypt', medium: 'website', stage_id: 'new', active: false, lost_reason: 'price' });
  return db;
};

test('predictive scoring favours features seen on won leads and needs enough history', () => {
  const db = withHistory();
  const good = predictiveProbability(db, { country: 'Egypt', medium: 'referral', stage_id: 'new' });
  const bad = predictiveProbability(db, { country: 'UAE', medium: 'website', stage_id: 'new' });
  assert.ok(good > 80, `good ${good}`);
  assert.ok(bad < 20, `bad ${bad}`);
  assert.ok(good <= 100 && bad >= 0);
  assert.equal(predictiveProbability(seed(), { country: 'Egypt' }), null);
});

test('assignment follows team rules and member capacity, least loaded first', () => {
  let db = seed();
  for (let i = 0; i < 5; i += 1) db = create(db, 'crm.lead', { name: `Lead ${i}`, country: 'Egypt', type: 'lead', user: '' }).db;
  db = create(db, 'crm.lead', { name: 'Dubai lead', country: 'UAE', type: 'lead', user: '' }).db;
  const team = create(db, 'crm.team', { name: 'Egypt', auto_assign: true, country: 'Egypt', member_ids: [{ name: 'A', capacity: 2 }, { name: 'B', capacity: 2 }] });
  const done = assignLeads(team.db, read(team.db, 'crm.team', team.id), '2026-06-01');
  const mine = search(done, 'crm.lead').filter((l) => l.team_id === team.id);
  assert.equal(mine.length, 4);
  assert.deepEqual(['A', 'B'].map((n) => mine.filter((l) => l.user === n).length), [2, 2]);
  assert.ok(!mine.some((l) => l.country === 'UAE'));
  assert.equal(search(done, 'crm.lead').find((l) => l.name === 'Lead 4').team_id ?? null, null);
});

test('the seeded teams auto-assign by country through the scheduler job', () => {
  let db = seed();
  db = create(db, 'crm.lead', { name: 'Gulf deal', country: 'UAE', type: 'lead', user: '' }).db;
  const out = assignAllTeams(db, '2026-06-01');
  const lead = search(out, 'crm.lead').find((l) => l.name === 'Gulf deal');
  assert.equal(lead.user, 'Laila Samir');
});
