// Token-only customer documents; no internal database or staff print route is exposed.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { postNote, read, search, write } from '../src/orm.js';
import { subtotal, today } from '../src/models/common.js';
import * as quotePlus from '../src/models/quoteplus.js';
import { demoPaymentsAllowed } from './api.js';

const ORDER = 'sale.order';
const INVOICE = 'account.move';
const paths = { __proto__: null, [ORDER]: 'orders', [INVOICE]: 'invoices' };
const escape = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (v) => escape((Number(v) || 0).toFixed(2));
const tokenFor = (secret, model, r) => createHmac('sha256', secret).update(`${model}:${r.id}:${r.partner_id}`).digest('hex');
const tokenMatches = (secret, model, r, given) => /^[a-f0-9]{64}$/.test(given ?? '') && timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(tokenFor(secret, model, r), 'hex'));
const documentOf = (db, model, id) => {
  const r = paths[model] && read(db, model, id);
  return r?.partner_id && (model === ORDER || r.move_type === 'out_invoice') ? r : null;
};

/** Build a customer URL without putting a token or secret in the record. */
export function portalUrl(secret, model, record) {
  if (!paths[model] || !record?.partner_id) throw new Error('This document cannot be shared');
  return `/my/${paths[model]}/${record.id}?access_token=${tokenFor(secret, model, record)}`;
}

const optionsOf = (r) => r.option_ids ?? [];
const optionAdded = (r, o) => o.is_present || (r.order_line ?? []).some((l) => l.product_id === o.product_id);
const editable = (r) => ['draft', 'sent'].includes(r.state) && !r.is_expired && (!r.validity_date || r.validity_date >= today());
const assertEditable = (r) => { if (!editable(r)) throw new Error('This quotation is closed or expired'); };
/** Adapter contract: prepaymentAmount(order) -> number. */
export function portalPrepaymentAmount(r) {
  const amount = quotePlus.prepaymentAmount(r);
  if (!Number.isFinite(amount) || amount <= 0 || amount > Number(r.amount_total)) throw new Error('Invalid quotation prepayment amount');
  return amount;
}

/** Adapter contract: signQuote(db, orderId, { name, signature }) -> db. */
export function portalSignQuote(db, r, { name, signature }) {
  assertEditable(r);
  if (r.signature) throw new Error('This quotation is already signed');
  if (!name?.trim() || name.trim().length > 120 || !signature?.trim() || signature.trim().length > 2000) throw new Error('Enter your name and typed signature');
  return quotePlus.signQuote(db, r.id, { name: name.trim(), signature: signature.trim() });
}

/** Adapter contract: payQuote(db, orderId, amount, { journal }) -> db; demo gate and replay protection stay server-side. */
export function portalPayQuote(db, r, env = process.env) {
  assertEditable(r);
  if (!demoPaymentsAllowed(env)) throw new Error('Online demo payments are not available; please use bank transfer');
  if (!r.require_payment) throw new Error('This quotation does not require online payment');
  if (r.require_signature && !r.signature) throw new Error('Sign the quotation before paying');
  if (r.payment_state === 'paid') throw new Error('This quotation is already paid');
  const amount = portalPrepaymentAmount(r);
  const booked = quotePlus.payQuote(db, r.id, amount, { journal: 'BNK1' });
  const next = write(booked, ORDER, r.id, { payment_state: 'paid', payment_provider: 'demo', amount_paid: amount });
  return postNote(next, ORDER, r.id, `Demo prepayment recorded: ${amount.toFixed(2)} (no real payment)`);
}

/** Add one offered option at its stored price, consuming it so repeated submissions cannot duplicate it. */
export function portalAddOption(db, r, rawIndex) {
  assertEditable(r);
  if (r.signature || r.payment_state === 'paid') throw new Error('A signed or paid quotation cannot be changed');
  const index = /^\d{1,6}$/.test(rawIndex ?? '') ? Number(rawIndex) : -1;
  const option = optionsOf(r)[index];
  if (!option || optionAdded(r, option) || !read(db, 'product', option.product_id)) throw new Error('Choose an available optional product');
  if (!Number.isFinite(Number(option.price_unit)) || Number(option.price_unit) < 0 || !Number.isFinite(Number(option.qty)) || !(Number(option.qty) > 0)) throw new Error('This optional product is not configured correctly');
  return quotePlus.addOption(db, r.id, index);
}

const page = (title, content) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title><style>
body{margin:0;background:#f5f6f7;color:#20252b;font:1rem/1.6 system-ui,sans-serif}main{max-width:56rem;margin:2rem auto;padding:1.5rem;background:white}h1{line-height:1.2;overflow-wrap:anywhere}a{color:#174f87}table{width:100%;border-collapse:collapse}th,td{text-align:start;padding:.7rem;border-bottom:1px solid #ddd;overflow-wrap:anywhere}label{display:block;margin-block:1rem}input{font:inherit;max-width:100%;box-sizing:border-box}input,button{padding:.7rem;min-height:48px}button{font:inherit;cursor:pointer}form{margin-block:1rem}dl{display:grid;grid-template-columns:1fr 1fr}dd{text-align:end}p{white-space:pre-wrap;overflow-wrap:anywhere}.scroll{overflow-x:auto}:focus-visible{outline:3px solid #174f87;outline-offset:3px}@media(max-width:40rem){main{margin:0;padding:1rem}th,td{padding:.4rem}}@media print{body{background:white}main{margin:0;max-width:none}.no-print{display:none}}
</style></head><body><main>${content}</main></body></html>`;
const form = (url, action, token, content) => `<form method="post" action="${escape(url.split('?')[0] + '/' + action)}"><input type="hidden" name="access_token" value="${escape(token)}">${content}</form>`;

function documentPage(db, model, r, url, query, env) {
  const isOrder = model === ORDER;
  const title = isOrder ? r.state === 'sale' ? 'Sales Order' : 'Quotation' : 'Invoice';
  const partner = read(db, 'res.partner', r.partner_id);
  const token = new URL(url, 'http://x').searchParams.get('access_token');
  const lines = r[isOrder ? 'order_line' : 'invoice_line_ids'] ?? [];
  const printing = query.has('print') || query.has('download');
  let controls = '';
  if (isOrder && editable(r) && !printing) {
    if (!r.signature && r.payment_state !== 'paid') controls += optionsOf(r).map((o, index) => optionAdded(r, o) ? '' : form(url, 'option', token, `<input type="hidden" name="option" value="${index}"><span>${escape(o.name || read(db, 'product', o.product_id)?.name)} — ${money(o.price_unit)}</span> <button type="submit">Add</button>`)).join('');
    if (!r.signature) controls += form(url, 'sign', token, '<h2>Sign quotation</h2><label>Your name <input name="name" autocomplete="name" required maxlength="120"></label><label>Typed signature <input name="signature" required maxlength="2000"></label><button type="submit">Sign and accept</button>');
    if (r.require_payment && r.payment_state !== 'paid') {
      controls += `<h2>Payment required</h2><p>Prepayment: ${money(portalPrepaymentAmount(r))}</p>`;
      controls += demoPaymentsAllowed(env) ? form(url, 'pay', token, '<p>Demo only: no real money is transferred.</p><button type="submit">Pay with demo provider</button>') : `<p>Pay by bank transfer. ${escape(search(db, 'payment.provider').find((p) => p.code === 'wire' && p.state === 'enabled')?.pending_msg || 'Contact us for bank details and use the document number as your payment reference.')}</p>`;
    }
  }
  return page(`${title} ${r.name}`, `<nav class="no-print" aria-label="Portal"><a href="/my">My documents</a></nav><h1>${escape(title)} ${escape(r.name)}</h1><p>${escape(db.settings?.company?.name ?? db.settings?.company)} · ${escape(db.settings?.currency ?? 'USD')}</p><p>${escape(partner?.name)}</p><p>Status: ${escape(r.state)}</p><p>${isOrder ? 'Valid until' : 'Due date'}: ${escape(isOrder ? r.validity_date : r.invoice_date_due)}</p>
    ${query.has('message') ? `<p role="status">${escape(query.get('message'))}</p>` : ''}
    <div class="scroll"><table><caption>Document lines</caption><thead><tr><th scope="col">Description</th><th scope="col">Quantity</th><th scope="col">Unit price</th><th scope="col">Amount</th></tr></thead><tbody>${lines.map((l) => `<tr><td>${escape(l.name || read(db, 'product', l.product_id)?.name)}</td><td>${escape(l.qty)}</td><td>${money(l.price_unit)}</td><td>${money(subtotal(l))}</td></tr>`).join('')}</tbody></table></div>
    <dl><dt>Untaxed</dt><dd>${money(r.amount_untaxed)}</dd><dt>Tax</dt><dd>${money(r.amount_tax)}</dd><dt>Total</dt><dd>${money(r.amount_total)}</dd>${!isOrder ? `<dt>Amount due</dt><dd>${money(r.amount_residual)}</dd>` : ''}</dl><p>${escape(r.note)}</p>
    ${r.signed_by ? `<p>Signed by ${escape(r.signed_by)}</p>` : ''}<div class="no-print"><a href="${escape(url + '&print=1')}">Printable document</a> · <a href="${escape(url + '&download=1')}">Download document (HTML)</a><p>Use your browser’s Print command to print or save as PDF.</p>${controls}</div>`);
}

function homePage(db, user, urlFor) {
  // The current users table has no portal role or verified partner relation. Never infer ownership from email/login.
  const partnerId = user?.isPortal === true && Number.isSafeInteger(user.partnerId) && user.partnerId > 0 ? user.partnerId : null;
  const orders = partnerId ? search(db, ORDER).filter((r) => r.partner_id === partnerId) : [];
  const invoices = partnerId ? search(db, INVOICE).filter((r) => r.partner_id === partnerId && r.move_type === 'out_invoice') : [];
  const groups = [['Quotations', ORDER, orders.filter((r) => ['draft', 'sent'].includes(r.state))], ['Sales orders', ORDER, orders.filter((r) => r.state === 'sale')], ['Invoices', INVOICE, invoices]];
  return page('My documents', `<h1>My documents</h1>${!partnerId ? '<p>Open the secure link provided by your salesperson to view a document. Portal login is not configured.</p>' : ''}${groups.map(([label, model, records]) => `<h2>${label} (${records.length})</h2><ul>${records.map((r) => `<li><a href="${escape(urlFor(model, r))}">${escape(r.name)}</a> — ${money(r.amount_total)}</li>`).join('')}</ul>`).join('')}`);
}

/** Mountable portal handlers with a durable kv secret and the host server's authentication, headers and rate limiter. */
export function createPortal({ sql, getDb, commitDb, sessionUser, allowedFor, clientIp, tooMany, recordFailure, readRaw, securityHeaders, env = process.env }) {
  sql.prepare("INSERT OR IGNORE INTO kv (key, value) VALUES ('portal_secret', ?)").run(randomBytes(32).toString('hex'));
  const secret = sql.prepare("SELECT value FROM kv WHERE key = 'portal_secret'").get().value;
  const urlFor = (model, r) => portalUrl(secret, model, r);
  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { ...securityHeaders, 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', 'Content-Type': 'text/html; charset=utf-8', ...headers });
    res.end(body);
    return true;
  };
  const error = (res, status, text) => send(res, status, page(text, `<h1>${escape(text)}</h1>`));
  const limited = (req, res, prefix) => {
    const key = `${prefix}:${clientIp(req)}`;
    if (tooMany(key)) { error(res, 429, 'Too many requests, try again later'); return true; }
    recordFailure(key);
    return false;
  };
  const sameOrigin = (req) => {
    if (req.headers['sec-fetch-site'] === 'cross-site') return false;
    if (!req.headers.origin) return true;
    try {
      const expected = new URL(env.MIZAN_PUBLIC_URL || `${env.MIZAN_SECURE_COOKIE === '1' || (env.NODE_ENV === 'production' && env.MIZAN_SECURE_COOKIE !== '0') ? 'https' : 'http'}://${req.headers.host}`).origin;
      return req.headers.origin === expected;
    } catch { return false; }
  };
  const handle = async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const link = /^\/api\/portal-link\/([^/]+)\/(\d{1,9})$/.exec(url.pathname);
    if (url.pathname.startsWith('/api/portal-link/')) {
      if (req.method !== 'GET') return error(res, 405, 'Method not allowed');
      const user = sessionUser(req);
      if (!user || user.isPortal) return error(res, user ? 403 : 401, 'Staff login required');
      const allowed = allowedFor(user);
      if (!link || !paths[link[1]]) return error(res, 404, 'Document not found');
      if (allowed && !allowed.has(link[1])) return error(res, 403, 'No access to this document');
      const r = documentOf(getDb(), link[1], Number(link[2]));
      if (!r) return error(res, 404, 'Document not found');
      return send(res, 200, JSON.stringify({ url: urlFor(link[1], r) }), { 'Content-Type': 'application/json; charset=utf-8' });
    }
    if (url.pathname !== '/my' && !url.pathname.startsWith('/my/')) return false;
    if (!['GET', 'POST'].includes(req.method)) return error(res, 405, 'Method not allowed');
    if (req.method === 'GET' && url.pathname === '/my') return send(res, 200, homePage(getDb(), sessionUser(req), urlFor));
    const route = /^\/my\/(orders|invoices)\/(\d{1,9})(?:\/(sign|pay|option))?$/.exec(url.pathname);
    if (!route || (req.method === 'GET' && route[3]) || (req.method === 'POST' && (route[1] !== 'orders' || !route[3]))) return error(res, 404, 'Document not found');
    let input = url.searchParams;
    if (req.method === 'POST') {
      if (limited(req, res, 'portalpost')) return true;
      if (!sameOrigin(req)) return error(res, 403, 'Cross-site request refused');
      if (String(req.headers['content-type']).split(';')[0] !== 'application/x-www-form-urlencoded') return error(res, 415, 'Submit the portal form');
      if (Number(req.headers['content-length']) > 8192) { req.resume(); return error(res, 413, 'Request too large'); }
      let raw;
      try { raw = await readRaw(req, 8192); } catch { return error(res, 413, 'Request too large'); }
      input = new URLSearchParams(raw.toString('utf8'));
    }
    const model = route[1] === 'orders' ? ORDER : INVOICE;
    const db = getDb();
    const r = documentOf(db, model, Number(route[2]));
    if (!r || !tokenMatches(secret, model, r, input.get('access_token'))) {
      if (req.method === 'GET' && limited(req, res, 'portalauth')) return true;
      return error(res, 404, 'Document not found');
    }
    const back = urlFor(model, r);
    if (req.method === 'GET') return send(res, 200, documentPage(db, model, r, back, url.searchParams, env), url.searchParams.has('download') ? { 'Content-Disposition': `attachment; filename="${paths[model]}-${r.id}.html"` } : {});
    let message;
    try {
      const next = route[3] === 'sign' ? portalSignQuote(db, r, { name: input.get('name'), signature: input.get('signature') })
        : route[3] === 'pay' ? portalPayQuote(db, r, env) : portalAddOption(db, r, input.get('option'));
      commitDb(next, { actor: 'portal' });
      message = 'Your quotation has been updated';
    } catch (e) { message = e.message; }
    return send(res, 303, '', { Location: `${back}&message=${encodeURIComponent(message)}` });
  };
  return { handle, portalUrl: urlFor };
}
