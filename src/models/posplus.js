// Restaurant bills, split tenders and POS loyalty.
import { create, read, search, write } from '../orm.js';
import { amounts } from './common.js';
import { moreModels } from './more.js';
import { openSession, payOrder, refundOrder } from './pos.js';
import { applicablePrograms, applyCode, computeRewardLines, earnPoints, confirmProgramUsage, giftCardPay } from './loyalty.js';

const round = (n) => Math.round(n * 100) / 100;
const baseOrder = moreModels['pos.order'];
const methodOptions = [['cash', 'Cash'], ['bank', 'Bank / Card']];
const discountsOf = (lines) => round(lines.filter((l) => !l.payment_rounding && !l.is_tip).reduce((s, l) => s + (l.price_unit < 0 ? -amounts([l]).total : amounts([{ ...l, discount: 0 }]).total - amounts([l]).total), 0));
const paymentsField = {
  type: 'one2many', label: 'Payments',
  fields: { method: { type: 'selection', label: 'Method', options: methodOptions }, amount: { type: 'monetary', label: 'Amount' } },
  newLine: () => ({ method: 'cash', amount: 0 }),
};

function draftOrder(db, id) {
  const order = read(db, 'pos.order', id);
  if (!order || order.state !== 'draft') throw new Error('Select a draft order');
  return order;
}

function tableAt(db, key, configId) {
  const separator = String(key).indexOf(':');
  const floor = read(db, 'restaurant.floor', Number(String(key).slice(0, separator)));
  const table = floor?.table_ids?.find((t) => t.name === String(key).slice(separator + 1));
  if (separator < 0 || !table || floor.config_id !== configId) throw new Error('Select a table in this point of sale');
  return table;
}

/** Open a free table without booking stock or money. */
export function openTableOrder(db, { configId, floorId, tableName, customerCount = 1 }) {
  if (!read(db, 'pos.config', configId)?.module_restaurant) throw new Error('Enable restaurant mode first');
  const key = `${floorId}:${tableName}`;
  tableAt(db, key, configId);
  if (!Number.isInteger(customerCount) || customerCount < 1) throw new Error('Enter a positive whole number of guests');
  if (search(db, 'pos.order').some((o) => o.table_id === key && o.state === 'draft')) throw new Error('This table already has a draft order');
  return create(db, 'pos.order', { config_id: configId, table_id: key, customer_count: customerCount, state: 'draft' });
}

/** Show tables, aggregating draft split bills and guests. */
export function tableStatus(db, floorId) {
  const floor = read(db, 'restaurant.floor', floorId);
  if (!floor) throw new Error('Floor not found');
  return (floor.table_ids ?? []).map((table) => {
    const orders = search(db, 'pos.order').filter((o) => o.state === 'draft' && o.table_id === `${floorId}:${table.name}`);
    return { table: table.name, seats: table.seats, orderId: orders[0]?.id ?? null, total: round(orders.reduce((s, o) => s + o.amount_total, 0)), guests: orders.reduce((s, o) => s + (o.customer_count || 0), 0) };
  });
}

/** Move a draft bill to a free table in the same configuration. */
export function transferTable(db, orderId, toTableKey) {
  const order = draftOrder(db, orderId);
  tableAt(db, toTableKey, order.config_id);
  if (search(db, 'pos.order').some((o) => o.id !== orderId && o.table_id === toTableKey && o.state === 'draft')) throw new Error('Destination table already has a draft order');
  return write(db, 'pos.order', orderId, { table_id: toTableKey });
}

/** Combine compatible draft bills and cancel the source. */
export function mergeTables(db, fromOrderId, intoOrderId) {
  const from = draftOrder(db, fromOrderId);
  const into = draftOrder(db, intoOrderId);
  if (from.id === into.id || from.config_id !== into.config_id || from.partner_id !== into.partner_id) throw new Error('Select two different orders with the same point of sale and customer');
  if (from.loyalty_applied || into.loyalty_applied) throw new Error('Merge bills before applying loyalty');
  const next = write(db, 'pos.order', into.id, { lines: [...into.lines, ...from.lines], customer_count: into.customer_count + from.customer_count, tip_amount: round(into.tip_amount + from.tip_amount), note: [into.note, from.note].filter(Boolean).join('\n') });
  return write(next, 'pos.order', from.id, { state: 'cancel' });
}

/** Move selected quantities to a separate draft bill at the same table. */
export function splitBill(db, orderId, lineSelections) {
  const order = draftOrder(db, orderId);
  if (order.loyalty_applied) throw new Error('Split bills before applying loyalty');
  const selected = new Map();
  for (const { index, qty } of lineSelections) {
    if (!Number.isInteger(index) || !order.lines[index] || !Number.isFinite(qty) || qty <= 0) throw new Error('Select valid lines and positive quantities');
    selected.set(index, (selected.get(index) ?? 0) + qty);
    if (selected.get(index) > order.lines[index].qty) throw new Error('Selected quantity exceeds the line quantity');
  }
  if (!selected.size) throw new Error('Select at least one line');
  const lines = order.lines.flatMap((l, i) => selected.has(i) ? [{ ...l, qty: selected.get(i) }] : []);
  const remaining = order.lines.map((l, i) => ({ ...l, qty: l.qty - (selected.get(i) ?? 0) })).filter((l) => l.qty > 0);
  const tip = round(amounts(lines.filter((l) => l.is_tip)).total);
  const next = write(db, 'pos.order', orderId, { lines: remaining, tip_amount: round(order.tip_amount - tip) });
  const out = create(next, 'pos.order', { config_id: order.config_id, table_id: order.table_id, customer_count: 0, partner_id: order.partner_id, note: order.note, state: 'draft', lines, tip_amount: tip });
  return { db: out.db, newOrderId: out.id };
}

/** Replace the tip with one untaxed tip line. */
export function addTip(db, orderId, amount) {
  const order = draftOrder(db, orderId);
  const config = read(db, 'pos.config', order.config_id);
  if (!Number.isFinite(amount) || amount < 0) throw new Error('Enter a non-negative tip');
  const productId = config?.iface_tipproduct ? config.tip_product_id : null;
  if (productId && !read(db, 'product', productId)) throw new Error('Tip product not found');
  const tip = round(amount);
  return write(db, 'pos.order', orderId, { tip_amount: tip, lines: [...order.lines.filter((l) => !l.is_tip), ...(tip ? [{ product_id: productId ?? null, name: 'Tip', qty: 1, price_unit: tip, tax: 0, discount: 0, is_tip: true }] : [])] });
}

/** Apply automatic POS promotions or one code once per draft bill. */
export function applyLoyaltyToOrder(db, orderId, code) {
  const order = draftOrder(db, orderId);
  if (!read(db, 'pos.config', order.config_id)?.loyalty_enabled) throw new Error('Enable loyalty for this point of sale');
  if (order.loyalty_applied) throw new Error('Loyalty has already been applied to this bill');
  let lines = order.lines;
  let uses = [];
  if (code) {
    const applied = applyCode(db, order, code, { channel: 'pos' });
    lines = applied.lines;
    const program = applied.card ? read(db, 'loyalty.program', applied.card.program_id) : search(db, 'loyalty.program').find((p) => p.code === String(code).trim());
    const gift = program.program_type === 'gift_card';
    const spent = !applied.card ? 0 : gift ? round(amounts(order.lines).total - amounts(lines).total) : applied.pointsSpent;
    uses = [{ programId: program.id, cardCode: applied.card?.code, gift, spent }];
  } else {
    const programs = applicablePrograms(db, order, { channel: 'pos' }).filter((p) => p.trigger !== 'with_code' && ['promotion', 'buy_x_get_y'].includes(p.program_type));
    for (const program of programs) {
      lines = [...lines, ...(program.reward_ids ?? []).flatMap((r) => computeRewardLines(db, program, r, order.lines))];
      uses.push({ programId: program.id });
    }
  }
  return write(db, 'pos.order', orderId, { lines, loyalty_applied: true, loyalty_uses: uses });
}

/** Pay using method-specific settlements, returning cash overpayment as change. */
export function payWithMethods(db, orderId, payments) {
  const order = draftOrder(db, orderId);
  if (!openSession(db)) throw new Error('Open a session first');
  const total = amounts(order.lines).total;
  if (!order.lines.length || !Number.isFinite(total) || total < 0) throw new Error('The bill must have a non-negative total and at least one line');
  const config = read(db, 'pos.config', order.config_id);
  const byMethod = { cash: 0, bank: 0 };
  for (const payment of payments) {
    const method = payment.method === 'card' ? 'bank' : payment.method;
    if (!['cash', 'bank'].includes(method) || !Number.isFinite(payment.amount) || payment.amount <= 0) throw new Error('Select a valid payment method and positive amount');
    if (config?.payment_method_ids?.length && !config.payment_method_ids.some((m) => m.name === payment.method || m.journal === method)) throw new Error('Payment method is not enabled');
    byMethod[method] = round(byMethod[method] + payment.amount);
  }
  const change = round(byMethod.cash + byMethod.bank - total);
  if (change < 0) throw new Error('Payments must cover the order total');
  if (change > byMethod.cash) throw new Error('Only cash may exceed the order total');
  byMethod.cash = round(byMethod.cash - change);
  let next = db;
  let points = 0;
  if (config?.loyalty_enabled) {
    const uses = new Map((order.loyalty_uses ?? []).map((u) => [u.programId, u]));
    for (const p of applicablePrograms(next, order, { channel: 'pos' }).filter((p) => order.partner_id && p.program_type === 'loyalty' && p.trigger !== 'with_code')) uses.set(p.id, uses.get(p.id) ?? { programId: p.id });
    for (const use of uses.values()) {
      const program = read(next, 'loyalty.program', use.programId);
      const earned = order.partner_id ? earnPoints(next, program, order.lines, total) : 0;
      if (use.gift) {
        const paid = giftCardPay(next, use.cardCode, use.spent);
        if (paid.used !== use.spent) throw new Error('Gift card balance has changed; reapply the code');
        next = paid.db;
      }
      next = confirmProgramUsage(next, program.id, { cardCode: use.gift ? undefined : use.cardCode, pointsSpent: use.spent, pointsEarned: earned, partnerId: order.partner_id });
      points += earned;
    }
  }
  const methods = Object.entries(byMethod).filter(([, amount]) => amount > 0);
  if (!methods.length) methods.push(['cash', 0]);
  const allocated = order.lines.map(() => 0);
  let allocatedTax = 0;
  let allocatedTip = 0;
  let allocatedDiscount = 0;
  for (let i = 0; i < methods.length; i++) {
    const [method, amount] = methods[i];
    const lines = order.lines.map((l, index) => {
      const qty = i === methods.length - 1 ? l.qty - allocated[index] : l.qty * amount / total;
      allocated[index] += qty;
      return { ...l, qty };
    });
    const subtotal = amounts(lines);
    const tax = i === methods.length - 1 ? round(amounts(order.lines).tax - allocatedTax) : subtotal.tax;
    const taxDifference = round(tax - subtotal.tax);
    const difference = round(amount - tax - subtotal.untaxed);
    if (difference || taxDifference) lines.push({ product_id: null, name: 'Payment rounding', qty: 1, price_unit: difference, tax: taxDifference, tax_type: 'fixed', payment_rounding: true });
    allocatedTax += tax;
    const last = i === methods.length - 1;
    const tip = last ? round(order.tip_amount - allocatedTip) : round(order.tip_amount * amount / total);
    const discount = last ? round(discountsOf(order.lines) - allocatedDiscount) : round(discountsOf(order.lines) * amount / total);
    allocatedTip += tip;
    allocatedDiscount += discount;
    const paid = payOrder(next, { lines, method: method === 'bank' ? 'card' : 'cash', partner_id: order.partner_id });
    next = write(paid.db, 'pos.order', paid.id, { config_id: order.config_id, settlement_of: orderId, tip_amount: tip, discount_total: discount, payment_ids: [{ method, amount }] });
  }
  next = write(next, 'pos.order', orderId, { state: 'paid', session_id: null, payment_ids: payments.map((p) => ({ ...p })), change, loyalty_points_earned: round(points) });
  return { db: next, change };
}

/** Report session settlements and refunds, excluding unbooked drafts. */
export function zReport(db, sessionId) {
  if (!read(db, 'pos.session', sessionId)) throw new Error('Session not found');
  const orders = search(db, 'pos.order').filter((o) => o.session_id === sessionId && ['paid', 'refunded', 'refund'].includes(o.state));
  const report = { orders: orders.length, refunds: 0, byMethod: { cash: 0, bank: 0 }, taxes: 0, tips: 0, discounts: 0, total: 0 };
  for (const order of orders) {
    const sign = order.state === 'refund' ? -1 : 1;
    const totals = amounts(order.lines);
    if (sign < 0) report.refunds++;
    report.byMethod[order.payment_method === 'cash' ? 'cash' : 'bank'] += sign * totals.total;
    report.taxes += sign * totals.tax;
    const source = order.refund_of ? read(db, 'pos.order', order.refund_of) : order;
    report.tips += sign * (source?.settlement_of ? source.tip_amount : amounts(order.lines.filter((l) => l.is_tip)).total);
    report.discounts += sign * (source?.settlement_of ? source.discount_total : discountsOf(order.lines));
    report.total += sign * totals.total;
  }
  return { ...report, byMethod: { cash: round(report.byMethod.cash), bank: round(report.byMethod.bank) }, taxes: round(report.taxes), tips: round(report.tips), discounts: round(report.discounts), total: round(report.total) };
}

export function refundBill(db, order) {
  const settlements = search(db, 'pos.order').filter((o) => o.settlement_of === order.id);
  if (!settlements.length) return refundOrder(db, order).db;
  let next = db;
  for (const settlement of settlements) next = refundOrder(next, settlement).db;
  return write(next, 'pos.order', order.id, { state: 'refunded' });
}

export const posPlusModels = {
  'pos.config': {
    label: 'Point of Sale',
    fields: {
      name: { type: 'char', label: 'Name', required: true },
      module_restaurant: { type: 'boolean', label: 'Restaurant' },
      iface_tipproduct: { type: 'boolean', label: 'Tips' },
      tip_product_id: { type: 'many2one', relation: 'product', label: 'Tip Product' },
      payment_method_ids: { ...paymentsField, label: 'Payment Methods', fields: { name: { type: 'char', label: 'Name' }, journal: { type: 'selection', label: 'Journal', options: methodOptions } }, newLine: () => ({ name: 'Cash', journal: 'cash' }) },
      loyalty_enabled: { type: 'boolean', label: 'Loyalty' },
    },
    defaults: () => ({ module_restaurant: false, iface_tipproduct: false, loyalty_enabled: false, payment_method_ids: [] }),
    list: ['name', 'module_restaurant', 'loyalty_enabled'],
    form: { title: 'name', groups: [['module_restaurant']], tabs: [{ label: 'Payments', fields: ['payment_method_ids', 'iface_tipproduct', 'tip_product_id'] }, { label: 'Loyalty', fields: ['loyalty_enabled'] }] },
  },
  'restaurant.floor': {
    label: 'Floors',
    fields: {
      name: { type: 'char', label: 'Name', required: true },
      config_id: { type: 'many2one', relation: 'pos.config', label: 'Point of Sale', required: true },
      table_ids: { type: 'one2many', label: 'Tables', fields: { name: { type: 'char', label: 'Table' }, seats: { type: 'integer', label: 'Seats' }, shape: { type: 'selection', label: 'Shape', options: [['square', 'Square'], ['round', 'Round']] } }, newLine: () => ({ name: '', seats: 2, shape: 'square' }) },
    },
    defaults: () => ({ table_ids: [] }),
    guard: (db, before, after) => new Set((after.table_ids ?? []).map((t) => t.name)).size !== (after.table_ids ?? []).length ? 'Table names must be unique within a floor' : null,
    list: ['name', 'config_id'],
    form: { title: 'name', groups: [['config_id']], tabs: [{ label: 'Tables', fields: ['table_ids'] }] },
  },
  'pos.order': {
    ...baseOrder,
    fields: {
      ...baseOrder.fields,
      lines: { ...baseOrder.fields.lines, fields: { ...baseOrder.fields.lines.fields, name: { type: 'char', label: 'Description' }, is_tip: { type: 'boolean', label: 'Tip', hidden: true }, payment_rounding: { type: 'boolean', label: 'Payment Rounding', hidden: true } } },
      state: { ...baseOrder.fields.state, options: [['draft', 'Draft'], ...baseOrder.fields.state.options, ['cancel', 'Cancelled']] },
      config_id: { type: 'many2one', relation: 'pos.config', label: 'Point of Sale' },
      table_id: { type: 'char', label: 'Table' },
      customer_count: { type: 'integer', label: 'Guests' },
      note: { type: 'text', label: 'Note' },
      tip_amount: { type: 'monetary', label: 'Tip', readonly: true },
      payment_ids: paymentsField,
      loyalty_points_earned: { type: 'float', label: 'Points Earned', readonly: true },
      change: { type: 'monetary', label: 'Change', readonly: true },
      discount_total: { type: 'monetary', label: 'Settlement Discounts', hidden: true },
      settlement_of: { type: 'many2one', relation: 'pos.order', label: 'Restaurant Bill', hidden: true },
      loyalty_applied: { type: 'boolean', label: 'Loyalty Applied', hidden: true },
      loyalty_uses: {
        type: 'one2many', label: 'Applied Programs', hidden: true,
        fields: { programId: { type: 'many2one', relation: 'loyalty.program', label: 'Program' }, cardCode: { type: 'char', label: 'Code' }, gift: { type: 'boolean', label: 'Gift Card' }, spent: { type: 'float', label: 'Points Spent' } },
        newLine: () => ({ programId: null, cardCode: '', gift: false, spent: 0 }),
      },
    },
    defaults: (id) => ({ ...baseOrder.defaults(id), state: 'draft', partner_id: null, customer_count: 1, tip_amount: 0, payment_ids: [], loyalty_points_earned: 0 }),
    form: {
      ...baseOrder.form,
      statusbar: 'state', lockedWhen: (r) => r.state !== 'draft',
      groups: [...baseOrder.form.groups, ['config_id', 'table_id', 'customer_count', 'tip_amount', 'loyalty_points_earned']],
      tabs: [...baseOrder.form.tabs, { label: 'Payments', fields: ['payment_ids'] }, { label: 'Notes', fields: ['note'] }],
      buttons: [
        { label: 'Pay', primary: true, server: '/api/op/pos.bill.pay', when: (r) => r.state === 'draft', run: (db, r) => payWithMethods(db, r.id, r.payment_ids) },
        { label: 'Apply Promotions', when: (r) => r.state === 'draft', run: (db, r) => ({ db: applyLoyaltyToOrder(db, r.id) }) },
        { label: 'Refund', server: '/api/op/pos.bill.refund', when: (r) => r.state === 'paid' && !r.settlement_of, run: (db, r) => ({ db: refundBill(db, r) }) },
      ],
    },
  },
};
