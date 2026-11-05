import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, search } from './orm.js';
import { seed } from './seed.js';
import { postEntry, profitAndLoss } from './models/ledger.js';
import { trialBalance } from './models/reports.js';
import { cashflowColumns } from './views/reportCompare.js';

/** Two analytic accounts; revenue 100 tagged to the first and 40 to the second, both received in cash, one per month. */
function fixture() {
  let db = { ...seed(), records: { ...seed().records, 'account.analytic.account': [], 'account.analytic.line': [] } };
  const plan = create(db, 'account.analytic.plan', { name: 'Projects' });
  db = plan.db;
  const first = create(db, 'account.analytic.account', { name: 'Alpha', plan_id: plan.id });
  const second = create(first.db, 'account.analytic.account', { name: 'Beta', plan_id: plan.id });
  db = second.db;
  const company = (account) => (account.company_id ?? 1) === 1;
  const income = search(db, 'account.account').find((a) => a.account_type === 'income' && company(a));
  const cash = search(db, 'account.account').find((a) => a.account_type === 'asset_cash' && company(a));
  const sale = (date, amount, analyticId) => postEntry(db, {
    journal: 'MISC', date, ref: `Sale ${amount}`, lines: [
      { account_id: cash.id, debit: amount, credit: 0, analytic_distribution: { [analyticId]: 100 } },
      { account_id: income.id, debit: 0, credit: amount, analytic_distribution: { [analyticId]: 100 } },
    ],
  }).db;
  db = sale('2030-01-10', 100, first.id);
  db = sale('2030-02-10', 40, second.id);
  return { db, alpha: first.id, beta: second.id, income: income.id };
}

test('analytic filter narrows P&L and trial balance to lines distributed to the selected accounts', () => {
  const { db, alpha, beta, income } = fixture();
  const period = { from: '2030-01-01', to: '2030-12-31' };
  assert.equal(profitAndLoss(db, period, { analyticAccountIds: [alpha] }).revenue, 100);
  assert.equal(profitAndLoss(db, period, { analyticAccountIds: [alpha, beta] }).revenue, 140);
  const trialRow = (ids) => trialBalance(db, { ...period, analyticAccountIds: ids }).rows.find((r) => r.account.id === income);
  assert.equal(trialRow([beta]).credit, 40);
  assert.equal(trialRow([]).credit >= 140, true);
});

test('cash flow compares calendar periods and honours the analytic filter', () => {
  const { db, alpha } = fixture();
  const periods = [{ from: '2030-01-01', to: '2030-01-31', label: 'Jan 2030' }, { from: '2030-02-01', to: '2030-02-28', label: 'Feb 2030' }];
  const all = cashflowColumns(db, periods, { company_id: 1 });
  const net = (data) => data.totals.find((t) => t.label === 'Net Change in Cash').values;
  assert.deepEqual(all.headers, ['Jan 2030', 'Feb 2030']);
  assert.deepEqual(net(all), [100, 40]);
  assert.deepEqual(net(cashflowColumns(db, periods, { company_id: 1, analyticAccountIds: [alpha] })), [100, 0]);
});
