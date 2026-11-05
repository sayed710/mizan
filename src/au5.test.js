import test from 'node:test';
import assert from 'node:assert/strict';
import { create } from './orm.js';
import { seed } from './seed.js';
import { balanceSheet, postEntry } from './models/ledger.js';
import { closeFiscalYear } from './models/closing.js';

test('analytic balance sheet reports a closed prior year as retained equity, not current earnings', () => {
  let db = seed();
  const alpha = create(db, 'account.analytic.account', { name: 'Project Alpha' });
  db = alpha.db;
  const tag = { analytic_distribution: { [alpha.id]: 100 } };

  // 2024: revenue 60,000 and expense 10,000 -> net 50,000, all tagged to the analytic account.
  db = postEntry(db, {
    journal: 'MISC', date: '2024-06-15',
    lines: [
      { account: '101401', debit: 60000 },
      { account: '400000', credit: 60000, ...tag },
    ],
  }).db;
  db = postEntry(db, {
    journal: 'MISC', date: '2024-07-15',
    lines: [
      { account: '600000', debit: 10000, ...tag },
      { account: '101401', credit: 10000 },
    ],
  }).db;
  const fy2024 = create(db, 'account.fiscal.year', {
    name: 'FY 2024', company_id: 1, date_from: '2024-01-01', date_to: '2024-12-31',
  });
  db = closeFiscalYear(fy2024.db, fy2024.id);

  // 2025: revenue 20,000 is the only current-year activity.
  db = postEntry(db, {
    journal: 'MISC', date: '2025-03-10',
    lines: [
      { account: '101401', debit: 20000 },
      { account: '400000', credit: 20000, ...tag },
    ],
  }).db;

  const whole = balanceSheet(db, '2025-06-30');
  const analytic = balanceSheet(db, '2025-06-30', { analyticAccountIds: [alpha.id] });

  // The whole-company sheet books the closing entry, so only 2025 remains in current earnings.
  assert.equal(whole.earnings, 20000);
  assert.equal(whole.equity.find((row) => row.account.code === '302000').balance, 50000);
  assert.equal(whole.totalEquity, 70000);

  // The analytic sheet drops the untagged closing entry, so the closed 2024 result must sit in equity.
  assert.equal(analytic.earnings, 20000, 'current earnings only covers the fiscal year containing the report date');
  assert.equal(analytic.equity.find((row) => row.account.code === '302000').balance, 50000, 'closed prior-year result is retained equity');
  assert.equal(analytic.totalEquity, 70000);
  assert.equal(analytic.totalAssets, 70000);
  assert.equal(analytic.totalAssets, analytic.totalLiabilities + analytic.totalEquity);
});
