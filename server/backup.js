// Consistent SQLite snapshots. VACUUM INTO copies the whole file (records, messages, users, sessions, API keys)
// inside one read transaction, so a snapshot taken while the server writes is never half a commit.
// CLI: `npm run backup -- [dir]` (default ./backups) snapshots MIZAN_DB while the server keeps running.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = /^mizan-\d{8}T\d{9}Z\.sqlite$/;
const stamp = (d) => d.toISOString().replace(/[-:.]/g, '');

/** Write a snapshot into `dir` and keep only the newest `keep` snapshots there. Returns the new file. */
export function snapshot(sql, dir, { keep = 7, now = new Date() } = {}) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `mizan-${stamp(now)}.sqlite`);
  sql.prepare('VACUUM INTO ?').run(file);
  const all = readdirSync(dir).filter((f) => NAME.test(f)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - keep))) rmSync(join(dir, old));
  return file;
}

/** Snapshot on start and then every `hours` when MIZAN_BACKUP_DIR is set; errors are logged, never fatal. */
export function scheduleSnapshots(sql, env = process.env, log = console) {
  if (!env.MIZAN_BACKUP_DIR) return null;
  const keep = Math.max(1, Number(env.MIZAN_BACKUP_KEEP) || 7);
  const hours = Math.max(1, Number(env.MIZAN_BACKUP_HOURS) || 24);
  const run = () => {
    try { log.log(`Backup written: ${snapshot(sql, env.MIZAN_BACKUP_DIR, { keep })}`); } catch (e) { log.error(`Backup failed: ${e.message}`); }
  };
  run();
  return setInterval(run, hours * 3600 * 1000).unref();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const sql = new DatabaseSync(process.env.MIZAN_DB ?? join(root, 'mizan.sqlite'));
  console.log(snapshot(sql, resolve(process.argv[2] ?? 'backups'), { keep: Math.max(1, Number(process.env.MIZAN_BACKUP_KEEP) || 7) }));
  sql.close();
}
