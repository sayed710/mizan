import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { depreciationBoard, assetModels, confirmAsset, modifyAsset, postDepreciation } from './models/assets.js';
import { accountingModels } from './models/accounting.js';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { models } from './registry.js';
import { diffDb, applyDiff } from './sync.js';
import { assetAccounts } from './test-support/asset-accounts.js';
import { postMove } from './models/accounting.js';
import { changeFormValue, newDefaults } from './views/formDefaults.js';

const run = (db, model, id, label) => models[model].form.buttons.find((b) => b.label === label).run(db, read(db, model, id));

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

test('Finding 1 regression: monthly rate mode uses consistent conversion factor and synchronizes onchange', () => {
  const model = accountingModels['account.asset.model'];
  assert.deepEqual(model.onchange({ method_period: '1', method_mode: 'duration', method_number: 4 }, 'method_number'), { method_rate: 0.25 });
  assert.deepEqual(model.onchange({ method_period: '1', method_mode: 'rate', method_rate: 0.25 }, 'method_rate'), { method_number: 4 });
  assert.deepEqual(model.onchange({ method_period: '1', method_mode: 'rate', method_rate: 0.25 }, 'method_mode'), { method_number: 4 });

  const assetModel = assetModels['account.asset'];
  assert.deepEqual(assetModel.onchange({ method_mode: 'duration', method_number: 4 }, 'method_number'), { method_rate: 0.25 });
  assert.deepEqual(assetModel.onchange({ method_mode: 'rate', method_rate: 0.25 }, 'method_rate'), { method_number: 4 });

  const board = depreciationBoard({
    ...base,
    method_period: '1',
    method_mode: 'rate',
    method_rate: 0.25,
    prorata_computation_type: 'none',
    prorata_date: '2026-03-01',
  });
  assert.equal(board.length, 4);
  assert.equal(board.at(-1).remaining, 0);
});

test('Finding 2 regression: modifyAsset allows fractional remaining durations', () => {
  const db = seed();
  const made = create(db, 'account.asset', { ...assetAccounts(db), name: 'Laptop', ...base, method_number: 5 });
  const opened = confirmAsset(made.db, read(made.db, 'account.asset', made.id));
  const asset = read(opened, 'account.asset', made.id);

  const modifiedDb = modifyAsset(opened, asset, { methodNumber: 1.5, date: '2026-03-15' });
  const modified = read(modifiedDb, 'account.asset', asset.id);
  assert.equal(modified.method_number, 1.5);
  assert.equal(modified.depreciation_ids.length, 2);
  assert.equal(modified.depreciation_ids.at(-1).remaining, 0);

  const wizard = assetModels['account.asset'].form.buttons.find((b) => b.label === 'Modify Depreciation').wizard();
  assert.equal(wizard.fields.find((f) => f.name === 'method_number').type, 'float');
});

test('Finding 4 regression: month-end daily asset clamps anniversary to target month end', () => {
  const asset = {
    original_value: 1000,
    salvage_value: 0,
    acquisition_date: '2026-01-31',
    prorata_date: '2026-01-31',
    method: 'linear',
    method_number: 1,
    method_period: '1',
    prorata_computation_type: 'daily_computation',
  };
  const board = depreciationBoard(asset);
  assert.equal(board.at(-1).date, '2026-02-28');
  assert.equal(board.at(-1).remaining, 0);
  assert.equal(board.reduce((s, l) => s + l.amount, 0), 1000);
});

test('Finding 5 regression: no_depreciation asset can be modified and retains empty board without closing', () => {
  let db = seed();
  const made = create(db, 'account.asset', { ...assetAccounts(db), name: 'Land', ...base, method: 'no_depreciation', method_number: 5 });
  db = confirmAsset(made.db, read(made.db, 'account.asset', made.id));
  let asset = read(db, 'account.asset', made.id);
  assert.equal(asset.state, 'open');
  assert.deepEqual(asset.depreciation_ids, []);

  db = postDepreciation(db, asset);
  asset = read(db, 'account.asset', asset.id);
  assert.equal(asset.state, 'open');

  const counterpartId = assetAccounts(db).account_asset_id;
  db = modifyAsset(db, asset, { value_change: 3000, accountId: counterpartId, date: '2026-04-01' });
  asset = read(db, 'account.asset', asset.id);
  assert.equal(asset.original_value, 15000);
  assert.equal(asset.state, 'open');
  assert.deepEqual(asset.depreciation_ids, []);
  assert.equal(asset.revaluation_ids.length, 1);
  assert.equal(asset.revaluation_ids[0].amount, 3000);
});

test('Finding 6 regression: account.asset.model validates rate range and positive duration; vendor bill posting validates asset', () => {
  let db = seed();
  const accounts = assetAccounts(db);

  for (const badRate of [0, -0.1, 1.5]) {
    assert.throws(
      () => create(db, 'account.asset.model', {
        name: `Bad Rate ${badRate}`, method: 'linear', method_mode: 'rate', method_rate: badRate, method_number: 5,
        account_asset_id: accounts.account_asset_id,
        account_depreciation_id: accounts.account_depreciation_id,
        account_depreciation_expense_id: accounts.account_depreciation_expense_id,
      }),
      /Rate must be greater than zero and at most one/i,
    );
  }

  assert.throws(
    () => create(db, 'account.asset.model', {
      name: 'Bad Duration', method: 'linear', method_number: 0,
      account_asset_id: accounts.account_asset_id,
      account_depreciation_id: accounts.account_depreciation_id,
      account_depreciation_expense_id: accounts.account_depreciation_expense_id,
    }),
    /The duration must be positive/i,
  );

  const goodModel = create(db, 'account.asset.model', {
    name: 'Good Rate Model', method: 'linear', method_mode: 'rate', method_rate: 0.25, method_number: 4,
    account_asset_id: accounts.account_asset_id,
    account_depreciation_id: accounts.account_depreciation_id,
    account_depreciation_expense_id: accounts.account_depreciation_expense_id,
  });
  db = goodModel.db;
  const forged = { ...db, records: { ...db.records, 'account.asset.model': db.records['account.asset.model'].map((r) => r.id === goodModel.id ? { ...r, method_rate: 0 } : r) } };
  assert.throws(() => applyDiff(db, diffDb(db, forged), { isAdmin: true }), /Rate must be greater than zero and at most one/i);

  const fixedAccount = create(db, 'account.account', {
    code: '159999', name: 'Auto Validated Fixed Asset', account_type: 'asset_fixed',
    create_asset: 'validate', asset_model_id: goodModel.id,
  });
  db = fixedAccount.db;

  const bill = create(db, 'account.move', {
    move_type: 'in_invoice', partner_id: 2, invoice_date: '2026-06-01',
    invoice_line_ids: [{ name: 'Server', product_id: 1, qty: 1, price_unit: 4000, tax: 0, account_id: fixedAccount.id }],
  });
  db = postMove(bill.db, bill.id);

  const created = search(db, 'account.asset').find((a) => a.bill_id === bill.id);
  assert.ok(created);
  assert.equal(created.state, 'open');
  assert.equal(created.method_mode, 'rate');
  assert.equal(created.method_rate, 0.25);
  assert.equal(created.depreciation_ids.length > 0, true);
});

test('Qodo Finding 1 regression: direct asset create with model_id preserves model prorata computation and date', () => {
  let db = seed();
  const accounts = assetAccounts(db);
  const constantModel = create(db, 'account.asset.model', {
    name: 'Constant Prorata Model',
    method: 'linear',
    method_number: 5,
    method_period: '12',
    prorata_computation_type: 'constant_periods',
    ...accounts,
  });
  db = constantModel.db;

  const dailyModel = create(db, 'account.asset.model', {
    name: 'Daily Prorata Model',
    method: 'linear',
    method_number: 5,
    method_period: '12',
    prorata_computation_type: 'daily_computation',
    ...accounts,
  });
  db = dailyModel.db;

  const directConstant = create(db, 'account.asset', {
    name: 'Constant Linked Asset',
    model_id: constantModel.id,
    original_value: 12000,
    acquisition_date: '2026-03-15',
  });
  const constantRec = read(directConstant.db, 'account.asset', directConstant.id);
  assert.equal(constantRec.prorata_computation_type, 'constant_periods');
  assert.equal(constantRec.prorata_date, '2026-03-15');
  const confirmedConstant = confirmAsset(directConstant.db, constantRec);
  assert.deepEqual(
    read(confirmedConstant, 'account.asset', directConstant.id).depreciation_ids.map((l) => [l.date, l.amount, l.remaining]),
    years([[1909.68, 10090.32], [2400, 7690.32], [2400, 5290.32], [2400, 2890.32], [2400, 490.32], [490.32, 0]]),
  );

  const directDaily = create(db, 'account.asset', {
    name: 'Daily Linked Asset',
    model_id: dailyModel.id,
    original_value: 12000,
    acquisition_date: '2026-03-15',
  });
  const dailyRec = read(directDaily.db, 'account.asset', directDaily.id);
  assert.equal(dailyRec.prorata_computation_type, 'daily_computation');
  assert.equal(dailyRec.prorata_date, '2026-03-15');
  const confirmedDaily = confirmAsset(directDaily.db, dailyRec);
  assert.deepEqual(
    read(confirmedDaily, 'account.asset', directDaily.id).depreciation_ids.map((l) => [l.date, l.amount, l.remaining]),
    years([[1918.95, 10081.05], [2398.68, 7682.37], [2405.26, 5277.11], [2398.69, 2878.42], [2398.68, 479.74], [479.74, 0]]),
  );

  const overriddenNone = create(db, 'account.asset', {
    name: 'Overridden None Asset',
    model_id: dailyModel.id,
    original_value: 12000,
    acquisition_date: '2026-03-15',
    prorata_computation_type: 'none',
  });
  const noneRec = read(overriddenNone.db, 'account.asset', overriddenNone.id);
  assert.equal(noneRec.prorata_computation_type, 'none');
  assert.equal(noneRec.prorata_date, '2026-01-01');
});

test('Qodo Finding 2 regression: selecting a prorata model without explicit date updates prorata_date from acquisition_date', () => {
  let db = seed();
  const accounts = assetAccounts(db);
  const dailyModel = create(db, 'account.asset.model', {
    name: 'Daily Model',
    method: 'linear',
    method_number: 5,
    method_period: '12',
    prorata_computation_type: 'daily_computation',
    ...accounts,
  });
  db = dailyModel.db;

  const noProrataModel = create(db, 'account.asset.model', {
    name: 'No Prorata Model',
    method: 'linear',
    method_number: 5,
    method_period: '12',
    prorata_computation_type: 'none',
    ...accounts,
  });
  db = noProrataModel.db;

  const initial = newDefaults(db, 'account.asset', { defaults: {} }, new URLSearchParams(), null);
  let changes = {};
  changes = changeFormValue('account.asset', initial, changes, 'acquisition_date', '2026-03-15', db);
  assert.equal(changes.prorata_date, '2026-01-01');

  changes = changeFormValue('account.asset', initial, changes, 'model_id', dailyModel.id, db);
  assert.equal(changes.prorata_computation_type, 'daily_computation');
  assert.equal(changes.prorata_date, '2026-03-15');

  const created = create(db, 'account.asset', { ...initial, ...changes, name: 'Form Selected Daily', original_value: 12000 });
  const confirmed = confirmAsset(created.db, read(created.db, 'account.asset', created.id));
  assert.deepEqual(
    read(confirmed, 'account.asset', created.id).depreciation_ids.map((l) => [l.date, l.amount, l.remaining]),
    years([[1918.95, 10081.05], [2398.68, 7682.37], [2405.26, 5277.11], [2398.69, 2878.42], [2398.68, 479.74], [479.74, 0]]),
  );

  changes = changeFormValue('account.asset', initial, changes, 'model_id', noProrataModel.id, db);
  assert.equal(changes.prorata_computation_type, 'none');
  assert.equal(changes.prorata_date, '2026-01-01');
});

test('Qodo Finding 3 regression: reposting a bill on an unmodeled account clears rate mode, rate, and prorata fields', () => {
  let db = seed();
  const accounts = assetAccounts(db);
  const rateModel = create(db, 'account.asset.model', {
    name: 'Rate Prorata Model',
    method: 'linear',
    method_mode: 'rate',
    method_rate: 0.25,
    method_number: 4,
    method_period: '12',
    prorata_computation_type: 'constant_periods',
    account_asset_id: accounts.account_asset_id,
    account_depreciation_id: accounts.account_depreciation_id,
    account_depreciation_expense_id: accounts.account_depreciation_expense_id,
  });
  db = rateModel.db;

  const modeledAcc = create(db, 'account.account', {
    name: 'Modeled Rate Asset Acc',
    code: '151300',
    account_type: 'asset_fixed',
    create_asset: 'draft',
    asset_model_id: rateModel.id,
  });
  db = modeledAcc.db;

  const unmodeledAcc = create(db, 'account.account', {
    name: 'Unmodeled Asset Acc',
    code: '151400',
    account_type: 'asset_fixed',
    create_asset: 'draft',
  });
  db = unmodeledAcc.db;

  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 2,
    invoice_date: '2026-03-15',
    invoice_line_ids: [{ name: 'Server', product_id: 1, qty: 1, price_unit: 12000, tax: 0, account_id: modeledAcc.id }],
  });
  db = postMove(bill.db, bill.id);

  const beforeAsset = search(db, 'account.asset').find((a) => a.bill_id === bill.id);
  assert.equal(beforeAsset.method_mode, 'rate');
  assert.equal(beforeAsset.method_rate, 0.25);
  assert.equal(beforeAsset.prorata_computation_type, 'constant_periods');
  assert.equal(beforeAsset.prorata_date, '2026-03-15');

  db = run(db, 'account.move', bill.id, 'Reset to Draft').db;
  db = write(db, 'account.move', bill.id, {
    invoice_line_ids: [{ name: 'Server', product_id: 1, qty: 1, price_unit: 12000, tax: 0, account_id: unmodeledAcc.id }],
  });
  db = postMove(db, bill.id);

  const afterAsset = search(db, 'account.asset').find((a) => a.bill_id === bill.id);
  assert.equal(afterAsset.id, beforeAsset.id);
  assert.equal(afterAsset.model_id, null);
  assert.equal(afterAsset.method, 'linear');
  assert.equal(afterAsset.method_mode, 'duration');
  assert.equal(afterAsset.method_rate, 0.2);
  assert.equal(afterAsset.method_number, 5);
  assert.equal(afterAsset.prorata, false);
  assert.equal(afterAsset.prorata_computation_type, 'none');
  assert.equal(afterAsset.prorata_date, '2026-01-01');

  db = write(db, 'account.asset', afterAsset.id, {
    account_depreciation_id: accounts.account_depreciation_id,
    account_depreciation_expense_id: accounts.account_depreciation_expense_id,
  });
  db = confirmAsset(db, read(db, 'account.asset', afterAsset.id));
  const confirmed = read(db, 'account.asset', afterAsset.id);
  assert.deepEqual(
    confirmed.depreciation_ids.map((l) => [l.date, l.amount, l.remaining]),
    years([[2400, 9600], [2400, 7200], [2400, 4800], [2400, 2400], [2400, 0]]),
  );
});
