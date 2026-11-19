import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { create, read, search } from './orm.js';
import { seed } from './seed.js';
import { postEntry } from './models/ledger.js';
import { today } from './models/common.js';
import {
  accountJournalItemsHref,
  configurableReport,
  findStatementReport,
  isExpandableLine,
} from './models/configurableReports.js';
import { cashFlow } from './models/reports.js';
import {
  cashflowAnalyticColumns,
  executiveColumns,
} from './views/reportCompare.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const props = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];

// ---------------------------------------------------------------------------
// FIN-9 (a): Executive Summary period comparison
// ---------------------------------------------------------------------------

test('FIN-9 (a) model: executiveColumns computes aligned KPI columns with variance across calendar periods', () => {
  let db = seed();
  db = { ...db, records: { ...db.records, 'account.move': [], 'account.payment': [] } };
  const yr = Number(today().slice(0, 4));
  const cashAcc = search(db, 'account.account').find((a) => a.code === '101401');
  const revAcc = search(db, 'account.account').find((a) => a.code === '400000');
  const expAcc = search(db, 'account.account').find((a) => a.code === '600000');

  // Period 1 (Jan): Revenue 1000, Expense 400 -> Net 600
  db = postEntry(db, {
    journal: 'MISC', company: 1, date: `${yr}-01-15`,
    lines: [
      { account_id: cashAcc.id, debit: 600 },
      { account_id: expAcc.id, debit: 400 },
      { account_id: revAcc.id, credit: 1000 },
    ],
  }).db;

  // Period 2 (Feb): Revenue 2000, Expense 500 -> Net 1500
  db = postEntry(db, {
    journal: 'MISC', company: 1, date: `${yr}-02-15`,
    lines: [
      { account_id: cashAcc.id, debit: 1500 },
      { account_id: expAcc.id, debit: 500 },
      { account_id: revAcc.id, credit: 2000 },
    ],
  }).db;

  const periods = [
    { from: `${yr}-01-01`, to: `${yr}-01-31`, label: 'Jan' },
    { from: `${yr}-02-01`, to: `${yr}-02-28`, label: 'Feb' },
  ];

  const cols = executiveColumns(db, periods);
  assert.deepEqual(cols.headers, ['Jan', 'Feb']);
  assert.ok(Array.isArray(cols.totals));
  assert.ok(cols.totals.length >= 10, 'Executive summary comparison has at least 10 KPI lines');

  const revTotal = cols.totals.find((t) => t.label === 'Revenue');
  const netTotal = cols.totals.find((t) => t.label === 'Net Profit');
  const cashTotal = cols.totals.find((t) => t.label === 'Cash');

  assert.ok(revTotal, 'Revenue total line exists');
  assert.ok(netTotal, 'Net Profit total line exists');
  assert.ok(cashTotal, 'Cash total line exists');

  assert.deepEqual(revTotal.values, [1000, 2000]);
  assert.deepEqual(netTotal.values, [600, 1500]);
  assert.deepEqual(cashTotal.values, [600, 2100]);

  // Variance verification for Revenue: Feb (2000) vs Jan (1000) -> +1000, +100%
  const revIdx = cols.totals.findIndex((t) => t.label === 'Revenue');
  assert.deepEqual(cols.variance[cols.sections.length + revIdx], { amount: 1000, pct: 100 });
});

test('FIN-9 (a) view: Reports.jsx renders Comparison select for Executive Summary and displays comparison columns', async () => {
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting/executive-summary' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const store = await import('./store.js');
  await store.initStore();

  let db = seed();
  db = { ...db, records: { ...db.records, 'account.move': [], 'account.payment': [] } };
  const yr = Number(today().slice(0, 4));
  const cashAcc = search(db, 'account.account').find((a) => a.code === '101401');
  const revAcc = search(db, 'account.account').find((a) => a.code === '400000');

  // Month 1
  db = postEntry(db, {
    journal: 'MISC', company: 1, date: `${yr}-01-15`,
    lines: [{ account_id: cashAcc.id, debit: 1000 }, { account_id: revAcc.id, credit: 1000 }],
  }).db;
  // Month 2
  db = postEntry(db, {
    journal: 'MISC', company: 1, date: `${yr}-02-15`,
    lines: [{ account_id: cashAcc.id, debit: 1500 }, { account_id: revAcc.id, credit: 1500 }],
  }).db;

  await React.act(async () => store.commit(db));

  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'executive', title: 'Executive Summary' } })));

    // Verify Comparison selector is rendered for executive summary
    const compSelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.value === 'none');
    assert.ok(compSelect, 'Comparison dropdown must be rendered for Executive Summary');

    // Select comparison: 'previous'
    await React.act(async () => {
      props(compSelect).onChange({ target: { value: 'previous' } });
    });

    // When comparison is active, table must show Variance and % header columns
    assert.ok(host.textContent.includes('Variance'), 'Table header must include Variance');
    assert.ok(host.textContent.includes('%'), 'Table header must include %');
    assert.ok(host.textContent.includes('Revenue'), 'Executive Summary rows must be present');
  } finally {
    await React.act(async () => root.unmount());
  }
});

// ---------------------------------------------------------------------------
// FIN-9 (b): Cash Flow Statement horizontal groups
// ---------------------------------------------------------------------------

test('FIN-9 (b) model: cashFlow supports weight function and cashflowAnalyticColumns partitions cash flows by bucket', () => {
  let db = seed();
  db = { ...db, records: { ...db.records, 'account.move': [], 'account.payment': [] } };
  const yr = Number(today().slice(0, 4));
  const p1 = create(db, 'res.partner', { name: 'Partner One' }); db = p1.db;
  const p2 = create(db, 'res.partner', { name: 'Partner Two' }); db = p2.db;
  const cashAcc = search(db, 'account.account').find((a) => a.code === '101401');
  const revAcc = search(db, 'account.account').find((a) => a.code === '400000');

  // Entry 1 with partner 1: Revenue 500
  db = postEntry(db, {
    journal: 'MISC', company: 1, date: `${yr}-05-10`,
    lines: [
      { account_id: cashAcc.id, debit: 500, partner_id: p1.id },
      { account_id: revAcc.id, credit: 500, partner_id: p1.id },
    ],
  }).db;

  // Entry 2 with partner 2: Revenue 800
  db = postEntry(db, {
    journal: 'MISC', company: 1, date: `${yr}-05-20`,
    lines: [
      { account_id: cashAcc.id, debit: 800, partner_id: p2.id },
      { account_id: revAcc.id, credit: 800, partner_id: p2.id },
    ],
  }).db;

  const period = { from: `${yr}-05-01`, to: `${yr}-05-31` };

  // Verify weight in cashFlow directly
  const cfP1 = cashFlow(db, { ...period, weight: (l) => Number(l.partner_id === p1.id) });
  assert.equal(cfP1.operating, 500);
  assert.equal(cfP1.net, 500);

  const cfP2 = cashFlow(db, { ...period, weight: (l) => Number(l.partner_id === p2.id) });
  assert.equal(cfP2.operating, 800);
  assert.equal(cfP2.net, 800);

  // Horizontal group model by partner
  const group = create(db, 'account.report.horizontal.group', {
    name: 'Cashflow Partners',
    company_id: 1,
    rule_ids: [{ field: 'partner', partner_ids: [p1.id, p2.id] }],
  });
  db = group.db;

  const groupedCols = cashflowAnalyticColumns(db, read(db, 'account.report.horizontal.group', group.id), period);
  assert.ok(groupedCols.headers.includes('Partner One'), 'Includes Partner One column header');
  assert.ok(groupedCols.headers.includes('Partner Two'), 'Includes Partner Two column header');
  assert.ok(groupedCols.headers.includes('Others'), 'Includes Others column header');

  const p1Idx = groupedCols.headers.indexOf('Partner One');
  const p2Idx = groupedCols.headers.indexOf('Partner Two');

  const opSection = groupedCols.sections.find((s) => s.title === 'Operating Activities');
  assert.ok(opSection);
  assert.equal(opSection.totals[p1Idx], 500);
  assert.equal(opSection.totals[p2Idx], 800);

  const netTotal = groupedCols.totals.find((t) => t.label === 'Net Change in Cash');
  assert.ok(netTotal);
  assert.equal(netTotal.values[p1Idx], 500);
  assert.equal(netTotal.values[p2Idx], 800);
});

test('FIN-9 (b) view: Reports.jsx renders Horizontal Group selector on Cash Flow when cashflow group exists and renders bucket columns', async () => {
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting/reports/cash-flow' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const store = await import('./store.js');
  await store.initStore();

  let db = seed();
  db = { ...db, records: { ...db.records, 'account.move': [], 'account.payment': [] } };
  const yr = Number(today().slice(0, 4));
  const p1 = create(db, 'res.partner', { name: 'Alpha Client' }); db = p1.db;
  const cashAcc = search(db, 'account.account').find((a) => a.code === '101401');
  const revAcc = search(db, 'account.account').find((a) => a.code === '400000');

  db = postEntry(db, {
    journal: 'MISC', company: 1, date: `${yr}-06-10`,
    lines: [
      { account_id: cashAcc.id, debit: 300, partner_id: p1.id },
      { account_id: revAcc.id, credit: 300, partner_id: p1.id },
    ],
  }).db;

  const cfGroup = create(db, 'account.report.horizontal.group', {
    name: 'Cash Flow Branch Group',
    company_id: 1,
    report_ids: [],
    rule_ids: [{ field: 'partner', partner_ids: [p1.id] }],
  });
  db = cfGroup.db;

  await React.act(async () => store.commit(db));

  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'cashflow', title: 'Cash Flow Statement' } })));

    const groupSelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === 'Horizontal Group');
    assert.ok(groupSelect, 'Horizontal Group dropdown must be rendered for Cash Flow when matching group exists');

    await React.act(async () => {
      props(groupSelect).onChange({ target: { value: String(cfGroup.id) } });
    });

    assert.ok(host.textContent.includes('Alpha Client'), 'Rendered table contains Alpha Client bucket header');
    assert.ok(host.textContent.includes('Others'), 'Rendered table contains Others bucket header');
    assert.ok(host.textContent.includes('$300.00'), 'Rendered table contains partitioned amount');
  } finally {
    await React.act(async () => root.unmount());
  }
});

// ---------------------------------------------------------------------------
// FIN-11: Balance Sheet CYE and PYE fold/unfold into contributing P&L accounts
// ---------------------------------------------------------------------------

test('FIN-11: CYE and PYE unfold into contributing P&L accounts and sum to line total, excluding closed accounts', () => {
  let db = seed();
  db = { ...db, records: { ...db.records, 'account.move': [], 'account.payment': [] } };
  const yr = Number(today().slice(0, 4));
  const cashAcc = search(db, 'account.account').find((a) => a.code === '101401');
  const revAcc = search(db, 'account.account').find((a) => a.code === '400000');
  const expAcc = search(db, 'account.account').find((a) => a.code === '600000');
  const retAcc = search(db, 'account.account').find((a) => a.account_type === 'equity');

  // Prior year 1 (yr - 2): Revenue 300, closed to equity
  db = postEntry(db, {
    journal: 'MISC', company: 1, date: `${yr - 2}-04-01`,
    lines: [
      { account_id: cashAcc.id, debit: 300 },
      { account_id: revAcc.id, credit: 300 },
    ],
  }).db;
  // Closing entry closing revAcc to retAcc for yr - 2
  db = postEntry(db, {
    journal: 'MISC', company: 1, date: `${yr - 2}-12-31`, is_closing: true,
    lines: [
      { account_id: revAcc.id, debit: 300, is_closing: true },
      { account_id: retAcc.id, credit: 300, is_closing: true },
    ],
  }).db;

  // Prior year 2 (yr - 1): Revenue 700, Expense 200 -> NOT closed to equity (Prior year unallocated earnings = 500)
  db = postEntry(db, {
    journal: 'MISC', company: 1, date: `${yr - 1}-06-15`,
    lines: [
      { account_id: cashAcc.id, debit: 500 },
      { account_id: expAcc.id, debit: 200 },
      { account_id: revAcc.id, credit: 700 },
    ],
  }).db;

  // Current year (yr): Revenue 1200, Expense 450 -> Current year net = 750
  db = postEntry(db, {
    journal: 'MISC', company: 1, date: `${yr}-03-10`,
    lines: [
      { account_id: cashAcc.id, debit: 750 },
      { account_id: expAcc.id, debit: 450 },
      { account_id: revAcc.id, credit: 1200 },
    ],
  }).db;

  const bsRep = findStatementReport(db, 'balance', 1);
  const out = configurableReport(db, bsRep, { from: `${yr}-01-01`, to: `${yr}-12-31` });

  const cyeRow = out.rows.find((r) => r.code === 'CYE');
  const pyeRow = out.rows.find((r) => r.code === 'PYE');

  assert.ok(cyeRow, 'CYE row exists');
  assert.ok(pyeRow, 'PYE row exists');

  // CYE values and unfolded account rows
  assert.equal(cyeRow.values[0], 750, 'CYE balance is 750');
  assert.equal(isExpandableLine(cyeRow), true, 'CYE is expandable');
  assert.equal(cyeRow.accountRows.length, 2, 'CYE unfolds to revenue and expense accounts');
  const cyeSum = cyeRow.accountRows.reduce((s, r) => s + r.values[0], 0);
  assert.equal(cyeSum, cyeRow.values[0], 'CYE accountRows sum equals CYE line total');
  assert.equal(cyeRow.accountRows.find((r) => r.account.id === revAcc.id)?.values[0], 1200);
  assert.equal(cyeRow.accountRows.find((r) => r.account.id === expAcc.id)?.values[0], -450);

  // PYE values and unfolded account rows: yr-2 revenue was closed, so only yr-1 unclosed remains (500)
  assert.equal(pyeRow.values[0], 500, 'PYE balance is 500');
  assert.equal(isExpandableLine(pyeRow), true, 'PYE is expandable');
  assert.equal(pyeRow.accountRows.length, 2, 'PYE unfolds to unclosed prior-year accounts');
  const pyeSum = pyeRow.accountRows.reduce((s, r) => s + r.values[0], 0);
  assert.equal(pyeSum, pyeRow.values[0], 'PYE accountRows sum equals PYE line total');
  assert.equal(pyeRow.accountRows.find((r) => r.account.id === revAcc.id)?.values[0], 700);
  assert.equal(pyeRow.accountRows.find((r) => r.account.id === expAcc.id)?.values[0], -200);

  // Verify drill-down href
  assert.equal(accountJournalItemsHref(revAcc.id), `#/accounting/journal-items?account=${revAcc.id}`);
});

// ---------------------------------------------------------------------------
// FIN-13: Custom account.report keeps user's analytic account filter in comparison
// ---------------------------------------------------------------------------

test('FIN-13: ConfigurableReportPage passes analyticAccountIds to compareConfigurableReport for custom account.report', async () => {
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting/reports/custom' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const store = await import('./store.js');
  await store.initStore();

  let db = seed();
  db = { ...db, records: { ...db.records, 'account.move': [], 'account.payment': [] } };
  const yr = Number(today().slice(0, 4));

  const a1 = create(db, 'account.analytic.account', { name: 'Alpha Analytics', company_id: 1 }); db = a1.db;
  const a2 = create(db, 'account.analytic.account', { name: 'Beta Analytics', company_id: 1 }); db = a2.db;

  const cashAcc = search(db, 'account.account').find((a) => a.code === '101401');
  const revAcc = search(db, 'account.account').find((a) => a.code === '400000');

  // Move 1: Revenue 1000 with 60% Alpha ($600) and 40% Beta ($400)
  db = postEntry(db, {
    journal: 'MISC', company: 1, date: `${yr}-03-15`,
    lines: [
      { account_id: cashAcc.id, debit: 1000 },
      {
        account_id: revAcc.id, credit: 1000,
        analytic_distribution: { [a1.id]: 60, [a2.id]: 40 },
      },
    ],
  }).db;

  // Custom report with revenue line (no statementKind)
  const customReport = create(db, 'account.report', {
    name: 'Custom Revenue Report',
    company_id: 1,
    date_scope: 'range',
    line_ids: [
      { name: 'Revenue', code: 'REV', sequence: 10, parent_code: '', formula: '400000', sign: -1, foldable: false, strong: true },
    ],
  });
  db = customReport.db;

  await React.act(async () => store.commit(db));

  const { ConfigurableReportPage } = await import('./views/ConfigurableReport.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    await React.act(async () => root.render(React.createElement(ConfigurableReportPage, { id: customReport.id })));

    // Initially unfiltered: $1,000.00
    assert.ok(host.textContent.includes('$1,000.00'), 'Initial unfiltered total is $1,000.00');

    // Select Analytic Accounts filter: a1 (60% -> $600.00)
    const analyticSelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === 'Analytic Accounts');
    assert.ok(analyticSelect, 'Analytic Accounts multi-select must be rendered on custom report');

    await React.act(async () => {
      props(analyticSelect).onChange({ target: { selectedOptions: [{ value: String(a1.id) }] } });
    });

    assert.ok(host.textContent.includes('$600.00'), 'Filtered total is $600.00');
    assert.ok(!host.textContent.includes('$1,000.00'), 'Unfiltered $1,000.00 no longer appears');

    // Enable comparison: 'previous'
    const compSelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === 'Comparison');
    assert.ok(compSelect, 'Comparison select must be rendered on custom report');

    await React.act(async () => {
      props(compSelect).onChange({ target: { value: 'previous' } });
    });

    // In comparison mode, the current period column must STILL be filtered to $600.00, NOT $1,000.00!
    assert.ok(host.textContent.includes('$600.00'), 'Comparison mode keeps analytic account filter at $600.00');
    assert.ok(!host.textContent.includes('$1,000.00'), 'Comparison mode must not revert to unfiltered $1,000.00');
  } finally {
    await React.act(async () => root.unmount());
  }
});
