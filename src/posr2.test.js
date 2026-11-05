import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, write } from './orm.js';
import { seed } from './seed.js';
import { accountId } from './models/ledger.js';
import { payOrder, priceLines, refundOrder, startSession } from './models/pos.js';
import { taxesByGrid } from './models/finance.js';

test('POS refund posts with tax refund side: refund tax accounts, refund tax tags and refund base tags', () => {
  const base = seed();
  const invTaxTag = create(base, 'account.account.tag', { name: 'Inv Tax Tag', applicability: 'taxes' });
  const invBaseTag = create(invTaxTag.db, 'account.account.tag', { name: 'Inv Base Tag', applicability: 'taxes' });
  const refTaxTag = create(invBaseTag.db, 'account.account.tag', { name: 'Ref Tax Tag', applicability: 'taxes' });
  const refBaseTag = create(refTaxTag.db, 'account.account.tag', { name: 'Ref Base Tag', applicability: 'taxes' });

  const invTaxAcc = create(refBaseTag.db, 'account.account', { code: '251001', name: 'Sales Tax (Inv)', account_type: 'liability_current', company_id: 1 });
  const refTaxAcc = create(invTaxAcc.db, 'account.account', { code: '251002', name: 'Sales Tax (Ref)', account_type: 'liability_current', company_id: 1 });

  const tax15 = create(refTaxAcc.db, 'account.tax', {
    name: '15% Test Tax',
    type_tax_use: 'sale',
    amount: 15,
    amount_type: 'percent',
    company_id: 1,
    active: true,
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [invBaseTag.id] },
      { repartition_type: 'tax', factor_percent: 100, account_id: invTaxAcc.id, tag_ids: [invTaxTag.id] },
    ],
    refund_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [refBaseTag.id] },
      { repartition_type: 'tax', factor_percent: 100, account_id: refTaxAcc.id, tag_ids: [refTaxTag.id] },
    ],
  });

  const incomeAcc = accountId(tax15.db, '400000');
  const prod = create(tax15.db, 'product', {
    name: 'Taxed Product',
    list_price: 100,
    type: 'consu',
    tax_id: tax15.id,
    property_account_income_id: incomeAcc,
    company_id: 1,
  });

  const opened = startSession(prod.db).db;
  const lines = priceLines(opened, [{ product_id: prod.id, qty: 1 }]);
  const sale = payOrder(opened, { lines, method: 'cash' });

  const saleOrder = read(sale.db, 'pos.order', sale.id);
  assert.equal(saleOrder.amount_total, 115);
  const saleEntry = read(sale.db, 'account.move', saleOrder.accounting_entries[0].move_id);
  const saleBaseLine = saleEntry.line_ids.find((l) => l.account_id === incomeAcc);
  assert.equal(saleBaseLine.credit, 100);
  assert.deepEqual(saleBaseLine.tax_tag_ids, [invBaseTag.id]);
  const saleTaxLine = saleEntry.line_ids.find((l) => l.account_id === invTaxAcc.id);
  assert.equal(saleTaxLine.credit, 15);
  assert.deepEqual(saleTaxLine.tax_tag_ids, [invTaxTag.id]);

  const refund = refundOrder(sale.db, saleOrder);
  const refOrder = read(refund.db, 'pos.order', refund.id);
  assert.equal(refOrder.state, 'refund');
  assert.equal(read(refund.db, 'pos.order', sale.id).state, 'refunded');

  const refEntry = read(refund.db, 'account.move', refOrder.accounting_entries[0].move_id);
  const refBaseLine = refEntry.line_ids.find((l) => l.account_id === incomeAcc);
  assert.ok(refBaseLine, 'refund base line exists on the original income account');
  assert.equal(refBaseLine.debit, 100);
  assert.deepEqual(refBaseLine.tax_tag_ids, [refBaseTag.id]);

  const refTaxLine = refEntry.line_ids.find((l) => l.account_id === refTaxAcc.id);
  assert.ok(refTaxLine, 'refund tax line uses the refund tax account');
  assert.equal(refTaxLine.debit, 15);
  assert.deepEqual(refTaxLine.tax_tag_ids, [refTaxTag.id]);

  const grid = taxesByGrid(refund.db);
  const findGrid = (tagId) => grid.find((g) => g.id === tagId);
  assert.equal(findGrid(invBaseTag.id)?.base, 100);
  assert.equal(findGrid(invTaxTag.id)?.tax, 15);
  assert.equal(findGrid(refBaseTag.id)?.base, -100);
  assert.equal(findGrid(refTaxTag.id)?.tax, -15);
});

test('POS refund preserves line income account even if product income account changed after sale', () => {
  const base = seed();
  const incomeAcc1 = accountId(base, '400000');
  const incomeAcc2 = create(base, 'account.account', { code: '400002', name: 'New Sales Account', account_type: 'income', company_id: 1 });

  const prod = create(incomeAcc2.db, 'product', {
    name: 'Changing Account Product',
    list_price: 100,
    type: 'consu',
    property_account_income_id: incomeAcc1,
    company_id: 1,
  });

  const opened = startSession(prod.db).db;
  const lines = priceLines(opened, [{ product_id: prod.id, qty: 1 }]);
  const sale = payOrder(opened, { lines, method: 'cash' });
  const saleOrder = read(sale.db, 'pos.order', sale.id);

  assert.equal(saleOrder.lines[0].income_account_id, incomeAcc1);

  const changedDb = write(sale.db, 'product', prod.id, { property_account_income_id: incomeAcc2.id });
  const refund = refundOrder(changedDb, read(changedDb, 'pos.order', sale.id));
  const refOrder = read(refund.db, 'pos.order', refund.id);
  const refEntry = read(refund.db, 'account.move', refOrder.accounting_entries[0].move_id);

  const refBaseLine = refEntry.line_ids.find((l) => l.account_id === incomeAcc1);
  assert.ok(refBaseLine, 'refund entry still posts to original income account');
  assert.equal(refEntry.line_ids.some((l) => l.account_id === incomeAcc2.id), false);
});

test('zero-rate tax without refund rows refunds fine; nonzero tax without refund rows is rejected and nothing written', () => {
  const base = seed();
  const taxAccount = create(base, 'account.account', { code: '251009', name: 'Test Tax Account', account_type: 'liability_current', company_id: 1 });

  const zeroTaxId = 9101;
  const zeroTax = {
    id: zeroTaxId,
    name: '0% Tax Without Refund Rows',
    type_tax_use: 'sale',
    amount: 0,
    amount_type: 'percent',
    company_id: 1,
    active: true,
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 100, account_id: null, tag_ids: [] },
    ],
    refund_repartition_line_ids: [],
  };

  const nonzeroTaxId = 9102;
  const nonzeroTax = {
    id: nonzeroTaxId,
    name: '15% Tax Without Refund Rows',
    type_tax_use: 'sale',
    amount: 15,
    amount_type: 'percent',
    company_id: 1,
    active: true,
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 100, account_id: taxAccount.id, tag_ids: [] },
    ],
    refund_repartition_line_ids: [],
  };

  const dbWithTaxes = {
    ...taxAccount.db,
    records: {
      ...taxAccount.db.records,
      'account.tax': [...(taxAccount.db.records['account.tax'] ?? []), zeroTax, nonzeroTax],
    },
  };

  const prodZero = create(dbWithTaxes, 'product', { name: 'Zero Tax Product', list_price: 100, type: 'consu', tax_id: zeroTaxId, company_id: 1 });
  const prodNonzero = create(prodZero.db, 'product', { name: 'Nonzero Tax Product', list_price: 100, type: 'consu', tax_id: nonzeroTaxId, company_id: 1 });

  const opened = startSession(prodNonzero.db).db;

  // Zero-tax order refunds fine
  const zeroLines = priceLines(opened, [{ product_id: prodZero.id, qty: 1 }]);
  const zeroSale = payOrder(opened, { lines: zeroLines, method: 'cash' });
  const zeroRefund = refundOrder(zeroSale.db, read(zeroSale.db, 'pos.order', zeroSale.id));
  assert.equal(read(zeroRefund.db, 'pos.order', zeroSale.id).state, 'refunded');

  // Nonzero tax without refund rows is rejected and nothing written
  const nonzeroLines = priceLines(opened, [{ product_id: prodNonzero.id, qty: 1 }]);
  const nonzeroSale = payOrder(opened, { lines: nonzeroLines, method: 'cash' });
  const beforeRefund = structuredClone(nonzeroSale.db);
  const nonzeroSaleOrder = read(nonzeroSale.db, 'pos.order', nonzeroSale.id);

  assert.throws(
    () => refundOrder(nonzeroSale.db, nonzeroSaleOrder),
    /has no refund distribution lines/i
  );
  assert.deepEqual(nonzeroSale.db, beforeRefund);
});
