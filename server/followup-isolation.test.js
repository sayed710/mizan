import '../src/models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCompany } from '../src/models/company.js';
import { seed } from '../src/seed.js';
import { diffDb } from '../src/sync.js';
import { openStorage } from './storage.js';

test('legacy follow-up progress migrates and restricted API writes preserve other companies', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mizan-followup-'));
  const path = join(dir, 'db.sqlite');
  const sql = new DatabaseSync(path);
  const base = seed();
  const branch = createCompany(base, { name: 'Follow-up branch', currency_id: base.records['res.company'][0].currency_id });
  const partnerId = 988;
  const partner = {
    id: partnerId, name: 'Legacy shared customer', company_id: null,
    followup_level: 1, followup_level_delay: 15, followup_date: '2025-01-01',
    followup_lines: [{ company_id: branch.id, followup_level_delay: 30, followup_date: '2025-02-01' }],
  };
  const owned = { id: 989, name: 'Legacy branch customer', company_id: branch.id, followup_level_delay: 45, followup_date: '2025-03-01' };
  openStorage(sql).save(null, { ...branch.db, schema_version: 11, settings: { ...branch.db.settings, uninstalled: ['accounting'] }, records: { ...branch.db.records, 'res.partner': [...branch.db.records['res.partner'], partner, owned] } });
  sql.close();
  const child = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: '0', MIZAN_DB: path, MIZAN_ADMIN_PASSWORD: 'followup-admin-password' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  try {
    const url = await new Promise((resolve, reject) => {
      let out = '';
      child.stdout.on('data', (b) => { out += b; const m = /Mizan listening on (http:\/\/localhost:\d+)/.exec(out); if (m) resolve(m[1]); });
      child.on('exit', (code) => reject(new Error(`server exited ${code}: ${out}`)));
    });
    const client = () => {
      let cookie = '';
      return async (method, path, body) => {
        const res = await fetch(url + path, { method, headers: { 'content-type': 'application/json', 'x-requested-with': 'mizan', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
        cookie = res.headers.get('set-cookie')?.split(';')[0] ?? cookie;
        return { status: res.status, body: await res.json() };
      };
    };
    const admin = client();
    assert.equal((await admin('POST', '/api/login', { login: 'admin', password: 'followup-admin-password' })).status, 200);
    const all = (await admin('GET', '/api/db')).body;
    const migrated = all.records['res.partner'].find((p) => p.id === partnerId);
    for (const key of ['followup_level', 'followup_level_delay', 'followup_date']) assert.ok(!(key in migrated));
    assert.deepEqual(migrated.followup_lines, [partner.followup_lines[0], { company_id: 1, followup_level_delay: 15, followup_date: '2025-01-01', followup_level: 1 }]);
    const migratedOwned = all.records['res.partner'].find((p) => p.id === owned.id);
    assert.equal(migratedOwned.followup_lines[0].company_id, branch.id);
    assert.equal(migratedOwned.followup_lines[0].followup_level_delay, 45);
    assert.ok(!('followup_level_delay' in migratedOwned));

    assert.equal((await admin('POST', '/api/users', { login: 'followup-company-one', password: 'followup-user-password', isAdmin: true, companies: '1' })).status, 201);
    const restricted = client();
    assert.equal((await restricted('POST', '/api/login', { login: 'followup-company-one', password: 'followup-user-password' })).status, 200);
    const snapshot = (await restricted('GET', '/api/db')).body;
    const visible = snapshot.records['res.partner'].find((p) => p.id === partnerId);
    assert.deepEqual(visible.followup_lines.map((l) => l.company_id), [1]);
    for (const key of ['followup_level', 'followup_level_delay', 'followup_date']) assert.ok(!(key in visible));
    const edited = { ...snapshot, records: { ...snapshot.records, 'res.partner': snapshot.records['res.partner'].map((p) => p.id === partnerId ? { ...p, followup_lines: [{ ...p.followup_lines[0], followup_level_delay: 30 }] } : p) } };
    const diff = diffDb(snapshot, edited);
    Object.assign(diff.upserts['res.partner'][0], { followup_level_delay: 999, followup_level: 999, followup_date: '2099-01-01' });
    const saved = await restricted('POST', '/api/diff', diff);
    assert.equal(saved.status, 200, saved.body.error);
    // Older clients without bases may submit obsolete scalars directly; the server must discard them too.
    const legacyWrite = await restricted('POST', '/api/diff', { upserts: { 'res.partner': [{ ...saved.body.records['res.partner'].find((p) => p.id === partnerId), phone: '12345', followup_level_delay: 999, followup_level: 999, followup_date: '2099-01-01' }] }, deletes: {} });
    assert.equal(legacyWrite.status, 200, legacyWrite.body.error);
    const after = (await admin('GET', '/api/db')).body.records['res.partner'].find((p) => p.id === partnerId);
    assert.equal(after.followup_lines.find((l) => l.company_id === 1).followup_level_delay, 30);
    assert.deepEqual(after.followup_lines.find((l) => l.company_id === branch.id), partner.followup_lines[0]);
    for (const key of ['followup_level', 'followup_level_delay', 'followup_date']) assert.ok(!(key in after));
    const foreign = await restricted('POST', '/api/diff', { upserts: { 'res.partner': [{ ...visible, followup_lines: [{ company_id: branch.id, followup_level_delay: 99 }] }] }, deletes: {} });
    assert.equal(foreign.status, 400);
    assert.match(foreign.body.error, /No access to this company/);
    const stale = await restricted('POST', '/api/diff', diff);
    assert.equal(stale.status, 409, 'same-company concurrent edits still conflict');
  } finally {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.send('shutdown'); await exited; }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
