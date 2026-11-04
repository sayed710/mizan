import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from './orm.js';
import { seed } from './seed.js';
import { migrate, SCHEMA_VERSION } from './migrations.js';
import { postMove } from './models/accounting.js';
import { analyticActuals } from './models/finance.js';

test('journal entry analytics use the accounting date when posted and backfilled', () => {
  const analytic = create(seed(), 'account.analytic.account', { name: 'Historical entry' });
  const accounts = search(analytic.db, 'account.account');
  const expense = accounts.find((account) => account.code === '600000');
  const cash = accounts.find((account) => account.account_type === 'asset_cash');
  const move = create(analytic.db, 'account.move', {
    move_type: 'entry', date: '2020-12-31', invoice_date: '2021-01-15', line_ids: [
      { account_id: expense.id, debit: 100, analytic_distribution: { [analytic.id]: 100 } },
      { account_id: cash.id, credit: 100 },
    ],
  });
  const posted = postMove(move.db, move.id);
  const lines = (db) => search(db, 'account.analytic.line').filter((line) => line.move_id === move.id);
  const legacy = { ...posted, schema_version: 18, records: { ...posted.records,
    'account.analytic.line': posted.records['account.analytic.line'].filter((line) => line.move_id !== move.id),
  } };
  assert.deepEqual(lines(migrate(legacy)).map((line) => [line.date, line.amount]), [['2020-12-31', -100]]);
  assert.deepEqual(lines(posted).map((line) => [line.date, line.amount]), [['2020-12-31', -100]]);
});

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
