// Mass mailing delivery and tracking: personalised emails with tracked links, an open pixel and an unsubscribe link.
import { randomUUID } from 'node:crypto';
import { read, search } from '../src/orm.js';
import { markBounced, queueMailing, renderTemplate, trackEvent, unsubscribe } from '../src/models/mailing.js';
import { sendMail } from './smtp.js';

const TOKEN = /^[\w-]{8,64}$/;
const LINK = /https?:\/\/[^\s<>"')\]]+/g;
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const today = () => new Date().toISOString().slice(0, 10);

/** Distinct links of a mailing body, in order: click URLs carry an index into this list, never a free URL (no open redirect). */
export const linksOf = (body) => [...new Set(String(body ?? '').match(LINK) ?? [])];

/** The email one recipient gets: placeholders filled from their record, links tracked, open pixel and unsubscribe link. */
export function emailFor(db, mailing, trace, baseUrl) {
  const object = (trace.res_model && read(db, trace.res_model, trace.res_id)) || { name: trace.name, email: trace.email };
  const body = renderTemplate(mailing.body ?? '', object);
  const links = linksOf(mailing.body);
  const tracked = (url) => `${baseUrl}/api/public/mail/click/${trace.token}/${links.indexOf(url)}`;
  const unsubscribeUrl = `${baseUrl}/api/public/mail/unsubscribe/${trace.token}`;
  const text = `${body.replace(LINK, (u) => (links.includes(u) ? tracked(u) : u))}\n\n--\nUnsubscribe: ${unsubscribeUrl}`;
  const html = `<!doctype html><html><body>${mailing.preview ? `<div style="display:none">${escapeHtml(mailing.preview)}</div>` : ''}`
    + `<div>${escapeHtml(body).replace(LINK, (u) => (links.includes(u) ? `<a href="${tracked(u)}">${u}</a>` : u)).replace(/\n/g, '<br>')}</div>`
    + `<p style="font-size:12px;color:#888"><a href="${unsubscribeUrl}">Unsubscribe</a></p>`
    + `<img src="${baseUrl}/api/public/mail/open/${trace.token}" width="1" height="1" alt=""></body></html>`;
  return { to: trace.email, subject: renderTemplate(mailing.subject ?? '', object), text, html, replyTo: mailing.reply_to };
}

/**
 * Run `queue` (which creates traces) and email every new trace; failed deliveries become bounces.
 * @param {(db: object, opts: {now: string, token: () => string}) => object} queue
 * @returns {Promise<{db: object, sent: number, delivered: number}>}
 */
export async function deliver(cfg, db, queue, baseUrl, now = today()) {
  const before = new Set(search(db, 'mailing.trace').map((t) => t.id));
  let next = queue(db, { now, token: randomUUID });
  const fresh = search(next, 'mailing.trace').filter((t) => !before.has(t.id));
  let delivered = 0;
  for (const trace of fresh) {
    try {
      await sendMail(cfg, emailFor(next, read(next, 'mailing.mailing', trace.mailing_id), trace, baseUrl));
      delivered += 1;
    } catch (e) {
      console.warn(`Mailing ${trace.mailing_id}: ${trace.email} failed: ${e.message}`);
      next = markBounced(next, trace.token);
    }
  }
  return { db: next, sent: fresh.length, delivered };
}

/** Public tracking endpoints: /api/public/mail/(open|click|unsubscribe)/<token>[/<link index>]. */
export function trackingResponse(db, path, now = today()) {
  const m = /^\/api\/public\/mail\/(open|click|unsubscribe)\/([^/]+)(?:\/(\d+))?$/.exec(path);
  if (!m || !TOKEN.test(m[2])) return null;
  const [, kind, token, index] = m;
  const trace = search(db, 'mailing.trace').find((t) => t.token === token);
  if (kind === 'open') return { status: 200, headers: { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' }, body: PIXEL, db: trace ? trackEvent(db, token, 'open', { now }) : db };
  if (!trace) return { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'Unknown link' };
  if (kind === 'click') {
    const url = linksOf(read(db, 'mailing.mailing', trace.mailing_id)?.body)[Number(index)];
    if (!url) return { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'Unknown link' };
    return { status: 302, headers: { Location: url, 'Cache-Control': 'no-store' }, body: '', db: trackEvent(db, token, 'click', { now, url }) };
  }
  return {
    status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, db: unsubscribe(db, token),
    body: '<!doctype html><meta charset="utf-8"><title>Unsubscribed</title><p style="font-family:sans-serif">You have been unsubscribed. You will not receive these emails any more.</p>',
  };
}

export const deliverMailing = (cfg, db, mailingId, baseUrl, now) => deliver(cfg, db, (d, opts) => queueMailing(d, read(d, 'mailing.mailing', mailingId), opts), baseUrl, now);
