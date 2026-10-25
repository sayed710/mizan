// Live Chat: website channels with visibility rules, operator load balancing, chatbots, canned responses and ratings.
import { create, read, search, write } from '../orm.js';
import { today } from './common.js';
import { t } from '../i18n.js';

export const MAX_MESSAGE = 2000;
const STAGES = [['waiting', 'Waiting'], ['open', 'In Conversation'], ['closed', 'Closed']];
const AUTHORS = [['visitor', 'Visitor'], ['operator', 'Operator'], ['bot', 'Bot']];
const RULE_ACTIONS = [['display_button', 'Show'], ['auto_popup', 'Open automatically'], ['hide_button', 'Hide']];
const STEP_TYPES = [['text', 'Text'], ['question', 'Question'], ['forward_operator', 'Forward to Operator'], ['end', 'End Conversation']];

const round = (n) => Math.round(n * 100) / 100;
const list = (s) => String(s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const minutesBetween = (a, b) => (a && b ? Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 60000)) : 0);

/** First rule of the channel whose URL pattern and country match (empty pattern/country match everything). */
function findRule(channel, url = '', country = '') {
  return (channel?.rules ?? []).find((r) => {
    if (r.country && String(r.country).toLowerCase() !== String(country ?? '').toLowerCase()) return false;
    if (!r.url_regex) return true;
    try { return new RegExp(r.url_regex).test(String(url ?? '').slice(0, 2000)); } catch { return false; }
  }) ?? null;
}

/** Action of the first matching rule: display_button (default), auto_popup or hide_button. */
export const matchRule = (channel, url, country) => findRule(channel, url, country)?.action ?? 'display_button';

/** Channel operator with the fewest open sessions, ties broken by the lowest employee id; null when none. */
export function pickOperator(db, channel) {
  const ids = [...new Set((channel?.operator_ids ?? []).map((l) => l.operator_id).filter(Boolean))];
  if (!ids.length) return null;
  const open = search(db, 'livechat.session').filter((s) => s.stage_id === 'open');
  const load = (id) => open.filter((s) => s.operator_id === id).length;
  return ids.sort((a, b) => load(a) - load(b) || a - b)[0];
}

const sessionOf = (db, id) => {
  const s = read(db, 'livechat.session', id);
  if (!s) throw new Error('Conversation not found');
  return s;
};
const addMessages = (db, s, msgs) => write(db, 'livechat.session', s.id, { messages: [...(s.messages ?? []), ...msgs] });

/** Refresh the stored rating statistics of a channel. */
function refreshStats(db, channelId) {
  if (!channelId || !read(db, 'livechat.channel', channelId)) return db;
  const st = channelStats(db, channelId);
  return write(db, 'livechat.channel', channelId, { session_count: st.sessions, rating_avg: st.avgRating, duration_avg: st.avgDuration });
}

/** Assign the least busy operator: the session opens, or waits when nobody is available. */
function assignOperator(db, s) {
  const operator = pickOperator(db, read(db, 'livechat.channel', s.channel_id));
  return write(db, 'livechat.session', s.id, { operator_id: operator, stage_id: operator ? 'open' : 'waiting', bot_step: null });
}

/** Run the chatbot from step `from`: text steps chain, a question waits for an answer, forward/end stop the bot. */
function runBot(db, id, from, now) {
  let next = db;
  const bot = read(db, 'livechat.chatbot', sessionOf(db, id).chatbot_id);
  const steps = bot?.steps ?? [];
  for (let i = from; i < steps.length; i += 1) {
    const step = steps[i];
    if (step.message) next = addMessages(next, sessionOf(next, id), [{ author: 'bot', body: step.message, date: now }]);
    if (step.step_type === 'question') return write(next, 'livechat.session', id, { bot_step: i });
    if (step.step_type === 'forward_operator') return assignOperator(next, sessionOf(next, id));
    if (step.step_type === 'end') return closeSession(write(next, 'livechat.session', id, { bot_step: null }), id, now);
  }
  // Script finished without an explicit step: hand over to a human.
  return assignOperator(next, sessionOf(next, id));
}

/**
 * Start a visitor conversation. A rule with a chatbot hands the visitor to the bot; otherwise the least busy
 * operator is assigned and greets with the channel's welcome message.
 * @returns {{ db: object, id: number }}
 */
export function startSession(db, channel, { name = '', email = '', country = '', url = '', token = '', now = new Date().toISOString() } = {}) {
  if (!channel) throw new Error('Live chat is not available');
  const rule = findRule(channel, url, country);
  if (rule?.action === 'hide_button') throw new Error('Live chat is not available');
  const visitor = String(name).trim().slice(0, 120);
  const res = create(db, 'livechat.session', {
    name: visitor || `Visitor #${(db.seq['livechat.session'] ?? 0) + 1}`,
    visitor_name: visitor, visitor_email: String(email).trim().slice(0, 254), country: String(country).slice(0, 80),
    channel_id: channel.id, token, start_date: now, date: now.slice(0, 10), messages: [], stage_id: 'waiting',
  });
  let next = res.db;
  if (rule?.chatbot_id && read(next, 'livechat.chatbot', rule.chatbot_id)) {
    next = runBot(write(next, 'livechat.session', res.id, { chatbot_id: rule.chatbot_id, stage_id: 'open' }), res.id, 0, now);
  } else {
    next = assignOperator(next, sessionOf(next, res.id));
    if (channel.welcome_message) next = addMessages(next, sessionOf(next, res.id), [{ author: 'operator', body: channel.welcome_message, date: now }]);
  }
  return { db: refreshStats(next, channel.id), id: res.id };
}

/** Body of an operator message, with ":shortcut" replaced by its canned response. */
function expandCanned(db, author, body) {
  if (author !== 'operator' || !body.startsWith(':')) return body;
  const key = body.slice(1).trim().toLowerCase();
  return search(db, 'livechat.canned').find((c) => String(c.shortcut ?? '').toLowerCase() === key)?.substitution ?? body;
}

/** Add a message to an open conversation; empty bodies and bodies over 2000 characters are refused. */
export function postMessage(db, sessionId, { author, body, now = new Date().toISOString() }) {
  const s = sessionOf(db, sessionId);
  if (!AUTHORS.some(([k]) => k === author)) throw new Error('Unknown author');
  const text = String(body ?? '').trim();
  if (!text) throw new Error('Write a message first');
  if (text.length > MAX_MESSAGE) throw new Error(`Messages are limited to ${MAX_MESSAGE} characters`);
  if (s.stage_id === 'closed') throw new Error('This conversation is closed');
  const next = addMessages(db, s, [{ author, body: expandCanned(db, author, text).slice(0, MAX_MESSAGE), date: now }]);
  return author === 'operator' && s.stage_id === 'waiting' ? write(next, 'livechat.session', s.id, { stage_id: 'open' }) : next;
}

/** Visitor answer to the chatbot: an answer outside the offered ones repeats the question, otherwise the script moves on. */
export function chatbotReply(db, sessionId, answer, now = new Date().toISOString()) {
  const s = sessionOf(db, sessionId);
  if (s.bot_step == null || !s.chatbot_id) throw new Error('No chatbot is running in this conversation');
  const next = postMessage(db, sessionId, { author: 'visitor', body: answer, now });
  const step = read(db, 'livechat.chatbot', s.chatbot_id)?.steps?.[s.bot_step];
  const offered = list(step?.answers);
  if (offered.length && !offered.some((a) => a.toLowerCase() === String(answer).trim().toLowerCase())) {
    return addMessages(next, sessionOf(next, sessionId), [{ author: 'bot', body: `${step.message} (${offered.join(' / ')})`, date: now }]);
  }
  return runBot(next, sessionId, s.bot_step + 1, now);
}

/** End a conversation (no-op when it is already closed). */
export function closeSession(db, sessionId, now = new Date().toISOString()) {
  const s = sessionOf(db, sessionId);
  if (s.stage_id === 'closed') return db;
  return refreshStats(write(db, 'livechat.session', sessionId, { stage_id: 'closed', close_date: now, bot_step: null }), s.channel_id);
}

/** Visitor rating (1-5) with an optional comment: once per conversation, after it started. */
export function rateSession(db, sessionId, rating, comment = '') {
  const s = sessionOf(db, sessionId);
  const value = Number(rating);
  if (!Number.isInteger(value) || value < 1 || value > 5) throw new Error('Rate from 1 to 5 stars');
  if (!['open', 'closed'].includes(s.stage_id)) throw new Error('This conversation cannot be rated yet');
  if (Number(s.rating) > 0) throw new Error('This conversation was already rated');
  return refreshStats(write(db, 'livechat.session', sessionId, { rating: value, rating_comment: String(comment ?? '').slice(0, 1000) }), s.channel_id);
}

/** Sessions count, average rating (rated sessions) and average duration in minutes (closed sessions) of a channel. */
export function channelStats(db, channelId) {
  const sessions = search(db, 'livechat.session').filter((s) => s.channel_id === channelId);
  const rated = sessions.filter((s) => Number(s.rating) > 0);
  const closed = sessions.filter((s) => s.stage_id === 'closed' && s.close_date);
  const avg = (xs, f) => (xs.length ? round(xs.reduce((sum, x) => sum + f(x), 0) / xs.length) : 0);
  return { sessions: sessions.length, avgRating: avg(rated, (s) => Number(s.rating)), avgDuration: avg(closed, (s) => s.duration) };
}

const employee = (label) => ({ type: 'many2one', relation: 'hr.employee', label });

export const livechatModels = {
  'livechat.channel': {
    label: 'Channels',
    fields: {
      name: { type: 'char', label: 'Channel Name', required: true },
      button_text: { type: 'char', label: 'Button Text' },
      welcome_message: { type: 'text', label: 'Welcome Message' },
      operator_ids: { type: 'one2many', label: 'Operators', fields: { operator_id: employee('Operator') }, newLine: () => ({ operator_id: null }) },
      rules: {
        type: 'one2many',
        label: 'Channel Rules',
        fields: {
          url_regex: { type: 'char', label: 'URL Regex' },
          action: { type: 'selection', label: 'Live Chat Button', options: RULE_ACTIONS },
          country: { type: 'char', label: 'Country' },
          chatbot_id: { type: 'many2one', relation: 'livechat.chatbot', label: 'Chatbot' },
        },
        newLine: () => ({ url_regex: '', action: 'display_button', country: '', chatbot_id: null }),
      },
      session_count: { type: 'integer', label: 'Sessions', readonly: true },
      rating_avg: { type: 'float', label: 'Average Rating', readonly: true },
      duration_avg: { type: 'float', label: 'Average Duration (min)', readonly: true },
      operator_count: { type: 'integer', label: 'Operators', compute: (r) => (r.operator_ids ?? []).length },
    },
    defaults: () => ({ button_text: 'Have a Question? Chat with us.', welcome_message: 'Hello, how may I help you?', operator_ids: [], rules: [], session_count: 0, rating_avg: 0, duration_avg: 0 }),
    kanban: { title: 'name', lines: ['operator_count', 'session_count', 'rating_avg'] },
    list: ['name', 'operator_count', 'session_count', 'rating_avg', 'duration_avg'],
    form: {
      title: 'name',
      groups: [['button_text', 'operator_count'], ['session_count', 'rating_avg', 'duration_avg']],
      tabs: [{ label: 'Operators', fields: ['operator_ids'] }, { label: 'Options', fields: ['welcome_message'] }, { label: 'Channel Rules', fields: ['rules'] }],
      smart: [{ label: 'Sessions', model: 'livechat.session', field: 'channel_id', target: 'livechat/sessions' }],
      chatter: true,
    },
  },

  'livechat.session': {
    label: 'Sessions',
    fields: {
      name: { type: 'char', label: 'Visitor', required: true },
      channel_id: { type: 'many2one', relation: 'livechat.channel', label: 'Channel' },
      operator_id: employee('Operator'),
      visitor_name: { type: 'char', label: 'Visitor Name' },
      visitor_email: { type: 'char', label: 'Visitor Email' },
      date: { type: 'date', label: 'Date' },
      country: { type: 'char', label: 'Country' },
      stage_id: { type: 'selection', label: 'Stage', tracking: true, options: STAGES },
      rating: { type: 'integer', label: 'Rating' },
      rating_comment: { type: 'text', label: 'Rating Comment' },
      transcript: { type: 'text', label: 'Transcript' },
      messages: {
        type: 'one2many',
        label: 'Messages',
        fields: { author: { type: 'selection', label: 'Author', options: AUTHORS }, body: { type: 'char', label: 'Message' }, date: { type: 'char', label: 'Date' } },
        newLine: () => ({ author: 'operator', body: '', date: new Date().toISOString() }),
      },
      token: { type: 'char', label: 'Access Token', readonly: true },
      chatbot_id: { type: 'many2one', relation: 'livechat.chatbot', label: 'Chatbot', readonly: true },
      bot_step: { type: 'integer', label: 'Chatbot Step', readonly: true },
      start_date: { type: 'char', label: 'Started', readonly: true },
      close_date: { type: 'char', label: 'Closed', readonly: true },
      duration: { type: 'float', label: 'Duration (min)', compute: (r) => minutesBetween(r.start_date, r.close_date) },
      message_count: { type: 'integer', label: 'Messages', compute: (r) => (r.messages ?? []).length },
    },
    defaults: () => ({ stage_id: 'waiting', date: today(), rating: 0, messages: [] }),
    groupBys: ['stage_id', 'channel_id', 'operator_id', 'country', 'date'],
    filters: [[{ id: 'open', label: 'In Conversation', fn: (r) => r.stage_id === 'open' }, { id: 'rated', label: 'Rated', fn: (r) => Number(r.rating) > 0 }]],
    views: ['kanban', 'list', 'pivot', 'graph'],
    kanban: { groupBy: 'stage_id', title: 'name', lines: ['operator_id', 'country', 'message_count'] },
    list: ['date', 'name', 'channel_id', 'operator_id', 'country', 'message_count', 'duration', 'rating', 'stage_id'],
    pivot: { row: 'operator_id', col: 'stage_id', measure: 'duration' },
    graph: { groupBy: 'operator_id', measure: 'rating' },
    form: {
      statusbar: 'stage_id',
      statusbarClickable: true,
      title: 'name',
      buttons: [
        {
          label: 'Reply', primary: true, when: (r) => r.stage_id !== 'closed',
          run: (db, r) => {
            const body = prompt(t('Reply (":shortcut" inserts a canned response)'), '');
            return { db: body == null || !body.trim() ? db : postMessage(db, r.id, { author: 'operator', body }) };
          },
        },
        { label: 'Close Conversation', when: (r) => r.stage_id !== 'closed', run: (db, r) => ({ db: closeSession(db, r.id) }) },
      ],
      groups: [['channel_id', 'operator_id', 'visitor_name', 'visitor_email', 'country'], ['date', 'start_date', 'close_date', 'duration', 'rating']],
      tabs: [
        { label: 'Messages', fields: ['messages'], readonly: true },
        { label: 'Rating', fields: ['rating_comment'] },
        { label: 'Transcript', fields: ['transcript'] },
      ],
      chatter: true,
    },
  },

  'livechat.canned': {
    label: 'Canned Responses',
    fields: {
      shortcut: { type: 'char', label: 'Shortcut', required: true },
      substitution: { type: 'text', label: 'Substitution', required: true },
      name: { type: 'char', label: 'Name', compute: (r) => `:${r.shortcut ?? ''}` },
    },
    views: ['list', 'kanban'],
    kanban: { title: 'name', lines: ['substitution'] },
    list: ['shortcut', 'substitution'],
    form: { title: 'shortcut', groups: [['shortcut'], []], tabs: [{ label: 'Substitution', fields: ['substitution'] }] },
  },

  'livechat.chatbot': {
    label: 'Chatbots',
    fields: {
      name: { type: 'char', label: 'Chatbot Name', required: true },
      steps: {
        type: 'one2many',
        label: 'Script Steps',
        fields: {
          message: { type: 'char', label: 'Message' },
          step_type: { type: 'selection', label: 'Step Type', options: STEP_TYPES },
          answers: { type: 'char', label: 'Answers (comma separated)' },
        },
        newLine: () => ({ message: '', step_type: 'text', answers: '' }),
      },
      step_count: { type: 'integer', label: 'Steps', compute: (r) => (r.steps ?? []).length },
    },
    defaults: () => ({ steps: [] }),
    kanban: { title: 'name', lines: ['step_count'] },
    list: ['name', 'step_count'],
    form: { title: 'name', groups: [['step_count'], []], tabs: [{ label: 'Script', fields: ['steps'] }], chatter: true },
  },
};
