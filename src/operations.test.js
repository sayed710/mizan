import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
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

test('sale.prepay accepts an amount typed in Arabic-Indic digits', () => {
  const made = quote(seed());
  const saved = apply(made.db, runOperation(made.db, 'sale.prepay', { id: made.id, text: '١٠٠' }, access(['sales'])));
  assert.equal(search(saved, 'account.payment').find((p) => p.sale_id === made.id)?.amount, 100);
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

test('pos.pay rejects foreign-company products and accepts shared products', () => {
  const db = startSession(seed(), 0).db;
  const company = create(db, 'res.company', { name: 'Other company' });
  const foreign = write(company.db, 'product', 1, { company_id: company.id });
  const request = { cart: [{ product_id: 1, qty: 1 }], method: 'cash' };
  const before = JSON.stringify(foreign.records);
  assert.throws(() => runOperation(foreign, 'pos.pay', request, access(['pos'])), /not available in POS/);
  assert.equal(JSON.stringify(foreign.records), before, 'rejected checkout makes no writes');

  const shared = write(foreign, 'product', 1, { company_id: null });
  const out = runOperation(shared, 'pos.pay', request, access(['pos']));
  const saved = apply(shared, out);
  assert.equal(read(saved, 'pos.order', out.reply.id).lines[0].product_id, 1);
});

test('operations need the model on the user\'s own menus and refuse unknown names', () => {
  const made = quote(seed());
  assert.ok(modelsForApps(['appointments']).has('account.move'), 'appointments reach invoices through a relation');
  assert.equal(menuModelsForApps(['appointments']).has('account.move'), false, 'but cannot share or book them');
  assert.throws(() => runOperation(made.db, 'sale.prepay', { id: made.id, amount: 100 }, access(['todo'])), (e) => e.status === 403);
  for (const name of ['nope', 'constructor', '__proto__']) assert.throws(() => runOperation(made.db, name, {}, access(['sales'])), (e) => e.status === 404);
  assert.throws(() => runOperation(made.db, 'pos.pay', { cart: [], method: 'bitcoin' }, access(['pos'])), /payment method/);
});

test('a POS user refunds through server operation pos.refund: rejects mismatched tenders and enforces single refund', () => {
  let db = startSession(seed(), 100).db;
  const payOut = runOperation(db, 'pos.pay', { cart: [{ product_id: 1, qty: 1 }], method: 'cash' }, access(['pos']));
  db = apply(db, payOut);
  const orderId = payOut.reply.id;

  // Attempt mismatched tenders through pos.refund
  assert.throws(
    () => runOperation(db, 'pos.refund', { id: orderId, method: 'card' }, access(['pos'])),
    /Invalid payment|match.*original/i
  );

  // Correct refund
  const refundOut = runOperation(db, 'pos.refund', { id: orderId }, access(['pos']));
  db = apply(db, refundOut);
  const refundedOrder = read(db, 'pos.order', orderId);
  assert.equal(refundedOrder.state, 'refunded');

  // Duplicate refund through pos.refund rejected
  assert.throws(
    () => runOperation(db, 'pos.refund', { id: orderId }, access(['pos'])),
    /already refunded/i
  );
});

