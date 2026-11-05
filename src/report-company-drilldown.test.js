import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));
const props = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];
const textOf = (node) => node.nodeType === 3 ? node.nodeValue : (node.childNodes ?? []).map(textOf).join('');

test('analytic report includes selected companies and period and links to source entries', async () => {
  const { makeEl } = setupDom(); globalThis.location = { hash: '#/accounting' };
  const React = await import('react'); const { createRoot } = await import('react-dom/client');
  const { initStore, getDb, commit } = await import('./store.js'); await initStore();
  const base = getDb(); const year = new Date().getFullYear();
  const db = { ...base, settings: { ...base.settings, current_company_id: 1, allowed_company_ids: [1, 2] }, records: { ...base.records,
    'res.company': [{ id: 1, name: 'First', currency_id: 1 }, { id: 2, name: 'Second', currency_id: 1 }],
    'account.analytic.account': [{ id: 91, name: 'Project', company_id: 1 }, { id: 92, name: 'Foreign project', company_id: 2 }],
    'account.analytic.line': [
      { id: 91, name: 'Current line', account_id: 91, amount: 123, company_id: 1, move_id: 91, date: `${year}-02-01` },
      { id: 92, name: 'Old line', account_id: 91, amount: 456, company_id: 1, move_id: 92, date: `${year - 1}-02-01` },
      { id: 93, name: 'Foreign line', account_id: 91, amount: 789, company_id: 2, move_id: 93, date: `${year}-02-01` },
      { id: 94, name: 'Unposted line', account_id: 91, amount: 999, company_id: 1, move_id: 94, date: `${year}-02-01` },
    ],
    'account.move': [91, 92, 93, 94].map((id) => ({ id, name: `ENTRY-${id}`, state: id === 94 ? 'draft' : 'posted', move_type: 'entry', company_id: id === 93 ? 2 : 1, line_ids: [] })),
  } };
  await React.act(async () => commit(db));
  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div'); host.ownerDocument = globalThis.document; const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'analytic' } })));
    assert.match(textOf(host), /123\.00/);
    assert.match(textOf(host), /Foreign project/); assert.match(textOf(host), /789\.00/); assert.match(textOf(host), /912\.00/);
    assert.doesNotMatch(textOf(host), /456\.00|1,122\.00/);
    assert.ok(find(host, (node) => node.tagName === 'A' && props(node)?.href === '#/open/account.move/91'));
    assert.ok(find(host, (node) => node.tagName === 'A' && props(node)?.href === '#/open/account.analytic.line/91'));
    assert.equal(find(host, (node) => node.tagName === 'A' && props(node)?.href === '#/open/account.move/92'), null);
    await React.act(async () => commit({ ...db, settings: { ...db.settings, allowed_company_ids: [1] } }));
    assert.doesNotMatch(textOf(host), /Foreign project|789\.00/);
  } finally { await React.act(async () => root.unmount()); }
});
