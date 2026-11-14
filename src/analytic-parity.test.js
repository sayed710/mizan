import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { create, matches, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { menusFor, models, viewsOf } from './models/index.js';
import { createCompany, setCompanies } from './models/company.js';
import { actionRecords } from './companyView.js';
import { migrate, SCHEMA_VERSION } from './migrations.js';

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
const fieldLabelsOf = (container) => allFind(container, (n) => hasClass(n, 'field'))
  .map((f) => f.childNodes[0]?.textContent?.replaceAll('*', '').trim());

const findLeafByKey = (items, key) => {
  for (const item of items) {
    if (item.key === key) return item;
    if (item.children) {
      const found = findLeafByKey(item.children, key);
      if (found) return found;
    }
  }
  return null;
};

const plansLeaf = () => findLeafByKey(menusFor('accounting'), 'analytic-plans');
const accountsLeaf = () => findLeafByKey(menusFor('accounting'), 'analytic');

async function mountView(renderElement, initialDb = seed()) {
  const prevStorage = globalThis.localStorage;
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
      return child;
    };
    return el;
  };
  globalThis.document.createElementNS = (_, tag) => globalThis.document.createElement(tag);
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit, getDb } = await import('./store.js');
  await initStore();
  await commit(initialDb);
  const host = globalThis.document.createElement('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  const render = async () => {
    await React.act(async () => root.render(renderElement(React)));
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
      globalThis.localStorage = prevStorage;
    },
  };
}

test('account.analytic.plan list opens first, uses sequence handle, drops parent_id, and appends new plans last', async () => {
  const def = models['account.analytic.plan'];
  assert.equal(viewsOf('account.analytic.plan')[0], 'list');
  assert.equal(def.fields.sequence.widget, 'handle');
  assert.deepEqual(def.list, ['sequence', 'name', 'default_applicability', 'color']);
  assert.ok(!def.list.includes('parent_id'));
  assert.equal(def.listLabels.name, 'Analytic Plans');

  let db = seed();
  const first = create(db, 'account.analytic.plan', { name: 'Alpha Plan', color: 2 });
  const second = create(first.db, 'account.analytic.plan', { name: 'Beta Plan', color: 5 });
  db = second.db;
  const seq1 = read(db, 'account.analytic.plan', first.id).sequence;
  const seq2 = read(db, 'account.analytic.plan', second.id).sequence;
  assert.ok(seq2 > seq1, 'new plan gets higher sequence so it goes last');

  // Reordering by sequence sorts the list accordingly.
  db = write(db, 'account.analytic.plan', first.id, { sequence: seq2 + 10 });
  const { ActionView } = await import('./views/ActionView.jsx');
  const mounted = await mountView(
    (React) => React.createElement(ActionView, { leaf: plansLeaf(), base: '#/accounting/analytic-plans', params: new URLSearchParams() }),
    db,
  );
  try {
    const table = find(mounted.host, (n) => n.tagName === 'TABLE' && hasClass(n, 'list'));
    const headers = allFind(table, (n) => n.tagName === 'TH' && !hasClass(n, 'o2m-cols-th'))
      .map((th) => th.textContent.replace(/[▲▼]/g, '').trim())
      .filter(Boolean);
    assert.deepEqual(headers, ['Analytic Plans', 'Default Applicability', 'Color']);
    const rows = allFind(table, (n) => n.tagName === 'TR').slice(1);
    const orderedNames = rows.map((tr) => allFind(tr, (n) => n.tagName === 'TD')[2]?.textContent?.trim()).filter(Boolean);
    assert.ok(orderedNames.indexOf('Beta Plan') < orderedNames.indexOf('Alpha Plan'));
  } finally {
    await mounted.done();
  }
});

test('account.analytic.plan form smart counts, conditional default_applicability/tab, and applicability columns', async () => {
  const def = models['account.analytic.plan'];
  assert.deepEqual(def.form.groups, [['parent_id', 'default_applicability', 'color']]);
  assert.deepEqual(
    Object.keys(def.fields.applicability_ids.fields),
    ['business_domain', 'company_id', 'applicability', 'account_prefix', 'product_categ_id'],
  );
  assert.equal(def.fields.applicability_ids.fields.company_id.multiCompanyOnly, true);
  assert.equal(def.fields.applicability_ids.fields.company_id.placeholder, 'Visible to all');

  let db = seed();
  const rootPlan = create(db, 'account.analytic.plan', {
    name: 'Operations',
    applicability_ids: [{ business_domain: 'invoice', applicability: 'mandatory', account_prefix: '40' }],
  });
  const childPlan = create(rootPlan.db, 'account.analytic.plan', { name: 'Logistics', parent_id: rootPlan.id });
  const grandChild = create(childPlan.db, 'account.analytic.plan', { name: 'Fleet', parent_id: childPlan.id });
  const rootAcc = create(grandChild.db, 'account.analytic.account', { name: 'Ops Account', plan_id: rootPlan.id });
  const childAcc = create(rootAcc.db, 'account.analytic.account', { name: 'Fleet Account', plan_id: grandChild.id });
  db = childAcc.db;

  // Root plan requires default_applicability when cleared.
  assert.throws(
    () => write(db, 'account.analytic.plan', rootPlan.id, { default_applicability: '' }),
    /Default Applicability/,
  );
  // Child plan with parent_id does NOT require default_applicability.
  const childCleared = write(db, 'account.analytic.plan', childPlan.id, { default_applicability: '' });
  assert.equal(read(childCleared, 'account.analytic.plan', childPlan.id).default_applicability, '');

  const { FormView } = await import('./views/FormView.jsx');
  const { parseRel } = await import('./views/ActionView.jsx');
  const rootMounted = await mountView(
    (React) => React.createElement(FormView, { base: '#/accounting/analytic-plans', id: rootPlan.id, leaf: plansLeaf(), params: new URLSearchParams() }),
    db,
  );
  try {
    const smarts = allFind(rootMounted.host, (n) => hasClass(n, 'smart'));
    const smartMap = Object.fromEntries(smarts.map((s) => [
      s.childNodes[1]?.textContent?.trim(),
      { count: s.childNodes[0]?.textContent?.trim(), href: props(s)?.href },
    ]));
    assert.equal(smartMap['Subplans'].count, '1');
    assert.equal(smartMap['Subplans'].href, `#/accounting/analytic-plans?view=list&rel=parent_id:${rootPlan.id}`);
    assert.equal(smartMap['Analytic Accounts'].count, '2');
    assert.equal(smartMap['Analytic Accounts'].href, `#/accounting/analytic?view=list&rel=plan_id:${rootPlan.id},${childPlan.id},${grandChild.id}`);

    // Clicking "Analytic Accounts" navigates with multi-id rel that includes accounts in root & descendant subplans.
    const relRaw = smartMap['Analytic Accounts'].href.split('rel=')[1];
    const parsed = parseRel(db, 'account.analytic.account', relRaw);
    const drilled = actionRecords(db, accountsLeaf(), parsed).map((r) => r.id);
    assert.deepEqual(drilled, [rootAcc.id, childAcc.id]);

    assert.ok(fieldLabelsOf(rootMounted.host).includes('Default Applicability'));
    const tabLabels = allFind(rootMounted.host, (n) => props(n)?.role === 'tab')
      .map((n) => n.textContent.trim());
    assert.ok(tabLabels.includes('Applicability'));

    // Single-company hides applicability company_id column; multi-company shows it.
    const linesSingle = find(rootMounted.host, (n) => hasClass(n, 'lines'));
    const appHeadersSingle = allFind(linesSingle, (n) => n.tagName === 'TH').map((th) => th.textContent.trim()).filter(Boolean);
    assert.deepEqual(appHeadersSingle, ['Domain', 'Applicability', 'Accounts Prefix', 'Product Category']);

    const c2 = createCompany(db, { name: 'Alexandria Branch' });
    const multiDb = setCompanies(c2.db, { current: 1, allowed: [1, c2.id] });
    await rootMounted.commit(multiDb);
    await rootMounted.render();
    const linesMulti = find(rootMounted.host, (n) => hasClass(n, 'lines'));
    const appHeadersMulti = allFind(linesMulti, (n) => n.tagName === 'TH')
      .map((th) => th.textContent.trim()).filter(Boolean);
    assert.deepEqual(appHeadersMulti, ['Domain', 'Company', 'Applicability', 'Accounts Prefix', 'Product Category']);
  } finally {
    await rootMounted.done();
  }

  // Child plan hides Default Applicability and the Applicability tab.
  const childMounted = await mountView(
    (React) => React.createElement(FormView, { base: '#/accounting/analytic-plans', id: childPlan.id, leaf: plansLeaf(), params: new URLSearchParams() }),
    db,
  );
  try {
    assert.ok(!fieldLabelsOf(childMounted.host).includes('Default Applicability'));
    const tabLabels = allFind(childMounted.host, (n) => props(n)?.role === 'tab').map((n) => n.textContent.trim());
    assert.ok(!tabLabels.includes('Applicability'));
  } finally {
    await childMounted.done();
  }
});

test('account.analytic.plan guard blocks self-parenting and ancestor cycles', () => {
  let db = seed();
  const a = create(db, 'account.analytic.plan', { name: 'Plan A' });
  const b = create(a.db, 'account.analytic.plan', { name: 'Plan B', parent_id: a.id });
  const c = create(b.db, 'account.analytic.plan', { name: 'Plan C', parent_id: b.id });
  db = c.db;

  assert.throws(
    () => write(db, 'account.analytic.plan', a.id, { parent_id: a.id }),
    /A plan cannot be its own ancestor/,
  );
  assert.throws(
    () => write(db, 'account.analytic.plan', a.id, { parent_id: c.id }),
    /A plan cannot be its own ancestor/,
  );
});

test('account.analytic.account list columns, multi-company Company column, balance computation & footer sum, search and group-by', async () => {
  const def = models['account.analytic.account'];
  assert.equal(viewsOf('account.analytic.account')[0], 'list');
  assert.deepEqual(def.list, ['name', 'code', 'partner_id', 'plan_id', 'company_id', 'balance']);
  assert.ok(!def.list.includes('plan'));
  assert.equal(def.listLabels.name, 'Name');
  assert.deepEqual(def.searchFields, ['name', 'code', 'partner_id']);
  assert.deepEqual(def.groupBys, ['partner_id']);
  assert.equal(def.groupByLabels.partner_id, 'Associated Partner');

  let db = seed();
  const plan = create(db, 'account.analytic.plan', { name: 'Client Projects' });
  const acc1 = create(plan.db, 'account.analytic.account', { name: 'Tower Build', code: 'TWR-01', partner_id: 1, plan_id: plan.id });
  const acc2 = create(acc1.db, 'account.analytic.account', { name: 'Harbor Fitout', code: 'HRB-02', partner_id: 2, plan_id: plan.id });
  db = acc2.db;

  // Balance = credit - debit using analyticBalance helper via account.analytic.line (income +, cost -).
  db = create(db, 'account.analytic.line', { name: 'Revenue', date: '2026-10-01', account_id: acc1.id, amount: 1200, category: 'invoice' }).db;
  db = create(db, 'account.analytic.line', { name: 'Cost', date: '2026-10-02', account_id: acc1.id, amount: -450, category: 'vendor_bill' }).db;
  db = create(db, 'account.analytic.line', { name: 'Revenue 2', date: '2026-10-03', account_id: acc2.id, amount: 250, category: 'invoice' }).db;

  const readAcc1 = read(db, 'account.analytic.account', acc1.id);
  assert.equal(readAcc1.credit, 1200);
  assert.equal(readAcc1.debit, 450);
  assert.equal(readAcc1.balance, 750);
  // Shared master config stays visible to all when company_id omitted.
  assert.equal(readAcc1.company_id ?? null, null);

  // Search matches name, code, and partner name.
  const partner1Name = read(db, 'res.partner', 1).name;
  assert.equal(matches(db, 'account.analytic.account', readAcc1, ['Tower']), true);
  assert.equal(matches(db, 'account.analytic.account', readAcc1, ['TWR-01']), true);
  assert.equal(matches(db, 'account.analytic.account', readAcc1, [partner1Name]), true);
  assert.equal(matches(db, 'account.analytic.account', read(db, 'account.analytic.account', acc2.id), ['TWR-01']), false);

  const { ActionView } = await import('./views/ActionView.jsx');
  const mounted = await mountView(
    (React) => React.createElement(ActionView, { leaf: accountsLeaf(), base: '#/accounting/analytic', params: new URLSearchParams() }),
    db,
  );
  try {
    const singleTable = find(mounted.host, (n) => n.tagName === 'TABLE' && hasClass(n, 'list'));
    const singleHeaders = allFind(singleTable, (n) => n.tagName === 'TH' && !hasClass(n, 'o2m-cols-th'))
      .map((th) => th.textContent.replace(/[▲▼]/g, '').trim())
      .filter(Boolean);
    assert.deepEqual(singleHeaders, ['Name', 'Reference', 'Customer', 'Analytic Plan', 'Balance']);

    // Footer shows summed balance (750 + 250 = 1,000.00).
    const tfoot = find(singleTable, (n) => n.tagName === 'TFOOT');
    assert.ok(tfoot.textContent.includes('1,000.00'), `expected 1,000.00 in footer, got: ${tfoot.textContent}`);

    // Open search panel to verify Group By "Associated Partner".
    const toggleBtn = find(mounted.host, (n) => n.tagName === 'BUTTON' && hasClass(n, 'search-toggle'));
    await mounted.React.act(async () => props(toggleBtn).onClick());
    assert.ok(mounted.host.textContent.includes('Associated Partner'));

    // Multi-company reveals Company column.
    const c2 = createCompany(db, { name: 'Delta Co' });
    const multiDb = setCompanies(c2.db, { current: 1, allowed: [1, c2.id] });
    await mounted.commit(multiDb);
    await mounted.render();
    const multiTable = find(mounted.host, (n) => n.tagName === 'TABLE' && hasClass(n, 'list'));
    const multiHeaders = allFind(multiTable, (n) => n.tagName === 'TH' && !hasClass(n, 'o2m-cols-th'))
      .map((th) => th.textContent.replace(/[▲▼]/g, '').trim())
      .filter(Boolean);
    assert.deepEqual(multiHeaders, ['Name', 'Reference', 'Customer', 'Analytic Plan', 'Company', 'Balance']);
  } finally {
    await mounted.done();
  }
});

test('account.analytic.account form layout, Archived ribbon, Gross Margin stat button, company/currency gating and chatter', async () => {
  let db = seed();
  const plan = create(db, 'account.analytic.plan', { name: 'Delivery' });
  const acc = create(plan.db, 'account.analytic.account', { name: 'Port Project', code: 'PRT', partner_id: 1, plan_id: plan.id, active: false });
  db = create(acc.db, 'account.analytic.line', { name: 'Income', date: '2026-10-05', account_id: acc.id, amount: 500, category: 'invoice' }).db;

  // Turn off all extra currencies first to verify single-currency hides Currency.
  const companyCurrId = read(db, 'res.company', 1)?.currency_id;
  for (const c of search(db, 'res.currency')) {
    if (c.id !== companyCurrId && c.active !== false) db = write(db, 'res.currency', c.id, { active: false });
  }
  assert.equal(search(db, 'res.company').length, 1);

  const { FormView } = await import('./views/FormView.jsx');
  const mounted = await mountView(
    (React) => React.createElement(FormView, { base: '#/accounting/analytic', id: acc.id, leaf: accountsLeaf(), params: new URLSearchParams() }),
    db,
  );
  try {
    // Archived ribbon, Gross Margin smart button, titleLabel + placeholder, chatter.
    const ribbon = find(mounted.host, (n) => hasClass(n, 'ribbon'));
    assert.equal(ribbon?.textContent?.trim(), 'Archived');

    const grossBtn = find(mounted.host, (n) => hasClass(n, 'smart') && n.textContent.includes('Gross Margin'));
    assert.ok(grossBtn, 'Gross Margin stat button present');
    assert.ok(grossBtn.textContent.includes('500.00'));
    assert.equal(props(grossBtn)?.href, `#/accounting/analytic-items?view=list&rel=account_id:${acc.id}`);

    const titleWrap = find(mounted.host, (n) => hasClass(n, 'title-field'));
    assert.ok(titleWrap.textContent.includes('Analytic Account'), 'titleLabel rendered above title');
    const titleInput = find(titleWrap, (n) => n.tagName === 'INPUT');
    assert.equal(props(titleInput)?.placeholder, 'e.g. Project XYZ');

    assert.ok(find(mounted.host, (n) => hasClass(n, 'chatter')), 'chatter kept');

    // Single-company + single-currency hides Company and Currency.
    assert.deepEqual(fieldLabelsOf(mounted.host), ['Customer', 'Reference', 'Analytic Plan']);

    // Multi-company + multi-currency shows Company and Currency.
    const foreignCurr = search(db, 'res.currency', { includeArchived: true }).find((c) => c.id !== companyCurrId);
    const nextWithCurr = write(db, 'res.currency', foreignCurr.id, { active: true });
    const c2 = createCompany(nextWithCurr, { name: 'Second Co' });
    const nextDb = setCompanies(c2.db, { current: 1, allowed: [1, c2.id] });
    await mounted.commit(nextDb);
    await mounted.render();
    assert.deepEqual(fieldLabelsOf(mounted.host), ['Customer', 'Reference', 'Analytic Plan', 'Company', 'Currency']);
  } finally {
    await mounted.done();
  }
});

test('migration 46 backfills analytic plan sequences and Arabic labels resolve cleanly', async () => {
  assert.equal(SCHEMA_VERSION, 53);
  const legacy = {
    schema_version: 45,
    records: {
      'account.analytic.plan': [
        { id: 1, name: 'First' },
        { id: 2, name: 'Child', parent_id: 1 },
      ],
    },
  };
  const migrated = migrate(legacy);
  assert.equal(migrated.schema_version, 53);
  assert.equal(migrated.records['account.analytic.plan'][0].sequence, 10);
  assert.equal(migrated.records['account.analytic.plan'][0].default_applicability, 'optional');
  assert.equal(migrated.records['account.analytic.plan'][1].sequence, 20);
  assert.equal(migrate(migrated), migrated);

  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null) };
  try {
    const { t: tAr } = await import(`./i18n.js?ar=${Date.now()}`);
    for (const key of ['Analytic Plans', 'Subplans', 'Associated Partner', 'Gross Margin', 'e.g. Project XYZ', 'A plan cannot be its own ancestor', 'Visible to all', 'Currency']) {
      assert.notEqual(tAr(key), key, `Arabic translation missing for "${key}"`);
    }
  } finally {
    globalThis.localStorage = prevStorage;
  }
});
