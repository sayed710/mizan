import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { apps, APP_INFO } from './models/index.js';

const CORE = ['apps', 'settings'];

test('every installable app has an app-store category and description', () => {
  assert.deepEqual(apps.filter((a) => !CORE.includes(a.id) && !APP_INFO[a.id]).map((a) => a.id), []);
});

test('every app has an explicit home-screen position (unordered apps would jump to the front)', () => {
  const source = readFileSync(new URL('./models/index.js', import.meta.url), 'utf8');
  const order = source.match(/const ORDER = \[([\s\S]*?)\];/)[1].match(/'([\w-]+)'/g).map((s) => s.slice(1, -1));
  assert.deepEqual(apps.filter((a) => !order.includes(a.id)).map((a) => a.id), []);
});

test('the README app list matches the registry', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const section = readme.slice(readme.indexOf('## Apps'), readme.indexOf('POS includes'));
  assert.match(section, new RegExp(`\(${apps.length} apps\)`));
  for (const a of apps) assert.ok(section.includes(a.name), `${a.name} is missing from README.md`);
});
