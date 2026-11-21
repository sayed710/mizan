import './models/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from './orm.js';
import { seed } from './seed.js';
import { postMove } from './models/accounting.js';
import { adjustAssetsForCreditNote, postDepreciation } from './models/assets.js';
import { assetAccounts } from './test-support/asset-accounts.js';

test('BILL-3: Posting a vendor refund reverses draft assets linked to the refunded bill', () => {
  let db = seed();

  const draftAccount = create(db, 'account.account', {
    name: 'Fixed Asset Draft',
    code: '151111',
    account_type: 'asset_fixed',
    create_asset: 'draft',
  });
  db = draftAccount.db;

  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 2,
    invoice_date: '2026-01-01',
    invoice_line_ids: [{
      line_id: 'bill_line_1',
      name: 'Office Equipment',
      qty: 1,
      price_unit: 1000,
      tax: 0,
      account_id: draftAccount.id,
    }],
  });
  db = postMove(bill.db, bill.id);

  const assetBefore = search(db, 'account.asset').find((a) => a.bill_id === bill.id);
  assert.ok(assetBefore, 'Asset should be created from bill');
  assert.equal(assetBefore.state, 'draft');
  const unmatched = adjustAssetsForCreditNote(db, {
    id: 999, move_type: 'in_refund', reversed_entry_id: bill.id, invoice_date: '2026-01-10',
    invoice_line_ids: [{ qty: 1, price_unit: 1000, tax: 0 }],
  });
  assert.deepEqual(read(unmatched, 'account.asset', assetBefore.id), assetBefore);

  // Create and post full vendor refund
  const refund = create(db, 'account.move', {
    move_type: 'in_refund',
    partner_id: 2,
    invoice_date: '2026-01-10',
    reversed_entry_id: bill.id,
    invoice_line_ids: [{
      name: 'Refund Office Equipment',
      qty: 1,
      price_unit: 1000,
      tax: 0,
      account_id: draftAccount.id,
      source_line_id: 'bill_line_1',
    }],
  });
  db = postMove(refund.db, refund.id);

  const assetAfter = read(db, 'account.asset', assetBefore.id);
  assert.equal(assetAfter.state, 'cancel', 'Draft asset must be cancelled when vendor refund is posted');
});

test('BILL-3: Posting a vendor refund cancels open assets with no posted depreciations', () => {
  let db = seed();
  const accounts = assetAccounts(db);

  const model = create(db, 'account.asset.model', {
    name: 'Linear 5yr',
    method: 'linear',
    method_number: 5,
    method_period: '12',
    account_depreciation_id: accounts.account_depreciation_id,
    account_depreciation_expense_id: accounts.account_depreciation_expense_id,
  });
  db = model.db;

  const validAccount = create(db, 'account.account', {
    name: 'Auto Validated Asset',
    code: '152222',
    account_type: 'asset_fixed',
    asset_model_id: model.id,
    create_asset: 'validate',
  });
  db = validAccount.db;

  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 2,
    invoice_date: '2026-01-01',
    invoice_line_ids: [{
      line_id: 'line_srv_1',
      name: 'Server Hardware',
      qty: 1,
      price_unit: 5000,
      tax: 0,
      account_id: validAccount.id,
    }],
  });
  db = postMove(bill.db, bill.id);

  const assetBefore = search(db, 'account.asset').find((a) => a.bill_id === bill.id);
  assert.ok(assetBefore);
  assert.equal(assetBefore.state, 'open', 'Asset is auto-validated into open state');
  assert.equal(assetBefore.depreciation_ids.length, 5);
  assert.ok(assetBefore.depreciation_ids.every((l) => !l.posted));

  // Post vendor refund reversing the bill
  const refund = create(db, 'account.move', {
    move_type: 'in_refund',
    partner_id: 2,
    invoice_date: '2026-01-15',
    reversed_entry_id: bill.id,
    invoice_line_ids: [{
      name: 'Refund Server Hardware',
      qty: 1,
      price_unit: 5000,
      tax: 0,
      account_id: validAccount.id,
      source_line_id: 'line_srv_1',
    }],
  });
  db = postMove(refund.db, refund.id);

  const assetAfter = read(db, 'account.asset', assetBefore.id);
  assert.equal(assetAfter.state, 'cancel', 'Running asset with no posted depreciations must be cancelled');
  assert.equal(assetAfter.depreciation_ids.length, 0, 'No active unposted depreciation lines should remain');

  // Verify postDepreciation does nothing
  const dbAfterDep = postDepreciation(db, assetAfter, '2099-12-31');
  assert.equal(dbAfterDep, db, 'postDepreciation on cancelled asset must make no changes');
});

test('BILL-3: Posting a vendor refund disposes or cancels asset with posted depreciations', () => {
  let db = seed();
  const accounts = assetAccounts(db);

  const model = create(db, 'account.asset.model', {
    name: 'Linear 5yr Machinery',
    method: 'linear',
    method_number: 5,
    method_period: '12',
    account_depreciation_id: accounts.account_depreciation_id,
    account_depreciation_expense_id: accounts.account_depreciation_expense_id,
  });
  db = model.db;

  const validAccount = create(db, 'account.account', {
    name: 'Machinery Account',
    code: '153333',
    account_type: 'asset_fixed',
    asset_model_id: model.id,
    create_asset: 'validate',
  });
  db = validAccount.db;

  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 2,
    invoice_date: '2026-01-01',
    invoice_line_ids: [{
      line_id: 'mach_line_1',
      name: 'Industrial Machine',
      qty: 1,
      price_unit: 10000,
      tax: 0,
      account_id: validAccount.id,
    }],
  });
  db = postMove(bill.db, bill.id);

  let asset = search(db, 'account.asset').find((a) => a.bill_id === bill.id);
  assert.ok(asset);
  assert.equal(asset.state, 'open');

  // Post 1 depreciation line (year 1: 2026-12-31)
  db = postDepreciation(db, asset, '2026-12-31');
  asset = read(db, 'account.asset', asset.id);
  const postedLines = asset.depreciation_ids.filter((l) => l.posted);
  assert.equal(postedLines.length, 1);

  // Now post full refund in 2027
  const refund = create(db, 'account.move', {
    move_type: 'in_refund',
    partner_id: 2,
    invoice_date: '2027-02-01',
    reversed_entry_id: bill.id,
    invoice_line_ids: [{
      name: 'Refund Industrial Machine',
      qty: 1,
      price_unit: 10000,
      tax: 0,
      account_id: validAccount.id,
      source_line_id: 'mach_line_1',
    }],
  });
  db = postMove(refund.db, refund.id);

  const assetAfter = read(db, 'account.asset', asset.id);
  // It should be closed/disposed or cancelled, but critically must STOP further depreciations
  assert.ok(['close', 'cancel'].includes(assetAfter.state), `Asset state should be close or cancel, got ${assetAfter.state}`);

  // Future depreciation must not run
  const dbFuture = postDepreciation(db, assetAfter, '2030-12-31');
  const assetFuture = read(dbFuture, 'account.asset', assetAfter.id);
  const futurePosted = assetFuture.depreciation_ids.filter((l) => l.posted);
  assert.equal(futurePosted.length, 1, 'No additional depreciation lines should have been posted');
});

test('BILL-3: Partial vendor refund adjusts running asset original value and board', () => {
  let db = seed();
  const accounts = assetAccounts(db);

  const model = create(db, 'account.asset.model', {
    name: 'Linear 4yr',
    method: 'linear',
    method_number: 4,
    method_period: '12',
    account_depreciation_id: accounts.account_depreciation_id,
    account_depreciation_expense_id: accounts.account_depreciation_expense_id,
  });
  db = model.db;

  const validAccount = create(db, 'account.account', {
    name: 'Hardware Account',
    code: '154444',
    account_type: 'asset_fixed',
    asset_model_id: model.id,
    create_asset: 'validate',
  });
  db = validAccount.db;

  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 2,
    invoice_date: '2026-01-01',
    invoice_line_ids: [{
      line_id: 'hw_line_1',
      name: 'Network Equipment',
      qty: 1,
      price_unit: 4000,
      tax: 0,
      account_id: validAccount.id,
    }],
  });
  db = postMove(bill.db, bill.id);

  const asset = search(db, 'account.asset').find((a) => a.bill_id === bill.id);
  assert.equal(asset.original_value, 4000);
  assert.equal(asset.state, 'open');

  // Partial refund: $1000 credit note
  const refund = create(db, 'account.move', {
    move_type: 'in_refund',
    partner_id: 2,
    invoice_date: '2026-06-01',
    reversed_entry_id: bill.id,
    invoice_line_ids: [{
      name: 'Partial Credit Network Equipment',
      qty: 1,
      price_unit: 1000,
      tax: 0,
      account_id: validAccount.id,
      source_line_id: 'hw_line_1',
    }],
  });
  db = postMove(refund.db, refund.id);

  const assetAfter = read(db, 'account.asset', asset.id);
  assert.equal(assetAfter.original_value, 3000, 'Original value should be reduced from 4000 to 3000');
  assert.equal(assetAfter.state, 'open', 'Asset remains open with remaining value');

  const boardSum = assetAfter.depreciation_ids.reduce((s, l) => s + l.amount, 0);
  assert.equal(Math.round(boardSum), 3000, 'Remaining depreciation board should sum to new original value');
});

test('BILL-3: Selective refund on multi-line bill only affects matching refunded asset', () => {
  let db = seed();
  const accounts = assetAccounts(db);

  const model = create(db, 'account.asset.model', {
    name: 'Linear 5yr Multi',
    method: 'linear',
    method_number: 5,
    method_period: '12',
    account_depreciation_id: accounts.account_depreciation_id,
    account_depreciation_expense_id: accounts.account_depreciation_expense_id,
  });
  db = model.db;

  const validAccount = create(db, 'account.account', {
    name: 'Multi Asset Account',
    code: '155555',
    account_type: 'asset_fixed',
    asset_model_id: model.id,
    create_asset: 'validate',
  });
  db = validAccount.db;

  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 2,
    invoice_date: '2026-01-01',
    invoice_line_ids: [
      {
        line_id: 'line_asset_A',
        name: 'Asset A',
        qty: 1,
        price_unit: 2000,
        tax: 0,
        account_id: validAccount.id,
      },
      {
        line_id: 'line_asset_B',
        name: 'Asset B',
        qty: 1,
        price_unit: 3000,
        tax: 0,
        account_id: validAccount.id,
      },
    ],
  });
  db = postMove(bill.db, bill.id);

  const assets = search(db, 'account.asset').filter((a) => a.bill_id === bill.id);
  assert.equal(assets.length, 2);
  const assetA = assets.find((a) => a.bill_line === 0);
  const assetB = assets.find((a) => a.bill_line === 1);
  assert.ok(assetA && assetB);
  assert.equal(assetA.state, 'open');
  assert.equal(assetB.state, 'open');

  // Refund only Asset A
  const refund = create(db, 'account.move', {
    move_type: 'in_refund',
    partner_id: 2,
    invoice_date: '2026-02-01',
    reversed_entry_id: bill.id,
    invoice_line_ids: [{
      name: 'Refund Asset A Only',
      qty: 1,
      price_unit: 2000,
      tax: 0,
      account_id: validAccount.id,
      source_line_id: 'line_asset_A',
    }],
  });
  db = postMove(refund.db, refund.id);

  const assetAAfter = read(db, 'account.asset', assetA.id);
  const assetBAfter = read(db, 'account.asset', assetB.id);

  assert.equal(assetAAfter.state, 'cancel', 'Refunded Asset A should be cancelled');
  assert.equal(assetBAfter.state, 'open', 'Unrefunded Asset B must remain open');
  assert.equal(assetBAfter.original_value, 3000, 'Asset B value must be unchanged');
});
