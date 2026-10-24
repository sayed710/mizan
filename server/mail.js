// Email actions: send a business document to its partner, or a mailing to its list.
import { models } from '../src/models/index.js';
import { postNote, read, search, write } from '../src/orm.js';
import { applyDiff, diffDb } from '../src/sync.js';
import { sendMail } from './smtp.js';

const DOCUMENTS = { 'sale.order': { draft: 'sent' }, 'purchase.order': { draft: 'sent' }, 'account.move': {} };
const MAX_RECIPIENTS = 500;

const money = (db, n) => (Number(n) || 0).toLocaleString('en-US', { style: 'currency', currency: db.settings?.currency ?? 'USD' });

/** Plain-text rendering of a document: header, lines, totals. */
function documentText(db, model, rec) {
  const lines = rec.order_line ?? rec.invoice_line_ids ?? [];
  const product = (id) => read(db, 'product', id)?.name ?? '';
  return [
    `${db.settings?.company ?? ''}`,
    '',
    `${models[model].label.replace(/s$/, '')} ${rec.name}`,
    '',
    ...lines.map((l) => `- ${product(l.product_id)}  ×${l.qty}  ${money(db, l.price_unit)}`),
    '',
    `Total: ${money(db, rec.amount_total)}`,
    rec.amount_residual ? `Amount due: ${money(db, rec.amount_residual)}` : '',
  ].filter((l, i, all) => l !== '' || all[i - 1] !== '').join('\n');
}

/**
 * @returns {Promise<{status: number, body: object, db?: object}>}
 */
export async function sendDocument(cfg, db, user, { model, id }) {
  if (!DOCUMENTS[model]) return { status: 400, body: { error: 'This document cannot be emailed' } };
  const rec = read(db, model, Number(id));
  if (!rec) return { status: 404, body: { error: 'Record not found' } };
  const partner = read(db, 'res.partner', rec.partner_id);
  if (!partner?.email) return { status: 400, body: { error: 'The customer has no email address' } };
  await sendMail(cfg, { to: partner.email, subject: `${db.settings?.company ?? ''} — ${rec.name}`, text: documentText(db, model, rec) });
  const nextState = DOCUMENTS[model][rec.state];
  let next = nextState ? write(db, model, rec.id, { state: nextState }) : db;
  next = postNote(next, model, rec.id, `Sent by email to ${partner.email}`);
  return { status: 200, body: { ok: true }, db: applyDiff(db, diffDb(db, next), { author: user.name, isAdmin: user.isAdmin }) };
}

export async function sendMailing(cfg, db, user, { id }) {
  const mailing = read(db, 'mailing.mailing', Number(id));
  if (!mailing) return { status: 404, body: { error: 'Mailing not found' } };
  if (mailing.state === 'sent') return { status: 400, body: { error: 'Already sent' } };
  const recipients = search(db, 'mailing.contact').filter((c) => c.list_id === mailing.list_id && !c.opt_out && c.email).slice(0, MAX_RECIPIENTS);
  if (!recipients.length) return { status: 400, body: { error: 'The mailing list has no subscribed recipients' } };
  let delivered = 0;
  for (const c of recipients) {
    try {
      await sendMail(cfg, { to: c.email, subject: mailing.subject, text: `Hello ${c.name},\n\n${mailing.body ?? ''}` });
      delivered += 1;
    } catch (e) {
      console.warn(`Mailing ${mailing.id}: ${c.email} failed: ${e.message}`);
    }
  }
  const next = write(db, 'mailing.mailing', mailing.id, { state: 'sent', sent_date: new Date().toISOString().slice(0, 10), sent: recipients.length, delivered });
  return { status: 200, body: { ok: true, sent: recipients.length, delivered }, db: applyDiff(db, diffDb(db, next), { author: user.name, isAdmin: user.isAdmin }) };
}
