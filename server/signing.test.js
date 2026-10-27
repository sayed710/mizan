import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { create, read, write } from '../src/orm.js';
import { seed } from '../src/seed.js';
import { addDays, today } from '../src/models/common.js';
import { requestFromTemplate, sendRequest } from '../src/models/signplus.js';
import { readRaw } from './whatsapp.js';
import { createSigning, remindSigners, sendSignRequest } from './signing.js';

const draft = () => {
  const base = write(write(seed(), 'res.partner', 1, { email: 'buyer@example.com' }), 'res.partner', 2, { email: 'staff@example.com' });
  const template = create(base, 'sign.template', { name: 'Agreement', item_ids: [{ type: 'signature', role: 'customer', page: 1, required: true }, { type: 'date', role: 'customer', page: 1, required: true }] });
  return requestFromTemplate(template.db, template.id, { signers: [{ role: 'customer', partner_id: 1 }], deadline: addDays(today(), 30) });
};

async function server(t, db) {
  const state = { db };
  const handle = createSigning({ getDb: () => state.db, commitDb: (next) => { state.db = next; }, clientIp: () => '203.0.113.9', tooMany: () => false, recordFailure: () => {}, readRaw, securityHeaders: {} });
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
  const sent = await sendSignRequest({}, db, { id }, 'https://erp.example', async (cfg, m) => mails.push(m));
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
  const reminded = await remindSigners({}, sent, { id }, 'https://erp.example', async (cfg, m) => mails.push(m));
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
  await assert.rejects(sendSignRequest({}, noMail, { id }, 'https://erp.example', async () => {}), /Add an email address/);
});
