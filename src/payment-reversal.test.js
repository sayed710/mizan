import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from './orm.js';
import { models } from './models/index.js';
import { accountId, journalItems } from './models/ledger.js';
import { payMove, payWithDiscount, postMove } from './models/accounting.js';
import { postPayment } from './models/pay.js';
import { taxSnapshot } from './models/taxes.js';
import { seed } from './seed.js';
import { applyDiff, diffDb } from './sync.js';
import { reconcileWith } from './models/bank.js';
import { portalPayQuote } from '../server/portal.js';
import { postBatch } from './models/payments.js';

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

test('an unrelated bank reconciliation does not block reversing a matching manual payment', () => {
  const inv = invoice(seed(), 500);
  const manual = payMove(inv.db, inv.id, 250, '2026-03-07');
  const payment = search(manual, 'account.payment').find((p) => p.invoice_id === inv.id);
  const line = create(manual, 'account.bank.statement.line', { date: '2026-03-07', payment_ref: 'Bank portion', amount: 250, partner_id: 1 });
  const matched = reconcileWith(line.db, read(line.db, 'account.bank.statement.line', line.id), inv.id);
  const reversed = reverse(matched, payment.id);
  assert.equal(read(reversed, 'account.move', inv.id).amount_residual, 250);
  const bankPayment = search(matched, 'account.payment').find((p) => p.invoice_id === inv.id && p.id !== payment.id);
  assert.throws(() => reverse(matched, bankPayment.id), /reconciled bank transaction/);
});

test('legacy bank reconciliations without payment identity fail closed during reversal', () => {
  const inv = invoice(seed(), 100);
  const line = create(inv.db, 'account.bank.statement.line', { date: '2026-03-07', payment_ref: 'Legacy', amount: 100, partner_id: 1 });
  const matched = reconcileWith(line.db, read(line.db, 'account.bank.statement.line', line.id), inv.id);
  const legacy = { ...matched, records: { ...matched.records, 'account.bank.statement.line': matched.records['account.bank.statement.line'].map(({ payment_move_id, ...l }) => l) } };
  const payment = search(legacy, 'account.payment').find((p) => p.invoice_id === inv.id);
  assert.throws(() => reverse(legacy, payment.id), /reconciled bank transaction/);
});

test('reversing a discounted payment also reverses its discount and restores the receivable', () => {
  const term = create(seed(), 'account.payment.term', { name: '2% in ten days', early_discount: true, discount_percent: 2, discount_days: 10 });
  const inv = invoice(term.db, 100, { invoice_payment_term_id: term.id });
  const balance = balanceOf(inv.db, '121000');
  const paid = payWithDiscount(inv.db, inv.id, 98, '2026-03-05');
  const payment = search(paid, 'account.payment').find((p) => p.invoice_id === inv.id);
  assert.equal(read(paid, 'account.move', inv.id).amount_residual, 0);
  const reversed = reverse(paid, payment.id);
  assert.equal(read(reversed, 'account.move', inv.id).amount_residual, 100);
  assert.ok(read(reversed, 'account.move', inv.id).payments.every((p) => p.reversed));
  assert.equal(balanceOf(reversed, '121000'), balance);
  assert.equal(read(applyDiff(paid, diffDb(paid, reversed)), 'account.move', inv.id).amount_residual, 100);
});

test('reversing an order prepayment clears the stored payment state without undoing confirmation', () => {
  const sale = create(seed(), 'sale.order', { partner_id: 1, require_payment: true, order_line: [{ product_id: 7, qty: 1, price_unit: 100, tax: 0 }] });
  const paid = portalPayQuote(sale.db, read(sale.db, 'sale.order', sale.id), { MIZAN_DEMO_PAYMENTS: '1', NODE_ENV: 'test' });
  const payment = search(paid, 'account.payment').find((p) => p.sale_id === sale.id);
  assert.equal(read(paid, 'sale.order', sale.id).payment_state, 'paid');
  const reversed = reverse(paid, payment.id);
  assert.equal(read(reversed, 'sale.order', sale.id).amount_paid, 0);
  assert.equal(read(reversed, 'sale.order', sale.id).payment_state, 'pending');
  assert.equal(read(reversed, 'sale.order', sale.id).state, 'sale');
  const synced = applyDiff(paid, diffDb(paid, reversed));
  assert.equal(read(synced, 'sale.order', sale.id).amount_paid, 0);
  assert.equal(read(synced, 'sale.order', sale.id).payment_state, 'pending');
});

test('reversed outbound batch payments cancel their check lines while preserving posted history', () => {
  const bank = create(seed(), 'res.partner.bank', { partner_id: 1, account_number: 'REVERSE100', allow_out_payment: true });
  const bill = invoice(bank.db, 100, { move_type: 'in_invoice', force_post: true });
  const batch = create(bill.db, 'account.batch.payment', { batch_type: 'outbound', check_number_start: 100, lines: [{ move_id: bill.id, amount: 100 }] });
  const paid = postBatch(batch.db, read(batch.db, 'account.batch.payment', batch.id));
  const payment = search(paid, 'account.payment').find((p) => p.invoice_id === bill.id);
  const reversed = reverse(paid, payment.id);
  const history = read(reversed, 'account.batch.payment', batch.id);
  assert.equal(history.state, 'posted');
  assert.equal(history.lines[0].payment_id, payment.id);
  assert.equal(history.lines[0].cancelled, true);
  const synced = applyDiff(paid, diffDb(paid, reversed));
  assert.equal(read(synced, 'account.batch.payment', batch.id).lines[0].cancelled, true);
});
