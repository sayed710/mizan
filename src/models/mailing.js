// Email Marketing: mailing lists, contacts, mailings with A/B tests, delivery traces and the blacklist.
import { create, read, search, write } from '../orm.js';
import { addDays, today } from './common.js';

const state = (options, label = 'Status') => ({ type: 'selection', label, tracking: true, options });
const norm = (email) => String(email ?? '').trim().toLowerCase();
const ratio = (part, sent) => (Number(sent) > 0 ? Math.round(((Number(part) || 0) * 1000) / Number(sent)) / 10 : 0);
const LEVEL = { sent: 0, opened: 1, clicked: 2, replied: 3 };
const KIND = { open: 'opened', click: 'clicked', reply: 'replied' };
const COPIED = ['subject', 'preview', 'body', 'email_from', 'reply_to', 'user_id', 'mailing_model', 'list_id', 'partner_tag', 'partner_country', 'exclude_blacklist', 'campaign_key'];

/** Replace {{ object.field }} / {{object.a.b}} with the value as a string (missing → ''); other {{...}} stay. */
export function renderTemplate(text, object) {
  return String(text ?? '').replace(/\{\{\s*object\.([\w.]+)\s*\}\}/g, (_, path) => {
    const value = path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), object);
    return value == null ? '' : String(value);
  });
}

const matches = (m) => (r) => (!m.partner_tag || (r.tag_ids ?? []).includes(m.partner_tag))
  && (!m.partner_country || norm(r.country) === norm(m.partner_country));

/** Recipients of a mailing: list contacts not opted out, or partners/leads by tag and country; deduped, minus the blacklist. */
export function recipientsOf(db, mailing) {
  const model = mailing.mailing_model || 'mailing.list';
  const raw = model === 'mailing.list'
    ? search(db, 'mailing.contact').filter((c) => c.list_id === mailing.list_id && !c.opt_out)
      .map((c) => ({ email: c.email, name: c.name, res_model: 'mailing.contact', res_id: c.id }))
    : model === 'crm.lead'
      ? search(db, 'crm.lead').filter((l) => l.email).filter(matches(mailing))
        .map((l) => ({ email: l.email, name: l.partner_name || l.contact_name || l.name, res_model: 'crm.lead', res_id: l.id }))
      : search(db, 'res.partner').filter((p) => p.email).filter(matches(mailing))
        .map((p) => ({ email: p.email, name: p.name, res_model: 'res.partner', res_id: p.id }));
  const blocked = mailing.exclude_blacklist === false ? new Set() : new Set(search(db, 'mail.blacklist').map((b) => norm(b.email)));
  const seen = new Set();
  return raw.filter((r) => {
    const key = norm(r.email);
    if (!key || seen.has(key) || blocked.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const campaignIds = (db, mailing) => (mailing.campaign_key
  ? search(db, 'mailing.mailing').filter((m) => m.campaign_key === mailing.campaign_key).map((m) => m.id)
  : [mailing.id]);

const tracedEmails = (db, mailing) => {
  const ids = new Set(campaignIds(db, mailing));
  return new Set(search(db, 'mailing.trace').filter((t) => ids.has(t.mailing_id)).map((t) => norm(t.email)));
};

/** One A/B version's sample: pc% of all recipients (sorted by email), skipping anyone already sent a version of the campaign. */
export function abSample(db, mailing) {
  const all = [...recipientsOf(db, mailing)].sort((a, b) => norm(a.email).localeCompare(norm(b.email)));
  const pc = Math.min(100, Math.max(1, Number(mailing.ab_testing_pc) || 10));
  const traced = tracedEmails(db, mailing);
  return all.filter((r) => !traced.has(norm(r.email))).slice(0, Math.max(1, Math.round((all.length * pc) / 100)));
}

/** Validate and queue a mailing: one 'sent' trace per recipient (the server delivers them), then mark it sent. */
export function queueMailing(db, mailing, { now = today(), token = () => crypto.randomUUID() } = {}) {
  if (!mailing.subject) throw new Error('Set a subject before sending');
  if (mailing.state === 'sent') throw new Error('This mailing has already been sent');
  const all = recipientsOf(db, mailing);
  if (!all.length) {
    throw new Error((mailing.mailing_model || 'mailing.list') === 'mailing.list' ? 'The mailing list has no subscribed recipients' : 'No recipients match this mailing');
  }
  const isVersion = !!mailing.ab_testing_enabled && !mailing.ab_winner;
  const traced = mailing.ab_winner ? tracedEmails(db, mailing) : null;
  const picked = isVersion ? abSample(db, mailing) : traced ? all.filter((r) => !traced.has(norm(r.email))) : all;
  if (!picked.length) throw new Error('Every recipient of this A/B campaign has already received a version');
  const next = picked.reduce((acc, r) => create(acc, 'mailing.trace', {
    mailing_id: mailing.id, email: r.email, name: r.name, res_model: r.res_model, res_id: r.res_id,
    token: token(), state: 'sent', sent_date: now, ab_version: isVersion, links_clicked: [],
  }).db, db);
  return write(next, 'mailing.mailing', mailing.id, { state: 'sent', sent_date: now, sent: picked.length, delivered: picked.length });
}

const traceBy = (db, token) => (token ? search(db, 'mailing.trace').find((t) => t.token === token) : undefined);
const bump = (db, mailingId, deltas) => {
  const m = read(db, 'mailing.mailing', mailingId);
  if (!m) return db;
  return write(db, 'mailing.mailing', m.id, Object.fromEntries(Object.entries(deltas).map(([k, d]) => [k, Math.max(0, (Number(m[k]) || 0) + d)])));
};

/** A hard bounce: the trace is bounced and the mailing counts one delivery less. */
export function markBounced(db, token) {
  const t = traceBy(db, token);
  if (!t || t.state === 'bounced') return db;
  return bump(write(db, 'mailing.trace', t.id, { state: 'bounced' }), t.mailing_id, { delivered: -1, bounced: 1 });
}

/** Record an open, click or reply; states only move up and each counter counts a trace once. */
export function trackEvent(db, token, kind, { now = today(), url } = {}) {
  const t = traceBy(db, token);
  const target = KIND[kind];
  if (!t || !target || t.state === 'bounced' || t.state === 'cancel') return db;
  const firstOpen = !t.open_date;
  const firstClick = kind === 'click' && !t.click_date;
  const firstReply = kind === 'reply' && !t.reply_date;
  const links = t.links_clicked ?? [];
  const vals = {
    state: (LEVEL[target] > (LEVEL[t.state] ?? 0)) ? target : t.state,
    ...(firstOpen ? { open_date: now } : {}),
    ...(firstClick ? { click_date: now } : {}),
    ...(firstReply ? { reply_date: now } : {}),
    ...(kind === 'click' && url && !links.includes(url) ? { links_clicked: [...links, url] } : {}),
  };
  const deltas = { ...(firstOpen ? { opened: 1 } : {}), ...(firstClick ? { clicked: 1 } : {}), ...(firstReply ? { replied: 1 } : {}) };
  return bump(write(db, 'mailing.trace', t.id, vals), t.mailing_id, deltas);
}

/** Unsubscribe link: opt the list contact out, or blacklist the address for partner/lead mailings. */
export function unsubscribe(db, token) {
  const t = traceBy(db, token);
  if (!t) return db;
  if (t.res_model === 'mailing.contact') return read(db, 'mailing.contact', t.res_id) ? write(db, 'mailing.contact', t.res_id, { opt_out: true }) : db;
  if (search(db, 'mail.blacklist').some((b) => norm(b.email) === norm(t.email))) return db;
  return create(db, 'mail.blacklist', { email: t.email, reason: 'Unsubscribed from mailing', active: true }).db;
}

const versionsOf = (db, key) => search(db, 'mailing.mailing').filter((m) => m.campaign_key === key && m.ab_testing_enabled && !m.ab_winner).sort((a, b) => a.id - b.id);
const automatic = (sel) => ['opened', 'clicked', 'replied'].includes(sel);

/** Best sent A/B version by the campaign's winner criterion (ties: lowest id); null for manual selection. */
export function selectWinner(db, campaignKey) {
  const versions = versionsOf(db, campaignKey);
  const sel = versions[0]?.ab_testing_winner_selection;
  if (!automatic(sel)) return null;
  return versions.filter((m) => m.state === 'sent').reduce((best, m) => (!best || m[`${sel}_ratio`] > best[`${sel}_ratio`] ? m : best), null);
}

/** Copy the winning version into a final mailing and send it to everyone who got no version yet. */
export function sendWinner(db, winnerId, opts) {
  const w = read(db, 'mailing.mailing', winnerId);
  if (!w) throw new Error('Winning mailing not found');
  if (search(db, 'mailing.mailing').some((m) => m.ab_winner && m.campaign_key === w.campaign_key)) throw new Error('The winner of this A/B test has already been sent');
  const vals = Object.fromEntries(COPIED.filter((k) => w[k] !== undefined).map((k) => [k, w[k]]));
  const { db: next, id } = create(db, 'mailing.mailing', { ...vals, ab_winner: true, ab_testing_enabled: false, state: 'draft' });
  return queueMailing(next, read(next, 'mailing.mailing', id), opts);
}

/** Scheduled mailings due at `at`. */
export const dueMailings = (db, at) => search(db, 'mailing.mailing').filter((m) => m.state === 'scheduled' && m.schedule_date && m.schedule_date <= at);

/** A/B campaigns ready for automatic winner sending at `at`. */
export function dueAbWinners(db, at) {
  const mailings = search(db, 'mailing.mailing');
  const keys = [...new Set(mailings.filter((m) => m.campaign_key && m.ab_testing_enabled && !m.ab_winner).map((m) => m.campaign_key))];
  return keys.filter((key) => {
    const versions = versionsOf(db, key);
    const first = versions[0];
    return versions.every((m) => m.state === 'sent') && automatic(first.ab_testing_winner_selection)
      && first.ab_testing_schedule_date && first.ab_testing_schedule_date <= at
      && !mailings.some((m) => m.ab_winner && m.campaign_key === key);
  });
}

function sendWinnerNow(db, r) {
  const manual = !automatic(versionsOf(db, r.campaign_key)[0]?.ab_testing_winner_selection);
  const winner = selectWinner(db, r.campaign_key) ?? (manual ? r : null);
  if (!winner) throw new Error('Select the winning version manually: open it and use Send Winner Now');
  return { db: sendWinner(db, winner.id, { now: today(), token: () => crypto.randomUUID() }) };
}

const counter = (label) => ({ type: 'integer', label, readonly: true });
const percent = (label, part) => ({ type: 'float', label, compute: (r) => ratio(r[part], r.sent) });

export const mailingModels = {
  'mailing.list': {
    label: 'Mailing Lists',
    fields: { name: { type: 'char', label: 'Mailing List', required: true } },
    kanban: { title: 'name', lines: [], counter: { label: 'Contacts', model: 'mailing.contact', field: 'list_id' } },
    list: ['name'],
    form: { title: 'name', smart: [{ label: 'Contacts', model: 'mailing.contact', field: 'list_id', target: 'marketing/contacts' }], groups: [[], []] },
  },

  'mailing.contact': {
    label: 'Mailing Contacts',
    fields: {
      name: { type: 'char', label: 'Name', required: true },
      email: { type: 'char', label: 'Email', required: true },
      phone: { type: 'char', label: 'Mobile' },
      list_id: { type: 'many2one', relation: 'mailing.list', label: 'Mailing List' },
      opt_out: { type: 'boolean', label: 'Opted Out' },
    },
    filters: [[{ id: 'subscribed', label: 'Subscribed', fn: (r) => !r.opt_out }, { id: 'optout', label: 'Opted Out', fn: (r) => r.opt_out }]],
    groupBys: ['list_id', 'opt_out'],
    kanban: { title: 'name', lines: ['email', 'list_id'], avatar: true },
    list: ['name', 'email', 'list_id', 'opt_out'],
    views: ['list', 'kanban'],
    form: { title: 'name', groups: [['email', 'list_id'], ['opt_out']] },
  },

  'mailing.mailing': {
    label: 'Mailings',
    fields: {
      subject: { type: 'char', label: 'Subject', required: true },
      preview: { type: 'char', label: 'Preview Text' },
      body: { type: 'text', label: 'Mail Body' },
      email_from: { type: 'char', label: 'Send From' },
      reply_to: { type: 'char', label: 'Reply To' },
      user_id: { type: 'many2one', relation: 'hr.employee', label: 'Responsible' },
      mailing_model: { type: 'selection', label: 'Recipients', options: [['mailing.list', 'Mailing List'], ['res.partner', 'Contact'], ['crm.lead', 'Lead/Opportunity']] },
      list_id: { type: 'many2one', relation: 'mailing.list', label: 'Mailing List' },
      partner_tag: { type: 'char', label: 'Contact Tag' },
      partner_country: { type: 'char', label: 'Country' },
      exclude_blacklist: { type: 'boolean', label: 'Exclude Blacklisted Recipients' },
      state: state([['draft', 'Draft'], ['scheduled', 'Scheduled'], ['sending', 'Sending'], ['sent', 'Sent']]),
      schedule_date: { type: 'date', label: 'Scheduled for' },
      sent_date: { type: 'date', label: 'Sent on', readonly: true },
      ab_testing_enabled: { type: 'boolean', label: 'A/B Test' },
      ab_testing_pc: { type: 'integer', label: 'Percentage of recipients' },
      ab_testing_winner_selection: {
        type: 'selection', label: 'Winner Selection',
        options: [['manual', 'Manual'], ['opened', 'Highest Open Rate'], ['clicked', 'Highest Click Rate'], ['replied', 'Highest Reply Rate']],
      },
      ab_testing_schedule_date: { type: 'date', label: 'Send Final On' },
      campaign_key: { type: 'char', label: 'A/B Campaign' },
      ab_winner: { type: 'boolean', label: 'A/B Winner', readonly: true },
      sent: counter('Sent'),
      delivered: counter('Delivered'),
      opened: counter('Opened'),
      clicked: counter('Clicked'),
      replied: counter('Replied'),
      bounced: counter('Bounced'),
      received_ratio: percent('Received (%)', 'delivered'),
      opened_ratio: percent('Opened (%)', 'opened'),
      clicked_ratio: percent('Clicked (%)', 'clicked'),
      replied_ratio: percent('Replied (%)', 'replied'),
      bounced_ratio: percent('Bounced (%)', 'bounced'),
    },
    defaults: () => ({
      state: 'draft', user_id: 1, mailing_model: 'mailing.list', exclude_blacklist: true,
      ab_testing_enabled: false, ab_testing_pc: 10, ab_testing_winner_selection: 'opened', ab_winner: false,
      sent: 0, delivered: 0, opened: 0, clicked: 0, replied: 0, bounced: 0,
    }),
    guard: (db, old, vals) => {
      const pc = vals.ab_testing_pc;
      return pc != null && pc !== '' && !(Number(pc) >= 1 && Number(pc) <= 100) ? 'Percentage of recipients must be between 1 and 100' : null;
    },
    groupBys: ['state', 'mailing_model', 'list_id', 'user_id', 'sent_date', 'campaign_key'],
    kanban: { groupBy: 'state', title: 'subject', lines: ['list_id', 'sent', 'opened_ratio', 'sent_date'], badge: 'user_id' },
    list: ['sent_date', 'subject', 'user_id', 'sent', 'delivered', 'opened_ratio', 'clicked_ratio', 'replied_ratio', 'bounced_ratio', 'state'],
    views: ['list', 'kanban', 'calendar', 'graph'],
    calendar: { date: 'schedule_date' },
    graph: { groupBy: 'list_id', measure: 'sent' },
    form: {
      statusbar: 'state',
      lockedWhen: (r) => r.state === 'sent',
      buttons: [
        {
          label: 'Send', email: 'mailing', primary: true, when: (r) => r.state === 'draft' || r.state === 'scheduled',
          run: (db, r) => ({ db: queueMailing(db, r, { now: today(), token: () => crypto.randomUUID() }) }),
        },
        { label: 'Schedule', when: (r) => r.state === 'draft', vals: { state: 'scheduled', schedule_date: addDays(today(), 1) } },
        { label: 'Send Winner Now', when: (r) => r.state === 'sent' && r.ab_testing_enabled && !!r.campaign_key, run: sendWinnerNow },
        { label: 'Cancel', when: (r) => r.state === 'scheduled', vals: { state: 'draft' } },
      ],
      smart: [{ label: 'Traces', model: 'mailing.trace', field: 'mailing_id', target: 'marketing/traces' }],
      title: 'subject',
      groups: [
        ['subject', 'mailing_model', 'list_id', 'partner_tag', 'partner_country'],
        ['user_id', 'schedule_date', 'sent_date', 'sent', 'delivered', 'opened_ratio', 'clicked_ratio', 'replied_ratio', 'bounced_ratio'],
      ],
      tabs: [
        { label: 'Mail Body', fields: ['preview', 'body'] },
        { label: 'A/B Tests', fields: ['ab_testing_enabled', 'ab_testing_pc', 'ab_testing_winner_selection', 'ab_testing_schedule_date', 'campaign_key'] },
        { label: 'Settings', fields: ['email_from', 'reply_to', 'exclude_blacklist'] },
      ],
      chatter: true,
    },
  },

  'mailing.trace': {
    label: 'Mailing Traces',
    fields: {
      mailing_id: { type: 'many2one', relation: 'mailing.mailing', label: 'Mailing' },
      email: { type: 'char', label: 'Email' },
      name: { type: 'char', label: 'Recipient' },
      res_model: { type: 'char', label: 'Document Model' },
      res_id: { type: 'integer', label: 'Document ID' },
      token: { type: 'char', label: 'Token', readonly: true },
      state: state([['sent', 'Sent'], ['opened', 'Opened'], ['clicked', 'Clicked'], ['replied', 'Replied'], ['bounced', 'Bounced'], ['cancel', 'Cancelled']]),
      sent_date: { type: 'date', label: 'Sent On' },
      open_date: { type: 'date', label: 'Opened On' },
      click_date: { type: 'date', label: 'Clicked On' },
      reply_date: { type: 'date', label: 'Replied On' },
      links_clicked: { type: 'tags', label: 'Links Clicked' },
      ab_version: { type: 'boolean', label: 'A/B Version' },
    },
    defaults: () => ({ state: 'sent', links_clicked: [], ab_version: false }),
    groupBys: ['mailing_id', 'state', 'res_model'],
    kanban: { title: 'email', lines: ['mailing_id', 'sent_date'], badge: 'state' },
    list: ['sent_date', 'mailing_id', 'name', 'email', 'state', 'open_date', 'click_date', 'reply_date'],
    views: ['list', 'kanban', 'pivot'],
    form: {
      statusbar: 'state',
      title: 'email',
      groups: [['mailing_id', 'name', 'email', 'res_model', 'res_id', 'ab_version'], ['sent_date', 'open_date', 'click_date', 'reply_date', 'links_clicked']],
    },
  },

  'mail.blacklist': {
    label: 'Blacklisted Email Addresses',
    fields: {
      email: { type: 'char', label: 'Email Address', required: true },
      reason: { type: 'char', label: 'Reason' },
      active: { type: 'boolean', label: 'Active' },
    },
    defaults: () => ({ active: true }),
    kanban: { title: 'email', lines: ['reason'] },
    list: ['email', 'reason'],
    views: ['list', 'kanban'],
    form: { title: 'email', groups: [['email'], ['reason', 'active']], chatter: true },
  },
};
