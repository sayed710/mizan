// Workflow steps that book accounting records for users whose apps may not write accounting directly.
// The server recomputes them from its own data, so the client never sends the journal entries or payments.
import { read } from './orm.js';
import { promptedAmount } from './models/common.js';
import { payQuote } from './models/quoteplus.js';
import { closeSession, payCart, refundOrder } from './models/pos.js';
import { payWithMethods, refundBill } from './models/posplus.js';

const record = (db, model, id) => {
  const r = read(db, model, Number(id));
  if (!r) throw new Error('Record not found');
  return r;
};

/** name -> { model the user must be able to write, run(db, body) -> db | { db, ...reply } } */
export const OPERATIONS = {
  'sale.prepay': { model: 'sale.order', run: (db, { id, text, amount = text }) => payQuote(db, record(db, 'sale.order', id).id, promptedAmount(amount) ?? Number.NaN) },
  'pos.pay': {
    model: 'pos.order',
    run: (db, { cart = [], method, partner_id = null, request_key = null }) => {
      if (!['cash', 'card'].includes(method)) throw new Error('Unknown payment method');
      return payCart(db, { cart, method, partner_id: Number(partner_id) || null, request_key });
    },
  },
  'pos.refund': { model: 'pos.order', run: (db, { id }) => { const out = refundOrder(db, record(db, 'pos.order', id)); return { ...out, go: `#/pos/orders/${out.id}` }; } },
  'pos.close': { model: 'pos.session', run: (db, { id, counted }) => closeSession(db, record(db, 'pos.session', id), counted) },
  'pos.bill.pay': { model: 'pos.order', run: (db, { id }) => payWithMethods(db, record(db, 'pos.order', id).id, record(db, 'pos.order', id).payment_ids) },
  'pos.bill.refund': { model: 'pos.order', run: (db, { id }) => refundBill(db, record(db, 'pos.order', id)) },
};

/**
 * Run operation `name` for a user whose app menus show `direct` and who may write `allowed` (null = everything).
 * The operation's model must be on the user's own menus, not just reachable through a relation.
 * Returns the new db, the write set to apply it with (none: the server computed every record, including the
 * journal entries, payments and stock valuation the user's apps cannot write), and the rest of the result as the reply.
 */
export function runOperation(db, name, body, { allowed = null, direct = null } = {}) {
  const op = Object.hasOwn(OPERATIONS, name) ? OPERATIONS[name] : null;
  if (!op) throw Object.assign(new Error('Unknown operation'), { status: 404 });
  if ((direct && !direct.has(op.model)) || (allowed && !allowed.has(op.model))) throw Object.assign(new Error(`No access to ${op.model}`), { status: 403 });
  const out = op.run(db, body ?? {});
  const { db: next, ...reply } = out?.records ? { db: out } : out;
  return { db: next, allowed: null, reply };
}
