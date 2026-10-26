import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { claimWriter } from './storage.js';

test('a second writer is refused while the lease is fresh, and can take over a stale or forced one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mizan-lease-'));
  try {
    let clock = 1_000_000;
    const now = () => clock;
    const sqlA = new DatabaseSync(join(dir, 'db.sqlite'));
    const sqlB = new DatabaseSync(join(dir, 'db.sqlite'));
    const a = claimWriter(sqlA, { now, id: '1@a' });
    assert.throws(() => claimWriter(sqlB, { now, id: '2@b' }), /Another Mizan server \(pid 1\) is using this database/);
    clock += 25_000;
    a.renew();
    clock += 25_000;
    assert.throws(() => claimWriter(sqlB, { now, id: '2@b' }), /is using this database/); // renewed 25 s ago
    clock += 31_000;
    const b = claimWriter(sqlB, { now, id: '2@b' }); // stale: the first one stopped renewing
    assert.throws(() => a.assert(), /took over/);
    assert.doesNotThrow(() => b.assert());
    a.renew(); // a stale holder cannot win the lease back by renewing
    assert.doesNotThrow(() => b.assert());
    const c = claimWriter(sqlA, { now, id: '3@c', force: true });
    assert.throws(() => b.assert(), /took over/);
    c.release();
    assert.doesNotThrow(() => claimWriter(sqlB, { now, id: '4@d' }));
    sqlA.close();
    sqlB.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const start = (dbPath, env = {}) => new Promise((resolve) => {
  const child = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: '0', MIZAN_DB: dbPath, MIZAN_ADMIN_PASSWORD: 'lease-admin-pw', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  const done = (result) => resolve({ child, out, ...result });
  child.stdout.on('data', (b) => { out += b; const m = /Mizan listening on (http:\/\/localhost:\d+)/.exec(out); if (m) done({ url: m[1] }); });
  child.stderr.on('data', (b) => { out += b; });
  child.on('exit', (code) => done({ code }));
});

test('a second server on the same database file refuses to start', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mizan-lease-'));
  const first = await start(join(dir, 'db.sqlite'));
  try {
    assert.ok(first.url, first.out);
    const second = await start(join(dir, 'db.sqlite'));
    assert.equal(second.code, 1);
    assert.match(second.out, /Another Mizan server .* is using this database/);
    // Stopping the first one releases the database right away.
    await new Promise((resolve) => { first.child.on('exit', resolve); first.child.kill(); });
    const third = await start(join(dir, 'db.sqlite'));
    assert.ok(third.url, third.out);
    third.child.kill();
  } finally {
    first.child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
