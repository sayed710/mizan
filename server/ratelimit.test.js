import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const directory = await mkdtemp(join(tmpdir(), 'mizan-ratelimit-'));
let child;
let origin;

async function start(preload) {
  child = spawn(process.execPath, [...(preload ? ['--import', pathToFileURL(preload).href] : []), 'server/index.js'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: '0', MIZAN_DB: join(directory, 'test.sqlite'), MIZAN_ADMIN_PASSWORD: 'admin-password-1', MIZAN_SECURE_COOKIE: '0', MIZAN_TRUST_PROXY: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
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

test('case-distinct login identities do not share the account failure ceiling', async () => {
  for (let i = 0; i < 50; i++) assert.equal(await attempt(origin, 'ADMIN', 'wrong-password', `10.20.${i}.1`), 401);
  assert.equal(await attempt(origin, 'admin', 'admin-password-1', '10.21.1.1'), 200);
});

test('startup prunes expired persistent rate events even on short-lived servers', async () => {
  await stop();
  const sql = new DatabaseSync(join(directory, 'test.sqlite'));
  sql.prepare('INSERT INTO rate_events (key, at) VALUES (?, ?)').run('expired-regression', 1);
  sql.close();
  origin = await start();
  const check = new DatabaseSync(join(directory, 'test.sqlite'));
  try { assert.equal(check.prepare('SELECT COUNT(*) AS n FROM rate_events WHERE key = ?').get('expired-regression').n, 0); }
  finally { check.close(); }
});

test('failed rate-event cleanup does not terminate startup or its interval callback', async () => {
  await stop();
  const sql = new DatabaseSync(join(directory, 'test.sqlite'));
  sql.exec("CREATE TRIGGER fail_cleanup BEFORE DELETE ON rate_events BEGIN SELECT RAISE(ABORT, 'cleanup unavailable'); END");
  sql.prepare('INSERT INTO rate_events (key, at) VALUES (?, ?)').run('cleanup-failure', 1);
  sql.close();
  const preload = join(directory, 'fast-cleanup.mjs');
  await writeFile(preload, 'const original = globalThis.setInterval; globalThis.setInterval = (fn, ms, ...args) => { if (ms === 900000) setImmediate(fn); return original(fn, ms, ...args); };');
  origin = await start(preload);
  assert.equal(await attempt(origin, 'admin', 'admin-password-1', '10.99.1.1'), 200);
});
