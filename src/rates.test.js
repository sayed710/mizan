import test from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { create, read } from './orm.js';
import { conversionRate, rateAt, toCompany } from './models/currency.js';
import { migrate, SCHEMA_VERSION } from './migrations.js';

test('company rates take precedence over shared rates as of the conversion date', () => {
  let db = seed();
  const base = db.settings.base_currency_id;
  const first = db.records['res.company'][0].id;
  const company = create(db, 'res.company', { name: 'Second company', currency_id: base });
  db = company.db;
  const foreign = create(db, 'res.currency', { name: 'Rate test', rate_ids: [
    { date: '2024-01-01', rate: 2, company_id: null },
    { date: '2024-03-01', rate: 3, company_id: null },
    { date: '2024-02-01', rate: 4, company_id: first },
    { date: '2024-04-01', rate: 8, company_id: first },
    { date: '2024-02-01', rate: 5, company_id: company.id },
  ] });
  db = foreign.db;
  assert.equal(rateAt(db, foreign.id, '2024-01-15', first), 2);
  assert.equal(rateAt(db, foreign.id, '2024-03-15', first), 4);
  assert.equal(rateAt(db, foreign.id, '2024-03-15', company.id), 5);
  assert.equal(rateAt(db, foreign.id, '2024-04-15', first), 8);
  assert.equal(rateAt(db, foreign.id, '2024-03-15'), 3);
  assert.equal(toCompany(db, foreign.id, 100, '2024-03-15', first), 25);
  assert.equal(toCompany(db, foreign.id, 100, '2024-03-15', company.id), 20);
  assert.equal(conversionRate(db, base, foreign.id, '2024-03-15', company.id), 5);
  assert.throws(() => rateAt(db, foreign.id, '2023-01-01', first), /No .* rate on or before/);
});

test('legacy currency rate migration marks rows shared and preserves company rates', () => {
  const db = seed();
  const currency = db.records['res.currency'][0];
  const old = { ...db, schema_version: 23, records: { ...db.records, 'res.currency': [{ ...currency, rate_ids: [
    { date: '2020-01-01', rate: 1 }, { date: '2021-01-01', rate: 2, company_id: 1 },
  ] }] } };
  const migrated = migrate(old);
  assert.equal(migrated.schema_version, SCHEMA_VERSION);
  assert.deepEqual(read(migrated, 'res.currency', currency.id).rate_ids.map((r) => r.company_id), [null, 1]);
  assert.equal(migrate(migrated), migrated);
  assert.equal(old.records['res.currency'][0].rate_ids[0].company_id, undefined);
});
