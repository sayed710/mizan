import { test } from 'node:test';
import assert from 'node:assert/strict';
import './models/index.js';
import { models } from './models/index.js';
import { seed } from './seed.js';
import { create, read, search, updateSettings, write } from './orm.js';
import { createCompany } from './models/company.js';
import { postMove } from './models/accounting.js';
import { accountId, journalItems } from './models/ledger.js';
import { valuationReport } from './models/valuation.js';

const run = (db, model, id, label, options) => {
  const btn = models[model].form.buttons.find((b) => b.label === label);
  if (!btn) throw new Error(`Button "${label}" not found on ${model}`);
  return btn.run(db, read(db, model, id), options).db;
};

const balance = (state, code, company = null) => {
  const id = accountId(state, code, company);
  return Math.round(journalItems(state).filter((l) => l.account_id === id).reduce((s, l) => s + l.debit - l.credit, 0) * 100) / 100;
};

test('sale order of company 2 creates invoice belonging to company 2 and uses company 2 accounts and journals', () => {
  let db = seed();
  const co = createCompany(db, { name: 'Order branch' });
  db = updateSettings(co.db, { current_company_id: 1, allowed_company_ids: [1, co.id] });

  // Create accounts and journal for company 2
  const invJournalCo2 = create(db, 'account.journal', { name: 'Customer Invoices Co2', code: 'INV', type: 'sale', company_id: co.id, invoice_sequence_prefix: 'CO2-INV/', invoice_sequence_next_number: 1, refund_sequence_prefix: 'CO2-RINV/', refund_sequence_next_number: 1, default_account_id: accountId(db, '400000', co.id) });
  db = invJournalCo2.db;

  const sale = create(db, 'sale.order', {
    company_id: co.id,
    partner_id: 3,
    order_line: [{ product_id: 7, qty: 2, price_unit: 100, tax: 0 }],
  });
  db = run(sale.db, 'sale.order', sale.id, 'Confirm');
  db = run(db, 'sale.order', sale.id, 'Create Invoice');

  const inv = search(db, 'account.move').find((m) => m.sale_id === sale.id);
  assert.ok(inv, 'invoice created from sale order');
  assert.equal(inv.company_id, co.id, 'invoice must belong to order company');
  assert.equal(inv.journal_id, invJournalCo2.id, 'invoice must use company 2 journal');

  // Confirm / post the invoice
  db = run(db, 'account.move', inv.id, 'Confirm');
  const posted = read(db, 'account.move', inv.id);
  assert.equal(posted.state, 'posted');
  assert.equal(posted.company_id, co.id);
  assert.equal(posted.journal_id, invJournalCo2.id);
  for (const line of posted.line_ids) {
    const acc = read(db, 'account.account', line.account_id);
    assert.ok(!acc.company_id || acc.company_id === co.id, `line account ${acc.code} belongs to invoice company`);
  }
});

test('down payment for sale order of company 2 belongs to company 2 and posts successfully', () => {
  let db = seed();
  const co = createCompany(db, { name: 'Order branch DP' });
  db = updateSettings(co.db, { current_company_id: 1, allowed_company_ids: [1, co.id] });

  // 1. Down payment via Create Invoice wizard with percentage
  const sale = create(db, 'sale.order', {
    company_id: co.id,
    partner_id: 3,
    order_line: [{ product_id: 7, qty: 2, price_unit: 100, tax: 0 }],
  });
  db = run(sale.db, 'sale.order', sale.id, 'Confirm');
  db = run(db, 'sale.order', sale.id, 'Create Invoice', { method: 'percentage', amount: 30 });

  const inv = search(db, 'account.move').find((m) => m.sale_id === sale.id);
  assert.ok(inv, 'down payment invoice created');
  assert.equal(inv.company_id, co.id, 'down payment invoice must belong to order company');

  db = run(db, 'account.move', inv.id, 'Confirm');
  const posted = read(db, 'account.move', inv.id);
  assert.equal(posted.state, 'posted');
  assert.equal(posted.company_id, co.id);

  // 2. Down Payment button for delivery-policy product
  const pDeliv = create(db, 'product', {
    name: 'Delivery Goods',
    type: 'goods',
    invoice_policy: 'delivery',
    list_price: 100,
    qty_available: 0,
  });
  db = pDeliv.db;
  const sale2 = create(db, 'sale.order', {
    company_id: co.id,
    partner_id: 3,
    order_line: [{ product_id: pDeliv.id, qty: 2, price_unit: 100, tax: 0 }],
  });
  db = run(sale2.db, 'sale.order', sale2.id, 'Confirm');
  db = run(db, 'sale.order', sale2.id, 'Down Payment', { method: 'percentage', amount: 40 });
  const inv2 = search(db, 'account.move').find((m) => m.sale_id === sale2.id);
  assert.ok(inv2, 'down payment invoice created via Down Payment button');
  assert.equal(inv2.company_id, co.id);
  db = run(db, 'account.move', inv2.id, 'Confirm');
  assert.equal(read(db, 'account.move', inv2.id).state, 'posted');
});

test('posting rejects company mismatch between order and invoice/bill', () => {
  let db = seed();
  const co = createCompany(db, { name: 'Order branch mismatch' });
  db = updateSettings(co.db, { current_company_id: 1, allowed_company_ids: [1, co.id] });

  // Sale order in company 2
  const sale = create(db, 'sale.order', {
    company_id: co.id,
    partner_id: 3,
    order_line: [{ product_id: 7, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = run(sale.db, 'sale.order', sale.id, 'Confirm');

  // Manually construct an invoice in company 1 linking to company 2's sale order
  const mismatchedInv = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: 3,
    sale_id: sale.id,
    invoice_line_ids: [{ product_id: 7, qty: 1, price_unit: 100, tax: 0 }],
  });

  assert.throws(
    () => postMove(mismatchedInv.db, mismatchedInv.id),
    /company/i,
    'posting invoice with mismatched sale order company must be rejected'
  );

  // Purchase order in company 2
  const po = create(db, 'purchase.order', {
    company_id: co.id,
    partner_id: 2,
    order_line: [{ product_id: 7, qty: 1, price_unit: 50, tax: 0 }],
  });
  db = run(po.db, 'purchase.order', po.id, 'Confirm Order');

  // Mismatched bill in company 1
  const mismatchedBill = create(db, 'account.move', {
    move_type: 'in_invoice',
    company_id: 1,
    partner_id: 2,
    purchase_id: po.id,
    invoice_line_ids: [{ product_id: 7, qty: 1, price_unit: 50, tax: 0 }],
  });

  assert.throws(
    () => postMove(mismatchedBill.db, mismatchedBill.id),
    /company/i,
    'posting bill with mismatched purchase order company must be rejected'
  );
});

test('FIFO product: price difference clears interim account and values stock layer when bill comes before receipt', () => {
  let db = seed();
  const p = create(db, 'product', {
    name: 'Bill first FIFO probe',
    type: 'goods',
    cost: 10,
    cost_method: 'fifo',
    valuation: 'real_time',
    purchase_method: 'purchase',
    qty_available: 0,
  });
  const po = create(p.db, 'purchase.order', {
    partner_id: 2,
    order_line: [{ product_id: p.id, qty: 5, price_unit: 10, tax: 0 }],
  });
  db = run(po.db, 'purchase.order', po.id, 'Confirm Order');
  const start = db;

  // Bill comes first: 5 units at price 12 (total 60)
  db = run(db, 'purchase.order', po.id, 'Create Bill');
  const bill = search(db, 'account.move').find((m) => m.purchase_id === po.id);
  db = write(db, 'account.move', bill.id, {
    invoice_line_ids: bill.invoice_line_ids.map((l) => ({ ...l, price_unit: 12 })),
  });
  db = postMove(db, bill.id);

  const delta = (state, code) => Math.round((balance(state, code) - balance(start, code)) * 100) / 100;

  // Bill posted 60 to interim
  assert.equal(delta(db, '110200'), 60);
  assert.equal(delta(db, '110100'), 0);

  // Later, receipt arrives (Validate picking)
  const picking = search(db, 'stock.picking').find((x) => x.purchase_id === po.id);
  db = run(db, 'stock.picking', picking.id, 'Validate');

  // Interim account must be cleared to 0
  assert.equal(delta(db, '110200'), 0, 'interim account must end at 0');
  // Stock valuation must reflect the billed cost (60)
  assert.equal(delta(db, '110100'), 60, 'valuation account must reflect billed amount');
  // Price difference / expense is 0 for FIFO
  assert.equal(delta(db, '600000'), 0, 'no price difference in expense for FIFO');

  const layers = search(db, 'stock.valuation.layer').filter((l) => l.product_id === p.id);
  assert.equal(layers.length, 1);
  assert.equal(layers[0].value, 60, 'layer value must be 60');
  assert.equal(layers[0].unit_cost, 12, 'layer unit_cost must be 12');
  assert.equal(layers[0].price_difference, 0);

  const report = valuationReport(db, { at: '9999-12-31' })[p.id];
  assert.deepEqual(report, { qty: 5, value: 60, unitCost: 12 });
});

test('standard costing: price difference clears interim account and posts variance to price difference account when bill comes before receipt', () => {
  let db = seed();
  const p = create(db, 'product', {
    name: 'Bill first Standard probe',
    type: 'goods',
    cost: 10,
    cost_method: 'standard',
    valuation: 'real_time',
    purchase_method: 'purchase',
    qty_available: 0,
  });
  const po = create(p.db, 'purchase.order', {
    partner_id: 2,
    order_line: [{ product_id: p.id, qty: 5, price_unit: 10, tax: 0 }],
  });
  db = run(po.db, 'purchase.order', po.id, 'Confirm Order');
  const start = db;

  // Bill comes first: 5 units at price 12 (total 60)
  db = run(db, 'purchase.order', po.id, 'Create Bill');
  const bill = search(db, 'account.move').find((m) => m.purchase_id === po.id);
  db = write(db, 'account.move', bill.id, {
    invoice_line_ids: bill.invoice_line_ids.map((l) => ({ ...l, price_unit: 12 })),
  });
  db = postMove(db, bill.id);

  const delta = (state, code) => Math.round((balance(state, code) - balance(start, code)) * 100) / 100;
  assert.equal(delta(db, '110200'), 60);

  // Later, receipt arrives (Validate picking)
  const picking = search(db, 'stock.picking').find((x) => x.purchase_id === po.id);
  db = run(db, 'stock.picking', picking.id, 'Validate');

  // Interim account must be cleared to 0
  assert.equal(delta(db, '110200'), 0, 'interim account must end at 0');
  // Stock valuation remains at standard cost (50)
  assert.equal(delta(db, '110100'), 50, 'valuation account must be standard value 50');
  // Price difference of 10 posted to expense (600000)
  assert.equal(delta(db, '600000'), 10, 'price difference of 10 must be in 600000');

  const layers = search(db, 'stock.valuation.layer').filter((l) => l.product_id === p.id);
  assert.equal(layers.length, 1);
  assert.equal(layers[0].value, 50, 'layer value must be 50');
  assert.equal(layers[0].price_difference, 10, 'layer price_difference must be 10');

  const report = valuationReport(db, { at: '9999-12-31' })[p.id];
  assert.deepEqual(report, { qty: 5, value: 50, unitCost: 10 });
});

test('purchase order of company 2 creates bill belonging to company 2 and posts successfully', () => {
  let db = seed();
  const co = createCompany(db, { name: 'Purchase branch' });
  db = updateSettings(co.db, { current_company_id: 1, allowed_company_ids: [1, co.id] });

  const billJournalCo2 = create(db, 'account.journal', { name: 'Vendor Bills Co2', code: 'BILL', type: 'purchase', company_id: co.id, invoice_sequence_prefix: 'CO2-BILL/', invoice_sequence_next_number: 1, refund_sequence_prefix: 'CO2-RBILL/', refund_sequence_next_number: 1, default_account_id: accountId(db, '600000', co.id) });
  db = billJournalCo2.db;

  const p = create(db, 'product', {
    name: 'PO Goods',
    type: 'goods',
    purchase_method: 'purchase',
    list_price: 50,
    cost: 40,
    qty_available: 0,
  });
  db = p.db;

  const po = create(db, 'purchase.order', {
    company_id: co.id,
    partner_id: 2,
    order_line: [{ product_id: p.id, qty: 3, price_unit: 40, tax: 0 }],
  });
  db = run(po.db, 'purchase.order', po.id, 'Confirm Order');
  db = run(db, 'purchase.order', po.id, 'Create Bill');

  const bill = search(db, 'account.move').find((m) => m.purchase_id === po.id);
  assert.ok(bill, 'bill created from purchase order');
  assert.equal(bill.company_id, co.id, 'bill must belong to order company');
  assert.equal(bill.journal_id, billJournalCo2.id, 'bill must use company 2 journal');

  db = run(db, 'account.move', bill.id, 'Confirm');
  const posted = read(db, 'account.move', bill.id);
  assert.equal(posted.state, 'posted');
  assert.equal(posted.company_id, co.id);
  assert.equal(posted.journal_id, billJournalCo2.id);
});

test('receipt-first order continues to clear interim account for standard and FIFO products', () => {
  let db = seed();
  const pFifo = create(db, 'product', {
    name: 'Receipt first FIFO',
    type: 'goods',
    cost: 10,
    cost_method: 'fifo',
    valuation: 'real_time',
    purchase_method: 'purchase',
    qty_available: 0,
  });
  const po = create(pFifo.db, 'purchase.order', {
    partner_id: 2,
    order_line: [{ product_id: pFifo.id, qty: 5, price_unit: 10, tax: 0 }],
  });
  db = run(po.db, 'purchase.order', po.id, 'Confirm Order');
  const start = db;

  // Receipt first
  const picking = search(db, 'stock.picking').find((x) => x.purchase_id === po.id);
  db = run(db, 'stock.picking', picking.id, 'Validate');

  // Then bill at 12 (price difference of 10)
  db = run(db, 'purchase.order', po.id, 'Create Bill');
  const bill = search(db, 'account.move').find((m) => m.purchase_id === po.id);
  db = write(db, 'account.move', bill.id, {
    invoice_line_ids: bill.invoice_line_ids.map((l) => ({ ...l, price_unit: 12 })),
  });
  db = postMove(db, bill.id);

  const delta = (state, code) => Math.round((balance(state, code) - balance(start, code)) * 100) / 100;
  assert.equal(delta(db, '110200'), 0, 'interim account must end at 0 in receipt-first');
  assert.equal(delta(db, '110100'), 50, 'valuation account is 50');
  assert.equal(delta(db, '600000'), 10, 'price difference goes to expense');
});
