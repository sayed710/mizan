import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { applyDiff, diffDb } from './sync.js';
import { applyStatus, canSendFreeText, markWhatsApp, queueWhatsApp, receiveMessage, renderWhatsApp, whatsappPhone } from './models/whatsapp.js';

const NOW = '2026-10-25T12:00:00.000Z';
const template = (db) => search(db, 'whatsapp.template').find((t) => t.name === 'order_confirmation');
const hoursBefore = (h) => new Date(Date.parse(NOW) - h * 3600 * 1000).toISOString();
/** Seed without the demo conversation, so the 24-hour window is decided by each test. */
const quiet = () => {
  const db = seed();
  return { ...db, records: { ...db.records, 'whatsapp.message': [] } };
};

test('rendering fills placeholders through dotted field paths', () => {
  const db = seed();
  const order = read(db, 'sale.order', 1);
  const out = renderWhatsApp(db, template(db), order);
  assert.equal(out.body, `Hello Nile Furniture Co., your order ${order.name} of ${order.amount_total.toFixed(2)} is confirmed.`);
  assert.deepEqual(out.values, ['Nile Furniture Co.', order.name, order.amount_total.toFixed(2)]);
});

test('rendering refuses missing values and caps the body at 1024 characters', () => {
  const db = seed();
  const order = read(db, 'sale.order', 1);
  assert.throws(() => renderWhatsApp(db, { ...template(db), variables: [] }, order), /No value for \{\{1\}\}/);
  assert.throws(() => renderWhatsApp(db, template(db), { ...order, partner_id: null }), /partner_id\.name/);
  const long = renderWhatsApp(db, { ...template(db), body: `${'x'.repeat(2000)} {{2}}` }, order);
  assert.equal(long.body.length, 1024);
});

test('phones are normalized to E.164 digits and local numbers are refused', () => {
  assert.equal(whatsappPhone('+20 100 123-4567'), '201001234567');
  assert.equal(whatsappPhone('0020 100 123 4567'), '201001234567');
  assert.equal(whatsappPhone('0100 123 4567'), '');
  assert.equal(whatsappPhone(''), '');
  const db = write(quiet(), 'res.partner', 1, { phone: '' });
  assert.throws(() => queueWhatsApp(db, { templateId: template(db).id, model: 'sale.order', id: 1, now: NOW }), /no international phone/);
});

test('templates must be approved and match the document model', () => {
  const db = quiet();
  const tpl = template(db);
  const pending = write(db, 'whatsapp.template', tpl.id, { status: 'pending' });
  assert.throws(() => queueWhatsApp(pending, { templateId: tpl.id, model: 'sale.order', id: 1, now: NOW }), /not approved/);
  assert.throws(() => queueWhatsApp(db, { templateId: tpl.id, model: 'res.partner', id: 1, now: NOW }), /not for this kind/);
  const out = queueWhatsApp(db, { templateId: tpl.id, model: 'sale.order', id: 1, now: NOW });
  const msg = read(out.db, 'whatsapp.message', out.id);
  assert.deepEqual([msg.state, msg.direction, msg.phone, msg.partner_id, msg.res_model, msg.res_id], ['queued', 'outgoing', '20223456789', 1, 'sale.order', 1]);
  assert.match(out.db.messages.at(-1).body, /WhatsApp to \+20223456789: Hello Nile/);
  assert.equal(out.db.messages.at(-1).model, 'sale.order');
});

test('free text is only allowed within 24 hours of the last incoming message', () => {
  const db = quiet();
  assert.equal(canSendFreeText(db, '20223456789', NOW), false);
  assert.throws(() => queueWhatsApp(db, { text: 'Hi', model: 'res.partner', id: 1, now: NOW }), /24 hours/);
  const recent = receiveMessage(db, { from: '20223456789', text: 'Hello?', id: 'in-1', timestamp: String(Date.parse(hoursBefore(23)) / 1000) });
  assert.equal(canSendFreeText(recent, '+20223456789', NOW), true);
  const reply = queueWhatsApp(recent, { text: 'Hi', model: 'res.partner', id: 1, now: NOW });
  assert.equal(read(reply.db, 'whatsapp.message', reply.id).body, 'Hi');
  const old = receiveMessage(db, { from: '20223456789', text: 'Hello?', id: 'in-2', timestamp: String(Date.parse(hoursBefore(25)) / 1000) });
  assert.equal(canSendFreeText(old, '20223456789', NOW), false);
});

test('statuses only move forward, failed from any state', () => {
  const queued = queueWhatsApp(quiet(), { templateId: 1, model: 'sale.order', id: 1, now: NOW });
  let db = markWhatsApp(queued.db, queued.id, { waMessageId: 'wamid.1' });
  const state = () => read(db, 'whatsapp.message', queued.id).state;
  assert.equal(state(), 'sent');
  db = applyStatus(db, 'wamid.1', 'read');
  assert.equal(state(), 'read');
  assert.equal(applyStatus(db, 'wamid.1', 'delivered'), db);
  assert.equal(applyStatus(db, 'unknown', 'delivered'), db);
  db = applyStatus(db, 'wamid.1', 'failed', { error: 'Re-engagement message' });
  assert.deepEqual([state(), read(db, 'whatsapp.message', queued.id).error], ['failed', 'Re-engagement message']);
  const failed = markWhatsApp(queued.db, queued.id, { error: 'timeout' });
  assert.equal(read(failed, 'whatsapp.message', queued.id).state, 'failed');
});

test('incoming messages link to the contact and are stored once', () => {
  const db = quiet();
  const once = receiveMessage(db, { from: '201001234567', text: 'Is my desk ready?', id: 'wamid.in', timestamp: '1790000000' });
  const twice = receiveMessage(once, { from: '201001234567', text: 'Is my desk ready?', id: 'wamid.in', timestamp: '1790000000' });
  assert.equal(twice, once);
  const msgs = search(once, 'whatsapp.message');
  assert.equal(msgs.length, 1);
  const sara = search(db, 'res.partner').find((p) => p.name === 'Sara Hassan');
  assert.deepEqual([msgs[0].partner_id, msgs[0].direction, msgs[0].state, msgs[0].date], [sara.id, 'incoming', 'received', new Date(1790000000 * 1000).toISOString()]);
  const stranger = receiveMessage(db, { from: '15550001111', text: 'hi', id: 'wamid.x', timestamp: '1790000000' });
  assert.equal(search(stranger, 'whatsapp.message')[0].partner_id, null);
});

test('only administrators approve templates when synced', () => {
  const db = seed();
  const draft = create(db, 'whatsapp.template', { name: 'promo', model: 'res.partner', body: 'Hi {{1}}', variables: [{ index: 1, field: 'name' }] });
  const submitted = write(draft.db, 'whatsapp.template', draft.id, { status: 'pending' });
  const approved = write(submitted, 'whatsapp.template', draft.id, { status: 'approved' });
  const user = { author: 'Sam', isAdmin: false };
  assert.doesNotThrow(() => applyDiff(db, diffDb(db, submitted), user));
  const base = applyDiff(db, diffDb(db, submitted), user);
  assert.throws(() => applyDiff(base, diffDb(submitted, approved), user), /Only administrators/);
  assert.equal(read(applyDiff(base, diffDb(submitted, approved), { author: 'Admin', isAdmin: true }), 'whatsapp.template', draft.id).status, 'approved');
  const edited = write(submitted, 'whatsapp.template', draft.id, { body: 'Changed' });
  assert.throws(() => applyDiff(base, diffDb(submitted, edited), user), /cannot be edited/);
});
