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
});import { create, read } from './orm.js';
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
  assert.equal(migrated.schema_version, 84);
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

import { unlink } from './orm.js';
import { compareConfigurableReport } from './models/configurableReports.js';

test('account code negative subformula reverses selected balances', () => {
  let db = seed();
  db = postEntry(db, { journal: 'MISC', company: 1, date: '2026-02-01', lines: [{ account: '600000', debit: 100 }, { account: '301000', credit: 100 }] }).db;
  const report = { id: 99991, company_id: 1 };
  const line = { id: 99991, report_id: report.id, code: 'X' };
  const expr = { id: 99991, report_line_id: line.id, label: 'balance', engine: 'account_codes', formula: '600000', subformula: '-sum', date_scope: 'strict_range' };
  db = { ...db, records: { ...db.records, 'account.report.line': [line], 'account.report.expression': [expr] } };
  assert.equal(evaluateStoredReport(db, report, { from: '2026-02-01', to: '2026-02-01' })[0].expressions.balance, -100);
});

test('cumulative stored expressions retain unallocated analytic counterparts', () => {
  let db = seed();
  const posted = postEntry(db, { journal: 'MISC', company: 1, date: '2090-02-01', lines: [{ account: '600000', debit: 100 }, { account: '301000', credit: 100 }] });
  db = posted.db;
  db = { ...db, records: { ...db.records, 'account.move': db.records['account.move'].map((move) => move.id === posted.id ? { ...move, line_ids: move.line_ids.map((line, index) => index === 0 ? { ...line, analytic_distribution: { 777: 100 } } : line) } : move) } };
  const report = { id: 99992, company_id: 1, date_scope: 'cumulative' };
  const line = { id: 99992, report_id: report.id, code: 'X' };
  const expr = { id: 99992, report_line_id: line.id, label: 'balance', engine: 'account_codes', formula: '301000', subformula: 'sum', date_scope: 'from_beginning' };
  db = { ...db, records: { ...db.records, 'account.report.line': [line], 'account.report.expression': [expr] } };
  assert.equal(evaluateStoredReport(db, report, { to: '2090-02-01' }, { analyticAccountIds: [777] })[0].expressions.balance, -100);
});

test('inline edits preserve independent stored lines and expressions', () => {
  let db = seed();
  const report = db.records['account.report'].find((r) => r.kind === 'pnl' && r.company_id === 1);
  const created = create(db, 'account.report.line', { report_id: report.id, name: 'Independent', code: 'INDEPENDENT' }); db = created.db;
  const expr = create(db, 'account.report.expression', { report_line_id: created.id, label: 'balance', engine: 'domain', formula: '[]', subformula: 'sum', date_scope: 'strict_range' }); db = expr.db;
  db = write(db, 'account.report', report.id, { line_ids: report.line_ids.map((line, i) => i ? line : { ...line, name: 'Changed' }) });
  assert.ok(db.records['account.report.line'].some((line) => line.id === created.id));
  assert.ok(db.records['account.report.expression'].some((item) => item.id === expr.id));
});

test('deleting a duplicate statement cascades its stored records', () => {
  let db = seed();
  const original = db.records['account.report'].find((r) => r.kind === 'pnl' && r.company_id === 1);
  const duplicate = create(db, 'account.report', { ...original, name: 'Duplicate', line_ids: [] }); db = duplicate.db;
  const line = create(db, 'account.report.line', { report_id: duplicate.id, name: 'Line', code: 'L' }); db = line.db;
  const expr = create(db, 'account.report.expression', { report_line_id: line.id, label: 'balance', engine: 'domain', formula: '[]', subformula: 'sum', date_scope: 'strict_range' }); db = expr.db;
  db = unlink(db, 'account.report', [duplicate.id]);
  assert.equal(db.records['account.report.line'].some((item) => item.id === line.id), false);
  assert.equal(db.records['account.report.expression'].some((item) => item.id === expr.id), false);
});

test('comparison keeps a hidden-zero line when another period has a value', () => {
  let db = seed();
  db = postEntry(db, { journal: 'MISC', company: 1, date: '2026-02-01', lines: [{ account: '600000', debit: 100 }, { account: '301000', credit: 100 }] }).db;
  const report = db.records['account.report'].find((r) => r.kind === 'pnl' && r.company_id === 1);
  const line = db.records['account.report.line'].find((r) => r.report_id === report.id && r.code === 'EXP');
  db = write(db, 'account.report.line', line.id, { hide_if_zero: true });
  const result = compareConfigurableReport(db, report, [{ from: '1900-01-01', to: '1900-01-01' }, { from: '2026-02-01', to: '2026-02-01' }]);
  assert.deepEqual(result.rows.find((row) => row.id === line.id).values, [0, 100]);
});

test('changing statement date scope resynchronizes stored expressions', () => {
  let db = seed();
  const report = db.records['account.report'].find((r) => r.kind === 'pnl' && r.company_id === 1);
  db = write(db, 'account.report', report.id, { date_scope: 'cumulative' });
  const line = db.records['account.report.line'].find((r) => r.report_id === report.id && r.code === 'OPINC');
  assert.equal(db.records['account.report.expression'].find((e) => e.report_line_id === line.id).date_scope, 'from_beginning');
  assert.doesNotThrow(() => configurableReport(db, { ...report, date_scope: 'cumulative' }, { from: '2026-01-01', to: '2026-12-31' }));
});

test('account code expressions reject unsupported subformulas', () => {
  const seeded = seed();
  const report = { id: 99993, company_id: 1 };
  const line = { id: 99993, report_id: report.id, code: 'X' };
  const expr = { id: 99993, report_line_id: line.id, label: 'balance', engine: 'account_codes', formula: '600000', subformula: 'invalid', date_scope: 'strict_range' };
  const db = { ...seeded, records: { ...seeded.records, 'account.report.line': [line], 'account.report.expression': [expr] } };
  assert.throws(() => evaluateStoredReport(db, report, { from: '2026-01-01', to: '2026-12-31' }), /Unsupported account code subformula/);
});

test('inline statement edits accept a list of account types', () => {
  let db = seed();
  const report = db.records['account.report'].find((item) => item.kind === 'pnl' && item.company_id === 1);
  const line = report.line_ids.find((item) => item.code === 'OPINC');
  db = write(db, 'account.report', report.id, { line_ids: report.line_ids.map((item) => item === line ? { ...item, formula: 'type:income,type:income_other' } : item) });
  const stored = db.records['account.report.line'].find((item) => item.report_id === report.id && item.code === line.code);
  const expression = db.records['account.report.expression'].find((item) => item.report_line_id === stored.id && item.label === 'balance');
  assert.deepEqual(JSON.parse(expression.formula), [['account_type', 'in', ['income', 'income_other']]]);
  assert.doesNotThrow(() => configurableReport(db, db.records['account.report'].find((item) => item.id === report.id), { from: '2026-01-01', to: '2026-12-31' }));
});

test('production rendering honors stored selectors, domains and expression periods', () => {
  let db = seed();
  db = postEntry(db, { journal: 'MISC', company: 1, date: '2089-12-01', lines: [{ account: '600000', debit: 20 }, { account: '301000', credit: 20 }] }).db;
  db = postEntry(db, { journal: 'MISC', company: 1, date: '2090-01-01', lines: [{ account: '600000', debit: 100 }, { account: '301000', credit: 100 }] }).db;
  const account = db.records['account.account'].find((item) => item.code === '600000' && (item.company_id ?? 1) === 1);
  const report = { id: 99123, company_id: 1, date_scope: 'range', line_ids: [] };
  const lines = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((code, i) => ({ id: 99123 + i, report_id: report.id, code, name: code, sequence: i, foldable: true }));
  const specs = [
    ['account_codes', '6(601)', 'from_beginning'],
    ['account_codes', '6D', 'from_beginning'],
    ['domain', JSON.stringify([['account_id', '=', account.id], ['company_id', '=', 1]]), 'from_beginning'],
    ['account_codes', '6', 'strict_range'],
    ['account_codes', '6(600)', 'from_beginning'],
    ['account_codes', '301000C', 'from_fiscalyear'],
    ['domain', JSON.stringify([['account_id', '=', account.id], ['company_id', '=', 1]]), 'from_fiscalyear'],
  ];
  const expressions = specs.map(([engine, formula, date_scope], i) => ({ id: 99123 + i, report_line_id: lines[i].id, label: 'balance', engine, formula, date_scope, subformula: 'sum' }));
  db = { ...db, records: { ...db.records, 'account.report.line': [...db.records['account.report.line'], ...lines], 'account.report.expression': [...db.records['account.report.expression'], ...expressions] } };
  const rows = configurableReport(db, report, { from: '2090-02-01', to: '2090-12-31' }).rows;
  assert.deepEqual(rows.map((row) => row.values[0]), [120, 120, 120, 0, 0, -100, 100]);
  assert.equal(rows[2].accountRows.find((row) => row.account.id === account.id).values[0], 120);
});

test('expressionless stored lines render as headers alongside custom inline lines', () => {
  const seeded = seed();
  const report = { id: 99130, company_id: 1, date_scope: 'range', line_ids: [{ code: 'INLINE', name: 'Inline', formula: '6', sequence: 10 }] };
  const header = { id: 99130, report_id: report.id, name: 'Header', sequence: 20 };
  const db = { ...seeded, records: { ...seeded.records, 'account.report.line': [...seeded.records['account.report.line'], header] } };
  const rows = configurableReport(db, report, { from: '2090-01-01', to: '2090-12-31' }).rows;
  assert.ok(rows.find((row) => row.code === 'INLINE'));
  assert.deepEqual(rows.find((row) => row.id === header.id).values, [null]);
  const compared = compareConfigurableReport(db, report, [{ from: '2090-01-01', to: '2090-06-30' }, { from: '2090-07-01', to: '2090-12-31' }]);
  assert.deepEqual(compared.rows.find((row) => row.id === header.id).values, [null, null]);
});

test('inline statement edits retain code exclusions and tag selectors', () => {
  let db = seed();
  db = postEntry(db, { journal: 'MISC', company: 1, date: '2090-01-01', lines: [{ account: '600000', debit: 100 }, { account: '301000', credit: 100 }] }).db;
  db = { ...db, records: { ...db.records, 'account.account.tag': [...db.records['account.account.tag'], { id: 99000, name: 'Selected' }], 'account.account': db.records['account.account'].map((account) => account.code === '600000' && (account.company_id ?? 1) === 1 ? { ...account, tag_ids: [99000] } : account) } };
  const report = db.records['account.report'].find((item) => item.kind === 'pnl' && item.company_id === 1);
  const line = report.line_ids.find((item) => item.code === 'OPINC');
  for (const formula of ['6,-601', 'tag:Selected']) {
    const changed = { ...line, formula };
    db = write(db, 'account.report', report.id, { line_ids: report.line_ids.map((item) => item.code === line.code ? changed : item) });
    const current = db.records['account.report'].find((item) => item.id === report.id);
    const period = { from: '2090-01-01', to: '2090-12-31' };
    assert.equal(configurableReport(db, current, period).rows.find((item) => item.code === line.code).values[0], configurableReportLegacy(db, current, period).rows.find((item) => item.code === line.code).values[0]);
    const stored = db.records['account.report.line'].find((item) => item.report_id === report.id && item.code === line.code);
    assert.ok(db.records['account.report.expression'].find((item) => item.report_line_id === stored.id && item.label === 'balance'));
  }
});

test('inline synchronization preserves a stored counterpart whose code was edited', () => {
  let db = seed();
  const report = db.records['account.report'].find((item) => item.kind === 'pnl' && item.company_id === 1);
  const stored = db.records['account.report.line'].find((item) => item.report_id === report.id && item.code === 'OPINC');
  db = write(db, 'account.report.line', stored.id, { code: 'CUSTOM_CODE' });
  db = write(db, 'account.report', report.id, { line_ids: report.line_ids.map((item) => item.code === 'OPINC' ? { ...item, name: 'Edited name' } : item) });
  const matches = db.records['account.report.line'].filter((item) => item.report_id === report.id && (item.code === 'OPINC' || item.code === 'CUSTOM_CODE'));
  assert.equal(matches.length, 1);
  assert.equal(matches[0].id, stored.id);
  assert.equal(matches[0].code, 'CUSTOM_CODE');
  assert.equal(matches[0].name, 'Edited name');
  assert.doesNotThrow(() => configurableReport(db, db.records['account.report'].find((item) => item.id === report.id), { from: '2026-01-01', to: '2026-12-31' }));
  assert.ok(db.records['account.report.expression'].some((item) => item.engine === 'aggregation' && item.formula.includes('CUSTOM_CODE.balance')));
});

test('stored and inline child lines stay beneath their parent even when child sequence is lower', () => {
  let db = seed();
  const report = create(db, 'account.report', {
    name: 'Hierarchy Sequence Test',
    company_id: 1,
    line_ids: [
      { code: 'PARENT', name: 'Parent Inline', formula: '400', sequence: 50 },
      { code: 'INLINE_ROOT', name: 'Inline Root', formula: '400', sequence: 15 },
      { code: 'INLINE_CHILD', name: 'Inline Child', parent_code: 'PARENT', formula: '400', sequence: 5 },
    ],
  });
  db = report.db;
  const parent = create(db, 'account.report.line', { report_id: report.id, name: 'Parent Stored', code: 'PARENT', sequence: 50 }); db = parent.db;
  const earlier = create(db, 'account.report.line', { report_id: report.id, name: 'Earlier Root', code: 'EARLIER', sequence: 20 }); db = earlier.db;
  const child = create(db, 'account.report.line', { report_id: report.id, parent_id: parent.id, name: 'Child Lower Seq', code: 'CHILD', sequence: 10 }); db = child.db;
  const rows = configurableReport(db, read(db, 'account.report', report.id), { from: '2026-01-01', to: '2026-12-31' }).rows;
  assert.deepEqual(
    rows.map((row) => [row.code, row.depth]),
    [['INLINE_ROOT', 0], ['EARLIER', 0], ['PARENT', 0], ['INLINE_CHILD', 1], ['CHILD', 1]],
  );
});

test('validateReportExpressions rejects duplicate expression labels on a code-less line', () => {
  const lines = [{ id: 1, name: 'Codeless' }];
  const expr = (id) => ({ id, report_line_id: 1, label: 'balance', engine: 'domain', date_scope: 'strict_range', formula: '[]', subformula: 'sum' });
  assert.match(validateReportExpressions(lines, [expr(1), expr(2)]), /Duplicate report expression/);
});

test('deleting an inline statement line reparents its stored-only children so they stay visible', () => {
  let db = seed();
  const report = db.records['account.report'].find((item) => item.kind === 'pnl' && item.company_id === 1);
  const rev = db.records['account.report.line'].find((item) => item.report_id === report.id && item.code === 'REV');
  const opinc = db.records['account.report.line'].find((item) => item.report_id === report.id && item.code === 'OPINC');
  const customChild = create(db, 'account.report.line', { report_id: report.id, parent_id: opinc.id, name: 'Custom Child', code: 'CUSTOM_CHILD', sequence: 25 });
  db = customChild.db;
  const customGrand = create(db, 'account.report.line', { report_id: report.id, parent_id: customChild.id, name: 'Custom Grandchild', code: 'CUSTOM_GRAND', sequence: 26 });
  db = customGrand.db;
  const nextInline = report.line_ids
    .filter((item) => item.code !== 'OPINC')
    .map((item) => (item.code === 'REV' ? { ...item, formula: 'type:income', sign: -1 } : item.code === 'GROSS' ? { ...item, formula: 'REV - COR' } : item));
  db = write(db, 'account.report', report.id, { line_ids: nextInline });
  const updatedChild = read(db, 'account.report.line', customChild.id);
  const updatedGrand = read(db, 'account.report.line', customGrand.id);
  assert.equal(updatedChild.parent_id, rev.id);
  assert.equal(updatedGrand.parent_id, customChild.id);
  const rows = configurableReport(db, read(db, 'account.report', report.id), { from: '2026-01-01', to: '2026-12-31' }).rows;
  assert.equal(rows.find((row) => row.id === customChild.id)?.depth, 1);
  assert.equal(rows.find((row) => row.id === customGrand.id)?.depth, 2);
});

test('stored foldable breakdown matches legacy accountRows across columns, groups, and direct accountId lookups', () => {
  let db = seed();
  const yr = 2091;
  db = postEntry(db, { journal: 'MISC', company: 1, date: `${yr}-02-10`, lines: [{ account: '101401', debit: 300, partner_id: 1 }, { account: '400000', credit: 300, partner_id: 1 }] }).db;
  db = postEntry(db, { journal: 'MISC', company: 1, date: `${yr}-02-15`, lines: [{ account: '600000', debit: 120, partner_id: 2 }, { account: '101401', credit: 120, partner_id: 2 }] }).db;
  const pnl = db.records['account.report'].find((item) => item.kind === 'pnl' && item.company_id === 1);
  const report = { ...pnl, show_debit: true, show_credit: true };
  const group = create(db, 'account.report.horizontal.group', { name: 'Partner Split', company_id: 1, report_ids: [pnl.id], rule_ids: [{ field: 'partner', partner_ids: [1] }] });
  db = group.db;
  const period = { from: `${yr}-01-01`, to: `${yr}-12-31` };
  const stored = configurableReport(db, report, period, read(db, 'account.report.horizontal.group', group.id));
  const legacy = configurableReportLegacy(db, report, period, read(db, 'account.report.horizontal.group', group.id));
  for (const code of ['REV', 'OPINC', 'EXP_GRP', 'EXP']) {
    const sRow = stored.rows.find((r) => r.code === code);
    const lRow = legacy.rows.find((r) => r.code === code);
    assert.deepEqual(sRow.values, lRow.values, `${code} values`);
    assert.deepEqual(
      sRow.accountRows.map((a) => [a.account.id, a.values]),
      lRow.accountRows.map((a) => [a.account.id, a.values]),
      `${code} accountRows`,
    );
  }
  const incAcc = db.records['account.account'].find((a) => a.code === '400000' && (a.company_id ?? 1) === 1);
  const cache = new Map();
  const fullCached = evaluateStoredReport(db, report, period, { itemCache: cache });
  const oneAccount = evaluateStoredReport(db, report, period, { itemCache: cache, accountId: incAcc.id, skipValidation: true });
  const uncachedOne = evaluateStoredReport(db, report, period, { accountId: incAcc.id });
  assert.equal(oneAccount.find((r) => r.code === 'REV').expressions.balance, uncachedOne.find((r) => r.code === 'REV').expressions.balance);
  assert.equal(fullCached.find((r) => r.code === 'OPINC').expressions.balance, 300);
  const zeroFiltered = configurableReport(db, report, period, null, { includeZeroRows: true });
  assert.equal(zeroFiltered.rows.find((r) => r.code === 'OPINC').accountRows.some((a) => a.account.code === '600000'), false);
  const breakdown = evaluateStoredReport(db, report, period, { includeAccountBreakdown: true });
  assert.equal(breakdown.find((r) => r.code === 'REV').accountExpressions.balance.get(incAcc.id), 300);
  assert.equal(breakdown.find((r) => r.code === 'GROSS').accountExpressions.balance.size, 0);
});

import { isExpandableLine } from './models/configurableReports.js';

test('foldable aggregations with disjoint division or additive constants evaluate totals without broken account breakdowns', () => {
  let db = seed();
  const yr = 2092;
  const secondExp = create(db, 'account.account', { code: '601000', name: 'Other Expense', account_type: 'expense', company_id: 1 });
  db = secondExp.db;
  db = postEntry(db, {
    journal: 'MISC',
    company: 1,
    date: `${yr}-02-10`,
    lines: [
      { account: '400000', credit: 300 },
      { account: '600000', debit: 100 },
      { account: '601000', debit: 50 },
      { account: '101401', debit: 150 },
    ],
  }).db;
  const report = create(db, 'account.report', { name: 'Ratio and Constant Report', company_id: 1, line_ids: [] });
  db = report.db;
  const makeLine = (code, sequence, foldable = false) => {
    const res = create(db, 'account.report.line', { report_id: report.id, name: code, code, sequence, foldable });
    db = res.db;
    return res.id;
  };
  const revId = makeLine('REV', 10);
  const expId = makeLine('EXP', 20);
  const ratioId = makeLine('RATIO', 30, true);
  const offsetId = makeLine('OFFSET', 40, true);
  const depId = makeLine('DEP_RATIO', 50, true);
  const scaledId = makeLine('SCALED', 60, true);
  const addExpr = (report_line_id, engine, formula, subformula = 'sum') => {
    db = create(db, 'account.report.expression', { report_line_id, label: 'balance', engine, formula, subformula, date_scope: 'strict_range' }).db;
  };
  addExpr(revId, 'domain', '[["account_type","=","income"]]', '-sum');
  addExpr(expId, 'domain', '[["account_type","=","expense"]]', 'sum');
  addExpr(ratioId, 'aggregation', 'REV.balance / EXP.balance');
  addExpr(offsetId, 'aggregation', 'EXP.balance + 100');
  addExpr(depId, 'aggregation', 'RATIO.balance + EXP.balance');
  addExpr(scaledId, 'aggregation', '3 * EXP.balance - REV.balance');

  const period = { from: `${yr}-01-01`, to: `${yr}-12-31` };
  const rep = read(db, 'account.report', report.id);
  const out = configurableReport(db, rep, period);
  const rowOf = (code) => out.rows.find((row) => row.code === code);
  assert.equal(rowOf('RATIO').values[0], 2);
  assert.deepEqual(rowOf('RATIO').accountRows, []);
  assert.equal(isExpandableLine(rowOf('RATIO')), false);
  assert.equal(rowOf('OFFSET').values[0], 250);
  assert.deepEqual(rowOf('OFFSET').accountRows, []);
  assert.equal(isExpandableLine(rowOf('OFFSET')), false);
  assert.equal(rowOf('DEP_RATIO').values[0], 152);
  assert.deepEqual(rowOf('DEP_RATIO').accountRows, []);
  assert.equal(rowOf('SCALED').values[0], 150);
  assert.equal(rowOf('SCALED').accountRows.reduce((sum, item) => sum + item.values[0], 0), 150);
  assert.equal(isExpandableLine(rowOf('SCALED')), true);

  const raw = evaluateStoredReport(db, rep, period, { includeAccountBreakdown: true });
  assert.equal(raw.find((row) => row.code === 'RATIO').accountExpressions.balance.size, 0);
  assert.equal(raw.find((row) => row.code === 'OFFSET').accountExpressions.balance.size, 0);
  assert.equal(raw.find((row) => row.code === 'DEP_RATIO').accountExpressions.balance.size, 0);
});

test('deleting an inline statement line referenced by a retained stored aggregation expression is rejected', () => {
  let db = seed();
  const report = db.records['account.report'].find((item) => item.kind === 'pnl' && item.company_id === 1);
  const custom = create(db, 'account.report.line', { report_id: report.id, name: 'Double Sales', code: 'DBL_SALES', sequence: 25 });
  db = custom.db;
  db = create(db, 'account.report.expression', {
    report_line_id: custom.id,
    label: 'balance',
    engine: 'aggregation',
    formula: 'OPINC.balance * 2',
    date_scope: 'strict_range',
  }).db;
  const nextInline = report.line_ids
    .filter((item) => item.code !== 'OPINC')
    .map((item) => (item.code === 'REV' ? { ...item, formula: 'type:income', sign: -1 } : item.code === 'GROSS' ? { ...item, formula: 'REV - COR' } : item));
  assert.throws(
    () => write(db, 'account.report', report.id, { line_ids: nextInline }),
    /Cannot delete report line OPINC: still referenced by DBL_SALES/,
  );
  assert.doesNotThrow(() => configurableReport(db, read(db, 'account.report', report.id), { from: '2026-01-01', to: '2026-12-31' }));

  const opinc = db.records['account.report.line'].find((item) => item.report_id === report.id && item.code === 'OPINC');
  db = write(db, 'account.report.line', opinc.id, { code: 'RENAMED_OPINC' });
  assert.throws(
    () => write(db, 'account.report', report.id, { line_ids: nextInline }),
    /Cannot delete report line RENAMED_OPINC: still referenced by DBL_SALES/,
  );
});

test('scaled foldable aggregation account rows reconcile rounding remainder to the line total', () => {
  let db = seed();
  const yr = 2093;
  const secondExp = create(db, 'account.account', { code: '601000', name: 'Other Expense', account_type: 'expense', company_id: 1 });
  db = secondExp.db;
  db = postEntry(db, {
    journal: 'MISC',
    company: 1,
    date: `${yr}-03-10`,
    lines: [
      { account: '600000', debit: 0.01 },
      { account: '601000', debit: 0.01 },
      { account: '101401', credit: 0.02 },
    ],
  }).db;
  const report = create(db, 'account.report', { name: 'Half Cent Rounding Report', company_id: 1, show_debit: true, show_credit: true, line_ids: [] });
  db = report.db;
  const expLine = create(db, 'account.report.line', { report_id: report.id, name: 'Expenses', code: 'EXP', sequence: 10 });
  db = expLine.db;
  const halfLine = create(db, 'account.report.line', { report_id: report.id, name: 'Half Expenses', code: 'HALF', sequence: 20, foldable: true });
  db = halfLine.db;
  const negHalfLine = create(db, 'account.report.line', { report_id: report.id, name: 'Neg Half Expenses', code: 'NEG_HALF', sequence: 30, foldable: true });
  db = negHalfLine.db;
  db = create(db, 'account.report.expression', { report_line_id: expLine.id, label: 'balance', engine: 'domain', formula: '[["account_type","=","expense"]]', subformula: 'sum', date_scope: 'strict_range' }).db;
  db = create(db, 'account.report.expression', { report_line_id: halfLine.id, label: 'balance', engine: 'aggregation', formula: 'EXP.balance / 2', date_scope: 'strict_range' }).db;
  db = create(db, 'account.report.expression', { report_line_id: negHalfLine.id, label: 'balance', engine: 'aggregation', formula: '-EXP.balance / 2', date_scope: 'strict_range' }).db;

  const period = { from: `${yr}-01-01`, to: `${yr}-12-31` };
  const rep = read(db, 'account.report', report.id);
  const out = configurableReport(db, rep, period);
  const halfRow = out.rows.find((row) => row.code === 'HALF');
  assert.deepEqual(halfRow.values, [0.01, 0.01, 0]);
  assert.equal(halfRow.accountRows.reduce((sum, item) => sum + item.values[0], 0), 0.01);
  assert.equal(halfRow.accountRows.reduce((sum, item) => sum + item.values[1], 0), 0.01);
  assert.equal(halfRow.accountRows.reduce((sum, item) => sum + item.values[2], 0), 0);

  const negHalfRow = out.rows.find((row) => row.code === 'NEG_HALF');
  assert.deepEqual(negHalfRow.values, [-0.01, -0.01, 0]);
  assert.equal(negHalfRow.accountRows.reduce((sum, item) => sum + item.values[0], 0), -0.01);

  const raw = evaluateStoredReport(db, rep, period, { includeAccountBreakdown: true });
  const halfBreakdown = [...raw.find((row) => row.code === 'HALF').accountExpressions.balance.values()];
  assert.equal(halfBreakdown.reduce((sum, amt) => sum + amt, 0), 0.01);
});

test('nested foldable aggregation preserves raw per-account contributions across intermediate reconciliation', () => {
  let db = seed();
  const yr = 2094;
  const secondExp = create(db, 'account.account', { code: '601000', name: 'Other Expense', account_type: 'expense', company_id: 1 });
  db = secondExp.db;
  db = postEntry(db, {
    journal: 'MISC',
    company: 1,
    date: `${yr}-04-10`,
    lines: [
      { account: '600000', debit: 0.01 },
      { account: '601000', debit: 0.01 },
      { account: '101401', credit: 0.02 },
    ],
  }).db;
  const report = create(db, 'account.report', { name: 'Nested Half Double Report', company_id: 1, show_debit: true, show_credit: true, line_ids: [] });
  db = report.db;
  const expLine = create(db, 'account.report.line', { report_id: report.id, name: 'Expenses', code: 'EXP', sequence: 10 });
  db = expLine.db;
  const halfLine = create(db, 'account.report.line', { report_id: report.id, name: 'Half Expenses', code: 'HALF', sequence: 20, foldable: true });
  db = halfLine.db;
  const doubleLine = create(db, 'account.report.line', { report_id: report.id, name: 'Double Half Expenses', code: 'DOUBLE', sequence: 30, foldable: true });
  db = doubleLine.db;
  db = create(db, 'account.report.expression', { report_line_id: expLine.id, label: 'balance', engine: 'domain', formula: '[["account_type","=","expense"]]', subformula: 'sum', date_scope: 'strict_range' }).db;
  db = create(db, 'account.report.expression', { report_line_id: halfLine.id, label: 'balance', engine: 'aggregation', formula: 'EXP.balance / 2', date_scope: 'strict_range' }).db;
  db = create(db, 'account.report.expression', { report_line_id: doubleLine.id, label: 'balance', engine: 'aggregation', formula: 'HALF.balance * 2', date_scope: 'strict_range' }).db;

  const period = { from: `${yr}-01-01`, to: `${yr}-12-31` };
  const rep = read(db, 'account.report', report.id);
  const out = configurableReport(db, rep, period);
  const doubleRow = out.rows.find((row) => row.code === 'DOUBLE');
  assert.deepEqual(doubleRow.values, [0.02, 0.02, 0]);
  assert.deepEqual(
    doubleRow.accountRows.map((item) => [item.account.code, item.values]),
    [['600000', [0.01, 0.01, 0]], ['601000', [0.01, 0.01, 0]]],
  );

  const raw = evaluateStoredReport(db, rep, period, { includeAccountBreakdown: true });
  const exp1 = db.records['account.account'].find((a) => a.code === '600000' && (a.company_id ?? 1) === 1);
  const doubleBreakdown = raw.find((row) => row.code === 'DOUBLE').accountExpressions.balance;
  assert.equal(doubleBreakdown.get(exp1.id), 0.01);
  assert.equal(doubleBreakdown.get(secondExp.id), 0.01);
});
