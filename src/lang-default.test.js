import { test } from 'node:test';
import assert from 'node:assert/strict';

// i18n.js reads the language once at import: each case loads a fresh copy.
let copy = 0;
const fresh = () => import(`./i18n.js?copy=${copy++}`);
async function langFor(stored, languages, { search = '', page = true } = {}) {
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? stored : null), setItem() {} };
  Object.defineProperty(globalThis, 'navigator', { value: { languages }, configurable: true });
  globalThis.location = { search };
  if (page) globalThis.document = {}; else delete globalThis.document;
  return (await fresh()).lang;
}

test('a first visit follows the first supported browser language', async () => {
  assert.equal(await langFor(null, ['ar-EG', 'en-US']), 'ar');
  assert.equal(await langFor(null, ['fr-FR', 'ar']), 'ar');
  assert.equal(await langFor(null, ['en-US', 'ar']), 'en');
  assert.equal(await langFor(null, ['fr-FR']), 'en');
});

test('a stored language wins over the browser, and an unknown stored value is ignored', async () => {
  assert.equal(await langFor('en', ['ar-EG']), 'en');
  assert.equal(await langFor('ar', ['en-US']), 'ar');
  assert.equal(await langFor('xx', ['ar-EG']), 'ar');
});

test('outside a browser page the system locale is ignored', async () => {
  assert.equal(await langFor(null, ['ar-EG'], { page: false }), 'en');
});

test('?lang= in the address wins, and an unsupported value is ignored', async () => {
  assert.equal(await langFor('ar', ['ar-EG'], { search: '?lang=en' }), 'en');
  assert.equal(await langFor(null, ['en-US'], { search: '?lang=ar' }), 'ar');
  assert.equal(await langFor('ar', ['en-US'], { search: '?lang=xx' }), 'ar');
});

test('switching with blocked storage carries the choice in the address; with storage it drops ?lang=', async () => {
  const visited = [];
  const page = (href, setItem) => {
    globalThis.document = {};
    globalThis.localStorage = { getItem: () => null, setItem };
    globalThis.location = { href, search: new URL(href).search, replace: (to) => visited.push(to), reload: () => visited.push('reload') };
  };
  page('http://localhost/#/accounting', () => { throw new Error('blocked'); });
  (await fresh()).setLang('ar');
  page('http://localhost/?lang=ar#/accounting', () => {});
  (await fresh()).setLang('en');
  page('http://localhost/#/accounting', () => {});
  (await fresh()).setLang('ar');
  assert.deepEqual(visited, ['http://localhost/?lang=ar#/accounting', 'http://localhost/#/accounting', 'reload']);
});
