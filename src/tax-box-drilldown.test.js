import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { create, read, write } from './orm.js';
import { seed } from './seed.js';
import { accountId } from './models/ledger.js';
import { payMove, postMove } from './models/accounting.js';
import { defaultTaxRepartitionLines, replaceTaxSnapshot, taxSnapshot } from './models/taxes.js';
import { taxBoxItems, taxReturnBoxes } from './models/taxExport.js';
import { round } from './money.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));
const props = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];
const textOf = (node) => (node.nodeType === 3 ? node.nodeValue : (node.childNodes ?? []).map(textOf).join(''));
const findAll = (node, predicate, out = []) => {
  if (!node) return out;
  if (predicate(node)) out.push(node);
  for (const child of node.childNodes ?? []) findAll(child, predicate, out);
  return out;
};

test('Must hold 1: Net/PAYABLE box: item contributions signed (purchase negative); their sum equals the box tax', () => {
  let db = seed();
  const yr = new Date().getFullYear();
  const period = { from: `${yr}-03-01`, to: `${yr}-03-31`, company_id: 1 };

  const vatOutAcc = accountId(db, '251000');
  const vatInAcc = accountId(db, '131000');

  const saleTax = create(db, 'account.tax', {
    name: 'Sale Tax 14%',
    amount: 14,
    amount_type: 'percent',
    type_tax_use: 'sale',
    company_id: 1,
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100 },
      { repartition_type: 'tax', factor_percent: 100, account_id: vatOutAcc },
    ],
  });
  db = saleTax.db;

  const purchTax = create(db, 'account.tax', {
    name: 'Purchase Tax 10%',
    amount: 10,
    amount_type: 'percent',
    type_tax_use: 'purchase',
    company_id: 1,
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100 },
      { repartition_type: 'tax', factor_percent: 100, account_id: vatInAcc },
    ],
  });
  db = purchTax.db;

  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: `${yr}-03-10`,
    company_id: 1,
    invoice_line_ids: [{ product_id: 5, qty: 10, price_unit: 100, ...taxSnapshot(read(db, 'account.tax', saleTax.id)) }],
  });
  db = postMove(inv.db, inv.id);

  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 2,
    invoice_date: `${yr}-03-12`,
    company_id: 1,
    invoice_line_ids: [{ product_id: 5, qty: 5, price_unit: 100, ...taxSnapshot(read(db, 'account.tax', purchTax.id)) }],
  });
  db = postMove(bill.db, bill.id);

  // In generic mode: PAYABLE box
  const resGen = taxBoxItems(db, period, 'PAYABLE');
  const boxesGen = taxReturnBoxes(db, period).boxes;
  const payableBoxGen = boxesGen.find((b) => b.code === 'PAYABLE');

  assert.ok(payableBoxGen, 'PAYABLE box must exist');
  assert.equal(resGen.tax, payableBoxGen.tax);
  assert.equal(resGen.base, payableBoxGen.base);
  assert.equal(resGen.base, 0);

  const saleItem = resGen.items.find((it) => it.move_id === inv.id);
  const purchItem = resGen.items.find((it) => it.move_id === bill.id);
  assert.ok(saleItem, 'Sale item must be present');
  assert.ok(purchItem, 'Purchase item must be present');
  assert.equal(saleItem.tax, 140, 'Sale item tax contribution must be positive');
  assert.equal(purchItem.tax, -50, 'Purchase item tax contribution must be negative in net box');

  const genSum = round(resGen.items.reduce((s, it) => s + it.tax, 0));
  assert.equal(genSum, resGen.tax);
  assert.equal(genSum, payableBoxGen.tax);

  // In template mode: BOX-9 (net_payable in eg_vat)
  const retEg = { ...period, tax_return_template: 'eg_vat' };
  const resEg = taxBoxItems(db, retEg, 'BOX-9');
  const boxesEg = taxReturnBoxes(db, retEg).boxes;
  const payableBoxEg = boxesEg.find((b) => b.code === 'BOX-9');

  assert.ok(payableBoxEg, 'BOX-9 must exist');
  assert.equal(resEg.tax, payableBoxEg.tax);
  assert.equal(resEg.base, payableBoxEg.base);
  assert.equal(resEg.base, 0);

  const saleItemEg = resEg.items.find((it) => it.move_id === inv.id);
  const purchItemEg = resEg.items.find((it) => it.move_id === bill.id);
  assert.ok(saleItemEg, 'Sale item must be present in template net box');
  assert.ok(purchItemEg, 'Purchase item must be present in template net box');
  assert.equal(saleItemEg.tax, 140);
  assert.equal(purchItemEg.tax, -50);

  const egSum = round(resEg.items.reduce((s, it) => s + it.tax, 0));
  assert.equal(egSum, resEg.tax);
  assert.equal(egSum, payableBoxEg.tax);
});

test('Must hold 2: Base is the deduplicated base (a document with two taxes on the same line does not count the base twice)', () => {
  let db = seed();
  const yr = new Date().getFullYear();
  const period = { from: `${yr}-04-01`, to: `${yr}-04-30`, company_id: 1 };
  const vatOutAcc = accountId(db, '251000');

  const tax1 = create(db, 'account.tax', {
    name: 'Tax 10%',
    amount: 10,
    amount_type: 'percent',
    type_tax_use: 'sale',
    tax_scope: 'consu',
    company_id: 1,
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100 },
      { repartition_type: 'tax', factor_percent: 100, account_id: vatOutAcc },
    ],
  });
  db = tax1.db;

  const tax2 = create(db, 'account.tax', {
    name: 'Tax 5%',
    amount: 5,
    amount_type: 'percent',
    type_tax_use: 'sale',
    tax_scope: 'consu',
    company_id: 1,
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100 },
      { repartition_type: 'tax', factor_percent: 100, account_id: vatOutAcc },
    ],
  });
  db = tax2.db;

  const snap1 = taxSnapshot(read(db, 'account.tax', tax1.id));
  const snap2 = taxSnapshot(read(db, 'account.tax', tax2.id));

  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: `${yr}-04-10`,
    company_id: 1,
    invoice_line_ids: [{
      product_id: 5,
      qty: 1,
      price_unit: 1000,
      ...replaceTaxSnapshot(snap1),
      tax_ids: [tax1.id, tax2.id],
      tax_breakdown: [snap1, snap2],
    }],
  });
  db = postMove(inv.db, inv.id);

  // In generic mode: TOTAL-OUT should have base = 1000 (deduplicated), NOT 2000
  const drillTotalOut = taxBoxItems(db, period, 'TOTAL-OUT');
  const boxTotalOut = taxReturnBoxes(db, period).boxes.find((b) => b.code === 'TOTAL-OUT');
  assert.equal(drillTotalOut.base, 1000, 'TOTAL-OUT base must be deduplicated to 1000');
  assert.equal(boxTotalOut.base, 1000);
  assert.equal(drillTotalOut.base, boxTotalOut.base);
  assert.equal(drillTotalOut.tax, 150);
  assert.equal(boxTotalOut.tax, 150);

  // In template mode: BOX-4 (total_output in eg_vat) should also have base = 1000
  const retEg = { ...period, tax_return_template: 'eg_vat' };
  const drillEgBox4 = taxBoxItems(db, retEg, 'BOX-4');
  const boxEgBox4 = taxReturnBoxes(db, retEg).boxes.find((b) => b.code === 'BOX-4');
  assert.equal(drillEgBox4.base, 1000, 'BOX-4 base must be deduplicated to 1000');
  assert.equal(boxEgBox4.base, 1000);
  assert.equal(drillEgBox4.base, boxEgBox4.base);
  assert.equal(drillEgBox4.tax, 150);

  // And BOX-1 (Goods Sales in eg_vat) matches both taxes because both are consu
  const drillEgBox1 = taxBoxItems(db, retEg, 'BOX-1');
  const boxEgBox1 = taxReturnBoxes(db, retEg).boxes.find((b) => b.code === 'BOX-1');
  assert.equal(drillEgBox1.base, 1000, 'BOX-1 base must be deduplicated to 1000');
  assert.equal(boxEgBox1.base, 1000);
  assert.equal(drillEgBox1.base, boxEgBox1.base);
  assert.equal(drillEgBox1.tax, 150);
});

test('Must hold 3: Cash-basis: with a cash-basis tax, before payment the box has no items; after payment the release items appear and sum to the box', () => {
  let db = seed();
  const yr = new Date().getFullYear();
  const period = { from: `${yr}-05-01`, to: `${yr}-05-31`, company_id: 1 };

  const cashTax = create(db, 'account.tax', {
    name: 'Cash VAT 14%',
    amount: 14,
    amount_type: 'percent',
    type_tax_use: 'sale',
    company_id: 1,
    ...defaultTaxRepartitionLines(accountId(db, '251000')),
    tax_exigibility: 'on_payment',
    cash_basis_transition_account_id: accountId(db, '251100'),
  });
  db = cashTax.db;

  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: `${yr}-05-05`,
    company_id: 1,
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, ...taxSnapshot(read(db, 'account.tax', cashTax.id)) }],
  });
  db = postMove(inv.db, inv.id);

  // Before payment: box has no items and tax is 0
  const beforeDrill = taxBoxItems(db, period, 'TOTAL-OUT');
  const beforeBox = taxReturnBoxes(db, period).boxes.find((b) => b.code === 'TOTAL-OUT');
  assert.equal(beforeDrill.items.length, 0, 'No items before payment');
  assert.equal(beforeDrill.tax, 0);
  assert.equal(beforeBox.tax, 0);

  // Register and post payment
  db = payMove(db, inv.id, 114, `${yr}-05-15`);

  // After payment: release items appear and sum to the box
  const afterDrill = taxBoxItems(db, period, 'TOTAL-OUT');
  const afterBox = taxReturnBoxes(db, period).boxes.find((b) => b.code === 'TOTAL-OUT');
  assert.ok(afterDrill.items.length > 0, 'Release items must appear after payment');
  assert.equal(afterDrill.tax, 14, 'Drill tax must equal 14 after payment');
  assert.equal(afterBox.tax, 14, 'Box tax must equal 14 after payment');
  assert.equal(afterDrill.tax, afterBox.tax);
  assert.equal(afterDrill.base, afterBox.base);
  assert.equal(round(afterDrill.items.reduce((s, it) => s + it.tax, 0)), afterBox.tax);
});

test('Must hold 4: A refund contributes negatively', () => {
  let db = seed();
  const yr = new Date().getFullYear();
  const period = { from: `${yr}-06-01`, to: `${yr}-06-30`, company_id: 1 };
  const vatOutAcc = accountId(db, '251000');

  const saleTax = create(db, 'account.tax', {
    name: 'Standard VAT 14%',
    amount: 14,
    amount_type: 'percent',
    type_tax_use: 'sale',
    company_id: 1,
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

  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: `${yr}-06-05`,
    company_id: 1,
    invoice_line_ids: [{ product_id: 5, qty: 10, price_unit: 100, ...taxSnapshot(read(db, 'account.tax', saleTax.id)) }],
  });
  db = postMove(inv.db, inv.id);

  const refund = create(db, 'account.move', {
    move_type: 'out_refund',
    partner_id: 1,
    invoice_date: `${yr}-06-15`,
    company_id: 1,
    invoice_line_ids: [{ product_id: 5, qty: 2, price_unit: 100, ...taxSnapshot(read(db, 'account.tax', saleTax.id)) }],
  });
  db = postMove(refund.db, refund.id);

  const drill = taxBoxItems(db, period, 'TOTAL-OUT');
  const box = taxReturnBoxes(db, period).boxes.find((b) => b.code === 'TOTAL-OUT');

  assert.equal(drill.items.length, 2);
  const refundItem = drill.items.find((it) => it.move_id === refund.id);
  assert.ok(refundItem, 'Refund item must be in drill-down');
  assert.equal(refundItem.tax, -28, 'Refund item must contribute negatively');

  const invItem = drill.items.find((it) => it.move_id === inv.id);
  assert.equal(invItem.tax, 140);

  assert.equal(drill.tax, 112);
  assert.equal(box.tax, 112);
  assert.equal(drill.tax, box.tax);
  assert.equal(drill.base, box.base);
  assert.equal(round(drill.items.reduce((s, it) => s + it.tax, 0)), box.tax);
});

test('Must hold 5: For EVERY box of a seeded scenario with sales, purchases, a refund and two taxes, taxBoxItems(...).tax === box.tax and .base === box.base, in template mode and generic mode', () => {
  let db = seed();
  const yr = new Date().getFullYear();
  const period = { from: `${yr}-07-01`, to: `${yr}-07-31`, company_id: 1 };
  const vatOutAcc = accountId(db, '251000');
  const vatInAcc = accountId(db, '131000');

  const saleTax1 = create(db, 'account.tax', {
    name: 'Sale Goods 14%',
    amount: 14,
    amount_type: 'percent',
    type_tax_use: 'sale',
    tax_scope: 'consu',
    company_id: 1,
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100 },
      { repartition_type: 'tax', factor_percent: 100, account_id: vatOutAcc },
    ],
    refund_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100 },
      { repartition_type: 'tax', factor_percent: 100, account_id: vatOutAcc },
    ],
  });
  db = saleTax1.db;

  const saleTax2 = create(db, 'account.tax', {
    name: 'Sale Services 10%',
    amount: 10,
    amount_type: 'percent',
    type_tax_use: 'sale',
    tax_scope: 'service',
    company_id: 1,
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100 },
      { repartition_type: 'tax', factor_percent: 100, account_id: vatOutAcc },
    ],
    refund_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100 },
      { repartition_type: 'tax', factor_percent: 100, account_id: vatOutAcc },
    ],
  });
  db = saleTax2.db;

  const purchTax = create(db, 'account.tax', {
    name: 'Purch Goods 14%',
    amount: 14,
    amount_type: 'percent',
    type_tax_use: 'purchase',
    tax_scope: 'consu',
    company_id: 1,
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

  // 1. Sale invoice with single tax
  const inv1 = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: `${yr}-07-02`,
    company_id: 1,
    invoice_line_ids: [{ product_id: 5, qty: 5, price_unit: 100, ...taxSnapshot(read(db, 'account.tax', saleTax1.id)) }],
  });
  db = postMove(inv1.db, inv1.id);

  // 2. Sale invoice with two taxes on one line
  const snap1 = taxSnapshot(read(db, 'account.tax', saleTax1.id));
  const snap2 = taxSnapshot(read(db, 'account.tax', saleTax2.id));
  const inv2 = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: `${yr}-07-05`,
    company_id: 1,
    invoice_line_ids: [{
      product_id: 5,
      qty: 2,
      price_unit: 100,
      ...replaceTaxSnapshot(snap1),
      tax_ids: [saleTax1.id, saleTax2.id],
      tax_breakdown: [snap1, snap2],
    }],
  });
  db = postMove(inv2.db, inv2.id);

  // 3. Sale refund
  const ref1 = create(db, 'account.move', {
    move_type: 'out_refund',
    partner_id: 1,
    invoice_date: `${yr}-07-10`,
    company_id: 1,
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, ...taxSnapshot(read(db, 'account.tax', saleTax1.id)) }],
  });
  db = postMove(ref1.db, ref1.id);

  // 4. Purchase bill
  const bill1 = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 2,
    invoice_date: `${yr}-07-12`,
    company_id: 1,
    invoice_line_ids: [{ product_id: 5, qty: 4, price_unit: 100, ...taxSnapshot(read(db, 'account.tax', purchTax.id)) }],
  });
  db = postMove(bill1.db, bill1.id);

  // 5. Purchase refund
  const billRef = create(db, 'account.move', {
    move_type: 'in_refund',
    partner_id: 2,
    invoice_date: `${yr}-07-15`,
    company_id: 1,
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, ...taxSnapshot(read(db, 'account.tax', purchTax.id)) }],
  });
  db = postMove(billRef.db, billRef.id);

  // Check generic mode for EVERY box
  const genBoxes = taxReturnBoxes(db, { ...period, tax_return_template: 'generic' }).boxes;
  assert.ok(genBoxes.length > 0, 'Generic boxes must not be empty');
  for (const box of genBoxes) {
    const drill = taxBoxItems(db, { ...period, tax_return_template: 'generic' }, box.code);
    assert.equal(drill.tax, box.tax, `Generic box ${box.code} tax must match box.tax`);
    assert.equal(drill.base, box.base, `Generic box ${box.code} base must match box.base`);
    const sum = round(drill.items.reduce((s, it) => s + it.tax, 0));
    assert.equal(sum, box.tax, `Generic box ${box.code} items sum must match box.tax`);
  }

  // Check template mode (eg_vat) for EVERY box
  const egBoxes = taxReturnBoxes(db, { ...period, tax_return_template: 'eg_vat' }).boxes;
  assert.ok(egBoxes.length > 0, 'eg_vat boxes must not be empty');
  for (const box of egBoxes) {
    const drill = taxBoxItems(db, { ...period, tax_return_template: 'eg_vat' }, box.code);
    assert.equal(drill.tax, box.tax, `eg_vat box ${box.code} tax must match box.tax`);
    assert.equal(drill.base, box.base, `eg_vat box ${box.code} base must match box.base`);
    const sum = round(drill.items.reduce((s, it) => s + it.tax, 0));
    assert.equal(sum, box.tax, `eg_vat box ${box.code} items sum must match box.tax`);
  }

  // Check template mode (sa_vat) for EVERY box
  const saBoxes = taxReturnBoxes(db, { ...period, tax_return_template: 'sa_vat' }).boxes;
  assert.ok(saBoxes.length > 0, 'sa_vat boxes must not be empty');
  for (const box of saBoxes) {
    const drill = taxBoxItems(db, { ...period, tax_return_template: 'sa_vat' }, box.code);
    assert.equal(drill.tax, box.tax, `sa_vat box ${box.code} tax must match box.tax`);
    assert.equal(drill.base, box.base, `sa_vat box ${box.code} base must match box.base`);
    const sum = round(drill.items.reduce((s, it) => s + it.tax, 0));
    assert.equal(sum, box.tax, `sa_vat box ${box.code} items sum must match box.tax`);
  }
});

test('Must hold 6: UI test: activating a box button renders its item rows and the total; aria-expanded toggles', async () => {
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();

  let db = seed();
  const yr = new Date().getFullYear();
  const vatOutAcc = accountId(db, '251000');
  const saleTax = create(db, 'account.tax', {
    name: 'Goods VAT 14%',
    amount: 14,
    amount_type: 'percent',
    type_tax_use: 'sale',
    tax_scope: 'consu',
    company_id: 1,
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100 },
      { repartition_type: 'tax', factor_percent: 100, account_id: vatOutAcc },
    ],
  });
  db = saleTax.db;

  const inv = create(db, 'account.move', {
    name: 'INV/2026/0099',
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: `${yr}-08-10`,
    company_id: 1,
    invoice_line_ids: [{ product_id: 5, qty: 10, price_unit: 100, ...taxSnapshot(read(db, 'account.tax', saleTax.id)) }],
  });
  db = postMove(inv.db, inv.id);
  db = write(db, 'res.company', 1, { tax_return_template: 'eg_vat' });

  await React.act(async () => commit(db));

  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'tax' } })));

    // Find the button for BOX-1 (Goods VAT 14%)
    const buttons = findAll(host, (node) => node.tagName === 'BUTTON' && props(node)?.['aria-expanded'] !== undefined);
    assert.ok(buttons.length > 0, 'Tax buttons with aria-expanded must be rendered');

    const box1Btn = buttons[0];
    assert.equal(props(box1Btn)['aria-expanded'], false, 'Initially aria-expanded is false');
    assert.ok(!textOf(host).includes('INV/2026/0099'), 'Detail item not yet rendered');

    // Click button to expand
    await React.act(async () => {
      props(box1Btn).onClick({ stopPropagation: () => {}, preventDefault: () => {} });
    });

    assert.equal(props(box1Btn)['aria-expanded'], true, 'aria-expanded toggles to true');
    assert.ok(textOf(host).includes('INV/2026/0099'), 'Detail item move name is rendered');
    assert.match(textOf(host), /140\.00/, 'Tax total is rendered');

    // Click again to collapse
    await React.act(async () => {
      props(box1Btn).onClick({ stopPropagation: () => {}, preventDefault: () => {} });
    });

    assert.equal(props(box1Btn)['aria-expanded'], false, 'aria-expanded toggles back to false');
    assert.ok(!textOf(host).includes('INV/2026/0099'), 'Detail item removed after collapse');

    // Also test generic mode
    const variantSelect = find(host, (node) => node.tagName === 'SELECT' && (props(node)?.['aria-label'] === 'Variant' || props(node)?.['aria-label'] === 'النوع'));
    assert.ok(variantSelect, 'Variant selector should be rendered');
    await React.act(async () => {
      props(variantSelect).onChange({ target: { value: 'generic' } });
    });

    const genRow = findAll(host, (node) => node.tagName === 'TR').find((r) => textOf(r).includes('Goods VAT 14%'));
    assert.ok(genRow, 'Generic row for Goods VAT 14% must be found');
    const genOut1Btn = find(genRow, (node) => node.tagName === 'BUTTON' && props(node)?.['aria-expanded'] !== undefined);
    assert.ok(genOut1Btn, 'Generic mode tax button with aria-expanded must be rendered');
    assert.equal(props(genOut1Btn)['aria-expanded'], false, 'Generic button initially aria-expanded is false');
    assert.ok(!textOf(host).includes('INV/2026/0099'), 'Detail item not yet rendered in generic mode');

    // Click to expand generic row
    await React.act(async () => {
      props(genOut1Btn).onClick({ stopPropagation: () => {}, preventDefault: () => {} });
    });

    assert.equal(props(genOut1Btn)['aria-expanded'], true, 'Generic button aria-expanded toggles to true');
    assert.ok(textOf(host).includes('INV/2026/0099'), 'Generic detail item move name is rendered');
    assert.match(textOf(host), /140\.00/, 'Generic tax total is rendered');

    // Click to collapse
    await React.act(async () => {
      props(genOut1Btn).onClick({ stopPropagation: () => {}, preventDefault: () => {} });
    });

    assert.equal(props(genOut1Btn)['aria-expanded'], false, 'Generic button aria-expanded toggles back to false');
    assert.ok(!textOf(host).includes('INV/2026/0099'), 'Generic detail item removed after collapse');
  } finally {
    await React.act(async () => root.unmount());
  }
});
