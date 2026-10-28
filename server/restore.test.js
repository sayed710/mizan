import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let child, directory, origin;
const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'mizan' };
const login = async (login, password) => {
  const res = await fetch(`${origin}/api/login`, { method: 'POST', headers, body: JSON.stringify({ login, password }) });
  assert.equal(res.status, 200);
  return { ...headers, Cookie: res.headers.get('set-cookie').split(';')[0] };
};
const post = (path, h, body) => fetch(`${origin}${path}`, { method: 'POST', headers: h, body: JSON.stringify(body) });

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mizan-restore-'));
  child = spawn(process.execPath, ['server/index.js'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: '0', MIZAN_DB: join(directory, 'test.sqlite'), MIZAN_ADMIN_PASSWORD: 'test-admin-password', MIZAN_SECURE_COOKIE: '0', MIZAN_SMTP_HOST: '' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
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
  if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.send('shutdown'); await exited; }
  if (directory) await rm(directory, { recursive: true, force: true });
});

test('only an admin can restore, a dry run changes nothing, and an unmodified backup round-trips', async () => {
  const admin = await login('admin', 'test-admin-password');
  assert.equal((await post('/api/users', admin, { login: 'clerk', name: 'Clerk', password: 'clerk-password' })).status, 201);
  const clerk = await login('clerk', 'clerk-password');
  const backup = await (await fetch(`${origin}/api/db`, { headers: admin })).json();
  const total = Object.values(backup.records).reduce((n, list) => n + list.length, 0);

  assert.equal((await post('/api/restore', clerk, { backup, confirm: 'RESTORE' })).status, 403);

  const older = { ...backup, records: { ...backup.records, 'crm.lead': backup.records['crm.lead'].slice(1) } };
  const dry = await (await post('/api/restore', admin, { backup: older })).json();
  assert.deepEqual(dry, { dryRun: true, current: total, restored: total - 1, removed: 1, added: 0, changed: 0, messages: { current: backup.messages.length, restored: backup.messages.length }, settingsChanged: false });
  assert.equal((await (await fetch(`${origin}/api/db`, { headers: admin })).json()).records['crm.lead'].length, backup.records['crm.lead'].length);

  const done = await (await post('/api/restore', admin, { backup, confirm: 'RESTORE' })).json();
  assert.equal(done.ok, true);
  assert.equal(done.restored, total);
  const after = await (await fetch(`${origin}/api/db`, { headers: admin })).json();
  assert.deepEqual(after.records, backup.records);

  assert.match((await (await post('/api/restore', admin, { backup: { records: { nope: [] }, messages: [] }, confirm: 'RESTORE' })).json()).error, /Unknown model nope/);
});

test('a browser that synced before a restore cannot replay its edits afterwards', async () => {
  const admin = await login('admin', 'test-admin-password');
  const first = await fetch(`${origin}/api/db`, { headers: admin });
  const backup = await first.json();
  const epoch = first.headers.get('x-mizan-epoch');
  const edit = { upserts: { 'crm.lead': [{ ...backup.records['crm.lead'][0], name: 'Edited before restore' }] }, deletes: {}, messages: [], removedMessages: [] };
  assert.equal((await post('/api/diff', { ...admin, 'X-Mizan-Epoch': epoch }, { ...edit, upserts: { 'crm.lead': [{ ...edit.upserts['crm.lead'][0], name: backup.records['crm.lead'][0].name }] } })).status, 200);
  assert.equal((await post('/api/restore', admin, { backup, confirm: 'RESTORE' })).status, 200);
  const late = await post('/api/diff', { ...admin, 'X-Mizan-Epoch': epoch }, edit);
  assert.equal(late.status, 409);
  const now = await (await fetch(`${origin}/api/db`, { headers: admin })).json();
  assert.equal(now.records['crm.lead'][0].name, backup.records['crm.lead'][0].name);
});
