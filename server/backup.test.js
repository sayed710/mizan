import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { scheduleSnapshots, snapshot } from './backup.js';

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

test('scheduled snapshots run only when a backup folder is set, and failures are logged', (t) => {
  const dir = temp(t);
  const sql = live(dir);
  assert.equal(scheduleSnapshots(sql, {}), null);
  const logs = [];
  const log = { log: (m) => logs.push(m), error: (m) => logs.push(m) };
  clearInterval(scheduleSnapshots(sql, { MIZAN_BACKUP_DIR: join(dir, 'auto') }, log));
  assert.match(logs[0], /^Backup written: .*mizan-.*\.sqlite$/);
  sql.close();
  clearInterval(scheduleSnapshots(sql, { MIZAN_BACKUP_DIR: join(dir, 'auto') }, log));
  assert.match(logs[1], /^Backup failed/);
});
