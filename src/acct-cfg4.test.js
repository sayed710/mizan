import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { models } from './models/index.js';
import { create, read, matches, applyFilters } from './orm.js';
import { newDefaults } from './views/formDefaults.js';
import { diffDb, applyDiff } from './sync.js';

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
