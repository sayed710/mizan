import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { seed } from './seed.js';
import { models } from './models/index.js';
import { create, read, search, write, matches, applyFilters } from './orm.js';
import { newDefaults } from './views/formDefaults.js';
import { diffDb, applyDiff } from './sync.js';
import { migrate, SCHEMA_VERSION } from './migrations.js';
import { autoReconcile, ruleMatches } from './models/reconcile.js';
import { postMove } from './models/accounting.js';
import { createCompany } from './models/company.js';
import { invoiceJournalDefaults } from './test-support/accounting-company.js';
import { assetAccounts } from './test-support/asset-accounts.js';

test('CFG-1: Reconciliation models require company_id and default to current company', () => {
  const modelDef = models['account.reconcile.model'];
  assert.equal(modelDef.fields.company_id.required, true, 'company_id must be required on account.reconcile.model');

  let db = seed();
  db = { ...db, settings: { ...db.settings, current_company_id: 1 } };

  // Form default sets company_id to current company
  const formVals = newDefaults(db, 'account.reconcile.model', { defaults: {} }, new URLSearchParams());
  assert.equal(formVals.company_id, 1, 'form default should set company_id to current company');

  // Direct create defaults company_id to current company
  const res1 = create(db, 'account.reconcile.model', { name: 'Auto Invoices', trigger: 'manual' });
  db = res1.db;
  const created1 = read(db, 'account.reconcile.model', res1.id);
  assert.equal(created1.company_id, 1, 'new reconcile model defaults to company 1');

  // Change current company and verify new default picks it up
  const db2 = { ...db, settings: { ...db.settings, current_company_id: 2 } };
  const res2 = create(db2, 'account.reconcile.model', { name: 'Company 2 Reconcile' });
  const created2 = read(res2.db, 'account.reconcile.model', res2.id);
  assert.equal(created2.company_id, 2, 'new reconcile model defaults to company 2 when active');

  // Guard / validation check: company_id is required through diffDb + applyDiff
  const forged = {
    ...db,
    records: {
      ...db.records,
      'account.reconcile.model': [
        ...(db.records['account.reconcile.model'] ?? []),
        { id: (db.seq['account.reconcile.model'] ?? 0) + 1, name: 'Missing Company', company_id: null, active: true },
      ],
    },
  };
  assert.throws(
    () => applyDiff(db, diffDb(db, forged), { isAdmin: true }),
    /Company is required/,
    'Saving account.reconcile.model without company_id must fail diff validation',
  );
});

test('CFG-2: Depreciation models require company_id with current company default, and expose HTML/text Notes field on form', () => {
  const modelDef = models['account.asset.model'];
  assert.equal(modelDef.fields.company_id.required, true, 'company_id must be required on account.asset.model');

  // Notes field exists and is html/text
  assert.ok(modelDef.fields.notes, 'account.asset.model must declare notes field');
  assert.equal(modelDef.fields.notes.label, 'Notes');
  assert.ok(['html', 'text'].includes(modelDef.fields.notes.type), 'notes field should be html or text');

  // Form includes notes field (e.g. in tabs like Odoo's asset form)
  const tabFields = (modelDef.form.tabs ?? []).flatMap((t) => t.fields ?? []);
  const groupFields = (modelDef.form.groups ?? []).flatMap((g) => (Array.isArray(g) ? g : g.fields ?? []));
  assert.ok(
    tabFields.includes('notes') || groupFields.includes('notes'),
    'notes field must be shown on the account.asset.model form (in tabs or groups)',
  );

  let db = seed();
  db = { ...db, settings: { ...db.settings, current_company_id: 1 } };

  // Form default sets company_id to current company
  const formVals = newDefaults(db, 'account.asset.model', { defaults: {} }, new URLSearchParams());
  assert.equal(formVals.company_id, 1, 'form default should set company_id to current company');

  // Direct create defaults company_id to current company and saves notes
  const res1 = create(db, 'account.asset.model', {
    name: 'Hardware 3Y',
    method: 'linear',
    method_number: 3,
    method_period: '12',
    notes: '<p>Laptops and desktop computers</p>',
  });
  db = res1.db;
  const created1 = read(db, 'account.asset.model', res1.id);
  assert.equal(created1.company_id, 1, 'new asset model defaults to company 1');
  assert.equal(created1.notes, '<p>Laptops and desktop computers</p>', 'notes field is persisted');

  // Change current company and verify new default picks it up
  const db2 = { ...db, settings: { ...db.settings, current_company_id: 2 } };
  const res2 = create(db2, 'account.asset.model', {
    name: 'Software 5Y',
    method: 'linear',
    method_number: 5,
    method_period: '12',
  });
  const created2 = read(res2.db, 'account.asset.model', res2.id);
  assert.equal(created2.company_id, 2, 'new asset model defaults to company 2');

  // Guard / validation check: company_id is required through diffDb + applyDiff
  const forged = {
    ...db,
    records: {
      ...db.records,
      'account.asset.model': [
        ...(db.records['account.asset.model'] ?? []),
        { id: (db.seq['account.asset.model'] ?? 0) + 1, name: 'No Company Asset Model', company_id: null, method: 'linear', method_number: 5, method_period: '12' },
      ],
    },
  };
  assert.throws(
    () => applyDiff(db, diffDb(db, forged), { isAdmin: true }),
    /Company is required/,
    'Saving account.asset.model without company_id must fail diff validation',
  );
});

test('CFG-3: Incoterms name search matches the code as well as the name', () => {
  const modelDef = models['account.incoterm'];
  assert.ok(modelDef.searchFields.includes('code'), 'searchFields must include code');
  assert.ok(modelDef.searchFields.includes('name'), 'searchFields must include name');

  let db = seed();
  const res = create(db, 'account.incoterm', { code: 'DAP', name: 'Delivered at Place' });
  db = res.db;
  const incoterm = read(db, 'account.incoterm', res.id);

  // List search matches code
  assert.equal(matches(db, 'account.incoterm', incoterm, ['DAP']), true, 'matches code DAP');
  assert.equal(matches(db, 'account.incoterm', incoterm, ['dap']), true, 'matches code case-insensitively');

  // List search matches name
  assert.equal(matches(db, 'account.incoterm', incoterm, ['Delivered']), true, 'matches name Delivered');
  assert.equal(matches(db, 'account.incoterm', incoterm, ['Place']), true, 'matches name Place');

  // Does not match unrelated term
  assert.equal(matches(db, 'account.incoterm', incoterm, ['FOB']), false, 'does not match FOB');
});

test('CFG-4: Account Tags list search has Archived filter and rejects duplicates on name, applicability and country', () => {
  const modelDef = models['account.account.tag'];

  // Archived filter in list search
  const allFilters = (modelDef.filters ?? []).flat();
  const archivedFilter = allFilters.find((f) => f.label === 'Archived' || f.id === 'archived');
  assert.ok(archivedFilter, 'Archived filter must exist in account.account.tag filters');
  assert.equal(archivedFilter.includeArchived, true, 'Archived filter must specify includeArchived: true');
  assert.equal(archivedFilter.fn({ active: false }), true, 'Archived filter matches inactive tags');
  assert.equal(archivedFilter.fn({ active: true }), false, 'Archived filter excludes active tags');

  let db = seed();
  const tActive = create(db, 'account.account.tag', { name: 'Tag Active', applicability: 'accounts', active: true });
  db = tActive.db;
  const tArchived = create(db, 'account.account.tag', { name: 'Tag Archived', applicability: 'accounts', active: false });
  db = tArchived.db;

  const filtered = applyFilters(
    'account.account.tag',
    [read(db, 'account.account.tag', tActive.id), read(db, 'account.account.tag', tArchived.id)],
    [archivedFilter.id],
    db,
    modelDef.filters,
  );
  assert.deepEqual(filtered.map((t) => t.id), [tArchived.id], 'applying Archived filter yields only inactive tags');

  // Duplicate guard: saving a tag whose name, applicability and country equal an existing tag's is rejected
  const t1 = create(db, 'account.account.tag', { name: 'Operating Tax', applicability: 'taxes', country: 'SA' });
  db = t1.db;

  // Direct create rejects duplicate
  assert.throws(
    () => create(db, 'account.account.tag', { name: 'Operating Tax', applicability: 'taxes', country: 'SA' }),
    /A tag with the same name and applicability already exists in this country\./,
    'Duplicate tag create must be rejected with Odoo message',
  );

  // Different country is allowed
  const tDiffCountry = create(db, 'account.account.tag', { name: 'Operating Tax', applicability: 'taxes', country: 'AE' });
  assert.ok(tDiffCountry.id, 'Same name and applicability in different country is allowed');

  // Different applicability is allowed
  const tDiffApp = create(db, 'account.account.tag', { name: 'Operating Tax', applicability: 'accounts', country: 'SA' });
  assert.ok(tDiffApp.id, 'Same name in same country with different applicability is allowed');

  // Guard tested through diffDb + applyDiff
  const forged = {
    ...db,
    records: {
      ...db.records,
      'account.account.tag': [
        ...(db.records['account.account.tag'] ?? []),
        { id: (db.seq['account.account.tag'] ?? 0) + 1, name: 'Operating Tax', applicability: 'taxes', country: 'SA', active: true },
      ],
    },
  };
  assert.throws(
    () => applyDiff(db, diffDb(db, forged), { isAdmin: true }),
    /A tag with the same name and applicability already exists in this country\./,
    'Saving duplicate tag through diffDb + applyDiff must be rejected',
  );
});

test('Finding 1 regression: upgrade assigns company 1 to company-less reconcile models, scopes matching, and allows edits/archiving', () => {
  let db = seed();
  const c2 = createCompany(db, { name: 'Branch 2', ...invoiceJournalDefaults(db) });
  db = c2.db;
  const bankAccC2 = create(db, 'account.account', { code: '101491', name: 'Bank C2', account_type: 'asset_cash', company_id: c2.id });
  const suspAccC2 = create(bankAccC2.db, 'account.account', { code: '101492', name: 'Suspense C2', account_type: 'asset_current', company_id: c2.id });
  const jC2 = create(suspAccC2.db, 'account.journal', {
    name: 'Bank C2',
    code: 'BNK2',
    type: 'bank',
    company_id: c2.id,
    default_account_id: bankAccC2.id,
    suspense_account_id: suspAccC2.id,
  });
  db = jC2.db;

  const jC1 = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  const feeAcc = search(db, 'account.account').find((a) => a.code === '600000').id;

  const legacyRule = {
    id: 9501,
    name: 'Legacy Global Fee',
    company_id: null,
    sequence: 10,
    trigger: 'auto_reconcile',
    rule_type: 'reco_model',
    match_label: 'contains',
    match_label_param: 'FEE',
    active: true,
    line_ids: [{ sequence: 10, account_id: feeAcc, amount_type: 'percentage', amount_string: '100', amount: 100 }],
  };

  const legacyDb = {
    ...db,
    schema_version: 68,
    records: {
      ...db.records,
      'account.reconcile.model': [...(db.records['account.reconcile.model'] ?? []), legacyRule],
    },
  };

  // Before migration, writing or archiving a company-less rule is rejected
  assert.throws(() => write(legacyDb, 'account.reconcile.model', legacyRule.id, { active: false }), /Company is required/);

  // Upgrade assigns company_id: 1
  const upgraded = migrate(legacyDb);
  assert.equal(upgraded.schema_version, SCHEMA_VERSION);
  const migratedRule = read(upgraded, 'account.reconcile.model', legacyRule.id);
  assert.equal(migratedRule.company_id, 1);

  // Matching is now scoped to company 1, not company 2
  const l1 = create(upgraded, 'account.bank.statement.line', {
    journal_id: jC1.id, company_id: 1, date: '2026-06-01', state: 'to_check', payment_ref: 'FEE C1', amount: -25,
  });
  const l2 = create(l1.db, 'account.bank.statement.line', {
    journal_id: jC2.id, company_id: c2.id, date: '2026-06-01', state: 'to_check', payment_ref: 'FEE C2', amount: -25,
  });
  assert.equal(ruleMatches(migratedRule, read(l2.db, 'account.bank.statement.line', l1.id)), true);
  assert.equal(ruleMatches(migratedRule, read(l2.db, 'account.bank.statement.line', l2.id)), false);

  const afterAuto = autoReconcile(l2.db);
  assert.equal(read(afterAuto, 'account.bank.statement.line', l1.id).state, 'reconciled');
  assert.equal(read(afterAuto, 'account.bank.statement.line', l2.id).state, 'to_check');

  // Ordinary edits, sequence updates, and archiving succeed after upgrade
  let edited = write(afterAuto, 'account.reconcile.model', legacyRule.id, { name: 'Renamed Fee', sequence: 25 });
  assert.equal(read(edited, 'account.reconcile.model', legacyRule.id).name, 'Renamed Fee');
  assert.equal(read(edited, 'account.reconcile.model', legacyRule.id).sequence, 25);
  edited = write(edited, 'account.reconcile.model', legacyRule.id, { active: false });
  assert.equal(read(edited, 'account.reconcile.model', legacyRule.id).active, false);

  // Idempotent
  assert.strictEqual(migrate(upgraded), upgraded);
});

test('Finding 2 regression: legacy duplicate tags can be archived and edited without altering key fields, while new collisions are blocked', () => {
  const base = seed();
  const dup1 = { id: 9601, name: 'Legacy Dup', applicability: 'taxes', country: 'SA', active: true, color: 1, balance_negate: false };
  const dup2 = { id: 9602, name: 'Legacy Dup', applicability: 'taxes', country: 'SA', active: true, color: 2, balance_negate: false };
  const dbWithDups = {
    ...base,
    records: {
      ...base.records,
      'account.account.tag': [...(base.records['account.account.tag'] ?? []), dup1, dup2],
    },
    seq: { ...base.seq, 'account.account.tag': Math.max(base.seq['account.account.tag'] ?? 0, 9602) },
  };

  // Archiving and editing unrelated fields on an existing duplicate succeed
  let db = write(dbWithDups, 'account.account.tag', dup1.id, { active: false });
  assert.equal(read(db, 'account.account.tag', dup1.id).active, false);
  db = write(db, 'account.account.tag', dup1.id, { color: 7, active: true });
  assert.equal(read(db, 'account.account.tag', dup1.id).color, 7);

  // Changing identifying fields of another tag into a collision still fails
  const other = create(db, 'account.account.tag', { name: 'Unique Tag', applicability: 'taxes', country: 'SA' });
  assert.throws(
    () => write(other.db, 'account.account.tag', other.id, { name: 'Legacy Dup' }),
    /A tag with the same name and applicability already exists in this country\./,
  );
});

test('Finding 3 regression: asset model selector and asset validation enforce asset company even with shared accounts', () => {
  let db = seed();
  const c2 = createCompany(db, { name: 'Branch 2', ...invoiceJournalDefaults(db) });
  db = c2.db;

  // Shared accounts (company_id: null)
  const sharedAssetAcc = create(db, 'account.account', { code: '151900', name: 'Shared Fixed Asset', account_type: 'asset_fixed', company_id: null });
  const sharedDepAcc = create(sharedAssetAcc.db, 'account.account', { code: '152900', name: 'Shared Dep', account_type: 'asset_fixed', company_id: null });
  const sharedExpAcc = create(sharedDepAcc.db, 'account.account', { code: '680900', name: 'Shared Dep Exp', account_type: 'expense', company_id: null });
  db = sharedExpAcc.db;

  const modelC1 = create(db, 'account.asset.model', {
    name: 'Model C1',
    company_id: 1,
    method: 'linear',
    method_number: 5,
    method_period: '12',
    account_asset_id: sharedAssetAcc.id,
    account_depreciation_id: sharedDepAcc.id,
    account_depreciation_expense_id: sharedExpAcc.id,
  });
  const modelC2 = create(modelC1.db, 'account.asset.model', {
    name: 'Model C2',
    company_id: c2.id,
    method: 'linear',
    method_number: 5,
    method_period: '12',
    account_asset_id: sharedAssetAcc.id,
    account_depreciation_id: sharedDepAcc.id,
    account_depreciation_expense_id: sharedExpAcc.id,
  });
  db = modelC2.db;

  // Selector domain restricts models to the asset's company
  const modelFieldDomain = models['account.asset'].fields.model_id.domain;
  assert.equal(modelFieldDomain(read(db, 'account.asset.model', modelC1.id), { company_id: 1 }), true);
  assert.equal(modelFieldDomain(read(db, 'account.asset.model', modelC2.id), { company_id: 1 }), false);
  assert.equal(modelFieldDomain(read(db, 'account.asset.model', modelC2.id), { company_id: c2.id }), true);

  // Direct create with foreign model whose accounts are shared is rejected
  assert.throws(
    () => create(db, 'account.asset', {
      name: 'Foreign Model Asset',
      company_id: 1,
      model_id: modelC2.id,
      original_value: 1000,
      account_asset_id: sharedAssetAcc.id,
      account_depreciation_id: sharedDepAcc.id,
      account_depreciation_expense_id: sharedExpAcc.id,
    }),
    /Depreciation model must belong to the asset company/,
  );

  // Direct write and sync diff assigning foreign model or changing company are rejected
  const draftAsset = create(db, 'account.asset', {
    name: 'Company 1 Asset',
    company_id: 1,
    model_id: modelC1.id,
    original_value: 1000,
  });
  assert.throws(
    () => write(draftAsset.db, 'account.asset', draftAsset.id, { model_id: modelC2.id }),
    /Depreciation model must belong to the asset company/,
  );
  assert.throws(
    () => write(draftAsset.db, 'account.asset', draftAsset.id, { company_id: c2.id }),
    /Depreciation model must belong to the asset company/,
  );
  const forged = {
    ...draftAsset.db,
    records: {
      ...draftAsset.db.records,
      'account.asset': draftAsset.db.records['account.asset'].map((a) => (a.id === draftAsset.id ? { ...a, model_id: modelC2.id } : a)),
    },
  };
  assert.throws(
    () => applyDiff(draftAsset.db, diffDb(draftAsset.db, forged), { isAdmin: true }),
    /Depreciation model must belong to the asset company/,
  );
});

test('Finding 4 regression: upgrade assigns company 1 to company-less depreciation models so they can be edited and archived', () => {
  const base = seed();
  const accounts = assetAccounts(base, 1);
  const legacyModel = {
    id: 9701,
    name: 'Legacy Asset Model',
    company_id: null,
    method: 'linear',
    method_mode: 'duration',
    method_number: 5,
    method_rate: 0.2,
    method_period: '12',
    method_progress_factor: 0.3,
    prorata: false,
    ...accounts,
  };
  const legacyDb = {
    ...base,
    schema_version: 68,
    records: {
      ...base.records,
      'account.asset.model': [...(base.records['account.asset.model'] ?? []), legacyModel],
    },
  };

  // Before migration, editing or archiving fails
  assert.throws(() => write(legacyDb, 'account.asset.model', legacyModel.id, { name: 'Edited' }), /Company is required/);
  assert.throws(() => write(legacyDb, 'account.asset.model', legacyModel.id, { active: false }), /Company is required/);

  // Upgrade assigns company_id: 1
  const upgraded = migrate(legacyDb);
  assert.equal(upgraded.schema_version, SCHEMA_VERSION);
  assert.equal(read(upgraded, 'account.asset.model', legacyModel.id).company_id, 1);

  // Editing accounts, method, notes, name, and archiving all succeed
  let edited = write(upgraded, 'account.asset.model', legacyModel.id, {
    name: 'Updated Legacy Model',
    method_number: 4,
    notes: '<p>Updated</p>',
  });
  assert.equal(read(edited, 'account.asset.model', legacyModel.id).name, 'Updated Legacy Model');
  assert.equal(read(edited, 'account.asset.model', legacyModel.id).method_number, 4);
  assert.equal(read(edited, 'account.asset.model', legacyModel.id).notes, '<p>Updated</p>');

  edited = write(edited, 'account.asset.model', legacyModel.id, { active: false });
  assert.equal(read(edited, 'account.asset.model', legacyModel.id).active, false);

  assert.strictEqual(migrate(upgraded), upgraded);
});

test('Finding 5 regression: shared accounts treat missing company as company 1 and validate model ownership on bills across companies', () => {
  let db = seed();
  const c2 = createCompany(db, { name: 'Branch 2', ...invoiceJournalDefaults(db) });
  db = c2.db;

  const sharedAssetAcc = create(db, 'account.account', { code: '151950', name: 'Shared Equipment', account_type: 'asset_fixed', company_id: null, create_asset: 'draft' });
  const sharedDepAcc = create(sharedAssetAcc.db, 'account.account', { code: '152950', name: 'Shared Dep', account_type: 'asset_fixed', company_id: null });
  const sharedExpAcc = create(sharedDepAcc.db, 'account.account', { code: '680950', name: 'Shared Dep Exp', account_type: 'expense', company_id: null });
  db = sharedExpAcc.db;

  const modelC1 = create(db, 'account.asset.model', {
    name: 'C1 Shared Acc Model',
    company_id: 1,
    method: 'linear',
    method_number: 3,
    method_period: '12',
    account_asset_id: sharedAssetAcc.id,
    account_depreciation_id: sharedDepAcc.id,
    account_depreciation_expense_id: sharedExpAcc.id,
  });
  const modelC2 = create(modelC1.db, 'account.asset.model', {
    name: 'C2 Foreign Model',
    company_id: c2.id,
    method: 'linear',
    method_number: 3,
    method_period: '12',
    account_asset_id: sharedAssetAcc.id,
    account_depreciation_id: sharedDepAcc.id,
    account_depreciation_expense_id: sharedExpAcc.id,
  });
  db = modelC2.db;

  // Shared (companyless) account cannot link to a company-2 model
  assert.throws(
    () => write(db, 'account.account', sharedAssetAcc.id, { asset_model_id: modelC2.id }),
    /Asset model must belong to the account company/,
  );

  // Linking company-1 model to shared account succeeds
  db = write(db, 'account.account', sharedAssetAcc.id, { asset_model_id: modelC1.id });

  // Posting a bill in company 1 generates a draft asset with modelC1
  const billC1 = create(db, 'account.move', {
    move_type: 'in_invoice',
    company_id: 1,
    partner_id: 2,
    invoice_date: '2026-03-01',
    invoice_line_ids: [{ name: 'C1 Asset', qty: 1, price_unit: 1500, tax: 0, account_id: sharedAssetAcc.id }],
  });
  const afterC1 = postMove(billC1.db, billC1.id);
  const assetC1 = search(afterC1, 'account.asset').find((a) => a.bill_id === billC1.id);
  assert.ok(assetC1);
  assert.equal(assetC1.company_id, 1);
  assert.equal(assetC1.model_id, modelC1.id);

  // Posting a bill in company 2 on the same shared account is rejected because modelC1 belongs to company 1
  const billC2 = create(afterC1, 'account.move', {
    move_type: 'in_invoice',
    company_id: c2.id,
    partner_id: 2,
    invoice_date: '2026-03-01',
    invoice_line_ids: [{ name: 'C2 Asset', qty: 1, price_unit: 1500, tax: 0, account_id: sharedAssetAcc.id }],
  });
  assert.throws(
    () => postMove(billC2.db, billC2.id),
    /Asset model must belong to the bill company/,
  );
});

test('Finding 6 regression: Arabic translations exist for Company is required and asset model company messages', () => {
  const i18nSource = readFileSync(new URL('./i18n.js', import.meta.url), 'utf8');
  for (const key of [
    'Company is required',
    'Select an existing depreciation model',
    'Depreciation model must belong to the asset company',
    'Select an existing asset model',
    'Asset model must belong to the account company',
    'Asset model must belong to the bill company',
  ]) {
    assert.match(i18nSource, new RegExp(`'${key}':\\s*'[^']+'`), `${key} must have an Arabic entry in i18n.js`);
  }
});

test('migration 78 gives a company-less depreciation model the company of the assets using it', () => {
  const db = seed();
  const old = {
    ...db,
    schema_version: 77,
    records: {
      ...db.records,
      'account.asset.model': [
        { id: 901, name: 'Used by company 2' },
        { id: 902, name: 'Shared' },
        { id: 903, name: 'Unused' },
      ],
      'account.asset': [
        ...(db.records['account.asset'] ?? []),
        { id: 9901, name: 'A', company_id: 2, model_id: 901, state: 'draft' },
        { id: 9902, name: 'B', company_id: 1, model_id: 902, state: 'draft' },
        { id: 9903, name: 'C', company_id: 2, model_id: 902, state: 'draft' },
      ],
    },
  };
  const models = migrate(old).records['account.asset.model'];
  assert.equal(models.find((m) => m.id === 901).company_id, 2);
  assert.equal(models.find((m) => m.id === 902).company_id, undefined);
  assert.equal(models.find((m) => m.id === 903).company_id, 1);
});
