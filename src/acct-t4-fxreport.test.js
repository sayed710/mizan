import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { create, read } from './orm.js';
import { seed } from './seed.js';
import { applyDiff, diffDb } from './sync.js';
import { postMove } from './models/accounting.js';
import { setupDom, find } from './test-support/dom.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const withCurrency = (db, record) => ({
  ...db,
  records: {
    ...db.records,
    'res.currency': (db.records['res.currency'] ?? []).some((c) => c.id === record.id)
      ? db.records['res.currency'].map((c) => (c.id === record.id ? record : c))
      : [...(db.records['res.currency'] ?? []), record],
  },
});

test('rate row guard rejects non-positive exchange rates via diffDb + applyDiff', () => {
  const db = seed();

  for (const badRate of [0, -1.5, null, '']) {
    const forgedCreate = withCurrency(db, {
      id: 991,
      name: 'BADRATE',
      rounding: 0.01,
      rate_ids: [{ date: '2026-01-01', rate: badRate, company_id: 1 }],
    });
    assert.throws(
      () => applyDiff(db, diffDb(db, forgedCreate), { isAdmin: true }),
      /positive/i,
      `Guard must reject non-positive rate ${String(badRate)} on create`,
    );
  }

  for (const invalidTypeRate of [true, NaN]) {
    const forgedInvalidType = withCurrency(db, {
      id: 991,
      name: 'BADRATE',
      rounding: 0.01,
      rate_ids: [{ date: '2026-01-01', rate: invalidTypeRate, company_id: 1 }],
    });
    assert.throws(
      () => applyDiff(db, diffDb(db, forgedInvalidType), { isAdmin: true }),
      /Invalid value|positive/i,
      `applyDiff must reject invalid rate ${String(invalidTypeRate)} on create`,
    );
  }

  // Update existing currency to add a non-positive rate via diffDb + applyDiff
  const valid = create(db, 'res.currency', {
    name: 'VALIDFX',
    rounding: 0.01,
    rate_ids: [{ date: '2026-01-01', rate: 1.25, company_id: 1 }],
  });
  const current = read(valid.db, 'res.currency', valid.id);

  const forgedZeroUpdate = withCurrency(valid.db, {
    ...current,
    rate_ids: [
      { date: '2026-01-01', rate: 1.25, company_id: 1 },
      { date: '2026-02-01', rate: 0, company_id: 1 },
    ],
  });
  assert.throws(
    () => applyDiff(valid.db, diffDb(valid.db, forgedZeroUpdate), { isAdmin: true }),
    /positive/i,
    'Guard must reject updating currency with rate 0',
  );

  const forgedNegativeUpdate = withCurrency(valid.db, {
    ...current,
    rate_ids: [
      { date: '2026-01-01', rate: 1.25, company_id: 1 },
      { date: '2026-02-01', rate: -0.5, company_id: 1 },
    ],
  });
  assert.throws(
    () => applyDiff(valid.db, diffDb(valid.db, forgedNegativeUpdate), { isAdmin: true }),
    /positive/i,
    'Guard must reject updating currency with negative rate',
  );

  // Strictly positive rate succeeds
  const validUpdate = withCurrency(valid.db, {
    ...current,
    rate_ids: [
      { date: '2026-01-01', rate: 1.25, company_id: 1 },
      { date: '2026-02-01', rate: 0.85, company_id: 1 },
    ],
  });
  assert.doesNotThrow(
    () => applyDiff(valid.db, diffDb(valid.db, validUpdate), { isAdmin: true }),
    'Guard must allow strictly positive rates',
  );
});

test('rate row guard rejects duplicate rate rows for same currency, date and company via diffDb + applyDiff', () => {
  const db0 = seed();
  const secondCompany = create(db0, 'res.company', { name: 'Branch Co', currency_id: db0.settings.base_currency_id });
  const valid = create(secondCompany.db, 'res.currency', { name: 'DUPFX', rounding: 0.01 });
  const current = read(valid.db, 'res.currency', valid.id);

  // Two rate rows with same date and same company_id
  const duplicateSameCompany = withCurrency(valid.db, {
    ...current,
    rate_ids: [
      { date: '2026-01-01', rate: 1.25, company_id: 1 },
      { date: '2026-01-01', rate: 1.30, company_id: 1 },
    ],
  });
  assert.throws(
    () => applyDiff(valid.db, diffDb(valid.db, duplicateSameCompany), { isAdmin: true }),
    /duplicate|same date/i,
    'Guard must reject duplicate rate rows for same currency, date and company',
  );

  // Two rate rows with same date and shared company (null / undefined / '')
  const duplicateNullCompany = withCurrency(valid.db, {
    ...current,
    rate_ids: [
      { date: '2026-01-01', rate: 1.25, company_id: null },
      { date: '2026-01-01', rate: 1.30, company_id: undefined },
    ],
  });
  assert.throws(
    () => applyDiff(valid.db, diffDb(valid.db, duplicateNullCompany), { isAdmin: true }),
    /duplicate|same date/i,
    'Guard must reject duplicate rate rows for same currency, date and shared company',
  );

  const duplicateEmptyCompany = withCurrency(valid.db, {
    ...current,
    rate_ids: [
      { date: '2026-01-01', rate: 1.25, company_id: null },
      { date: '2026-01-01', rate: 1.30, company_id: '' },
    ],
  });
  assert.throws(
    () => applyDiff(valid.db, diffDb(valid.db, duplicateEmptyCompany), { isAdmin: true }),
    /duplicate|same date/i,
    'Guard must reject duplicate rate rows when one uses empty string and another uses null',
  );

  // Same date across different currencies is allowed
  const secondCurrency = withCurrency(valid.db, {
    id: 993,
    name: 'OTHERFX',
    rounding: 0.01,
    rate_ids: [{ date: '2026-01-01', rate: 2.0, company_id: 1 }],
  });
  assert.doesNotThrow(
    () => applyDiff(valid.db, diffDb(valid.db, secondCurrency), { isAdmin: true }),
    'Different currencies on the same date and company must be allowed',
  );

  // Same date but different companies (company 1 vs company 2 vs null) is allowed
  const diffCompanies = withCurrency(valid.db, {
    ...current,
    rate_ids: [
      { date: '2026-01-01', rate: 1.25, company_id: 1 },
      { date: '2026-01-01', rate: 1.30, company_id: secondCompany.id },
      { date: '2026-01-01', rate: 1.28, company_id: null },
    ],
  });
  assert.doesNotThrow(
    () => applyDiff(valid.db, diffDb(valid.db, diffCompanies), { isAdmin: true }),
    'Different companies on the same date must be allowed',
  );

  // Same company but different dates is allowed
  const diffDates = withCurrency(valid.db, {
    ...current,
    rate_ids: [
      { date: '2026-01-01', rate: 1.25, company_id: 1 },
      { date: '2026-02-01', rate: 1.30, company_id: 1 },
    ],
  });
  assert.doesNotThrow(
    () => applyDiff(valid.db, diffDb(valid.db, diffDates), { isAdmin: true }),
    'Different dates for the same company must be allowed',
  );
});

test('Unrealized Currencies view formats foreign balance with line foreign currency and displays exchange rate column', async () => {
  let db = seed();

  // Foreign currency 1: KWD (3 decimals, symbol KD after amount)
  const kwd = create(db, 'res.currency', {
    name: 'KWD',
    symbol: 'KD',
    position: 'after',
    rounding: 0.001,
    rate_ids: [
      { date: '2026-01-01', rate: 0.3, company_id: 1 },
      { date: '2026-02-01', rate: 0.32, company_id: 1 },
    ],
  });
  db = kwd.db;

  // Foreign currency 2: GBP (2 decimals, symbol £ before amount)
  const gbp = create(db, 'res.currency', {
    name: 'GBP',
    symbol: '£',
    position: 'before',
    rounding: 0.01,
    rate_ids: [
      { date: '2026-01-01', rate: 0.8, company_id: 1 },
    ],
  });
  db = gbp.db;

  // Post invoice in KWD
  const invoiceKwd = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    currency_id: kwd.id,
    invoice_date: '2026-01-10',
    invoice_line_ids: [{ name: 'Consulting', qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(invoiceKwd.db, invoiceKwd.id);

  // Post invoice in GBP
  const invoiceGbp = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    currency_id: gbp.id,
    invoice_date: '2026-01-10',
    invoice_line_ids: [{ name: 'Design', qty: 1, price_unit: 250, tax: 0 }],
  });
  db = postMove(invoiceGbp.db, invoiceGbp.id);

  const { initStore, commit } = await import('./store.js');
  await initStore();
  await commit(db);

  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { UnrealizedCurrencies } = await import('./views/UnrealizedCurrencies.jsx');

  const html = renderToStaticMarkup(React.createElement(UnrealizedCurrencies));

  // 1. Verify Exchange Rate column header exists
  assert.match(html, /<th>Exchange Rate<\/th>/, 'Table header must include Exchange Rate column');

  // 2. Verify Foreign Balance is formatted with each line's foreign currency (100.000 KD and £250.00), not company currency ($100.00 / $250.00)
  assert.match(html, /100\.000 KD/, 'KWD foreign balance must be formatted with KD symbol and 3 decimals');
  assert.match(html, /£250\.00/, 'GBP foreign balance must be formatted with £ symbol and 2 decimals');
  assert.doesNotMatch(html, />\$100\.00<\/td>/, 'KWD foreign balance must NOT be formatted in company currency');
  assert.doesNotMatch(html, />\$250\.00<\/td>/, 'GBP foreign balance must NOT be formatted in company currency');

  // 3. Verify Exchange Rate column displays the revaluation rate at the report date (today() >= 2026-02-01 => 0.320000 for KWD, 0.800000 for GBP)
  assert.match(html, /0\.320000/, 'Exchange rate column must display the revaluation exchange rate for KWD with 6 decimals');
  assert.match(html, /0\.800000/, 'Exchange rate column must display the revaluation exchange rate for GBP with 6 decimals');

  // 4. Changing the report date changes the Exchange Rate column to the rate used at that report date
  const { makeEl } = setupDom();
  const container = makeEl('div');
  container.ownerDocument = globalThis.document;
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container);
  const propsOf = (el) => Object.entries(el).find(([k]) => k.startsWith('__reactProps$'))?.[1];
  try {
    await React.act(async () => root.render(React.createElement(UnrealizedCurrencies)));
    const dateInput = find(container, (n) => n.tagName === 'INPUT' && propsOf(n)?.type === 'date');
    assert.ok(dateInput, 'Date input must render');
    await React.act(async () => propsOf(dateInput).onChange({ target: { value: '2026-01-20' } }));
    assert.match(container.textContent, /0\.300000/, 'Exchange rate column must update to the rate at the chosen report date (0.300000)');
    assert.doesNotMatch(container.textContent, /0\.320000/, 'Exchange rate column must not show a later rate after switching to an earlier report date');
  } finally {
    await React.act(async () => root.unmount());
  }

  // 5. Test Arabic translations for new UI and guard strings
  const prevStorage = globalThis.localStorage;
  try {
    globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem() {} };
    const { t } = await import('./i18n.js?lang=ar-test');
    assert.notEqual(t('Exchange Rate'), 'Exchange Rate');
    assert.notEqual(t('Exchange rate must be strictly positive'), 'Exchange rate must be strictly positive');
    assert.notEqual(t('Duplicate exchange rate row for the same date and company'), 'Duplicate exchange rate row for the same date and company');
  } finally {
    globalThis.localStorage = prevStorage;
  }
});

test('rate row guard leaves untouched legacy rows alone so the currency stays editable', () => {
  const base = seed();
  const legacy = withCurrency(base, { id: 992, name: 'LEGACY', symbol: 'L', rounding: 0.01, rate_ids: [{ date: '2020-01-01', rate: 0, company_id: 1 }] });
  const renamed = withCurrency(legacy, { id: 992, name: 'LEGACY', symbol: 'X', rounding: 0.01, rate_ids: [{ date: '2020-01-01', rate: 0, company_id: 1 }] });
  assert.equal(read(applyDiff(legacy, diffDb(legacy, renamed), { isAdmin: true }), 'res.currency', 992).symbol, 'X');
  const addedBad = withCurrency(legacy, { id: 992, name: 'LEGACY', symbol: 'L', rounding: 0.01, rate_ids: [{ date: '2020-01-01', rate: 0, company_id: 1 }, { date: '2021-01-01', rate: -1, company_id: 1 }] });
  assert.throws(() => applyDiff(legacy, diffDb(legacy, addedBad), { isAdmin: true }), /positive/i);
});
