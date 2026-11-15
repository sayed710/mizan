import { test } from 'node:test';
import assert from 'node:assert/strict';

// i18n.js reads the language once at import: each case loads a fresh copy.
let copy = 0;
async function langFor(stored, languages) {
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? stored : null), setItem() {} };
  Object.defineProperty(globalThis, 'navigator', { value: { languages }, configurable: true });
  return (await import(`./i18n.js?copy=${copy++}`)).lang;
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
