import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom } from './test-support/dom.js';
import { seed } from './seed.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));
const textOf = (node) => node.nodeType === 3 ? node.nodeValue : (node.childNodes ?? []).map(textOf).join('');

test('server Audit Trail filters rows for other companies and deleted records', async () => {
  const { makeEl } = setupDom(); globalThis.location = { hash: '#/accounting' };
  const base = seed();
  const db = { ...base, settings: { ...base.settings, current_company_id: 2, allowed_company_ids: [2] }, records: { ...base.records,
    'res.company': [{ id: 1, name: 'First' }, { id: 2, name: 'Second' }],
    'account.move': [{ id: 71, name: 'First move', company_id: 1 }, { id: 72, name: 'Second move', company_id: 2 }] } };
  const rows = [71, 72, 73, 74].map((id) => ({ id, model: 'account.move', res_id: id, ...(id === 73 ? { company_id: 2 } : id === 74 ? { company_id: 1 } : {}), action: 'write', actor: `Actor ${id}`, at: new Date().toISOString(), changes: { ref: ['', `Secret ${id}`] } }));
  const oldFetch = globalThis.fetch, oldInterval = globalThis.setInterval;
  const requests = [];
  globalThis.setInterval = () => 0;
  globalThis.fetch = async (url) => { requests.push(url); return { ok: true, status: 200, headers: { get: (name) => name === 'content-type' ? 'application/json' : null }, json: async () => url === '/api/session' ? { name: 'Admin' } : url === '/api/db' ? db : rows }; };
  const React = await import('react'); const { createRoot } = await import('react-dom/client');
  const { initStore } = await import('./store.js'); await initStore(); const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div'); host.ownerDocument = globalThis.document; const root = createRoot(host);
  try { await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'audit' } })));
    assert.match(textOf(host), /Secret 72/); assert.match(textOf(host), /Secret 73/); assert.doesNotMatch(textOf(host), /Secret 71|Secret 74|Actor 71|Actor 74/);
    assert.ok(requests.some((url) => url.startsWith('/api/audit?') && new URLSearchParams(url.split('?')[1]).get('selected') === '1'));
  } finally { await React.act(async () => root.unmount()); globalThis.fetch = oldFetch; globalThis.setInterval = oldInterval; }
});
