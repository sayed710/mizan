import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { models } from './registry.js';
import { accountId } from './models/ledger.js';
import { confirmAsset, disposeAsset, hasDueDepreciation, modifyAsset, pauseAsset, postDepreciation, resumeAsset } from './models/assets.js';
import { postMove } from './models/accounting.js';
import { newDefaults } from './views/formDefaults.js';
import { assetAccounts } from './test-support/asset-accounts.js';

const BASE_ASSET = {
  name: 'Machine Tool',
  acquisition_date: '2026-06-01',
  original_value: 12000,
  salvage_value: 0,
  method: 'linear',
  method_number: 5,
  method_period: '12',
  method_progress_factor: 0.3,
  prorata: false,
};

function createDraftAsset(db, overrides = {}) {
  const accounts = assetAccounts(db);
  const created = create(db, 'account.asset', {
    ...BASE_ASSET,
    ...accounts,
    state: 'draft',
    depreciation_ids: [],
    ...overrides,
  });
  return { db: created.db, id: created.id, asset: read(created.db, 'account.asset', created.id) };
}

function createOpenAsset(db, overrides = {}) {
  const { db: draftDb, id } = createDraftAsset(db, overrides);
  const confirmedDb = confirmAsset(draftDb, read(draftDb, 'account.asset', id));
  return { db: confirmedDb, id, asset: read(confirmedDb, 'account.asset', id) };
}

test('1. Core depreciation-defining fields are readonly on open assets and server rejects writes; allowed on draft', () => {
  let db = seed();
  const draft = createDraftAsset(db);
  db = draft.db;

  // Allowed on draft
  db = write(db, 'account.asset', draft.id, { original_value: 15000, method_number: 6 });
  assert.equal(read(db, 'account.asset', draft.id).original_value, 15000);
  assert.equal(read(db, 'account.asset', draft.id).method_number, 6);

  // Confirm to open
  db = confirmAsset(db, read(db, 'account.asset', draft.id));
  const open = read(db, 'account.asset', draft.id);
  assert.equal(open.state, 'open');

  const coreFields = [
    'original_value', 'salvage_value', 'already_depreciated', 'acquisition_date',
    'method', 'method_number', 'method_period', 'method_progress_factor', 'prorata',
    'company_id', 'account_asset_id', 'account_depreciation_id', 'account_depreciation_expense_id',
    'journal_id', 'model_id',
  ];

  // Check form field readonly metadata
  const def = models['account.asset'];
  for (const field of coreFields) {
    const f = def.fields[field];
    assert.ok(f, `Field ${field} must exist`);
    assert.equal(typeof f.readonly, 'function', `Field ${field} must have dynamic readonly function`);
    assert.equal(f.readonly(open), true, `Field ${field} must be readonly when open`);
    assert.equal(Boolean(f.readonly({ state: 'draft' })), false, `Field ${field} must be editable in draft`);
  }

  // Server rejects write to core fields on open asset
  assert.throws(
    () => write(db, 'account.asset', open.id, { original_value: 5000 }),
    /core asset fields|depreciation-defining/i,
  );
  assert.throws(
    () => write(db, 'account.asset', open.id, { method_number: 10 }),
    /core asset fields|depreciation-defining/i,
  );
  assert.throws(
    () => write(db, 'account.asset', open.id, { account_asset_id: accountId(db, '151000') + 1 }),
    /core asset fields|depreciation-defining/i,
  );

  // Non-core edits (e.g. name, partner_id) are not blocked by core field guard
  const renamed = write(db, 'account.asset', open.id, { name: 'Machine Tool Updated' });
  assert.equal(read(renamed, 'account.asset', open.id).name, 'Machine Tool Updated');
});

test('2. Modify Depreciation and dispose still work on an open asset', () => {
  let db = seed();
  const open = createOpenAsset(db, { original_value: 10000 });
  db = open.db;

  const revalAccId = accountId(db, '450300');
  // Modify Depreciation via modifyAsset
  db = modifyAsset(db, read(db, 'account.asset', open.id), {
    date: '2026-06-15',
    value_change: 2000,
    accountId: revalAccId,
  });
  let asset = read(db, 'account.asset', open.id);
  assert.equal(asset.original_value, 12000);

  // Dispose via disposeAsset
  db = disposeAsset(db, asset, { date: '2026-07-01' });
  asset = read(db, 'account.asset', open.id);
  assert.equal(asset.state, 'close');
  assert.equal(asset.disposal_date, '2026-07-01');
});

test('3. Bill selector lists only posted vendor bills of the company (and vendor when set); server rejects invalid bills', () => {
  let db = seed();
  const vendor1 = 2;
  const vendor2 = 3;

  // 1. Posted vendor bill for vendor 1 in company 1
  const bill1 = create(db, 'account.move', {
    move_type: 'in_invoice', partner_id: vendor1, company_id: 1, invoice_date: '2026-01-10',
    invoice_line_ids: [{ name: 'Part A', price_unit: 1000, qty: 1, account_id: accountId(db, '151000') }],
  });
  db = postMove(bill1.db, bill1.id);

  // 2. Draft vendor bill for vendor 1
  const draftBill = create(db, 'account.move', {
    move_type: 'in_invoice', partner_id: vendor1, company_id: 1, invoice_date: '2026-01-11',
    invoice_line_ids: [{ name: 'Part B', price_unit: 500, qty: 1, account_id: accountId(db, '151000') }],
  });
  db = draftBill.db;

  // 3. Customer invoice (out_invoice) posted
  const outInvoice = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: vendor1, company_id: 1, invoice_date: '2026-01-12',
    invoice_line_ids: [{ name: 'Service', price_unit: 200, qty: 1 }],
  });
  db = postMove(outInvoice.db, outInvoice.id);

  // 4. Posted vendor bill for vendor 2 in company 1
  const bill2 = create(db, 'account.move', {
    move_type: 'in_invoice', partner_id: vendor2, company_id: 1, invoice_date: '2026-01-15',
    invoice_line_ids: [{ name: 'Part C', price_unit: 800, qty: 1, account_id: accountId(db, '151000') }],
  });
  db = postMove(bill2.db, bill2.id);

  const billField = models['account.asset'].fields.bill_id;
  assert.ok(billField.domain, 'bill_id must have a domain filter');

  // Test domain filtering when no partner is set on asset
  const assetNoPartner = { company_id: 1, partner_id: null };
  assert.equal(billField.domain(read(db, 'account.move', bill1.id), assetNoPartner), true);
  assert.equal(billField.domain(read(db, 'account.move', bill2.id), assetNoPartner), true);
  assert.equal(billField.domain(read(db, 'account.move', draftBill.id), assetNoPartner), false);
  assert.equal(billField.domain(read(db, 'account.move', outInvoice.id), assetNoPartner), false);

  // Test domain filtering when partner is vendor1
  const assetVendor1 = { company_id: 1, partner_id: vendor1 };
  assert.equal(billField.domain(read(db, 'account.move', bill1.id), assetVendor1), true);
  assert.equal(billField.domain(read(db, 'account.move', bill2.id), assetVendor1), false);

  // Test domain filtering for another company
  const assetCompany2 = { company_id: 2, partner_id: vendor1 };
  assert.equal(billField.domain(read(db, 'account.move', bill1.id), assetCompany2), false);

  // Server rejection:
  // Reject draft bill
  assert.throws(
    () => create(db, 'account.asset', { ...BASE_ASSET, ...assetAccounts(db), bill_id: draftBill.id }),
    /posted vendor bill/i,
  );
  // Reject customer invoice
  assert.throws(
    () => create(db, 'account.asset', { ...BASE_ASSET, ...assetAccounts(db), bill_id: outInvoice.id }),
    /posted vendor bill/i,
  );
  // Reject bill of different vendor when asset partner_id is set
  assert.throws(
    () => create(db, 'account.asset', { ...BASE_ASSET, ...assetAccounts(db), partner_id: vendor1, bill_id: bill2.id }),
    /vendor bill/i,
  );

  // Valid bill creates successfully
  const validCreated = create(db, 'account.asset', { ...BASE_ASSET, ...assetAccounts(db), partner_id: vendor1, bill_id: bill1.id });
  assert.equal(read(validCreated.db, 'account.asset', validCreated.id).bill_id, bill1.id);
});

test('4. Journal selector lists only general journals and defaults to MISC; server rejects non-general journal', () => {
  let db = seed();
  const jField = models['account.asset'].fields.journal_id;
  assert.ok(jField.domain, 'journal_id must have a domain filter');

  const misc = search(db, 'account.journal').find((j) => j.code === 'MISC');
  const bnk = search(db, 'account.journal').find((j) => j.type === 'bank');
  const sale = search(db, 'account.journal').find((j) => j.type === 'sale');

  assert.ok(misc, 'MISC journal exists');
  assert.ok(bnk, 'Bank journal exists');
  assert.ok(sale, 'Sale journal exists');

  assert.equal(jField.domain(misc, { company_id: 1 }), true);
  assert.equal(jField.domain(bnk, { company_id: 1 }), false);
  assert.equal(jField.domain(sale, { company_id: 1 }), false);

  // Default on a new asset is MISC journal before saving
  const newAssetValues = newDefaults(db, 'account.asset', { defaults: {} }, new URLSearchParams(), null);
  assert.equal(newAssetValues.journal_id, misc.id, 'New asset form defaults to MISC journal');

  // Server rejects non-general journal
  assert.throws(
    () => create(db, 'account.asset', { ...BASE_ASSET, ...assetAccounts(db), journal_id: bnk.id }),
    /general|miscellaneous/i,
  );
  assert.throws(
    () => create(db, 'account.asset', { ...BASE_ASSET, ...assetAccounts(db), journal_id: sale.id }),
    /general|miscellaneous/i,
  );
});

test('5. Legacy Expense Account is removed from form view groups; field definition remains', () => {
  const formGroups = models['account.asset'].form.groups;
  const allFormFields = formGroups.flat();
  assert.ok(!allFormFields.includes('account_expense_id'), 'account_expense_id must be removed from form groups');
  assert.ok(models['account.asset'].fields.account_expense_id, 'account_expense_id field must still exist on model');
});

test('6. Disposal Date and Sale Price are readonly on the form and only shown when set', () => {
  const def = models['account.asset'];
  const dispDate = def.fields.disposal_date;
  const salePrice = def.fields.sale_value;

  assert.equal(dispDate.readonly, true, 'disposal_date must be readonly');
  assert.equal(salePrice.readonly, true, 'sale_value must be readonly');

  assert.ok(dispDate.hideWhen, 'disposal_date must have hideWhen');
  assert.ok(salePrice.hideWhen, 'sale_value must have hideWhen');

  assert.equal(dispDate.hideWhen({ disposal_date: null }), true, 'disposal_date hidden when not set');
  assert.equal(dispDate.hideWhen({ disposal_date: '2026-06-01' }), false, 'disposal_date visible when set');

  assert.equal(salePrice.hideWhen({ sale_value: null }), true, 'sale_value hidden when not set');
  assert.equal(salePrice.hideWhen({ sale_value: 0 }), false, 'sale_value visible when 0');
  assert.equal(salePrice.hideWhen({ sale_value: 100 }), false, 'sale_value visible when positive');

  // Server rejects direct writes to disposal fields outside disposal flow
  const db = seed();
  const draft = createDraftAsset(db);
  assert.throws(
    () => write(draft.db, 'account.asset', draft.id, { disposal_date: '2026-07-01' }),
    /Sell or Dispose/i,
  );
  assert.throws(
    () => write(draft.db, 'account.asset', draft.id, { sale_value: 500 }),
    /Sell or Dispose/i,
  );
});

test('7. Post Depreciation when no line is due yet notifies and does not change state', () => {
  let db = seed();
  // Asset with acquisition in future (e.g. next year) so all lines are in the future
  const open = createOpenAsset(db, { acquisition_date: '2099-01-01' });
  db = open.db;

  const btn = models['account.asset'].form.buttons.find((b) => b.label === 'Post Depreciation');
  assert.ok(btn, 'Post Depreciation button must exist');

  const assetBefore = read(db, 'account.asset', open.id);
  assert.equal(hasDueDepreciation(assetBefore, '2026-06-01'), false, 'hasDueDepreciation returns false when no lines due');

  const res = btn.run(db, assetBefore);
  assert.equal(res.message, 'No depreciation is due yet.');
  assert.equal(res.notification, undefined, 'notification key must be dropped');

  // Asset state must remain open and no entries posted
  const assetAfter = read(res.db, 'account.asset', open.id);
  assert.equal(assetAfter.state, 'open');
  assert.ok(assetAfter.depreciation_ids.every((l) => !l.posted));
});

test('8. Running asset with non-general journal can still Post Depreciation, Pause, Resume, Modify and Sell or Dispose', () => {
  let db = seed();
  const open = createOpenAsset(db, {
    acquisition_date: '2026-01-01',
    original_value: 12000,
    salvage_value: 0,
    method_number: 12,
    method_period: '1',
  });
  db = open.db;

  // Set up a non-general journal (e.g. Bank or Sale) using an internal write
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank');
  assert.ok(bankJournal, 'bank journal exists');
  db = write(db, 'account.asset', open.id, { journal_id: bankJournal.id }, { internal: true });

  let asset = read(db, 'account.asset', open.id);
  assert.equal(asset.journal_id, bankJournal.id);
  assert.equal(asset.state, 'open');

  // 1. Post Depreciation still works for existing running asset
  db = postDepreciation(db, asset, '2026-03-31');
  asset = read(db, 'account.asset', open.id);
  const posted = (asset.depreciation_ids ?? []).filter((l) => l.posted);
  assert.ok(posted.length > 0, 'Depreciation entries must post');
  assert.equal(read(db, 'account.move', posted[0].move_id).journal_id, bankJournal.id);

  // 2. Pause
  db = pauseAsset(db, asset, '2026-04-01');
  asset = read(db, 'account.asset', open.id);
  assert.equal(asset.state, 'paused');

  // 3. Resume
  db = resumeAsset(db, asset, '2026-04-10');
  asset = read(db, 'account.asset', open.id);
  assert.equal(asset.state, 'open');

  // 4. Modify Depreciation
  const revalAccId = accountId(db, '450300');
  db = modifyAsset(db, asset, {
    date: '2026-04-15',
    value_change: 1000,
    accountId: revalAccId,
  });
  asset = read(db, 'account.asset', open.id);
  assert.equal(asset.original_value, 13000);

  // 5. Sell or Dispose
  db = disposeAsset(db, asset, { date: '2026-05-01' });
  asset = read(db, 'account.asset', open.id);
  assert.equal(asset.state, 'close');
  assert.equal(asset.disposal_date, '2026-05-01');
});
