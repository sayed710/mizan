import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Arabic must be active before i18n.js reads the language at import time.
globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem() {} };
const { t } = await import('./i18n.js');
const { models } = await import('./models/index.js');

// Product and platform names stay in their original spelling.
const BRANDS = new Set(['Amazon', 'Noon', 'Shopee', 'Lazada', 'TikTok Shop', 'Jumia', 'Facebook', 'Instagram', 'X', 'YouTube']);

const list = (x) => (Array.isArray(x) ? x : []);
function uiStrings() {
  const keys = new Set();
  const field = (f) => {
    if (f.label) keys.add(f.label);
    for (const o of f.options ?? []) if (typeof o?.[1] === 'string') keys.add(o[1]);
    for (const sub of Object.values(f.fields ?? {})) field(sub);
  };
  for (const def of Object.values(models)) {
    if (def.label) keys.add(def.label);
    Object.values(def.fields ?? {}).forEach(field);
    for (const b of list(def.form?.buttons)) if (typeof b.label === 'string') keys.add(b.label);
    for (const tab of list(def.form?.tabs)) if (tab.label) keys.add(tab.label);
    for (const f of list(def.filters)) if (f.label) keys.add(f.label);
  }
  const dir = fileURLToPath(new URL('.', import.meta.url));
  const walk = (d) => readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? walk(p) : /\.jsx?$/.test(n) && !n.includes('.test.') ? [p] : [];
  });
  for (const file of walk(dir)) {
    for (const m of readFileSync(file, 'utf8').matchAll(/\bt\(\s*(['"])((?:\\.|(?!\1).)*)\1/g)) keys.add(m[2].replace(/\\(['"])/g, '$1'));
  }
  return [...keys].filter((k) => /[A-Za-z]/.test(k));
}

test('every UI string, field label and selection option has an Arabic translation', () => {
  const missing = uiStrings().filter((k) => !BRANDS.has(k) && t(k) === k);
  assert.deepEqual(missing, []);
});
