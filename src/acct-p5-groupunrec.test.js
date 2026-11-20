import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { models } from './models/index.js';
import { defaultPaymentJournalId, journalItemIdentity } from './models/ledger.js';
import { applyCreditNote, paymentState, payMove, postMove, purchaseInvoiceView, residual, salesInvoiceView } from './models/accounting.js';
import { applyPaymentCredit, postPayment, unapplyPaymentCredit } from './models/pay.js';
import { reconcileLedgerItems } from './models/glReconcile.js';
import { applyDiff, diffDb } from './sync.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

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

// ---------------------------------------------------------------------------
// Bug 1: A payment row matched through Journal Items carries partial_reconcile_id
// ---------------------------------------------------------------------------
test('Bug 1: invoice Unreconcile removes partial_reconcile_id match through Journal Items unreconciliation', () => {
  const invoice = postDoc(seed(), { invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }] });
  const draftPay = create(invoice.db, 'account.payment', {
    partner_id: 2, company_id: 1, journal_id: defaultPaymentJournalId(invoice.db, 1),
    amount: 150, date: '2026-05-10', payment_type: 'inbound', partner_type: 'customer',
  });
  const postedPayDb = postPayment(draftPay.db, read(draftPay.db, 'account.payment', draftPay.id));
  const postedPay = read(postedPayDb, 'account.payment', draftPay.id);
  const ar = read(postedPayDb, 'res.company', 1).account_default_receivable_id;
  const inv2 = postDoc(postedPayDb, { invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 50, tax: 0 }] });

  // Match 3 items via reconcileLedgerItems so delegatesToJournalItems is false and partial_reconcile records are created
  const sel = (db, moveId) => {
    const m = read(db, 'account.move', moveId);
    const idx = m.line_ids.findIndex((l) => l.account_id === ar);
    return { move_id: moveId, line_index: idx, line_identity: journalItemIdentity(m.line_ids[idx]) };
  };
  const matchedDb = reconcileLedgerItems(inv2.db, [
    sel(inv2.db, invoice.id),
    sel(inv2.db, inv2.id),
    sel(inv2.db, postedPay.move_id),
  ], { date: '2026-05-10' });

  const invDoc = read(matchedDb, 'account.move', invoice.id);
  const [payRow] = invDoc.payments;
  assert.ok(payRow.partial_reconcile_id, 'must carry partial_reconcile_id from Journal Items matching');
  const partialBefore = read(matchedDb, 'account.partial.reconcile', payRow.partial_reconcile_id);
  assert.equal(partialBefore.active, true);

  // Unreconcile from invoice tab
  const { db: unrecDb } = widget().unreconcile(matchedDb, invDoc, payRow);
  const partialAfter = read(unrecDb, 'account.partial.reconcile', payRow.partial_reconcile_id);
  assert.equal(partialAfter.active, false, 'partial record must be deactivated');
  assert.equal(partialAfter.reversed, true, 'partial record must be marked reversed');
  assert.equal(open(unrecDb, invoice.id), 100, 'invoice must be open again');
  assert.equal(paymentState(read(unrecDb, 'account.move', invoice.id), unrecDb), 'not_paid');
  assert.equal(read(unrecDb, 'account.payment', postedPay.id).state, 'posted');
  assert.equal(read(unrecDb, 'account.payment', postedPay.id).unapplied, 100);
});

// ---------------------------------------------------------------------------
// Bug 2: Grouped Register Payment honours early-payment discounts
// ---------------------------------------------------------------------------
test('Bug 2: grouped register payment honours early-payment discounts and pays only net cash', () => {
  let db = seed();
  const discAccount = create(db, 'account.account', { name: 'Early discount expense', code: '690000', account_type: 'expense', company_id: 1 });
  db = write(discAccount.db, 'res.company', 1, { expense_early_payment_discount_account_id: discAccount.id });
  const term = create(db, 'account.payment.term', {
    name: '2% 10 days',
    early_discount: true,
    discount_percent: 2,
    discount_days: 10,
    discount_tax_computation: 'excluded',
  });
  db = term.db;
  const docA = postDoc(db, { invoice_date: '2026-05-01', invoice_payment_term_id: term.id, invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }] });
  const docB = postDoc(docA.db, { invoice_date: '2026-05-01', invoice_payment_term_id: term.id, invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 200, tax: 0 }] });

  // Invoices: 100 (discount 2, cash 98) and 200 (discount 4, cash 196). Net cash = 294.
  const before = search(docB.db, 'account.payment').length;
  const { db: paidDb } = listAction(salesInvoiceView).run(docB.db, [docA.id, docB.id], values(docB.db, { date: '2026-05-05', group_payment: true }));

  assert.equal(search(paidDb, 'account.payment').length - before, 1, 'exactly one payment registered for group');
  const payment = paymentOf(paidDb, docA.id);
  assert.equal(payment.amount, 294, 'payment amount pays only the net cash (98 + 196)');
  assert.equal(payment.state, 'posted');
  assert.equal(Number(payment.unapplied) || 0, 0);

  for (const id of [docA.id, docB.id]) {
    assert.equal(open(paidDb, id), 0);
    assert.equal(paymentState(read(paidDb, 'account.move', id), paidDb), 'paid');
  }
  const paymentsA = read(paidDb, 'account.move', docA.id).payments;
  const discA = paymentsA.find((p) => p.discount);
  assert.ok(discA, 'invoice A records discount settlement');
  assert.equal(discA.amount, 2);
  assert.equal(discA.payment_move_id, payment.move_id);

  const paymentsB = read(paidDb, 'account.move', docB.id).payments;
  const discB = paymentsB.find((p) => p.discount);
  assert.ok(discB, 'invoice B records discount settlement');
  assert.equal(discB.amount, 4);
  assert.equal(discB.payment_move_id, payment.move_id);
});

// ---------------------------------------------------------------------------
// Bug 3: Two separate applications of the same payment to the same invoice
// ---------------------------------------------------------------------------
test('Bug 3: two separate applications of the same payment to the same invoice are unreconcilable on their own', () => {
  const inv = postDoc(seed(), { invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }] });
  const draft = create(inv.db, 'account.payment', {
    partner_id: 2, company_id: 1, journal_id: defaultPaymentJournalId(inv.db, 1),
    amount: 100, date: '2026-05-01', payment_type: 'inbound', partner_type: 'customer',
  });
  const paidDb = postPayment(draft.db, read(draft.db, 'account.payment', draft.id));
  const payId = draft.id;

  // Apply 40, then 60 from the same payment
  const step1 = applyPaymentCredit(paidDb, payId, inv.id, '2026-05-05', 40);
  const step2 = applyPaymentCredit(step1, payId, inv.id, '2026-05-06', 60);

  const invoice = read(step2, 'account.move', inv.id);
  const rows = widget().list(step2, invoice);
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].id, rows[1].id, 'each row must have a distinct stable identity');

  // Unreconcile the first row (40)
  const { db: afterFirst } = widget().unreconcile(step2, invoice, rows[0]);
  assert.equal(open(afterFirst, inv.id), 40);
  assert.equal(paymentState(read(afterFirst, 'account.move', inv.id), afterFirst), 'partial');
  assert.equal(read(afterFirst, 'account.payment', payId).unapplied, 40);
  const remainingRows = widget().list(afterFirst, read(afterFirst, 'account.move', inv.id));
  assert.equal(remainingRows.length, 1);
  assert.equal(remainingRows[0].id, rows[1].id);
  assert.equal(remainingRows[0].amount, 60);

  // Unreconcile the second row (60)
  const { db: afterSecond } = widget().unreconcile(afterFirst, read(afterFirst, 'account.move', inv.id), remainingRows[0]);
  assert.equal(open(afterSecond, inv.id), 100);
  assert.equal(paymentState(read(afterSecond, 'account.move', inv.id), afterSecond), 'not_paid');
  assert.equal(read(afterSecond, 'account.payment', payId).unapplied, 100);
  assert.deepEqual(widget().list(afterSecond, read(afterSecond, 'account.move', inv.id)), []);
});

// ---------------------------------------------------------------------------
// Bug 4: Payments tab shows ONE table with Unreconcile control on unreconcilable rows
// ---------------------------------------------------------------------------
test('Bug 4: Payments tab shows ONE table with unreconcile button only on active unreconcilable rows', async () => {
  const { setupDom, find } = await import('./test-support/dom.js');
  const { initStore, commit } = await import('./store.js');
  const { FormView } = await import('./views/FormView.jsx');
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');

  const { makeEl } = setupDom();
  globalThis.document.createElementNS = (namespace, tag) => makeEl(tag);
  await initStore();

  let db = seed();
  const discAccount = create(db, 'account.account', { name: 'Early discount expense', code: '690000', account_type: 'expense', company_id: 1 });
  db = write(discAccount.db, 'res.company', 1, { expense_early_payment_discount_account_id: discAccount.id });
  const term = create(db, 'account.payment.term', {
    name: '2% 10 days',
    early_discount: true,
    discount_percent: 2,
    discount_days: 10,
    discount_tax_computation: 'excluded',
  });
  db = term.db;
  const doc = postDoc(db, { invoice_date: '2026-05-01', invoice_payment_term_id: term.id, invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }] });

  // Pay with discount so we have a cash payment row and a discount row
  const { db: paidDb } = listAction(salesInvoiceView).run(doc.db, [doc.id], values(doc.db, { date: '2026-05-05' }));

  const host = globalThis.document.createElement('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  const props = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];

  try {
    await React.act(async () => {
      await commit(paidDb);
      root.render(React.createElement(FormView, {
        leaf: { model: 'account.move' },
        id: doc.id,
        base: '#/accounting/customer-invoices',
        params: new URLSearchParams('view=form'),
      }));
    });

    const findAll = (node, predicate, acc = []) => {
      if (!node) return acc;
      if (predicate(node)) acc.push(node);
      for (const child of node.childNodes ?? []) findAll(child, predicate, acc);
      return acc;
    };

    // Click Payments tab
    const tabs = findAll(host, (n) => n.tagName === 'BUTTON' && props(n)?.role === 'tab');
    const paymentsTabBtn = tabs.find((t) => t.textContent === 'Payments');
    assert.ok(paymentsTabBtn, 'Payments tab button must exist');
    await React.act(async () => props(paymentsTabBtn).onClick());

    const panel = find(host, (n) => n.className === 'tab-panel');
    assert.ok(panel);
    const tables = findAll(panel, (n) => n.tagName === 'TABLE');
    assert.equal(tables.length, 1, 'Payments tab must show ONE table, no second table');

    const unrecBtnList = findAll(panel, (n) => n.tagName === 'BUTTON' && n.textContent === 'Unreconcile');
    assert.equal(unrecBtnList.length, 1, 'only active payment row gets Unreconcile button, discount row does not');
  } finally {
    await React.act(async () => root.unmount());
  }
});

// ---------------------------------------------------------------------------
// Bug 5: Credit-note settlement rows must not show Unreconcile action
// ---------------------------------------------------------------------------
test('Bug 5: credit-note settlement rows do not get Unreconcile action', () => {
  const inv = postDoc(seed(), { invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }] });
  const cn = postDoc(inv.db, { move_type: 'out_refund', invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 30, tax: 0 }] });
  const settledDb = applyCreditNote(cn.db, cn.id, inv.id, '2026-05-10', 30);

  const invDoc = read(settledDb, 'account.move', inv.id);
  assert.equal(invDoc.payments.length, 1);
  assert.equal(invDoc.payments[0].move_id, cn.id);

  // Credit note row must not be offered for unreconcile in widget().list
  const listRows = widget().list(settledDb, invDoc);
  assert.deepEqual(listRows, [], 'credit-note row must not be listed as unreconcilable');
});
