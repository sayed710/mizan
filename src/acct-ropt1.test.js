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
  assert.equal(data.rows.find((line) => line.code === 'EXP').green_on_positive, false);
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
import { createCompany } from './models/company.js';
import { updateSettings, write } from './orm.js';
import { reportPeriodRange } from './views/reportNavigation.js';
import { periodsFor } from './views/reportCompare.js';
import { today } from './models/common.js';

test('custom report uses its company fiscal presets and comparison windows', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { ConfigurableReportPage } = await import('./views/ConfigurableReport.jsx');
  await initStore();
  let db = seed();
  const co = createCompany(db, { name: 'Fiscal company', fiscalyear_last_day: 31, fiscalyear_last_month: 3 });
  db = updateSettings(co.db, { current_company_id: 1, allowed_company_ids: [1, co.id] });
  const report = { id: 99999, name: 'Custom fiscal', company_id: co.id, active: true, filter_date_range: true, filter_period_comparison: true, line_ids: [] };
  db = { ...db, records: { ...db.records, 'account.report': [...db.records['account.report'], report] } };
  const host = makeEl('div'); host.ownerDocument = document;
  const root = createRoot(host);
  const props = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];
  try {
    await React.act(async () => { commit(db); root.render(React.createElement(ConfigurableReportPage, { id: report.id })); });
    const period = () => find(host, (n) => n.tagName === 'SELECT' && ['year', 'quarter'].includes(props(n).value));
    const comparison = () => find(host, (n) => n.tagName === 'SELECT' && ['none', 'previous', 'lastYear', 'last3'].includes(props(n).value) && n.textContent.includes('Previous Period'));
    for (const key of ['year', 'quarter']) {
      await React.act(async () => props(period()).onChange({ target: { value: key } }));
      const range = reportPeriodRange(db, key, { companyId: co.id });
      assert.equal(props(find(host, (n) => n.tagName === 'INPUT' && props(n)['aria-label'] === 'From')).value, range.from);
      for (const mode of ['previous', 'lastYear', 'last3']) {
        await React.act(async () => props(comparison()).onChange({ target: { value: mode } }));
        const windows = periodsFor(key, mode, today(), { db, companyId: co.id });
        for (const window of windows) assert.ok(host.textContent.includes(window.label));
      }
    }
  } finally { await React.act(async () => root.unmount()); }
});

test('company switch resets disabled statement filters', async () => {
  const { makeEl } = setupDom();
  const React = await import('react'); const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js'); const { ConfigurableReportPage } = await import('./views/ConfigurableReport.jsx');
  await initStore(); let db = seed(); const co = createCompany(db, { name: 'Other' });
  db = updateSettings(co.db, { current_company_id: 1, allowed_company_ids: [1, co.id] });
  db = { ...db, records: { ...db.records, 'account.report': db.records['account.report'].map((r) => r.kind !== 'pnl' ? r : r.company_id === co.id ? { ...r, filter_hide_0_lines: 'never', filter_hierarchy: 'never', filter_period_comparison: false, filter_line_comparison: false } : { ...r, filter_hide_0_lines: 'by_default', filter_hierarchy: 'by_default' }) } };
  const host = makeEl('div'); host.ownerDocument = document; const root = createRoot(host);
  const props = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];
  try {
    await React.act(async () => { commit(db); root.render(React.createElement(ConfigurableReportPage, { statementKind: 'pnl' })); });
    const comparison = find(host, (n) => n.tagName === 'SELECT' && props(n).value === 'none' && n.textContent.includes('Previous Period'));
    await React.act(async () => props(comparison).onChange({ target: { value: 'previous' } }));
    await React.act(async () => props(find(host, (n) => n.tagName === 'SELECT' && props(n)['aria-label'] === 'Company')).onChange({ target: { value: String(co.id) } }));
    assert.equal(find(host, (n) => n.tagName === 'LABEL' && n.textContent.includes('Hide lines at 0')), null);
    assert.ok(host.textContent.includes('Revenue'));
    assert.ok(!host.textContent.includes('Variance'));
  } finally { await React.act(async () => root.unmount()); }
});

test('seeded statement growth directions match their financial roles', () => {
  const db = seed();
  const unfavorable = { pnl: ['COR', 'EXP_GRP', 'EXP', 'DEP', 'EXO'], balance: ['LIAB', 'CUR_LIAB', 'CL', 'PAY', 'CC', 'NCL', 'LIAB_EQUITY'] };
  for (const report of db.records['account.report'].filter((r) => r.kind === 'pnl' || r.kind === 'balance')) {
    const spec = STATEMENT_REPORT_SPECS.find((item) => item.kind === report.kind);
    for (const item of spec.line_ids) {
      const line = db.records['account.report.line'].find((l) => l.report_id === report.id && l.inline_code === item.code);
      const expr = db.records['account.report.expression'].find((e) => e.report_line_id === line.id && e.label === 'balance');
      assert.equal(expr.green_on_positive, !unfavorable[report.kind].includes(item.code), item.code);
    }
  }
  const pnl = db.records['account.report'].find((r) => r.kind === 'pnl');
  const expense = db.records['account.report.line'].find((l) => l.report_id === pnl.id && l.inline_code === 'EXP');
  assert.equal(db.records['account.report.expression'].find((e) => e.report_line_id === expense.id).green_on_positive, false);
});


test('upgrade restores seeded growth directions without changing user report lines', () => {
  const seeded = seed();
  const pnl = seeded.records['account.report'].find((r) => r.kind === 'pnl');
  const customReport = { id: 999901, name: 'Custom', company_id: 1, kind: '' };
  const customLine = { id: 999902, report_id: customReport.id, code: 'EXP', inline_code: 'EXP', company_id: 1 };
  const extraLine = { id: 999903, report_id: pnl.id, code: 'CUSTOM', company_id: 1 };
  const expense = seeded.records['account.report.line'].find((line) => line.report_id === pnl.id && line.inline_code === 'EXP');
  const revenue = seeded.records['account.report.line'].find((line) => line.report_id === pnl.id && line.inline_code === 'REV');
  const preservedIds = new Set([expense.id, revenue.id]);
  const customExpressions = [
    { id: 999904, report_line_id: customLine.id, label: 'balance', green_on_positive: true },
    { id: 999905, report_line_id: extraLine.id, label: 'balance', green_on_positive: true },
  ];
  const old = { ...seeded, schema_version: 83, records: { ...seeded.records,
    'account.report': [...seeded.records['account.report'], customReport],
    'account.report.line': [...seeded.records['account.report.line'], customLine, extraLine],
    'account.report.expression': [...seeded.records['account.report.expression'].map((e) => ({ ...e, green_on_positive: !preservedIds.has(e.report_line_id) })), ...customExpressions],
  } };
  const upgraded = migrate(old);
  const unfavorable = { pnl: ['COR', 'EXP_GRP', 'EXP', 'DEP', 'EXO'], balance: ['LIAB', 'CUR_LIAB', 'CL', 'PAY', 'CC', 'NCL', 'LIAB_EQUITY'] };
  for (const report of seeded.records['account.report'].filter((r) => unfavorable[r.kind])) {
    for (const line of seeded.records['account.report.line'].filter((l) => l.report_id === report.id)) {
      const expression = upgraded.records['account.report.expression'].find((e) => e.report_line_id === line.id && e.label === 'balance');
      assert.equal(expression.green_on_positive, !preservedIds.has(line.id) && !unfavorable[report.kind].includes(line.inline_code), line.inline_code);
    }
  }
  for (const original of customExpressions) assert.deepEqual(upgraded.records['account.report.expression'].find((e) => e.id === original.id), original);
  assert.equal(upgraded.schema_version, 84);
  assert.equal(migrate(upgraded), upgraded);
});


test('inline direction edits synchronize stored expressions with or without formula changes', () => {
  let db = seed();
  const report = db.records['account.report'].find((item) => item.kind === 'pnl');
  const storedLine = db.records['account.report.line'].find((item) => item.report_id === report.id && item.inline_code === 'EXP');
  const expression = () => db.records['account.report.expression'].find((item) => item.report_line_id === storedLine.id && item.label === 'balance');
  assert.equal(expression().green_on_positive, false);
  const lines = report.line_ids.map((line) => line.code === 'EXP' ? { ...line, green_on_positive: true } : line);
  db = write(db, 'account.report', report.id, { line_ids: lines });
  assert.equal(expression().green_on_positive, true);
  const edited = lines.map((line) => line.code === 'EXP' ? { ...line, green_on_positive: false, formula: 'type:expense_depreciation' } : line);
  db = write(db, 'account.report', report.id, { line_ids: edited });
  assert.equal(expression().green_on_positive, false);
  assert.ok(expression().formula.includes('expense_depreciation'));
});
