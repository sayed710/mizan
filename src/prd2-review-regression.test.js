import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, write } from './orm.js';
import { seed } from './seed.js';
import { generateVariants, salesModels } from './models/sales.js';
import { productTax } from './models/taxes.js';
import { isSellable } from './models/shop.js';
import { validatePosProducts } from './models/pos.js';

test('clearing tax selections removes legacy rates on both sides', () => {
  let db = seed();
  const p = create(db, 'product', { name: 'Legacy rates', sale_tax: 15, purchase_tax: 7 });
  db = write(p.db, 'product', p.id, { taxes_id: [], supplier_taxes_id: [] });
  const product = read(db, 'product', p.id);
  assert.equal(productTax(db, product, 'sale', null, 1), null);
  assert.equal(productTax(db, product, 'purchase', null, 1), null);
});

test('text variants inherit legacy rates and explicitly empty tax selections', () => {
  const p = create(seed(), 'product', { name: 'Legacy variant', attributes: 'Color: Red', sale_tax: 13, purchase_tax: 4 });
  const db = generateVariants(p.db, read(p.db, 'product', p.id));
  const variant = db.records.product.find((v) => v.variant_of === p.id);
  assert.equal(productTax(db, variant, 'sale', null, 1).tax, 13);
  assert.equal(productTax(db, variant, 'purchase', null, 1).tax, 4);
  assert.deepEqual(variant.taxes_id, []);
});

test('combo products cannot enter public channels or purchase confirmation', () => {
  const item = create(seed(), 'product', { name: 'Combo item', type: 'goods', sale_ok: true, list_price: 10 });
  const choice = create(item.db, 'product.combo', { name: 'Main', combo_item_ids: [{ product_id: item.id, extra_price: 0 }] });
  const p = create(choice.db, 'product', { name: 'Combo', type: 'combo', sale_ok: true, list_price: 10, combo_ids: [choice.id] });
  const product = read(p.db, 'product', p.id);
  assert.equal(isSellable(product), false);
  assert.throws(() => validatePosProducts(p.db, [{ product_id: p.id }], 1), /not available/);
  const confirm = salesModels['purchase.order'].form.buttons.find((b) => b.label === 'Confirm Order');
  assert.throws(() => confirm.run(p.db, { order_line: [{ product_id: p.id }] }), /cannot be purchased/);
});
import { ensureMainWarehouse } from './models/warehouse.js';
import { orderOrderpoints } from './models/orderpoint.js';
import { confirmRequisition, newQuotationFromRequisition } from './models/purchaseplus.js';
import { createSheet, reinvoiceExpenses } from './models/expenseplus.js';
import { createInvoice } from './models/fsm.js';
import { models } from './models/index.js';
import { search } from './orm.js';

const multiTaxFixture = () => {
  let db = ensureMainWarehouse(seed());
  const ids = {};
  for (const side of ['sale', 'purchase']) {
    ids[side] = [];
    for (const rate of [10, 5]) {
      const tax = create(db, 'account.tax', { name: `${side} ${rate}`, type_tax_use: side, amount_type: 'percent', amount: rate, company_id: 1 });
      db = tax.db;
      ids[side].push(tax.id);
    }
  }
  const product = create(db, 'product', { name: 'Multi tax product', type: 'goods', cost: 100, list_price: 100, vendor_id: 2, taxes_id: ids.sale, supplier_taxes_id: ids.purchase });
  return { db: product.db, id: product.id, ids };
};
const assertTaxes = (line, ids) => {
  assert.deepEqual(line.tax_ids, ids);
  assert.deepEqual(line.tax_breakdown.map((tax) => tax.tax_id), ids);
};

test('structured variants preserve both legacy percentage taxes', () => {
  let db = seed();
  const attr = create(db, 'product.attribute', { name: 'Material' });
  const value = create(attr.db, 'product.attribute.value', { name: 'Cotton', attribute_id: attr.id });
  const p = create(value.db, 'product', { name: 'Structured', sale_tax: 13, purchase_tax: 4, attribute_line_ids: [{ attribute_id: attr.id, value_ids: [value.id] }] });
  db = generateVariants(p.db, read(p.db, 'product', p.id));
  const variant = db.records.product.find((v) => v.variant_of === p.id);
  assert.equal(productTax(db, variant, 'sale', null, 1).tax, 13);
  assert.equal(productTax(db, variant, 'purchase', null, 1).tax, 4);
});

test('combo sales confirmation rejects programmatic order lines', () => {
  // Odoo 20 requires at least one combo choice on a combo product; an unconfigured combo line still cannot be confirmed.
  const item = create(seed(), 'product', { name: 'Combo item', type: 'goods', sale_ok: true, list_price: 10 });
  const choice = create(item.db, 'product.combo', { name: 'Main', combo_item_ids: [{ product_id: item.id, extra_price: 0 }] });
  const p = create(choice.db, 'product', { name: 'Combo sale', type: 'combo', sale_ok: true, list_price: 10, combo_ids: [choice.id] });
  const order = create(p.db, 'sale.order', { partner_id: 1, order_line: [{ product_id: p.id, qty: 1, price_unit: 10 }] });
  const confirm = salesModels['sale.order'].form.buttons.find((b) => b.label === 'Confirm');
  assert.throws(() => confirm.run(order.db, read(order.db, 'sale.order', order.id)), /Configure each combo before confirming the order/);
  assert.equal(read(order.db, 'sale.order', order.id).state, 'draft');
});

test('purchase line selector excludes combo while allowing goods and services', () => {
  const domain = salesModels['purchase.order'].fields.order_line.fields.product_id.domain;
  assert.equal(domain({ type: 'combo' }), false);
  assert.equal(domain({ type: 'goods' }), true);
  assert.equal(domain({ type: 'service' }), true);
});

test('replenishment and purchase agreements preserve all purchase taxes', () => {
  let { db, id, ids } = multiTaxFixture();
  const wh = search(db, 'stock.warehouse').find((w) => w.code === 'WH');
  const op = create(db, 'stock.warehouse.orderpoint', { product_id: id, warehouse_id: wh.id, location_id: wh.lot_stock_id, product_min_qty: 1, product_max_qty: 5, trigger: 'manual', route_id: 'buy' });
  db = orderOrderpoints(op.db, [op.id]);
  assertTaxes(search(db, 'purchase.order').find((o) => o.origin === 'Replenishment' && o.order_line.some((l) => l.product_id === id)).order_line.find((l) => l.product_id === id), ids.purchase);
  const req = create(db, 'purchase.requisition', { type: 'blanket', vendor_id: 2, line_ids: [{ product_id: id, product_qty: 2, price_unit: 100 }] });
  db = confirmRequisition(req.db, req.id);
  const quote = newQuotationFromRequisition(db, req.id);
  assertTaxes(read(quote.db, 'purchase.order', quote.id).order_line[0], ids.purchase);
});

test('field service invoices retain all sales taxes', () => {
  const { db, id, ids } = multiTaxFixture();
  const task = create(db, 'fsm.task', { name: 'Multi tax task', partner_id: 1, hours: 2, company_id: 1 });
  const invoice = createInvoice(task.db, read(task.db, 'fsm.task', task.id), { serviceProductId: id, hourlyRate: 100 });
  assertTaxes(read(invoice.db, 'account.move', invoice.id).invoice_line_ids[0], ids.sale);
});

test('expense product onchange totals both purchase taxes', () => {
  const { db, id } = multiTaxFixture();
  const result = models['hr.expense'].onchange({ product_id: id, quantity: 2, company_id: 1 }, 'product_id', db);
  assert.equal(result.tax, 15);
  assert.equal(result.total_amount, 230);
});

test('expense reinvoicing retains every sales tax', () => {
  const { db, id, ids } = multiTaxFixture();
  const order = create(db, 'sale.order', { partner_id: 1, order_line: [] });
  const exp = create(order.db, 'hr.expense', { name: 'Expense', employee_id: 2, product_id: id, quantity: 1, total_amount: 100, tax: 0, sale_order_id: order.id, reinvoice: 'sales_price' });
  const sheet = createSheet(exp.db, [exp.id], {});
  const posted = write(sheet.db, 'hr.expense.sheet', sheet.id, { state: 'post' });
  const result = reinvoiceExpenses(posted, sheet.id);
  assertTaxes(read(result, 'sale.order', order.id).order_line[0], ids.sale);
});
