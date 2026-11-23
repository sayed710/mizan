import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apps, findLeaf, models } from './models/index.js';
import { moreModels } from './models/more.js';
import { seed } from './seed.js';
import { create, read, search, write } from './orm.js';
import { diffDb, applyDiff } from './sync.js';
import { migrate, SCHEMA_VERSION } from './migrations.js';

const model = 'account.analytic.line';
const leaf = (app, key) => findLeaf(apps.find((item) => item.id === app), key);
const force = (db, id, vals) => ({ ...db, records: { ...db.records, [model]: db.records[model].map((r) => r.id === id ? { ...r, ...vals } : r) } });

test('ANI-1 accounting analytic views are distinct from the timesheet leaf', () => {
  const accounting = leaf('accounting', 'analytic-items');
  const timesheets = leaf('timesheets', 'timesheets');
  assert.deepEqual(accounting.list, ['date', 'name', 'account_id', 'company_id', 'amount']);
  assert.deepEqual(accounting.groupBy, ['account_id']);
  assert.ok(accounting.form.groups.flat().includes('general_account'));
  assert.equal(timesheets.form, undefined);
  assert.equal(timesheets.list, undefined);
  assert.deepEqual(models[model].list.slice(0, moreModels[model].list.length), moreModels[model].list);
  assert.deepEqual(models[model].form.groups.slice(0, moreModels[model].form.groups.length), moreModels[model].form.groups);
  assert.equal(timesheets.domain({ category: 'timesheet' }), true);
  assert.equal(timesheets.domain({ category: 'other' }), false);
});

test('ANI-2 manual amounts can be changed through sync while generated amounts cannot', () => {
  const a = create(seed(), 'account.analytic.account', { name: 'Analytic' });
  const manual = create(a.db, model, { name: 'Manual', category: 'other', account_id: a.id, amount: 10 });
  assert.equal(models[model].fields.amount.readonly(read(manual.db, model, manual.id)), false);
  const staged = write(manual.db, model, manual.id, { amount: 35 });
  const saved = applyDiff(manual.db, diffDb(manual.db, staged), { isAdmin: true });
  assert.equal(read(saved, model, manual.id).amount, 35);
  const generated = force(saved, manual.id, { move_id: 1, category: 'invoice' });
  assert.equal(models[model].fields.amount.readonly(read(generated, model, manual.id)), true);
  for (const vals of [{ amount: 50 }, { move_id: null }, { category: 'other' }]) {
    assert.throws(() => applyDiff(generated, diffDb(generated, force(generated, manual.id, vals)), { isAdmin: true }), /read-only/);
  }
});

test('ANI-3 migration resolves exact company codes and reports unmatched or ambiguous values', () => {
  const base = seed();
  const accounts = [
    { id: 7001, code: 'SAME', name: 'First', company_id: 1 },
    { id: 7002, code: 'SAME', name: 'Second', company_id: 2 },
    { id: 7003, code: 'DUP', name: 'Duplicate A', company_id: 1 },
    { id: 7004, code: 'DUP', name: 'Duplicate B', company_id: 1 },
  ];
  const lines = [
    { id: 8001, name: 'First', date: '2026-01-01', company_id: 1, general_account: 'SAME' },
    { id: 8002, name: 'Second', date: '2026-01-01', company_id: 2, general_account: 'SAME' },
    { id: 8003, name: 'Missing', date: '2026-01-01', company_id: 1, general_account: 'UNKNOWN' },
    { id: 8004, name: 'Ambiguous', date: '2026-01-01', company_id: 1, general_account: 'DUP' },
  ];
  const old = { ...base, schema_version: 67, records: { ...base.records, 'account.account': [...base.records['account.account'], ...accounts], [model]: lines } };
  const db = migrate(old);
  assert.equal(SCHEMA_VERSION, 68);
  assert.deepEqual(db.records[model].map((r) => r.general_account), [7001, 7002, null, null]);
  assert.deepEqual(db.records[model].slice(2).map((r) => r.legacy_general_account), ['UNKNOWN', 'DUP']);
  assert.equal(db.messages.filter((m) => m.model === model && [8003, 8004].includes(m.res_id)).length, 2);
  assert.equal(migrate(db), db);
  assert.equal(models[model].fields.general_account.relation, 'account.account');
  const analytic = create(seed(), 'account.analytic.account', { name: 'Manual' });
  const line = create(analytic.db, model, { name: 'Manual', category: 'other', account_id: analytic.id });
  const foreign = { ...line.db, records: { ...line.db.records, 'account.account': [...line.db.records['account.account'], accounts[1]] } };
  const invalid = force(foreign, line.id, { general_account: 7002 });
  assert.throws(() => applyDiff(foreign, diffDb(foreign, invalid), { isAdmin: true }), /line company/);
  const valid = search(foreign, 'account.account').find((a) => (a.company_id ?? 1) === 1);
  const updated = applyDiff(foreign, diffDb(foreign, force(foreign, line.id, { general_account: valid.id })), { isAdmin: true });
  assert.equal(read(updated, model, line.id).general_account, valid.id);
});
