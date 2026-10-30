import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function start(path) {
  const child = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: '0', MIZAN_DB: path, MIZAN_ADMIN_PASSWORD: 'epoch-password', MIZAN_ALLOW_RESET: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const url = await new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', (b) => { output += b; const m = /Mizan listening on (http:\/\/localhost:\d+)/.exec(output); if (m) resolve(m[1]); });
    child.once('exit', (code) => reject(new Error(`server exited ${code}: ${output}`)));
  });
  let cookie = '';
  const call = async (path, body, epoch) => {
    const res = await fetch(url + path, { method: body ? 'POST' : 'GET', headers: { cookie, 'content-type': 'application/json', 'x-requested-with': 'mizan', ...(epoch ? { 'x-mizan-epoch': epoch } : {}) }, body: body ? JSON.stringify(body) : undefined });
    cookie = res.headers.get('set-cookie')?.split(';')[0] ?? cookie;
    return res;
  };
  await call('/api/login', { login: 'admin', password: 'epoch-password' });
  return { call, stop: async () => { if (child.exitCode === null) { const exited = once(child, 'exit'); child.send('shutdown'); await exited; } } };
}

test('database generation survives restart, but changes durably after reset', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mizan-epoch-'));
  let server;
  try {
    server = await start(join(dir, 'db.sqlite'));
    const epoch = (await server.call('/api/db')).headers.get('x-mizan-epoch');
    await server.stop();
    server = await start(join(dir, 'db.sqlite'));
    assert.equal((await server.call('/api/db')).headers.get('x-mizan-epoch'), epoch);
    assert.equal((await server.call('/api/diff', { upserts: {}, deletes: {} }, epoch)).status, 200);
    const reset = await server.call('/api/reset', { confirm: 'RESET' });
    assert.equal(reset.status, 200);
    const replacement = reset.headers.get('x-mizan-epoch');
    assert.notEqual(replacement, epoch);
    await server.stop();
    server = await start(join(dir, 'db.sqlite'));
    assert.equal((await server.call('/api/db')).headers.get('x-mizan-epoch'), replacement);
    assert.equal((await server.call('/api/diff', { upserts: {}, deletes: {} }, epoch)).status, 409);
  } finally {
    await server?.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
