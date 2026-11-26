// Email actions: send a business document to its partner, or a mailing to its list.
import { models } from '../src/models/index.js';
import { postNote, read, write } from '../src/orm.js';
import { ConflictError, applyDiff, diffDb } from '../src/sync.js';
import { sendMail } from './smtp.js';
import { deliverMailing } from './mailtrack.js';
import { addressLines, documentCompany, documentTaxBreakdown } from '../src/models/company.js';
import { subtotal, today, validDate } from '../src/models/common.js';
import { customerStatement } from '../src/models/reports.js';
import { followUpEmail, followUpLetter, logManualFollowUp, partnerFollowUp } from '../src/models/finance.js';
import { findCompanyCurrencyRecord, formatCurrency } from '../src/money.js';

const DOCUMENTS = { 'sale.order': { draft: 'sent' }, 'purchase.order': { draft: 'sent' }, 'account.move': {} };

const docCurrency = (db, rec) => {
  const company = read(db, 'res.company', rec.company_id ?? 1);
  const currency = read(db, 'res.currency', rec.currency_id ?? company?.currency_id);
  if (!currency) throw new Error('Configure the document or company currency before emailing.');
  return currency.name;
};

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
export async function sendDocument(cfg, db, _user, { model, id }) {
  if (!DOCUMENTS[model]) return { status: 400, body: { error: 'This document cannot be emailed' } };
  const rec = read(db, model, Number(id));
  if (!rec) return { status: 404, body: { error: 'Record not found' } };
  if (model === 'account.move' && rec.state !== 'posted') return { status: 400, body: { error: 'Only posted invoices can be emailed.' } };
  const partner = read(db, 'res.partner', rec.partner_id);
  if (!partner?.email) return { status: 400, body: { error: 'The customer has no email address' } };
  const company = documentCompany(db, rec);
  if (!company) return { status: 400, body: { error: 'Configure the document company before emailing.' } };
  const email = { to: partner.email, ...documentEmail(db, model, rec, company) };
  const nextState = DOCUMENTS[model][rec.state];
  let next = nextState ? write(db, model, rec.id, { state: nextState }) : db;
  if (model === 'account.move' && rec.state === 'posted') next = write(next, model, rec.id, { is_move_sent: true });
  next = postNote(next, model, rec.id, `Sent by email to ${partner.email}`);
  await sendMail(cfg, email);
  return { status: 200, body: { ok: true }, db: next };
}

/** Deliver one company-scoped customer statement using the accounting report calculation. */
export async function sendCustomerStatement(cfg, db, { partnerId, companyId, from, to, reviewMode }, deliver = sendMail) {
  // Input problems are the caller's, not the mail server's: answer 400 with the bare message so the client can translate it.
  const invalid = (error) => ({ status: 400, body: { error } });
  const company = Number(companyId);
  if (!Number.isSafeInteger(company) || !read(db, 'res.company', company)
    || !(db.settings?.allowed_company_ids ?? [db.settings?.current_company_id ?? 1]).includes(company)) {
    return invalid('Configure the document company before emailing.');
  }
  if ((from && !validDate(from)) || !validDate(to) || (from && from > to)) return invalid('Invalid statement period');
  const partner = read(db, 'res.partner', Number(partnerId));
  if (!partner) return invalid('Record not found');
  if (!partner.email?.trim()) return invalid('The customer has no email address');
  const statementDb = (db.settings?.current_company_id ?? 1) === company ? db : { ...db, settings: { ...db.settings, current_company_id: company } };
  const currency = findCompanyCurrencyRecord(statementDb, company);
  if (!currency) return invalid('Configure the document or company currency before emailing.');
  const docCompany = documentCompany(statementDb, { company_id: company });
  if (!docCompany) return invalid('Configure the document company before emailing.');
  const report = customerStatement(statementDb, partner.id, { from, to, company_id: company, reviewMode: reviewMode === 'all' ? 'all' : 'posted' });
  const amount = (value) => formatCurrency(value, currency);
  const rows = report.lines.map((line) => [line.date, line.move_name, line.ref ?? '', amount(line.debit), amount(line.credit), amount(line.balance)]);
  const headings = ['Date', 'Journal Entry', 'Reference', 'Debit', 'Credit', 'Balance'];
  const header = [docCompany.name, partner.name, 'Customer Statement', `${from || ''} – ${to}`];
  const opening = `Opening Balance: ${amount(report.opening)}`;
  const closing = `Closing Balance: ${amount(report.closing)}`;
  const text = [...header, opening, headings.join(' | '), ...rows.map((row) => row.join(' | ')), closing].join('\n');
  const html = `<h1>${escapeHtml(docCompany.name)}</h1><h2>${escapeHtml(partner.name)} – Customer Statement</h2><p>${escapeHtml(header[3])}</p><p>${escapeHtml(opening)}</p><table border="1"><thead><tr>${headings.map((value) => `<th>${escapeHtml(value)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((value) => `<td>${escapeHtml(value)}</td>`).join('')}</tr>`).join('')}</tbody></table><p>${escapeHtml(closing)}</p>`;
  await deliver(cfg, { to: partner.email.trim(), subject: `${docCompany.name} – Customer Statement`, text, html });
  return { status: 200, body: { ok: true } };
}

/** Send a follow-up and persist its existing manual reminder transition after delivery. */
export async function sendFollowUp(cfg, db, user, { partnerId, companyId, at = today(), joinInvoices }, deliver = sendMail, writeOptions = { author: user.name, isAdmin: user.isAdmin }) {
  if (!validDate(at)) throw new Error('Enter a valid As of Date');
  const partner = read(db, 'res.partner', Number(partnerId));
  if (!partner?.email?.trim()) throw new Error('A customer email address is required to send an email reminder');
  const company = Number(companyId);
  const letter = followUpLetter(db, partner.id, company, at);
  const next = logManualFollowUp(db, partner.id, at, { companyId: company, channel: 'email', ignoreNextActionDate: true });
  const amount = (n, currency) => `${formatCurrency(n, currency, '')} ${currency.name}`;
  const rows = letter.invoices.map((m) => [m.name, m.invoice_date ?? '', m.invoice_date_due ?? '', amount(m.amount_residual, m.followup_currency), m.overdue ? 'Overdue' : '']);
  const totals = (list) => list.map(({ amount: value, currency }) => amount(value, currency)).join(', ') || '0';
  const headers = ['Invoice', 'Invoice Date', 'Due Date', 'Residual', 'Overdue'];
  const base = followUpEmail(db, letter.reminder, letter.level, partner, { joinInvoices });
  const text = `${base.text}\n\n${headers.join(' | ')}\n${rows.map((row) => row.join(' | ')).join('\n')}\nTotal Due: ${totals(letter.due)}\nTotal Overdue: ${totals(letter.overdue)}`;
  const html = `<p style="white-space:pre-line">${escapeHtml(base.text)}</p><table border="1"><thead><tr>${headers.map((v) => `<th>${escapeHtml(v)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((v) => `<td>${escapeHtml(v)}</td>`).join('')}</tr>`).join('')}</tbody></table><p>Total Due: ${escapeHtml(totals(letter.due))}<br>Total Overdue: ${escapeHtml(totals(letter.overdue))}</p>`;
  const attachments = base.joinInvoices
    ? (base.invoiceIds ?? [])
      .map((invId) => read(db, 'account.move', invId))
      .filter((inv) => inv && documentCompany(db, inv))
      .map((inv) => ({
        filename: `${String(inv.name || `invoice-${inv.id}`).replace(/[^A-Za-z0-9._-]+/g, '_')}.html`,
        contentType: 'text/html; charset=utf-8',
        content: documentHtml(db, 'account.move', inv),
      }))
    : [];
  const validated = applyDiff(db, diffDb(db, next), writeOptions);
  await deliver(cfg, { ...base, text, html, ...(attachments.length ? { attachments } : {}) });
  return {
    status: 200,
    body: { ok: true },
    db: validated,
    reconcile: (current, snapshot, sent, opts) => reconcileFollowUp(current, snapshot, sent, opts, partner.id, company),
  };
}

/**
 * Reconcile follow-up bookkeeping into fresh db on concurrent send conflict.
 */
export function reconcileFollowUp(current, snapshot, sent, opts, partnerId, companyId) {
  const snapshotMsgs = snapshot.messages ?? [];
  const sentMsgs = sent.messages ?? [];
  const newMessages = sentMsgs.slice(snapshotMsgs.length);

  const snapshotActs = new Set((snapshot.records?.['mail.activity'] ?? []).map((a) => a.id));
  const newActivities = (sent.records?.['mail.activity'] ?? []).filter((a) => !snapshotActs.has(a.id));

  const freshPartner = read(current, 'res.partner', partnerId);
  const originalPartner = read(snapshot, 'res.partner', partnerId);
  const sentPartner = read(sent, 'res.partner', partnerId);
  const sentLine = sentPartner ? partnerFollowUp(sentPartner, companyId) : null;

  if (!freshPartner) {
    const notesOnly = { ...current, messages: [...(current.messages ?? []), ...newMessages] };
    const saved = applyDiff(current, diffDb(current, notesOnly), opts);
    return {
      db: saved,
      notice: 'The email was sent, but the contact was deleted meanwhile, so partner follow-up progression could not be recorded.',
    };
  }

  const originalLine = originalPartner ? partnerFollowUp(originalPartner, companyId) : null;
  const currentLine = partnerFollowUp(freshPartner, companyId);
  if (JSON.stringify(currentLine ?? null) !== JSON.stringify(originalLine ?? null)) {
    const notesOnly = { ...current, messages: [...(current.messages ?? []), ...newMessages] };
    return {
      db: applyDiff(current, diffDb(current, notesOnly), opts),
      notice: 'The email was sent, but the company follow-up changed meanwhile, so progression could not be recorded.',
    };
  }

  const currentActivities = current.records?.['mail.activity'] ?? [];
  const usedIds = new Set(currentActivities.map((activity) => activity.id));
  let nextActivityId = Math.max(current.seq?.['mail.activity'] ?? 0, ...usedIds, 0);
  const incomingActivities = newActivities.map((activity) => {
    let id = activity.id;
    if (usedIds.has(id)) {
      do { id = ++nextActivityId; } while (usedIds.has(id));
    }
    usedIds.add(id);
    return id === activity.id ? activity : { ...activity, id };
  });

  const existingLines = (freshPartner.followup_lines ?? []).filter((l) => l.company_id !== companyId);
  const updatedLines = sentLine ? [...existingLines, sentLine] : existingLines;
  const updatedPartner = {
    ...freshPartner,
    followup_lines: updatedLines,
  };

  const reconciled = {
    ...current,
    records: {
      ...current.records,
      'res.partner': (current.records?.['res.partner'] ?? []).map((p) => (p.id === partnerId ? updatedPartner : p)),
      ...(incomingActivities.length ? {
        'mail.activity': [...currentActivities, ...incomingActivities],
      } : {}),
    },
    messages: [...(current.messages ?? []), ...newMessages],
  };

  try {
    const diff = diffDb(current, reconciled);
    const saved = applyDiff(current, diff, opts);
    return { db: saved };
  } catch (err) {
    const notesOnly = { ...current, messages: [...(current.messages ?? []), ...newMessages] };
    const fallback = applyDiff(current, diffDb(current, notesOnly), opts);
    return {
      db: fallback,
      notice: `The email was sent, but concurrent edits prevented recording follow-up progression: ${err.message}`,
    };
  }
}

/**
 * Store the result of a delivered email. The message is already out, so a concurrent edit of the document must not
 * turn the send into a failure: on a conflict only the "sent" note is recorded and the newer state is kept.
 * @returns {{db: object, notice?: string}}
 */
export function recordSent(current, snapshot, sent, opts, { document = null, reconcile = null } = {}) {
  const diff = diffDb(snapshot, sent);
  const original = document?.model === 'account.move' ? read(snapshot, document.model, Number(document.id)) : null;
  if (original?.state === 'posted') {
    const rows = (diff.upserts['account.move'] ??= []);
    if (!rows.some((row) => row.id === original.id)) rows.push(read(sent, 'account.move', original.id));
    const base = ((diff.bases['account.move'] ??= {})[original.id] ??= {});
    base.state = original.state;
    base.is_move_sent = original.is_move_sent ?? null;
  }
  try {
    return { db: applyDiff(current, diff, opts) };
  } catch (e) {
    if (!(e instanceof ConflictError)) throw e;
    if (typeof reconcile === 'function') {
      return reconcile(current, snapshot, sent, opts, e);
    }
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
