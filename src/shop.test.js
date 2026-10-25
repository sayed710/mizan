import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, write } from './orm.js';
import { generateVariants } from './models/sales.js';
import { cartTotals, isPurchasable, namedAttributes, productVariants, shopProducts } from './models/shop.js';
import { categoryPath } from './models/ecommerce.js';
import { seed } from './seed.js';

const names = (r) => r.items.map((p) => p.name);

test('the shop lists published sellable templates, not variants, unpublished or unpriced products', () => {
  const db = seed();
  const all = shopProducts(db, { perPage: 100 });
  assert.ok(names(all).includes('Standing Desk'));
  assert.ok(!names(all).some((n) => n.startsWith('Standing Desk (')), 'variants are reached from their template');
  assert.ok(!names(all).includes('Shipping') && !names(all).includes('Oak Desk Top'));
  const hidden = write(db, 'product', 4, { is_published: false });
  assert.ok(!names(shopProducts(hidden, { perPage: 100 })).includes('LED Desk Lamp'));
});

test('category filter includes sub-categories; search matches name and description', () => {
  const base = seed();
  const { db: withSub, id: sub } = create(base, 'product.public.category', { name: 'Standing', parent_id: 1 });
  const db = write(withSub, 'product', 4, { public_categ_ids: [{ category_id: sub }] });
  assert.equal(categoryPath(db, sub), 'Desks / Standing');
  assert.deepEqual(names(shopProducts(db, { category: 1, sort: 'name' })), ['LED Desk Lamp', 'Meeting Table (8 seats)', 'Standing Desk']);
  assert.deepEqual(names(shopProducts(db, { category: sub })), ['LED Desk Lamp']);
  assert.deepEqual(names(shopProducts(db, { search: 'LUMBAR' })), ['Ergonomic Chair']);
  assert.equal(shopProducts(db, { search: 'no such thing' }).total, 0);
});

test('sorting and pagination', () => {
  const db = seed();
  const asc = shopProducts(db, { sort: 'price_asc', perPage: 100 }).items.map((p) => p.list_price);
  assert.deepEqual(asc, [...asc].sort((a, b) => a - b));
  assert.equal(shopProducts(db, { sort: 'price_desc' }).items[0].name, 'Meeting Table (8 seats)');
  assert.equal(shopProducts(db, { sort: 'newest' }).items[0].id, Math.max(...shopProducts(db, { perPage: 100 }).items.map((p) => p.id)));
  assert.equal(shopProducts(db, { sort: 'featured' }).items[0].name, 'Ergonomic Chair');
  const page1 = shopProducts(db, { perPage: 4, page: 1 });
  const page3 = shopProducts(db, { perPage: 4, page: 3 });
  assert.equal(page1.pages, Math.ceil(page1.total / 4));
  assert.equal(page1.items.length, 4);
  assert.equal(page3.items.length, page1.total - 8);
  assert.equal(shopProducts(db, { perPage: 4, page: 99 }).page, page1.pages, 'out-of-range pages clamp to the last one');
});

test('variants are grouped by named attribute and resolve to their own product and price', () => {
  assert.deepEqual(namedAttributes('Color: White, Black; Legs: Steel, Aluminium, Custom'), [['Color', ['White', 'Black']], ['Legs', ['Steel', 'Aluminium', 'Custom']]]);
  const db = seed();
  const { attributes, variants } = productVariants(db, read(db, 'product', 2));
  assert.deepEqual(attributes, [['Color', ['White', 'Black']], ['Legs', ['Steel', 'Aluminium']]]);
  assert.equal(variants.length, 4);
  assert.equal(variants.find((v) => v.values.join('|') === 'Black|Aluminium').price, 590);
  assert.ok(!isPurchasable(db, read(db, 'product', 2)), 'a template with variants is bought through a variant');
  assert.ok(isPurchasable(db, read(db, 'product', variants[0].id)));
  const chair = write(seed(), 'product', 1, { attributes: 'Arms: Yes, No' });
  const withVariants = generateVariants(chair, read(chair, 'product', 1));
  assert.equal(productVariants(withVariants, read(withVariants, 'product', 1)).variants.length, 2);
});

test('cart totals apply the pricelist, product taxes and the carrier price', () => {
  const db = seed();
  const plain = cartTotals(db, [{ product_id: 1, qty: 2 }]);
  assert.deepEqual(plain.lines, [{ product_id: 1, qty: 2, price_unit: 210, subtotal: 420, tax: 58.8 }]);
  assert.deepEqual([plain.untaxed, plain.tax, plain.delivery, plain.total], [420, 58.8, 0, 478.8]);
  // Wholesale: 10% off from 10 units.
  const wholesale = cartTotals(db, [{ product_id: 4, qty: 10 }], { pricelistId: 1 });
  assert.equal(wholesale.lines[0].price_unit, 31.5);
  // Standard Delivery: 25 fixed, taxed like the shipping product (14%).
  const shipped = cartTotals(db, [{ product_id: 1, qty: 2 }], { carrierId: 1 });
  assert.deepEqual([shipped.untaxed, shipped.delivery, shipped.tax, shipped.total], [420, 25, 62.3, 507.3]);
  assert.equal(shipped.orderLines.at(-1).product_id, 13);
  // Free above 2000.
  assert.equal(cartTotals(db, [{ product_id: 3, qty: 2 }], { carrierId: 1 }).delivery, 0);
  // Export fiscal position (auto-applied for a country) maps VAT to 0%.
  const exportDb = write(db, 'account.fiscal.position', 2, { auto_apply: true, country: 'UAE' });
  assert.equal(cartTotals(exportDb, [{ product_id: 1, qty: 1 }], { partnerCountry: 'uae' }).tax, 0);
});
