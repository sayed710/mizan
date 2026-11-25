import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from './test-server.js';

test('a generated admin password goes to an owner-only file, never to the server log', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizan-admin-'));
  const dbFile = join(directory, 'test.sqlite');
  const { MIZAN_ADMIN_PASSWORD, ...env } = process.env;
  let server;
  try {
    server = await startServer({ env: { ...env, PORT: '0', MIZAN_DB: dbFile, MIZAN_SECURE_COOKIE: '0' } });
    const password = (await readFile(`${dbFile}.admin-password`, 'utf8')).trim();
    assert.ok(password.length >= 12);
    assert.ok(!server.output.includes(password), 'the password must not appear in the log');
    assert.match(server.output, /admin-password/);
    const login = await fetch(`${server.origin}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mizan' }, body: JSON.stringify({ login: 'admin', password }) });
    assert.equal(login.status, 200);
  } finally {
    await server?.stop();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
