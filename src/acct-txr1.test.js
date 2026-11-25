import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { accountId, journalId } from './models/ledger.js';
import { payMove, postMove } from './models/accounting.js';
import { replaceTaxSnapshot, taxSnapshot } from './models/taxes.js';
import { taxItems, taxReport, taxesByGrid, taxesByTax } from './models/finance.js';
import { taxBoxItems, taxReturnBoxes, taxReturnToXml } from './models/taxExport.js';
import { detailReportColumns } from './views/reportCompare.js';
import { createCompanyWithDefaultInvoiceJournals } from './test-support/accounting-company.js';

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
    baseTagOutId: baseTagOut.id,
    taxTagOutAId: taxTagOutA.id,
    taxTagOutBId: taxTagOutB.id,
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

test('Finding 1: All-companies statutory scope hides Export XML when multiple companies share a template, and taxReturnToXml refuses null company_id', async () => {
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();
  const { Reports } = await import('./views/Reports.jsx');

  let { db, yr } = setupTxr1Data({ template: 'eg_vat' });
  const c2 = createCompanyWithDefaultInvoiceJournals(db, { name: 'Co 2', currency_id: 1, tax_return_template: 'eg_vat' });
  db = c2.db;
  const c3 = createCompanyWithDefaultInvoiceJournals(db, { name: 'Co 3', currency_id: 1, tax_return_template: 'eg_vat' });
  db = c3.db;

  // Model guard: explicit company_id: null or multi-company omitted company_id never falls back to company 1
  const multiBoxes = taxReturnBoxes(db, { from: `${yr}-01-01`, to: `${yr}-12-31`, company_id: null, tax_return_template: 'eg_vat' });
  assert.equal(multiBoxes.company_id, null);
  assert.throws(
    () => taxReturnToXml(db, { from: `${yr}-01-01`, to: `${yr}-12-31`, company_id: null, tax_return_template: 'eg_vat' }),
    /single company/i,
  );
  assert.throws(
    () => taxReturnToXml(db, { from: `${yr}-01-01`, to: `${yr}-12-31`, tax_return_template: 'eg_vat' }),
    /single company/i,
  );

  // Scope excludes company 1 completely (only companies 2 and 3 allowed), both sharing eg_vat
  db = {
    ...db,
    settings: { ...db.settings, current_company_id: c2.id, allowed_company_ids: [c2.id, c3.id] },
  };
  await React.act(async () => commit(db));

  const downloads = [];
  const origUrl = globalThis.URL;
  const origBlob = globalThis.Blob;
  globalThis.Blob = class MockBlob {
    constructor(parts) { this.textContent = parts.join(''); }
  };
  globalThis.URL = {
    createObjectURL: (blob) => { downloads.push(blob.textContent); return 'blob:f1'; },
    revokeObjectURL: () => {},
  };

  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'tax' } })));

    // Under 'All Companies' with 2 companies sharing eg_vat, Export XML must NOT be offered
    assert.equal(find(host, (n) => n.tagName === 'BUTTON' && textOf(n) === 'Export XML'), null);

    // Selecting Company 2 resolves a single concrete company and exports companyId="2"
    const companySelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === 'Company');
    assert.ok(companySelect);
    await React.act(async () => props(companySelect).onChange({ target: { value: String(c2.id) } }));

    const xmlBtn = find(host, (n) => n.tagName === 'BUTTON' && textOf(n) === 'Export XML');
    assert.ok(xmlBtn, 'Export XML must appear once a single concrete company is selected');
    await React.act(async () => props(xmlBtn).onClick());
    assert.ok(downloads.at(-1).includes(`companyId="${c2.id}"`));
  } finally {
    await React.act(async () => root.unmount());
    globalThis.URL = origUrl;
    globalThis.Blob = origBlob;
  }
});

test('Finding 2: Editing a tax base repartition tag after posting preserves historical grid bases under Taxes filter', () => {
  let { db, yr, period, saleTaxAId, baseTagOutId, taxTagOutAId } = setupTxr1Data();
  const vatOutAcc = accountId(db, '251000');

  // Also test cash-basis tax and manual journal entry whose base tag changes after posting
  const cbBaseTag = create(db, 'account.account.tag', { name: 'CB Old Base', applicability: 'taxes' });
  db = cbBaseTag.db;
  const cbTaxTag = create(db, 'account.account.tag', { name: 'CB Tax Tag', applicability: 'taxes' });
  db = cbTaxTag.db;
  const cbTax = create(db, 'account.tax', {
    name: 'CB Tax 10%',
    amount: 10,
    amount_type: 'percent',
    type_tax_use: 'sale',
    company_id: 1,
    tax_exigibility: 'on_payment',
    cash_basis_transition_account_id: accountId(db, '251100'),
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, tag_ids: [cbBaseTag.id] },
      { repartition_type: 'tax', factor_percent: 100, account_id: vatOutAcc, tag_ids: [cbTaxTag.id] },
    ],
    refund_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, tag_ids: [cbBaseTag.id] },
      { repartition_type: 'tax', factor_percent: 100, account_id: vatOutAcc, tag_ids: [cbTaxTag.id] },
    ],
  });
  db = cbTax.db;
  const cbInv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: `${yr}-03-18`,
    company_id: 1,
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 300, ...taxSnapshot(read(db, 'account.tax', cbTax.id)) }],
  });
  db = postMove(cbInv.db, cbInv.id);
  db = payMove(db, cbInv.id, 330, `${yr}-03-19`);

  const revAcc = accountId(db, '400000', 1);
  const cashAcc = search(db, 'account.account').find((a) => (a.company_id ?? 1) === 1 && (a.account_type === 'asset_cash' || a.account_type === 'asset_current'))?.id;
  const miscJournalId = journalId(db, 'MISC', 1);
  const entry = create(db, 'account.move', {
    move_type: 'entry',
    journal_id: miscJournalId,
    date: `${yr}-03-20`,
    company_id: 1,
    line_ids: [
      { account_id: revAcc, debit: 0, credit: 600, tax_ids: [saleTaxAId] },
      { account_id: cashAcc, debit: 684, credit: 0 },
    ],
  });
  db = postMove(entry.db, entry.id);

  const newTag = create(db, 'account.account.tag', { name: 'Grid Out Base New', applicability: 'taxes' });
  db = newTag.db;

  // Edit both saleTaxA and cbTax base repartition tags AFTER posting
  db = write(db, 'account.tax', saleTaxAId, {
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, tag_ids: [newTag.id] },
      { repartition_type: 'tax', factor_percent: 100, account_id: vatOutAcc, tag_ids: [taxTagOutAId] },
    ],
  });
  db = write(db, 'account.tax', cbTax.id, {
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, tag_ids: [newTag.id] },
      { repartition_type: 'tax', factor_percent: 100, account_id: vatOutAcc, tag_ids: [cbTaxTag.id] },
    ],
  });

  const gridsA = taxesByGrid(db, { ...period, taxIds: [saleTaxAId] });
  assert.equal(gridsA.find((g) => g.id === baseTagOutId)?.base, 1800, 'Invoice 1000 + multi 200 + manual entry 600 base preserved');
  assert.equal(gridsA.find((g) => g.id === taxTagOutAId)?.tax, 252, '140 + 28 + 84 tax preserved');

  const gridsCb = taxesByGrid(db, { ...period, taxIds: [cbTax.id] });
  assert.equal(gridsCb.find((g) => g.id === cbBaseTag.id)?.base, 300, 'Cash-basis base preserved after tax edit');
  assert.equal(gridsCb.find((g) => g.id === cbTaxTag.id)?.tax, 30);
});

test('Finding 3: Switching Variant to Generic hides Export XML so statutory boxes cannot be exported from Generic view', async () => {
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();
  const { Reports } = await import('./views/Reports.jsx');

  const { db } = setupTxr1Data({ template: 'eg_vat' });
  await React.act(async () => commit(db));

  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'tax' } })));
    const variantSelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === 'Variant');
    assert.ok(variantSelect);
    assert.equal(props(variantSelect).value, 'eg_vat');
    assert.ok(find(host, (n) => n.tagName === 'BUTTON' && textOf(n) === 'Export XML'));

    await React.act(async () => props(variantSelect).onChange({ target: { value: 'generic' } }));
    assert.equal(find(host, (n) => n.tagName === 'BUTTON' && textOf(n) === 'Export XML'), null);

    await React.act(async () => props(variantSelect).onChange({ target: { value: 'eg_vat' } }));
    assert.ok(find(host, (n) => n.tagName === 'BUTTON' && textOf(n) === 'Export XML'));
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('Finding 4: Export XML is disabled while Taxes filter is active and taxReturnToXml rejects filtered specs', async () => {
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();
  const { Reports } = await import('./views/Reports.jsx');

  const { db, yr, saleTaxAId } = setupTxr1Data({ template: 'eg_vat' });
  assert.throws(
    () => taxReturnToXml(db, { from: `${yr}-01-01`, to: `${yr}-12-31`, company_id: 1, tax_return_template: 'eg_vat', taxIds: [saleTaxAId] }),
    /tax filter/i,
  );

  await React.act(async () => commit(db));
  const downloads = [];
  const origUrl = globalThis.URL;
  const origBlob = globalThis.Blob;
  globalThis.Blob = class MockBlob {
    constructor(parts) { this.textContent = parts.join(''); }
  };
  globalThis.URL = {
    createObjectURL: (blob) => { downloads.push(blob.textContent); return 'blob:f4'; },
    revokeObjectURL: () => {},
  };

  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'tax' } })));
    const taxesSelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === 'Taxes');
    await React.act(async () => props(taxesSelect).onChange({ target: { selectedOptions: [{ value: String(saleTaxAId) }] } }));

    const xmlBtn = find(host, (n) => n.tagName === 'BUTTON' && textOf(n) === 'Export XML');
    assert.ok(xmlBtn);
    assert.equal(props(xmlBtn).disabled, true);
    await React.act(async () => props(xmlBtn).onClick());
    assert.equal(downloads.length, 0, 'Filtered tax report must not trigger XML download');

    // Clearing filter re-enables Export XML
    await React.act(async () => props(taxesSelect).onChange({ target: { selectedOptions: [] } }));
    const enabledBtn = find(host, (n) => n.tagName === 'BUTTON' && textOf(n) === 'Export XML');
    assert.equal(props(enabledBtn).disabled, false);
    await React.act(async () => props(enabledBtn).onClick());
    assert.equal(downloads.length, 1);
  } finally {
    await React.act(async () => root.unmount());
    globalThis.URL = origUrl;
    globalThis.Blob = origBlob;
  }
});

test('Finding 5: Filtering by a tax excludes bases from separate invoices or lines that only used another tax sharing the same base tag', () => {
  let { db, yr, period, saleTaxAId, saleTaxBId, baseTagOutId, taxTagOutAId, taxTagOutBId } = setupTxr1Data();
  const snapA = taxSnapshot(read(db, 'account.tax', saleTaxAId));
  const snapB = taxSnapshot(read(db, 'account.tax', saleTaxBId));

  // Separate invoice using ONLY Sale B (which shares baseTagOutId with Sale A)
  const invBOnly = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: `${yr}-03-14`,
    company_id: 1,
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 500, ...snapB }],
  });
  db = postMove(invBOnly.db, invBOnly.id);

  // Single invoice with two lines on the same income account: one using Sale A (300), one using Sale B (400)
  const invSplit = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: `${yr}-03-16`,
    company_id: 1,
    invoice_line_ids: [
      { product_id: 5, qty: 1, price_unit: 300, ...snapA },
      { product_id: 5, qty: 1, price_unit: 400, ...snapB },
    ],
  });
  db = postMove(invSplit.db, invSplit.id);

  const gridsAll = taxesByGrid(db, period);
  assert.equal(gridsAll.find((g) => g.id === baseTagOutId)?.base, 2400); // 1000 + 200 + 500 + 300 + 400

  const gridsA = taxesByGrid(db, { ...period, taxIds: [saleTaxAId] });
  assert.equal(gridsA.find((g) => g.id === baseTagOutId)?.base, 1500, 'Must include 1000 + 200 + 300 only, excluding 500 and 400');
  assert.equal(gridsA.find((g) => g.id === taxTagOutAId)?.tax, 210); // 140 + 28 + 42
  assert.equal(gridsA.some((g) => g.id === taxTagOutBId), false);

  const gridsB = taxesByGrid(db, { ...period, taxIds: [saleTaxBId] });
  assert.equal(gridsB.find((g) => g.id === baseTagOutId)?.base, 1100, 'Must include 500 + 200 + 400 only, excluding 1000 and 300');
  assert.equal(gridsB.find((g) => g.id === taxTagOutBId)?.tax, 55); // 10 + 25 + 20
  assert.equal(gridsB.some((g) => g.id === taxTagOutAId), false);
});
