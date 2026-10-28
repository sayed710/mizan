// External integrations, each enabled by its own environment variables:
//   AI (Claude):      ANTHROPIC_API_KEY (or another Anthropic credential source) + MIZAN_AI=1
//   WhatsApp Cloud:   MIZAN_WHATSAPP_TOKEN, MIZAN_WHATSAPP_PHONE_ID
//   SMS (Twilio):     MIZAN_TWILIO_SID, MIZAN_TWILIO_TOKEN, MIZAN_TWILIO_FROM
//   Shipping APIs:    MIZAN_SHIPPING_TOKEN (sent as Bearer to each carrier's Rate API URL)
//   Marketplaces:     feed URL on each connector record; MIZAN_MARKETPLACE_TOKEN sent as Bearer
import Anthropic from '@anthropic-ai/sdk';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { createHash, randomBytes } from 'node:crypto';
import { models } from '../src/models/index.js';
import { create, messagesOf, postNote, read, search, write } from '../src/orm.js';
import { addShipping, orderWeight } from '../src/models/logistics.js';
import { markSms, queueSms } from '../src/models/sms.js';
import { markWhatsApp, queueWhatsApp, renderWhatsApp, replyTarget } from '../src/models/whatsapp.js';

const AI_MODEL = 'claude-opus-5-5';

export function integrationStatus(env = process.env) {
  return {
    ai: env.MIZAN_AI === '1' || !!(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN),
    whatsapp: !!(env.MIZAN_WHATSAPP_TOKEN && env.MIZAN_WHATSAPP_PHONE_ID),
    sms: !!(env.MIZAN_TWILIO_SID && env.MIZAN_TWILIO_TOKEN && env.MIZAN_TWILIO_FROM),
    shipping_api: true,
    marketplace: true,
  };
}

// ---- outbound HTTP guard: user-configured URLs must be public https endpoints (no SSRF into the LAN) ----
// Every IPv4 block that is not public unicast: this network, private, CGNAT, loopback, link-local, IETF protocol
// assignments, documentation (TEST-NET 1-3), benchmarking, multicast, reserved and broadcast.
const BLOCKED_V4 = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24',
  '192.0.2.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4']
  .map((cidr) => { const [ip, bits] = cidr.split('/'); return [v4Number(ip), Number(bits)]; });
function v4Number(ip) {
  return ip.split('.').reduce((n, part) => n * 256 + Number(part), 0);
}
const blockedV4 = (ip) => {
  const n = v4Number(ip);
  return BLOCKED_V4.some(([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits)));
};
/** True for any address that is not public unicast (IPv4, IPv6 and IPv4 embedded in IPv6). */
export function isPrivate(ip) {
  if (isIP(ip) === 4) return blockedV4(ip);
  const v6 = ip.toLowerCase();
  const mapped = /^(?:::ffff:|::|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return blockedV4(mapped[1]);
  // The same, written in hex as URL parsing normalises it (::ffff:a00:1 is 10.0.0.1).
  const hex = /^(?:::ffff:|::|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6);
  if (hex) return blockedV4([parseInt(hex[1], 16) >> 8, parseInt(hex[1], 16) & 255, parseInt(hex[2], 16) >> 8, parseInt(hex[2], 16) & 255].join('.'));
  // Unspecified, loopback, unique local (fc00::/7), link-local (fe80::/10), multicast (ff00::/8), documentation (2001:db8::/32).
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || /^ff/.test(v6) || /^2001:0?db8:/.test(v6);
}

/** DNS lookup that refuses any non-public answer; used both to check a URL and to connect, so they cannot differ. */
async function publicAddresses(hostname) {
  const answers = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true });
  if (!answers.length || answers.some((a) => isPrivate(a.address))) throw new Error('URLs pointing to private networks are not allowed');
  return answers;
}

export async function assertPublicUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('Invalid URL'); }
  if (url.protocol !== 'https:') throw new Error('Only https URLs are allowed');
  await publicAddresses(url.hostname.replace(/^\[|\]$/g, ''));
  return url;
}

const MAX_RESPONSE = 5 * 1024 * 1024;
/**
 * HTTPS request whose connection resolves the host through publicAddresses, so the address checked is the
 * address connected to (no DNS-rebinding window). Redirects are not followed.
 */
export function pinnedFetch(url, { method = 'GET', headers = {}, body, signal } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, {
      method, headers, signal,
      lookup: (hostname, options, callback) => {
        publicAddresses(hostname).then((answers) => {
          if (options?.all) callback(null, answers);
          else callback(null, answers[0].address, answers[0].family);
        }, (e) => callback(e));
      },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => { size += c.length; if (size > MAX_RESPONSE) req.destroy(new Error('The response is too large')); else chunks.push(c); });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text: async () => text });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

const NATIVE_FETCH = globalThis.fetch;
async function fetchJson(url, init = {}) {
  // A fetch swapped in after start (tests, a proxy) is used as is; otherwise the pinned request connects.
  const send = globalThis.fetch === NATIVE_FETCH ? pinnedFetch : (u, i) => globalThis.fetch(u, { ...i, redirect: 'error' });
  const res = await send(url, { ...init, signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${new URL(url).hostname} answered ${res.status}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { throw new Error('The service did not return JSON'); }
}

const digits = (phone) => String(phone ?? '').replace(/[^\d+]/g, '');

// ---- AI ----
let anthropic;
// fetch is resolved per call so the client honours a fetch swapped in after it was created (tests, proxies).
const aiClient = () => (anthropic ??= new Anthropic({ fetch: (url, init) => globalThis.fetch(url, init) }));

/** Compact text view of a record + its chatter, for the model. */
function recordContext(db, model, rec) {
  const fields = models[model].fields;
  const lines = Object.entries(fields)
    .filter(([k, f]) => rec[k] != null && rec[k] !== '' && f.type !== 'binary' && f.type !== 'one2many')
    .map(([k, f]) => `${f.label}: ${f.type === 'many2one' ? read(db, f.relation, rec[k])?.name ?? '' : Array.isArray(rec[k]) ? rec[k].join(', ') : rec[k]}`);
  const history = messagesOf(db, model, rec.id).slice(0, 20).map((m) => `- ${m.date.slice(0, 10)} ${m.author}: ${m.body}`);
  return [`Record type: ${models[model].label}`, ...lines, history.length ? `Recent history:\n${history.join('\n')}` : ''].join('\n');
}

/** Ask Claude to draft text (email, note, summary) about a record. Returns { text } or throws a user-facing error. */
/** One Claude request with the shared model, fallback and effort settings; API errors become user-readable. */
async function callClaude(params) {
  try {
    const response = await aiClient().beta.messages.create({
      model: AI_MODEL,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low' },
      ...params,
    });
    if (response.stop_reason === 'refusal') throw new Error('The AI declined this request.');
    return response;
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error('AI credentials are invalid (ANTHROPIC_API_KEY).', { cause: e });
    if (e instanceof Anthropic.RateLimitError) throw new Error('The AI is busy, try again in a moment.', { cause: e });
    if (e instanceof Anthropic.APIError) throw new Error(`AI service error ${e.status}.`, { cause: e });
    throw e;
  }
}

export async function aiDraft(db, user, { model, id, instruction }) {
  const rec = models[model] && read(db, model, Number(id));
  if (!rec) throw new Error('Record not found');
  const task = String(instruction ?? '').slice(0, 2000) || 'Summarize this record and suggest the next step.';
  const response = await callClaude({
    max_tokens: 16000,
    system: `You help employees of ${db.settings?.company ?? 'a company'} inside their ERP. Write in the language of the instruction. Be concise and practical. Output only the text to use, no preamble.`,
    messages: [{ role: 'user', content: `${recordContext(db, model, rec)}\n\nTask (from ${user.name}): ${task}` }],
  });
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  if (!text) throw new Error('The AI returned no text.');
  return { text };
}

// ---- bill digitization (OCR): Claude reads an uploaded vendor bill into a draft bill ----
const MAX_DOC_BASE64 = 4 * 1024 * 1024; // ≈3 MB file
const DOC_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf']);
const BILL_TOOL = {
  name: 'record_bill',
  description: 'Record the fields read from the vendor bill document.',
  input_schema: {
    type: 'object',
    properties: {
      vendor: { type: 'string', description: 'Vendor (supplier) company name' },
      vendor_vat: { type: 'string', description: 'Vendor tax ID, empty if absent' },
      reference: { type: 'string', description: 'Bill / invoice number printed on the document' },
      invoice_date: { type: 'string', description: 'Bill date as YYYY-MM-DD' },
      due_date: { type: 'string', description: 'Due date as YYYY-MM-DD, empty if absent' },
      lines: {
        type: 'array',
        items: {
          type: 'object',
          properties: { description: { type: 'string' }, quantity: { type: 'number' }, unit_price: { type: 'number' }, tax_percent: { type: 'number' } },
          required: ['description', 'quantity', 'unit_price', 'tax_percent'],
        },
      },
    },
    required: ['vendor', 'reference', 'invoice_date', 'lines'],
  },
};
const isoOrNull = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s ?? '')) ? s : null);
const num = (n, min = 0) => (Number.isFinite(Number(n)) && Number(n) >= min ? Number(n) : min);

/** Fill a draft vendor bill from an uploaded image/PDF: vendor (matched or created), reference, dates and lines. */
export async function digitizeBill(db, { id, file }) {
  const bill = read(db, 'account.move', Number(id));
  if (!bill || bill.move_type !== 'in_invoice' || bill.state !== 'draft') throw new Error('Open a draft vendor bill to digitize a document');
  if (!file || !DOC_TYPES.has(file.type) || typeof file.data !== 'string' || !file.data) throw new Error('Upload a PDF or an image (JPEG, PNG, GIF, WebP)');
  if (file.data.length > MAX_DOC_BASE64) throw new Error('The document is too large (3 MB maximum)');
  const source = { type: 'base64', media_type: file.type, data: file.data };
  const response = await callClaude({
    max_tokens: 4000,
    tools: [BILL_TOOL],
    tool_choice: { type: 'tool', name: 'record_bill' },
    messages: [{ role: 'user', content: [
      { type: file.type === 'application/pdf' ? 'document' : 'image', source },
      { type: 'text', text: 'Read this vendor bill and record its fields. Amounts are unit prices before tax.' },
    ] }],
  });
  const data = response.content.find((b) => b.type === 'tool_use')?.input;
  if (!data?.vendor || !Array.isArray(data.lines)) throw new Error('The document could not be read as a bill.');

  const name = String(data.vendor).trim().slice(0, 200);
  const known = search(db, 'res.partner').find((p) => p.name.toLowerCase() === name.toLowerCase() || (data.vendor_vat && p.vat === data.vendor_vat));
  const { db: withVendor, id: partner_id } = known ? { db, id: known.id } : create(db, 'res.partner', { name, is_company: true, vat: String(data.vendor_vat ?? '').slice(0, 50) });
  const invoice_line_ids = data.lines.slice(0, 200).map((l) => ({
    product_id: null, name: String(l.description ?? '').slice(0, 500), qty: num(l.quantity), price_unit: num(l.unit_price), discount: 0, tax: num(l.tax_percent),
  }));
  const next = write(withVendor, 'account.move', bill.id, {
    partner_id, ref: String(data.reference ?? '').slice(0, 100), invoice_line_ids,
    invoice_date: isoOrNull(data.invoice_date) ?? bill.invoice_date, invoice_date_due: isoOrNull(data.due_date) ?? bill.invoice_date_due,
  });
  return { db: postNote(next, 'account.move', bill.id, `Digitized from ${String(file.name ?? 'document').slice(0, 100)}`), message: `${invoice_line_ids.length} line(s) read from ${name}` };
}

// ---- WhatsApp / SMS ----
/**
 * Queue the message and commit it first, then call the WhatsApp Cloud API and commit the result (sent with the
 * returned id, or failed with the error). Without text or template, the first approved template of the document's
 * model is used; a reply to a WhatsApp message goes to that message's document.
 * @param {{get: () => object, commit: (next: object) => void}} store
 */
export async function sendWhatsApp(env, store, user, { model, id, text, templateId }) {
  let target = { model, id: Number(id) };
  if (model === 'whatsapp.message') {
    const msg = read(store.get(), 'whatsapp.message', Number(id));
    if (!msg) throw new Error('Message not found');
    target = replyTarget(msg);
  }
  const rec = models[target.model] && read(store.get(), target.model, Number(target.id));
  if (!rec) throw new Error('Document not found');
  const fallback = !templateId && !String(text ?? '').trim()
    ? search(store.get(), 'whatsapp.template').find((t) => t.status === 'approved' && t.model === target.model) : null;
  const tplId = templateId ?? fallback?.id ?? null;
  const body = tplId ? '' : String(text ?? '').trim() || `${store.get().settings?.company}: ${rec.name ?? ''}`;
  const queued = queueWhatsApp(store.get(), { templateId: tplId, text: body, ...target });
  store.commit(queued.db);
  const msg = read(queued.db, 'whatsapp.message', queued.id);
  const template = tplId && read(queued.db, 'whatsapp.template', Number(tplId));
  const content = template
    ? { type: 'template', template: { name: template.name, language: { code: template.language || 'en' }, components: [{ type: 'body', parameters: renderWhatsApp(queued.db, template, rec).values.map((v) => ({ type: 'text', text: v })) }] } }
    : { type: 'text', text: { body: msg.body } };
  try {
    store.check?.(); // the lease may have been lost since the message was queued
    const out = await fetchJson(`https://graph.facebook.com/v21.0/${encodeURIComponent(env.MIZAN_WHATSAPP_PHONE_ID)}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.MIZAN_WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: msg.phone, ...content }),
    });
    store.commit(markWhatsApp(store.get(), msg.id, { waMessageId: out?.messages?.[0]?.id ?? '' }));
  } catch (e) {
    store.commit(markWhatsApp(store.get(), msg.id, { error: e.message }));
    throw new Error(`WhatsApp message failed: ${e.message}`, { cause: e });
  }
  return { message: 'WhatsApp message sent' };
}

export async function sendSms(env, to, body) {
  const form = new URLSearchParams({ To: digits(to), From: env.MIZAN_TWILIO_FROM, Body: String(body).slice(0, 1600) });
  await fetchJson(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(env.MIZAN_TWILIO_SID)}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`${env.MIZAN_TWILIO_SID}:${env.MIZAN_TWILIO_TOKEN}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
}

const MAX_SMS = 500;

/**
 * Queue the campaign's traces and commit them first (a second send then sees it sent; concurrent edits survive),
 * then send each through the gateway and commit its result against the current db.
 * @param {{get: () => object, commit: (next: object) => void}} store
 */
export async function sendSmsCampaign(env, store, { id }) {
  const c = read(store.get(), 'sms.campaign', Number(id));
  if (!c) throw new Error('Campaign not found');
  const queued = queueSms(store.get(), c);
  store.commit(queued);
  const traces = search(queued, 'sms.trace').filter((t) => t.campaign_id === c.id && t.state === 'outgoing').slice(0, MAX_SMS);
  let sent = 0;
  for (const trace of traces) {
    try {
      store.check?.();
      await sendSms(env, trace.phone, c.body);
      store.commit(markSms(store.get(), trace.id, true));
      sent += 1;
    } catch (e) {
      store.commit(markSms(store.get(), trace.id, false, e.message));
    }
  }
  return { message: `${sent} SMS sent, ${traces.length - sent} failed` };
}

// ---- Shipping rate APIs ----
export async function quoteShipping(env, db, { id }) {
  const order = read(db, 'sale.order', Number(id));
  const carrier = order && read(db, 'delivery.carrier', order.carrier_id);
  if (!carrier) throw new Error('Choose a delivery method first');
  if (carrier.delivery_type !== 'api') {
    // Non-API carriers are priced locally; reuse the model's button logic.
    const button = models['sale.order'].form.buttons.find((b) => b.label === 'Add Shipping');
    return { db: button.run(db, order).db };
  }
  if (!carrier.api_url) throw new Error(`Set the Rate API URL on ${carrier.name}`);
  const url = await assertPublicUrl(carrier.api_url);
  const partner = read(db, 'res.partner', order.partner_id);
  const quote = await fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(env.MIZAN_SHIPPING_TOKEN ? { Authorization: `Bearer ${env.MIZAN_SHIPPING_TOKEN}` } : {}) },
    body: JSON.stringify({ weight_kg: orderWeight(db, order.order_line), value: order.amount_untaxed, destination: { city: partner?.city, country: partner?.country }, reference: order.name }),
  });
  const price = Number(quote.price);
  if (!Number.isFinite(price) || price < 0) throw new Error('The carrier did not return a valid price');
  return { db: addShipping(db, order, price), message: `${carrier.name}: ${price}` };
}

// ---- Marketplace order import ----
/**
 * Feed format (JSON array, e.g. from a marketplace middleware):
 * [{ id, date?, customer: { name, email?, phone?, city?, country? }, lines: [{ sku, qty, price }] }]
 */
export async function syncMarketplace(db, { id }) {
  const conn = read(db, 'marketplace.connector', Number(id));
  if (!conn?.feed_url) throw new Error('Set the orders feed URL');
  const url = await assertPublicUrl(conn.feed_url);
  const token = process.env.MIZAN_MARKETPLACE_TOKEN;
  const feed = await fetchJson(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!Array.isArray(feed)) throw new Error('The feed must be a JSON array of orders');
  let next = db;
  let imported = 0;
  for (const o of feed.slice(0, 500)) {
    const ref = `${conn.platform}:${String(o?.id ?? '').slice(0, 80)}`;
    if (!o?.id || search(next, 'sale.order').some((s) => s.client_order_ref === ref)) continue;
    const c = o.customer ?? {};
    const email = String(c.email ?? '').slice(0, 254);
    let partnerId = email && search(next, 'res.partner').find((p) => p.email?.toLowerCase() === email.toLowerCase())?.id;
    if (!partnerId) {
      const res = create(next, 'res.partner', { name: String(c.name ?? 'Marketplace customer').slice(0, 120), email, phone: String(c.phone ?? '').slice(0, 40), city: String(c.city ?? '').slice(0, 80), country: String(c.country ?? '').slice(0, 80), tag_ids: [conn.platform] });
      next = res.db;
      partnerId = res.id;
    }
    const lines = (Array.isArray(o.lines) ? o.lines : []).map((l) => {
      const product = search(next, 'product').find((p) => p.default_code === l.sku);
      return product && Number(l.qty) > 0 ? { product_id: product.id, qty: Number(l.qty), price_unit: Number(l.price) || product.list_price, tax: 14 } : null;
    }).filter(Boolean);
    if (!lines.length) continue;
    next = create(next, 'sale.order', { partner_id: partnerId, order_line: lines, client_order_ref: ref, connector_id: conn.id, source: 'marketplace', state: 'sent' }).db;
    imported += 1;
  }
  next = write(next, 'marketplace.connector', conn.id, { last_sync: new Date().toISOString().slice(0, 16).replace('T', ' '), last_count: imported });
  return { db: next, message: `${imported} order(s) imported` };
}

// ---- IoT ----
export const hashToken = (token) => createHash('sha256').update(token).digest('hex');

export function issueIotToken(db, { id }) {
  const device = read(db, 'iot.device', Number(id));
  if (!device) throw new Error('Device not found');
  const token = `iot_${randomBytes(24).toString('base64url')}`;
  return { db: write(db, 'iot.device', device.id, { token_hash: hashToken(token) }), message: `Device token (shown once):\n${token}\n\nPOST /api/iot/ingest with Authorization: Bearer <token> and {"value": 12.5}` };
}

export function ingestIot(db, token, body) {
  const device = search(db, 'iot.device').find((d) => d.token_hash && d.token_hash === hashToken(token));
  if (!device) return null;
  const value = Number(body?.value);
  if (!Number.isFinite(value)) throw new Error('value must be a number');
  return write(db, 'iot.device', device.id, { last_value: value, last_seen: new Date().toISOString().slice(0, 19).replace('T', ' '), ...(typeof body.unit === 'string' ? { unit: body.unit.slice(0, 20) } : {}) });
}
