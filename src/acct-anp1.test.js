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
  rootPlanMap,
  rawPlanMap,
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
  // Odoo 20: account_count counts the plan's own accounts; all_account_count includes subplans.
  assert.equal(plan10.account_count, 0);
  assert.equal(plan20.account_count, 1);
  assert.equal(plan30.account_count, 2);
  assert.equal(plan40.account_count, 1);
  assert.equal(plan10.all_account_count, 3);
  assert.equal(plan20.all_account_count, 3);

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

// Regression test: Finding 1 - Accounts without a resolvable root plan render in Unassigned column
test('Finding 1: Accounts without a resolvable root plan render in Unassigned column with aligned headers and detail rows', async () => {
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
      ],
      'account.analytic.account': [
        { id: 10, name: 'Website Redesign', plan_id: 1, company_id: 1, active: true },
        { id: 20, name: 'General Overhead', plan_id: null, company_id: 1, active: true },
        { id: 30, name: 'Orphaned Account', plan_id: 999, company_id: 1, active: true },
      ],
      'account.analytic.line': [
        { id: 101, account_id: 10, amount: -500, date: '2026-03-01', name: 'Design Services' },
        { id: 102, account_id: 20, amount: -200, date: '2026-03-02', name: 'Office Supplies' },
        { id: 103, account_id: 30, amount: -150, date: '2026-03-03', name: 'Legacy Expense' },
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
    await React.act(async () => {
      root.render(React.createElement(Reports, { leaf: { report: 'analytic', label: 'Analytic Report' } }));
    });

    const ths = findAll(host, (node) => node.tagName === 'TH');
    const headerTexts = ths.map((th) => textOf(th).trim());
    assert.deepEqual(headerTexts, ['', 'Projects', 'Unassigned'], 'Headers include Unassigned column when unplanned accounts exist');

    const rows = findAll(host, (node) => node.tagName === 'TR');
    const totalRows = rows.filter((r) => r.className?.includes('rep-total'));
    assert.equal(totalRows.length, 3, 'Three analytic accounts displayed');

    // 1. Planned account: Website Redesign (Projects)
    const row1Cells = findAll(totalRows[0], (node) => node.tagName === 'TD').map((td) => textOf(td).trim());
    assert.deepEqual(row1Cells, ['Website Redesign', '-$500.00', ''], 'Planned account amount in Projects column');

    // 2. Unplanned account: General Overhead (no plan_id)
    const row2Cells = findAll(totalRows[1], (node) => node.tagName === 'TD').map((td) => textOf(td).trim());
    assert.deepEqual(row2Cells, ['General Overhead', '', '-$200.00'], 'Unplanned account amount renders in Unassigned column');

    // 3. Orphaned account: Orphaned Account (plan_id: 999 unresolvable)
    const row3Cells = findAll(totalRows[2], (node) => node.tagName === 'TD').map((td) => textOf(td).trim());
    assert.deepEqual(row3Cells, ['Orphaned Account', '', '-$150.00'], 'Unresolvable plan account amount renders in Unassigned column');

    // Verify detail rows
    const detailRows = rows.filter((r) => r.className?.includes('rep-detail'));
    assert.equal(detailRows.length, 3, 'Three detail lines displayed');

    const detail1Cells = findAll(detailRows[0], (node) => node.tagName === 'TD').map((td) => textOf(td).trim());
    assert.deepEqual(detail1Cells, ['Design Services', '-$500.00', ''], 'Planned detail line in Projects column');

    const detail2Cells = findAll(detailRows[1], (node) => node.tagName === 'TD').map((td) => textOf(td).trim());
    assert.deepEqual(detail2Cells, ['Office Supplies', '', '-$200.00'], 'Unplanned detail line in Unassigned column');

    const detail3Cells = findAll(detailRows[2], (node) => node.tagName === 'TD').map((td) => textOf(td).trim());
    assert.deepEqual(detail3Cells, ['Legacy Expense', '', '-$150.00'], 'Unresolvable detail line in Unassigned column');

    // Header and body column counts alignment
    for (const r of [...totalRows, ...detailRows]) {
      const cells = findAll(r, (node) => node.tagName === 'TD');
      assert.equal(cells.length, headerTexts.length, 'Every row must have the same number of cells as header columns');
    }
  } finally {
    await React.act(async () => root.unmount());
  }
});

// Regression test: Finding 2 - Some plan names change in Arabic reports
test('Finding 2: Analytic report headings show stored plan names and an Unassigned column', async () => {
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { tableToRows } = await import('./csv.js');
  await initStore();

  const { Reports } = await import('./views/Reports.jsx');


  const reportDb = {
    settings: { current_company_id: 1, allowed_company_ids: [1] },
    records: {
      'res.company': [{ id: 1, name: 'Test Corp', currency_id: 1 }],
      'res.currency': [{ id: 1, name: 'USD', symbol: '$', decimal_places: 2 }],
      'account.analytic.plan': [
        // 'Sales' is a known UI term that translates to 'المبيعات' in Arabic
        { id: 1, name: 'Sales', parent_id: null, sequence: 10, active: true },
      ],
      'account.analytic.account': [
        { id: 10, name: 'Domestic Sales', plan_id: 1, company_id: 1, active: true },
        { id: 20, name: 'Unassigned Account', plan_id: null, company_id: 1, active: true },
      ],
      'account.analytic.line': [
        { id: 101, account_id: 10, amount: 1000, date: '2026-03-01', name: 'Invoice Item' },
        { id: 102, account_id: 20, amount: 200, date: '2026-03-02', name: 'Misc Item' },
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
    await React.act(async () => {
      root.render(React.createElement(Reports, { leaf: { report: 'analytic', label: 'Analytic Report' } }));
    });

    const ths = findAll(host, (node) => node.tagName === 'TH');
    const headerTexts = ths.map((th) => textOf(th).trim());
    // Stored plan names are shown as saved, never passed through t()
    // the static Unassigned heading is a UI label
    assert.equal(headerTexts[1], 'Sales', 'Dynamic plan name heading must preserve stored name');
    assert.equal(headerTexts[2], 'Unassigned', 'Static Unassigned heading');

    // Verify table export via tableToRows
    const tableEl = findAll(host, (node) => node.tagName === 'TABLE')[0];
    const exportedRows = tableToRows(tableEl);
    assert.ok(exportedRows.length > 0, 'Table rows exported');
    assert.equal(exportedRows[0][1], 'Sales', 'Exported CSV/XLSX header must preserve stored plan name');
    assert.equal(exportedRows[0][2], 'Unassigned', 'Exported header includes Unassigned');
  } finally {
    await React.act(async () => root.unmount());
  }
});

// Regression test: Finding 3 - Large analytic reports repeat full scans
test('Finding 3: Plan hierarchy indices account counts once per snapshot and rootPlanMap avoids per-account ORM reads', async () => {
  const baseDb = {
    settings: { current_company_id: 1, allowed_company_ids: [1] },
    records: {
      'account.analytic.plan': [
        { id: 1, name: 'Root 1', parent_id: null },
        { id: 2, name: 'Child 1-1', parent_id: 1 },
        { id: 3, name: 'Grandchild 1-1-1', parent_id: 2 },
        { id: 4, name: 'Root 2', parent_id: null },
      ],
      'account.analytic.account': [
        { id: 101, name: 'A1', plan_id: 1, active: true },
        { id: 102, name: 'A2', plan_id: 2, active: true },
        { id: 103, name: 'A3', plan_id: 3, active: true },
        { id: 104, name: 'A4', plan_id: 4, active: true },
        { id: 105, name: 'Archived', plan_id: 3, active: false },
      ],
    },
  };

  // 1. Verify rootPlanMap builds root plan lookups once per snapshot
  const rootsMap1 = rootPlanMap(baseDb);
  const rootsMap2 = rootPlanMap(baseDb);
  assert.equal(rootsMap1, rootsMap2, 'rootPlanMap returns cached index on same snapshot');
  assert.equal(rootsMap1.get(1), 1);
  assert.equal(rootsMap1.get(2), 1);
  assert.equal(rootsMap1.get(3), 1);
  assert.equal(rootsMap1.get(4), 4);

  // 2. Verify planAccountCount uses indexed snapshot cache
  const p1 = read(baseDb, 'account.analytic.plan', 1);
  const p2 = read(baseDb, 'account.analytic.plan', 2);
  const p3 = read(baseDb, 'account.analytic.plan', 3);
  const p4 = read(baseDb, 'account.analytic.plan', 4);

  assert.equal(planAccountCount(baseDb, p1), 3, 'Root 1 counts accounts in 1, 2, 3 (excluding archived)');
  assert.equal(planAccountCount(baseDb, p2), 2, 'Child 1-1 counts accounts in 2, 3');
  assert.equal(planAccountCount(baseDb, p3), 1, 'Grandchild counts account in 3');
  assert.equal(planAccountCount(baseDb, p4), 1, 'Root 2 counts account in 4');

  // Verify rawPlanMap lookup
  const rawMap = rawPlanMap(baseDb);
  assert.equal(rawMap.get(2)?.name, 'Child 1-1');

  // Verify that rendering Analytic does not call read() for 'account.analytic.plan' per account row
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();

  const { Reports } = await import('./views/Reports.jsx');

  // Add 10 accounts under plan 1 to simulate repeated accounts sharing a plan
  const manyAccountsDb = {
    settings: { current_company_id: 1, allowed_company_ids: [1] },
    records: {
      'res.company': [{ id: 1, name: 'Test Corp', currency_id: 1 }],
      'res.currency': [{ id: 1, name: 'USD', symbol: '$', decimal_places: 2 }],
      'account.analytic.plan': [
        { id: 1, name: 'Shared Plan', parent_id: null, sequence: 10, active: true },
      ],
      'account.analytic.account': Array.from({ length: 10 }, (_, i) => ({
        id: 100 + i,
        name: `Account ${i}`,
        plan_id: 1,
        company_id: 1,
        active: true,
      })),
      'account.analytic.line': [],
      'account.move': [],
      'account.move.line': [],
    },
  };

  await React.act(async () => commit(manyAccountsDb));

  const origCompute = models['account.analytic.plan'].fields.account_count.compute;
  let planComputeCount = 0;
  models['account.analytic.plan'].fields.account_count.compute = (r, db) => {
    planComputeCount += 1;
    return origCompute(r, db);
  };

  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    await React.act(async () => {
      root.render(React.createElement(Reports, { leaf: { report: 'analytic', label: 'Analytic Report' } }));
    });

    // Before fix, read() was called on each account row, computing account_count 10 extra times (>= 11 total).
    // With fix, rootPlanMap is used and account_count is computed only for root plans in the header (1 total).
    assert.equal(planComputeCount, 1, 'Analytic report rendering must not recompute plan account_count per account row');
  } finally {
    models['account.analytic.plan'].fields.account_count.compute = origCompute;
    await React.act(async () => root.unmount());
  }
});
