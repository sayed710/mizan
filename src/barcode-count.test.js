import { test } from 'node:test';
import assert from 'node:assert/strict';
import { read, search } from './orm.js';
import { seed } from './seed.js';
import { adjustQuantity } from './models/valuation.js';
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
