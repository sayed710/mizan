import test from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { emptyDb, read } from './orm.js';
import { companyCurrencyRecord, documentCurrency } from './money.js';
import { companyCurrency, currencyModels, rateAt, toCompany } from './models/currency.js';
import { companyAmount, reportingBookedAmount, reportingValue } from './models/money.js';
import { createCompany } from './models/company.js';
import { migrate } from './migrations.js';
import { documentEmail } from '../server/mail.js';

test('document email rejects a missing company currency instead of using the legacy setting', () => {
  const db = seed();
  const company = db.records['res.company'][0];
  const broken = { ...db, records: { ...db.records, 'res.company': db.records['res.company'].map((row) => row.id === company.id ? { ...row, currency_id: null } : row) } };
  const invoice = { name: 'INV', company_id: company.id, amount_total: 10, invoice_line_ids: [] };
  assert.throws(() => documentEmail(broken, 'account.move', invoice), /configure.*currency/i);
});

test('id-based company currency resolver resolves company currency by record id and throws on missing configuration', () => {
  const db = seed();
  const mainCo = read(db, 'res.company', 1);
  const mainCurr = companyCurrencyRecord(db, mainCo.id);
  assert.equal(mainCurr.id, mainCo.currency_id);
  assert.equal(companyCurrency(db, mainCo.id), mainCo.currency_id);

  // Resolving with no company resolves the explicitly configured main company's currency
  const defaultCurr = companyCurrencyRecord(db, null);
  assert.equal(defaultCurr.id, mainCo.currency_id);
  assert.equal(companyCurrency(db, null), mainCo.currency_id);

  // Missing currency on company raises a clear error
  const brokenCompany = { ...db, records: { ...db.records, 'res.company': [{ id: 99, name: 'No Curr Co' }] } };
  assert.throws(() => companyCurrencyRecord(brokenCompany, 99), /configure.*currency/i);

  // Missing base currency when no company is passed raises a clear error
  const empty = emptyDb();
  assert.throws(() => companyCurrencyRecord(empty, null), /configure.*currency/i);
});

test('currency rates resolve per-company rates and fall back to shared rate (null company_id)', () => {
  let db = seed();
  const eur = db.records['res.currency'].find((c) => c.name === 'EUR');
  const co1 = read(db, 'res.company', 1);

  // Create second company with EUR as secondary rate test
  const co2Res = createCompany(db, { name: 'Company Two', currency_id: co1.currency_id });
  db = co2Res.db;
  const co2Id = co2Res.id;

  // Set company-specific rate for Company 1, Company 2, and a shared rate
  const rates = [
    { date: '2026-01-01', rate: 1.1, company_id: co1.id },
    { date: '2026-01-01', rate: 1.25, company_id: co2Id },
    { date: '2026-01-01', rate: 1.0, company_id: null }, // shared rate
  ];
  db = {
    ...db,
    records: {
      ...db.records,
      'res.currency': db.records['res.currency'].map((c) => (c.id === eur.id ? { ...c, rate_ids: rates } : c)),
    },
  };

  // rateAt resolves per company
  assert.equal(rateAt(db, eur.id, '2026-01-15', co1.id), 1.1);
  assert.equal(rateAt(db, eur.id, '2026-01-15', co2Id), 1.25);

  // Company 3 with no company-specific rate falls back to shared rate
  const co3Res = createCompany(db, { name: 'Company Three', currency_id: co1.currency_id });
  db = co3Res.db;
  assert.equal(rateAt(db, eur.id, '2026-01-15', co3Res.id), 1.0);

  // toCompany converts using the company-specific rate
  assert.equal(toCompany(db, eur.id, 110, '2026-01-15', co1.id), 100);
  assert.equal(toCompany(db, eur.id, 125, '2026-01-15', co2Id), 100);

  // companyAmount and reportingValue use company rate
  const moveCo1 = { company_id: co1.id, currency_id: eur.id, amount_total: 110, date: '2026-01-15' };
  const moveCo2 = { company_id: co2Id, currency_id: eur.id, amount_total: 125, date: '2026-01-15' };
  assert.equal(companyAmount(db, moveCo1, 'amount_total'), 100);
  assert.equal(companyAmount(db, moveCo2, 'amount_total'), 100);
  assert.equal(reportingValue(db, moveCo1, 110), 100);
  assert.equal(reportingValue(db, moveCo2, 125), 100);
  // reportingBookedAmount translates an amount already in company currency into reporting company currency
  assert.equal(reportingBookedAmount(db, { company_id: co1.id, date: '2026-01-15' }, 110), 110);
});

test('currency rate UI shows and edits rates with company_id defaulting to current company', () => {
  const model = currencyModels['res.currency'];
  assert.ok(model.fields.rate_ids);
  assert.equal(model.fields.rate_ids.type, 'one2many');
  assert.ok(model.fields.rate_ids.fields.company_id);
  assert.equal(model.fields.rate_ids.fields.company_id.relation, 'res.company');

  // newLine defaults company_id to current_company_id
  const dummyDb = { settings: { current_company_id: 42 } };
  const newLine = model.fields.rate_ids.newLine({}, dummyDb);
  assert.equal(newLine.company_id, 42);
});

test('migration 36 explicitly sets res.company.currency_id from legacy settings, is idempotent, and notes an unresolvable currency', () => {
  const base = seed();
  const usd = base.records['res.currency'].find((c) => c.name === 'USD');
  const eur = base.records['res.currency'].find((c) => c.name === 'EUR');

  // Database at schema version 35 with legacy settings.currency and settings.companies
  const legacyDb = {
    ...base,
    schema_version: 35,
    settings: {
      ...base.settings,
      currency: 'USD',
      companies: [
        { id: 1, name: 'Co1', currency: 'USD' },
        { id: 2, name: 'Co2', currency: 'EUR' },
        { id: 3, name: 'Co3', currency: 'NON_EXISTENT_XYZ' },
      ],
    },
    records: {
      ...base.records,
      'res.company': [
        { id: 1, name: 'Co1', currency_id: null },
        { id: 2, name: 'Co2', currency_id: null },
        { id: 3, name: 'Co3', currency_id: null },
      ],
    },
  };

  const migrated = migrate(legacyDb, 36);
  assert.equal(migrated.schema_version, 36);

  const co1 = migrated.records['res.company'].find((c) => c.id === 1);
  const co2 = migrated.records['res.company'].find((c) => c.id === 2);
  const co3 = migrated.records['res.company'].find((c) => c.id === 3);

  // Successfully resolved currencies
  assert.equal(co1.currency_id, usd.id);
  assert.equal(co2.currency_id, eur.id);

  // Unresolvable currency stays unset and the company chatter says why
  assert.equal(co3.currency_id, null);
  const notes = (migrated.messages ?? []).filter((m) => m.model === 'res.company' && m.res_id === 3);
  assert.equal(notes.length, 1);
  assert.match(notes[0].body, /no single currency with code NON_EXISTENT_XYZ/);

  // Idempotence: running migration again does not change or corrupt records
  const second = migrate({ ...migrated, schema_version: 35 }, 36);
  assert.deepEqual(second.records['res.company'], migrated.records['res.company']);
});

test('companyCurrencyRecord and documentCurrency strict semantics', () => {
  const db = seed();
  const usd = db.records['res.currency'].find((c) => c.name === 'USD');
  const eur = db.records['res.currency'].find((c) => c.name === 'EUR');

  // Passing an object/record to companyCurrencyRecord throws TypeError
  assert.throws(() => companyCurrencyRecord(db, { id: 1 }), TypeError);

  // Main company means company 1, never settings.current_company_id
  const co2Res = createCompany(db, { name: 'Co2', currency_id: eur.id });
  let multiDb = co2Res.db;
  multiDb = { ...multiDb, settings: { ...multiDb.settings, current_company_id: co2Res.id } };
  // companyCurrencyRecord with null resolves company 1 (USD), not current_company_id (Co2, EUR)
  assert.equal(companyCurrencyRecord(multiDb, null).id, usd.id);

  // Do not fall back to settings.base_currency_id for a company whose currency_id is unset
  const brokenCo1 = {
    ...db,
    settings: { ...db.settings, base_currency_id: usd.id },
    records: {
      ...db.records,
      'res.company': db.records['res.company'].map((c) => (c.id === 1 ? { ...c, currency_id: null } : c)),
    },
  };
  assert.throws(() => companyCurrencyRecord(brokenCo1, null), /Configure the base currency/);
  assert.throws(() => companyCurrencyRecord(brokenCo1, 1), /Configure the company currency/);

  // settings.base_currency_id may only be read when company 1 does not exist yet (initialisation)
  const initDb = {
    settings: { base_currency_id: usd.id },
    records: { 'res.currency': [usd], 'res.company': [] },
  };
  assert.equal(companyCurrencyRecord(initDb, null).id, usd.id);
  assert.equal(companyCurrencyRecord(initDb, 1).id, usd.id);

  // documentCurrency does not swallow configuration errors
  assert.throws(() => documentCurrency(brokenCo1, { company_id: 1 }), /configure.*currency/i);
  assert.throws(() => documentCurrency(brokenCo1, {}), /configure.*currency/i);

  // createCompany without currency_id and without main company currency raises error
  const empty = emptyDb();
  assert.throws(() => createCompany(empty, { name: 'No Main Currency Co' }), /Configure the company currency before creating a company/);
});
