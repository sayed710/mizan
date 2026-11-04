// SMS Marketing: recipients with a phone, GSM-7/Unicode segment counting, per-recipient traces and STOP opt-outs.
import { create, search, write } from '../orm.js';
import { today } from './common.js';

// GSM 03.38 basic set plus the extension characters that cost two septets.
const GSM = new Set('@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà');
const GSM_EXT = new Set('^{}\\[~]|€');

/** Encoding, billable length and number of SMS parts (160/153 for GSM-7, 70/67 for Unicode). */
export function smsSegments(text = '') {
  const chars = [...String(text)];
  const gsm = chars.every((c) => GSM.has(c) || GSM_EXT.has(c));
  const length = gsm ? chars.reduce((n, c) => n + (GSM_EXT.has(c) ? 2 : 1), 0) : chars.length;
  const [single, multi] = gsm ? [160, 153] : [70, 67];
  return { encoding: gsm ? 'GSM-7' : 'Unicode', length, segments: length === 0 ? 0 : length <= single ? 1 : Math.ceil(length / multi) };
}

/** Phone number reduced to + and digits, so duplicates and the blacklist compare reliably. */
export const normalizePhone = (p) => String(p ?? '').replace(/(?!^\+)[^\d]/g, '').replace(/^00/, '+');

const blacklisted = (db) => new Set(search(db, 'phone.blacklist').filter((b) => b.active !== false).map((b) => normalizePhone(b.number)));

/** Recipients with a usable phone: list contacts not opted out, or contacts; deduped and without blacklisted numbers. */
export function smsRecipients(db, campaign) {
  const raw = campaign.mailing_model === 'res.partner'
    ? search(db, 'res.partner').filter((p) => !campaign.partner_tag || (p.tag_ids ?? []).includes(campaign.partner_tag)).map((p) => ({ phone: p.mobile || p.phone, name: p.name, res_model: 'res.partner', res_id: p.id }))
    : search(db, 'mailing.contact').filter((c) => c.list_id === campaign.list_id && !c.opt_out).map((c) => ({ phone: c.phone, name: c.name, res_model: 'mailing.contact', res_id: c.id }));
  const banned = blacklisted(db);
  const seen = new Set();
  return raw.map((r) => ({ ...r, phone: normalizePhone(r.phone) })).filter((r) => {
    if (r.phone.replace('+', '').length < 6 || banned.has(r.phone) || seen.has(r.phone)) return false;
    seen.add(r.phone);
    return true;
  });
}

/** Create one trace per recipient and mark the campaign sent; the server delivers the queued traces. */
export function queueSms(db, campaign, { now = today() } = {}) {
  if (campaign.stage_id === 'sent') throw new Error('This SMS campaign was already sent');
  if (!String(campaign.body ?? '').trim()) throw new Error('Write the SMS content first');
  const recipients = smsRecipients(db, campaign);
  if (!recipients.length) throw new Error('No recipient has a valid phone number');
  const traced = recipients.reduce((acc, r) => create(acc, 'sms.trace', { campaign_id: campaign.id, ...r, state: 'outgoing', delivery_pending: true, date: now }).db, db);
  return write(traced, 'sms.campaign', campaign.id, { stage_id: 'sent', sent_date: now, sent: recipients.length, delivered: 0, failed: 0 });
}

/** Record a delivery result for a trace and keep the campaign counters in step. */
export function markSms(db, traceId, ok, error = '') {
  const trace = search(db, 'sms.trace').find((t) => t.id === traceId);
  if (!trace || trace.state !== 'outgoing') return db;
  const camp = search(db, 'sms.campaign').find((c) => c.id === trace.campaign_id);
  const next = write(db, 'sms.trace', traceId, { state: ok ? 'sent' : 'error', error: ok ? '' : String(error).slice(0, 200) });
  return camp ? write(next, 'sms.campaign', camp.id, ok ? { delivered: (Number(camp.delivered) || 0) + 1 } : { failed: (Number(camp.failed) || 0) + 1 }) : next;
}

/** An incoming "STOP" (any case, optionally with text after it) blacklists the sender's number. */
export function handleInbound(db, from, text) {
  const phone = normalizePhone(from);
  if (!/^\s*stop\b/i.test(String(text)) || !phone) return db;
  if (blacklisted(db).has(phone)) return db;
  return create(db, 'phone.blacklist', { number: phone, reason: 'Replied STOP', active: true }).db;
}

const stages = [['draft', 'Draft'], ['scheduled', 'Scheduled'], ['sent', 'Sent']];

export const smsModels = {
  'sms.campaign': {
    label: 'SMS Campaigns',
    fields: {
      name: { type: 'char', label: 'Subject', required: true },
      mailing_model: { type: 'selection', label: 'Recipients', options: [['mailing.list', 'Mailing List'], ['res.partner', 'Contact']] },
      list_id: { type: 'many2one', relation: 'mailing.list', label: 'Mailing List' },
      partner_tag: { type: 'char', label: 'Contact Tag' },
      body: { type: 'text', label: 'SMS Content' },
      length: { type: 'integer', label: 'Characters', compute: (r) => smsSegments(r.body).length },
      segments: { type: 'integer', label: 'SMS Parts', compute: (r) => smsSegments(r.body).segments },
      encoding: { type: 'char', label: 'Encoding', compute: (r) => smsSegments(r.body).encoding },
      stage_id: { type: 'selection', label: 'Status', tracking: true, options: stages },
      schedule_date: { type: 'date', label: 'Scheduled for' },
      sent_date: { type: 'date', label: 'Sent on', readonly: true },
      sent: { type: 'integer', label: 'Sent', readonly: true },
      delivered: { type: 'integer', label: 'Delivered', readonly: true },
      failed: { type: 'integer', label: 'Failed', readonly: true },
    },
    defaults: () => ({ mailing_model: 'mailing.list', stage_id: 'draft', sent: 0, delivered: 0, failed: 0 }),
    groupBys: ['stage_id', 'list_id'],
    kanban: { groupBy: 'stage_id', title: 'name', lines: ['list_id', 'segments', 'sent'] },
    list: ['name', 'list_id', 'length', 'segments', 'sent', 'delivered', 'failed', 'stage_id'],
    form: {
      statusbar: 'stage_id',
      lockedWhen: (r) => r.stage_id === 'sent',
      buttons: [
        // The server sends the queued traces through the SMS gateway; offline, queueing records the campaign.
        { label: 'Send', primary: true, when: (r) => r.stage_id !== 'sent', server: '/api/integrations/sms-campaign', requires: 'sms', run: (db, r) => ({ db: queueSms(db, r) }) },
        { label: 'Resume Unsent', when: (r, db) => r.stage_id === 'sent' && (db?.records?.['sms.trace'] ?? []).some((t) => t.campaign_id === r.id && t.state === 'outgoing'), server: '/api/integrations/sms-campaign', requires: 'sms' },
        { label: 'Schedule', when: (r) => r.stage_id === 'draft', vals: { stage_id: 'scheduled' } },
        { label: 'Cancel', when: (r) => r.stage_id === 'scheduled', vals: { stage_id: 'draft' } },
      ],
      title: 'name',
      groups: [['mailing_model', 'list_id', 'partner_tag', 'schedule_date'], ['length', 'segments', 'encoding', 'sent_date', 'sent', 'delivered', 'failed']],
      tabs: [{ label: 'SMS Content', fields: ['body'] }],
      smart: [{ label: 'Traces', model: 'sms.trace', field: 'campaign_id', target: 'sms/traces' }],
      chatter: true,
    },
  },

  'sms.trace': {
    label: 'SMS Traces',
    fields: {
      campaign_id: { type: 'many2one', relation: 'sms.campaign', label: 'Campaign' },
      attempted_at: { type: 'datetime', label: 'Attempted At', readonly: true },
      delivery_pending: { type: 'boolean', label: 'Pending', readonly: true, hidden: true },
      phone: { type: 'char', label: 'Number' },
      name: { type: 'char', label: 'Recipient' },
      res_model: { type: 'char', label: 'Document Model', readonly: true },
      res_id: { type: 'integer', label: 'Document ID', readonly: true },
      state: { type: 'selection', label: 'Status', options: [['outgoing', 'In Queue'], ['sent', 'Sent'], ['error', 'Error'], ['uncertain', 'Delivery Uncertain']] },
      error: { type: 'char', label: 'Error', readonly: true },
      date: { type: 'date', label: 'Date', readonly: true },
    },
    groupBys: ['campaign_id', 'state'],
    kanban: { title: 'phone', lines: ['name', 'campaign_id'], badge: 'state' },
    list: ['date', 'campaign_id', 'name', 'phone', 'state', 'error'],
    views: ['list', 'kanban', 'pivot'],
    pivot: { row: 'campaign_id', col: 'state', measure: '__count' },
    form: { lockedWhen: () => true, title: 'phone', groups: [['campaign_id', 'name', 'phone'], ['state', 'error', 'date']] },
  },

  'phone.blacklist': {
    label: 'Blacklisted Phone Numbers',
    fields: {
      number: { type: 'char', label: 'Phone Number', required: true },
      reason: { type: 'char', label: 'Reason' },
      active: { type: 'boolean', label: 'Active' },
    },
    defaults: () => ({ active: true }),
    kanban: { title: 'number', lines: ['reason'] },
    list: ['number', 'reason', 'active'],
    form: { title: 'number', groups: [['number', 'reason'], ['active']] },
  },
};
