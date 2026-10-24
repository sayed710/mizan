// External REST API (/api/v1) authenticated with personal API keys (Authorization: Bearer <key>).
import { models } from '../src/models/index.js';
import { create, matches, read, search, unlink, write } from '../src/orm.js';
import { applyDiff, diffDb } from '../src/sync.js';

const MAX_LIMIT = 500;

const sellable = (db) => search(db, 'product').filter((p) => p.list_price > 0 && p.website_published !== false);

/** Public website content: only published pages and sellable products (no internal fields). */
export const publicSite = (db) => ({
  company: db.settings?.company,
  currency: db.settings?.currency ?? 'USD',
  pages: search(db, 'website.page').filter((p) => p.is_published).sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
    .map((p) => ({ name: p.name, slug: p.slug, content: p.content })),
  products: sellable(db).map((p) => ({ id: p.id, name: p.name, price: p.list_price })),
  jobs: search(db, 'hr.job').filter((j) => j.is_published).map((j) => ({ id: j.id, name: j.name, description: j.description ?? '' })),
});

/** Anonymous job application to a published position. */
export function publicApply(db, body) {
  const b = body && typeof body === 'object' ? body : {};
  const job = search(db, 'hr.job').find((j) => j.is_published && j.id === b.job_id);
  const name = String(b.name ?? '').trim().slice(0, 120);
  const email = String(b.email ?? '').trim().slice(0, 254);
  if (!job) return { status: 400, body: { error: 'This position is not open' } };
  if (!name || !EMAIL.test(email)) return { status: 400, body: { error: 'Enter your name and a valid email address' } };
  const res = create(db, 'hr.applicant', { name, email, phone: String(b.phone ?? '').slice(0, 40), job_id: job.id, description: String(b.motivation ?? '').slice(0, 5000), tag_ids: ['Website'] });
  return { status: 201, body: { ok: true }, db: applyDiff(db, diffDb(db, res.db), { author: 'Website', isAdmin: false }) };
}

const EMAIL = /^[^@\s]{1,64}@[^@\s]{1,190}\.[^@\s]{2,}$/;

/** Anonymous checkout: validated customer + quotation from sellable products only. */
export function publicOrder(db, body) {
  const b = body && typeof body === 'object' ? body : {};
  const name = String(b.name ?? '').trim().slice(0, 120);
  const email = String(b.email ?? '').trim().slice(0, 254);
  if (!name) return { status: 400, body: { error: 'Name is required' } };
  if (!EMAIL.test(email)) return { status: 400, body: { error: 'Enter a valid email address' } };
  const products = new Map(sellable(db).map((p) => [p.id, p]));
  const lines = (Array.isArray(b.lines) ? b.lines : []).slice(0, 50)
    .filter((l) => products.has(l?.product_id) && Number.isInteger(l.qty) && l.qty > 0 && l.qty <= 1000)
    .map((l) => ({ product_id: l.product_id, qty: l.qty, price_unit: products.get(l.product_id).list_price, tax: 14 }));
  if (!lines.length) return { status: 400, body: { error: 'Your cart is empty' } };
  let next = db;
  let partnerId = search(db, 'res.partner').find((p) => p.email?.toLowerCase() === email.toLowerCase())?.id;
  if (!partnerId) {
    const res = create(next, 'res.partner', { name, email, phone: String(b.phone ?? '').slice(0, 40), city: String(b.city ?? '').slice(0, 80), tag_ids: ['Website'] });
    next = res.db;
    partnerId = res.id;
  }
  const order = create(next, 'sale.order', { partner_id: partnerId, order_line: lines, state: 'sent', source: 'website' });
  const saved = applyDiff(db, diffDb(db, order.db), { author: 'Website', isAdmin: false });
  return { status: 201, body: { order: read(saved, 'sale.order', order.id).name }, db: saved };
}

/** Public shape of a model for API discovery. */
const describe = (name) => ({
  model: name,
  label: models[name].label,
  fields: Object.fromEntries(Object.entries(models[name].fields).map(([k, f]) => [k, {
    type: f.type, label: f.label, required: !!f.required, readonly: !!(f.readonly || f.compute), ...(f.relation ? { relation: f.relation } : {}), ...(f.options ? { options: f.options.map((o) => o[0]) } : {}),
  }])),
});

/**
 * @param {{ method: string, path: string, query: URLSearchParams, body: unknown, db: object, user: {name: string, isAdmin: boolean} }} req
 * @returns {{ status: number, body: unknown, db?: object }} db is set when the request changed data.
 */
export function handleApi({ method, path, query, body, db, user, allowed = null }) {
  const [, , , model, rawId] = path.split('/'); // "", "api", "v1", model, id
  if (model === 'models' && method === 'GET') return { status: 200, body: Object.keys(models).filter((m) => !allowed || allowed.has(m)).map(describe) };
  if (!model || !models[model]) return { status: 404, body: { error: `Unknown model ${model ?? ''}` } };
  if (allowed && !allowed.has(model)) return { status: 403, body: { error: `No access to ${model}` } };
  const id = rawId === undefined ? null : Number(rawId);
  if (rawId !== undefined && !(Number.isInteger(id) && id > 0)) return { status: 400, body: { error: 'Invalid id' } };

  // Writes go through the same validation as the web client (applyDiff strips undeclared fields).
  const commit = (next) => ({ db: applyDiff(db, diffDb(db, next), { author: user.name, isAdmin: user.isAdmin, allowed }) });
  const vals = body && typeof body === 'object' && !Array.isArray(body) ? body : null;

  try {
    if (id === null && method === 'GET') {
      const limit = Math.min(MAX_LIMIT, Math.max(1, Number(query.get('limit')) || 80));
      const offset = Math.max(0, Number(query.get('offset')) || 0);
      const terms = (query.get('q') ?? '').split(/\s+/).filter(Boolean);
      const all = search(db, model).filter((r) => matches(db, model, r, terms));
      return { status: 200, body: { total: all.length, offset, limit, records: all.slice(offset, offset + limit) } };
    }
    if (id === null && method === 'POST') {
      if (!vals) return { status: 400, body: { error: 'JSON object expected' } };
      const res = create(db, model, vals);
      const { db: saved } = commit(res.db);
      return { status: 201, body: read(saved, model, res.id), db: saved };
    }
    const rec = read(db, model, id);
    if (!rec) return { status: 404, body: { error: `${model} #${id} not found` } };
    if (method === 'GET') return { status: 200, body: rec };
    if (method === 'PATCH') {
      if (!vals) return { status: 400, body: { error: 'JSON object expected' } };
      const { id: _ignored, ...changes } = vals;
      const { db: saved } = commit(write(db, model, id, changes));
      return { status: 200, body: read(saved, model, id), db: saved };
    }
    if (method === 'DELETE') {
      const { db: saved } = commit(unlink(db, model, [id]));
      return { status: 200, body: { ok: true }, db: saved };
    }
  } catch (e) {
    return { status: 400, body: { error: e instanceof Error ? e.message : 'Invalid request' } };
  }
  return { status: 405, body: { error: 'Method not allowed' } };
}
