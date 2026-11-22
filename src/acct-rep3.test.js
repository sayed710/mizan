import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { seed } from './seed.js';
import { createCompany, setCompanies } from './models/company.js';
import { read } from './orm.js';
register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

async function setup() {
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  return { React, render: (component) => renderToStaticMarkup(component) };
}
async function page(report, db) {
  const { initStore, commit } = await import('./store.js');
  await initStore(); await commit(db);
  const { React, render } = await setup();
  const { Reports } = await import('./views/Reports.jsx');
  return render(React.createElement(Reports, { leaf: { report } }));
}
const periods = [{ from: '2026-01-01', to: '2026-12-31', label: 'Current' }, { from: '2025-01-01', to: '2025-12-31', label: 'Previous' }];

test('tax and fiscal offer comparison controls', async () => {
  for (const name of ['tax', 'fiscal']) assert.ok((await page(name, seed())).includes('Previous Period'), name);
});
test('trial balance renders comparison period columns', async () => {
  const { React, render } = await setup();
  const { TrialBalance } = await import('./views/FinanceReports.jsx');
  const html = render(React.createElement('table', null, React.createElement(TrialBalance, { db: seed(), period: periods[0], periods, money: String })));
  const total = html.split('rep-total strong')[1];
  assert.equal((total.match(/class="num"/g) ?? []).length, 8);
});
test('fiscal and tax render values for each comparison period', async () => {
  const { React, render } = await setup();
  const { FiscalReport } = await import('./views/FinanceReports.jsx');
  const { Tax } = await import('./views/Reports.jsx');
  const fiscal = render(React.createElement('table', null, React.createElement(FiscalReport, { db: seed(), period: periods[0], periods, money: String })));
  assert.equal((fiscal.split('rep-total strong')[1].match(/class="num"/g) ?? []).length, 6);
  const tax = render(React.createElement('table', null, React.createElement(Tax, { db: seed(), period: periods[0], periods, variant: 'generic', money: String })));
  const payable = tax.split('PAYABLE');
  assert.ok(tax.includes('Tax Payable'));
  assert.equal((tax.split('rep-total strong')[1].split('</tr>')[0].match(/class="num"/g) ?? []).length, 2);
  assert.ok(payable);
});
test('budget report offers allowed company selector', async () => {
  const db = seed();
  const branch = createCompany(db, { name: 'Branch RP3', currency_id: read(db, 'res.company', 1).currency_id });
  const scoped = setCompanies(branch.db, { current: 1, allowed: [1, branch.id] });
  const html = await page('budget', scoped);
  assert.ok(html.includes('aria-label="Company"'));
  assert.ok(html.includes('Branch RP3'));
});

test('budget company filter limits visible budgets', async () => {
  const { React, render } = await setup();
  const { Budget } = await import('./views/Reports.jsx');
  const db = seed();
  db.records['account.budget'] = [
    { id: 1001, name: 'First budget', state: 'confirm', company_id: 1, lines: [] },
    { id: 1002, name: 'Second budget', state: 'confirm', company_id: 2, lines: [] },
  ];
  const html = render(React.createElement('table', null, React.createElement(Budget, { db, period: {}, companyId: '1' })));
  assert.ok(html.includes('First budget'));
  assert.ok(!html.includes('Second budget'));
});

test('fiscal comparison preserves values from each period', async () => {
  const { create, search } = await import('./orm.js');
  const { postMove } = await import('./models/accounting.js');
  const { React, render } = await setup();
  const { FiscalReport } = await import('./views/FinanceReports.jsx');
  let db = seed();
  const cash = search(db, 'account.account').find((a) => a.code === '101401');
  const expense = create(db, 'account.account', { code: 'RP301', name: 'Comparison expense', account_type: 'expense' });
  db = expense.db;
  for (const [date, amount] of [['2026-01-10', 123], ['2025-01-10', 456]]) {
    const move = create(db, 'account.move', { move_type: 'entry', company_id: 1, invoice_date: date, line_ids: [{ account_id: expense.id, debit: amount, credit: 0 }, { account_id: cash.id, debit: 0, credit: amount }] });
    db = postMove(move.db, move.id);
  }
  const html = render(React.createElement('table', null, React.createElement(FiscalReport, { db, period: periods[0], periods, money: String })));
  const total = html.split('rep-total strong')[1].split('</tr>')[0];
  const { fiscalReport } = await import('./models/reports.js');
  const expected = periods.map((p) => fiscalReport(db, p).totals.debit);
  assert.notEqual(expected[0], expected[1]);
  for (const value of expected) assert.ok(total.includes(`>${value}</td>`));
});
