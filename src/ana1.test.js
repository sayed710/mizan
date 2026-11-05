import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { models } from './models/index.js';
import { create, read, write } from './orm.js';
import { seed } from './seed.js';
import { budgetReport } from './models/analyticplus.js';
import { postMove } from './models/accounting.js';
import { createCompany, setCompanies } from './models/company.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const run = (db, model, id, label) => models[model].form.buttons.find((b) => b.label === label).run(db, read(db, model, id)).db;
const budget = (db, account, extra = {}) => create(db, 'account.budget', { name: 'Audit budget', date_from: '2026-01-01', date_to: '2026-01-31', lines: [{ analytic_account_id: account, planned: -1000 }], ...extra });
const actual = (db, id) => budgetReport(db, id, '2026-01-31')[0];

test('budget achieved excludes timesheets and draft moves and follows posted move resets', () => {
  const a = create(seed(), 'account.analytic.account', { name: 'Budget actuals' });
  let db = create(a.db, 'account.analytic.line', { account_id: a.id, date: '2026-01-10', amount: -500 }).db;
  const bill = create(db, 'account.move', { move_type: 'in_invoice', partner_id: 2, invoice_date: '2026-01-10', invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0, analytic_account_id: a.id }] });
  const b = budget(bill.db, a.id);
  assert.equal(actual(b.db, b.id).practical, 0);
  db = postMove(b.db, bill.id);
  assert.deepEqual([actual(db, b.id).practical, actual(db, b.id).achievement], [-100, 10]);
  db = run(db, 'account.move', bill.id, 'Reset to Draft');
  assert.equal(actual(db, b.id).practical, 0);
});

test('budgets default to the selected database company and reject missing company configuration', () => {
  let db = seed();
  const company = createCompany(db, { name: 'Second', currency_id: read(db, 'res.company', 1).currency_id });
  db = setCompanies(company.db, { current: company.id, allowed: [1, company.id] });
  const a = create(db, 'account.analytic.account', { name: 'Second company analysis', company_id: company.id });
  const b = budget(a.db, a.id);
  assert.equal(read(b.db, 'account.budget', b.id).company_id, company.id);
  const bill = create(b.db, 'account.move', { company_id: company.id, move_type: 'entry', date: '2026-01-10', invoice_date: '2026-01-10', line_ids: [] });
  // Use explicitly selected chart accounts; no account-code or name inference.
  const expense = create(bill.db, 'account.account', { name: 'Expense', code: 'AUD-EXP', account_type: 'expense', company_id: company.id });
  const equity = create(expense.db, 'account.account', { name: 'Equity', code: 'AUD-EQ', account_type: 'equity', company_id: company.id });
  db = write(equity.db, 'account.move', bill.id, { line_ids: [{ account_id: expense.id, debit: 100, analytic_distribution: { [a.id]: 100 } }, { account_id: equity.id, credit: 100 }] });
  const journal = create(db, 'account.journal', { name: 'Second company general', code: 'AUD', type: 'general', company_id: company.id });
  db = write(journal.db, 'account.move', bill.id, { journal_id: journal.id });
  db = postMove(db, bill.id);
  assert.equal(actual(db, b.id).practical, -100);
  assert.throws(() => write(db, 'account.budget', b.id, { company_id: null }), /company/i);
  assert.throws(() => budget(db, a.id, { company_id: 99999 }), /company/i);
});

test('budget commitments track confirmed unbilled allocations through partial bills and cancellation', async () => {
  const a = create(seed(), 'account.analytic.account', { name: 'Purchase budget' });
  const po = create(a.db, 'purchase.order', { partner_id: 2, date_order: '2026-01-10', order_line: [{ product_id: 5, qty: 10, price_unit: 100, discount: 10, tax: 0, analytic_distribution: { [a.id]: 60 } }] });
  const b = budget(po.db, a.id);
  assert.equal(actual(b.db, b.id).committed, 0);
  let db = run(b.db, 'purchase.order', po.id, 'Confirm Order');
  assert.deepEqual([actual(db, b.id).committed, actual(db, b.id).practical], [-540, 0]);
  db = run(db, 'purchase.order', po.id, 'Create Bill');
  const bill = db.records['account.move'].find((m) => m.purchase_id === po.id);
  assert.equal(actual(db, b.id).committed, -540, 'a draft bill is not achieved');
  db = write(db, 'account.move', bill.id, { invoice_date: '2026-01-15', date: '2026-01-15', invoice_line_ids: bill.invoice_line_ids.map((l) => ({ ...l, qty: 4 })) });
  db = postMove(db, bill.id);
  assert.deepEqual([actual(db, b.id).committed, actual(db, b.id).practical], [-324, -216]);
  assert.equal(budgetReport(db, b.id, '2026-01-31', { period: { from: '2026-01-20' } })[0].committed, 0);
  const { initStore, commit } = await import('./store.js');
  await initStore();
  await commit(run(db, 'account.budget', b.id, 'Confirm'));
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { Reports } = await import('./views/Reports.jsx');
  const html = renderToStaticMarkup(React.createElement(Reports, { leaf: { report: 'budget' }, initialPeriod: 'all' }));
  assert.match(html, /Committed/);
  assert.match(html, new RegExp(`#/open/purchase.order/${po.id}`));
  assert.match(html, /-\$324\.00/);
  const cancelled = write(db, 'purchase.order', po.id, { state: 'cancel' });
  assert.equal(actual(cancelled, b.id).committed, 0);
});

test('commitments use explicit line keys for repeated products and reject unlinked posted bills', () => {
  const a = create(seed(), 'account.analytic.account', { name: 'Allocated purchase' });
  const b = budget(a.db, a.id);
  const po = create(b.db, 'purchase.order', { state: 'purchase', partner_id: 2, date_order: '2026-01-10', order_line: [
    { purchase_line_key: 'allocated', product_id: 5, qty: 10, price_unit: 20, tax: 0, analytic_account_id: a.id },
    { purchase_line_key: 'unallocated', product_id: 5, qty: 10, price_unit: 100, tax: 0 },
  ] });
  const bill = create(po.db, 'account.move', { move_type: 'in_invoice', purchase_id: po.id, partner_id: 2, invoice_date: '2026-01-15', invoice_line_ids: [{ purchase_line_key: 'unallocated', product_id: 5, qty: 10, price_unit: 100, tax: 0 }] });
  const db = postMove(bill.db, bill.id);
  assert.equal(actual(db, b.id).committed, -200);
  const unlinked = create(po.db, 'account.move', { move_type: 'in_invoice', purchase_id: po.id, partner_id: 2, invoice_date: '2026-01-15', invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }] });
  const posted = postMove(unlinked.db, unlinked.id);
  const before = JSON.stringify(posted);
  assert.throws(() => actual(posted, b.id), /Link each posted bill line/);
  assert.equal(JSON.stringify(posted), before);
});

test('commitments honor company, line dates, explicit general accounts and foreign currency rates', () => {
  const a = create(seed(), 'account.analytic.account', { name: 'Currency purchases' });
  const expense = create(a.db, 'account.account', { name: 'Configured purchase expense', code: 'AUD-COST', account_type: 'expense' });
  const currency = create(expense.db, 'res.currency', { name: 'AUDIT', symbol: 'A', rate_ids: [{ date: '2026-01-01', rate: 2 }] });
  const company = createCompany(currency.db, { name: 'Other purchase company', currency_id: read(currency.db, 'res.company', 1).currency_id });
  const b = budget(company.db, a.id, { lines: [{ analytic_account_id: a.id, account_id: expense.id, date_from: '2026-01-10', date_to: '2026-01-20', planned: -100 }] });
  const orderVals = { state: 'purchase', partner_id: 2, company_id: 1, currency_id: currency.id, date_order: '2026-01-10', order_line: [{ product_id: 5, account_id: expense.id, qty: 2, price_unit: 100, tax: 0, analytic_account_id: a.id }] };
  let db = create(b.db, 'purchase.order', orderVals).db;
  db = create(db, 'purchase.order', { ...orderVals, date_order: '2026-01-09' }).db;
  db = create(db, 'purchase.order', { ...orderVals, company_id: company.id }).db;
  assert.equal(actual(db, b.id).committed, -100);
  assert.equal(budgetReport(db, b.id, '2026-01-31', { period: { to: '2026-01-09' } })[0].committed, 0);
  const noRate = write(db, 'res.currency', currency.id, { rate_ids: [] });
  assert.throws(() => actual(noRate, b.id), /exchange rate/);
});

test('migration gives company-less budgets the only company of a single-company database', async () => {
  const { migrate } = await import('./migrations.js');
  const company = { id: 7, name: 'Solo' };
  const single = migrate({ schema_version: 31, records: { 'res.company': [company], 'account.budget': [{ id: 1, name: 'B' }] } });
  assert.equal(single.records['account.budget'][0].company_id, 7);
  const multi = migrate({ schema_version: 31, records: { 'res.company': [company, { id: 8 }], 'account.budget': [{ id: 1, name: 'B' }] } });
  assert.equal(multi.records['account.budget'][0].company_id, undefined);
});
