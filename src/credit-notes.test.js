import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, write } from './orm.js';
import { seed } from './seed.js';
import { creditNote, payMove, postMove } from './models/accounting.js';
import { applyDiff, diffDb } from './sync.js';
import { models } from './models/index.js';

function postedInvoice(price = 100) {
  const inv = create(seed(), 'account.move', { move_type: 'out_invoice', partner_id: 2, invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: price, tax: 0 }] });
  return { db: postMove(inv.db, inv.id), id: inv.id };
}
const move = (db, id) => read(db, 'account.move', id);
const noteId = (out) => Number(out.go.split('/').at(-1));

test('a posted credit note settles its invoice (ACC-007)', () => {
  const { db, id } = postedInvoice(100);
  const out = creditNote(db, move(db, id));
  assert.equal(move(out.db, noteId(out)).reversed_entry_id, id);
  const posted = postMove(out.db, noteId(out));
  assert.equal(move(posted, id).amount_residual, 0);
  assert.equal(move(posted, id).payment_state, 'paid');
  assert.equal(move(posted, noteId(out)).payment_state, 'paid');
  assert.deepEqual(move(posted, id).payments.map((p) => [p.amount, p.move_id]), [[100, noteId(out)]]);
  // The server keeps the link and the settlement.
  const synced = applyDiff(out.db, diffDb(out.db, posted));
  assert.equal(move(synced, id).amount_paid, 100);
});

test('settled customer and vendor credit notes can be corrected by a linked replacement invoice without rewriting issued books', () => {
  for (const kind of ['out_invoice', 'in_invoice']) {
    const created = create(seed(), 'account.move', { move_type: kind, partner_id: 2, invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }] });
    const posted = postMove(created.db, created.id);
    const draftNote = creditNote(posted, move(posted, created.id));
    const settled = postMove(draftNote.db, noteId(draftNote));
    const note = move(settled, noteId(draftNote));
    const before = JSON.stringify(settled.records['account.move']);
    const action = models['account.move'].form.buttons.find((b) => b.label === 'Correct Credit Note');
    assert.ok(action, 'a posted credit note must have a correction workflow');
    assert.equal(action.when(note, settled), true);
    const correction = action.run(settled, note);
    const replacementId = noteId(correction);
    const replacement = move(correction.db, replacementId);
    assert.equal(replacement.move_type, kind);
    assert.equal(replacement.correction_of_id, note.id);
    assert.equal(replacement.amount_residual, 100);
    assert.equal(JSON.stringify(settled.records['account.move']), before, 'the issued invoice and credit remain immutable');
    assert.throws(() => action.run(correction.db, note), /already.*correction/i);
    const booked = postMove(correction.db, replacementId);
    const synced = applyDiff(settled, diffDb(settled, booked), { isAdmin: true });
    assert.equal(move(synced, replacementId).state, 'posted');
    assert.equal(move(synced, replacementId).amount_residual, 100);
    assert.equal(move(synced, created.id).amount_residual, 0);
    assert.equal(move(synced, note.id).amount_residual, 0);
  }
});

test('credit notes of one invoice cannot exceed it in total', () => {
  const { db, id } = postedInvoice(100);
  const first = creditNote(db, move(db, id));
  // A full draft already credits the whole invoice.
  assert.throws(() => creditNote(first.db, move(first.db, id)), /already fully credited/);
  // Lower the first to 30: a second may be drafted, but not posted for the full 100.
  const partial = write(first.db, 'account.move', noteId(first), { invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 30, tax: 0 }] });
  const second = creditNote(partial, move(partial, id));
  const afterFirst = postMove(second.db, noteId(first));
  assert.throws(() => postMove(afterFirst, noteId(second)), /would exceed .*70\.00 is left to credit/);
  const fitted = write(afterFirst, 'account.move', noteId(second), { invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 70, tax: 0 }] });
  const done = postMove(fitted, noteId(second));
  assert.equal(move(done, id).payment_state, 'paid');
  assert.throws(() => creditNote(done, move(done, id)), /already fully credited/);
});

test('a partial credit note leaves the rest due; on a paid invoice it stays open as customer credit', () => {
  const { db, id } = postedInvoice(100);
  const out = creditNote(db, move(db, id));
  const partial = write(out.db, 'account.move', noteId(out), { invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 30, tax: 0 }] });
  const posted = postMove(partial, noteId(out));
  assert.equal(move(posted, id).amount_residual, 70);
  assert.equal(move(posted, id).payment_state, 'partial');

  const paid = postedInvoice(100);
  const settled = payMove(paid.db, paid.id, 100);
  const late = creditNote(settled, move(settled, paid.id));
  const lateNote = postMove(late.db, noteId(late));
  assert.equal(move(lateNote, noteId(late)).amount_residual, 100);
  assert.equal(move(lateNote, paid.id).amount_paid, 100);
});

import { accountId } from './models/ledger.js';

const receivable = (db, partner) => {
  const id = accountId(db, '121000');
  return Math.round(db.records['account.move'].filter((m) => m.state === 'posted').flatMap((m) => m.line_ids ?? [])
    .filter((l) => l.account_id === id && l.partner_id === partner).reduce((s, l) => s + (Number(l.debit) || 0) - (Number(l.credit) || 0), 0) * 100) / 100;
};

test('a foreign-currency credit note at another rate clears the receivable with an exchange difference', () => {
  const fx = create(seed(), 'res.currency', { name: 'FXC', rate_ids: [{ date: '2026-01-01', rate: 2 }, { date: '2026-03-01', rate: 4 }] });
  const inv = create(fx.db, 'account.move', { move_type: 'out_invoice', partner_id: 2, currency_id: fx.id, invoice_date: '2026-01-15', invoice_date_due: '2026-01-15', invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }] });
  const db = postMove(inv.db, inv.id);
  const before = receivable(db, 2);
  const out = creditNote(db, move(db, inv.id));
  const dated = write(out.db, 'account.move', noteId(out), { invoice_date: '2026-03-15' });
  const posted = postMove(dated, noteId(out));
  assert.equal(move(posted, inv.id).payment_state, 'paid');
  assert.equal(receivable(posted, 2), 0, `receivable should clear, was ${before}`);
});

test('credit settlement clears actual separately-rounded historical counterpart lines', () => {
  const fx = create(seed(), 'res.currency', { name: 'FRA', rate_ids: [{ date: '2020-01-01', rate: 0.6 }] });
  const inv = create(fx.db, 'account.move', { move_type: 'out_invoice', partner_id: 2, currency_id: fx.id, invoice_date: '2026-01-01', invoice_line_ids: [{ qty: 1, price_unit: 0.01, tax: 0 }, { qty: 1, price_unit: 0.01, tax: 0 }] });
  const posted = postMove(inv.db, inv.id);
  const legacy = { ...posted, records: { ...posted.records, 'account.move': posted.records['account.move'].map((m) => m.id !== inv.id ? m : { ...m, line_ids: [
    { account_id: accountId(posted, '121000'), partner_id: 2, debit: 0.02, credit: 0 },
    { account_id: accountId(posted, '121000'), partner_id: 2, debit: 0.02, credit: 0 },
    { account_id: accountId(posted, '400000'), partner_id: 2, debit: 0, credit: 0.04 },
  ] }) } };
  const drafted = creditNote(legacy, move(legacy, inv.id));
  const settled = postMove(drafted.db, noteId(drafted));
  assert.equal(receivable(settled, 2), 0);
  assert.equal(move(settled, inv.id).amount_residual, 0);
  assert.equal(move(applyDiff(drafted.db, diffDb(drafted.db, settled)), inv.id).amount_residual, 0);
});

test('a credit note must match the invoice partner, currency and kind, and be positive', () => {
  const { db, id } = postedInvoice(100);
  const out = creditNote(db, move(db, id));
  const n = noteId(out);
  assert.throws(() => postMove(write(out.db, 'account.move', n, { partner_id: 3 }), n), /partner must be/);
  const other = create(seed(), 'res.currency', { name: 'OTH', rate_ids: [{ date: '2026-01-01', rate: 2 }] });
  assert.throws(() => postMove(write({ ...out.db, records: { ...out.db.records, 'res.currency': other.db.records['res.currency'] } }, 'account.move', n, { currency_id: other.id }), n), /currency must be/);
  assert.throws(() => postMove(write(out.db, 'account.move', n, { invoice_line_ids: [{ product_id: 1, qty: -1, price_unit: 30, tax: 0 }] }), n), /positive total|cannot exceed the invoice total/);
  assert.throws(() => postMove(write(out.db, 'account.move', n, { move_type: 'in_refund' }), n), /can only reverse/);
});

test('a credit note that settled an invoice, and that invoice, cannot be deleted', () => {
  const { db, id } = postedInvoice(100);
  const out = creditNote(db, move(db, id));
  const posted = postMove(out.db, noteId(out));
  const settings = { isAdmin: true };
  assert.throws(() => applyDiff(posted, { upserts: {}, deletes: { 'account.move': [noteId(out)] } }, settings), /cannot be deleted/);
  assert.throws(() => applyDiff(posted, { upserts: {}, deletes: { 'account.move': [id] } }, settings), /cannot be deleted/);
});
