import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffDb } from '../src/sync.js';

const PASSWORD = 'approval-admin-pw';

async function startServer() {
  const dir = mkdtempSync(join(tmpdir(), 'mizan-approvals-'));
  const child = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: '0', MIZAN_DB: join(dir, 'db.sqlite'), MIZAN_ADMIN_PASSWORD: PASSWORD },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (b) => { out += b; const m = /Mizan listening on (http:\/\/localhost:\d+)/.exec(out); if (m) resolve(m[1]); });
    child.on('exit', (code) => reject(new Error(`server exited ${code}: ${out}`)));
  });
  return { url, stop: () => { child.kill(); rmSync(dir, { recursive: true, force: true }); } };
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

test('a signed-in user approves only as the manager linked to their login', async () => {
  const { url, stop } = await startServer();
  try {
    const admin = client(url);
    await admin('POST', '/api/login', { login: 'admin', password: PASSWORD });
    const { body: db } = await admin('GET', '/api/db');
    for (const login of ['mona', 'youssef']) assert.equal((await admin('POST', '/api/users', { login, name: login, password: 'user-password' })).status, 201);
    const linked = { ...db, records: { ...db.records, 'hr.employee': db.records['hr.employee'].map((e) => (e.id === 2 ? { ...e, user_login: 'mona' } : e.id === 3 ? { ...e, user_login: 'youssef' } : e)) } };
    assert.equal((await admin('POST', '/api/diff', diffDb(db, linked))).status, 200);

    const approveLeave = async (login) => {
      const user = client(url);
      await user('POST', '/api/login', { login, password: 'user-password' });
      const { body: mine } = await user('GET', '/api/db');
      const next = { ...mine, records: { ...mine.records, 'hr.leave': mine.records['hr.leave'].map((l) => (l.id === 1 ? { ...l, state: 'validate' } : l)) } };
      return user('POST', '/api/diff', diffDb(mine, next));
    };
    const own = await approveLeave('youssef'); // leave 1 is Youssef's
    assert.equal(own.status, 400);
    assert.match(own.body.error, /your own request/);
    const byManager = await approveLeave('mona');
    assert.equal(byManager.status, 200);
    assert.equal(byManager.body.records['hr.leave'].find((l) => l.id === 1).state, 'validate');
  } finally {
    stop();
  }
});
