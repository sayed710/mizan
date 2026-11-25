import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read } from './orm.js';
import { models, menusFor, apps, findLeaf } from './models/index.js';
import { incrementPartnerRank } from './models/crm.js';
import { migrate } from './migrations.js';
import { seed } from './seed.js';
import { newDefaults } from './views/formDefaults.js';

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
  assert.equal(read(db, 'res.partner', parent.id).customer_rank, 1);
  assert.equal(read(db, 'res.partner', parent.id).supplier_rank, 1);
  assert.equal(read(db, 'res.partner', child.id).customer_rank, 0);
  assert.equal(models['res.partner'].fields.customer_rank.readonly, true);
  assert.equal(models['res.partner'].fields.supplier_rank.readonly, true);
});

test('runtime increments partner rank for contacts whose parent was deleted', () => {
  const db = seed();
  const orphan = create(db, 'res.partner', { name: 'Orphan Contact', parent_id: 999999 });
  assert.equal(read(orphan.db, 'res.partner', orphan.id).customer_rank, 0);
  assert.equal(read(orphan.db, 'res.partner', orphan.id).supplier_rank, 0);

  const next = incrementPartnerRank(orphan.db, orphan.id, 'customer_rank');
  assert.equal(read(next, 'res.partner', orphan.id).customer_rank, 1);

  const nextSupp = incrementPartnerRank(next, orphan.id, 'supplier_rank');
  assert.equal(read(nextSupp, 'res.partner', orphan.id).supplier_rank, 1);
});

test('posting an invoice for a contact whose parent was deleted marks it as a customer', () => {
  let db = seed();
  const orphan = create(db, 'res.partner', { name: 'Orphan Customer', parent_id: 999999 });
  const line = { product_id: 1, qty: 1, price_unit: 10, tax: 0 };
  const invoice = create(orphan.db, 'account.move', { partner_id: orphan.id, move_type: 'out_invoice', invoice_line_ids: [line] });
  db = press(invoice.db, 'account.move', invoice.id, 'Confirm');
  assert.equal(read(db, 'res.partner', orphan.id).customer_rank, 1);
});

test('migration marks only posted invoices and confirmed orders for commercial partners', () => {
  const db = { schema_version: 62, records: { 'res.partner': [{ id: 1 }, { id: 2, parent_id: 1 }, { id: 3 }], 'account.move': [{ id: 1, partner_id: 2, state: 'posted', move_type: 'out_invoice' }, { id: 2, partner_id: 2, state: 'draft', move_type: 'in_invoice' }], 'sale.order': [{ id: 1, partner_id: 2, state: 'sale' }], 'purchase.order': [{ id: 1, partner_id: 2, state: 'purchase' }] } };
  const next = migrate(db);
  assert.deepEqual(next.records['res.partner'].map((p) => [p.customer_rank, p.supplier_rank]), [[1, 1], [0, 0], [0, 0]]);
});

test('migration backfills rank 1 for multiple qualifying transactions while preserving existing positive rank', () => {
  const db = {
    schema_version: 62,
    records: {
      'res.partner': [
        { id: 1, customer_rank: 0, supplier_rank: 0 },
        { id: 2, customer_rank: 5, supplier_rank: 0 },
      ],
      'account.move': [
        { id: 1, partner_id: 1, state: 'posted', move_type: 'out_invoice' },
        { id: 2, partner_id: 1, state: 'posted', move_type: 'out_invoice' },
        { id: 3, partner_id: 1, state: 'posted', move_type: 'out_invoice' },
        { id: 4, partner_id: 2, state: 'posted', move_type: 'out_invoice' },
      ],
    },
  };
  const next = migrate(db);
  const p1 = next.records['res.partner'].find((p) => p.id === 1);
  const p2 = next.records['res.partner'].find((p) => p.id === 2);
  assert.equal(p1.customer_rank, 1, 'partner with multiple transactions backfills rank 1 as activity flag');
  assert.equal(p2.customer_rank, 5, 'partner with existing positive rank preserves its value');
});

test('accounting partner and product leaves use removable default filters', () => {
  const sections = menusFor('accounting');
  for (const [section, partnerKey, partnerFilter, productKey, productFilter] of [['Customers', 'customers', 'customers', 'customer-products', 'sale_ok'], ['Vendors', 'vendors', 'vendors', 'vendor-products', 'purchase_ok']]) {
    const children = sections.find((m) => m.label === section).children;
    for (const [key, filter, model] of [[partnerKey, partnerFilter, 'res.partner'], [productKey, productFilter, 'product']]) {
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

test('accounting products leaves have distinct keys and resolve to their own filters and defaults via findLeaf', () => {
  const app = apps.find((a) => a.id === 'accounting');
  const customerLeaf = findLeaf(app, 'customer-products');
  assert.equal(customerLeaf.key, 'customer-products');
  assert.deepEqual(customerLeaf.defaultFilters, ['sale_ok']);
  assert.deepEqual(customerLeaf.defaults, { sale_ok: true });

  const vendorLeaf = findLeaf(app, 'vendor-products');
  assert.equal(vendorLeaf.key, 'vendor-products');
  assert.deepEqual(vendorLeaf.defaultFilters, ['purchase_ok']);
  assert.deepEqual(vendorLeaf.defaults, { purchase_ok: true });
});

test('creating partners from Accounting Customers and Vendors leaves assigns rank 1 while unrelated defaults to 0', () => {
  const app = apps.find((a) => a.id === 'accounting');
  const custLeaf = findLeaf(app, 'customers');
  const vendLeaf = findLeaf(app, 'vendors');

  assert.equal(custLeaf.defaults?.customer_rank, 1);
  assert.equal(vendLeaf.defaults?.supplier_rank, 1);

  const db = seed();
  const custVals = newDefaults(db, 'res.partner', custLeaf, new URLSearchParams(), null);
  const custCreated = create(db, 'res.partner', { ...custVals, name: 'New Customer' });
  const custRecord = read(custCreated.db, 'res.partner', custCreated.id);
  assert.equal(custRecord.customer_rank, 1);

  const custFilter = models['res.partner'].filters.flat().find((f) => f.id === 'customers').fn;
  assert.equal(custFilter(custRecord), true);

  const vendVals = newDefaults(db, 'res.partner', vendLeaf, new URLSearchParams(), null);
  const vendCreated = create(db, 'res.partner', { ...vendVals, name: 'New Vendor' });
  const vendRecord = read(vendCreated.db, 'res.partner', vendCreated.id);
  assert.equal(vendRecord.supplier_rank, 1);

  const vendFilter = models['res.partner'].filters.flat().find((f) => f.id === 'vendors').fn;
  assert.equal(vendFilter(vendRecord), true);

  const unrelated = create(db, 'res.partner', { name: 'Unrelated' });
  const unrelatedRecord = read(unrelated.db, 'res.partner', unrelated.id);
  assert.equal(unrelatedRecord.customer_rank, 0);
  assert.equal(unrelatedRecord.supplier_rank, 0);
  assert.equal(custFilter(unrelatedRecord), false);
  assert.equal(vendFilter(unrelatedRecord), false);
});

test('migration 65 aggregates ranks efficiently without repeatedly remapping partner array', () => {
  const partnerCount = 2000;
  const partners = Array.from({ length: partnerCount }, (_, i) => ({ id: i + 1, name: `Partner ${i + 1}` }));
  partners.push({ id: partnerCount + 1, name: 'Child of 1', parent_id: 1 });

  const moveCount = 3000;
  const moves = Array.from({ length: moveCount }, (_, i) => ({
    id: i + 1,
    partner_id: (i % 5 === 0) ? partnerCount + 1 : (i % partnerCount) + 1,
    state: 'posted',
    move_type: i % 2 === 0 ? 'out_invoice' : 'in_invoice',
  }));

  const start = performance.now();
  const migrated = migrate({ schema_version: 62, records: { 'res.partner': partners, 'account.move': moves } });
  const elapsed = performance.now() - start;

  assert.equal(migrated.schema_version, 76);
  assert.ok(elapsed < 300, `Migration took too long: ${elapsed}ms`);

  const p1 = migrated.records['res.partner'].find((p) => p.id === 1);
  assert.ok(p1.customer_rank > 0);
  assert.ok(p1.supplier_rank > 0);
});
