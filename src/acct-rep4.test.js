import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

import { create, read, search, groupRecords } from './orm.js';
import { seed } from './seed.js';
import { models } from './models/index.js';
import { depreciationReport } from './models/assets.js';
import { budgetReport } from './models/analyticplus.js';
import { applyDiff, diffDb } from './sync.js';
import { find, setupDom } from './test-support/dom.js';
import { today } from './models/common.js';
import { postMove } from './models/accounting.js';

const replaceRecord = (db, model, id, values) => ({
  ...db,
  records: {
    ...db.records,
    [model]: db.records[model].map((r) => r.id === id ? { ...r, ...values } : r),
  },
});

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
    const row = () => find(container, (n) => n.tagName === 'TR' && n.className === 'rep-detail' && textOf(n.childNodes[0]) === '6');
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

test('REP4-5 Current unfinished budget period evaluates achievement against full period plan', async () => {
  let db = seed();
  const currentYear = today().slice(0, 4);
  const an = create(db, 'account.analytic.account', { name: 'Unfinished Project', company_id: 1 });
  db = an.db;
  const posted = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: 1, company_id: 1, date: `${currentYear}-01-01`, invoice_date: `${currentYear}-01-01`,
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(posted.db, posted.id);
  const expenseAccount = search(db, 'account.account').find((a) => a.code === '600000' && (!a.company_id || a.company_id === 1));
  db = create(db, 'account.analytic.line', {
    account_id: an.id, move_id: posted.id, company_id: 1, date: `${currentYear}-01-02`, amount: -2000, general_account: expenseAccount.id,
  }).db;
  const budget = create(db, 'account.budget', {
    name: 'Unfinished period budget',
    budget_type: 'expense',
    company_id: 1,
    date_from: `${currentYear}-01-01`,
    date_to: '2030-12-31',
    state: 'confirmed',
    lines: [
      { planned: 10000, analytic_account_id: an.id, general_account: '600', date_from: `${currentYear}-01-01`, date_to: '2030-12-31' },
    ],
  });
  db = budget.db;

  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { Budget } = await import('./views/Reports.jsx');
  const { reportMoney } = await import('./views/reportCompany.jsx');
  const money = reportMoney(db, 1);

  const period = { from: `${currentYear}-01-01`, to: '2030-12-31' };
  const html = renderToStaticMarkup(
    React.createElement('table', null,
      React.createElement(Budget, { db, period, companyId: '1', money })
    )
  );

  const expectedReport = budgetReport(db, budget.id, today(), { period, company_id: 1 });
  assert.equal(expectedReport[0].budget_achievement, 20);
  assert.equal(expectedReport[0].achievement, 20);
  assert.match(html, />20%</);
});

test('REP4-6 Budget starting in current period displays zero metrics for nonoverlapping earlier period', async () => {
  let db = seed();
  const budget = create(db, 'account.budget', {
    name: 'Current Year Only Budget',
    company_id: 1,
    date_from: '2026-01-01',
    date_to: '2026-12-31',
    state: 'confirmed',
    lines: [
      { planned: 10000, general_account: '6' },
    ],
  });
  db = budget.db;

  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { Budget } = await import('./views/Reports.jsx');
  const { reportMoney } = await import('./views/reportCompany.jsx');
  const money = reportMoney(db, 1);

  // Comparison between earlier period (2025) and current period (2026)
  const periods = [
    { label: '2025', from: '2025-01-01', to: '2025-12-31' },
    { label: '2026', from: '2026-01-01', to: '2026-12-31' },
  ];
  const html = renderToStaticMarkup(
    React.createElement('table', null,
      React.createElement(Budget, { db, period: periods[1], periods, companyId: '1', money })
    )
  );

  assert.match(html, /Current Year Only Budget/);
  // Current period (2026) displays planned $10,000.00
  assert.match(html, />\$10,000\.00</);
  // Earlier nonoverlapping period (2025) renders zero metrics ($0.00) without negative variance
  const rowMatch = html.match(/<tr class="rep-detail"><td>6<\/td>(.*?)<\/tr>/);
  assert.ok(rowMatch, 'found detail row');
  const cells = rowMatch[1].match(/<td[^>]*>(.*?)<\/td>/g) || [];
  // Period 2025 cells: planned 0, practical 0, committed 0, variance 0, achievement empty
  const p2025Cells = cells.slice(0, 5);
  assert.deepEqual(p2025Cells, [
    '<td class="num">$0.00</td>',
    '<td class="num">$0.00</td>',
    '<td class="num">$0.00</td>',
    '<td class="num">$0.00</td>',
    '<td class="num"></td>',
  ]);
});

test('REP4-7 Analytic filter retains companyless budgets and failed reports', async () => {
  let db = seed();
  const an = create(db, 'account.analytic.account', { name: 'Active Filter Account', company_id: 1 });
  db = an.db;

  const b1 = create(db, 'account.budget', {
    name: 'Companyless Budget',
    company_id: 1,
    date_from: '2026-01-01',
    date_to: '2026-12-31',
    state: 'confirmed',
    lines: [{ planned: 5000, analytic_account_id: an.id }],
  });
  db = replaceRecord(b1.db, 'account.budget', b1.id, { company_id: null });

  const b2 = create(db, 'account.budget', {
    name: 'Error Budget',
    company_id: 1,
    date_from: '2026-01-01',
    date_to: '2026-12-31',
    state: 'confirmed',
    lines: [{ planned: 5000, account_id: 999999, analytic_account_id: an.id }],
  });
  db = b2.db;

  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { Budget } = await import('./views/Reports.jsx');
  const { reportMoney } = await import('./views/reportCompany.jsx');
  const money = reportMoney(db, 1);

  const period = { from: '2026-01-01', to: '2026-12-31' };
  const html = renderToStaticMarkup(
    React.createElement('table', null,
      React.createElement(Budget, { db, period, companyId: 'all', analyticAccountIds: [an.id], money })
    )
  );

  assert.match(html, /Companyless Budget/);
  assert.match(html, /Select a company to show this budget report/);
  assert.match(html, /Error Budget/);
  assert.match(html, /Budget account not found/);
});

test('REP4-8 Later comparison period failure renders unavailable cells and does not reuse earlier figures', async () => {
  let db = seed();
  const budget = create(db, 'account.budget', {
    name: 'Comparison Error Budget',
    company_id: 1,
    date_from: '2025-01-01',
    date_to: '2026-12-31',
    state: 'confirmed',
    lines: [
      { planned: 12345, general_account: '600' },
    ],
  });
  db = budget.db;

  const po1 = create(db, 'purchase.order', {
    state: 'purchase', partner_id: 1, company_id: 1, date_order: '2025-06-01',
    order_line: [{ id: 991, purchase_line_key: 'line-unique-2025', qty: 1, price_unit: 100, tax: 0 }],
  });
  db = po1.db;

  const po2 = create(db, 'purchase.order', {
    state: 'purchase', partner_id: 1, company_id: 1, date_order: '2026-06-01',
    order_line: [
      { id: 992, purchase_line_key: 'dup', qty: 1, price_unit: 100, tax: 0 },
      { id: 992, purchase_line_key: 'dup', qty: 1, price_unit: 100, tax: 0 },
    ],
  });
  db = po2.db;

  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { Budget } = await import('./views/Reports.jsx');
  const { reportMoney } = await import('./views/reportCompany.jsx');
  const money = reportMoney(db, 1);

  const periods = [
    { label: '2025', from: '2025-01-01', to: '2025-12-31' },
    { label: '2026', from: '2026-01-01', to: '2026-12-31' },
  ];

  const html = renderToStaticMarkup(
    React.createElement('table', null,
      React.createElement(Budget, { db, period: periods[0], periods, companyId: '1', money })
    )
  );

  assert.match(html, />\$6,172\.50</);
  assert.match(html, /Configure a unique purchase order line link/);
  const matches = html.match(/>\$6,172\.50</g) || [];
  assert.equal(matches.length, 1, 'Prorated planned amount 6172.50 should only appear for period 2025, not repeated in period 2026');
  assert.match(html, /—/);
});

test('REP4-9 Expense budget unbilled purchase commitment detail matches committed summary sign', async () => {
  let db = seed();
  const analytic = create(db, 'account.analytic.account', { name: 'Expense Project', company_id: 1 });
  db = analytic.db;
  const budget = create(db, 'account.budget', {
    name: 'Expense Commitment Budget',
    budget_type: 'expense',
    company_id: 1,
    date_from: '2026-01-01',
    date_to: '2026-12-31',
    state: 'confirmed',
    lines: [{ analytic_account_id: analytic.id, planned: 1000 }],
  });
  db = budget.db;

  const purchase = create(db, 'purchase.order', {
    name: 'PO-2026-EXP',
    partner_id: 2,
    date_order: '2026-01-10',
    order_line: [{ product_id: 5, qty: 1, price_unit: 150, tax: 0, analytic_distribution: { [analytic.id]: 100 } }],
  });
  const confirm = models['purchase.order'].form.buttons.find((button) => button.label === 'Confirm Order');
  db = confirm.run(purchase.db, read(purchase.db, 'purchase.order', purchase.id)).db;

  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { Budget } = await import('./views/Reports.jsx');
  const { reportMoney } = await import('./views/reportCompany.jsx');
  const money = reportMoney(db, 1);

  const period = { from: '2026-01-01', to: '2026-12-31' };
  const html = renderToStaticMarkup(
    React.createElement('table', null,
      React.createElement(Budget, { db, period, companyId: '1', money })
    )
  );

  // The summary row committed column shows positive $150.00 for expense budget
  assert.match(html, />\$150\.00</);
  // Specifically in the purchase order commitment detail row, it must show $150.00, not -$150.00
  assert.match(html, /PO-2026-EXP/);
  const poRowMatch = html.match(/<tr class="rep-detail"><td><a[^>]*>PO-2026-EXP<\/a><\/td>(.*?)<\/tr>/);
  assert.ok(poRowMatch, 'found commitment detail row for PO-2026-EXP');
  assert.doesNotMatch(poRowMatch[1], />-\$150\.00</, 'commitment detail row should not be negative');
  assert.match(poRowMatch[1], />\$150\.00</, 'commitment detail row should match the positive committed summary');
});

test('REP4-10 Periodic body reports and comparison use canonical PERIODIC_BODY_REPORTS and COMPARABLE_REPORTS', async () => {
  const { PERIODIC_BODY_REPORTS, COMPARABLE_REPORTS, REPORTS } = await import('./views/Reports.jsx');
  assert.ok(PERIODIC_BODY_REPORTS instanceof Set, 'PERIODIC_BODY_REPORTS should be a Set');
  assert.ok(COMPARABLE_REPORTS instanceof Set, 'COMPARABLE_REPORTS should be a Set');

  for (const rep of ['trial', 'fiscal', 'tax', 'budget']) {
    assert.ok(PERIODIC_BODY_REPORTS.has(rep), `PERIODIC_BODY_REPORTS should include ${rep}`);
    assert.ok(COMPARABLE_REPORTS.has(rep), `COMPARABLE_REPORTS should include ${rep}`);
    assert.ok(REPORTS[rep]?.Body, `Report ${rep} should define a Body component`);
  }

  // Adding a report to PERIODIC_BODY_REPORTS should dynamically control both header and body rendering in ReportPage
  const { makeEl } = setupDom();
  globalThis.window = Object.assign(new EventTarget(), { HTMLIFrameElement: class {}, scrollTo() {}, document: globalThis.document, location: { hash: '' } });
  globalThis.document.createElementNS = (_, tag) => makeEl(tag);
  globalThis.location = globalThis.window.location;
  const container = makeEl('div');
  container.ownerDocument = globalThis.document;

  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const db = seed();
  await initStore();
  await React.act(async () => commit(db));

  const { Reports } = await import('./views/Reports.jsx');
  const root = createRoot(container);
  const textOf = (node) => node.nodeType === 3 ? node.nodeValue : (node.childNodes ?? []).map(textOf).join('');

  const customKey = 'test_periodic_rep';
  REPORTS[customKey] = {
    title: 'Custom Test Report',
    Body: ({ periods }) => React.createElement('tbody', null,
      React.createElement('tr', { className: 'rep-detail' },
        React.createElement('td', null, 'RowTitle'),
        ...(periods ?? []).flatMap((p) => [
          React.createElement('td', { key: `${p.label}-1`, className: 'num' }, '10'),
          React.createElement('td', { key: `${p.label}-2`, className: 'num' }, '20'),
        ]),
      )
    ),
    cols: ['Col1', 'Col2'],
  };

  try {
    PERIODIC_BODY_REPORTS.add(customKey);
    COMPARABLE_REPORTS.add(customKey);

    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: customKey } })));
    const props = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];
    const comparison = find(container, (n) => n.tagName === 'SELECT' && n.options.some((o) => textOf(o) === 'Previous Period'));
    assert.ok(comparison, 'Comparison selector is rendered because COMPARABLE_REPORTS includes the report');

    await React.act(async () => props(comparison).onChange({ target: { value: 'previous' } }));

    const thead = find(container, (n) => n.tagName === 'THEAD');
    const headerCols = thead.childNodes[0].childNodes.map(textOf);
    assert.equal(headerCols.length, 5, 'Header columns rendered via PERIODIC_BODY_REPORTS branch');

    const tr = find(container, (n) => n.tagName === 'TR' && n.className === 'rep-detail');
    const bodyCells = tr.childNodes.map(textOf);
    assert.equal(bodyCells.length, 5, 'Body row cells match header columns count');
    assert.equal(bodyCells.length, headerCols.length, 'Header column count and body cell count stay aligned');
  } finally {
    delete REPORTS[customKey];
    if (PERIODIC_BODY_REPORTS) PERIODIC_BODY_REPORTS.delete(customKey);
    if (COMPARABLE_REPORTS) COMPARABLE_REPORTS.delete(customKey);
    await React.act(async () => root.unmount());
  }
});


