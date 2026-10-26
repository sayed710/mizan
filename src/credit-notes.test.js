import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { creditNote, payMove, postMove } from './models/accounting.js';
import { applyDiff, diffDb } from './sync.js';

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
