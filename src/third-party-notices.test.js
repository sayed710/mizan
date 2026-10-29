import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('THIRD_PARTY_NOTICES.md lists every production dependency at its locked version with exact inventory and license text', () => {
  const notices = read('THIRD_PARTY_NOTICES.md');
  assert.doesNotMatch(notices, /No licence file is included/);

  const headings = [...notices.matchAll(/^## (@?[^ ]+) ([^ ]+) \(([^)]+)\)$/gm)].map((m) => `${m[1]}@${m[2]}`);
  const headingSet = new Set(headings);
  assert.equal(headings.length, headingSet.size, 'notice headings must not contain duplicates');

  const shipped = Object.entries(JSON.parse(read('package-lock.json')).packages)
    .filter(([path, p]) => path.startsWith('node_modules/') && !p.dev && !p.optional)
    .map(([path, p]) => `${path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length)}@${p.version}`);
  const shippedSet = new Set(shipped);

  assert.deepEqual(headingSet, shippedSet, 'notices must match production dependencies exactly without extras or omissions');
});
