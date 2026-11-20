import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { models } from './models/index.js';
import { defaultPaymentJournalId } from './models/ledger.js';
import { paymentState, payMove, postMove, purchaseInvoiceView, residual, salesInvoiceView } from './models/accounting.js';
import { unapplyPaymentCredit } from './models/pay.js';
import { applyDiff, diffDb } from './sync.js';

const postDoc = (db, vals = {}) => {
  const { db: next, id } = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: 2, invoice_date: '2026-05-01', invoice_date_due: '2026-05-30',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }], ...vals,
  });
  return { db: postMove(next, id), id };
};
// Overwrites stored fields directly, the way a legacy or forged record would carry them.
const patch = (db, id, changes) => ({ ...db, records: { ...db.records, 'account.move': db.records['account.move'].map((m) => (m.id === id ? { ...m, ...changes } : m)) } });
const withDocs = (amounts, move_type = 'out_invoice') => amounts.reduce((acc, amount) => {
  const doc = postDoc(acc.db, { move_type, invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: amount, tax: 0 }] });
  return { db: doc.db, ids: [...acc.ids, doc.id] };
}, { db: seed(), ids: [] });
const open = (db, id) => residual(read(db, 'account.move', id), db);
const paymentOf = (db, docId, index = 0) => search(db, 'account.payment').find((p) => p.move_id === read(db, 'account.move', docId).payments[index].move_id);
const listAction = (view) => view.listActions.find((a) => a.label === 'Register Payment');
const values = (db, extra = {}) => ({ date: '2026-05-10', journal_id: defaultPaymentJournalId(db, 1), ...extra });

// ---------------------------------------------------------------------------
// PAY-6: group payments from the invoice and bill lists
// ---------------------------------------------------------------------------
test('PAY-6: both lists offer a Register Payment action that needs a selection', () => {
  for (const view of [salesInvoiceView, purchaseInvoiceView]) {
    const action = listAction(view);
    assert.ok(action, 'Register Payment list action');
    assert.equal(action.requiresSelection, true);
  }
});

test('PAY-6: the Group Payments toggle shows only for more than one selected document', () => {
  const { db, ids } = withDocs([100, 100]);
  const action = listAction(salesInvoiceView);
  const names = (spec) => spec.fields.map((f) => f.name);
  assert.ok(names(action.wizard(db, ids)).includes('group_payment'));
  assert.ok(!names(action.wizard(db, [ids[0]])).includes('group_payment'));
  assert.ok(['date', 'journal_id'].every((n) => names(action.wizard(db, ids)).includes(n)));
});

test('PAY-6: grouping on pays each partner\'s documents with one payment', () => {
  const partner = create(seed(), 'res.partner', { name: 'Second customer' });
  const a = postDoc(partner.db, { invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }] });
  const b = postDoc(a.db, { invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 200, tax: 0 }] });
  const c = postDoc(b.db, { partner_id: partner.id, invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 50, tax: 0 }] });
  const before = search(c.db, 'account.payment').length;
  const { db } = listAction(salesInvoiceView).run(c.db, [a.id, b.id, c.id], values(c.db, { group_payment: true }));
  assert.equal(search(db, 'account.payment').length - before, 2, 'one payment for partner 2, one for the new partner');
  for (const id of [a.id, b.id, c.id]) assert.equal(open(db, id), 0);
  const [rowA] = read(db, 'account.move', a.id).payments;
  const [rowB] = read(db, 'account.move', b.id).payments;
  assert.equal(rowA.move_id, rowB.move_id, 'same payment entry for both documents of one partner');
  assert.notEqual(read(db, 'account.move', c.id).payments[0].move_id, rowA.move_id);
  const payment = paymentOf(db, a.id);
  assert.equal(payment.amount, 300);
  assert.equal(payment.state, 'posted');
  assert.equal(Number(payment.unapplied) || 0, 0);
  assert.equal(payment.journal_id, defaultPaymentJournalId(c.db, 1));
});

test('PAY-6: grouping off pays every document with its own payment', () => {
  const { db: base, ids } = withDocs([100, 200]);
  const before = search(base, 'account.payment').length;
  const { db } = listAction(salesInvoiceView).run(base, ids, values(base, { group_payment: false }));
  assert.equal(search(db, 'account.payment').length - before, 2);
  assert.deepEqual(ids.map((id) => open(db, id)), [0, 0]);
  assert.notEqual(read(db, 'account.move', ids[0]).payments[0].move_id, read(db, 'account.move', ids[1]).payments[0].move_id);
  assert.deepEqual(ids.map((id) => paymentOf(db, id).amount), [100, 200]);
});

test('PAY-6: vendor bills are grouped the same way and result in outbound payments', () => {
  const { db: base, ids } = withDocs([70, 30], 'in_invoice');
  const { db } = listAction(purchaseInvoiceView).run(base, ids, values(base, { group_payment: true }));
  assert.deepEqual(ids.map((id) => open(db, id)), [0, 0]);
  const payment = paymentOf(db, ids[0]);
  assert.equal(payment.payment_type, 'outbound');
  assert.equal(payment.amount, 100);
  assert.equal(read(db, 'account.move', ids[0]).payments[0].move_id, read(db, 'account.move', ids[1]).payments[0].move_id);
});

test('PAY-6: only the open balance is paid for a partly paid document', () => {
  const { db: base, ids } = withDocs([100, 100]);
  const partly = payMove(base, ids[0], 40, '2026-05-05');
  const { db } = listAction(salesInvoiceView).run(partly, ids, values(partly, { group_payment: true }));
  assert.deepEqual(ids.map((id) => paymentState(read(db, 'account.move', id), db)), ['paid', 'paid']);
  assert.equal(paymentOf(db, ids[0], 1).amount, 160);
});

test('PAY-6: a mixed selection is refused with a clear message, in the wizard and on run', () => {
  const invoice = postDoc(seed());
  const bill = postDoc(invoice.db, { move_type: 'in_invoice' });
  const action = listAction(salesInvoiceView);
  assert.throws(() => action.wizard(bill.db, [invoice.id, bill.id]), /Customer invoices and vendor bills cannot be paid together/);
  assert.throws(() => action.run(bill.db, [invoice.id, bill.id], values(bill.db)), /Customer invoices and vendor bills cannot be paid together/);
  assert.equal(open(bill.db, invoice.id), 100);
});

test('PAY-6: documents of different companies are refused', () => {
  const { db, ids } = withDocs([100, 100]);
  const other = patch(db, ids[1], { company_id: 2 });
  assert.throws(() => listAction(salesInvoiceView).wizard(other, ids), /different companies/);
  assert.throws(() => listAction(salesInvoiceView).run(other, ids, values(other)), /different companies/);
});

test('PAY-6: drafts, cancelled and fully paid documents are refused', () => {
  const { db, ids } = withDocs([100, 100]);
  const action = listAction(salesInvoiceView);
  const draft = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 2, invoice_date: '2026-05-01', invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 10, tax: 0 }] });
  assert.throws(() => action.run(draft.db, [ids[0], draft.id], values(draft.db)), /Only posted invoices and bills can be paid/);
  const cancelled = patch(db, ids[1], { state: 'cancel' });
  assert.throws(() => action.wizard(cancelled, ids), /Only posted invoices and bills can be paid/);
  const paid = payMove(db, ids[1], 100, '2026-05-05');
  assert.throws(() => action.wizard(paid, ids), /fully paid/);
  assert.throws(() => action.run(paid, ids, values(paid)), /fully paid/);
  assert.throws(() => action.run(db, [], values(db)), /Select posted invoices or bills/);
});

test('PAY-6: credit notes alone or with zero/negative net are refused, in wizard and on run', () => {
  const refund = postDoc(seed(), { move_type: 'out_refund' });
  const action = listAction(salesInvoiceView);
  assert.throws(() => action.wizard(refund.db, [refund.id]), /net payment amount must be greater than zero/);
  assert.throws(() => action.run(refund.db, [refund.id], values(refund.db)), /net payment amount must be greater than zero/);

  // Equal invoice and credit note
  const inv = postDoc(seed(), { invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }] });
  const cn = postDoc(inv.db, { move_type: 'out_refund', invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }] });
  assert.throws(() => action.wizard(cn.db, [inv.id, cn.id]), /net payment amount must be greater than zero/);
  assert.throws(() => action.run(cn.db, [inv.id, cn.id], values(cn.db)), /net payment amount must be greater than zero/);

  // Credit note greater than invoice
  const invSmall = postDoc(seed(), { invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 40, tax: 0 }] });
  const cnBig = postDoc(invSmall.db, { move_type: 'out_refund', invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }] });
  assert.throws(() => action.wizard(cnBig.db, [invSmall.id, cnBig.id]), /net payment amount must be greater than zero/);
  assert.throws(() => action.run(cnBig.db, [invSmall.id, cnBig.id], values(cnBig.db)), /net payment amount must be greater than zero/);
});

test('PAY-6: credit notes with grouping disabled are refused', () => {
  const inv = postDoc(seed(), { invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }] });
  const cn = postDoc(inv.db, { move_type: 'out_refund', invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 30, tax: 0 }] });
  const action = listAction(salesInvoiceView);
  assert.throws(() => action.run(cn.db, [inv.id, cn.id], values(cn.db, { group_payment: false })), /Credit notes can only be paid when Group Payments is enabled/);
});

test('PAY-6: grouping customer invoice and credit note nets them and pays the net balance', () => {
  const inv = postDoc(seed(), { invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }] });
  const cn = postDoc(inv.db, { move_type: 'out_refund', invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 30, tax: 0 }] });
  const before = search(cn.db, 'account.payment').length;
  const { db } = listAction(salesInvoiceView).run(cn.db, [inv.id, cn.id], values(cn.db, { group_payment: true }));
  assert.equal(search(db, 'account.payment').length - before, 1, 'exactly one payment registered for the net amount');
  assert.equal(open(db, inv.id), 0, 'invoice is fully paid');
  assert.equal(open(db, cn.id), 0, 'credit note is fully allocated');
  const payment = paymentOf(db, inv.id, 1);
  assert.equal(payment.amount, 70, 'payment covers the net balance (100 - 30)');
  assert.equal(payment.payment_type, 'inbound');
  assert.equal(Number(payment.unapplied) || 0, 0);
  assert.equal(read(db, 'account.move', inv.id).payments[0].move_id, cn.id, 'first settlement is the credit note');
  assert.equal(read(db, 'account.move', inv.id).payments[0].amount, 30);
});

test('PAY-6: grouping vendor bills and refunds nets them and registers one outbound payment', () => {
  const bill = postDoc(seed(), { move_type: 'in_invoice', invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 200, tax: 0 }] });
  const ref = postDoc(bill.db, { move_type: 'in_refund', invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 50, tax: 0 }] });
  const before = search(ref.db, 'account.payment').length;
  const { db } = listAction(purchaseInvoiceView).run(ref.db, [bill.id, ref.id], values(ref.db, { group_payment: true }));
  assert.equal(search(db, 'account.payment').length - before, 1);
  assert.equal(open(db, bill.id), 0);
  assert.equal(open(db, ref.id), 0);
  const payment = paymentOf(db, bill.id, 1);
  assert.equal(payment.amount, 150, 'covers net (200 - 50)');
  assert.equal(payment.payment_type, 'outbound');
  assert.equal(Number(payment.unapplied) || 0, 0);
});

test('PAY-6: grouping multiple partner groups nets each partner\'s credit notes independently', () => {
  const partnerB = create(seed(), 'res.partner', { name: 'Customer PAY-6-B' });
  const invA1 = postDoc(partnerB.db, { partner_id: 2, invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }] });
  const cnA = postDoc(invA1.db, { partner_id: 2, move_type: 'out_refund', invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 25, tax: 0 }] });
  const invB = postDoc(cnA.db, { partner_id: partnerB.id, invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 150, tax: 0 }] });
  const cnB = postDoc(invB.db, { partner_id: partnerB.id, move_type: 'out_refund', invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 50, tax: 0 }] });
  const before = search(cnB.db, 'account.payment').length;
  const { db } = listAction(salesInvoiceView).run(cnB.db, [invA1.id, cnA.id, invB.id, cnB.id], values(cnB.db, { group_payment: true }));
  assert.equal(search(db, 'account.payment').length - before, 2, 'one payment per partner group');
  for (const id of [invA1.id, cnA.id, invB.id, cnB.id]) assert.equal(open(db, id), 0);
  assert.equal(paymentOf(db, invA1.id, 1).amount, 75);
  assert.equal(paymentOf(db, invB.id, 1).amount, 100);
});

// ---------------------------------------------------------------------------
// PAY-12: unreconcile one applied payment from the invoice form
// ---------------------------------------------------------------------------
const widget = () => models['account.move'].form.appliedPayments;
const paymentsTab = () => models['account.move'].form.tabs({ move_type: 'out_invoice' }).find((t) => t.label === 'Payments');
const twoPayments = () => {
  const { db, id } = postDoc(seed());
  return { id, db: payMove(payMove(db, id, 60, '2026-05-10'), id, 40, '2026-05-11') };
};

test('PAY-12: the payments tab lists each applied payment with an unreconcile action', () => {
  const { db, id } = twoPayments();
  assert.equal(paymentsTab().widget, 'appliedPayments');
  const rows = widget().list(db, read(db, 'account.move', id));
  assert.deepEqual(rows.map((r) => r.amount), [60, 40]);
  assert.equal(widget().unreconcileLabel, 'Unreconcile');
  assert.deepEqual(widget().list(db, { ...read(db, 'account.move', id), state: 'draft' }), []);
});

test('PAY-12: unreconcile removes only that payment\'s matching and keeps the payment posted', () => {
  const { db, id } = twoPayments();
  const invoice = read(db, 'account.move', id);
  const [first, second] = widget().list(db, invoice);
  const payment = paymentOf(db, id, 0);
  const { db: next } = widget().unreconcile(db, invoice, first);
  assert.equal(open(next, id), 60);
  assert.equal(paymentState(read(next, 'account.move', id), next), 'partial');
  assert.equal(read(next, 'account.payment', payment.id).state, 'posted');
  assert.equal(read(next, 'account.payment', payment.id).unapplied, 60);
  assert.deepEqual(widget().list(next, read(next, 'account.move', id)).map((r) => r.id), [second.id]);
  // The same change is accepted from a plain diff.
  assert.doesNotThrow(() => applyDiff(db, diffDb(db, next), { isAdmin: false }));
  // Removing the last one leaves the invoice not paid.
  const last = widget().unreconcile(next, read(next, 'account.move', id), second).db;
  assert.equal(paymentState(read(last, 'account.move', id), last), 'not_paid');
  assert.deepEqual(widget().list(last, read(last, 'account.move', id)), []);
});

test('PAY-12: an unknown or already removed application is refused', () => {
  const { db, id } = twoPayments();
  const invoice = read(db, 'account.move', id);
  const [first] = widget().list(db, invoice);
  assert.throws(() => widget().unreconcile(db, invoice, { ...first, move_id: 999999, line_index: null }), /Select one active application/);
  const next = widget().unreconcile(db, invoice, first).db;
  assert.throws(() => widget().unreconcile(next, read(next, 'account.move', id), first), /Select one active application/);
});

test('PAY-12: a locked period refuses the unreconcile, also on a plain diff', () => {
  const { db, id } = twoPayments();
  const invoice = read(db, 'account.move', id);
  const [first] = widget().list(db, invoice);
  const unlocked = widget().unreconcile(db, invoice, first).db;
  const locked = write(db, 'res.company', 1, { lock_date: '2026-05-31' });
  assert.throws(() => widget().unreconcile(locked, read(locked, 'account.move', id), first), /locked/);
  // A forged client change set that skips the helper is stopped by the stored guards.
  const forged = { ...locked, records: { ...locked.records, 'account.move': unlocked.records['account.move'], 'account.payment': unlocked.records['account.payment'] } };
  assert.throws(() => applyDiff(locked, diffDb(locked, forged), { isAdmin: false }), /locked/);
  // Lock dates never apply to the stored database of the open period.
  assert.equal(open(locked, id), 0);
});

test('PAY-12: unreconciling keeps the payment bank match and its posted batch, and reopens the invoice', () => {
  const { db, id } = twoPayments();
  const invoice = read(db, 'account.move', id);
  const [first] = widget().list(db, invoice);
  const payment = paymentOf(db, id, 0);
  const bank = create(db, 'account.bank.statement.line', {
    journal_id: payment.journal_id, date: '2026-05-11', payment_ref: 'Bank line', amount: 60, state: 'reconciled', move_id: payment.move_id, payment_move_id: payment.move_id,
  });
  const batch = create(bank.db, 'account.batch.payment', {
    batch_type: 'inbound', journal_id: payment.journal_id, state: 'posted', lines: [{ payment_id: payment.id, amount: 60, cancelled: false }],
  });
  const next = widget().unreconcile(batch.db, read(batch.db, 'account.move', id), first).db;
  assert.equal(read(next, 'account.bank.statement.line', bank.id).state, 'reconciled');
  assert.equal(read(next, 'account.batch.payment', batch.id).state, 'posted');
  assert.equal(read(next, 'account.payment', payment.id).state, 'posted');
  assert.equal(open(next, id), 60);
});

test('PAY-12: the form action reuses the shared unapplication, not a second implementation', () => {
  const { db, id } = twoPayments();
  const invoice = read(db, 'account.move', id);
  const [first] = widget().list(db, invoice);
  const viaForm = widget().unreconcile(db, invoice, first).db;
  const direct = unapplyPaymentCredit(db, id, first.move_id, '2026-11-30', { lineIndex: null });
  const strip = (d) => read(d, 'account.move', id).payments.map(({ reversal_date: _, ...row }) => row);
  assert.deepEqual(strip(viaForm), strip(direct));
  assert.equal(read(viaForm, 'account.move', id).amount_paid, read(direct, 'account.move', id).amount_paid);
});
