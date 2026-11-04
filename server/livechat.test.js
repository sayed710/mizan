import '../src/models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { read } from '../src/orm.js';
import { seed } from '../src/seed.js';
import { livechatInfo, livechatMessage, livechatPoll, livechatRate, livechatStart, tokenMatches } from './livechat.js';

const T0 = '2026-01-01T10:00:00.000Z';
const T1 = '2026-01-01T10:05:00.000Z';
const started = () => {
  const out = livechatStart(seed(), { name: 'Hala', email: 'hala@example.com', url: '/shop' }, T0);
  assert.equal(out.status, 201);
  return { db: out.db, ...out.body };
};
const poll = (db, params) => livechatPoll(db, new URLSearchParams(params));

test('start validates the visitor and returns a random token', () => {
  assert.equal(livechatStart(seed(), { name: '', email: 'x' }).status, 400);
  const a = started();
  const b = started();
  assert.match(a.token, /^[0-9a-f-]{36}$/);
  assert.notEqual(a.token, b.token);
  assert.equal(read(a.db, 'livechat.session', a.sessionId).visitor_email, 'hala@example.com');
  assert.equal(livechatInfo(a.db).button_text, 'Have a Question? Chat with us.');
});

test('wrong, missing or differently sized tokens are refused', () => {
  const { db, sessionId, token } = started();
  assert.equal(tokenMatches({ token }, token), true);
  assert.equal(tokenMatches({ token }, `${token}x`), false);
  assert.equal(tokenMatches({ token }, token.replace(/.$/, (c) => (c === '0' ? '1' : '0'))), false);
  assert.equal(tokenMatches({ token: null }, ''), false);
  for (const bad of ['', 'nope', `${token.slice(0, -1)}z`, undefined]) {
    assert.equal(livechatMessage(db, { sessionId, token: bad, body: 'hi' }).status, 403);
    assert.equal(livechatRate(db, { sessionId, token: bad, rating: 5 }).status, 403);
    assert.equal(poll(db, { sessionId, token: bad ?? '' }).status, 403);
  }
  assert.equal(livechatMessage(db, { sessionId: sessionId + 99, token, body: 'hi' }).status, 403);
});

test('messages are limited to 2000 characters and polling returns only newer ones', () => {
  const { db, sessionId, token } = started();
  assert.equal(livechatMessage(db, { sessionId, token, body: 'x'.repeat(2001) }, T1).status, 400);
  assert.equal(livechatMessage(db, { sessionId, token, body: '' }, T1).status, 400);
  const sent = livechatMessage(db, { sessionId, token, body: 'Where is my order?' }, T1);
  assert.equal(sent.status, 200);
  assert.equal(poll(sent.db, { sessionId, token }).body.messages.length, 2);
  const newer = poll(sent.db, { sessionId, token, since: T0 }).body;
  assert.deepEqual(newer.messages.map((m) => [m.author, m.body]), [['visitor', 'Where is my order?']]);
  assert.equal(newer.stage, 'open');
  assert.equal(poll(sent.db, { sessionId, token, since: T1 }).body.messages.length, 0);
});

test('visitors rate their conversation once', () => {
  const { db, sessionId, token } = started();
  const rated = livechatRate(db, { sessionId, token, rating: 5, comment: 'Great' });
  assert.equal(rated.status, 200);
  assert.equal(read(rated.db, 'livechat.session', sessionId).rating, 5);
  assert.match(livechatRate(rated.db, { sessionId, token, rating: 4 }).body.error, /already rated/);
});
