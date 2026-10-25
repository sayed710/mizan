// Point of Sale sessions (opening/closing cash control), paying and refunding orders.
import { create, read, search, write } from '../orm.js';
import { amounts, nextName, today } from './common.js';
import { deliver, moveValued } from './valuation.js';
import { postEntry } from './ledger.js';

const round = (n) => Math.round(n * 100) / 100;
const CASH = '101501';
const BANK = '101401';

export const openSession = (db) => search(db, 'pos.session').find((s) => s.state === 'opened') ?? null;

/** Open the register with the counted opening cash. */
export function startSession(db, openingCash = 0) {
  if (openSession(db)) throw new Error('A session is already open');
  return create(db, 'pos.session', { name: nextName(db, 'pos.session', 'POS/S/'), state: 'opened', start_at: today(), cash_start: round(Number(openingCash) || 0) });
}

/** Lines of a cart priced from the products (sales price and sales tax). */
export const priceLines = (db, cart) => cart.map((l) => {
  const p = read(db, 'product', l.product_id);
  return { product_id: l.product_id, qty: l.qty, price_unit: p?.list_price ?? 0, discount: Number(l.discount) || 0, tax: p?.sale_tax ?? 14 };
});

/** Book a paid order (or a refund, when `refund_of` is set) in the open session: stock moves and the sale/refund entry. */
export function payOrder(db, { lines, method, partner_id = null, refund_of = null }) {
  const session = openSession(db);
  if (!session) throw new Error('Open a session first');
  if (!lines.length) throw new Error('The order is empty');
  const { db: next, id } = create(db, 'pos.order', { partner_id, payment_method: method, lines, session_id: session.id, state: refund_of ? 'refund' : 'paid', refund_of });
  const name = read(next, 'pos.order', id).name;
  const total = amounts(lines);
  const sign = refund_of ? -1 : 1;
  const side = (amount, debit) => ((debit === (sign > 0)) ? { debit: round(amount) } : { credit: round(amount) });
  let stocked = next;
  const costs = [];
  const original = refund_of ? read(db, 'pos.order', refund_of) : null;
  for (const [index, l] of lines.entries()) {
    const p = read(stocked, 'product', l.product_id);
    if (p?.type !== 'goods' || !l.qty) continue;
    if (!refund_of && p.valuation !== 'manual_periodic') {
      const out = deliver(stocked, p.id, Number(l.qty), { reference: name });
      stocked = out.db;
      costs.push({ index, unit_cost: out.value / Number(l.qty) });
    } else {
      const unit_cost = original?.stock_costs?.find((c) => c.index === index)?.unit_cost ?? p.cost;
      stocked = moveValued(stocked, [{ ...l, unit_cost }], -sign, { reference: name, counterpart: '500000', actualCost: true });
    }
  }
  stocked = write(stocked, 'pos.order', id, { stock_costs: costs });
  const { db: booked } = postEntry(stocked, {
    journal: 'POSS', ref: name,
    lines: [
      { account: method === 'cash' ? CASH : BANK, ...side(total.total, true) },
      { account: '400000', ...side(total.untaxed, false) },
      ...(total.tax ? [{ account: '251000', ...side(total.tax, false) }] : []),
    ],
  });
  return { db: booked, id };
}

/** Refund a paid order in full (stock comes back, money goes out the way it came in). */
export function refundOrder(db, order) {
  if (order.state !== 'paid') throw new Error('Only paid orders can be refunded');
  if (search(db, 'pos.order').some((o) => o.refund_of === order.id)) throw new Error('This order was already refunded');
  const { db: next, id } = payOrder(db, { lines: order.lines, method: order.payment_method, partner_id: order.partner_id, refund_of: order.id });
  return { db: write(next, 'pos.order', order.id, { state: 'refunded' }), id };
}

/** Session totals by payment method (refunds negative) and the cash expected in the drawer. */
export function sessionTotals(db, session) {
  const orders = search(db, 'pos.order').filter((o) => o.session_id === session.id);
  const sum = (method) => round(orders.filter((o) => o.payment_method === method).reduce((s, o) => s + (o.state === 'refund' ? -1 : 1) * amounts(o.lines).total, 0));
  const cash = sum('cash');
  return { orders: orders.length, cash, card: sum('card'), expected: round((Number(session.cash_start) || 0) + cash) };
}

/** Close with the counted cash; a difference is booked as a cash gain or loss. */
export function closeSession(db, session, countedCash) {
  if (session.state !== 'opened') throw new Error('The session is not open');
  const { cash, card, expected } = sessionTotals(db, session);
  const counted = round(Number(countedCash) || 0);
  const difference = round(counted - expected);
  const booked = difference ? postEntry(db, {
    journal: 'POSS', ref: `${session.name} cash difference`,
    lines: difference > 0 ? [{ account: CASH, debit: difference }, { account: '450000', credit: difference }] : [{ account: '690000', debit: -difference }, { account: CASH, credit: -difference }],
  }).db : db;
  return write(booked, 'pos.session', session.id, { state: 'closed', stop_at: today(), total_cash: cash, total_card: card, cash_expected: expected, cash_end: counted, cash_difference: difference });
}

export const posModels = {
  'pos.session': {
    label: 'Sessions',
    fields: {
      name: { type: 'char', label: 'Session', readonly: true },
      state: { type: 'selection', label: 'Status', tracking: true, options: [['opened', 'In Progress'], ['closed', 'Closed']] },
      start_at: { type: 'date', label: 'Opening Date', readonly: true },
      stop_at: { type: 'date', label: 'Closing Date', readonly: true },
      cash_start: { type: 'monetary', label: 'Opening Cash' },
      total_cash: { type: 'monetary', label: 'Cash Payments', readonly: true },
      total_card: { type: 'monetary', label: 'Card Payments', readonly: true },
      cash_expected: { type: 'monetary', label: 'Expected Cash', readonly: true },
      cash_end: { type: 'monetary', label: 'Counted Cash', readonly: true },
      cash_difference: { type: 'monetary', label: 'Difference', readonly: true },
    },
    defaults: () => ({ state: 'opened', start_at: today(), cash_start: 0 }),
    kanban: { title: 'name', lines: ['start_at', 'cash_expected'], badge: 'state' },
    list: ['name', 'start_at', 'stop_at', 'total_cash', 'total_card', 'cash_difference', 'state'],
    form: {
      statusbar: 'state',
      lockedWhen: () => true,
      smart: [{ label: 'Orders', model: 'pos.order', field: 'session_id', target: 'pos/orders' }],
      buttons: [{
        label: 'Close Session', primary: true, when: (r) => r.state === 'opened',
        run: (db, r) => {
          const { expected } = sessionTotals(db, r);
          const counted = prompt(`Counted cash in the drawer (expected ${expected})`, String(expected));
          return { db: counted == null ? db : closeSession(db, r, counted) };
        },
      }],
      title: 'name',
      groups: [['start_at', 'stop_at', 'cash_start'], ['total_cash', 'total_card', 'cash_expected', 'cash_end', 'cash_difference']],
      chatter: true,
    },
  },
};
