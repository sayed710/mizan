import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, unlink, write } from './orm.js';
import { models } from './models/index.js';
import { applyDiff } from './sync.js';
import { payMove, payWithDiscount } from './models/accounting.js';
import { accountId, isBalanced, journalItems } from './models/ledger.js';
import { today } from './models/common.js';
import { seed } from './seed.js';

const button = (label) => models['account.move'].form.buttons.find((b) => b.label === label);
const invoice = (db, vals = {}) => {
  const { db: next, id } = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 3, invoice_date: '2026-04-01', invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 1210, tax: 0 }], ...vals });
  return { db: button('Confirm').run(next, read(next, 'account.move', id)).db, id };
};
const receivable = (db, partner) => journalItems(db).filter((l) => l.account_id === accountId(db, '121000') && l.partner_id === partner)
  .reduce((s, l) => s + l.debit - l.credit, 0);

test('the entry that pays an invoice cannot be reset to draft or deleted', () => {
  const { db, id } = invoice(seed());
  const paid = payMove(db, id, 1210, '2026-04-05');
  const entry = read(paid, 'account.move', read(paid, 'account.move', id).payments[0].move_id);
  assert.equal(button('Reset to Draft').when(entry, paid), false);
  assert.throws(() => write(paid, 'account.move', entry.id, { state: 'draft' }), /settles an invoice payment/);
  assert.throws(() => unlink(paid, 'account.move', [entry.id]), /tied to a payment|Posted entries cannot be deleted/);
  assert.throws(() => write(paid, 'account.move', id, { state: 'cancel' }), /Paid invoices|Posted entries go back to draft/);
});

test('the paid amount must match the recorded payments, also through the server', () => {
  const { db, id } = invoice(seed());
  assert.throws(() => write(db, 'account.move', id, { amount_paid: 1210 }), /recorded payments/);
  const move = read(db, 'account.move', id);
  assert.throws(() => applyDiff(db, { upserts: { 'account.move': [{ ...move, amount_paid: 1210 }] } }), /recorded payments/);
  assert.throws(() => applyDiff(db, { upserts: { 'account.move': [{ ...move, amount_paid: 5000, payments: [{ date: today(), amount: 5000, move_id: null }] }] } }), /exceed the invoice total/);
});

test('paying more than the amount due keeps the excess as an outstanding credit in the books', () => {
  const { db, id } = invoice(seed());
  const before = receivable(db, 3);
  const paid = payMove(db, id, 1710, '2026-04-05');
  const inv = read(paid, 'account.move', id);
  assert.equal(inv.amount_paid, 1210);
  assert.equal(inv.payment_state, 'paid');
  const entry = read(paid, 'account.move', inv.payments[0].move_id);
  assert.equal(entry.line_ids.find((l) => l.account_id === accountId(paid, '101401')).debit, 1710);
  assert.equal(Math.round((receivable(paid, 3) - before) * 100) / 100, -1710);
  const payment = search(paid, 'account.payment').find((p) => p.move_id === entry.id);
  assert.equal(payment.amount, 1710);
  assert.equal(payment.unapplied, 500);
});

test('an early-payment discount is recorded with the payments', () => {
  const db0 = seed();
  const term = search(db0, 'account.payment.term').find((t) => t.name === '2/7 Net 30').id;
  const { db, id } = invoice(db0, { invoice_payment_term_id: term, invoice_date: today(), invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }] });
  const inv = read(payWithDiscount(db, id, 98), 'account.move', id);
  assert.equal(inv.amount_paid, 100);
  assert.deepEqual(inv.payments.map((p) => p.amount), [98, 2]);
  assert.equal(inv.payments[1].discount, true);
});

import { diffDb } from './sync.js';

test('lowering the total of a paid invoice below what was paid is refused', () => {
  const { db, id } = invoice(seed());
  const paid = payMove(db, id, 1210, '2026-04-05');
  assert.throws(() => write(paid, 'account.move', id, { invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }] }), /cannot exceed the invoice total|Posted entries cannot be edited/);
  const move = read(paid, 'account.move', id);
  assert.throws(() => applyDiff(paid, { upserts: { 'account.move': [{ ...move, invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }] }] } }), /cannot exceed the invoice total|Posted entries cannot be edited/);
});

test('the lines of a payment entry cannot be rewritten once an invoice records it', () => {
  const { db, id } = invoice(seed());
  const paid = payMove(db, id, 1210, '2026-04-05');
  const entry = read(paid, 'account.move', read(paid, 'account.move', id).payments[0].move_id);
  const cheaper = entry.line_ids.map((l) => ({ ...l, debit: l.debit ? 1 : 0, credit: l.credit ? 1 : 0 }));
  assert.throws(() => write(paid, 'account.move', entry.id, { line_ids: cheaper }), /settles an invoice payment and cannot be changed|Posted entries cannot be edited/);
});

test('payment rows keep their entry link and new ones must point at a posted entry', () => {
  const { db, id } = invoice(seed());
  const paid = payMove(db, id, 600, '2026-04-05');
  const move = read(paid, 'account.move', id);
  assert.throws(() => write(paid, 'account.move', id, { payments: move.payments.map((p) => ({ ...p, move_id: null })) }), /cannot be removed or re-linked/);
  assert.throws(() => write(paid, 'account.move', id, { amount_paid: 1200, payments: [...move.payments, { date: today(), amount: 600, move_id: null }] }), /posted journal entry/);
  assert.throws(() => write(paid, 'account.move', id, { amount_paid: 1200, payments: [...move.payments, { date: today(), amount: 600, move_id: 987654 }] }), /posted journal entry/);
});

test('an early-payment discount marker survives the server round trip, in any order of the change set', () => {
  const db0 = seed();
  const term = search(db0, 'account.payment.term').find((t) => t.name === '2/7 Net 30').id;
  const { db, id } = invoice(db0, { invoice_payment_term_id: term, invoice_date: today(), invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }] });
  const diff = diffDb(db, payWithDiscount(db, id, 98));
  diff.upserts['account.move'].reverse(); // the invoice may arrive before the entries it points at
  const stored = applyDiff(db, diff, { isAdmin: false });
  assert.equal(read(stored, 'account.move', id).payments[1].discount, true);
});

test('a foreign overpayment keeps one rounded bank amount and books the outstanding credit in company currency', () => {
  const db0 = seed();
  const fx = create(db0, 'res.currency', { name: 'FXR', rate_ids: [{ date: '2026-01-01', rate: 0.6 }] });
  const { db, id } = invoice(fx.db, { currency_id: fx.id, invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 0.01, tax: 0 }] });
  const paid = payMove(db, id, 0.02, '2026-04-05');
  const inv = read(paid, 'account.move', id);
  const entry = read(paid, 'account.move', inv.payments[0].move_id);
  const bank = entry.line_ids.find((l) => l.account_id === accountId(paid, '101401'));
  assert.equal(bank.debit, 0.03); // 0.02 / 0.6 converted once, not 0.02 + 0.01 rounded separately
  const payment = search(paid, 'account.payment').find((p) => p.move_id === entry.id);
  assert.equal(payment.unapplied, 0.01); // the credit line of the entry, in company currency
  assert.ok(isBalanced(entry.line_ids));
});

test('a legacy invoice with drifted amount_paid can be paid further', () => {
  const { db: seeded, id } = invoice(seed());
  const legacy = {
    ...seeded,
    records: {
      ...seeded.records,
      'account.move': seeded.records['account.move'].map((m) => (m.id === id ? { ...m, amount_paid: 500, payments: [] } : m)),
    },
  };
  const paid = payMove(legacy, id, 200, '2026-04-05');
  const inv = read(paid, 'account.move', id);
  assert.equal(inv.amount_paid, 700);
  assert.equal(inv.payments.length, 1);
  assert.equal(inv.payments[0].amount, 200);
});
