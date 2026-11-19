import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const { seed } = await import('../src/seed.js');
const { create, read, search, write } = await import('../src/orm.js');
const { models } = await import('../src/models/index.js');
const { createCompany } = await import('../src/models/company.js');
const { upsertCurrencyRate, upsertCurrencyRates } = await import('../src/models/currency.js');
const { find, setupDom } = await import('../src/test-support/dom.js');

const {
  parseEcbXml,
  convertRatesToCompanyCurrency,
  advanceExecutionDate,
  updateCompanyCurrencyRates,
  updateDueCurrencyRates,
} = await import('./currencyRates.js');

const props = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];

const SAMPLE_ECB_XML = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-05-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <gesmes:subject>Reference rates</gesmes:subject>
  <Cube>
    <Cube time='2026-11-18'>
      <Cube currency='USD' rate='1.0850'/>
      <Cube currency='JPY' rate='165.20'/>
      <Cube currency='GBP' rate='0.83250'/>
      <Cube currency='CHF' rate='0.9350'/>
      <Cube currency='CAD' rate='1.5120'/>
    </Cube>
  </Cube>
</gesmes:Envelope>`;

const mockFetch = (xmlText = SAMPLE_ECB_XML, ok = true, status = 200) => async () => {
  if (!ok) throw new Error('Network error: unable to reach ECB');
  return {
    ok: true,
    status,
    statusText: 'OK',
    text: async () => xmlText,
  };
};

async function renderSettingsView(initialDb) {
  const { makeEl } = setupDom();
  const prevConfirm = globalThis.confirm;
  globalThis.confirm = () => true;
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit, getDb } = await import('../src/store.js');
  const { Settings } = await import('../src/views/Settings.jsx');
  await initStore();
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  await React.act(async () => {
    await commit(initialDb);
    root.render(React.createElement(Settings));
  });
  return {
    React,
    host,
    getDb,
    commit,
    control: (id) => find(host, (n) => props(n)?.id === id),
    cleanup: async () => {
      await React.act(async () => root.unmount());
      globalThis.confirm = prevConfirm;
    },
  };
}

// ---------------------------------------------------------------------------
// 1. res.company fields definition and defaults for FX-14
// ---------------------------------------------------------------------------

test('res.company defines currency_provider, currency_interval_unit, and currency_next_execution_date', () => {
  const fields = models['res.company'].fields;
  assert.ok(fields.currency_provider, 'currency_provider field must exist');
  assert.equal(fields.currency_provider.type, 'selection');
  assert.ok(fields.currency_interval_unit, 'currency_interval_unit field must exist');
  assert.equal(fields.currency_interval_unit.type, 'selection');
  assert.ok(fields.currency_next_execution_date, 'currency_next_execution_date field must exist');
  assert.equal(fields.currency_next_execution_date.type, 'date');

  const defaults = models['res.company'].defaults?.() ?? {};
  assert.equal(defaults.currency_provider, 'none');
  assert.equal(defaults.currency_interval_unit, 'manually');
});

// ---------------------------------------------------------------------------
// 2. XML parsing
// ---------------------------------------------------------------------------

test('parseEcbXml parses date and EUR-based rates, adding EUR: 1.0', () => {
  const parsed = parseEcbXml(SAMPLE_ECB_XML);
  assert.equal(parsed.date, '2026-11-18');
  assert.equal(parsed.rates.EUR, 1.0);
  assert.equal(parsed.rates.USD, 1.085);
  assert.equal(parsed.rates.JPY, 165.2);
  assert.equal(parsed.rates.GBP, 0.8325);
  assert.equal(parsed.rates.CHF, 0.935);
  assert.equal(parsed.rates.CAD, 1.512);
});

// ---------------------------------------------------------------------------
// 3. Conversion from EUR rates to company currency
// ---------------------------------------------------------------------------

test('convertRatesToCompanyCurrency converts EUR-based rates to company currency terms', () => {
  const parsed = parseEcbXml(SAMPLE_ECB_XML);

  // When company currency is USD (1.085 units per EUR):
  // 1 USD = (1 / 1.085) EUR ~ 0.921659 EUR
  // 1 USD = (0.8325 / 1.085) GBP ~ 0.767281 GBP
  const usdCompanyRates = convertRatesToCompanyCurrency(parsed.rates, 'USD');
  assert.equal(usdCompanyRates.USD, 1.0);
  assert.ok(Math.abs(usdCompanyRates.EUR - 1.0 / 1.085) < 1e-9);
  assert.ok(Math.abs(usdCompanyRates.GBP - 0.8325 / 1.085) < 1e-9);
  assert.ok(Math.abs(usdCompanyRates.JPY - 165.2 / 1.085) < 1e-9);

  // When company currency is EUR (1.0 units per EUR):
  const eurCompanyRates = convertRatesToCompanyCurrency(parsed.rates, 'EUR');
  assert.equal(eurCompanyRates.EUR, 1.0);
  assert.equal(eurCompanyRates.USD, 1.085);
  assert.equal(eurCompanyRates.GBP, 0.8325);

  // When company currency is not in feed (e.g. SAR): throws clear error
  assert.throws(
    () => convertRatesToCompanyCurrency(parsed.rates, 'SAR'),
    /SAR.*not in.*feed/i,
  );
});

// ---------------------------------------------------------------------------
// 4. Writing rates: canonical helper in currency.js (active only, no duplicates)
// ---------------------------------------------------------------------------

test('upsertCurrencyRate and upsertCurrencyRates write rates only for active currencies and prevent duplicates on rerun', () => {
  let db = seed();
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  assert.ok(eur, 'EUR currency should exist');

  // Create an inactive currency
  const inactive = create(db, 'res.currency', {
    name: 'INACT',
    active: false,
    rounding: 0.01,
  });
  db = inactive.db;
  const inactId = inactive.id;

  const testDate = '2026-11-18';
  const cId = 1;

  // Initial upsert for EUR
  db = upsertCurrencyRate(db, eur.id, { date: testDate, rate: 0.921659, companyId: cId });
  const eurAfter = read(db, 'res.currency', eur.id);
  const rows = eurAfter.rate_ids.filter((r) => r.date === testDate && r.company_id === cId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rate, 0.921659);

  // Rerun with updated rate: must NOT create duplicate row
  db = upsertCurrencyRate(db, eur.id, { date: testDate, rate: 0.93, companyId: cId });
  const eurRerun = read(db, 'res.currency', eur.id);
  const rowsRerun = eurRerun.rate_ids.filter((r) => r.date === testDate && r.company_id === cId);
  assert.equal(rowsRerun.length, 1, 'Rerun must update existing row instead of adding duplicate');
  assert.equal(rowsRerun[0].rate, 0.93);

  // Upsert on inactive currency: must NOT add rate rows
  db = upsertCurrencyRate(db, inactId, { date: testDate, rate: 2.5, companyId: cId });
  const inactAfter = read(db, 'res.currency', inactId);
  assert.equal(inactAfter.rate_ids?.length ?? 0, 0, 'Inactive currencies must not receive rate rows');

  // Batch helper: upsertCurrencyRates
  db = upsertCurrencyRates(db, { EUR: 0.915, INACT: 3.0 }, { date: testDate, companyId: cId });
  const eurBatch = read(db, 'res.currency', eur.id);
  const batchRows = eurBatch.rate_ids.filter((r) => r.date === testDate && r.company_id === cId);
  assert.equal(batchRows.length, 1);
  assert.equal(batchRows[0].rate, 0.915);

  const inactBatch = read(db, 'res.currency', inactId);
  assert.equal(inactBatch.rate_ids?.length ?? 0, 0);
});

// ---------------------------------------------------------------------------
// 5. Due-date advance logic
// ---------------------------------------------------------------------------

test('updateCompanyCurrencyRates fetches rates and upserts for company', async () => {
  const db = seed();
  const res = await updateCompanyCurrencyRates(db, 1, { fetchFn: mockFetch(SAMPLE_ECB_XML) });
  assert.equal(res.date, '2026-11-18');
  assert.equal(res.rates.USD, 1.0);
  const eur = search(res.db, 'res.currency').find((c) => c.name === 'EUR');
  const eurRow = eur.rate_ids.find((r) => r.date === '2026-11-18' && r.company_id === 1);
  assert.ok(eurRow);
  assert.ok(eurRow.rate > 0);
});

test('advanceExecutionDate advances date by interval unit', () => {
  assert.equal(advanceExecutionDate('2026-11-19', 'daily'), '2026-11-20');
  assert.equal(advanceExecutionDate('2026-11-19', 'weekly'), '2026-11-26');
  assert.equal(advanceExecutionDate('2026-11-19', 'monthly'), '2026-12-19');
  assert.equal(advanceExecutionDate('2026-11-19', 'manually'), '2026-11-19');
});

// ---------------------------------------------------------------------------
// 6. Periodic job execution: due companies, error handling, date advance
// ---------------------------------------------------------------------------

test('updateDueCurrencyRates runs for due companies, advances next execution date, and preserves date on failure', async () => {
  let db = seed();

  // Company 1: EUR currency (or USD), active interval 'daily', due date today
  db = write(db, 'res.company', 1, {
    currency_provider: 'ecb',
    currency_interval_unit: 'daily',
    currency_next_execution_date: '2026-11-19',
  });

  // Company 2: manual interval - must not run
  const compManual = createCompany(db, {
    name: 'Manual Rate Co',
    currency_provider: 'ecb',
    currency_interval_unit: 'manually',
    currency_next_execution_date: '2026-11-19',
  });
  db = compManual.db;
  const manualId = compManual.id;

  // Company 3: future date - must not run
  const compFuture = createCompany(db, {
    name: 'Future Rate Co',
    currency_provider: 'ecb',
    currency_interval_unit: 'weekly',
    currency_next_execution_date: '2026-11-25',
  });
  db = compFuture.db;
  const futureId = compFuture.id;

  // Store mock
  let currentDb = db;
  const store = {
    get: () => currentDb,
    commit: (next) => { currentDb = next; },
  };

  const logs = [];
  const log = (level, msg, ctx) => logs.push({ level, msg, ctx });

  // 1. Successful run with injected fetch
  await updateDueCurrencyRates(store, {
    fetchFn: mockFetch(SAMPLE_ECB_XML),
    todayDate: '2026-11-19',
    log,
  });

  // Company 1 should be advanced to 2026-11-20
  const comp1After = read(currentDb, 'res.company', 1);
  assert.equal(comp1After.currency_next_execution_date, '2026-11-20');

  // Manual and future companies remain unchanged
  assert.equal(read(currentDb, 'res.company', manualId).currency_next_execution_date, '2026-11-19');
  assert.equal(read(currentDb, 'res.company', futureId).currency_next_execution_date, '2026-11-25');

  // Verify rates were written for Company 1
  const eur = search(currentDb, 'res.currency').find((c) => c.name === 'EUR');
  const eurRateRow = eur.rate_ids.find((r) => r.date === '2026-11-18' && r.company_id === 1);
  assert.ok(eurRateRow, 'Company 1 rate row must exist');
  assert.ok(eurRateRow.rate > 0);

  // 2. Network failure scenario: leaves date unchanged and logs error
  // Reset company 1 date back to due
  currentDb = write(currentDb, 'res.company', 1, { currency_next_execution_date: '2026-11-19' });
  logs.length = 0;

  await updateDueCurrencyRates(store, {
    fetchFn: mockFetch(null, false), // throws network error
    todayDate: '2026-11-19',
    log,
  });

  // Date MUST remain unchanged
  const comp1Failed = read(currentDb, 'res.company', 1);
  assert.equal(comp1Failed.currency_next_execution_date, '2026-11-19', 'Next execution date must remain unchanged on failure');
  assert.ok(logs.some((l) => l.level === 'error'), 'Network failure must be logged');
});

// ---------------------------------------------------------------------------
// 7. Settings UI: Provider, Interval, and Update Now button
// ---------------------------------------------------------------------------

test('Settings renders Currency Rates settings and Update Now button writes rates', async () => {
  let db = seed();
  db = write(db, 'res.company', 1, {
    currency_provider: 'ecb',
    currency_interval_unit: 'daily',
    currency_next_execution_date: '2026-11-19',
  });

  const ctx = await renderSettingsView(db);
  try {
    const providerSelect = ctx.control('currency_provider');
    assert.ok(providerSelect, 'currency_provider select control must render');

    const intervalSelect = ctx.control('currency_interval_unit');
    assert.ok(intervalSelect, 'currency_interval_unit select control must render');

    const updateBtn = find(ctx.host, (n) => n.tagName === 'BUTTON' && n.textContent?.includes('Update Now'));
    assert.ok(updateBtn, 'Update Now button must render');

    // Change provider to ecb and interval to weekly
    await ctx.React.act(async () => {
      props(intervalSelect)?.onChange?.({ target: { value: 'weekly' } });
    });

    const updated = read(ctx.getDb(), 'res.company', 1);
    assert.equal(updated.currency_interval_unit, 'weekly');
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 8. Arabic translations
// ---------------------------------------------------------------------------

test('Arabic translations for currency rates in i18n.js', async () => {
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem: () => {}, removeItem: () => {}, clear: () => {} };
  try {
    const { t } = await import(`../src/i18n.js?lang=ar-cr-${Date.now()}`);
    assert.equal(t('Currency Provider'), 'مزود أسعار العملات');
    assert.equal(t('European Central Bank'), 'البنك المركزي الأوروبي');
    assert.equal(t('Update Now'), 'تحديث الآن');
    assert.equal(t('Daily'), 'يومياً');
    assert.equal(t('Monthly'), 'شهري');
    assert.equal(t('Weekly'), 'أسبوعي');
    assert.equal(t('Select a valid currency provider'), 'اختر مزود أسعار عملات صالحاً');
  } finally {
    globalThis.localStorage = prevStorage;
  }
});

