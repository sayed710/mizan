import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
// The rule lives in the repository's .gitignore, so it can only be checked from a Git checkout (not inside the Docker build context).
const inCheckout = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, encoding: 'utf8' }).stdout?.trim() === 'true';

test('Git ignores local Claude settings using the repository rule', { skip: !inCheckout && 'not a Git checkout' }, () => {
  const result = spawnSync('git', ['-c', 'core.excludesFile=', 'check-ignore', '--no-index', '-v', '.claude/settings.local.json'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^\.gitignore:\d+:\.claude\/settings\.local\.json\s+\.claude\/settings\.local\.json\s*$/);
  const shared = spawnSync('git', ['-c', 'core.excludesFile=', 'check-ignore', '--no-index', '.claude/settings.json'], { cwd: root, encoding: 'utf8' });
  assert.equal(shared.status, 1, shared.stderr);
});
