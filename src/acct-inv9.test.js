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

test('unposted invoices omit Amount Due on print and cancelled invoices omit installment schedule', async () => {
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
    const s = seed();
    const term = s.records['account.payment.term']?.find((t) => t.display_on_invoice)
      ?? create(s, 'account.payment.term', { name: '30 Days Net', display_on_invoice: true, line_ids: [{ value: 'balance', days: 30 }] });
    const termDb = term.db ?? s;
    const termId = term.id ?? (term.line_ids && term.id);
    const created = create(termDb, 'account.move', {
      move_type: 'out_invoice',
      partner_id: 1,
      invoice_payment_term_id: termId,
      invoice_line_ids: [{ name: 'Desk', qty: 1, price_unit: 500, account_id: 1 }],
    });
    const moveId = created.id;

    // 1. Draft invoice
    const draftDb = { ...created.db, records: { ...created.db.records, 'account.move': created.db.records['account.move'].map((r) => r.id === moveId ? { ...r, state: 'draft', name: '/' } : r) } };
    await React.act(async () => commit(draftDb));
    await React.act(async () => root.render(React.createElement(PrintDoc, { model: 'account.move', id: moveId })));
    let text = textOf(host);
    assert.ok(text.includes('Total') || text.includes('500'), 'draft shows total');
    assert.ok(!text.includes('Amount Due'), 'draft must not show Amount Due');
    assert.ok(text.includes('Due Date'), 'draft previews installment schedule');

    // 2. Cancelled invoice
    const cancelDb = { ...created.db, records: { ...created.db.records, 'account.move': created.db.records['account.move'].map((r) => r.id === moveId ? { ...r, state: 'cancel', name: 'INV/2026/0001' } : r) } };
    await React.act(async () => commit(cancelDb));
    await React.act(async () => root.render(React.createElement(PrintDoc, { model: 'account.move', id: moveId })));
    text = textOf(host);
    assert.ok(text.includes('Total') || text.includes('500'), 'cancelled shows total');
    assert.ok(!text.includes('Amount Due'), 'cancelled must not show Amount Due');
    assert.ok(!text.includes('Due Date'), 'cancelled must omit installment schedule');

    // 3. Posted invoice
    const postedDb = { ...created.db, records: { ...created.db.records, 'account.move': created.db.records['account.move'].map((r) => r.id === moveId ? { ...r, state: 'posted', name: 'INV/2026/0001' } : r) } };
    await React.act(async () => commit(postedDb));
    await React.act(async () => root.render(React.createElement(PrintDoc, { model: 'account.move', id: moveId })));
    text = textOf(host);
    assert.ok(text.includes('Total') || text.includes('500'), 'posted shows total');
    assert.ok(text.includes('Amount Due'), 'posted shows Amount Due');
    assert.ok(text.includes('Due Date'), 'posted shows installment schedule');
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('App updates print route when mizan:remapped fires', async () => {
  setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore } = await import('./store.js');
  const { App } = await import('./App.jsx');
  await initStore();
  globalThis.location.hash = '#/print/account.move/1001';
  const host = globalThis.document.createElement('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(App)));
    await React.act(async () => {
      globalThis.window.dispatchEvent(new globalThis.CustomEvent('mizan:remapped', {
        detail: { 'account.move': { 1001: 55 } },
      }));
    });
    assert.equal(globalThis.location.hash, '#/print/account.move/55');
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('FormView Print on draft awaits save confirmation and keeps user on form if save fails', async () => {
  setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore } = await import('./store.js');
  const { FormView } = await import('./views/FormView.jsx');
  const { menusFor } = await import('./models/index.js');

  const baseDb = seed();
  let resolveDiff;
  const originalFetch = globalThis.fetch;
  const originalInterval = globalThis.setInterval;
  globalThis.setInterval = () => ({ unref() {} });
  const response = (data, ok = true) => new Response(JSON.stringify(data), {
    status: ok ? 200 : 400,
    headers: { 'Content-Type': 'application/json' },
  });
  globalThis.fetch = async (url) => {
    if (url === '/api/session') return response({ name: 'Admin', isAdmin: true });
    if (url === '/api/db') return response(baseDb);
    if (url === '/api/diff') {
      return new Promise((resolve) => {
        resolveDiff = () => resolve(response({ error: 'Database locked' }, false));
      });
    }
    return response({});
  };

  await initStore();
  const leaf = menusFor('accounting').find((m) => m.label === 'Customers').children.find((c) => c.key === 'invoices');
  globalThis.location = {
    hash: '#/accounting/customer-invoices/new',
    replace(h) { this.hash = h; },
  };
  const host = globalThis.document.createElement('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    await React.act(async () => root.render(React.createElement(FormView, {
      leaf,
      id: 'new',
      base: '#/accounting/customer-invoices',
      params: new URLSearchParams('view=form'),
    })));

    const propsOf = (n) => n?.[Object.keys(n).find((k) => k.startsWith('__reactProps$'))];
    const gearBtn = host.childNodes.flatMap(function search(n) {
      if (n.tagName === 'BUTTON' && (n.textContent === '⚙' || n.getAttribute?.('aria-label') === 'Actions')) return [n];
      return (n.childNodes ?? []).flatMap(search);
    })[0];
    assert.ok(gearBtn, 'gear menu button exists');
    await React.act(async () => propsOf(gearBtn).onClick());

    const printBtn = host.childNodes.flatMap(function search(n) {
      if (n.tagName === 'BUTTON' && n.textContent === 'Print') return [n];
      return (n.childNodes ?? []).flatMap(search);
    })[0];
    assert.ok(printBtn, 'Print button in gear menu exists');

    let printPromise;
    await React.act(async () => {
      printPromise = propsOf(printBtn).onClick();
    });

    // Before save resolves, must NOT have navigated to print
    assert.ok(!globalThis.location.hash.startsWith('#/print/'), 'must await save confirmation before navigating to print');

    await React.act(async () => {
      resolveDiff();
      await printPromise;
    });

    assert.ok(!globalThis.location.hash.startsWith('#/print/'), 'must not navigate to print on save rejection');
    const text = textOf(host);
    assert.ok(text.includes('Database locked'), 'form shows the save error');
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setInterval = originalInterval;
    await React.act(async () => root.unmount());
  }
});

test('FormView Print on draft uses remapped ID after save confirmation', async () => {
  setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore } = await import('./store.js');
  const { FormView } = await import('./views/FormView.jsx');
  const { menusFor } = await import('./models/index.js');

  const baseDb = seed();
  let resolveDiff;
  const originalFetch = globalThis.fetch;
  const originalInterval = globalThis.setInterval;
  globalThis.setInterval = () => ({ unref() {} });
  const response = (data, ok = true) => new Response(JSON.stringify(data), {
    status: ok ? 200 : 400,
    headers: { 'Content-Type': 'application/json' },
  });
  globalThis.fetch = async (url, opts) => {
    if (url === '/api/session') return response({ name: 'Admin', isAdmin: true });
    if (url === '/api/db') return response(baseDb);
    if (url === '/api/diff') {
      const diff = JSON.parse(opts?.body ?? '{}');
      const optimisticId = diff.created?.['account.move']?.[0];
      const move = diff.upserts?.['account.move']?.[0];
      return new Promise((resolve) => {
        resolveDiff = () => {
          const updatedDb = {
            ...baseDb,
            records: {
              ...baseDb.records,
              'account.move': [...(baseDb.records['account.move'] ?? []), { ...move, id: 777 }],
            },
          };
          resolve(response({
            ok: true,
            remapped: { 'account.move': { [Number(optimisticId)]: 777 } },
            ...updatedDb,
          }));
        };
      });
    }
    return response({});
  };

  await initStore();
  const leaf = menusFor('accounting').find((m) => m.label === 'Customers').children.find((c) => c.key === 'invoices');
  globalThis.location = {
    hash: '#/accounting/customer-invoices/new',
    replace(h) { this.hash = h; },
  };
  const host = globalThis.document.createElement('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    await React.act(async () => root.render(React.createElement(FormView, {
      leaf,
      id: 'new',
      base: '#/accounting/customer-invoices',
      params: new URLSearchParams('view=form'),
    })));

    const propsOf = (n) => n?.[Object.keys(n).find((k) => k.startsWith('__reactProps$'))];
    const gearBtn = host.childNodes.flatMap(function search(n) {
      if (n.tagName === 'BUTTON' && (n.textContent === '⚙' || n.getAttribute?.('aria-label') === 'Actions')) return [n];
      return (n.childNodes ?? []).flatMap(search);
    })[0];
    assert.ok(gearBtn, 'gear menu button exists');
    await React.act(async () => propsOf(gearBtn).onClick());

    const printBtn = host.childNodes.flatMap(function search(n) {
      if (n.tagName === 'BUTTON' && n.textContent === 'Print') return [n];
      return (n.childNodes ?? []).flatMap(search);
    })[0];
    assert.ok(printBtn, 'Print button in gear menu exists');

    let printPromise;
    await React.act(async () => {
      printPromise = propsOf(printBtn).onClick();
    });

    // Before save confirms, must NOT have navigated with optimistic ID
    assert.ok(!globalThis.location.hash.startsWith('#/print/'), 'must await save confirmation before navigating');

    await React.act(async () => {
      resolveDiff();
      await printPromise;
    });

    assert.equal(globalThis.location.hash, '#/print/account.move/777');
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setInterval = originalInterval;
    await React.act(async () => root.unmount());
  }
});
