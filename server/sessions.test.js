import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let child;
let origin;
let directory;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mizan-sessions-'));
  child = spawn(process.execPath, ['server/index.js'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: '0', MIZAN_DB: join(directory, 'test.sqlite'), MIZAN_ADMIN_PASSWORD: 'admin-password-1', MIZAN_SECURE_COOKIE: '0' } });
  origin = await new Promise((resolve, reject) => {
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
});

after(async () => {
  if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
  await rm(directory, { recursive: true, force: true });
});

const call = (path, { cookie, bearer, body } = {}) => fetch(`${origin}${path}`, {
  method: body ? 'POST' : 'GET',
  headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mizan', ...(cookie ? { Cookie: cookie } : {}), ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
const signIn = async (login, password) => {
  const r = await call('/api/login', { body: { login, password } });
  return r.status === 200 ? r.headers.get('set-cookie').split(';')[0] : null;
};
const status = async (cookie) => (await call('/api/db', { cookie })).status;

test('changing the password needs the current one and signs out every other session', async () => {
  const kept = await signIn('admin', 'admin-password-1');
  const other = await signIn('admin', 'admin-password-1');
  assert.equal((await call('/api/password', { cookie: kept, body: { current: 'wrong-password', password: 'admin-password-2' } })).status, 403);
  assert.equal((await call('/api/password', { cookie: kept, body: { current: 'admin-password-1', password: 'short' } })).status, 400);
  assert.equal((await call('/api/password', { cookie: kept, body: { current: 'admin-password-1', password: 'admin-password-2' } })).status, 200);
  assert.equal(await status(kept), 200);
  assert.equal(await status(other), 401);
  assert.equal(await signIn('admin', 'admin-password-1'), null);
  const third = await signIn('admin', 'admin-password-2');
  assert.equal((await call('/api/sessions/revoke', { cookie: kept, body: {} })).status, 200);
  assert.equal(await status(third), 401);
  assert.equal(await status(kept), 200);
});

test('an admin revokes another user’s sessions and API keys and can reset the password', async () => {
  const admin = await signIn('admin', 'admin-password-2');
  assert.equal((await call('/api/users', { cookie: admin, body: { login: 'clerk', name: 'Clerk', password: 'clerk-password-1' } })).status, 201);
  const clerk = await signIn('clerk', 'clerk-password-1');
  const key = (await (await call('/api/keys', { cookie: clerk, body: { name: 'Script' } })).json()).key;
  assert.equal((await call('/api/v1/res.partner', { bearer: key })).status, 200);
  const id = (await (await call('/api/users', { cookie: admin })).json()).find((u) => u.login === 'clerk').id;
  assert.equal((await call('/api/users/revoke', { cookie: clerk, body: { id } })).status, 403);
  assert.equal((await call('/api/users/revoke', { cookie: admin, body: { id: 9999 } })).status, 404);
  assert.equal((await call('/api/users/revoke', { cookie: admin, body: { id, password: 'clerk-password-2' } })).status, 200);
  assert.equal(await status(clerk), 401);
  assert.equal((await call('/api/v1/res.partner', { bearer: key })).status, 401);
  assert.equal(await signIn('clerk', 'clerk-password-1'), null);
  assert.ok(await signIn('clerk', 'clerk-password-2'));
});
