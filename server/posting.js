// Posting services: actions that book journal entries run here with system rights, after checking that the user
// may work on the business document (a cashier on POS orders, a payroll officer on payslips) — users who may not
// write account.move themselves can still complete sales and payslips.
import { read } from '../src/orm.js';
import { models } from '../src/models/index.js';
import { closeSession, payCart } from '../src/models/pos.js';

const need = (allowed, model) => { if (allowed && !allowed.has(model)) throw new Error(`No access to ${model}`); };

/**
 * @param {object} db current database
 * @param {Set<string>|null} allowed models the user may write (null = all)
 * @param {string} path /api/button | /api/pos/pay | /api/pos/close
 * @returns {{ db: object, body: object }} the database to commit and the response body
 */
export function runPosting(db, allowed, path, body = {}) {
  if (path === '/api/button') {
    const { model, id, label } = body;
    need(allowed, model);
    const button = models[model]?.form?.buttons?.find((b) => b.posts && b.label === label);
    const rec = read(db, model, Number(id));
    if (!button || !rec || (button.when && !button.when(rec, db))) throw new Error('This action is not available');
    const res = button.run(db, rec);
    return { db: res.db, body: { go: res.go ?? null } };
  }
  if (path === '/api/pos/pay') {
    need(allowed, 'pos.order');
    const out = payCart(db, {
      cart: body.lines ?? body.cart,
      method: body.method,
      payments: body.payments,
      partner_id: body.partner_id ? Number(body.partner_id) : null,
      config_id: body.config_id ? Number(body.config_id) : null,
      preset_id: body.preset_id ? Number(body.preset_id) : null,
      request_key: body.request_key ?? null,
      refund_of: body.refund_of ? Number(body.refund_of) : null,
    });
    return { db: out.db, body: { id: out.id, name: out.name, total: out.total } };
  }
  if (path === '/api/pos/refund') {
    need(allowed, 'pos.order');
    const orderId = Number(body.id ?? body.order_id ?? body.refund_of);
    const order = read(db, 'pos.order', orderId);
    if (!order) throw new Error('Order not found');
    const out = payCart(db, {
      method: body.method,
      payments: body.payments,
      refund_of: order.id,
      request_key: body.request_key ?? null,
    });
    return { db: out.db, body: { id: out.id, name: out.name, total: out.total } };
  }
  if (path === '/api/pos/close') {
    need(allowed, 'pos.session');
    const session = read(db, 'pos.session', Number(body.session_id));
    if (!session) throw new Error('Session not found');
    return { db: closeSession(db, session, body.counted), body: { ok: true } };
  }
  return null;
}
