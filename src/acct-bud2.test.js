import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { models } from './models/index.js';
import { create, read, write } from './orm.js';
import { seed } from './seed.js';
import { postMove } from './models/accounting.js';
import { budgetReport } from './models/analyticplus.js';
import { migrate } from './migrations.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

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

test('migration fills budget_type: both on legacy budgets and allows status changes', () => {
  const seeded = seed();
  const legacyRecord = {
    id: 991,
    name: 'Legacy 2025',
    company_id: 1,
    state: 'draft',
    date_from: '2025-01-01',
    date_to: '2025-12-31',
    lines: [],
  };
  const unmigrated = {
    ...seeded,
    schema_version: 66,
    records: {
      ...seeded.records,
      'account.budget': [...(seeded.records['account.budget'] ?? []), legacyRecord],
    },
  };
  // Before migration, writing or confirming throws because budget_type is missing
  assert.throws(() => write(unmigrated, 'account.budget', 991, { state: 'confirmed' }), /Budget Type is required/);

  // Migrating upgrades database to schema_version 68 and fills budget_type: 'both'
  const upgraded = migrate(unmigrated);
  assert.equal(upgraded.schema_version, 75);
  assert.equal(read(upgraded, 'account.budget', 991).budget_type, 'both');

  // Status transition on migrated budget succeeds
  const confirmed = write(upgraded, 'account.budget', 991, { state: 'confirmed' });
  assert.equal(read(confirmed, 'account.budget', 991).state, 'confirmed');
});

