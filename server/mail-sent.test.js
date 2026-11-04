import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postNote, read, search, write } from '../src/orm.js';
import { seed } from '../src/seed.js';
import { recordSent } from './mail.js';



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
