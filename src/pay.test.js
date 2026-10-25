import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from './orm.js';
import { models } from './models/index.js';
import { accountId, isBalanced } from './models/ledger.js';
import { payMove, postMove } from './models/accounting.js';
import { postPayment } from './models/pay.js';
import { seed } from './seed.js';

const post = (db, vals) => {
  const { db: next, id } = create(db, 'account.move', { partner_id: 2, invoice_date: '2026-04-01', invoice_date_due: '2026-04-30', invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }], ...vals });
  return { db: postMove(next, id), id };
};

test('a vendor refund reduces the payable and the vendor paying it back brings cash in', () => {
  const { db, id } = post(seed(), { move_type: 'in_refund' });
  const refund = read(db, 'account.move', id);
  assert.match(refund.name, /^RBILL\//);
  assert.equal(refund.line_ids.find((l) => l.account_id === accountId(db, '211000')).debit, 100);
  const paid = payMove(db, id, 100, '2026-04-05');
  const entry = read(paid, 'account.move', read(paid, 'account.move', id).payments[0].move_id);
  assert.equal(entry.line_ids.find((l) => l.account_id === accountId(paid, '101401')).debit, 100);
  assert.equal(read(paid, 'account.move', id).payment_state, 'paid');
});

test('a credit note refunded to the customer pays cash out against the receivable', () => {
  const { db, id } = post(seed(), { move_type: 'out_refund', partner_id: 1 });
  const paid = payMove(db, id, 100, '2026-04-05');
  const entry = read(paid, 'account.move', read(paid, 'account.move', id).payments[0].move_id);
  assert.equal(entry.line_ids.find((l) => l.account_id === accountId(paid, '121000')).debit, 100);
  assert.equal(entry.line_ids.find((l) => l.account_id === accountId(paid, '101401')).credit, 100);
});

test('the credit note button reverses a bill into a vendor refund', () => {
  const { db, id } = post(seed(), { move_type: 'in_invoice' });
  const button = models['account.move'].form.buttons.find((b) => b.label === 'Credit Note');
  const { db: next, go } = button.run(db, read(db, 'account.move', id));
  assert.match(go, /refunds/);
  assert.equal(search(next, 'account.move').at(-1).move_type, 'in_refund');
});

test('registering a payment on an invoice also records a posted payment', () => {
  const { db, id } = post(seed(), { move_type: 'out_invoice', partner_id: 1 });
  const paid = payMove(db, id, 40, '2026-04-02');
  const payment = search(paid, 'account.payment').at(-1);
  assert.equal(payment.state, 'posted');
  assert.equal(payment.amount, 40);
  assert.equal(payment.invoice_id, id);
  assert.match(payment.name, /^PBNK1\/2026\//);
});

test('a manual customer payment settles open invoices oldest due first and keeps the rest as credit', () => {
  const fresh = create(seed(), 'res.partner', { name: 'New Client' });
  const a = post(fresh.db, { move_type: 'out_invoice', partner_id: fresh.id, invoice_date_due: '2026-05-30' });
  const b = post(a.db, { move_type: 'out_invoice', partner_id: fresh.id, invoice_date_due: '2026-05-01' });
  const { db, id } = create(b.db, 'account.payment', { partner_id: fresh.id, amount: 150, date: '2026-05-10', payment_type: 'inbound', partner_type: 'customer' });
  const done = postPayment(db, read(db, 'account.payment', id));
  assert.equal(read(done, 'account.move', b.id).payment_state, 'paid');
  assert.equal(read(done, 'account.move', a.id).amount_residual, 50);
  const payment = read(done, 'account.payment', id);
  assert.equal(payment.state, 'posted');
  assert.equal(payment.unapplied, 0);
  assert.ok(isBalanced(read(done, 'account.move', payment.move_id).line_ids));
  const extra = create(done, 'account.payment', { partner_id: fresh.id, amount: 80, payment_type: 'inbound', partner_type: 'customer' });
  assert.equal(read(postPayment(extra.db, read(extra.db, 'account.payment', extra.id)), 'account.payment', extra.id).unapplied, 30);
  assert.throws(() => postPayment(done, payment), /draft/);
});

test('a payment through the cash journal books on the cash account', () => {
  const { db, id } = post(seed(), { move_type: 'out_invoice', partner_id: 1 });
  const cash = search(db, 'account.journal').find((j) => j.code === 'CSH1');
  const paid = payMove(db, id, 100, '2026-04-03', { journalId: cash.id });
  const entry = read(paid, 'account.move', read(paid, 'account.move', id).payments[0].move_id);
  assert.equal(entry.line_ids.find((l) => l.debit).account_id, accountId(paid, '101501'));
  assert.match(search(paid, 'account.payment').at(-1).name, /^PCSH1\//);
});
