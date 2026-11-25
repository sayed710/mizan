import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { create, read, write } from './orm.js';
import { seed } from './seed.js';
import { accountId } from './models/ledger.js';
import { postMove } from './models/accounting.js';
import { taxSnapshot } from './models/taxes.js';
import { taxReport } from './models/finance.js';
import { taxReturnBoxes } from './models/taxExport.js';
import { createCompanyWithDefaultInvoiceJournals } from './test-support/accounting-company.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));
const props = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];
const textOf = (node) => (node.nodeType === 3 ? node.nodeValue : (node.childNodes ?? []).map(textOf).join(''));
const findAll = (node, predicate, out = []) => {
  if (!node) return out;
  if (predicate(node)) out.push(node);
  for (const child of node.childNodes ?? []) findAll(child, predicate, out);
  return out;
};

function setupTaxData(initialDb = null, { companyId = 1, template = 'eg_vat' } = {}) {
  let db = initialDb ?? seed();
  db = write(db, 'res.company', companyId, { tax_return_template: template });

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
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: `${yr}-04-10`,
    company_id: companyId,
    invoice_line_ids: [{ product_id: 5, qty: 10, price_unit: 100, ...taxSnapshot(read(db, 'account.tax', saleTax.id)) }],
  });
  db = postMove(inv.db, inv.id);

  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 2,
    invoice_date: `${yr}-04-12`,
    company_id: companyId,
    invoice_line_ids: [{ product_id: 5, qty: 4, price_unit: 100, ...taxSnapshot(read(db, 'account.tax', purchTax.id)) }],
  });
  db = postMove(bill.db, bill.id);

  return { db, saleTaxId: saleTax.id, purchTaxId: purchTax.id };
}

test('company with eg_vat: variant defaults to the country template, box rows render with codes and tax amounts equal to taxReturnBoxes for the period, payable equals taxReport payable', async () => {
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { money } = await import('./ui.jsx');
  await initStore();

  const { db } = setupTaxData(null, { companyId: 1, template: 'eg_vat' });
  await React.act(async () => commit(db));

  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'tax' } })));

    // 1. Variant selector defaults to country template
    const variantSelect = find(host, (node) => node.tagName === 'SELECT' && (props(node)?.['aria-label'] === 'Variant' || props(node)?.['aria-label'] === 'النوع'));
    assert.ok(variantSelect, 'Variant selector should be rendered');
    assert.equal(props(variantSelect).value, 'eg_vat');

    // Headers in country variant have 4 columns: Box, Description, Base, Tax
    const ths = findAll(host, (node) => node.tagName === 'TH');
    assert.deepEqual(ths.map(textOf), ['Box', 'Description', 'Base', 'Tax']);

    // 2. Compute canonical boxes and totals for the period
    const yr = new Date().getFullYear();
    const period = { from: `${yr}-01-01`, to: `${yr}-12-31`, company_id: 1 };
    const expected = taxReturnBoxes(db, period);
    const expectedTotals = taxReport(db, period);

    // 3. Verify box rows render with codes and tax amounts equal to taxReturnBoxes
    const rows = findAll(host, (node) => node.tagName === 'TR');
    for (const b of expected.boxes) {
      const row = rows.find((r) => {
        const cells = (r.childNodes ?? []).filter((c) => c.tagName === 'TD');
        return cells.length >= 4 && textOf(cells[0]) === b.code;
      });
      assert.ok(row, `Box row ${b.code} must be rendered`);
      const cells = (row.childNodes ?? []).filter((c) => c.tagName === 'TD');
      assert.equal(textOf(cells[0]), b.code);
      assert.equal(textOf(cells[2]), money(b.base));
      assert.equal(textOf(cells[3]), money(b.tax));
      if (b.kind === 'total') {
        const trClass = props(row)?.className ?? '';
        assert.ok(trClass.includes('rep-total'), `Total box ${b.code} should have rep-total class`);
        if (b.code === 'BOX-9') {
          assert.ok(trClass.includes('strong'), 'Net tax payable should have strong class');
        }
      }
    }

    // 4. Payable equals taxReport payable
    const payableBox = expected.boxes.find((b) => b.code === 'BOX-9');
    assert.equal(payableBox.tax, expectedTotals.payable);
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('company with generic: no selector, existing table unchanged', async () => {
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();

  const { db } = setupTaxData(null, { companyId: 1, template: 'generic' });
  await React.act(async () => commit(db));

  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'tax' } })));

    // No selector
    const variantSelect = find(host, (node) => node.tagName === 'SELECT' && (props(node)?.['aria-label'] === 'Variant' || props(node)?.['aria-label'] === 'النوع'));
    assert.equal(variantSelect, null, 'Variant selector should NOT be rendered when only generic applies');

    // Headers in generic variant have 3 columns: '', Base, Tax
    const ths = findAll(host, (node) => node.tagName === 'TH');
    assert.deepEqual(ths.map(textOf), ['', 'Base', 'Tax']);

    // Existing table unchanged: by-tax sections and rows
    const allText = textOf(host);
    assert.match(allText, /Sales/);
    assert.match(allText, /Purchases/);
    assert.match(allText, /Goods VAT 14% C1/);
    assert.match(allText, /Services VAT 10% C1/);
    assert.match(allText, /Total Sales/);
    assert.match(allText, /Total Purchases/);
    assert.match(allText, /Tax Payable/);
    assert.doesNotMatch(allText, /BOX-1/);
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('switching the variant to Generic shows the existing by-tax rows', async () => {
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();

  const { db } = setupTaxData(null, { companyId: 1, template: 'eg_vat' });
  await React.act(async () => commit(db));

  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'tax' } })));

    const variantSelect = find(host, (node) => node.tagName === 'SELECT' && (props(node)?.['aria-label'] === 'Variant' || props(node)?.['aria-label'] === 'النوع'));
    assert.ok(variantSelect, 'Variant selector should be rendered');
    assert.equal(props(variantSelect).value, 'eg_vat');
    assert.match(textOf(host), /BOX-1/);

    // Switch variant to Generic
    await React.act(async () => props(variantSelect).onChange({ target: { value: 'generic' } }));

    // Headers updated to generic 3 columns: '', Base, Tax
    const thsGeneric = findAll(host, (node) => node.tagName === 'TH');
    assert.deepEqual(thsGeneric.map(textOf), ['', 'Base', 'Tax']);

    // Now existing by-tax rows appear
    const allText = textOf(host);
    assert.match(allText, /Sales/);
    assert.match(allText, /Purchases/);
    assert.match(allText, /Goods VAT 14% C1/);
    assert.match(allText, /Services VAT 10% C1/);
    assert.match(allText, /Total Sales/);
    assert.match(allText, /Total Purchases/);
    assert.match(allText, /Tax Payable/);
    assert.doesNotMatch(allText, /BOX-1/);
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('multi-company: another company\'s moves never appear in the boxes', async () => {
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { money } = await import('./ui.jsx');
  await initStore();

  // Create Company 1 with eg_vat
  let { db } = setupTaxData(null, { companyId: 1, template: 'eg_vat' });

  // Create Company 2 with generic (different templates)
  const co2 = createCompanyWithDefaultInvoiceJournals(db, { name: 'Company Two', currency_id: 1, tax_return_template: 'generic' });
  db = co2.db;
  const c2Data = setupTaxData(db, { companyId: co2.id, template: 'generic' });
  db = {
    ...c2Data.db,
    settings: {
      ...c2Data.db.settings,
      current_company_id: 1,
      allowed_company_ids: [1, co2.id],
    },
  };
  await React.act(async () => commit(db));

  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'tax' } })));

    // When "all companies" is selected, companies use different templates (eg_vat vs generic) -> show Generic only
    const allSelect = find(host, (node) => node.tagName === 'SELECT' && (props(node)?.['aria-label'] === 'Variant' || props(node)?.['aria-label'] === 'النوع'));
    assert.equal(allSelect, null, 'Selector should be hidden when all companies have different templates');

    // Select Company 1 in Company dropdown
    const companySelect = find(host, (node) => node.tagName === 'SELECT' && (props(node)?.['aria-label'] === 'Company' || props(node)?.['aria-label'] === 'الشركة'));
    assert.ok(companySelect, 'Company selector should be rendered');
    await React.act(async () => props(companySelect).onChange({ target: { value: '1' } }));

    // Company 1 has eg_vat -> selector appears and defaults to eg_vat boxes
    const c1Variant = find(host, (node) => node.tagName === 'SELECT' && (props(node)?.['aria-label'] === 'Variant' || props(node)?.['aria-label'] === 'النوع'));
    assert.ok(c1Variant, 'Variant selector should appear for Company 1');
    assert.equal(props(c1Variant).value, 'eg_vat');

    // Verify Company 1's boxes do NOT include Company 2's moves!
    const yr = new Date().getFullYear();
    const c1Period = { from: `${yr}-01-01`, to: `${yr}-12-31`, company_id: 1 };
    const c1Boxes = taxReturnBoxes(db, c1Period);
    const box1Expected = c1Boxes.boxes.find((b) => b.code === 'BOX-1');
    assert.equal(box1Expected.base, 1000);
    assert.equal(box1Expected.tax, 140);

    const rows = findAll(host, (node) => node.tagName === 'TR');
    const box1Row = rows.find((r) => {
      const cells = (r.childNodes ?? []).filter((c) => c.tagName === 'TD');
      return cells.length >= 4 && textOf(cells[0]) === 'BOX-1';
    });
    assert.ok(box1Row);
    const cells = (box1Row.childNodes ?? []).filter((c) => c.tagName === 'TD');
    assert.equal(textOf(cells[2]), money(1000));
    assert.equal(textOf(cells[3]), money(140));

    // And verify Company 2 moves are completely absent from Company 1's boxes
    assert.doesNotMatch(textOf(box1Row), new RegExp(money(2000)));
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('standalone Tax component: renders country boxes by default when company template has mode boxes, and generic when variant is generic', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { Tax } = await import('./views/Reports.jsx');

  const { db } = setupTaxData(null, { companyId: 1, template: 'eg_vat' });
  const yr = new Date().getFullYear();
  const period = { from: `${yr}-01-01`, to: `${yr}-12-31`, company_id: 1 };

  const host = makeEl('table');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    // Default: country template boxes
    await React.act(async () => root.render(React.createElement(Tax, { db, period })));
    const allText = textOf(host);
    assert.match(allText, /BOX-1/);
    assert.match(allText, /BOX-9/);

    // Explicit generic variant: by-tax rows
    await React.act(async () => root.render(React.createElement(Tax, { db, period, variant: 'generic' })));
    const genericText = textOf(host);
    assert.match(genericText, /Sales/);
    assert.match(genericText, /Total Sales/);
    assert.doesNotMatch(genericText, /BOX-1/);
  } finally {
    await React.act(async () => root.unmount());
  }
});

