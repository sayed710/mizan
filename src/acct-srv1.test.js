import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom } from './test-support/dom.js';
import { create, search, write } from './orm.js';
import { seed } from './seed.js';
import { checkInalterability, secureEntries } from './models/hash_chain.js';
import { valuationReport } from './models/valuation.js';
import { postMove } from './models/accounting.js';
import { applyDiff, diffDb } from './sync.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const props = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];

function findAll(node, predicate) {
  const result = [];
  const walk = (n) => {
    if (!n) return;
    if (predicate(n)) result.push(n);
    for (const child of n.childNodes ?? []) walk(child);
  };
  walk(node);
  return result;
}

function find(node, predicate) {
  return findAll(node, predicate)[0] ?? null;
}

const rendered = async (React, container, text) => {
  for (let i = 0; i < 200 && !container.textContent.includes(text); i++) {
    await React.act(() => new Promise((resolve) => setTimeout(resolve, 50)));
  }
};

const server = (db, next) => applyDiff(db, diffDb(db, next), { isAdmin: true });

test('SRV-1: Review > Sales > Invoices To Be Issued / Invoiced Not Delivered filters, grouping, export, and domains', async () => {
  const { makeEl } = setupDom();
  let printCalled = false;
  globalThis.window = Object.assign(new EventTarget(), {
    scrollTo() {},
    HTMLIFrameElement: class {},
    print() { printCalled = true; },
  });
  document.createElementNS = (_namespace, tag) => document.createElement(tag);

  const downloadedBlobs = [];
  const origCreateObjectURL = URL.createObjectURL;
  const origRevokeObjectURL = URL.revokeObjectURL;
  URL.createObjectURL = (blob) => {
    downloadedBlobs.push(blob);
    return 'blob:test';
  };
  URL.revokeObjectURL = () => {};

  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();

  let db = seed();
  // Ensure second company exists
  const comp2Res = create(db, 'res.company', { name: 'Branch Delta', currency: 'USD' });
  db = comp2Res.db;
  const comp2Id = comp2Res.id;
  db = {
    ...db,
    settings: {
      ...db.settings,
      allowed_company_ids: [1, comp2Id],
    },
  };

  const partnerA = create(db, 'res.partner', { name: 'Customer Alpha' });
  db = partnerA.db;
  const partnerB = create(db, 'res.partner', { name: 'Customer Beta' });
  db = partnerB.db;
  const partnerC = create(db, 'res.partner', { name: 'Customer Gamma', company_id: comp2Id });
  db = partnerC.db;

  const product = create(db, 'product', { name: 'Test Widget', list_price: 100, type: 'goods' });
  db = product.db;

  // 1. Confirmed Order 1 in Company 1, in 2026:
  //    Line 1: 5 delivered, 2 invoiced -> to issue = 3 ($300)
  //    Line 2: 1 delivered, 4 invoiced -> invoiced not delivered = 3 ($300)
  //    Line 3: down payment line -> excluded
  const order1 = create(db, 'sale.order', {
    name: 'SO-SRV-01',
    partner_id: partnerA.id,
    company_id: 1,
    state: 'sale',
    date_order: '2026-06-15',
    order_line: [
      { product_id: product.id, name: 'Widget To Issue', qty: 5, qty_delivered: 5, qty_invoiced: 2, price_unit: 100, tax: 0 },
      { product_id: product.id, name: 'Widget Inv Not Del', qty: 4, qty_delivered: 1, qty_invoiced: 4, price_unit: 100, tax: 0 },
      { name: 'Down Payment', qty: 1, qty_delivered: 1, qty_invoiced: 0, price_unit: 100, down_payment_key: 'dp-srv1' },
    ],
  });
  db = order1.db;

  // 2. Confirmed Order 2 in Company 1, past year 2025:
  //    Line 1: 10 delivered, 4 invoiced -> to issue = 6
  const order2 = create(db, 'sale.order', {
    name: 'SO-SRV-02-PAST',
    partner_id: partnerB.id,
    company_id: 1,
    state: 'sale',
    date_order: '2025-03-10',
    order_line: [
      { product_id: product.id, name: 'Widget Past Year', qty: 10, qty_delivered: 10, qty_invoiced: 4, price_unit: 100, tax: 0 },
    ],
  });
  db = order2.db;

  // 3. Draft Quotation (state: 'draft'): must be excluded by Odoo domain!
  const orderDraft = create(db, 'sale.order', {
    name: 'SO-SRV-03-DRAFT',
    partner_id: partnerA.id,
    company_id: 1,
    state: 'draft',
    date_order: '2026-06-15',
    order_line: [
      { product_id: product.id, name: 'Widget Draft', qty: 5, qty_delivered: 5, qty_invoiced: 0, price_unit: 100, tax: 0 },
    ],
  });
  db = orderDraft.db;

  // 4. Cancelled Order (state: 'cancel'): must be excluded!
  const orderCancel = create(db, 'sale.order', {
    name: 'SO-SRV-04-CANCEL',
    partner_id: partnerA.id,
    company_id: 1,
    state: 'cancel',
    date_order: '2026-06-15',
    order_line: [
      { product_id: product.id, name: 'Widget Cancel', qty: 5, qty_delivered: 5, qty_invoiced: 0, price_unit: 100, tax: 0 },
    ],
  });
  db = orderCancel.db;

  // 5. Confirmed Order in Company 2:
  const orderComp2 = create(db, 'sale.order', {
    name: 'SO-SRV-05-COMP2',
    partner_id: partnerC.id,
    company_id: comp2Id,
    state: 'sale',
    date_order: '2026-07-20',
    order_line: [
      { product_id: product.id, name: 'Widget Delta', qty: 8, qty_delivered: 8, qty_invoiced: 3, price_unit: 100, tax: 0 },
    ],
  });
  db = orderComp2.db;

  await commit(db);

  const { SalesReview } = await import('./views/SalesReview.jsx');
  const host = makeEl('div');
  host.ownerDocument = document;
  const root = createRoot(host);

  try {
    // ----------------------------------------------------
    // Test A: Invoices To Be Issued
    // ----------------------------------------------------
    await React.act(async () => {
      root.render(React.createElement(SalesReview, { leaf: { report: 'invoicesToBeIssued', label: 'Invoices To Be Issued' } }));
    });
    await rendered(React, host, 'SO-SRV-01');

    // Confirmed order in 2026 appears
    assert.ok(host.textContent.includes('SO-SRV-01'), 'Confirmed order SO-SRV-01 appears');
    // Draft and Cancelled orders are excluded
    assert.ok(!host.textContent.includes('SO-SRV-03-DRAFT'), 'Draft order is excluded by sale.order.line domain');
    assert.ok(!host.textContent.includes('SO-SRV-04-CANCEL'), 'Cancelled order is excluded');
    // Down payment line is excluded
    assert.ok(!host.textContent.includes('Down Payment'), 'Down payment line is excluded');

    // 1. Period filter test:
    // Past year order SO-SRV-02-PAST is excluded in default 'This Year' (2026)
    assert.ok(!host.textContent.includes('SO-SRV-02-PAST'), 'Order from 2025 excluded under This Year period');

    // Select 'All Dates' period
    const periodSelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === 'Period');
    assert.ok(periodSelect, 'Period select exists');
    await React.act(async () => {
      props(periodSelect).onChange({ target: { value: 'all' } });
    });
    assert.ok(host.textContent.includes('SO-SRV-02-PAST'), 'Order from 2025 now appears under All Dates');

    // Select 'Custom Period'
    await React.act(async () => {
      props(periodSelect).onChange({ target: { value: 'custom' } });
    });
    const fromInput = find(host, (n) => n.tagName === 'INPUT' && props(n)?.['aria-label'] === 'From');
    const toInput = find(host, (n) => n.tagName === 'INPUT' && props(n)?.['aria-label'] === 'To');
    assert.ok(fromInput && toInput, 'Custom From and To date inputs exist');
    await React.act(async () => {
      props(fromInput).onChange({ target: { value: '2026-06-01' } });
      props(toInput).onChange({ target: { value: '2026-06-30' } });
    });
    assert.ok(host.textContent.includes('SO-SRV-01'), 'Order 1 is in range');
    assert.ok(!host.textContent.includes('SO-SRV-02-PAST'), 'Order 2 is out of range for custom period');
    assert.ok(!host.textContent.includes('SO-SRV-05-COMP2'), 'Order 5 (July) is out of range for June period');

    // 2. Company filter test:
    // Switch back to All Dates
    await React.act(async () => {
      props(periodSelect).onChange({ target: { value: 'all' } });
    });
    const companySelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === 'Company');
    assert.ok(companySelect, 'Company select exists');

    // Filter to Company 2 (Branch Delta)
    await React.act(async () => {
      props(companySelect).onChange({ target: { value: String(comp2Id) } });
    });
    assert.ok(host.textContent.includes('SO-SRV-05-COMP2'), 'Company 2 order is present');
    assert.ok(!host.textContent.includes('SO-SRV-01'), 'Company 1 order is excluded when Company 2 is selected');

    // Filter back to All Companies
    await React.act(async () => {
      props(companySelect).onChange({ target: { value: 'all' } });
    });
    assert.ok(host.textContent.includes('SO-SRV-01'), 'Company 1 order present under all companies');
    assert.ok(host.textContent.includes('SO-SRV-05-COMP2'), 'Company 2 order present under all companies');

    // 3. Group By test:
    const groupBySelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === 'Group By');
    assert.ok(groupBySelect, 'Group By select exists');

    // Group by customer
    await React.act(async () => {
      props(groupBySelect).onChange({ target: { value: 'customer' } });
    });
    const groupRowsCust = findAll(host, (n) => n.tagName === 'TR' && n.className === 'group-row');
    assert.ok(groupRowsCust.length >= 2, 'Customer group rows rendered');
    assert.ok(host.textContent.includes('Customer Alpha'), 'Customer Alpha header shown');
    assert.ok(host.textContent.includes('Customer Gamma'), 'Customer Gamma header shown');

    // Group by order
    await React.act(async () => {
      props(groupBySelect).onChange({ target: { value: 'order' } });
    });
    const groupRowsOrder = findAll(host, (n) => n.tagName === 'TR' && n.className === 'group-row');
    assert.ok(groupRowsOrder.length >= 2, 'Order group rows rendered');
    assert.ok(host.textContent.includes('SO-SRV-01'), 'SO-SRV-01 group header shown');

    // Reset Group By to None
    await React.act(async () => {
      props(groupBySelect).onChange({ target: { value: '' } });
    });

    // 4. Export & Print tests:
    const printBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent === 'Print');
    const csvBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent === 'Download CSV');
    const xlsxBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent === 'Export XLSX');
    assert.ok(printBtn, 'Print button exists');
    assert.ok(csvBtn, 'Download CSV button exists');
    assert.ok(xlsxBtn, 'Export XLSX button exists');

    // Test CSV click
    await React.act(async () => {
      props(csvBtn).onClick();
    });
    assert.ok(downloadedBlobs.length > 0, 'CSV download was triggered');

    // Test XLSX click
    const prevCount = downloadedBlobs.length;
    await React.act(async () => {
      props(xlsxBtn).onClick();
    });
    assert.ok(downloadedBlobs.length > prevCount, 'XLSX download was triggered');

    // Test Print click
    await React.act(async () => {
      props(printBtn).onClick();
    });
    assert.ok(printCalled, 'Print window.print was invoked');

    // ----------------------------------------------------
    // Test B: Invoiced Not Delivered
    // ----------------------------------------------------
    await React.act(async () => {
      root.render(React.createElement(SalesReview, { leaf: { report: 'invoicedNotDelivered', label: 'Invoiced Not Delivered' } }));
    });
    await rendered(React, host, 'Widget Inv Not Del');
    assert.ok(host.textContent.includes('Widget Inv Not Del'), 'Invoiced not delivered line appears');
    assert.ok(!host.textContent.includes('Widget To Issue'), 'Delivered not invoiced line does not appear');
  } finally {
    URL.createObjectURL = origCreateObjectURL;
    URL.revokeObjectURL = origRevokeObjectURL;
    await React.act(async () => root.unmount());
  }
});

test('SRV-2: Review > Inventory > Inventory Valuation period selector drives valuation date', async () => {
  const { makeEl } = setupDom();
  globalThis.window = Object.assign(new EventTarget(), { scrollTo() {}, HTMLIFrameElement: class {}, print() {} });
  document.createElementNS = (_namespace, tag) => document.createElement(tag);

  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();

  let db = seed();
  const prod = create(db, 'product', { name: 'Valuation Test Item', cost: 10, type: 'goods', qty_available: 15 });
  db = prod.db;

  // Add valuation layers at different dates:
  // Layer 1: 2025-03-01: 10 units @ $10 = $100
  const l1 = create(db, 'stock.valuation.layer', {
    product_id: prod.id,
    date: '2025-03-01',
    quantity: 10,
    unit_cost: 10,
    value: 100,
    remaining_qty: 10,
    remaining_value: 100,
    company_id: 1,
  });
  db = l1.db;

  // Layer 2: 2026-06-01: 5 units @ $20 = $100
  const l2 = create(db, 'stock.valuation.layer', {
    product_id: prod.id,
    date: '2026-06-01',
    quantity: 5,
    unit_cost: 20,
    value: 100,
    remaining_qty: 5,
    remaining_value: 100,
    company_id: 1,
  });
  db = l2.db;

  await commit(db);

  // Model test: valuationReport at cutoff dates
  const rep2025 = valuationReport(db, { at: '2025-12-31' })[prod.id];
  assert.equal(rep2025.qty, 10, 'Valuation report at 2025 includes only layer 1 qty');
  assert.equal(rep2025.value, 100, 'Valuation report at 2025 includes only layer 1 value');

  const rep2026 = valuationReport(db, { at: '2026-12-31' })[prod.id];
  assert.equal(rep2026.qty, 15, 'Valuation report at 2026 includes both layers');
  assert.equal(rep2026.value, 200, 'Valuation report at 2026 includes both layers total value');

  // View test: Reports view with inventory-valuation leaf
  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div');
  host.ownerDocument = document;
  const root = createRoot(host);

  try {
    await React.act(async () => {
      root.render(React.createElement(Reports, { leaf: { report: 'valuation', label: 'Inventory Valuation' } }));
    });
    await rendered(React, host, 'Valuation Test Item');

    // Period selector is present and drives valuation
    const periodSelect = find(host, (n) => n.tagName === 'SELECT' && (props(n)?.value === 'year' || props(n)?.value === 'month'));
    assert.ok(periodSelect, 'Period select is available on Inventory Valuation');

    // Set custom period to end at 2025-12-31
    await React.act(async () => {
      props(periodSelect).onChange({ target: { value: 'custom' } });
    });
    const toInput = find(host, (n) => n.tagName === 'INPUT' && props(n)?.type === 'date' && props(n)?.value !== '2026-01-01');
    assert.ok(toInput, 'Custom To date input exists');
    await React.act(async () => {
      props(toInput).onChange({ target: { value: '2025-12-31' } });
    });

    // After driving date to 2025-12-31, row reflects 10 units instead of 15
    const row = find(host, (n) => n.tagName === 'TR' && n.textContent.includes('Valuation Test Item'));
    assert.ok(row, 'Product row is visible');
    const cells = findAll(row, (n) => n.tagName === 'TD');
    // cells: [Product, On Hand, Unit Cost, Total Value]
    assert.equal(cells[1].textContent, '10', 'On Hand quantity driven by period selector is 10');
    assert.equal(cells[3].textContent, '$100.00', 'Total Value driven by period selector is $100.00');

    // Guard test: diffDb + applyDiff refuses modifying stock valuation layers
    assert.throws(
      () => server(db, write(db, 'stock.valuation.layer', l1.id, { value: 999 })),
      /Stock valuation history cannot be changed/,
      'Guard verified via sync applyDiff',
    );
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('SRV-3: Data Inalterability Check exposes journal filter and checks individual journal', async () => {
  const { makeEl } = setupDom();
  globalThis.window = Object.assign(new EventTarget(), { scrollTo() {}, HTMLIFrameElement: class {}, print() {} });
  document.createElementNS = (_namespace, tag) => document.createElement(tag);

  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();

  let db = seed();
  const j1 = create(db, 'account.journal', { name: 'Customer Invoices Secure', code: 'JSEC1', restrict_mode_hash_table: true });
  db = j1.db;
  const j2 = create(db, 'account.journal', { name: 'Vendor Bills Secure', code: 'JSEC2', restrict_mode_hash_table: true });
  db = j2.db;

  const receivable = search(db, 'account.account').find((a) => a.code === '121000')?.id ?? 1;
  const revenue = search(db, 'account.account').find((a) => a.code === '400000')?.id ?? 2;
  const payable = search(db, 'account.account').find((a) => a.code === '211000')?.id ?? 3;
  const expense = search(db, 'account.account').find((a) => a.code === '600000')?.id ?? 4;

  // Move in J1
  const m1 = create(db, 'account.move', {
    move_type: 'entry',
    name: 'INV/2026/0001',
    journal_id: j1.id,
    date: '2026-11-01',
    line_ids: [
      { account_id: receivable, debit: 100, credit: 0 },
      { account_id: revenue, debit: 0, credit: 100 },
    ],
  });
  db = postMove(m1.db, m1.id);
  db = secureEntries(db, { throughMoveId: m1.id });

  // Move in J2
  const m2 = create(db, 'account.move', {
    move_type: 'entry',
    name: 'BILL/2026/0001',
    journal_id: j2.id,
    date: '2026-11-02',
    line_ids: [
      { account_id: expense, debit: 200, credit: 0 },
      { account_id: payable, debit: 0, credit: 200 },
    ],
  });
  db = postMove(m2.db, m2.id);
  db = secureEntries(db, { throughMoveId: m2.id });

  await commit(db);

  // Model verification of checkInalterability accepting journalId
  const allResults = checkInalterability(db);
  assert.ok(allResults.some((r) => r.journal_id === j1.id), 'J1 in all results');
  assert.ok(allResults.some((r) => r.journal_id === j2.id), 'J2 in all results');

  const j1Only = checkInalterability(db, { journalId: j1.id });
  assert.equal(j1Only.length, 1, 'Only 1 journal returned');
  assert.equal(j1Only[0].journal_id, j1.id, 'J1 returned');

  const j2Only = checkInalterability(db, { journalId: j2.id });
  assert.equal(j2Only.length, 1, 'Only 1 journal returned');
  assert.equal(j2Only[0].journal_id, j2.id, 'J2 returned');

  // UI verification: Reports view with inalterability leaf
  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div');
  host.ownerDocument = document;
  const root = createRoot(host);

  try {
    await React.act(async () => {
      root.render(React.createElement(Reports, { leaf: { report: 'inalterability', label: 'Data Inalterability Check' } }));
    });
    await rendered(React, host, 'JSEC1');

    const table = find(host, (n) => n.tagName === 'TABLE');
    assert.ok(table, 'Report table exists');

    // Both journals displayed initially in table
    assert.ok(table.textContent.includes('JSEC1'), 'JSEC1 shown initially in table');
    assert.ok(table.textContent.includes('JSEC2'), 'JSEC2 shown initially in table');

    // Journal filter select exists
    const journalSelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === 'Journal');
    assert.ok(journalSelect, 'Journal filter select exists in Data Inalterability Check controls');

    // Filter to J1
    await React.act(async () => {
      props(journalSelect).onChange({ target: { value: String(j1.id) } });
    });
    assert.ok(table.textContent.includes('JSEC1'), 'JSEC1 shown in table when filtered');
    assert.ok(!table.textContent.includes('JSEC2'), 'JSEC2 hidden in table when filtered to J1');

    // Filter to J2
    await React.act(async () => {
      props(journalSelect).onChange({ target: { value: String(j2.id) } });
    });
    assert.ok(!table.textContent.includes('JSEC1'), 'JSEC1 hidden in table when filtered to J2');
    assert.ok(table.textContent.includes('JSEC2'), 'JSEC2 shown in table when filtered to J2');

    // Guard verification via diffDb + applyDiff: cannot tamper with secured entry hash
    assert.throws(
      () => server(db, write(db, 'account.move', m1.id, { inalterable_hash: 'corrupted-hash' })),
      /Secured entries cannot be modified/,
      'Tampering with secured entry is refused by sync applyDiff',
    );
  } finally {
    await React.act(async () => root.unmount());
  }
});
