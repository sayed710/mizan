import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = await mkdtemp(join(tmpdir(), 'mizan-ratelimit-'));
let child;
let origin;

async function start() {
  child = spawn(process.execPath, ['server/index.js'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: '0', MIZAN_DB: join(directory, 'test.sqlite'), MIZAN_ADMIN_PASSWORD: 'admin-password-1', MIZAN_SECURE_COOKIE: '0', MIZAN_TRUST_PROXY: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`Server did not start: ${output}`)), 15000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = /Mizan listening on (http:\/\/localhost:\d+)/.exec(output);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('exit', () => { clearTimeout(timeout); reject(new Error(output)); });
  });
}
async function stop() {
  if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.send('shutdown'); await exited; }
}
after(async () => { await stop(); await rm(directory, { recursive: true, force: true }); });

const attempt = (origin, login, password, ip) => fetch(`${origin}/api/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mizan', 'X-Forwarded-For': ip },
  body: JSON.stringify({ login, password }),
}).then((r) => r.status);

test('login failures stay counted across a server restart', async () => {
  origin = await start();
  for (let i = 0; i < 10; i += 1) assert.equal(await attempt(origin, 'admin', 'wrong-password', '10.0.0.1'), 401);
  assert.equal(await attempt(origin, 'admin', 'admin-password-1', '10.0.0.1'), 429);
  await stop();
  origin = await start();
  assert.equal(await attempt(origin, 'admin', 'admin-password-1', '10.0.0.1'), 429);
  assert.equal(await attempt(origin, 'admin', 'admin-password-1', '10.0.0.2'), 200);
});

test('failures spread over many addresses still hit a per-account ceiling', async () => {
  for (let i = 0; i < 50; i += 1) await attempt(origin, 'victim', 'wrong-password', `10.1.${i}.1`);
  assert.equal(await attempt(origin, 'victim', 'any-password', '10.9.9.9'), 429);
  assert.equal(await attempt(origin, 'admin', 'admin-password-1', '10.9.9.9'), 200);
});
