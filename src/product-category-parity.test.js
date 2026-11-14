import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { find, setupDom } from './test-support/dom.js';
import { create, matches, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { accountingCompany } from './test-support/accounting-company.js';
import { invoiceLines } from './models/ledger.js';
import { postMove } from './models/accounting.js';
import { deliver, receive } from './models/valuation.js';
import { menusFor, models, viewsOf } from './models/index.js';
import { migrate, SCHEMA_VERSION } from './migrations.js';

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

const categoryLeaf = () => findLeafByKey(menusFor('accounting'), 'product-categories');

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
  await React.act(async () => { root.render(renderElement(React)); });
  return {
    React,
    host,
    commit,
    getDb,
    done: async () => {
      await React.act(async () => { root.unmount(); });
      globalThis.localStorage = prevStorage;
    },
  };
}

test('list view opens first with single Product Category column (full path) and search fields', async () => {
  assert.deepEqual(viewsOf('product.category'), ['list']);
  const def = models['product.category'];
  assert.deepEqual(def.list, ['display_name']);
  assert.equal(def.listLabels.display_name, 'Product Category');
  assert.deepEqual(def.searchFields, ['name', 'parent_id']);

  let db = seed();
  const parent = create(db, 'product.category', { name: 'All' });
  const child = create(parent.db, 'product.category', { name: 'Lamps', parent_id: parent.id });
  db = child.db;

  assert.ok(matches(db, 'product.category', read(db, 'product.category', child.id), ['Lamps']));
  assert.ok(matches(db, 'product.category', read(db, 'product.category', child.id), ['All']));
  assert.ok(!matches(db, 'product.category', read(db, 'product.category', parent.id), ['Lamps']));

  const { ActionView } = await import('./views/ActionView.jsx');
  const ctx = await mountView((React) => React.createElement(ActionView, { leaf: categoryLeaf(), base: '#/accounting/product-categories', params: new URLSearchParams() }), db);
  try {
    const headers = allFind(ctx.host, (n) => n.tagName === 'TH' && !hasClass(n, 'o2m-cols-th'))
      .map((th) => th.textContent.replace(/[▲▼]/g, '').trim())
      .filter(Boolean);
    assert.deepEqual(headers, ['Product Category']);
    assert.ok(ctx.host.textContent.includes('All / Lamps'), 'full path rendered in list row');
    assert.deepEqual(def.searchFields.map((f) => def.fields[f].label), ['Product Categories', 'Parent Category']);

    // Live search bar matches Parent Category via searchFields: ['name', 'parent_id']
    const standalone = create(db, 'product.category', { name: 'Services Only' });
    await ctx.React.act(async () => { await ctx.commit(standalone.db); });
    const searchInput = find(ctx.host, (n) => n.tagName === 'INPUT' && props(n)?.placeholder === 'Search...');
    await ctx.React.act(async () => { props(searchInput).onChange({ target: { value: 'All' } }); });
    const updatedSearchInput = find(ctx.host, (n) => n.tagName === 'INPUT' && props(n)?.placeholder === 'Search...');
    await ctx.React.act(async () => { props(updatedSearchInput).onKeyDown({ key: 'Enter' }); });
    assert.ok(ctx.host.textContent.includes('All / Lamps'));
    assert.ok(!ctx.host.textContent.includes('Services Only'));
  } finally {
    await ctx.done();
  }
});

test('form view matches Odoo 20 layout: titleLabel, placeholder, smart button, two accounting groups, conditional price difference, inventory tab, and chatter', async () => {
  let db = seed();
  const categ = create(db, 'product.category', {
    name: 'Lighting',
    property_valuation: 'periodic',
    property_cost_method: 'average',
  });
  const p1 = create(categ.db, 'product', { name: 'Desk Lamp', categ_id: categ.id });
  const p2 = create(p1.db, 'product', { name: 'Floor Lamp', categ_id: categ.id });
  db = p2.db;

  const { FormView } = await import('./views/FormView.jsx');
  const ctx = await mountView((React) => React.createElement(FormView, {
    leaf: categoryLeaf(),
    id: String(categ.id),
    base: '#/accounting/product-categories',
    params: new URLSearchParams('view=list'),
  }), db);

  try {
    // Title label "Category" and placeholder "e.g. Lamps"
    const titleLabel = find(ctx.host, (n) => n.tagName === 'LABEL' && hasClass(n, 'title-label'));
    assert.equal(titleLabel?.textContent?.trim(), 'Category');
    const titleInput = find(ctx.host, (n) => n.tagName === 'INPUT' && props(n)?.id === 'f-name');
    assert.equal(props(titleInput)?.placeholder, 'e.g. Lamps');

    // Products smart button count & target
    const smart = allFind(ctx.host, (n) => n.tagName === 'A' && hasClass(n, 'smart'))
      .find((a) => a.textContent.includes('Products'));
    assert.ok(smart, 'Products smart button rendered');
    assert.equal(find(smart, (n) => n.tagName === 'B')?.textContent, '2');
    assert.equal(props(smart)?.href, `#/inventory/products?view=list&rel=categ_id:${categ.id}`);

    // Header group: only Parent Category with blank option "None"
    const parentEl = find(ctx.host, (n) => n.tagName === 'SELECT' && props(n)?.id === 'f-parent_id');
    const blankParentOption = find(parentEl, (n) => n.tagName === 'OPTION' && props(n)?.value === '');
    assert.equal(blankParentOption?.textContent?.trim(), 'None');
    assert.equal(find(ctx.host, (n) => props(n)?.id === 'f-company_id'), null, 'company_id stays hidden');
    assert.equal(find(ctx.host, (n) => props(n)?.id === 'f-property_stock_journal'), null, 'stock journal stays hidden');

    // Accounting tab: 2 groups, Price Difference hidden when valuation != real_time or cost != standard
    const tabs = allFind(ctx.host, (n) => props(n)?.role === 'tab');
    assert.deepEqual(tabs.map((tabEl) => tabEl.textContent.trim()), ['Accounting', 'Inventory']);
    const groups = allFind(ctx.host, (n) => hasClass(n, 'group'));
    assert.equal(groups.length, 3, '1 header group + 2 accounting tab groups');
    assert.deepEqual(fieldLabelsOf(groups[0]), ['Parent Category']);
    assert.deepEqual(fieldLabelsOf(groups[1]), [
      'Income Account',
      'Expense Account',
      'Invoices to be Issued Account',
      'Invoiced Not Delivered Account',
    ]);
    assert.deepEqual(fieldLabelsOf(groups[2]), [
      'Inventory Valuation',
      'Costing Method',
      'Stock Account',
      'Stock Variation',
    ]);
    assert.equal(find(ctx.host, (n) => props(n)?.id === 'f-property_account_creditor_price_difference_categ'), null);

    // Switch to Perpetual (real_time) + average -> still hidden
    const valSelect = find(ctx.host, (n) => props(n)?.id === 'f-property_valuation');
    await ctx.React.act(async () => { props(valSelect).onChange({ target: { value: 'real_time' } }); });
    assert.equal(find(ctx.host, (n) => props(n)?.id === 'f-property_account_creditor_price_difference_categ'), null);

    // Switch Costing Method to Standard Price while Perpetual -> Price Difference Account appears
    const costSelect = find(ctx.host, (n) => props(n)?.id === 'f-property_cost_method');
    await ctx.React.act(async () => { props(costSelect).onChange({ target: { value: 'standard' } }); });
    assert.ok(find(ctx.host, (n) => props(n)?.id === 'f-property_account_creditor_price_difference_categ'));
    assert.ok(fieldLabelsOf(allFind(ctx.host, (n) => hasClass(n, 'group'))[2]).includes('Price Difference Account'));

    // Help texts present on Accounting tab
    assert.ok(ctx.host.textContent.includes('This account will be used when validating a customer invoice.'));
    assert.ok(ctx.host.textContent.includes('Account holding the accrued value of the goods delivered but not invoiced yet.'));
    assert.ok(ctx.host.textContent.includes('Account holding the accrued value of the goods invoiced but not delivered yet.'));
    assert.ok(ctx.host.textContent.includes('At closing, register the inventory variation of the period into a specific account'));

    // Inventory tab shows Routes & Removal Strategy
    await ctx.React.act(async () => { props(tabs[1]).onClick(); });
    assert.deepEqual(fieldLabelsOf(find(ctx.host, (n) => hasClass(n, 'tab-panel'))), ['Routes', 'Removal Strategy']);

    // Chatter kept
    assert.ok(find(ctx.host, (n) => hasClass(n, 'chatter')), 'chatter rendered on existing category');
  } finally {
    await ctx.done();
  }
});

test('valuation and costing options, required constraint, defaults, and inheritance', () => {
  const def = models['product.category'];
  assert.deepEqual(def.fields.property_valuation.options, [
    ['periodic', 'Periodic (at closing)'],
    ['real_time', 'Perpetual (at invoicing)'],
  ]);
  assert.deepEqual(def.fields.property_cost_method.options, [
    ['standard', 'Standard Price'],
    ['average', 'Average Cost (AVCO)'],
    ['fifo', 'FIFO'],
  ]);
  assert.equal(def.fields.property_cost_method.required, true);

  let db = seed();
  const root = create(db, 'product.category', { name: 'Standard Default' });
  assert.equal(read(root.db, 'product.category', root.id).property_cost_method, 'standard');
  const parentFifo = create(root.db, 'product.category', { name: 'FIFO Parent', property_cost_method: 'fifo' });
  const child = create(parentFifo.db, 'product.category', { name: 'FIFO Child', parent_id: parentFifo.id });
  assert.equal(read(child.db, 'product.category', child.id).property_cost_method, 'fifo');

  assert.throws(
    () => create(child.db, 'product.category', { name: 'No Costing', property_cost_method: null }),
    /Costing Method is required/,
  );
  assert.throws(
    () => write(child.db, 'product.category', child.id, { property_cost_method: '' }),
    /Costing Method is required/,
  );
});

test('canonical income/expense accounts resolve invoice lines and COGS after migration 48', () => {
  let db = seed();
  const income = create(db, 'account.account', { code: '409100', name: 'Category Income', account_type: 'income', company_id: 1 });
  const expense = create(income.db, 'account.account', { code: '609100', name: 'Category Expense', account_type: 'expense', company_id: 1 });
  db = expense.db;

  // Legacy un-migrated category using property_account_income_id / property_account_expense_id
  const legacyDb = {
    ...db,
    schema_version: 47,
    records: {
      ...db.records,
      'product.category': [
        ...(db.records['product.category'] ?? []),
        {
          id: 950,
          name: 'Legacy Category',
          parent_id: null,
          property_account_income_id: income.id,
          property_account_expense_id: expense.id,
        },
      ],
      product: [
        ...(db.records.product ?? []),
        {
          id: 951,
          name: 'Legacy Cat Product',
          type: 'consu',
          categ_id: 950,
          list_price: 100,
          cost: 60,
          sale_ok: true,
          purchase_ok: true,
        },
      ],
    },
  };

  const migrated = migrate(legacyDb);
  assert.equal(SCHEMA_VERSION, 51);
  assert.equal(migrated.schema_version, 51);
  assert.equal(migrate(migrated), migrated, 'migration 48 is idempotent');

  const cat = read(migrated, 'product.category', 950);
  assert.equal(cat.property_account_income_categ_id, income.id);
  assert.equal(cat.property_account_expense_categ_id, expense.id);
  assert.equal(cat.property_cost_method, 'standard');
  assert.equal('property_account_income_id' in cat, false);
  assert.equal('property_account_expense_id' in cat, false);

  const saleEntry = invoiceLines(migrated, {
    move_type: 'out_invoice',
    company_id: 1,
    invoice_line_ids: [{ product_id: 951, qty: 1, price_unit: 100 }],
  });
  assert.ok(saleEntry.some((l) => l.account_id === income.id && l.credit === 100), 'customer invoice uses canonical category income account');

  const billEntry = invoiceLines(migrated, {
    move_type: 'in_invoice',
    company_id: 1,
    invoice_line_ids: [{ product_id: 951, qty: 1, price_unit: 60 }],
  });
  assert.ok(billEntry.some((l) => l.account_id === expense.id && l.debit === 60), 'vendor bill uses canonical category expense account');

  const postedBill = create(migrated, 'account.move', {
    move_type: 'in_invoice',
    company_id: 1,
    partner_id: 1,
    invoice_date: '2026-10-01',
    invoice_line_ids: [{ product_id: 951, qty: 1, price_unit: 60, tax: 0 }],
  });
  const confirmed = postMove(postedBill.db, postedBill.id);
  assert.ok(read(confirmed, 'account.move', postedBill.id).line_ids.some((l) => l.account_id === expense.id && l.debit === 60));

  // Category COGS account reuses property_account_expense_categ_id in perpetual stock valuation
  const stockAcc = create(migrated, 'account.account', { code: '110990', name: 'Category Stock', account_type: 'asset_current', company_id: 1 });
  const inputAcc = create(stockAcc.db, 'account.account', { code: '110991', name: 'Category Input', account_type: 'asset_current', company_id: 1 });
  const cogsCat = create(inputAcc.db, 'product.category', {
    name: 'Perpetual Goods',
    property_valuation: 'real_time',
    property_cost_method: 'fifo',
    property_account_expense_categ_id: expense.id,
    property_stock_valuation_account_id: stockAcc.id,
    property_stock_account_input_categ_id: inputAcc.id,
  });
  const stockProd = create(cogsCat.db, 'product', {
    name: 'Valued Lamp',
    type: 'goods',
    categ_id: cogsCat.id,
    cost: 25,
    qty_available: 0,
    cost_method: null,
    valuation: null,
  });
  const received = receive(stockProd.db, stockProd.id, 1, 25, { date: '2026-10-01' });
  const delivered = deliver(received, stockProd.id, 1, { date: '2026-10-02' });
  const outLayer = search(delivered.db, 'stock.valuation.layer').find((l) => l.product_id === stockProd.id && l.kind === 'out');
  assert.ok(read(delivered.db, 'account.move', outLayer.move_id).line_ids.some((l) => l.account_id === expense.id && l.debit === 25));
});

test('company validation enforces configured accounts match category company and cycle guard forbids loops', () => {
  const co2 = accountingCompany(seed());
  let db = co2.db;
  const acc1 = create(db, 'account.account', { code: '409201', name: 'Co1 Income', account_type: 'income', company_id: 1 });
  const acc2 = create(acc1.db, 'account.account', { code: '409202', name: 'Co2 Income', account_type: 'income', company_id: co2.id });
  const shared = create(acc2.db, 'account.account', { code: '609200', name: 'Shared Accrued', account_type: 'expense', company_id: null });
  db = shared.db;

  // Reject account from another company across standard & new category account fields
  assert.throws(
    () => create(db, 'product.category', { name: 'Bad Co', company_id: co2.id, property_account_income_categ_id: acc1.id }),
    /belongs to another company/,
  );
  assert.throws(
    () => create(db, 'product.category', { name: 'Bad Variation', company_id: 1, account_stock_variation_id: acc2.id }),
    /belongs to another company/,
  );
  assert.throws(
    () => create(db, 'product.category', { name: 'Bad Accrued', company_id: 1, account_invoices_to_be_issued_id: acc2.id }),
    /belongs to another company/,
  );

  // Allow matching-company account and company-less shared account; forbid changing company under mismatched account
  const valid = create(db, 'product.category', {
    name: 'Valid Co2',
    company_id: co2.id,
    property_account_income_categ_id: acc2.id,
    account_invoiced_not_delivered_id: shared.id,
  });
  assert.throws(
    () => write(valid.db, 'product.category', valid.id, { company_id: 1 }),
    /belongs to another company/,
  );

  // Cycle guard preserved
  const a = create(valid.db, 'product.category', { name: 'Parent A' });
  const b = create(a.db, 'product.category', { name: 'Child B', parent_id: a.id });
  assert.throws(
    () => write(b.db, 'product.category', a.id, { parent_id: b.id }),
    /Category hierarchy cannot contain a cycle/,
  );
});

test('Arabic translations exist and differ from English for every new or updated string', async () => {
  const keys = [
    'Product Category',
    'Product Categories',
    'Category',
    'e.g. Lamps',
    'None',
    'Parent Category',
    'Products',
    'Accounting',
    'Inventory',
    'Income Account',
    'This account will be used when validating a customer invoice.',
    'Expense Account',
    'The expense is accounted for when a vendor bill is validated, except in anglo-saxon accounting with perpetual inventory valuation in which case the expense (Cost of Goods Sold account) is recognized at the customer invoice validation.',
    'Invoices to be Issued Account',
    'Account holding the accrued value of the goods delivered but not invoiced yet. With perpetual valuation, it counterbalances the stock valuation account at closing.',
    'Invoiced Not Delivered Account',
    'Account holding the accrued value of the goods invoiced but not delivered yet. With perpetual valuation, it counterbalances the stock valuation account at closing.',
    'Inventory Valuation',
    'Periodic (at closing)',
    'Perpetual (at invoicing)',
    'Costing Method',
    'Standard Price',
    'Average Cost (AVCO)',
    'FIFO',
    'Stock Account',
    'Stock Variation',
    'At closing, register the inventory variation of the period into a specific account',
    'Price Difference Account',
    'Routes',
    'Removal Strategy',
    'Category hierarchy cannot contain a cycle',
    'Costing Method is required',
  ];

  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null) };
  try {
    const { t: tAr } = await import(`./i18n.js?ar=${Date.now()}`);
    for (const key of keys) {
      const translated = tAr(key);
      assert.ok(translated && translated !== key, `Missing or untranslated Arabic string for "${key}": got "${translated}"`);
    }
  } finally {
    globalThis.localStorage = prevStorage;
  }
});
