import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from './orm.js';
import { handleInbound, markSms, normalizePhone, queueSms, smsRecipients, smsSegments } from './models/sms.js';
import { seed } from './seed.js';

test('segments: GSM-7 160/153, extension characters count twice, Unicode 70/67', () => {
  assert.deepEqual(smsSegments('a'.repeat(160)), { encoding: 'GSM-7', length: 160, segments: 1 });
  assert.deepEqual(smsSegments('a'.repeat(161)), { encoding: 'GSM-7', length: 161, segments: 2 });
  assert.equal(smsSegments('€'.repeat(80)).length, 160);
  assert.deepEqual(smsSegments('مرحبا'.repeat(14)), { encoding: 'Unicode', length: 70, segments: 1 });
  assert.equal(smsSegments('م'.repeat(71)).segments, 2);
  assert.equal(smsSegments('').segments, 0);
});

test('recipients: valid phones only, deduped after normalising, blacklist and opt-out respected', () => {
  const base = seed();
  const list = create(base, 'mailing.list', { name: 'SMS' });
  let db = list.db;
  for (const [name, phone, opt_out] of [['A', '+20 100 111 2222', false], ['B', '0020-100-111-2222', false], ['C', '12', false], ['D', '+20 100 999 0000', true], ['E', '+971 50 123 4567', false]]) {
    db = create(db, 'mailing.contact', { name, email: `${name}@x.example`, phone, list_id: list.id, opt_out }).db;
  }
  db = create(db, 'phone.blacklist', { number: '+971501234567', active: true }).db;
  assert.deepEqual(smsRecipients(db, { list_id: list.id }).map((r) => [r.name, r.phone]), [['A', '+201001112222']]);
  assert.equal(normalizePhone('00 20 (100) 111-2222'), '+201001112222');
});

test('queueing creates traces; delivery results move the counters once', () => {
  const base = seed();
  const list = create(base, 'mailing.list', { name: 'SMS' });
  const withContacts = create(create(list.db, 'mailing.contact', { name: 'A', email: 'a@x.example', phone: '+201001112222', list_id: list.id }).db, 'mailing.contact', { name: 'B', email: 'b@x.example', phone: '+201003334444', list_id: list.id }).db;
  const camp = create(withContacts, 'sms.campaign', { name: 'Promo', list_id: list.id, body: 'Sale!', stage_id: 'draft' });
  const queued = queueSms(camp.db, read(camp.db, 'sms.campaign', camp.id), { now: '2026-06-01' });
  const traces = search(queued, 'sms.trace').filter((t) => t.campaign_id === camp.id);
  assert.equal(traces.length, 2);
  const done = markSms(markSms(markSms(queued, traces[0].id, true), traces[1].id, false, 'Unreachable'), traces[0].id, false);
  const c = read(done, 'sms.campaign', camp.id);
  assert.deepEqual([c.stage_id, c.sent, c.delivered, c.failed], ['sent', 2, 1, 1]);
  assert.throws(() => queueSms(done, c), /already sent/);
  assert.throws(() => queueSms(camp.db, { ...read(camp.db, 'sms.campaign', camp.id), body: ' ' }), /content/);
});

test('a STOP reply blacklists the number once; other replies do nothing', () => {
  const db = seed();
  const once = handleInbound(db, '+20 100 111 2222', 'Stop please');
  assert.equal(search(once, 'phone.blacklist').length, 1);
  assert.equal(handleInbound(once, '+201001112222', 'STOP'), once);
  assert.equal(handleInbound(db, '+201001112222', 'thanks'), db);
});
