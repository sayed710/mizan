// Posting services: actions that book journal entries run here with system rights, after checking that the user
// may work on the business document (a cashier on POS orders, a payroll officer on payslips) — users who may not
// write account.move themselves can still complete sales and payslips.
import { read } from '../src/orm.js';
import { models } from '../src/models/index.js';
import { closeSession, payOrder, priceLines } from '../src/models/pos.js';

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
    if (!button || !rec || (button.when && !button.when(rec))) throw new Error('This action is not available');
    const res = button.run(db, rec);
    return { db: res.db, body: { go: res.go ?? null } };
  }
  if (path === '/api/pos/pay') {
    need(allowed, 'pos.order');
    if (!Array.isArray(body.lines) || !body.lines.length || body.lines.some((l) => !l || !Number.isFinite(Number(l.qty)) || Number(l.qty) <= 0 || !Number.isFinite(Number(l.discount ?? 0)) || Number(l.discount ?? 0) < 0 || Number(l.discount ?? 0) > 100)) throw new Error('Invalid cart quantities or discounts');
    const cart = body.lines.map((l) => ({ product_id: Number(l.product_id), qty: Number(l.qty), uom_id: l.uom_id ? Number(l.uom_id) : undefined, discount: Number(l.discount ?? 0) }));
    for (const line of cart) {
      const product = read(db, 'product', line.product_id);
      if (!product || product.active === false || product.available_in_pos === false || product.sale_ok === false) throw new Error('Product is not available in POS');
    }
    if (body.payments !== undefined && (!Array.isArray(body.payments) || !body.payments.length || body.payments.some((p) => !p || !['cash', 'card', 'bank'].includes(p.method) || !Number.isFinite(Number(p.amount)) || Number(p.amount) <= 0))) throw new Error('Invalid payments');
    if (!body.payments && !['cash', 'card'].includes(body.method)) throw new Error('Unknown payment method');
    // Prices come from the products, not from the request.
    const { db: next, id } = payOrder(db, { lines: priceLines(db, cart, Number(body.partner_id) || null), method: body.method, payments: body.payments, partner_id: Number(body.partner_id) || null });
    return { db: next, body: { id, name: read(next, 'pos.order', id).name } };
  }
  if (path === '/api/pos/close') {
    need(allowed, 'pos.session');
    const session = read(db, 'pos.session', Number(body.session_id));
    if (!session) throw new Error('Session not found');
    return { db: closeSession(db, session, body.counted), body: { ok: true } };
  }
  return null;
}
