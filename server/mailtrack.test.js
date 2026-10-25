import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from '../src/orm.js';
import { queueMailing } from '../src/models/mailing.js';
import { emailFor, linksOf, trackingResponse } from './mailtrack.js';
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

test('the unsubscribe link opts the contact out', () => {
  const { db, trace } = queued();
  const out = trackingResponse(db, `/api/public/mail/unsubscribe/${trace.token}`);
  assert.equal(out.status, 200);
  assert.equal(read(out.db, trace.res_model, trace.res_id).opt_out, true);
});
