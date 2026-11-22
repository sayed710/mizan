import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read } from './orm.js';
import { models, menusFor } from './models/index.js';
import { migrate } from './migrations.js';
import { seed } from './seed.js';

const press = (db, model, id, label) => models[model].form.buttons.find((b) => b.label === label).run(db, read(db, model, id)).db;

test('posting invoices and confirming orders increments the commercial partner ranks', () => {
  let parent = create(seed(), 'res.partner', { name: 'Parent' });
  const child = create(parent.db, 'res.partner', { name: 'Contact', parent_id: parent.id });
  let db = child.db;
  assert.equal(read(db, 'res.partner', parent.id).customer_rank, 0);
  for (const [model, type, button] of [['account.move', 'out_invoice', 'Confirm'], ['account.move', 'in_invoice', 'Confirm'], ['sale.order', null, 'Confirm'], ['purchase.order', null, 'Confirm Order']]) {
    const line = { product_id: 1, qty: 1, price_unit: 10, tax: 0 };
    const made = create(db, model, { partner_id: child.id, ...(type ? { move_type: type, invoice_line_ids: [line] } : { order_line: [line] }) });
    db = press(made.db, model, made.id, button);
  }
  assert.equal(read(db, 'res.partner', parent.id).customer_rank, 2);
  assert.equal(read(db, 'res.partner', parent.id).supplier_rank, 2);
  assert.equal(read(db, 'res.partner', child.id).customer_rank, 0);
  assert.equal(models['res.partner'].fields.customer_rank.readonly, true);
  assert.equal(models['res.partner'].fields.supplier_rank.readonly, true);
});

test('migration counts only posted invoices and confirmed orders for commercial partners', () => {
  const db = { schema_version: 62, records: { 'res.partner': [{ id: 1 }, { id: 2, parent_id: 1 }, { id: 3 }], 'account.move': [{ id: 1, partner_id: 2, state: 'posted', move_type: 'out_invoice' }, { id: 2, partner_id: 2, state: 'draft', move_type: 'in_invoice' }], 'sale.order': [{ id: 1, partner_id: 2, state: 'sale' }], 'purchase.order': [{ id: 1, partner_id: 2, state: 'purchase' }] } };
  const next = migrate(db);
  assert.deepEqual(next.records['res.partner'].map((p) => [p.customer_rank, p.supplier_rank]), [[2, 1], [0, 0], [0, 0]]);
});

test('accounting partner and product leaves use removable default filters', () => {
  const sections = menusFor('accounting');
  for (const [section, partnerKey, partnerFilter, productFilter] of [['Customers', 'customers', 'customers', 'sale_ok'], ['Vendors', 'vendors', 'vendors', 'purchase_ok']]) {
    const children = sections.find((m) => m.label === section).children;
    for (const [key, filter, model] of [[partnerKey, partnerFilter, 'res.partner'], ['products', productFilter, 'product']]) {
      const leaf = children.find((m) => m.key === key);
      assert.deepEqual(leaf.defaultFilters, [filter]);
      assert.equal(leaf.domain, undefined);
      const predicate = models[model].filters.flat().find((f) => f.id === filter).fn;
      const field = filter === 'customers' ? 'customer_rank' : filter === 'vendors' ? 'supplier_rank' : filter;
      assert.equal(!!predicate({ [field]: model === 'product' ? true : 1 }), true);
      assert.equal(!!predicate({ [field]: model === 'product' ? false : 0 }), false);
    }
  }
  const product = create(seed(), 'product', { name: 'Product' });
  assert.equal(read(product.db, 'product', product.id).sale_ok, true);
  assert.equal(read(product.db, 'product', product.id).purchase_ok, true);
});
