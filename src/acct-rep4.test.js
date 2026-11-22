import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

import { create, search, groupRecords } from './orm.js';
import { seed } from './seed.js';
import { models } from './models/index.js';
import { depreciationReport } from './models/assets.js';
import { budgetReport } from './models/analyticplus.js';
import { applyDiff, diffDb } from './sync.js';
import { find, setupDom } from './test-support/dom.js';

async function renderReport(report, db) {
  const { initStore, commit } = await import('./store.js');
  await initStore();
  await commit(db);
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { Reports } = await import('./views/Reports.jsx');
  return renderToStaticMarkup(React.createElement(Reports, { leaf: { report } }));
}

test('REP4-1 Depreciation Schedule: option to include draft (and running) assets, off by default', async () => {
  let db = seed();

  // Running asset created through diffDb + applyDiff
  const r1 = create(db, 'account.asset', {
    name: 'Running Machine',
    company_id: 1,
    original_value: 1000,
    acquisition_date: '2026-01-01',
    state: 'open',
  });
  db = applyDiff(db, diffDb(db, r1.db), { isAdmin: true });

  // Draft asset created through diffDb + applyDiff
  const r2 = create(db, 'account.asset', {
    name: 'Draft Vehicle',
    company_id: 1,
    original_value: 500,
    acquisition_date: '2026-01-15',
    state: 'draft',
  });
  db = applyDiff(db, diffDb(db, r2.db), { isAdmin: true });

  // 1. Model test: default excludes draft assets
  const defaultReport = depreciationReport(db, { from: '2026-01-01', to: '2026-12-31' }, '1');
  assert.equal(defaultReport.rows.some((r) => r.a.name === 'Running Machine'), true, 'Running asset included by default');
  assert.equal(defaultReport.rows.some((r) => r.a.name === 'Draft Vehicle'), false, 'Draft asset excluded by default');
  assert.equal(defaultReport.totals.original, 1000);

  // 2. Model test: includeDraft option includes draft assets alongside running assets
  const draftReport = depreciationReport(db, { from: '2026-01-01', to: '2026-12-31' }, '1', { includeDraft: true });
  assert.equal(draftReport.rows.some((r) => r.a.name === 'Running Machine'), true, 'Running asset included');
  assert.equal(draftReport.rows.some((r) => r.a.name === 'Draft Vehicle'), true, 'Draft asset included when includeDraft is true');
  assert.equal(draftReport.totals.original, 1500, 'Totals reflect both running and draft assets');

  const legacyPeriod = depreciationReport(db, { from: '2026-01-01', to: '2026-12-31', includeDraft: true, reviewMode: 'all' }, '1');
  assert.equal(legacyPeriod.rows.some((r) => r.a.name === 'Draft Vehicle'), false);

  const draftRow = draftReport.rows.find((r) => r.a.name === 'Draft Vehicle');
  assert.equal(draftRow.original, 500);
  assert.equal(draftRow.book, 500);
  assert.equal(draftRow.inPeriod, 0);

  // 3. UI test: rendered Depreciation Schedule renders toggle and hides draft by default
  const html = await renderReport('depreciation', db);
  assert.match(html, /Running Machine/);
  assert.doesNotMatch(html, /Draft Vehicle/);
  assert.match(html, /type="checkbox"/);
});

test('REP4-2 Budget vs Actual: report-level company, analytic account filters and period comparison', async () => {
  let db = seed();
  // Ensure second company exists
  if (!db.records['res.company']?.some((c) => c.id === 2)) {
    const c2 = create(db, 'res.company', { id: 2, name: 'Second Company', currency_id: 1 });
    db = applyDiff(db, diffDb(db, c2.db), { isAdmin: true });
  }

  // Create analytic accounts
  const an1 = create(db, 'account.analytic.account', { name: 'Project Alpha', company_id: 1 });
  db = applyDiff(db, diffDb(db, an1.db), { isAdmin: true });
  const an2 = create(db, 'account.analytic.account', { name: 'Project Beta', company_id: 1 });
  db = applyDiff(db, diffDb(db, an2.db), { isAdmin: true });

  // Create budget in company 1 with lines for an1 and an2
  const b1 = create(db, 'account.budget', {
    name: '2026 Company 1 Budget',
    company_id: 1,
    date_from: '2026-01-01',
    date_to: '2026-12-31',
    state: 'confirmed',
    lines: [
      { planned: 10000, analytic_account_id: an1.id, general_account: '6' },
      { planned: 20000, analytic_account_id: an2.id, general_account: '6' },
    ],
  });
  db = applyDiff(db, diffDb(db, b1.db), { isAdmin: true });

  // Create budget in company 2
  const b2 = create(db, 'account.budget', {
    name: '2026 Company 2 Budget',
    company_id: 2,
    date_from: '2026-01-01',
    date_to: '2026-12-31',
    state: 'confirmed',
    lines: [
      { planned: 30000, general_account: '6' },
    ],
  });
  db = applyDiff(db, diffDb(db, b2.db), { isAdmin: true });

  // 1. Model test: Filter budgetReport by analyticAccountIds
  const fullReport = budgetReport(db, b1.id, '2026-06-30', { company_id: 1 });
  assert.equal(fullReport.length, 2, 'Unfiltered report returns all lines');

  const filteredAlpha = budgetReport(db, b1.id, '2026-06-30', { company_id: 1, analyticAccountIds: [an1.id] });
  assert.equal(filteredAlpha.length, 1, 'Filtered report returns only Project Alpha line');
  assert.equal(filteredAlpha[0].analytic_account_id, an1.id);
  assert.equal(filteredAlpha[0].planned, 10000);

  const filteredBeta = budgetReport(db, b1.id, '2026-06-30', { company_id: 1, analyticAccountIds: [an2.id] });
  assert.equal(filteredBeta.length, 1, 'Filtered report returns only Project Beta line');
  assert.equal(filteredBeta[0].analytic_account_id, an2.id);
  assert.equal(filteredBeta[0].planned, 20000);

  // 2. Model test: Period option restricts date range
  const periodReport = budgetReport(db, b1.id, '2026-03-31', { period: { from: '2026-01-01', to: '2026-03-31' }, company_id: 1 });
  assert.equal(periodReport.length, 2);

  // 3. UI test: Report-level company selector, analytic filter, and comparison dropdown are rendered
  const html = await renderReport('budget', db);
  assert.match(html, /2026 Company 1 Budget/);
  assert.match(html, /aria-label="Company"/, 'renders report-level company selector');
  assert.match(html, /aria-label="Analytic Accounts"/, 'renders report-level analytic account filter');
  assert.match(html, /Previous Period/, 'renders comparison dropdown options');
  assert.match(html, /Same Period Last Year/);
});

test('REP4-3 Invoice Analysis groups invoice amounts by journal, fiscal position and partner country', () => {
  let db = seed();
  const partner = create(db, 'res.partner', { name: 'REP4 Partner', country: 'Egypt' });
  db = partner.db;
  const journal = db.records['account.journal'][0];
  const position = create(db, 'account.fiscal.position', { name: 'REP4 Position' });
  db = position.db;
  const invoice = create(db, 'account.move', {
    move_type: 'out_invoice', state: 'draft', partner_id: partner.id,
    journal_id: journal.id, fiscal_position_id: position.id,
    invoice_date: '2026-01-01', invoice_line_ids: [{ name: 'REP4 line', qty: 1, price_unit: 123 }],
  });
  db = invoice.db;
  const rows = search(db, 'account.invoice.report').filter((r) => r.move_id === invoice.id);
  assert.equal(rows.length, 1);
  for (const [field, key] of [['journal_id', journal.id], ['fiscal_position_id', position.id], ['country_id', 'Egypt']]) {
    assert.ok(models['account.invoice.report'].groupBys.includes(field));
    const group = groupRecords(db, 'account.invoice.report', rows, field).find((g) => g.key === key);
    assert.equal(group?.records.length, 1);
    assert.equal(group.records[0].price_subtotal, 123);
  }
});

test('REP4-4 Budget comparison displays period headers and the same amounts as single-period mode', async () => {
  const { makeEl } = setupDom();
  globalThis.window = Object.assign(new EventTarget(), { HTMLIFrameElement: class {}, scrollTo() {}, document: globalThis.document, location: { hash: '' } });
  globalThis.document.createElementNS = (_, tag) => makeEl(tag);
  globalThis.location = globalThis.window.location;
  const container = makeEl('div');
  container.ownerDocument = globalThis.document;
  let db = seed();
  const budget = create(db, 'account.budget', { name: 'Comparison budget', company_id: 1, date_from: '2020-01-01', date_to: '2099-12-31', state: 'confirmed', lines: [{ planned: 12345, general_account: '6' }] });
  db = budget.db;
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();
  await React.act(async () => commit(db));
  const { Reports } = await import('./views/Reports.jsx');
  const root = createRoot(container);
  const props = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];
  const textOf = (node) => node.nodeType === 3 ? node.nodeValue : (node.childNodes ?? []).map(textOf).join('');
  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'budget' } })));
    const row = () => find(container, (n) => n.tagName === 'TR' && n.className === 'rep-detail');
    const single = row().childNodes.map(textOf);
    const comparison = find(container, (n) => n.tagName === 'SELECT' && n.options.some((o) => textOf(o) === 'Previous Period'));
    await React.act(async () => props(comparison).onChange({ target: { value: 'previous' } }));
    const header = find(container, (n) => n.tagName === 'THEAD');
    const headers = header.childNodes[0].childNodes.map(textOf);
    assert.equal(headers.length, 11);
    assert.equal(new Set(headers.slice(1)).size, 10);
    assert.ok(headers[1].includes('Planned'));
    assert.ok(headers[6].includes('Planned'));
    const compared = row().childNodes.map(textOf);
    assert.equal(compared.length, 11);
    assert.deepEqual(compared.slice(0, 6), single);
  } finally {
    await React.act(async () => root.unmount());
  }
});
