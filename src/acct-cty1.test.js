import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { applyDiff, diffDb } from './sync.js';
import { migrate, SCHEMA_VERSION } from './migrations.js';
import { autoFiscalPosition } from './models/taxes.js';
import { models } from './models/index.js';
import { create } from './orm.js';
import { importCsvRows } from './csv.js';

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
    'account.tax.group': [
      { id: 1, name: 'Exact', country: 'EG' },
      { id: 2, name: 'Unknown', country: 'unknown' },
      { id: 3, name: 'Normalized', country: '  egypt  ' },
    ],
    'account.tax': [{ id: 1, name: 'Tax', country: 'Egypt' }],
    'account.account.tag': [{ id: 1, name: 'Tag', country: 'Egypt' }],
    'account.fiscal.position': [{ id: 1, name: 'FP', country: 'Egypt', state_ids: [state.code], auto_apply: true }],
  } };
  const migrated = migrate(old);
  assert.equal(migrated.schema_version, SCHEMA_VERSION);
  assert.equal(migrated.records['account.tax.group'][0].country_id, egypt.id);
  assert.equal(migrated.records['account.tax.group'][1].country_id, null);
  assert.equal(migrated.records['account.tax.group'][1].country, 'unknown');
  assert.equal(migrated.records['account.tax.group'][2].country_id, egypt.id);
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

test('Finding 1: migration resolves country codes, leaves informal names unresolved, creates unseeded states under resolved country, and disables auto_apply for unresolved targeting', () => {
  const db = seed();
  const us = db.records['res.country'].find((c) => c.code === 'US');
  const uae = db.records['res.country'].find((c) => c.code === 'AE');
  const ksa = db.records['res.country'].find((c) => c.code === 'SA');

  const old = {
    ...db,
    schema_version: SCHEMA_VERSION - 1,
    records: {
      ...db.records,
      'account.fiscal.position': [
        // ISO codes (any case/spacing), an informal name and unseeded states
        { id: 10, name: 'UAE Position', country: 'ae', auto_apply: true },
        { id: 11, name: 'KSA Position', country: ' SA ', auto_apply: true },
        { id: 12, name: 'UK Position', country: 'UK', auto_apply: true },
        { id: 13, name: 'US CA Position', country: 'US', state_ids: ['CA'], auto_apply: true },
        // Unresolved country targeting
        { id: 14, name: 'Unresolved Country FP', country: 'UnknownLand', auto_apply: true },
        // Unresolved state targeting
        { id: 15, name: 'Unresolved State FP', state_ids: ['NonexistentStateWithoutCountry'], auto_apply: true },
      ],
    },
  };

  const migrated = migrate(old);
  const fpMap = Object.fromEntries(migrated.records['account.fiscal.position'].map((fp) => [fp.id, fp]));

  // Codes resolved; the informal "UK" is not guessed as GB
  assert.equal(fpMap[10].country_id, uae.id);
  assert.equal(fpMap[11].country_id, ksa.id);
  assert.equal(fpMap[12].country_id, null);
  assert.equal(fpMap[12].auto_apply, false);
  assert.equal(fpMap[13].country_id, us.id);

  // CA state was created under US
  assert.equal(fpMap[13].state_ids.length, 1);
  const caState = migrated.records['res.country.state'].find((s) => s.id === fpMap[13].state_ids[0]);
  assert.ok(caState, 'CA state should be created in res.country.state');
  assert.equal(caState.country_id, us.id);
  assert.equal(caState.code, 'CA');
  assert.equal(fpMap[13].auto_apply, true);

  // Unresolved targeting disables auto_apply and retains legacy text
  assert.equal(fpMap[14].country_id, null);
  assert.equal(fpMap[14].country, 'UnknownLand');
  assert.equal(fpMap[14].auto_apply, false);
  assert.equal(fpMap[14].unresolved_targeting, true);

  assert.equal(fpMap[15].state_ids.length, 0);
  assert.deepEqual(fpMap[15].states, ['NonexistentStateWithoutCountry']);
  assert.equal(fpMap[15].auto_apply, false);
  assert.equal(fpMap[15].unresolved_targeting, true);

  // Upgraded unresolved positions never match as country-wide or global fallbacks
  assert.equal(autoFiscalPosition(migrated, { country_id: uae.id }), 10);
  assert.equal(autoFiscalPosition(migrated, { country_id: us.id, state_id: caState.id }), 13);
  // An address in an unrelated country does NOT match unresolved FPs 14 or 15
  assert.notEqual(autoFiscalPosition(migrated, { country_id: 9999 }), 14);
  assert.notEqual(autoFiscalPosition(migrated, { country_id: 9999 }), 15);
});

test('Finding 3: state-only fiscal positions can be saved and matched without country constraint', () => {
  const db = seed();
  const egypt = db.records['res.country'].find((c) => c.code === 'EG');
  const saudi = db.records['res.country'].find((c) => c.code === 'SA');
  const giza = db.records['res.country.state'].find((s) => s.country_id === egypt.id);
  const alex = db.records['res.country.state'].find((s) => s.country_id === egypt.id && s.id !== giza.id);
  const riyadh = db.records['res.country.state'].find((s) => s.country_id === saudi.id);

  // Guard accepts state-only fiscal position when country_id is null
  const { db: dbWithFp, id: fpId } = create(db, 'account.fiscal.position', {
    name: 'Giza Only',
    country_id: null,
    state_ids: [giza.id],
    auto_apply: true,
  });
  const stateFp = dbWithFp.records['account.fiscal.position'].find((r) => r.id === fpId);
  assert.equal(stateFp.name, 'Giza Only');
  assert.equal(stateFp.country_id, null);
  assert.deepEqual(stateFp.state_ids, [giza.id]);

  // Guard rejects nonexistent state ID when country_id is null
  assert.throws(
    () => create(db, 'account.fiscal.position', { name: 'Invalid State', country_id: null, state_ids: [999999] }),
    /Selected state does not exist/
  );

  // Guard rejects state from different country when country_id is set
  assert.throws(
    () => create(db, 'account.fiscal.position', { name: 'Mismatch', country_id: egypt.id, state_ids: [riyadh.id] }),
    /Select states belonging to the selected country/
  );

  // Address matching matches partner with matching state, regardless of whether country is set
  assert.equal(autoFiscalPosition(dbWithFp, { country_id: null, state_id: giza.id }), stateFp.id);
  assert.equal(autoFiscalPosition(dbWithFp, { country_id: egypt.id, state_id: giza.id }), stateFp.id);

  // Does not match different state or missing state
  assert.equal(autoFiscalPosition(dbWithFp, { country_id: egypt.id, state_id: alex.id }), null);
  assert.equal(autoFiscalPosition(dbWithFp, { country_id: egypt.id, state_id: null }), null);
});

test('Finding 4: many2many CSV import parses state_ids into record ID arrays and rejects malformed/nonexistent IDs', () => {
  const db = seed();
  const egypt = db.records['res.country'].find((c) => c.code === 'EG');
  const giza = db.records['res.country.state'].find((s) => s.country_id === egypt.id);
  const alex = db.records['res.country.state'].find((s) => s.country_id === egypt.id && s.id !== giza.id);

  // Nonempty state cell with integer IDs
  const rows = [
    ['Fiscal Position', 'Federal States'],
    ['FP Import Test', `${giza.id}, ${alex.id}`],
  ];
  const { db: importedDb } = importCsvRows(db, 'account.fiscal.position', models['account.fiscal.position'].defaults(), rows);
  const importedFp = importedDb.records['account.fiscal.position'].find((r) => r.name === 'FP Import Test');
  assert.ok(importedFp, 'Fiscal position should be imported');
  assert.deepEqual(importedFp.state_ids, [giza.id, alex.id]);

  // Nonexistent state ID rejects
  const badIdRows = [
    ['Fiscal Position', 'Federal States'],
    ['Bad ID FP', '999999'],
  ];
  assert.throws(
    () => importCsvRows(db, 'account.fiscal.position', models['account.fiscal.position'].defaults(), badIdRows),
    /Enter existing record IDs for Federal States/
  );

  // Malformed non-numeric/non-code string rejects
  const malformedRows = [
    ['Fiscal Position', 'Federal States'],
    ['Malformed FP', 'not-a-state'],
  ];
  assert.throws(
    () => importCsvRows(db, 'account.fiscal.position', models['account.fiscal.position'].defaults(), malformedRows),
    /Enter existing record IDs for Federal States/
  );
});

test('Finding 5: CSV import maps explicit ISO code columns and codes to record IDs without guessing from names', () => {
  const db = seed();
  const egypt = db.records['res.country'].find((c) => c.code === 'EG');

  // Explicit ISO code column res.country.code
  const explicitCodeRows = [
    ['Fiscal Position', 'res.country.code'],
    ['FP Explicit ISO', 'EG'],
  ];
  const { db: db1 } = importCsvRows(db, 'account.fiscal.position', models['account.fiscal.position'].defaults(), explicitCodeRows);
  const fp1 = db1.records['account.fiscal.position'].find((r) => r.name === 'FP Explicit ISO');
  assert.equal(fp1.country_id, egypt.id);

  // Country header with ISO code value "EG"
  const isoValRows = [
    ['Fiscal Position', 'Country'],
    ['FP ISO Val', 'EG'],
  ];
  const { db: db2 } = importCsvRows(db, 'account.fiscal.position', models['account.fiscal.position'].defaults(), isoValRows);
  const fp2 = db2.records['account.fiscal.position'].find((r) => r.name === 'FP ISO Val');
  assert.equal(fp2.country_id, egypt.id);

  // Country header with country name "Egypt" rejects (no name guessing per orchestrator note)
  const nameRows = [
    ['Fiscal Position', 'Country'],
    ['FP Name Val', 'Egypt'],
  ];
  assert.throws(
    () => importCsvRows(db, 'account.fiscal.position', models['account.fiscal.position'].defaults(), nameRows),
    /Enter an existing record ID for Country/
  );
});
