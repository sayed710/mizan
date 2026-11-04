import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('a generated admin password goes to an owner-only file, never to the server log', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizan-admin-'));
  const dbFile = join(directory, 'test.sqlite');
  const { MIZAN_ADMIN_PASSWORD, ...env } = process.env;
  const child = spawn(process.execPath, ['server/index.js'], { cwd: new URL('..', import.meta.url), env: { ...env, PORT: '0', MIZAN_DB: dbFile, MIZAN_SECURE_COOKIE: '0' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = '';
  try {
    const origin = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Server did not start: ${output}`)), 15000);
      child.stdout.on('data', (chunk) => {
        output += chunk;
        const match = /Mizan listening on (http:\/\/localhost:\d+)/.exec(output);
        if (match) { clearTimeout(timeout); resolve(match[1]); }
      });
      child.stderr.on('data', (chunk) => { output += chunk; });
      child.once('exit', () => { clearTimeout(timeout); reject(new Error(output)); });
    });
    const password = (await readFile(`${dbFile}.admin-password`, 'utf8')).trim();
    assert.ok(password.length >= 12);
    assert.ok(!output.includes(password), 'the password must not appear in the log');
    assert.match(output, /admin-password/);
    const login = await fetch(`${origin}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mizan' }, body: JSON.stringify({ login: 'admin', password }) });
    assert.equal(login.status, 200);
  } finally {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.send('shutdown'); await exited; }
    await rm(directory, { recursive: true, force: true });
  }
});
