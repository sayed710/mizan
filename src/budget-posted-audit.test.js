import test from 'node:test';
import assert from 'node:assert/strict';
import { invoiceJournalDefaults } from './test-support/accounting-company.js';
import './models/index.js';
import { create, search } from './orm.js';
import { seed } from './seed.js';
import { postMove } from './models/accounting.js';
import { budgetReport } from './models/analyticplus.js';
import { createCompany } from './models/company.js';

test('budget report uses posted analytic lines for each company and line period, with refund and drill-down', () => {
  let db = seed();
  const analytic = create(db, 'account.analytic.account', { name: 'Budget project' }); db = analytic.db;
  const company = createCompany(db, { name: 'Other company', ...invoiceJournalDefaults(db) }); db = company.db;
  const post = (type, date, amount, companyId) => {
    const move = create(db, 'account.move', { move_type: type, partner_id: 1, company_id: companyId, invoice_date: date,
      invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: amount, tax: 0, analytic_distribution: { [analytic.id]: 100 } }] });
    db = postMove(move.db, move.id);
    return move.id;
  };
  const invoice = post('out_invoice', '2026-01-10', 100, 1);
  const refund = post('out_refund', '2026-01-20', 30, 1);
  post('out_invoice', '2026-02-10', 200, 1);
  const otherInvoice = post('out_invoice', '2026-01-10', 500, company.id);
  db = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 1, company_id: 1, invoice_date: '2026-01-15',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 800, tax: 0, analytic_distribution: { [analytic.id]: 100 } }] }).db;
  const draft = create(db, 'account.move', { move_type: 'entry', company_id: 1, invoice_date: '2026-01-12' }); db = draft.db;
  db = create(db, 'account.analytic.line', { account_id: analytic.id, date: '2026-01-12', amount: 999, company_id: 1, move_id: draft.id }).db;
  const budget = create(db, 'account.budget', { name: 'Annual', company_id: 1, date_from: '2026-01-01', date_to: '2026-12-31', lines: [
    { analytic_account_id: analytic.id, date_from: '2026-01-01', date_to: '2026-01-31', planned: 100 },
  ] }); db = budget.db;
  const [row] = budgetReport(db, budget.id, '2026-01-31');
  assert.deepEqual([row.planned, row.practical, row.variance, row.achievement], [100, 70, -30, 70]);
  assert.deepEqual(row.analytic_lines.map((line) => line.move_id).sort(), [invoice, refund].sort());
  assert.equal(row.analytic_lines.every((line) => search(db, 'account.move').some((move) => move.id === line.move_id && move.state === 'posted')), true);
  assert.equal(budgetReport(db, budget.id, '2026-01-31', { period: { from: '2026-01-15', to: '2026-01-31' } })[0].practical, -30);
  assert.equal(budgetReport(db, budget.id, '2026-01-15')[0].achievement, 144.66);
  const otherBudget = create(db, 'account.budget', { name: 'Other', company_id: company.id, date_from: '2026-01-01', date_to: '2026-01-31', lines: [
    { analytic_account_id: analytic.id, planned: 1000 },
  ] });
  const [otherRow] = budgetReport(otherBudget.db, otherBudget.id, '2026-01-31');
  assert.equal(otherRow.practical, 500);
  assert.deepEqual(otherRow.analytic_lines.map((line) => line.move_id), [otherInvoice]);
});
