import test from 'node:test';
import assert from 'node:assert/strict';
import './models/index.js';
import { create, read, search } from './orm.js';
import { seed } from './seed.js';
import { postMove } from './models/accounting.js';
import { journalItems } from './models/ledger.js';
import { budgetReport } from './models/analyticplus.js';

test('invoice journal items retain distinct analytic distributions', () => {
  let db = seed();
  const a = create(db, 'account.analytic.account', { name: 'A' }); db = a.db;
  const b = create(db, 'account.analytic.account', { name: 'B' }); db = b.db;
  const invoice = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_date: '2026-01-10', invoice_line_ids: [
    { product_id: 1, qty: 1, price_unit: 10, tax: 0, analytic_distribution: { [a.id]: 100 } },
    { product_id: 1, qty: 1, price_unit: 20, tax: 0, analytic_distribution: { [b.id]: 100 } },
  ] });
  db = postMove(invoice.db, invoice.id);
  const items = read(db, 'account.move', invoice.id).line_ids.filter((l) => l.invoice_sources?.length);
  assert.deepEqual(items.map((l) => [l.credit, l.analytic_distribution]), [[10, { [a.id]: 100 }], [20, { [b.id]: 100 }]]);
  assert.deepEqual(search(db, 'account.analytic.line').filter((l) => l.move_id === invoice.id).map((l) => [l.account_id, l.amount]), [[a.id, 10], [b.id, 20]]);
});

test('mandatory plan applies to expense but not bank counterpart', () => {
  let db = seed();
  const plan = create(db, 'account.analytic.plan', { name: 'Mandatory', default_applicability: 'mandatory' }); db = plan.db;
  const a = create(db, 'account.analytic.account', { name: 'A', plan_id: plan.id }); db = a.db;
  const expense = search(db, 'account.account').find((x) => x.account_type === 'expense');
  const bank = search(db, 'account.account').find((x) => x.account_type === 'asset_cash');
  const entry = create(db, 'account.move', { move_type: 'entry', invoice_date: '2026-01-10', line_ids: [{ account_id: expense.id, debit: 10 }, { account_id: bank.id, credit: 10 }] });
  assert.throws(() => postMove(entry.db, entry.id), /mandatory analytic plan/);
  const allocated = create(db, 'account.move', { move_type: 'entry', invoice_date: '2026-01-10', line_ids: [{ account_id: expense.id, debit: 10, analytic_distribution: { [a.id]: 100 } }, { account_id: bank.id, credit: 10 }] });
  db = postMove(allocated.db, allocated.id);
  assert.deepEqual(search(db, 'account.analytic.line').filter((l) => l.move_id === allocated.id).map((l) => l.amount), [-10]);
});

test('bill analytic actuals follow accounting date and budget period', () => {
  let db = seed();
  const a = create(db, 'account.analytic.account', { name: 'A' }); db = a.db;
  const bill = create(db, 'account.move', { move_type: 'in_invoice', partner_id: 1, invoice_date: '2026-01-10', date: '2026-02-10', invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 30, tax: 0, analytic_distribution: { [a.id]: 100 } }] });
  db = postMove(bill.db, bill.id);
  assert.equal(journalItems(db, { from: '2026-02-01', to: '2026-02-28' }).some((l) => l.move_id === bill.id), true);
  assert.equal(search(db, 'account.analytic.line').find((l) => l.move_id === bill.id).date, '2026-02-10');
  const budget = create(db, 'account.budget', { name: 'February', company_id: 1, date_from: '2026-02-01', date_to: '2026-02-28', lines: [{ analytic_account_id: a.id, planned: -30 }] });
  assert.equal(budgetReport(budget.db, budget.id, '2026-02-28')[0].practical, -30);
});
