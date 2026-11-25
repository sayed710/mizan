import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, stopChild } from './test-server.js';

const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'mizan' };

/** Start a server with `env`, run `fn(origin, adminHeaders, directory)`, then stop it. */
async function withServer(env, fn) {
  const directory = await mkdtemp(join(tmpdir(), 'mizan-reset-'));
  let server;
  try {
    server = await startServer({
      env: { ...process.env, PORT: '0', MIZAN_DB: join(directory, 'test.sqlite'), MIZAN_ADMIN_PASSWORD: 'test-admin-password', MIZAN_SECURE_COOKIE: '0', MIZAN_SMTP_HOST: '', NODE_ENV: '', MIZAN_ALLOW_RESET: '', ...env },
    });
    const { origin } = server;
    const res = await fetch(`${origin}/api/login`, { method: 'POST', headers, body: JSON.stringify({ login: 'admin', password: 'test-admin-password' }) });
    await fn(origin, { ...headers, Cookie: res.headers.get('set-cookie').split(';')[0] }, directory);
  } finally {
    try {
      await server?.stop();
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
}
const reset = (origin, h, body) => fetch(`${origin}/api/reset`, { method: 'POST', headers: h, body: JSON.stringify(body) });

test('reset needs RESET typed and keeps the wiped data in a private file', async () => {
  await withServer({ NODE_ENV: 'development' }, async (origin, admin, directory) => {
    assert.equal((await (await fetch(`${origin}/api/session`, { headers: admin })).json()).canReset, true);
    assert.equal((await reset(origin, admin, {})).status, 400);
    assert.equal((await reset(origin, admin, { confirm: 'RESET' })).status, 200);
    const saved = (await readdir(directory)).find((f) => /^test\.sqlite\.before-reset-.*\.json$/.test(f));
    assert.ok(saved);
    if (process.platform !== 'win32') assert.equal((await stat(join(directory, saved))).mode & 0o777, 0o600);
  });
});

test('reset is off when NODE_ENV is unset, as in a plain npm start', async () => {
  await withServer({}, async (origin, admin) => {
    assert.equal((await (await fetch(`${origin}/api/session`, { headers: admin })).json()).canReset, false);
    assert.equal((await reset(origin, admin, { confirm: 'RESET' })).status, 403);
  });
  await withServer({ NODE_ENV: 'development', MIZAN_ALLOW_RESET: '0' }, async (origin, admin) => {
    assert.equal((await reset(origin, admin, { confirm: 'RESET' })).status, 403);
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

test('teardown kills a live child whose IPC channel closed and tolerates ERR_IPC_CHANNEL_CLOSED while rethrowing other send errors', async () => {
  const disconnected = spawn(process.execPath, ['-e', 'process.disconnect(); setInterval(() => {}, 1000);'], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  try {
    await once(disconnected, 'disconnect');
    await stopChild(disconnected);
    assert.ok(disconnected.exitCode !== null || disconnected.signalCode !== null, 'disconnected live child must be killed');
  } finally {
    if (disconnected.exitCode === null && disconnected.signalCode === null) disconnected.kill();
  }

  const closedRace = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  try {
    closedRace.send = (_msg, cb) => cb?.(Object.assign(new Error('Channel closed'), { code: 'ERR_IPC_CHANNEL_CLOSED' }));
    await stopChild(closedRace);
    assert.ok(closedRace.exitCode !== null || closedRace.signalCode !== null, 'child hitting ERR_IPC_CHANNEL_CLOSED while connected must be killed');
  } finally {
    if (closedRace.exitCode === null && closedRace.signalCode === null) closedRace.kill();
  }

  const sendFailed = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  try {
    sendFailed.send = (_msg, cb) => cb?.(Object.assign(new Error('Broken pipe'), { code: 'EPIPE' }));
    await assert.rejects(() => stopChild(sendFailed), { code: 'EPIPE' });
    assert.ok(sendFailed.exitCode !== null || sendFailed.signalCode !== null, 'child must still be killed on unexpected send error');
  } finally {
    if (sendFailed.exitCode === null && sendFailed.signalCode === null) sendFailed.kill();
  }
});
