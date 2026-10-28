import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('THIRD_PARTY_NOTICES.md lists every production dependency at its locked version', () => {
  const notices = read('THIRD_PARTY_NOTICES.md');
  const shipped = Object.entries(JSON.parse(read('package-lock.json')).packages)
    .filter(([path, p]) => path.startsWith('node_modules/') && !p.dev && !p.optional);
  assert.ok(shipped.length > 0);
  for (const [path, p] of shipped) {
    const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    assert.ok(notices.includes(`## ${name} ${p.version} (`), `${name} ${p.version} is missing: run npm run notices`);
  }
});
