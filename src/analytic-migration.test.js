import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from './orm.js';
import { seed } from './seed.js';
import { migrate, SCHEMA_VERSION } from './migrations.js';
import { postMove } from './models/accounting.js';
import { analyticActuals } from './models/finance.js';

test('migration restores historical analytic actuals without duplicating posted allocations', () => {
  const analytic = create(seed(), 'account.analytic.account', { name: 'Historical project' });
  let db = analytic.db;
  const ids = [];
  for (const type of ['out_invoice', 'in_invoice', 'in_refund']) {
    const move = create(db, 'account.move', {
      move_type: type, partner_id: 1, invoice_date: '2026-01-10',
      invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, analytic_account_id: analytic.id }],
    });
    db = postMove(move.db, move.id);
    ids.push(move.id);
  }
  const originalLines = search(db, 'account.analytic.line').filter((line) => ids.includes(line.move_id));
  assert.equal(originalLines.length, 3);
  const legacy = { ...db, schema_version: 18, records: { ...db.records,
    'account.analytic.line': db.records['account.analytic.line'].filter((line) => line.move_id !== ids[0]),
  } };
  assert.equal(analyticActuals(legacy).get(analytic.id), 0);
  const migrated = migrate(legacy);
  assert.equal(migrated.schema_version, SCHEMA_VERSION);
  assert.equal(analyticActuals(migrated).get(analytic.id), 100);
  assert.deepEqual(search(migrated, 'account.analytic.line').filter((line) => ids.includes(line.move_id)).map((line) => [line.move_id, line.amount]).sort(), originalLines.map((line) => [line.move_id, line.amount]).sort());
  assert.equal(read(migrated, 'account.move', ids[0]).state, 'posted');
  assert.equal(migrate(migrated), migrated);
  const rerun = migrate({ ...migrated, schema_version: 18 });
  assert.equal(search(rerun, 'account.analytic.line').filter((line) => ids.includes(line.move_id)).length, 3);
});
