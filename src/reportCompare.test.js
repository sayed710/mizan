import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create } from './orm.js';
import { balanceSheet, postEntry, profitAndLoss } from './models/ledger.js';
import { seed } from './seed.js';
import { balanceColumns, periodsFor, pnlColumns } from './views/reportCompare.js';

test('monthly comparisons use complete months, including leap February and year rollover', () => {
  assert.deepEqual(periodsFor('month', 'none', '2024-02-29'), [
    { from: '2024-02-01', to: '2024-02-29', label: 'Feb 2024' },
  ]);
  assert.deepEqual(periodsFor('month', 'previous', '2024-03-31'), [
    { from: '2024-02-01', to: '2024-02-29', label: 'Feb 2024' },
    { from: '2024-03-01', to: '2024-03-31', label: 'Mar 2024' },
  ]);
  assert.deepEqual(periodsFor('month', 'lastYear', '2024-02-29'), [
    { from: '2023-02-01', to: '2023-02-28', label: 'Feb 2023' },
    { from: '2024-02-01', to: '2024-02-29', label: 'Feb 2024' },
  ]);
  assert.deepEqual(periodsFor('month', 'last3', '2026-01-15'), [
    { from: '2025-11-01', to: '2025-11-30', label: 'Nov 2025' },
    { from: '2025-12-01', to: '2025-12-31', label: 'Dec 2025' },
    { from: '2026-01-01', to: '2026-01-31', label: 'Jan 2026' },
  ]);
  assert.equal(periodsFor('month', 'lastYear', '2025-02-28')[0].to, '2024-02-29');
});

test('quarter comparisons cross years and keep full quarter boundaries for every mode', () => {
  const current = { from: '2024-01-01', to: '2024-03-31', label: 'Q1 2024' };
  const previous = { from: '2023-10-01', to: '2023-12-31', label: 'Q4 2023' };
  assert.deepEqual(periodsFor('quarter', 'none', '2024-02-29'), [current]);
  assert.deepEqual(periodsFor('quarter', 'previous', '2024-02-29'), [previous, current]);
  assert.deepEqual(periodsFor('quarter', 'lastYear', '2024-02-29'), [
    { from: '2023-01-01', to: '2023-03-31', label: 'Q1 2023' }, current,
  ]);
  assert.deepEqual(periodsFor('quarter', 'last3', '2024-02-29'), [
    { from: '2023-07-01', to: '2023-09-30', label: 'Q3 2023' }, previous, current,
  ]);
  assert.equal(periodsFor('quarter', 'none', '2026-10-25')[0].label, 'Q4 2026');
});

test('annual comparisons, All Dates and invalid inputs have explicit results', () => {
  const period = (year) => ({ from: `${year}-01-01`, to: `${year}-12-31`, label: String(year) });
  assert.deepEqual(periodsFor('year', 'none', '2024-02-29'), [period(2024)]);
  for (const mode of ['previous', 'lastYear']) assert.deepEqual(periodsFor('year', mode, '2024-02-29'), [period(2023), period(2024)]);
  assert.deepEqual(periodsFor('year', 'last3', '2024-02-29'), [period(2022), period(2023), period(2024)]);
  assert.deepEqual(periodsFor('all', 'last3', '2024-02-29'), [{ from: '', to: '9999-12-31', label: 'All Dates' }]);
  assert.throws(() => periodsFor('week', 'none', '2024-02-29'), /valid period/);
  assert.throws(() => periodsFor('month', 'none', '2023-02-29'), /valid period/);
  assert.throws(() => periodsFor('month', 'unknown', '2024-02-29'), /valid comparison/);
});

function fixture() {
  let db = seed();
  for (const [code, name, account_type] of [
    ['499991', 'Comparison Sales A', 'income'], ['499992', 'Comparison Sales B', 'income'],
    ['199991', 'Comparison Asset', 'asset_current'], ['299991', 'Comparison Liability', 'liability_current'],
  ]) db = create(db, 'account.account', { code, name, account_type }).db;
  const entry = (date, lines) => { db = postEntry(db, { journal: 'MISC', date, lines }).db; };
  entry('2040-01-01', [{ account: '199991', debit: 100 }, { account: '299991', credit: 100 }]);
  entry('2040-01-31', [{ account: '101401', debit: 100 }, { account: '499991', credit: 100 }]);
  entry('2040-02-29', [{ account: '101401', debit: 200 }, { account: '499992', credit: 200 }]);
  entry('2040-03-01', [{ account: '101401', debit: 300 }, { account: '499991', credit: 300 }]);
  entry('2040-03-31', [{ account: '600000', debit: 40 }, { account: '101401', credit: 40 }]);
  entry('2040-03-31', [{ account: '500000', debit: 20 }, { account: '211000', credit: 20 }]);
  entry('2040-03-31', [{ account: '101401', debit: 10 }, { account: '450000', credit: 10 }]);
  entry('2040-03-31', [{ account: '690000', debit: 5 }, { account: '101401', credit: 5 }]);
  return db;
}

const periods = periodsFor('month', 'last3', '2040-03-15');

test('P&L columns match every ledger section and total without changing the db', () => {
  const db = fixture();
  const before = JSON.stringify(db);
  const result = pnlColumns(db, periods);
  assert.deepEqual(result.headers, ['Jan 2040', 'Feb 2040', 'Mar 2040']);
  assert.deepEqual(result.sections.map((s) => s.title), ['Revenue', 'Cost of Revenue', 'Expenses', 'Other Income', 'Other Expenses']);
  assert.deepEqual(result.totals.map((r) => [r.label, r.strong]), [['Gross Profit', false], ['Net Operating Income', false], ['Net Income', true]]);
  periods.forEach((p, i) => {
    const expected = profitAndLoss(db, p);
    assert.deepEqual(result.sections.map((s) => s.totals[i]), [expected.revenue, expected.cost, expected.expense, expected.otherIncome, expected.otherExpense]);
    assert.deepEqual(result.totals.map((r) => r.values[i]), [expected.gross, expected.operating, expected.net]);
  });
  assert.equal(JSON.stringify(db), before);
});

test('balance columns match cumulative ledger totals and the accounting equation per period', () => {
  const db = fixture();
  const before = JSON.stringify(db);
  const result = balanceColumns(db, periods);
  assert.deepEqual(result.headers, periods.map((p) => p.label));
  assert.deepEqual(result.sections.map((s) => s.title), ['Assets', 'Liabilities', 'Equity', 'Current Year Earnings']);
  assert.deepEqual(result.totals.map((r) => [r.label, r.strong]), [['Total Assets', true], ['Liabilities + Equity', true]]);
  periods.forEach((p, i) => {
    const b = balanceSheet(db, p.to);
    assert.deepEqual(result.sections.map((s) => s.totals[i]), [b.totalAssets, b.totalLiabilities, Math.round((b.totalEquity - b.earnings) * 100) / 100, b.earnings]);
    assert.equal(result.totals[0].values[i], b.totalAssets);
    assert.equal(result.totals[1].values[i], Math.round((b.totalLiabilities + b.totalEquity) * 100) / 100);
    assert.equal(result.totals[0].values[i], result.totals[1].values[i]);
  });
  assert.equal(JSON.stringify(db), before);
});

test('variance uses the last two columns, rounds percentages and leaves zero baselines null', () => {
  const db = fixture();
  const result = pnlColumns(db, periods);
  assert.deepEqual(result.variance[0], { amount: 100, pct: 50 });
  assert.deepEqual(result.variance[1], { amount: 20, pct: null });
  assert.deepEqual(result.variance.at(-1), { amount: 45, pct: 22.5 });
  const reversed = pnlColumns(db, [...periods].reverse());
  assert.deepEqual(reversed.variance[0], { amount: -100, pct: -50 });
  const negative = postEntry(db, { journal: 'MISC', date: '2040-02-01', lines: [{ account: '600000', debit: 400 }, { account: '101401', credit: 400 }] }).db;
  assert.deepEqual(pnlColumns(negative, periods).variance.at(-1), { amount: 445, pct: 222.5 });
  assert.ok(pnlColumns(db, [periods[0]]).variance.every((v) => v.amount === null && v.pct === null));
  assert.deepEqual(pnlColumns(db, []).headers, []);
  const balance = balanceColumns(db, periods);
  balance.variance.forEach((v, i) => {
    const values = i < balance.sections.length ? balance.sections[i].totals : balance.totals[i - balance.sections.length].values;
    const amount = Math.round((values[2] - values[1]) * 100) / 100;
    assert.deepEqual(v, { amount, pct: values[1] ? Math.round(amount / Math.abs(values[1]) * 10000) / 100 : null });
  });
});

test('account detail is a sorted union with zeroes where an account has no period activity', () => {
  const db = fixture();
  const revenue = pnlColumns(db, periods).sections[0].rows;
  assert.deepEqual(revenue.filter((r) => r.account.code.startsWith('49999')).map((r) => r.values), [[100, 0, 300], [0, 200, 0]]);
  for (const result of [pnlColumns(db, periods), balanceColumns(db, periods)]) {
    result.sections.forEach((section) => {
      assert.deepEqual(section.rows.map((r) => r.account.code), section.rows.map((r) => r.account.code).sort());
      section.rows.forEach((r) => assert.equal(r.values.length, 3));
    });
  }
  const earlier = [{ from: '1900-01-01', to: '1900-01-31', label: 'Jan 1900' }, ...periods];
  const sheet = balanceColumns(db, earlier);
  assert.deepEqual(sheet.sections[0].rows.find((r) => r.account.code === '199991').values, [0, 100, 100, 100]);
  assert.deepEqual(sheet.sections[1].rows.find((r) => r.account.code === '299991').values, [0, 100, 100, 100]);
});
