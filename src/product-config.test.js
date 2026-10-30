import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { create, read, write } from './orm.js';
import { migrate } from './migrations.js';
import { categoryPath, productProperty } from './models/productconfig.js';
import { generateVariants } from './models/sales.js';
import { costMethod } from './models/valuation.js';
import { cleanRecord } from './validate.js';
import { models } from './models/index.js';
import { invoiceLines } from './models/ledger.js';
import { moveValued, receive } from './models/valuation.js';
import { applyDiff } from './sync.js';

test('category paths and product policy overrides', () => {
  let db = seed();
  const root = create(db, 'product.category', { name: 'All', property_cost_method: 'fifo', property_account_income_id: 1 }); db = root.db;
  const child = create(db, 'product.category', { name: 'Office', parent_id: root.id }); db = child.db;
  const p = create(db, 'product', { name: 'Test', categ_id: child.id, cost_method: null }); db = p.db;
  assert.equal(categoryPath(db, child.id), 'All / Office');
  assert.equal(costMethod(db, p.id), 'fifo');
  assert.equal(productProperty(db, read(db, 'product', p.id), 'property_account_income_id'), 1);
  db = write(db, 'product', p.id, { cost_method: 'average', property_account_income_id: 2 });
  assert.equal(costMethod(db, p.id), 'average');
  assert.equal(productProperty(db, read(db, 'product', p.id), 'property_account_income_id'), 2);
});

test('migration preserves category names and creates shared hierarchical categories', () => {
  const old = seed();
  const db = migrate({ ...old, schema_version: 5, records: { ...old.records, product: old.records.product.map((p, i) => ({ ...p, categ: i < 2 ? 'All / Office' : p.categ, categ_id: null })) } });
  assert.equal(categoryPath(db, db.records.product[0].categ_id), 'All / Office');
  assert.equal(db.records.product[0].categ_id, db.records.product[1].categ_id);
  assert.equal(db.records.product[0].categ, 'All / Office');
});

test('attribute combinations generate priced, distinct selectable product variants', () => {
  let db = seed();
  const attr = create(db, 'product.attribute', { name: 'Finish' }); db = attr.db;
  const red = create(db, 'product.attribute.value', { name: 'Red', attribute_id: attr.id, default_extra_price: 5 }); db = red.db;
  const blue = create(db, 'product.attribute.value', { name: 'Blue', attribute_id: attr.id, default_extra_price: 9 }); db = blue.db;
  const size = create(db, 'product.attribute', { name: 'Size' }); db = size.db;
  const small = create(db, 'product.attribute.value', { name: 'Small', attribute_id: size.id, default_extra_price: 2 }); db = small.db;
  const large = create(db, 'product.attribute.value', { name: 'Large', attribute_id: size.id, default_extra_price: 3 }); db = large.db;
  const p = create(db, 'product', { name: 'Widget', default_code: 'W', list_price: 100, attribute_line_ids: [{ attribute_id: attr.id, value_ids: [red.id, blue.id], sequence: 10 }, { attribute_id: size.id, value_ids: [small.id, large.id], sequence: 20 }] }); db = p.db;
  db = generateVariants(db, read(db, 'product', p.id));
  const variants = db.records.product.filter((v) => v.variant_of === p.id);
  assert.deepEqual(variants.map((v) => v.list_price), [107, 108, 111, 112]);
  assert.equal(new Set(variants.map((v) => v.default_code)).size, 4);
  assert.equal(generateVariants(db, read(db, 'product', p.id)).records.product.length, db.records.product.length);
});

test('product tag relations survive cleaning and tagged filter', () => {
  let db = seed();
  const tag = create(db, 'product.tag', { name: 'Featured' }); db = tag.db;
  const p = create(db, 'product', { name: 'Tagged', tag_ids: [tag.id] });
  assert.deepEqual(cleanRecord('product', read(p.db, 'product', p.id)).tag_ids, [tag.id]);
  assert.ok(models.product.filters.flat().find((f) => f.id === 'tagged').fn(read(p.db, 'product', p.id)));
});

test('inherited accounting and periodic valuation drive the existing posting flows', () => {
  let db = seed();
  const income = db.records['account.account'].find((a) => a.code === '400000');
  const stock = db.records['account.account'].find((a) => a.code === '151000');
  const cat = create(db, 'product.category', { name: 'Policy', property_valuation: 'periodic', property_account_income_id: income.id, property_stock_valuation_account_id: stock.id }); db = cat.db;
  const p = create(db, 'product', { name: 'Policy product', categ_id: cat.id, cost: 4 }); db = p.db;
  const entries = invoiceLines(db, { move_type: 'out_invoice', invoice_line_ids: [{ product_id: p.id, qty: 1, price_unit: 10 }] });
  assert.ok(entries.some((l) => l.account_id === income.id && l.credit === 10));
  const periodic = moveValued(db, [{ product_id: p.id, qty: 1 }], 1);
  assert.equal((periodic.records['stock.valuation.layer'] ?? []).filter((l) => l.product_id === p.id).length, 0);
  db = write(db, 'product.category', cat.id, { property_valuation: 'real_time' });
  const posted = receive(db, p.id, 1, 4);
  const layer = posted.records['stock.valuation.layer'].find((l) => l.product_id === p.id);
  assert.ok(read(posted, 'account.move', layer.move_id).line_ids.some((l) => l.account_id === stock.id));
});

test('invalid attribute links and missing tag references are rejected', () => {
  let db = seed();
  const attr = create(db, 'product.attribute', { name: 'Size' }); db = attr.db;
  assert.throws(() => create(db, 'product', { name: 'Bad', attribute_line_ids: [{ attribute_id: attr.id, value_ids: [99999] }] }));
  const p = create(db, 'product', { name: 'Bad tag' });
  assert.throws(() => applyDiff(p.db, { upserts: { product: [{ ...read(p.db, 'product', p.id), tag_ids: [99999] }] } }));
});
