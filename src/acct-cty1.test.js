import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { applyDiff, diffDb } from './sync.js';
import { migrate, SCHEMA_VERSION } from './migrations.js';
import { autoFiscalPosition, fiscalPositionFor, isDomesticTax } from './models/taxes.js';
import { countryIdFor, countryReferenceError, stateIdFor } from './models/country.js';
import { models } from './models/index.js';
import { create, read, search, write } from './orm.js';
import { importCsvRows } from './csv.js';
import { cartTotals } from './models/shop.js';
import { publicCart, publicOrder } from '../server/api.js';
import { priceLines } from './models/pos.js';

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

test('Qodo 1: repaired migrated fiscal positions clear unresolved_targeting and auto-apply once targeting is valid', () => {
  const db = seed();
  const egypt = db.records['res.country'].find((c) => c.code === 'EG');
  const saudi = db.records['res.country'].find((c) => c.code === 'SA');
  const giza = db.records['res.country.state'].find((s) => s.country_id === egypt.id && s.name === 'Giza');
  const alex = db.records['res.country.state'].find((s) => s.country_id === egypt.id && s.name === 'Alexandria');

  const old = {
    ...db,
    schema_version: SCHEMA_VERSION - 1,
    records: {
      ...db.records,
      'account.fiscal.position': [
        { id: 20, name: 'Unresolved Country FP', country: 'UnknownLand', auto_apply: true, sequence: 1 },
        { id: 21, name: 'Unresolved State FP', state_ids: ['UnknownState'], auto_apply: true, sequence: 2 },
        { id: 22, name: 'Unresolved Both FP', country: 'Nowhere', state_ids: ['NoState'], auto_apply: true, sequence: 3 },
      ],
    },
  };

  let migrated = migrate(old);
  assert.equal(autoFiscalPosition(migrated, { country_id: egypt.id }), null);

  // Unrelated edits or enabling auto_apply without repairing targeting keep the position excluded
  let partial = write(migrated, 'account.fiscal.position', 20, { name: 'Renamed Unresolved' });
  partial = write(partial, 'account.fiscal.position', 20, { auto_apply: true });
  assert.equal(read(partial, 'account.fiscal.position', 20).unresolved_targeting, true);
  assert.equal(autoFiscalPosition(partial, { country_id: egypt.id }), null);
  assert.equal(autoFiscalPosition(partial, { country_id: saudi.id }), null);

  // Completing country repair clears unresolved_targeting and legacy country, and allows auto-apply
  let repairedCountry = write(partial, 'account.fiscal.position', 20, { country_id: egypt.id });
  const fp20 = read(repairedCountry, 'account.fiscal.position', 20);
  assert.equal(fp20.unresolved_targeting, undefined);
  assert.equal(fp20.country, undefined);
  assert.equal(autoFiscalPosition(repairedCountry, { country_id: egypt.id }), 20);
  assert.equal(autoFiscalPosition(repairedCountry, { country_id: saudi.id }), null);

  // Repairing an unresolved state position with state_ids + auto_apply selects it only for that state
  let repairedState = write(migrated, 'account.fiscal.position', 21, { state_ids: [giza.id], auto_apply: true });
  const fp21 = read(repairedState, 'account.fiscal.position', 21);
  assert.equal(fp21.unresolved_targeting, undefined);
  assert.equal(fp21.states, undefined);
  assert.equal(autoFiscalPosition(repairedState, { country_id: egypt.id, state_id: giza.id }), 21);
  assert.equal(autoFiscalPosition(repairedState, { country_id: egypt.id, state_id: alex.id }), null);

  // Two-step repair on both-unresolved position keeps it excluded until both country and state are repaired
  let step1 = write(migrated, 'account.fiscal.position', 22, { country_id: egypt.id });
  assert.equal(read(step1, 'account.fiscal.position', 22).unresolved_targeting, true);
  assert.equal(autoFiscalPosition(step1, { country_id: egypt.id, state_id: giza.id }), null);
  let step2 = write(step1, 'account.fiscal.position', 22, { state_ids: [giza.id], auto_apply: true });
  assert.equal(read(step2, 'account.fiscal.position', 22).unresolved_targeting, undefined);
  assert.equal(autoFiscalPosition(step2, { country_id: egypt.id, state_id: giza.id }), 22);
});

test('Qodo 2: lowercase, whitespace-padded, and alias country/state addresses match fiscal positions across partners, POS, and checkout', () => {
  let db = seed();
  const egypt = search(db, 'res.country').find((c) => c.code === 'EG');
  const uae = search(db, 'res.country').find((c) => c.code === 'AE');
  const ksa = search(db, 'res.country').find((c) => c.code === 'SA');
  const us = search(db, 'res.country').find((c) => c.code === 'US');
  const gb = search(db, 'res.country').find((c) => c.code === 'GB');
  const giza = search(db, 'res.country.state').find((s) => s.country_id === egypt.id && s.name === 'Giza');

  // Helper normalization & alias resolution, with strict integer ID checks
  assert.equal(countryIdFor(db, 'egypt'), egypt.id);
  assert.equal(countryIdFor(db, ' Egypt '), egypt.id);
  assert.equal(countryIdFor(db, ' eg '), egypt.id);
  assert.equal(countryIdFor(db, 'UAE'), uae.id);
  assert.equal(countryIdFor(db, ' uae '), uae.id);
  assert.equal(countryIdFor(db, 'KSA'), ksa.id);
  assert.equal(countryIdFor(db, 'USA'), us.id);
  assert.equal(countryIdFor(db, 'UK'), gb.id);
  assert.equal(countryIdFor(db, 999999), null);
  assert.equal(countryIdFor(db, 1.5), null);
  assert.equal(stateIdFor(db, ' giza ', egypt.id), giza.id);
  assert.equal(stateIdFor(db, ' gz ', egypt.id), giza.id);
  assert.equal(stateIdFor(db, giza.id, ksa.id), null);

  const saleTax = db.records['account.tax'].find((t) => t.type_tax_use === 'sale' && Number(t.amount) === 14 && !t.price_include);
  const gccGroup = create(db, 'res.country.group', { name: 'GCC', country_ids: ['ae', ' KSA '] });
  db = gccGroup.db;
  const fpGiza = create(db, 'account.fiscal.position', { name: 'Giza Zone', auto_apply: true, sequence: 1, country_id: egypt.id, state_ids: [giza.id] });
  db = fpGiza.db;
  const fpEgypt = create(db, 'account.fiscal.position', { name: 'Egypt Domestic', auto_apply: true, sequence: 2, country_id: egypt.id });
  db = fpEgypt.db;
  const fpGcc = create(db, 'account.fiscal.position', { name: 'GCC Group', auto_apply: true, sequence: 3, country_group_id: gccGroup.id });
  db = fpGcc.db;
  const fpUae = create(db, 'account.fiscal.position', { name: 'UAE Export', auto_apply: true, sequence: 4, country_id: uae.id });
  db = fpUae.db;

  const taxGiza = create(db, 'account.tax', { name: 'Giza 0%', amount_type: 'percent', amount: 0, type_tax_use: 'sale', fiscal_position_ids: [fpGiza.id], original_tax_ids: [saleTax.id] });
  db = taxGiza.db;
  const taxUae = create(db, 'account.tax', { name: 'UAE 0%', amount_type: 'percent', amount: 0, type_tax_use: 'sale', fiscal_position_ids: [fpUae.id], original_tax_ids: [saleTax.id] });
  db = taxUae.db;
  db = write(db, 'product', 1, { tax_id: saleTax.id });

  // Lowercase and padded partner addresses resolve state + country and country-only positions
  const pLowerEgypt = create(db, 'res.partner', { name: 'Lower Buyer', country: 'egypt' });
  db = pLowerEgypt.db;
  const pPaddedGiza = create(db, 'res.partner', { name: 'Padded Giza Buyer', country: ' Egypt ', state: ' giza ' });
  db = pPaddedGiza.db;
  const pKsaAlias = create(db, 'res.partner', { name: 'KSA Alias Buyer', country: 'ksa' });
  db = pKsaAlias.db;

  assert.equal(fiscalPositionFor(db, pLowerEgypt.id), fpEgypt.id);
  assert.equal(fiscalPositionFor(db, pPaddedGiza.id), fpGiza.id);
  assert.equal(fiscalPositionFor(db, pKsaAlias.id), fpGcc.id);

  // Seeded partner "Gulf Interiors" (id 4, country: 'UAE') resolves to UAE position (which beats GCC group by specificity)
  const gulfPartner = read(db, 'res.partner', 4);
  assert.equal(gulfPartner.country, 'UAE');
  assert.equal(fiscalPositionFor(db, gulfPartner.id), fpUae.id);

  // POS priceLines uses fiscalPositionFor on the UAE partner
  const posPriced = priceLines(db, [{ product_id: 1, qty: 1 }], gulfPartner.id);
  assert.equal(posPriced[0].tax_id, taxUae.id);

  // Website cartTotals, publicCart, and publicOrder handle lowercase, padded, and alias addresses
  assert.equal(cartTotals(db, [{ product_id: 1, qty: 1 }], { partnerCountry: 'egypt', partnerState: ' giza ' }).fiscalPositionId, fpGiza.id);
  assert.equal(cartTotals(db, [{ product_id: 1, qty: 1 }], { partnerCountry: ' Egypt ' }).fiscalPositionId, fpEgypt.id);
  assert.equal(cartTotals(db, [{ product_id: 1, qty: 1 }], { partnerCountry: 'UAE' }).fiscalPositionId, fpUae.id);
  assert.equal(cartTotals(db, [{ product_id: 1, qty: 1 }], { partnerCountry: 'France' }).fiscalPositionId, null);

  const cartPreview = publicCart(db, { lines: [{ product_id: 1, qty: 1 }], country: ' Egypt ', state: ' giza ' });
  assert.equal(cartPreview.status, 200);
  assert.equal(cartPreview.body.tax, 0);

  const checkout = publicOrder(db, {
    name: 'UAE Visitor',
    email: 'uae@example.com',
    street: '1 Sheikh Zayed Rd',
    city: 'Dubai',
    country: 'UAE',
    lines: [{ product_id: 1, qty: 1 }],
    carrier_id: 1,
    provider_code: 'wire',
  });
  assert.equal(checkout.status, 201, JSON.stringify(checkout.body));
  const sale = search(checkout.db, 'sale.order').find((o) => o.name === checkout.body.order);
  assert.equal(sale.fiscal_position_id, fpUae.id);
  assert.equal(sale.order_line.find((l) => l.product_id === 1).tax_id, taxUae.id);

  // Domestic tax filter also works with country_id-based fiscal positions and alias company country
  const dbCompanyUae = write(db, 'res.company', 1, { country: 'UAE' });
  assert.equal(isDomesticTax(read(dbCompanyUae, 'account.tax', taxUae.id), dbCompanyUae), true);
  assert.equal(isDomesticTax(read(dbCompanyUae, 'account.tax', taxGiza.id), dbCompanyUae), false);
});

test('Review Finding 1: updating country and enabling auto-apply on position with both restrictions unresolved keeps legacy state restriction and unresolved marker', () => {
  const db = seed();
  const egypt = db.records['res.country'].find((c) => c.code === 'EG');
  const giza = db.records['res.country.state'].find((s) => s.country_id === egypt.id && s.name === 'Giza');
  const alex = db.records['res.country.state'].find((s) => s.country_id === egypt.id && s.name === 'Alexandria');

  const old = {
    ...db,
    schema_version: SCHEMA_VERSION - 1,
    records: {
      ...db.records,
      'account.fiscal.position': [
        { id: 40, name: 'Both Unresolved FP', country: 'UnknownLand', state_ids: ['UnknownState'], auto_apply: true, sequence: 1 },
      ],
    },
  };

  const migrated = migrate(old);
  const fpMigrated = read(migrated, 'account.fiscal.position', 40);
  assert.equal(fpMigrated.unresolved_targeting, true);
  assert.equal(fpMigrated.country, 'UnknownLand');
  assert.deepEqual(fpMigrated.states, ['UnknownState']);

  // Updating only country and enabling auto-apply must NOT clear legacy state restriction or unresolved marker
  const step1 = write(migrated, 'account.fiscal.position', 40, { country_id: egypt.id, auto_apply: true });
  const fpStep1 = read(step1, 'account.fiscal.position', 40);
  assert.equal(fpStep1.country_id, egypt.id);
  assert.equal(fpStep1.country, undefined);
  assert.deepEqual(fpStep1.states, ['UnknownState']);
  assert.equal(fpStep1.unresolved_targeting, true);

  // Position must not match broadly across the country or for any state until state restriction is resolved
  assert.equal(autoFiscalPosition(step1, { country_id: egypt.id }), null);
  assert.equal(autoFiscalPosition(step1, { country_id: egypt.id, state_id: giza.id }), null);
  assert.equal(autoFiscalPosition(step1, { country_id: egypt.id, state_id: alex.id }), null);

  // Once states are also explicitly repaired, unresolved_targeting is cleared and position matches
  const step2 = write(step1, 'account.fiscal.position', 40, { state_ids: [giza.id] });
  const fpStep2 = read(step2, 'account.fiscal.position', 40);
  assert.equal(fpStep2.states, undefined);
  assert.equal(fpStep2.unresolved_targeting, undefined);
  assert.equal(autoFiscalPosition(step2, { country_id: egypt.id, state_id: giza.id }), 40);
  assert.equal(autoFiscalPosition(step2, { country_id: egypt.id, state_id: alex.id }), null);
});

test('Review Finding 2: migrated manual fiscal positions retain unresolved marker and remain excluded when auto-apply is enabled', () => {
  const db = seed();
  const egypt = db.records['res.country'].find((c) => c.code === 'EG');
  const giza = db.records['res.country.state'].find((s) => s.country_id === egypt.id && s.name === 'Giza');

  const old = {
    ...db,
    schema_version: SCHEMA_VERSION - 1,
    records: {
      ...db.records,
      'account.fiscal.position': [
        { id: 41, name: 'Manual Unresolved Country', country: 'UnknownLand', auto_apply: false, sequence: 1 },
        { id: 42, name: 'Manual Unresolved State', state_ids: ['UnknownState'], auto_apply: false, sequence: 2 },
      ],
    },
  };

  const migrated = migrate(old);
  const fp41Migrated = read(migrated, 'account.fiscal.position', 41);
  const fp42Migrated = read(migrated, 'account.fiscal.position', 42);

  // Migration marks unresolved targeting even on manual positions
  assert.equal(fp41Migrated.unresolved_targeting, true);
  assert.equal(fp42Migrated.unresolved_targeting, true);

  // Enabling auto_apply without editing targets keeps them excluded
  const enabled41 = write(migrated, 'account.fiscal.position', 41, { auto_apply: true });
  const enabled42 = write(migrated, 'account.fiscal.position', 42, { auto_apply: true });
  assert.equal(read(enabled41, 'account.fiscal.position', 41).unresolved_targeting, true);
  assert.equal(read(enabled42, 'account.fiscal.position', 42).unresolved_targeting, true);

  assert.equal(autoFiscalPosition(enabled41, { country_id: egypt.id }), null);
  assert.equal(autoFiscalPosition(enabled41, { country_id: 999999 }), null);
  assert.equal(autoFiscalPosition(enabled42, { country_id: egypt.id, state_id: giza.id }), null);

  // Even if an existing record had unresolved targeting without the marker, enabling auto_apply establishes it
  const unflaggedDb = {
    ...db,
    records: {
      ...db.records,
      'account.fiscal.position': [
        { id: 43, name: 'Unflagged Manual Legacy', country: 'UnknownLand', auto_apply: false, sequence: 1 },
      ],
    },
  };
  assert.equal(autoFiscalPosition(unflaggedDb, { country_id: egypt.id }), null);
  const enabledUnflagged = write(unflaggedDb, 'account.fiscal.position', 43, { auto_apply: true });
  assert.equal(read(enabledUnflagged, 'account.fiscal.position', 43).unresolved_targeting, true);
  assert.equal(autoFiscalPosition(enabledUnflagged, { country_id: egypt.id }), null);
});

test('Review Finding 3: countryReferenceError and models reject country_id: 0 on create and write', () => {
  const db = seed();

  assert.equal(countryReferenceError(db, { country_id: 0 }), 'Selected country does not exist');
  assert.equal(countryReferenceError(db, { country_id: null }), null);
  assert.equal(countryReferenceError(db, { country_id: undefined }), null);

  for (const model of ['account.tax', 'account.tax.group', 'account.account.tag', 'account.fiscal.position']) {
    const existing = db.records[model]?.[0];
    assert.ok(existing, `${model} should have at least one seeded record`);

    // create with country_id: 0 must reject
    assert.throws(
      () => create(db, model, { ...models[model].defaults?.(999), name: `Zero Country ${model}`, country_id: 0 }),
      /Selected country does not exist/
    );

    // write with country_id: 0 must reject
    assert.throws(
      () => write(db, model, existing.id, { country_id: 0 }),
      /Selected country does not exist/
    );
  }
});
