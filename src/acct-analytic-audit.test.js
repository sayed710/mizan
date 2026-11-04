import test from 'node:test';
import assert from 'node:assert/strict';
import './models/index.js';
import { create, read, search } from './orm.js';
import { seed } from './seed.js';
import { postMove } from './models/accounting.js';

test('posted journal entry allocates each plan with remainder on largest share', () => {
  let db = seed();
  const a = create(db, 'account.analytic.account', { name: 'Large' }); db = a.db;
  const b = create(db, 'account.analytic.account', { name: 'Small' }); db = b.db;
  const plan = create(db, 'account.analytic.plan', { name: 'Departments' }); db = plan.db;
  const c = create(db, 'account.analytic.account', { name: 'Department', plan_id: plan.id }); db = c.db;
  const accounts = search(db, 'account.account');
  const expense = accounts.find((x) => x.code === '600000');
  const cash = accounts.find((x) => x.account_type === 'asset_cash');
  const move = create(db, 'account.move', { move_type: 'entry', invoice_date: '2026-10-20', line_ids: [
    { account_id: expense.id, debit: 0.01, credit: 0, analytic_distribution: { [a.id]: 60, [b.id]: 40, [c.id]: 100 } },
    { account_id: cash.id, debit: 0, credit: 0.01 },
  ] });
  db = postMove(move.db, move.id);
  const lines = search(db, 'account.analytic.line').filter((line) => line.move_id === move.id);
  assert.deepEqual(lines.map((line) => [line.account_id, line.amount]), [[a.id, -0.01], [b.id, 0], [c.id, -0.01]]);
});

test('journal entry applies matching distribution rule without replacing manual allocation', () => {
  let db = seed();
  const a = create(db, 'account.analytic.account', { name: 'Rule' }); db = a.db;
  const b = create(db, 'account.analytic.account', { name: 'Manual' }); db = b.db;
  const account = search(db, 'account.account').find((x) => x.code === '600000');
  const cash = search(db, 'account.account').find((x) => x.account_type === 'asset_cash');
  db = create(db, 'account.analytic.distribution.model', { account_prefix: '600', company_id: 1, analytic_distribution: { [a.id]: 100 } }).db;
  const move = create(db, 'account.move', { move_type: 'entry', invoice_date: '2026-10-20', line_ids: [
    { account_id: account.id, debit: 10, credit: 0 },
    { account_id: account.id, debit: 5, credit: 0, analytic_distribution: { [b.id]: 100 } },
    { account_id: cash.id, debit: 0, credit: 15 },
  ] });
  db = postMove(move.db, move.id);
  assert.deepEqual(search(db, 'account.analytic.line').filter((line) => line.move_id === move.id).map((line) => [line.account_id, line.amount]), [[a.id, -10], [b.id, -5]]);
});

test('partner-only distribution applies to expenses but not bank journal items', () => {
  let db = seed();
  const analytic = create(db, 'account.analytic.account', { name: 'Rule target' }); db = analytic.db;
  const expense = search(db, 'account.account').find((a) => a.code === '600000');
  const bank = search(db, 'account.account').find((a) => a.code === '101401');
  db = create(db, 'account.analytic.distribution.model', { partner_id: 1, analytic_distribution: { [analytic.id]: 100 } }).db;
  const move = create(db, 'account.move', { move_type: 'entry', partner_id: 1, invoice_date: '2026-10-20', line_ids: [
    { account_id: expense.id, debit: 100 }, { account_id: bank.id, credit: 100 },
  ] });
  db = postMove(move.db, move.id);
  assert.deepEqual(search(db, 'account.analytic.line').filter((line) => line.move_id === move.id).map((line) => [line.account_id, line.amount]), [[analytic.id, -100]]);
  assert.equal(Object.hasOwn(read(db, 'account.move', move.id).line_ids[1], 'analytic_distribution'), false);
});

test('posted invoice assigns fractional-cent remainder to the largest analytic share', () => {
  let db = seed();
  const small = create(db, 'account.analytic.account', { name: 'Small' }); db = small.db;
  const large = create(db, 'account.analytic.account', { name: 'Large' }); db = large.db;
  const invoice = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_date: '2026-10-20', invoice_line_ids: [
    { product_id: 1, qty: 1, price_unit: 0.01, tax: 0, analytic_distribution: { [small.id]: 40, [large.id]: 60 } },
  ] });
  db = postMove(invoice.db, invoice.id);
  assert.deepEqual(search(db, 'account.analytic.line').filter((line) => line.move_id === invoice.id).map((line) => [line.account_id, line.amount]), [[small.id, 0], [large.id, 0.01]]);
});
