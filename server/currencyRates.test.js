import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { register } from 'node:module';
import { startServer } from './test-server.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const { seed } = await import('../src/seed.js');
const { create, read, search, write } = await import('../src/orm.js');
const { models } = await import('../src/models/index.js');
const { createCompany } = await import('../src/models/company.js');
const {
  advanceExecutionDate,
  convertRatesToBaseCurrency,
  parseEcbXml,
  upsertCurrencyRate,
  upsertCurrencyRates,
} = await import('../src/models/currency.js');
const { find, setupDom } = await import('../src/test-support/dom.js');

const {
  fetchEcbRates,
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

async function withTestServer(env, fn) {
  const directory = await mkdtemp(join(tmpdir(), 'mizan-rates-test-'));
  const preloadPath = join(directory, 'stub-ecb.mjs');
  await writeFile(preloadPath, `
    const SAMPLE = ${JSON.stringify(SAMPLE_ECB_XML)};
    const orig = globalThis.fetch;
    globalThis.fetch = async (url, ...args) => {
      if (String(url).includes('ecb.europa.eu')) {
        return new Response(SAMPLE, { headers: { 'Content-Type': 'application/xml' } });
      }
      return orig(url, ...args);
    };
  `);
  let server;
  try {
    server = await startServer({
      preload: preloadPath,
      env: {
        ...process.env,
        PORT: '0',
        MIZAN_DB: join(directory, 'test.sqlite'),
        MIZAN_ADMIN_PASSWORD: 'admin-rates-password',
        MIZAN_SECURE_COOKIE: '0',
        MIZAN_SMTP_HOST: '',
        NODE_ENV: '',
        ...env,
      },
    });
    const { origin } = server;
    const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'mizan' };
    const res = await fetch(`${origin}/api/login`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ login: 'admin', password: 'admin-rates-password' }),
    });
    const adminHeaders = { ...headers, Cookie: res.headers.get('set-cookie').split(';')[0] };
    await fn(origin, adminHeaders, directory);
  } finally {
    await server?.stop();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
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
// 2. XML parsing (pure helper in src/models/currency.js)
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

test('parseEcbXml throws if feed is missing date or non-EUR currency rates', () => {
  assert.throws(() => parseEcbXml('<html><body>502 Bad Gateway</body></html>'), /missing date or currency rates/);
  assert.throws(() => parseEcbXml('<Cube><Cube time="2026-11-18"></Cube></Cube>'), /missing date or currency rates/);
  assert.throws(() => parseEcbXml('<Cube><Cube currency="USD" rate="1.08"/></Cube>'), /missing date or currency rates/);
});

// ---------------------------------------------------------------------------
// 3. Conversion from EUR rates to database base currency (pure helper in src/models/currency.js)
// ---------------------------------------------------------------------------

test('convertRatesToBaseCurrency converts EUR-based rates to database base currency terms and omits base', () => {
  const parsed = parseEcbXml(SAMPLE_ECB_XML);

  // When base currency is USD (1.085 units per EUR):
  // 1 USD = (1 / 1.085) EUR ~ 0.921659 EUR
  // 1 USD = (0.8325 / 1.085) GBP ~ 0.767281 GBP
  const usdBaseRates = convertRatesToBaseCurrency(parsed.rates, 'USD');
  assert.equal(usdBaseRates.USD, undefined, 'Base currency USD must be omitted');
  assert.ok(Math.abs(usdBaseRates.EUR - 1.0 / 1.085) < 1e-6);
  assert.ok(Math.abs(usdBaseRates.GBP - 0.8325 / 1.085) < 1e-6);

  // When base currency is EUR (1.0 in feed):
  const eurBaseRates = convertRatesToBaseCurrency(parsed.rates, 'EUR');
  assert.equal(eurBaseRates.EUR, undefined, 'Base currency EUR must be omitted');
  assert.equal(eurBaseRates.USD, 1.085);

  // When base currency is not in feed (e.g. SAR), fails with clear error:
  assert.throws(() => convertRatesToBaseCurrency(parsed.rates, 'SAR'), /not in the ECB feed/);
});

test('fetchEcbRates enforces timeout with AbortSignal', async () => {
  let signalReceived = null;
  const timeoutFetch = async (url, opts) => {
    signalReceived = opts?.signal;
    throw new DOMException('The operation was aborted', 'TimeoutError');
  };
  await assert.rejects(() => fetchEcbRates(timeoutFetch), /aborted/);
  assert.ok(signalReceived instanceof AbortSignal);
});

// ---------------------------------------------------------------------------
// 4. Rate writing and canonical upsert helper (src/models/currency.js)
// ---------------------------------------------------------------------------

test('upsertCurrencyRate and upsertCurrencyRates write rates only for active currencies and prevent duplicates on rerun', () => {
  let db = seed();
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  assert.ok(eur, 'EUR must exist');

  // Deactivate a currency (e.g. create inactive currency)
  const inactive = create(db, 'res.currency', {
    name: 'INA',
    symbol: 'I',
    active: false,
    rate_ids: [],
  });
  db = inactive.db;
  const inactId = inactive.id;

  // Upsert on active EUR
  db = upsertCurrencyRate(db, eur.id, { date: '2026-11-19', rate: 0.92, companyId: 1 });
  const eurAfter1 = read(db, 'res.currency', eur.id);
  const rows1 = eurAfter1.rate_ids.filter((r) => r.date === '2026-11-19' && r.company_id === 1);
  assert.equal(rows1.length, 1);
  assert.equal(rows1[0].rate, 0.92);

  // Rerun upsert with new rate on same date and company: must update without duplicate
  db = upsertCurrencyRate(db, eur.id, { date: '2026-11-19', rate: 0.93, companyId: 1 });
  const eurAfter2 = read(db, 'res.currency', eur.id);
  const rows2 = eurAfter2.rate_ids.filter((r) => r.date === '2026-11-19' && r.company_id === 1);
  assert.equal(rows2.length, 1, 'Duplicate row must not be created on rerun');
  assert.equal(rows2[0].rate, 0.93, 'Rate must be updated in place');

  // Upsert on inactive currency: must not write
  db = upsertCurrencyRate(db, inactId, { date: '2026-11-19', rate: 2.5, companyId: 1 });
  const inactAfter = read(db, 'res.currency', inactId);
  assert.equal((inactAfter.rate_ids ?? []).length, 0, 'Inactive currency must not receive rates');

  // Bulk upsertCurrencyRates
  db = upsertCurrencyRates(db, { EUR: 0.94, INA: 3.0 }, { date: '2026-11-19', companyId: 1 });
  const eurAfter3 = read(db, 'res.currency', eur.id);
  const rows3 = eurAfter3.rate_ids.filter((r) => r.date === '2026-11-19' && r.company_id === 1);
  assert.equal(rows3.length, 1);
  assert.equal(rows3[0].rate, 0.94);
  assert.equal((read(db, 'res.currency', inactId).rate_ids ?? []).length, 0);

  // Array-form upsertCurrencyRates with base entry (USD) and foreign entry (EUR)
  const usd = search(db, 'res.currency').find((c) => c.name === 'USD');
  const usdRowsBefore = read(db, 'res.currency', usd.id).rate_ids ?? [];
  db = upsertCurrencyRates(db, [
    { currency_id: usd.id, rate: 1.0 },
    { currency_id: eur.id, rate: 0.96 },
  ], { date: '2026-11-19', companyId: 1 });
  const eurAfter4 = read(db, 'res.currency', eur.id);
  const rows4 = eurAfter4.rate_ids.filter((r) => r.date === '2026-11-19' && r.company_id === 1);
  assert.equal(rows4.length, 1);
  assert.equal(rows4[0].rate, 0.96);
  assert.deepEqual(read(db, 'res.currency', usd.id).rate_ids ?? [], usdRowsBefore, 'Base currency must not receive rate rows');
});

test('upsertCurrencyRate replaces all legacy duplicate rows for (currency, date, company) with one updated row', () => {
  let db = seed();
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  assert.ok(eur);

  // Directly seed two duplicate rate rows in db (simulating legacy data)
  const legacyRows = [
    { date: '2026-11-19', rate: 0.90, company_id: 1 },
    { date: '2026-11-19', rate: 0.91, company_id: 1 },
    { date: '2026-11-15', rate: 0.88, company_id: 1 },
  ];
  db = {
    ...db,
    records: {
      ...db.records,
      'res.currency': (db.records['res.currency'] ?? []).map((c) => (c.id === eur.id ? { ...c, rate_ids: legacyRows } : c)),
    },
  };

  const updatedDb = upsertCurrencyRate(db, eur.id, { date: '2026-11-19', rate: 0.95, companyId: 1 });
  const updatedEur = read(updatedDb, 'res.currency', eur.id);
  const matching = (updatedEur.rate_ids ?? []).filter((r) => r.date === '2026-11-19' && r.company_id === 1);
  assert.equal(matching.length, 1, 'Must collapse duplicates into exactly one row');
  assert.equal(matching[0].rate, 0.95);
  const unrelated = (updatedEur.rate_ids ?? []).filter((r) => r.date === '2026-11-15');
  assert.equal(unrelated.length, 1, 'Must preserve unrelated rows');
});

// ---------------------------------------------------------------------------
// 5. updateCompanyCurrencyRates and advanceExecutionDate
// ---------------------------------------------------------------------------

test('fetchEcbRates fetches and parses rates with injected fetch', async () => {
  const result = await fetchEcbRates(mockFetch(SAMPLE_ECB_XML));
  assert.equal(result.date, '2026-11-18');
  assert.equal(result.rates.EUR, 1.0);
  assert.equal(result.rates.USD, 1.085);
});

test('updateCompanyCurrencyRates fetches rates and upserts for company', async () => {
  const db = seed();
  const res = await updateCompanyCurrencyRates(db, 1, {
    fetchFn: mockFetch(SAMPLE_ECB_XML),
    date: '2026-11-19',
  });
  assert.ok(res.db);
  assert.equal(res.date, '2026-11-19');
  const eur = search(res.db, 'res.currency').find((c) => c.name === 'EUR');
  const row = eur.rate_ids.find((r) => r.date === '2026-11-19' && r.company_id === 1);
  assert.ok(row);
  assert.ok(row.rate > 0);
});

test('import rates when base is USD and company is EUR: conversionRate/rateAt give ECB cross rates', async () => {
  let db = seed();
  const { rateAt, conversionRate } = await import('../src/models/currency.js');
  const usd = search(db, 'res.currency').find((c) => c.name === 'USD');
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  assert.ok(usd && eur);
  const createdGbp = create(db, 'res.currency', { name: 'GBP', symbol: '£', active: true });
  db = createdGbp.db;
  const gbp = read(db, 'res.currency', createdGbp.id);
  db = { ...db, settings: { ...db.settings, base_currency_id: usd.id } };

  const comp = createCompany(db, { name: 'EUR Company', currency_id: eur.id });
  db = comp.db;
  const eurCompId = comp.id;

  const res = await updateCompanyCurrencyRates(db, eurCompId, {
    fetchFn: mockFetch(SAMPLE_ECB_XML),
    date: '2026-11-18',
  });
  db = res.db;

  const usdAfter = read(db, 'res.currency', usd.id);
  const usdCompRow = (usdAfter.rate_ids ?? []).find((r) => r.company_id === eurCompId);
  assert.equal(usdCompRow, undefined, 'Base currency USD must never have a rate row written');

  assert.equal(rateAt(db, eur.id, '2026-11-18', eurCompId), 1);
  const usdRateInEurComp = rateAt(db, usd.id, '2026-11-18', eurCompId);
  assert.ok(Math.abs(usdRateInEurComp - 1.085) < 1e-6, `Expected ~1.085, got ${usdRateInEurComp}`);
  const gbpRateInEurComp = rateAt(db, gbp.id, '2026-11-18', eurCompId);
  assert.ok(Math.abs(gbpRateInEurComp - 0.8325) < 1e-6, `Expected ~0.8325, got ${gbpRateInEurComp}`);

  // Test conversionRate gives ECB cross rates for USD and EUR documents
  assert.equal(conversionRate(db, eur.id, eur.id, '2026-11-18', eurCompId), 1);
  assert.ok(Math.abs(conversionRate(db, eur.id, usd.id, '2026-11-18', eurCompId) - 1.085) < 1e-6);
  assert.ok(Math.abs(conversionRate(db, usd.id, eur.id, '2026-11-18', eurCompId) - 1 / 1.085) < 1e-6);
});

test('advanceExecutionDate advances date by interval unit', () => {
  assert.equal(advanceExecutionDate('2026-11-19', 'daily'), '2026-11-20');
  assert.equal(advanceExecutionDate('2026-11-19', 'weekly'), '2026-11-26');
  assert.equal(advanceExecutionDate('2026-11-19', 'monthly'), '2026-12-19');
  assert.equal(advanceExecutionDate('2026-11-19', 'manually'), '2026-11-19');
});

// ---------------------------------------------------------------------------
// 6. Periodic job updateDueCurrencyRates: execution and error handling
// ---------------------------------------------------------------------------

test('updateDueCurrencyRates requires log function and runs for due companies', async () => {
  let db = seed();

  // Company 1: daily interval, due today - must run
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

  // Must reject when log function is missing
  await assert.rejects(
    () => updateDueCurrencyRates(store, { fetchFn: mockFetch(SAMPLE_ECB_XML), todayDate: '2026-11-19' }),
    TypeError,
  );

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
// 7. Settings UI: Local mode hides controls; Server mode displays and calls endpoint
// ---------------------------------------------------------------------------

test('Settings in local mode hides automatic rate controls', async () => {
  let db = seed();
  db = write(db, 'res.company', 1, {
    currency_provider: 'ecb',
    currency_interval_unit: 'daily',
    currency_next_execution_date: '2026-11-19',
  });

  const ctx = await renderSettingsView(db);
  try {
    // In local mode (!isServer()), automatic-rate settings and button must not render
    assert.equal(ctx.control('currency_provider'), null, 'currency_provider must not render in local mode');
    assert.equal(ctx.control('currency_interval_unit'), null, 'currency_interval_unit must not render in local mode');
    const updateBtn = find(ctx.host, (n) => n.tagName === 'BUTTON' && n.textContent?.includes('Update Now'));
    assert.equal(updateBtn, null, 'Update Now button must not render in local mode');
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 8. Server Endpoint: POST /api/currency-rates/update
// ---------------------------------------------------------------------------

test('POST /api/currency-rates/update: non-admin gets 403, admin with stubbed fetch gets rates written and response ok', async () => {
  await withTestServer({}, async (origin, adminHeaders) => {
    const publicHeaders = { 'Content-Type': 'application/json', 'X-Requested-With': 'mizan' };

    // 1. Non-admin user gets 403
    await fetch(`${origin}/api/users`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ login: 'clerk', name: 'Clerk', password: 'clerk-password' }),
    });
    const clerkLoginRes = await fetch(`${origin}/api/login`, {
      method: 'POST',
      headers: publicHeaders,
      body: JSON.stringify({ login: 'clerk', password: 'clerk-password' }),
    });
    const clerkHeaders = { ...publicHeaders, Cookie: clerkLoginRes.headers.get('set-cookie').split(';')[0] };

    const nonAdminRes = await fetch(`${origin}/api/currency-rates/update`, {
      method: 'POST',
      headers: clerkHeaders,
      body: JSON.stringify({ company_id: 1 }),
    });
    assert.equal(nonAdminRes.status, 403);
    const nonAdminBody = await nonAdminRes.json();
    assert.equal(nonAdminBody.error, 'Admins only');

    // 2. Admin request gets 200 and rates written
    const adminRes = await fetch(`${origin}/api/currency-rates/update`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ company_id: 1 }),
    });
    assert.equal(adminRes.status, 200);
    const adminBody = await adminRes.json();
    assert.equal(adminBody.ok, true);
    assert.equal(adminBody.date, '2026-11-18');

    // 3. Verify in database that rates were written for company 1
    const dbRes = await fetch(`${origin}/api/db`, { headers: adminHeaders });
    assert.equal(dbRes.status, 200);
    const serverDb = await dbRes.json();
    const eur = search(serverDb, 'res.currency').find((c) => c.name === 'EUR');
    assert.ok(eur, 'EUR currency must exist');
    const rateRow = (eur.rate_ids ?? []).find((r) => r.date === '2026-11-18' && r.company_id === 1);
    assert.ok(rateRow, 'Rate row for company 1 must be written to server database');
    assert.ok(rateRow.rate > 0);
  });
});

// ---------------------------------------------------------------------------
// 9. Arabic translations
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
    assert.equal(t('Could not update currency rates'), 'تعذر تحديث أسعار العملات');
  } finally {
    globalThis.localStorage = prevStorage;
  }
});
