// Cashiers and payroll officers complete sales and payslips: the server books the journal entry for them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from '../src/orm.js';
import { modelsForApps } from '../src/models/index.js';
import { closeSession, openSession, refundOrder, sessionTotals, startSession } from '../src/models/pos.js';
import { applyDiff, diffDb } from '../src/sync.js';
import { runOperation } from '../src/operations.js';
import { seed } from '../src/seed.js';
import { accountId } from '../src/models/ledger.js';
import { receive } from '../src/models/valuation.js';
import { runPosting } from './posting.js';

const moves = (db) => search(db, 'account.move').length;
const commitAsSystem = (db, next) => applyDiff(db, diffDb(db, next), { author: 'test', isAdmin: false, allowed: null });

test('POS refuses invalid quantities and discounts before posting', () => {
  const db = startSession(seed(), 0).db;
  for (const line of [{ qty: -1 }, { qty: 0 }, { qty: Infinity }, { qty: NaN }, { qty: 1, discount: 101 }, { qty: 1, discount: -1 }, { qty: 1, discount: Infinity }]) {
    assert.throws(() => runPosting(db, null, '/api/pos/pay', { lines: [{ product_id: 1, ...line }], method: 'cash' }), /Invalid cart/);
  }
});

test('POS refuses products outside the register catalog', () => {
  const db = startSession(seed(), 0).db;
  for (const vals of [{ active: false }, { available_in_pos: false }, { sale_ok: false }]) {
    const unavailable = write(db, 'product', 1, vals);
    assert.throws(() => runPosting(unavailable, null, '/api/pos/pay', { lines: [{ product_id: 1, qty: 1 }], method: 'cash' }), /not available in POS/);
  }
  assert.throws(() => runPosting(db, null, '/api/pos/pay', { lines: [{ product_id: 999999, qty: 1 }], method: 'cash' }), /not available in POS/);
});

test('a POS-only user pays an order: the server prices it and posts the entry', () => {
  const pos = modelsForApps(['pos']);
  assert.equal(pos.has('account.move'), false);
  const db = startSession(seed(), 100).db;
  const out = runPosting(db, pos, '/api/pos/pay', { lines: [{ product_id: 1, qty: 2, price_unit: 0.01 }], method: 'cash' });
  const saved = commitAsSystem(db, out.db);
  const order = read(saved, 'pos.order', out.body.id);
  assert.equal(order.name, out.body.name);
  assert.ok(order.lines[0].price_unit > 1, 'price comes from the product, not the request');
  assert.ok(moves(saved) > moves(db));
  const closed = commitAsSystem(saved, runPosting(saved, pos, '/api/pos/close', { session_id: order.session_id, counted: 0 }).db);
  assert.equal(read(closed, 'pos.session', order.session_id).state, 'closed');
});

test('server POS accepts numeric-string method IDs and configured method names', () => {
  const db = startSession(seed(), 0).db;
  const method = read(db, 'pos.payment.method', 1);
  assert.ok(method);
  for (const selection of ['1', method.name]) {
    const out = runPosting(db, modelsForApps(['pos']), '/api/pos/pay', { lines: [{ product_id: 1, qty: 1 }], method: selection });
    const order = read(out.db, 'pos.order', out.body.id);
    assert.equal(order.payment_method_id, method.id);
    assert.equal(order.payment_ids[0].payment_method_id, method.id);
    assert.ok(order.accounting_entries.length > 0);
  }
});

test('server split payment and refund accept numeric-string IDs like numeric IDs', () => {
  const db = startSession(seed(), 0).db;
  const methods = search(db, 'pos.payment.method');
  const cash = methods.find((m) => m.type === 'cash');
  const card = methods.find((m) => m.type === 'bank');
  const body = { lines: [{ product_id: 1, qty: 1 }] };
  const due = runPosting(db, null, '/api/pos/pay', { ...body, method: cash.id }).body.total;
  const payments = [{ payment_method_id: cash.id, amount: 10 }, { payment_method_id: card.id, amount: due - 10 }];
  const post = (ps) => runPosting(db, null, '/api/pos/pay', { ...body, payments: ps });
  const numeric = post(payments);
  const string = post(payments.map((p) => ({ ...p, payment_method_id: String(p.payment_method_id) })));
  const order = read(numeric.db, 'pos.order', numeric.body.id);
  assert.deepEqual(read(string.db, 'pos.order', string.body.id), order);
  assert.deepEqual(search(string.db, 'account.move'), search(numeric.db, 'account.move'));
  const withStrings = write(numeric.db, 'pos.order', order.id, { payment_ids: order.payment_ids.map((p) => ({ ...p, payment_method_id: String(p.payment_method_id) })) });
  const refund = (snapshot) => runOperation(snapshot, 'pos.refund', { id: order.id });
  const numericRefund = refund(numeric.db);
  const stringRefund = refund(withStrings);
  const refunds = (snapshot) => search(snapshot, 'pos.order').filter((o) => o.refund_of === order.id);
  assert.deepEqual(refunds(stringRefund.db), refunds(numericRefund.db));
  assert.deepEqual(search(stringRefund.db, 'account.move'), search(numericRefund.db, 'account.move'));
});

test('server POS posting preserves split tenders and whole quantities', () => {
  const db = startSession(seed(), 0).db;
  const body = { lines: [{ product_id: 1, qty: 1 }], method: 'cash' };
  const single = runPosting(db, null, '/api/pos/pay', body);
  const due = read(single.db, 'pos.order', single.body.id).amount_total;
  const payments = [{ method: 'cash', amount: 10 }, { method: 'card', amount: due - 10 }];
  const out = runPosting(db, modelsForApps(['pos']), '/api/pos/pay', { ...body, payments });
  const saved = commitAsSystem(db, out.db);
  const order = read(saved, 'pos.order', out.body.id);
  assert.equal(order.lines[0].qty, 1);
  assert.deepEqual(order.payment_ids.map((p) => p.amount), payments.map((p) => p.amount));
  assert.throws(() => runPosting(db, null, '/api/pos/pay', { ...body, payments: [{ method: 'bitcoin', amount: due }] }), /Invalid payments/);
});

test('a payroll-only user confirms a payslip through the posting button', () => {
  const payroll = modelsForApps(['payroll']);
  const { db, id } = create(seed(), 'hr.payslip', { employee_id: 1 });
  const out = runPosting(db, payroll, '/api/button', { model: 'hr.payslip', id, label: 'Confirm' });
  const saved = commitAsSystem(db, out.db);
  assert.equal(read(saved, 'hr.payslip', id).state, 'done');
  assert.ok(moves(saved) > moves(db));
});

test('users without the business document, and buttons not marked as posting, are refused', () => {
  const { db, id } = create(seed(), 'hr.payslip', { employee_id: 1 });
  assert.throws(() => runPosting(db, modelsForApps(['crm']), '/api/button', { model: 'hr.payslip', id, label: 'Confirm' }), /No access/);
  assert.throws(() => runPosting(db, null, '/api/button', { model: 'hr.payslip', id, label: 'Cancel' }), /not available/);
  assert.throws(() => runPosting(db, null, '/api/button', { model: 'hr.payslip', id, label: 'Mark as Paid' }), /not available/);
  assert.throws(() => runPosting(startSession(db, 0).db, modelsForApps(['pos']), '/api/pos/pay', { lines: [{ product_id: 1, qty: 1 }], method: 'bitcoin' }), /payment method/);
});

test('server POS posting rejects zero-total order with offsetting tenders leaving drawer totals and accounting unchanged', () => {
  const sessionRes = startSession(seed(), 100);
  const db = sessionRes.db;
  const session = read(db, 'pos.session', sessionRes.id);
  const initialTotals = sessionTotals(db, session);
  assert.deepEqual(initialTotals, { orders: 0, cash: 0, card: 0, expected: 100 });
  const initialMoves = moves(db);

  const methods = search(db, 'pos.payment.method');
  const cash = methods.find((m) => m.type === 'cash');
  const card = methods.find((m) => m.type === 'bank');
  assert.ok(cash && card);

  const offsettingPayments = [
    { payment_method_id: cash.id, amount: 100 },
    { payment_method_id: card.id, amount: -100 },
  ];

  assert.throws(
    () => runPosting(db, modelsForApps(['pos']), '/api/pos/pay', {
      lines: [{ product_id: 5, qty: 1, discount: 100 }],
      payments: offsettingPayments,
    }),
    /Invalid payment/
  );

  // Assert drawer totals and accounting unchanged
  assert.deepEqual(sessionTotals(db, session), initialTotals);
  assert.equal(moves(db), initialMoves);

  // Legitimate zero-total order through server posting succeeds and keeps drawer totals and accounting unchanged
  const valid = runPosting(db, modelsForApps(['pos']), '/api/pos/pay', {
    lines: [{ product_id: 5, qty: 1, discount: 100 }],
    method: 'cash',
  });
  const saved = commitAsSystem(db, valid.db);
  assert.deepEqual(sessionTotals(saved, session), { orders: 1, cash: 0, card: 0, expected: 100 });
  assert.equal(moves(saved), initialMoves);
  assert.deepEqual(read(saved, 'pos.order', valid.body.id).accounting_entries, []);
});

test('server POS posting rejects mismatched refund tenders and duplicate refunds, and leaves drawer and accounting consistent on refund', () => {
  const sessionRes = startSession(seed(), 100);
  const db = sessionRes.db;
  const session = read(db, 'pos.session', sessionRes.id);

  const methods = search(db, 'pos.payment.method');
  const cash = methods.find((m) => m.type === 'cash');
  const card = methods.find((m) => m.type === 'bank');
  assert.ok(cash && card);

  // 1. Single cash sale of 10 through /api/pos/pay
  const saleOut = runPosting(db, modelsForApps(['pos']), '/api/pos/pay', {
    lines: [{ product_id: 5, qty: 1 }],
    method: cash.id,
  });
  const saleDb = commitAsSystem(db, saleOut.db);
  const saleOrder = read(saleDb, 'pos.order', saleOut.body.id);
  const due = saleOrder.amount_total;
  assert.deepEqual(sessionTotals(saleDb, session), { orders: 1, cash: due, card: 0, expected: 100 + due });

  // Repro through /api/pos/pay: cash sale, refund with cash -90 / card (due + 90) -> rejected
  assert.throws(
    () => runPosting(saleDb, modelsForApps(['pos']), '/api/pos/pay', {
      lines: saleOrder.lines,
      refund_of: saleOrder.id,
      payments: [
        { payment_method_id: cash.id, amount: -90 },
        { payment_method_id: card.id, amount: due + 90 },
      ],
    }),
    /Invalid payment|match.*original/i
  );

  // Repro through /api/pos/pay: cash sale 10, refund with method: card -> rejected
  assert.throws(
    () => runPosting(saleDb, modelsForApps(['pos']), '/api/pos/pay', {
      lines: saleOrder.lines,
      refund_of: saleOrder.id,
      method: card.id,
    }),
    /Invalid payment|match.*original/i
  );

  // Repro through /api/pos/refund: refund with method: card -> rejected
  assert.throws(
    () => runPosting(saleDb, modelsForApps(['pos']), '/api/pos/refund', {
      id: saleOrder.id,
      method: card.id,
    }),
    /Invalid payment|match.*original/i
  );

  // Correct refund through server posting (/api/pos/refund or /api/pos/pay)
  const refundOut = runPosting(saleDb, modelsForApps(['pos']), '/api/pos/refund', {
    id: saleOrder.id,
  });
  const refundedDb = commitAsSystem(saleDb, refundOut.db);
  const refundOrderRec = read(refundedDb, 'pos.order', refundOut.body.id);
  assert.equal(refundOrderRec.state, 'refund');
  assert.equal(read(refundedDb, 'pos.order', saleOrder.id).state, 'refunded');

  // Drawer totals and accounting consistent
  const totals = sessionTotals(refundedDb, session);
  assert.deepEqual(totals, { orders: 2, cash: 0, card: 0, expected: 100 });
  const cashAccountId = accountId(refundedDb, '101501', session.company_id);
  assert.ok(cashAccountId);
  const saleMoves = search(refundedDb, 'account.move').filter((m) => m.ref === saleOrder.name && m.state === 'posted');
  const refundMoves = search(refundedDb, 'account.move').filter((m) => m.ref === refundOrderRec.name && m.state === 'posted');
  assert.ok(saleMoves.length > 0);
  assert.ok(refundMoves.length > 0);
  const saleCashLines = saleMoves.flatMap((m) => m.line_ids).filter((l) => l.account_id === cashAccountId);
  const refundCashLines = refundMoves.flatMap((m) => m.line_ids).filter((l) => l.account_id === cashAccountId);
  assert.ok(saleCashLines.length > 0);
  assert.ok(refundCashLines.length > 0);
  const saleCashContribution = saleCashLines.reduce((s, l) => s + (l.debit || 0) - (l.credit || 0), 0);
  const refundCashContribution = refundCashLines.reduce((s, l) => s + (l.debit || 0) - (l.credit || 0), 0);
  const netCashDebit = saleCashContribution + refundCashContribution;
  assert.equal(Math.round(saleCashContribution * 100) / 100, due);
  assert.equal(Math.round(refundCashContribution * 100) / 100, -due);
  assert.equal(Math.round(netCashDebit * 100) / 100, 0);

  // Duplicate refund rejected through server posting
  assert.throws(
    () => runPosting(refundedDb, modelsForApps(['pos']), '/api/pos/refund', { id: saleOrder.id }),
    /already refunded/i
  );
  assert.throws(
    () => runPosting(refundedDb, modelsForApps(['pos']), '/api/pos/pay', { lines: saleOrder.lines, refund_of: saleOrder.id }),
    /already refunded/i
  );

  // 2. Split sale via server posting
  const splitOut = runPosting(refundedDb, modelsForApps(['pos']), '/api/pos/pay', {
    lines: [{ product_id: 5, qty: 1 }],
    payments: [
      { payment_method_id: cash.id, amount: 71 },
      { payment_method_id: card.id, amount: due - 71 },
    ],
  });
  const splitDb = commitAsSystem(refundedDb, splitOut.db);
  const splitOrder = read(splitDb, 'pos.order', splitOut.body.id);
  assert.equal(splitOrder.amount_total, due);
  assert.deepEqual(sessionTotals(splitDb, session), { orders: 3, cash: 71, card: due - 71, expected: 100 + 71 });

  // Mismatched refund tenders via /api/pos/refund
  assert.throws(
    () => runPosting(splitDb, modelsForApps(['pos']), '/api/pos/refund', {
      id: splitOrder.id,
      method: cash.id,
    }),
    /Invalid payment|match.*original/i
  );

  // Mismatched refund tenders via /api/pos/pay
  assert.throws(
    () => runPosting(splitDb, modelsForApps(['pos']), '/api/pos/pay', {
      lines: splitOrder.lines,
      refund_of: splitOrder.id,
      payments: [
        { payment_method_id: cash.id, amount: due - 71 },
        { payment_method_id: card.id, amount: 71 },
      ],
    }),
    /Invalid payment|match.*original/i
  );

  // Correct refund of split order via /api/pos/refund
  const splitRefundOut = runPosting(splitDb, modelsForApps(['pos']), '/api/pos/refund', {
    id: splitOrder.id,
  });
  const finalDb = commitAsSystem(splitDb, splitRefundOut.db);
  assert.equal(read(finalDb, 'pos.order', splitOrder.id).state, 'refunded');
  assert.deepEqual(sessionTotals(finalDb, session), { orders: 4, cash: 0, card: 0, expected: 100 });
});

test('server posting automated-valuation return committed through real diff/apply path retains return_layers and cancellation restores stock, valuation and drawer totals', () => {
  let db = seed();
  const prod = create(db, 'product', { name: 'Committed Return Goods', type: 'goods', valuation: 'real_time', cost: 20, list_price: 50, sale_tax: 0, available_in_pos: true, sale_ok: true });
  db = prod.db;
  const cfg = search(db, 'pos.config')[0];
  const preset = create(db, 'pos.preset', { name: 'Return Preset', is_return: true, identification: 'none', service_at: 'counter' });
  db = write(preset.db, 'pos.config', cfg.id, { available_preset_ids: [preset.id], default_preset_id: preset.id });
  db = startSession(db, 100, cfg.id).db;
  const session = search(db, 'pos.session').find((s) => s.state === 'opened');
  const methods = search(db, 'pos.payment.method').filter((m) => cfg.payment_method_ids?.includes(m.id));
  const cash = methods.find((m) => m.type === 'cash');
  assert.ok(cash);

  const quantQty = (state) => (state.records['stock.quant'] ?? []).filter((q) => q.product_id === prod.id).reduce((s, q) => s + q.quantity, 0);
  const layerVal = (state) => (state.records['stock.valuation.layer'] ?? []).filter((l) => l.product_id === prod.id).reduce((s, l) => s + l.value, 0);

  assert.equal(quantQty(db), 0);
  assert.equal(layerVal(db), 0);
  assert.deepEqual(sessionTotals(db, session), { orders: 0, cash: 0, card: 0, expected: 100 });

  // 1. Create a return via server posting
  const returnOut = runPosting(db, modelsForApps(['pos']), '/api/pos/pay', {
    lines: [{ product_id: prod.id, qty: -2, price_unit: 50, tax: 0 }],
    method: cash.id,
  });

  // 2. Commit through the real diff/apply path
  const committedDb = commitAsSystem(db, returnOut.db);

  // 3. Reload from stored snapshot
  const reloadedDb = JSON.parse(JSON.stringify(committedDb));
  const returnOrder = read(reloadedDb, 'pos.order', returnOut.body.id);

  assert.ok(Array.isArray(returnOrder.return_layers) && returnOrder.return_layers.length === 1);
  assert.equal(returnOrder.return_layers[0].index, 0);
  assert.ok(returnOrder.return_layers[0].layer_id);
  assert.equal(returnOrder.preset_snapshot?.is_return, true);

  assert.equal(quantQty(reloadedDb), 2);
  assert.equal(layerVal(reloadedDb), 40);
  assert.deepEqual(sessionTotals(reloadedDb, session), { orders: 1, cash: -100, card: 0, expected: 0 });

  // 4. Cancel it via server posting /api/pos/refund
  const cancelOut = runPosting(reloadedDb, modelsForApps(['pos']), '/api/pos/refund', {
    id: returnOrder.id,
  });
  const finalCommitted = commitAsSystem(reloadedDb, cancelOut.db);
  const finalDb = JSON.parse(JSON.stringify(finalCommitted));

  // 5. Check stock, valuation, and drawer totals
  assert.equal(quantQty(finalDb), 0, 'stock must return to original quantity (0)');
  assert.equal(layerVal(finalDb), 0, 'net valuation must return to original value (0)');
  assert.deepEqual(sessionTotals(finalDb, session), { orders: 2, cash: 0, card: 0, expected: 100 }, 'drawer cash must be restored to opening expected');

  const layers = (finalDb.records['stock.valuation.layer'] ?? []).filter((l) => l.product_id === prod.id);
  assert.equal(layers.length, 2);
  const [inLayer, outLayer] = layers;
  assert.equal(inLayer.quantity, 2);
  assert.equal(inLayer.value, 40);
  assert.equal(inLayer.remaining_qty, 0);
  assert.equal(inLayer.remaining_value, 0);
  assert.equal(outLayer.quantity, -2);
  assert.equal(outLayer.value, -40);
  assert.equal(outLayer.reversed_layer_id, inLayer.id);
});

test('public server-path regression: zero-total stockable sale refunded in a session of another company is rejected and nothing moves', () => {
  let db = seed();
  const c2 = create(db, 'res.company', { name: 'Company Two' });
  db = c2.db;
  for (const [code, type] of [['121000', 'asset_receivable'], ['400000', 'income'], ['101501', 'asset_cash'], ['110100', 'asset_current'], ['500000', 'expense_direct'], ['450000', 'income_other'], ['690000', 'expense_other']]) {
    db = create(db, 'account.account', { code, name: `C2 ${code}`, account_type: type, company_id: c2.id }).db;
  }
  const account = (code) => search(db, 'account.account').find((a) => a.code === code && a.company_id === c2.id);
  const c2Journal = create(db, 'account.journal', { name: 'C2 Cash Journal', code: 'CSH2', type: 'cash', company_id: c2.id, default_account_id: account('101501').id });
  db = c2Journal.db;
  const cfg2 = create(db, 'pos.config', { name: 'C2 POS', company_id: c2.id });
  db = cfg2.db;
  const c2CashMethod = create(db, 'pos.payment.method', { name: 'C2 Cash', type: 'cash', company_id: c2.id, config_ids: [cfg2.id], journal_id: c2Journal.id });
  db = c2CashMethod.db;
  db = write(db, 'pos.config', cfg2.id, { payment_method_ids: [c2CashMethod.id] });

  // Stockable goods product in Company 1
  const prod = create(db, 'product', { name: 'Free Promotional Goods', type: 'goods', valuation: 'real_time', cost: 15, list_price: 30, sale_tax: 0, available_in_pos: true, sale_ok: true });
  db = receive(prod.db, prod.id, 5, 15, { company_id: 1 });

  // 1. Session in Company 1
  const cfg1 = search(db, 'pos.config').find((c) => (c.company_id ?? 1) === 1);
  db = startSession(db, 100, cfg1.id).db;
  const session1 = openSession(db);
  const cash1 = search(db, 'pos.payment.method').find((m) => (m.company_id ?? 1) === 1 && m.type === 'cash');

  // Sell zero-total stockable item via /api/pos/pay
  const saleOut = runPosting(db, modelsForApps(['pos']), '/api/pos/pay', {
    lines: [{ product_id: prod.id, qty: 1, price_unit: 30, discount: 100, tax: 0 }],
    method: cash1.id,
  });
  db = commitAsSystem(db, saleOut.db);
  const saleOrder = read(db, 'pos.order', saleOut.body.id);
  assert.equal(saleOrder.amount_total, 0);
  assert.equal(saleOrder.state, 'paid');
  assert.equal(saleOrder.company_id, 1);

  // Close Session 1
  db = closeSession(db, session1, 100);
  assert.equal(openSession(db), null);

  // 2. Open Session in Company 2
  db = startSession(db, 80, cfg2.id).db;
  const session2 = openSession(db);
  assert.equal(session2.company_id, c2.id);

  // Capture database state before refund attempt
  const before = JSON.parse(JSON.stringify(db));
  const quantC1 = (state) => (state.records['stock.quant'] ?? []).find((q) => q.product_id === prod.id && q.company_id === 1)?.quantity ?? 0;
  const quantC2 = (state) => (state.records['stock.quant'] ?? []).find((q) => q.product_id === prod.id && q.company_id === c2.id)?.quantity ?? 0;
  const layersCount = (state) => (state.records['stock.valuation.layer'] ?? []).length;
  const ordersCount = (state) => (state.records['pos.order'] ?? []).length;
  const movesCount = (state) => (state.records['account.move'] ?? []).length;

  assert.equal(quantC1(db), 4);
  assert.equal(quantC2(db), 0);

  // 3. Attempt refund of Company 1's zero-total order through public server path /api/pos/refund
  assert.throws(
    () => runPosting(db, modelsForApps(['pos']), '/api/pos/refund', { id: saleOrder.id }),
    /company/i
  );

  // Also via /api/pos/pay with refund_of
  assert.throws(
    () => runPosting(db, modelsForApps(['pos']), '/api/pos/pay', { refund_of: saleOrder.id, method: c2CashMethod.id }),
    /company/i
  );

  // Also via server operation pos.refund
  assert.throws(
    () => runOperation(db, 'pos.refund', { id: saleOrder.id }, { allowed: null, direct: null }),
    /company/i
  );

  // Also via refundOrder directly
  assert.throws(
    () => refundOrder(db, saleOrder),
    /company/i
  );

  // 4. Assert nothing moves: stock, valuation, drawer, orders, moves, and state remain exactly as before
  assert.equal(quantC1(db), 4, 'Company 1 stock quant must be unchanged');
  assert.equal(quantC2(db), 0, 'Company 2 must not receive any stock quant');
  assert.equal(layersCount(db), before.records['stock.valuation.layer'].length, 'no valuation layers created');
  assert.equal(ordersCount(db), before.records['pos.order'].length, 'no refund order created');
  assert.equal(movesCount(db), before.records['account.move'].length, 'no account moves created');
  assert.equal(read(db, 'pos.order', saleOrder.id).state, 'paid', 'sale order state must remain paid');
  assert.deepEqual(sessionTotals(db, session2), { orders: 0, cash: 0, card: 0, expected: 80 }, 'Company 2 session drawer totals unchanged');
});

