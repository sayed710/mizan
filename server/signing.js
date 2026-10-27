// External e-signature: each signer opens their private /sign/<request>/<token> link, signs or refuses there,
// and the server records it with the time and IP. Sending and reminders email those links.
import { postNote, read, write } from '../src/orm.js';
import { today } from '../src/models/common.js';
import { nextSigner } from '../src/models/extra.js';
import { refuse, sendRequest, signFields, signersOf, signingLink, verifyToken } from '../src/models/signplus.js';
import { escape, page } from './portal.js';
import { sendMail } from './smtp.js';

const MODEL = 'sign.request';
const partnerOf = (db, s) => read(db, 'res.partner', s.partner_id);

/** The index of the signer whose token this is, or -1. */
export function signerFor(r, token) {
  return signersOf(r).findIndex((_, i) => verifyToken(r, i, token));
}

const mailLinks = async (cfg, db, r, baseUrl, subject, intro, deliver) => {
  const sent = [];
  for (const [i, s] of signersOf(r).entries()) {
    const partner = partnerOf(db, s);
    if (s.signed || !partner?.email) continue;
    const text = `${intro}\n\n${r.name}\n${baseUrl}${signingLink(r, i)}\n\nThis link is personal: do not forward it.\n${db.settings?.company ?? ''}`;
    await deliver(cfg, { to: partner.email, subject, text });
    sent.push(partner.email);
  }
  return sent;
};

/** Send a draft request and email every signer their link; every signer needs an email address. */
export async function sendSignRequest(cfg, db, { id }, baseUrl, deliver = sendMail) {
  const r = read(db, MODEL, Number(id));
  if (!r) throw new Error('Signature request not found');
  const missing = signersOf(r).map((s) => partnerOf(db, s)).filter((p) => !p?.email).map((p) => p?.name ?? 'a signer');
  if (missing.length) throw new Error(`Add an email address for ${missing.join(', ')}`);
  const { db: sent } = sendRequest(db, r);
  const request = read(sent, MODEL, r.id);
  const to = await mailLinks(cfg, sent, request, baseUrl, `${db.settings?.company ?? ''}: please sign ${r.name}`, 'You are asked to sign this document:', deliver);
  return { db: postNote(sent, MODEL, r.id, `Signature request emailed to ${to.join(', ')}`), message: `Sent to ${to.length} signer(s)` };
}

/** Email unsigned signers their link again. */
export async function remindSigners(cfg, db, { id }, baseUrl, deliver = sendMail) {
  const r = read(db, MODEL, Number(id));
  if (r?.state !== 'sent') throw new Error('Only requests waiting for signatures get reminders');
  const to = await mailLinks(cfg, db, r, baseUrl, `Reminder: please sign ${r.name}`, 'This document is still waiting for your signature:', deliver);
  if (!to.length) throw new Error('No unsigned signer has an email address');
  const next = write(db, MODEL, r.id, { last_reminder_date: today() });
  return { db: postNote(next, MODEL, r.id, `Signature reminder emailed to ${to.join(', ')}`), message: `Reminder sent to ${to.length} signer(s)` };
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
  return page(r.name, `<h1>${escape(r.name)}</h1><p>Signer: ${escape(partnerOf(db, signer)?.name ?? '')}</p>${message ? `<p role="status">${escape(message)}</p>` : ''}${status}${forms}`);
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
  const limited = (req, key) => { if (tooMany(`${key}:${clientIp(req)}`)) return true; recordFailure(`${key}:${clientIp(req)}`); return false; };
  return async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const route = /^\/sign\/(\d{1,9})\/([A-Za-z0-9]{16,128})(?:\/(sign|refuse))?$/.exec(url.pathname);
    if (!url.pathname.startsWith('/sign/')) return false;
    if (!route || (req.method === 'GET') === !!route[3] || !['GET', 'POST'].includes(req.method)) return error(res, 404, 'Signing link not found');
    const db = getDb();
    const r = read(db, MODEL, Number(route[1]));
    const index = r ? signerFor(r, route[2]) : -1;
    if (index < 0) {
      if (limited(req, 'signauth')) return error(res, 429, 'Too many requests, try again later');
      return error(res, 404, 'Signing link not found');
    }
    const base = `/sign/${r.id}/${route[2]}`;
    if (req.method === 'GET') return send(res, 200, signPage(db, r, index, base, url.searchParams.get('message')));
    if (limited(req, 'signpost')) return error(res, 429, 'Too many requests, try again later');
    if (req.headers['sec-fetch-site'] === 'cross-site') return error(res, 403, 'Cross-site request refused');
    if (String(req.headers['content-type']).split(';')[0] !== 'application/x-www-form-urlencoded') return error(res, 415, 'Submit the signing form');
    let input;
    try { input = new URLSearchParams((await readRaw(req, 16384)).toString('utf8')); } catch { return error(res, 413, 'Request too large'); }
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
