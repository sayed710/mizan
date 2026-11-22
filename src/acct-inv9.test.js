import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom } from './test-support/dom.js';
import { create, read } from './orm.js';
import { seed } from './seed.js';
import { models } from './models/index.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const types = { out_invoice: 'Invoice', out_refund: 'Credit Note', in_invoice: 'Bill', in_refund: 'Refund' };
const textOf = (node) => node.nodeType === 3 ? node.nodeValue : (node.childNodes ?? []).map(textOf).join('');

test('invoice gear-menu Print works in every state while the header Print stays posted-only, as in Odoo', () => {
  const menu = models['account.move'].menuActions.find((a) => a.label === 'Print');
  const header = models['account.move'].form.buttons.find((b) => b.label === 'Print');
  for (const move_type of Object.keys(types)) {
    for (const state of ['draft', 'cancel', 'posted']) {
      const move = { id: 42, move_type, state, name: '/' };
      const db = { records: { 'account.move': [move] } };
      assert.equal(menu.when(move), true, `${state} ${move_type}`);
      assert.equal(header.when(move), state === 'posted', `header ${state} ${move_type}`);
      assert.deepEqual(menu.run(db, move), { db, go: '#/print/account.move/42' });
      assert.deepEqual(move, { id: 42, move_type, state, name: '/' });
    }
  }
  assert.equal(menu.when({ move_type: 'entry', state: 'draft' }), false);
});

test('printed invoice titles reflect draft and cancelled state and preserve posted titles', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { PrintDoc } = await import('./views/PrintDoc.jsx');
  await initStore();
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    for (const [move_type, label] of Object.entries(types)) {
      for (const state of ['draft', 'cancel', 'posted']) {
        const created = create(seed(), 'account.move', { move_type, partner_id: 1 });
        const move = read(created.db, 'account.move', created.id);
        const db = { ...created.db, records: { ...created.db.records, 'account.move': created.db.records['account.move'].map((r) => r.id === created.id ? { ...r, state, name: 'TEST/1' } : r) } };
        await React.act(async () => commit(db));
        await React.act(async () => root.render(React.createElement(PrintDoc, { model: 'account.move', id: move.id })));
        const text = textOf(host);
        const expected = state === 'draft' ? `Draft ${label}` : state === 'cancel' ? `Cancelled ${label} TEST/1` : `${models['account.move'].form.subtitle(move)} TEST/1`;
        assert.ok(text.includes(expected), `${state} ${move_type}: ${text}`);
        if (state === 'draft') assert.ok(!text.includes('TEST/1'));
      }
    }
  } finally {
    await React.act(async () => root.unmount());
  }
});
