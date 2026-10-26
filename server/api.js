// External REST API (/api/v1) authenticated with personal API keys (Authorization: Bearer <key>).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { models } from '../src/models/index.js';
import { create, matches, postNote, read, search, unlink, write } from '../src/orm.js';
import { subtotal, today } from '../src/models/common.js';
import { categoryPath } from '../src/models/ecommerce.js';
import { cartTotals, isPurchasable, isSellable, websiteCarriers } from '../src/models/shop.js';
import { applyDiff, diffDb } from '../src/sync.js';
import { availableSlots, bookAppointment } from '../src/models/appointments.js';
import { menuTree, resolveUrl } from '../src/models/websiteplus.js';

const MAX_LIMIT = 500;

const IMAGE = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/;
/** Only inline raster images reach the website (the CSP allows data: images). */
export const safeImage = (v) => (IMAGE.test(v?.data ?? '') ? v.data : null);

/** Products the shop can show or sell, in the field names the shared shop logic (src/models/shop.js) reads. */
const shopCatalog = (db) => search(db, 'product').filter((p) => isSellable(p) && (!p.variant_of || isSellable(read(db, 'product', p.variant_of)))).map((p) => ({
  id: p.id, name: p.name, price: p.list_price, list_price: p.list_price, default_code: p.default_code ?? '', type: p.type,
  variant_of: p.variant_of ?? null, variant_values: p.variant_values ?? [], attributes: p.attributes ?? '',
  public_categ_ids: (p.public_categ_ids ?? []).map((l) => ({ category_id: l.category_id })), website_description: p.website_description ?? '',
  website_sequence: p.website_sequence ?? 0, ribbon: p.ribbon ?? '', image: safeImage(p.image), qty_available: p.type === 'goods' ? Number(p.qty_available) || 0 : null,
}));
/** Demo payments confirm orders as paid without a payment: only when MIZAN_DEMO_PAYMENTS=1 outside production. */
export const demoPaymentsAllowed = (env = process.env) => env.MIZAN_DEMO_PAYMENTS === '1' && env.NODE_ENV !== 'production';
const enabledProviders = (db) => search(db, 'payment.provider').filter((p) => p.state === 'enabled' && (p.code !== 'demo' || demoPaymentsAllowed()));
const selectablePricelists = (db) => search(db, 'product.pricelist').filter((p) => p.selectable);

/** Public website content: only published pages and sellable products (no internal fields). */
export const publicSite = (db, canAccess = () => false) => ({
  company: db.settings?.company,
  currency: db.settings?.currency ?? 'USD',
  pages: search(db, 'website.page').filter((p) => {
    const access = resolveUrl(db, p.slug);
    return access?.page || ((access?.needsPassword || access?.needsLogin) && canAccess(p));
  }).sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
    .map((p) => ({ id: p.id, name: p.name, slug: p.slug, content: p.content, translations: p.translations ?? [], website_meta_title: p.website_meta_title ?? '', website_meta_description: p.website_meta_description ?? '', header_visible: p.header_visible !== false, footer_visible: p.footer_visible !== false })),
  menus: menuTree(db),
  products: shopCatalog(db),
  categories: search(db, 'product.public.category').sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0) || a.id - b.id)
    .map((c) => ({ id: c.id, name: c.name, parent_id: c.parent_id ?? null, sequence: c.sequence ?? 0, display_name: categoryPath(db, c.id), image: safeImage(c.image) })),
  carriers: websiteCarriers(db).map((c) => ({ id: c.id, name: c.name })),
  providers: enabledProviders(db).map((p) => ({ name: p.name, code: p.code, pending_msg: p.pending_msg ?? '' })),
  pricelists: selectablePricelists(db).map((p) => ({ id: p.id, name: p.name })),
  jobs: search(db, 'hr.job').filter((j) => j.is_published).map((j) => ({ id: j.id, name: j.name, description: j.description ?? '' })),
  events: openEvents(db).map((e) => ({
    id: e.id, name: e.name, date_begin: e.date_begin, location: e.location ?? '', description: e.description ?? '',
    tickets: (e.ticket_ids ?? []).map((t) => ({ name: t.name, price: Number(t.price) || 0 })),
  })),
  appointments: publishedTypes(db).map((a) => ({
    id: a.id, name: a.name, description: a.description ?? '', image: safeImage(a.image), location: a.location ?? '', is_online: !!a.is_online,
    duration: Number(a.duration) || 60, price: Number(a.price) || 0, assign_method: a.assign_method ?? 'random', timezone: a.timezone || 'Africa/Cairo',
    staff: (a.staff_ids ?? []).map((l) => read(db, 'hr.employee', l.employee_id)).filter(Boolean).map((e) => ({ id: e.id, name: e.name, avatar: safeImage(e.image) })),
    questions: (a.questions ?? []).filter((q) => q.label).map((q) => ({ label: q.label, required: !!q.required })),
  })),
});

/** A real YYYY-MM-DD day (rejects 2099-02-31). */
const isCalendarDate = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? '');
  if (!m) return false;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]);
};

const publishedTypes = (db) => search(db, 'appointment.type').filter((a) => a.is_published);

const openEvents = (db) => search(db, 'event.event').filter((e) => ['booked', 'announced'].includes(e.stage_id) && e.date_begin >= today());

/** Visitor contact, matched by email or created (tagged Website). */
function websitePartner(db, { name, email, phone }) {
  const known = search(db, 'res.partner').find((p) => p.email?.toLowerCase() === email.toLowerCase());
  return known ? { db, id: known.id } : create(db, 'res.partner', { name, email, phone, tag_ids: ['Website'] });
}

const visitor = (b) => ({ name: String(b.name ?? '').trim().slice(0, 120), email: String(b.email ?? '').trim().slice(0, 254), phone: String(b.phone ?? '').slice(0, 40) });

/** Run a public create; model guards (sold out, slot taken…) become a 400 with their message. */
function publicCreate(db, build) {
  try {
    const next = build();
    return { status: 201, body: { ok: true }, db: applyDiff(db, diffDb(db, next), { author: 'Website', isAdmin: false }) };
  } catch (e) {
    return { status: 400, body: { error: e.message } };
  }
}

/** Anonymous registration to an announced event (seat and ticket limits apply). */
export function publicRegister(db, body) {
  const b = body && typeof body === 'object' ? body : {};
  const event = openEvents(db).find((e) => e.id === b.event_id);
  const v = visitor(b);
  if (!event) return { status: 400, body: { error: 'Registrations for this event are closed' } };
  if (!v.name || !EMAIL.test(v.email)) return { status: 400, body: { error: 'Enter your name and a valid email address' } };
  const tickets = event.ticket_ids ?? [];
  const ticket = tickets.find((t) => t.name === b.ticket)?.name ?? null;
  if (tickets.length && !ticket) return { status: 400, body: { error: 'Choose a ticket' } };
  if (search(db, 'event.registration').some((r) => r.event_id === event.id && r.state !== 'cancel' && r.email?.toLowerCase() === v.email.toLowerCase())) {
    return { status: 400, body: { error: 'You are already registered for this event' } };
  }
  return publicCreate(db, () => {
    const { db: withPartner, id: partner_id } = websitePartner(db, v);
    return create(withPartner, 'event.registration', { ...v, event_id: event.id, partner_id, ticket }).db;
  });
}

const SLOT_DAYS = 14;

/** Free slots of a published type for the next 14 days (GET /api/public/appointment/<id>/slots?from=&staff=). */
export function publicSlots(db, id, query, now = new Date()) {
  const get = (k) => String((typeof query?.get === 'function' ? query.get(k) : query?.[k]) ?? '');
  const type = publishedTypes(db).find((a) => a.id === Number(id));
  if (!type) return { status: 404, body: { error: 'Unknown appointment' } };
  const staff = Number(get('staff'));
  return { status: 200, body: { slots: availableSlots(db, type, { from: isCalendarDate(get('from')) ? get('from') : undefined, days: SLOT_DAYS, staffId: Number.isInteger(staff) && staff > 0 ? staff : null, now }) } };
}

const MAX_ANSWERS = 20;

/** Anonymous booking of a free slot (checked by bookAppointment); returns the booking id, start and meeting link. */
export function publicBook(db, body, now = new Date()) {
  const b = bodyOf(body);
  const type = publishedTypes(db).find((a) => a.id === b.type_id);
  if (!type) return { status: 400, body: { error: 'Unknown appointment' } };
  const answers = (Array.isArray(b.answers) ? b.answers : []).slice(0, MAX_ANSWERS).map((a) => ({ question: clip(a?.question, 200), answer: clip(a?.answer, 2000) }));
  try {
    const res = bookAppointment(db, type, {
      ...visitor(b), start: String(b.start ?? ''), staffId: Number.isInteger(b.staff_id) ? b.staff_id : null, answers, now,
    });
    const saved = applyDiff(db, diffDb(db, res.db), { author: 'Website', isAdmin: false });
    const booking = read(saved, 'appointment.booking', res.id);
    return { status: 201, body: { booking: booking.id, start: booking.start, ...(booking.meeting_url ? { meeting_url: booking.meeting_url } : {}) }, db: saved };
  } catch (e) {
    return { status: 400, body: { error: e.message } };
  }
}

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

export const EMAIL = /^[^@\s]{1,64}@[^@\s]{1,190}\.[^@\s]{2,}$/;

const MAX_LINES = 50;
const clip = (v, max) => String(v ?? '').trim().slice(0, max);
const bodyOf = (body) => (body && typeof body === 'object' && !Array.isArray(body) ? body : {});

/** Cart lines from the visitor: every product must be purchasable online, or the whole cart is refused. */
function cartLines(db, raw) {
  if (!Array.isArray(raw) || !raw.length) return { error: 'Your cart is empty' };
  if (raw.length > MAX_LINES) return { error: 'Too many lines in your cart' };
  const lines = [];
  for (const l of raw) {
    if (!Number.isInteger(l?.qty) || l.qty < 1 || l.qty > 1000) return { error: 'Enter a quantity between 1 and 1000' };
    const product = Number.isInteger(l.product_id) ? read(db, 'product', l.product_id) : null;
    if (!isPurchasable(db, product)) return { error: 'A product in your cart is not available online' };
    if (product.type === 'goods' && l.qty > (Number(product.qty_available) || 0)) return { error: `Only ${Math.max(0, Number(product.qty_available) || 0)} of ${product.name} in stock` };
    lines.push({ product_id: product.id, qty: l.qty });
  }
  return { lines };
}

const pricelistOf = (db, id) => selectablePricelists(db).find((p) => p.id === id)?.id ?? null;
/** Totals without the internal order lines. */
const publicTotals = ({ orderLines, ...totals }) => totals;

/** Cart prices computed on the server (client prices are never used), with the price of each website carrier. */
export function publicCart(db, body) {
  const b = bodyOf(body);
  const { lines, error } = cartLines(db, b.lines);
  if (error) return { status: 400, body: { error } };
  const options = { pricelistId: pricelistOf(db, b.pricelist), partnerCountry: clip(b.country, 80) };
  const carriers = websiteCarriers(db);
  try {
    const totals = cartTotals(db, lines, { ...options, carrierId: carriers.find((c) => c.id === b.carrier_id)?.id ?? null });
    const priced = carriers.map((c) => {
      try { return { id: c.id, name: c.name, price: cartTotals(db, lines, { ...options, carrierId: c.id }).delivery }; } catch { return { id: c.id, name: c.name, price: null }; }
    });
    return { status: 200, body: { ...publicTotals(totals), carriers: priced } };
  } catch (e) {
    return { status: 400, body: { error: e.message } };
  }
}

const hashToken = (token) => createHash('sha256').update(String(token)).digest('hex');
/** Constant-time comparison of a visitor token with the stored hash. */
const tokenMatches = (token, hash) => {
  const a = Buffer.from(hashToken(token));
  const b = Buffer.from(String(hash ?? ''));
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * Customer for a checkout: always a new Website contact holding the address. An unverified email never puts orders,
 * credit or payment terms on an existing customer; staff merge the contacts when the order is genuine.
 */
function checkoutPartners(db, v, address) {
  const known = search(db, 'res.partner').some((p) => p.email?.toLowerCase() === v.email.toLowerCase());
  const res = create(db, 'res.partner', { ...v, ...address, tag_ids: known ? ['Website', 'To Merge'] : ['Website'] });
  return { db: res.db, partnerId: res.id, shippingId: res.id };
}

/**
 * Anonymous checkout: address, delivery method and payment provider; every price is recomputed here.
 * Demo payments confirm the order and mark it paid; wire transfer and cash on delivery leave a sent quotation.
 * @returns {{ status: number, body: { order?: string, access_token?: string, error?: string }, db?: object }}
 */
export function publicOrder(db, body) {
  const b = bodyOf(body);
  const v = visitor(b);
  if (!v.name) return { status: 400, body: { error: 'Name is required' } };
  if (!EMAIL.test(v.email)) return { status: 400, body: { error: 'Enter a valid email address' } };
  const address = { street: clip(b.street, 120), city: clip(b.city, 80), zip: clip(b.zip, 20), country: clip(b.country, 80) };
  const { lines, error } = cartLines(db, b.lines);
  if (error) return { status: 400, body: { error } };
  const carriers = websiteCarriers(db);
  const carrier = carriers.find((c) => c.id === b.carrier_id) ?? null;
  if (!carrier && (b.carrier_id != null || carriers.length)) return { status: 400, body: { error: 'Choose a delivery method' } };
  const provider = enabledProviders(db).find((p) => p.code === b.provider_code);
  if (!provider) return { status: 400, body: { error: 'Choose a payment method' } };
  const pricelistId = pricelistOf(db, b.pricelist);
  try {
    const totals = cartTotals(db, lines, { pricelistId, carrierId: carrier?.id ?? null, partnerCountry: address.country });
    const { db: withPartner, partnerId, shippingId } = checkoutPartners(db, v, address);
    const token = randomBytes(24).toString('base64url');
    const order = create(withPartner, 'sale.order', {
      partner_id: partnerId, partner_invoice_id: partnerId, partner_shipping_id: shippingId, pricelist_id: pricelistId, carrier_id: carrier?.id ?? null,
      order_line: totals.orderLines, state: 'sent', source: 'website', payment_provider: provider.code, payment_state: 'pending', access_token_hash: hashToken(token),
    });
    let next = postNote(order.db, 'sale.order', order.id, `Payment method: ${provider.name}`);
    if (provider.code === 'demo') {
      const confirm = models['sale.order'].form.buttons.find((x) => x.label === 'Confirm');
      next = confirm.run(next, read(next, 'sale.order', order.id)).db;
      next = postNote(write(next, 'sale.order', order.id, { payment_state: 'paid' }), 'sale.order', order.id, `Paid online (${provider.name}): ${totals.total}`);
    }
    const saved = applyDiff(db, diffDb(db, next), { author: 'Website', isAdmin: false });
    return { status: 201, body: { order: read(saved, 'sale.order', order.id).name, access_token: token }, db: saved };
  } catch (e) {
    return { status: 400, body: { error: e.message } };
  }
}

/**
 * Order status for the visitor holding its token (GET /api/public/order-status?order=&token=).
 * `denied` marks a wrong order/token so the server can rate-limit guessing.
 */
export function publicOrderStatus(db, query) {
  const get = (k) => String((typeof query?.get === 'function' ? query.get(k) : query?.[k]) ?? '');
  const order = search(db, 'sale.order').find((o) => o.source === 'website' && o.name === get('order'));
  if (!order?.access_token_hash || !tokenMatches(get('token'), order.access_token_hash)) return { status: 404, body: { error: 'Order not found' }, denied: true };
  const provider = enabledProviders(db).find((p) => p.code === order.payment_provider) ?? search(db, 'payment.provider').find((p) => p.code === order.payment_provider);
  return {
    status: 200,
    body: {
      order: order.name, date: order.date_order, state: order.state, payment_state: order.payment_state ?? null,
      provider: provider ? { name: provider.name, code: provider.code, pending_msg: provider.pending_msg ?? '', done_msg: provider.done_msg ?? '' } : null,
      lines: (order.order_line ?? []).map((l) => ({ name: read(db, 'product', l.product_id)?.name ?? '', qty: l.qty, price_unit: l.price_unit, subtotal: Math.round(subtotal(l) * 100) / 100 })),
      untaxed: order.amount_untaxed, tax: order.amount_tax, total: order.amount_total,
    },
  };
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
  const commit = (next) => ({ db: applyDiff(db, diffDb(db, next), { author: user.name, isAdmin: user.isAdmin, allowed, login: user.login }) });
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
