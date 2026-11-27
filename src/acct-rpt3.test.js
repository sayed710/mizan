import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { expressionPeriod, validateReportExpressions, evaluateStoredReport } from './models/reportEngine.js';

test('stored expression periods use fiscal and period boundaries', () => {
  const db = seed();
  const period = { from: '2026-04-01', to: '2026-06-30' };
  assert.deepEqual(expressionPeriod(db, 'from_beginning', period, 1), { from: '', to: period.to });
  assert.deepEqual(expressionPeriod(db, 'to_beginning_of_period', period, 1), { from: '', to: '2026-03-31' });
  assert.deepEqual(expressionPeriod(db, 'strict_range', period, 1), period);
  assert.throws(() => expressionPeriod(db, 'previous_return_period', period, 1), /Previous return period/);
});

test('stored aggregation rejects unknown and cyclic references', () => {
  const lines = [{ id: 1, code: 'A' }, { id: 2, code: 'B' }];
  const expression = (id, report_line_id, formula) => ({ id, report_line_id, label: 'balance', engine: 'aggregation', date_scope: 'strict_range', formula });
  assert.match(validateReportExpressions(lines, [expression(1, 1, 'B.balance')]), /Unknown/);
  assert.match(validateReportExpressions(lines, [expression(1, 1, 'B.balance'), expression(2, 2, 'A.balance')]), /cycle/);
  assert.match(validateReportExpressions(lines, [{ ...expression(1, 1, 'A.balance'), engine: 'unknown' }]), /Unknown report engine/);
});

test('stored domain and account code expressions use ledger balances and aggregate across lines', () => {
  const db = seed();
  const report = { id: 991, company_id: 1 };
  const lines = [{ id: 1, report_id: report.id, code: 'A' }, { id: 2, report_id: report.id, code: 'B' }, { id: 3, report_id: report.id, code: 'C' }];
  const expressions = [
    { id: 1, report_line_id: 1, label: 'balance', engine: 'domain', formula: '[["account_type","=","income"]]', subformula: 'sum', date_scope: 'from_beginning' },
    { id: 2, report_line_id: 2, label: 'balance', engine: 'account_codes', formula: '4', date_scope: 'from_beginning' },
    { id: 3, report_line_id: 3, label: 'balance', engine: 'aggregation', formula: 'A.balance + B.balance', date_scope: 'from_beginning' },
  ];
  const staged = { ...db, records: { ...db.records, 'account.report.line': lines, 'account.report.expression': expressions } };
  const result = evaluateStoredReport(staged, report, { to: '2099-12-31' });
  assert.equal(result[2].expressions.balance, result[0].expressions.balance + result[1].expressions.balance);
});import { create } from './orm.js';
import { applyDiff, diffDb } from './sync.js';

test('server diff rejects unknown engines and cyclic aggregation', () => {
  let db = seed();
  const report = db.records['account.report'].find((item) => item.kind === 'pnl');
  const a = create(db, 'account.report.line', { report_id: report.id, name: 'A', code: 'A' }); db = a.db;
  const b = create(db, 'account.report.line', { report_id: report.id, name: 'B', code: 'B' }); db = b.db;
  const base = { label: 'balance', date_scope: 'strict_range', engine: 'domain', formula: '[]', subformula: 'sum' };
  const x = create(db, 'account.report.expression', { ...base, report_line_id: a.id }); db = x.db;
  const y = create(db, 'account.report.expression', { ...base, report_line_id: b.id }); db = y.db;
  const modify = (fn) => ({ ...db, records: { ...db.records, 'account.report.expression': db.records['account.report.expression'].map(fn) } });
  const badEngine = modify((expr) => expr.id === x.id ? { ...expr, engine: 'unknown' } : expr);
  assert.throws(() => applyDiff(db, diffDb(db, badEngine), { isAdmin: true }), /Invalid value for account.report.expression.engine/);
  const cycle = modify((expr) => [x.id, y.id].includes(expr.id) ? { ...expr, engine: 'aggregation', formula: expr.id === x.id ? 'B.balance' : 'A.balance' } : expr);
  assert.throws(() => applyDiff(db, diffDb(db, cycle), { isAdmin: true }), /cycle/);
});
import { postEntry } from './models/ledger.js';
import { write } from './orm.js';

test('stored expressions react to edits and hide a zero subtree', () => {
  let db = seed();
  db = postEntry(db, { journal: 'MISC', company: 1, date: '2026-02-01', lines: [{ account: '600000', debit: 100 }, { account: '301000', credit: 100 }] }).db;
  const report = db.records['account.report'].find((item) => item.kind === 'pnl');
  const line = create(db, 'account.report.line', { report_id: report.id, name: 'Selected expense', code: 'CHANGED', hide_if_zero: true }); db = line.db;
  const exp = create(db, 'account.report.expression', { report_line_id: line.id, label: 'balance', engine: 'domain', formula: '[["account_type","=","expense"]]', subformula: 'sum', date_scope: 'strict_range' }); db = exp.db;
  const run = (state, from, to) => evaluateStoredReport(state, report, { from, to }).find((row) => row.id === line.id);
  const before = run(db, '2026-02-01', '2026-02-01');
  assert.ok(before.expressions.balance >= 100);
  const changed = write(db, 'account.report.expression', exp.id, { subformula: '-sum' });
  assert.equal(run(changed, '2026-02-01', '2026-02-01').expressions.balance, -before.expressions.balance);
  assert.equal(run(db, '1900-01-01', '1900-01-01'), undefined);
});
import { configurableReport, configurableReportLegacy } from './models/configurableReports.js';
import { migrate } from './migrations.js';

test('migration seeds stored statement expressions idempotently and preserves seed totals', () => {
  const seeded = seed();
  const withoutStored = { ...seeded, schema_version: 80, records: { ...seeded.records, 'account.report.line': [], 'account.report.expression': [] } };
  const migrated = migrate(withoutStored);
  assert.equal(migrated.schema_version, 81);
  assert.equal(migrate(migrated), migrated);
  for (const kind of ['pnl', 'balance']) {
    const report = migrated.records['account.report'].find((item) => item.kind === kind && item.company_id === 1);
    const period = { from: '2026-01-01', to: '2026-12-31' };
    const oldRows = configurableReport(migrated, report, period).rows;
    const stored = evaluateStoredReport(migrated, report, period);
    for (const code of kind === 'pnl' ? ['GROSS', 'NET'] : ['ASSETS', 'LIAB', 'EQUITY', 'LIAB_EQUITY']) {
      assert.equal(stored.find((line) => line.code === code).expressions.balance, oldRows.find((line) => line.code === code).values[0], `${kind} ${code}`);
    }
  }
});

test('production report reflects a stored expression edit applied through diff and hides zero lines', () => {
  let db = seed();
  db = postEntry(db, { journal: 'MISC', company: 1, date: '2026-03-01', lines: [{ account: '400000', credit: 123 }, { account: '101401', debit: 123 }] }).db;
  const report = db.records['account.report'].find((item) => item.kind === 'pnl' && item.company_id === 1);
  const line = db.records['account.report.line'].find((item) => item.report_id === report.id && item.code === 'OPINC');
  const expr = db.records['account.report.expression'].find((item) => item.report_line_id === line.id && item.label === 'balance');
  const period = { from: '2026-03-01', to: '2026-03-01' };
  const before = configurableReport(db, report, period).rows.find((item) => item.id === line.id).values[0];
  const edited = write(db, 'account.report.expression', expr.id, { subformula: 'sum' });
  const saved = applyDiff(db, diffDb(db, edited), { isAdmin: true });
  assert.equal(configurableReport(saved, report, period).rows.find((item) => item.id === line.id).values[0], -before);
  const hiddenEdit = write(saved, 'account.report.line', line.id, { hide_if_zero: true });
  const hidden = applyDiff(saved, diffDb(saved, hiddenEdit), { isAdmin: true });
  assert.equal(configurableReport(hidden, report, { from: '1900-01-01', to: '1900-01-01' }).rows.some((item) => item.id === line.id), false);
});

test('production stored report matches every legacy balance on seed data', () => {
  const db = seed();
  for (const kind of ['pnl', 'balance']) {
    const report = db.records['account.report'].find((item) => item.kind === kind && item.company_id === 1);
    const period = { from: '2026-01-01', to: '2026-12-31' };
    const actual = configurableReport(db, report, period).rows;
    const expected = configurableReportLegacy(db, report, period).rows;
    assert.deepEqual(actual.map((row) => [row.code, row.values]), expected.map((row) => [row.code, row.values]));
  }
});

test('P&L displays the requested top-level layout and retains legacy net profit', () => {
  const db = seed();
  const report = db.records['account.report'].find((item) => item.kind === 'pnl' && item.company_id === 1);
  const period = { from: '2026-01-01', to: '2026-12-31' };
  const rows = configurableReport(db, report, period).rows;
  assert.deepEqual(rows.filter((row) => row.depth === 0).map((row) => row.name), [
    'Revenue', 'Less Costs of Revenue', 'Gross Profit', 'Less Operating Expenses',
    'Operating Income', 'Plus Other Income', 'Less Other Expenses', 'Net Profit',
  ]);
  const oldLines = report.line_ids.filter((line) => line.code !== 'OPERATING').map((line) => {
    if (line.code === 'EXP_GRP') return { ...line, formula: 'EXP + DEP + EXO' };
    if (line.code === 'NET') return { ...line, formula: 'GROSS + INC_GRP - EXP_GRP' };
    return line;
  });
  const old = configurableReportLegacy(db, { ...report, line_ids: oldLines }, period).rows;
  assert.equal(rows.find((row) => row.code === 'NET').values[0], old.find((row) => row.code === 'NET').values[0]);
});
