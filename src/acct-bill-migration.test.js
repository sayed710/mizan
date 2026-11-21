import test from 'node:test';
import assert from 'node:assert/strict';
import { migrate } from './migrations.js';

test('migration 62 assigns stable IDs and resolves legacy bill keys without positions', () => {
  const db = { schema_version: 61, records: {
    'purchase.order': [{ id: 1, order_line: [{ purchase_line_key: 'first' }, { id: 42, purchase_line_key: 'second' }] }],
    'account.move': [{ move_type: 'in_invoice', purchase_id: 1, invoice_line_ids: [{ purchase_line_key: 'first' }] }],
  } };
  const result = migrate(db);
  const line = result.records['purchase.order'][0].order_line[0];
  assert.equal(line.id, 43);
  assert.deepEqual(result.records['account.move'][0].invoice_line_ids[0], { purchase_line_id: line.id });
  const bad = structuredClone(db);
  bad.records['account.move'][0].invoice_line_ids[0].purchase_line_key = 'missing';
  assert.throws(() => migrate(bad), /Unable to resolve purchase order line/);
});
