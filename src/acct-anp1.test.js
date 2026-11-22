import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { read } from './orm.js';
import { models } from './models/index.js';
import {
  completePlanName,
  rootPlanId,
  rootPlan,
  isRootPlan,
  rootAnalyticPlans,
  planAccountCount,
} from './models/analyticplus.js';
import { diffDb, applyDiff } from './sync.js';
import { setupDom } from './test-support/dom.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const textOf = (node) => (node.nodeType === 3 ? node.nodeValue : (node.childNodes ?? []).map(textOf).join(''));
const findAll = (node, predicate, out = []) => {
  if (!node) return out;
  if (predicate(node)) out.push(node);
  for (const child of node.childNodes ?? []) findAll(child, predicate, out);
  return out;
};

// ANP-1: Analytic Plans hierarchy, description, account count, guards, and Arabic i18n
test('ANP-1: Analytic Plans description, parent/children hierarchy, complete_name, root plan, and account_count', async () => {
  const planModel = models['account.analytic.plan'];
  assert.ok(planModel, 'account.analytic.plan model must exist');
  assert.equal(planModel.fields.description?.type, 'text', 'description field must be text');
  assert.ok(planModel.form.groups.flat().includes('description'), 'description is editable on the plan form');
  assert.equal(planModel.fields.parent_id?.type, 'many2one', 'parent_id must be many2one');
  assert.equal(planModel.fields.children_ids?.type, 'one2many', 'children_ids must be one2many');
  assert.equal(planModel.fields.complete_name?.type, 'char', 'complete_name must be char');
  assert.equal(planModel.fields.root_plan_id?.type, 'many2one', 'root_plan_id must be many2one');
  assert.equal(planModel.fields.account_count?.type, 'integer', 'account_count must be integer');

  const defaults = planModel.defaults?.(1) ?? {};
  assert.equal(defaults.description, '', 'default description should be empty string');

  const baseDb = {
    settings: { current_company_id: 1, allowed_company_ids: [1] },
    messages: [],
    seq: {},
    records: {
      'account.analytic.plan': [
        { id: 10, name: 'Operations', parent_id: null, description: 'Core operational plans', color: 1 },
        { id: 20, name: 'Logistics', parent_id: 10, description: 'Fleet and warehouse logistics', color: 2 },
        { id: 30, name: 'Fleet', parent_id: 20, description: 'Vehicle fleet management', color: 3 },
        { id: 40, name: 'Commercial', parent_id: null, description: 'Commercial activities', color: 4 },
      ],
      'account.analytic.account': [
        { id: 101, name: 'HQ Warehouse', plan_id: 20, company_id: 1, active: true },
        { id: 102, name: 'Truck Fleet A', plan_id: 30, company_id: 1, active: true },
        { id: 103, name: 'Truck Fleet B', plan_id: 30, company_id: 1, active: true },
        { id: 104, name: 'Sales East', plan_id: 40, company_id: 1, active: true },
      ],
      'res.company': [{ id: 1, name: 'My Company', currency_id: 1 }],
      'res.currency': [{ id: 1, name: 'USD', symbol: '$', decimal_places: 2 }],
    },
  };

  const plan10 = read(baseDb, 'account.analytic.plan', 10);
  const plan20 = read(baseDb, 'account.analytic.plan', 20);
  const plan30 = read(baseDb, 'account.analytic.plan', 30);
  const plan40 = read(baseDb, 'account.analytic.plan', 40);

  // Complete name hierarchy
  assert.equal(completePlanName(baseDb, plan10), 'Operations');
  assert.equal(completePlanName(baseDb, plan20), 'Operations / Logistics');
  assert.equal(completePlanName(baseDb, plan30), 'Operations / Logistics / Fleet');
  assert.equal(plan10.complete_name, 'Operations');
  assert.equal(plan20.complete_name, 'Operations / Logistics');
  assert.equal(plan30.complete_name, 'Operations / Logistics / Fleet');

  // Children IDs
  assert.deepEqual(plan10.children_ids, [20]);
  assert.deepEqual(plan20.children_ids, [30]);
  assert.deepEqual(plan30.children_ids, []);

  // Root plan derivation
  assert.equal(rootPlanId(baseDb, plan10), 10);
  assert.equal(rootPlanId(baseDb, plan20), 10);
  assert.equal(rootPlanId(baseDb, plan30), 10);
  assert.equal(rootPlan(baseDb, plan30)?.id, 10);
  assert.equal(plan10.root_plan_id, 10);
  assert.equal(plan20.root_plan_id, 10);
  assert.equal(plan30.root_plan_id, 10);
  assert.equal(isRootPlan(plan10), true);
  assert.equal(isRootPlan(plan20), false);
  assert.equal(isRootPlan(plan30), false);
  assert.deepEqual(rootAnalyticPlans(baseDb).map((p) => p.id), [10, 40]);

  // Account count per plan (including subtree)
  assert.equal(planAccountCount(baseDb, plan10), 3, 'Operations subtree has Logistics (1) + Fleet (2)');
  assert.equal(planAccountCount(baseDb, plan20), 3, 'Logistics subtree has 101 + Fleet (102, 103)');
  assert.equal(planAccountCount(baseDb, plan30), 2, 'Fleet plan has 102, 103');
  assert.equal(planAccountCount(baseDb, plan40), 1, 'Commercial has 104');
  assert.equal(plan10.account_count, 3);
  assert.equal(plan20.account_count, 3);
  assert.equal(plan30.account_count, 2);
  assert.equal(plan40.account_count, 1);

  // Guards tested through diffDb + applyDiff
  // 1. Direct cycle: self-parenting
  const forgedSelf = {
    ...baseDb,
    records: {
      ...baseDb.records,
      'account.analytic.plan': baseDb.records['account.analytic.plan'].map((p) => (p.id === 10 ? { ...p, parent_id: 10 } : p)),
    },
  };
  assert.throws(
    () => applyDiff(baseDb, diffDb(baseDb, forgedSelf), { isAdmin: true }),
    /A plan cannot be its own ancestor/i,
    'Self-parenting plan must be rejected via applyDiff'
  );

  // 2. Indirect cycle: root parented to descendant
  const forgedCycle = {
    ...baseDb,
    records: {
      ...baseDb.records,
      'account.analytic.plan': baseDb.records['account.analytic.plan'].map((p) => (p.id === 10 ? { ...p, parent_id: 30 } : p)),
    },
  };
  assert.throws(
    () => applyDiff(baseDb, diffDb(baseDb, forgedCycle), { isAdmin: true }),
    /A plan cannot be its own ancestor/i,
    'Cycle through descendant must be rejected via applyDiff'
  );

  // Arabic translations
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem() {} };
  try {
    const { t } = await import(`./i18n.js?ar-anp1-test=${Date.now()}`);
    for (const key of ['Root Plan', 'Sub-plans', 'Complete Name', 'Analytic Accounts', 'Description', 'A plan cannot be its own ancestor']) {
      assert.notEqual(t(key), key, `missing Arabic translation for: ${key}`);
    }
  } finally {
    globalThis.localStorage = prevStorage;
  }
});

// ANP-3: Analytic Report one column per root analytic plan
test('ANP-3: Analytic Report renders one column per root analytic plan', async () => {
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();

  const { Reports } = await import('./views/Reports.jsx');

  const reportDb = {
    settings: { current_company_id: 1, allowed_company_ids: [1] },
    records: {
      'res.company': [{ id: 1, name: 'Test Corp', currency_id: 1 }],
      'res.currency': [{ id: 1, name: 'USD', symbol: '$', decimal_places: 2 }],
      'account.analytic.plan': [
        { id: 1, name: 'Projects', parent_id: null, sequence: 10, active: true },
        { id: 2, name: 'Departments', parent_id: null, sequence: 20, active: true },
        { id: 3, name: 'R&D', parent_id: 2, sequence: 10, active: true }, // Sub-plan of Departments
      ],
      'account.analytic.account': [
        { id: 10, name: 'Website Redesign', plan_id: 1, company_id: 1, active: true },
        { id: 20, name: 'Core Engine Dev', plan_id: 3, company_id: 1, active: true }, // under R&D, root is Departments
      ],
      'account.analytic.line': [
        { id: 101, account_id: 10, amount: -500, date: '2026-03-01', name: 'Design Services' },
        { id: 102, account_id: 20, amount: -300, date: '2026-03-02', name: 'Software Licenses' },
      ],
      'account.move': [],
      'account.move.line': [],
    },
  };

  await React.act(async () => commit(reportDb));

  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    // 1. Render with root plans present: columns should be Account, Projects, Departments
    await React.act(async () => {
      root.render(React.createElement(Reports, { leaf: { report: 'analytic', label: 'Analytic Report' } }));
    });

    const ths = findAll(host, (node) => node.tagName === 'TH');
    const headerTexts = ths.map((th) => textOf(th).trim());
    assert.deepEqual(headerTexts, ['', 'Projects', 'Departments'], 'Headers should have one column per root plan');

    // Verify row columns: total rows have .rep-total
    const rows = findAll(host, (node) => node.tagName === 'TR');
    const totalRows = rows.filter((r) => r.className?.includes('rep-total'));
    assert.equal(totalRows.length, 2, 'Two analytic accounts displayed');

    // First account: Website Redesign (root plan: Projects)
    const row1Cells = findAll(totalRows[0], (node) => node.tagName === 'TD').map((td) => textOf(td).trim());
    assert.equal(row1Cells[0], 'Website Redesign');
    assert.equal(row1Cells[1], '-$500.00', 'Amount renders in Projects column');
    assert.equal(row1Cells[2], '', 'Departments column is empty for Projects account');

    // Second account: Core Engine Dev (subplan R&D, root plan: Departments)
    const row2Cells = findAll(totalRows[1], (node) => node.tagName === 'TD').map((td) => textOf(td).trim());
    assert.equal(row2Cells[0], 'Core Engine Dev');
    assert.equal(row2Cells[1], '', 'Projects column is empty for Departments account');
    assert.equal(row2Cells[2], '-$300.00', 'Amount renders in Departments column via root plan');

    // 2. Render fallback when no root plans exist: columns should fallback to ['Account', 'Balance']
    const noPlansDb = {
      ...reportDb,
      records: {
        ...reportDb.records,
        'account.analytic.plan': [],
      },
    };
    await React.act(async () => commit(noPlansDb));
    await React.act(async () => {
      root.render(React.createElement(Reports, { leaf: { report: 'analytic', label: 'Analytic Report' } }));
    });

    const fallbackThs = findAll(host, (node) => node.tagName === 'TH');
    const fallbackHeaders = fallbackThs.map((th) => textOf(th).trim());
    assert.deepEqual(fallbackHeaders, ['', 'Balance'], 'Fallback headers should be Account and Balance');

    const fallbackTotalRows = findAll(host, (node) => node.tagName === 'TR').filter((r) => r.className?.includes('rep-total'));
    const fallbackRow1Cells = findAll(fallbackTotalRows[0], (node) => node.tagName === 'TD').map((td) => textOf(td).trim());
    assert.equal(fallbackRow1Cells[0], 'Website Redesign');
    assert.equal(fallbackRow1Cells[1], '-$500.00', 'Balance column displays total');
  } finally {
    await React.act(async () => root.unmount());
  }
});
