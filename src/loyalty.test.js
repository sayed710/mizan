import test from 'node:test';
import assert from 'node:assert/strict';
import { create, emptyDb, read, search } from './orm.js';
import { seed } from './seed.js';
import {
  applicablePrograms,
  applyCode,
  computeRewardLines,
  confirmProgramUsage,
  earnPoints,
  generateCoupons,
  giftCardPay,
} from './models/loyalty.js';
import { loyaltyModels } from './models/loyalty.js';

const productLine = (product_id, qty, price_unit) => ({ product_id, qty, price_unit, discount: 0, tax: 0 });

function addProgram(db, values = {}) {
  const result = create(db, 'loyalty.program', { name: 'Test Program', ...values });
  return { db: result.db, program: read(result.db, 'loyalty.program', result.id) };
}

test('automatic programs enforce minimum quantity, amount, dates, and channel', () => {
  const { db, program } = addProgram(emptyDb(), {
    program_type: 'promotion',
    date_from: '2026-10-01',
    date_to: '2026-10-31',
    pos_ok: false,
    rule_ids: [{ product_id: 1, minimum_qty: 3, minimum_amount: 100 }],
  });
  const order = { partner_id: 7 };
  const qualifying = [productLine(1, 3, 50)];

  assert.deepEqual(applicablePrograms(db, order, { lines: qualifying, date: '2026-10-25', channel: 'sale' }).map((item) => item.id), [program.id]);
  assert.deepEqual(applicablePrograms(db, order, { lines: [productLine(1, 2, 100)], date: '2026-10-25', channel: 'sale' }), []);
  assert.deepEqual(applicablePrograms(db, order, { lines: [productLine(1, 3, 20)], date: '2026-10-25', channel: 'sale' }), []);
  assert.deepEqual(applicablePrograms(db, order, { lines: qualifying, date: '2026-09-30', channel: 'sale' }), []);
  assert.deepEqual(applicablePrograms(db, order, { lines: qualifying, date: '2026-11-01', channel: 'sale' }), []);
  assert.deepEqual(applicablePrograms(db, order, { lines: qualifying, date: '2026-10-25', channel: 'pos' }), []);
});

test('discount rewards handle order percentage, cheapest line, and fixed caps', () => {
  const db = emptyDb();
  const program = { name: 'Summer Sale' };
  const lines = [productLine(1, 1, 100), productLine(2, 1, 40)];
  const orderPercent = computeRewardLines(db, program, {
    reward_type: 'discount', discount: 10, discount_mode: 'percent', discount_applicability: 'order', description: '10% off',
  }, lines);
  assert.equal(orderPercent[0].price_unit, -14);
  assert.equal(orderPercent[0].name, 'Discount: 10% off');
  assert.equal(orderPercent[0].tax, 0);

  const cheapestPercent = computeRewardLines(db, program, {
    reward_type: 'discount', discount: 10, discount_mode: 'percent', discount_applicability: 'cheapest', description: 'Cheapest item',
  }, lines);
  assert.equal(cheapestPercent[0].price_unit, -4);

  const fixedDiscount = computeRewardLines(db, program, {
    reward_type: 'discount', discount: 200, discount_mode: 'per_order', discount_applicability: 'order',
  }, lines);
  assert.equal(fixedDiscount[0].price_unit, -140);
  assert.equal(computeRewardLines(db, program, { reward_type: 'discount', discount: 0, discount_mode: 'per_order' }, lines).length, 0);
});

test('buy three get one free awards two free units when seven are purchased', () => {
  const db = emptyDb();
  const program = { program_type: 'buy_x_get_y', rule_ids: [{ product_id: 1, minimum_qty: 3 }] };
  const reward = { reward_type: 'product', reward_product_id: 9, reward_product_qty: 1, description: 'Free item' };
  const lines = [productLine(1, 7, 12)];
  assert.deepEqual(computeRewardLines(db, program, reward, lines), [{
    product_id: 9, name: 'Free item', qty: 2, price_unit: 0, discount: 0, tax: 0,
  }]);
});

test('discount codes and coupon codes apply, while unknown, used, and expired codes are refused', () => {
  let db = emptyDb();
  const discount = addProgram(db, {
    program_type: 'discount_code', trigger: 'with_code', code: 'SAVE10',
    reward_ids: [{ reward_type: 'discount', discount: 10, discount_mode: 'percent', discount_applicability: 'order' }],
  });
  db = discount.db;
  const lines = [productLine(1, 1, 100)];
  assert.equal(applyCode(db, { order_line: lines }, 'SAVE10', { channel: 'sale', date: '2026-10-25' }).lines.at(-1).price_unit, -10);
  assert.throws(() => applyCode(db, { order_line: lines }, 'NOT-A-CODE'), /Unknown promotion code/);

  const coupon = addProgram(db, {
    program_type: 'coupons',
    reward_ids: [{ reward_type: 'discount', discount: 5, discount_mode: 'per_order', discount_applicability: 'order' }],
  });
  db = generateCoupons(coupon.db, coupon.program.id, {
    count: 1, partnerIds: [4], points: 1, expiration: '2026-12-31', codeFn: () => 'WELCOME',
  });
  const applied = applyCode(db, { partner_id: 4, order_line: lines }, 'WELCOME', { date: '2026-10-25' });
  assert.equal(applied.card.partner_id, 4);
  assert.equal(applied.lines.at(-1).price_unit, -5);
  db = confirmProgramUsage(db, coupon.program.id, { cardCode: 'WELCOME', partnerId: 4 });
  assert.equal(read(db, 'loyalty.card', applied.card.id).state, 'used');
  assert.throws(() => applyCode(db, { partner_id: 4, order_line: lines }, 'WELCOME'), /already been used/);

  db = generateCoupons(db, coupon.program.id, {
    count: 1, points: 1, expiration: '2025-12-31', codeFn: () => 'OLD-CODE',
  });
  assert.throws(() => applyCode(db, { order_line: lines }, 'OLD-CODE', { date: '2026-10-25' }), /expired/);
});

test('loyalty earns order, money, and unit points, then spends them safely', () => {
  const { db, program } = addProgram(emptyDb(), {
    program_type: 'loyalty',
    rule_ids: [
      { reward_point_amount: 4, reward_point_mode: 'order' },
      { reward_point_amount: 1.5, reward_point_mode: 'money' },
      { product_id: 1, reward_point_amount: 0.5, reward_point_mode: 'unit' },
    ],
  });
  const lines = [productLine(1, 2, 10), productLine(2, 1, 5)];
  assert.equal(earnPoints(db, program, lines, 25.75), 42.5);

  let next = confirmProgramUsage(db, program.id, { pointsEarned: 42.5, partnerId: 7 });
  const card = next.records['loyalty.card'][0];
  assert.equal(card.partner_id, 7);
  assert.equal(card.points, 42.5);
  next = confirmProgramUsage(next, program.id, { cardCode: card.code, pointsSpent: 10, partnerId: 7 });
  assert.equal(read(next, 'loyalty.card', card.id).points, 32.5);
  assert.throws(() => confirmProgramUsage(next, program.id, { cardCode: card.code, pointsSpent: 40, partnerId: 7 }), /Insufficient loyalty points/);
  assert.equal(read(next, 'loyalty.card', card.id).points, 32.5);
});

test('gift cards accept partial payment and never create a negative balance', () => {
  const { db, program } = addProgram(emptyDb(), { program_type: 'gift_card' });
  let next = generateCoupons(db, program.id, { count: 1, points: 30, codeFn: () => 'GIFT30' });
  let payment = giftCardPay(next, 'GIFT30', 12.34);
  assert.equal(payment.used, 12.34);
  assert.equal(read(payment.db, 'loyalty.card', 1).points, 17.66);
  payment = giftCardPay(payment.db, 'GIFT30', 50);
  assert.equal(payment.used, 17.66);
  assert.equal(read(payment.db, 'loyalty.card', 1).points, 0);
  assert.equal(read(payment.db, 'loyalty.card', 1).state, 'used');
  assert.throws(() => giftCardPay(payment.db, 'GIFT30', 1), /already been used/);
});

test('coupon generation is deterministic when requested and usage limits are enforced', () => {
  const { db, program } = addProgram(emptyDb(), {
    limit_usage: true, max_usage: 1,
    rule_ids: [{ minimum_qty: 1 }],
  });
  const generated = generateCoupons(db, program.id, {
    count: 2, partnerIds: [11], points: 3, codeFn: (index) => `CODE${index}`,
  });
  assert.deepEqual(generated.records['loyalty.card'].map((card) => card.code), ['CODE0', 'CODE1']);
  assert.deepEqual(generated.records['loyalty.card'].map((card) => card.partner_id), [11, 11]);
  assert.equal(generated.records['loyalty.card'][0].points, 3);
  assert.equal(applicablePrograms(db, { order_line: [productLine(1, 1, 1)] }, { date: '2026-10-25', channel: 'sale' }).length, 1);

  const used = confirmProgramUsage(db, program.id, {});
  assert.equal(read(used, 'loyalty.program', program.id).usage_count, 1);
  assert.deepEqual(applicablePrograms(used, { order_line: [productLine(1, 1, 1)] }, { date: '2026-10-25', channel: 'sale' }), []);
  assert.throws(() => confirmProgramUsage(used, program.id, {}), /usage limit/);
});

test('loyalty model definitions expose the requested program tabs and card views', () => {
  const program = loyaltyModels['loyalty.program'];
  const card = loyaltyModels['loyalty.card'];
  assert.equal(program.label, 'Discount & Loyalty');
  assert.ok(program.form.tabs.some((tab) => tab.label === 'Rules'));
  assert.ok(program.form.tabs.some((tab) => tab.label === 'Rewards'));
  assert.ok(program.form.buttons.some((button) => button.label === 'Generate Coupons'));
  assert.deepEqual(card.views, ['list', 'kanban']);
});

test('the sales order Apply Coupon button adds the discount line for a valid code', async () => {
  const { models } = await import('./models/index.js');
  const base = seed();
  const prog = create(base, 'loyalty.program', {
    name: 'SAVE10', program_type: 'discount_code', trigger: 'with_code', code: 'SAVE10', active: true, sale_ok: true, applies_on: 'current',
    rule_ids: [{ minimum_qty: 0, minimum_amount: 0 }], reward_ids: [{ reward_type: 'discount', discount: 10, discount_mode: 'percent', discount_applicability: 'order', description: '10% off' }],
  });
  const order = search(prog.db, 'sale.order').find((o) => ['draft', 'sent'].includes(o.state));
  const button = models['sale.order'].form.buttons.find((b) => b.label === 'Apply Coupon');
  globalThis.prompt = () => 'SAVE10';
  const out = button.run(prog.db, order).db;
  delete globalThis.prompt;
  const lines = read(out, 'sale.order', order.id).order_line;
  assert.ok(lines.length === order.order_line.length + 1 && lines.at(-1).price_unit < 0);
});
