import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from '../src/orm.js';
import { markBounced, markSent, queueMailing } from '../src/models/mailing.js';
import { deliverMailing, emailFor, linksOf, resumeQueued, trackingResponse } from './mailtrack.js';
import { seed } from '../src/seed.js';
import net from 'node:net';

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

test('server-queued traces count as delivered only once sent, and a bounce of a queued trace does not undercount', () => {
  const base = seed();
  const { db: start, id } = create(base, 'mailing.mailing', { subject: 'Hi', list_id: search(base, 'mailing.list')[0].id, body: 'Hello' });
  const db = queueMailing(start, read(start, 'mailing.mailing', id), { queued: true });
  const [a, b] = search(db, 'mailing.trace').filter((t) => t.mailing_id === id);
  assert.equal(a.state, 'queued');
  assert.equal(read(db, 'mailing.mailing', id).delivered, 0);
  const sent = markSent(db, a.token);
  assert.equal(read(sent, 'mailing.trace', a.id).state, 'sent');
  assert.equal(markSent(sent, a.token), sent);
  const bounced = markBounced(sent, b.token);
  assert.deepEqual([read(bounced, 'mailing.mailing', id).delivered, read(bounced, 'mailing.mailing', id).bounced], [1, 1]);
});

test('resume sends traces left queued by an interrupted delivery', async () => {
  const base = seed();
  const { db: start, id } = create(base, 'mailing.mailing', { subject: 'Hi', list_id: search(base, 'mailing.list')[0].id, body: 'Hello' });
  let current = queueMailing(start, read(start, 'mailing.mailing', id), { queued: true });
  const store = { get: () => current, commit: (next) => { current = next; } };
  const delivered = await resumeQueued({ host: '127.0.0.1', port: 9, from: 'a@x.example' }, store, 'https://erp.example');
  assert.equal(delivered, 0);
  assert.equal(search(current, 'mailing.trace').filter((t) => t.state === 'queued').length, 0);
  assert.equal(read(current, 'mailing.mailing', id).delivered, 0);
});

test('engagement before SMTP completion counts delivery exactly once and preserves engagement', () => {
  // Use an actual server-queued mailing so delivery starts at zero.
  const mailing = create(seed(), 'mailing.mailing', { subject: 'Pending', list_id: 1, body: 'Hello' });
  const db = queueMailing(mailing.db, read(mailing.db, 'mailing.mailing', mailing.id), { queued: true });
  const trace = search(db, 'mailing.trace').find((t) => t.mailing_id === mailing.id);
  const opened = trackingResponse(db, `/api/public/mail/open/${trace.token}`).db;
  const sent = markSent(opened, trace.token);
  assert.equal(read(sent, 'mailing.mailing', mailing.id).delivered, 1);
  assert.equal(read(sent, 'mailing.trace', trace.id).state, 'opened');
  assert.equal(markSent(sent, trace.token), sent);
});

test('a bounce of an engaged but undelivered trace does not decrement another delivery', () => {
  const mailing = create(seed(), 'mailing.mailing', { subject: 'Pending', list_id: 1, body: 'Hello' });
  const db = queueMailing(mailing.db, read(mailing.db, 'mailing.mailing', mailing.id), { queued: true });
  const [a, b] = search(db, 'mailing.trace').filter((t) => t.mailing_id === mailing.id);
  const sent = markSent(db, a.token);
  const opened = trackingResponse(sent, `/api/public/mail/open/${b.token}`).db;
  const bounced = markBounced(opened, b.token);
  assert.equal(read(bounced, 'mailing.mailing', mailing.id).delivered, 1);
});

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
async function smtpFixture(t, accept = async () => {}) {
  let count = 0;
  const server = net.createServer((socket) => {
    socket.write('220 test SMTP\r\n');
    let buffer = '', data = false;
    socket.on('data', (bytes) => {
      buffer += bytes;
      let end;
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (data) {
          if (line === '.') { data = false; const n = ++count; Promise.resolve(accept(n)).then(() => socket.write('250 queued\r\n')); }
        } else if (line.startsWith('EHLO')) socket.write('250 test\r\n');
        else if (line.startsWith('MAIL') || line.startsWith('RCPT')) socket.write('250 ok\r\n');
        else if (line === 'DATA') { data = true; socket.write('354 go\r\n'); }
        else if (line === 'QUIT') socket.end('221 bye\r\n');
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { cfg: { host: '127.0.0.1', port: server.address().port, from: 'test@example.test' }, count: () => count };
}
function pendingStore() {
  const mailing = create(seed(), 'mailing.mailing', { subject: 'Pending', list_id: 1, body: 'Hello' });
  let db = queueMailing(mailing.db, read(mailing.db, 'mailing.mailing', mailing.id), { queued: true });
  const traces = search(db, 'mailing.trace').filter((t) => t.mailing_id === mailing.id).slice(0, 2);
  db = { ...db, records: { ...db.records, 'mailing.trace': traces } };
  return { traces, store: { get: () => db, commit: (next) => { db = next; } } };
}

test('overlapping resume loops claim each trace immediately before SMTP', async (t) => {
  const first = deferred(), second = deferred(), releaseFirst = deferred(), releaseSecond = deferred();
  const smtp = await smtpFixture(t, async (n) => { if (n === 1) { first.resolve(); await releaseFirst.promise; } if (n === 2) { second.resolve(); await releaseSecond.promise; } });
  const { store } = pendingStore();
  const a = resumeQueued(smtp.cfg, store, 'https://erp.example');
  await first.promise;
  const b = resumeQueued(smtp.cfg, store, 'https://erp.example');
  await second.promise;
  releaseFirst.resolve();
  await a;
  releaseSecond.resolve();
  await b;
  assert.equal(smtp.count(), 2);
});

test('resume rechecks a cancelled trace after waiting for another SMTP attempt', async (t) => {
  const first = deferred(), release = deferred();
  const smtp = await smtpFixture(t, async (n) => { if (n === 1) { first.resolve(); await release.promise; } });
  const { store, traces } = pendingStore();
  const pending = resumeQueued(smtp.cfg, store, 'https://erp.example');
  await first.promise;
  store.commit(write(store.get(), 'mailing.trace', traces[1].id, { state: 'cancel' }));
  release.resolve();
  await pending;
  assert.equal(smtp.count(), 1);
  assert.equal(read(store.get(), 'mailing.trace', traces[1].id).state, 'cancel');
});

test('post-SMTP persistence failure is surfaced and does not mark accepted mail bounced', async (t) => {
  const smtp = await smtpFixture(t);
  const { store, traces } = pendingStore();
  const commit = store.commit;
  let failed = false;
  store.commit = (next) => { if (!failed) { failed = true; throw new Error('Database unavailable'); } commit(next); };
  await assert.rejects(resumeQueued(smtp.cfg, store, 'https://erp.example'), /Database unavailable/);
  assert.equal(read(store.get(), 'mailing.trace', traces[0].id).state, 'queued');
  assert.equal(read(store.get(), 'mailing.mailing', traces[0].mailing_id).bounced, 0);
});
