import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { depreciationBoard, assetModels, confirmAsset } from './models/assets.js';
import { accountingModels } from './models/accounting.js';
import { create, read } from './orm.js';
import { seed } from './seed.js';
import { diffDb, applyDiff } from './sync.js';
import { assetAccounts } from './test-support/asset-accounts.js';

const base = { acquisition_date: '2026-03-15', prorata_date: '2026-03-15', original_value: 12000, method: 'linear', method_number: 5, method_period: '12', prorata_computation_type: 'constant_periods' };
const lines = (asset) => depreciationBoard(asset).map(({ date, amount, remaining }) => [date, amount, remaining]);
const years = (values) => values.map(([amount, remaining], i) => [`${2026 + i}-12-31`, amount, remaining]);
const boards = [
  ['constant yearly', {}, years([[1909.68, 10090.32], [2400, 7690.32], [2400, 5290.32], [2400, 2890.32], [2400, 490.32], [490.32, 0]])],
  ['daily yearly', { prorata_computation_type: 'daily_computation' }, years([[1918.95, 10081.05], [2398.68, 7682.37], [2405.26, 5277.11], [2398.69, 2878.42], [2398.68, 479.74], [479.74, 0]])],
  ['no prorata', { prorata_computation_type: 'none', prorata_date: '2026-01-01' }, years([[2400, 9600], [2400, 7200], [2400, 4800], [2400, 2400], [2400, 0]])],
  ['constant monthly', { method_number: 12, method_period: '1' }, [
    ['2026-03-31', 548.39, 11451.61], ['2026-04-30', 1000, 10451.61], ['2026-05-31', 1000, 9451.61], ['2026-06-30', 1000, 8451.61], ['2026-07-31', 1000, 7451.61], ['2026-08-31', 1000, 6451.61], ['2026-09-30', 1000, 5451.61], ['2026-10-31', 1000, 4451.61], ['2026-11-30', 1000, 3451.61], ['2026-12-31', 1000, 2451.61], ['2027-01-31', 1000, 1451.61], ['2027-02-28', 1000, 451.61], ['2027-03-31', 451.61, 0],
  ]],
  ['rate', { method_mode: 'rate', method_rate: 0.25 }, years([[2387.1, 9612.9], [3000, 6612.9], [3000, 3612.9], [3000, 612.9], [612.9, 0]])],
  ['declining', { method: 'degressive', method_progress_factor: 0.3 }, years([[2864.52, 9135.48], [2740.64, 6394.84], [1995.71, 4399.13], [1995.7, 2403.43], [1995.71, 407.72], [407.72, 0]])],
  ['declining then straight line', { method: 'degressive_then_linear', method_progress_factor: 0.3 }, years([[2864.52, 9135.48], [2740.64, 6394.84], [2400, 3994.84], [2400, 1594.84], [1594.84, 0]])],
  ['no depreciation', { method: 'no_depreciation' }, []],
];
for (const [name, changes, expected] of boards) test(`Odoo golden: ${name}`, () => assert.deepEqual(lines({ ...base, ...changes }), expected));

test('asset and model expose the reference fields', () => {
  for (const model of [assetModels['account.asset'], accountingModels['account.asset.model']]) {
    for (const field of ['method_mode', 'method_rate', 'prorata_computation_type', 'prorata_date']) assert.ok(model.fields[field]);
    assert.ok(model.fields.method.options.some(([value]) => value === 'no_depreciation'));
  }
  const model = accountingModels['account.asset.model'];
  assert.equal(assetModels['account.asset'].fields.method.readonly({ state: 'draft', model_id: 1 }), true);
  assert.equal(model.fields.method_number.type, 'float');
  assert.deepEqual(model.onchange({ method_mode: 'duration', method_number: 5 }, 'method_number'), { method_rate: 0.2 });
  assert.deepEqual(model.onchange({ method_mode: 'rate', method_rate: 0.25 }, 'method_rate'), { method_number: 4 });
});

test('confirmed asset settings are guarded through a plain diff', () => {
  const db = seed();
  const made = create(db, 'account.asset', { ...assetAccounts(db), name: 'Machine', ...base });
  const opened = confirmAsset(made.db, read(made.db, 'account.asset', made.id));
  const asset = read(opened, 'account.asset', made.id);
  for (const change of [{ prorata_computation_type: 'daily_computation' }, { prorata_date: '2026-04-01' }, { method_mode: 'rate' }]) {
    const forged = { ...opened, records: { ...opened.records, 'account.asset': opened.records['account.asset'].map((r) => r.id === asset.id ? { ...r, ...change } : r) } };
    assert.throws(() => applyDiff(opened, diffDb(opened, forged), { isAdmin: true }), /core asset fields/i);
  }
});
