import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { seed } from './seed.js';
import { apps, findLeaf, models } from './models/index.js';
import { activeRootPlans, analyticPlanFilters } from './models/analyticplus.js';
import { createCompany, setCompanies } from './models/company.js';
import { applyFilters, create, groupRecords, read, search, unlink, updateSettings, write } from './orm.js';
import { applyDiff, diffDb } from './sync.js';
import { setupDom, find } from './test-support/dom.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const props = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];
const classOf = (node) => props(node)?.className ?? node?.className ?? '';
const hasClass = (node, cls) => typeof classOf(node) === 'string' && classOf(node).split(/\s+/).includes(cls);
const allFind = (root, pred, out = []) => {
  if (!root) return out;
  if (pred(root)) out.push(root);
  for (const child of root.childNodes ?? []) allFind(child, pred, out);
  return out;
};
const analyticItemsLeaf = () => findLeaf(apps.find((a) => a.id === 'accounting'), 'analytic-items');

async function mountAnalyticList(initialDb, params = new URLSearchParams('view=list')) {
  const prevStorage = globalThis.localStorage;
  const prevPrompt = globalThis.prompt;
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
    clear: () => { mem.clear(); },
  };
  setupDom();
  const origCreate = globalThis.document.createElement;
  globalThis.document.createElement = (tag) => {
    const el = origCreate(tag);
    el.insertBefore = (child, before) => {
      const idx = before ? el.childNodes.indexOf(before) : -1;
      if (idx >= 0) el.childNodes.splice(idx, 0, child);
      else el.childNodes.push(child);
      child.parentNode = el;
      if (child.tagName === 'OPTION') el.options.push(child);
      return el;
    };
    return el;
  };
  globalThis.document.createElementNS = (_, tag) => globalThis.document.createElement(tag);
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit, getDb } = await import('./store.js');
  const { ActionView } = await import('./views/ActionView.jsx');
  await initStore();
  await commit(initialDb);
  const host = globalThis.document.createElement('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  const leaf = analyticItemsLeaf();
  const render = async (nextParams = params) => {
    await React.act(async () => {
      root.render(React.createElement(ActionView, {
        leaf,
        base: '#/accounting/analytic-items',
        params: nextParams,
      }));
    });
  };
  await render();
  return {
    React,
    host,
    commit,
    getDb,
    render,
    done: async () => {
      await React.act(async () => root.unmount());
      if (prevStorage === undefined) delete globalThis.localStorage;
      else globalThis.localStorage = prevStorage;
      if (prevPrompt === undefined) delete globalThis.prompt;
      else globalThis.prompt = prevPrompt;
    },
  };
}

test('analytic lines resolve and group by their root plan', () => {
  let db = seed();
  const p1 = create(db, 'account.analytic.plan', { name: 'First plan' }); db = p1.db;
  const p2 = create(db, 'account.analytic.plan', { name: 'Second plan' }); db = p2.db;
  const child = create(db, 'account.analytic.plan', { name: 'Child plan', parent_id: p1.id }); db = child.db;
  const a = create(db, 'account.analytic.account', { name: 'First account', plan_id: child.id }); db = a.db;
  const b = create(db, 'account.analytic.account', { name: 'Second account', plan_id: p2.id }); db = b.db;
  const l1 = create(db, 'account.analytic.line', { name: 'One', date: '2026-01-01', account_id: a.id, amount: 12 }); db = l1.db;
  const l2 = create(db, 'account.analytic.line', { name: 'Two', date: '2026-01-01', account_id: b.id, amount: 7 }); db = l2.db;
  const lines = [read(db, 'account.analytic.line', l1.id), read(db, 'account.analytic.line', l2.id)];
  assert.deepEqual(lines.map((l) => [l.account_id, l.plan_id]), [[a.id, p1.id], [b.id, p2.id]]);
  const groups = groupRecords(db, 'account.analytic.line', lines, 'plan_id');
  assert.equal(groups.find((g) => g.key === p1.id).records.reduce((sum, l) => sum + l.amount, 0), 12);
  assert.equal(groups.find((g) => g.key === p2.id).records.reduce((sum, l) => sum + l.amount, 0), 7);
});

test('archived root plans are not offered', () => {
  let db = seed();
  const plan = create(db, 'account.analytic.plan', { name: 'Archived plan', active: false }); db = plan.db;
  assert.equal(activeRootPlans(db).some((p) => p.id === plan.id), false);
});

test('analytic-items restores optional product_uom_id (hidden by default) and multi-company-only company_id', async () => {
  const { visibleListColumns } = await import('./views/List.jsx');
  const def = models['account.analytic.line'];
  const leaf = analyticItemsLeaf();
  let db = seed();

  const single = visibleListColumns(def, db, {}, leaf);
  assert.equal(single.cols.includes('company_id'), false, 'company_id hidden in single-company');
  assert.equal(single.optionalCols.some(([k]) => k === 'company_id'), false, 'company_id omitted from optional menu in single-company');
  assert.equal(single.cols.includes('product_uom_id'), false, 'product_uom_id hidden by default');
  assert.equal(single.optionalCols.some(([k, f]) => k === 'product_uom_id' && f.optional === 'hide'), true, 'product_uom_id is optional');

  const singleWithUom = visibleListColumns(def, db, { product_uom_id: true }, leaf);
  assert.equal(singleWithUom.cols.includes('product_uom_id'), true, 'product_uom_id shows when toggled on');

  const branch = createCompany(db, { name: 'Branch Co' });
  db = setCompanies(branch.db, { current: 1, allowed: [1, branch.id] });
  const multi = visibleListColumns(def, db, {}, leaf);
  assert.equal(multi.cols.includes('company_id'), true, 'company_id visible by default in multi-company');
  assert.equal(multi.optionalCols.some(([k, f]) => k === 'company_id' && f.optional === 'show'), true);
  assert.equal(multi.cols.includes('product_uom_id'), false, 'product_uom_id remains hidden by default in multi-company');
});

test('eager plan_id computation avoids per-line array scans and updates without stale caches', () => {
  let db = seed();
  const p1 = create(db, 'account.analytic.plan', { name: 'Root One' }); db = p1.db;
  const p2 = create(db, 'account.analytic.plan', { name: 'Root Two' }); db = p2.db;
  const child = create(db, 'account.analytic.plan', { name: 'Child', parent_id: p1.id }); db = child.db;
  const acc = create(db, 'account.analytic.account', { name: 'Acc', plan_id: child.id }); db = acc.db;
  for (let i = 0; i < 20; i += 1) {
    db = create(db, 'account.analytic.line', { name: `L${i}`, date: '2026-01-01', account_id: acc.id, amount: i + 1 }).db;
  }

  let accountFindCalls = 0;
  let planFindCalls = 0;
  const accountsProxy = new Proxy(db.records['account.analytic.account'], {
    get(target, prop, receiver) {
      if (prop === 'find') accountFindCalls += 1;
      return Reflect.get(target, prop, receiver);
    },
  });
  const plansProxy = new Proxy(db.records['account.analytic.plan'], {
    get(target, prop, receiver) {
      if (prop === 'find') planFindCalls += 1;
      return Reflect.get(target, prop, receiver);
    },
  });
  const instrumentedDb = {
    ...db,
    records: {
      ...db.records,
      'account.analytic.account': accountsProxy,
      'account.analytic.plan': plansProxy,
    },
  };

  const lines = search(instrumentedDb, 'account.analytic.line');
  assert.ok(lines.length >= 20);
  assert.ok(lines.filter((l) => l.account_id === acc.id).every((l) => l.plan_id === p1.id));
  assert.equal(accountFindCalls, 0, 'no per-line account.find scan');
  assert.equal(planFindCalls, 0, 'no per-line plan.find scan');

  // Re-parenting a plan or changing an account plan immediately invalidates caches on the new snapshot.
  const movedPlanDb = write(db, 'account.analytic.plan', child.id, { parent_id: p2.id });
  assert.equal(
    search(movedPlanDb, 'account.analytic.line').find((l) => l.account_id === acc.id).plan_id,
    p2.id,
  );
  const movedAccDb = write(db, 'account.analytic.account', acc.id, { plan_id: p2.id });
  assert.equal(
    search(movedAccDb, 'account.analytic.line').find((l) => l.account_id === acc.id).plan_id,
    p2.id,
  );
});

test('saved plan filters persist, stay effective on archived plans, and deleted filters never broaden the list', async () => {
  let db = seed();
  const p1 = create(db, 'account.analytic.plan', { name: 'Active Plan One' }); db = p1.db;
  const p2 = create(db, 'account.analytic.plan', { name: 'Active Plan Two' }); db = p2.db;
  const child1 = create(db, 'account.analytic.plan', { name: 'Subplan One', parent_id: p1.id }); db = child1.db;
  const a1 = create(db, 'account.analytic.account', { name: 'Acc One', plan_id: child1.id }); db = a1.db;
  const a2 = create(db, 'account.analytic.account', { name: 'Acc Two', plan_id: p2.id }); db = a2.db;
  const l1 = create(db, 'account.analytic.line', { name: 'Line One', date: '2026-01-01', account_id: a1.id, amount: 10 }); db = l1.db;
  const l2 = create(db, 'account.analytic.line', { name: 'Line Two', date: '2026-01-02', account_id: a2.id, amount: 20 }); db = l2.db;

  // 1. Analytic plan filter descriptors never silently broaden on a deleted plan id, while generic applyFilters stays unchanged.
  const allLines = search(db, 'account.analytic.line');
  assert.deepEqual(
    applyFilters('account.analytic.line', allLines, ['analytic-plan-999999'], db, [analyticPlanFilters(db, ['analytic-plan-999999'])]),
    [],
  );
  assert.deepEqual(
    applyFilters('account.analytic.line', allLines, [`analytic-plan-${p1.id}`, 'analytic-plan-999999'], db, [analyticPlanFilters(db, [`analytic-plan-${p1.id}`, 'analytic-plan-999999'])]).map((r) => r.id),
    [l1.id],
  );
  assert.deepEqual(
    applyFilters('account.analytic.line', allLines, ['unrecognized-filter-id'], db).map((r) => r.id),
    allLines.map((r) => r.id),
  );

  // 2. Save a Favorite filter in the ActionView UI, verify persistence through sync sanitization.
  const ctx = await mountAnalyticList(db);
  try {
    const toggleBtn = find(ctx.host, (n) => n.tagName === 'BUTTON' && hasClass(n, 'search-toggle'));
    await ctx.React.act(async () => { props(toggleBtn).onClick(); });

    const panel = find(ctx.host, (n) => hasClass(n, 'search-panel'));
    const p1Btn = find(panel, (n) => n.tagName === 'BUTTON' && n.textContent === 'Active Plan One');
    assert.ok(p1Btn, 'active root plan filter is offered');
    await ctx.React.act(async () => { props(p1Btn).onClick(); });

    const rowsText = () => allFind(ctx.host, (n) => n.tagName === 'TBODY').flatMap((tb) => allFind(tb, (n) => n.tagName === 'TR')).map((tr) => tr.textContent);
    assert.equal(rowsText().some((t) => t.includes('Acc One')), true);
    assert.equal(rowsText().some((t) => t.includes('Acc Two')), false);
    const accOneGroup = find(ctx.host, (n) => n.tagName === 'TR' && hasClass(n, 'group-row') && n.textContent.includes('Acc One'));
    await ctx.React.act(async () => { props(accOneGroup).onClick(); });
    assert.equal(rowsText().some((t) => t.includes('Line One')), true);
    assert.equal(rowsText().some((t) => t.includes('Line Two')), false);

    globalThis.prompt = () => 'Saved Plan One';
    const saveFavBtn = find(ctx.host, (n) => n.tagName === 'BUTTON' && n.textContent === 'Save current search');
    await ctx.React.act(async () => { props(saveFavBtn).onClick(); });

    const savedFavs = ctx.getDb().settings.favorites['account.analytic.line'];
    assert.equal(savedFavs.length, 1);
    assert.deepEqual(savedFavs[0].search.filters, [`analytic-plan-${p1.id}`]);

    // Verify sync sanitization preserves saved analytic-plan filters.
    const syncedDb = applyDiff(db, diffDb(db, ctx.getDb()));
    assert.deepEqual(syncedDb.settings.favorites['account.analytic.line'], savedFavs);
  } finally {
    await ctx.done();
  }

  // 3. Archive Plan One: not offered in SearchPanel, but saved Favorite and URL ?filter= still restrict to Line One.
  const archivedDb = write(
    updateSettings(db, {
      favorites: {
        'account.analytic.line': [{ name: 'Saved Plan One', search: { terms: [], filters: [`analytic-plan-${p1.id}`], groupBy: [], archived: false, rel: null } }],
      },
    }),
    'account.analytic.plan',
    p1.id,
    { active: false },
  );

  const archivedCtx = await mountAnalyticList(archivedDb);
  try {
    const toggleBtn = find(archivedCtx.host, (n) => n.tagName === 'BUTTON' && hasClass(n, 'search-toggle'));
    await archivedCtx.React.act(async () => { props(toggleBtn).onClick(); });

    const panel = find(archivedCtx.host, (n) => hasClass(n, 'search-panel'));
    assert.equal(find(panel, (n) => n.tagName === 'BUTTON' && n.textContent === 'Active Plan One'), null, 'archived plan is not offered in filter list');
    assert.ok(find(panel, (n) => n.tagName === 'BUTTON' && n.textContent === 'Active Plan Two'), 'active plan is offered');

    const favBtn = find(panel, (n) => n.tagName === 'BUTTON' && n.textContent === 'Saved Plan One');
    await archivedCtx.React.act(async () => { props(favBtn).onClick(); });

    const rows = allFind(archivedCtx.host, (n) => n.tagName === 'TBODY').flatMap((tb) => allFind(tb, (n) => n.tagName === 'TR')).map((tr) => tr.textContent);
    assert.equal(rows.some((t) => t.includes('Line One')), true, 'archived plan saved filter keeps matching line');
    assert.equal(rows.some((t) => t.includes('Line Two')), false, 'archived plan saved filter must not broaden to other plans');
  } finally {
    await archivedCtx.done();
  }

  const archivedUrlCtx = await mountAnalyticList(archivedDb, new URLSearchParams(`view=list&filter=analytic-plan-${p1.id}`));
  try {
    const accOneGroup = find(archivedUrlCtx.host, (n) => n.tagName === 'TR' && hasClass(n, 'group-row') && n.textContent.includes('Acc One'));
    assert.ok(accOneGroup, 'archived plan URL filter keeps matching group');
    assert.equal(find(archivedUrlCtx.host, (n) => n.tagName === 'TR' && hasClass(n, 'group-row') && n.textContent.includes('Acc Two')), null, 'archived plan URL filter excludes other plans');
    await archivedUrlCtx.React.act(async () => { props(accOneGroup).onClick(); });
    const rows = allFind(archivedUrlCtx.host, (n) => n.tagName === 'TBODY').flatMap((tb) => allFind(tb, (n) => n.tagName === 'TR')).map((tr) => tr.textContent);
    assert.equal(rows.some((t) => t.includes('Line One')), true);
    assert.equal(rows.some((t) => t.includes('Line Two')), false);
  } finally {
    await archivedUrlCtx.done();
  }

  // 4. Deleted plan: saved Favorite and URL ?filter= never broaden to show Line Two.
  const deletedPlan = create(db, 'account.analytic.plan', { name: 'Temp Plan' });
  const tempId = deletedPlan.id;
  let afterDeleteDb = unlink(deletedPlan.db, 'account.analytic.plan', [tempId]);
  afterDeleteDb = updateSettings(afterDeleteDb, {
    favorites: {
      'account.analytic.line': [{ name: 'Deleted Plan Fav', search: { terms: [], filters: [`analytic-plan-${tempId}`], groupBy: [], archived: false, rel: null } }],
    },
  });

  const deletedCtx = await mountAnalyticList(afterDeleteDb);
  try {
    const toggleBtn = find(deletedCtx.host, (n) => n.tagName === 'BUTTON' && hasClass(n, 'search-toggle'));
    await deletedCtx.React.act(async () => { props(toggleBtn).onClick(); });
    const favBtn = find(deletedCtx.host, (n) => n.tagName === 'BUTTON' && n.textContent === 'Deleted Plan Fav');
    await deletedCtx.React.act(async () => { props(favBtn).onClick(); });

    const dataRows = allFind(deletedCtx.host, (n) => n.tagName === 'TBODY')
      .flatMap((tb) => allFind(tb, (n) => n.tagName === 'TR'))
      .filter((tr) => !find(tr, (n) => hasClass(n, 'empty')));
    assert.equal(dataRows.length, 0, 'deleted plan favorite must restrict to 0 rows, never broaden');
    assert.ok(find(deletedCtx.host, (n) => hasClass(n, 'empty')), 'empty state row shown');
  } finally {
    await deletedCtx.done();
  }

  const deletedUrlCtx = await mountAnalyticList(afterDeleteDb, new URLSearchParams(`view=list&filter=analytic-plan-${tempId}`));
  try {
    const dataRows = allFind(deletedUrlCtx.host, (n) => n.tagName === 'TBODY')
      .flatMap((tb) => allFind(tb, (n) => n.tagName === 'TR'))
      .filter((tr) => !find(tr, (n) => hasClass(n, 'empty')));
    assert.equal(dataRows.length, 0, 'deleted plan URL filter must restrict to 0 rows, never broaden');
    assert.ok(find(deletedUrlCtx.host, (n) => hasClass(n, 'empty')), 'empty state row shown');
  } finally {
    await deletedUrlCtx.done();
  }
});

test('multi-company analytic-items offers allowed and shared root plans while excluding disallowed companies', async () => {
  let db = seed();
  const compB = createCompany(db, { name: 'Company B' }); db = compB.db;
  const compC = createCompany(db, { name: 'Company C' }); db = compC.db;

  const planA = create(db, 'account.analytic.plan', { name: 'Plan A', company_id: 1 }); db = planA.db;
  const planB = create(db, 'account.analytic.plan', { name: 'Plan B', company_id: compB.id }); db = planB.db;
  const planC = create(db, 'account.analytic.plan', { name: 'Plan C', company_id: compC.id }); db = planC.db;
  const planShared = create(db, 'account.analytic.plan', { name: 'Shared Plan', company_id: null }); db = planShared.db;

  const accA = create(db, 'account.analytic.account', { name: 'Acc A', plan_id: planA.id, company_id: 1 }); db = accA.db;
  const accB = create(db, 'account.analytic.account', { name: 'Acc B', plan_id: planB.id, company_id: compB.id }); db = accB.db;
  const accC = create(db, 'account.analytic.account', { name: 'Acc C', plan_id: planC.id, company_id: compC.id }); db = accC.db;
  const accShared = create(db, 'account.analytic.account', { name: 'Acc Shared', plan_id: planShared.id, company_id: null }); db = accShared.db;

  const lineA = create(db, 'account.analytic.line', { name: 'Line A', date: '2026-01-01', account_id: accA.id, company_id: 1, amount: 10 }); db = lineA.db;
  const lineB = create(db, 'account.analytic.line', { name: 'Line B', date: '2026-01-02', account_id: accB.id, company_id: compB.id, amount: 20 }); db = lineB.db;
  const lineC = create(db, 'account.analytic.line', { name: 'Line C', date: '2026-01-03', account_id: accC.id, company_id: compC.id, amount: 30 }); db = lineC.db;
  const lineShared = create(db, 'account.analytic.line', { name: 'Line Shared', date: '2026-01-04', account_id: accShared.id, company_id: 1, amount: 40 }); db = lineShared.db;

  // Undefined allowed_company_ids falls back to current company (1) + shared plans only.
  const undefAllowedDb = { ...db, settings: { ...db.settings, current_company_id: 1, allowed_company_ids: undefined } };
  const undefIds = analyticPlanFilters(undefAllowedDb).map((f) => f.id);
  assert.equal(undefIds.includes(`analytic-plan-${planA.id}`), true);
  assert.equal(undefIds.includes(`analytic-plan-${planShared.id}`), true);
  assert.equal(undefIds.includes(`analytic-plan-${planB.id}`), false);
  assert.equal(undefIds.includes(`analytic-plan-${planC.id}`), false);

  // Company A (1) is active, Company B is allowed, Company C is NOT allowed.
  const multiDb = setCompanies(db, { current: 1, allowed: [1, compB.id] });

  // activeRootPlans stays scoped to current company + shared.
  const currentOnlyIds = activeRootPlans(multiDb).map((p) => p.id);
  assert.equal(currentOnlyIds.includes(planA.id), true);
  assert.equal(currentOnlyIds.includes(planShared.id), true);
  assert.equal(currentOnlyIds.includes(planB.id), false);
  assert.equal(currentOnlyIds.includes(planC.id), false);

  // analyticPlanFilters offers A, B, and shared, while excluding C.
  const multiPlanFilterIds = analyticPlanFilters(multiDb).map((f) => f.id);
  assert.equal(multiPlanFilterIds.includes(`analytic-plan-${planA.id}`), true);
  assert.equal(multiPlanFilterIds.includes(`analytic-plan-${planB.id}`), true);
  assert.equal(multiPlanFilterIds.includes(`analytic-plan-${planShared.id}`), true);
  assert.equal(multiPlanFilterIds.includes(`analytic-plan-${planC.id}`), false);

  // Real ActionView list UI: Plan B is offered and filters visible lines to Company B; Plan C is not offered.
  const ctx = await mountAnalyticList(multiDb);
  try {
    const toggleBtn = find(ctx.host, (n) => n.tagName === 'BUTTON' && hasClass(n, 'search-toggle'));
    await ctx.React.act(async () => { props(toggleBtn).onClick(); });

    const panel = find(ctx.host, (n) => hasClass(n, 'search-panel'));
    const btnA = find(panel, (n) => n.tagName === 'BUTTON' && n.textContent === 'Plan A');
    const btnB = find(panel, (n) => n.tagName === 'BUTTON' && n.textContent === 'Plan B');
    const btnShared = find(panel, (n) => n.tagName === 'BUTTON' && n.textContent === 'Shared Plan');
    const btnC = find(panel, (n) => n.tagName === 'BUTTON' && n.textContent === 'Plan C');

    assert.ok(btnA, 'Plan A (active company) is offered');
    assert.ok(btnB, 'Plan B (allowed company) is offered');
    assert.ok(btnShared, 'Shared Plan is offered');
    assert.equal(btnC, null, 'Plan C (disallowed company) is excluded');

    await ctx.React.act(async () => { props(btnB).onClick(); });

    const rowsText = () => allFind(ctx.host, (n) => n.tagName === 'TBODY').flatMap((tb) => allFind(tb, (n) => n.tagName === 'TR')).map((tr) => tr.textContent);
    assert.equal(rowsText().some((t) => t.includes('Acc B')), true, 'Company B group is shown');
    assert.equal(rowsText().some((t) => t.includes('Acc A')), false, 'Company A group is filtered out');
    assert.equal(rowsText().some((t) => t.includes('Acc Shared')), false, 'Shared group is filtered out');
    assert.equal(rowsText().some((t) => t.includes('Acc C')), false, 'Company C group is never shown');

    const accBGroup = find(ctx.host, (n) => n.tagName === 'TR' && hasClass(n, 'group-row') && n.textContent.includes('Acc B'));
    await ctx.React.act(async () => { props(accBGroup).onClick(); });
    assert.equal(rowsText().some((t) => t.includes('Line B')), true);
    assert.equal(rowsText().some((t) => t.includes('Line A')), false);
    assert.equal(rowsText().some((t) => t.includes('Line Shared')), false);
    assert.equal(rowsText().some((t) => t.includes('Line C')), false);
  } finally {
    await ctx.done();
  }

  // Disallowed company C filter via URL restricts to 0 rows, never broadens.
  const disallowedUrlCtx = await mountAnalyticList(multiDb, new URLSearchParams(`view=list&filter=analytic-plan-${planC.id}`));
  try {
    const dataRows = allFind(disallowedUrlCtx.host, (n) => n.tagName === 'TBODY')
      .flatMap((tb) => allFind(tb, (n) => n.tagName === 'TR'))
      .filter((tr) => !find(tr, (n) => hasClass(n, 'empty')));
    assert.equal(dataRows.length, 0, 'disallowed company plan filter must restrict to 0 rows');
    assert.ok(find(disallowedUrlCtx.host, (n) => hasClass(n, 'empty')));
  } finally {
    await disallowedUrlCtx.done();
  }
});
