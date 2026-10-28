import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { create, postNote, read, write } from '../src/orm.js';
import { seed } from '../src/seed.js';
import { addDays, today } from '../src/models/common.js';
import { requestFromTemplate, sendRequest } from '../src/models/signplus.js';
import { readRaw } from './whatsapp.js';
import { createSigning, publicOrigin, remindSigners, sendSignRequest } from './signing.js';

const draft = () => {
  const base = write(write(seed(), 'res.partner', 1, { email: 'buyer@example.com' }), 'res.partner', 2, { email: 'staff@example.com' });
  const template = create(base, 'sign.template', { name: 'Agreement', item_ids: [{ type: 'signature', role: 'customer', page: 1, required: true }, { type: 'date', role: 'customer', page: 1, required: true }] });
  return requestFromTemplate(template.db, template.id, { signers: [{ role: 'customer', partner_id: 1 }], deadline: addDays(today(), 30) });
};

const storeOf = (db) => {
  const store = { db, get: () => store.db, commit: (next) => { store.db = next; } };
  return store;
};

async function server(t, db, { getDb } = {}) {
  const state = { db };
  const handle = createSigning({ getDb: getDb ? () => getDb(state) : () => state.db, commitDb: (next) => { state.db = next; }, clientIp: () => '203.0.113.9', tooMany: () => false, recordFailure: () => {}, readRaw, securityHeaders: {} });
  const srv = createServer(async (req, res) => { if (!await handle(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  t.after(() => new Promise((ok) => srv.close(ok)));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = (path, { body, headers = {} } = {}) => new Promise((ok, fail) => {
    const req = request(base + path, { method: body == null ? 'GET' : 'POST', headers: body == null ? headers : { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => ok({ status: res.statusCode, location: res.headers.location, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', fail);
    req.end(body);
  });
  return { state, call };
}

test('sending emails each signer their private link and the signer signs through it', async (t) => {
  const { db, id } = draft();
  const mails = [];
  const store = storeOf(db);
  await sendSignRequest({}, store, { id }, 'https://erp.example', async (cfg, m) => mails.push(m));
  const sent = { db: store.db };
  const r = read(sent.db, 'sign.request', id);
  assert.equal(r.state, 'sent');
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, 'buyer@example.com');
  assert.ok(mails[0].text.includes(`https://erp.example/sign/${id}/${r.signer_ids[0].token}`));
  const { state, call } = await server(t, sent.db);
  const link = `/sign/${id}/${r.signer_ids[0].token}`;
  const pageRes = await call(link);
  assert.equal(pageRes.status, 200);
  assert.match(pageRes.text, /Your full name/);
  assert.equal((await call(`/sign/${id}/${'f'.repeat(64)}`)).status, 404);
  assert.equal((await call(`${link}/sign`, { body: `name=Buyer&agree=1&item_1=${today()}`, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  const missingAgree = await call(`${link}/sign`, { body: `name=Buyer&item_1=${today()}` });
  assert.match(decodeURIComponent(missingAgree.location), /accept the electronic signature/);
  assert.equal(read(state.db, 'sign.request', id).state, 'sent');
  const done = await call(`${link}/sign`, { body: `name=Jane+Buyer&agree=1&item_1=${today()}` });
  assert.equal(done.status, 303);
  const signed = read(state.db, 'sign.request', id);
  assert.equal(signed.state, 'signed');
  assert.equal(signed.signer_ids[0].signature, 'Jane Buyer');
  assert.ok(state.db.messages.some((m) => m.res_id === id && m.body.includes('through their signing link (IP 203.0.113.9)')));
});

test('a signer can refuse through the link, and reminders reach only unsigned signers', async (t) => {
  const { db, id } = draft();
  const { db: sent } = sendRequest(db, read(db, 'sign.request', id));
  const mails = [];
  const remindStore = storeOf(sent);
  await remindSigners({}, remindStore, { id }, 'https://erp.example', async (cfg, m) => mails.push(m));
  const reminded = { db: remindStore.db };
  assert.equal(mails.length, 1);
  assert.equal(read(reminded.db, 'sign.request', id).last_reminder_date, today());
  assert.ok(reminded.db.messages.some((m) => m.res_id === id && m.body === 'Signature reminder emailed to buyer@example.com'));
  const { state, call } = await server(t, sent);
  const token = read(sent, 'sign.request', id).signer_ids[0].token;
  await call(`/sign/${id}/${token}/refuse`, { body: 'reason=Wrong+price' });
  assert.equal(read(state.db, 'sign.request', id).state, 'refused');
  assert.equal(read(state.db, 'sign.request', id).refusal_reason, 'Wrong price');
});

test('sending needs an email address for every signer', async () => {
  const { db, id } = draft();
  const noMail = write(db, 'res.partner', 1, { email: '' });
  await assert.rejects(sendSignRequest({}, storeOf(noMail), { id }, 'https://erp.example', async () => {}), /Add an email address/);
});

test('the sent state and tokens are saved before emailing, so a failing mailbox never leaves dead links', async () => {
  const { db, id } = draft();
  const withTwo = write(db, 'sign.request', id, { signer_ids: [...read(db, 'sign.request', id).signer_ids, { partner_id: 2, role: 'employee', token: 'x'.repeat(40) }] });
  const store = storeOf(withTwo);
  const mails = [];
  const deliver = async (cfg, m) => { if (m.to === 'staff@example.com') throw new Error('mailbox full'); mails.push(m); };
  await assert.rejects(sendSignRequest({}, store, { id }, 'https://erp.example', deliver), /1 email\(s\) failed: staff@example.com/);
  const r = read(store.db, 'sign.request', id);
  assert.equal(r.state, 'sent');
  assert.ok(mails[0].text.includes(`/sign/${id}/${r.signer_ids[0].token}`)); // the emailed link is the saved one
  assert.ok(store.db.messages.some((m) => m.res_id === id && /could not email staff@example.com/.test(m.body)));
});

test('a delivery that finishes after someone cancelled the request does not bring it back', async () => {
  const { db, id } = draft();
  const store = storeOf(db);
  const deliver = async () => { store.db = write(store.db, 'sign.request', id, { state: 'canceled' }); };
  const live = { commit: (next) => { store.db = next; }, get: () => store.db };
  await sendSignRequest({}, live, { id }, 'https://erp.example', deliver).catch(() => {});
  assert.equal(read(store.db, 'sign.request', id).state, 'canceled');
});

test('reminders are not sent after the deadline', async () => {
  const { db, id } = draft();
  const { db: sent } = sendRequest(db, read(db, 'sign.request', id));
  const late = write(sent, 'sign.request', id, { deadline: addDays(today(), -1) });
  const mails = [];
  await assert.rejects(remindSigners({}, storeOf(late), { id }, 'https://erp.example', async (cfg, m) => mails.push(m)), /deadline has passed/);
  assert.equal(mails.length, 0);
});

test('the signing page shows the document text and a token-protected attachment', async (t) => {
  const { db, id } = draft();
  const file = { name: 'contract.pdf', type: 'application/pdf', size: 4, data: `data:application/pdf;base64,${Buffer.from('%PDF').toString('base64')}` };
  const { db: sent } = sendRequest(write(write(db, 'sign.request', id, { body: 'Terms <b>apply</b>\nSecond line' }), 'sign.request', id, { attachment: file }), read(db, 'sign.request', id));
  const { call } = await server(t, sent);
  const token = read(sent, 'sign.request', id).signer_ids[0].token;
  const page = await call(`/sign/${id}/${token}`);
  assert.match(page.text, /Terms &lt;b&gt;apply&lt;\/b&gt;\nSecond line/);
  assert.match(page.text, new RegExp(`/sign/${id}/${token}/document`));
  const doc = await call(`/sign/${id}/${token}/document`);
  assert.equal(doc.status, 200);
  assert.equal(doc.text, '%PDF');
  assert.equal((await call(`/sign/${id}/${'f'.repeat(64)}/document`)).status, 404);
  assert.equal((await call(`/sign/${id}/${token}/document`, { body: 'x=1' })).status, 404); // GET only
});

test('a signature is applied to the database as it is when the body arrives, so concurrent changes survive', async (t) => {
  const { db, id } = draft();
  const { db: sent } = sendRequest(db, read(db, 'sign.request', id));
  const token = read(sent, 'sign.request', id).signer_ids[0].token;
  let calls = 0;
  // The first look (before the body is read) sees the old database; later looks see a note added in between.
  const newer = postNote(sent, 'sign.request', id, 'Edited while the signer typed');
  const { state, call } = await server(t, sent, { getDb: (s) => { calls += 1; if (calls > 1) s.db = newer; return s.db; } });
  await call(`/sign/${id}/${token}/sign`, { body: `name=Jane+Buyer&agree=1&item_1=${today()}` });
  assert.equal(read(state.db, 'sign.request', id).state, 'signed');
  assert.ok(state.db.messages.some((m) => m.body === 'Edited while the signer typed'));
});

test('signing links are built only on the configured public address', () => {
  assert.throws(() => publicOrigin({}), /MIZAN_PUBLIC_URL/);
  assert.throws(() => publicOrigin({ MIZAN_PUBLIC_URL: 'javascript:alert(1)' }), /MIZAN_PUBLIC_URL/);
  assert.equal(publicOrigin({ MIZAN_PUBLIC_URL: 'https://erp.example.com/' }), 'https://erp.example.com');
  assert.equal(publicOrigin({ MIZAN_PUBLIC_URL: 'https://erp.example.com/app/' }), 'https://erp.example.com/app');
});
