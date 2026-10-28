import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { claimWriter } from './storage.js';

const stop = async (child) => {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.send('shutdown');
  await exited;
};

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
    env: { ...process.env, PORT: '0', MIZAN_DB: dbPath, MIZAN_ADMIN_PASSWORD: 'lease-admin-pw', ...env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
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
    await stop(first.child);
    const third = await start(join(dir, 'db.sqlite'));
    assert.ok(third.url, third.out);
    await stop(third.child);
  } finally {
    await stop(first.child);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('renewing waits briefly for a competing write lock, then fails cleanly instead of hanging, and recovers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mizan-lease-'));
  try {
    const sqlA = new DatabaseSync(join(dir, 'db.sqlite'));
    const sqlB = new DatabaseSync(join(dir, 'db.sqlite'));
    const a = claimWriter(sqlA, { id: '1@a', busyMs: 30 });
    sqlB.exec('BEGIN IMMEDIATE'); // another process is writing
    assert.throws(() => a.renew(), /locked|busy/i);
    sqlB.exec('ROLLBACK');
    assert.doesNotThrow(() => a.renew());
    sqlA.close();
    sqlB.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('renewal never takes back a lease another server claimed in between', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mizan-lease-'));
  try {
    const sqlA = new DatabaseSync(join(dir, 'db.sqlite'));
    const sqlB = new DatabaseSync(join(dir, 'db.sqlite'));
    const a = claimWriter(sqlA, { id: '1@a' });
    const b = claimWriter(sqlB, { id: '2@b', force: true });
    a.renew(); // the old holder renewing after the takeover changes nothing
    assert.equal(JSON.parse(sqlB.prepare("SELECT value FROM kv WHERE key = 'writer'").get().value).id, '2@b');
    assert.doesNotThrow(() => b.assert());
    sqlA.close();
    sqlB.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('after a forced takeover the old server stops on its next login, user or API-key write', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mizan-lease-'));
  const dbPath = join(dir, 'db.sqlite');
  const old = await start(dbPath);
  let next;
  try {
    assert.ok(old.url, old.out);
    next = await start(dbPath, { MIZAN_FORCE_TAKEOVER: '1' });
    assert.ok(next.url, next.out);
    const exited = new Promise((resolve) => old.child.on('exit', resolve));
    const res = await fetch(`${old.url}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mizan' }, body: JSON.stringify({ login: 'admin', password: 'lease-admin-pw' }) }).catch(() => null);
    assert.ok(!res || res.status >= 400, `the displaced server must not hand out a session (got ${res?.status})`);
    assert.equal(await exited, 1);
  } finally {
    await stop(old.child);
    await stop(next?.child);
    rmSync(dir, { recursive: true, force: true });
  }
});
