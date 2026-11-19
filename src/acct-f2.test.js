import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { postEntry } from './models/ledger.js';
import { postMove } from './models/accounting.js';
import { today } from './models/common.js';
import {
  accountJournalItemsHref,
  configurableReport,
  findStatementReport,
  isExpandableLine,
  STANDARD_BALANCE_LINES,
} from './models/configurableReports.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const props = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];
const findAll = (node, predicate, out = []) => {
  if (!node) return out;
  if (predicate(node)) out.push(node);
  for (const child of node.childNodes ?? []) findAll(child, predicate, out);
  return out;
};

test('FIN-11: Balance Sheet CYE and PYE are foldable and unfold into contributing P&L accounts whose values sum to line total', () => {
  let db = seed();
  db = { ...db, records: { ...db.records, 'account.move': [], 'account.payment': [] } };
  const yr = Number(today().slice(0, 4));
  const cashAcc = search(db, 'account.account').find((a) => a.code === '101401');
  const revAcc = search(db, 'account.account').find((a) => a.code === '400000');
  const expAcc = search(db, 'account.account').find((a) => a.code === '600000');

  // Prior year entry: Revenue 500, Expense 150 -> Prior year net = 350
  db = postEntry(db, {
    journal: 'MISC',
    company: 1,
    date: `${yr - 1}-06-15`,
    lines: [
      { account_id: cashAcc.id, debit: 350 },
      { account_id: expAcc.id, debit: 150 },
      { account_id: revAcc.id, credit: 500 },
    ],
  }).db;

  // Current year entry: Revenue 1000, Expense 400 -> Current year net = 600
  db = postEntry(db, {
    journal: 'MISC',
    company: 1,
    date: `${yr}-03-10`,
    lines: [
      { account_id: cashAcc.id, debit: 600 },
      { account_id: expAcc.id, debit: 400 },
      { account_id: revAcc.id, credit: 1000 },
    ],
  }).db;

  const cyeSpec = STANDARD_BALANCE_LINES.find((l) => l.code === 'CYE');
  const pyeSpec = STANDARD_BALANCE_LINES.find((l) => l.code === 'PYE');
  assert.equal(cyeSpec.foldable, true, 'CYE must be foldable in STANDARD_BALANCE_LINES');
  assert.equal(pyeSpec.foldable, true, 'PYE must be foldable in STANDARD_BALANCE_LINES');

  const bsRep = findStatementReport(db, 'balance', 1);
  const out = configurableReport(db, bsRep, { from: `${yr}-01-01`, to: `${yr}-12-31` });

  const cyeRow = out.rows.find((r) => r.code === 'CYE');
  const pyeRow = out.rows.find((r) => r.code === 'PYE');
  const unallocRow = out.rows.find((r) => r.code === 'UNALLOC');

  assert.equal(cyeRow.values[0], 600);
  assert.equal(isExpandableLine(cyeRow), true, 'CYE row must be expandable');
  assert.equal(cyeRow.accountRows.length, 2, 'CYE unfolds to 2 contributing P&L accounts');
  assert.equal(
    cyeRow.accountRows.reduce((s, r) => s + r.values[0], 0),
    cyeRow.values[0],
    'CYE accountRows sum to CYE line value',
  );
  assert.equal(cyeRow.accountRows.find((r) => r.account.id === revAcc.id)?.values[0], 1000);
  assert.equal(cyeRow.accountRows.find((r) => r.account.id === expAcc.id)?.values[0], -400);

  assert.equal(pyeRow.values[0], 350);
  assert.equal(isExpandableLine(pyeRow), true, 'PYE row must be expandable');
  assert.equal(pyeRow.accountRows.length, 2, 'PYE unfolds to 2 contributing prior-year P&L accounts');
  assert.equal(
    pyeRow.accountRows.reduce((s, r) => s + r.values[0], 0),
    pyeRow.values[0],
    'PYE accountRows sum to PYE line value',
  );

  // Also verify parent aggregation line if marked foldable includes earnings account contributions
  const foldableUnallocRep = write(db, 'account.report', bsRep.id, {
    line_ids: bsRep.line_ids.map((l) => (['UNALLOC', 'CUR_UNALLOC'].includes(l.code) ? { ...l, foldable: true } : l)),
  });
  const outFoldableUnalloc = configurableReport(foldableUnallocRep, read(foldableUnallocRep, 'account.report', bsRep.id), { from: `${yr}-01-01`, to: `${yr}-12-31` });
  const unallocExpanded = outFoldableUnalloc.rows.find((r) => r.code === 'UNALLOC');
  assert.equal(unallocExpanded.values[0], unallocRow.values[0]);
  assert.equal(
    unallocExpanded.accountRows.reduce((s, r) => s + r.values[0], 0),
    unallocExpanded.values[0],
    'Foldable UNALLOC parent sums current and prior year earnings account contributions',
  );
});

test('FIN-4: Account rows in ConfigurableReportPage link to Journal Items route filtered by account', async () => {
  assert.equal(accountJournalItemsHref(42), '#/accounting/journal-items?account=42');

  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting/reports/balance' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();

  const db = seed();
  await React.act(async () => commit(db));

  const { ConfigurableReportPage } = await import('./views/ConfigurableReport.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    await React.act(async () => root.render(React.createElement(ConfigurableReportPage, { statementKind: 'balance', title: 'Balance Sheet' })));

    // Find and expand the first expandable row
    const expandableRow = find(host, (n) => n.tagName === 'TR' && props(n)?.['aria-expanded'] === false);
    assert.ok(expandableRow, 'Must have at least one expandable section');
    await React.act(async () => props(expandableRow).onClick());

    // Verify account row links to Journal Items
    const jiLinks = findAll(host, (n) => n.tagName === 'A' && String(props(n)?.href ?? '').startsWith('#/accounting/journal-items'));
    assert.ok(jiLinks.length > 0, 'Account detail rows must contain Journal Items links');
    for (const link of jiLinks) {
      const href = props(link).href;
      assert.match(href, /^#\/accounting\/journal-items\?account=\d+$/, `Account link must drill down to Journal Items, got: ${href}`);
    }

    // Verify clicking the account row navigates to Journal Items
    const detailRow = find(host, (n) => n.tagName === 'TR' && props(n)?.className === 'rep-detail');
    assert.ok(detailRow, 'Must render at least one detail row');
    await React.act(async () => props(detailRow).onClick());
    assert.match(globalThis.location.hash, /^#\/accounting\/journal-items\?account=\d+$/, 'Clicking account row navigates to Journal Items');
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('FIN-6: ConfigurableReportPage renders Unfold All / Collapse All controls and toggles all expandable lines', async () => {
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting/reports/pnl' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();

  const db = seed();
  await React.act(async () => commit(db));

  const { ConfigurableReportPage } = await import('./views/ConfigurableReport.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    await React.act(async () => root.render(React.createElement(ConfigurableReportPage, { statementKind: 'balance', title: 'Balance Sheet' })));

    // Initially collapsed: no account detail rows
    const detailRowsBefore = findAll(host, (n) => n.tagName === 'TR' && props(n)?.className === 'rep-detail');
    assert.equal(detailRowsBefore.length, 0, 'No detail rows rendered before unfolding');

    // Find Unfold All button
    const unfoldBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent === 'Unfold All');
    assert.ok(unfoldBtn, 'Unfold All button must be rendered in control panel');
    assert.equal(props(unfoldBtn)['aria-pressed'], false);

    // Click Unfold All
    await React.act(async () => props(unfoldBtn).onClick());

    // Button should now say Collapse All with aria-pressed=true
    const collapseBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent === 'Collapse All');
    assert.ok(collapseBtn, 'Button label switches to Collapse All when all expandable lines are open');
    assert.equal(props(collapseBtn)['aria-pressed'], true);

    // Detail rows are now visible
    const detailRowsAfter = findAll(host, (n) => n.tagName === 'TR' && props(n)?.className === 'rep-detail');
    assert.ok(detailRowsAfter.length > 0, 'Account detail rows must appear after clicking Unfold All');

    // Click Collapse All
    await React.act(async () => props(collapseBtn).onClick());
    const detailRowsCollapsed = findAll(host, (n) => n.tagName === 'TR' && props(n)?.className === 'rep-detail');
    assert.equal(detailRowsCollapsed.length, 0, 'All detail rows collapse after clicking Collapse All');
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('FIN-13: Custom account.report renders Analytic Accounts filter and filters report figures by selected analytic accounts', async () => {
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting/configurable-report-view/1' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();

  let db = seed();
  const a1 = create(db, 'account.analytic.account', { name: 'Custom Analytic Alpha', company_id: 1 });
  db = a1.db;
  const a2 = create(db, 'account.analytic.account', { name: 'Custom Analytic Beta', company_id: 1 });
  db = a2.db;

  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    company_id: 1,
    invoice_date: today(),
    invoice_line_ids: [
      { name: 'Alpha Line', account_id: search(db, 'account.account').find((a) => a.code === '410000').id, qty: 1, price_unit: 250, tax_ids: [], tax: 0, analytic_distribution: { [a1.id]: 100 } },
      { name: 'Beta Line', account_id: search(db, 'account.account').find((a) => a.code === '410000').id, qty: 1, price_unit: 750, tax_ids: [], tax: 0, analytic_distribution: { [a2.id]: 100 } },
    ],
  });
  db = postMove(inv.db, inv.id);

  const customReport = create(db, 'account.report', {
    name: 'Subscription Custom Report',
    company_id: 1,
    date_scope: 'range',
    line_ids: [
      { name: 'Subscription Revenue Line', code: 'SUB_REV', sequence: 10, parent_code: '', formula: '410000', sign: -1, foldable: true, strong: false },
    ],
  });
  db = customReport.db;

  await React.act(async () => commit(db));

  const { ConfigurableReportPage } = await import('./views/ConfigurableReport.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    await React.act(async () => root.render(React.createElement(ConfigurableReportPage, { id: customReport.id })));

    // Unfiltered total for 410000 is $1,000.00
    assert.ok(host.textContent.includes('$1,000.00'), `Expected unfiltered $1,000.00 in custom report, got: ${host.textContent}`);

    // Analytic Accounts multi-select must be rendered on custom account.report too
    const analyticSelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === 'Analytic Accounts');
    assert.ok(analyticSelect, 'Analytic Accounts selector must be rendered for custom account.report');

    // Select Custom Analytic Alpha (a1.id) -> should filter to $250.00
    await React.act(async () => {
      props(analyticSelect).onChange({ target: { selectedOptions: [{ value: String(a1.id) }] } });
    });

    assert.ok(host.textContent.includes('$250.00'), `Expected analytic-filtered $250.00 in custom report, got: ${host.textContent}`);
    assert.ok(!host.textContent.includes('$1,000.00'), 'Unfiltered $1,000.00 should no longer appear when analytic filter is active');
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('migration 57 makes earnings lines of already-seeded Balance Sheets foldable and leaves other lines alone', async () => {
  const { migrate } = await import('./migrations.js');
  const db = seed();
  const sheet = findStatementReport(db, 'balance', 1);
  assert.ok(sheet, 'seed has a Balance Sheet');
  // A Balance Sheet stored before this release: earnings lines were not foldable, and a user folded Retained Earnings shut.
  const legacyLines = sheet.line_ids.map((l) => (/^earnings:/.test(l.formula) || l.code === 'RET' ? { ...l, foldable: false } : l));
  const legacy = { ...db, schema_version: 56, records: { ...db.records,
    'account.report': db.records['account.report'].map((r) => (r.id === sheet.id ? { ...r, line_ids: legacyLines } : r)) } };
  const migrated = findStatementReport(migrate(legacy), 'balance', 1);
  const foldable = Object.fromEntries(migrated.line_ids.map((l) => [l.code, l.foldable]));
  assert.equal(foldable.CYE, true);
  assert.equal(foldable.PYE, true);
  assert.equal(foldable.RET, false);
});
