import test from 'node:test';
import assert from 'node:assert/strict';
import { models } from './models/index.js';
import { create, read } from './orm.js';
import { seed } from './seed.js';
import { postMove } from './models/accounting.js';
import { budgetReport } from './models/analyticplus.js';

test('budget line achieved and committed include posted analytic activity', () => {
  let db = seed();
  const analytic = create(db, 'account.analytic.account', { name: 'Project' }); db = analytic.db;
  const move = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 1, company_id: 1, invoice_date: '2026-01-10',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0, analytic_distribution: { [analytic.id]: 100 } }] });
  db = postMove(move.db, move.id);
  const budget = create(db, 'account.budget', { name: 'Annual', budget_type: 'both', company_id: 1, date_from: '2026-01-01', date_to: '2026-12-31',
    lines: [{ analytic_account_id: analytic.id, planned: 200 }] });
  const [line] = budgetReport(budget.db, budget.id, '2026-01-31');
  assert.equal(line.achieved_amount, 100);
  assert.equal(line.committed_amount, 100);
  const purchase = create(budget.db, 'purchase.order', { partner_id: 2, date_order: '2026-01-10',
    order_line: [{ product_id: 5, qty: 1, price_unit: 40, tax: 0, analytic_distribution: { [analytic.id]: 100 } }] });
  const confirm = models['purchase.order'].form.buttons.find((button) => button.label === 'Confirm Order');
  db = confirm.run(purchase.db, read(purchase.db, 'purchase.order', purchase.id)).db;
  const [withPurchase] = budgetReport(db, budget.id, '2026-01-31');
  assert.equal(withPurchase.achieved_amount, 100);
  assert.equal(withPurchase.committed_amount, 60);
});

for (const [type, expected] of [['expense', 100], ['revenue', -100], ['both', -100]]) {
  test(`${type} budget signs achieved and committed amounts`, () => {
    let db = seed();
    const analytic = create(db, 'account.analytic.account', { name: 'Project' }); db = analytic.db;
    const move = create(db, 'account.move', { move_type: 'in_invoice', partner_id: 2, company_id: 1, invoice_date: '2026-01-10',
      invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0, analytic_distribution: { [analytic.id]: 100 } }] });
    db = postMove(move.db, move.id);
    const budget = create(db, 'account.budget', { name: 'Annual', budget_type: type, company_id: 1, date_from: '2026-01-01', date_to: '2026-12-31',
      lines: [{ analytic_account_id: analytic.id, planned: 200 }] });
    const [line] = budgetReport(budget.db, budget.id, '2026-01-31');
    assert.equal(line.achieved_amount, expected);
    assert.equal(line.committed_amount, expected);
    if (type === 'both') {
      const legacy = { ...budget.db, records: { ...budget.db.records, 'account.budget': budget.db.records['account.budget'].map((record) => {
        if (record.id !== budget.id) return record;
        const { budget_type: _budgetType, ...rest } = record;
        return rest;
      }) } };
      assert.equal(budgetReport(legacy, budget.id, '2026-01-31')[0].achieved_amount, expected);
    }
    const purchase = create(budget.db, 'purchase.order', { partner_id: 2, date_order: '2026-01-10',
      order_line: [{ product_id: 5, qty: 1, price_unit: 40, tax: 0, analytic_distribution: { [analytic.id]: 100 } }] });
    const confirm = models['purchase.order'].form.buttons.find((button) => button.label === 'Confirm Order');
    db = confirm.run(purchase.db, read(purchase.db, 'purchase.order', purchase.id)).db;
    assert.equal(budgetReport(db, budget.id, '2026-01-31')[0].committed_amount, expected * 1.4);
  });
}

test('new budgets default to expense', () => {
  const created = create(seed(), 'account.budget', { name: 'New' });
  assert.equal(read(created.db, 'account.budget', created.id).budget_type, 'expense');
});
