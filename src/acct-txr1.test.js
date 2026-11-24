import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { create, read, write } from './orm.js';
import { seed } from './seed.js';
import { accountId } from './models/ledger.js';
import { postMove } from './models/accounting.js';
import { replaceTaxSnapshot, taxSnapshot } from './models/taxes.js';
import { taxItems, taxReport, taxesByGrid, taxesByTax } from './models/finance.js';
import { taxBoxItems, taxReturnBoxes, taxReturnToXml } from './models/taxExport.js';
import { detailReportColumns } from './views/reportCompare.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const props = (node) => node?.[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];
const textOf = (node) => (node?.nodeType === 3 ? node.nodeValue : (node?.childNodes ?? []).map(textOf).join(''));
const findAll = (node, predicate, out = []) => {
  if (!node) return out;
  if (predicate(node)) out.push(node);
  for (const child of node.childNodes ?? []) findAll(child, predicate, out);
  return out;
};

function setupTxr1Data({ template = 'generic' } = {}) {
  let db = seed();
  db = write(db, 'res.company', 1, { tax_return_template: template });

  const vatOutAcc = accountId(db, '251000');
  const vatInAcc = accountId(db, '131000');

  const baseTagOut = create(db, 'account.account.tag', { name: 'Grid Out Base', applicability: 'taxes' });
  db = baseTagOut.db;
  const taxTagOutA = create(db, 'account.account.tag', { name: 'Grid Out Tax A', applicability: 'taxes' });
  db = taxTagOutA.db;
  const taxTagOutB = create(db, 'account.account.tag', { name: 'Grid Out Tax B', applicability: 'taxes' });
  db = taxTagOutB.db;
  const baseTagIn = create(db, 'account.account.tag', { name: 'Grid In Base', applicability: 'taxes' });
  db = baseTagIn.db;
  const taxTagIn = create(db, 'account.account.tag', { name: 'Grid In Tax', applicability: 'taxes' });
  db = taxTagIn.db;

  const saleTaxA = create(db, 'account.tax', {
    name: 'TXR Sale A 14%',
    amount: 14,
    amount_type: 'percent',
    type_tax_use: 'sale',
    tax_scope: 'consu',
    company_id: 1,
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, tag_ids: [baseTagOut.id] },
      { repartition_type: 'tax', factor_percent: 100, account_id: vatOutAcc, tag_ids: [taxTagOutA.id] },
    ],
    refund_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, tag_ids: [baseTagOut.id] },
      { repartition_type: 'tax', factor_percent: 100, account_id: vatOutAcc, tag_ids: [taxTagOutA.id] },
    ],
  });
  db = saleTaxA.db;

  const saleTaxB = create(db, 'account.tax', {
    name: 'TXR Sale B 5%',
    amount: 5,
    amount_type: 'percent',
    type_tax_use: 'sale',
    tax_scope: 'service',
    company_id: 1,
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, tag_ids: [baseTagOut.id] },
      { repartition_type: 'tax', factor_percent: 100, account_id: vatOutAcc, tag_ids: [taxTagOutB.id] },
    ],
    refund_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, tag_ids: [baseTagOut.id] },
      { repartition_type: 'tax', factor_percent: 100, account_id: vatOutAcc, tag_ids: [taxTagOutB.id] },
    ],
  });
  db = saleTaxB.db;

  const purchTax = create(db, 'account.tax', {
    name: 'TXR Purchase 10%',
    amount: 10,
    amount_type: 'percent',
    type_tax_use: 'purchase',
    tax_scope: 'service',
    company_id: 1,
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, tag_ids: [baseTagIn.id] },
      { repartition_type: 'tax', factor_percent: 100, account_id: vatInAcc, tag_ids: [taxTagIn.id] },
    ],
    refund_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, tag_ids: [baseTagIn.id] },
      { repartition_type: 'tax', factor_percent: 100, account_id: vatInAcc, tag_ids: [taxTagIn.id] },
    ],
  });
  db = purchTax.db;

  const yr = new Date().getFullYear();
  const snapA = taxSnapshot(read(db, 'account.tax', saleTaxA.id));
  const snapB = taxSnapshot(read(db, 'account.tax', saleTaxB.id));
  const snapP = taxSnapshot(read(db, 'account.tax', purchTax.id));

  // Single-tax sale invoice: 1000 base, 140 tax
  const invA = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: `${yr}-03-10`,
    company_id: 1,
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 1000, ...snapA }],
  });
  db = postMove(invA.db, invA.id);

  // Multi-tax sale invoice: 200 base with both Sale A (28) and Sale B (10)
  const invMulti = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: `${yr}-03-12`,
    company_id: 1,
    invoice_line_ids: [{
      product_id: 5,
      qty: 1,
      price_unit: 200,
      ...replaceTaxSnapshot(snapA),
      taxIds: [saleTaxA.id, saleTaxB.id],
      tax_breakdown: [snapA, snapB],
    }],
  });
  db = postMove(invMulti.db, invMulti.id);

  // Purchase bill: 400 base, 40 tax
  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 2,
    invoice_date: `${yr}-03-15`,
    company_id: 1,
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 400, ...snapP }],
  });
  db = postMove(bill.db, bill.id);

  return {
    db,
    yr,
    period: { from: `${yr}-03-01`, to: `${yr}-03-31`, company_id: 1 },
    saleTaxAId: saleTaxA.id,
    saleTaxBId: saleTaxB.id,
    purchTaxId: purchTax.id,
  };
}

test('TXR-1 model: taxIds restricts taxItems, taxReport, taxesByTax, taxesByGrid, taxReturnBoxes, taxBoxItems and detailReportColumns; empty means all taxes', () => {
  const { db, period, saleTaxAId, saleTaxBId, purchTaxId } = setupTxr1Data();

  // Unfiltered (omitted and empty array behave identically)
  const allTotals = taxReport(db, period);
  assert.deepEqual(taxReport(db, { ...period, taxIds: [] }), allTotals);
  assert.equal(allTotals.output, 178); // 140 + 28 + 10
  assert.equal(allTotals.input, 40);
  assert.equal(allTotals.payable, 138);

  const allRows = taxesByTax(db, period);
  assert.equal(allRows.length, 3);

  // Filter to Sale A only
  const onlyAPeriod = { ...period, taxIds: [saleTaxAId] };
  assert.equal(taxItems(db, onlyAPeriod).every((it) => it.tax_id === saleTaxAId), true);
  assert.deepEqual(taxReport(db, onlyAPeriod), { output: 168, input: 0, payable: 168 });
  assert.deepEqual(taxesByTax(db, onlyAPeriod), [
    { side: 'sale', tax_id: saleTaxAId, name: 'TXR Sale A 14%', base: 1200, tax: 168 },
  ]);

  const gridsA = taxesByGrid(db, onlyAPeriod);
  assert.ok(gridsA.some((g) => g.name === 'Grid Out Tax A' && g.tax === 168));
  assert.equal(gridsA.some((g) => g.name === 'Grid Out Tax B'), false);
  assert.equal(gridsA.some((g) => g.name === 'Grid In Tax'), false);

  const boxesA = taxReturnBoxes(db, onlyAPeriod).boxes;
  assert.equal(boxesA.find((b) => b.code === 'TOTAL-OUT').tax, 168);
  assert.equal(boxesA.find((b) => b.code === 'TOTAL-IN').tax, 0);
  assert.equal(boxesA.find((b) => b.code === 'PAYABLE').tax, 168);
  assert.equal(taxBoxItems(db, onlyAPeriod, 'PAYABLE').tax, 168);

  // Filter to Sale A + Purchase
  const apPeriod = { ...period, taxIds: [saleTaxAId, purchTaxId] };
  assert.deepEqual(taxReport(db, apPeriod), { output: 168, input: 40, payable: 128 });
  assert.equal(taxesByTax(db, apPeriod).some((r) => r.tax_id === saleTaxBId), false);

  // Multi-period comparison helper respects taxIds
  const cmp = detailReportColumns(db, 'tax', [{ ...period, label: 'Mar' }], { company_id: 1, taxIds: [saleTaxBId] });
  assert.equal(cmp.rows.some((r) => r.label === 'TXR Sale A 14%'), false);
  assert.equal(cmp.rows.find((r) => r.label === 'TXR Sale B 5%').columns[0].values[1], 10);
  assert.equal(cmp.rows.find((r) => r.label === 'Total Sales').columns[0].values[1], 10);
});

test('TXR-1 view: Tax Report Taxes multi-select restricts rows and totals and resets to all when cleared', async () => {
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { money } = await import('./ui.jsx');
  await initStore();

  const { db, saleTaxAId } = setupTxr1Data({ template: 'generic' });
  await React.act(async () => commit(db));

  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'tax' } })));

    const taxesSelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === 'Taxes');
    assert.ok(taxesSelect, 'Taxes multi-select filter must be rendered on Tax Report');
    assert.equal(props(taxesSelect).multiple, true);

    const tableText = () => textOf(find(host, (n) => n.tagName === 'TABLE'));
    const beforeText = tableText();
    assert.match(beforeText, /TXR Sale A 14%/);
    assert.match(beforeText, /TXR Sale B 5%/);
    assert.match(beforeText, /TXR Purchase 10%/);

    // Select only Sale Tax A
    await React.act(async () => {
      props(taxesSelect).onChange({ target: { selectedOptions: [{ value: String(saleTaxAId) }] } });
    });

    const filteredText = tableText();
    assert.match(filteredText, /TXR Sale A 14%/);
    assert.doesNotMatch(filteredText, /TXR Sale B 5%/);
    assert.doesNotMatch(filteredText, /TXR Purchase 10%/);
    const totalSalesRow = findAll(host, (n) => n.tagName === 'TR').find((r) => textOf(r).includes('Total Sales'));
    assert.ok(totalSalesRow);
    assert.match(textOf(totalSalesRow), new RegExp(money(168).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    // Clear selection -> all taxes restored
    await React.act(async () => {
      props(taxesSelect).onChange({ target: { selectedOptions: [] } });
    });
    const resetText = tableText();
    assert.match(resetText, /TXR Sale B 5%/);
    assert.match(resetText, /TXR Purchase 10%/);
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('TXR-2: Generic tax report uses Odoo section/total labels (Sales, Purchases, Total Sales, Total Purchases, Tax Payable) with Arabic translations', async () => {
  const { db, period } = setupTxr1Data({ template: 'generic' });
  const { boxes } = taxReturnBoxes(db, period);
  const totalLabels = boxes.filter((b) => b.kind === 'total').map((b) => [b.code, b.label]);
  assert.deepEqual(totalLabels, [
    ['TOTAL-OUT', 'Total Sales'],
    ['TOTAL-IN', 'Total Purchases'],
    ['PAYABLE', 'Tax Payable'],
  ]);

  const prevStorage = globalThis.localStorage;
  try {
    globalThis.localStorage = { getItem: (key) => (key === 'mizan-lang' ? 'ar' : null) };
    const { t: tAr } = await import(`./i18n.js?txr1=${Date.now()}`);
    for (const key of ['Sales', 'Purchases', 'Total Sales', 'Total Purchases', 'Tax Payable', 'Taxes']) {
      const translated = tAr(key);
      assert.ok(translated && translated !== key, `${key} must have a non-identity Arabic translation`);
    }
  } finally {
    globalThis.localStorage = prevStorage;
  }
});

test('TXR-3: Statutory XML export is reachable on the Tax Report page only when company has a statutory template and uses taxReturnToXml', async () => {
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();

  const { Reports } = await import('./views/Reports.jsx');

  // 1. Generic company: no Export XML button
  const genericData = setupTxr1Data({ template: 'generic' });
  await React.act(async () => commit(genericData.db));
  const hostGen = makeEl('div');
  hostGen.ownerDocument = globalThis.document;
  const rootGen = createRoot(hostGen);
  try {
    await React.act(async () => rootGen.render(React.createElement(Reports, { leaf: { report: 'tax' } })));
    const xmlBtnGen = find(hostGen, (n) => n.tagName === 'BUTTON' && textOf(n) === 'Export XML');
    assert.equal(xmlBtnGen, null, 'Export XML must not appear when company template is generic');
  } finally {
    await React.act(async () => rootGen.unmount());
  }

  // 2. Statutory company (eg_vat / sa_vat): Export XML button appears and emits canonical taxReturnToXml output
  const downloads = [];
  const origUrl = globalThis.URL;
  const origBlob = globalThis.Blob;
  globalThis.Blob = class MockBlob {
    constructor(parts) { this.textContent = parts.join(''); }
  };
  globalThis.URL = {
    createObjectURL: (blob) => {
      downloads.push(blob.textContent);
      return 'blob:txr1';
    },
    revokeObjectURL: () => {},
  };

  try {
    for (const tpl of ['eg_vat', 'sa_vat']) {
      const statData = setupTxr1Data({ template: tpl });
      await React.act(async () => commit(statData.db));
      const hostStat = makeEl('div');
      hostStat.ownerDocument = globalThis.document;
      const rootStat = createRoot(hostStat);
      try {
        await React.act(async () => rootStat.render(React.createElement(Reports, { leaf: { report: 'tax' } })));
        const xmlBtn = find(hostStat, (n) => n.tagName === 'BUTTON' && textOf(n) === 'Export XML');
        assert.ok(xmlBtn, `Export XML must be rendered on Tax Report for ${tpl}`);

        await React.act(async () => props(xmlBtn).onClick());
        const exported = downloads.at(-1);
        const yearPeriod = {
          from: `${statData.yr}-01-01`,
          to: `${statData.yr}-12-31`,
          company_id: 1,
          tax_return_template: tpl,
        };
        const expected = taxReturnToXml(statData.db, yearPeriod);
        const expectedTotals = taxReport(statData.db, yearPeriod);
        assert.ok(exported.includes(`template="${tpl}"`));
        assert.ok(exported.includes(`payable="${expectedTotals.payable.toFixed(2)}"`));
        assert.equal(exported.split('\n').slice(2).join('\n'), expected.split('\n').slice(2).join('\n'));
      } finally {
        await React.act(async () => rootStat.unmount());
      }
    }
  } finally {
    globalThis.URL = origUrl;
    globalThis.Blob = origBlob;
  }
});
