import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { seed } from './seed.js';
register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

test('a failed save after demo reset rolls back to the reset response', async () => {
  const original = { fetch: globalThis.fetch, document: globalThis.document, window: globalThis.window, alert: globalThis.alert, setInterval: globalThis.setInterval };
  const before = { ...seed(), settings: { ...seed().settings, company: 'Before reset' } };
  const reset = { ...seed(), settings: { ...seed().settings, company: 'After reset' } };
  globalThis.document = { visibilityState: 'hidden' };
  globalThis.window = { dispatchEvent: () => {} };
  globalThis.alert = () => {};
  globalThis.setInterval = () => 0;
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = async (url) => {
    if (url === '/api/session') return reply({ name: 'Admin', isAdmin: true });
    if (url === '/api/db') return reply(before);
    if (url === '/api/reset') return reply(reset);
    if (url === '/api/diff') return reply({ error: 'Save refused' }, 400);
    throw new Error(`Unexpected request ${url}`);
  };
  try {
    const store = await import('./store.js');
    await store.initStore();
    await store.resetDemo();
    assert.equal(store.getDb().settings.company, 'After reset');
    const saved = await store.commit({ ...store.getDb(), settings: { ...store.getDb().settings, company: 'Unsaved' } }, { quiet: true });
    assert.equal(saved.ok, false);
    assert.equal(store.getDb().settings.company, 'After reset');
  } finally { Object.assign(globalThis, original); }
});
