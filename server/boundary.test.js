// The server boundary over HTTP: sessions, CSRF, admin-only routes, app restrictions and the REST API,
// exercised as a restricted (non-admin) user rather than through browser functions.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let child, directory, origin;
const call = async (path, { method = 'GET', cookie, body, csrf = true, headers = {} } = {}) => {
  const res = await fetch(origin + path, {
    method, redirect: 'manual',
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(csrf && method !== 'GET' ? { 'X-Requested-With': 'mizan' } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, data, headers: res.headers };
};
const login = async (name, password) => {
  const res = await call('/api/login', { method: 'POST', body: { login: name, password } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.headers.get('set-cookie').split(';')[0];
};
let admin, sales, salesDb;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mizan-boundary-'));
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
  admin = await login('admin', 'test-admin-password');
  assert.equal((await call('/api/users', { method: 'POST', cookie: admin, body: { login: 'sales', name: 'Sales Rep', password: 'sales-password', apps: 'crm' } })).status, 201);
  sales = await login('sales', 'sales-password');
  salesDb = (await call('/api/db', { cookie: sales })).data;
});

after(async () => {
  if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.send('shutdown'); await exited; }
  if (directory) await rm(directory, { recursive: true, force: true });
});

test('every data route needs a session, and a logged-out session stops working', async () => {
  for (const [path, method] of [['/api/db', 'GET'], ['/api/diff', 'POST'], ['/api/users', 'GET'], ['/api/keys', 'GET'], ['/api/reset', 'POST']]) {
    assert.equal((await call(path, { method, body: method === 'POST' ? {} : undefined })).status, 401, path);
  }
  const extra = await login('sales', 'sales-password');
  assert.equal((await call('/api/logout', { method: 'POST', cookie: extra, body: {} })).status, 200);
  assert.equal((await call('/api/db', { cookie: extra })).status, 401);
  assert.equal((await call('/api/login', { method: 'POST', body: { login: 'sales', password: 'wrong-password' } })).status, 401);
});

test('state-changing calls without the CSRF header or as a form post are refused', async () => {
  assert.equal((await call('/api/diff', { method: 'POST', cookie: sales, body: {}, csrf: false })).status, 403);
  const form = await fetch(`${origin}/api/diff`, { method: 'POST', headers: { Cookie: sales, 'X-Requested-With': 'mizan', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'a=1' });
  assert.equal(form.status, 403);
});

test('barcode counts require inventory entitlement independently of shared product access', async () => {
  const body = { productId: 2, counted: 10, observed: 10, company: 1 };
  assert.equal((await call('/api/barcode/count', { method: 'POST', cookie: sales, body })).status, 403);
});

test('barcode counts require an observed quantity and an existing active company', async () => {
  const db = (await call('/api/db', { cookie: admin })).data;
  const p = db.records.product.find((p) => p.type === 'goods');
  const base = { productId: p.id, counted: p.qty_available + 1, company: db.records['res.company'][0].id };
  for (const observed of [undefined, null, 'not-a-number']) {
    const out = await call('/api/barcode/count', { method: 'POST', cookie: admin, body: { ...base, observed } });
    assert.equal(out.status, 400, JSON.stringify(out.data));
    assert.match(out.data.error, /observed quantity/i);
  }
  const invalid = await call('/api/barcode/count', { method: 'POST', cookie: admin, body: { ...base, observed: p.qty_available, company: 987654 } });
  assert.equal(invalid.status, 400);
  assert.match(invalid.data.error, /existing active company/i);
  assert.equal((await call('/api/db', { cookie: admin })).data.records.product.find((r) => r.id === p.id).qty_available, p.qty_available);
});

test('admin-only routes refuse a regular user', async () => {
  assert.equal((await call('/api/users', { cookie: sales })).status, 403);
  assert.equal((await call('/api/users', { method: 'POST', cookie: sales, body: { login: 'x', password: 'whatever-password' } })).status, 403);
  assert.equal((await call('/api/reset', { method: 'POST', cookie: sales, body: {} })).status, 403);
  assert.ok((await call('/api/db', { cookie: admin })).data.records['account.move'].length > 0);
});

test('a CRM-only user sees only CRM data and cannot write other apps through /api/diff', async () => {
  assert.ok(salesDb.records['crm.lead']);
  assert.equal(salesDb.records['account.move'], undefined);
  const move = (await call('/api/db', { cookie: admin })).data.records['account.move'][0];
  const forged = await call('/api/diff', { method: 'POST', cookie: sales, body: { upserts: { 'account.move': [{ ...move, ref: 'forged' }] } } });
  assert.equal(forged.status, 400);
  assert.match(forged.data.error, /No access to account.move/);
  const deleted = await call('/api/diff', { method: 'POST', cookie: sales, body: { deletes: { 'account.move': [move.id] } } });
  assert.match(deleted.data.error, /No access to account.move/);
  assert.equal((await call('/api/db', { cookie: admin })).data.records['account.move'].find((m) => m.id === move.id).ref, move.ref);
});

test('a regular user cannot change admin settings through a diff', async () => {
  const before = (await call('/api/db', { cookie: admin })).data.settings;
  const res = await call('/api/diff', { method: 'POST', cookie: sales, body: { settings: { lock_date: '2099-12-31', company: 'Hijacked', uninstalled: ['crm'] } } });
  assert.equal(res.status, 200);
  const after = (await call('/api/db', { cookie: admin })).data.settings;
  assert.equal(after.lock_date ?? null, before.lock_date ?? null);
  assert.equal(after.company, before.company);
  assert.deepEqual(after.uninstalled ?? [], before.uninstalled ?? []);
});

test('invalid records are refused at the server, not only in the browser', async () => {
  const lead = salesDb.records['crm.lead'][0];
  for (const bad of [{ ...lead, id: -1 }, { ...lead, id: 'x' }, null]) {
    assert.equal((await call('/api/diff', { method: 'POST', cookie: sales, body: { upserts: { 'crm.lead': [bad] } } })).status, 400);
  }
  assert.match((await call('/api/diff', { method: 'POST', cookie: sales, body: { upserts: { 'no.such.model': [] } } })).data.error, /Unknown model/);
});

test('the REST API needs a key and applies the key owner\'s app restrictions', async () => {
  assert.equal((await call('/api/v1/crm.lead')).status, 401);
  assert.equal((await call('/api/v1/crm.lead', { headers: { Authorization: 'Bearer mzn_not-a-real-key-at-all' } })).status, 401);
  const { key } = (await call('/api/keys', { method: 'POST', cookie: sales, body: { name: 'test' } })).data;
  const auth = { Authorization: `Bearer ${key}` };
  const api = (path, opts = {}) => call(path, { ...opts, csrf: false, headers: auth });
  assert.equal((await api('/api/v1/crm.lead')).status, 200);
  assert.equal((await api('/api/v1/account.move')).status, 403);
  assert.ok(!(await api('/api/v1/models')).data.some((m) => m.model === 'account.move' || m.name === 'account.move'));
  assert.equal((await api('/api/v1/nothing')).status, 404);
  assert.equal((await api('/api/v1/crm.lead/abc')).status, 400);
  const created = await api('/api/v1/crm.lead', { method: 'POST', body: { name: 'From API' } });
  assert.equal(created.status, 201);
  const patched = await api(`/api/v1/crm.lead/${created.data.id}`, { method: 'PATCH', body: { name: 'Renamed by API', id: 999999 } });
  assert.equal(patched.data.name, 'Renamed by API');
  assert.equal(patched.data.id, created.data.id);
  assert.equal((await api(`/api/v1/crm.lead/${created.data.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await api(`/api/v1/crm.lead/${created.data.id}`)).status, 404);
  assert.equal((await api('/api/v1/crm.lead', { method: 'POST', body: [1, 2] })).status, 400);
});
