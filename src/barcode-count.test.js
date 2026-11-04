import { test } from 'node:test';
import assert from 'node:assert/strict';
import { read, search } from './orm.js';
import { seed } from './seed.js';
import { createCompany } from './models/company.js';
import { adjustQuantity, countProduct } from './models/valuation.js';
import { modelsForApps } from './models/index.js';
import { applyDiff, diffDb } from './sync.js';

test('a barcode count is a valued inventory adjustment with a journal entry (MOD-004)', () => {
  const db = seed();
  const before = read(db, 'product', 2).qty_available;
  const next = adjustQuantity(db, 2, before + 3);
  assert.equal(read(next, 'product', 2).qty_available, before + 3);
  const layer = search(next, 'stock.valuation.layer').filter((l) => l.product_id === 2 && l.kind === 'adjustment').at(-1);
  assert.equal(layer.quantity, 3);
  assert.ok(layer.value > 0);
  assert.equal(search(next, 'account.move').length, search(db, 'account.move').length + 1);
  // What the Barcode page sends is accepted by the server as it is.
  assert.equal(read(applyDiff(db, diffDb(db, next), { isAdmin: false, author: 'Clerk' }), 'product', 2).qty_available, before + 3);
  assert.throws(() => adjustQuantity(db, 2, -1), /Counted quantity/);
});

const ACTION_MODELS = ['stock.inventory.count', 'stock.valuation.layer', 'account.move'];

test('a barcode-only user can apply a count through the server action, and not by writing accounting records', () => {
  const db = seed();
  const before = read(db, 'product', 2).qty_available;
  const allowed = modelsForApps(['barcode']);
  const next = countProduct(db, { productId: 2, counted: before + 2, observed: before });
  assert.throws(() => applyDiff(db, diffDb(db, next), { isAdmin: false, author: 'Scanner', allowed }), /access|not allowed|permission/i);
  const stored = applyDiff(db, diffDb(db, next), { isAdmin: false, author: 'Scanner', allowed: new Set([...allowed, ...ACTION_MODELS]) });
  assert.equal(read(stored, 'product', 2).qty_available, before + 2);
});

test('a count from a stale view is refused, so a second counter cannot overwrite the first', () => {
  const db = seed();
  const before = read(db, 'product', 2).qty_available;
  const first = countProduct(db, { productId: 2, counted: before + 1, observed: before });
  const stored = applyDiff(db, diffDb(db, first), { isAdmin: false, author: 'A' });
  assert.throws(() => countProduct(stored, { productId: 2, counted: before + 5, observed: before }), /changed to .* scan it again/);
  assert.equal(read(stored, 'product', 2).qty_available, before + 1); // the first count stands
});

test('a count made in company 2 books its count, layer and entry under company 2', () => {
  const company = createCompany(seed(), { name: 'Company two' });
  const db = company.db;
  const before = read(db, 'product', 2).qty_available;
  const next = countProduct(db, { productId: 2, counted: before + 1, observed: before, company: company.id });
  const added = (model) => next.records[model].filter((r) => !db.records[model]?.some((o) => o.id === r.id));
  for (const model of ['stock.inventory.count', 'stock.valuation.layer', 'account.move']) {
    assert.ok(added(model).length, model);
    assert.ok(added(model).every((r) => r.company_id === 2), `${model} belongs to company 2`);
  }
});
