import { test } from 'node:test';
import assert from 'node:assert/strict';
import { read, search, write } from './orm.js';
import { generateVariants, parseAttributes } from './models/sales.js';
import { seed } from './seed.js';

test('attribute text parses into value groups', () => {
  assert.deepEqual(parseAttributes('Color: Red, Blue; Size: S, M, L'), [['Red', 'Blue'], ['S', 'M', 'L']]);
  assert.deepEqual(parseAttributes(' ; Color: '), []);
});

test('generating variants creates every combination once', () => {
  const db0 = write(seed(), 'product', 1, { attributes: 'Color: Black, Grey; Arms: Yes, No' });
  const db1 = generateVariants(db0, read(db0, 'product', 1));
  const variants = search(db1, 'product').filter((p) => p.variant_of === 1);
  assert.equal(variants.length, 4);
  assert.ok(variants.some((v) => v.name === 'Ergonomic Chair (Grey, No)' && v.list_price === 210));
  const db2 = generateVariants(db1, read(db1, 'product', 1)); // idempotent
  assert.equal(search(db2, 'product').filter((p) => p.variant_of === 1).length, 4);
});
