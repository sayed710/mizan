// Email actions: send a business document to its partner, or a mailing to its list.
import { models } from '../src/models/index.js';
import { postNote, read, write } from '../src/orm.js';
import { ConflictError, applyDiff, diffDb } from '../src/sync.js';
import { sendMail } from './smtp.js';
import { deliverMailing } from './mailtrack.js';
import { addressLines, documentCompany, documentTaxBreakdown } from '../src/models/company.js';
import { subtotal } from '../src/models/common.js';

const DOCUMENTS = { 'sale.order': { draft: 'sent' }, 'purchase.order': { draft: 'sent' }, 'account.move': {} };

const docCurrency = (db, rec) => (rec.currency_id && read(db, 'res.currency', rec.currency_id)?.name)
  ?? (read(db, 'res.company', rec.company_id ?? 1)?.currency_id && read(db, 'res.currency', read(db, 'res.company', rec.company_id ?? 1).currency_id)?.name)
  ?? db.settings?.currency ?? 'USD';

const money = (db, rec, n) => {
  const curr = docCurrency(db, rec);
  const num = Number(n) || 0;
  if (typeof curr === 'string' && /^[A-Za-z]{3}$/.test(curr)) {
    try {
      return num.toLocaleString('en-US', { style: 'currency', currency: curr.toUpperCase() });
    } catch { /* fallback */ }
  }
  return `${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${curr ?? ''}`.trim();
};

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

/** Resolve the document's company, or explain what to configure; email content must never guess it from a global setting. */
function emailCompany(db, rec, company) {
  const resolved = company ?? documentCompany(db, rec);
  if (!resolved) throw new Error('Configure the document company before emailing.');
  return resolved;
}

const documentLines = (rec) => rec.order_line ?? rec.invoice_line_ids ?? [];

/** Header values shared by the text and HTML renderings, in display order. */
const documentDetails = (rec) => [
  ['Date', rec.invoice_date ?? rec.date_order],
  ['Due date', rec.invoice_date_due ?? rec.date_planned],
  ['Reference', rec.ref ?? rec.invoice_origin],
].filter(([, value]) => value);

const partnerLabel = (model, rec) => (model === 'purchase.order' || (model === 'account.move' && ['in_invoice', 'in_refund', 'in_receipt'].includes(rec.move_type))) ? 'Vendor' : 'Customer';

/** Plain-text rendering of a document: parties, header, lines, tax breakdown and totals. */
export function documentText(db, model, rec, company = null) {
  const docCompany = emailCompany(db, rec, company);
  const lines = documentLines(rec);
  const product = (id) => read(db, 'product', id)?.name ?? '';
  const partner = read(db, 'res.partner', rec.partner_id);
  const breakdown = documentTaxBreakdown(db, rec, lines);
  return [
    docCompany.name,
    ...addressLines(docCompany),
    '',
    `${models[model].label.replace(/s$/, '')} ${rec.name}`,
    ...(partner ? [`${partnerLabel(model, rec)}: ${partner.name}`, ...addressLines(partner).map((line) => `  ${line}`)] : []),
    ...documentDetails(rec).map(([label, value]) => `${label}: ${value}`),
    '',
    ...lines.map((l) => `- ${product(l.product_id)}  ×${l.qty}  ${money(db, rec, l.price_unit)}  ${money(db, rec, subtotal(l))}`),
    '',
    ...breakdown.map((row) => `${row.label}: base ${money(db, rec, row.base)}, tax ${money(db, rec, row.amount)}`),
    `Total: ${money(db, rec, rec.amount_total)}`,
    rec.amount_residual ? `Amount due: ${money(db, rec, rec.amount_residual)}` : '',
  ].filter((l, i, all) => l !== '' || all[i - 1] !== '').join('\n');
}

/** HTML rendering of the same content, sent as the text/html alternative. */
export function documentHtml(db, model, rec, company = null) {
  const docCompany = emailCompany(db, rec, company);
  const lines = documentLines(rec);
  const product = (id) => read(db, 'product', id)?.name ?? '';
  const partner = read(db, 'res.partner', rec.partner_id);
  const breakdown = documentTaxBreakdown(db, rec, lines);
  const details = documentDetails(rec);
  const address = (record) => addressLines(record).map((line) => `<div>${escapeHtml(line)}</div>`).join('');
  const totals = ['amount_untaxed', 'amount_tax', 'amount_total']
    .filter((field) => rec[field] != null)
    .map((field) => [models[model].fields[field]?.label ?? field, rec[field]]);
  if (rec.amount_residual) totals.push(['Amount due', rec.amount_residual]);
  return `<!doctype html>
<html><body style="font-family:Arial,sans-serif;color:#111">
<header>
<h1 style="margin:0">${escapeHtml(docCompany.name)}</h1>
${address(docCompany)}
</header>
${partner ? `<section><h2 style="margin-bottom:0">${escapeHtml(partner.name)}</h2>${address(partner)}</section>` : ''}
<p><strong>${escapeHtml(models[model].label.replace(/s$/, ''))} ${escapeHtml(rec.name)}</strong></p>
${details.length ? `<dl>${details.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join('')}</dl>` : ''}
<table style="width:100%;border-collapse:collapse" border="1" cellpadding="6">
<thead><tr><th align="left">${escapeHtml('Product')}</th><th align="right">${escapeHtml('Quantity')}</th><th align="right">${escapeHtml('Unit Price')}</th><th align="right">${escapeHtml('Amount')}</th></tr></thead>
<tbody>${lines.map((l) => `<tr><td>${escapeHtml(product(l.product_id))}</td><td align="right">${escapeHtml(l.qty)}</td><td align="right">${escapeHtml(money(db, rec, l.price_unit))}</td><td align="right">${escapeHtml(money(db, rec, subtotal(l)))}</td></tr>`).join('')}</tbody>
</table>
${breakdown.length ? `<table style="width:100%;border-collapse:collapse" border="1" cellpadding="6">
<thead><tr><th align="left">${escapeHtml('Tax')}</th><th align="right">${escapeHtml('Base')}</th><th align="right">${escapeHtml('Amount')}</th></tr></thead>
<tbody>${breakdown.map((row) => `<tr><td>${escapeHtml(row.label)}</td><td align="right">${escapeHtml(money(db, rec, row.base))}</td><td align="right">${escapeHtml(money(db, rec, row.amount))}</td></tr>`).join('')}</tbody>
</table>` : ''}
<table style="margin-left:auto;border-collapse:collapse" cellpadding="6">
<tbody>${totals.map(([label, value]) => `<tr><td>${escapeHtml(label)}</td><td align="right">${escapeHtml(money(db, rec, value))}</td></tr>`).join('')}</tbody>
</table>
</body></html>`;
}

/** The subject and both bodies for a document email, using the document's own company. */
export function documentEmail(db, model, rec, company = null) {
  const docCompany = emailCompany(db, rec, company);
  return {
    subject: `${docCompany.name} — ${rec.name}`,
    text: documentText(db, model, rec, docCompany),
    html: documentHtml(db, model, rec, docCompany),
  };
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
  const company = documentCompany(db, rec);
  if (!company) return { status: 400, body: { error: 'Configure the document company before emailing.' } };
  await sendMail(cfg, { to: partner.email, ...documentEmail(db, model, rec, company) });
  const nextState = DOCUMENTS[model][rec.state];
  let next = nextState ? write(db, model, rec.id, { state: nextState }) : db;
  next = postNote(next, model, rec.id, `Sent by email to ${partner.email}`);
  return { status: 200, body: { ok: true }, db: applyDiff(db, diffDb(db, next), { author: user.name, isAdmin: user.isAdmin }) };
}

/**
 * Store the result of a delivered email. The message is already out, so a concurrent edit of the document must not
 * turn the send into a failure: on a conflict only the "sent" note is recorded and the newer state is kept.
 * @returns {{db: object, notice?: string}}
 */
export function recordSent(current, snapshot, sent, opts) {
  try {
    return { db: applyDiff(current, diffDb(snapshot, sent), opts) };
  } catch (e) {
    if (!(e instanceof ConflictError)) throw e;
    const notesOnly = { ...snapshot, messages: sent.messages };
    return { db: applyDiff(current, diffDb(snapshot, notesOnly), opts), notice: 'The email was sent, but the document changed meanwhile, so its status was left as it is.' };
  }
}

/** Send a mailing now: one tracked email per recipient (see mailtrack.js); `store` commits through normal validation. */
export async function sendMailing(cfg, store, { id }, baseUrl) {
  const mailing = read(store.get(), 'mailing.mailing', Number(id));
  if (!mailing) return { status: 404, body: { error: 'Mailing not found' } };
  if (mailing.state === 'sent') return { status: 400, body: { error: 'Already sent' } };
  try {
    const out = await deliverMailing(cfg, store, mailing.id, baseUrl);
    return { status: 200, body: { ok: true, sent: out.sent, delivered: out.delivered } };
  } catch (e) {
    return { status: 400, body: { error: e.message } };
  }
}
