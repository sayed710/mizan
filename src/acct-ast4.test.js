import './models/index.js';
import { test } from 'node:test';
import { register } from 'node:module';
import assert from 'node:assert/strict';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { models } from './registry.js';
import { accountId, isBalanced } from './models/ledger.js';
import { confirmAsset, modifyAsset, pauseAsset, postDepreciation } from './models/assets.js';
import { applyDiff, diffDb } from './sync.js';
import { assetAccounts } from './test-support/asset-accounts.js';

const sync = (db, next) => applyDiff(db, diffDb(db, next), { isAdmin: false });

test('AST-4 list state badges and row decorations match Odoo 20 asset states', async () => {
  const { setupDom, find } = await import('./test-support/dom.js');
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { List } = await import('./views/List.jsx');
  const { makeEl } = setupDom();
  await initStore();

  const assetDef = models['account.asset'];
  assert.deepEqual(assetDef.fields.state.badge, {
    draft: 'info',
    open: 'success',
    paused: 'warning',
    close: 'muted',
    cancel: 'muted',
  });
  assert.equal(assetDef.listDecoration({ state: 'draft' }), 'info');
  assert.equal(assetDef.listDecoration({ state: 'open' }), null);
  assert.equal(assetDef.listDecoration({ state: 'paused' }), null);
  assert.equal(assetDef.listDecoration({ state: 'close' }), 'muted');
  assert.equal(assetDef.listDecoration({ state: 'cancel' }), 'muted');

  let db = seed();
  const accounts = assetAccounts(db);
  const mk = (name) => {
    const res = create(db, 'account.asset', { ...accounts, name, acquisition_date: '2026-01-01', original_value: 1000, method_number: 2, method_period: '12' });
    db = res.db;
    return res.id;
  };
  mk('Draft Asset');
  const openId = mk('Open Asset');
  const pausedId = mk('Paused Asset');
  const closedId = mk('Closed Asset');
  const cancelId = mk('Cancelled Asset');
  for (const id of [openId, pausedId, closedId, cancelId]) {
    db = confirmAsset(db, read(db, 'account.asset', id));
  }
  db = pauseAsset(db, read(db, 'account.asset', pausedId), '2026-01-15');
  db = postDepreciation(db, read(db, 'account.asset', closedId), '2028-12-31');
  db = write(db, 'account.asset', cancelId, { state: 'cancel' });

  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => {
      await commit(db);
      root.render(React.createElement(List, {
        db,
        model: 'account.asset',
        records: search(db, 'account.asset'),
        open: () => {},
        selected: new Set(),
        setSelected: () => {},
        groupBy: [],
        page: { start: 0, end: 20, total: 5, label: '1-5' },
      }));
    });
    const rowByName = (name) => find(host, (node) => node.tagName === 'TR' && !find(node, (c) => c.tagName === 'TH') && node.textContent.includes(name));
    assert.ok(rowByName('Draft Asset').className.includes('info'));
    assert.ok(rowByName('Closed Asset').className.includes('muted'));
    assert.ok(rowByName('Cancelled Asset').className.includes('muted'));
    assert.ok(!rowByName('Open Asset').className.includes('muted') && !rowByName('Open Asset').className.includes('info'));

    const badgeOf = (name) => find(rowByName(name), (node) => node.tagName === 'SPAN' && node.className?.includes('badge'));
    assert.ok(badgeOf('Draft Asset').className.includes('badge-info'));
    assert.ok(badgeOf('Open Asset').className.includes('badge-success'));
    assert.ok(badgeOf('Paused Asset').className.includes('badge-warning'));
    assert.ok(badgeOf('Closed Asset').className.includes('badge-muted'));
    assert.ok(badgeOf('Cancelled Asset').className.includes('badge-muted'));
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('AST-4 Re-evaluate wizard exposes Odoo accounts, defaults, company domains, and Value Adjustments tab', () => {
  let db = seed();
  const accounts = assetAccounts(db);
  const comp2 = create(db, 'res.company', { name: 'Other Co' });
  db = comp2.db;
  const foreignAcc = create(db, 'account.account', { code: '159999', name: 'Foreign Fixed', account_type: 'asset_fixed', company_id: comp2.id });
  const deprecatedAcc = create(foreignAcc.db, 'account.account', { code: '159998', name: 'Deprecated Fixed', account_type: 'asset_fixed', company_id: 1, deprecated: true });
  db = deprecatedAcc.db;

  const made = create(db, 'account.asset', {
    ...accounts,
    name: 'Wizard Asset',
    acquisition_date: '2026-01-01',
    original_value: 1000,
    salvage_value: 0,
    method: 'linear',
    method_number: 5,
    method_period: '12',
  });
  db = confirmAsset(made.db, read(made.db, 'account.asset', made.id));
  const asset = read(db, 'account.asset', made.id);
  const button = models['account.asset'].form.buttons.find((b) => b.label === 'Modify Depreciation');
  const spec = button.wizard(db, asset);

  const assetField = spec.fields.find((f) => f.name === 'account_asset_id');
  const depField = spec.fields.find((f) => f.name === 'account_depreciation_id');
  const expField = spec.fields.find((f) => f.name === 'account_depreciation_expense_id');
  const counterpartField = spec.fields.find((f) => f.name === 'account_asset_counterpart_id');
  assert.equal(assetField.default, accounts.account_asset_id);
  assert.equal(depField.default, accounts.account_depreciation_id);
  assert.equal(expField.default, accounts.account_depreciation_expense_id);

  const foreignRec = read(db, 'account.account', foreignAcc.id);
  const deprecatedRec = read(db, 'account.account', deprecatedAcc.id);
  const localFixed = read(db, 'account.account', accounts.account_asset_id);
  const localExp = read(db, 'account.account', accounts.account_depreciation_expense_id);
  for (const field of [assetField, depField, expField, counterpartField]) {
    assert.equal(field.domain(foreignRec), false);
    assert.equal(field.domain(deprecatedRec), false);
  }
  assert.equal(assetField.domain(localFixed), true);
  assert.equal(assetField.domain(localExp), false);
  assert.equal(expField.domain(localExp), true);

  assert.deepEqual(spec.onchange({ modify_action: 'modify', method_mode: 'rate', method_number: 4, method_rate: null }, 'method_mode'), { method_rate: 0.25 });

  const revalTab = models['account.asset'].form.tabs.find((tab) => tab.label === 'Value Adjustments');
  assert.ok(revalTab);
  assert.equal(revalTab.when(asset), false);

  const decreased = modifyAsset(db, asset, { date: '2026-02-01', valueChange: -200 });
  assert.equal(revalTab.when(read(decreased, 'account.asset', made.id)), true);
});

test('AST-4 Re-evaluate wizard adjusts salvage vs depreciable amount without posting a false value change', () => {
  let db = seed();
  const accounts = assetAccounts(db);
  const made = create(db, 'account.asset', {
    ...accounts,
    name: 'Salvage Shift Machine',
    acquisition_date: '2026-01-01',
    original_value: 1000,
    salvage_value: 0,
    method: 'linear',
    method_number: 5,
    method_period: '12',
  });
  db = confirmAsset(made.db, read(made.db, 'account.asset', made.id));
  const asset = read(db, 'account.asset', made.id);
  const movesBefore = search(db, 'account.move').length;

  const button = models['account.asset'].form.buttons.find((b) => b.label === 'Modify Depreciation');
  const next = button.run(db, asset, {
    modify_action: 'modify',
    date: '2026-02-01',
    value_residual: 800,
    salvage_value: 200,
    account_asset_id: accounts.account_asset_id,
    account_depreciation_id: accounts.account_depreciation_id,
    account_depreciation_expense_id: accounts.account_depreciation_expense_id,
  }).db;

  const synced = sync(db, next);
  const updated = read(synced, 'account.asset', made.id);
  assert.equal(updated.original_value, 1000);
  assert.equal(updated.salvage_value, 200);
  assert.equal(updated.book_value, 1000);
  assert.deepEqual(updated.revaluation_ids ?? [], []);
  assert.equal(search(synced, 'account.asset').filter((a) => a.parent_id === made.id).length, 0);
  assert.equal(search(synced, 'account.move').length, movesBefore);
  assert.deepEqual(updated.depreciation_ids.map((l) => l.amount), [160, 160, 160, 160, 160]);
  assert.equal(updated.depreciation_ids.at(-1).remaining, 200);
});

test('AST-4 Gross increase child uses wizard accumulated and expense accounts and survives sync', () => {
  let db = seed();
  const accounts = assetAccounts(db);
  const altAsset = create(db, 'account.account', { code: '151900', name: 'Alt Asset', account_type: 'asset_fixed', company_id: 1 });
  const altDep = create(altAsset.db, 'account.account', { code: '152900', name: 'Alt Dep', account_type: 'asset_fixed', company_id: 1 });
  const altExp = create(altDep.db, 'account.account', { code: '680900', name: 'Alt Exp', account_type: 'expense', company_id: 1 });
  db = altExp.db;

  const made = create(db, 'account.asset', {
    ...accounts,
    name: 'CNC Mill',
    acquisition_date: '2026-01-01',
    original_value: 1000,
    salvage_value: 0,
    method: 'linear',
    method_number: 4,
    method_period: '12',
  });
  db = confirmAsset(made.db, read(made.db, 'account.asset', made.id));
  const button = models['account.asset'].form.buttons.find((b) => b.label === 'Modify Depreciation');
  const counterpart = accountId(db, '450300');
  const next = button.run(db, read(db, 'account.asset', made.id), {
    modify_action: 'modify',
    date: '2026-02-01',
    value_residual: 1400,
    salvage_value: 0,
    account_asset_id: altAsset.id,
    account_depreciation_id: altDep.id,
    account_depreciation_expense_id: altExp.id,
    account_asset_counterpart_id: counterpart,
  }).db;

  const synced = sync(db, next);
  const child = search(synced, 'account.asset').find((a) => a.parent_id === made.id);
  assert.ok(child);
  assert.equal(child.original_value, 400);
  assert.equal(child.account_asset_id, altAsset.id);
  assert.equal(child.account_depreciation_id, altDep.id);
  assert.equal(child.account_depreciation_expense_id, altExp.id);

  const increaseMove = read(synced, 'account.move', child.gross_increase_move_id);
  assert.ok(isBalanced(increaseMove.line_ids));
  assert.equal(increaseMove.line_ids.find((l) => l.account_id === altAsset.id).debit, 400);
  assert.equal(increaseMove.line_ids.find((l) => l.account_id === counterpart).credit, 400);

  const postedChildDb = postDepreciation(synced, child, '2026-12-31');
  const depMove = read(postedChildDb, 'account.move', read(postedChildDb, 'account.asset', child.id).depreciation_ids[0].move_id);
  assert.equal(depMove.line_ids.find((l) => l.debit > 0).account_id, altExp.id);
  assert.equal(depMove.line_ids.find((l) => l.credit > 0).account_id, altDep.id);
});

test('AST-4 Value decrease closes imported asset when reduced to depreciated floor and guards non-increase account edits', () => {
  let db = seed();
  const accounts = assetAccounts(db);
  const lossExp = create(db, 'account.account', { code: '680901', name: 'Impairment Loss', account_type: 'expense', company_id: 1 });
  db = lossExp.db;

  const made = create(db, 'account.asset', {
    ...accounts,
    name: 'Imported Press',
    acquisition_date: '2026-01-01',
    original_value: 1000,
    already_depreciated: 400,
    salvage_value: 100,
    method: 'linear',
    method_number: 3,
    method_period: '12',
  });
  db = confirmAsset(made.db, read(made.db, 'account.asset', made.id));
  const asset = read(db, 'account.asset', made.id);

  assert.throws(() => modifyAsset(db, asset, { date: '2025-12-31', valueChange: -100 }), /precede acquisition date/i);
  assert.throws(() => modifyAsset(db, asset, { date: 'not-a-date', valueChange: -100 }), /valid modification date/i);
  assert.throws(() => modifyAsset(db, asset, { date: '2026-02-01', valueChange: 0, depreciationAccountId: accountId(db, '151000') }), /only on a gross increase/i);
  assert.throws(() => modifyAsset(db, asset, { date: '2026-02-01', valueChange: 0, expenseAccountId: lossExp.id }), /only on a gross increase/i);

  const button = models['account.asset'].form.buttons.find((b) => b.label === 'Modify Depreciation');
  const next = button.run(db, asset, {
    modify_action: 'modify',
    date: '2026-02-01',
    value_residual: 0,
    salvage_value: 100,
    account_depreciation_id: accounts.account_depreciation_id,
    account_depreciation_expense_id: lossExp.id,
  }).db;

  const synced = sync(db, next);
  const closed = read(synced, 'account.asset', made.id);
  assert.equal(closed.original_value, 500);
  assert.equal(closed.state, 'close');
  assert.equal(closed.depreciation_ids.length, 0);
  assert.equal(closed.revaluation_ids.length, 1);
  assert.equal(closed.revaluation_ids[0].amount, -500);
  const decreaseMove = read(synced, 'account.move', closed.revaluation_ids[0].move_id);
  assert.ok(isBalanced(decreaseMove.line_ids));
  assert.equal(decreaseMove.line_ids.find((l) => l.account_id === lossExp.id).debit, 500);
  assert.equal(decreaseMove.line_ids.find((l) => l.account_id === accounts.account_asset_id).credit, 500);
});

test('AST-4 Qodo Finding 1: modifyAsset rejects newly selected deprecated accounts while preserving unchanged historical accounts', () => {
  let db = seed();
  const accounts = assetAccounts(db);
  const depFixed = create(db, 'account.account', { code: '159901', name: 'Deprecated Fixed', account_type: 'asset_fixed', company_id: 1, deprecated: true });
  const depAccum = create(depFixed.db, 'account.account', { code: '159902', name: 'Deprecated Accum', account_type: 'asset_fixed', company_id: 1, deprecated: true });
  const depExp = create(depAccum.db, 'account.account', { code: '689901', name: 'Deprecated Expense', account_type: 'expense', company_id: 1, deprecated: true });
  const depCounterpart = create(depExp.db, 'account.account', { code: '459901', name: 'Deprecated Counterpart', account_type: 'equity', company_id: 1, deprecated: true });
  db = depCounterpart.db;

  const made = create(db, 'account.asset', {
    ...accounts,
    name: 'Deprecated Guard Press',
    acquisition_date: '2026-01-01',
    original_value: 1000,
    salvage_value: 0,
    method: 'linear',
    method_number: 4,
    method_period: '12',
  });
  db = confirmAsset(made.db, read(made.db, 'account.asset', made.id));
  const asset = read(db, 'account.asset', made.id);
  const counterpart = accountId(db, '450300');

  assert.throws(
    () => modifyAsset(db, asset, { date: '2026-02-01', valueChange: 200, accountId: counterpart, depreciationAccountId: depAccum.id }),
    /Configure the depreciation account/i,
  );
  assert.throws(
    () => modifyAsset(db, asset, { date: '2026-02-01', valueChange: 200, accountId: counterpart, expenseAccountId: depExp.id }),
    /Configure the depreciation expense account/i,
  );
  assert.throws(
    () => modifyAsset(db, asset, { date: '2026-02-01', valueChange: 200, accountId: counterpart, increaseAccountId: depFixed.id }),
    /Configure the fixed asset account/i,
  );
  assert.throws(
    () => modifyAsset(db, asset, { date: '2026-02-01', valueChange: 200, accountId: depCounterpart.id }),
    /Configure the counterpart account/i,
  );
  assert.throws(
    () => modifyAsset(db, asset, { date: '2026-02-01', valueChange: -100, expenseAccountId: depExp.id }),
    /Configure the counterpart account/i,
  );

  // Unchanged historical accounts on the asset remain usable if later marked deprecated.
  let historicalDb = write(db, 'account.account', accounts.account_asset_id, { deprecated: true });
  historicalDb = write(historicalDb, 'account.account', accounts.account_depreciation_id, { deprecated: true });
  historicalDb = write(historicalDb, 'account.account', accounts.account_depreciation_expense_id, { deprecated: true });
  const historicalAsset = read(historicalDb, 'account.asset', made.id);

  const increasedDb = modifyAsset(historicalDb, historicalAsset, {
    date: '2026-02-01',
    valueChange: 200,
    accountId: counterpart,
    increaseAccountId: accounts.account_asset_id,
    depreciationAccountId: accounts.account_depreciation_id,
    expenseAccountId: accounts.account_depreciation_expense_id,
  });
  const child = search(increasedDb, 'account.asset').find((a) => a.parent_id === made.id);
  assert.ok(child);
  assert.equal(child.account_depreciation_id, accounts.account_depreciation_id);
  assert.equal(child.account_depreciation_expense_id, accounts.account_depreciation_expense_id);

  const decreasedDb = modifyAsset(historicalDb, historicalAsset, {
    date: '2026-02-01',
    valueChange: -100,
    expenseAccountId: accounts.account_depreciation_expense_id,
  });
  assert.equal(read(decreasedDb, 'account.asset', made.id).original_value, 900);
});

test('AST-4 Qodo Finding 2: switching to rate mode after posted periods derives rate from remaining unposted periods', () => {
  let db = seed();
  const accounts = assetAccounts(db);
  const made = create(db, 'account.asset', {
    ...accounts,
    name: 'Five Year Press',
    acquisition_date: '2026-01-01',
    original_value: 1000,
    salvage_value: 0,
    method: 'linear',
    method_mode: 'duration',
    method_number: 5,
    method_period: '12',
    prorata_computation_type: 'none',
    prorata_date: '2026-01-01',
  });
  db = confirmAsset(made.db, read(made.db, 'account.asset', made.id));
  db = postDepreciation(db, read(db, 'account.asset', made.id), '2026-12-31');

  const asset = read(db, 'account.asset', made.id);
  assert.equal(asset.depreciation_ids.filter((l) => l.posted).length, 1);
  assert.equal(asset.depreciation_ids.filter((l) => !l.posted).length, 4);

  const button = models['account.asset'].form.buttons.find((b) => b.label === 'Modify Depreciation');
  const spec = button.wizard(db, asset);

  assert.deepEqual(
    spec.onchange({ modify_action: 'modify', date: '2027-01-15', method_mode: 'rate', method_number: null, method_rate: null }, 'method_mode'),
    { method_rate: 0.25 },
  );
  assert.deepEqual(
    spec.onchange({ modify_action: 'modify', date: '2027-12-31', method_mode: 'rate', method_number: null, method_rate: null }, 'method_mode'),
    { method_rate: 1 / 3 },
  );

  const next = button.run(db, asset, {
    modify_action: 'modify',
    date: '2027-01-15',
    method_mode: 'rate',
    method_rate: 0.25,
  }).db;
  const synced = sync(db, next);
  const updated = read(synced, 'account.asset', made.id);
  assert.equal(updated.method_mode, 'rate');
  assert.equal(updated.method_rate, 0.25);
  assert.equal(updated.method_number, 5);
  assert.equal(updated.depreciation_ids.filter((l) => l.posted).length, 1);
  assert.equal(updated.depreciation_ids.filter((l) => !l.posted).length, 4);
  assert.deepEqual(updated.depreciation_ids.map((l) => l.amount), [200, 200, 200, 200, 200]);
  assert.equal(updated.depreciation_ids.at(-1).remaining, 0);

  // Direct run omitting method_rate also stays consistent with remaining unposted periods.
  const directRate = button.run(db, asset, {
    modify_action: 'modify',
    date: '2027-01-15',
    method_mode: 'rate',
  }).db;
  const directUpdated = read(sync(db, directRate), 'account.asset', made.id);
  assert.equal(directUpdated.method_rate, 0.25);
  assert.equal(directUpdated.depreciation_ids.filter((l) => !l.posted).length, 4);

  // Switching from rate back to duration without entering remaining duration keeps rate consistent.
  const rateMade = create(db, 'account.asset', {
    ...accounts,
    name: 'Five Year Rate Press',
    acquisition_date: '2026-01-01',
    original_value: 1000,
    salvage_value: 0,
    method: 'linear',
    method_mode: 'rate',
    method_rate: 0.2,
    method_number: 5,
    method_period: '12',
    prorata_computation_type: 'none',
    prorata_date: '2026-01-01',
  });
  let rateStart = confirmAsset(rateMade.db, read(rateMade.db, 'account.asset', rateMade.id));
  rateStart = postDepreciation(rateStart, read(rateStart, 'account.asset', rateMade.id), '2026-12-31');
  const backToDuration = button.run(rateStart, read(rateStart, 'account.asset', rateMade.id), {
    modify_action: 'modify',
    date: '2027-01-15',
    method_mode: 'duration',
  }).db;
  const backUpdated = read(sync(rateStart, backToDuration), 'account.asset', rateMade.id);
  assert.equal(backUpdated.method_mode, 'duration');
  assert.equal(backUpdated.method_rate, 0.25);
  assert.equal(backUpdated.depreciation_ids.filter((l) => !l.posted).length, 4);
});
