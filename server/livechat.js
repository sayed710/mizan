// Public live chat endpoints: visitors start a conversation, send messages, poll for replies and rate it.
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { read, search } from '../src/orm.js';
import { chatbotReply, postMessage, rateSession, startSession } from '../src/models/livechat.js';
import { applyDiff, diffDb } from '../src/sync.js';

const EMAIL = /^[^@\s]{1,64}@[^@\s]{1,190}\.[^@\s]{2,}$/;
const ALLOWED = new Set(['livechat.session', 'livechat.channel']);
const obj = (b) => (b && typeof b === 'object' && !Array.isArray(b) ? b : {});

/** The website's live chat channel (the first one). */
const channelOf = (db) => search(db, 'livechat.channel')[0] ?? null;

/** Button settings for the public site, or null when no channel exists. */
export function livechatInfo(db) {
  const c = channelOf(db);
  return c ? { name: c.name, button_text: c.button_text ?? '', rules: (c.rules ?? []).map((r) => ({ url_regex: r.url_regex ?? '', action: r.action, country: r.country ?? '' })) } : null;
}

/** True when `token` is this session's secret (constant-time comparison on equal-length buffers). */
export function tokenMatches(session, token) {
  if (!session?.token || typeof token !== 'string') return false;
  const a = Buffer.from(token);
  const b = Buffer.from(session.token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Visitor session for an id/token pair, or null (unknown id and wrong token look the same). */
function visitorSession(db, sessionId, token) {
  const s = Number.isInteger(sessionId) ? read(db, 'livechat.session', sessionId) : null;
  return s && tokenMatches(s, token) ? s : null;
}

const commit = (db, next) => applyDiff(db, diffDb(db, next), { author: 'Website', isAdmin: false, allowed: ALLOWED });
const denied = { status: 403, body: { error: 'Unknown conversation' }, denied: true };

/** Run a model transition and commit it; model errors become a 400 with their message. */
function attempt(db, run, body) {
  try {
    const next = run();
    return { status: 200, body: typeof body === 'function' ? body(next) : body, db: commit(db, next) };
  } catch (e) {
    return { status: 400, body: { error: e.message } };
  }
}

/** POST /api/public/livechat/start {name, email, url} → {sessionId, token}. */
export function livechatStart(db, body, now = new Date().toISOString()) {
  const b = obj(body);
  const name = String(b.name ?? '').trim().slice(0, 120);
  const email = String(b.email ?? '').trim().slice(0, 254);
  if (!name || !EMAIL.test(email)) return { status: 400, body: { error: 'Enter your name and a valid email address' } };
  const token = randomUUID();
  let id = null;
  const out = attempt(db, () => {
    const res = startSession(db, channelOf(db), { name, email, url: String(b.url ?? '').slice(0, 2000), token, now });
    id = res.id;
    return res.db;
  }, () => ({ sessionId: id, token }));
  return out.status === 200 ? { ...out, status: 201 } : out;
}

/** POST /api/public/livechat/message {sessionId, token, body}: the chatbot answers while it runs. */
export function livechatMessage(db, body, now = new Date().toISOString()) {
  const b = obj(body);
  const s = visitorSession(db, b.sessionId, b.token);
  if (!s) return denied;
  const run = () => (s.bot_step != null && s.chatbot_id ? chatbotReply(db, s.id, String(b.body ?? ''), now) : postMessage(db, s.id, { author: 'visitor', body: b.body, now }));
  return attempt(db, run, { ok: true });
}

/** GET /api/public/livechat/poll?sessionId&token&since → messages newer than `since` (ISO date) and the stage. */
export function livechatPoll(db, query) {
  const s = visitorSession(db, Number(query.get('sessionId')), query.get('token'));
  if (!s) return denied;
  const since = String(query.get('since') ?? '');
  const messages = (s.messages ?? []).filter((m) => !since || String(m.date) > since);
  return { status: 200, body: { messages, stage: s.stage_id, rated: Number(s.rating) > 0, operator: read(db, 'hr.employee', s.operator_id)?.name ?? null } };
}

/** POST /api/public/livechat/rate {sessionId, token, rating, comment}: once per conversation. */
export function livechatRate(db, body) {
  const b = obj(body);
  const s = visitorSession(db, b.sessionId, b.token);
  if (!s) return denied;
  return attempt(db, () => rateSession(db, s.id, b.rating, String(b.comment ?? '')), { ok: true });
}
