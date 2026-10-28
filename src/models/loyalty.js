import { create, read, write } from '../orm.js';
import { amounts, today } from './common.js';
import { round } from '../money.js';

const numeric = (value) => Number(value) || 0;
const linesOf = (order, lines) => lines ?? order?.order_line ?? order?.lines ?? [];
const dateOf = (value) => value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? today()).slice(0, 10);
const randomCode = () => globalThis.crypto.randomUUID().slice(0, 12).toUpperCase();
const cardsOf = (db) => db.records['loyalty.card'] ?? [];
const programsOf = (db) => db.records['loyalty.program'] ?? [];

function matchingLines(lines, rule) {
  // Reward lines (no product) never count toward a rule.
  return rule?.product_id == null ? lines.filter((line) => line.product_id != null) : lines.filter((line) => line.product_id === rule.product_id);
}

function ruleMetrics(lines, rule) {
  const matching = matchingLines(lines, rule);
  return {
    lines: matching,
    qty: matching.reduce((sum, line) => sum + numeric(line.qty), 0),
    amount: amounts(matching).total,
  };
}

function ruleSatisfied(lines, rule) {
  if (!rule) return true;
  const metrics = ruleMetrics(lines, rule);
  return metrics.qty >= numeric(rule.minimum_qty) && metrics.amount >= numeric(rule.minimum_amount);
}

function programDateAndChannel(program, date, channel) {
  if (program.active === false) return false;
  const on = dateOf(date);
  if (program.date_from && on < dateOf(program.date_from)) return false;
  if (program.date_to && on > dateOf(program.date_to)) return false;
  if (channel === 'sale' && program.sale_ok === false) return false;
  if (channel === 'pos' && program.pos_ok === false) return false;
  if (program.limit_usage && numeric(program.usage_count) >= numeric(program.max_usage)) return false;
  return true;
}

function programRulesMatch(program, lines) {
  const rules = program.rule_ids ?? [];
  return !rules.length || rules.some((rule) => ruleSatisfied(lines, rule));
}

function assertAvailableCard(card, date) {
  if (!card) throw new Error('Unknown coupon or gift card code');
  if (card.state === 'used') throw new Error('This code has already been used');
  if (card.state === 'expired' || (card.expiration_date && dateOf(date) > dateOf(card.expiration_date))) {
    throw new Error('This code has expired');
  }
}

function assertUsageAvailable(program) {
  if (program.limit_usage && numeric(program.usage_count) >= numeric(program.max_usage)) {
    throw new Error('This program has reached its usage limit');
  }
}

/** Generate unique, partner-assigned coupon or card codes without mutating the input db. */
export function generateCoupons(db, programId, { count, partnerIds = [], points = 1, expiration = null, codeFn = randomCode } = {}) {
  const program = read(db, 'loyalty.program', programId);
  if (!program) throw new Error(`Loyalty program #${programId} not found`);
  const quantity = Number(count);
  if (!Number.isInteger(quantity) || quantity < 0) throw new Error('Coupon count must be a non-negative integer');

  let next = db;
  for (let i = 0; i < quantity; i++) {
    const partner_id = partnerIds.length ? partnerIds[i % partnerIds.length] : null;
    const code = String(codeFn(i, programId, partner_id) ?? '').trim().toUpperCase();
    if (!code) throw new Error('Coupon codes cannot be empty');
    if (cardsOf(next).some((card) => card.code === code)) throw new Error(`Coupon code ${code} already exists`);
    next = create(next, 'loyalty.card', {
      program_id: programId,
      partner_id,
      code,
      points: numeric(points),
      expiration_date: expiration ?? null,
      state: 'active',
    }).db;
  }
  return next;
}

/** Return the active programs whose context and at least one rule match this order. */
export function applicablePrograms(db, order, { lines, partnerId, code, date, channel = 'sale' } = {}) {
  const orderLines = linesOf(order, lines);
  const on = date ?? order?.date_order ?? today();
  return programsOf(db).filter((program) => {
    if (!programDateAndChannel(program, on, channel)) return false;
    if (program.trigger === 'with_code' && String(code ?? '') !== String(program.code ?? '')) return false;
    return programRulesMatch(program, orderLines);
  });
}

/** Compute accounting lines for a discount or free-product reward. */
export function computeRewardLines(db, program, reward, lines = []) {
  if (!reward) return [];
  if (reward.reward_type === 'discount') {
    const total = Math.max(0, amounts(lines).total);
    const mode = reward.discount_mode ?? 'percent';
    let basis = total;
    if (reward.discount_applicability === 'cheapest') {
      // One unit of the product with the lowest unit price.
      const units = lines
        .filter((line) => line.product_id != null && numeric(line.qty) > 0)
        .map((line) => Math.max(0, amounts([{ ...line, qty: 1 }]).total))
        .filter((amount) => amount > 0)
        .sort((a, b) => a - b);
      basis = units[0] ?? 0;
    } else if (reward.discount_applicability === 'specific') {
      basis = Math.max(0, amounts(lines.filter((line) => line.product_id === reward.discount_product_id)).total);
    }
    const rawDiscount = mode === 'percent' ? basis * numeric(reward.discount) / 100 : numeric(reward.discount);
    const discount = round(Math.min(total, basis, Math.max(0, rawDiscount)));
    if (!discount) return [];
    return [{
      product_id: null,
      name: `Discount: ${reward.description || program?.name || 'Reward'}`,
      qty: 1,
      price_unit: -discount,
      discount: 0,
      tax: 0,
    }];
  }

  if (reward.reward_type !== 'product' || reward.reward_product_id == null) return [];
  const rewardQty = numeric(reward.reward_product_qty) || 1;
  let qty = rewardQty;
  if (program?.program_type === 'buy_x_get_y') {
    const rules = (program.rule_ids ?? []).filter((rule) => numeric(rule.minimum_qty) > 0);
    if (!rules.length) return [];
    const freeUnits = rules.map((rule) => {
      const metrics = ruleMetrics(lines, rule);
      return ruleSatisfied(lines, rule) ? Math.floor(metrics.qty / numeric(rule.minimum_qty)) * rewardQty : 0;
    });
    qty = Math.max(...freeUnits, 0);
  }
  if (qty <= 0) return [];
  return [{
    product_id: reward.reward_product_id,
    name: reward.description || read(db, 'product', reward.reward_product_id)?.name || 'Free Product',
    qty,
    price_unit: 0,
    discount: 0,
    tax: 0,
  }];
}

function assertProgramForOrder(db, program, order, orderLines, { channel, date, code }) {
  if (!programDateAndChannel(program, date, channel)) {
    if (program.date_to && dateOf(date) > dateOf(program.date_to)) throw new Error('This promotion code has expired');
    throw new Error('This promotion code is not active for this channel or date');
  }
  if (program.trigger === 'with_code' && String(code ?? '') !== String(program.code ?? '')) {
    throw new Error('This promotion code is not valid');
  }
  if (!programRulesMatch(program, orderLines)) throw new Error('This code does not meet the order requirements');
  assertUsageAvailable(program);
  return applicablePrograms(db, order, { lines: orderLines, partnerId: order.partner_id, code: program.code, date, channel }).some((p) => p.id === program.id);
}

/** Apply a program, coupon, or gift-card code to the order's current lines. */
export function applyCode(db, order, code, { channel = 'sale', date = today() } = {}) {
  const value = String(code ?? '').trim();
  if (!value) throw new Error('Unknown promotion code');
  const orderLines = linesOf(order);
  const program = programsOf(db).find((item) => String(item.code ?? '') === value);
  if (program) {
    if (!assertProgramForOrder(db, program, order, orderLines, { channel, date, code: value })) {
      throw new Error('This promotion code is not valid for this order');
    }
    const added = (program.reward_ids ?? []).flatMap((reward) => computeRewardLines(db, program, reward, orderLines));
    return { lines: [...orderLines, ...added], programId: program.id, pointsSpent: 0 };
  }

  const card = cardsOf(db).find((item) => item.code === value);
  if (!card) throw new Error('Unknown promotion code or coupon/gift card code');
  assertAvailableCard(card, date);
  const linkedProgram = read(db, 'loyalty.program', card.program_id);
  if (!linkedProgram) throw new Error('This card is not linked to a loyalty program');
  if (card.partner_id != null && order.partner_id != null && card.partner_id !== order.partner_id) {
    throw new Error('This code belongs to another customer');
  }
  if (!programDateAndChannel(linkedProgram, date, channel)) {
    if (linkedProgram.date_to && dateOf(date) > dateOf(linkedProgram.date_to)) throw new Error('This code has expired');
    throw new Error('This code is not active for this channel or date');
  }

  if (linkedProgram.program_type === 'gift_card') {
    const amount = round(Math.min(Math.max(0, amounts(orderLines).total), Math.max(0, numeric(card.points))));
    const giftLine = amount ? [{ product_id: null, name: 'Discount: Gift Card', qty: 1, price_unit: -amount, discount: 0, tax: 0 }] : [];
    return { lines: [...orderLines, ...giftLine], card, programId: linkedProgram.id, pointsSpent: amount };
  }

  if (!programRulesMatch(linkedProgram, orderLines)) throw new Error('This code does not meet the order requirements');
  const affordable = (linkedProgram.reward_ids ?? []).filter((reward) => numeric(reward.required_points) <= numeric(card.points));
  if (!affordable.length && (linkedProgram.reward_ids ?? []).some((reward) => numeric(reward.required_points) > 0)) {
    throw new Error('Insufficient loyalty points for this reward');
  }
  // ponytail: one reward per code, the richest the card can afford; a reward picker would let the cashier choose.
  const reward = affordable.toSorted((a, b) => numeric(b.required_points) - numeric(a.required_points))[0];
  const added = computeRewardLines(db, linkedProgram, reward, orderLines);
  return { lines: [...orderLines, ...added], card, programId: linkedProgram.id, pointsSpent: numeric(reward?.required_points) };
}

/** Calculate points earned from the program's matching rules. */
export function earnPoints(db, program, lines = [], total = amounts(lines).total) {
  const rules = program?.rule_ids ?? [];
  return round(rules.reduce((sum, rule) => {
    if (!ruleSatisfied(lines, rule)) return sum;
    const metrics = ruleMetrics(lines, rule);
    const mode = rule.reward_point_mode ?? 'order';
    const amount = numeric(rule.reward_point_amount);
    if (mode === 'order') return sum + amount;
    if (mode === 'money') {
      const spent = rule.product_id == null ? numeric(total) : metrics.amount;
      return sum + Math.floor(Math.max(0, spent)) * amount;
    }
    if (mode === 'unit') return sum + metrics.qty * amount;
    return sum;
  }, 0));
}

/** Commit one program use and any coupon/loyalty card balance changes. */
export function confirmProgramUsage(db, programId, { cardCode, pointsSpent = 0, pointsEarned = 0, partnerId = null } = {}) {
  const program = read(db, 'loyalty.program', programId);
  if (!program) throw new Error(`Loyalty program #${programId} not found`);
  assertUsageAvailable(program);

  let next = db;
  const spent = Math.max(0, numeric(pointsSpent));
  const earned = Math.max(0, numeric(pointsEarned));
  const card = cardCode ? cardsOf(db).find((item) => item.code === cardCode) : null;

  if (cardCode && (!card || card.program_id !== programId)) throw new Error('Unknown coupon or loyalty card code');
  if (card) {
    assertAvailableCard(card, today());
    if (partnerId != null && card.partner_id != null && card.partner_id !== partnerId) throw new Error('This code belongs to another customer');
  }

  if (program.program_type === 'loyalty') {
    let loyaltyCard = card ?? cardsOf(db).find((item) => item.program_id === programId && item.partner_id === partnerId && item.state === 'active');
    if (loyaltyCard && numeric(loyaltyCard.points) < spent) throw new Error('Insufficient loyalty points');
    if (!loyaltyCard && spent > 0) throw new Error('Insufficient loyalty points');
    if (!loyaltyCard && earned > 0) {
      if (partnerId == null) throw new Error('A customer is required to create a loyalty card');
      const code = randomCode();
      if (cardsOf(db).some((item) => item.code === code)) throw new Error(`Coupon code ${code} already exists`);
      next = create(next, 'loyalty.card', { program_id: programId, partner_id: partnerId, code, points: earned, state: 'active' }).db;
    } else if (loyaltyCard) {
      next = write(next, 'loyalty.card', loyaltyCard.id, {
        points: round(numeric(loyaltyCard.points) - spent + earned),
        state: 'active',
      });
    }
  } else if (card && program.program_type === 'gift_card') {
    if (numeric(card.points) < spent) throw new Error('Insufficient gift card balance');
    const remaining = round(numeric(card.points) - spent);
    next = write(next, 'loyalty.card', card.id, { points: remaining, state: remaining === 0 ? 'used' : 'active' });
  } else if (card) {
    next = write(next, 'loyalty.card', card.id, { state: 'used' });
  }

  return write(next, 'loyalty.program', programId, { usage_count: numeric(program.usage_count) + 1 });
}

/** Consume the codes applied to an order when it is confirmed (coupons used, points and gift balances spent). */
export function consumeOrderCodes(db, order) {
  return (order.loyalty_uses ?? []).reduce((next, use) => (use.gift
    ? giftCardPay(next, use.cardCode, use.spent).db
    : confirmProgramUsage(next, use.programId, { cardCode: use.cardCode, pointsSpent: use.spent, partnerId: order.partner_id })), db);
}

/** Spend gift-card balance as currency, returning the amount actually applied. */
export function giftCardPay(db, code, amount) {
  const card = cardsOf(db).find((item) => item.code === code);
  assertAvailableCard(card, today());
  const program = read(db, 'loyalty.program', card.program_id);
  if (program?.program_type !== 'gift_card') throw new Error('This code is not a gift card');
  const requested = numeric(amount);
  if (requested < 0) throw new Error('Payment amount cannot be negative');
  const balance = Math.max(0, numeric(card.points));
  const used = round(Math.min(requested, balance));
  if (!used) return { db, used: 0 };
  const remaining = round(balance - used);
  const next = write(db, 'loyalty.card', card.id, { points: remaining, state: remaining === 0 ? 'used' : 'active' });
  return { db: next, used };
}

const programTypeOptions = [
  ['coupons', 'Coupons'], ['promotion', 'Promotion'], ['discount_code', 'Discount Code'],
  ['loyalty', 'Loyalty'], ['gift_card', 'Gift Card'], ['buy_x_get_y', 'Buy X Get Y'],
];
const rulesField = {
  type: 'one2many', label: 'Rules',
  fields: {
    minimum_qty: { type: 'float', label: 'Minimum Quantity' },
    minimum_amount: { type: 'monetary', label: 'Minimum Amount' },
    product_id: { type: 'many2one', relation: 'product', label: 'Product' },
    reward_point_amount: { type: 'float', label: 'Points' },
    reward_point_mode: { type: 'selection', label: 'Points Mode', options: [['order', 'Per Order'], ['money', 'Per Currency Unit'], ['unit', 'Per Product Unit']] },
  },
  newLine: () => ({ minimum_qty: 0, minimum_amount: 0, product_id: null, reward_point_amount: 1, reward_point_mode: 'order' }),
};
const rewardsField = {
  type: 'one2many', label: 'Rewards',
  fields: {
    reward_type: { type: 'selection', label: 'Reward Type', options: [['discount', 'Discount'], ['product', 'Free Product']] },
    discount: { type: 'float', label: 'Discount' },
    discount_mode: { type: 'selection', label: 'Discount Mode', options: [['percent', 'Percentage'], ['per_order', 'Fixed Amount']] },
    discount_applicability: { type: 'selection', label: 'Apply Discount On', options: [['order', 'Order'], ['cheapest', 'Cheapest Product'], ['specific', 'Specific Product']] },
    discount_product_id: { type: 'many2one', relation: 'product', label: 'Specific Product' },
    reward_product_id: { type: 'many2one', relation: 'product', label: 'Reward Product' },
    reward_product_qty: { type: 'float', label: 'Reward Quantity' },
    required_points: { type: 'float', label: 'Required Points' },
    description: { type: 'char', label: 'Description' },
  },
  newLine: () => ({ reward_type: 'discount', discount: 10, discount_mode: 'percent', discount_applicability: 'order', reward_product_qty: 1, required_points: 0, description: '' }),
};

export const loyaltyModels = {
  'loyalty.program': {
    label: 'Discount & Loyalty',
    fields: {
      name: { type: 'char', label: 'Program Name', required: true },
      program_type: { type: 'selection', label: 'Program Type', options: programTypeOptions },
      applies_on: { type: 'selection', label: 'Applies On', options: [['current', 'Current order'], ['future', 'Future orders']] },
      trigger: { type: 'selection', label: 'Trigger', options: [['auto', 'Automatic'], ['with_code', 'With a Code']] },
      code: { type: 'char', label: 'Code' },
      date_from: { type: 'date', label: 'Start Date' },
      date_to: { type: 'date', label: 'End Date' },
      active: { type: 'boolean', label: 'Active' },
      limit_usage: { type: 'boolean', label: 'Limit Usage' },
      max_usage: { type: 'integer', label: 'Maximum Uses' },
      usage_count: { type: 'integer', label: 'Uses', readonly: true },
      pos_ok: { type: 'boolean', label: 'Available in POS' },
      sale_ok: { type: 'boolean', label: 'Available in Sales' },
      rule_ids: rulesField,
      reward_ids: rewardsField,
    },
    defaults: () => ({ program_type: 'promotion', applies_on: 'current', trigger: 'auto', active: true, limit_usage: false, max_usage: 0, usage_count: 0, pos_ok: true, sale_ok: true, rule_ids: [], reward_ids: [] }),
    guard: (db, before, after) => {
      if (after.trigger === 'with_code' && !String(after.code ?? '').trim()) return 'A code is required for a code-triggered program';
      return null;
    },
    kanban: { title: 'name', lines: ['program_type', 'trigger', 'date_from', 'date_to'], badge: 'active' },
    list: ['name', 'program_type', 'applies_on', 'trigger', 'code', 'date_from', 'date_to', 'usage_count', 'active'],
    views: ['list', 'kanban'],
    form: {
      title: 'name',
      buttons: [{
        label: 'Generate Coupons',
        when: (record) => record.active !== false,
        run: (db, record) => {
          const answer = prompt('How many coupons would you like to generate?', '1');
          if (answer == null) return { db };
          const count = Number(answer);
          if (!Number.isInteger(count) || count < 0) throw new Error('Enter a non-negative whole number of coupons');
          return { db: generateCoupons(db, record.id, { count }) };
        },
      }],
      groups: [['program_type', 'applies_on', 'trigger', 'code'], ['date_from', 'date_to', 'active', 'pos_ok', 'sale_ok'], ['limit_usage', 'max_usage', 'usage_count']],
      tabs: [{ label: 'Rules', fields: ['rule_ids'] }, { label: 'Rewards', fields: ['reward_ids'] }],
      chatter: true,
    },
  },

  'loyalty.card': {
    label: 'Coupons & Cards',
    fields: {
      program_id: { type: 'many2one', relation: 'loyalty.program', label: 'Program', required: true },
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Customer' },
      code: { type: 'char', label: 'Code', required: true },
      points: { type: 'float', label: 'Points / Balance' },
      expiration_date: { type: 'date', label: 'Expiration Date' },
      state: { type: 'selection', label: 'Status', options: [['active', 'Active'], ['used', 'Used'], ['expired', 'Expired']] },
    },
    defaults: () => ({ partner_id: null, points: 1, expiration_date: null, state: 'active' }),
    guard: (db, before, after) => {
      if ((db.records['loyalty.card'] ?? []).some((card) => card.id !== before?.id && card.code === after.code)) return 'Card code must be unique';
      return null;
    },
    kanban: { title: 'code', lines: ['program_id', 'partner_id', 'points', 'expiration_date'], badge: 'state' },
    list: ['code', 'program_id', 'partner_id', 'points', 'expiration_date', 'state'],
    views: ['list', 'kanban'],
    form: { title: 'code', groups: [['program_id', 'partner_id', 'state'], ['points', 'expiration_date']], chatter: true },
  },
};
