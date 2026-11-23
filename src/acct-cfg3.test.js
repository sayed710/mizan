import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create } from './orm.js';
import { seed } from './seed.js';
import { models } from './registry.js';
import { applyDiff, diffDb } from './sync.js';

test('Domestic taxes have no fiscal position or include the company domestic position', () => {
  const db = seed();
  const company = db.records['res.company'].find((r) => r.id === 1);
  const scoped = { ...db, records: { ...db.records, 'res.company': db.records['res.company'].map((r) => r.id === 1 ? { ...company, domestic_fiscal_position_id: 42 } : r) } };
  const filter = models['account.tax'].filters.flat().find((f) => f.id === 'domestic');
  assert.equal(filter.fn({ company_id: 1, fiscal_position_ids: [] }, scoped), true);
  assert.equal(filter.fn({ company_id: 1, fiscal_position_ids: [42, 43] }, scoped), true);
  assert.equal(filter.fn({ company_id: 1, fiscal_position_ids: [43] }, scoped), false);
});

test('ledger group names are globally unique, including through sync', () => {
  let db = seed();
  const first = create(db, 'account.journal.group', { name: 'IFRS', company_id: 1 });
  db = first.db;
  assert.throws(() => create(db, 'account.journal.group', { name: 'IFRS', company_id: 1 }), /A Ledger group name must be unique\./);
  const second = create(db, 'account.journal.group', { name: 'Local', company_id: 1 });
  const raw = diffDb(db, second.db);
  raw.upserts['account.journal.group'][0].name = 'IFRS';
  assert.throws(() => applyDiff(db, raw, { isAdmin: true }), /A Ledger group name must be unique\./);
});
