import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { applyDiff, diffDb } from './sync.js';
import { migrate, SCHEMA_VERSION } from './migrations.js';
import { autoFiscalPosition } from './models/taxes.js';
import { models } from './models/index.js';

const update = (db, model, records) => ({ ...db, records: { ...db.records, [model]: records } });

test('CTY-1: Odoo countries and states exist and only administrators can change them through sync', () => {
  const db = seed();
  const countries = db.records['res.country'];
  const egypt = countries.find((c) => c.code === 'EG');
  const saudi = countries.find((c) => c.code === 'SA');
  assert.ok(countries.length >= 249);
  assert.equal(egypt.name, 'Egypt');
  assert.equal(egypt.phone_code, 20);
  assert.equal(db.records['res.currency'].find((c) => c.id === egypt.currency_id)?.name, 'EGP');
  assert.equal(saudi.phone_code, 966);
  assert.ok(db.records['res.country.state'].filter((s) => s.country_id === egypt.id).length >= 27);
  assert.ok(db.records['res.country.state'].filter((s) => s.country_id === saudi.id).length >= 13);
  for (const model of ['res.country', 'res.country.state']) {
    const rows = db.records[model];
    const changed = update(db, model, rows.map((r, i) => i ? r : { ...r, name: 'Changed' }));
    assert.throws(() => applyDiff(db, diffDb(db, changed)), /Only administrators/);
    assert.equal(applyDiff(db, diffDb(db, changed), { isAdmin: true }).records[model][0].name, 'Changed');
    assert.throws(() => applyDiff(db, diffDb(db, update(db, model, rows.slice(1)))), /Only administrators/);
  }
  const states = db.records['res.country.state'];
  const invalid = update(db, 'res.country.state', states.map((r, i) => i ? r : { ...r, country_id: 999999 }));
  assert.throws(() => applyDiff(db, diffDb(db, invalid), { isAdmin: true }), /Selected country does not exist/);
});

test('CTY-2: migration uses exact matches, fiscal positions match IDs and sync rejects invalid references', () => {
  const db = seed();
  const egypt = db.records['res.country'].find((c) => c.code === 'EG');
  const saudi = db.records['res.country'].find((c) => c.code === 'SA');
  const state = db.records['res.country.state'].find((s) => s.country_id === egypt.id);
  const old = { ...db, schema_version: SCHEMA_VERSION - 1, records: { ...db.records,
    'account.tax.group': [{ id: 1, name: 'Exact', country: 'EG' }, { id: 2, name: 'Unknown', country: 'egypt' }],
    'account.tax': [{ id: 1, name: 'Tax', country: 'Egypt' }],
    'account.account.tag': [{ id: 1, name: 'Tag', country: 'Egypt' }],
    'account.fiscal.position': [{ id: 1, name: 'FP', country: 'Egypt', state_ids: [state.code], auto_apply: true }],
  } };
  const migrated = migrate(old);
  assert.equal(migrated.schema_version, SCHEMA_VERSION);
  assert.equal(migrated.records['account.tax.group'][0].country_id, egypt.id);
  assert.equal(migrated.records['account.tax.group'][1].country_id, null);
  assert.equal(migrated.records['account.tax'][0].country_id, egypt.id);
  assert.equal(migrated.records['account.account.tag'][0].country_id, egypt.id);
  assert.deepEqual(migrated.records['account.fiscal.position'][0].state_ids, [state.id]);
  assert.equal(autoFiscalPosition(migrated, { country_id: egypt.id, state_id: state.id }), 1);
  assert.equal(autoFiscalPosition(migrated, { country_id: saudi.id, state_id: state.id }), null);
  for (const model of ['account.tax.group', 'account.tax', 'account.account.tag', 'account.fiscal.position']) {
    assert.equal(models[model].fields.country_id.relation, 'res.country');
    const rows = db.records[model];
    if (!rows.length) continue;
    const changed = update(db, model, rows.map((r, i) => i ? r : { ...r, country_id: 999999 }));
    assert.throws(() => applyDiff(db, diffDb(db, changed), { isAdmin: true }), /Selected country does not exist/);
  }
  const fps = db.records['account.fiscal.position'];
  const bad = update(db, 'account.fiscal.position', fps.map((r, i) => i ? r : { ...r, country_id: saudi.id, state_ids: [state.id] }));
  assert.throws(() => applyDiff(db, diffDb(db, bad), { isAdmin: true }), /Select states belonging/);
});
