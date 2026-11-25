import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { models } from './models/index.js';
import { postMove, purchaseInvoiceView, salesInvoiceView } from './models/accounting.js';
import { defaultPaymentJournalId } from './models/ledger.js';
import { journalMethodLines } from './models/paymentmethod.js';
import { registerPayments } from './models/pay.js';

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

test('RP-3 foreign-currency payments allocate remaining invoice document cash using currency-aware routine', () => {
  let db = seed();
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  db = write(db, 'res.currency', eur.id, { rate_ids: [{ date: '2026-01-01', rate: 2.0 }] });
  const inv1 = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 2, currency_id: eur.id, invoice_date: '2026-05-01', invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }] });
  db = postMove(inv1.db, inv1.id);
  const inv2 = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 2, currency_id: eur.id, invoice_date: '2026-05-01', invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }] });
  db = postMove(inv2.db, inv2.id);

  const result = registerPayments(db, [inv1.id, inv2.id], { date: '2026-05-10', journal_id: defaultPaymentJournalId(db, 1) }).db;
  assert.equal(read(result, 'account.move', inv1.id).payment_state, 'paid');
  assert.equal(read(result, 'account.move', inv2.id).payment_state, 'paid');
});

test('RP-4 list wizard default amount accounts for credit note application on discounted bills', () => {
  let db = seed();
  const term = create(db, 'account.payment.term', {
    name: '2/10 Net 30',
    early_discount: true,
    discount_percent: 2,
    discount_days: 10,
    line_ids: [{ value_type: 'percent', value: 100, nb_days: 30, delay_type: 'days_after' }],
  });
  db = term.db;
  const d = '2026-05-01';
  const inv = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 2, invoice_date: d, invoice_payment_term_id: term.id, invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }] });
  db = postMove(inv.db, inv.id);
  const credit = create(db, 'account.move', { move_type: 'out_refund', partner_id: 2, invoice_date: d, invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 20, tax: 0 }] });
  db = postMove(credit.db, credit.id);

  const wiz = action(salesInvoiceView).wizard(db, [inv.id, credit.id]);
  const defaultAmt = wiz.fields.find((f) => f.name === 'amount').default;
  assert.equal(defaultAmt, '80');

  const result = action(salesInvoiceView).run(db, [inv.id, credit.id], {
    amount: defaultAmt,
    date: '2026-05-05',
    journal_id: defaultPaymentJournalId(db, 1),
    group_payment: true,
  }).db;
  assert.equal(read(result, 'account.move', inv.id).amount_residual, 0);
  assert.equal(read(result, 'account.move', credit.id).amount_residual, 0);
});

test('RP-5 wizard amount is hidden when multiple payments result', () => {
  const a = doc(seed()); const b = doc(a.db);
  const partner = create(b.db, 'res.partner', { name: 'Another customer' });
  const c = doc(partner.db, 'out_invoice', partner.id);
  const single = action(salesInvoiceView).wizard(c.db, [a.id, b.id]);
  const singleAmt = single.fields.find((f) => f.name === 'amount');
  assert.equal(singleAmt.invisible({ group_payment: true }), false);
  assert.equal(singleAmt.invisible({ group_payment: false }), true);

  const multiple = action(salesInvoiceView).wizard(c.db, [a.id, b.id, c.id]);
  const multAmt = multiple.fields.find((f) => f.name === 'amount');
  assert.equal(multAmt.invisible({ group_payment: true }), true);
  assert.equal(multAmt.invisible({ group_payment: false }), true);
  assert.equal(multAmt.default, '');
});

test('RP-6 registerPayment rejects archived payment method lines', () => {
  const bill = doc(seed(), 'in_invoice');
  const journal = defaultPaymentJournalId(bill.db, 1);
  const methods = journalMethodLines(bill.db, journal, 'outbound');
  const check = methods.find((m) => read(bill.db, 'account.payment.method', m.payment_method_id)?.code === 'check_printing');
  assert.ok(check);
  const archivedDb = write(bill.db, 'account.payment.method.line', check.id, { active: false });

  assert.throws(
    () => button.run(archivedDb, read(archivedDb, 'account.move', bill.id), { amount: 100, date: '2026-05-10', journal_id: journal, payment_method_line_id: check.id }),
    /archived/i
  );
});
