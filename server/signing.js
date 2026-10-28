// External e-signature: each signer opens their private /sign/<request>/<token> link, signs or refuses there,
// and the server records it with the time and IP. Sending and reminders email those links.
import { postNote, read, write } from '../src/orm.js';
import { today } from '../src/models/common.js';
import { nextSigner } from '../src/models/extra.js';
import { refuse, sendRequest, signFields, signersOf, signingLink, verifyToken } from '../src/models/signplus.js';
import { escape, page } from './portal.js';
import { sendMail } from './smtp.js';

const MODEL = 'sign.request';

/**
 * The address signing links are built on. Links carry private tokens, so it comes from MIZAN_PUBLIC_URL only: a
 * crafted Host header must never decide where signers are sent.
 */
export function publicOrigin(env = process.env) {
  let url;
  try { url = new URL(env.MIZAN_PUBLIC_URL ?? ''); } catch { /* reported below */ }
  if (!url || !['http:', 'https:'].includes(url.protocol)) throw new Error('Set MIZAN_PUBLIC_URL (the address signers open, e.g. https://erp.example.com) before emailing signing links');
  return `${url.origin}${url.pathname.replace(/\/$/, '')}`;
}
const partnerOf = (db, s) => read(db, 'res.partner', s.partner_id);

/** The index of the signer whose token this is, or -1. */
export function signerFor(r, token) {
  return signersOf(r).findIndex((_, i) => verifyToken(r, i, token));
}

/** Email every unsigned signer with an address; one failing mailbox does not stop the others. */
const mailLinks = async (cfg, db, r, baseUrl, subject, intro, deliver) => {
  const to = [];
  const failed = [];
  for (const [i, s] of signersOf(r).entries()) {
    const partner = partnerOf(db, s);
    if (s.signed || !partner?.email) continue;
    const text = `${intro}\n\n${r.name}\n${baseUrl}${signingLink(r, i)}\n\nThis link is personal: do not forward it.\n${db.settings?.company ?? ''}`;
    try {
      await deliver(cfg, { to: partner.email, subject, text });
      to.push(partner.email);
    } catch (e) {
      failed.push(`${partner.email} (${e.message})`);
    }
  }
  return { to, failed };
};

/**
 * Send a draft request and email every signer their link; every signer needs an email address. The sent state and the
 * tokens are saved before any email goes out, so a link that was emailed always works, and the outcome is recorded
 * against the current request, not a snapshot taken before the (slow) SMTP calls.
 * @param {{get: () => object, commit: (next: object) => void}} store
 */
export async function sendSignRequest(cfg, store, { id }, baseUrl, deliver = sendMail) {
  const db = store.get();
  const r = read(db, MODEL, Number(id));
  if (!r) throw new Error('Signature request not found');
  const missing = signersOf(r).map((s) => partnerOf(db, s)).filter((p) => !p?.email).map((p) => p?.name ?? 'a signer');
  if (missing.length) throw new Error(`Add an email address for ${missing.join(', ')}`);
  store.commit(sendRequest(db, r).db);
  const live = store.get();
  const { to, failed } = await mailLinks(cfg, live, read(live, MODEL, r.id), baseUrl, `${live.settings?.company ?? ''}: please sign ${r.name}`, 'You are asked to sign this document:', deliver);
  store.commit(postNote(store.get(), MODEL, r.id, `Signature request emailed to ${to.join(', ') || 'nobody'}${failed.length ? `; could not email ${failed.join(', ')}` : ''}`));
  if (failed.length) throw new Error(`The request is sent, but ${failed.length} email(s) failed: ${failed.join(', ')}. Use Send Reminder to try again.`);
  return { message: `Sent to ${to.length} signer(s)` };
}

/** Email unsigned signers their link again (not once the deadline has passed: nobody can sign then). */
export async function remindSigners(cfg, store, { id }, baseUrl, deliver = sendMail) {
  const db = store.get();
  const r = read(db, MODEL, Number(id));
  if (r?.state !== 'sent') throw new Error('Only requests waiting for signatures get reminders');
  if (r.deadline && r.deadline < today()) throw new Error('The signature deadline has passed; extend it before sending reminders');
  const { to, failed } = await mailLinks(cfg, db, r, baseUrl, `Reminder: please sign ${r.name}`, 'This document is still waiting for your signature:', deliver);
  if (!to.length && !failed.length) throw new Error('No unsigned signer has an email address');
  const note = `Signature reminder emailed to ${to.join(', ') || 'nobody'}${failed.length ? `; could not email ${failed.join(', ')}` : ''}`;
  store.commit(postNote(write(store.get(), MODEL, r.id, to.length ? { last_reminder_date: today() } : {}), MODEL, r.id, note));
  if (failed.length) throw new Error(`${failed.length} reminder(s) failed: ${failed.join(', ')}`);
  return { message: `Reminder sent to ${to.length} signer(s)` };
}

/** The request's fields for one signer, with their index; signature and name fields take the typed name. */
const fieldsOf = (db, r, index) => (r.item_ids ?? read(db, 'sign.template', r.template_id)?.item_ids ?? [])
  .map((item, i) => ({ ...item, i })).filter((item) => item.role === signersOf(r)[index].role);
const TYPED = ['signature', 'name'];

function signPage(db, r, index, base, message) {
  const signer = signersOf(r)[index];
  const items = fieldsOf(db, r, index).filter((item) => !TYPED.includes(item.type));
  const turn = r.signing_order === false || nextSigner(r) === index;
  const open = r.state === 'sent' && !signer.signed && (!r.deadline || r.deadline >= today());
  const input = (item) => {
    const name = `item_${item.i}`;
    const label = `${escape(item.type)} (field ${item.i + 1})${item.required ? ' *' : ''}`;
    if (item.type === 'checkbox') return `<label><input type="checkbox" name="${name}" value="true"> ${label}</label>`;
    const type = { date: 'date', email: 'email' }[item.type] ?? 'text';
    return `<label>${label}<br><input type="${type}" name="${name}" maxlength="200"${item.required ? ' required' : ''}></label>`;
  };
  const status = signer.signed ? `<p>Signed by ${escape(signer.signature)} on ${escape(signer.sign_date)}.</p>`
    : !open ? '<p>This request is no longer open for signing.</p>'
    : !turn ? '<p>Another signer signs first; open this link again once they have.</p>' : '';
  const forms = open && turn ? `
    <form method="post" action="${escape(base)}/sign">
      <label>Your full name *<br><input name="name" maxlength="120" required autocomplete="name"></label>
      ${items.map(input).join('')}
      <label><input type="checkbox" name="agree" value="1" required> I agree that typing my name is my electronic signature.</label>
      <button type="submit">Sign</button>
    </form>
    <form method="post" action="${escape(base)}/refuse">
      <label>Reason for refusing<br><input name="reason" maxlength="500" required></label>
      <button type="submit">Refuse to sign</button>
    </form>` : '';
  const file = r.attachment ?? read(db, 'sign.template', r.template_id)?.attachment;
  const attachment = file?.data ? `<p><a href="${escape(base)}/document" target="_blank" rel="noopener">View the attached document (${escape(file.name)})</a></p>` : '';
  const content = r.body ? `<div style="white-space:pre-wrap;border:1px solid #ccc;padding:12px;margin:12px 0">${escape(r.body)}</div>` : '';
  return page(r.name, `<h1>${escape(r.name)}</h1><p>Signer: ${escape(partnerOf(db, signer)?.name ?? '')}</p>${content}${attachment}${message ? `<p role="status">${escape(message)}</p>` : ''}${status}${forms}`);
}

/** Values from the signing form, typed per field. */
const valuesFrom = (input) => Object.fromEntries([...input.keys()].filter((k) => /^item_\d{1,4}$/.test(k))
  .map((k) => [k.slice(5), input.get(k) === 'true' ? true : input.get(k)]));

/** Mountable /sign routes, sharing the portal's protections (rate limit, same-origin POST, size limit). */
export function createSigning({ getDb, commitDb, clientIp, tooMany, recordFailure, readRaw, securityHeaders }) {
  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { ...securityHeaders, 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', 'Content-Type': 'text/html; charset=utf-8', ...headers });
    res.end(body);
    return true;
  };
  const error = (res, status, text) => send(res, status, page(text, `<h1>${escape(text)}</h1>`));
  /** The attachment, only for a holder of a valid link; browsers may display PDFs and images, anything else downloads. */
  const sendDocument = (res, r, db) => {
    const file = r.attachment ?? read(db, 'sign.template', r.template_id)?.attachment;
    const m = /^data:([\w.+/-]*)(;base64)?,(.*)$/s.exec(file?.data ?? '');
    if (!m) return error(res, 404, 'No document attached');
    const body = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]));
    const inline = ['application/pdf', 'image/png', 'image/jpeg', 'image/gif'].includes(m[1]);
    res.writeHead(200, {
      ...securityHeaders, 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox", 'Content-Type': inline ? m[1] : 'application/octet-stream',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${String(file.name ?? 'document').replace(/[^\w. -]/g, '_').slice(0, 100)}"`,
    });
    res.end(body);
    return true;
  };
  const limited = (req, key) => { if (tooMany(`${key}:${clientIp(req)}`)) return true; recordFailure(`${key}:${clientIp(req)}`); return false; };
  return async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const route = /^\/sign\/(\d{1,9})\/([A-Za-z0-9]{16,128})(?:\/(sign|refuse|document))?$/.exec(url.pathname);
    if (!url.pathname.startsWith('/sign/')) return false;
    // GET shows the page (or the document); POST only submits sign or refuse.
    const wanted = route && (route[3] === 'sign' || route[3] === 'refuse') ? 'POST' : 'GET';
    if (!route || req.method !== wanted) return error(res, 404, 'Signing link not found');
    const first = getDb();
    const found = read(first, MODEL, Number(route[1]));
    const check = found ? signerFor(found, route[2]) : -1;
    if (check < 0) {
      if (limited(req, 'signauth')) return error(res, 429, 'Too many requests, try again later');
      return error(res, 404, 'Signing link not found');
    }
    const base = `/sign/${found.id}/${route[2]}`;
    if (route[3] === 'document') return sendDocument(res, found, first);
    if (req.method === 'GET') return send(res, 200, signPage(first, found, check, base, url.searchParams.get('message')));
    if (limited(req, 'signpost')) return error(res, 429, 'Too many requests, try again later');
    if (req.headers['sec-fetch-site'] === 'cross-site') return error(res, 403, 'Cross-site request refused');
    if (String(req.headers['content-type']).split(';')[0] !== 'application/x-www-form-urlencoded') return error(res, 415, 'Submit the signing form');
    let input;
    try { input = new URLSearchParams((await readRaw(req, 16384)).toString('utf8')); } catch { return error(res, 413, 'Request too large'); }
    // The body may have taken a while: judge and change the request as it is now, not as it was when the request began.
    const db = getDb();
    const r = read(db, MODEL, Number(route[1]));
    const index = r ? signerFor(r, route[2]) : -1;
    if (index < 0) return error(res, 404, 'Signing link not found');
    const who = `${partnerOf(db, signersOf(r)[index])?.name ?? `Signer ${index + 1}`}`;
    let message;
    try {
      if (route[3] === 'sign') {
        const name = String(input.get('name') ?? '').trim();
        if (!name || name.length > 120 || input.get('agree') !== '1') throw new Error('Type your full name and accept the electronic signature');
        const values = valuesFrom(input);
        for (const item of fieldsOf(db, r, index)) if (TYPED.includes(item.type)) values[item.i] = name;
        const signed = signFields(db, r, index, values, name);
        commitDb(postNote(signed, MODEL, r.id, `${who} signed as "${name}" through their signing link (IP ${clientIp(req)})`));
        message = 'Thank you, your signature is recorded';
      } else {
        const refused = refuse(db, r, index, String(input.get('reason') ?? '').slice(0, 500));
        commitDb(postNote(refused, MODEL, r.id, `${who} refused through their signing link (IP ${clientIp(req)})`));
        message = 'Your refusal is recorded';
      }
    } catch (e) { message = e.message; }
    return send(res, 303, '', { Location: `${base}?message=${encodeURIComponent(message)}` });
  };
}
