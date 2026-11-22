import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from './orm.js';
import { seed } from './seed.js';
import { models } from './models/index.js';
import { postMove, purchaseInvoiceView, salesInvoiceView } from './models/accounting.js';
import { defaultPaymentJournalId } from './models/ledger.js';
import { journalMethodLines } from './models/paymentmethod.js';

const doc = (db, type = 'out_invoice', partner = 2) => {
  const made = create(db, 'account.move', { move_type: type, partner_id: partner, invoice_date: '2026-05-01', invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }] });
  return { db: postMove(made.db, made.id), id: made.id };
};
const button = models['account.move'].form.buttons.find((b) => b.label === 'Register Payment');
const action = (view) => view.listActions.find((a) => a.label === 'Register Payment');

test('RP-1 method selection follows journal and direction and creates a check payment', () => {
  const bill = doc(seed(), 'in_invoice');
  const journal = defaultPaymentJournalId(bill.db, 1);
  const methods = journalMethodLines(bill.db, journal, 'outbound');
  const check = methods.find((m) => read(bill.db, 'account.payment.method', m.payment_method_id)?.code === 'check_printing');
  assert.ok(check);
  const wizard = button.wizard(bill.db, read(bill.db, 'account.move', bill.id));
  const field = wizard.fields.find((f) => f.name === 'payment_method_line_id');
  assert.equal(field.default, methods[0].id);
  assert.ok(field.domain(check, { journal_id: journal }));
  assert.ok(!field.domain(journalMethodLines(bill.db, journal, 'inbound')[0], { journal_id: journal }));
  const result = button.run(bill.db, read(bill.db, 'account.move', bill.id), { amount: 100, date: '2026-05-10', journal_id: journal, payment_method_line_id: check.id }).db;
  assert.equal(search(result, 'account.payment').find((p) => p.invoice_id === bill.id).payment_method_line_id, check.id);
});

test('RP-2 list amount is editable only for one resulting payment', () => {
  const a = doc(seed()); const b = doc(a.db);
  const partner = create(b.db, 'res.partner', { name: 'Another customer' });
  const c = doc(partner.db, 'out_invoice', partner.id);
  const grouped = action(salesInvoiceView).wizard(c.db, [a.id, b.id]);
  const amount = grouped.fields.find((f) => f.name === 'amount');
  assert.equal(amount.readonly({ group_payment: true }), false);
  assert.equal(amount.readonly({ group_payment: false }), true);
  const multiple = action(salesInvoiceView).wizard(c.db, [a.id, b.id, c.id]);
  assert.equal(multiple.fields.find((f) => f.name === 'amount').readonly({ group_payment: true }), true);
  assert.ok(action(purchaseInvoiceView));
});

test('RP-2 grouped edited amount creates one partial payment; ungrouped pays each residual', () => {
  const a = doc(seed()); const b = doc(a.db);
  const list = action(salesInvoiceView);
  const values = { date: '2026-05-10', journal_id: defaultPaymentJournalId(b.db, 1) };
  const partial = list.run(b.db, [a.id, b.id], { ...values, group_payment: true, amount: '150' }).db;
  const payments = search(partial, 'account.payment').filter((p) => p.invoice_id === a.id);
  assert.equal(payments.at(-1).amount, 150);
  assert.equal(read(partial, 'account.move', b.id).payments[0].amount, 50);
  const separate = list.run(b.db, [a.id, b.id], { ...values, group_payment: false, amount: '1' }).db;
  assert.equal(search(separate, 'account.payment').filter((p) => [a.id, b.id].includes(p.invoice_id)).length, 2);
});

test('RP-1 list propagates the chosen outbound method', () => {
  const a = doc(seed(), 'in_invoice'); const b = doc(a.db, 'in_invoice');
  const journal = defaultPaymentJournalId(b.db, 1);
  const check = journalMethodLines(b.db, journal, 'outbound').find((m) => read(b.db, 'account.payment.method', m.payment_method_id)?.code === 'check_printing');
  const list = action(purchaseInvoiceView);
  const field = list.wizard(b.db, [a.id, b.id]).fields.find((f) => f.name === 'payment_method_line_id');
  assert.ok(field.domain(check, { journal_id: journal }));
  const result = list.run(b.db, [a.id, b.id], { date: '2026-05-10', journal_id: journal, payment_method_line_id: check.id }).db;
  assert.equal(search(result, 'account.payment').find((p) => p.invoice_id === a.id).payment_method_line_id, check.id);
});

test('RP-2 edited amount nets credit notes before allocating payment', () => {
  const a = doc(seed()); const b = doc(a.db); const credit = doc(b.db, 'out_refund');
  const result = action(salesInvoiceView).run(credit.db, [a.id, b.id, credit.id], {
    date: '2026-05-10', journal_id: defaultPaymentJournalId(credit.db, 1), group_payment: true, amount: '50',
  }).db;
  assert.equal(read(result, 'account.move', a.id).payments[0].amount, 100);
  assert.equal(read(result, 'account.move', b.id).payments[0].amount, 50);
  assert.equal(search(result, 'account.payment').find((p) => p.invoice_id === b.id).amount, 50);
});
