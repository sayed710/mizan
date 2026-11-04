import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

async function launch(dbPath) {
  const env = { ...process.env, PORT: '0', MIZAN_DB: dbPath };
  delete env.MIZAN_ADMIN_PASSWORD;
  const child = spawn(process.execPath, ['server/index.js'], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const ready = await new Promise((resolve, reject) => {
    child.stdout.on('data', (b) => { if (/Mizan listening/.test(String(b))) resolve(true); });
    child.stderr.resume();
    child.once('exit', () => resolve(false));
    child.once('error', reject);
  });
  if (ready) { const exited = once(child, 'exit'); child.send('shutdown'); await exited; }
  return ready;
}

test('failed password sidecar creation leaves bootstrap retryable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mizan-bootstrap-'));
  const dbPath = join(dir, 'db.sqlite');
  const sidecar = `${dbPath}.admin-password`;
  try {
    mkdirSync(sidecar);
    assert.equal(await launch(dbPath), false);
    const sql = new DatabaseSync(dbPath);
    try { assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0); } finally { sql.close(); }
    rmSync(sidecar, { recursive: true });
    assert.equal(await launch(dbPath), true);
    assert.ok(readFileSync(sidecar, 'utf8').trim().length >= 8);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('bootstrap rejects an existing password sidecar without replacing its contents', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mizan-bootstrap-'));
  const dbPath = join(dir, 'db.sqlite');
  const sidecar = `${dbPath}.admin-password`;
  try {
    writeFileSync(sidecar, 'old secret', { mode: 0o644 });
    assert.equal(await launch(dbPath), false);
    assert.equal(readFileSync(sidecar, 'utf8'), 'old secret');
    const sql = new DatabaseSync(dbPath);
    try { assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0); } finally { sql.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
