import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { models } from './models/index.js';
import { seed } from './seed.js';
import { accountId } from './models/ledger.js';
import { approveSheet, createSheet, postSheet, submitSheet } from './models/expenseplus.js';
import { openSession, payCart, priceLines, startSession } from './models/pos.js';

const date = '2026-06-01';

function expenseFixture() {
  let db = seed();
  const payable = accountId(db, '230100');
  db = write(db, 'account.account', payable, { account_type: 'liability_payable', company_id: 1 });
  db = write(db, 'res.company', 1, { account_default_payable_id: payable });
  const plan = create(db, 'account.analytic.plan', { name: 'Expense Cost Center', default_applicability: 'mandatory' });
  db = plan.db;
  const analytic = create(db, 'account.analytic.account', { name: 'Travel Cost Center', code: 'TRAVEL-CC', plan_id: plan.id });
  db = analytic.db;
  const product = create(db, 'product', { name: 'Taxi expense', type: 'service', property_account_expense_id: accountId(db, '610000') });
  db = product.db;
  const tax = search(db, 'account.tax').find((record) => record.type_tax_use === 'purchase' && record.amount === 14);
  return { db, analyticId: analytic.id, expenseAccountId: accountId(db, '610000'), taxId: tax.id, productId: product.id };
}

function createExpense(db, fixture, state, name) {
  return create(db, 'hr.expense', {
    name,
    employee_id: 2,
    company_id: 1,
    product_id: fixture.productId,
    date,
    state,
    category: 'travel',
    total_amount: 114,
    tax: 14,
    tax_id: fixture.taxId,
    analytic_account_id: fixture.analyticId,
  });
}

function assertExpenseAnalytics(db, expenseId, fixture) {
  const expense = read(db, 'hr.expense', expenseId);
  const move = read(db, 'account.move', expense.move_id);
  const debit = move.line_ids.find((line) => line.account_id === fixture.expenseAccountId && line.debit > 0);
  assert.deepEqual(debit.analytic_distribution, { [fixture.analyticId]: 100 });
  const analytics = search(db, 'account.analytic.line').filter((line) => line.move_id === move.id);
  assert.deepEqual(analytics.map(({ account_id, amount, category }) => ({ account_id, amount, category })), [
    { account_id: fixture.analyticId, amount: -100, category: 'journal_entry' },
  ]);
}

test('direct and approved-report expenses post their single analytic account as a distribution', () => {
  const fixture = expenseFixture();
  const postDirect = models['hr.expense'].form.buttons.find((button) => button.label === 'Post Journal Entries');
  const direct = createExpense(fixture.db, fixture, 'approved', 'Direct taxi');
  const directDb = postDirect.run(direct.db, read(direct.db, 'hr.expense', direct.id)).db;
  assertExpenseAnalytics(directDb, direct.id, fixture);

  const reported = createExpense(directDb, fixture, 'draft', 'Reported taxi');
  const report = createSheet(reported.db, [reported.id], { name: 'Approved taxi expenses' });
  const submitted = submitSheet(report.db, report.id);
  const approverId = read(submitted, 'hr.expense.sheet', report.id).manager_id;
  const approved = approveSheet(submitted, report.id, approverId);
  const posted = postSheet(approved, report.id, date);
  assertExpenseAnalytics(posted, reported.id, fixture);
});

test('POS checkout applies its product distribution model, validates mandatory plans, and posts analytic items', () => {
  let db = startSession(seed(), 100).db;
  const session = openSession(db);
  const plan = create(db, 'account.analytic.plan', {
    name: 'POS Revenue Allocation',
    default_applicability: 'optional',
    applicability_ids: [{ business_domain: 'general', account_prefix: '4', applicability: 'mandatory' }],
  });
  db = plan.db;
  const analytic = create(db, 'account.analytic.account', { name: 'Retail Channel', code: 'RETAIL-CC', plan_id: plan.id });
  db = analytic.db;

  assert.throws(() => payCart(db, { cart: [{ product_id: 1, qty: 1 }], method: 'cash', config_id: session.config_id }), /mandatory.*POS Revenue Allocation/);
  assert.equal(search(db, 'account.move').length, seed().records['account.move'].length);

  const distributionModel = create(db, 'account.analytic.distribution.model', {
    name: 'POS product allocation',
    company_id: session.company_id,
    product_id: 1,
    analytic_distribution: { [analytic.id]: 100 },
  });
  db = distributionModel.db;
  const priced = priceLines(db, [{ product_id: 1, qty: 1 }], null, { companyId: session.company_id, journalId: session.journal_id });
  assert.deepEqual(priced[0].analytic_distribution, { [analytic.id]: 100 });

  const paid = payCart(db, { cart: [{ product_id: 1, qty: 1 }], method: 'cash', config_id: session.config_id });
  const order = read(paid.db, 'pos.order', paid.id);
  const saleMove = read(paid.db, 'account.move', order.accounting_entries[0].move_id);
  const revenue = saleMove.line_ids.find((line) => line.credit > 0 && read(paid.db, 'account.account', line.account_id).account_type === 'income');
  assert.deepEqual(revenue.analytic_distribution, { [analytic.id]: 100 });
  const analyticLine = search(paid.db, 'account.analytic.line').find((line) => line.move_id === saleMove.id && line.account_id === analytic.id);
  assert.equal(analyticLine.amount, revenue.credit - revenue.debit);
  assert.equal(analyticLine.category, 'journal_entry');
});

test('direct expense posting rejects a missing allocation for a mandatory plan before returning a posted database', () => {
  const fixture = expenseFixture();
  const expense = createExpense(fixture.db, fixture, 'approved', 'Unallocated taxi');
  const unallocated = write(expense.db, 'hr.expense', expense.id, { analytic_account_id: null });
  const post = models['hr.expense'].form.buttons.find((button) => button.label === 'Post Journal Entries');
  const moveCount = search(unallocated, 'account.move').length;

  assert.throws(() => post.run(unallocated, read(unallocated, 'hr.expense', expense.id)), /mandatory.*Expense Cost Center/);
  assert.equal(search(unallocated, 'account.move').length, moveCount);
  assert.equal(read(unallocated, 'hr.expense', expense.id).state, 'approved');
});
