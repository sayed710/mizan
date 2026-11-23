import './models/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { models } from './registry.js';
import { accountId } from './models/ledger.js';
import { seed } from './seed.js';
import { migrate } from './migrations.js';
import { applyDiff, diffDb } from './sync.js';
import { postMove } from './models/accounting.js';
import { confirmAsset } from './models/assets.js';
import { assetAccounts } from './test-support/asset-accounts.js';

const button = (model, label, db, id) => {
  const btn = models[model].form.buttons.find((b) => b.label === label);
  if (!btn) throw new Error(`Button ${label} not found on ${model}`);
  return btn.run(db, read(db, model, id)).db;
};

test('deferral computation methods: day, month, and full_months from bill posting', () => {
  for (const method of ['day', 'month', 'full_months']) {
    let db = seed();
    const company = read(db, 'res.company', 1);
    db = write(db, 'res.company', company.id, {
      deferred_expense_amount_computation_method: method,
      generate_deferred_expense_entries_method: 'manual',
    });

    const expenseAcc = accountId(db, '600000');
    // Period: 2026-01-15 to 2026-03-15 (3 periods: Jan 15-31, Feb 1-28, Mar 1-15)
    const bill = create(db, 'account.move', {
      move_type: 'in_invoice',
      partner_id: 2,
      invoice_date: '2026-01-15',
      invoice_line_ids: [{
        name: 'Quarterly Maintenance',
        qty: 1,
        price_unit: 900,
        tax: 0,
        account_id: expenseAcc,
        deferred_start_date: '2026-01-15',
        deferred_end_date: '2026-03-15',
      }],
    });
    db = postMove(bill.db, bill.id);

    const schedule = search(db, 'account.deferral').find((d) => d.source_move_id === bill.id);
    assert.ok(schedule, `Schedule should be created for method ${method}`);
    assert.equal(schedule.kind, 'expense');
    assert.equal(schedule.recognition_account_id, expenseAcc);
    assert.equal(schedule.start_date, '2026-01-15');
    assert.equal(schedule.end_date, '2026-03-15');
    assert.equal(schedule.board.length, 3);

    // Sum of amounts across board must always equal original amount (900)
    const totalAmount = schedule.board.reduce((sum, l) => sum + l.amount, 0);
    assert.equal(Math.round(totalAmount), 900);

    if (method === 'full_months') {
      // In full_months, all periods have weight 1, so exactly 300 each
      assert.deepEqual(schedule.board.map((l) => l.amount), [300, 300, 300]);
    } else if (method === 'day') {
      // Days: Jan 15-31 = 17 days, Feb 1-28 = 28 days, Mar 1-15 = 15 days. Total = 60 days.
      // Jan = 900 * 17/60 = 255; Feb = 900 * 28/60 = 420; Mar = 900 * 15/60 = 225
      assert.deepEqual(schedule.board.map((l) => l.amount), [255, 420, 225]);
    } else if (method === 'month') {
      // Month: Jan = 17/31, Feb = 28/28 = 1, Mar = 15/31
      // Weights: ~0.5484, 1.0, ~0.4839. Feb is larger than Jan and Mar.
      assert.ok(schedule.board[1].amount > schedule.board[0].amount);
      assert.ok(schedule.board[0].amount > schedule.board[2].amount);
    }
  }
});

test('automatic deferral generation on post (on_validation mode)', () => {
  let db = seed();
  const company = read(db, 'res.company', 1);
  const expenseAcc = accountId(db, '600000');
  const customJournal = search(db, 'account.journal').find((j) => j.type === 'general' && j.id !== company.default_general_journal_id);

  db = write(db, 'res.company', company.id, {
    generate_deferred_expense_entries_method: 'on_validation',
    deferred_expense_amount_computation_method: 'full_months',
    ...(customJournal ? { deferred_expense_journal_id: customJournal.id } : {}),
  });

  // Today is in the current execution date. We pick a range starting earlier in the year to end of year
  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 2,
    invoice_date: '2026-01-01',
    invoice_line_ids: [{
      name: 'Annual Subscription',
      qty: 1,
      price_unit: 1200,
      tax: 0,
      account_id: expenseAcc,
      deferred_start_date: '2026-01-01',
      deferred_end_date: '2026-12-31',
    }],
  });
  db = postMove(bill.db, bill.id);

  const schedule = search(db, 'account.deferral').find((d) => d.source_move_id === bill.id);
  assert.ok(schedule);
  assert.equal(schedule.board.length, 12);

  // Every line in the board must have a move_id generated
  for (const line of schedule.board) {
    assert.ok(line.move_id, `Board line dated ${line.date} should have a generated move_id`);
    const move = read(db, 'account.move', line.move_id);
    assert.ok(move);
    if (customJournal) {
      assert.equal(move.journal_id, customJournal.id);
    }
    // Lines in the past/present are posted; lines in the future are draft with auto_post: 'at_date'
    if (line.posted) {
      assert.equal(move.state, 'posted');
    } else {
      assert.equal(move.state, 'draft');
      assert.equal(move.auto_post, 'at_date');
    }
  }
});

test('manual deferral generation mode creates running schedule without posting entries', () => {
  let db = seed();
  const company = read(db, 'res.company', 1);
  const expenseAcc = accountId(db, '600000');

  db = write(db, 'res.company', company.id, {
    generate_deferred_expense_entries_method: 'manual',
  });

  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 2,
    invoice_date: '2026-01-01',
    invoice_line_ids: [{
      name: 'Server Hosting',
      qty: 1,
      price_unit: 600,
      tax: 0,
      account_id: expenseAcc,
      deferred_start_date: '2026-01-01',
      deferred_end_date: '2026-06-30',
    }],
  });
  db = postMove(bill.db, bill.id);

  const schedule = search(db, 'account.deferral').find((d) => d.source_move_id === bill.id);
  assert.ok(schedule);
  assert.equal(schedule.state, 'running');
  assert.equal(schedule.board.length, 6);
  // Manual mode does not generate or post entries on validation
  assert.ok(schedule.board.every((l) => !l.move_id && !l.posted));
});

test('resetting or cancelling a bill reverses/cancels deferral entries and updates schedule', () => {
  let db = seed();
  const company = read(db, 'res.company', 1);
  const expenseAcc = accountId(db, '600000');

  db = write(db, 'res.company', company.id, {
    generate_deferred_expense_entries_method: 'on_validation',
  });

  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 2,
    invoice_date: '2026-01-01',
    invoice_line_ids: [{
      name: 'Cloud Services',
      qty: 1,
      price_unit: 600,
      tax: 0,
      account_id: expenseAcc,
      deferred_start_date: '2026-01-01',
      deferred_end_date: '2026-06-30',
    }],
  });
  db = postMove(bill.db, bill.id);

  const schedule = search(db, 'account.deferral').find((d) => d.source_move_id === bill.id);
  assert.ok(schedule);
  const originalMoveIds = schedule.board.map((l) => l.move_id).filter(Boolean);

  // Reset bill to draft
  db = button('account.move', 'Reset to Draft', db, bill.id);
  assert.equal(read(db, 'account.move', bill.id).state, 'draft');

  // Deferral schedule must be cancelled
  const cancelledSchedule = read(db, 'account.deferral', schedule.id);
  assert.equal(cancelledSchedule.state, 'cancel');

  // Check the moves: posted moves must have reversals; draft moves must be cancelled
  for (const moveId of originalMoveIds) {
    const move = read(db, 'account.move', moveId);
    if (move.state === 'draft') {
      // Draft deferral moves should be cancelled
      assert.equal(move.state, 'cancel');
    } else if (move.state === 'posted') {
      // Posted deferral moves should have a posted reversal move
      const reversal = search(db, 'account.move').find((m) => m.reversed_entry_id === move.id);
      assert.ok(reversal, `Reversal move should exist for posted move ${move.name}`);
      assert.equal(reversal.state, 'posted');
    }
  }
});

test('asset auto-creation: decided strictly by account create_asset and linked model, not account type', () => {
  let db = seed();
  const accounts = assetAccounts(db);

  // 1. Account with account_type === 'expense' but create_asset === 'draft' -> creates draft asset
  const expWithDraft = create(db, 'account.account', {
    name: 'Expense with Draft Asset',
    code: '654321',
    account_type: 'expense',
    create_asset: 'draft',
  });
  db = expWithDraft.db;

  const bill1 = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 2,
    invoice_date: '2026-01-01',
    invoice_line_ids: [{ name: 'Non-fixed draft asset', qty: 1, price_unit: 1000, tax: 0, account_id: expWithDraft.id }],
  });
  db = postMove(bill1.db, bill1.id);
  const asset1 = search(db, 'account.asset').find((a) => a.bill_id === bill1.id);
  assert.ok(asset1, 'Asset should be created even on expense account because create_asset is draft');
  assert.equal(asset1.state, 'draft');

  // 2. Account with account_type === 'asset_fixed' but create_asset === 'no' -> does NOT create asset
  const fixedWithNo = create(db, 'account.account', {
    name: 'Fixed with No Asset',
    code: '159999',
    account_type: 'asset_fixed',
    create_asset: 'no',
  });
  db = fixedWithNo.db;

  const bill2 = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 2,
    invoice_date: '2026-01-01',
    invoice_line_ids: [{ name: 'Fixed asset line no creation', qty: 1, price_unit: 2000, tax: 0, account_id: fixedWithNo.id }],
  });
  db = postMove(bill2.db, bill2.id);
  const asset2 = search(db, 'account.asset').find((a) => a.bill_id === bill2.id);
  assert.equal(asset2, undefined, 'Asset should NOT be created when create_asset is no, even if account_type is asset_fixed');

  // 3. Account with create_asset === 'validate' overrides model setting and creates validated (open) asset
  const draftModel = create(db, 'account.asset.model', {
    name: 'Draft Base Model',
    method: 'linear',
    method_number: 4,
    method_period: '12',
    account_depreciation_id: accounts.account_depreciation_id,
    account_depreciation_expense_id: accounts.account_depreciation_expense_id,
  });
  db = draftModel.db;

  const accWithValidate = create(db, 'account.account', {
    name: 'Immediate Validate Account',
    code: '158888',
    account_type: 'asset_fixed',
    asset_model_id: draftModel.id,
    create_asset: 'validate',
  });
  db = accWithValidate.db;

  const bill3 = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 2,
    invoice_date: '2026-01-01',
    invoice_line_ids: [{ name: 'Direct validated asset', qty: 1, price_unit: 3000, tax: 0, account_id: accWithValidate.id }],
  });
  db = postMove(bill3.db, bill3.id);
  const asset3 = search(db, 'account.asset').find((a) => a.bill_id === bill3.id);
  assert.ok(asset3, 'Asset should be created');
  assert.equal(asset3.state, 'open', 'Asset should be immediately validated (open) due to account override');
  assert.ok(asset3.depreciation_ids?.length > 0, 'Depreciation board should be computed');
});

test('asset auto-creation: the account setting decides and the linked model supplies the asset values', () => {
  let db = seed();
  const accounts = assetAccounts(db);
  const model = create(db, 'account.asset.model', {
    name: 'Three-year model',
    method: 'linear',
    method_number: 3,
    method_period: '12',
    account_depreciation_id: accounts.account_depreciation_id,
    account_depreciation_expense_id: accounts.account_depreciation_expense_id,
  });
  db = model.db;
  const post = (accountId) => {
    const bill = create(db, 'account.move', {
      move_type: 'in_invoice', partner_id: 2, invoice_date: '2026-01-01',
      invoice_line_ids: [{ name: 'Machine', qty: 1, price_unit: 6000, tax: 0, account_id: accountId }],
    });
    db = postMove(bill.db, bill.id);
    return search(db, 'account.asset').find((a) => a.bill_id === bill.id);
  };
  const validated = create(db, 'account.account', { name: 'Validated from model', code: '157777', account_type: 'asset_fixed', asset_model_id: model.id, create_asset: 'validate' });
  db = validated.db;
  const asset = post(validated.id);
  assert.equal(asset.state, 'open');
  assert.equal(asset.model_id, model.id);
  assert.equal(asset.method_number, 3);
  assert.equal(asset.depreciation_ids.length, 3);

  const off = create(db, 'account.account', { name: 'Model but no creation', code: '156666', account_type: 'asset_fixed', asset_model_id: model.id, create_asset: 'no' });
  db = off.db;
  assert.equal(post(off.id), undefined);
});

test('validated asset creation requires a model with depreciation accounts, also through sync', () => {
  const db = seed();
  const message = /Validated asset creation needs a depreciation model with depreciation accounts/;
  assert.throws(() => create(db, 'account.account', { name: 'No model', code: '158881', account_type: 'asset_fixed', create_asset: 'validate' }), message);
  const bare = create(db, 'account.asset.model', { name: 'No accounts', method: 'linear', method_number: 3, method_period: '12' });
  assert.throws(() => create(bare.db, 'account.account', { name: 'Bare model', code: '158882', account_type: 'asset_fixed', asset_model_id: bare.id, create_asset: 'validate' }), message);
  const fixed = bare.db.records['account.account'].find((a) => a.account_type === 'asset_fixed');
  const forged = { ...bare.db, records: { ...bare.db.records, 'account.account': bare.db.records['account.account'].map((a) => (a.id === fixed.id ? { ...a, create_asset: 'validate', asset_model_id: null } : a)) } };
  assert.throws(() => applyDiff(bare.db, diffDb(bare.db, forged), { isAdmin: true }), message);

  // The linked model cannot later drop a depreciation account, also through sync.
  const accounts = assetAccounts(bare.db);
  const full = create(bare.db, 'account.asset.model', { name: 'Full', method: 'linear', method_number: 3, method_period: '12', ...accounts });
  const linked = create(full.db, 'account.account', { name: 'Linked', code: '158883', account_type: 'asset_fixed', asset_model_id: full.id, create_asset: 'validate' });
  assert.throws(() => write(linked.db, 'account.asset.model', full.id, { account_depreciation_id: null }), message);
  const stripped = { ...linked.db, records: { ...linked.db.records, 'account.asset.model': linked.db.records['account.asset.model'].map((m) => (m.id === full.id ? { ...m, account_depreciation_expense_id: null } : m)) } };
  assert.throws(() => applyDiff(linked.db, diffDb(linked.db, stripped), { isAdmin: true }), message);
});

test('posting a bill again keeps its single validated asset', () => {
  let db = seed();
  const accounts = assetAccounts(db);
  const model = create(db, 'account.asset.model', {
    name: 'Two-year model', method: 'linear', method_number: 2, method_period: '12',
    account_depreciation_id: accounts.account_depreciation_id, account_depreciation_expense_id: accounts.account_depreciation_expense_id,
  });
  const account = create(model.db, 'account.account', { name: 'Auto validated', code: '157778', account_type: 'asset_fixed', asset_model_id: model.id, create_asset: 'validate' });
  const bill = create(account.db, 'account.move', {
    move_type: 'in_invoice', partner_id: 2, invoice_date: '2026-01-01',
    invoice_line_ids: [{ name: 'Press', qty: 1, price_unit: 4000, tax: 0, account_id: account.id }],
  });
  db = postMove(bill.db, bill.id);
  db = postMove(db, bill.id);
  const assets = search(db, 'account.asset').filter((a) => a.bill_id === bill.id);
  assert.equal(assets.length, 1);
  assert.equal(assets[0].state, 'open');
});

test('migration 56 keeps draft asset creation on accounts that created assets before', () => {
  const db = seed();
  const strip = (a) => { const { create_asset: _drop, ...rest } = a; return rest; };
  const fixed = db.records['account.account'].find((a) => a.account_type === 'asset_fixed');
  const expense = db.records['account.account'].find((a) => a.account_type === 'expense');
  const legacy = { ...db, schema_version: 55, records: { ...db.records, 'account.account': db.records['account.account'].map(strip) } };
  const migrated = migrate(legacy);
  assert.equal(migrated.schema_version, 73);
  assert.equal(migrated.records['account.account'].find((a) => a.id === fixed.id).create_asset, 'draft');
  assert.equal(migrated.records['account.account'].find((a) => a.id === expense.id).create_asset, 'no');
});

test('reset and cancel lifecycle with draft vs running assets', () => {
  let db = seed();
  const accounts = assetAccounts(db);

  // Bill that creates a draft asset
  const billDraft = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 2,
    invoice_date: '2026-01-01',
    invoice_line_ids: [{ name: 'Draft Asset Tool', qty: 1, price_unit: 500, tax: 0, account_id: accountId(db, '151000') }],
  });
  db = postMove(billDraft.db, billDraft.id);
  const draftAsset = search(db, 'account.asset').find((a) => a.bill_id === billDraft.id);
  assert.ok(draftAsset);
  assert.equal(draftAsset.state, 'draft');

  // Reset bill to draft preserves the draft asset
  let resetDb = button('account.move', 'Reset to Draft', db, billDraft.id);
  assert.ok(search(resetDb, 'account.asset').find((a) => a.bill_id === billDraft.id));

  // Cancelling bill unlinks draft assets
  let cancelDb = write(resetDb, 'account.move', billDraft.id, { state: 'cancel' });
  assert.equal(search(cancelDb, 'account.asset').find((a) => a.bill_id === billDraft.id), undefined);

  // Bill that has a running asset
  const billRunning = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 2,
    invoice_date: '2026-01-01',
    invoice_line_ids: [{ name: 'Running Machine', qty: 1, price_unit: 8000, tax: 0, account_id: accountId(db, '151000') }],
  });
  db = postMove(billRunning.db, billRunning.id);
  const runningAsset = search(db, 'account.asset').find((a) => a.bill_id === billRunning.id);
  assert.ok(runningAsset);
  db = write(db, 'account.asset', runningAsset.id, {
    account_depreciation_id: accounts.account_depreciation_id,
    account_depreciation_expense_id: accounts.account_depreciation_expense_id,
  });
  db = confirmAsset(db, read(db, 'account.asset', runningAsset.id));
  assert.equal(read(db, 'account.asset', runningAsset.id).state, 'open');

  // Resetting to draft or cancelling a bill with running asset is blocked by paymentGuard
  assert.throws(
    () => button('account.move', 'Reset to Draft', db, billRunning.id),
    /Handle the bill's running or depreciated assets before resetting it/
  );
  assert.throws(
    () => write(db, 'account.move', billRunning.id, { state: 'draft' }),
    /Handle the bill's running or depreciated assets before resetting it/
  );
  assert.throws(
    () => write(db, 'account.move', billRunning.id, { state: 'cancel' }),
    /Posted entries go back to draft before anything else/
  );
});
