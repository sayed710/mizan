import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './test-server.js';

test('a server that fails to start is dead before startServer rejects', async () => {
  const err = await startServer({ env: { ...process.env, PORT: '0', MIZAN_DB: ':memory:' }, timeoutMs: 1 }).then(
    () => assert.fail('startServer should reject'),
    (e) => e,
  );
  assert.ok(err instanceof Error);
  assert.ok(err.child.exitCode !== null || err.child.signalCode !== null, 'child process has exited');
});
