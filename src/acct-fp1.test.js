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

test('FP1: PERIODS requires explicit db without global provider and uses passed company fiscal year', async () => {
  let db = seed();
  db = write(db, 'res.company', 1, { fiscalyear_last_day: 31, fiscalyear_last_month: 3 });

  assert.throws(() => PERIODS.year(), /Database is required/);
  assert.throws(() => PERIODS.quarter(), /Database is required/);
  assert.throws(() => PERIODS.month(), /Database is required/);
  assert.throws(() => PERIODS.all(), /Database is required/);

  const ref = today();
  assert.deepEqual(PERIODS.year(db, 1), reportPeriodRange(db, 'year', { companyId: 1, date: ref }));
  assert.deepEqual(PERIODS.quarter(db, 1), reportPeriodRange(db, 'quarter', { companyId: 1, date: ref }));
  assert.deepEqual(PERIODS.month(db, 1), reportPeriodRange(db, 'month', { companyId: 1, date: ref }));
  assert.deepEqual(PERIODS.all(db, 1), { from: '', to: '9999-12-31' });
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

test('FP1: explicit fiscal years separated by a gap never overlap during navigation or comparison', async () => {
  let db = seed();
  const comp = createCompany(db, {
    name: 'Gap Co',
    fiscalyear_last_day: 31,
    fiscalyear_last_month: 3,
  });
  db = comp.db;
  const cId = comp.id;
  db = create(db, 'account.fiscal.year', {
    name: 'FY 2024',
    company_id: cId,
    date_from: '2024-01-01',
    date_to: '2024-12-31',
  }).db;
  db = create(db, 'account.fiscal.year', {
    name: 'FY 2025-26',
    company_id: cId,
    date_from: '2025-04-01',
    date_to: '2026-03-31',
  }).db;

  // Gap between 2024-12-31 and 2025-04-01 is clamped before 2025-04-01
  assert.deepEqual(fiscalYearDates(db, '2025-03-31', cId), { from: '2025-01-01', to: '2025-03-31' });
  // Pre-FY1 fallback (Mar 31 year-end) is clamped before 2024-01-01
  assert.deepEqual(fiscalYearDates(db, '2023-12-31', cId), { from: '2023-04-01', to: '2023-12-31' });

  // Stepping back from FY 2025-26 lands on the 3-month gap, then FY 2024
  assert.deepEqual(
    reportPeriodRange(db, 'year', { companyId: cId, date: '2025-05-01', offset: -1 }),
    { from: '2025-01-01', to: '2025-03-31' },
  );
  assert.deepEqual(
    reportPeriodRange(db, 'year', { companyId: cId, date: '2025-05-01', offset: -2 }),
    { from: '2024-01-01', to: '2024-12-31' },
  );
  // Stepping forward from FY 2024 lands on the gap, then FY 2025-26
  assert.deepEqual(
    reportPeriodRange(db, 'year', { companyId: cId, date: '2024-06-15', offset: 1 }),
    { from: '2025-01-01', to: '2025-03-31' },
  );
  assert.deepEqual(
    reportPeriodRange(db, 'year', { companyId: cId, date: '2024-06-15', offset: 2 }),
    { from: '2025-04-01', to: '2026-03-31' },
  );

  // Comparison columns do not overlap across the gap
  assert.deepEqual(
    periodsFor('year', 'last3', '2025-05-01', { db, companyId: cId }),
    [
      { from: '2024-01-01', to: '2024-12-31', label: '2024' },
      { from: '2025-01-01', to: '2025-03-31', label: '2025-01-01 → 2025-03-31' },
      { from: '2025-04-01', to: '2026-03-31', label: '2025-04-01 → 2026-03-31' },
    ],
  );

  // UI pager navigation in Reports.jsx steps cleanly back into the gap and forward back into current FY
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting/trial-balance' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();

  const ref = today();
  const refYear = Number(ref.slice(0, 4));
  const refMonth = Number(ref.slice(5, 7));
  const fyStartYear = refMonth >= 4 ? refYear : refYear - 1;
  const curFrom = `${fyStartYear}-04-01`;
  const curTo = `${fyStartYear + 1}-03-31`;
  const gapFrom = `${fyStartYear}-01-01`;
  const gapTo = `${fyStartYear}-03-31`;
  const prevFrom = `${fyStartYear - 1}-01-01`;
  const prevTo = `${fyStartYear - 1}-12-31`;

  let uiDb = seed();
  const uiCo = createCompany(uiDb, { name: 'UI Gap Co', fiscalyear_last_day: 31, fiscalyear_last_month: 3 });
  uiDb = uiCo.db;
  uiDb = create(uiDb, 'account.fiscal.year', { name: 'Prev Cal FY', company_id: uiCo.id, date_from: prevFrom, date_to: prevTo }).db;
  uiDb = create(uiDb, 'account.fiscal.year', { name: 'Cur Apr FY', company_id: uiCo.id, date_from: curFrom, date_to: curTo }).db;
  uiDb = setCompanies(uiDb, { current: uiCo.id, allowed: [uiCo.id] });

  await React.act(async () => commit(uiDb));
  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'trial' } })));
    const prevBtn = () => find(host, (n) => n.tagName === 'BUTTON' && props(n)?.['aria-label'] === 'Previous Period');
    const nextBtn = () => find(host, (n) => n.tagName === 'BUTTON' && props(n)?.['aria-label'] === 'Next Period');

    assert.ok(textOf(host).includes(`${curFrom} → ${curTo}`));
    await React.act(async () => props(prevBtn()).onClick());
    assert.ok(textOf(host).includes(`${gapFrom} → ${gapTo}`), 'Stepping back lands on non-overlapping gap');
    await React.act(async () => props(prevBtn()).onClick());
    assert.ok(textOf(host).includes(`${prevFrom} → ${prevTo}`), 'Stepping back again lands on earlier explicit FY');
    await React.act(async () => props(nextBtn()).onClick());
    assert.ok(textOf(host).includes(`${gapFrom} → ${gapTo}`), 'Stepping forward lands back on gap');
    await React.act(async () => props(nextBtn()).onClick());
    assert.ok(textOf(host).includes(`${curFrom} → ${curTo}`), 'Stepping forward again lands on current explicit FY');
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('FP1: ConfigurableReport uses selected company fiscal year and fiscal comparison columns', async () => {
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting/profit-and-loss' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();

  let db = seed();
  // Company 1 stays Dec 31 calendar year; Company 2 uses Mar 31 fiscal year-end
  const marCo = createCompany(db, {
    name: 'Secondary Mar Co',
    fiscalyear_last_day: 31,
    fiscalyear_last_month: 3,
  });
  db = marCo.db;
  const c2 = marCo.id;
  db = setCompanies(db, { current: 1, allowed: [1, c2] });

  const ref = today();
  const c1Fy = reportPeriodRange(db, 'year', { companyId: 1, date: ref });
  const c2CurFy = reportPeriodRange(db, 'year', { companyId: c2, date: ref });
  const c2PrevFy = reportPeriodRange(db, 'year', { companyId: c2, date: ref, offset: -1 });

  const revAcc = search(db, 'account.account').find((a) => a.code === '400000' && (a.company_id ?? 1) === c2)
    ?? search(db, 'account.account').find((a) => a.code === '400000');
  const cashAcc = search(db, 'account.account').find((a) => a.code === '101401' && (a.company_id ?? 1) === c2)
    ?? search(db, 'account.account').find((a) => a.code === '101401');
  const genJournal = search(db, 'account.journal').find((j) => j.type === 'general' && j.company_id === c2)
    ?? search(db, 'account.journal').find((j) => j.type === 'general');

  db = postEntry(db, {
    journal_id: genJournal.id,
    company: c2,
    date: c2PrevFy.from,
    ref: 'C2-PREV-FY',
    lines: [
      { account_id: cashAcc.id, debit: 111 },
      { account_id: revAcc.id, credit: 111 },
    ],
  }).db;
  db = postEntry(db, {
    journal_id: genJournal.id,
    company: c2,
    date: c2CurFy.from,
    ref: 'C2-CUR-FY',
    lines: [
      { account_id: cashAcc.id, debit: 222 },
      { account_id: revAcc.id, credit: 222 },
    ],
  }).db;

  await React.act(async () => commit(db));
  const { ConfigurableReportPage } = await import('./views/ConfigurableReport.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    await React.act(async () => root.render(React.createElement(ConfigurableReportPage, { statementKind: 'pnl', title: 'Profit and Loss' })));

    const companySelect = () => find(host, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === 'Company');
    const periodSelect = () => find(host, (n) => n.tagName === 'SELECT' && n.childNodes?.some((c) => textOf(c).includes('Custom Period')));
    const comparisonSelect = () => find(host, (n) => n.tagName === 'SELECT' && n.childNodes?.some((c) => textOf(c).includes('No comparison')));
    const headers = () => {
      const thead = find(host, (n) => n.tagName === 'THEAD');
      return thead ? (thead.childNodes?.[0]?.childNodes ?? []).map((th) => textOf(th)) : [];
    };

    // "All Companies" preserves active company (company 1, Dec 31 calendar year)
    assert.equal(props(companySelect()).value, 'all');
    assert.ok(textOf(host).includes(`${c1Fy.from} → ${c1Fy.to}`), `Expected active company FY ${c1Fy.from} → ${c1Fy.to}`);

    // Selecting Company 2 switches the statement preset to Company 2's Mar 31 fiscal year
    await React.act(async () => props(companySelect()).onChange({ target: { value: String(c2) } }));
    assert.ok(textOf(host).includes(`${c2CurFy.from} → ${c2CurFy.to}`), `Expected Company 2 FY ${c2CurFy.from} → ${c2CurFy.to}`);

    // Enabling "Previous Period" comparison produces fiscal-year columns matching Company 2 (not calendar columns)
    await React.act(async () => props(comparisonSelect()).onChange({ target: { value: 'previous' } }));
    assert.deepEqual(headers(), ['Report Lines', `${c2PrevFy.from} → ${c2PrevFy.to}`, `${c2CurFy.from} → ${c2CurFy.to}`, 'Variance', '%']);
    assert.ok(textOf(host).includes('111.00'), 'Previous FY revenue appears in previous FY column');
    assert.ok(textOf(host).includes('222.00'), 'Current FY revenue appears in current FY column');

    // Custom period comparison continues using custom range math
    await React.act(async () => props(periodSelect()).onChange({ target: { value: 'custom' } }));
    const fromInput = () => find(host, (n) => n.tagName === 'INPUT' && props(n)?.['aria-label'] === 'From');
    const toInput = () => find(host, (n) => n.tagName === 'INPUT' && props(n)?.['aria-label'] === 'To');
    await React.act(async () => props(fromInput()).onChange({ target: { value: '2026-03-01' } }));
    await React.act(async () => props(toInput()).onChange({ target: { value: '2026-03-31' } }));
    const customHeaders = headers();
    assert.equal(customHeaders.length, 5);
    assert.ok(customHeaders.includes('2026-02-01 → 2026-02-28'), 'Custom comparison keeps prior month range');
    assert.ok(customHeaders.includes('2026-03-01 → 2026-03-31'), 'Custom comparison keeps selected custom range');
  } finally {
    await React.act(async () => root.unmount());
  }
});
