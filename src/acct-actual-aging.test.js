import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, search } from './orm.js';
import { seed } from './seed.js';
import { postMove, payMove } from './models/accounting.js';
import { reversePayment } from './models/pay.js';
import { analyticActuals, agedBalance } from './models/finance.js';
import { budgetReport } from './models/analyticplus.js';

test('analytic actuals and budgets include posted distributions, refunds and manual items with filters', () => {
  let db = seed();
  const a = create(db, 'account.analytic.account', { name: 'A' });
  const b = create(a.db, 'account.analytic.account', { name: 'B' }); db = b.db;
  const post = (type, date, value) => {
    const m = create(db, 'account.move', { move_type: type, partner_id: 1, invoice_date: date, invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: value, tax: 0, analytic_distribution: { [a.id]: 60, [b.id]: 40 } }] });
    db = postMove(m.db, m.id);
  };
  post('out_invoice', '2026-01-02', 100);
  assert.equal(analyticActuals(db, { from: '2026-01-01', to: '2026-01-31' }).get(a.id), 60);
  post('in_invoice', '2026-01-03', 100);
  assert.deepEqual([analyticActuals(db).get(a.id), analyticActuals(db).get(b.id)], [0, 0]);
  post('out_refund', '2026-01-04', 50);
  assert.deepEqual([analyticActuals(db).get(a.id), analyticActuals(db).get(b.id)], [-30, -20]);
  db = create(db, 'account.analytic.line', { name: 'Manual', date: '2026-01-05', account_id: a.id, amount: 10, general_account: '400000', company_id: 1 }).db;
  db = create(db, 'account.analytic.line', { name: 'Outside', date: '2026-02-01', account_id: a.id, amount: 999, company_id: 1 }).db;
  const period = { from: '2026-01-01', to: '2026-01-31', company_id: 1 };
  assert.deepEqual([analyticActuals(db, period).get(a.id), analyticActuals(db, period).get(b.id)], [-20, -20]);
  assert.equal(analyticActuals(db, { ...period, general_account: '400' }).get(a.id), 40);
  const budget = create(db, 'account.budget', { name: 'Budget', date_from: period.from, date_to: period.to, company_id: 1, lines: [{ analytic_account_id: a.id, general_account: '400', planned: 100 }] }); db = budget.db;
  assert.equal(budgetReport(db, budget.id, '2026-01-31')[0].practical, 40);
});

test('aged balances reconstruct payments and reversals at the cutoff for customers and vendors', () => {
  let db = seed();
  for (const [type, kind, partner] of [['out_invoice', 'receivable', 1], ['in_invoice', 'payable', 2]]) {
    const m = create(db, 'account.move', { move_type: type, partner_id: partner, invoice_date: '2026-01-01', invoice_date_due: '2026-01-01', invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }] });
    db = postMove(m.db, m.id); db = payMove(db, m.id, 100, '2026-01-20');
    const row = (date) => agedBalance(db, kind, date).rows.find((r) => r.partner_id === partner)?.total ?? 0;
    assert.equal(row('2025-12-31'), 0);
    assert.equal(row('2026-01-10'), 100);
    assert.equal(row('2026-01-20'), 0);
    const payment = search(db, 'account.payment').find((p) => p.invoice_id === m.id);
    db = reversePayment(db, payment, '2026-01-25');
    assert.equal(row('2026-01-22'), 0);
    assert.equal(row('2026-01-25'), 100);
  }
});

test('aged balances apply dated credit notes and allocate installments in due-date order', () => {
  let db = seed();
  const term = create(db, 'account.payment.term', { name: 'Two installments', line_ids: [
    { value_type: 'percent', value: 50, nb_days: 0, delay_type: 'days_after' },
    { value_type: 'percent', value: 50, nb_days: 30, delay_type: 'days_after' },
  ] }); db = term.db;
  const inv = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_date: '2026-01-01', invoice_payment_term_id: term.id, invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }] });
  db = postMove(inv.db, inv.id);
  const note = create(db, 'account.move', { move_type: 'out_refund', partner_id: 1, reversed_entry_id: inv.id, invoice_date: '2026-01-20', invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 30, tax: 0 }] });
  db = postMove(note.db, note.id);
  const earlier = agedBalance(db, 'receivable', '2026-01-10').rows.find((r) => r.partner_id === 1);
  assert.equal(earlier.total, 100);
  assert.equal(earlier.current, 50);
  const after = agedBalance(db, 'receivable', '2026-01-21').rows.find((r) => r.partner_id === 1);
  assert.equal(after.total, 70);
  assert.equal(after.current, 50);
  assert.equal(after['1_30'], 20);
});


