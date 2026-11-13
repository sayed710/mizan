import { test } from 'node:test';
import { register } from 'node:module';
import assert from 'node:assert/strict';
import { seed } from './seed.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

// Seeded before any session actor is set (seeding as a restricted user is refused).
const seeded = seed();

// Serve the store a signed-in, non-admin session (server mode) without a real backend.
async function renderSettingsAs(user) {
  const json = (body) => ({ ok: true, status: 200, headers: { get: (h) => ({ 'content-type': 'application/json', etag: '"1"' })[h.toLowerCase()] ?? null }, json: async () => body });
  const prevFetch = globalThis.fetch;
  const prevInterval = globalThis.setInterval;
  globalThis.fetch = async (path) => json(path === '/api/session' ? user : path === '/api/db' ? seeded : []);
  globalThis.setInterval = () => 0;
  try {
    const React = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { initStore } = await import('./store.js');
    const { Settings } = await import('./views/Settings.jsx');
    await initStore();
    return renderToStaticMarkup(React.createElement(Settings));
  } finally {
    globalThis.setInterval = prevInterval;
    globalThis.fetch = prevFetch;
  }
}

test('Settings Currencies link appears only for users who can open the Accounting app', async () => {
  const settingsOnly = await renderSettingsAs({ id: 2, login: 'clerk', name: 'Clerk', isAdmin: false, apps: ['settings'] });
  assert.match(settingsOnly, /<span>Currencies<\/span>/);
  assert.doesNotMatch(settingsOnly, /href="#\/accounting\/currencies"/);

  const accountant = await renderSettingsAs({ id: 3, login: 'acc', name: 'Acc', isAdmin: false, apps: ['accounting', 'settings'] });
  assert.match(accountant, /<a href="#\/accounting\/currencies">Currencies<\/a>/);
});
