import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { read, search } from '../src/orm.js';
import { seed } from '../src/seed.js';
import { applyDiff, diffDb } from '../src/sync.js';
import { checkSignature, handleWebhook, verifyWebhook, WEBHOOK_WRITE } from './whatsapp.js';
import { sendWhatsApp } from './integrations.js';

const ENV = { MIZAN_WHATSAPP_VERIFY_TOKEN: 'verify-me', MIZAN_WHATSAPP_APP_SECRET: 'app-secret' };
const sign = (raw, secret = ENV.MIZAN_WHATSAPP_APP_SECRET) => `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
const params = (q) => new URLSearchParams(q);

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test('verification GET echoes the challenge only for the right token', () => {
  assert.deepEqual(verifyWebhook(ENV, params('hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=1158201444')), { status: 200, body: '1158201444' });
  assert.equal(verifyWebhook(ENV, params('hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1')).status, 403);
  assert.equal(verifyWebhook(ENV, params('hub.mode=unsubscribe&hub.verify_token=verify-me&hub.challenge=1')).status, 403);
  assert.equal(verifyWebhook({}, params('hub.mode=subscribe&hub.verify_token=&hub.challenge=1')).status, 403);
});

test('deliveries need a valid X-Hub-Signature-256 and a configured secret', () => {
  const raw = Buffer.from('{"entry":[]}');
  assert.equal(checkSignature(ENV, raw, sign(raw)), true);
  assert.equal(checkSignature(ENV, raw, sign(raw, 'other-secret')), false);
  assert.equal(checkSignature(ENV, Buffer.from('{"entry":[1]}'), sign(raw)), false);
  assert.equal(checkSignature(ENV, raw, undefined), false);
  assert.equal(checkSignature({}, raw, sign(raw)), false);
  assert.equal(handleWebhook(ENV, seed(), raw, 'sha256=00').status, 401);
  assert.equal(handleWebhook({}, seed(), raw, sign(raw)).status, 401);
});

test('a webhook with one message and one status is applied through the limited diff', () => {
  const db = seed();
  const out = search(db, 'whatsapp.message').find((m) => m.wa_message_id === 'seed-out-1');
  const before = { ...db, records: { ...db.records, 'whatsapp.message': db.records['whatsapp.message'].map((m) => (m.id === out.id ? { ...m, state: 'sent' } : m)) } };
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp',
      messages: [{ from: '201001234567', id: 'wamid.IN1', timestamp: '1790000000', type: 'text', text: { body: 'Is my desk ready?' } }],
      statuses: [{ id: 'seed-out-1', status: 'delivered', timestamp: '1790000001', recipient_id: '20223456789' }],
    } }] }],
  };
  const raw = Buffer.from(JSON.stringify(payload));
  const res = handleWebhook(ENV, before, raw, sign(raw));
  assert.equal(res.status, 200);
  const next = applyDiff(before, diffDb(before, res.db), WEBHOOK_WRITE);
  assert.equal(read(next, 'whatsapp.message', out.id).state, 'delivered');
  const incoming = search(next, 'whatsapp.message').find((m) => m.wa_message_id === 'wamid.IN1');
  assert.equal(incoming.body, 'Is my desk ready?');
  assert.equal(read(next, 'res.partner', incoming.partner_id).name, 'Sara Hassan');
  // Redelivery by Meta changes nothing.
  assert.equal(diffDb(next, handleWebhook(ENV, next, raw, sign(raw)).db).upserts['whatsapp.message'], undefined);
});

test('sending a template commits the queued message, then the API result', async () => {
  const bodies = [];
  globalThis.fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ messages: [{ id: 'wamid.OUT' }] }), { status: 200 });
  };
  let db = seed();
  const commits = [];
  const store = { get: () => db, commit: (next) => { commits.push(next); db = next; } };
  await sendWhatsApp({ MIZAN_WHATSAPP_TOKEN: 't', MIZAN_WHATSAPP_PHONE_ID: '1' }, store, { name: 'Admin' }, { model: 'sale.order', id: 1 });
  assert.equal(commits.length, 2);
  const msg = search(db, 'whatsapp.message').at(-1);
  assert.equal(search(commits[0], 'whatsapp.message').at(-1).state, 'queued');
  assert.deepEqual([msg.state, msg.wa_message_id], ['sent', 'wamid.OUT']);
  const order = read(db, 'sale.order', 1);
  assert.deepEqual(bodies[0].template, {
    name: 'order_confirmation', language: { code: 'en' },
    components: [{ type: 'body', parameters: ['Nile Furniture Co.', order.name, order.amount_total.toFixed(2)].map((text) => ({ type: 'text', text })) }],
  });
  globalThis.fetch = async () => new Response('{"error":"bad"}', { status: 400 });
  await assert.rejects(sendWhatsApp({ MIZAN_WHATSAPP_TOKEN: 't', MIZAN_WHATSAPP_PHONE_ID: '1' }, store, { name: 'Admin' }, { model: 'sale.order', id: 1 }), /failed/);
  assert.equal(search(db, 'whatsapp.message').at(-1).state, 'failed');
});

test('a server that lost the database lease queues the message but never sends it', async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; return new Response('{}', { status: 200 }); };
  let db = seed();
  const lost = new Error('Another Mizan server took over this database; this one stops writing');
  const store = { get: () => db, commit: (next) => { db = next; }, check: () => { throw lost; } };
  await assert.rejects(sendWhatsApp({ MIZAN_WHATSAPP_TOKEN: 't', MIZAN_WHATSAPP_PHONE_ID: '1' }, store, { name: 'Admin' }, { model: 'sale.order', id: 1 }), /failed|took over/);
  assert.equal(called, false);
});
