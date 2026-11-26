import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { apps, findLeaf, menusFor, models } from './models/index.js';
import { defaultTaxRepartitionLines, productTax } from './models/taxes.js';
import { postMove } from './models/accounting.js';
import { createCompanyWithDefaultInvoiceJournals } from './test-support/accounting-company.js';
import { applyDiff, diffDb } from './sync.js';
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
  globalThis.document.createElementNS = (_ns, tag) => makeEl(tag);
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit, getDb } = await import('./store.js');
  const { ActionView } = await import('./views/ActionView.jsx');
  const { FormView } = await import('./views/FormView.jsx');
  const { List, visibleListColumns } = await import('./views/List.jsx');
  await initStore();
  await commit(initialDb);
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    return await fn({ React, host, root, commit, getDb, ActionView, FormView, List, visibleListColumns });
  } finally {
    await React.act(async () => root.unmount());
    globalThis.localStorage = prevStorage;
  }
}

test('PRD-2: Accounting > Customers/Vendors > Products list columns and optional toggles match Odoo 20', async () => {
  const db0 = seed();
  const tag = create(db0, 'product.tag', { name: 'Bestseller' });
  const db = write(tag.db, 'product', 1, { tag_ids: [tag.id], barcode: '1234567890123' });

  const customersProducts = leafFor('Customers', 'customer-products');
  const vendorsProducts = leafFor('Vendors', 'vendor-products');
  const accountingApp = apps.find((a) => a.id === 'accounting');
  assert.equal(findLeaf(accountingApp, 'customer-products'), customersProducts);
  assert.equal(findLeaf(accountingApp, 'vendor-products'), vendorsProducts);

  await withUi(db, async ({ React, host, root, ActionView, visibleListColumns }) => {
    const cust = visibleListColumns(models.product, db, {}, {
      list: customersProducts.list,
      listFields: customersProducts.listFields,
    });
    assert.deepEqual(cust.cols, ['name', 'default_code', 'list_price', 'taxes_id', 'qty_available', 'uom_id']);
    assert.deepEqual(
      cust.optionalCols.map(([k, f]) => [k, f.optional]),
      [
        ['default_code', 'show'],
        ['tag_ids', 'hide'],
        ['barcode', 'hide'],
        ['list_price', 'show'],
        ['cost', 'hide'],
        ['qty_available', 'show'],
        ['categ_id', 'hide'],
        ['type', 'hide'],
        ['uom_id', 'show'],
      ],
    );

    const vend = visibleListColumns(models.product, db, {}, {
      list: vendorsProducts.list,
      listFields: vendorsProducts.listFields,
    });
    assert.deepEqual(vend.cols, ['name', 'default_code', 'cost', 'supplier_taxes_id', 'qty_available', 'uom_id']);
    assert.deepEqual(
      vend.optionalCols.map(([k, f]) => [k, f.optional]),
      [
        ['default_code', 'show'],
        ['tag_ids', 'hide'],
        ['barcode', 'hide'],
        ['list_price', 'hide'],
        ['cost', 'show'],
        ['qty_available', 'show'],
        ['categ_id', 'hide'],
        ['type', 'hide'],
        ['uom_id', 'show'],
      ],
    );

    // Toggling optional columns reveals tag_ids, barcode, cost, categ_id, type.
    const toggled = visibleListColumns(models.product, db, { tag_ids: true, barcode: true, cost: true, categ_id: true, type: true }, {
      list: customersProducts.list,
      listFields: customersProducts.listFields,
    });
    assert.deepEqual(toggled.cols, ['name', 'default_code', 'tag_ids', 'barcode', 'list_price', 'taxes_id', 'cost', 'qty_available', 'categ_id', 'type', 'uom_id']);

    // Multi-company includes optional company_id column.
    const co2 = createCompanyWithDefaultInvoiceJournals(db, { name: 'Co2', currency_id: read(db, 'res.company', 1).currency_id });
    const multiCust = visibleListColumns(models.product, co2.db, { company_id: true }, {
      list: customersProducts.list,
      listFields: customersProducts.listFields,
    });
    assert.ok(multiCust.cols.includes('company_id'));

    // Render Customers > Products in list view and verify Sales Taxes column & tags render.
    await React.act(async () => root.render(React.createElement(ActionView, {
      leaf: customersProducts,
      base: '#/accounting/customer-products',
      params: new URLSearchParams('view=list'),
    })));
    const custHeaders = allFind(host, (n) => n.tagName === 'TH').map((th) => th.textContent.trim());
    assert.ok(custHeaders.some((h) => h.includes('Product Name')));
    assert.ok(custHeaders.some((h) => h.includes('Sales Price')));
    assert.ok(custHeaders.some((h) => h.includes('Sales Taxes')));
    assert.ok(!custHeaders.some((h) => h === 'Cost'));
    assert.ok(host.textContent.includes('VAT 14%'));

    // Render Vendors > Products in list view and verify Purchase Taxes column renders.
    await React.act(async () => root.render(React.createElement(ActionView, {
      key: 'vendor-products',
      leaf: vendorsProducts,
      base: '#/accounting/vendor-products',
      params: new URLSearchParams('view=list'),
    })));
    const vendHeaders = allFind(host, (n) => n.tagName === 'TH').map((th) => th.textContent.trim());
    assert.ok(vendHeaders.some((h) => h.includes('Cost')));
    assert.ok(vendHeaders.some((h) => h.includes('Purchase Taxes')));
    assert.ok(!vendHeaders.some((h) => h.includes('Sales Price')));
  });
});

test('PRD-2: No hardcoded 14% default tax rate; new products take company default taxes and support multi-tax', () => {
  assert.equal(models.product.defaults(1).sale_tax, undefined);
  assert.equal(models.product.defaults(1).purchase_tax, undefined);
  assert.equal(models.product.fields.sale_tax.hidden, true);
  assert.equal(models.product.fields.purchase_tax.hidden, true);

  let db = seed();
  const vatPay = search(db, 'account.account').find((a) => a.code === '251000').id;
  const vatRec = search(db, 'account.account').find((a) => a.code === '131000').id;
  const sale15 = create(db, 'account.tax', { name: 'VAT 15%', company_id: 1, type_tax_use: 'sale', amount_type: 'percent', amount: 15, ...defaultTaxRepartitionLines(vatPay, []) });
  db = sale15.db;
  const purch5 = create(db, 'account.tax', { name: 'Import 5%', company_id: 1, type_tax_use: 'purchase', amount_type: 'percent', amount: 5, ...defaultTaxRepartitionLines(vatRec, []) });
  db = purch5.db;
  const eco2 = create(db, 'account.tax', { name: 'Eco 2%', company_id: 1, type_tax_use: 'sale', amount_type: 'percent', amount: 2, ...defaultTaxRepartitionLines(vatPay, []) });
  db = eco2.db;

  // Company configured with 15% sale and 5% purchase default taxes.
  db = write(db, 'res.company', 1, { account_sale_tax_id: sale15.id, account_purchase_tax_id: purch5.id });
  const customersProducts = leafFor('Customers', 'customer-products');
  const formDefaults = newDefaults(db, 'product', customersProducts, new URLSearchParams(), null);
  assert.deepEqual(formDefaults.taxes_id, [sale15.id]);
  assert.deepEqual(formDefaults.supplier_taxes_id, [purch5.id]);

  const created = create(db, 'product', { name: 'Company Defaulted Item', list_price: 100, cost: 40 });
  const prod = read(created.db, 'product', created.id);
  assert.deepEqual(prod.taxes_id, [sale15.id]);
  assert.equal(prod.tax_id, sale15.id);
  assert.deepEqual(prod.supplier_taxes_id, [purch5.id]);
  assert.equal(prod.supplier_tax_id, purch5.id);
  assert.equal(productTax(created.db, prod, 'sale', null, 1).tax, 15);
  assert.equal(productTax(created.db, prod, 'purchase', null, 1).tax, 5);

  // Company with no default taxes produces untaxed new products (no hardcoded 14%).
  const noTaxDb = write(created.db, 'res.company', 1, { account_sale_tax_id: null, account_purchase_tax_id: null });
  const untaxed = create(noTaxDb, 'product', { name: 'Untaxed Item', list_price: 100 });
  const untaxedProd = read(untaxed.db, 'product', untaxed.id);
  assert.deepEqual(untaxedProd.taxes_id, []);
  assert.equal(untaxedProd.tax_id, null);
  assert.deepEqual(untaxedProd.supplier_taxes_id, []);
  assert.equal(untaxedProd.supplier_tax_id, null);
  assert.equal(productTax(untaxed.db, untaxedProd, 'sale', null, 1), null);

  // Multi-tax on a product applies all taxes on invoice lines.
  const multiDb = write(untaxed.db, 'product', untaxed.id, { taxes_id: [sale15.id, eco2.id] });
  const lineDef = models['account.move'].fields.invoice_line_ids;
  const line = lineDef.onchange({ product_id: untaxed.id, qty: 1 }, 'product_id', multiDb, { move_type: 'out_invoice', company_id: 1 });
  assert.deepEqual(line.tax_ids, [sale15.id, eco2.id]);
  assert.equal(line.tax_id, sale15.id);

  // Shared products take only the active company default; explicitly assigned taxes are filtered by document company.
  const co2 = createCompanyWithDefaultInvoiceJournals(noTaxDb, { name: 'Branch Co', currency_id: read(noTaxDb, 'res.company', 1).currency_id });
  const co2Sale = create(co2.db, 'account.tax', { name: 'Branch VAT 20%', type_tax_use: 'sale', amount_type: 'percent', amount: 20, company_id: co2.id, ...defaultTaxRepartitionLines(vatPay, []) });
  let multiCoDb = write(co2Sale.db, 'res.company', 1, { account_sale_tax_id: sale15.id });
  multiCoDb = write(multiCoDb, 'res.company', co2.id, { account_sale_tax_id: co2Sale.id });
  const shared = create(multiCoDb, 'product', { name: 'Shared Multi-Co Item', list_price: 100 });
  const sharedProd = read(shared.db, 'product', shared.id);
  assert.deepEqual(sharedProd.taxes_id, [sale15.id]);
  assert.equal(productTax(shared.db, sharedProd, 'sale', null, 1).tax, 15);
  assert.equal(productTax(shared.db, sharedProd, 'sale', null, co2.id), null);
  const both = { ...sharedProd, taxes_id: [sale15.id, co2Sale.id] };
  assert.equal(productTax(shared.db, both, 'sale', null, co2.id).tax, 20);
});

test('PRD-2: Combo product type clears taxes and purchase_ok, enforces guards, hides non-combo fields, and posts on invoices', async () => {
  let db = seed();
  assert.ok(models.product.fields.type.options.some(([k, l]) => k === 'combo' && l === 'Combo'));
  assert.ok(models.product.filters.flat().some((f) => f.id === 'combo' && f.label === 'Combo'));

  // Creating a combo product omits company default taxes and sets purchase_ok = false.
  const made = create(db, 'product', { name: 'Office Bundle', type: 'combo', list_price: 300 });
  db = made.db;
  const combo = read(db, 'product', made.id);
  assert.equal(combo.type, 'combo');
  assert.equal(combo.purchase_ok, false);
  assert.deepEqual(combo.taxes_id, []);
  assert.equal(combo.tax_id, null);
  assert.deepEqual(combo.supplier_taxes_id, []);
  assert.equal(combo.supplier_tax_id, null);

  // Switching an existing goods product to combo clears taxes and purchase_ok.
  const switched = write(db, 'product', 1, { type: 'combo' });
  const switchedRec = read(switched, 'product', 1);
  assert.equal(switchedRec.purchase_ok, false);
  assert.deepEqual(switchedRec.taxes_id, []);
  assert.equal(switchedRec.tax_id, null);
  assert.deepEqual(switchedRec.supplier_taxes_id, []);
  assert.equal(switchedRec.supplier_tax_id, null);

  // Guards reject combo products with purchase_ok, taxes, or attributes (including via applyDiff).
  const vatSale = read(db, 'res.company', 1).account_sale_tax_id;
  assert.throws(() => create(db, 'product', { name: 'Bad Combo Tax', type: 'combo', taxes_id: [vatSale] }), /Combo products cannot have taxes/);
  assert.throws(() => create(db, 'product', { name: 'Bad Combo Buy', type: 'combo', purchase_ok: true }), /Combo products cannot be purchased/);
  const forged = {
    ...db,
    records: {
      ...db.records,
      product: db.records.product.map((p) => (p.id === made.id ? { ...p, taxes_id: [vatSale], tax_id: vatSale } : p)),
    },
  };
  assert.throws(() => applyDiff(db, diffDb(db, forged), { isAdmin: true }), /Combo products cannot have taxes/);

  // Product form hides purchase_ok, cost, barcode, taxes_id, supplier_taxes_id for combo, and renders Accounting > Cost and Revenue.
  const customersProducts = leafFor('Customers', 'customer-products');
  await withUi(db, async ({ React, host, root, FormView }) => {
    await React.act(async () => root.render(React.createElement(FormView, {
      leaf: customersProducts,
      id: String(made.id),
      base: '#/accounting/customer-products',
      params: new URLSearchParams('view=form'),
    })));
    const byFieldId = (id) => find(host, (n) => props(n)?.id === id);
    assert.ok(byFieldId('f-list_price'));
    assert.equal(byFieldId('f-purchase_ok'), null);
    assert.equal(byFieldId('f-cost'), null);
    assert.equal(byFieldId('f-barcode'), null);
    assert.equal(byFieldId('f-taxes_id'), null);
    assert.equal(byFieldId('f-supplier_taxes_id'), null);
    assert.equal(byFieldId('f-sale_tax'), null);
    assert.equal(byFieldId('f-purchase_tax'), null);

    const accTab = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.trim() === 'Accounting');
    assert.ok(accTab, 'Accounting tab exists on product form');
    await React.act(async () => props(accTab).onClick());
    assert.ok(host.textContent.includes('Cost and Revenue'));
    assert.ok(byFieldId('f-property_account_income_id'));
    assert.ok(byFieldId('f-property_account_expense_id'));
  });

  // Invoice behavior for combo: selectable on customer invoices (not vendor bills), 0 tax, posts cleanly.
  const lineDef = models['account.move'].fields.invoice_line_ids;
  assert.equal(lineDef.fields.product_id.domain(combo, { move_type: 'out_invoice' }), true);
  assert.equal(lineDef.fields.product_id.domain(combo, { move_type: 'in_invoice' }), false);

  const line = lineDef.onchange({ product_id: made.id, qty: 2 }, 'product_id', db, { move_type: 'out_invoice', company_id: 1 });
  assert.deepEqual(line.tax_ids, []);
  assert.equal(line.tax_id, null);
  assert.equal(line.tax, 0);
  assert.equal(line.price_unit, 300);

  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-06-01',
    invoice_line_ids: [line],
  });
  const postedDb = postMove(inv.db, inv.id);
  const posted = read(postedDb, 'account.move', inv.id);
  assert.equal(posted.state, 'posted');
  assert.equal(posted.amount_untaxed, 600);
  assert.equal(posted.amount_tax, 0);
  assert.equal(posted.amount_total, 600);
});

test('PRD-2: Arabic translations exist for new product, combo, and Accounting form labels and errors', async () => {
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem: () => {}, removeItem: () => {}, clear: () => {} };
  try {
    const { t } = await import('./i18n.js?lang=ar-prd2');
    for (const phrase of [
      'Combo',
      'Cost and Revenue',
      'From Category',
      'Select an existing tax',
      'Combo products cannot have taxes',
      'Combo products cannot be purchased',
      'Combo products cannot have attributes',
      'Sales Taxes',
      'Purchase Taxes',
      'Product Tags',
      'Stock / Sales Unit',
    ]) {
      assert.notEqual(t(phrase), phrase, `missing Arabic translation for "${phrase}"`);
    }
  } finally {
    globalThis.localStorage = prevStorage;
  }
});

test('legacy scalar tax fallback is exported and drives list sorting', async () => {
  let db = seed();
  const z = create(db, 'account.tax', { name: 'Zulu tax', type_tax_use: 'sale', amount: 3, company_id: 1 });
  const a = create(z.db, 'account.tax', { name: 'Alpha tax', type_tax_use: 'sale', amount: 4, company_id: 1 });
  const first = create(a.db, 'product', { name: 'First fallback', taxes_id: [] });
  const second = create(first.db, 'product', { name: 'Second fallback', taxes_id: [] });
  db = { ...second.db, records: { ...second.db.records, product: second.db.records.product.map((p) => p.id === first.id ? { ...p, tax_id: z.id, taxes_id: [] } : p.id === second.id ? { ...p, tax_id: a.id, taxes_id: [] } : p) } };
  const records = [read(db, 'product', first.id), read(db, 'product', second.id)];
  await withUi(db, async ({ React, host, root, List, ActionView }) => {
    const listFields = { name: { optional: null }, taxes_id: { optional: null } };
    await React.act(async () => root.render(React.createElement(List, { db, model: 'product', records, open: () => {}, selected: new Set(), setSelected: () => {}, groupBy: [], page: { start: 0, end: 10 }, list: ['name', 'taxes_id'], listFields })));
    assert.ok(host.textContent.includes('Zulu tax'));
    assert.ok(host.textContent.includes('Alpha tax'));
    const sortButton = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes('Sales Taxes'));
    assert.ok(sortButton);
    const body = find(host, (n) => n.tagName === 'TBODY');
    const append = body.appendChild;
    body.appendChild = (child) => { if (body.childNodes.includes(child)) body.removeChild(child); return append(child); };
    await React.act(async () => props(sortButton).onClick());
    const rows = body.childNodes.filter((n) => n.tagName === 'TR');
    assert.ok(rows[0].textContent.includes('Second fallback'));
    assert.ok(rows[1].textContent.includes('First fallback'));

    const previous = URL.createObjectURL;
    let blob;
    URL.createObjectURL = (value) => { blob = value; return 'blob:regression'; };
    try {
      await React.act(async () => root.render(React.createElement(ActionView, { leaf: { key: 'fallback-export', model: 'product', view: 'list', list: ['name', 'taxes_id'], listFields, domain: (p) => p.id === first.id }, base: '#/test', params: new URLSearchParams('view=list') })));
      const exportButton = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes('Export'));
      assert.ok(exportButton);
      await React.act(async () => props(exportButton).onClick());
      const dialog = find(host, (n) => props(n)?.role === 'dialog');
      assert.ok(dialog, 'Export dialog opens');
      const formatSelect = find(dialog, (n) => props(n)?.['aria-label'] === 'Format');
      await React.act(async () => props(formatSelect).onChange({ target: { value: 'csv' } }));
      const confirmButton = find(dialog, (n) => n.tagName === 'BUTTON' && n.textContent === 'Export');
      await React.act(async () => props(confirmButton).onClick());
      assert.ok(blob, 'CSV download created');
      const csv = await blob.text();
      assert.match(csv, /First fallback/);
      assert.match(csv, /Zulu tax/);
    } finally { URL.createObjectURL = previous; }
  });
});

test('per-row hide rules suppress editable, badge and ordinary cells', async () => {
  let db = seed();
  const hidden = create(db, 'product', { name: 'Hidden row', type: 'service', default_code: 'EDIT-HIDDEN', barcode: 'PLAIN-HIDDEN' });
  const visible = create(hidden.db, 'product', { name: 'Visible row', type: 'goods', default_code: 'EDIT-VISIBLE', barcode: 'PLAIN-VISIBLE' });
  db = visible.db;
  await withUi(db, async ({ React, host, root, List }) => {
    const oldEditable = models.product.editableList;
    models.product.editableList = ['default_code'];
    try {
      const hideWhen = (r) => r.type === 'service';
      const listFields = {
        name: { optional: null },
        default_code: { optional: null, hideWhen },
        type: { optional: null, hideWhen, badge: { goods: 'success', service: 'warning' } },
        barcode: { optional: null, hideWhen },
      };
      await React.act(async () => root.render(React.createElement(List, { db, model: 'product', records: [read(db, 'product', hidden.id), read(db, 'product', visible.id)], open: () => {}, selected: new Set(), setSelected: () => {}, groupBy: [], page: { start: 0, end: 10 }, list: ['name', 'default_code', 'type', 'barcode'], listFields })));
      const body = find(host, (n) => n.tagName === 'TBODY');
      const rows = body.childNodes.filter((n) => n.tagName === 'TR');
      const hiddenCells = rows[0].childNodes.filter((n) => n.tagName === 'TD');
      const visibleCells = rows[1].childNodes.filter((n) => n.tagName === 'TD');
      assert.equal(Boolean(find(hiddenCells[2], (n) => n.tagName === 'INPUT')), false);
      assert.equal(hiddenCells[3].textContent, '');
      assert.equal(hiddenCells[4].textContent, '');
      assert.ok(find(visibleCells[2], (n) => n.tagName === 'INPUT'));
      assert.ok(visibleCells[3].textContent.includes('Goods'));
      assert.equal(visibleCells[4].textContent, 'PLAIN-VISIBLE');
    } finally { models.product.editableList = oldEditable; }
  });
});
