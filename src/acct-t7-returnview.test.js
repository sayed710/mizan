import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { create, read } from './orm.js';
import { seed } from './seed.js';
import { accountId } from './models/ledger.js';
import { postMove } from './models/accounting.js';
import { taxSnapshot } from './models/taxes.js';
import { taxReturnBoxes } from './models/taxExport.js';
import { menusFor } from './models/index.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const props = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];
const textOf = (node) => (node.nodeType === 3 ? node.nodeValue : (node.childNodes ?? []).map(textOf).join(''));
const findAll = (node, predicate, out = []) => {
  if (!node) return out;
  if (predicate(node)) out.push(node);
  for (const child of node.childNodes ?? []) findAll(child, predicate, out);
  return out;
};

function setupReturnTestData(companyId = 1) {
  let db = seed();
  const vatOutAcc = accountId(db, '251000');
  const vatInAcc = accountId(db, '131000');

  const saleTax = create(db, 'account.tax', {
    name: `Goods VAT 14% C${companyId}`,
    amount: 14,
    amount_type: 'percent',
    type_tax_use: 'sale',
    tax_scope: 'consu',
    company_id: companyId,
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100 },
      { repartition_type: 'tax', factor_percent: 100, account_id: vatOutAcc },
    ],
    refund_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100 },
      { repartition_type: 'tax', factor_percent: 100, account_id: vatOutAcc },
    ],
  });
  db = saleTax.db;

  const purchTax = create(db, 'account.tax', {
    name: `Services VAT 10% C${companyId}`,
    amount: 10,
    amount_type: 'percent',
    type_tax_use: 'purchase',
    tax_scope: 'service',
    company_id: companyId,
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100 },
      { repartition_type: 'tax', factor_percent: 100, account_id: vatInAcc },
    ],
    refund_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100 },
      { repartition_type: 'tax', factor_percent: 100, account_id: vatInAcc },
    ],
  });
  db = purchTax.db;

  const yr = new Date().getFullYear();
  const inv = create(db, 'account.move', {
    name: 'INV/2026/0001',
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: `${yr}-05-10`,
    company_id: companyId,
    invoice_line_ids: [{ product_id: 5, qty: 10, price_unit: 100, ...taxSnapshot(read(db, 'account.tax', saleTax.id)) }],
  });
  db = postMove(inv.db, inv.id);

  const bill = create(db, 'account.move', {
    name: 'BILL/2026/0002',
    move_type: 'in_invoice',
    partner_id: 2,
    invoice_date: `${yr}-05-12`,
    company_id: companyId,
    invoice_line_ids: [{ product_id: 5, qty: 4, price_unit: 100, ...taxSnapshot(read(db, 'account.tax', purchTax.id)) }],
  });
  db = postMove(bill.db, bill.id);

  return { db, invId: inv.id, billId: bill.id, saleTaxId: saleTax.id, purchTaxId: purchTax.id };
}

test('TaxReportTable renders statutory template boxes and drill-down when returnRecord has eg_vat', async () => {
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { money } = await import('./ui.jsx');
  const { TaxReportTable } = await import('./views/Reports.jsx');
  await initStore();

  const { db } = setupReturnTestData(1);
  await React.act(async () => commit(db));

  const yr = new Date().getFullYear();
  const period = { from: `${yr}-01-01`, to: `${yr}-12-31`, company_id: 1 };
  const returnRecord = {
    id: 101,
    name: 'RET-2026-EG',
    company_id: 1,
    date_from: `${yr}-01-01`,
    date_to: `${yr}-12-31`,
    tax_return_template: 'eg_vat',
  };

  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    await React.act(async () => {
      root.render(React.createElement(TaxReportTable, { db, period, returnRecord }));
    });

    // 1. Headers must have 4 columns for statutory template: Box, Description, Base, Tax
    const ths = findAll(host, (node) => node.tagName === 'TH');
    assert.deepEqual(ths.map(textOf), ['Box', 'Description', 'Base', 'Tax']);

    // 2. Boxes must match taxReturnBoxes
    const expected = taxReturnBoxes(db, returnRecord);
    const rows = findAll(host, (node) => node.tagName === 'TR');

    for (const b of expected.boxes) {
      const boxRow = rows.find((r) => {
        const cells = (r.childNodes ?? []).filter((c) => c.tagName === 'TD');
        return cells.length >= 4 && textOf(cells[0]) === b.code;
      });
      assert.ok(boxRow, `Box row ${b.code} must be rendered in statutory table`);
      const cells = (boxRow.childNodes ?? []).filter((c) => c.tagName === 'TD');
      assert.equal(textOf(cells[0]), b.code);
      assert.equal(textOf(cells[2]), money(b.base));
      assert.equal(textOf(cells[3]), money(b.tax));
    }

    // 3. Drill-down interaction on BOX-1 (Sales)
    const box1Row = rows.find((r) => {
      const cells = (r.childNodes ?? []).filter((c) => c.tagName === 'TD');
      return cells.length >= 4 && textOf(cells[0]) === 'BOX-1';
    });
    assert.ok(box1Row, 'BOX-1 row must exist');

    const toggleBtn1 = find(box1Row, (node) => node.tagName === 'BUTTON' && props(node)?.['aria-expanded'] !== undefined);
    assert.ok(toggleBtn1, 'Drilldown toggle button must be present in BOX-1 row');
    assert.equal(props(toggleBtn1)['aria-expanded'], false, 'Initially aria-expanded is false');
    assert.ok(!textOf(host).includes('INV/2026/0001'), 'Journal entry name should not be visible before expand');

    // Click to expand drill-down
    await React.act(async () => {
      props(toggleBtn1).onClick({ stopPropagation: () => {}, preventDefault: () => {} });
    });

    assert.equal(props(toggleBtn1)['aria-expanded'], true, 'aria-expanded should toggle to true');
    assert.ok(textOf(host).includes('INV/2026/0001'), 'Journal entry INV/2026/0001 must appear in drilldown table');

    // Click to collapse drill-down
    await React.act(async () => {
      props(toggleBtn1).onClick({ stopPropagation: () => {}, preventDefault: () => {} });
    });

    assert.equal(props(toggleBtn1)['aria-expanded'], false, 'aria-expanded toggles back to false');
    assert.ok(!textOf(host).includes('INV/2026/0001'), 'Journal entry name should disappear after collapse');

    // 4. Drill-down interaction on BOX-6 (Purchases - Services)
    const box6Row = findAll(host, (node) => node.tagName === 'TR').find((r) => {
      const cells = (r.childNodes ?? []).filter((c) => c.tagName === 'TD');
      return cells.length >= 4 && textOf(cells[0]) === 'BOX-6';
    });
    assert.ok(box6Row, 'BOX-6 row must exist');
    const toggleBtn6 = find(box6Row, (node) => node.tagName === 'BUTTON' && props(node)?.['aria-expanded'] !== undefined);
    assert.ok(toggleBtn6, 'Drilldown toggle button must be present in BOX-6 row');

    await React.act(async () => {
      props(toggleBtn6).onClick({ stopPropagation: () => {}, preventDefault: () => {} });
    });
    assert.equal(props(toggleBtn6)['aria-expanded'], true);
    assert.ok(textOf(host).includes('BILL/2026/0002'), 'Bill BILL/2026/0002 must appear in drilldown table');
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('TaxReportTable renders statutory template boxes and drill-down when returnRecord has sa_vat', async () => {
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { money } = await import('./ui.jsx');
  const { TaxReportTable } = await import('./views/Reports.jsx');
  await initStore();

  const { db } = setupReturnTestData(1);
  await React.act(async () => commit(db));

  const yr = new Date().getFullYear();
  const period = { from: `${yr}-01-01`, to: `${yr}-12-31`, company_id: 1 };
  const returnRecord = {
    id: 102,
    name: 'RET-2026-SA',
    company_id: 1,
    date_from: `${yr}-01-01`,
    date_to: `${yr}-12-31`,
    tax_return_template: 'sa_vat',
  };

  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    await React.act(async () => {
      root.render(React.createElement(TaxReportTable, { db, period, returnRecord }));
    });

    const ths = findAll(host, (node) => node.tagName === 'TH');
    assert.deepEqual(ths.map(textOf), ['Box', 'Description', 'Base', 'Tax']);

    const expected = taxReturnBoxes(db, returnRecord);
    const rows = findAll(host, (node) => node.tagName === 'TR');

    for (const b of expected.boxes) {
      const boxRow = rows.find((r) => {
        const cells = (r.childNodes ?? []).filter((c) => c.tagName === 'TD');
        return cells.length >= 4 && textOf(cells[0]) === b.code;
      });
      assert.ok(boxRow, `Box row ${b.code} must be rendered in sa_vat table`);
      const cells = (boxRow.childNodes ?? []).filter((c) => c.tagName === 'TD');
      assert.equal(textOf(cells[0]), b.code);
      assert.equal(textOf(cells[2]), money(b.base));
      assert.equal(textOf(cells[3]), money(b.tax));
    }

    const box1Row = rows.find((r) => {
      const cells = (r.childNodes ?? []).filter((c) => c.tagName === 'TD');
      return cells.length >= 4 && textOf(cells[0]) === '1';
    });
    assert.ok(box1Row, 'ZATCA box 1 row must exist');
    const toggleBtn = find(box1Row, (node) => node.tagName === 'BUTTON' && props(node)?.['aria-expanded'] !== undefined);
    assert.ok(toggleBtn, 'Drilldown toggle button must be present in ZATCA box 1 row');
    await React.act(async () => {
      props(toggleBtn).onClick({ stopPropagation: () => {}, preventDefault: () => {} });
    });
    assert.equal(props(toggleBtn)['aria-expanded'], true);
    assert.ok(textOf(host).includes('INV/2026/0001'), 'Invoice INV/2026/0001 must appear in sa_vat drilldown');
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('TaxReportTable renders generic table when returnRecord has tax_return_template: generic', async () => {
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { TaxReportTable } = await import('./views/Reports.jsx');
  await initStore();

  const { db } = setupReturnTestData(1);
  await React.act(async () => commit(db));

  const yr = new Date().getFullYear();
  const period = { from: `${yr}-01-01`, to: `${yr}-12-31`, company_id: 1 };
  const returnRecord = {
    id: 103,
    name: 'RET-2026-GEN',
    company_id: 1,
    date_from: `${yr}-01-01`,
    date_to: `${yr}-12-31`,
    tax_return_template: 'generic',
  };

  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    await React.act(async () => {
      root.render(React.createElement(TaxReportTable, { db, period, returnRecord }));
    });

    const ths = findAll(host, (node) => node.tagName === 'TH');
    assert.deepEqual(ths.map(textOf), ['', 'Base', 'Tax']);

    const allText = textOf(host);
    assert.match(allText, /Sales/);
    assert.match(allText, /Purchases/);
    assert.match(allText, /Total Sales/);
    assert.match(allText, /Total Purchases/);
    assert.match(allText, /Tax Payable/);
    assert.doesNotMatch(allText, /BOX-1/);

    // Generic drilldown test on the first tax row
    const saleRow = findAll(host, (node) => node.tagName === 'TR').find((r) => textOf(r).includes('Goods VAT 14% C1'));
    assert.ok(saleRow, 'Generic sale tax row must exist');
    const toggleBtn = find(saleRow, (node) => node.tagName === 'BUTTON' && props(node)?.['aria-expanded'] !== undefined);
    assert.ok(toggleBtn, 'Toggle button must exist in generic row');

    await React.act(async () => {
      props(toggleBtn).onClick({ stopPropagation: () => {}, preventDefault: () => {} });
    });
    assert.equal(props(toggleBtn)['aria-expanded'], true);
    assert.ok(textOf(host).includes('INV/2026/0001'), 'Journal entry INV/2026/0001 must appear in generic drilldown');
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('TaxReportTable keeps generic table when returnRecord has no statutory template or is omitted', async () => {
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { TaxReportTable } = await import('./views/Reports.jsx');
  await initStore();

  const { db } = setupReturnTestData(1);
  await React.act(async () => commit(db));

  const yr = new Date().getFullYear();
  const period = { from: `${yr}-01-01`, to: `${yr}-12-31`, company_id: 1 };

  // Case A: returnRecord without tax_return_template
  const hostA = makeEl('div');
  hostA.ownerDocument = globalThis.document;
  const rootA = createRoot(hostA);
  try {
    await React.act(async () => {
      rootA.render(React.createElement(TaxReportTable, { db, period, returnRecord: { id: 104, name: 'RET-NO-TPL', company_id: 1 } }));
    });
    const thsA = findAll(hostA, (node) => node.tagName === 'TH');
    assert.deepEqual(thsA.map(textOf), ['', 'Base', 'Tax']);
    assert.doesNotMatch(textOf(hostA), /BOX-1/);
  } finally {
    await React.act(async () => rootA.unmount());
  }

  // Case B: returnRecord is null
  const hostB = makeEl('div');
  hostB.ownerDocument = globalThis.document;
  const rootB = createRoot(hostB);
  try {
    await React.act(async () => {
      rootB.render(React.createElement(TaxReportTable, { db, period, returnRecord: null }));
    });
    const thsB = findAll(hostB, (node) => node.tagName === 'TH');
    assert.deepEqual(thsB.map(textOf), ['', 'Base', 'Tax']);
    assert.doesNotMatch(textOf(hostB), /BOX-1/);
  } finally {
    await React.act(async () => rootB.unmount());
  }
});

test('FormView for account.return with statutory template renders statutory boxes under Tax Report tab', async () => {
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { FormView } = await import('./views/FormView.jsx');
  await initStore();

  const { db } = setupReturnTestData(1);
  const yr = new Date().getFullYear();
  const vatType = (db.records['account.return.type'] ?? []).find((t) => t.category === 'account_return' && (t.company_id ?? 1) === 1);

  const ret = create(db, 'account.return', {
    name: 'RET-FORMVIEW-EG',
    type_id: vatType.id,
    company_id: 1,
    date_from: `${yr}-01-01`,
    date_to: `${yr}-12-31`,
    tax_return_template: 'eg_vat',
  });
  const updatedDb = ret.db;
  await React.act(async () => commit(updatedDb));

  const trLeaf = menusFor('accounting').find((m) => m.label === 'Accounting').children.find((m) => m.label === 'Closing').children.find((m) => m.key === 'tax-returns');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    await React.act(async () => {
      root.render(React.createElement(FormView, { leaf: trLeaf, id: ret.id, base: '#/accounting/tax-returns', params: new URLSearchParams() }));
    });

    // Verify statutory table rendered inside FormView
    const ths = findAll(host, (node) => node.tagName === 'TH');
    assert.ok(ths.some((node) => textOf(node) === 'Box'), 'Header Box must be rendered');
    assert.ok(ths.some((node) => textOf(node) === 'Description'), 'Header Description must be rendered');

    const allText = textOf(host);
    assert.match(allText, /BOX-1/, 'BOX-1 must appear on statutory return form');
    assert.match(allText, /BOX-9/, 'BOX-9 Net Tax Payable must appear on statutory return form');
  } finally {
    await React.act(async () => root.unmount());
  }
});
