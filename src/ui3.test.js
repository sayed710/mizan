import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from './orm.js';
import { seed } from './seed.js';
import { models } from './models/index.js';
import { debitNote, postMove, payMove } from './models/accounting.js';
import { today } from './models/common.js';

const move = (db, id) => read(db, 'account.move', id);
const debitButton = models['account.move'].form.buttons.find((b) => b.label === 'Debit Note');
const saleOrderButton = (label) => models['sale.order'].form.buttons.find((b) => b.label === label).run;

function postedDocument(kind = 'out_invoice', price = 100, extraLineFields = {}) {
  const created = create(seed(), 'account.move', {
    move_type: kind,
    partner_id: 2,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: price, tax: 0, ...extraLineFields }],
  });
  return { db: postMove(created.db, created.id), id: created.id };
}

test('Debit Note is offered on posted invoices and bills only, with the Odoo wizard fields (finding 6)', () => {
  assert.ok(debitButton, 'a posted invoice or vendor bill must offer a Debit Note workflow');
  assert.equal(typeof debitButton.run, 'function');
  for (const kind of ['out_invoice', 'in_invoice']) {
    const { db, id } = postedDocument(kind);
    assert.equal(debitButton.when(move(db, id), db), true);
  }
  for (const kind of ['out_refund', 'in_refund']) {
    const { db, id } = postedDocument(kind);
    assert.equal(debitButton.when(move(db, id), db), false, `${kind} must not be debited`);
  }
  const entryDb = seed();
  const entryCreated = create(entryDb, 'account.move', { move_type: 'entry', ref: 'Adjustment', line_ids: [{ account_id: entryDb.records['account.account'][0].id, debit: 10, credit: 0, partner_id: 2 }, { account_id: entryDb.records['account.account'][0].id, debit: 0, credit: 10, partner_id: 2 }] });
  assert.equal(debitButton.when(read(entryCreated.db, 'account.move', entryCreated.id), entryCreated.db), false, 'a journal entry must not be debited');
  const fresh = create(seed(), 'account.move', { move_type: 'out_invoice', partner_id: 2, invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }] });
  assert.equal(debitButton.when(move(fresh.db, fresh.id), fresh.db), false, 'a draft invoice has no debit note yet');
});

test('the Debit Note wizard carries Copy Lines, Reason, Debit Note Date and Use Specific Journal (finding 6)', () => {
  const { db, id } = postedDocument();
  const inv = move(db, id);
  const spec = debitButton.wizard(db, inv);
  assert.equal(spec.title, 'Debit Note');
  assert.deepEqual(spec.fields.map((f) => [f.name, f.type, f.required]), [
    ['copy_lines', 'boolean', undefined],
    ['reason', 'char', undefined],
    ['date', 'date', true],
    ['journal_id', 'many2one', undefined],
  ]);
  assert.equal(spec.fields[0].label, 'Copy Lines');
  assert.equal(spec.fields[0].default, true, 'lines are copied by default like in Odoo');
  assert.equal(spec.fields[1].label, 'Reason Displayed on Debit Note');
  assert.equal(spec.fields[2].label, 'Debit Note Date');
  assert.equal(spec.fields[2].default, today());
  const journalField = spec.fields[3];
  assert.equal(journalField.label, 'Use Specific Journal');
  assert.equal(journalField.relation, 'account.journal');
  assert.equal(journalField.default, inv.journal_id);
  assert.equal(journalField.domain({ type: 'sale', company_id: 1 }), true);
  assert.equal(journalField.domain({ type: 'bank', company_id: 1 }), false, 'journal must match the document direction');
  assert.equal(journalField.domain({ type: 'sale', company_id: 2 }), false, 'journal must belong to the document company');
});

test('running Debit Note drafts a debit note of the entered reason, date and journal with copied lines and stored origin (finding 6)', () => {
  for (const kind of ['out_invoice', 'in_invoice']) {
    const { db, id } = postedDocument(kind, 100, { sale_line_key: 'sale-key', purchase_line_key: 'purchase-key', down_payment_key: 'down-key' });
    const inv = move(db, id);
    const expectedJournal = db.records['account.journal'].find((j) => j.type === (kind === 'in_invoice' ? 'purchase' : 'sale'));
    const out = debitButton.run(db, inv, { copy_lines: true, reason: 'Extra charge after delivery', date: '2026-01-05', journal_id: expectedJournal.id });
    const note = move(out.db, out.id);
    assert.equal(note.move_type, kind);
    assert.equal(note.state, 'draft');
    assert.equal(note.debit_origin_id, id, 'the link to the debited document must be stored');
    assert.equal(note.ref, `Debit of ${inv.name}, Extra charge after delivery`);
    assert.equal(note.invoice_origin, inv.name);
    assert.equal(note.invoice_date, '2026-01-05');
    assert.equal(note.invoice_date_due, '2026-01-05');
    assert.equal(note.journal_id, expectedJournal.id);
    assert.deepEqual(note.invoice_line_ids.map(({ product_id, qty }) => [product_id, qty]), [[1, 1]], 'invoice lines are copied');
    assert.deepEqual(note.invoice_line_ids.map((l) => [l.sale_line_key, l.purchase_line_key, l.down_payment_key]), [[undefined, undefined, undefined]], 'order-line keys are stripped so invoiced quantities are never double-counted');
    assert.equal(out.go, `#/accounting/${kind === 'in_invoice' ? 'bills' : 'invoices'}/${out.id}`);
  }
});

test('Debit Note with Copy Lines off drafts an empty note and omits the reason from the reference (finding 6)', () => {
  const { db, id } = postedDocument('out_invoice', 100);
  const out = debitNote(db, move(db, id), { copy_lines: false, reason: 'Extra', date: '2026-01-05' });
  let note = move(out.db, out.id);
  assert.deepEqual(note.invoice_line_ids, [], 'copy_lines false must not copy lines');
  assert.equal(note.ref, `Debit of ${move(out.db, id).name}, Extra`);
  const plain = debitNote(out.db, move(out.db, id), { date: '2026-01-05' });
  note = move(plain.db, plain.id);
  assert.equal(note.ref, `Debit of ${move(plain.db, id).name}`, 'a missing reason falls back to the plain debit title');
});

test('Debit Note rejects invalid dates, journals and non-invoice documents (finding 6)', () => {
  const { db, id } = postedDocument();
  const inv = move(db, id);
  assert.throws(() => debitNote(db, inv, { date: '' }), /Enter a valid debit note date/);
  assert.throws(() => debitNote(db, inv, { date: '2026-01-05', journal_id: 999 }), /Selected journal does not exist/);
  const bank = db.records['account.journal'].find((j) => j.type === 'bank');
  assert.throws(() => debitNote(db, inv, { date: '2026-01-05', journal_id: bank.id }), /Journal must be of type sale/);
  for (const mutated of [{ ...inv, state: 'draft' }, { ...inv, move_type: 'out_refund' }, { ...inv, move_type: 'entry' }]) {
    assert.throws(() => debitNote(db, mutated, { date: '2026-01-05' }), /Only posted invoices and vendor bills can be debited/, JSON.stringify({ state: mutated.state, move_type: mutated.move_type }));
  }
});

test('a drafted debit note can be confirmed like any invoice without settling the debited document (finding 6)', () => {
  const { db, id } = postedDocument();
  const inv = move(db, id);
  const out = debitNote(db, inv, { reason: 'Leakage', date: '2026-01-05' });
  const confirmed = postMove(out.db, out.id);
  const note = move(confirmed, out.id);
  assert.equal(note.state, 'posted');
  assert.equal(note.debit_origin_id, id);
  assert.equal(move(confirmed, id).state, 'posted', 'the debited document stays posted');
  assert.equal(move(confirmed, id).amount_residual, 100, 'a debit note documents extra debt, it does not settle the invoice');
  assert.equal(move(confirmed, id).amount_paid, 0);
});

test('debit-note copies do not double-count invoiced sale-order quantities (finding 6)', () => {
  const order = create(seed(), 'sale.order', { partner_id: 2, order_line: [{ product_id: 7, qty: 10, price_unit: 100, tax: 0 }] });
  let db = saleOrderButton('Confirm')(order.db, read(order.db, 'sale.order', order.id)).db;
  db = saleOrderButton('Create Invoice')(db, read(db, 'sale.order', order.id), { method: 'regular' }).db;
  const invoice = search(db, 'account.move').find((m) => m.sale_id === order.id && m.move_type === 'out_invoice');
  db = postMove(db, invoice.id);
  const inv = move(db, invoice.id);
  assert.ok(inv.invoice_line_ids.every((l) => l.sale_line_key), 'the invoiced lines carry order-line keys');
  assert.equal(read(db, 'sale.order', order.id).order_line[0].qty_invoiced, 10);
  const out = debitNote(db, inv, { reason: 'Extra unit', date: '2026-01-05' });
  const note = move(out.db, out.id);
  assert.ok(note.invoice_line_ids.every((l) => !l.sale_line_key));
  db = postMove(out.db, out.id);
  assert.equal(read(db, 'sale.order', order.id).order_line[0].qty_invoiced, 10, 'confirming the debit note must not raise the order invoiced quantity');
  assert.equal(search(db, 'account.move').filter((m) => m.sale_id === order.id).length, 1, 'the debit note is not linked back to the sale order');
});

test('the invoice form exposes an outstanding credits widget with Add controls (finding 11)', () => {
  const widget = models['account.move'].form.outstandingCredits;
  assert.ok(widget, 'the invoice form must expose an outstanding credits widget');
  assert.equal(widget.title, 'Outstanding Credits');
  assert.equal(widget.applyLabel, 'Add');
  assert.deepEqual(widget.fields.map((f) => [f.name, f.label, f.money]), [
    ['name', 'Payment', undefined],
    ['date', 'Paid on', undefined],
    ['unapplied', 'Available Credit', true],
  ]);
  assert.equal(typeof widget.list, 'function');
  assert.equal(typeof widget.apply, 'function');
});

test('a posted open invoice sees its outstanding credits and can apply one in full through the widget (finding 11)', () => {
  const first = postedDocument();
  let db = payMove(first.db, first.id, 150);
  const payment = db.records['account.payment'].find((p) => p.invoice_id === first.id);
  const second = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 2, invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 80, tax: 0 }] });
  db = postMove(second.db, second.id);
  const inv = move(db, second.id);
  const widget = models['account.move'].form.outstandingCredits;
  const rows = widget.list(db, inv);
  assert.equal(rows.map((p) => p.id).includes(payment.id), true, 'the overpayment credit is an outstanding credit');
  assert.equal(rows.find((p) => p.id === payment.id).unapplied, 50);
  const applyButton = models['account.move'].form.buttons.find((b) => b.label === 'Apply Outstanding Credit');
  assert.equal(applyButton.when(inv, db), true);
  assert.equal(applyButton.wizard(db, inv).fields[0].domain(payment), true);
  const applied = widget.apply(db, inv, payment.id);
  const settled = move(applied.db, second.id);
  assert.equal(settled.amount_paid, 50);
  assert.equal(settled.amount_residual, 30);
  assert.equal(settled.payment_state, 'partial');
  assert.equal(read(applied.db, 'account.payment', payment.id).unapplied, 0);
  assert.deepEqual(widget.list(applied.db, settled), [], 'the applied credit disappears from the widget');
  assert.equal(applyButton.when(settled, applied.db), false);
});

test('the widget is empty for drafts, settled documents and partner or direction mismatched credits (finding 11)', () => {
  const widget = models['account.move'].form.outstandingCredits;
  const applyButton = models['account.move'].form.buttons.find((b) => b.label === 'Apply Outstanding Credit');
  const { db, id } = postedDocument();
  const paid = payMove(db, id, 100);
  assert.deepEqual(widget.list(paid, move(paid, id)), [], 'a settled invoice has no outstanding credit to apply');
  const draft = create(paid, 'account.move', { move_type: 'out_invoice', partner_id: 2, invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 40, tax: 0 }] });
  assert.deepEqual(widget.list(paid, move(paid, draft.id)), [], 'a draft invoice lists no credits');
  assert.equal(applyButton.when(move(paid, draft.id), paid), false);

  const { db: billDb, id: billId } = postedDocument('in_invoice', 60);
  let withCredit = payMove(billDb, billId, 70);
  const outbound = withCredit.records['account.payment'].find((p) => p.invoice_id === billId);
  const laterBill = create(withCredit, 'account.move', { move_type: 'in_invoice', partner_id: 2, invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 40, tax: 0 }] });
  withCredit = postMove(laterBill.db, laterBill.id);
  const bill = move(withCredit, laterBill.id);
  assert.deepEqual(widget.list(withCredit, move(withCredit, billId)), [], 'a settled bill has no outstanding credit to apply');
  assert.equal(widget.list(withCredit, bill).map((p) => p.id).includes(outbound.id), true, 'a later open vendor bill sees the outstanding outbound credit');
  assert.equal(applyButton.when(bill, withCredit), true);
  const customerInvoice = create(withCredit, 'account.move', { move_type: 'out_invoice', partner_id: 2, invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 30, tax: 0 }] });
  withCredit = postMove(customerInvoice.db, customerInvoice.id);
  assert.deepEqual(widget.list(withCredit, move(withCredit, customerInvoice.id)), [], 'outbound credit is not offered to a customer invoice');
  assert.equal(applyButton.when(move(withCredit, customerInvoice.id), withCredit), false);
  const stranger = create(withCredit, 'res.partner', { name: 'Unrelated Co', is_company: true });
  const others = create(withCredit, 'account.move', { move_type: 'in_invoice', partner_id: stranger.id, invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 50, tax: 0 }] });
  withCredit = postMove(others.db, others.id);
  assert.deepEqual(widget.list(withCredit, move(withCredit, others.id)), [], 'another partner credit never shows');
  assert.equal(widget.list(withCredit, bill).length, 1, 'the open bill keeps its credit listed once');
  assert.equal(applyButton.when(bill, withCredit), true, 'button visibility and rows never disagree');
});

test('widget rows carry payment name, paid-on date and available credit (finding 11)', () => {
  const { db, id } = postedDocument('in_invoice', 100);
  let paid = payMove(db, id, 110);
  const laterBill = create(paid, 'account.move', { move_type: 'in_invoice', partner_id: 2, invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 40, tax: 0 }] });
  paid = postMove(laterBill.db, laterBill.id);
  const widget = models['account.move'].form.outstandingCredits;
  const row = widget.list(paid, move(paid, laterBill.id)).find(Boolean);
  assert.ok(row, 'an overpaid vendor bill leaves credit for later bills');
  assert.equal(row.unapplied, 10);
  assert.ok(row.name, 'the row shows the payment number');
  assert.ok(row.date, 'the row shows when it was paid');
});
