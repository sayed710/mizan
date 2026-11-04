import { test } from 'node:test';
import assert from 'node:assert/strict';
import { journalAudit } from './models/journal_audit.js';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));
const props = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];
const text = (node) => node.nodeType === 3 ? node.nodeValue : (node.childNodes ?? []).map(text).join('');

test('journal audit uses the accounting date for filtering and display', () => {
  const db = { records: { 'account.journal': [{ id: 1 }], 'account.move': [{ id: 1, name: 'Bill', state: 'posted', journal_id: 1, invoice_date: '2026-01-31', date: '2026-02-01', line_ids: [{ debit: 100 }] }] } };
  assert.deepEqual(journalAudit(db, { from: '2026-01-01', to: '2026-01-31' }), []);
  assert.equal(journalAudit(db, { from: '2026-02-01', to: '2026-02-28' })[0].items[0].date, '2026-02-01');
});

test('report custom periods reach depreciation and archived analytic activity', async () => {
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, getDb, commit } = await import('./store.js');
  await initStore();
  const base = getDb();
  const db = { ...base, records: { ...base.records,
    'account.asset': [
      { id: 1, name: 'Future asset', state: 'open', acquisition_date: '2026-03-01', original_value: 300 },
      { id: 2, name: 'Disposed asset', state: 'close', acquisition_date: '2025-01-01', disposal_date: '2026-02-01', original_value: 200, depreciation_ids: [{ date: '2025-12-31', amount: 50, posted: true }] },
    ],
    'account.analytic.account': [{ id: 1, name: 'Archived project', active: false }],
    'account.analytic.line': [{ id: 1, name: 'Historical activity', account_id: 1, date: '2026-01-15', amount: 123 }],
  } };
  await React.act(async () => commit(db));
  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div'); host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    for (const report of ['tax', 'cashflow', 'executive', 'depreciation', 'analytic', 'budget']) {
      await React.act(async () => root.render(React.createElement(Reports, { leaf: { report } })));
      assert.ok(find(host, (node) => node.tagName === 'OPTION' && props(node)?.value === 'custom'), report);
      const select = find(host, (node) => node.tagName === 'SELECT' && props(node)?.value === 'year');
      await React.act(async () => props(select).onChange({ target: { value: 'custom' } }));
      const from = find(host, (node) => node.tagName === 'INPUT' && props(node)?.type === 'date');
      await React.act(async () => props(from).onChange({ target: { value: '2026-01-01' } }));
      const to = find(host, (node) => node.tagName === 'INPUT' && props(node)?.type === 'date' && node !== from);
      await React.act(async () => props(to).onChange({ target: { value: '2026-01-31' } }));
      if (report === 'depreciation') {
        assert.match(text(host), /Disposed asset/);
        assert.match(text(host), /150\.00/);
        assert.doesNotMatch(text(host), /Future asset/);
        await React.act(async () => props(to).onChange({ target: { value: '2026-02-01' } }));
        assert.doesNotMatch(text(host), /Disposed asset/);
      }
      if (report === 'analytic') {
        assert.match(text(host), /Archived project/);
        assert.match(text(host), /Historical activity/);
        assert.match(text(host), /123\.00/);
      }
    }
  } finally { await React.act(async () => root.unmount()); }
});
