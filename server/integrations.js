// External integrations, each enabled by its own environment variables:
//   AI (Claude):      ANTHROPIC_API_KEY (or another Anthropic credential source) + MIZAN_AI=1
//   WhatsApp Cloud:   MIZAN_WHATSAPP_TOKEN, MIZAN_WHATSAPP_PHONE_ID
//   SMS (Twilio):     MIZAN_TWILIO_SID, MIZAN_TWILIO_TOKEN, MIZAN_TWILIO_FROM
//   Shipping APIs:    MIZAN_SHIPPING_TOKEN (sent as Bearer to each carrier's Rate API URL)
//   Marketplaces:     feed URL on each connector record; MIZAN_MARKETPLACE_TOKEN sent as Bearer
import Anthropic from '@anthropic-ai/sdk';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { models } from '../src/models/index.js';
import { create, messagesOf, postNote, read, search, write } from '../src/orm.js';
import { addShipping, orderWeight } from '../src/models/logistics.js';

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
const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];
const isPrivate = (ip) => (isIP(ip) === 6 ? /^(::1|fc|fd|fe80|::ffff:(10|127|192\.168|169\.254)\.)/i.test(ip) : PRIVATE_V4.some((r) => r.test(ip)));

export async function assertPublicUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('Invalid URL'); }
  if (url.protocol !== 'https:') throw new Error('Only https URLs are allowed');
  const { address } = await lookup(url.hostname);
  if (isPrivate(address)) throw new Error('URLs pointing to private networks are not allowed');
  return url;
}

async function fetchJson(url, init = {}) {
  const res = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${new URL(url).hostname} answered ${res.status}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { throw new Error('The service did not return JSON'); }
}

const digits = (phone) => String(phone ?? '').replace(/[^\d+]/g, '');

// ---- AI ----
let anthropic;
const aiClient = () => (anthropic ??= new Anthropic());

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
export async function aiDraft(db, user, { model, id, instruction }) {
  const rec = models[model] && read(db, model, Number(id));
  if (!rec) throw new Error('Record not found');
  const task = String(instruction ?? '').slice(0, 2000) || 'Summarize this record and suggest the next step.';
  try {
    const response = await aiClient().beta.messages.create({
      model: AI_MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low' },
      system: `You help employees of ${db.settings?.company ?? 'a company'} inside their ERP. Write in the language of the instruction. Be concise and practical. Output only the text to use, no preamble.`,
      messages: [{ role: 'user', content: `${recordContext(db, model, rec)}\n\nTask (from ${user.name}): ${task}` }],
    });
    if (response.stop_reason === 'refusal') throw new Error('The AI declined this request.');
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (!text) throw new Error('The AI returned no text.');
    return { text };
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error('AI credentials are invalid (ANTHROPIC_API_KEY).');
    if (e instanceof Anthropic.RateLimitError) throw new Error('The AI is busy, try again in a moment.');
    if (e instanceof Anthropic.APIError) throw new Error(`AI service error ${e.status}.`);
    throw e;
  }
}

// ---- WhatsApp / SMS ----
function partnerOf(db, model, rec) {
  if (model === 'res.partner') return rec;
  return read(db, 'res.partner', rec.partner_id);
}

export async function sendWhatsApp(env, db, user, { model, id, text }) {
  const rec = models[model] && read(db, model, Number(id));
  const partner = rec && partnerOf(db, model, rec);
  if (!partner?.phone) throw new Error('The contact has no phone number');
  const body = String(text ?? '').trim() || `${db.settings?.company}: ${rec.name ?? ''}`;
  await fetchJson(`https://graph.facebook.com/v21.0/${encodeURIComponent(env.MIZAN_WHATSAPP_PHONE_ID)}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.MIZAN_WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: digits(partner.phone).replace(/^\+/, ''), type: 'text', text: { body: body.slice(0, 4096) } }),
  });
  return { db: postNote(db, model, rec.id, `WhatsApp sent to ${partner.phone}: ${body.slice(0, 200)}`), message: 'WhatsApp message sent' };
}

export async function sendSms(env, to, body) {
  const form = new URLSearchParams({ To: digits(to), From: env.MIZAN_TWILIO_FROM, Body: String(body).slice(0, 1600) });
  await fetchJson(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(env.MIZAN_TWILIO_SID)}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`${env.MIZAN_TWILIO_SID}:${env.MIZAN_TWILIO_TOKEN}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
}

export async function sendSmsCampaign(env, db, { id }) {
  const c = read(db, 'sms.campaign', Number(id));
  if (!c) throw new Error('Campaign not found');
  const recipients = search(db, 'mailing.contact').filter((x) => x.list_id === c.list_id && !x.opt_out);
  const phones = recipients.map((x) => x.phone ?? read(db, 'res.partner', x.partner_id)?.phone).filter(Boolean);
  let sent = 0;
  for (const phone of phones.slice(0, 500)) {
    try { await sendSms(env, phone, c.body); sent += 1; } catch (e) { console.warn(`SMS ${phone}: ${e.message}`); }
  }
  return { db: write(db, 'sms.campaign', c.id, { stage_id: 'sent', sent }), message: `${sent} SMS sent` };
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
