import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

import { setupDom, find } from './test-support/dom.js';

test('button with a wizard on an unsaved record drives the button -> wizard -> confirm flow', async () => {
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/sales/orders/new' };

  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit, getDb } = await import('./store.js');
  const { create, read } = await import('./orm.js');
  await initStore();

  const tmpl = create(getDb(), 'sale.order.template', { name: 'Standard Template' });
  commit(tmpl.db);

  const { FormView } = await import('./views/FormView.jsx');
  const rootEl = makeEl('div');
  rootEl.ownerDocument = globalThis.document;
  const root = createRoot(rootEl);

  await React.act(async () => {
    root.render(React.createElement(FormView, {
      leaf: { model: 'sale.order', key: 'orders', label: 'Quotations' },
      id: 'new',
      base: '#/sales/orders',
      params: new URLSearchParams('default_partner_id=1'),
    }));
  });

  // Step 1: Click button with wizard on unsaved record
  const applyBtn = find(rootEl, (n) => n.tagName === 'BUTTON' && n.textContent === 'Apply Template');
  assert.ok(applyBtn, 'Apply Template button must exist');
  const btnPropsKey = Object.keys(applyBtn).find((k) => k.startsWith('__reactProps$'));
  await React.act(async () => {
    await applyBtn[btnPropsKey].onClick();
  });

  // Wizard opens and location.hash remains unchanged (did not navigate prematurely)
  assert.equal(globalThis.location.hash, '#/sales/orders/new', 'location.hash must not update before wizard confirmation');
  const form = find(rootEl, (n) => n.tagName === 'FORM');
  assert.ok(form, 'Wizard dialog must render');

  // Step 2: Choose template in wizard dialog
  const select = find(form, (n) => n.tagName === 'SELECT');
  assert.ok(select, 'Template select in wizard dialog must exist');
  const selectPropsKey = Object.keys(select).find((k) => k.startsWith('__reactProps$'));
  await React.act(async () => {
    select[selectPropsKey].onChange({ target: { value: String(tmpl.id) } });
  });

  // Step 3: Confirm wizard dialog
  const formPropsKey = Object.keys(form).find((k) => k.startsWith('__reactProps$'));
  await React.act(async () => {
    form[formPropsKey].onSubmit({ preventDefault: () => {} });
  });

  // After confirmation, save() persisted the record, hash updated, and wizard action applied
  assert.match(globalThis.location.hash, /^#\/sales\/orders\/(\d+)\?view=/, 'location.hash must update after wizard confirm');
  const newId = Number(globalThis.location.hash.match(/orders\/(\d+)/)[1]);
  const saved = read(getDb(), 'sale.order', newId);
  assert.equal(saved?.sale_order_template_id, tmpl.id, 'wizard action must have been applied to the saved record');
});

test('button without a wizard on an unsaved record saves and navigates immediately', async () => {
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/sales/orders/new' };

  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore } = await import('./store.js');
  await initStore();

  const { FormView } = await import('./views/FormView.jsx');
  const rootEl = makeEl('div');
  rootEl.ownerDocument = globalThis.document;
  const root = createRoot(rootEl);

  await React.act(async () => {
    root.render(React.createElement(FormView, {
      leaf: { model: 'sale.order', key: 'orders', label: 'Quotations' },
      id: 'new',
      base: '#/sales/orders',
      params: new URLSearchParams('default_partner_id=1'),
    }));
  });

  const confirmBtn = find(rootEl, (n) => n.tagName === 'BUTTON' && n.textContent === 'Confirm');
  assert.ok(confirmBtn, 'Confirm button must exist');
  const btnPropsKey = Object.keys(confirmBtn).find((k) => k.startsWith('__reactProps$'));
  await React.act(async () => {
    await confirmBtn[btnPropsKey].onClick();
  });

  assert.match(globalThis.location.hash, /^#\/sales\/orders\/\d+\?view=/, 'button without wizard saves and navigates immediately');
});
test('document form resolves workflow-only tag references when recomputing fields', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const store = await import('./store.js');
  const { create } = await import('./orm.js');
  await store.initStore();
  const tag = create(store.getDb(), 'documents.tag', { name: 'Workflow tag unique' });
  const doc = create(tag.db, 'documents.document', { name: 'Tagged', tag_ids: [{ tag_id: tag.id }] });
  await store.commit(doc.db);
  const { FormView } = await import('./views/FormView.jsx');
  const rootEl = makeEl('div');
  rootEl.ownerDocument = globalThis.document;
  const root = createRoot(rootEl);
  try {
    await React.act(async () => root.render(React.createElement(FormView, { leaf: { model: 'documents.document', key: 'documents', label: 'Documents' }, id: doc.id, base: '#/documents/documents', params: new URLSearchParams() })));
    assert.ok(find(rootEl, (n) => n.textContent === 'Workflow tag unique'), 'computed legacy tags must display the referenced tag name');
  } finally { await React.act(async () => root.unmount()); }
});
