import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from './orm.js';
import { seed } from './seed.js';
import { models } from './models/index.js';
import { amounts } from './models/common.js';
import { postMove } from './models/accounting.js';
import { isBalanced } from './models/ledger.js';
import { defaultTaxRepartitionLines } from './models/taxes.js';

test('1. tax_ids is exposed as the editable Taxes field and tax_id stays hidden', () => {
  const invLineDef = models['account.move'].fields.invoice_line_ids;
  const saleLineDef = models['sale.order'].fields.order_line;
  const purchLineDef = models['purchase.order'].fields.order_line;

  for (const [name, def] of [
    ['account.move', invLineDef],
    ['sale.order', saleLineDef],
    ['purchase.order', purchLineDef],
  ]) {
    const taxIdsField = def.fields.tax_ids;
    assert.ok(taxIdsField, `${name} has tax_ids field`);
    assert.equal(taxIdsField.type, 'many2many');
    assert.equal(taxIdsField.relation, 'account.tax');
    assert.equal(taxIdsField.label, 'Taxes');
    assert.equal(taxIdsField.widget, 'many2many_tags');
    assert.ok(!taxIdsField.hidden, `${name} tax_ids is not hidden`);

    const taxIdField = def.fields.tax_id;
    assert.ok(taxIdField, `${name} has tax_id field`);
    assert.equal(taxIdField.hidden, true, `${name} tax_id stays hidden`);
  }
});

test('2. invoiceLineField domain and rateOnlyText on tax_ids', () => {
  const db = seed();
  const invLineDef = models['account.move'].fields.invoice_line_ids;
  const taxIdsField = invLineDef.fields.tax_ids;
  assert.ok(typeof taxIdsField.domain === 'function', 'tax_ids has domain function');

  const saleTax = search(db, 'account.tax').find((t) => t.type_tax_use === 'sale' && t.active !== false);
  const purchTax = search(db, 'account.tax').find((t) => t.type_tax_use === 'purchase' && t.active !== false);
  assert.ok(saleTax && purchTax);

  const saleLine = { move_type: 'out_invoice', company_id: 1 };
  assert.equal(taxIdsField.domain(saleTax, saleLine, db), true);
  assert.equal(taxIdsField.domain(purchTax, saleLine, db), false);

  const billLine = { move_type: 'in_invoice', company_id: 1 };
  assert.equal(taxIdsField.domain(purchTax, billLine, db), true);
  assert.equal(taxIdsField.domain(saleTax, billLine, db), false);

  // Inactive or other company taxes are excluded
  assert.equal(taxIdsField.domain({ ...saleTax, active: false }, saleLine, db), false);
  assert.equal(taxIdsField.domain({ ...saleTax, company_id: 999 }, saleLine, db), false);

  // rateOnlyText displays plain percentage when no tax_id
  assert.equal(taxIdsField.rateOnlyText?.({ tax: 14 }), '14%');
  assert.equal(taxIdsField.rateOnlyText?.({ tax_id: saleTax.id, tax: 14 }), null);
  // A line saved with only tax_id still shows that tax in the Taxes tags.
  assert.deepEqual(taxIdsField.valueFallback({ tax_id: saleTax.id, tax_ids: [] }), [saleTax.id]);
  assert.deepEqual(taxIdsField.valueFallback({ tax: 14 }), []);
});

test('3. newLine carries company default tax into both tax_ids and tax_id', () => {
  const db = seed();
  const invLineDef = models['account.move'].fields.invoice_line_ids;
  const saleMove = { move_type: 'out_invoice', company_id: 1 };
  const line = invLineDef.newLine(saleMove, db);

  const comp = read(db, 'res.company', 1);
  assert.equal(line.tax_id, comp.account_sale_tax_id);
  assert.deepEqual(line.tax_ids, [comp.account_sale_tax_id]);

  const billMove = { move_type: 'in_invoice', company_id: 1 };
  const billLine = invLineDef.newLine(billMove, db);
  assert.equal(billLine.tax_id, comp.account_purchase_tax_id);
  assert.deepEqual(billLine.tax_ids, [comp.account_purchase_tax_id]);
});

test('4. onchange with tax_ids keeps tax_id consistent with the first tax', () => {
  let db = seed();
  const vatAccount = search(db, 'account.account').find((a) => a.code === '251000').id;
  const taxA = create(db, 'account.tax', { name: 'Tax A 10%', amount_type: 'percent', amount: 10, type_tax_use: 'sale', ...defaultTaxRepartitionLines(vatAccount, []) });
  db = taxA.db;
  const taxB = create(db, 'account.tax', { name: 'Tax B 5%', amount_type: 'percent', amount: 5, type_tax_use: 'sale', ...defaultTaxRepartitionLines(vatAccount, []) });
  db = taxB.db;

  const invLineDef = models['account.move'].fields.invoice_line_ids;
  const move = { move_type: 'out_invoice', company_id: 1 };

  // Select two taxes: tax_id becomes taxA.id, tax_ids is [taxA.id, taxB.id]
  const line2 = invLineDef.onchange(
    { product_id: 1, qty: 1, price_unit: 100, tax_ids: [taxA.id, taxB.id] },
    'tax_ids',
    db,
    move
  );
  assert.equal(line2.tax_id, taxA.id);
  assert.deepEqual(line2.tax_ids, [taxA.id, taxB.id]);
  assert.equal(line2.tax_breakdown.length, 2);
  assert.equal(line2.tax_breakdown[0].tax_id, taxA.id);
  assert.equal(line2.tax_breakdown[1].tax_id, taxB.id);

  // Remove taxA: tax_id becomes taxB.id
  const line1 = invLineDef.onchange(
    { ...line2, tax_ids: [taxB.id] },
    'tax_ids',
    db,
    move
  );
  assert.equal(line1.tax_id, taxB.id);
  assert.deepEqual(line1.tax_ids, [taxB.id]);
  assert.equal(line1.tax_breakdown.length, 1);
  assert.equal(line1.tax_breakdown[0].tax_id, taxB.id);

  // Clear all taxes: tax_id becomes null, tax_ids is []
  const line0 = invLineDef.onchange(
    { ...line1, tax_ids: [] },
    'tax_ids',
    db,
    move
  );
  assert.equal(line0.tax_id, null);
  assert.deepEqual(line0.tax_ids, []);
  assert.deepEqual(line0.tax_breakdown, []);
  assert.equal(line0.tax, 0);

  // Legacy tax_id change keeps tax_ids consistent
  const lineLegacy = invLineDef.onchange(
    { product_id: 1, qty: 1, price_unit: 100, tax_id: taxA.id },
    'tax_id',
    db,
    move
  );
  assert.equal(lineLegacy.tax_id, taxA.id);
  assert.deepEqual(lineLegacy.tax_ids, [taxA.id]);
});

test('5. amounts and invoice computations use all selected taxes', () => {
  let db = seed();
  const vatAccount = search(db, 'account.account').find((a) => a.code === '251000').id;
  const vat10 = create(db, 'account.tax', { name: 'VAT 10%', amount_type: 'percent', amount: 10, type_tax_use: 'sale', ...defaultTaxRepartitionLines(vatAccount, []) });
  db = vat10.db;
  const eco5 = create(db, 'account.tax', { name: 'Eco 5%', amount_type: 'percent', amount: 5, type_tax_use: 'sale', ...defaultTaxRepartitionLines(vatAccount, []) });
  db = eco5.db;

  const invLineDef = models['account.move'].fields.invoice_line_ids;
  const move = { move_type: 'out_invoice', company_id: 1 };
  const line = invLineDef.onchange(
    { product_id: 1, qty: 2, price_unit: 100, discount: 0, tax_ids: [vat10.id, eco5.id] },
    'tax_ids',
    db,
    move
  );

  // Base: 200. Tax: 200 * 10% (20) + 200 * 5% (10) = 30. Total: 230.
  const calc = amounts([line]);
  assert.equal(calc.untaxed, 200);
  assert.equal(calc.tax, 30);
  assert.equal(calc.total, 230);
});

test('6. posting invoice with multiple taxes creates journal items for all taxes', () => {
  let db = seed();
  const revAccount = search(db, 'account.account').find((a) => a.code === '400000').id;
  const vatAccount = search(db, 'account.account').find((a) => a.code === '251000').id;
  const ecoAccount = create(db, 'account.account', { code: '251001', name: 'Eco Tax Payable', account_type: 'liability_current' });
  db = ecoAccount.db;

  const vat10 = create(db, 'account.tax', { name: 'VAT 10%', amount_type: 'percent', amount: 10, type_tax_use: 'sale', ...defaultTaxRepartitionLines(vatAccount, []) });
  db = vat10.db;
  const eco5 = create(db, 'account.tax', { name: 'Eco 5%', amount_type: 'percent', amount: 5, type_tax_use: 'sale', ...defaultTaxRepartitionLines(ecoAccount.id, []) });
  db = eco5.db;

  const invLineDef = models['account.move'].fields.invoice_line_ids;
  const moveCtx = { move_type: 'out_invoice', company_id: 1 };
  const line = invLineDef.onchange(
    { name: 'Dual Tax Item', product_id: 1, account_id: revAccount, qty: 1, price_unit: 100, discount: 0, tax_ids: [vat10.id, eco5.id] },
    'tax_ids',
    db,
    moveCtx
  );

  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-06-01',
    invoice_line_ids: [line],
  });
  db = postMove(inv.db, inv.id);

  const posted = read(db, 'account.move', inv.id);
  assert.equal(posted.state, 'posted');
  assert.equal(posted.amount_untaxed, 100);
  assert.equal(posted.amount_tax, 15);
  assert.equal(posted.amount_total, 115);
  assert.ok(isBalanced(posted.line_ids));

  // Find tax lines
  const vatLine = posted.line_ids.find((l) => l.account_id === vatAccount);
  const ecoLine = posted.line_ids.find((l) => l.account_id === ecoAccount.id);
  assert.ok(vatLine, 'VAT journal item exists');
  assert.ok(ecoLine, 'Eco tax journal item exists');
  assert.equal(vatLine.credit, 10);
  assert.equal(vatLine.tax_id, vat10.id);
  assert.equal(ecoLine.credit, 5);
  assert.equal(ecoLine.tax_id, eco5.id);
});

test('7. vendor bill with multiple purchase taxes calculates and posts correctly', () => {
  let db = seed();
  const expAccount = search(db, 'account.account').find((a) => a.code === '600000').id;
  const purchVatAccount = search(db, 'account.account').find((a) => a.code === '131000').id;
  const purchDutyAccount = create(db, 'account.account', { code: '131001', name: 'Customs Duty', account_type: 'asset_current' });
  db = purchDutyAccount.db;

  const purchVat = create(db, 'account.tax', { name: 'Purch VAT 14%', amount_type: 'percent', amount: 14, type_tax_use: 'purchase', ...defaultTaxRepartitionLines(purchVatAccount, []) });
  db = purchVat.db;
  const purchDuty = create(db, 'account.tax', { name: 'Purch Duty 6%', amount_type: 'percent', amount: 6, type_tax_use: 'purchase', ...defaultTaxRepartitionLines(purchDutyAccount.id, []) });
  db = purchDuty.db;

  const invLineDef = models['account.move'].fields.invoice_line_ids;
  const billCtx = { move_type: 'in_invoice', company_id: 1 };
  const line = invLineDef.onchange(
    { name: 'Import Materials', product_id: 1, account_id: expAccount, qty: 10, price_unit: 50, discount: 0, tax_ids: [purchVat.id, purchDuty.id] },
    'tax_ids',
    db,
    billCtx
  );

  assert.equal(line.tax_id, purchVat.id);
  assert.deepEqual(line.tax_ids, [purchVat.id, purchDuty.id]);

  // Base: 500. Tax: 14% (70) + 6% (30) = 100. Total: 600.
  const calc = amounts([line]);
  assert.equal(calc.untaxed, 500);
  assert.equal(calc.tax, 100);
  assert.equal(calc.total, 600);

  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 1,
    invoice_date: '2026-06-01',
    invoice_line_ids: [line],
  });
  db = postMove(bill.db, bill.id);

  const posted = read(db, 'account.move', bill.id);
  assert.equal(posted.state, 'posted');
  assert.equal(posted.amount_untaxed, 500);
  assert.equal(posted.amount_tax, 100);
  assert.equal(posted.amount_total, 600);
  assert.ok(isBalanced(posted.line_ids));

  const vatItem = posted.line_ids.find((l) => l.account_id === purchVatAccount);
  const dutyItem = posted.line_ids.find((l) => l.account_id === purchDutyAccount.id);
  assert.ok(vatItem, 'Purchase VAT item exists');
  assert.ok(dutyItem, 'Customs Duty item exists');
  assert.equal(vatItem.debit, 70);
  assert.equal(dutyItem.debit, 30);
});

test('8. group tax combined with another tax in tax_ids expands all components and computes accurately', () => {
  let db = seed();
  const vatAccount = search(db, 'account.account').find((a) => a.code === '251000').id;
  const child1 = create(db, 'account.tax', { name: 'Child 1 6%', amount_type: 'percent', amount: 6, type_tax_use: 'sale', ...defaultTaxRepartitionLines(vatAccount, []) });
  db = child1.db;
  const child2 = create(db, 'account.tax', { name: 'Child 2 4%', amount_type: 'percent', amount: 4, type_tax_use: 'sale', ...defaultTaxRepartitionLines(vatAccount, []) });
  db = child2.db;
  const group = create(db, 'account.tax', { name: 'Group 10%', amount_type: 'group', type_tax_use: 'sale', children_tax_ids: [child1.id, child2.id] });
  db = group.db;

  const extra = create(db, 'account.tax', { name: 'Extra 5%', amount_type: 'percent', amount: 5, type_tax_use: 'sale', ...defaultTaxRepartitionLines(vatAccount, []) });
  db = extra.db;

  const invLineDef = models['account.move'].fields.invoice_line_ids;
  const moveCtx = { move_type: 'out_invoice', company_id: 1 };
  const line = invLineDef.onchange(
    { product_id: 1, qty: 1, price_unit: 100, discount: 0, tax_ids: [group.id, extra.id] },
    'tax_ids',
    db,
    moveCtx
  );

  // First selected tax is group
  assert.equal(line.tax_id, group.id);
  assert.deepEqual(line.tax_ids, [group.id, extra.id]);

  // Breakdown expands children of group + extra: child1 (6%), child2 (4%), extra (5%)
  assert.equal(line.tax_breakdown.length, 3);
  const breakdownIds = line.tax_breakdown.map((t) => t.tax_id);
  assert.ok(breakdownIds.includes(child1.id));
  assert.ok(breakdownIds.includes(child2.id));
  assert.ok(breakdownIds.includes(extra.id));

  // Calculation: 100 * (6% + 4% + 5%) = 15
  const calc = amounts([line]);
  assert.equal(calc.untaxed, 100);
  assert.equal(calc.tax, 15);
  assert.equal(calc.total, 115);
});

test('9. compound taxes in tax_ids compute cascading bases correctly', () => {
  let db = seed();
  const vatAccount = search(db, 'account.account').find((a) => a.code === '251000').id;
  // Tax 1: 10%, affects base of subsequent taxes
  const tax1 = create(db, 'account.tax', {
    name: 'Excise 10%',
    amount_type: 'percent',
    amount: 10,
    sequence: 1,
    include_base_amount: true,
    type_tax_use: 'sale',
    ...defaultTaxRepartitionLines(vatAccount, []),
  });
  db = tax1.db;

  // Tax 2: 10%, base affected by previous taxes
  const tax2 = create(db, 'account.tax', {
    name: 'VAT on Excise 10%',
    amount_type: 'percent',
    amount: 10,
    sequence: 2,
    is_base_affected: true,
    type_tax_use: 'sale',
    ...defaultTaxRepartitionLines(vatAccount, []),
  });
  db = tax2.db;

  const invLineDef = models['account.move'].fields.invoice_line_ids;
  const line = invLineDef.onchange(
    { product_id: 1, qty: 1, price_unit: 100, discount: 0, tax_ids: [tax1.id, tax2.id] },
    'tax_ids',
    db,
    { move_type: 'out_invoice', company_id: 1 }
  );

  // Untaxed base: 100.
  // Tax 1: 100 * 10% = 10. Base of Tax 2 becomes 100 + 10 = 110.
  // Tax 2: 110 * 10% = 11.
  // Total tax: 10 + 11 = 21. Total: 121.
  const calc = amounts([line]);
  assert.equal(calc.untaxed, 100);
  assert.equal(calc.tax, 21);
  assert.equal(calc.total, 121);
});

test('10. sale.order order_line with multiple taxes computes amounts and creates order', () => {
  let db = seed();
  const vatAccount = search(db, 'account.account').find((a) => a.code === '251000').id;
  const vat10 = create(db, 'account.tax', { name: 'VAT 10%', amount_type: 'percent', amount: 10, type_tax_use: 'sale', ...defaultTaxRepartitionLines(vatAccount, []) });
  db = vat10.db;
  const stamp = create(db, 'account.tax', { name: 'Stamp 5', amount_type: 'fixed', amount: 5, type_tax_use: 'sale', ...defaultTaxRepartitionLines(vatAccount, []) });
  db = stamp.db;

  const orderLineDef = models['sale.order'].fields.order_line;
  const orderLine = orderLineDef.onchange(
    { product_id: 1, qty: 2, price_unit: 50, discount: 0, tax_ids: [vat10.id, stamp.id] },
    'tax_ids',
    db,
    {}
  );

  assert.equal(orderLine.tax_id, vat10.id);
  assert.deepEqual(orderLine.tax_ids, [vat10.id, stamp.id]);

  // Base: 2 * 50 = 100.
  // VAT 10% = 10. Stamp: qty 2 * 5 = 10. Total tax = 20. Total = 120.
  const calc = amounts([orderLine]);
  assert.equal(calc.untaxed, 100);
  assert.equal(calc.tax, 20);
  assert.equal(calc.total, 120);

  const { db: nextDb, id: orderId } = create(db, 'sale.order', {
    partner_id: 1,
    order_line: [orderLine],
  });
  const order = read(nextDb, 'sale.order', orderId);
  assert.equal(order.amount_untaxed, 100);
  assert.equal(order.amount_tax, 20);
  assert.equal(order.amount_total, 120);
});
