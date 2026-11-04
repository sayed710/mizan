import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const sources = ['.', 'models'].flatMap((dir) => readdirSync(join(root, dir)).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js')).map((f) => resolve(root, dir, f)));
const importsOf = (file) => [...readFileSync(file, 'utf8').matchAll(/^(?:import|export)\s[^;]*?from\s+'(\.[^']+)'|^import\s+'(\.[^']+)'/gm)].map((m) => resolve(dirname(file), m[1] ?? m[2]));
const graph = new Map(sources.map((f) => [f, importsOf(f)]));

/** Modules reachable from `start` through static imports. */
function reachable(start) {
  const seen = new Set();
  const stack = [...(graph.get(start) ?? [])];
  while (stack.length) {
    const next = stack.pop();
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...(graph.get(next) ?? []));
  }
  return seen;
}

const index = resolve(root, 'models/index.js');

test('nothing models/index.js imports leads back to it, so any module can be imported first (ARCH-004)', () => {
  const back = [...graph.get(index)].filter((dep) => dep === index || reachable(dep).has(index)).map((f) => relative(root, f));
  assert.deepEqual(back, []);
});

test('the ORM, validation and sync read models from the registry, not from models/index.js', () => {
  for (const name of ['orm.js', 'validate.js', 'sync.js']) assert.ok(!reachable(resolve(root, name)).has(index), name);
});
