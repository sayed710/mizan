import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { create, read, search, write } from '../src/orm.js';
import { seed } from '../src/seed.js';
import { sendDocument, sendMailing } from './mail.js';

/** Minimal SMTP server accepting every message; resolves with what it received. */
function fakeSmtp() {
  const seen = [];
  const server = net.createServer((s) => {
    s.write('220 fake\r\n');
    let inData = false;
    let buf = '';
    s.on('data', (d) => {
      buf += d.toString();
      for (let i; (i = buf.indexOf('\r\n')) >= 0;) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) { if (line === '.') { inData = false; s.write('250 queued\r\n'); } else seen.push(line); continue; }
        seen.push(line);
        if (line.startsWith('EHLO')) s.write('250 fake\r\n');
        else if (line.startsWith('MAIL') || line.startsWith('RCPT')) s.write('250 ok\r\n');
        else if (line === 'DATA') { inData = true; s.write('354 go\r\n'); } else if (line === 'QUIT') { s.write('221 bye\r\n'); s.end(); }
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, cfg: { host: '127.0.0.1', port: server.address().port, from: 'erp@mizan.example' } })));
}

const admin = { name: 'Admin', isAdmin: true };

test('documents that cannot be emailed, missing records and partners without email are refused', async () => {
  const db = seed();
  assert.equal((await sendDocument({}, db, admin, { model: 'crm.lead', id: 1 })).status, 400);
  assert.equal((await sendDocument({}, db, admin, { model: 'sale.order', id: 99999 })).status, 404);
  const partner = create(db, 'res.partner', { name: 'No Mail' });
  const order = create(partner.db, 'sale.order', { partner_id: partner.id, order_line: [] });
  const out = await sendDocument({}, order.db, admin, { model: 'sale.order', id: order.id });
  assert.deepEqual([out.status, out.body.error], [400, 'The customer has no email address']);
});

test('a draft quotation is emailed to its customer, marked sent and noted in the chatter', async () => {
  const { server, seen, cfg } = await fakeSmtp();
  const base = seed();
  const partner = create(base, 'res.partner', { name: 'Mail Client', email: 'client@example.com' });
  const order = create(partner.db, 'sale.order', { partner_id: partner.id, order_line: [{ product_id: 1, qty: 2, price_unit: 50, tax: 0 }] });
  const out = await sendDocument(cfg, order.db, admin, { model: 'sale.order', id: order.id });
  server.close();
  assert.equal(out.status, 200);
  assert.ok(seen.includes('RCPT TO:<client@example.com>'));
  assert.ok(seen.some((l) => l.includes('Total:')));
  assert.equal(read(out.db, 'sale.order', order.id).state, 'sent');
  assert.ok(out.db.messages.some((m) => m.res_id === order.id && /Sent by email to client@example.com/.test(m.body)));
});

test('a mailing that does not exist or was already sent is refused', async () => {
  const db = seed();
  const store = { get: () => db, commit: () => assert.fail('nothing to commit') };
  assert.equal((await sendMailing({}, store, { id: 99999 }, 'https://erp.example')).status, 404);
  const { db: withMailing, id } = create(db, 'mailing.mailing', { subject: 'Hi', list_id: search(db, 'mailing.list')[0].id, body: 'Hello' });
  const sent = write(withMailing, 'mailing.mailing', id, { state: 'sent' });
  const out = await sendMailing({}, { get: () => sent, commit: () => {} }, { id }, 'https://erp.example');
  assert.deepEqual([out.status, out.body.error], [400, 'Already sent']);
});

test('a document with a custom nonstandard currency name formats safely and sends email', async () => {
  const { server, seen, cfg } = await fakeSmtp();
  try {
    const base = seed();
    const customCurr = create(base, 'res.currency', { name: 'CUSTOM-COIN' });
    const partner = create(customCurr.db, 'res.partner', { name: 'Custom Coin Partner', email: 'custom@example.com' });
    const order = create(partner.db, 'sale.order', { partner_id: partner.id, currency_id: customCurr.id, order_line: [{ product_id: 1, qty: 2, price_unit: 50, tax: 0 }] });
    const out = await sendDocument(cfg, order.db, admin, { model: 'sale.order', id: order.id });
    assert.equal(out.status, 200);
    assert.ok(seen.includes('RCPT TO:<custom@example.com>'));
    assert.ok(seen.some((l) => l.includes('CUSTOM-COIN')));
  } finally {
    server.close();
  }
});

test('a request with a forged Host header does not persist mail_base_url for future mailings', async () => {
  const { server, cfg } = await fakeSmtp();
  const dir = mkdtempSync(join(tmpdir(), 'mizan-mail-'));
  const dbPath = join(dir, 'test.sqlite');
  const password = 'test-admin-password';
  const child = spawn(process.execPath, ['server/index.js'], {
    env: {
      ...process.env,
      PORT: '0',
      MIZAN_DB: dbPath,
      MIZAN_ADMIN_PASSWORD: password,
      MIZAN_SMTP_HOST: cfg.host,
      MIZAN_SMTP_PORT: String(cfg.port),
      MIZAN_SMTP_FROM: cfg.from,
      MIZAN_PUBLIC_URL: '',
      MIZAN_SECURE_COOKIE: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  try {
    const origin = await new Promise((resolve, reject) => {
      let out = '';
      child.stdout.on('data', (b) => { out += b; const m = /Mizan listening on (http:\/\/localhost:\d+)/.exec(out); if (m) resolve(m[1]); });
      child.on('exit', (code) => reject(new Error(`server exited ${code}: ${out}`)));
    });
    const loginRes = await fetch(`${origin}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mizan' },
      body: JSON.stringify({ login: 'admin', password }),
    });
    const cookie = loginRes.headers.get('set-cookie')?.split(';')[0];
    assert.equal(loginRes.status, 200);

    const port = Number(new URL(origin).port);
    const bodyStr = JSON.stringify({ id: 99999 });
    await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/api/mail/mailing',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
          'X-Requested-With': 'mizan',
          Cookie: cookie,
          Host: 'evil.attacker.com',
        },
      }, (res) => {
        res.resume();
        res.on('end', resolve);
      });
      req.on('error', reject);
      req.end(bodyStr);
    });

    const sql = new DatabaseSync(dbPath, { readOnly: true });
    const saved = sql.prepare("SELECT value FROM kv WHERE key = 'mail_base_url'").get()?.value;
    sql.close();
    assert.equal(saved, undefined, 'mail_base_url should not be persisted from request Host header');
  } finally {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.send('shutdown'); await exited; }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    server.close();
  }
});


