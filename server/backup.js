// Consistent SQLite snapshots. VACUUM INTO copies the whole file (records, messages, users, sessions, API keys)
// inside one read transaction, so a snapshot taken while the server writes is never half a commit.
// CLI: `npm run backup -- [dir]` (default ./backups) snapshots MIZAN_DB while the server keeps running.
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = /^mizan-\d{8}T\d{9}Z\.sqlite$/;
const stamp = (d) => d.toISOString().replace(/[-:.]/g, '');

/**
 * Write a snapshot into `dir` and keep only the newest `keep` snapshots there. Returns the new file.
 * The copy is made under a private temporary name (owner-only folder and file, never matched by the retention
 * rule) and moved to its final name only after it succeeded, so a failed run leaves nothing that could displace a
 * good snapshot and no moment where the data is readable by other local users.
 */
export function snapshot(sql, dir, { keep = 7, now = new Date() } = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const work = mkdtempSync(join(dir, '.partial-'));
  const file = join(dir, `mizan-${stamp(now)}.sqlite`);
  try {
    chmodSync(work, 0o700);
    const partial = join(work, 'snapshot.sqlite');
    sql.prepare('VACUUM INTO ?').run(partial);
    chmodSync(partial, 0o600);
    const copy = new DatabaseSync(partial, { readOnly: true });
    try {
      if (copy.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('The snapshot failed its integrity check');
    } finally {
      copy.close();
    }
    renameSync(partial, file);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  const all = readdirSync(dir).filter((f) => NAME.test(f)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - keep))) rmSync(join(dir, old));
  return file;
}

/** Open an existing Mizan database for backup: a wrong path must fail, not become a fresh empty file. */
export function openSource(path) {
  if (!existsSync(path)) throw new Error(`Database not found: ${path}`);
  const sql = new DatabaseSync(path, { readOnly: true });
  const tables = new Set(sql.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
  if (!['records', 'kv', 'users'].every((t) => tables.has(t))) { sql.close(); throw new Error(`${path} is not a Mizan database`); }
  return sql;
}

/**
 * Snapshot on start and then every `hours` when MIZAN_BACKUP_DIR is set. The copy runs in a separate process with
 * its own connection, so a large database never stalls the server's requests; errors are logged, never fatal.
 */
export function scheduleSnapshots(dbPath, env = process.env, log = console, { onDone } = {}) {
  if (!env.MIZAN_BACKUP_DIR) return null;
  const hours = Math.max(1, Number(env.MIZAN_BACKUP_HOURS) || 24);
  const run = () => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), resolve(env.MIZAN_BACKUP_DIR)], {
      env: { ...process.env, MIZAN_DB: dbPath, MIZAN_BACKUP_KEEP: String(Math.max(1, Number(env.MIZAN_BACKUP_KEEP) || 7)) }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { err += b; });
    child.on('error', (e) => { log.error(`Backup failed: ${e.message}`); onDone?.(false); });
    child.on('close', (code) => {
      if (code === 0) log.log(`Backup written: ${out.trim()}`);
      else log.error(`Backup failed: ${err.split('\n').find((l) => l.trim() && !/ExperimentalWarning|trace-warnings/.test(l)) ?? `exit code ${code}`}`);
      onDone?.(code === 0);
    });
  };
  run();
  return setInterval(run, hours * 3600 * 1000).unref();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  try {
    const sql = openSource(resolve(process.env.MIZAN_DB || join(root, 'mizan.sqlite')));
    console.log(snapshot(sql, resolve(process.argv[2] ?? 'backups'), { keep: Math.max(1, Number(process.env.MIZAN_BACKUP_KEEP) || 7) }));
    sql.close();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
