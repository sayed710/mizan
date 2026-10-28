import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, emptyDb, read, search, unlink, write } from './orm.js';
import { seed } from './seed.js';
import { checkPackagingMultiple, convert, convertPrice, defaultUoms, ensureUoms, lineToStockQty, packagingSuggestion, uomForLegacy, uomModels } from './models/uom.js';

const named = (db, name) => search(db, 'uom.uom').find((r) => r.name === name).id;

test('standard quantities convert by ratio, rounding UP at target precision, not HALF-UP', () => {
  const db = ensureUoms(emptyDb());
  const qty = (n, from, to, options) => convert(db, n, named(db, from), named(db, to), options);
  assert.equal(qty(2, 'Dozens', 'Units'), 24);
  assert.equal(qty(13, 'Units', 'Dozens'), 1.09);
  assert.equal(qty(1001, 'g', 'kg'), 1.01);
  assert.ok(Math.abs(qty(1001, 'g', 'kg', { round: false }) - 1.001) < 1e-12);
  assert.equal(qty(123, 'cm', 'm'), 1.23);
  assert.equal(qty(2, 'Days', 'Hours'), 16);
  assert.equal(qty(-1001, 'g', 'kg'), -1.01);
  assert.equal(qty(0, 'kg', 'g'), 0);
  assert.equal(qty(0.3, 'kg', 'kg'), 0.3);
  const coarse = write(db, 'uom.uom', named(db, 'kg'), { rounding: 0.25 });
  assert.equal(convert(coarse, 1001, named(db, 'g'), named(db, 'kg')), 1.25);
});

test('conversion rejects cross-category units, missing records and invalid numbers', () => {
  const db = ensureUoms(emptyDb());
  assert.throws(() => convert(db, 1, named(db, 'kg'), named(db, 'm')), /different categories/);
  assert.throws(() => convertPrice(db, 1, named(db, 'kg'), named(db, 'm')), /different categories/);
  assert.throws(() => convert(db, 1, -1, named(db, 'm')), /existing unit/);
  assert.throws(() => convert(db, Infinity, named(db, 'm'), named(db, 'm')), /finite/);
});

test('unit prices scale inversely to quantities without quantity rounding', () => {
  const db = ensureUoms(emptyDb());
  assert.equal(convertPrice(db, 5, named(db, 'Units'), named(db, 'Dozens')), 60);
  assert.equal(convertPrice(db, 60, named(db, 'Dozens'), named(db, 'Units')), 5);
  assert.equal(convertPrice(db, 10, named(db, 'kg'), named(db, 'g')), 0.01);
});

test('UoM guards preserve one reference even when archived and validate ratios and rounding', () => {
  const db = ensureUoms(emptyDb());
  const kg = read(db, 'uom.uom', named(db, 'kg'));
  const vals = { name: 'Duplicate', category_id: kg.category_id };
  assert.match(uomModels['uom.uom'].guard(db, null, { ...kg, id: 999 }), /one reference/);
  assert.throws(() => create(db, 'uom.uom', vals), /one reference/);
  const archived = write(db, 'uom.uom', kg.id, { active: false });
  assert.throws(() => create(archived, 'uom.uom', vals), /one reference/);
  assert.throws(() => write(db, 'uom.uom', kg.id, { uom_type: 'bigger', ratio: 2 }), /keep its reference/);
  assert.throws(() => unlink(db, 'uom.uom', [kg.id]), /keep its reference/);
  assert.throws(() => write(db, 'uom.uom', kg.id, { rounding: 0 }), /positive/);
  assert.throws(() => write(db, 'uom.uom', named(db, 'g'), { ratio: 2 }), /match the unit type/);
  assert.throws(() => create(db, 'uom.uom', { ...vals, category_id: -1 }), /existing UoM category/);
  const category = create(db, 'uom.category', { name: 'Custom' });
  assert.throws(() => create(category.db, 'uom.uom', { name: 'Large', category_id: category.id, uom_type: 'bigger', ratio: 2 }), /reference unit first/);
});

test('stock quantities convert explicit line units and retain legacy fallback without mutating inputs', () => {
  const db = ensureUoms(seed());
  const product = { ...read(db, 'product', 1), uom_id: named(db, 'Units') };
  const line = { product_id: product.id, qty: 2, uom_id: named(db, 'Dozens') };
  const snapshot = structuredClone(db);
  assert.equal(lineToStockQty(db, line, product), 24);
  assert.equal(lineToStockQty(db, { qty: 2.003 }, product), 2.003);
  assert.equal(lineToStockQty(db, { qty: 1001, uom_id: named(db, 'g') }, { uom: 'kg' }), 1.01);
  assert.equal(lineToStockQty(seed(), { qty: 3 }, { uom: 'box' }), 3);
  assert.throws(() => lineToStockQty(db, line, { uom_id: named(db, 'kg') }), /different categories/);
  assert.deepEqual(db, snapshot);
  assert.equal(line.qty, 2);
});

test('packaging suggestions are largest-first and warnings tolerate floating point multiples', () => {
  const db0 = seed();
  const small = create(db0, 'product.packaging', { name: 'Six', product_id: 1, qty: 6 });
  const large = create(small.db, 'product.packaging', { name: 'Case', product_id: 1, qty: 24 });
  const other = create(large.db, 'product.packaging', { name: 'Other', product_id: 2, qty: 100 });
  const snapshot = structuredClone(other.db);
  const result = packagingSuggestion(other.db, 1, 57);
  assert.deepEqual(result.packages.map((p) => [p.packaging.id, p.count]), [[large.id, 2], [small.id, 1]]);
  assert.equal(result.remainder, 3);
  assert.deepEqual(packagingSuggestion(other.db, 999, 7), { packages: [], remainder: 7 });
  assert.deepEqual(packagingSuggestion(other.db, 1, 0), { packages: [], remainder: 0 });
  assert.equal(checkPackagingMultiple(other.db, 1, 48, large.id), null);
  assert.match(checkPackagingMultiple(other.db, 1, 49, large.id), /multiple of 24.*Case/);
  assert.throws(() => checkPackagingMultiple(other.db, 1, 100, other.id), /for this product/);
  assert.throws(() => packagingSuggestion(other.db, 1, -1), /negative/);
  assert.throws(() => write(other.db, 'product.packaging', small.id, { qty: 0 }), /positive/);
  const fractional = create(other.db, 'product.packaging', { name: 'Tenth', product_id: 3, qty: 0.1 });
  assert.equal(checkPackagingMultiple(fractional.db, 3, 0.3, fractional.id), null);
  assert.equal(packagingSuggestion(fractional.db, 3, 0.3).packages[0].count, 3);
  assert.deepEqual(other.db, snapshot);
});

test('legacy codes resolve canonical units; box is a quantity-neutral unit alias', () => {
  const db = ensureUoms(emptyDb());
  for (const [code, name] of Object.entries({ unit: 'Units', kg: 'kg', m: 'm', l: 'L', hour: 'Hours', box: 'Units' })) {
    assert.equal(uomForLegacy(db, code).name, name);
  }
  assert.equal(uomForLegacy(db, 'unknown'), null);
  assert.equal(uomForLegacy(emptyDb(), 'unit'), null);
});

test('default specifications are fresh and ensureUoms is immutable, idempotent and archive-safe', () => {
  const original = emptyDb();
  const db = ensureUoms(original);
  assert.deepEqual(original, emptyDb());
  assert.equal(search(db, 'uom.category').length, 5);
  assert.equal(search(db, 'uom.uom').length, 12);
  for (const c of search(db, 'uom.category')) {
    assert.equal(search(db, 'uom.uom').filter((u) => u.category_id === c.id && u.uom_type === 'reference').length, 1);
  }
  assert.equal(ensureUoms(db), db);
  const archived = write(db, 'uom.uom', named(db, 'g'), { active: false, rounding: 0.5 });
  assert.equal(ensureUoms(archived), archived);
  const specs = defaultUoms();
  specs[0].uoms[0].ratio = 99;
  assert.equal(defaultUoms()[0].uoms[0].ratio, 1);
});

test('the unchanged seed loads with legacy product units and accepts UoM initialization', () => {
  const db = seed();
  assert.ok(search(db, 'product').length > 0);
  assert.equal(read(db, 'product', 1).uom, 'unit');
  const after = ensureUoms(db);
  assert.deepEqual(after.records.product, db.records.product);
  assert.equal(ensureUoms(after), after);
});
