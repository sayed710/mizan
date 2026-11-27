import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Arabic must be active before i18n.js reads the language at import time.
globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem() {} };
const { t } = await import('./i18n.js');
const { models, apps, APP_INFO } = await import('./models/index.js');

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
  const addMenu = (m) => {
    if (m.label) keys.add(m.label);
    for (const c of m.children ?? []) addMenu(c);
  };
  for (const [category, summary] of Object.values(APP_INFO)) keys.add(category).add(summary);
  for (const app of apps ?? []) {
    if (app.name) keys.add(app.name);
    for (const m of app.menus ?? []) addMenu(m);
  }
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

// The server starts, backs up and holds the database lease from a terminal: an operator reads these, not a screen.
// `test-server.js` is a test-only helper alongside `server/*.test.js`.
const OPERATOR_FILES = ['storage.js', 'backup.js', 'test-server.js'];
const OPERATOR_MESSAGES = new Set(['Run "npm run build" first']);

/** Messages a screen can show after a failed action: literal errors, browser dialogs and server answers outside tests. */
function messageStrings() {
  const walk = (d) => readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    if (statSync(p).isDirectory()) return n === 'test-support' ? [] : walk(p);
    return /\.jsx?$/.test(n) && !n.includes('.test.') && !['seed.js', 'migrations.js', 'i18n.js', ...OPERATOR_FILES].includes(n) ? [p] : [];
  });
  const keys = new Set();
  for (const folder of ['.', '../server']) {
    for (const file of walk(fileURLToPath(new URL(folder, import.meta.url)))) {
      for (const m of readFileSync(file, 'utf8').matchAll(/(?:\b(?:new Error|alert|confirm|prompt)\(|\berror:)\s*(['"])((?:\\.|(?!\1)[^\\\n])*)\1/g)) keys.add(m[2].replace(/\\(['"])/g, '$1'));
    }
  }
  // Spreadsheet error codes such as #VALUE! and bare identifiers such as a badge colour are not prose.
  return [...keys].filter((k) => /[A-Za-z]{3}/.test(k) && !k.startsWith('#') && !/^[a-z_]+$/.test(k) && !OPERATOR_MESSAGES.has(k));
}

test('every UI string, field label and selection option has an Arabic translation', () => {
  const missing = uiStrings().filter((k) => !BRANDS.has(k) && t(k) === k);
  assert.deepEqual(missing, []);
});

test('every literal error and dialog message has an Arabic translation', () => {
  const missing = messageStrings().filter((k) => t(k) === k);
  assert.deepEqual(missing, []);
});

test('every Arabic UI and error translation is readable Arabic without placeholder question marks', () => {
  const corrupted = [...uiStrings(), ...messageStrings()].filter((k) => !BRANDS.has(k) && /\?{2,}/.test(t(k)));
  assert.deepEqual(corrupted, []);
  for (const key of ['No access to that company', 'Select an active partner belonging to the bill company']) {
    const translated = t(key);
    assert.notEqual(translated, key);
    assert.match(translated, /[\u0600-\u06FF]/);
    assert.doesNotMatch(translated, /\?/);
  }
});

test('custom fields named name or email retain their user-entered label in Arabic mode', () => {
  const customNameField = { type: 'char', label: 'Custom Name', custom: true };
  const customEmailField = { type: 'char', label: 'Custom Email', custom: true };
  const resolve = (f) => (f.custom ? f.label : t(f.label));
  assert.equal(resolve(customNameField), 'Custom Name');
  assert.equal(resolve(customEmailField), 'Custom Email');
});
