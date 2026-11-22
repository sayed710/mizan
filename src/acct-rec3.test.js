import { test } from 'node:test';
import assert from 'node:assert/strict';

import { create, write } from './orm.js';
import { seed } from './seed.js';
import { diffDb, applyDiff } from './sync.js';

const MODEL = 'account.reconcile.model';
const rule = (vals) => ({ name: 'Tolerance rule', rule_type: 'matching_rule', trigger: 'manual', payment_tolerance_type: 'percentage', ...vals });

test('a percentage payment tolerance above 100 is refused on create, write and replayed diffs', () => {
  const db = seed();
  assert.throws(() => create(db, MODEL, rule({ payment_tolerance: 150 })), /cannot exceed 100/);
  const ok = create(db, MODEL, rule({ payment_tolerance: 100 }));
  assert.throws(() => write(ok.db, MODEL, ok.id, { payment_tolerance: 101 }), /cannot exceed 100/);
  assert.doesNotThrow(() => write(ok.db, MODEL, ok.id, { payment_tolerance_type: 'amount', payment_tolerance: 250 }));
  const forged = { ...ok.db, records: { ...ok.db.records, [MODEL]: ok.db.records[MODEL].map((r) => (r.id === ok.id ? { ...r, payment_tolerance: 120 } : r)) } };
  assert.throws(() => applyDiff(ok.db, diffDb(ok.db, forged)), /cannot exceed 100/);
});
