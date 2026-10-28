// REST creates honour Idempotency-Key: a retry returns the first record instead of creating another.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

async function startServer() {
  const dir = mkdtempSync(join(tmpdir(), 'mizan-idem-'));
  const proc = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: '0', MIZAN_DB: join(dir, 'db.sqlite'), MIZAN_ADMIN_PASSWORD: 'idem-test-pass-1', NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const port = await new Promise((ok, fail) => {
    let output = '';
    proc.on('message', (msg) => {
      if (msg?.type === 'ready' && msg.port > 0) ok(Number(msg.port));
    });
    proc.stdout.on('data', (d) => {
      output += d;
      const m = /Mizan listening on http:\/\/(?:localhost|127\.0\.0\.1):([1-9]\d*)/.exec(output);
      if (m) ok(Number(m[1]));
    });
    proc.stderr.on('data', (d) => { output += d; });
    proc.on('error', fail);
    proc.on('exit', (code) => fail(new Error(`server exited ${code}: ${output}`)));
  });
  return { base: `http://127.0.0.1:${port}`, dbPath: join(dir, 'db.sqlite'), stop: async () => {
    proc.send('shutdown');
    await new Promise((ok) => (proc.exitCode !== null ? ok() : proc.once('exit', ok)));
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } };
}

test('a retried POST with the same Idempotency-Key creates one record', async (t) => {
  const { base, stop } = await startServer();
  t.after(stop);
  const json = { 'Content-Type': 'application/json', 'X-Requested-With': 'mizan' };
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: json, body: JSON.stringify({ login: 'admin', password: 'idem-test-pass-1' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const { key } = await (await fetch(`${base}/api/keys`, { method: 'POST', headers: { ...json, Cookie: cookie }, body: JSON.stringify({ name: 'test' }) })).json();
  const post = (idem, model = 'crm.lead') => fetch(`${base}/api/v1/${model}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(idem ? { 'Idempotency-Key': idem } : {}) },
    body: JSON.stringify({ name: 'Retry lead' }),
  });
  const first = await post('order-42');
  assert.equal(first.status, 201);
  const again = await post('order-42');
  assert.equal(again.status, 200);
  assert.equal((await again.json()).id, (await first.json()).id);
  assert.equal((await post('order-42', 'res.partner')).status, 422);
  assert.equal((await post(null)).status, 201);
  const list = await (await fetch(`${base}/api/v1/crm.lead?q=Retry`, { headers: { Authorization: `Bearer ${key}` } })).json();
  assert.equal(list.total, 2);
});

test('idempotency keys reject oversized keys and non-collection routes, and replay the original response', async (t) => {
  const { base, stop } = await startServer();
  t.after(stop);
  const json = { 'Content-Type': 'application/json', 'X-Requested-With': 'mizan' };
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: json, body: JSON.stringify({ login: 'admin', password: 'idem-test-pass-1' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const { key } = await (await fetch(`${base}/api/keys`, { method: 'POST', headers: { ...json, Cookie: cookie }, body: JSON.stringify({ name: 'test' }) })).json();
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const post = (idem, suffix = '') => fetch(`${base}/api/v1/crm.lead${suffix}`, { method: 'POST', headers: { ...headers, 'Idempotency-Key': idem }, body: JSON.stringify({ name: 'Original lead' }) });
  assert.equal((await post('x'.repeat(201))).status, 400);
  const first = await (await post('snapshot')).json();
  assert.equal((await post('snapshot', `/${first.id}`)).status, 404);
  await fetch(`${base}/api/v1/crm.lead/${first.id}`, { method: 'PATCH', headers, body: JSON.stringify({ name: 'Changed' }) });
  assert.deepEqual(await (await post('snapshot')).json(), first);
  await fetch(`${base}/api/v1/crm.lead/${first.id}`, { method: 'DELETE', headers });
  assert.deepEqual(await (await post('snapshot')).json(), first);
});

test('a failed idempotency insert rolls back the record and a retry creates exactly one', async (t) => {
  const { base, dbPath, stop } = await startServer();
  let sql;
  t.after(async () => { sql?.close(); await stop(); });
  const json = { 'Content-Type': 'application/json', 'X-Requested-With': 'mizan' };
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: json, body: JSON.stringify({ login: 'admin', password: 'idem-test-pass-1' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const { key } = await (await fetch(`${base}/api/keys`, { method: 'POST', headers: { ...json, Cookie: cookie }, body: JSON.stringify({ name: 'test' }) })).json();
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'atomic' };
  sql = new DatabaseSync(dbPath);
  sql.exec("CREATE TRIGGER reject_idem BEFORE INSERT ON idempotency BEGIN SELECT RAISE(ABORT, 'simulated failure'); END");
  const post = () => fetch(`${base}/api/v1/crm.lead`, { method: 'POST', headers, body: JSON.stringify({ name: 'Atomic lead' }) });
  assert.equal((await post()).status, 500);
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM records WHERE model = 'crm.lead' AND json_extract(data, '$.name') = 'Atomic lead'").get().n, 0);
  sql.exec('DROP TRIGGER reject_idem');
  assert.equal((await post()).status, 201);
  const list = await (await fetch(`${base}/api/v1/crm.lead?q=Atomic`, { headers })).json();
  assert.equal(list.total, 1);
});

test('idempotency replay rechecks current model grants', async (t) => {
  const { base, dbPath, stop } = await startServer();
  let sql;
  t.after(async () => { sql?.close(); await stop(); });
  const json = { 'Content-Type': 'application/json', 'X-Requested-With': 'mizan' };
  const login = async (name) => {
    const res = await fetch(`${base}/api/login`, { method: 'POST', headers: json, body: JSON.stringify({ login: name, password: 'idem-test-pass-1' }) });
    return res.headers.get('set-cookie').split(';')[0];
  };
  const admin = { ...json, Cookie: await login('admin') };
  assert.equal((await fetch(`${base}/api/users`, { method: 'POST', headers: admin, body: JSON.stringify({ login: 'limited', password: 'idem-test-pass-1', apps: 'crm' }) })).status, 201);
  const userCookie = await login('limited');
  const { key } = await (await fetch(`${base}/api/keys`, { method: 'POST', headers: { ...json, Cookie: userCookie }, body: JSON.stringify({ name: 'test' }) })).json();
  const post = () => fetch(`${base}/api/v1/crm.lead`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, ...json, 'Idempotency-Key': 'grants' }, body: JSON.stringify({ name: 'Restricted lead' }) });
  assert.equal((await post()).status, 201);
  sql = new DatabaseSync(dbPath);
  sql.prepare('UPDATE users SET apps = ? WHERE login = ?').run('contacts', 'limited');
  assert.equal((await post()).status, 403);
});
