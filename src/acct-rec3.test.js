import { test } from 'node:test';
import assert from 'node:assert/strict';

import { create, read, write } from './orm.js';
import { seed } from './seed.js';
import { diffDb, applyDiff } from './sync.js';
import { migrate, migrateReconcileModelTolerance } from './migrations.js';

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

test('upgrade brings percentage tolerances above 100 down to 100, leaving amount tolerances intact, allowing subsequent edits and deactivation', () => {
  const base = seed();
  const legacyRule1 = { id: 801, name: 'Legacy 150% rule', company_id: 1, rule_type: 'matching_rule', trigger: 'manual', payment_tolerance_type: 'percentage', payment_tolerance: 150, active: true };
  const legacyRule2 = { id: 802, name: 'Legacy 150 amount rule', company_id: 1, rule_type: 'matching_rule', trigger: 'manual', payment_tolerance_type: 'amount', payment_tolerance: 150, active: true };
  const legacyRule3 = { id: 803, name: 'Legacy untyped 120 rule', company_id: 1, rule_type: 'matching_rule', trigger: 'manual', payment_tolerance: 120, active: true };
  const legacyRule4 = { id: 804, name: 'Legacy 50% rule', company_id: 1, rule_type: 'matching_rule', trigger: 'manual', payment_tolerance_type: 'percentage', payment_tolerance: 50, active: true };

  const legacyDb = {
    ...base,
    schema_version: 66,
    records: {
      ...base.records,
      [MODEL]: [...(base.records[MODEL] ?? []), legacyRule1, legacyRule2, legacyRule3, legacyRule4],
    },
  };

  // Before migration, editing or deactivating the 150% rule fails validation
  assert.throws(() => write(legacyDb, MODEL, 801, { active: false }), /cannot exceed 100/);
  assert.throws(() => write(legacyDb, MODEL, 801, { name: 'Renamed' }), /cannot exceed 100/);

  // Upgrade the database
  const upgraded = migrate(legacyDb);
  assert.equal(upgraded.schema_version, 70);

  const r1 = read(upgraded, MODEL, 801);
  const r2 = read(upgraded, MODEL, 802);
  const r3 = read(upgraded, MODEL, 803);
  const r4 = read(upgraded, MODEL, 804);

  assert.equal(r1.payment_tolerance, 100, 'percentage tolerance capped to 100');
  assert.equal(r2.payment_tolerance, 150, 'amount tolerance remains unchanged');
  assert.equal(r3.payment_tolerance, 100, 'untyped tolerance (default percentage) capped to 100');
  assert.equal(r4.payment_tolerance, 50, 'tolerance under 100 left unchanged');

  // After upgrade, editing an unrelated field succeeds
  const edited = write(upgraded, MODEL, 801, { name: 'Updated 100% rule' });
  assert.equal(read(edited, MODEL, 801).name, 'Updated 100% rule');

  // After upgrade, deactivation succeeds
  const deactivated = write(edited, MODEL, 801, { active: false });
  assert.equal(read(deactivated, MODEL, 801).active, false);

  // Migration is idempotent
  assert.strictEqual(migrate(upgraded), upgraded);
  assert.strictEqual(migrateReconcileModelTolerance(upgraded), upgraded);
});
