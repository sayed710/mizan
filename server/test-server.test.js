import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './test-server.js';

const failedStart = (options) => startServer({ env: { ...process.env, PORT: '0', MIZAN_DB: ':memory:' }, ...options }).then(
  () => assert.fail('startServer should reject'),
  (e) => e,
);
const isDead = (child) => child.exitCode !== null || child.signalCode !== null;

test('a server killed for missing its startup timeout is dead before startServer rejects', async () => {
  const err = await failedStart({ timeoutMs: 1 });
  assert.ok(err.child, 'the rejected error carries the child process');
  assert.ok(isDead(err.child), 'child process has exited');
});

test('a server that exits on its own during startup is dead before startServer rejects', async () => {
  const err = await failedStart({ preload: 'data:text/javascript,process.exit(3)' });
  assert.equal(err.exited, true);
  assert.equal(err.code, 3);
  assert.ok(isDead(err.child), 'child process has exited');
});
