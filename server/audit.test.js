import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffDb } from '../src/sync.js';

const PASSWORD = 'audit-admin-pw';

async function startServer() {
  const dir = mkdtempSync(join(tmpdir(), 'mizan-audit-'));
  const child = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: '0', MIZAN_DB: join(dir, 'db.sqlite'), MIZAN_ADMIN_PASSWORD: PASSWORD },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (b) => { out += b; const m = /Mizan listening on (http:\/\/localhost:\d+)/.exec(out); if (m) resolve(m[1]); });
    child.on('exit', (code) => reject(new Error(`server exited ${code}: ${out}`)));
  });
  return { url, stop: async () => {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    rmSync(dir, { recursive: true, force: true });
  } };
}

const client = (url) => {
  let cookie = '';
  return async (method, path, body) => {
    const res = await fetch(url + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-requested-with': 'mizan', cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    cookie = res.headers.get('set-cookie')?.split(';')[0] ?? cookie;
    return { status: res.status, body: await res.json() };
  };
};

test('an edit through /api/diff is logged with the login, server time and old and new values; only admins read it', async () => {
  const { url, stop } = await startServer();
  try {
    const admin = client(url);
    assert.equal((await admin('POST', '/api/login', { login: 'admin', password: PASSWORD })).status, 200);
    const { body: db } = await admin('GET', '/api/db');
    const partner = db.records['res.partner'][0];
    const next = { ...db, records: { ...db.records, 'res.partner': db.records['res.partner'].map((p) => (p.id === partner.id ? { ...p, phone: '+20 100 000 0000' } : p)) } };
    const before = new Date().toISOString();
    assert.equal((await admin('POST', '/api/diff', diffDb(db, next))).status, 200);

    const { status, body: log } = await admin('GET', `/api/audit?model=res.partner&id=${partner.id}`);
    assert.equal(status, 200);
    assert.equal(log.length, 1);
    assert.equal(log[0].actor, 'admin');
    assert.equal(log[0].action, 'write');
    assert.deepEqual(log[0].changes, { phone: [partner.phone ?? null, '+20 100 000 0000'] });
    assert.ok(log[0].at >= before);
    assert.equal((await admin('GET', '/api/audit')).body.at(-1).action, 'seed');

    assert.equal((await admin('POST', '/api/users', { login: 'clerk', name: 'Clerk', password: 'clerk-password' })).status, 201);
    const clerk = client(url);
    assert.equal((await clerk('POST', '/api/login', { login: 'clerk', password: 'clerk-password' })).status, 200);
    assert.equal((await clerk('GET', '/api/audit')).status, 403);
  } finally {
    await stop();
  }
});

test('chatter messages get the server time, not the one the client sent', async () => {
  const { url, stop } = await startServer();
  try {
    const admin = client(url);
    await admin('POST', '/api/login', { login: 'admin', password: PASSWORD });
    const { body: db } = await admin('GET', '/api/db');
    const partner = db.records['res.partner'][0];
    const msg = { id: 'm-backdated', model: 'res.partner', res_id: partner.id, body: 'hello', kind: 'note', author: 'Someone else', date: '2001-01-01T00:00:00.000Z' };
    const out = await admin('POST', '/api/diff', diffDb(db, { ...db, messages: [...db.messages, msg] }));
    const saved = out.body.messages.find((m) => m.id === 'm-backdated');
    assert.equal(saved.author, 'Admin');
    assert.ok(saved.date > '2026-01-01');
  } finally {
    await stop();
  }
});

test('account administration, settings edits and notes are logged without secrets; the log pages back with `before`', async () => {
  const { url, stop } = await startServer();
  try {
    const admin = client(url);
    await admin('POST', '/api/login', { login: 'admin', password: PASSWORD });
    await admin('POST', '/api/users', { login: 'clerk', name: 'Clerk', password: 'clerk-password-secret' });
    const key = (await admin('POST', '/api/keys', { name: 'ci' })).body.key;
    const { body: db } = await admin('GET', '/api/db');
    const partner = db.records['res.partner'][0];
    const edited = { ...db, settings: { ...db.settings, lock_date: '2026-01-31' }, messages: [...db.messages, { id: 'm-audit', model: 'res.partner', res_id: partner.id, body: 'call back', kind: 'note' }] };
    assert.equal((await admin('POST', '/api/diff', diffDb(db, edited))).status, 200);
    await admin('DELETE', `/api/keys?created=${(await admin('GET', '/api/keys')).body[0].created}`);

    const log = (await admin('GET', '/api/audit?limit=1000')).body;
    const has = (model, action) => log.some((e) => e.model === model && e.action === action);
    assert.ok(has('auth.user', 'create') && has('auth.api_key', 'create') && has('auth.api_key', 'delete'));
    assert.ok(has('settings', 'write') && has('mail.message', 'create'));
    assert.ok(!JSON.stringify(log).includes('clerk-password-secret') && !JSON.stringify(log).includes(key));
    assert.equal(log.find((e) => e.model === 'auth.user' && e.changes.login?.[1] === 'clerk').actor, 'admin');

    const first = (await admin('GET', '/api/audit?limit=2')).body;
    const next = (await admin('GET', `/api/audit?limit=2&before=${first.at(-1).id}`)).body;
    assert.ok(next.length && next.every((e) => e.id < first.at(-1).id));
    assert.equal((await admin('GET', '/api/audit?before=abc')).status, 400);
  } finally {
    await stop();
  }
});

test('anonymous blog views change the counter without adding audit rows', async () => {
  const { url, stop } = await startServer();
  try {
    const admin = client(url);
    await admin('POST', '/api/login', { login: 'admin', password: PASSWORD });
    const { body: db } = await admin('GET', '/api/db');
    const blog = { id: 901, name: 'News' };
    const made = { id: 900, name: 'Hello', blog_id: 901, is_published: true, visits: 0, content: 'Body', published_date: '2026-01-01' };
    const saved = await admin('POST', '/api/diff', diffDb(db, { ...db, records: { ...db.records, 'blog.blog': [blog], 'blog.post': [made] } }));
    assert.equal(saved.status, 200, JSON.stringify(saved.body.error));
    const post = saved.body.records['blog.post'].find((p) => p.id === (saved.body.remapped?.['blog.post']?.[made.id] ?? made.id));
    const before = (await admin('GET', '/api/audit?limit=1000')).body.length;
    const anonymous = client(url);
    for (let i = 0; i < 3; i++) assert.equal((await anonymous('GET', `/api/public/blog/${post.id}`)).status, 200);
    assert.equal((await admin('GET', '/api/audit?limit=1000')).body.length, before);
    assert.equal((await admin('GET', '/api/db')).body.records['blog.post'].find((p) => p.id === post.id).visits, (post.visits ?? 0) + 3);
  } finally {
    await stop();
  }
});
