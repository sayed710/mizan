import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from './orm.js';
import { models } from './models/index.js';
import { accountId, journalItems } from './models/ledger.js';
import { payMove, postMove } from './models/accounting.js';
import { postPayment } from './models/pay.js';
import { taxSnapshot } from './models/taxes.js';
import { seed } from './seed.js';
import { applyDiff, diffDb } from './sync.js';

const reverse = (db, id) => models['account.payment'].form.buttons.find((b) => b.label === 'Reverse').run(db, read(db, 'account.payment', id)).db;
const balanceOf = (db, code) => Math.round(journalItems(db).filter((l) => l.account_id === accountId(db, code)).reduce((s, l) => s + l.debit - l.credit, 0) * 100) / 100;
const invoice = (db, price, vals = {}) => {
  const { db: next, id } = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_date: '2026-03-01', invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: price, discount: 0, tax: 0 }], ...vals });
  return { db: postMove(next, id), id };
};

test('reversing an invoice payment posts a mirror entry and makes the invoice due again (FLOW-017)', () => {
  const { db, id } = invoice(seed(), 500);
  const receivable = balanceOf(db, '121000');
  const paid = payMove(db, id, 500, '2026-03-05');
  const payment = search(paid, 'account.payment').find((p) => p.invoice_id === id);
  assert.equal(read(paid, 'account.move', id).amount_residual, 0);

  const reversed = reverse(paid, payment.id);
  const inv = read(reversed, 'account.move', id);
  assert.equal(inv.amount_residual, 500);
  assert.equal(inv.payments.length, 1);
  assert.equal(inv.payments[0].reversed, true);
  assert.equal(read(reversed, 'account.payment', payment.id).state, 'reversed');
  assert.equal(balanceOf(reversed, '121000'), receivable);
  const mirror = search(reversed, 'account.move').find((m) => m.ref === `Reversal of ${read(paid, 'account.move', payment.move_id).name}`);
  assert.ok(mirror && mirror.state === 'posted');
  const synced = applyDiff(paid, diffDb(paid, reversed));
  assert.equal(read(synced, 'account.move', id).amount_residual, 500);
  assert.throws(() => applyDiff(paid, { upserts: { 'account.move': [{ ...read(paid, 'account.move', id), amount_paid: 0, payments: [{ ...inv.payments[0], reversal_move_id: null }] }] } }), /reversing journal entry/);
  assert.throws(() => reverse(reversed, payment.id), /Only posted payments|not available/);
});

test('a payment applied to several invoices reopens each of them', () => {
  const first = invoice(seed(), 300, { invoice_date_due: '2026-03-10' });
  const second = invoice(first.db, 200, { invoice_date_due: '2026-03-20' });
  const { db: drafted, id } = create(second.db, 'account.payment', { partner_id: 1, amount: 450, payment_type: 'inbound', partner_type: 'customer', date: '2026-03-25' });
  const posted = postPayment(drafted, read(drafted, 'account.payment', id));
  assert.equal(read(posted, 'account.move', second.id).amount_residual, 50);
  const reversed = reverse(posted, id);
  assert.equal(read(reversed, 'account.move', first.id).amount_residual, 300);
  assert.equal(read(reversed, 'account.move', second.id).amount_residual, 200);
});

test('cash-basis tax released by the payment goes back to the transition account', () => {
  const base = seed();
  const tax = search(base, 'account.tax').find((t) => t.name === 'VAT 14% (Cash Basis)' && t.type_tax_use === 'sale');
  const { db: next, id } = create(base, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_date: '2026-03-01', invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 1000, discount: 0, ...taxSnapshot(tax) }] });
  const db = postMove(next, id);
  const transition = balanceOf(db, '251100');
  const paid = payMove(db, id, 1140, '2026-03-10');
  assert.equal(balanceOf(paid, '251100'), transition + 140);
  const payment = search(paid, 'account.payment').find((p) => p.invoice_id === id);
  assert.equal(balanceOf(reverse(paid, payment.id), '251100'), transition);
});

test('a payment made by a bank reconciliation is not reversed from the payment form', () => {
  const { db, id } = invoice(seed(), 250);
  const { db: lined, id: lineId } = create(db, 'account.bank.statement.line', { date: '2026-03-07', payment_ref: 'INV', amount: 250, partner_id: 1 });
  const matched = models['account.bank.statement.line'].form.buttons.find((b) => b.label === 'Reconcile').run(lined, read(lined, 'account.bank.statement.line', lineId)).db;
  const payment = search(matched, 'account.payment').find((p) => p.invoice_id === id);
  assert.throws(() => reverse(matched, payment.id), /reconciled bank transaction/);
});
