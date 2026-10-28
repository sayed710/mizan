import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let child, directory, origin, cookie;
// Raw HTTP so the test sees the bytes on the wire (fetch would decompress silently).
const raw = (path, { method = 'GET', headers = {}, body } = {}) => new Promise((ok, fail) => {
  const req = request(origin + path, { method, headers: { Cookie: cookie ?? '', ...headers, ...(body ? { 'Content-Type': 'application/json', 'X-Requested-With': 'mizan', 'Content-Length': Buffer.byteLength(body) } : {}) } }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
  });
  req.on('error', fail);
  req.end(body);
});

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mizan-poll-'));
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
  const login = await raw('/api/login', { method: 'POST', body: JSON.stringify({ login: 'admin', password: 'test-admin-password' }) });
  cookie = login.headers['set-cookie'][0].split(';')[0];
});

after(async () => {
  if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.send('shutdown'); await exited; }
  if (directory) await rm(directory, { recursive: true, force: true });
});

test('the database is gzipped and an unchanged poll answers 304 with no body', async () => {
  const plain = await raw('/api/db');
  const zipped = await raw('/api/db', { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(zipped.headers['content-encoding'], 'gzip');
  assert.ok(zipped.body.length * 2 < plain.body.length, `${zipped.body.length} vs ${plain.body.length}`);
  const tag = plain.headers.etag;
  const same = await raw('/api/db', { headers: { 'If-None-Match': tag } });
  assert.equal(same.status, 304);
  assert.equal(same.body.length, 0);
  const partner = JSON.parse(plain.body).records['res.partner'][0];
  const saved = await raw('/api/diff', { method: 'POST', body: JSON.stringify({ upserts: { 'res.partner': [{ ...partner, name: 'Renamed' }] }, deletes: {}, messages: [], removedMessages: [] }) });
  assert.equal(saved.status, 200);
  const changed = await raw('/api/db', { headers: { 'If-None-Match': tag } });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.etag, tag);
});
