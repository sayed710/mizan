import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed } from '../src/seed.js';
import { read, write } from '../src/orm.js';
import { startSession } from '../src/models/pos.js';
import { runPosting } from './posting.js';
import { applyDiff, diffDb } from '../src/sync.js';

test('a POS payment retry returns its original booking and server total after catalog changes', () => {
  const db = startSession(seed(), 0).db;
  const body = { request_key: 'cashier-sale-unique', method: 'cash', lines: [{ product_id: 1, qty: 1 }] };
  const first = runPosting(db, null, '/api/pos/pay', body);
  const stored = applyDiff(db, diffDb(db, first.db), { isAdmin: true });
  const changed = write(stored, 'product', 1, { list_price: 9999 });
  const retry = runPosting(changed, null, '/api/pos/pay', body);
  assert.equal(retry.body.id, first.body.id);
  assert.equal(retry.db, changed);
  assert.equal(first.body.total, read(stored, 'pos.order', first.body.id).amount_total);
  assert.equal(retry.body.total, first.body.total);
  assert.throws(() => runPosting(changed, null, '/api/pos/pay', { ...body, method: 'card' }), /already used|different payment/);
});
