import test from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { migrate, SCHEMA_VERSION } from './migrations.js';
import { create, read, write } from './orm.js';
import { diffDb, applyDiff } from './sync.js';
import { apps, models } from './models/index.js';
import { analyticAccountingEnabled, visibleAccountingMenus } from './models/analytic-setting.js';

const toggle = (db, enabled, isAdmin = true) => applyDiff(db, diffDb(db, write(db, 'res.company', 1, { group_analytic_accounting: enabled })), { isAdmin });
const leaves = (items) => items.flatMap((item) => item.children ? leaves(item.children) : [item.key]);

test('SET5-1: analytic accounting defaults off and is an administrator-controlled setting', () => {
  const db = seed();
  assert.equal(analyticAccountingEnabled(db), false);
  assert.throws(() => toggle(db, true, false), /Only administrators/);
  const enabled = toggle(db, true);
  assert.equal(read(enabled, 'res.company', 1).group_analytic_accounting, true);
  assert.equal(analyticAccountingEnabled(toggle(enabled, false)), false);
});

test('SET5-2: menus and move line fields follow setting without changing distributions', () => {
  let db = seed();
  db = create(db, 'account.analytic.plan', { name: 'Projects' }).db;
  const analytic = create(db, 'account.analytic.account', { name: 'Project' }); db = analytic.db;
  const move = create(db, 'account.move', { move_type: 'out_invoice', invoice_line_ids: [{ name: 'Work', qty: 1, price_unit: 10, analytic_distribution: { [analytic.id]: 100 } }] }); db = move.db;
  const menus = apps.find((app) => app.id === 'accounting').menus;
  const keys = ['analytic-items', 'analytic-report', 'analytic-distribution-models', 'analytic', 'analytic-plans'];
  const fields = models['account.move'].fields;
  const visible = (data, type, field) => Object.fromEntries(fields[field].columnsFor({ move_type: type, company_id: 1 }, data)).analytic_distribution;
  for (const enabled of [false, true, false, true]) {
    if (analyticAccountingEnabled(db) !== enabled) db = toggle(db, enabled);
    const shown = leaves(visibleAccountingMenus(menus, db));
    keys.forEach((key) => assert.equal(shown.includes(key), enabled, key));
    for (const type of ['out_invoice', 'in_invoice']) assert.equal(Boolean(visible(db, type, 'invoice_line_ids')), enabled);
    assert.equal(Boolean(visible(db, 'entry', 'line_ids')), enabled);
    assert.deepEqual(read(db, 'account.move', move.id).invoice_line_ids[0].analytic_distribution, { [analytic.id]: 100 });
  }
});


test('SET5: migration preserves analytics for existing companies while fresh databases default off', () => {
  const fresh = seed();
  assert.equal(fresh.schema_version, SCHEMA_VERSION);
  assert.equal(analyticAccountingEnabled(fresh), false);
  const { group_analytic_accounting: _setting, ...legacyCompany } = read(fresh, 'res.company', 1);
  const legacy = { ...fresh, schema_version: 67, records: { ...fresh.records, 'res.company': [legacyCompany, { id: 2 }, { id: 3, group_analytic_accounting: null }, { id: 4, group_analytic_accounting: false }, { id: 5, group_analytic_accounting: true }] } };
  const upgraded = migrate(legacy);
  assert.equal(upgraded.schema_version, 68);
  assert.deepEqual(upgraded.records['res.company'].map((company) => company.group_analytic_accounting), [true, true, true, false, true]);
  assert.equal(analyticAccountingEnabled(upgraded), true);
  assert.ok(leaves(visibleAccountingMenus(apps.find((app) => app.id === 'accounting').menus, upgraded)).includes('analytic-items'));
  assert.ok(Object.fromEntries(models['account.move'].fields.invoice_line_ids.columnsFor({ move_type: 'out_invoice', company_id: 1 }, upgraded)).analytic_distribution);
  assert.equal(migrate(upgraded), upgraded);
  assert.equal(Object.hasOwn(legacy.records['res.company'][0], 'group_analytic_accounting'), false);
});
