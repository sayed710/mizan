import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { startServer } from './test-server.js';

async function launch(dbPath) {
  const env = { ...process.env, PORT: '0', MIZAN_DB: dbPath };
  delete env.MIZAN_ADMIN_PASSWORD;
  try {
    const server = await startServer({ env });
    await server.stop();
    return true;
  } catch (err) {
    if (err?.exited) return false;
    throw err;
  }
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
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
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
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
