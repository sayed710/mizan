// REST creates honour Idempotency-Key: a retry returns the first record instead of creating another.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function startServer() {
  const dir = mkdtempSync(join(tmpdir(), 'mizan-idem-'));
  const proc = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: '0', MIZAN_DB: join(dir, 'db.sqlite'), MIZAN_ADMIN_PASSWORD: 'idem-test-pass-1', NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const port = await new Promise((ok, fail) => {
    proc.stdout.on('data', (d) => { const m = /localhost:(\d+)/.exec(String(d)); if (m) ok(Number(m[1])); });
    proc.on('exit', (code) => fail(new Error(`server exited ${code}`)));
  });
  return { base: `http://127.0.0.1:${port}`, stop: async () => {
    proc.kill();
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
