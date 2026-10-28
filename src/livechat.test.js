import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from './orm.js';
import { MAX_MESSAGES, channelStats, chatbotReply, closeSession, matchRule, pickOperator, postMessage, rateSession, startSession } from './models/livechat.js';
import { seed } from './seed.js';

const T0 = '2026-01-01T10:00:00.000Z';
const T1 = '2026-01-01T10:12:00.000Z';

const withChannel = (vals = {}) => {
  const { db, id } = create(seed(), 'livechat.channel', { name: 'Support', welcome_message: 'Welcome!', operator_ids: [{ operator_id: 3 }, { operator_id: 2 }], ...vals });
  return { db, channel: read(db, 'livechat.channel', id) };
};

test('the seed still loads its live chat data', () => {
  const db = seed();
  const sessions = search(db, 'livechat.session');
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].rating, 3);
  assert.equal(sessions[0].transcript, 'Asked about delivery times to Giza.');
  assert.deepEqual(sessions.map((s) => s.stage_id), ['closed', 'open']);
  assert.equal(search(db, 'livechat.channel')[0].button_text, 'Have a Question? Chat with us.');
});

test('rules: first match wins, by URL pattern and country; display_button by default', () => {
  const channel = { rules: [
    { url_regex: '/checkout', action: 'hide_button' },
    { url_regex: '', country: 'Egypt', action: 'auto_popup' },
    { url_regex: '[', action: 'hide_button' },
  ] };
  assert.equal(matchRule(channel, 'https://x/checkout', 'Egypt'), 'hide_button');
  assert.equal(matchRule(channel, 'https://x/shop', 'egypt'), 'auto_popup');
  assert.equal(matchRule(channel, 'https://x/shop', 'UAE'), 'display_button');
  assert.equal(matchRule({}, '/', ''), 'display_button');
});

test('operators are balanced by open sessions, ties go to the lowest id', () => {
  let { db, channel } = withChannel();
  assert.equal(pickOperator(db, channel), 2);
  db = startSession(db, channel, { name: 'A', now: T0 }).db;
  assert.equal(pickOperator(db, channel), 3);
  db = startSession(db, channel, { name: 'B', now: T0 }).db;
  assert.equal(pickOperator(db, channel), 2);
  assert.equal(pickOperator(db, { operator_ids: [] }), null);
});

test('start greets with the welcome message; posting enforces limits and expands canned responses', () => {
  const { db: base, channel } = withChannel();
  const canned = create(base, 'livechat.canned', { shortcut: 'thanks', substitution: 'Thank you, have a nice day!' }).db;
  const { db, id } = startSession(canned, channel, { name: 'Hala', email: 'h@x.co', token: 'tok', now: T0 });
  const s = read(db, 'livechat.session', id);
  assert.equal(s.stage_id, 'open');
  assert.equal(s.operator_id, 2);
  assert.equal(s.token, 'tok');
  assert.deepEqual(s.messages, [{ author: 'operator', body: 'Welcome!', date: T0 }]);
  assert.throws(() => postMessage(db, id, { author: 'visitor', body: '   ' }), /Write a message/);
  assert.throws(() => postMessage(db, id, { author: 'visitor', body: 'x'.repeat(2001) }), /2000/);
  assert.equal(read(postMessage(db, id, { author: 'visitor', body: 'x'.repeat(2000) }), 'livechat.session', id).messages.length, 2);
  const op = postMessage(db, id, { author: 'operator', body: ':Thanks', now: T1 });
  assert.equal(read(op, 'livechat.session', id).messages.at(-1).body, 'Thank you, have a nice day!');
  const visitor = postMessage(db, id, { author: 'visitor', body: ':hello' });
  assert.equal(read(visitor, 'livechat.session', id).messages.at(-1).body, ':hello');
});

test('without available operators the visitor waits', () => {
  const { db, channel } = withChannel({ operator_ids: [] });
  const res = startSession(db, channel, { name: 'Omar', now: T0 });
  assert.equal(read(res.db, 'livechat.session', res.id).stage_id, 'waiting');
  assert.throws(() => rateSession(res.db, res.id, 5), /cannot be rated/);
});

test('a chatbot rule runs the script and forwards to an operator', () => {
  const bot = create(seed(), 'livechat.chatbot', { name: 'Helper', steps: [
    { message: 'Hi, I am the bot.', step_type: 'text' },
    { message: 'Sales or support?', step_type: 'question', answers: 'Sales, Support' },
    { message: 'Connecting you to a human.', step_type: 'forward_operator' },
  ] });
  const ch = create(bot.db, 'livechat.channel', { name: 'Bot', operator_ids: [{ operator_id: 4 }], rules: [{ url_regex: '', action: 'display_button', chatbot_id: bot.id }] });
  const { db, id } = startSession(ch.db, read(ch.db, 'livechat.channel', ch.id), { name: 'Visitor', now: T0 });
  let s = read(db, 'livechat.session', id);
  assert.ok(!s.operator_id);
  assert.equal(s.bot_step, 1);
  assert.deepEqual(s.messages.map((m) => m.body), ['Hi, I am the bot.', 'Sales or support?']);
  const wrong = chatbotReply(db, id, 'Billing', T1);
  s = read(wrong, 'livechat.session', id);
  assert.equal(s.bot_step, 1);
  assert.match(s.messages.at(-1).body, /Sales \/ Support/);
  const fwd = chatbotReply(wrong, id, 'support', T1);
  s = read(fwd, 'livechat.session', id);
  assert.equal(s.operator_id, 4);
  assert.equal(s.stage_id, 'open');
  assert.equal(s.bot_step, null);
  assert.equal(s.messages.at(-1).body, 'Connecting you to a human.');
  assert.throws(() => chatbotReply(fwd, id, 'again'), /No chatbot/);
});

test('close, then rate once; stats follow', () => {
  const { db: base, channel } = withChannel();
  const { db, id } = startSession(base, channel, { name: 'Hala', now: T0 });
  const closed = closeSession(db, id, T1);
  const s = read(closed, 'livechat.session', id);
  assert.equal(s.stage_id, 'closed');
  assert.equal(s.duration, 12);
  assert.equal(closeSession(closed, id, T1), closed);
  assert.throws(() => postMessage(closed, id, { author: 'visitor', body: 'hi' }), /closed/);
  assert.throws(() => rateSession(closed, id, 6), /1 to 5/);
  const rated = rateSession(closed, id, 4, 'Quick answer');
  assert.equal(read(rated, 'livechat.session', id).rating_comment, 'Quick answer');
  assert.throws(() => rateSession(rated, id, 5), /already rated/);
  assert.deepEqual(channelStats(rated, channel.id), { sessions: 1, avgRating: 4, avgDuration: 12 });
  const ch = read(rated, 'livechat.channel', channel.id);
  assert.equal(ch.rating_avg, 4);
  assert.equal(ch.session_count, 1);
});

test('a conversation is capped so one visitor cannot grow it without bound', () => {
  const db = seed();
  const channel = search(db, 'livechat.channel')[0];
  const started = startSession(db, channel, { name: 'Flood', email: 'f@x.example', url: '/', token: 'tok-flood-0001', now: '2026-01-01T00:00:00Z' });
  const sid = started.id;
  const full = Array.from({ length: MAX_MESSAGES }).reduce((acc, _, i) => {
    const s = read(acc, 'livechat.session', sid);
    return (s.messages ?? []).length >= MAX_MESSAGES ? acc : postMessage(acc, sid, { author: 'visitor', body: `m${i}`, now: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}Z` });
  }, started.db);
  assert.equal(read(full, 'livechat.session', sid).messages.length, MAX_MESSAGES);
  assert.throws(() => postMessage(full, sid, { author: 'visitor', body: 'one more' }), /too long/);
});
