// Uploaded files move out of records into the blobs table, so they do not count toward the database size.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { create, read } from '../src/orm.js';
import { seed } from '../src/seed.js';
import { cleanValue } from '../src/validate.js';
import { openBlobs } from './blobs.js';
import { safeImage } from './api.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffDb } from '../src/sync.js';
import { createCompany } from '../src/models/company.js';
import { claimWriter } from './storage.js';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const PDF = `data:application/pdf;base64,${Buffer.from('%PDF-1.4 receipt').toString('base64')}`;

test('externalize stores inline files once and leaves records without inline data untouched', () => {
  const blobs = openBlobs(new DatabaseSync(':memory:'));
  const base = seed();
  assert.equal(blobs.externalize(base), base);
  const { db, id } = create(base, 'hr.expense', { name: 'Taxi', employee_id: 1, receipt: { name: 'r.pdf', type: 'application/pdf', size: 16, data: PDF } });
  const moved = blobs.externalize(db);
  const receipt = read(moved, 'hr.expense', id).receipt;
  assert.equal(receipt.data, undefined);
  assert.match(receipt.blob, /^[0-9a-f]{32}$/);
  assert.equal(Buffer.from(blobs.get(receipt.blob).data).toString(), '%PDF-1.4 receipt');
  assert.equal(blobs.externalize(moved), moved);
  assert.ok(JSON.stringify(moved).length < JSON.stringify(db).length);
  assert.equal(blobs.get('../etc'), undefined);
});

test('stored files validate as references and only raster images reach the website', () => {
  const ref = { name: 'p.png', type: 'image/png', size: 8, blob: 'ab'.repeat(16) };
  assert.deepEqual(cleanValue({ type: 'binary' }, ref, 'image'), ref);
  assert.throws(() => cleanValue({ type: 'binary' }, { blob: '../x' }, 'image'));
  assert.equal(safeImage(ref), `/api/public/image/${ref.blob}`);
  assert.equal(safeImage({ ...ref, type: 'text/html' }), null);
  assert.equal(safeImage({ data: PNG }), PNG);
});

test('an empty database (fresh install) passes through', () => {
  assert.equal(openBlobs(new DatabaseSync(':memory:')).externalize(null), null);
});

test('blob schema and inserts require the writer lease', () => {
  const sql = new DatabaseSync(':memory:');
  try {
    const writer = claimWriter(sql);
    const blobs = openBlobs(sql, { beforeWrite: writer.assert });
    claimWriter(sql, { force: true });
    const { db } = create(seed(), 'hr.expense', { name: 'Taxi', employee_id: 1, receipt: { name: 'r.pdf', data: PDF } });
    assert.throws(() => blobs.externalize(db), /took over/);
    assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM blobs').get().n, 0);
    assert.throws(() => openBlobs(sql, { beforeWrite: writer.assert }), /took over/);
  } finally { sql.close(); }
});

test('blob downloads require access to the referencing model and company', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mizan-blobs-'));
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: '0', MIZAN_DB: join(dir, 'db.sqlite'), MIZAN_ADMIN_PASSWORD: 'blob-admin-password', MIZAN_SECURE_COOKIE: '0' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  try {
    const url = await new Promise((resolve, reject) => {
      let output = '';
      child.stdout.on('data', (b) => { output += b; const m = /Mizan listening on (http:\/\/localhost:\d+)/.exec(output); if (m) resolve(m[1]); });
      child.stderr.on('data', (b) => { output += b; });
      child.on('error', reject);
      child.on('exit', (code) => reject(new Error(`server exited ${code}: ${output}`)));
    });
    const client = () => {
      let cookie = '';
      return async (method, path, body) => {
        const res = await fetch(url + path, {
          method, headers: { 'content-type': 'application/json', 'x-requested-with': 'mizan', cookie },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        cookie = res.headers.get('set-cookie')?.split(';')[0] ?? cookie;
        return res;
      };
    };
    const admin = client();
    assert.equal((await admin('POST', '/api/login', { login: 'admin', password: 'blob-admin-password' })).status, 200);
    const db = await (await admin('GET', '/api/db')).json();
    const branch = createCompany(db, { name: 'Branch', currency_id: db.records['res.company'][0].currency_id });
    const expense = create(branch.db, 'hr.expense', { name: 'Secret receipt', employee_id: 1, receipt: { name: 'r.pdf', type: 'application/pdf', data: PDF } });
    const saved = await admin('POST', '/api/diff', diffDb(db, expense.db));
    assert.equal(saved.status, 200);
    const moved = await saved.json();
    const receipt = moved.records['hr.expense'].find((r) => r.name === 'Secret receipt').receipt;
    assert.equal(receipt.data, undefined);
    const path = `/api/blob/${receipt.blob}`;
    assert.equal((await client()('GET', path)).status, 401);
    const download = await admin('GET', path);
    assert.equal(download.status, 200);
    assert.equal(await download.text(), '%PDF-1.4 receipt');
    // Expenses without a company field belong to company 1 under the server's visibility rules.
    for (const [login, grants] of [['contactsonly', { apps: 'contacts' }], ['branchonly', { companies: String(branch.id) }]]) {
      assert.equal((await admin('POST', '/api/users', { login, name: login, password: 'blob-user-password', ...grants })).status, 201);
      const restricted = client();
      assert.equal((await restricted('POST', '/api/login', { login, password: 'blob-user-password' })).status, 200);
      const visible = await (await restricted('GET', '/api/db')).json();
      assert.ok(!visible.records['hr.expense']?.some((r) => r.receipt?.blob === receipt.blob), login);
      assert.ok([403, 404].includes((await restricted('GET', path)).status), login);
    }
  } finally {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.send('shutdown'); await exited; }
    rmSync(dir, { recursive: true, force: true });
  }
});
