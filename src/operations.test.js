import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from './orm.js';
import { menuModelsForApps, modelsForApps, writableModelsForApps } from './models/index.js';
import { payQuote } from './models/quoteplus.js';
import { openSession, payOrder, startSession } from './models/pos.js';
import { runOperation } from './operations.js';
import { seed } from './seed.js';
import { applyDiff, diffDb } from './sync.js';

const access = (apps) => ({ allowed: writableModelsForApps(apps), direct: menuModelsForApps(apps) });
const apply = (db, out) => applyDiff(db, diffDb(db, out.db), { author: 'clerk', isAdmin: false, allowed: out.allowed });
const quote = (db) => create(db, 'sale.order', { partner_id: 3, require_payment: true, prepayment_percent: 100, order_line: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }] });

test('a Sales-only user registers a prepayment through the server operation, not by writing journal entries', () => {
  const made = quote(seed());
  const sales = writableModelsForApps(['sales']);
  assert.throws(() => applyDiff(made.db, diffDb(made.db, payQuote(made.db, made.id, 100)), { isAdmin: false, allowed: sales }), /No access to account\./);
  const saved = apply(made.db, runOperation(made.db, 'sale.prepay', { id: made.id, text: '100' }, access(['sales'])));
  const payment = search(saved, 'account.payment').find((p) => p.sale_id === made.id);
  assert.equal(payment?.amount, 100);
  assert.equal(read(saved, 'account.move', payment.move_id).state, 'posted');
});

test('a POS-only user pays and closes through server operations, priced from the server catalog', () => {
  const db = startSession(seed(), 0).db;
  const out = runOperation(db, 'pos.pay', { cart: [{ product_id: 1, qty: 2, price_unit: 0.01 }], method: 'cash' }, access(['pos']));
  const saved = apply(db, out);
  const order = read(saved, 'pos.order', out.reply.id);
  const local = payOrder(db, { lines: order.lines, method: 'cash' });
  assert.equal(order.lines[0].price_unit, read(db, 'product', 1).list_price, 'client prices are ignored');
  assert.ok(search(saved, 'account.move').length === search(local.db, 'account.move').length);
  const closed = apply(saved, runOperation(saved, 'pos.close', { id: openSession(saved).id, counted: 1 }, access(['pos'])));
  assert.ok(!openSession(closed));
});

test('operations need the model on the user\'s own menus and refuse unknown names', () => {
  const made = quote(seed());
  assert.ok(modelsForApps(['appointments']).has('account.move'), 'appointments reach invoices through a relation');
  assert.equal(menuModelsForApps(['appointments']).has('account.move'), false, 'but cannot share or book them');
  assert.throws(() => runOperation(made.db, 'sale.prepay', { id: made.id, amount: 100 }, access(['todo'])), (e) => e.status === 403);
  for (const name of ['nope', 'constructor', '__proto__']) assert.throws(() => runOperation(made.db, name, {}, access(['sales'])), (e) => e.status === 404);
  assert.throws(() => runOperation(made.db, 'pos.pay', { cart: [], method: 'bitcoin' }, access(['pos'])), /payment method/);
});
