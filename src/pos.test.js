import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { read, search } from './orm.js';
import { accountId, isBalanced, journalItems } from './models/ledger.js';
import { closeSession, openSession, payOrder, priceLines, refundOrder, sessionTotals, startSession } from './models/pos.js';
import { seed } from './seed.js';

const cashIn = (db) => journalItems(db).filter((l) => l.account_id === accountId(db, '101501')).reduce((s, l) => s + l.debit - l.credit, 0);

test('a session sells, refunds and closes with cash control', () => {
  let db = startSession(seed(), 100).db;
  assert.throws(() => startSession(db, 0), /already open/);
  const lines = priceLines(db, [{ product_id: 1, qty: 2 }]);
  const stock = read(db, 'product', 1).qty_available;
  const sale = payOrder(db, { lines, method: 'cash' });
  db = sale.db;
  assert.equal(read(db, 'product', 1).qty_available, stock - 2);
  const order = read(db, 'pos.order', sale.id);
  const refund = refundOrder(db, order);
  db = refund.db;
  assert.equal(read(db, 'product', 1).qty_available, stock);
  assert.equal(read(db, 'pos.order', sale.id).state, 'refunded');
  assert.throws(() => refundOrder(db, read(db, 'pos.order', sale.id)), /Only paid/);
  db = payOrder(db, { lines, method: 'card' }).db;
  const session = openSession(db);
  assert.deepEqual(sessionTotals(db, session), { orders: 3, cash: 0, card: order.amount_total, expected: 100 });
  const before = cashIn(db);
  const closed = closeSession(db, session, 95);
  assert.equal(read(closed, 'pos.session', session.id).cash_difference, -5);
  assert.equal(Math.round((cashIn(closed) - before) * 100) / 100, -5);
  assert.ok(search(closed, 'account.move').filter((m) => m.state === 'posted').every((m) => isBalanced(m.line_ids)));
  assert.equal(openSession(closed), null);
  assert.throws(() => payOrder(closed, { lines, method: 'cash' }), /Open a session/);
});
