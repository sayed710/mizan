import '../src/models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from '../src/orm.js';
import { queueMailing } from '../src/models/mailing.js';
import { deliverMailing, emailFor, linksOf, trackingResponse } from './mailtrack.js';
import { seed } from '../src/seed.js';

const queued = () => {
  const base = seed();
  const list = search(base, 'mailing.list')[0].id;
  const { db, id } = create(base, 'mailing.mailing', { subject: 'Hi {{object.name}}', list_id: list, body: 'Hello {{object.name}}, see https://shop.example/sale and https://shop.example/sale again.' });
  let n = 0;
  const next = queueMailing(db, read(db, 'mailing.mailing', id), { now: '2026-05-01', token: () => `tok-${String(++n).padStart(4, '0')}` });
  return { db: next, id, trace: search(next, 'mailing.trace').find((t) => t.mailing_id === id) };
};

test('each recipient gets a personalised email with tracked links, pixel and unsubscribe link', () => {
  const { db, id, trace } = queued();
  const mail = emailFor(db, read(db, 'mailing.mailing', id), trace, 'https://erp.example');
  assert.equal(mail.to, trace.email);
  assert.equal(mail.subject, `Hi ${trace.name}`);
  assert.match(mail.text, new RegExp(`Hello ${trace.name}`));
  assert.match(mail.text, /https:\/\/erp\.example\/api\/public\/mail\/click\/tok-\d{4}\/0/);
  assert.doesNotMatch(mail.text, /shop\.example/);
  assert.match(mail.html, /\/api\/public\/mail\/open\/tok-/);
  assert.match(mail.html, /unsubscribe\/tok-/);
  assert.deepEqual(linksOf('a https://x.example/1 b https://x.example/1 c http://y.example'), ['https://x.example/1', 'http://y.example']);
});

test('the pixel counts an open, a click redirects only to a link of the mailing, unknown tokens are refused', () => {
  const { db, id, trace } = queued();
  const opened = trackingResponse(db, `/api/public/mail/open/${trace.token}`);
  assert.equal(opened.headers['Content-Type'], 'image/gif');
  assert.equal(read(opened.db, 'mailing.mailing', id).opened, 1);
  const click = trackingResponse(opened.db, `/api/public/mail/click/${trace.token}/0`);
  assert.equal(click.status, 302);
  assert.equal(click.headers.Location, 'https://shop.example/sale');
  assert.equal(read(click.db, 'mailing.mailing', id).clicked, 1);
  assert.equal(trackingResponse(db, `/api/public/mail/click/${trace.token}/9`).status, 404);
  assert.equal(trackingResponse(db, '/api/public/mail/click/nope-nope-nope/0').status, 404);
  assert.equal(trackingResponse(db, '/api/public/mail/open/<script>'), null);
});

test('the unsubscribe link asks first (GET) and opts the contact out on POST, once', () => {
  const { db, trace } = queued();
  const ask = trackingResponse(db, `/api/public/mail/unsubscribe/${trace.token}`);
  assert.equal(ask.db, undefined);
  assert.match(ask.body, /method="post"/);
  const out = trackingResponse(db, `/api/public/mail/unsubscribe/${trace.token}`, '2026-05-02', 'POST');
  assert.equal(read(out.db, trace.res_model, trace.res_id).opt_out, true);
  assert.equal(trackingResponse(out.db, `/api/public/mail/unsubscribe/${trace.token}`, '2026-05-02', 'POST').db, out.db);
});

test('repeat opens change nothing, so nothing is saved', () => {
  const { db, trace } = queued();
  const once = trackingResponse(db, `/api/public/mail/open/${trace.token}`).db;
  assert.equal(trackingResponse(once, `/api/public/mail/open/${trace.token}`).db, once);
});

test('delivery commits the queue first and keeps changes made while emails go out', async () => {
  const base = seed();
  const list = search(base, 'mailing.list')[0].id;
  const { db: start, id } = create(base, 'mailing.mailing', { subject: 'Hi', list_id: list, body: 'Hello' });
  let current = start;
  const commits = [];
  const store = { get: () => current, commit: (next) => { commits.push(next); current = next; } };
  // An unreachable SMTP server: every email bounces after the queue is committed.
  const pending = deliverMailing({ host: '127.0.0.1', port: 9, from: 'a@x.example' }, store, id, 'https://erp.example');
  assert.equal(read(current, 'mailing.mailing', id).state, 'sent');
  const contact = search(current, 'mailing.contact').find((c) => !c.opt_out);
  current = { ...current, records: { ...current.records, 'mailing.contact': current.records['mailing.contact'].map((c) => (c.id === contact.id ? { ...c, phone: 'changed meanwhile' } : c)) } };
  const out = await pending;
  assert.equal(out.delivered, 0);
  assert.equal(read(current, 'mailing.mailing', id).bounced, out.sent);
  assert.equal(read(current, 'mailing.contact', contact.id).phone, 'changed meanwhile');
});
