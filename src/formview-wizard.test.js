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

test('invoice line account selection refreshes analytics without running pricing or changing a manual price', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { FieldInput } = await import('./ui.jsx');
  const { models } = await import('./models/index.js');
  const { create, read, search } = await import('./orm.js');
  const { seed } = await import('./seed.js');
  let db = seed();
  const product = read(db, 'product', 1);
  const stock = product.uom_id ? read(db, 'uom.uom', product.uom_id) : search(db, 'uom.uom').find((u) => u.name === 'Units');
  const otherUnit = search(db, 'uom.uom').find((u) => u.category_id !== stock.category_id);
  assert.ok(otherUnit, 'fixture has a unit in a different category');
  const account = create(db, 'account.account', { code: '699987', name: 'Analytic account selection' });
  const analytic = search(account.db, 'account.analytic.account')[0];
  const rule = create(account.db, 'account.analytic.distribution.model', { account_prefix: '699987', analytic_distribution: { [analytic.id]: 100 } });
  db = rule.db;
  const line = { product_id: product.id, account_id: null, uom_id: otherUnit.id, qty: 2, price_unit: 123.45, tax: 7, discount: 5 };
  const move = { move_type: 'out_invoice', partner_id: 1, company_id: 1, invoice_line_ids: [line] };
  let changed = null;
  const rootEl = makeEl('div');
  rootEl.ownerDocument = globalThis.document;
  const root = createRoot(rootEl);
  const props = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];
  await React.act(async () => root.render(React.createElement(FieldInput, {
    db, field: models['account.move'].fields.invoice_line_ids, value: [line], record: move, onChange: (value) => { changed = value; },
  })));
  const accountSelect = find(rootEl, (node) => node.tagName === 'SELECT' && props(node)?.['aria-label'] === 'Account 1');
  assert.ok(accountSelect, 'invoice line has an account selector');
  await React.act(async () => props(accountSelect).onChange({ target: { value: String(account.id) } }));
  assert.equal(changed[0].account_id, account.id);
  assert.equal(changed[0].price_unit, 123.45);
  assert.equal(changed[0].qty, 2);
  assert.equal(changed[0].uom_id, otherUnit.id);
  assert.equal(changed[0].tax, 7);
  assert.equal(changed[0].discount, 5);
  assert.deepEqual(changed[0].analytic_distribution, { [analytic.id]: 100 });
  await React.act(async () => root.unmount());
});

test('tax return relation input selects, saves, removes and links documents and closing entries', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { FieldInput } = await import('./ui.jsx');
  const { models } = await import('./models/index.js');
  const { create, read, search, write } = await import('./orm.js');
  const { seed } = await import('./seed.js');
  let db = seed();
  const doc = create(db, 'documents.document', { name: 'VAT proof' });
  const other = create(doc.db, 'documents.document', { name: 'VAT receipt' });
  const type = search(other.db, 'account.return.type')[0];
  const ret = create(other.db, 'account.return', { name: 'UI VAT', type_id: type.id, company_id: 1, date_from: '2025-01-01', date_to: '2025-01-31' });
  db = ret.db;
  const rootEl = makeEl('div');
  rootEl.ownerDocument = globalThis.document;
  const root = createRoot(rootEl);
  const field = models['account.return'].fields.attachment_ids;
  const render = async () => React.act(async () => root.render(React.createElement(FieldInput, {
    db, field, value: read(db, 'account.return', ret.id).attachment_ids, id: 'attachments',
    onChange: (value) => { db = write(db, 'account.return', ret.id, { attachment_ids: value }); },
  })));
  const props = (node) => node[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];
  await render();
  const select = find(rootEl, (node) => node.tagName === 'SELECT');
  assert.ok(select, 'attachments expose an editable selector');
  await React.act(async () => props(select).onChange({ target: { value: String(doc.id) } }));
  assert.deepEqual(read(db, 'account.return', ret.id).attachment_ids, [doc.id]);
  await render();
  const link = find(rootEl, (node) => node.tagName === 'A' && node.textContent.includes('VAT proof'));
  assert.equal(props(link).href, `#/documents/all/${doc.id}`);
  const nextSelect = find(rootEl, (node) => node.tagName === 'SELECT');
  await React.act(async () => props(nextSelect).onChange({ target: { value: String(other.id) } }));
  assert.deepEqual(read(db, 'account.return', ret.id).attachment_ids, [doc.id, other.id]);
  await render();
  const remove = find(rootEl, (node) => node.tagName === 'BUTTON' && props(node)['aria-label'].includes('VAT proof'));
  await React.act(async () => props(remove).onClick());
  assert.deepEqual(read(db, 'account.return', ret.id).attachment_ids, [other.id]);
  const move = search(db, 'account.move').find((m) => m.move_type === 'entry');
  await React.act(async () => root.render(React.createElement(FieldInput, {
    db, field: models['account.return'].fields.closing_move_ids, value: [move.id], readonly: true,
  })));
  const closingLink = find(rootEl, (node) => node.tagName === 'A');
  assert.equal(props(closingLink).href, `#/accounting/entries/${move.id}`);
  await React.act(async () => root.unmount());
});

test('tax return form persists attachment selection and opens the selected records', async () => {
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting/tax-returns' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit, getDb } = await import('./store.js');
  const { create, read, search } = await import('./orm.js');
  const { FormView } = await import('./views/FormView.jsx');
  await initStore();
  const doc = create(getDb(), 'documents.document', { name: 'Form evidence' });
  const type = search(doc.db, 'account.return.type')[0];
  const move = search(doc.db, 'account.move').find((m) => m.move_type === 'entry');
  const ret = create(doc.db, 'account.return', { name: 'Form VAT', type_id: type.id, company_id: 1,
    date_from: '2025-01-01', date_to: '2025-01-31', closing_move_ids: [move.id] });
  await commit(ret.db);
  const rootEl = makeEl('div');
  rootEl.ownerDocument = globalThis.document;
  const root = createRoot(rootEl);
  const props = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];
  await React.act(async () => root.render(React.createElement(FormView, {
    leaf: { model: 'account.return', key: 'tax-returns', label: 'Tax Returns' }, id: String(ret.id),
    base: '#/accounting/tax-returns', params: new URLSearchParams(),
  })));
  const tab = find(rootEl, (node) => node.tagName === 'BUTTON' && node.textContent === 'Closing Moves');
  assert.ok(tab);
  await React.act(async () => props(tab).onClick());
  const select = find(rootEl, (node) => node.tagName === 'SELECT' && props(node)?.id === 'f-attachment_ids');
  assert.ok(select, 'the return form exposes the attachment selector');
  await React.act(async () => props(select).onChange({ target: { value: String(doc.id) } }));
  assert.deepEqual(read(getDb(), 'account.return', ret.id).attachment_ids, [], 'selection remains unsaved until Save');
  const save = find(rootEl, (node) => node.tagName === 'BUTTON' && node.textContent === 'Save');
  assert.ok(save);
  await React.act(async () => props(save).onClick());
  assert.deepEqual(read(getDb(), 'account.return', ret.id).attachment_ids, [doc.id]);
  const documentLink = find(rootEl, (node) => node.tagName === 'A' && node.textContent.includes('Form evidence'));
  assert.equal(props(documentLink).href, `#/documents/all/${doc.id}`);
  const closingLink = find(rootEl, (node) => node.tagName === 'A' && props(node)?.href === `#/accounting/entries/${move.id}`);
  assert.ok(closingLink, 'the closing entry navigates to its own form');
  await React.act(async () => root.unmount());
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
