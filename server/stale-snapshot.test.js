import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let child, directory, origin;
const JSON_HEADERS = { 'Content-Type': 'application/json', 'X-Requested-With': 'mizan' };

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mizan-stale-'));
  child = spawn(process.execPath, ['server/index.js'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: '0', MIZAN_DB: join(directory, 'test.sqlite'), MIZAN_ADMIN_PASSWORD: 'test-admin-password', MIZAN_SECURE_COOKIE: '0', MIZAN_SMTP_HOST: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
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
  if (directory) await rm(directory, { recursive: true, force: true });
});

test('a slow public request does not revert changes committed while its body was arriving', async () => {
  const login = await fetch(`${origin}/api/login`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ login: 'admin', password: 'test-admin-password' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];

  // Start a public live chat request and hold its body open.
  const slow = request(`${origin}/api/public/livechat/start`, { method: 'POST', headers: JSON_HEADERS });
  const answered = new Promise((resolve, reject) => { slow.on('response', resolve); slow.on('error', reject); });
  slow.write('{"name":"Visitor",');
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Meanwhile an employee creates a contact.
  const db = await (await fetch(`${origin}/api/db`, { headers: { cookie } })).json();
  const id = Math.max(0, ...db.records['res.partner'].map((p) => p.id)) + 1;
  const saved = await fetch(`${origin}/api/diff`, {
    method: 'POST', headers: { ...JSON_HEADERS, cookie },
    body: JSON.stringify({ upserts: { 'res.partner': [{ id, name: 'Saved meanwhile' }] }, deletes: {}, messages: [], removedMessages: [], seq: { 'res.partner': id } }),
  });
  assert.equal(saved.status, 200);

  slow.end('"email":"visitor@example.com"}');
  assert.equal((await answered).statusCode, 201);

  const after = await (await fetch(`${origin}/api/db`, { headers: { cookie } })).json();
  assert.ok(after.records['res.partner'].some((p) => p.id === id && p.name === 'Saved meanwhile'), 'the contact saved during the slow request must survive');
});

test('IoT requests without a token or with bad JSON are refused and counted', async () => {
  const noToken = await fetch(`${origin}/api/iot/ingest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' });
  assert.equal(noToken.status, 401);
  const badJson = await fetch(`${origin}/api/iot/ingest`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer iot_${'x'.repeat(24)}` }, body: '{not json' });
  assert.equal(badJson.status, 400);
  let last;
  for (let i = 0; i < 12; i++) last = await fetch(`${origin}/api/iot/ingest`, { method: 'POST', body: '{not json' });
  assert.equal(last.status, 429, 'failed attempts must reach the per-client limit');
});
