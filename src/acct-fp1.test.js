import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const { create, write, search } = await import('./orm.js');
const { seed } = await import('./seed.js');
const { createCompany, setCompanies } = await import('./models/company.js');
const { fiscalYearDates, fiscalYearStart, postEntry } = await import('./models/ledger.js');
const { today } = await import('./models/common.js');
const { PERIODS, reportPeriodRange } = await import('./views/reportNavigation.js');
const { periodsFor } = await import('./views/reportCompare.js');
const { setupDom, find } = await import('./test-support/dom.js');

const props = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];
const textOf = (node) => (node.nodeType === 3 ? node.nodeValue : (node.childNodes ?? []).map(textOf).join(''));

test('FP1: fiscal year ending Mar 31 computes Apr 1..Mar 31 and steps back/forward', () => {
  let db = seed();
  const marCo = createCompany(db, {
    name: 'March End Co',
    fiscalyear_last_day: 31,
    fiscalyear_last_month: 3,
  });
  db = marCo.db;
  const cId = marCo.id;

  // Date after Mar 31 -> Apr 1 of same year to Mar 31 of next year
  assert.deepEqual(
    reportPeriodRange(db, 'year', { companyId: cId, date: '2026-11-19' }),
    { from: '2026-04-01', to: '2027-03-31' },
  );
  // One step back -> previous fiscal year
  assert.deepEqual(
    reportPeriodRange(db, 'year', { companyId: cId, date: '2026-11-19', offset: -1 }),
    { from: '2025-04-01', to: '2026-03-31' },
  );
  // One step forward -> next fiscal year
  assert.deepEqual(
    reportPeriodRange(db, 'year', { companyId: cId, date: '2026-11-19', offset: 1 }),
    { from: '2027-04-01', to: '2028-03-31' },
  );

  // Date before or on Mar 31 -> Apr 1 of previous year to Mar 31 of same year
  assert.deepEqual(
    reportPeriodRange(db, 'year', { companyId: cId, date: '2026-02-10' }),
    { from: '2025-04-01', to: '2026-03-31' },
  );
  assert.deepEqual(
    reportPeriodRange(db, 'year', { companyId: cId, date: '2026-03-31' }),
    { from: '2025-04-01', to: '2026-03-31' },
  );
  assert.deepEqual(
    reportPeriodRange(db, 'year', { companyId: cId, date: '2026-04-01' }),
    { from: '2026-04-01', to: '2027-03-31' },
  );
  assert.deepEqual(
    reportPeriodRange(db, 'year', { companyId: cId, date: '2026-02-10', offset: -1 }),
    { from: '2024-04-01', to: '2025-03-31' },
  );
});

test('FP1: Feb 28/29 fiscal year end handles leap years per Odoo get_fiscal_year rules', () => {
  let db = seed();
  const febCo = createCompany(db, {
    name: 'Feb End Co',
    fiscalyear_last_day: 28,
    fiscalyear_last_month: 2,
  });
  db = febCo.db;
  const cId = febCo.id;

  // Leap day belongs to the fiscal year ending 2024-02-29
  assert.deepEqual(
    fiscalYearDates(db, '2024-02-29', cId),
    { from: '2023-03-01', to: '2024-02-29' },
  );
  assert.equal(fiscalYearStart(db, '2024-02-29', cId), '2023-03-01');
  assert.deepEqual(
    reportPeriodRange(db, 'year', { companyId: cId, date: '2024-02-15' }),
    { from: '2023-03-01', to: '2024-02-29' },
  );

  // Day after leap day starts the next fiscal year (2024-03-01 .. 2025-02-28)
  assert.deepEqual(
    reportPeriodRange(db, 'year', { companyId: cId, date: '2024-03-01' }),
    { from: '2024-03-01', to: '2025-02-28' },
  );
  assert.deepEqual(
    reportPeriodRange(db, 'year', { companyId: cId, date: '2024-03-01', offset: -1 }),
    { from: '2023-03-01', to: '2024-02-29' },
  );
  assert.deepEqual(
    reportPeriodRange(db, 'year', { companyId: cId, date: '2024-03-01', offset: -2 }),
    { from: '2022-03-01', to: '2023-02-28' },
  );

  // Quarter and month stepping across leap Feb
  assert.deepEqual(
    reportPeriodRange(db, 'quarter', { companyId: cId, date: '2024-02-29' }),
    { from: '2023-12-01', to: '2024-02-29' },
  );
  assert.deepEqual(
    reportPeriodRange(db, 'quarter', { companyId: cId, date: '2024-02-29', offset: 1 }),
    { from: '2024-03-01', to: '2024-05-31' },
  );
  assert.deepEqual(
    reportPeriodRange(db, 'month', { companyId: cId, date: '2024-03-15', offset: -1 }),
    { from: '2024-02-01', to: '2024-02-29' },
  );
});

test('FP1: company without fiscal year end falls back to calendar year (Dec 31)', () => {
  let db = seed();
  const created = create(db, 'res.company', {
    name: 'No FY Setting Co',
    currency_id: db.records['res.currency'][0].id,
  });
  db = write(created.db, 'res.company', created.id, {
    fiscalyear_last_day: null,
    fiscalyear_last_month: null,
  });

  assert.deepEqual(
    reportPeriodRange(db, 'year', { companyId: created.id, date: '2026-06-15' }),
    { from: '2026-01-01', to: '2026-12-31' },
  );
  assert.deepEqual(
    reportPeriodRange(db, 'year', { companyId: created.id, date: '2026-06-15', offset: -1 }),
    { from: '2025-01-01', to: '2025-12-31' },
  );
  assert.deepEqual(
    reportPeriodRange(db, 'quarter', { companyId: created.id, date: '2026-06-15' }),
    { from: '2026-04-01', to: '2026-06-30' },
  );
  assert.deepEqual(
    reportPeriodRange(db, 'all', { companyId: created.id, date: '2026-06-15' }),
    { from: '', to: '9999-12-31' },
  );
});

test('FP1: quarter presets follow non-calendar fiscal year and step cleanly across year boundaries', () => {
  let db = seed();
  const marCo = createCompany(db, {
    name: 'Quarter Mar Co',
    fiscalyear_last_day: 31,
    fiscalyear_last_month: 3,
  });
  db = marCo.db;
  const cId = marCo.id;

  // Fiscal quarters for FY Apr 1 .. Mar 31
  assert.deepEqual(reportPeriodRange(db, 'quarter', { companyId: cId, date: '2026-04-15' }), { from: '2026-04-01', to: '2026-06-30' });
  assert.deepEqual(reportPeriodRange(db, 'quarter', { companyId: cId, date: '2026-08-20' }), { from: '2026-07-01', to: '2026-09-30' });
  assert.deepEqual(reportPeriodRange(db, 'quarter', { companyId: cId, date: '2026-11-10' }), { from: '2026-10-01', to: '2026-12-31' });
  assert.deepEqual(reportPeriodRange(db, 'quarter', { companyId: cId, date: '2027-02-05' }), { from: '2027-01-01', to: '2027-03-31' });

  // Stepping back from Q1 lands on Q4 of previous fiscal year; stepping forward from Q4 lands on Q1 of next fiscal year
  assert.deepEqual(reportPeriodRange(db, 'quarter', { companyId: cId, date: '2026-04-15', offset: -1 }), { from: '2026-01-01', to: '2026-03-31' });
  assert.deepEqual(reportPeriodRange(db, 'quarter', { companyId: cId, date: '2026-04-15', offset: -2 }), { from: '2025-10-01', to: '2025-12-31' });
  assert.deepEqual(reportPeriodRange(db, 'quarter', { companyId: cId, date: '2027-02-05', offset: 1 }), { from: '2027-04-01', to: '2027-06-30' });

  // Comparison helper respects fiscal year and fiscal quarters when given db & companyId
  assert.deepEqual(
    periodsFor('year', 'previous', '2026-11-19', { db, companyId: cId }),
    [
      { from: '2025-04-01', to: '2026-03-31', label: '2025-04-01 → 2026-03-31' },
      { from: '2026-04-01', to: '2027-03-31', label: '2026-04-01 → 2027-03-31' },
    ],
  );
  assert.deepEqual(
    periodsFor('quarter', 'lastYear', '2026-05-15', { db, companyId: cId }),
    [
      { from: '2025-04-01', to: '2025-06-30', label: '2025-04-01 → 2025-06-30' },
      { from: '2026-04-01', to: '2026-06-30', label: '2026-04-01 → 2026-06-30' },
    ],
  );
});

test('FP1: zero-arg PERIODS picks up active company fiscal year from store for ConfigurableReport compatibility', async () => {
  const { initStore, commit } = await import('./store.js');
  await initStore();
  let db = seed();
  db = write(db, 'res.company', 1, { fiscalyear_last_day: 31, fiscalyear_last_month: 3 });
  await commit(db);

  const ref = today();
  assert.deepEqual(PERIODS.year(), reportPeriodRange(db, 'year', { companyId: 1, date: ref }));
  assert.deepEqual(PERIODS.quarter(), reportPeriodRange(db, 'quarter', { companyId: 1, date: ref }));
  assert.deepEqual(PERIODS.month(), reportPeriodRange(db, 'month', { companyId: 1, date: ref }));
  assert.deepEqual(PERIODS.all(), { from: '', to: '9999-12-31' });
});

test('FP1: Reports.jsx period select and previous/next navigation update rendered range and report data', async () => {
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting/trial-balance' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();

  let db = seed();
  const marCo = createCompany(db, {
    name: 'UI Mar Co',
    fiscalyear_last_day: 31,
    fiscalyear_last_month: 3,
  });
  db = marCo.db;
  const cId = marCo.id;
  db = setCompanies(db, { current: cId, allowed: [cId] });

  const ref = today();
  const curFy = reportPeriodRange(db, 'year', { companyId: cId, date: ref, offset: 0 });
  const prevFy = reportPeriodRange(db, 'year', { companyId: cId, date: ref, offset: -1 });
  const curQ = reportPeriodRange(db, 'quarter', { companyId: cId, date: ref, offset: 0 });
  const prevQ = reportPeriodRange(db, 'quarter', { companyId: cId, date: ref, offset: -1 });
  const curM = reportPeriodRange(db, 'month', { companyId: cId, date: ref, offset: 0 });
  const prevM = reportPeriodRange(db, 'month', { companyId: cId, date: ref, offset: -1 });

  const revAcc = search(db, 'account.account').find((a) => a.code === '400000');
  const cashAcc = search(db, 'account.account').find((a) => a.code === '101401');
  const genJournal = search(db, 'account.journal').find((j) => j.type === 'general' && (!j.company_id || j.company_id === cId));
  db = postEntry(db, {
    journal_id: genJournal.id,
    company: cId,
    date: prevFy.from,
    ref: 'PREV-FY-ENTRY',
    lines: [
      { account_id: cashAcc.id, debit: 321 },
      { account_id: revAcc.id, credit: 321 },
    ],
  }).db;
  db = postEntry(db, {
    journal_id: genJournal.id,
    company: cId,
    date: curFy.from,
    ref: 'CUR-FY-ENTRY',
    lines: [
      { account_id: cashAcc.id, debit: 654 },
      { account_id: revAcc.id, credit: 654 },
    ],
  }).db;

  await React.act(async () => commit(db));
  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'trial' } })));

    const periodSelect = () => find(host, (n) => n.tagName === 'SELECT' && props(n)?.value !== undefined && n.childNodes?.some((c) => textOf(c).includes('Custom Period')));
    const prevBtn = () => find(host, (n) => n.tagName === 'BUTTON' && props(n)?.['aria-label'] === 'Previous Period');
    const nextBtn = () => find(host, (n) => n.tagName === 'BUTTON' && props(n)?.['aria-label'] === 'Next Period');

    // Default is fiscal year (Apr 1..Mar 31)
    assert.equal(props(periodSelect()).value, 'year');
    assert.ok(textOf(host).includes(`${curFy.from} → ${curFy.to}`), `Expected current FY ${curFy.from} → ${curFy.to}`);
    assert.ok(textOf(host).includes('654.00'), 'Current FY debit appears');
    assert.ok(prevBtn() && nextBtn(), 'Previous/Next buttons render for fiscal year preset');

    // Step back one fiscal year
    await React.act(async () => props(prevBtn()).onClick());
    assert.ok(textOf(host).includes(`${prevFy.from} → ${prevFy.to}`), `Expected previous FY ${prevFy.from} → ${prevFy.to}`);
    assert.ok(textOf(host).includes('321.00'), 'Previous FY debit appears');

    // Step forward back to current fiscal year
    await React.act(async () => props(nextBtn()).onClick());
    assert.ok(textOf(host).includes(`${curFy.from} → ${curFy.to}`));

    // Switch to quarter preset (resets offset to 0) and navigate back one quarter
    await React.act(async () => props(periodSelect()).onChange({ target: { value: 'quarter' } }));
    assert.ok(textOf(host).includes(`${curQ.from} → ${curQ.to}`), `Expected current fiscal quarter ${curQ.from} → ${curQ.to}`);
    await React.act(async () => props(prevBtn()).onClick());
    assert.ok(textOf(host).includes(`${prevQ.from} → ${prevQ.to}`), `Expected previous fiscal quarter ${prevQ.from} → ${prevQ.to}`);

    // Switch to month preset and navigate back one month
    await React.act(async () => props(periodSelect()).onChange({ target: { value: 'month' } }));
    assert.ok(textOf(host).includes(`${curM.from} → ${curM.to}`));
    await React.act(async () => props(prevBtn()).onClick());
    assert.ok(textOf(host).includes(`${prevM.from} → ${prevM.to}`));

    // Custom Period hides Previous/Next navigation and exposes From/To inputs
    await React.act(async () => props(periodSelect()).onChange({ target: { value: 'custom' } }));
    assert.equal(prevBtn(), null);
    assert.equal(nextBtn(), null);
    assert.ok(find(host, (n) => n.tagName === 'INPUT' && props(n)?.['aria-label'] === 'From'));
    assert.ok(find(host, (n) => n.tagName === 'INPUT' && props(n)?.['aria-label'] === 'To'));
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('FP1: Arabic translations for period navigation labels exist in i18n.js', async () => {
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem: () => {}, removeItem: () => {}, clear: () => {} };
  try {
    const { t } = await import(`./i18n.js?lang=ar-fp1-${Date.now()}`);
    assert.equal(t('Previous Period'), 'الفترة السابقة');
    assert.equal(t('Next Period'), 'الفترة التالية');
    assert.equal(t('Choose a valid period'), 'اختر فترة صالحة');
  } finally {
    globalThis.localStorage = prevStorage;
  }
});
