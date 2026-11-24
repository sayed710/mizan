import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeMoveHash } from './models/hash_chain.js';
import { purchaseLineId } from './models/purchase-links.js';
import { migrate } from './migrations.js';

test('migration 64 assigns stable IDs and resolves legacy bill keys without positions', () => {
  const db = { schema_version: 63, records: {
    'purchase.order': [{ id: 1, order_line: [{ purchase_line_key: 'first' }, { id: 42, purchase_line_key: 'second' }] }],
    'account.move': [{ move_type: 'in_invoice', purchase_id: 1, invoice_line_ids: [{ purchase_line_key: 'first' }] }],
  } };
  const result = migrate(db);
  assert.equal(result.schema_version, 76);
  const line = result.records['purchase.order'][0].order_line[0];
  assert.equal(line.id, 43);
  assert.deepEqual(result.records['account.move'][0].invoice_line_ids[0], { purchase_line_id: line.id });
  const bad = structuredClone(db);
  bad.records['account.move'][0].invoice_line_ids[0].purchase_line_key = 'missing';
  assert.deepEqual(migrate(bad).records['account.move'][0].invoice_line_ids[0], { purchase_line_key: 'missing' });
});


test('legacy link error has readable Arabic translation', () => {
  const source = readFileSync(new URL('./i18n.js', import.meta.url), 'utf8');
  assert.match(source, /'Unable to resolve purchase order line for vendor bill': '[\u0600-\u06ff]/);
});


test('migration preserves secured payload and resolves its legacy link on read', () => {
  const move = { id: 1, move_type: 'in_invoice', purchase_id: 1, inalterable_hash_version: 2, invoice_line_ids: [{ purchase_line_key: 'legacy' }], line_ids: [] };
  move.inalterable_hash = computeMoveHash(move, '', 2);
  const db = { schema_version: 63, records: { 'purchase.order': [{ id: 1, order_line: [{ purchase_line_key: 'legacy' }] }], 'account.move': [move] } };
  const migrated = migrate(db);
  assert.equal(migrated.schema_version, 76);
  const secured = migrated.records['account.move'][0];
  assert.deepEqual(secured, move);
  assert.equal(computeMoveHash(secured, '', 2), secured.inalterable_hash);
  assert.equal(purchaseLineId(migrated, secured.invoice_line_ids[0], 1), migrated.records['purchase.order'][0].order_line[0].id);
});
