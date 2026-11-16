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
    /inconsistent with asset values/i,
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
    /inconsistent with asset values/i,
  );
  assert.throws(
    () => applyDiff(db, { upserts: { 'account.asset': [{ ...asset, original_value: 5000 }] } }, { author: 'test', isAdmin: false }),
    /inconsistent with asset values/i,
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
