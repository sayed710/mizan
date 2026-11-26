import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { models } from './models/index.js';
import { create, read } from './orm.js';
import { applyDiff, diffDb } from './sync.js';
import { newDefaults } from './views/formDefaults.js';
import { productTax } from './models/taxes.js';

const sync = (base, changed) => applyDiff(base, diffDb(base, changed), { isAdmin: true });

test('combo choices validate through synchronization', () => {
  let db = seed();
  const item = create(db, 'product', { name: 'Choice', list_price: 12 }); db = item.db;
  const choice = create(db, 'product.combo', { name: 'Main', combo_item_ids: [{ product_id: item.id, extra_price: 2 }] }); db = sync(db, choice.db);
  const bundle = create(db, 'product', { name: 'Bundle', type: 'combo', combo_ids: [choice.id], list_price: 20 }); db = sync(db, bundle.db);
  assert.equal(read(db, 'product.combo', choice.id).base_price, 12);
  assert.equal(read(db, 'product', bundle.id).purchase_ok, false);
  for (const change of [{ tracking: 'lot' }, { is_storable: true }, { combo_ids: [] }]) {
    const forged = structuredClone(db); Object.assign(forged.records.product.find((p) => p.id === bundle.id), change);
    assert.throws(() => sync(db, forged), /combo product/i);
  }
  const forged = structuredClone(db); forged.records['product.combo'].find((c) => c.id === choice.id).combo_item_ids.push({ product_id: item.id, extra_price: 0 });
  assert.throws(() => sync(db, forged), /duplicate products/i);
});

test('product list has Odoo column order and optional defaults', () => {
  const p = models.product;
  assert.deepEqual(p.list, ['is_favorite', 'name', 'default_code', 'tag_ids', 'barcode', 'list_price', 'taxes_id', 'cost', 'supplier_taxes_id', 'qty_available', 'categ_id', 'type', 'uom_id']);
  assert.equal(p.fields.is_favorite.widget, 'boolean_favorite');
  for (const field of ['tag_ids', 'barcode', 'categ_id', 'type']) assert.equal(p.fields[field].optional, 'hide');
  for (const field of ['default_code', 'list_price', 'cost', 'qty_available', 'uom_id']) assert.equal(p.fields[field].optional, 'show');
});

test('sales and purchase pages follow product flags while accounting remains available', () => {
  const tabs = models.product.form.tabs;
  const sales = tabs.find((t) => t.label === 'Sales');
  const purchase = tabs.find((t) => t.label === 'Purchase');
  assert.equal(sales.when({ sale_ok: false }), false);
  assert.equal(purchase.when({ purchase_ok: false }), false);
  assert.equal(sales.when({ sale_ok: true }), true);
  assert.equal(purchase.when({ purchase_ok: true, type: 'goods' }), true);
  assert.ok(tabs.find((t) => t.label === 'Accounting').fields.includes('property_account_income_id'));
});

test('new products use company defaults and preserve empty tax selections', () => {
  let db = seed();
  const sale = db.records['account.tax'].find((t) => t.type_tax_use === 'sale');
  const purchase = db.records['account.tax'].find((t) => t.type_tax_use === 'purchase');
  db = structuredClone(db); Object.assign(db.records['res.company'][0], { account_sale_tax_id: sale.id, account_purchase_tax_id: purchase.id });
  const defaults = newDefaults(db, 'product', {}, new URLSearchParams(), null);
  assert.deepEqual(defaults.taxes_id, [sale.id]); assert.deepEqual(defaults.supplier_taxes_id, [purchase.id]);
  const product = create(db, 'product', { name: 'Defaults' }); db = sync(db, product.db);
  assert.equal(productTax(db, read(db, 'product', product.id), 'sale', null, 1).tax_id, sale.id);
  const noTax = create(db, 'product', { name: 'No tax', taxes_id: [], supplier_taxes_id: [] });
  assert.equal(productTax(noTax.db, read(noTax.db, 'product', noTax.id), 'sale', null, 1), null);
  const empty = structuredClone(db); Object.assign(empty.records['res.company'][0], { account_sale_tax_id: null, account_purchase_tax_id: null });
  const blank = create(empty, 'product', { name: 'No defaults' });
  assert.deepEqual(read(blank.db, 'product', blank.id).taxes_id, []);
  assert.equal(read(blank.db, 'product', blank.id).sale_tax, undefined);
});

function comboOrder() {
  let db = seed();
  const products = [1, 1, 1, 7].map((price, i) => {
    const out = create(db, 'product', { name: `Choice ${i}`, type: 'service', list_price: price, taxes_id: [] }); db = out.db; return out.id;
  });
  const choices = [0, 1, 2].map((i) => {
    const items = [{ product_id: products[i], extra_price: i === 2 ? 2 : 0 }];
    if (i === 0) items.push({ product_id: products[3], extra_price: 1 });
    const out = create(db, 'product.combo', { name: `Choice group ${i}`, combo_item_ids: items }); db = out.db; return out.id;
  });
  const combo = create(db, 'product', { name: 'Menu', type: 'combo', list_price: 10, combo_ids: choices, taxes_id: [] }); db = combo.db;
  const parent = models['sale.order'].fields.order_line.onchange({ product_id: combo.id, qty: 2 }, 'product_id', db, { company_id: 1 });
  const order = create(db, 'sale.order', { partner_id: 3, order_line: [parent] }); db = order.db;
  const button = models['sale.order'].form.buttons.find((b) => b.label === 'Configure Combos');
  const values = Object.fromEntries(choices.map((id, i) => [`combo_0_${id}`, String(products[i === 0 ? 3 : i])]));
  return { db, orderId: order.id, button, values, choices, products };
}

test('combo sale allocates its price by choice base prices and gives the last choice the rounding remainder', () => {
  const setup = comboOrder();
  const initial = read(setup.db, 'sale.order', setup.orderId);
  assert.equal(initial.order_line[0].price_unit, 0);
  const invalid = structuredClone(setup.db); invalid.records['sale.order'].find((o) => o.id === setup.orderId).state = 'sale';
  assert.throws(() => sync(setup.db, invalid), /Configure each combo/);
  const configured = setup.button.run(setup.db, initial, setup.values).db;
  const db = sync(setup.db, configured);
  const lines = read(db, 'sale.order', setup.orderId).order_line;
  assert.deepEqual(lines.map((l) => l.price_unit), [0, 4.33, 3.33, 5.34]);
  assert.deepEqual(lines.slice(1).map((l) => l.combo_choice_id), setup.choices);
  assert.ok(lines.slice(1).every((l) => l.combo_parent_key === lines[0].sale_line_key && l.qty === 2));
  const unequal = structuredClone(db);
  unequal.records.product.find((p) => p.id === setup.products[1]).list_price = 2;
  unequal.records.product.find((p) => p.id === setup.products[2]).list_price = 3;
  const proportional = setup.button.run(unequal, read(unequal, 'sale.order', setup.orderId), setup.values).db;
  assert.deepEqual(read(proportional, 'sale.order', setup.orderId).order_line.map((l) => l.price_unit), [0, 2.67, 3.33, 7]);
  const forgedPrice = structuredClone(db);
  const forgedOrder = forgedPrice.records['sale.order'].find((o) => o.id === setup.orderId);
  forgedOrder.state = 'sale'; forgedOrder.order_line[1].price_unit = 99;
  assert.throws(() => sync(db, forgedPrice), /Configure each combo/);
  const zero = structuredClone(db);
  for (const id of setup.products) zero.records.product.find((p) => p.id === id).list_price = 0;
  const even = setup.button.run(zero, read(zero, 'sale.order', setup.orderId), setup.values).db;
  assert.deepEqual(read(even, 'sale.order', setup.orderId).order_line.map((l) => l.price_unit), [0, 4.33, 3.33, 5.34]);
});

test('invoice copies linked combo item lines and their allocated prices', () => {
  const setup = comboOrder();
  let db = setup.button.run(setup.db, read(setup.db, 'sale.order', setup.orderId), setup.values).db;
  const buttons = models['sale.order'].form.buttons;
  db = buttons.find((b) => b.label === 'Confirm').run(db, read(db, 'sale.order', setup.orderId)).db;
  const beforeInvoice = db;
  db = buttons.find((b) => b.label === 'Create Invoice').run(db, read(db, 'sale.order', setup.orderId), { method: 'regular' }).db;
  db = sync(beforeInvoice, db);
  const invoice = db.records['account.move'].find((m) => m.sale_id === setup.orderId && m.move_type === 'out_invoice');
  assert.deepEqual(invoice.invoice_line_ids.map((l) => l.price_unit), [0, 4.33, 3.33, 5.34]);
  assert.deepEqual(invoice.invoice_line_ids.slice(1).map((l) => l.combo_choice_id), setup.choices);
  assert.ok(invoice.invoice_line_ids.slice(1).every((l) => l.combo_parent_key === invoice.invoice_line_ids[0].sale_line_key));
  db = models['account.move'].form.buttons.find((b) => b.label === 'Confirm').run(db, read(db, 'account.move', invoice.id)).db;
  assert.equal(read(db, 'account.move', invoice.id).state, 'posted');
});
test('a product without taxes leaves line taxes to the account defaults', () => {
  assert.equal(productTax(seed(), { taxes_id: [], supplier_taxes_id: [] }, 'sale', null, 1), null);
  assert.equal(productTax(seed(), { taxes_id: [], supplier_taxes_id: [] }, 'purchase', null, 1), null);
});
