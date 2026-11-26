import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { models } from './models/index.js';
import { create, read, write } from './orm.js';
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
  assert.deepEqual(p.list, ['is_favorite', 'name', 'default_code', 'tag_ids', 'barcode', 'company_id', 'list_price', 'taxes_id', 'cost', 'supplier_taxes_id', 'qty_available', 'categ_id', 'type', 'uom_id']);
  assert.equal(p.fields.is_favorite.widget, 'boolean_favorite');
  for (const field of ['tag_ids', 'barcode', 'categ_id', 'type']) assert.equal(p.fields[field].optional, 'hide');
  for (const field of ['default_code', 'list_price', 'cost', 'qty_available', 'uom_id']) assert.equal(p.fields[field].optional, 'show');
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

test('configuring a confirmed order preserves fulfilled combos and configures newly added ones', () => {
  for (const activity of ['qty_delivered', 'qty_invoiced']) {
    const setup = comboOrder();
    let db = setup.button.run(setup.db, read(setup.db, 'sale.order', setup.orderId), setup.values).db;
    const confirm = models['sale.order'].form.buttons.find((button) => button.label === 'Confirm');
    db = confirm.run(db, read(db, 'sale.order', setup.orderId)).db;
    const original = read(db, 'sale.order', setup.orderId);
    const withActivity = original.order_line.map((line, i) => i === 1 ? { ...line, [activity]: 1 } : line);
    db = write(db, 'sale.order', setup.orderId, { order_line: withActivity });
    // Historic prices need not be recomputed when another combo is added later.
    db = structuredClone(db);
    db.records.product.find((product) => product.id === setup.products[1]).list_price = 2;
    const confirmed = read(db, 'sale.order', setup.orderId);
    const preserved = structuredClone(confirmed.order_line);
    const newParent = models['sale.order'].fields.order_line.onchange({ product_id: preserved[0].product_id, qty: 1 }, 'product_id', db, confirmed);
    const pending = { ...confirmed, order_line: [...confirmed.order_line, newParent] };
    assert.equal(setup.button.when(confirmed, db), false);
    assert.equal(setup.button.when(pending, db), true);
    const index = preserved.length;
    const fields = setup.button.wizard(db, pending).fields;
    assert.deepEqual(fields.map((field) => field.name), setup.choices.map((id) => `combo_${index}_${id}`));
    const values = Object.fromEntries(setup.choices.map((id, i) => [`combo_${index}_${id}`, String(setup.products[i])]));
    const staged = structuredClone(db);
    staged.records['sale.order'].find((order) => order.id === setup.orderId).order_line.push(newParent);
    const result = setup.button.run(staged, pending, values).db;
    const saved = sync(db, result);
    const lines = read(saved, 'sale.order', setup.orderId).order_line;
    assert.deepEqual(lines.slice(0, preserved.length), preserved);
    assert.equal(lines[1][activity], 1);
    assert.ok(lines[index].sale_line_key);
    assert.equal(lines.slice(index + 1).length, setup.choices.length);
    assert.ok(lines.slice(index + 1).every((line) => line.combo_parent_key === lines[index].sale_line_key));
  }
});

test('draft and sent combo lines remain configurable even when they carry quantities', () => {
  for (const state of ['draft', 'sent']) {
    const setup = comboOrder();
    let db = setup.button.run(setup.db, read(setup.db, 'sale.order', setup.orderId), setup.values).db;
    const record = read(db, 'sale.order', setup.orderId);
    db = write(db, 'sale.order', setup.orderId, { state, order_line: record.order_line.map((line, index) => index === 1 ? { ...line, qty_delivered: 1 } : line) });
    const order = read(db, 'sale.order', setup.orderId);
    assert.equal(setup.button.wizard(db, order).fields.length, setup.choices.length);
    const updated = setup.button.run(db, order, setup.values).db;
    assert.notEqual(read(updated, 'sale.order', setup.orderId).order_line[1].sale_line_key, order.order_line[1].sale_line_key);
  }
});
test('a product without taxes leaves line taxes to the account defaults', () => {
  assert.equal(productTax(seed(), { taxes_id: [], supplier_taxes_id: [] }, 'sale', null, 1), null);
  assert.equal(productTax(seed(), { taxes_id: [], supplier_taxes_id: [] }, 'purchase', null, 1), null);
});

test('combo choices are reachable from Sales configuration and shared across companies', async () => {
  const { apps } = await import('./models/index.js');
  const { SHARED_MODELS } = await import('./orm.js');
  const sales = apps.find((app) => app.id === 'sales');
  const leaves = sales.menus.flatMap((menu) => menu.children ?? [menu]);
  assert.ok(leaves.some((leaf) => leaf.model === 'product.combo'));
  assert.ok(SHARED_MODELS.has('product.combo'));
});

test('an unsellable choice product is neither offered nor accepted', () => {
  const setup = comboOrder();
  const db = structuredClone(setup.db);
  db.records.product.find((p) => p.id === setup.products[3]).sale_ok = false;
  const order = read(db, 'sale.order', setup.orderId);
  const field = setup.button.wizard(db, order).fields.find((f) => f.name === `combo_0_${setup.choices[0]}`);
  assert.deepEqual(field.options.map(([id]) => Number(id)), [setup.products[0]]);
  assert.throws(() => setup.button.run(db, order, setup.values), /only contain sellable products/);
});

test('a confirmed order re-checks combo lines whenever they change', () => {
  const setup = comboOrder();
  let db = setup.button.run(setup.db, read(setup.db, 'sale.order', setup.orderId), setup.values).db;
  db = sync(setup.db, db);
  db = models['sale.order'].form.buttons.find((b) => b.label === 'Confirm').run(db, read(db, 'sale.order', setup.orderId)).db;
  const confirmed = read(db, 'sale.order', setup.orderId);
  assert.ok(setup.button.when(confirmed, db));
  const added = structuredClone(db);
  const order = added.records['sale.order'].find((o) => o.id === setup.orderId);
  order.order_line.push({ ...order.order_line[0], sale_line_key: null });
  assert.throws(() => sync(db, added), /Configure each combo/);
  const delivered = structuredClone(db);
  delivered.records['sale.order'].find((o) => o.id === setup.orderId).order_line[1].qty_delivered = 2;
  assert.doesNotThrow(() => sync(db, delivered));
});

test('a delivered combo parent becomes invoiceable with its components', async () => {
  const { qtyToInvoice } = await import('./models/sales.js');
  const setup = comboOrder();
  const db = structuredClone(setup.db);
  for (const id of setup.products) db.records.product.find((p) => p.id === id).invoice_policy = 'delivery';
  const lines = setup.button.run(db, read(db, 'sale.order', setup.orderId), setup.values).db.records['sale.order'].find((o) => o.id === setup.orderId).order_line;
  const order = { order_line: lines.map((line, i) => (i === 1 ? { ...line, qty_delivered: 1 } : i > 1 ? { ...line, qty_delivered: 2 } : line)) };
  assert.equal(qtyToInvoice(db, order.order_line[0], order), 1);
  const invoiced = { order_line: order.order_line.map((line) => ({ ...line, qty_delivered: 2, qty_invoiced: 2 })) };
  assert.equal(qtyToInvoice(db, invoiced.order_line[0], invoiced), 0);
});

test('a fixed pricelist price converts to a foreign order currency like the list price', () => {
  const setup = comboOrder();
  let db = structuredClone(setup.db);
  const combo = db.records.product.find((p) => p.type === 'combo' && p.name === 'Menu');
  const pricelist = create(db, 'product.pricelist', { name: 'Fixed', items: [{ product_id: combo.id, min_qty: 0, fixed_price: 10, percent: 0 }] }); db = pricelist.db;
  const company = read(db, 'res.company', 1);
  const foreign = db.records['res.currency'].find((c) => c.id !== company.currency_id);
  db.records['res.currency'] = db.records['res.currency'].map((c) => (c.id === foreign.id ? { ...c, rate_ids: [{ date: '2000-01-01', rate: 2 }] } : c));
  const priced = (vals) => {
    const next = structuredClone(db);
    Object.assign(next.records['sale.order'].find((o) => o.id === setup.orderId), vals);
    const order = read(next, 'sale.order', setup.orderId);
    return setup.button.run(next, order, setup.values).db.records['sale.order'].find((o) => o.id === setup.orderId).order_line.slice(1).reduce((sum, line) => sum + line.price_unit, 0);
  };
  assert.equal(Math.round(priced({ currency_id: foreign.id }) * 100), 2 * Math.round(priced({}) * 100));
  assert.equal(Math.round(priced({ currency_id: foreign.id, pricelist_id: pricelist.id }) * 100), Math.round(priced({ currency_id: foreign.id }) * 100));
});
