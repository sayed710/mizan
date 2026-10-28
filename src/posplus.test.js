import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { amounts } from './models/common.js';
import { accountId, isBalanced, journalItems } from './models/ledger.js';
import { openSession, sessionTotals, startSession } from './models/pos.js';
import { posPlusModels, openTableOrder, tableStatus, transferTable, mergeTables, splitBill, addTip, payWithMethods, applyLoyaltyToOrder, zReport } from './models/posplus.js';

const line = (qty = 2, price = 50, tax = 10) => ({ product_id: 1, qty, price_unit: price, tax, discount: 0 });
const round = (n) => Math.round(n * 100) / 100;

function setup() {
  const config = create(startSession(seed(), 100).db, 'pos.config', { name: 'Restaurant', module_restaurant: true, iface_tipproduct: true, tip_product_id: 5, loyalty_enabled: true, payment_method_ids: [{ name: 'Cash', journal: 'cash' }, { name: 'Card', journal: 'bank' }] });
  const floor = create(config.db, 'restaurant.floor', { name: 'Main', config_id: config.id, table_ids: [{ name: 'A', seats: 4, shape: 'square' }, { name: 'B', seats: 2, shape: 'round' }, { name: 'C', seats: 2, shape: 'square' }] });
  const order = openTableOrder(floor.db, { configId: config.id, floorId: floor.id, tableName: 'A', customerCount: 2 });
  return { db: write(order.db, 'pos.order', order.id, { lines: [line()] }), id: order.id, configId: config.id, floorId: floor.id };
}

test('table opening refuses double bookings and status shows occupied and free tables immutably', () => {
  const { db, id, configId, floorId } = setup();
  const before = structuredClone(db);
  assert.equal(read(db, 'pos.order', id).state, 'draft');
  assert.throws(() => openTableOrder(db, { configId, floorId, tableName: 'A', customerCount: 1 }), /already has/);
  assert.throws(() => openTableOrder(db, { configId, floorId, tableName: 'Missing' }), /Select a table/);
  assert.throws(() => openTableOrder(db, { configId, floorId, tableName: 'B', customerCount: 0 }), /guests/);
  assert.deepEqual(tableStatus(db, floorId), [
    { table: 'A', seats: 4, orderId: id, total: 110, guests: 2 },
    { table: 'B', seats: 2, orderId: null, total: 0, guests: 0 },
    { table: 'C', seats: 2, orderId: null, total: 0, guests: 0 },
  ]);
  assert.deepEqual(db, before);
  assert.ok(posPlusModels['pos.config'].form.tabs.length);
  assert.equal(posPlusModels['restaurant.floor'].fields.table_ids.type, 'one2many');
  assert.ok(posPlusModels['pos.order'].fields.kitchen_state);
});

test('transfer validates destinations and merging preserves lines and guests while cancelling the source', () => {
  const { db, id, configId, floorId } = setup();
  const moved = transferTable(db, id, `${floorId}:B`);
  assert.equal(tableStatus(moved, floorId)[0].orderId, null);
  assert.equal(read(db, 'pos.order', id).table_id, `${floorId}:A`);
  const other = openTableOrder(moved, { configId, floorId, tableName: 'A', customerCount: 3 });
  const ready = write(other.db, 'pos.order', other.id, { lines: [line(1, 25)] });
  assert.throws(() => transferTable(ready, id, `${floorId}:A`), /already has/);
  assert.throws(() => mergeTables(ready, id, id), /different/);
  const merged = mergeTables(ready, other.id, id);
  assert.equal(read(merged, 'pos.order', other.id).state, 'cancel');
  assert.equal(read(merged, 'pos.order', id).lines.length, 2);
  assert.equal(read(merged, 'pos.order', id).customer_count, 5);
  assert.equal(tableStatus(merged, floorId)[1].total, 137.5);
});

test('splitting moves quantities, removes empty lines and rejects cumulative over-selection', () => {
  const { db, id, floorId } = setup();
  const ready = write(db, 'pos.order', id, { lines: [line(3), line(1, 20)] });
  assert.throws(() => splitBill(ready, id, [{ index: 0, qty: 4 }]), /exceeds/);
  assert.throws(() => splitBill(ready, id, [{ index: 0, qty: 2 }, { index: 0, qty: 2 }]), /exceeds/);
  assert.throws(() => splitBill(ready, id, [{ index: 4, qty: 1 }]), /valid lines/);
  const split = splitBill(ready, id, [{ index: 0, qty: 1 }, { index: 1, qty: 1 }]);
  const original = read(split.db, 'pos.order', id);
  const bill = read(split.db, 'pos.order', split.newOrderId);
  assert.deepEqual(original.lines.map((l) => l.qty), [2]);
  assert.deepEqual(bill.lines.map((l) => l.qty), [1, 1]);
  assert.equal(bill.table_id, original.table_id);
  assert.equal(bill.state, 'draft');
  assert.equal(original.amount_total + bill.amount_total, 187);
  assert.equal(tableStatus(split.db, floorId)[0].guests, 2);
  assert.equal(tableStatus(split.db, floorId)[0].total, 187);
  assert.equal(read(ready, 'pos.order', id).lines[0].qty, 3);
});

test('tips use the configured product without tax and replace rather than duplicate', () => {
  const { db, id } = setup();
  const tipped = addTip(db, id, 15);
  const order = read(tipped, 'pos.order', id);
  assert.equal(order.tip_amount, 15);
  assert.deepEqual(order.lines[1], { product_id: 5, name: 'Tip', qty: 1, price_unit: 15, tax: 0, discount: 0, is_tip: true });
  assert.equal(order.amount_total, 125);
  assert.equal(read(addTip(tipped, id, 10), 'pos.order', id).lines.length, 2);
  assert.equal(read(addTip(tipped, id, 0), 'pos.order', id).lines.length, 1);
  assert.throws(() => addTip(db, id, -1), /non-negative/);
});

test('cash plus card returns cash change, books each method and moves total stock once', () => {
  const { db, id } = setup();
  const before = structuredClone(db);
  const cashBefore = journalItems(db).filter((l) => l.account_id === accountId(db, '101501')).reduce((s, l) => s + l.debit - l.credit, 0);
  const bankBefore = journalItems(db).filter((l) => l.account_id === accountId(db, '101401')).reduce((s, l) => s + l.debit - l.credit, 0);
  assert.throws(() => payWithMethods(db, id, [{ method: 'cash', amount: 100 }]), /cover/);
  assert.throws(() => payWithMethods(db, id, [{ method: 'card', amount: 120 }]), /Only cash/);
  const paid = payWithMethods(db, id, [{ method: 'cash', amount: 70 }, { method: 'card', amount: 50 }]);
  assert.equal(paid.change, 10);
  const order = read(paid.db, 'pos.order', id);
  assert.equal(order.state, 'paid');
  assert.equal(order.amount_total, 110);
  assert.equal(order.payment_ids.length, 2);
  assert.equal(read(paid.db, 'product', 1).qty_available, read(db, 'product', 1).qty_available - 2);
  const balance = (code) => journalItems(paid.db).filter((l) => l.account_id === accountId(paid.db, code)).reduce((s, l) => s + l.debit - l.credit, 0);
  assert.equal(round(balance('101501') - cashBefore), 60);
  assert.equal(round(balance('101401') - bankBefore), 50);
  // One settlement carries the whole bill with whole quantities; only the money is split (FLOW-017).
  assert.deepEqual(sessionTotals(paid.db, openSession(paid.db)), { orders: 1, cash: 60, card: 50, expected: 160 });
  const settlements = search(paid.db, 'pos.order').filter((o) => o.settlement_of === id);
  assert.deepEqual(settlements.map((o) => o.lines.map((l) => l.qty)), [order.lines.map((l) => l.qty)]);
  assert.deepEqual(settlements[0].payment_ids, [{ method: 'cash', amount: 60 }, { method: 'bank', amount: 50 }]);
  assert.ok(search(paid.db, 'account.move').filter((m) => m.state === 'posted').every((m) => isBalanced(m.line_ids)));
  assert.throws(() => payWithMethods(paid.db, id, [{ method: 'cash', amount: 110 }]), /draft/);
  assert.deepEqual(db, before);
});

test('automatic POS promotions respect channel and earn customer points only on payment', () => {
  const setupData = setup();
  const { id } = setupData;
  let db = write(setupData.db, 'pos.order', id, { partner_id: 1, lines: [line(2, 50, 0)] });
  const promotion = create(db, 'loyalty.program', { name: 'POS ten percent', program_type: 'promotion', reward_ids: [{ reward_type: 'discount', discount: 10, discount_mode: 'percent' }] });
  const excluded = create(promotion.db, 'loyalty.program', { name: 'Sales only', pos_ok: false, reward_ids: [{ reward_type: 'discount', discount: 99 }] });
  const points = create(excluded.db, 'loyalty.program', { name: 'Customer points', program_type: 'loyalty', rule_ids: [{ reward_point_mode: 'money', reward_point_amount: 1 }] });
  db = applyLoyaltyToOrder(points.db, id);
  assert.equal(read(db, 'pos.order', id).amount_total, 90);
  assert.equal(read(db, 'loyalty.program', promotion.id).usage_count, 0);
  assert.throws(() => applyLoyaltyToOrder(db, id), /already/);
  const paid = payWithMethods(db, id, [{ method: 'cash', amount: 90 }]).db;
  assert.equal(read(paid, 'pos.order', id).loyalty_points_earned, 90);
  assert.equal(read(paid, 'loyalty.program', promotion.id).usage_count, 1);
  assert.equal(read(paid, 'loyalty.program', excluded.id).usage_count, 0);
  assert.equal(search(paid, 'loyalty.card').find((c) => c.program_id === points.id && c.partner_id === 1).points, 90);
  assert.equal(zReport(paid, openSession(paid).id).discounts, 10);
});

test('POS codes reject the wrong channel and consume a coupon only after payment', () => {
  const setupData = setup();
  const { id } = setupData;
  const program = create(setupData.db, 'loyalty.program', { name: 'Coupon', program_type: 'coupons', reward_ids: [{ reward_type: 'discount', discount_mode: 'per_order', discount: 10 }] });
  const coupon = create(program.db, 'loyalty.card', { program_id: program.id, partner_id: 1, code: 'POS-COUPON' });
  const db = write(coupon.db, 'pos.order', id, { partner_id: 1 });
  assert.throws(() => applyLoyaltyToOrder(write(db, 'loyalty.program', program.id, { pos_ok: false }), id, 'POS-COUPON'), /channel/);
  const applied = applyLoyaltyToOrder(db, id, 'POS-COUPON');
  assert.equal(read(applied, 'loyalty.card', coupon.id).state, 'active');
  const paid = payWithMethods(applied, id, [{ method: 'bank', amount: 100 }]).db;
  assert.equal(read(paid, 'loyalty.card', coupon.id).state, 'used');
});

test('Z report reconciles session totals, taxes, tips and full split-tender refunds', () => {
  const { db, id } = setup();
  const tipped = addTip(db, id, 15);
  const paid = payWithMethods(tipped, id, [{ method: 'cash', amount: 75 }, { method: 'bank', amount: 50 }]).db;
  const session = openSession(paid);
  const report = zReport(paid, session.id);
  const totals = sessionTotals(paid, session);
  assert.equal(report.orders, totals.orders);
  assert.deepEqual(report.byMethod, { cash: totals.cash, bank: totals.card });
  assert.equal(report.total, 125);
  assert.equal(report.taxes, 10);
  assert.equal(report.tips, 15);
  assert.equal(report.discounts, 0);
  const refunded = posPlusModels['pos.order'].form.buttons.find((b) => b.label === 'Refund').run(paid, read(paid, 'pos.order', id)).db;
  const after = zReport(refunded, session.id);
  assert.equal(after.refunds, 1);
  assert.equal(after.orders, sessionTotals(refunded, session).orders);
  assert.deepEqual(after.byMethod, { cash: 0, bank: 0 });
  assert.equal(after.total, 0);
  assert.equal(after.taxes, 0);
  assert.equal(after.tips, 0);
  assert.equal(read(refunded, 'product', 1).qty_available, read(db, 'product', 1).qty_available);
  assert.equal(amounts(read(paid, 'pos.order', id).lines).total, 125);
});

test('anonymous coupons and fully covering gift cards are consumed when their bills are paid', () => {
  const { db, id } = setup();
  const couponProgram = create(db, 'loyalty.program', { name: 'Guest coupon', program_type: 'coupons', reward_ids: [{ reward_type: 'discount', discount_mode: 'per_order', discount: 10 }] });
  const coupon = create(couponProgram.db, 'loyalty.card', { program_id: couponProgram.id, code: 'GUEST' });
  const applied = applyLoyaltyToOrder(coupon.db, id, 'GUEST');
  const paid = payWithMethods(applied, id, [{ method: 'cash', amount: 100 }]).db;
  assert.equal(read(paid, 'loyalty.card', coupon.id).state, 'used');
  assert.equal(read(paid, 'pos.order', id).loyalty_points_earned, 0);
  const giftProgram = create(db, 'loyalty.program', { name: 'Gift', program_type: 'gift_card' });
  const card = create(giftProgram.db, 'loyalty.card', { program_id: giftProgram.id, code: 'GIFT', points: 110 });
  const gifted = applyLoyaltyToOrder(card.db, id, 'GIFT');
  assert.equal(read(gifted, 'pos.order', id).amount_total, 0);
  const redeemed = payWithMethods(gifted, id, []).db;
  assert.equal(read(redeemed, 'loyalty.card', card.id).points, 0);
  assert.equal(read(redeemed, 'loyalty.card', card.id).state, 'used');
  assert.equal(read(redeemed, 'product', 1).qty_available, read(db, 'product', 1).qty_available - 2);
});

test('uneven split payments conserve cents in both revenue and tax', () => {
  const { db, id } = setup();
  const ready = write(db, 'pos.order', id, { lines: [line(1, 0.05, 10)] });
  const paid = payWithMethods(ready, id, [{ method: 'cash', amount: 0.03 }, { method: 'bank', amount: 0.03 }]).db;
  const report = zReport(paid, openSession(paid).id);
  assert.equal(report.total, 0.06);
  assert.equal(report.taxes, 0.01);
  assert.deepEqual(report.byMethod, { cash: 0.03, bank: 0.03 });
  assert.ok(search(paid, 'account.move').filter((m) => m.state === 'posted').every((m) => isBalanced(m.line_ids)));
});
