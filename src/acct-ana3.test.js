import { test } from 'node:test';
import assert from 'node:assert/strict';
import { models } from './models/index.js';
import { create, read } from './orm.js';
import { seed } from './seed.js';
import { migrate, SCHEMA_VERSION } from './migrations.js';
import { diffDb, applyDiff } from './sync.js';
import { planOf } from './analytic_distribution.js';
import {
  completePlanName,
  planAccountCount,
} from './models/analyticplus.js';

// ANA-1: account.analytic.account no longer carries the stale plan field or default; plan_id is the only plan link.
// Migration 69 maps old plan value to plan_id only where plan_id is empty.
test('ANA-1: account.analytic.account has no stale plan field or default, plan_id is canonical, and migration 69 maps legacy plan to plan_id', () => {
  const model = models['account.analytic.account'];
  assert.ok(model, 'account.analytic.account model exists');

  // Verify stale plan field is gone and plan_id is canonical
  assert.equal(model.fields.plan, undefined, 'stale plan selection field must not exist on model');
  assert.equal(model.fields.plan_id?.type, 'many2one', 'plan_id must be many2one relation');
  assert.equal(model.fields.plan_id?.relation, 'account.analytic.plan', 'plan_id relates to account.analytic.plan');

  // Verify defaults do not contain plan
  const defs = model.defaults?.() ?? {};
  assert.equal('plan' in defs, false, 'plan must not be in model defaults');
  assert.equal(defs.plan, undefined);

  // GroupBys should not contain stale plan
  if (model.groupBys) {
    assert.equal(model.groupBys.includes('plan'), false, 'plan must not be in groupBys');
  }

  // Verify migration 69 maps legacy plan to plan_id only when plan_id is empty
  const legacyDb = {
    schema_version: 68,
    settings: { current_company_id: 1, allowed_company_ids: [1] },
    messages: [],
    seq: {},
    records: {
      'account.analytic.plan': [
        { id: 1, name: 'Internal', color: 1 },
        { id: 2, name: 'Projects', color: 2 },
      ],
      'account.analytic.account': [
        { id: 101, name: 'Legacy Internal', plan: 'internal', plan_id: null, company_id: 1, active: true },
        { id: 102, name: 'Legacy Project', plan: 'project', plan_id: null, company_id: 1, active: true },
        { id: 103, name: 'Legacy With PlanId', plan: 'internal', plan_id: 2, company_id: 1, active: true },
        { id: 104, name: 'Legacy Custom Plan', plan: 'custom_marketing', plan_id: null, company_id: 1, active: true },
        { id: 105, name: 'No Plan Specified', plan: null, plan_id: null, company_id: 1, active: true },
      ],
      'res.company': [{ id: 1, name: 'Test Co', currency_id: 1 }],
      'res.currency': [{ id: 1, name: 'USD', symbol: '$', decimal_places: 2 }],
    },
  };

  assert.equal(SCHEMA_VERSION, 76);
  const migrated = migrate(legacyDb);
  assert.equal(migrated.schema_version, 76, 'migration bumped schema_version to 76');

  const acc101 = read(migrated, 'account.analytic.account', 101);
  const acc102 = read(migrated, 'account.analytic.account', 102);
  const acc103 = read(migrated, 'account.analytic.account', 103);
  const acc104 = read(migrated, 'account.analytic.account', 104);
  const acc105 = read(migrated, 'account.analytic.account', 105);

  assert.equal(acc101.plan_id, 1, 'mapped internal to plan 1');
  assert.equal(acc102.plan_id, 2, 'mapped project to plan 2');
  assert.equal(acc103.plan_id, 2, 'preserved existing plan_id 2 despite old plan being internal');
  assert.ok(acc104.plan_id != null, 'created plan for custom_marketing and assigned plan_id');
  assert.equal(acc105.plan_id, null, 'empty plan remains null');

  // Migration is idempotent
  assert.equal(migrate(migrated), migrated, 'migration 69 is idempotent');

  // Verify plan_id changes are diff-verifiable through diffDb + applyDiff
  const updatedDb = {
    ...migrated,
    records: {
      ...migrated.records,
      'account.analytic.account': migrated.records['account.analytic.account'].map((a) =>
        a.id === 101 ? { ...a, plan_id: 2 } : a
      ),
    },
  };
  const diff = diffDb(migrated, updatedDb);
  const applied = applyDiff(migrated, diff, { isAdmin: true });
  assert.equal(read(applied, 'account.analytic.account', 101).plan_id, 2, 'plan_id update diff-verified');
});

// ANA-2: Analytic accounts get a color integer field, defaulted to 0, shown in list/kanban
test('ANA-2: account.analytic.account color integer field defaults to 0 and persists across diffDb + applyDiff', () => {
  const model = models['account.analytic.account'];
  assert.ok(model, 'account.analytic.account model exists');

  // Color field configuration
  assert.equal(model.fields.color?.type, 'integer', 'color field must be integer');
  assert.equal(model.fields.color?.label, 'Color', 'color field label must be Color');

  // Default color is 0
  const defs = model.defaults?.() ?? {};
  assert.equal(defs.color, 0, 'default color is 0');

  // Kanban view is supported
  if (model.kanban) {
    assert.ok(model.views.includes('kanban'), 'kanban view is supported');
  }

  // Persistence and diff-verification
  const baseDb = {
    settings: { current_company_id: 1, allowed_company_ids: [1] },
    messages: [],
    seq: {},
    records: {
      'account.analytic.plan': [{ id: 1, name: 'Default Plan', color: 1 }],
      'account.analytic.account': [
        { id: 201, name: 'Consulting', plan_id: 1, color: 0, company_id: 1, active: true },
      ],
      'res.company': [{ id: 1, name: 'Test Co', currency_id: 1 }],
      'res.currency': [{ id: 1, name: 'USD', symbol: '$', decimal_places: 2 }],
    },
  };

  const rec = read(baseDb, 'account.analytic.account', 201);
  assert.equal(rec.color, 0);

  // Update color via diffDb + applyDiff
  const updatedDb = {
    ...baseDb,
    records: {
      ...baseDb.records,
      'account.analytic.account': baseDb.records['account.analytic.account'].map((a) =>
        a.id === 201 ? { ...a, color: 7 } : a
      ),
    },
  };
  const diff = diffDb(baseDb, updatedDb);
  const applied = applyDiff(baseDb, diff, { isAdmin: true });
  assert.equal(read(applied, 'account.analytic.account', 201).color, 7, 'color persists through applyDiff');
});

// ANA-3: Analytic plans description, complete_name, account_count, all_account_count, and guards
test('ANA-3: account.analytic.plan description, complete_name, account_count, all_account_count, and hierarchy guards', async () => {
  const planModel = models['account.analytic.plan'];
  assert.ok(planModel, 'account.analytic.plan model exists');

  // Field definitions
  assert.equal(planModel.fields.description?.type, 'text', 'description is text');
  assert.equal(planModel.fields.complete_name?.type, 'char', 'complete_name is char');
  assert.equal(planModel.fields.account_count?.type, 'integer', 'account_count is integer');
  assert.equal(planModel.fields.all_account_count?.type, 'integer', 'all_account_count is integer');

  // Hierarchy with 3 levels: Root -> Child -> Grandchild, plus a separate Standalone plan
  const testDb = {
    settings: { current_company_id: 1, allowed_company_ids: [1] },
    messages: [],
    seq: {},
    records: {
      'account.analytic.plan': [
        { id: 10, name: 'Corporate', parent_id: null, description: 'Corporate top-level plan', color: 1 },
        { id: 20, name: 'Engineering', parent_id: 10, description: 'Engineering department', color: 2 },
        { id: 30, name: 'Software', parent_id: 20, description: 'Software team', color: 3 },
        { id: 40, name: 'Marketing', parent_id: null, description: 'Marketing division', color: 4 },
      ],
      'account.analytic.account': [
        { id: 1, name: 'Corporate Overhead', plan_id: 10, company_id: 1, active: true },
        { id: 2, name: 'Dev Ops', plan_id: 20, company_id: 1, active: true },
        { id: 3, name: 'Backend Core', plan_id: 30, company_id: 1, active: true },
        { id: 4, name: 'Frontend Web', plan_id: 30, company_id: 1, active: true },
        { id: 5, name: 'Archived Team', plan_id: 30, company_id: 1, active: false },
        { id: 6, name: 'Growth Campaign', plan_id: 40, company_id: 1, active: true },
      ],
      'res.company': [{ id: 1, name: 'Test Co', currency_id: 1 }],
      'res.currency': [{ id: 1, name: 'USD', symbol: '$', decimal_places: 2 }],
    },
  };

  const plan10 = read(testDb, 'account.analytic.plan', 10);
  const plan20 = read(testDb, 'account.analytic.plan', 20);
  const plan30 = read(testDb, 'account.analytic.plan', 30);
  const plan40 = read(testDb, 'account.analytic.plan', 40);

  // complete_name hierarchy
  assert.equal(completePlanName(testDb, plan10), 'Corporate');
  assert.equal(completePlanName(testDb, plan20), 'Corporate / Engineering');
  assert.equal(completePlanName(testDb, plan30), 'Corporate / Engineering / Software');
  assert.equal(completePlanName(testDb, plan40), 'Marketing');

  assert.equal(plan10.complete_name, 'Corporate');
  assert.equal(plan20.complete_name, 'Corporate / Engineering');
  assert.equal(plan30.complete_name, 'Corporate / Engineering / Software');
  assert.equal(plan40.complete_name, 'Marketing');

  // account_count: the plan's own active accounts; all_account_count: this plan and its subplans (Odoo 20).
  // Plan 10 subtree: Plan 10 (1) + Plan 20 (1) + Plan 30 (2 active) = 4
  assert.equal(planAccountCount(testDb, plan10), 4);
  assert.equal(plan10.account_count, 1);
  assert.equal(plan10.all_account_count, 4);

  // Plan 20 subtree: Plan 20 (1) + Plan 30 (2 active) = 3
  assert.equal(planAccountCount(testDb, plan20), 3);
  assert.equal(plan20.account_count, 1);
  assert.equal(plan20.all_account_count, 3);

  // Plan 30 subtree: Plan 30 (2 active) = 2
  assert.equal(planAccountCount(testDb, plan30), 2);
  assert.equal(plan30.account_count, 2);
  assert.equal(plan30.all_account_count, 2);

  // Plan 40: 1 active account
  assert.equal(planAccountCount(testDb, plan40), 1);
  assert.equal(plan40.account_count, 1);
  assert.equal(plan40.all_account_count, 1);

  // Smart buttons config
  const smartBtns = planModel.form?.smart ?? [];
  const accountsBtn = smartBtns.find((b) => b.label === 'Analytic Accounts');
  assert.ok(accountsBtn, 'smart button for Analytic Accounts must exist');
  assert.equal(accountsBtn.model, 'account.analytic.account');
  assert.equal(accountsBtn.field, 'plan_id');
  assert.deepEqual(accountsBtn.ids(testDb, plan10), [10, 20, 30], 'ids resolver returns subtree plan IDs');

  // Hierarchy cycle guard diff-verifiability via diffDb + applyDiff
  // 1. Direct self-parenting
  const directCycleDb = {
    ...testDb,
    records: {
      ...testDb.records,
      'account.analytic.plan': testDb.records['account.analytic.plan'].map((p) =>
        p.id === 10 ? { ...p, parent_id: 10 } : p
      ),
    },
  };
  assert.throws(
    () => applyDiff(testDb, diffDb(testDb, directCycleDb), { isAdmin: true }),
    /A plan cannot be its own ancestor/i,
    'Self-parenting plan must be rejected via applyDiff'
  );

  // 2. Indirect multi-tier cycle
  const indirectCycleDb = {
    ...testDb,
    records: {
      ...testDb.records,
      'account.analytic.plan': testDb.records['account.analytic.plan'].map((p) =>
        p.id === 10 ? { ...p, parent_id: 30 } : p
      ),
    },
  };
  assert.throws(
    () => applyDiff(testDb, diffDb(testDb, indirectCycleDb), { isAdmin: true }),
    /A plan cannot be its own ancestor/i,
    'Indirect ancestor cycle must be rejected via applyDiff'
  );

  // Arabic i18n
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem() {} };
  try {
    const { t } = await import(`./i18n.js?t=${Date.now()}`);
    const keysToCheck = [
      'All Analytic Accounts',
      'Analytic Accounts',
      'Analytic Plan',
      'Analytic Plans',
      'Color',
      'Description',
      'Complete Name',
      'Subplans',
      'A plan cannot be its own ancestor',
    ];
    for (const key of keysToCheck) {
      const translated = t(key);
      assert.ok(translated, `translation must exist for ${key}`);
      assert.notEqual(translated, key, `Arabic translation must differ from English key for ${key}`);
    }
  } finally {
    globalThis.localStorage = prevStorage;
  }
});

// ANA-4: account.analytic.account.plan_id is required (create and diffDb+applyDiff) and planOf has no legacy fallback.
test('ANA-4: account.analytic.account requires plan_id through create and diffDb + applyDiff, and planOf always uses plan:<plan_id>', async () => {
  const model = models['account.analytic.account'];
  assert.equal(model.fields.plan_id?.required, true, 'plan_id must be required on account.analytic.account');

  const db = seed();
  assert.throws(
    () => create(db, 'account.analytic.account', { name: 'Missing Plan' }),
    /Analytic Plan is required/
  );

  const newId = (db.seq['account.analytic.account'] ?? 0) + 1;
  const createWithoutPlanDb = {
    ...db,
    seq: { ...db.seq, 'account.analytic.account': newId },
    records: {
      ...db.records,
      'account.analytic.account': [
        ...(db.records['account.analytic.account'] ?? []),
        { id: newId, name: 'Missing Plan', color: 0, active: true },
      ],
    },
  };
  assert.throws(
    () => applyDiff(db, diffDb(db, createWithoutPlanDb), { isAdmin: true }),
    /Analytic Plan is required/,
    'creating analytic account without plan_id must be rejected by applyDiff'
  );

  const existing = db.records['account.analytic.account'][0];
  const clearedPlanDb = {
    ...db,
    records: {
      ...db.records,
      'account.analytic.account': db.records['account.analytic.account'].map((a) =>
        a.id === existing.id ? { ...a, plan_id: null } : a
      ),
    },
  };
  assert.throws(
    () => applyDiff(db, diffDb(db, clearedPlanDb), { isAdmin: true }),
    /Analytic Plan is required/,
    'clearing plan_id on an existing analytic account must be rejected by applyDiff'
  );

  assert.equal(planOf({ id: 1, plan_id: 7 }), 'plan:7');
  assert.throws(() => planOf({ id: 1, plan: 'project' }), /Analytic Plan is required/);
  assert.throws(() => planOf(null), /Analytic Plan is required/);

  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem() {} };
  try {
    const { t } = await import(`./i18n.js?t=${Date.now()}`);
    const translated = t('Analytic Plan is required');
    assert.ok(translated && translated !== 'Analytic Plan is required');
  } finally {
    globalThis.localStorage = prevStorage;
  }
});
