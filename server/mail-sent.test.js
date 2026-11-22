import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, postNote, read, search, write } from '../src/orm.js';
import { seed } from '../src/seed.js';
import { recordSent } from './mail.js';
import { postMove } from '../src/models/accounting.js';



test('a document changed during delivery keeps its newer state and still records the send', () => {
  const snapshot = seed();
  const order = search(snapshot, 'sale.order').find((o) => o.state === 'draft');
  assert.ok(order, 'seed has a draft order');
  // The mail step moved the order to "sent" and left a note.
  const sent = postNote(write(snapshot, 'sale.order', order.id, { state: 'sent' }), 'sale.order', order.id, 'Sent by email to x');
  // Meanwhile somebody confirmed it.
  const current = write(snapshot, 'sale.order', order.id, { state: 'sale' });
  const out = recordSent(current, snapshot, sent, { author: 'clerk', isAdmin: true });
  assert.equal(read(out.db, 'sale.order', order.id).state, 'sale');
  assert.ok(out.db.messages.some((m) => m.body === 'Sent by email to x'));
  assert.match(out.notice, /status was left as it is/);
  assert.equal(recordSent(snapshot, snapshot, sent, { author: 'clerk', isAdmin: true }).notice, undefined);
});


test('a reset during invoice delivery preserves draft and records the delivery notice', () => {
  const invoice = create(seed(), 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100 }] });
  const snapshot = postMove(invoice.db, invoice.id);
  const sent = postNote(write(snapshot, 'account.move', invoice.id, { is_move_sent: true }), 'account.move', invoice.id, 'Sent by email to x');
  const current = write(snapshot, 'account.move', invoice.id, { state: 'draft', is_move_sent: false });
  const out = recordSent(current, snapshot, sent, { author: 'clerk', isAdmin: true }, { model: 'account.move', id: invoice.id });
  assert.equal(read(out.db, 'account.move', invoice.id).state, 'draft');
  assert.equal(read(out.db, 'account.move', invoice.id).is_move_sent, false);
  assert.match(out.notice, /status was left/);
  assert.ok(out.db.messages.some((m) => m.body === 'Sent by email to x'));
});

test('invoice delivery persists sent status and propagates recording errors', () => {
  const invoice = create(seed(), 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100 }] });
  const snapshot = postMove(invoice.db, invoice.id);
  const sent = postNote(write(snapshot, 'account.move', invoice.id, { is_move_sent: true }), 'account.move', invoice.id, 'Sent by email to x');
  const document = { model: 'account.move', id: invoice.id };
  const out = recordSent(snapshot, snapshot, sent, { author: 'clerk', isAdmin: true }, document);
  assert.equal(read(out.db, 'account.move', invoice.id).is_move_sent, true);
  assert.throws(() => recordSent(snapshot, snapshot, sent, { author: 'clerk', allowed: new Set() }, document));
});
