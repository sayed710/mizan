import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { applyFilters, create, groupRecords, matches, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { menusFor, models, viewsOf } from './models/index.js';
import { createCompany, setCompanies } from './models/company.js';
import { isDomesticRecord } from './models/taxes.js';

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
const fiscalPositionsLeaf = () => findLeafByKey(menusFor('accounting'), 'fiscal-positions');

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

test('taxes list matches Odoo 20 columns, optional state, multi-company column, drag handle, active toggle, and muted inactive rows', async () => {
  const def = models['account.tax'];
  assert.deepEqual(def.list, [
    'sequence', 'name', 'description', 'type_tax_use', 'original_tax_ids',
    'tax_scope', 'invoice_label', 'company_id', 'active',
  ]);
  assert.equal(def.fields.sequence.widget, 'handle');
  assert.equal(def.fields.description.optional, 'show');
  assert.equal(def.fields.original_tax_ids.optional, 'hide');
  assert.equal(def.fields.company_id.multiCompanyOnly, true);
  assert.equal(def.listFields.active.widget, 'toggle');
  assert.deepEqual(def.editableList, ['active']);

  const { visibleListColumns } = await import('./views/List.jsx');
  const { ActionView } = await import('./views/ActionView.jsx');

  let db = seed();
  assert.deepEqual(
    visibleListColumns(def, db, {}, { listFields: def.listFields }).cols,
    ['sequence', 'name', 'description', 'type_tax_use', 'tax_scope', 'invoice_label', 'active'],
  );
  assert.deepEqual(
    visibleListColumns(def, db, { description: false, original_tax_ids: true }, { listFields: def.listFields }).cols,
    ['sequence', 'name', 'type_tax_use', 'original_tax_ids', 'tax_scope', 'invoice_label', 'active'],
  );

  // Add second company -> Company column appears before Active
  const branch = createCompany(db, { name: 'Branch Co' });
  db = setCompanies(branch.db, { current: 1, allowed: [1, branch.id] });
  assert.deepEqual(
    visibleListColumns(def, db, {}, { listFields: def.listFields }).cols,
    ['sequence', 'name', 'description', 'type_tax_use', 'tax_scope', 'invoice_label', 'company_id', 'active'],
  );

  const leaf = taxesLeaf();
  const ctx = await mountView(
    (React) => React.createElement(ActionView, { leaf, base: '#/accounting/taxes', params: new URLSearchParams('view=list') }),
    db,
  );
  try {
    const table = find(ctx.host, (n) => n.tagName === 'TABLE' && hasClass(n, 'list'));
    const handleTh = find(table, (n) => n.tagName === 'TH' && hasClass(n, 'handle-col'));
    assert.equal(props(handleTh)?.['aria-label'], 'Sequence');

    const headers = allFind(table, (n) => n.tagName === 'TH' && !hasClass(n, 'o2m-cols-th'))
      .map((th) => th.textContent.replace(/[▲▼]/g, '').trim())
      .filter(Boolean);
    assert.deepEqual(headers, ['Tax Name', 'Description', 'Tax Type', 'Tax Scope', 'Label on Invoices', 'Company', 'Active']);

    // Optional columns menu exposes Description (checked) and Replaces (unchecked)
    const colsBtn = find(table, (n) => n.tagName === 'BUTTON' && hasClass(n, 'o2m-cols-toggle'));
    await ctx.React.act(async () => { props(colsBtn).onClick(); });
    const menuItems = allFind(table, (n) => props(n)?.role === 'menuitemcheckbox');
    assert.deepEqual(menuItems.map((b) => [b.textContent.replace('✓', '').trim(), props(b)['aria-checked']]), [
      ['Description', true],
      ['Replaces', false],
    ]);

    // Drag handle reorders sequence
    const rows = allFind(find(table, (n) => n.tagName === 'TBODY'), (n) => n.tagName === 'TR');
    assert.ok(rows.length >= 2);
    const firstBefore = rows[0].childNodes[2].textContent.trim();
    const secondBefore = rows[1].childNodes[2].textContent.trim();
    await ctx.React.act(async () => { props(rows[1]).onDragStart(); });
    await ctx.React.act(async () => { props(rows[0]).onDrop({ preventDefault: () => {} }); });
    const rowsAfterDrag = allFind(find(table, (n) => n.tagName === 'TBODY'), (n) => n.tagName === 'TR');
    assert.equal(rowsAfterDrag[0].childNodes[2].textContent.trim(), secondBefore);
    assert.equal(rowsAfterDrag[1].childNodes[2].textContent.trim(), firstBefore);

    // Editable active toggle switch archives a tax inline, keeps it visible (active_test False), and mutes its row
    const vatRow = rowsAfterDrag.find((tr) => tr.childNodes[2]?.textContent?.trim() === 'VAT 14%' && tr.childNodes[4]?.textContent?.trim() === 'Sales');
    const vatSwitch = find(vatRow, (n) => n.tagName === 'INPUT' && props(n)?.role === 'switch');
    assert.ok(vatSwitch, 'Active column renders toggle switch');
    assert.equal(props(vatSwitch).checked, true);
    await ctx.React.act(async () => {
      props(vatSwitch).onChange({ target: { checked: false } });
    });
    const archivedVat = search(ctx.getDb(), 'account.tax', { includeArchived: true }).find((t) => t.name === 'VAT 14%' && t.type_tax_use === 'sale');
    assert.equal(archivedVat.active, false);

    const mutedVatRow = allFind(find(ctx.host, (n) => n.tagName === 'TBODY'), (n) => n.tagName === 'TR')
      .find((tr) => tr.childNodes[2]?.textContent?.trim() === 'VAT 14%' && tr.childNodes[4]?.textContent?.trim() === 'Sales');
    assert.ok(mutedVatRow && hasClass(mutedVatRow, 'muted'), 'inactive tax stays visible and row has muted class');

    // Toggle back on restores active: true and removes muted class
    const mutedSwitch = find(mutedVatRow, (n) => n.tagName === 'INPUT' && props(n)?.role === 'switch');
    await ctx.React.act(async () => {
      props(mutedSwitch).onChange({ target: { checked: true } });
    });
    const unarchivedVat = search(ctx.getDb(), 'account.tax', { includeArchived: true }).find((t) => t.id === archivedVat.id);
    assert.equal(unarchivedVat.active, true);
    const activeVatRow = allFind(find(ctx.host, (n) => n.tagName === 'TBODY'), (n) => n.tagName === 'TR')
      .find((tr) => tr.childNodes[2]?.textContent?.trim() === 'VAT 14%' && tr.childNodes[4]?.textContent?.trim() === 'Sales');
    assert.equal(hasClass(activeVatRow, 'muted'), false);
  } finally {
    await ctx.done();
  }
});

test('taxes action defaults to Sale + Purchase filters with active and inactive taxes visible together', async () => {
  const { ActionView } = await import('./views/ActionView.jsx');
  const leaf = taxesLeaf();
  assert.deepEqual(leaf.defaultFilters, ['sale', 'purchase']);
  assert.equal(leaf.includeArchived, true);

  let db = seed();
  db = create(db, 'account.tax', { name: 'Archived Sale Tax', type_tax_use: 'sale', amount: 8, active: false }).db;
  db = create(db, 'account.tax', { name: 'None Tax Active', type_tax_use: 'none', amount: 0, active: true }).db;
  db = create(db, 'account.tax', { name: 'None Tax Inactive', type_tax_use: 'none', amount: 0, active: false }).db;

  const ctx = await mountView(
    (React) => React.createElement(ActionView, { leaf, base: '#/accounting/taxes', params: new URLSearchParams('view=list') }),
    db,
  );
  try {
    // Default view shows active & inactive Sale/Purchase taxes, excluding type_tax_use='none'
    assert.ok(ctx.host.textContent.includes('VAT 14%'));
    assert.ok(ctx.host.textContent.includes('Archived Sale Tax'), 'inactive sale tax visible by default');
    assert.ok(!ctx.host.textContent.includes('None Tax Active'), 'Sale+Purchase default excludes none taxes');
    assert.ok(!ctx.host.textContent.includes('None Tax Inactive'), 'Sale+Purchase default excludes inactive none taxes');

    const archivedRow = allFind(find(ctx.host, (n) => n.tagName === 'TBODY'), (n) => n.tagName === 'TR')
      .find((tr) => tr.textContent.includes('Archived Sale Tax'));
    assert.ok(archivedRow && hasClass(archivedRow, 'muted'));

    // Removing the default Sale or Purchase facet reveals both active and inactive 'none' taxes
    const removeDefault = find(ctx.host, (n) => n.tagName === 'BUTTON' && props(n)?.['aria-label']?.includes('Sale or Purchase'));
    assert.ok(removeDefault, 'facet chip shows Sale or Purchase');
    await ctx.React.act(async () => { props(removeDefault).onClick(); });
    assert.ok(ctx.host.textContent.includes('None Tax Active'));
    assert.ok(ctx.host.textContent.includes('None Tax Inactive'));
  } finally {
    await ctx.done();
  }
});

test('taxes search fields, filter groups, and group-by options match Odoo 20', async () => {
  const def = models['account.tax'];
  assert.deepEqual(def.searchFields, ['name', 'description', 'amount', 'company_id', 'fiscal_position_ids']);
  assert.deepEqual(def.groupBys, ['company_id', 'type_tax_use', 'tax_scope', 'fiscal_position_ids']);
  assert.equal(def.groupBys.includes('tax_group_id'), false, 'extra Tax Group group-by dropped');

  let db = seed();
  const exportFp = search(db, 'account.fiscal.position').find((f) => f.name === 'Export');
  const tGoods = create(db, 'account.tax', {
    name: 'Goods Levy', description: 'Customs levy', amount: 7.5, type_tax_use: 'purchase', tax_scope: 'consu', active: true,
  });
  db = tGoods.db;
  const tSvc = create(db, 'account.tax', {
    name: 'Service Fee', description: 'Consulting tax', amount: 12, type_tax_use: 'sale', tax_scope: 'service', active: false,
  });
  db = tSvc.db;

  const allTaxes = search(db, 'account.tax', { includeArchived: true });
  const exportTax = allTaxes.find((t) => t.name === '0% Exports');

  // Search fields: Name, Description, Amount, Fiscal Position, and Company (multi-company only)
  assert.deepEqual(allTaxes.filter((r) => matches(db, 'account.tax', r, ['Goods Levy'])).map((r) => r.id), [tGoods.id]);
  assert.deepEqual(allTaxes.filter((r) => matches(db, 'account.tax', r, ['Consulting tax'])).map((r) => r.id), [tSvc.id]);
  assert.deepEqual(allTaxes.filter((r) => matches(db, 'account.tax', r, ['7.50'])).map((r) => r.id), [tGoods.id]);
  assert.ok(allTaxes.filter((r) => matches(db, 'account.tax', r, [exportFp.name])).some((r) => r.id === exportTax.id));
  assert.equal(allTaxes.filter((r) => matches(db, 'account.tax', r, ['Mizan Demo Co'])).length, 0, 'Company not searched in single-company mode');

  // Filters: each OR group and cross-group AND
  assert.ok(applyFilters('account.tax', allTaxes, ['sale'], db).every((r) => r.type_tax_use === 'sale'));
  assert.ok(applyFilters('account.tax', allTaxes, ['purchase'], db).every((r) => r.type_tax_use === 'purchase'));
  assert.equal(applyFilters('account.tax', allTaxes, ['sale', 'purchase'], db).filter((r) => [tGoods.id, tSvc.id].includes(r.id)).length, 2);
  assert.deepEqual(applyFilters('account.tax', allTaxes, ['services'], db).map((r) => r.id), [tSvc.id]);
  assert.deepEqual(applyFilters('account.tax', allTaxes, ['goods'], db).map((r) => r.id), [tGoods.id]);
  assert.deepEqual(applyFilters('account.tax', allTaxes, ['services', 'goods'], db).map((r) => r.id), [tGoods.id, tSvc.id]);
  assert.equal(applyFilters('account.tax', allTaxes, ['active'], db).some((r) => r.id === tSvc.id), false);
  assert.deepEqual(applyFilters('account.tax', allTaxes, ['inactive'], db).map((r) => r.id), [tSvc.id]);
  assert.equal(applyFilters('account.tax', allTaxes, ['active', 'inactive'], db).length, allTaxes.length);
  assert.deepEqual(applyFilters('account.tax', allTaxes, ['sale', 'goods'], db), []);

  // Multi-company unlocks Company search and Group by Company in SearchPanel
  const branch = createCompany(db, { name: 'Delta Branch' });
  db = setCompanies(branch.db, { current: 1, allowed: [1, branch.id] });
  const branchTax = create(db, 'account.tax', { name: 'Branch VAT', type_tax_use: 'sale', amount: 15, company_id: branch.id });
  db = branchTax.db;
  const multiTaxes = search(db, 'account.tax', { includeArchived: true });
  assert.deepEqual(multiTaxes.filter((r) => matches(db, 'account.tax', r, ['Delta Branch'])).map((r) => r.id), [branchTax.id]);

  // Group-by buckets work for every configured groupBys field
  assert.ok(groupRecords(db, 'account.tax', multiTaxes, 'company_id').some((g) => g.label === 'Delta Branch'));
  assert.ok(groupRecords(db, 'account.tax', multiTaxes, 'type_tax_use').some((g) => g.key === 'sale' && g.records.length > 0));
  assert.ok(groupRecords(db, 'account.tax', multiTaxes, 'tax_scope').some((g) => g.key === 'consu' && g.records.length > 0));
  assert.ok(groupRecords(db, 'account.tax', multiTaxes, 'fiscal_position_ids').some((g) => g.label === 'Export'));

  const { ActionView } = await import('./views/ActionView.jsx');
  const leaf = taxesLeaf();

  // Single-company SearchPanel hides Company group-by
  const singleCtx = await mountView(
    (React) => React.createElement(ActionView, { leaf, base: '#/accounting/taxes', params: new URLSearchParams('view=list') }),
    seed(),
  );
  try {
    const toggle = find(singleCtx.host, (n) => n.tagName === 'BUTTON' && props(n)?.['aria-label'] === 'Toggle search panel');
    await singleCtx.React.act(async () => { props(toggle).onClick(); });
    const panel = find(singleCtx.host, (n) => hasClass(n, 'search-panel'));
    const sections = allFind(panel, (n) => n.tagName === 'SECTION');
    const filterButtons = allFind(sections[0], (n) => n.tagName === 'BUTTON').map((b) => b.textContent.trim());
    assert.deepEqual(filterButtons, ['Sale', 'Purchase', 'Services', 'Goods', 'Active', 'Inactive', 'Archived']);
    const groupButtons = allFind(sections[1], (n) => n.tagName === 'BUTTON').map((b) => b.textContent.trim());
    assert.deepEqual(groupButtons, ['Tax Type', 'Tax Scope', 'Fiscal Position']);
  } finally {
    await singleCtx.done();
  }

  // Multi-company SearchPanel shows Company group-by first
  const multiCtx = await mountView(
    (React) => React.createElement(ActionView, { leaf, base: '#/accounting/taxes', params: new URLSearchParams('view=list') }),
    db,
  );
  try {
    const toggle = find(multiCtx.host, (n) => n.tagName === 'BUTTON' && props(n)?.['aria-label'] === 'Toggle search panel');
    await multiCtx.React.act(async () => { props(toggle).onClick(); });
    const panel = find(multiCtx.host, (n) => hasClass(n, 'search-panel'));
    const sections = allFind(panel, (n) => n.tagName === 'SECTION');
    const groupButtons = allFind(sections[1], (n) => n.tagName === 'BUTTON').map((b) => b.textContent.trim());
    assert.deepEqual(groupButtons, ['Company', 'Tax Type', 'Tax Scope', 'Fiscal Position']);
  } finally {
    await multiCtx.done();
  }
});

test('fiscal positions opens in list view with Odoo 20 columns, search, Archived, and shared Domestic predicate', async () => {
  const def = models['account.fiscal.position'];
  const leaf = fiscalPositionsLeaf();
  assert.equal(viewsOf('account.fiscal.position')[0], 'list');
  assert.equal(leaf.view, 'list');
  assert.deepEqual(def.list, ['sequence', 'name', 'company_id']);
  assert.equal(def.fields.sequence.widget, 'handle');
  assert.equal(def.fields.company_id.multiCompanyOnly, true);
  assert.deepEqual(def.searchFields, ['name']);

  let db = seed();
  // Domestic predicate uses record country vs company country, never inferring from record name
  assert.equal(isDomesticRecord(search(db, 'account.fiscal.position').find((f) => f.name === 'Domestic'), db), false, 'unset company country does not match');
  db = write(db, 'res.company', 1, { country: 'Egypt' });
  const fpForeign = create(db, 'account.fiscal.position', { name: 'GCC', country: 'UAE', active: true });
  db = fpForeign.db;
  const fpArchived = create(db, 'account.fiscal.position', { name: 'Old Regime', country: 'Egypt', active: false });
  db = fpArchived.db;

  const branch = createCompany(db, { name: 'UAE Branch', country: 'UAE' });
  db = setCompanies(branch.db, { current: 1, allowed: [1, branch.id] });
  const fpBranchDomestic = create(db, 'account.fiscal.position', { name: 'UAE Domestic', country: 'UAE', company_id: branch.id });
  db = fpBranchDomestic.db;

  // Domestic predicate checks record's company_id (fallback current company)
  assert.equal(isDomesticRecord(search(db, 'account.fiscal.position').find((f) => f.name === 'Domestic'), db), true);
  assert.equal(isDomesticRecord(read(db, 'account.fiscal.position', fpForeign.id), db), false);
  assert.equal(isDomesticRecord(read(db, 'account.fiscal.position', fpBranchDomestic.id), db), true);

  // Search only matches Fiscal Position (name), not country or note
  const visibleFps = search(db, 'account.fiscal.position');
  assert.deepEqual(visibleFps.filter((r) => matches(db, 'account.fiscal.position', r, ['Export'])).map((r) => r.name), ['Export']);
  assert.deepEqual(visibleFps.filter((r) => matches(db, 'account.fiscal.position', r, ['Egypt'])), []);

  const { ActionView } = await import('./views/ActionView.jsx');
  const ctx = await mountView(
    (React) => React.createElement(ActionView, { leaf, base: '#/accounting/fiscal-positions', params: new URLSearchParams() }),
    db,
  );
  try {
    const table = find(ctx.host, (n) => n.tagName === 'TABLE' && hasClass(n, 'list'));
    assert.ok(table, 'opens in list view without ?view=list');
    const handleTh = find(table, (n) => n.tagName === 'TH' && hasClass(n, 'handle-col'));
    assert.equal(props(handleTh)?.['aria-label'], 'Sequence');
    const headers = allFind(table, (n) => n.tagName === 'TH' && !hasClass(n, 'o2m-cols-th'))
      .map((th) => th.textContent.replace(/[▲▼]/g, '').trim())
      .filter(Boolean);
    assert.deepEqual(headers, ['Fiscal Position', 'Company']);

    // SearchPanel exposes Domestic and Archived filters
    const toggle = find(ctx.host, (n) => n.tagName === 'BUTTON' && props(n)?.['aria-label'] === 'Toggle search panel');
    await ctx.React.act(async () => { props(toggle).onClick(); });
    const panel = find(ctx.host, (n) => hasClass(n, 'search-panel'));
    const filterBtns = allFind(allFind(panel, (n) => n.tagName === 'SECTION')[0], (n) => n.tagName === 'BUTTON');
    assert.deepEqual(filterBtns.map((b) => b.textContent.trim()), ['Domestic', 'Archived']);

    // Clicking Domestic filters to domestic positions
    const tbodyText = () => find(ctx.host, (n) => n.tagName === 'TBODY').textContent;
    await ctx.React.act(async () => { props(filterBtns[0]).onClick(); });
    assert.ok(tbodyText().includes('Domestic'));
    assert.ok(tbodyText().includes('UAE Domestic'));
    assert.ok(!tbodyText().includes('Export'));

    // Uncheck Domestic, check Archived -> shows Old Regime
    await ctx.React.act(async () => { props(filterBtns[0]).onClick(); });
    await ctx.React.act(async () => { props(filterBtns[1]).onClick(); });
    assert.ok(tbodyText().includes('Old Regime'));
    assert.ok(!tbodyText().includes('Export'));
  } finally {
    await ctx.done();
  }
});

test('Arabic translations cover all tax and fiscal position list, filter, and group-by labels', async () => {
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem: () => {}, removeItem: () => {}, clear: () => {} };
  try {
    const { t } = await import('./i18n.js?lang=ar-taxes-parity');
    const labels = [
      'Sequence', 'Tax Name', 'Description', 'Tax Type', 'Replaces', 'Tax Scope',
      'Label on Invoices', 'Company', 'Active', 'Inactive',
      'Sale', 'Purchase', 'Services', 'Goods', 'Amount',
      'Fiscal Position', 'Fiscal Positions', 'Domestic', 'Archived',
    ];
    for (const label of labels) {
      assert.notEqual(t(label), label, `missing Arabic translation for "${label}"`);
    }
  } finally {
    globalThis.localStorage = prevStorage;
  }
});
