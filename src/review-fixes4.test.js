// Regressions for agy's review of Loyalty and Approvals (round 4).
import test from 'node:test';
import assert from 'node:assert/strict';
import { create, emptyDb, read } from './orm.js';
import { seed } from './seed.js';
import { applyCode, computeRewardLines, confirmProgramUsage, consumeOrderCodes, earnPoints } from './models/loyalty.js';
import { submitRequest } from './models/approvalsplus.js';

const line = (product_id, qty, price_unit) => ({ product_id, qty, price_unit, discount: 0, tax: 0 });
const discountOf = (lines) => -lines.reduce((s, l) => s + l.price_unit, 0);

test('the cheapest-product discount takes one unit of the lowest unit price', () => {
  const reward = { reward_type: 'discount', discount: 100, discount_mode: 'percent', discount_applicability: 'cheapest' };
  assert.equal(discountOf(computeRewardLines(emptyDb(), {}, reward, [line(1, 10, 2), line(2, 1, 15)])), 2);
});

test('a fixed discount on a specific product needs that product and is capped at it', () => {
  const reward = { reward_type: 'discount', discount: 20, discount_mode: 'per_order', discount_applicability: 'specific', discount_product_id: 1 };
  assert.deepEqual(computeRewardLines(emptyDb(), {}, reward, [line(2, 1, 100)]), []);
  assert.equal(discountOf(computeRewardLines(emptyDb(), {}, reward, [line(1, 1, 12), line(2, 1, 100)])), 12);
});

test('a loyalty code applies one affordable reward, not every tier at once', () => {
  let db = create(emptyDb(), 'loyalty.program', { name: 'Club', program_type: 'loyalty', sale_ok: true, rule_ids: [], reward_ids: [
    { reward_type: 'discount', discount: 10, discount_mode: 'per_order', required_points: 20 },
    { reward_type: 'discount', discount: 20, discount_mode: 'per_order', required_points: 40 },
  ] });
  db = create(db.db, 'loyalty.card', { program_id: db.id, code: 'CLUB1', points: 50, state: 'active' }).db;
  const applied = applyCode(db, { partner_id: null, order_line: [line(1, 1, 100)] }, 'CLUB1', { channel: 'sale' });
  assert.equal(discountOf(applied.lines.filter((l) => l.product_id == null)), 20);
  assert.equal(applied.pointsSpent, 40);
});

test('money-mode points fall back to the order total and ignore reward lines in quantity rules', () => {
  const program = { rule_ids: [{ reward_point_mode: 'money', reward_point_amount: 1 }] };
  assert.equal(earnPoints(emptyDb(), program, [line(1, 1, 100)]), 100);
  const qtyRule = { rule_ids: [{ minimum_qty: 3, reward_point_mode: 'order', reward_point_amount: 5 }] };
  assert.equal(earnPoints(emptyDb(), qtyRule, [line(1, 1, 10), line(2, 1, 10), line(null, 1, -5)]), 0);
});

test('spending part of a gift card keeps the rest of its balance', () => {
  let db = create(emptyDb(), 'loyalty.program', { name: 'Gift', program_type: 'gift_card' });
  const programId = db.id;
  db = create(db.db, 'loyalty.card', { program_id: programId, code: 'GIFT100', points: 100, state: 'active' }).db;
  const next = confirmProgramUsage(db, programId, { cardCode: 'GIFT100', pointsSpent: 20 });
  const card = next.records['loyalty.card'][0];
  assert.equal(card.points, 80);
  assert.equal(card.state, 'active');
});

test('confirming a sales order consumes its coupon', () => {
  let db = create(emptyDb(), 'loyalty.program', { name: 'Coupons', program_type: 'coupons', sale_ok: true, rule_ids: [], reward_ids: [{ reward_type: 'discount', discount: 10, discount_mode: 'percent' }] });
  const programId = db.id;
  db = create(db.db, 'loyalty.card', { program_id: programId, code: 'C1', points: 1, state: 'active' }).db;
  const next = consumeOrderCodes(db, { partner_id: null, loyalty_uses: [{ code: 'C1', programId, cardCode: 'C1', gift: false, spent: 0 }] });
  assert.equal(next.records['loyalty.card'][0].state, 'used');
  assert.throws(() => applyCode(next, { partner_id: null, order_line: [line(1, 1, 100)] }, 'C1', { channel: 'sale' }));
});

test('purchase and leave requests need what their follow-up records need before submission', () => {
  const base = seed();
  const purchase = create(base, 'approval.category', { name: 'Buy', approval_type: 'purchase', approver_ids: [{ employee_id: 1, sequence: 1 }] });
  const noVendor = create(purchase.db, 'approval.request', { name: 'Chairs', category_id: purchase.id, request_owner_id: 5, product_lines: [{ product_id: 1, qty: 1, price: 10 }] });
  assert.throws(() => submitRequest(noVendor.db, read(noVendor.db, 'approval.request', noVendor.id)), /vendor/);
  const noLines = create(purchase.db, 'approval.request', { name: 'Chairs', category_id: purchase.id, request_owner_id: 5, partner_id: 1 });
  assert.throws(() => submitRequest(noLines.db, read(noLines.db, 'approval.request', noLines.id)), /products/);
  const leave = create(base, 'approval.category', { name: 'Leave', approval_type: 'leave', approver_ids: [{ employee_id: 1, sequence: 1 }] });
  const noDate = create(leave.db, 'approval.request', { name: 'Holiday', category_id: leave.id, request_owner_id: 5, date: null });
  assert.throws(() => submitRequest(noDate.db, read(noDate.db, 'approval.request', noDate.id)), /start date/);
});
