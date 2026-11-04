// Mass mailing delivery and tracking: personalised emails with tracked links, an open pixel and an unsubscribe link.
import { randomUUID } from 'node:crypto';
import { read, search } from '../src/orm.js';
import { awaitingDelivery, markBounced, markSent, queueMailing, renderTemplate, trackEvent, unsubscribe } from '../src/models/mailing.js';
import { sendMail } from './smtp.js';
import { log } from './log.js';

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
  return { to: trace.email, subject: renderTemplate(mailing.subject ?? '', object), text, html, replyTo: mailing.reply_to, listUnsubscribe: unsubscribeUrl };
}

/**
 * Run `queue` (which creates traces) and email every new trace; failed deliveries become bounces.
 * The queued state is committed before any network I/O (so a second send sees the mailing as sent, and changes
 * made while emails go out, like unsubscribes, are kept); each bounce is then applied to the current db.
 * @param {{get: () => object, commit: (next: object) => void}} store current db and a validated commit
 * @param {(db: object, opts: {now: string, token: () => string}) => object} queue
 * @returns {Promise<{sent: number, delivered: number}>}
 */
export async function deliver(cfg, store, queue, baseUrl, now = today()) {
  const base = store.get();
  const before = new Set(search(base, 'mailing.trace').map((t) => t.id));
  const queued = queue(base, { now, token: randomUUID, queued: true });
  store.commit(queued);
  const fresh = search(queued, 'mailing.trace').filter((t) => !before.has(t.id));
  return { sent: fresh.length, delivered: await sendTraces(cfg, store, fresh, baseUrl) };
}

// Tokens being sent right now, so a resume does not send them a second time.
const inFlight = new Set();

/** Email each queued trace; each success is committed as sent and each failure as a bounce. Returns the delivered count. */
async function sendTraces(cfg, store, traces, baseUrl) {
  let delivered = 0;
  for (const snapshot of traces) {
    const db = store.get();
    const trace = search(db, 'mailing.trace').find((t) => t.token === snapshot.token);
    if (!awaitingDelivery(trace) || inFlight.has(trace.token)) continue;
    inFlight.add(trace.token);
    try {
      try {
        await sendMail(cfg, emailFor(db, read(db, 'mailing.mailing', trace.mailing_id), trace, baseUrl));
      } catch (e) {
        log('warn', 'mailing email failed', { mailingId: trace.mailing_id, traceId: trace.id, error: e.message });
        store.commit(markBounced(store.get(), trace.token));
        continue;
      }
      // SMTP already accepted the message: persistence errors must remain recoverable, not become bounces.
      store.commit(markSent(store.get(), trace.token));
      delivered += 1;
    } finally {
      inFlight.delete(trace.token);
    }
  }
  return delivered;
}

/** Send traces still queued after a crash or restart (at-least-once: one interrupted mid-send may go out twice). */
export const resumeQueued = (cfg, store, baseUrl) => sendTraces(cfg, store, search(store.get(), 'mailing.trace').filter(awaitingDelivery), baseUrl);

/**
 * Public tracking endpoints: /api/public/mail/(open|click|unsubscribe)/<token>[/<link index>].
 * Unsubscribing asks for confirmation on GET and acts on POST, so mail scanners that follow links do not unsubscribe people.
 */
export function trackingResponse(db, path, now = today(), method = 'GET') {
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
  const page = (inner) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Unsubscribe</title><div style="font-family:sans-serif;max-width:480px;margin:40px auto;padding:0 16px">${inner}</div>`;
  if (method !== 'POST') {
    return { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: page(`<p>Stop receiving these emails at <b>${escapeHtml(trace.email)}</b>?</p><form method="post"><button type="submit">Unsubscribe</button></form>`) };
  }
  return { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, db: unsubscribe(db, token), body: page('<p>You have been unsubscribed. You will not receive these emails any more.</p>') };
}

export const deliverMailing = (cfg, store, mailingId, baseUrl, now) => deliver(cfg, store, (d, opts) => queueMailing(d, read(d, 'mailing.mailing', mailingId), opts), baseUrl, now);
