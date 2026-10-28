import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { openSource, scheduleSnapshots, snapshot } from './backup.js';

const temp = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mizan-backup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const live = (dir) => {
  const sql = new DatabaseSync(join(dir, 'live.sqlite'));
  sql.exec("PRAGMA journal_mode = WAL; CREATE TABLE records (id INTEGER PRIMARY KEY, data TEXT); CREATE TABLE users (login TEXT)");
  sql.exec("INSERT INTO records (data) VALUES ('a'), ('b'); INSERT INTO users VALUES ('admin')");
  return sql;
};

test('a snapshot of a live WAL database holds every committed row, users included', (t) => {
  const dir = temp(t);
  const sql = live(dir);
  const file = snapshot(sql, join(dir, 'out'));
  sql.exec("INSERT INTO records (data) VALUES ('after')");
  const copy = new DatabaseSync(file, { readOnly: true });
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM records').get().n, 2);
  assert.equal(copy.prepare('SELECT login FROM users').get().login, 'admin');
  copy.close();
  sql.close();
});

test('only the newest snapshots are kept', (t) => {
  const dir = temp(t);
  const sql = live(dir);
  const out = join(dir, 'out');
  for (let i = 0; i < 4; i++) snapshot(sql, out, { keep: 2, now: new Date(Date.UTC(2026, 0, 1 + i)) });
  assert.deepEqual(readdirSync(out), ['mizan-20260103T000000000Z.sqlite', 'mizan-20260104T000000000Z.sqlite']);
  sql.close();
});

test('snapshots and their folder are owner-only, and no partial copy is left behind', (t) => {
  const dir = temp(t);
  const sql = live(dir);
  const out = join(dir, 'out');
  const file = snapshot(sql, out);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(out).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(out), [file.split('/').at(-1)]);
  sql.close();
});

test('a failed snapshot leaves no file that could displace a good one', (t) => {
  const dir = temp(t);
  const sql = live(dir);
  const out = join(dir, 'out');
  snapshot(sql, out, { keep: 1, now: new Date(Date.UTC(2026, 0, 1)) });
  const broken = { prepare: () => ({ run: (path) => { writeFileSync(path, 'half written'); throw new Error('disk full'); } }) };
  assert.throws(() => snapshot(broken, out, { keep: 1, now: new Date(Date.UTC(2026, 0, 2)) }), /disk full/);
  assert.deepEqual(readdirSync(out), ['mizan-20260101T000000000Z.sqlite']);
  sql.close();
});

test('a missing or foreign database is refused instead of backed up as an empty file', (t) => {
  const dir = temp(t);
  assert.throws(() => openSource(join(dir, 'typo.sqlite')), /not found/);
  assert.equal(readdirSync(dir).length, 0); // nothing was created
  const other = new DatabaseSync(join(dir, 'other.sqlite'));
  other.exec('CREATE TABLE unrelated (x)');
  other.close();
  assert.throws(() => openSource(join(dir, 'other.sqlite')), /not a Mizan database/);
  const cli = spawnSync(process.execPath, ['server/backup.js', join(dir, 'out')], { env: { ...process.env, MIZAN_DB: join(dir, 'typo.sqlite') }, encoding: 'utf8' });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /not found/);
});

test('scheduled snapshots run in a separate process, only when a backup folder is set, and failures are logged', async (t) => {
  const dir = temp(t);
  const real = new DatabaseSync(join(dir, 'mizan.sqlite'));
  real.exec("PRAGMA journal_mode = WAL; CREATE TABLE records (id INTEGER PRIMARY KEY, data TEXT); CREATE TABLE users (login TEXT); CREATE TABLE kv (key TEXT, value TEXT)");
  assert.equal(scheduleSnapshots(join(dir, 'mizan.sqlite'), {}), null);
  const logs = [];
  const log = { log: (m) => logs.push(m), error: (m) => logs.push(m) };
  const done = (path) => new Promise((resolve) => clearInterval(scheduleSnapshots(path, { MIZAN_BACKUP_DIR: join(dir, 'auto') }, log, { onDone: resolve })));
  assert.equal(await done(join(dir, 'mizan.sqlite')), true);
  assert.match(logs[0], /^Backup written: .*mizan-.*\.sqlite$/);
  assert.equal(await done(join(dir, 'missing.sqlite')), false);
  assert.match(logs[1], /^Backup failed: Database not found/);
  real.close();
});
