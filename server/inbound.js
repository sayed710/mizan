// Public routes fed from outside: Twilio SMS replies (STOP opt-outs) and read-only document share links.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { search } from '../src/orm.js';
import { handleInbound } from '../src/models/sms.js';
import { shareDocuments } from '../src/models/signplus.js';

/** What an inbound SMS may change: only the phone blacklist. */
export const SMS_WRITE = { author: 'SMS', isAdmin: false, allowed: new Set(['phone.blacklist']) };
export const SMS_PATH = '/api/public/sms/inbound';
const TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
const escape = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Twilio's X-Twilio-Signature: base64 HMAC-SHA1 of the full URL followed by every POST name and value, sorted by name. */
export function twilioSignature(token, url, params) {
  const data = url + [...params].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => k + v).join('');
  return createHmac('sha1', token).update(data, 'utf8').digest('base64');
}

const sameSignature = (a, b) => {
  const x = Buffer.from(String(a ?? '')), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Twilio inbound SMS webhook. Twilio signs the public URL, so MIZAN_PUBLIC_URL must be set; unsigned or
 * mis-signed requests are refused. A "STOP" reply blacklists the sender.
 * @returns {{status: number, headers: object, body: string, db?: object}}
 */
export function smsInbound(env, db, raw, signature) {
  const text = { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' };
  if (!env.MIZAN_TWILIO_TOKEN || !env.MIZAN_PUBLIC_URL) return { status: 503, headers: text, body: 'SMS replies are not configured' };
  const params = new URLSearchParams(raw.toString('utf8'));
  const url = `${env.MIZAN_PUBLIC_URL.replace(/\/$/, '')}${SMS_PATH}`;
  if (!sameSignature(signature, twilioSignature(env.MIZAN_TWILIO_TOKEN, url, params))) return { status: 403, headers: text, body: 'Invalid signature' };
  return { status: 200, headers: { 'Content-Type': 'text/xml; charset=utf-8', 'Cache-Control': 'no-store' }, body: TWIML, db: handleInbound(db, params.get('From') ?? '', params.get('Body') ?? '') };
}

const page = (title, content) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title><style>body{font-family:system-ui,sans-serif;max-width:720px;margin:2rem auto;padding:0 1rem;color:#1f2430}li{margin:.4rem 0}.muted{color:#5b6170}</style></head><body><main>${content}</main></body></html>`;

/**
 * GET /share/<token> lists the shared documents; GET /share/<token>/<id> downloads one of them as an attachment
 * (never rendered inline, whatever its type). Expired or unknown tokens get the same 404.
 * @returns {{status: number, headers: object, body: string|Buffer} | null} null when the path is not a share link
 */
export function sharePage(db, path, date, getBlob = () => undefined) {
  const m = /^\/share\/([\w-]{8,64})(?:\/(\d{1,9}))?$/.exec(path);
  const html = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
  if (!m) return path.startsWith('/share/') ? { status: 404, headers: html, body: page('Link expired', '<h1>This share link is invalid or expired</h1>') } : null;
  let docs;
  try { docs = shareDocuments(db, m[1], date); } catch { return { status: 404, headers: html, body: page('Link expired', '<h1>This share link is invalid or expired</h1>') }; }
  const share = search(db, 'documents.share').find((s) => s.token === m[1]);
  if (m[2]) {
    const doc = docs.find((d) => d.id === Number(m[2]));
    const data = /^data:[^,]*;base64,(.*)$/s.exec(doc?.file?.data ?? '');
    const stored = doc?.file?.blob ? getBlob(doc.file.blob) : undefined;
    if (!doc || (!data && !stored)) return { status: 404, headers: html, body: page('Not found', '<h1>Document not found</h1>') };
    const name = String(doc.file.name || doc.name || 'document').replace(/[^\w.\- ]/g, '_');
    return { status: 200, headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }, body: stored ? Buffer.from(stored.data) : Buffer.from(data[1], 'base64') };
  }
  const items = docs.map((d) => `<li>${d.file?.data || d.file?.blob ? `<a href="/share/${m[1]}/${d.id}">${escape(d.name)}</a>` : `${escape(d.name)} <span class="muted">(no file)</span>`}</li>`).join('');
  const expires = share?.expiration ? `<p class="muted">Available until ${escape(share.expiration)}</p>` : '';
  return { status: 200, headers: html, body: page(share?.name || 'Shared documents', `<h1>${escape(share?.name || 'Shared documents')}</h1>${expires}${docs.length ? `<ul>${items}</ul>` : '<p>No documents are shared here yet.</p>'}`) };
}
