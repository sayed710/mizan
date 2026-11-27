import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATEMENT_REPORT_SPECS } from './models/statementReports.js';
import { migrate, SCHEMA_VERSION } from './migrations.js';
import { seed } from './seed.js';
import { postEntry } from './models/ledger.js';
import { compareConfigurableReport, reportAccountHierarchy } from './models/configurableReports.js';
import { toggleAllReportFolds } from './views/reportFold.js';
import { register } from 'node:module';
import { readFile } from 'node:fs/promises';
import { toCsv } from './csv.js';
import { buildXlsx, parseZip } from './xlsx.js';
import { setupDom, find } from './test-support/dom.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

test('standard statements expose their Odoo report option defaults', () => {
  const pnl = STATEMENT_REPORT_SPECS.find((report) => report.kind === 'pnl');
  const balance = STATEMENT_REPORT_SPECS.find((report) => report.kind === 'balance');
  assert.equal(pnl.default_opening_date_filter, 'this_year');
  assert.equal(pnl.filter_date_range, true);
  assert.equal(balance.default_opening_date_filter, 'today');
  assert.equal(balance.filter_date_range, false);
  for (const report of [pnl, balance]) {
    assert.equal(report.filter_hide_0_lines, 'optional');
    assert.equal(report.filter_hierarchy, 'optional');
    assert.equal(report.filter_period_comparison, true);
    assert.equal(report.filter_growth_comparison, true);
    assert.equal(report.filter_line_comparison, true);
    assert.equal(report.filter_unfold_all, true);
  }
});

test('account group subtotals include nested accounts and folds toggle together', () => {
  const db = { records: { 'account.group': [{ id: 1, name: 'Parent' }, { id: 2, name: 'Child', parent_id: 1 }] } };
  const tree = reportAccountHierarchy(db, [
    { account: { id: 1, group_id: 1 }, values: [12, 20] },
    { account: { id: 2, group_id: 2 }, values: [8, 10] },
  ]);
  assert.deepEqual(tree[0].values, [20, 30]);
  assert.deepEqual(tree[0].children.find((node) => node.group).values, [8, 10]);
  const keys = ['line', 'line:group:1', 'line:group:2'];
  assert.deepEqual([...toggleAllReportFolds(new Set(), keys)], keys);
  assert.equal(toggleAllReportFolds(new Set(keys), keys).size, 0);
});

test('ledger growth uses unrounded period amounts and leaves zero baseline blank', () => {
  let db = seed();
  db = postEntry(db, { journal: 'MISC', company: 1, date: '2020-02-01', lines: [{ account: '600000', debit: 100 }, { account: '301000', credit: 100 }] }).db;
  db = postEntry(db, { journal: 'MISC', company: 1, date: '2021-02-01', lines: [{ account: '600000', debit: 150 }, { account: '301000', credit: 150 }] }).db;
  const report = db.records['account.report'].find((item) => item.kind === 'pnl');
  const periods = [{ from: '2020-01-01', to: '2020-12-31', label: '2020' }, { from: '2021-01-01', to: '2021-12-31', label: '2021' }];
  const data = compareConfigurableReport(db, report, periods);
  assert.equal(data.rows.find((line) => line.code === 'EXP').variance.pct, 50);
  const zero = compareConfigurableReport(db, report, [{ from: '2019-01-01', to: '2019-12-31', label: '2019' }, periods[1]]);
  assert.equal(zero.rows.find((line) => line.code === 'EXP').variance.pct, null);
  const shown = compareConfigurableReport(db, report, [periods[0]], periods[0], null, { hideZeroLines: false });
  const hidden = compareConfigurableReport(db, report, [periods[0]], periods[0], null, { hideZeroLines: true });
  assert.ok(hidden.rows.length < shown.rows.length);
  assert.ok(hidden.rows.some((line) => line.code === 'EXP'));
});

test('report option migration preserves existing settings', () => {
  const db = { schema_version: 82, records: { 'account.report': [{ id: 1, kind: 'balance', date_scope: 'cumulative', filter_hide_0_lines: 'never' }] } };
  const migrated = migrate(db);
  assert.equal(migrated.schema_version, SCHEMA_VERSION);
  assert.equal(migrated.records['account.report'][0].filter_hide_0_lines, 'never');
  assert.equal(migrated.records['account.report'][0].default_opening_date_filter, 'today');
});

test('rounding scales screen and export values without changing source totals', async () => {
  const { scaledReportAmount, configurableReportExportRows } = await import('./views/ConfigurableReport.jsx');
  const data = { headers: ['Balance'], unitLabel: 'kLE', showVariance: false, rows: [{ name: 'Expense', depth: 0, values: [1234567.89], accountRows: [] }] };
  assert.equal(scaledReportAmount(1234567.89, 'decimals'), 1234567.89);
  assert.equal(scaledReportAmount(1234567.89, 'units'), 1234568);
  assert.equal(scaledReportAmount(1234567.89, 'thousands'), 1235);
  assert.equal(scaledReportAmount(1234567.89, 'millions'), 1);
  assert.deepEqual(configurableReportExportRows(data, new Set(), 'thousands'), [['Report Lines', 'Balance (kLE)'], ['Expense', 1235]]);
  for (const [unit, symbol, expected] of [['decimals', '.LE', 1234567.89], ['units', 'LE', 1234568], ['thousands', 'kLE', 1235], ['millions', 'MLE', 1]]) {
    const rows = configurableReportExportRows({ ...data, unitLabel: symbol }, new Set(), unit);
    assert.equal(rows[1][1], expected);
    assert.match(toCsv(rows), new RegExp(`Balance \\(${symbol.replace('.', '\\.')}\\)`));
    const sheet = new TextDecoder().decode(parseZip(buildXlsx(rows)).files['xl/worksheets/sheet1.xml'].data);
    assert.ok(sheet.includes(`Balance (${symbol})`));
    assert.ok(sheet.includes(`<v>${expected}</v>`));
  }
  assert.equal(data.rows[0].values[0], 1234567.89);
});

test('report controls honour defaults, zero modes, folds and line comparison', async () => {
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting/reports/pnl' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { ConfigurableReportPage } = await import('./views/ConfigurableReport.jsx');
  await initStore();
  const initial = seed();
  const host = makeEl('div');
  host.ownerDocument = document;
  const root = createRoot(host);
  const props = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];
  const label = (name) => find(host, (node) => node.tagName === 'LABEL' && node.textContent.trimStart().startsWith(name));
  try {
    for (const [mode, checked] of [['by_default', true], ['optional', false], ['never', null]]) {
      const db = { ...initial, records: { ...initial.records, 'account.report': initial.records['account.report'].map((report) => report.kind === 'pnl' ? { ...report, filter_hide_0_lines: mode } : report) } };
      await React.act(async () => { commit(db); root.render(React.createElement(ConfigurableReportPage, { key: mode, statementKind: 'pnl' })); });
      assert.ok(find(host, (node) => node.tagName === 'SELECT' && props(node).value === 'year'));
      const zeroLabel = label('Hide lines at 0');
      if (checked == null) assert.equal(zeroLabel, null);
      else assert.equal(props(find(zeroLabel, (node) => node.tagName === 'INPUT')).checked, checked);
    }
    await React.act(async () => root.render(React.createElement(ConfigurableReportPage, { key: 'balance', statementKind: 'balance' })));
    assert.ok(find(host, (node) => node.tagName === 'SELECT' && props(node).value === 'today'));
    const periodSelect = find(host, (node) => node.tagName === 'SELECT' && props(node).value === 'today');
    await React.act(async () => props(periodSelect).onChange({ target: { value: 'custom' } }));
    assert.equal(find(host, (node) => node.tagName === 'INPUT' && props(node)['aria-label'] === 'From'), null);
    const unfold = find(host, (node) => node.tagName === 'BUTTON' && node.textContent === 'Unfold All');
    assert.ok(unfold);
    await React.act(async () => props(unfold).onClick());
    assert.ok(find(host, (node) => node.tagName === 'BUTTON' && node.textContent === 'Collapse All'));
    const comparison = find(host, (node) => node.tagName === 'SELECT' && props(node).value === 'none' && node.textContent.includes('Percentage of'));
    await React.act(async () => props(comparison).onChange({ target: { value: 'previous' } }));
    const growth = find(host, (node) => node.tagName === 'SELECT' && props(node)['aria-label'] === 'Comparison in');
    assert.equal(props(growth).value, 'percent');
    await React.act(async () => props(growth).onChange({ target: { value: 'amount' } }));
    assert.equal(props(growth).value, 'amount');
    assert.ok(host.textContent.includes('Amount'));
    await React.act(async () => props(comparison).onChange({ target: { value: 'report_line' } }));
    const base = find(host, (node) => node.tagName === 'SELECT' && props(node)['aria-label'] === 'Percentage of');
    await React.act(async () => props(base).onChange({ target: { value: 'ASSETS' } }));
    assert.ok(host.textContent.includes('100%'));
    assert.ok(!host.textContent.includes('First Line'));
    const currency = initial.records['res.currency'].find((item) => item.id === initial.records['res.company'][0].currency_id);
    const rounding = label('Rounding Unit');
    for (const symbol of [`.${currency.symbol}`, currency.symbol, `k${currency.symbol}`, `M${currency.symbol}`]) assert.ok(rounding.textContent.includes(symbol));
    const noUnfold = { ...initial, records: { ...initial.records, 'account.report': initial.records['account.report'].map((item) => item.kind === 'balance' ? { ...item, filter_unfold_all: false } : item) } };
    await React.act(async () => { commit(noUnfold); root.render(React.createElement(ConfigurableReportPage, { key: 'no-unfold', statementKind: 'balance' })); });
    assert.equal(find(host, (node) => node.tagName === 'BUTTON' && node.textContent === 'Unfold All'), null);
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('new report labels have Arabic translations', async () => {
  const source = await readFile(new URL('./i18n.js', import.meta.url), 'utf8');
  for (const label of ['Rounding Unit', 'Account Parents', 'Growth Comparison', 'Percentage of', 'Comparison in']) {
    assert.match(source, new RegExp(`'${label}': '[\\u0600-\\u06ff ]+'`));
  }
});

test('line percentages and growth export modes handle zero and account values', async () => {
  const { linePercentage, configurableReportExportRows } = await import('./views/ConfigurableReport.jsx');
  assert.equal(linePercentage(25, 100), 25);
  assert.equal(linePercentage(25, 0), null);
  const data = { headers: ['Balance'], lineComparison: true, baseValue: 100, showVariance: false, rows: [{ name: 'Line', code: 'LINE', foldable: true, values: [50], accountRows: [{ account: { id: 1, code: '1', name: 'Account' }, values: [25] }] }] };
  const percent = configurableReportExportRows(data, new Set(['LINE']));
  assert.equal(percent[1].at(-1), '50%');
  assert.equal(percent[2].at(-1), '25%');
  const zero = configurableReportExportRows({ ...data, baseValue: 0 }, new Set(['LINE']));
  assert.equal(zero[1].at(-1), '');
  assert.equal(zero[2].at(-1), '');
  const growth = { ...data, lineComparison: false, showVariance: true, showGrowth: true, rows: [{ ...data.rows[0], variance: { amount: 50, pct: 100 } }] };
  assert.equal(configurableReportExportRows({ ...growth, growthDisplay: 'percent' })[1].at(-1), '100%');
  assert.equal(configurableReportExportRows({ ...growth, growthDisplay: 'amount' })[1].at(-1), 50);
});
