import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { create, write } from './orm.js';
import { seed } from './seed.js';
import { apps, findLeaf, menusFor, models } from './models/index.js';
import { actionRecords } from './companyView.js';
import { newDefaults } from './views/formDefaults.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const props = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];
const allFind = (root, pred, out = []) => {
  if (!root) return out;
  if (pred(root)) out.push(root);
  for (const child of root.childNodes ?? []) allFind(child, pred, out);
  return out;
};

const leafFor = (sectionLabel, labelOrKey) => {
  const top = menusFor('accounting').find((m) => m.label === sectionLabel);
  return top?.children?.find((c) => c.key === labelOrKey || c.label === labelOrKey) ?? null;
};

async function withUi(initialDb, fn) {
  const prevStorage = globalThis.localStorage;
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
    clear: () => { mem.clear(); },
  };
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit, getDb } = await import('./store.js');
  const { ActionView } = await import('./views/ActionView.jsx');
  const { FormView } = await import('./views/FormView.jsx');
  await initStore();
  await commit(initialDb);
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    return await fn({ React, host, root, commit, getDb, ActionView, FormView });
  } finally {
    await React.act(async () => root.unmount());
    globalThis.localStorage = prevStorage;
  }
}

test('PRD-1: Customers > Products shows only sale_ok products and defaults sale_ok; Vendors > Products shows purchase_ok products and defaults purchase_ok', async () => {
  const accountingApp = apps.find((a) => a.id === 'accounting');
  const customersProducts = leafFor('Customers', 'Products');
  const vendorsProducts = leafFor('Vendors', 'Products');
  assert.ok(customersProducts, 'Customers > Products leaf exists');
  assert.ok(vendorsProducts, 'Vendors > Products leaf exists');
  assert.notEqual(customersProducts.key, vendorsProducts.key, 'Customers and Vendors Products menus have distinct route keys');
  assert.equal(findLeaf(accountingApp, customersProducts.key), customersProducts);
  assert.equal(findLeaf(accountingApp, vendorsProducts.key), vendorsProducts);

  let db = seed();
  const sellOnly = create(db, 'product', { name: 'PRD1 Sell Only', sale_ok: true, purchase_ok: false });
  const buyOnly = create(sellOnly.db, 'product', { name: 'PRD1 Buy Only', sale_ok: false, purchase_ok: true });
  const both = create(buyOnly.db, 'product', { name: 'PRD1 Sell And Buy', sale_ok: true, purchase_ok: true });
  const neither = create(both.db, 'product', { name: 'PRD1 Internal Neither', sale_ok: false, purchase_ok: false });
  db = neither.db;

  const custIds = new Set(actionRecords(db, customersProducts).map((r) => r.id));
  assert.ok(custIds.has(sellOnly.id));
  assert.ok(custIds.has(both.id));
  assert.ok(!custIds.has(buyOnly.id));
  assert.ok(!custIds.has(neither.id));

  const vendIds = new Set(actionRecords(db, vendorsProducts).map((r) => r.id));
  assert.ok(vendIds.has(buyOnly.id));
  assert.ok(vendIds.has(both.id));
  assert.ok(!vendIds.has(sellOnly.id));
  assert.ok(!vendIds.has(neither.id));

  assert.equal(newDefaults(db, 'product', customersProducts, new URLSearchParams(), null).sale_ok, true);
  assert.equal(newDefaults(db, 'product', vendorsProducts, new URLSearchParams(), null).purchase_ok, true);
});

test('PRD-2: Invoice line product selection offers sale_ok products on customer documents and purchase_ok products on vendor documents', async () => {
  let db = seed();
  const sellOnly = create(db, 'product', { name: 'PRD2 Sellable Product', sale_ok: true, purchase_ok: false });
  const buyOnly = create(sellOnly.db, 'product', { name: 'PRD2 Purchasable Product', sale_ok: false, purchase_ok: true });
  const both = create(buyOnly.db, 'product', { name: 'PRD2 Both Product', sale_ok: true, purchase_ok: true });
  const neither = create(both.db, 'product', { name: 'PRD2 Neither Product', sale_ok: false, purchase_ok: false });
  const archived = create(neither.db, 'product', { name: 'PRD2 Archived Product', sale_ok: true, purchase_ok: true, active: false });
  db = archived.db;

  const productField = models['account.move'].fields.invoice_line_ids.fields.product_id;
  assert.equal(typeof productField.domain, 'function');

  const cases = [
    { leaf: leafFor('Customers', 'invoices'), moveType: 'out_invoice', expectOffered: [sellOnly.id, both.id], expectExcluded: [buyOnly.id, neither.id, archived.id] },
    { leaf: leafFor('Customers', 'credit-notes'), moveType: 'out_refund', expectOffered: [sellOnly.id, both.id], expectExcluded: [buyOnly.id, neither.id, archived.id] },
    { leaf: leafFor('Vendors', 'bills'), moveType: 'in_invoice', expectOffered: [buyOnly.id, both.id], expectExcluded: [sellOnly.id, neither.id, archived.id] },
    { leaf: leafFor('Vendors', 'refunds'), moveType: 'in_refund', expectOffered: [buyOnly.id, both.id], expectExcluded: [sellOnly.id, neither.id, archived.id] },
  ];

  await withUi(db, async ({ React, host, root, commit, getDb, FormView }) => {
    for (const c of cases) {
      await React.act(async () => root.render(React.createElement(FormView, {
        key: c.moveType,
        leaf: c.leaf,
        id: 'new',
        base: `#/accounting/${c.leaf.key}`,
        params: new URLSearchParams('view=form'),
      })));
      const addLineBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.trim() === 'Add a line');
      assert.ok(addLineBtn, `Add a line button exists for ${c.moveType}`);
      await React.act(async () => props(addLineBtn).onClick());

      const productSelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === 'Product 1');
      assert.ok(productSelect, `Product select renders on line 1 for ${c.moveType}`);
      const optionIds = new Set(
        allFind(productSelect, (n) => n.tagName === 'OPTION')
          .map((opt) => Number(props(opt)?.value))
          .filter((id) => Number.isInteger(id) && id > 0),
      );
      for (const id of c.expectOffered) assert.ok(optionIds.has(id), `${c.moveType} offers product #${id}`);
      for (const id of c.expectExcluded) assert.ok(!optionIds.has(id), `${c.moveType} excludes product #${id}`);
    }

    // Existing invoice line whose product is later marked non-sellable keeps its selected product visible.
    const createdInv = create(getDb(), 'account.move', {
      move_type: 'out_invoice',
      partner_id: 1,
      invoice_date: '2026-03-01',
      invoice_line_ids: [{ product_id: sellOnly.id, qty: 1, price_unit: 50, tax: 0 }],
    });
    const updatedDb = write(createdInv.db, 'product', sellOnly.id, { sale_ok: false });
    await commit(updatedDb);

    const invLeaf = leafFor('Customers', 'invoices');
    await React.act(async () => root.render(React.createElement(FormView, {
      key: `existing-${createdInv.id}`,
      leaf: invLeaf,
      id: String(createdInv.id),
      base: `#/accounting/${invLeaf.key}`,
      params: new URLSearchParams('view=form'),
    })));
    const existingSelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === 'Product 1');
    const existingOptionIds = new Set(
      allFind(existingSelect, (n) => n.tagName === 'OPTION')
        .map((opt) => Number(props(opt)?.value))
        .filter((id) => Number.isInteger(id) && id > 0),
    );
    assert.ok(existingOptionIds.has(sellOnly.id), 'existing line preserves its current product even after sale_ok is turned off');
  });
});
