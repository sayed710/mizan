import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { activeRootPlans } from './models/analyticplus.js';
import { create, read, groupRecords } from './orm.js';

test('analytic lines resolve and group by their root plan', () => {
  let db = seed();
  const p1 = create(db, 'account.analytic.plan', { name: 'First plan' }); db = p1.db;
  const p2 = create(db, 'account.analytic.plan', { name: 'Second plan' }); db = p2.db;
  const child = create(db, 'account.analytic.plan', { name: 'Child plan', parent_id: p1.id }); db = child.db;
  const a = create(db, 'account.analytic.account', { name: 'First account', plan_id: child.id }); db = a.db;
  const b = create(db, 'account.analytic.account', { name: 'Second account', plan_id: p2.id }); db = b.db;
  const l1 = create(db, 'account.analytic.line', { name: 'One', date: '2026-01-01', account_id: a.id, amount: 12 }); db = l1.db;
  const l2 = create(db, 'account.analytic.line', { name: 'Two', date: '2026-01-01', account_id: b.id, amount: 7 }); db = l2.db;
  const lines = [read(db, 'account.analytic.line', l1.id), read(db, 'account.analytic.line', l2.id)];
  assert.deepEqual(lines.map((l) => [l.account_id, l.plan_id]), [[a.id, p1.id], [b.id, p2.id]]);
  const groups = groupRecords(db, 'account.analytic.line', lines, 'plan_id');
  assert.equal(groups.find((g) => g.key === p1.id).records.reduce((sum, l) => sum + l.amount, 0), 12);
  assert.equal(groups.find((g) => g.key === p2.id).records.reduce((sum, l) => sum + l.amount, 0), 7);
});

test('archived root plans are not offered', () => {
  let db = seed();
  const plan = create(db, 'account.analytic.plan', { name: 'Archived plan', active: false }); db = plan.db;
  assert.equal(activeRootPlans(db).some((p) => p.id === plan.id), false);
});
