import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'mizan' };

/**
 * Gracefully ask `child` to exit over IPC, tolerating only ERR_IPC_CHANNEL_CLOSED (which can happen when
 * `child.connected` is still true before the parent reads IPC EOF). If the channel is gone while the process
 * is still alive, kill it and wait for `close` so the server never outlives the test before dir removal.
 */
async function stopChild(child, isClosed = () => false) {
  if (isClosed()) return;
  const closed = once(child, 'close');
  let channelClosed = !child.connected;
  let sendError = null;
  try {
    if (child.connected) {
      await new Promise((resolve) => {
        child.send('shutdown', (err) => {
          if (err?.code === 'ERR_IPC_CHANNEL_CLOSED') channelClosed = true;
          else if (err) sendError = err;
          resolve();
        });
      });
    }
  } finally {
    if ((channelClosed || !child.connected || sendError) && child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
    await closed;
  }
  if (sendError) throw sendError;
}

/** Start a server with `env`, run `fn(origin, adminHeaders, directory)`, then stop it. */
async function withServer(env, fn) {
  const directory = await mkdtemp(join(tmpdir(), 'mizan-reset-'));
  const child = spawn(process.execPath, ['server/index.js'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: '0', MIZAN_DB: join(directory, 'test.sqlite'), MIZAN_ADMIN_PASSWORD: 'test-admin-password', MIZAN_SECURE_COOKIE: '0', MIZAN_SMTP_HOST: '', NODE_ENV: '', MIZAN_ALLOW_RESET: '', ...env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let closed = false;
  child.once('close', () => { closed = true; });
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
    try {
      await stopChild(child, () => closed);
    } finally {
      await rm(directory, { recursive: true, force: true });
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
