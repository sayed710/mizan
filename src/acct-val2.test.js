import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { create, read } from './orm.js';
import { seed } from './seed.js';
import { today } from './models/common.js';
import { valuationReport } from './models/valuation.js';
import { createCompany, setCompanies } from './models/company.js';
import { setupDom, find } from './test-support/dom.js';
import { fromCsv } from './csv.js';
import { readXlsx } from './xlsx.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const props = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];
const textOf = (node) => (node.nodeType === 3 ? node.nodeValue : (node.childNodes ?? []).map(textOf).join(''));

function setupDownloadSpy(makeEl) {
  const downloads = [];
  const origCreateElement = globalThis.document.createElement;
  const origCreateElementNS = globalThis.document.createElementNS;
  const origCreateUrl = URL.createObjectURL;
  const origRevokeUrl = URL.revokeObjectURL;

  globalThis.document.createElementNS = (_ns, tag) => makeEl(tag);
  globalThis.document.createElement = (tag) => {
    const el = makeEl(tag);
    const origSetAttr = el.setAttribute;
    el.setAttribute = (name, value) => {
      origSetAttr(name, value);
      if (name === 'colspan' || name === 'colSpan') el.colSpan = Number(value);
      if (name === 'rowspan' || name === 'rowSpan') el.rowSpan = Number(value);
    };
    el.click = () => {
      if (tag.toLowerCase() === 'a') {
        downloads.push({ filename: el.download, blob: el._blob ?? downloads.at(-1)?.blob });
      }
    };
    return el;
  };
  URL.createObjectURL = (blob) => {
    downloads.push({ filename: null, blob });
    return 'blob:test';
  };
  URL.revokeObjectURL = () => {};

  const takeLast = async () => {
    const entry = downloads.pop();
    if (!entry?.blob) return null;
    const buf = new Uint8Array(await entry.blob.arrayBuffer());
    return {
      filename: entry.filename,
      type: entry.blob.type,
      bytes: buf,
      text: async () => entry.blob.text(),
    };
  };

  const restore = () => {
    globalThis.document.createElement = origCreateElement;
    globalThis.document.createElementNS = origCreateElementNS;
    URL.createObjectURL = origCreateUrl;
    URL.revokeObjectURL = origRevokeUrl;
  };

  return { takeLast, restore };
}

test('VAL-1 filter: as-of date values stock from valuation layers up to that date, narrows rows, and totals follow', async () => {
  let db = seed();
  const prod = create(db, 'product', { name: 'AsOf Widget', type: 'goods', cost: 20, qty_available: 0 });
  db = prod.db;
  db.records['stock.valuation.layer'] = [
    { id: 9101, product_id: prod.id, company_id: 1, date: '2026-01-10', quantity: 10, unit_cost: 20, value: 200, kind: 'in' },
    { id: 9102, product_id: prod.id, company_id: 1, date: '2026-02-15', quantity: 5, unit_cost: 20, value: 100, kind: 'in' },
  ];

  // At 2026-01-31: only first layer is valued
  const repJan = valuationReport(db, { at: '2026-01-31', productId: prod.id });
  assert.equal(repJan[prod.id].qty, 10);
  assert.equal(repJan[prod.id].value, 200);

  // At 2026-02-28: both layers are valued
  const repFeb = valuationReport(db, { at: '2026-02-28', productId: prod.id });
  assert.equal(repFeb[prod.id].qty, 15);
  assert.equal(repFeb[prod.id].value, 300);

  // At 2025-12-31: no layers up to date, quantity is 0
  const repPast = valuationReport(db, { at: '2025-12-31', productId: prod.id });
  assert.equal(repPast[prod.id].qty, 0);
  assert.equal(repPast[prod.id].value, 0);
});

test('VAL-1 filter: company filter narrows rows to products and layers belonging to that company and totals follow', async () => {
  let db = seed();
  const branch = createCompany(db, { name: 'Valuation Branch Co', currency_id: read(db, 'res.company', 1).currency_id });
  db = setCompanies(branch.db, { current: 1, allowed: [1, branch.id] });

  const p1 = create(db, 'product', { name: 'Company 1 Item', type: 'goods', cost: 10, company_id: 1, qty_available: 0 });
  db = p1.db;
  const p2 = create(db, 'product', { name: 'Company 2 Item', type: 'goods', cost: 50, company_id: branch.id, qty_available: 0 });
  db = p2.db;

  db.records['stock.valuation.layer'] = [
    { id: 9201, product_id: p1.id, company_id: 1, date: '2026-01-10', quantity: 4, unit_cost: 10, value: 40, kind: 'in' },
    { id: 9202, product_id: p2.id, company_id: branch.id, date: '2026-01-10', quantity: 2, unit_cost: 50, value: 100, kind: 'in' },
  ];

  // Scoped to company 1: only p1 returned
  const repCo1 = valuationReport(db, { companyId: 1, at: '2026-01-31' });
  assert.ok(repCo1[p1.id], 'Company 1 product is present');
  assert.equal(repCo1[p1.id].qty, 4);
  assert.equal(repCo1[p1.id].value, 40);
  assert.equal(repCo1[p2.id], undefined, 'Company 2 product is excluded');

  // Scoped to branch: only p2 returned
  const repCo2 = valuationReport(db, { companyId: branch.id, at: '2026-01-31' });
  assert.ok(repCo2[p2.id], 'Branch product is present');
  assert.equal(repCo2[p2.id].qty, 2);
  assert.equal(repCo2[p2.id].value, 100);
  assert.equal(repCo2[p1.id], undefined, 'Company 1 product is excluded');

  // companyId: null defaults to current company (1), not all companies
  const repNull = valuationReport(db, { companyId: null, at: '2026-01-31' });
  assert.ok(repNull[p1.id], 'Current company product is present when companyId is null');
  assert.equal(repNull[p2.id], undefined, 'companyId: null does not act as all companies');
});

test('VAL-1 filter: companyId "all" sums stock across two companies including unlayered quants and legacy stock', async () => {
  let db = seed();
  const branch = createCompany(db, { name: 'Second Valuation Co', currency_id: read(db, 'res.company', 1).currency_id });
  db = setCompanies(branch.db, { current: 1, allowed: [1, branch.id] });

  // Shared product without valuation layers, holding quants in two companies
  const shared = create(db, 'product', { name: 'Shared Multi-Co Item', type: 'goods', cost: 15, qty_available: 0 });
  db = shared.db;
  const loc1 = create(db, 'stock.location', { name: 'Co1 Stock', usage: 'internal', company_id: 1 });
  db = loc1.db;
  const loc2 = create(db, 'stock.location', { name: 'Co2 Stock', usage: 'internal', company_id: branch.id });
  db = loc2.db;

  db.records['stock.quant'] = [
    ...(db.records['stock.quant'] ?? []),
    { id: 9251, product_id: shared.id, location_id: loc1.id, company_id: 1, quantity: 4 },
    { id: 9252, product_id: shared.id, location_id: loc2.id, company_id: branch.id, quantity: 6 },
  ];

  // Unlocated legacy product belonging to company 2 (no quants, no layers)
  const legacyCo2 = create(db, 'product', { name: 'Co2 Legacy Item', type: 'goods', cost: 20, company_id: branch.id, qty_available: 5 });
  db = legacyCo2.db;

  const repAll = valuationReport(db, { companyId: 'all', at: today() });
  assert.deepEqual(repAll[shared.id], { qty: 10, value: 150, unitCost: 15 });
  assert.deepEqual(repAll[legacyCo2.id], { qty: 5, value: 100, unitCost: 20 });

  // Single-company scope sees only its own stock
  const repCo1 = valuationReport(db, { companyId: 1, at: today() });
  assert.deepEqual(repCo1[shared.id], { qty: 4, value: 60, unitCost: 15 });
  assert.equal(repCo1[legacyCo2.id], undefined);

  const repCo2 = valuationReport(db, { companyId: branch.id, at: today() });
  assert.deepEqual(repCo2[shared.id], { qty: 6, value: 90, unitCost: 15 });
  assert.deepEqual(repCo2[legacyCo2.id], { qty: 5, value: 100, unitCost: 20 });
});

test('VAL-1 filter: product category narrows rows to category and its subcategories, and totals follow', async () => {
  let db = seed();
  const rootCat = create(db, 'product.category', { name: 'Industrial Hardware' });
  db = rootCat.db;
  const childCat = create(db, 'product.category', { name: 'Fasteners', parent_id: rootCat.id });
  db = childCat.db;
  const otherCat = create(db, 'product.category', { name: 'Office Supplies' });
  db = otherCat.db;

  const pRoot = create(db, 'product', { name: 'Heavy Machine', type: 'goods', categ_id: rootCat.id, cost: 500 });
  db = pRoot.db;
  const pChild = create(db, 'product', { name: 'Steel Bolt', type: 'goods', categ_id: childCat.id, cost: 2 });
  db = pChild.db;
  const pOther = create(db, 'product', { name: 'Printer Paper', type: 'goods', categ_id: otherCat.id, cost: 5 });
  db = pOther.db;
  const pNameOnly = create(db, 'product', { name: 'Name Text Only', type: 'goods', categ: 'Industrial Hardware', categ_id: otherCat.id, cost: 8 });
  db = pNameOnly.db;

  db.records['stock.valuation.layer'] = [
    { id: 9301, product_id: pRoot.id, company_id: 1, date: '2026-01-01', quantity: 2, unit_cost: 500, value: 1000 },
    { id: 9302, product_id: pChild.id, company_id: 1, date: '2026-01-01', quantity: 100, unit_cost: 2, value: 200 },
    { id: 9303, product_id: pOther.id, company_id: 1, date: '2026-01-01', quantity: 10, unit_cost: 5, value: 50 },
    { id: 9304, product_id: pNameOnly.id, company_id: 1, date: '2026-01-01', quantity: 3, unit_cost: 8, value: 24 },
  ];

  // Filtering by root category includes rootCat and childCat items, excludes otherCat and name-only text matches
  const repRoot = valuationReport(db, { categoryId: rootCat.id, at: '2026-01-31' });
  assert.ok(repRoot[pRoot.id], 'Root category product is included');
  assert.ok(repRoot[pChild.id], 'Child category product is included');
  assert.equal(repRoot[pOther.id], undefined, 'Unrelated category product is excluded');
  assert.equal(repRoot[pNameOnly.id], undefined, 'Product matching only by categ text is excluded');

  // Filtering by child category includes only childCat item
  const repChild = valuationReport(db, { categoryId: childCat.id, at: '2026-01-31' });
  assert.equal(repChild[pRoot.id], undefined, 'Parent category product is excluded');
  assert.ok(repChild[pChild.id], 'Child category product is included');
  assert.equal(repChild[pOther.id], undefined, 'Unrelated category product is excluded');
});

test('VAL-1 filter: product filter narrows rows to the selected product and totals follow', async () => {
  let db = seed();
  const pA = create(db, 'product', { name: 'Product Alpha', type: 'goods', cost: 15 });
  db = pA.db;
  const pB = create(db, 'product', { name: 'Product Beta', type: 'goods', cost: 30 });
  db = pB.db;

  db.records['stock.valuation.layer'] = [
    { id: 9401, product_id: pA.id, company_id: 1, date: '2026-01-01', quantity: 10, unit_cost: 15, value: 150 },
    { id: 9402, product_id: pB.id, company_id: 1, date: '2026-01-01', quantity: 5, unit_cost: 30, value: 150 },
  ];

  const repA = valuationReport(db, { productId: pA.id, at: '2026-01-31' });
  assert.ok(repA[pA.id], 'Product Alpha is returned');
  assert.equal(repA[pB.id], undefined, 'Product Beta is excluded');
  assert.equal(repA[pA.id].value, 150);
});

test('VAL-1 filter: warehouse and location filters use quant quantities in allowed internal locations and company layer unit cost at date', async () => {
  let db = seed();
  const locView1 = create(db, 'stock.location', { name: 'WH1', usage: 'view', company_id: 1 });
  db = locView1.db;
  const locStock1 = create(db, 'stock.location', { name: 'WH1/Stock', parent_id: locView1.id, usage: 'internal', company_id: 1 });
  db = locStock1.db;
  const locShelf1 = create(db, 'stock.location', { name: 'WH1/Stock/Shelf 1', parent_id: locStock1.id, usage: 'internal', company_id: 1 });
  db = locShelf1.db;
  const wh1 = create(db, 'stock.warehouse', { name: 'Warehouse North', code: 'WHN', lot_stock_id: locStock1.id, company_id: 1 });
  db = wh1.db;

  const locStock2 = create(db, 'stock.location', { name: 'WH2/Stock', usage: 'internal', company_id: 1 });
  db = locStock2.db;
  const wh2 = create(db, 'stock.warehouse', { name: 'Warehouse South', code: 'WHS', lot_stock_id: locStock2.id, company_id: 1 });
  db = wh2.db;

  const locInv = create(db, 'stock.location', { name: 'WH1/Virtual Inv', parent_id: locView1.id, usage: 'inventory', company_id: 1 });
  db = locInv.db;

  // Split-warehouse product: 4 units in WH1 (2 in Stock + 2 in Shelf 1) and 6 units in WH2; company layers total 10 units = 250
  const pSplit = create(db, 'product', { name: 'Split Cargo', type: 'goods', cost: 25 });
  db = pSplit.db;
  // Product with no quant in WH1, despite done picking, layer metadata, direct product fields, non-internal quant, and zero quant
  const pHeuristicOnly = create(db, 'product', { name: 'Heuristic Only Cargo', type: 'goods', cost: 50, warehouse_id: wh1.id, location_id: locStock1.id });
  db = pHeuristicOnly.db;

  const pickDone = create(db, 'stock.picking', {
    state: 'done',
    warehouse_id: wh1.id,
    location_dest_id: locStock1.id,
    company_id: 1,
    move_ids: [{ product_id: pHeuristicOnly.id, qty: 3 }],
  });
  db = pickDone.db;

  db.records['stock.quant'] = [
    { id: 9501, product_id: pSplit.id, location_id: locStock1.id, company_id: 1, quantity: 2 },
    { id: 9502, product_id: pSplit.id, location_id: locShelf1.id, company_id: 1, quantity: 2 },
    { id: 9503, product_id: pSplit.id, location_id: locStock2.id, company_id: 1, quantity: 6 },
    // Non-internal locations under WH1 must not be counted
    { id: 9504, product_id: pSplit.id, location_id: locView1.id, company_id: 1, quantity: 99 },
    { id: 9505, product_id: pSplit.id, location_id: locInv.id, company_id: 1, quantity: 88 },
    // Zero quant in WH1 must not list product
    { id: 9506, product_id: pHeuristicOnly.id, location_id: locStock1.id, company_id: 1, quantity: 0 },
  ];
  db.records['stock.valuation.layer'] = [
    { id: 9511, product_id: pSplit.id, company_id: 1, date: '2026-01-01', quantity: 5, unit_cost: 20, value: 100 },
    { id: 9512, product_id: pSplit.id, company_id: 1, date: '2026-01-15', quantity: 5, unit_cost: 30, value: 150 },
    { id: 9513, product_id: pHeuristicOnly.id, company_id: 1, date: '2026-01-01', quantity: 3, unit_cost: 50, value: 150, warehouse_id: wh1.id, location_id: locStock1.id, picking_id: pickDone.id },
  ];

  // At 2026-01-31: company unit cost = 250 / 10 = 25; WH1 has 4 units -> 100, WH2 has 6 units -> 150
  const repNorth = valuationReport(db, { warehouseId: wh1.id, at: '2026-01-31' });
  assert.deepEqual(repNorth[pSplit.id], { qty: 4, value: 100, unitCost: 25 });
  assert.equal(repNorth[pHeuristicOnly.id], undefined, 'Product without internal quant quantity in WH1 is excluded');

  const repSouth = valuationReport(db, { warehouseId: wh2.id, at: '2026-01-31' });
  assert.deepEqual(repSouth[pSplit.id], { qty: 6, value: 150, unitCost: 25 });
  assert.equal(repSouth[pHeuristicOnly.id], undefined);

  // At 2026-01-10: only the first layer (unit cost 20) exists at date
  const repNorthEarlier = valuationReport(db, { warehouseId: wh1.id, at: '2026-01-10' });
  assert.deepEqual(repNorthEarlier[pSplit.id], { qty: 4, value: 80, unitCost: 20 });

  // Warehouse + location intersection: matching child location includes only Shelf 1's 2 units
  const repWhAndShelf = valuationReport(db, { warehouseId: wh1.id, locationId: locShelf1.id, at: '2026-01-31' });
  assert.deepEqual(repWhAndShelf[pSplit.id], { qty: 2, value: 50, unitCost: 25 });

  // Warehouse + location intersection: disjoint location (locStock2 is not in WH1) yields empty
  const repWh1Loc2 = valuationReport(db, { warehouseId: wh1.id, locationId: locStock2.id, at: '2026-01-31' });
  assert.equal(repWh1Loc2[pSplit.id], undefined);

  // View location filter includes only its internal descendants (not the view/inventory quants)
  const repViewLoc = valuationReport(db, { locationId: locView1.id, at: '2026-01-31' });
  assert.deepEqual(repViewLoc[pSplit.id], { qty: 4, value: 100, unitCost: 25 });
});

test('VAL-1 filter: location filter narrows rows to products in that location and its child locations, and totals follow', async () => {
  let db = seed();
  const locZoneA = create(db, 'stock.location', { name: 'Zone A', usage: 'internal', company_id: 1 });
  db = locZoneA.db;
  const locShelfA = create(db, 'stock.location', { name: 'Shelf A', parent_id: locZoneA.id, usage: 'internal', company_id: 1 });
  db = locShelfA.db;
  const locShelfB = create(db, 'stock.location', { name: 'Shelf B', usage: 'internal', company_id: 1 });
  db = locShelfB.db;

  const pA = create(db, 'product', { name: 'Shelf A Good', type: 'goods', cost: 12 });
  db = pA.db;
  const pB = create(db, 'product', { name: 'Shelf B Good', type: 'goods', cost: 24 });
  db = pB.db;

  db.records['stock.quant'] = [
    { id: 9601, product_id: pA.id, location_id: locShelfA.id, company_id: 1, quantity: 10 },
    { id: 9602, product_id: pB.id, location_id: locShelfB.id, company_id: 1, quantity: 8 },
  ];
  db.records['stock.valuation.layer'] = [
    { id: 9603, product_id: pA.id, company_id: 1, date: '2026-01-01', quantity: 10, unit_cost: 12, value: 120 },
    { id: 9604, product_id: pB.id, company_id: 1, date: '2026-01-01', quantity: 8, unit_cost: 24, value: 192 },
  ];

  const repZoneA = valuationReport(db, { locationId: locZoneA.id, at: '2026-01-31' });
  assert.ok(repZoneA[pA.id], 'Child location product is included under parent location');
  assert.equal(repZoneA[pB.id], undefined, 'Other location product is excluded');

  const repA = valuationReport(db, { locationId: locShelfA.id, at: '2026-01-31' });
  assert.ok(repA[pA.id], 'Shelf A product is included');
  assert.equal(repA[pB.id], undefined, 'Shelf B product is excluded');

  const repB = valuationReport(db, { locationId: locShelfB.id, at: '2026-01-31' });
  assert.ok(repB[pB.id], 'Shelf B product is included');
  assert.equal(repB[pA.id], undefined, 'Shelf A product is excluded');
});

test('VAL-2: Print, CSV, and XLSX exports use the same filtered rows and show active filters in the header', async () => {
  const { makeEl } = setupDom();
  const spy = setupDownloadSpy(makeEl);
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const store = await import('./store.js');
  await store.initStore();

  let db = seed();
  const catFilter = create(db, 'product.category', { name: 'Filtered Electronics' });
  db = catFilter.db;
  const otherCat = create(db, 'product.category', { name: 'Filtered Furniture' });
  db = otherCat.db;

  const pTarget = create(db, 'product', { name: 'Filtered Smartphone', default_code: 'PHN-01', type: 'goods', cost: 100, categ_id: catFilter.id });
  db = pTarget.db;
  const pOther = create(db, 'product', { name: 'Filtered Desk', default_code: 'DSK-01', type: 'goods', cost: 250, categ_id: otherCat.id });
  db = pOther.db;

  db.records['stock.valuation.layer'] = [
    { id: 9701, product_id: pTarget.id, company_id: 1, date: '2026-01-15', quantity: 3, unit_cost: 100, value: 300 },
    { id: 9702, product_id: pOther.id, company_id: 1, date: '2026-01-15', quantity: 2, unit_cost: 250, value: 500 },
  ];
  await React.act(async () => store.commit(db));

  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'valuation' } })));

    // Verify filter UI controls exist
    const catSelect = find(host, (n) => props(n)?.['aria-label'] === 'Product Category');
    assert.ok(catSelect, 'Product Category filter select exists');
    const prodSelect = find(host, (n) => props(n)?.['aria-label'] === 'Product');
    assert.ok(prodSelect && prodSelect.tagName === 'SELECT', 'Product filter select exists');
    const whSelect = find(host, (n) => props(n)?.['aria-label'] === 'Warehouse');
    assert.ok(whSelect, 'Warehouse filter select exists');
    const locSelect = find(host, (n) => props(n)?.['aria-label'] === 'Location');
    assert.ok(locSelect, 'Location filter select exists');
    const asOfInput = find(host, (n) => props(n)?.['aria-label'] === 'As of');
    assert.ok(asOfInput, 'As of date input exists');

    // Filter by Product: Filtered Smartphone
    await React.act(async () => props(prodSelect).onChange({ target: { value: String(pTarget.id) } }));
    const prodFilteredTableText = textOf(find(host, (n) => n.tagName === 'TABLE'));
    assert.ok(prodFilteredTableText.includes('[PHN-01] Filtered Smartphone'), 'Active product filter is shown in header and table');
    assert.ok(!prodFilteredTableText.includes('Filtered Desk'), 'Excluded product is not shown when product filter is active');
    await React.act(async () => props(prodSelect).onChange({ target: { value: '' } }));

    // Filter by Category: Filtered Electronics
    await React.act(async () => props(catSelect).onChange({ target: { value: String(catFilter.id) } }));

    // 1. Web view / print header reflects active filters
    const table = find(host, (n) => n.tagName === 'TABLE');
    assert.ok(table, 'Report table exists');
    const textContent = textOf(table);
    assert.ok(textContent.includes('Filtered Electronics'), 'Active filter name is shown in table filter header');
    assert.ok(textContent.includes('Filtered Smartphone'), 'Filtered product is shown');
    assert.ok(!textContent.includes('Filtered Desk'), 'Excluded product is not shown');

    // 2. CSV Export
    const csvBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes('CSV'));
    assert.ok(csvBtn, 'Download CSV button exists');
    await React.act(async () => props(csvBtn).onClick());
    const csvExport = await spy.takeLast();
    assert.ok(csvExport, 'CSV export was triggered');
    const csvText = await csvExport.text();
    const csvRows = fromCsv(csvText);
    assert.ok(csvRows[0].some((c) => c.includes('Filtered Electronics')), 'CSV header contains active category filter');
    assert.ok(csvText.includes('Filtered Smartphone'), 'CSV contains filtered product row');
    assert.ok(!csvText.includes('Filtered Desk'), 'CSV excludes unselected category product');
    assert.ok(csvText.includes('300'), 'CSV total matches filtered rows');

    // 3. XLSX Export
    const xlsxBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes('XLSX'));
    assert.ok(xlsxBtn, 'Export XLSX button exists');
    await React.act(async () => props(xlsxBtn).onClick());
    const xlsxExport = await spy.takeLast();
    assert.ok(xlsxExport, 'XLSX export was triggered');
    const xlsxParsed = readXlsx(xlsxExport.bytes);
    const firstRowText = xlsxParsed.rows[0].join(' ');
    assert.ok(firstRowText.includes('Filtered Electronics'), 'XLSX header contains active category filter');
    const allXlsxText = xlsxParsed.rows.map((r) => r.join(' ')).join('\n');
    assert.ok(allXlsxText.includes('Filtered Smartphone'), 'XLSX contains filtered product row');
    assert.ok(!allXlsxText.includes('Filtered Desk'), 'XLSX excludes unselected category product');

    // 4. Print layout verification
    const printBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes('Print'));
    assert.ok(printBtn, 'Print button exists');
    await React.act(async () => props(printBtn).onClick());
    const printText = textOf(host);
    assert.ok(printText.includes('Filtered Electronics'), 'Print view header shows active filters');
    assert.ok(printText.includes('Filtered Smartphone'), 'Print view displays filtered product');
    assert.ok(!printText.includes('Filtered Desk'), 'Print view excludes other category product');
  } finally {
    spy.restore();
    await React.act(async () => root.unmount());
  }
});
