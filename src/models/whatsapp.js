// WhatsApp: message templates reviewed before use, a message log per phone and the 24-hour customer-service window.
import { models } from '../registry.js';
import { create, postNote, read, search, write } from '../orm.js';
import { t } from '../i18n.js';

const MAX_BODY = 1024;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const RANK = { queued: 0, sent: 1, delivered: 2, read: 3 };
const DOC_MODELS = [['res.partner', 'Contact'], ['sale.order', 'Sales Order'], ['account.move', 'Invoice']];
const CONTENT = ['name', 'language', 'category', 'model', 'header', 'body', 'footer', 'variables'];

/** E.164 digits without '+' (a leading 00 counts as '+'), or '' when it is not an international number. */
export function whatsappPhone(raw) {
  const s = String(raw ?? '').trim();
  const intl = s.startsWith('+') || s.startsWith('00');
  const d = s.replace(/\D/g, '').replace(/^00/, '');
  return intl && /^[1-9]\d{7,14}$/.test(d) ? d : '';
}

/** Value at a dotted field path ('partner_id.name'): each many2one step reads the related record. */
function valueAt(db, model, rec, path) {
  const [head, ...rest] = path.split('.');
  const field = models[model]?.fields[head];
  const value = rec?.[head];
  if (!rest.length) return field && ['float', 'monetary'].includes(field.type) && typeof value === 'number' ? value.toFixed(2) : value;
  if (field?.type !== 'many2one' || value == null) return undefined;
  return valueAt(db, field.relation, read(db, field.relation, value), rest.join('.'));
}

/** Template text with {{n}} filled from the variables' field paths; throws on a missing value. */
export function renderWhatsApp(db, template, record) {
  const vars = new Map((template.variables ?? []).map((v) => [Number(v.index), String(v.field ?? '').trim()]));
  const values = [];
  const body = String(template.body ?? '').replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n) => {
    const path = vars.get(Number(n));
    const value = path ? valueAt(db, template.model, record, path) : undefined;
    if (value == null || value === '') throw new Error(`No value for {{${n}}}${path ? ` (${path})` : ''}`);
    values[Number(n) - 1] = String(value);
    return String(value);
  });
  return { body: body.slice(0, MAX_BODY), values: values.filter((v) => v !== undefined) };
}

/** True while the last incoming message from `phone` is less than 24 hours old. */
export function canSendFreeText(db, phone, now = new Date().toISOString()) {
  const p = whatsappPhone(`+${String(phone ?? '').replace(/^\+/, '')}`);
  const last = search(db, 'whatsapp.message').filter((m) => m.direction === 'incoming' && m.phone === p).map((m) => Date.parse(m.date)).sort((a, b) => b - a)[0];
  return Number.isFinite(last) && Date.parse(now) - last < WINDOW_MS;
}

const partnerOf = (db, model, rec) => (model === 'res.partner' ? rec : read(db, 'res.partner', rec.partner_id));

/** Document a reply to a message goes to: its document, else its contact. */
export const replyTarget = (msg) => (msg.res_model && msg.res_id ? { model: msg.res_model, id: msg.res_id } : { model: 'res.partner', id: msg.partner_id });

/**
 * Queue an outgoing message for a document: an approved template of that document model, or free text inside the
 * 24-hour window. Adds a chatter note on the document. @returns {{db: object, id: number}}
 */
export function queueWhatsApp(db, { templateId = null, text = '', model, id, now = new Date().toISOString() }) {
  const rec = models[model] && read(db, model, Number(id));
  if (!rec) throw new Error('Document not found');
  const partner = partnerOf(db, model, rec);
  const phone = whatsappPhone(partner?.mobile || partner?.phone);
  if (!phone) throw new Error('The contact has no international phone number (e.g. +20 100 123 4567)');
  let body = String(text ?? '').trim();
  const template = templateId ? read(db, 'whatsapp.template', Number(templateId)) : null;
  if (templateId) {
    if (template?.status !== 'approved') throw new Error('The WhatsApp template is not approved');
    if (template.model !== model) throw new Error('This template is not for this kind of document');
    body = renderWhatsApp(db, template, rec).body;
  } else {
    if (!body) throw new Error('Write a message first');
    if (!canSendFreeText(db, phone, now)) throw new Error('More than 24 hours since the customer\'s last message: use an approved template');
  }
  const res = create(db, 'whatsapp.message', {
    partner_id: partner.id, phone, body: body.slice(0, 4096), direction: 'outgoing', template_id: template?.id ?? null,
    state: 'queued', res_model: model, res_id: rec.id, date: now,
  });
  return { db: postNote(res.db, model, rec.id, `WhatsApp to +${phone}: ${body.slice(0, 200)}`), id: res.id };
}

/** Record the API answer for a queued message: sent with its WhatsApp id, or failed with the error. */
export function markWhatsApp(db, id, { waMessageId = '', error = '' } = {}) {
  return write(db, 'whatsapp.message', id, error ? { state: 'failed', error: String(error).slice(0, 500) } : { state: 'sent', wa_message_id: String(waMessageId) });
}

/** Delivery report: states only move forward (sent < delivered < read); failed is accepted from any state. */
export function applyStatus(db, waMessageId, status, { error = '' } = {}) {
  const msg = waMessageId && search(db, 'whatsapp.message').find((m) => m.wa_message_id === String(waMessageId));
  if (!msg) return db;
  if (status === 'failed') return msg.state === 'failed' ? db : write(db, 'whatsapp.message', msg.id, { state: 'failed', error: String(error || 'Failed').slice(0, 500) });
  if (!(status in RANK) || !(msg.state in RANK) || RANK[status] <= RANK[msg.state]) return db;
  return write(db, 'whatsapp.message', msg.id, { state: status });
}

/** Store an incoming message once (by its WhatsApp id), linked to the contact with that phone if there is one. */
export function receiveMessage(db, { from, text, id, timestamp }) {
  if (!id || search(db, 'whatsapp.message').some((m) => m.wa_message_id === String(id))) return db;
  const phone = whatsappPhone(`+${String(from ?? '').replace(/^\+/, '')}`);
  if (!phone) return db;
  const partner = search(db, 'res.partner').find((p) => whatsappPhone(p.mobile) === phone || whatsappPhone(p.phone) === phone);
  const at = Number(timestamp) > 0 ? new Date(Number(timestamp) * 1000) : new Date();
  return create(db, 'whatsapp.message', {
    partner_id: partner?.id ?? null, phone, body: String(text ?? '').slice(0, 4096), direction: 'incoming', state: 'received',
    wa_message_id: String(id), res_model: partner ? 'res.partner' : '', res_id: partner?.id ?? null, date: at.toISOString(),
  }).db;
}

/** Templates are reviewed by administrators; once submitted their content is frozen for everyone else. */
function templateGuard(db, before, after, ctx) {
  if (ctx?.isAdmin !== false) return null;
  const from = before?.status ?? 'draft';
  if (after.status !== from && ['approved', 'rejected'].includes(after.status)) return 'Only administrators can approve or reject WhatsApp templates';
  if (before && from !== 'draft' && CONTENT.some((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))) return 'Submitted templates cannot be edited';
  return null;
}

const STATUS = [['draft', 'Draft'], ['pending', 'Pending'], ['approved', 'Approved'], ['rejected', 'Rejected']];
const STATES = [['queued', 'Queued'], ['sent', 'Sent'], ['delivered', 'Delivered'], ['read', 'Read'], ['failed', 'Failed'], ['received', 'Received']];

export const whatsappModels = {
  'whatsapp.template': {
    label: 'WhatsApp Templates',
    fields: {
      name: { type: 'char', label: 'Name', required: true },
      language: { type: 'char', label: 'Language' },
      category: { type: 'selection', label: 'Category', options: [['utility', 'Utility'], ['marketing', 'Marketing'], ['authentication', 'Authentication']] },
      model: { type: 'selection', label: 'Applies to', required: true, options: DOC_MODELS },
      header: { type: 'char', label: 'Header' },
      body: { type: 'text', label: 'Body', required: true },
      footer: { type: 'char', label: 'Footer' },
      variables: {
        type: 'one2many', label: 'Variables',
        fields: { index: { type: 'integer', label: 'Placeholder' }, field: { type: 'char', label: 'Field' } },
        newLine: () => ({ index: 1, field: '' }),
      },
      status: { type: 'selection', label: 'Status', tracking: true, options: STATUS },
    },
    defaults: () => ({ language: 'en', category: 'utility', model: 'res.partner', status: 'draft', variables: [] }),
    guard: templateGuard,
    groupBys: ['status', 'model', 'category'],
    kanban: { groupBy: 'status', title: 'name', lines: ['model', 'category', 'language'] },
    list: ['name', 'model', 'category', 'language', 'status'],
    form: {
      statusbar: 'status',
      lockedWhen: (r) => r.status !== 'draft',
      title: 'name',
      buttons: [
        { label: 'Submit for Approval', primary: true, when: (r) => r.status === 'draft', vals: { status: 'pending' } },
        { label: 'Approve', primary: true, admin: true, when: (r) => r.status === 'pending', vals: { status: 'approved' } },
        { label: 'Reject', admin: true, when: (r) => r.status === 'pending', vals: { status: 'rejected' } },
        { label: 'Reset to Draft', when: (r) => r.status === 'rejected', vals: { status: 'draft' } },
      ],
      groups: [['model', 'category', 'language'], ['header', 'footer']],
      tabs: [{ label: 'Body', fields: ['body'] }, { label: 'Variables', fields: ['variables'] }],
      chatter: true,
    },
  },

  'whatsapp.message': {
    label: 'WhatsApp Messages',
    fields: {
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Contact' },
      phone: { type: 'char', label: 'Phone', required: true },
      body: { type: 'text', label: 'Message' },
      direction: { type: 'selection', label: 'Direction', options: [['outgoing', 'Outgoing'], ['incoming', 'Incoming']] },
      template_id: { type: 'many2one', relation: 'whatsapp.template', label: 'Template' },
      state: { type: 'selection', label: 'Status', options: STATES },
      error: { type: 'char', label: 'Error', readonly: true },
      wa_message_id: { type: 'char', label: 'WhatsApp ID', readonly: true },
      res_model: { type: 'char', label: 'Document Model', readonly: true },
      res_id: { type: 'integer', label: 'Document ID', readonly: true },
      date: { type: 'char', label: 'Date', readonly: true },
    },
    defaults: () => ({ direction: 'outgoing', state: 'queued', date: new Date().toISOString() }),
    groupBys: ['phone', 'partner_id', 'direction', 'state'],
    views: ['list', 'kanban'],
    kanban: { title: 'phone', lines: ['partner_id', 'body', 'date'], badge: 'state' },
    list: ['date', 'partner_id', 'phone', 'direction', 'body', 'state'],
    form: {
      lockedWhen: () => true,
      title: 'phone',
      buttons: [
        {
          label: 'Reply', primary: true, server: '/api/integrations/whatsapp', requires: 'whatsapp', prompt: 'Reply',
          when: (r) => r.partner_id || r.res_id,
          run: (db, r) => {
            const text = prompt(t('Reply'), '');
            if (text == null || !text.trim()) return { db };
            return { db: queueWhatsApp(db, { text, ...replyTarget(r) }).db };
          },
        },
      ],
      groups: [['partner_id', 'phone', 'direction', 'template_id'], ['state', 'date', 'error', 'wa_message_id']],
      tabs: [{ label: 'Message', fields: ['body'] }],
    },
  },
};
