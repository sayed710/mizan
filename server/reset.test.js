import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'mizan' };

/** Start a server with `env`, run `fn(origin, adminHeaders, directory)`, then stop it. */
async function withServer(env, fn) {
  const directory = await mkdtemp(join(tmpdir(), 'mizan-reset-'));
  const child = spawn(process.execPath, ['server/index.js'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: '0', MIZAN_DB: join(directory, 'test.sqlite'), MIZAN_ADMIN_PASSWORD: 'test-admin-password', MIZAN_SECURE_COOKIE: '0', MIZAN_SMTP_HOST: '', NODE_ENV: '', MIZAN_ALLOW_RESET: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const origin = await new Promise((resolve, reject) => {
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
    const res = await fetch(`${origin}/api/login`, { method: 'POST', headers, body: JSON.stringify({ login: 'admin', password: 'test-admin-password' }) });
    await fn(origin, { ...headers, Cookie: res.headers.get('set-cookie').split(';')[0] }, directory);
  } finally {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    await rm(directory, { recursive: true, force: true });
  }
}
const reset = (origin, h, body) => fetch(`${origin}/api/reset`, { method: 'POST', headers: h, body: JSON.stringify(body) });

test('reset needs RESET typed and keeps the wiped data in a file', async () => {
  await withServer({}, async (origin, admin, directory) => {
    assert.equal((await (await fetch(`${origin}/api/session`, { headers: admin })).json()).canReset, true);
    assert.equal((await reset(origin, admin, {})).status, 400);
    assert.equal((await reset(origin, admin, { confirm: 'RESET' })).status, 200);
    assert.ok((await readdir(directory)).some((f) => /^test\.sqlite\.before-reset-.*\.json$/.test(f)));
  });
});

test('reset is off in production unless MIZAN_ALLOW_RESET=1', async () => {
  await withServer({ NODE_ENV: 'production' }, async (origin, admin) => {
    assert.equal((await (await fetch(`${origin}/api/session`, { headers: admin })).json()).canReset, false);
    const res = await reset(origin, admin, { confirm: 'RESET' });
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /disabled/);
  });
  await withServer({ NODE_ENV: 'production', MIZAN_ALLOW_RESET: '1' }, async (origin, admin) => {
    assert.equal((await reset(origin, admin, { confirm: 'RESET' })).status, 200);
  });
});
