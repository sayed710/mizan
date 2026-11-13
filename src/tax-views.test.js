import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { withDefaultVat, createCompanyWithDefaultInvoiceJournals } from './test-support/accounting-company.js';
import { create, groupRecords, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { menusFor, models } from './models/index.js';
import { postMove } from './models/accounting.js';
import { taxSnapshot } from './models/taxes.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const props = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];
const classOf = (node) => props(node)?.className ?? node?.className ?? '';
const hasClass = (node, cls) => typeof classOf(node) === 'string' && classOf(node).split(/\s+/).includes(cls);
const allFind = (root, pred, out = []) => {
  if (!root) return out;
  if (pred(root)) out.push(root);
  for (const child of root.childNodes ?? []) allFind(child, pred, out);
  return out;
};
const fieldLabelsOf = (container) => allFind(container, (n) => hasClass(n, 'field'))
  .map((f) => f.childNodes[0]?.textContent?.replaceAll('*', '').trim());

const findLeafByKey = (items, key) => {
  for (const item of items) {
    if (item.key === key) return item;
    if (item.children) {
      const found = findLeafByKey(item.children, key);
      if (found) return found;
    }
  }
  return null;
};

const taxesLeaf = () => findLeafByKey(menusFor('accounting'), 'taxes');

async function mountView(renderElement, initialDb = seed()) {
  const prevStorage = globalThis.localStorage;
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
    clear: () => { mem.clear(); },
  };
  setupDom();
  const origCreate = globalThis.document.createElement;
  globalThis.document.createElement = (tag) => {
    const el = origCreate(tag);
    el.insertBefore = (child, before) => {
      const idx = before ? el.childNodes.indexOf(before) : -1;
      if (idx >= 0) el.childNodes.splice(idx, 0, child);
      else el.childNodes.push(child);
      child.parentNode = el;
      if (child.tagName === 'OPTION') el.options.push(child);
      return child;
    };
    return el;
  };
  globalThis.document.createElementNS = (_, tag) => globalThis.document.createElement(tag);
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit, getDb } = await import('./store.js');
  await initStore();
  await commit(initialDb);
  const host = globalThis.document.createElement('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  const render = async (el) => {
    await React.act(async () => root.render(renderElement(React, el)));
  };
  await render();
  return {
    React,
    host,
    commit,
    getDb,
    render,
    done: async () => {
      await React.act(async () => root.unmount());
      globalThis.localStorage = prevStorage;
    },
  };
}

test('taxes menu opens as a list with the six Odoo columns, orders by sequence, and keeps kanban available', async () => {
  const leaf = taxesLeaf();
  assert.equal(leaf.view, 'list');
  const baseDb = seed();
  const stamped = create(baseDb, 'account.tax', { name: 'Early Tax', sequence: 0, amount: 10, type_tax_use: 'sale' }).db;
  const { ActionView } = await import('./views/ActionView.jsx');
  const ctx = await mountView(
    (React, overrideView) => React.createElement(ActionView, {
      leaf,
      base: '#/accounting/taxes',
      params: new URLSearchParams(overrideView ? `view=${overrideView}` : ''),
    }),
    stamped,
  );
  try {
    const table = find(ctx.host, (n) => n.tagName === 'TABLE' && hasClass(n, 'list'));
    assert.ok(table, 'opens list view by default');
    const headers = allFind(table, (n) => n.tagName === 'TH')
      .map((th) => th.textContent.trim())
      .filter(Boolean);
    assert.deepEqual(headers, ['Tax Name', 'Description', 'Tax Type', 'Tax Scope', 'Label on Invoices', 'Active']);

    const firstRowName = allFind(table, (n) => n.tagName === 'TBODY')[0]?.childNodes?.[0]?.childNodes?.[1]?.textContent?.trim();
    assert.equal(firstRowName, 'Early Tax', 'sequence orders the taxes list before id');

    const kanbanBtn = find(ctx.host, (n) => n.tagName === 'A' && props(n)?.href === '#/accounting/taxes?view=kanban');
    assert.ok(kanbanBtn, 'kanban remains available in the view switcher');
  } finally {
    await ctx.done();
  }
});

test('account.tax form shows one Tax Group, conditional Child Taxes, Definition side-by-side repartitions, and Advanced Options', async () => {
  const leaf = taxesLeaf();
  const baseDb = seed();
  const vatTax = search(baseDb, 'account.tax').find((t) => t.name === 'VAT 14%' && t.type_tax_use === 'sale');
  const { FormView } = await import('./views/FormView.jsx');
  const ctx = await mountView(
    (React, id = vatTax.id) => React.createElement(FormView, {
      leaf,
      id,
      base: '#/accounting/taxes',
      params: new URLSearchParams('view=form'),
    }),
    baseDb,
  );
  try {
    const topGroups = allFind(ctx.host, (n) => n.tagName === 'DIV' && hasClass(n, 'group')).slice(0, 2);
    assert.deepEqual(fieldLabelsOf(topGroups[0]), ['Tax Computation', 'Amount', 'Description']);
    assert.deepEqual(fieldLabelsOf(topGroups[1]), ['Tax Type', 'Tax Scope', 'Fiscal Position', 'Replaces']);
    assert.equal(allFind(ctx.host, (n) => n.textContent?.trim() === 'Sequence').length, 0, 'Sequence leaves the form');

    // Switch Tax Computation to Group of Taxes -> Child Taxes appears in left header group.
    const compSelect = find(topGroups[0], (n) => n.tagName === 'SELECT');
    await ctx.React.act(async () => props(compSelect).onChange({ target: { value: 'group' } }));
    const updatedLeft = allFind(ctx.host, (n) => n.tagName === 'DIV' && hasClass(n, 'group'))[0];
    assert.deepEqual(fieldLabelsOf(updatedLeft), ['Tax Computation', 'Amount', 'Child Taxes', 'Description']);

    const tabButtons = allFind(ctx.host, (n) => n.tagName === 'BUTTON' && props(n)?.role === 'tab');
    assert.deepEqual(tabButtons.map((b) => b.textContent.trim()), ['Definition', 'Advanced Options']);

    // Definition tab renders both repartition sections side-by-side in .groups with % before Based On.
    const defPanel = find(ctx.host, (n) => props(n)?.role === 'tabpanel');
    const defGroupTitles = allFind(defPanel, (n) => hasClass(n, 'group-title')).map((n) => n.textContent.trim());
    assert.deepEqual(defGroupTitles, ['Distribution for Invoices', 'Distribution for Refunds']);
    const defTables = allFind(defPanel, (n) => n.tagName === 'TABLE' && hasClass(n, 'lines'));
    assert.equal(defTables.length, 2);
    for (const tbl of defTables) {
      const ths = allFind(tbl, (n) => n.tagName === 'TH' && !hasClass(n, 'o2m-cols-th')).map((th) => th.textContent.trim());
      assert.deepEqual(ths.slice(0, 2), ['%', 'Based On']);
    }

    // Advanced Options tab renders the two groups and exactly one Tax Group field.
    await ctx.React.act(async () => props(tabButtons[1]).onClick());
    const advPanel = find(ctx.host, (n) => props(n)?.role === 'tabpanel');
    const advGroups = allFind(advPanel, (n) => hasClass(n, 'group'));
    assert.equal(advGroups.length, 2);
    assert.deepEqual(fieldLabelsOf(advGroups[0]), ['Label on Invoices', 'Tax Group']);
    assert.deepEqual(fieldLabelsOf(advGroups[1]), [
      'Included in Price',
      'Affect Base of Subsequent Taxes',
      'Base Affected by Previous Taxes',
      'Active',
      'Tax Exigibility',
      'Cash Basis Transition Account',
    ]);
    assert.equal(allFind(ctx.host, (n) => hasClass(n, 'field') && n.childNodes[0]?.textContent?.trim() === 'Tax Group').length, 1);
  } finally {
    await ctx.done();
  }
});

test('seed taxes and withDefaultVat set tax_group_id to real account.tax.group records', () => {
  const db = seed();
  const groups = new Map(search(db, 'account.tax.group').map((g) => [g.id, g.name]));
  assert.ok([...groups.values()].includes('VAT'));
  assert.ok([...groups.values()].includes('Stamp'));
  for (const tax of search(db, 'account.tax')) {
    assert.equal('tax_group' in tax, false, `seeded tax ${tax.name} drops legacy char tax_group`);
    assert.ok(groups.has(tax.tax_group_id), `seeded tax ${tax.name} links to account.tax.group`);
  }
  const stamp = search(db, 'account.tax').find((t) => t.name === 'Stamp Duty');
  assert.equal(groups.get(stamp.tax_group_id), 'Stamp');

  const co = createCompanyWithDefaultInvoiceJournals(db, { name: 'Branch Co' });
  const vatDb = withDefaultVat(co.db, co.id, 14);
  const companyTaxes = search(vatDb, 'account.tax').filter((t) => t.company_id === co.id);
  assert.equal(companyTaxes.length, 2);
  for (const tax of companyTaxes) {
    assert.equal('tax_group' in tax, false);
    assert.equal(read(vatDb, 'account.tax.group', tax.tax_group_id)?.name, 'VAT');
  }
});

test('a legacy tax record carrying only tax_group char loads, opens in form view, and groups cleanly', async () => {
  const base = seed();
  const legacyTax = {
    id: 999,
    name: 'Legacy Char Tax',
    sequence: 1,
    amount_type: 'percent',
    amount: 10,
    children_tax_ids: [],
    type_tax_use: 'sale',
    tax_exigibility: 'on_invoice',
    price_include: false,
    include_base_amount: false,
    is_base_affected: true,
    active: true,
    tax_group: 'Legacy Text Group',
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 100, account_id: null, tag_ids: [] },
    ],
    refund_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 100, account_id: null, tag_ids: [] },
    ],
  };
  const legacyDb = {
    ...base,
    records: {
      ...base.records,
      'account.tax': [...base.records['account.tax'], legacyTax],
    },
  };
  assert.equal(read(legacyDb, 'account.tax', 999).name, 'Legacy Char Tax');
  const grouped = groupRecords(legacyDb, 'account.tax', [read(legacyDb, 'account.tax', 999)], 'tax_group_id');
  assert.equal(grouped.length, 1);

  const { FormView } = await import('./views/FormView.jsx');
  const ctx = await mountView(
    (React) => React.createElement(FormView, {
      leaf: taxesLeaf(),
      id: 999,
      base: '#/accounting/taxes',
      params: new URLSearchParams('view=form'),
    }),
    legacyDb,
  );
  try {
    const titleInput = find(ctx.host, (n) => n.tagName === 'INPUT' && props(n)?.value === 'Legacy Char Tax');
    assert.ok(titleInput, 'legacy tax record opens cleanly in FormView');
    const savedDb = write(ctx.getDb(), 'account.tax', 999, { description: 'Updated note', tax_scope: 'service' });
    const saved = read(savedDb, 'account.tax', 999);
    assert.equal(saved.tax_scope, 'service');
    assert.equal(saved.description, 'Updated note');
  } finally {
    await ctx.done();
  }
});

test('invoice tax line labels and print breakdown stay unchanged with separate description and invoice_label fields', async () => {
  const base = seed();
  const madeTax = create(base, 'account.tax', {
    name: 'Special VAT 14%',
    description: 'Internal tax note',
    invoice_label: '14% VAT',
    type_tax_use: 'sale',
    tax_scope: 'consu',
    amount: 14,
  });
  const taxRec = read(madeTax.db, 'account.tax', madeTax.id);
  const snap = taxSnapshot(taxRec);
  assert.equal(snap.tax_name, 'Special VAT 14%');

  const inv = create(madeTax.db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, ...snap }],
  });
  const posted = postMove(inv.db, inv.id);
  const { PrintDoc } = await import('./views/PrintDoc.jsx');
  const ctx = await mountView(
    (React) => React.createElement(PrintDoc, { model: 'account.move', id: inv.id }),
    posted,
  );
  try {
    const html = ctx.host.textContent;
    assert.match(html, /Special VAT 14%/);
    assert.doesNotMatch(html, /Internal tax note/);
  } finally {
    await ctx.done();
  }
});

test('Arabic translations cover every account.tax label, tab, and selection option', async () => {
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem: () => {}, removeItem: () => {}, clear: () => {} };
  try {
    const { t } = await import('./i18n.js?lang=ar-tax');
    const taxDef = models['account.tax'];
    const labels = [
      taxDef.label,
      ...Object.values(taxDef.fields).map((f) => f.label),
      ...taxDef.form.tabs.map((tab) => tab.label),
      ...Object.values(taxDef.fields.invoice_repartition_line_ids.fields)
        .map((f) => f.label)
        .filter((l) => l !== '%'),
      'Tax Scope',
      'Goods',
      'Services',
      'Distribution for Invoices',
      'Distribution for Refunds',
      'of Tax',
      'Group of Taxes',
      'Percentage',
      'Fixed',
      'Sales',
      'Purchases',
    ];
    for (const label of labels) {
      assert.notEqual(t(label), label, `missing Arabic translation for "${label}"`);
    }
  } finally {
    globalThis.localStorage = prevStorage;
  }
});
