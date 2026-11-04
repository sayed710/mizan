import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, write } from './orm.js';
import { seed } from './seed.js';
import { productTax } from './models/taxes.js';

test('9. a product without a tax record keeps its plain rate and never borrows a same-rate tax record', () => {
  const db0 = seed();
  const other = create(db0, 'account.tax', { name: 'Other 14%', type_tax_use: 'sale', amount_type: 'percent', amount: 14 });
  const db = write(other.db, 'product', 7, { tax_id: null, sale_tax: 14 });
  const tax = productTax(db, read(db, 'product', 7), 'sale', null);
  assert.equal(tax.tax_id, null);
  assert.equal(tax.tax, 14);
});

test('9. a product with an explicit tax record uses that record', () => {
  const db = seed();
  const product = read(db, 'product', 1);
  assert.equal(productTax(db, product, 'sale', null).tax_id, product.tax_id);
});
