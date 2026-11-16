import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { models } from './registry.js';
import { accountId } from './models/ledger.js';
import { confirmAsset, disposeAsset, hasDueDepreciation, modifyAsset, pauseAsset, postDepreciation, resumeAsset } from './models/assets.js';
import { postMove, reverseDepreciation } from './models/accounting.js';
import { newDefaults } from './views/formDefaults.js';
import { assetAccounts } from './test-support/asset-accounts.js';
import { applyDiff, diffDb } from './sync.js';
import { runScheduledJobs } from './models/scheduler.js';

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
    /inconsistent with asset values|recorded value adjustments/i,
  );
  assert.throws(
    () => write(db, 'account.asset', open.id, { method_number: 10 }),
    /inconsistent with asset duration|inconsistent with asset values/i,
  );
  assert.throws(
    () => write(db, 'account.asset', open.id, { account_asset_id: accountId(db, '151000') + 1 }),
    /core asset fields/i,
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

  // Set up a non-general journal (e.g. Bank or Sale) directly in db.records
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank');
  assert.ok(bankJournal, 'bank journal exists');
  db = {
    ...db,
    records: {
      ...db.records,
      'account.asset': db.records['account.asset'].map((rec) => (rec.id === open.id ? { ...rec, journal_id: bankJournal.id } : rec)),
    },
  };

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

test('9. When current company is not company 1, new asset defaults match current company and confirm succeeds', () => {
  let db = seed();
  const company2 = create(db, 'res.company', { name: 'Branch Co' });
  db = company2.db;

  const misc2 = create(db, 'account.journal', { name: 'Misc Co2', code: 'MISC', type: 'general', company_id: company2.id });
  db = misc2.db;

  const assetAcc = create(db, 'account.account', { code: '151002', name: 'Fixed Assets Co 2', account_type: 'asset_fixed', company_id: company2.id });
  db = assetAcc.db;
  const depAcc = create(db, 'account.account', { code: '152002', name: 'Depreciation Co 2', account_type: 'asset_fixed', company_id: company2.id });
  db = depAcc.db;
  const expAcc = create(db, 'account.account', { code: '680002', name: 'Dep Expense Co 2', account_type: 'expense', company_id: company2.id });
  db = expAcc.db;

  // Set current company to Company 2
  db = { ...db, settings: { ...db.settings, current_company_id: company2.id } };

  // Create an asset without company_id or journal_id
  const created = create(db, 'account.asset', {
    name: 'Co2 Machine',
    acquisition_date: '2026-06-01',
    original_value: 6000,
    salvage_value: 0,
    method_number: 3,
    method_period: '12',
    account_asset_id: assetAcc.id,
    account_depreciation_id: depAcc.id,
    account_depreciation_expense_id: expAcc.id,
  });
  db = created.db;
  const asset = read(db, 'account.asset', created.id);
  assert.equal(asset.company_id, company2.id, 'Asset company must default to currentCompany (Company 2)');
  assert.equal(asset.journal_id, misc2.id, 'Asset journal must default to Company 2 MISC journal');

  // confirmAsset succeeds without company/journal mismatch error
  assert.doesNotThrow(() => {
    db = confirmAsset(db, read(db, 'account.asset', created.id));
  });
  assert.equal(read(db, 'account.asset', created.id).state, 'open');
});

test('10. Post Depreciation transitions open asset with 0 unposted lines to close; button and scheduler behavior', () => {
  let db = seed();
  const open = createOpenAsset(db, {
    acquisition_date: '2026-01-01',
    original_value: 2000,
    method_number: 2,
    method_period: '1',
  });
  db = open.db;

  // Post all lines
  db = postDepreciation(db, read(db, 'account.asset', open.id), '2026-03-01');
  let asset = read(db, 'account.asset', open.id);
  assert.equal(asset.state, 'close');

  // Test an open asset whose lines are already posted (e.g. state reset or historical fixture)
  db = {
    ...db,
    records: {
      ...db.records,
      'account.asset': db.records['account.asset'].map((rec) => (rec.id === open.id ? { ...rec, state: 'open' } : rec)),
    },
  };
  asset = read(db, 'account.asset', open.id);
  assert.equal(asset.state, 'open');
  assert.equal(asset.depreciation_ids.filter((l) => !l.posted).length, 0);

  // Form button click: does NOT return 'No depreciation is due yet.'; closes the asset
  const btn = models['account.asset'].form.buttons.find((b) => b.label === 'Post Depreciation');
  const initialMoveCount = (db.records['account.move'] ?? []).length;
  const btnResult = btn.run(db, asset);
  assert.equal(btnResult.message, undefined, 'Must not notify when 0 unposted lines');
  const closedAsset = read(btnResult.db, 'account.asset', open.id);
  assert.equal(closedAsset.state, 'close', 'Form button must close an asset when all lines are posted');
  assert.equal((btnResult.db.records['account.move'] ?? []).length, initialMoveCount, 'No new moves created');

  // Direct postDepreciation on an open asset with empty board also transitions to close
  const emptyBoardAsset = create(db, 'account.asset', {
    ...BASE_ASSET,
    ...assetAccounts(db),
    state: 'open',
    depreciation_ids: [],
  });
  db = emptyBoardAsset.db;
  const closedEmpty = postDepreciation(db, read(db, 'account.asset', emptyBoardAsset.id));
  assert.equal(read(closedEmpty, 'account.asset', emptyBoardAsset.id).state, 'close');

  // Scheduler closes an open asset whose lines are all posted
  let schedDb = {
    ...db,
    records: {
      ...db.records,
      'account.asset': db.records['account.asset'].map((rec) => (rec.id === open.id ? { ...rec, state: 'open' } : rec)),
    },
  };
  schedDb = runScheduledJobs(schedDb, '2026-04-01');
  assert.equal(read(schedDb, 'account.asset', open.id).state, 'close', 'Scheduler must close asset with all lines posted');
});

test('11. Structural invariants G1-G5 enforced identically by ORM write and server applyDiff', () => {
  let db = seed();
  const open = createOpenAsset(db, {
    acquisition_date: '2026-06-01',
    original_value: 12000,
    salvage_value: 0,
    method_number: 5,
    method_period: '12',
  });
  db = open.db;
  const asset = read(db, 'account.asset', open.id);
  const revalAccId = accountId(db, '450300');

  // 1. Sell or Dispose diff accepted by applyDiff
  const disposedDb = disposeAsset(db, asset, { date: '2026-06-01' });
  const syncedDisposed = applyDiff(db, diffDb(db, disposedDb), { author: 'test', isAdmin: false });
  assert.equal(read(syncedDisposed, 'account.asset', asset.id).state, 'close');
  assert.equal(read(syncedDisposed, 'account.asset', asset.id).disposal_date, '2026-06-01');

  // 2. Modify Depreciation diffs accepted by applyDiff
  // 2a. Value increase (+2400)
  const modifiedIncrease = modifyAsset(db, asset, {
    date: '2026-06-15',
    value_change: 2400,
    accountId: revalAccId,
  });
  const syncedIncrease = applyDiff(db, diffDb(db, modifiedIncrease), { author: 'test', isAdmin: false });
  assert.equal(read(syncedIncrease, 'account.asset', asset.id).original_value, 14400);

  // 2b. Impairment / value decrease (-1200)
  const modifiedImpair = modifyAsset(db, asset, {
    date: '2026-06-15',
    value_change: -1200,
  });
  const syncedImpair = applyDiff(db, diffDb(db, modifiedImpair), { author: 'test', isAdmin: false });
  assert.equal(read(syncedImpair, 'account.asset', asset.id).original_value, 10800);

  // 2c. Method number change (remaining duration to 6)
  const modifiedDuration = modifyAsset(db, asset, {
    date: '2026-06-15',
    methodNumber: 6,
  });
  const syncedDuration = applyDiff(db, diffDb(db, modifiedDuration), { author: 'test', isAdmin: false });
  const afterDuration = read(syncedDuration, 'account.asset', asset.id);
  assert.equal(afterDuration.method_number, 6);
  assert.equal(afterDuration.depreciation_ids.filter((l) => !l.cancelled).length, 6);

  // 3. Post Depreciation, Pause, and Resume diffs accepted by applyDiff
  const postedDb = postDepreciation(db, asset, '2026-12-31');
  const syncedPost = applyDiff(db, diffDb(db, postedDb), { author: 'test', isAdmin: false });
  assert.ok(read(syncedPost, 'account.asset', asset.id).depreciation_ids.filter((l) => l.posted).length > 0);

  const assetAfterPost = read(syncedPost, 'account.asset', asset.id);
  const pausedDb = pauseAsset(syncedPost, assetAfterPost, '2027-01-01');
  const syncedPause = applyDiff(syncedPost, diffDb(syncedPost, pausedDb), { author: 'test', isAdmin: false });
  assert.equal(read(syncedPause, 'account.asset', asset.id).state, 'paused');

  const resumedDb = resumeAsset(syncedPause, read(syncedPause, 'account.asset', asset.id), '2027-01-15');
  const syncedResume = applyDiff(syncedPause, diffDb(syncedPause, resumedDb), { author: 'test', isAdmin: false });
  assert.equal(read(syncedResume, 'account.asset', asset.id).state, 'open');

  // 4. Raw write of original_value rejected by write and by applyDiff (G3)
  assert.throws(
    () => write(db, 'account.asset', asset.id, { original_value: 5000 }),
    /inconsistent with asset values|recorded value adjustments/i,
  );
  assert.throws(
    () => applyDiff(db, { upserts: { 'account.asset': [{ ...asset, original_value: 5000 }] } }, { author: 'test', isAdmin: false }),
    /inconsistent with asset values|recorded value adjustments/i,
  );

  // 5. Re-drafting an open asset (state: 'draft') rejected by write and by applyDiff (G1)
  assert.throws(
    () => write(db, 'account.asset', asset.id, { state: 'draft' }),
    /Cannot reset a confirmed asset to draft/i,
  );
  assert.throws(
    () => applyDiff(db, { upserts: { 'account.asset': [{ ...asset, state: 'draft' }] } }, { author: 'test', isAdmin: false }),
    /Cannot reset a confirmed asset to draft/i,
  );

  // 6. Setting disposal_date on a running asset without moving to 'close' rejected by write and by applyDiff (G4)
  assert.throws(
    () => write(db, 'account.asset', asset.id, { disposal_date: '2026-05-01' }),
    /Disposal fields can only be set through Sell or Dispose/i,
  );
  assert.throws(
    () => applyDiff(db, { upserts: { 'account.asset': [{ ...asset, disposal_date: '2026-05-01' }] } }, { author: 'test', isAdmin: false }),
    /Disposal fields can only be set through Sell or Dispose/i,
  );

  // 7. Changing journal_id on an open asset rejected by write and by applyDiff (G2)
  const anotherJournal = create(db, 'account.journal', { name: 'Other General', code: 'GEN2', type: 'general' });
  db = anotherJournal.db;
  assert.throws(
    () => write(db, 'account.asset', asset.id, { journal_id: anotherJournal.id }),
    /Cannot modify core asset fields once confirmed/i,
  );
  assert.throws(
    () => applyDiff(db, { upserts: { 'account.asset': [{ ...asset, journal_id: anotherJournal.id }] } }, { author: 'test', isAdmin: false }),
    /Cannot modify core asset fields once confirmed/i,
  );

  // 8. Running asset carrying a non-general journal can still Post, Pause, Resume, Modify and Dispose via applyDiff
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank');
  let runningWithBank = {
    ...db,
    records: {
      ...db.records,
      'account.asset': db.records['account.asset'].map((rec) => (rec.id === asset.id ? { ...rec, journal_id: bankJournal.id } : rec)),
    },
  };
  let bankAsset = read(runningWithBank, 'account.asset', asset.id);

  // Post via applyDiff
  const bPost = postDepreciation(runningWithBank, bankAsset, '2026-12-31');
  runningWithBank = applyDiff(runningWithBank, diffDb(runningWithBank, bPost), { author: 'test', isAdmin: false });
  bankAsset = read(runningWithBank, 'account.asset', asset.id);
  assert.ok(bankAsset.depreciation_ids.filter((l) => l.posted).length > 0);

  // Pause via applyDiff
  const bPause = pauseAsset(runningWithBank, bankAsset, '2027-01-01');
  runningWithBank = applyDiff(runningWithBank, diffDb(runningWithBank, bPause), { author: 'test', isAdmin: false });
  bankAsset = read(runningWithBank, 'account.asset', asset.id);
  assert.equal(bankAsset.state, 'paused');

  // Resume via applyDiff
  const bResume = resumeAsset(runningWithBank, bankAsset, '2027-01-10');
  runningWithBank = applyDiff(runningWithBank, diffDb(runningWithBank, bResume), { author: 'test', isAdmin: false });
  bankAsset = read(runningWithBank, 'account.asset', asset.id);
  assert.equal(bankAsset.state, 'open');

  // Modify via applyDiff
  const bModify = modifyAsset(runningWithBank, bankAsset, { date: '2027-01-15', value_change: 1000, accountId: revalAccId });
  runningWithBank = applyDiff(runningWithBank, diffDb(runningWithBank, bModify), { author: 'test', isAdmin: false });
  bankAsset = read(runningWithBank, 'account.asset', asset.id);
  assert.equal(bankAsset.original_value, 13000);

  // Dispose via applyDiff
  const bDispose = disposeAsset(runningWithBank, bankAsset, { date: '2027-02-01' });
  runningWithBank = applyDiff(runningWithBank, diffDb(runningWithBank, bDispose), { author: 'test', isAdmin: false });
  bankAsset = read(runningWithBank, 'account.asset', asset.id);
  assert.equal(bankAsset.state, 'close');
  assert.equal(bankAsset.disposal_date, '2027-02-01');
});

test('12. Q1: Posted depreciation lines immutable on write and applyDiff; reverseDepreciation works via write and applyDiff', () => {
  let db = seed();
  const open = createOpenAsset(db, {
    acquisition_date: '2026-06-01',
    original_value: 12000,
    salvage_value: 0,
    method_number: 5,
    method_period: '12',
  });
  db = open.db;
  let asset = read(db, 'account.asset', open.id);

  // Post 1 depreciation line legitimately
  db = postDepreciation(db, asset, '2026-12-31');
  asset = read(db, 'account.asset', open.id);
  const postedLine = asset.depreciation_ids.find((l) => l.posted);
  assert.ok(postedLine);
  assert.ok(postedLine.move_id);

  // Forged 1: Modify amount of posted line
  const forgedAmountLines = asset.depreciation_ids.map((l) => (l.date === postedLine.date ? { ...l, amount: 2000 } : l));
  assert.throws(
    () => write(db, 'account.asset', asset.id, { depreciation_ids: forgedAmountLines }),
    /Posted depreciation lines cannot be modified/i,
  );
  assert.throws(
    () => applyDiff(db, { upserts: { 'account.asset': [{ ...asset, depreciation_ids: forgedAmountLines }] } }, { author: 'test', isAdmin: false }),
    /Posted depreciation lines cannot be modified/i,
  );

  // Forged 2: Modify move_id of posted line
  const forgedMoveLines = asset.depreciation_ids.map((l) => (l.date === postedLine.date ? { ...l, move_id: 99999 } : l));
  assert.throws(
    () => write(db, 'account.asset', asset.id, { depreciation_ids: forgedMoveLines }),
    /Posted depreciation lines cannot be modified/i,
  );
  assert.throws(
    () => applyDiff(db, { upserts: { 'account.asset': [{ ...asset, depreciation_ids: forgedMoveLines }] } }, { author: 'test', isAdmin: false }),
    /Posted depreciation lines cannot be modified/i,
  );

  // Forged 3: Remove posted line
  const forgedRemovedLines = asset.depreciation_ids.filter((l) => l.date !== postedLine.date);
  assert.throws(
    () => write(db, 'account.asset', asset.id, { depreciation_ids: forgedRemovedLines }),
    /Posted depreciation lines cannot be modified/i,
  );
  assert.throws(
    () => applyDiff(db, { upserts: { 'account.asset': [{ ...asset, depreciation_ids: forgedRemovedLines }] } }, { author: 'test', isAdmin: false }),
    /Posted depreciation lines cannot be modified/i,
  );

  // Forged 4: Unpost line without reversal move
  const forgedUnpostLines = asset.depreciation_ids.map((l) => (l.date === postedLine.date ? { ...l, posted: false, move_id: null } : l));
  assert.throws(
    () => write(db, 'account.asset', asset.id, { depreciation_ids: forgedUnpostLines }),
    /Posted depreciation lines cannot be modified/i,
  );
  assert.throws(
    () => applyDiff(db, { upserts: { 'account.asset': [{ ...asset, depreciation_ids: forgedUnpostLines }] } }, { author: 'test', isAdmin: false }),
    /Posted depreciation lines cannot be modified/i,
  );

  // Legitimate: reverseDepreciation works through write AND applyDiff
  const depMove = read(db, 'account.move', postedLine.move_id);
  assert.ok(depMove);
  const revDb = reverseDepreciation(db, depMove, { date: '2026-12-31' });
  const revAsset = read(revDb, 'account.asset', asset.id);
  const revLine = revAsset.depreciation_ids.find((l) => l.date === postedLine.date);
  assert.equal(revLine.posted, false);
  assert.equal(revLine.move_id, null);

  const syncedRevDb = applyDiff(db, diffDb(db, revDb), { author: 'test', isAdmin: false });
  const syncedRevAsset = read(syncedRevDb, 'account.asset', asset.id);
  const syncedRevLine = syncedRevAsset.depreciation_ids.find((l) => l.date === postedLine.date);
  assert.equal(syncedRevLine.posted, false);
  assert.equal(syncedRevLine.move_id, null);
});

test('13. Q2: Line posted:true requires valid posted move in asset company debiting exp and crediting dep, no sharing; workflows pass applyDiff', () => {
  let db = seed();
  const open = createOpenAsset(db, {
    acquisition_date: '2026-06-01',
    original_value: 12000,
    salvage_value: 0,
    method_number: 5,
    method_period: '12',
  });
  db = open.db;
  const asset = read(db, 'account.asset', open.id);

  // Legitimate 1: postDepreciation passes applyDiff
  const postedDb = postDepreciation(db, asset, '2026-12-31');
  const syncedPostedDb = applyDiff(db, diffDb(db, postedDb), { author: 'test', isAdmin: false });
  const syncedAsset = read(syncedPostedDb, 'account.asset', asset.id);
  const postedLine = syncedAsset.depreciation_ids.find((l) => l.posted);
  assert.ok(postedLine);
  assert.ok(postedLine.move_id);

  // Legitimate 2: runScheduledJobs passes applyDiff
  const schedDb = runScheduledJobs(syncedPostedDb, '2027-12-31');
  const syncedSchedDb = applyDiff(syncedPostedDb, diffDb(syncedPostedDb, schedDb), { author: 'test', isAdmin: false });
  const schedAsset = read(syncedSchedDb, 'account.asset', asset.id);
  assert.ok(schedAsset.depreciation_ids.filter((l) => l.posted).length >= 2);

  // Forged 1: Line posted:true with no move (move_id: null)
  const line1 = asset.depreciation_ids[0];
  const forgedNoMove = asset.depreciation_ids.map((l, idx) => (idx === 0 ? { ...l, posted: true, move_id: null } : l));
  assert.throws(
    () => write(db, 'account.asset', asset.id, { depreciation_ids: forgedNoMove }),
    /Depreciation move must be a posted entry debiting depreciation expense and crediting depreciation account/i,
  );
  assert.throws(
    () => applyDiff(db, { upserts: { 'account.asset': [{ ...asset, depreciation_ids: forgedNoMove }] } }, { author: 'test', isAdmin: false }),
    /Depreciation move must be a posted entry debiting depreciation expense and crediting depreciation account/i,
  );

  // Forged 2: Line posted:true with draft move
  const draftMove = create(db, 'account.move', {
    move_type: 'entry',
    journal_id: asset.journal_id,
    company_id: asset.company_id,
    date: line1.date,
    line_ids: [
      { account_id: asset.account_depreciation_expense_id, debit: line1.amount, credit: 0 },
      { account_id: asset.account_depreciation_id, debit: 0, credit: line1.amount },
    ],
  });
  const forgedDraftMoveLines = asset.depreciation_ids.map((l, idx) => (idx === 0 ? { ...l, posted: true, move_id: draftMove.id } : l));
  assert.throws(
    () => write(draftMove.db, 'account.asset', asset.id, { depreciation_ids: forgedDraftMoveLines }),
    /Depreciation move must be a posted entry debiting depreciation expense and crediting depreciation account/i,
  );
  assert.throws(
    () => applyDiff(draftMove.db, { upserts: { 'account.asset': [{ ...asset, depreciation_ids: forgedDraftMoveLines }] } }, { author: 'test', isAdmin: false }),
    /Depreciation move must be a posted entry debiting depreciation expense and crediting depreciation account/i,
  );

  // Forged 3: Line posted:true with move belonging to different company
  const comp2 = create(db, 'res.company', { name: 'Comp 2', currency_id: 1 });
  const moveComp2 = create(comp2.db, 'account.move', {
    name: 'MISC/2026/0001',
    move_type: 'entry',
    journal_id: asset.journal_id,
    company_id: comp2.id,
    date: line1.date,
    state: 'posted',
    line_ids: [
      { account_id: asset.account_depreciation_expense_id, debit: line1.amount, credit: 0 },
      { account_id: asset.account_depreciation_id, debit: 0, credit: line1.amount },
    ],
  });
  const forgedComp2Lines = asset.depreciation_ids.map((l, idx) => (idx === 0 ? { ...l, posted: true, move_id: moveComp2.id } : l));
  assert.throws(
    () => write(moveComp2.db, 'account.asset', asset.id, { depreciation_ids: forgedComp2Lines }),
    /Depreciation move must be a posted entry debiting depreciation expense and crediting depreciation account/i,
  );
  assert.throws(
    () => applyDiff(moveComp2.db, { upserts: { 'account.asset': [{ ...asset, depreciation_ids: forgedComp2Lines }] } }, { author: 'test', isAdmin: false }),
    /Depreciation move must be a posted entry debiting depreciation expense and crediting depreciation account/i,
  );

  // Forged 4: Line posted:true with move of wrong amount or wrong accounts
  const badAmountMove = create(db, 'account.move', {
    name: 'MISC/2026/0002',
    move_type: 'entry',
    journal_id: asset.journal_id,
    company_id: asset.company_id,
    date: line1.date,
    state: 'posted',
    line_ids: [
      { account_id: asset.account_depreciation_expense_id, debit: 999, credit: 0 },
      { account_id: asset.account_depreciation_id, debit: 0, credit: 999 },
    ],
  });
  const forgedBadAmountLines = asset.depreciation_ids.map((l, idx) => (idx === 0 ? { ...l, posted: true, move_id: badAmountMove.id } : l));
  assert.throws(
    () => write(badAmountMove.db, 'account.asset', asset.id, { depreciation_ids: forgedBadAmountLines }),
    /Depreciation move must be a posted entry debiting depreciation expense and crediting depreciation account/i,
  );
  assert.throws(
    () => applyDiff(badAmountMove.db, { upserts: { 'account.asset': [{ ...asset, depreciation_ids: forgedBadAmountLines }] } }, { author: 'test', isAdmin: false }),
    /Depreciation move must be a posted entry debiting depreciation expense and crediting depreciation account/i,
  );

  // Forged 5: Two board lines on same asset sharing same move_id
  const sharedOnSame = syncedAsset.depreciation_ids.map((l, idx) => (idx === 1 ? { ...l, posted: true, move_id: postedLine.move_id } : l));
  assert.throws(
    () => write(syncedPostedDb, 'account.asset', asset.id, { depreciation_ids: sharedOnSame }),
    /Depreciation move cannot be shared between board lines/i,
  );
  assert.throws(
    () => applyDiff(syncedPostedDb, { upserts: { 'account.asset': [{ ...syncedAsset, depreciation_ids: sharedOnSame }] } }, { author: 'test', isAdmin: false }),
    /Depreciation move cannot be shared between board lines/i,
  );

  // Forged 6: Another asset sharing the same move_id
  const open2 = createOpenAsset(syncedPostedDb, {
    acquisition_date: '2026-06-01',
    original_value: 12000,
    salvage_value: 0,
    method_number: 5,
    method_period: '12',
  });
  const asset2 = read(open2.db, 'account.asset', open2.id);
  const sharedOnOther = asset2.depreciation_ids.map((l, idx) => (idx === 0 ? { ...l, posted: true, move_id: postedLine.move_id } : l));
  assert.throws(
    () => write(open2.db, 'account.asset', open2.id, { depreciation_ids: sharedOnOther }),
    /Depreciation move cannot be shared between board lines/i,
  );
  assert.throws(
    () => applyDiff(open2.db, { upserts: { 'account.asset': [{ ...asset2, depreciation_ids: sharedOnOther }] } }, { author: 'test', isAdmin: false }),
    /Depreciation move cannot be shared between board lines/i,
  );
});

test('14. Q3: revaluation_ids prefix immutable, appended entries reference posted move on asset account, delta = sum', () => {
  let db = seed();
  const open = createOpenAsset(db, {
    acquisition_date: '2026-06-01',
    original_value: 12000,
    salvage_value: 0,
    method_number: 5,
    method_period: '12',
  });
  db = open.db;
  const asset = read(db, 'account.asset', open.id);
  const revalAccId = accountId(db, '450300');

  // Legitimate 1: modifyAsset value increase (+2400) passes applyDiff
  const modifiedInc = modifyAsset(db, asset, { date: '2026-06-15', value_change: 2400, accountId: revalAccId });
  const syncedInc = applyDiff(db, diffDb(db, modifiedInc), { author: 'test', isAdmin: false });
  const assetInc = read(syncedInc, 'account.asset', asset.id);
  assert.equal(assetInc.original_value, 14400);
  assert.equal(assetInc.revaluation_ids.length, 1);
  const rev1 = assetInc.revaluation_ids[0];
  assert.equal(rev1.amount, 2400);
  assert.ok(rev1.move_id);

  // Legitimate 2: modifyAsset impairment (-1200) passes applyDiff
  const modifiedDec = modifyAsset(syncedInc, assetInc, { date: '2026-07-01', value_change: -1200 });
  const syncedDec = applyDiff(syncedInc, diffDb(syncedInc, modifiedDec), { author: 'test', isAdmin: false });
  const assetDec = read(syncedDec, 'account.asset', asset.id);
  assert.equal(assetDec.original_value, 13200);
  assert.equal(assetDec.revaluation_ids.length, 2);

  // Legitimate 3: modifyAsset methodNumber change (no value change) passes applyDiff
  const modifiedDur = modifyAsset(syncedDec, assetDec, { date: '2026-07-15', methodNumber: 6 });
  const syncedDur = applyDiff(syncedDec, diffDb(syncedDec, modifiedDur), { author: 'test', isAdmin: false });
  const assetDur = read(syncedDur, 'account.asset', asset.id);
  assert.equal(assetDur.method_number, 6);

  // Forged 1: Modify existing revaluation entry in prefix
  const forgedModifyPrefix = assetInc.revaluation_ids.map((r, idx) => (idx === 0 ? { ...r, amount: 3000 } : r));
  assert.throws(
    () => write(syncedInc, 'account.asset', asset.id, { revaluation_ids: forgedModifyPrefix }),
    /Existing value adjustments cannot be modified/i,
  );
  assert.throws(
    () => applyDiff(syncedInc, { upserts: { 'account.asset': [{ ...assetInc, revaluation_ids: forgedModifyPrefix }] } }, { author: 'test', isAdmin: false }),
    /Existing value adjustments cannot be modified/i,
  );

  // Forged 2: Remove existing revaluation entry from prefix
  assert.throws(
    () => write(syncedInc, 'account.asset', asset.id, { revaluation_ids: [] }),
    /Existing value adjustments cannot be removed/i,
  );
  assert.throws(
    () => applyDiff(syncedInc, { upserts: { 'account.asset': [{ ...assetInc, revaluation_ids: [] }] } }, { author: 'test', isAdmin: false }),
    /Existing value adjustments cannot be removed/i,
  );

  // Forged 3: Append revaluation without valid move (e.g. null move_id)
  const forgedAppendNoMove = [...assetInc.revaluation_ids, { date: '2026-08-01', amount: 1000, move_id: null }];
  assert.throws(
    () => write(syncedInc, 'account.asset', asset.id, { revaluation_ids: forgedAppendNoMove, original_value: 15400 }),
    /Value adjustment must reference a posted move in the asset company/i,
  );
  assert.throws(
    () => applyDiff(syncedInc, { upserts: { 'account.asset': [{ ...assetInc, revaluation_ids: forgedAppendNoMove, original_value: 15400 }] } }, { author: 'test', isAdmin: false }),
    /Value adjustment must reference a posted move in the asset company/i,
  );

  // Forged 4: Append revaluation with move that does not book on account_asset_id
  const wrongMove = create(syncedInc, 'account.move', {
    name: 'MISC/2026/0003',
    move_type: 'entry',
    journal_id: assetInc.journal_id,
    company_id: assetInc.company_id,
    date: '2026-08-01',
    state: 'posted',
    line_ids: [
      { account_id: revalAccId, debit: 1000, credit: 0 },
      { account_id: assetInc.account_depreciation_expense_id, debit: 0, credit: 1000 },
    ],
  });
  const forgedAppendWrongMove = [...assetInc.revaluation_ids, { date: '2026-08-01', amount: 1000, move_id: wrongMove.id }];
  assert.throws(
    () => write(wrongMove.db, 'account.asset', asset.id, { revaluation_ids: forgedAppendWrongMove, original_value: 15400 }),
    /Value adjustment move must book the adjustment amount on the fixed asset account/i,
  );
  assert.throws(
    () => applyDiff(wrongMove.db, { upserts: { 'account.asset': [{ ...assetInc, revaluation_ids: forgedAppendWrongMove, original_value: 15400 }] } }, { author: 'test', isAdmin: false }),
    /Value adjustment move must book the adjustment amount on the fixed asset account/i,
  );

  // Forged 5: Original value delta does not match sum of appended revaluations
  assert.throws(
    () => write(syncedInc, 'account.asset', asset.id, { original_value: 15000 }),
    /inconsistent with asset values|recorded value adjustments/i,
  );
  assert.throws(
    () => applyDiff(syncedInc, { upserts: { 'account.asset': [{ ...assetInc, original_value: 15000 }] } }, { author: 'test', isAdmin: false }),
    /inconsistent with asset values|recorded value adjustments/i,
  );
});

test('15. Q4: Disposal field rules, disposal_move_id verification, sale invoice verification, legacy assets', () => {
  let db = seed();
  const open = createOpenAsset(db, {
    acquisition_date: '2026-06-01',
    original_value: 12000,
    salvage_value: 0,
    method_number: 5,
    method_period: '12',
  });
  db = open.db;
  const asset = read(db, 'account.asset', open.id);

  // Legitimate 1: disposeAsset without sale invoice passes applyDiff
  const disposedNoInv = disposeAsset(db, asset, { date: '2026-06-01' });
  const syncedDisposedNoInv = applyDiff(db, diffDb(db, disposedNoInv), { author: 'test', isAdmin: false });
  const assetNoInv = read(syncedDisposedNoInv, 'account.asset', asset.id);
  assert.equal(assetNoInv.state, 'close');
  assert.equal(assetNoInv.disposal_date, '2026-06-01');
  assert.ok(assetNoInv.disposal_move_id);

  // Legitimate 2: disposeAsset with sale invoice passes applyDiff
  const open2 = createOpenAsset(db, {
    name: 'Asset With Sale Invoice',
    acquisition_date: '2026-06-01',
    original_value: 10000,
    salvage_value: 0,
    method_number: 5,
    method_period: '12',
  });
  let db2 = open2.db;
  const invoice = create(db2, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-06-15',
    invoice_line_ids: [{ qty: 1, price_unit: 7000, tax: 0, account_id: accountId(db2, '101401') }],
  });
  db2 = postMove(invoice.db, invoice.id);
  const disposedWithInv = disposeAsset(db2, read(db2, 'account.asset', open2.id), {
    date: '2026-06-15',
    saleValue: 7000,
    invoiceId: invoice.id,
  });
  const syncedDisposedWithInv = applyDiff(db2, diffDb(db2, disposedWithInv), { author: 'test', isAdmin: false });
  const assetWithInv = read(syncedDisposedWithInv, 'account.asset', open2.id);
  assert.equal(assetWithInv.state, 'close');
  assert.equal(assetWithInv.sale_value, 7000);
  assert.equal(assetWithInv.sale_invoice_id, invoice.id);
  assert.ok(assetWithInv.disposal_move_id);

  // Legitimate 3: disposeAsset of asset where last line is posted during disposal passes applyDiff
  const open3 = createOpenAsset(db, {
    name: 'Asset Final Line Disposal',
    acquisition_date: '2026-06-01',
    original_value: 12000,
    salvage_value: 0,
    method_number: 1,
    method_period: '12',
  });
  let db3 = open3.db;
  const disposedFinal = disposeAsset(db3, read(db3, 'account.asset', open3.id), { date: '2026-12-31' });
  const syncedDisposedFinal = applyDiff(db3, diffDb(db3, disposedFinal), { author: 'test', isAdmin: false });
  const assetFinal = read(syncedDisposedFinal, 'account.asset', open3.id);
  assert.equal(assetFinal.state, 'close');
  assert.equal(assetFinal.depreciation_ids.filter((l) => l.posted).length, 1);
  assert.ok(assetFinal.disposal_move_id);

  // Legitimate 4: disposeAsset of asset already closed by depreciation passes applyDiff
  const open4 = createOpenAsset(db, {
    name: 'Asset Already Closed By Dep',
    acquisition_date: '2026-06-01',
    original_value: 12000,
    salvage_value: 0,
    method_number: 1,
    method_period: '12',
  });
  let db4 = postDepreciation(open4.db, read(open4.db, 'account.asset', open4.id), '2026-12-31');
  const fullyDeprecAsset = read(db4, 'account.asset', open4.id);
  assert.equal(fullyDeprecAsset.state, 'close');
  assert.equal(fullyDeprecAsset.disposal_date, undefined);
  const disposedClosed = disposeAsset(db4, fullyDeprecAsset, { date: '2027-01-15' });
  const syncedDisposedClosed = applyDiff(db4, diffDb(db4, disposedClosed), { author: 'test', isAdmin: false });
  const assetClosedAndDisposed = read(syncedDisposedClosed, 'account.asset', open4.id);
  assert.equal(assetClosedAndDisposed.state, 'close');
  assert.equal(assetClosedAndDisposed.disposal_date, '2027-01-15');
  assert.ok(assetClosedAndDisposed.disposal_move_id);

  // Legitimate 5: Legacy closed asset with disposal_date but no disposal_move_id stays writable for unrelated fields
  const legacyClosed = {
    ...asset,
    id: 88888,
    name: 'Legacy Closed Machine',
    state: 'close',
    disposal_date: '2025-01-01',
    sale_value: 0,
    disposal_move_id: null,
  };
  let legacyDb = {
    ...db,
    records: {
      ...db.records,
      'account.asset': [...(db.records['account.asset'] ?? []), legacyClosed],
    },
  };
  const renamedLegacy = write(legacyDb, 'account.asset', legacyClosed.id, { name: 'Renamed Legacy Machine' });
  assert.equal(read(renamedLegacy, 'account.asset', legacyClosed.id).name, 'Renamed Legacy Machine');
  const syncedLegacy = applyDiff(legacyDb, { upserts: { 'account.asset': [{ ...legacyClosed, name: 'Renamed Legacy Machine' }] } }, { author: 'admin', isAdmin: true });
  assert.equal(read(syncedLegacy, 'account.asset', legacyClosed.id).name, 'Renamed Legacy Machine');

  // But legacy closed asset cannot alter disposal fields once set
  assert.throws(
    () => write(legacyDb, 'account.asset', legacyClosed.id, { disposal_date: '2025-02-01' }),
    /Disposal fields cannot be modified once set/i,
  );
  assert.throws(
    () => applyDiff(legacyDb, { upserts: { 'account.asset': [{ ...legacyClosed, disposal_date: '2025-02-01' }] } }, { author: 'admin', isAdmin: true }),
    /Disposal fields cannot be modified once set/i,
  );

  // Forged 1: Setting disposal fields without disposal_move_id
  assert.throws(
    () => write(db, 'account.asset', asset.id, { state: 'close', disposal_date: '2026-06-01', sale_value: 0 }),
    /Disposal move is required when disposing of an asset/i,
  );
  assert.throws(
    () => applyDiff(db, { upserts: { 'account.asset': [{ ...asset, state: 'close', disposal_date: '2026-06-01', sale_value: 0 }] } }, { author: 'test', isAdmin: false }),
    /Disposal move is required when disposing of an asset/i,
  );

  // Forged 2: disposal_move_id referencing draft move or move of another company
  const comp2 = create(db, 'res.company', { name: 'Comp 2', currency_id: 1 });
  const draftDispMove = create(comp2.db, 'account.move', {
    move_type: 'entry',
    journal_id: asset.journal_id,
    company_id: asset.company_id,
    date: '2026-06-01',
    line_ids: [{ account_id: asset.account_asset_id, debit: 0, credit: asset.original_value }],
  });
  assert.throws(
    () => write(draftDispMove.db, 'account.asset', asset.id, { state: 'close', disposal_date: '2026-06-01', sale_value: 0, disposal_move_id: draftDispMove.id }),
    /Disposal move must be a posted entry in the asset company/i,
  );
  assert.throws(
    () => applyDiff(draftDispMove.db, { upserts: { 'account.asset': [{ ...asset, state: 'close', disposal_date: '2026-06-01', sale_value: 0, disposal_move_id: draftDispMove.id }] } }, { author: 'test', isAdmin: false }),
    /Disposal move must be a posted entry in the asset company/i,
  );

  // Forged 3: disposal_move_id does not credit account_asset_id by original_value
  const wrongDispMove = create(db, 'account.move', {
    name: 'MISC/2026/0005',
    move_type: 'entry',
    journal_id: asset.journal_id,
    company_id: asset.company_id,
    date: '2026-06-01',
    state: 'posted',
    line_ids: [
      { account_id: asset.account_asset_id, debit: 0, credit: 5000 },
      { account_id: asset.account_depreciation_expense_id, debit: 5000, credit: 0 },
    ],
  });
  assert.throws(
    () => write(wrongDispMove.db, 'account.asset', asset.id, { state: 'close', disposal_date: '2026-06-01', sale_value: 0, disposal_move_id: wrongDispMove.id }),
    /Disposal move must credit the fixed asset account by the asset original value/i,
  );
  assert.throws(
    () => applyDiff(wrongDispMove.db, { upserts: { 'account.asset': [{ ...asset, state: 'close', disposal_date: '2026-06-01', sale_value: 0, disposal_move_id: wrongDispMove.id }] } }, { author: 'test', isAdmin: false }),
    /Disposal move must credit the fixed asset account by the asset original value/i,
  );

  // Forged 4: sale_invoice_id referencing an unposted move or non-out_invoice
  const postedDispMove = create(db, 'account.move', {
    name: 'MISC/2026/0006',
    move_type: 'entry',
    journal_id: asset.journal_id,
    company_id: asset.company_id,
    date: '2026-06-01',
    state: 'posted',
    line_ids: [
      { account_id: asset.account_asset_id, debit: 0, credit: asset.original_value },
      { account_id: asset.account_depreciation_expense_id, debit: asset.original_value, credit: 0 },
    ],
  });
  const draftInvoice = create(postedDispMove.db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-06-01',
    invoice_line_ids: [{ qty: 1, price_unit: 5000, tax: 0, account_id: accountId(postedDispMove.db, '101401') }],
  });
  assert.throws(
    () => write(draftInvoice.db, 'account.asset', asset.id, {
      state: 'close',
      disposal_date: '2026-06-01',
      sale_value: 5000,
      disposal_move_id: postedDispMove.id,
      sale_invoice_id: draftInvoice.id,
    }),
    /Sale invoice must be a posted customer invoice in the asset company/i,
  );
  assert.throws(
    () => applyDiff(draftInvoice.db, {
      upserts: {
        'account.asset': [{
          ...asset,
          state: 'close',
          disposal_date: '2026-06-01',
          sale_value: 5000,
          disposal_move_id: postedDispMove.id,
          sale_invoice_id: draftInvoice.id,
        }],
      },
    }, { author: 'test', isAdmin: false }),
    /Sale invoice must be a posted customer invoice in the asset company/i,
  );

  // Forged 5: Modifying disposal fields once set
  assert.throws(
    () => write(syncedDisposedNoInv, 'account.asset', assetNoInv.id, { disposal_date: '2026-07-01' }),
    /Disposal fields cannot be modified once set/i,
  );
  assert.throws(
    () => applyDiff(syncedDisposedNoInv, { upserts: { 'account.asset': [{ ...assetNoInv, disposal_date: '2026-07-01' }] } }, { author: 'test', isAdmin: false }),
    /Disposal fields cannot be modified once set/i,
  );
  assert.throws(
    () => write(syncedDisposedNoInv, 'account.asset', assetNoInv.id, { sale_value: 1000 }),
    /Disposal fields cannot be modified once set/i,
  );
  assert.throws(
    () => applyDiff(syncedDisposedNoInv, { upserts: { 'account.asset': [{ ...assetNoInv, sale_value: 1000 }] } }, { author: 'test', isAdmin: false }),
    /Disposal fields cannot be modified once set/i,
  );

  // Forged 6: A second asset with same account and value closed with first asset's disposal_move_id
  const openDup = createOpenAsset(syncedDisposedNoInv, {
    name: 'Duplicate Disposed Asset',
    acquisition_date: '2026-06-01',
    original_value: 12000,
    salvage_value: 0,
    method_number: 5,
    method_period: '12',
  });
  const assetDup = read(openDup.db, 'account.asset', openDup.id);
  assert.throws(
    () => write(openDup.db, 'account.asset', assetDup.id, {
      state: 'close',
      disposal_date: '2026-06-01',
      sale_value: 0,
      disposal_move_id: assetNoInv.disposal_move_id,
    }),
    /Disposal move cannot be shared with another asset/i,
  );
  assert.throws(
    () => applyDiff(openDup.db, {
      upserts: {
        'account.asset': [{
          ...assetDup,
          state: 'close',
          disposal_date: '2026-06-01',
          sale_value: 0,
          disposal_move_id: assetNoInv.disposal_move_id,
        }],
      },
    }, { author: 'test', isAdmin: false }),
    /Disposal move cannot be shared with another asset/i,
  );

  // Forged 7-9: Sale invoice relationship checks on an open asset
  const openInvTest = createOpenAsset(db2, {
    name: 'Asset For Invoice Tests',
    acquisition_date: '2026-06-01',
    original_value: 10000,
    salvage_value: 0,
    method_number: 5,
    method_period: '12',
  });
  let dbInvTest = openInvTest.db;
  const assetInvTest = read(dbInvTest, 'account.asset', openInvTest.id);
  const validDispMove = create(dbInvTest, 'account.move', {
    name: 'MISC/2026/0010',
    move_type: 'entry',
    journal_id: assetInvTest.journal_id,
    company_id: assetInvTest.company_id,
    date: '2026-06-15',
    state: 'posted',
    line_ids: [
      { account_id: assetInvTest.account_asset_id, debit: 0, credit: 10000 },
      { account_id: accountId(dbInvTest, '101401'), debit: 7000, credit: 0 },
      { account_id: accountId(dbInvTest, '450300'), debit: 3000, credit: 0 },
    ],
  });
  dbInvTest = validDispMove.db;

  // Forged 7: Sale invoice with wrong line index
  assert.throws(
    () => write(dbInvTest, 'account.asset', assetInvTest.id, {
      state: 'close',
      disposal_date: '2026-06-15',
      sale_value: 7000,
      disposal_move_id: validDispMove.id,
      sale_invoice_id: invoice.id,
      sale_invoice_line: 99,
    }),
    /Sale invoice line not found/i,
  );
  assert.throws(
    () => applyDiff(dbInvTest, {
      upserts: {
        'account.asset': [{
          ...assetInvTest,
          state: 'close',
          disposal_date: '2026-06-15',
          sale_value: 7000,
          disposal_move_id: validDispMove.id,
          sale_invoice_id: invoice.id,
          sale_invoice_line: 99,
        }],
      },
    }, { author: 'test', isAdmin: false }),
    /Sale invoice line not found/i,
  );

  // Forged 8: Sale invoice with mismatched sale_value
  assert.throws(
    () => write(dbInvTest, 'account.asset', assetInvTest.id, {
      state: 'close',
      disposal_date: '2026-06-15',
      sale_value: 5000,
      disposal_move_id: validDispMove.id,
      sale_invoice_id: invoice.id,
      sale_invoice_line: 0,
    }),
    /Sale price must match the invoice line amount/i,
  );
  assert.throws(
    () => applyDiff(dbInvTest, {
      upserts: {
        'account.asset': [{
          ...assetInvTest,
          state: 'close',
          disposal_date: '2026-06-15',
          sale_value: 5000,
          disposal_move_id: validDispMove.id,
          sale_invoice_id: invoice.id,
          sale_invoice_line: 0,
        }],
      },
    }, { author: 'test', isAdmin: false }),
    /Sale price must match the invoice line amount/i,
  );

  // Forged 9: Disposal move does not book sale on sale invoice line account (unrelated posted invoice)
  const unrelatedMove = create(dbInvTest, 'account.move', {
    name: 'MISC/2026/0007',
    move_type: 'entry',
    journal_id: assetInvTest.journal_id,
    company_id: assetInvTest.company_id,
    date: '2026-06-15',
    state: 'posted',
    line_ids: [
      { account_id: assetInvTest.account_asset_id, debit: 0, credit: assetInvTest.original_value },
      { account_id: assetInvTest.account_depreciation_expense_id, debit: assetInvTest.original_value, credit: 0 },
    ],
  });
  assert.throws(
    () => write(unrelatedMove.db, 'account.asset', assetInvTest.id, {
      state: 'close',
      disposal_date: '2026-06-15',
      sale_value: 7000,
      disposal_move_id: unrelatedMove.id,
      sale_invoice_id: invoice.id,
      sale_invoice_line: 0,
    }),
    /Disposal move must book the sale on the sale invoice line account/i,
  );
  assert.throws(
    () => applyDiff(unrelatedMove.db, {
      upserts: {
        'account.asset': [{
          ...assetInvTest,
          state: 'close',
          disposal_date: '2026-06-15',
          sale_value: 7000,
          disposal_move_id: unrelatedMove.id,
          sale_invoice_id: invoice.id,
          sale_invoice_line: 0,
        }],
      },
    }, { author: 'test', isAdmin: false }),
    /Disposal move must book the sale on the sale invoice line account/i,
  );

  // Forged 10: sale_invoice_line provided without sale_invoice_id
  assert.throws(
    () => write(postedDispMove.db, 'account.asset', asset.id, {
      state: 'close',
      disposal_date: '2026-06-01',
      sale_value: 0,
      disposal_move_id: postedDispMove.id,
      sale_invoice_line: 0,
    }),
    /Sale invoice line must be empty without a sale invoice/i,
  );
  assert.throws(
    () => applyDiff(postedDispMove.db, {
      upserts: {
        'account.asset': [{
          ...asset,
          state: 'close',
          disposal_date: '2026-06-01',
          sale_value: 0,
          disposal_move_id: postedDispMove.id,
          sale_invoice_line: 0,
        }],
      },
    }, { author: 'test', isAdmin: false }),
    /Sale invoice line must be empty without a sale invoice/i,
  );

  // Forged 11: Modifying sale_invoice_line after disposal is rejected
  assert.throws(
    () => write(syncedDisposedWithInv, 'account.asset', assetWithInv.id, { sale_invoice_line: 1 }),
    /Disposal fields cannot be modified once set/i,
  );
  assert.throws(
    () => applyDiff(syncedDisposedWithInv, {
      upserts: {
        'account.asset': [{ ...assetWithInv, sale_invoice_line: 1 }],
      },
    }, { author: 'test', isAdmin: false }),
    /Disposal fields cannot be modified once set/i,
  );

  // Legacy closed asset cannot modify sale_invoice_line
  assert.throws(
    () => write(legacyDb, 'account.asset', legacyClosed.id, { sale_invoice_line: 0 }),
    /Disposal fields cannot be modified once set/i,
  );
  assert.throws(
    () => applyDiff(legacyDb, {
      upserts: {
        'account.asset': [{ ...legacyClosed, sale_invoice_line: 0 }],
      },
    }, { author: 'admin', isAdmin: true }),
    /Disposal fields cannot be modified once set/i,
  );
});
