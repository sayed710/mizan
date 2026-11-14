import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { create, matches, read, write } from './orm.js';
import { seed } from './seed.js';
import { menusFor, models, viewsOf } from './models/index.js';
import { findAnalyticDistribution, parseAccountPrefixes } from './models/analytic-distribution-models.js';
import { createCompany, setCompanies } from './models/company.js';

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

const distributionLeaf = () => findLeafByKey(menusFor('accounting'), 'analytic-distribution-models');

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

test('account.analytic.distribution.model list columns, optional flags, handle, no kanban, and default order', async () => {
  const def = models['account.analytic.distribution.model'];
  assert.deepEqual(viewsOf('account.analytic.distribution.model'), ['list']);
  assert.equal(def.kanban, undefined);
  assert.equal(def.editableList, undefined);
  assert.equal(def.fields.sequence.widget, 'handle');
  assert.deepEqual(def.list, [
    'sequence',
    'account_prefix',
    'partner_id',
    'partner_category_id',
    'product_id',
    'product_categ_id',
    'analytic_distribution',
  ]);
  assert.ok(!def.list.includes('company_id'));
  assert.deepEqual(def.listLabels, { account_prefix: 'Accounts Prefixes' });
  assert.deepEqual(def.listFields, {
    account_prefix: { optional: 'show' },
    partner_id: { optional: 'show' },
    partner_category_id: { optional: 'hide' },
    product_id: { optional: 'show' },
    product_categ_id: { optional: 'hide' },
    analytic_distribution: { optional: 'show' },
  });
  assert.deepEqual(def.searchFields, ['partner_id', 'product_id', 'account_prefix']);

  let db = seed();
  const partner = create(db, 'res.partner', { name: 'Alpha Partner' });
  const product = create(partner.db, 'product', { name: 'Alpha Service', type: 'service' });
  const analytic = create(product.db, 'account.analytic.account', { name: 'Ops Analytic' });
  const r1 = create(analytic.db, 'account.analytic.distribution.model', {
    sequence: 10,
    account_prefix: '601',
    partner_id: partner.id,
    analytic_distribution: { [analytic.id]: 100 },
  });
  const r2 = create(r1.db, 'account.analytic.distribution.model', {
    sequence: 10,
    account_prefix: '602',
    product_id: product.id,
    analytic_distribution: { [analytic.id]: 100 },
  });
  const r3 = create(r2.db, 'account.analytic.distribution.model', {
    sequence: 5,
    account_prefix: '605',
    analytic_distribution: { [analytic.id]: 100 },
  });
  db = r3.db;

  const { visibleListColumns, ActionView } = await Promise.all([import('./views/List.jsx'), import('./views/ActionView.jsx')])
    .then(([l, a]) => ({ visibleListColumns: l.visibleListColumns, ActionView: a.ActionView }));

  const { cols, optionalCols } = visibleListColumns(def, db, {}, { listFields: def.listFields });
  assert.deepEqual(cols, ['sequence', 'account_prefix', 'partner_id', 'product_id', 'analytic_distribution']);
  assert.deepEqual(optionalCols.map(([k]) => k), [
    'account_prefix',
    'partner_id',
    'partner_category_id',
    'product_id',
    'product_categ_id',
    'analytic_distribution',
  ]);

  const mounted = await mountView(
    (React) => React.createElement(ActionView, {
      leaf: distributionLeaf(),
      base: '#/accounting/analytic-distribution-models',
      params: new URLSearchParams(),
    }),
    db,
  );
  try {
    const table = find(mounted.host, (n) => n.tagName === 'TABLE' && hasClass(n, 'list'));
    assert.ok(table, 'opens in list view');
    const headers = allFind(table, (n) => n.tagName === 'TH' && !hasClass(n, 'o2m-cols-th'))
      .map((th) => th.textContent.replace(/[▲▼]/g, '').trim())
      .filter(Boolean);
    assert.deepEqual(headers, ['Accounts Prefixes', 'Partner', 'Product', 'Analytic Distribution']);

    const tbody = find(table, (n) => n.tagName === 'TBODY');
    const rows = allFind(tbody, (n) => n.tagName === 'TR');
    assert.ok(find(rows[0], (n) => hasClass(n, 'drag-handle')), 'renders sequence drag handle');
    // Sequence 5 first, then sequence 10 newest id first (r2 id > r1 id).
    const prefixesInOrder = rows.map((tr) => allFind(tr, (n) => n.tagName === 'TD')[2]?.textContent?.trim());
    assert.deepEqual(prefixesInOrder, ['605', '602', '601']);

    // Search works for Partner, Product and Accounts Prefixes.
    assert.equal(matches(db, 'account.analytic.distribution.model', read(db, 'account.analytic.distribution.model', r1.id), ['Alpha Partner'], def.searchFields), true);
    assert.equal(matches(db, 'account.analytic.distribution.model', read(db, 'account.analytic.distribution.model', r2.id), ['Alpha Service'], def.searchFields), true);
    assert.equal(matches(db, 'account.analytic.distribution.model', read(db, 'account.analytic.distribution.model', r3.id), ['605'], def.searchFields), true);
    assert.equal(matches(db, 'account.analytic.distribution.model', read(db, 'account.analytic.distribution.model', r3.id), ['999'], def.searchFields), false);
  } finally {
    await mounted.done();
  }
});

test('account.analytic.distribution.model form layout, labels, help texts, hidden company, and no chatter/title', async () => {
  const def = models['account.analytic.distribution.model'];
  assert.equal(def.form.hideTitle, true);
  assert.equal(def.form.chatter, undefined);
  assert.equal(def.fields.partner_id.label, 'Partner');
  assert.equal(
    def.fields.partner_id.help,
    'Select a partner for which the analytic distribution will be used (e.g. create new customer invoice or Sales order if we select this partner, it will automatically take this as an analytic account)',
  );
  assert.equal(def.fields.partner_category_id.type, 'char');
  assert.equal(def.fields.partner_category_id.label, 'Partner Category');
  assert.equal(
    def.fields.partner_category_id.help,
    'Select a partner category for which the analytic distribution will be used (e.g. create new customer invoice or Sales order if we select this partner category, it will automatically take this as an analytic account)',
  );
  assert.equal(def.fields.product_id.label, 'Product');
  assert.equal(
    def.fields.product_id.help,
    'Select a product for which the analytic distribution will be used (e.g. create new customer invoice or Sales order if we select this product, it will automatically take this as an analytic account)',
  );
  assert.equal(def.fields.product_categ_id.label, 'Product Category');
  assert.equal(
    def.fields.product_categ_id.help,
    'Select a product category which will use analytic account specified in analytic default (e.g. create new customer invoice or Sales order if we select this product, it will automatically take this as an analytic account)',
  );
  assert.equal(def.fields.account_prefix.label, 'Accounts Prefix');
  assert.equal(
    def.fields.account_prefix.help,
    'This analytic distribution will apply to all financial accounts sharing the prefix specified.',
  );
  assert.equal(def.fields.company_id.label, 'Company');
  assert.equal(def.fields.analytic_distribution.label, 'Analytic Distribution');
  assert.equal(def.fields.analytic_distribution.required, true);

  let db = seed();
  const second = createCompany(db, { name: 'Second Analytic Co' });
  db = setCompanies(second.db, { current: second.id, allowed: [1, second.id] });
  const analytic = create(db, 'account.analytic.account', { name: 'Second Co Analytic', company_id: second.id });
  const rule = create(analytic.db, 'account.analytic.distribution.model', {
    account_prefix: '600',
    company_id: second.id,
    analytic_distribution: { [analytic.id]: 100 },
  });
  db = rule.db;

  const { FormView } = await import('./views/FormView.jsx');
  const mounted = await mountView(
    (React) => React.createElement(FormView, {
      leaf: distributionLeaf(),
      id: rule.id,
      base: '#/accounting/analytic-distribution-models',
      params: new URLSearchParams('view=form'),
    }),
    db,
  );
  try {
    assert.equal(find(mounted.host, (n) => hasClass(n, 'title-field')), null, 'form has no title field');
    assert.equal(find(mounted.host, (n) => n.tagName === 'ASIDE' && hasClass(n, 'chatter')), null, 'form has no chatter');
    assert.equal(find(mounted.host, (n) => props(n)?.id === 'f-company_id'), null, 'company_id is not shown on the form');

    const groups = allFind(mounted.host, (n) => n.tagName === 'DIV' && hasClass(n, 'group'));
    assert.equal(groups.length, 3);
    assert.deepEqual(
      allFind(mounted.host, (n) => hasClass(n, 'group-title')).map((n) => n.textContent.trim()),
      ['Conditions to meet', 'Distribution to apply'],
    );
    assert.deepEqual(fieldLabelsOf(groups[0]), ['Partner', 'Partner Category', 'Accounts Prefixes']);
    assert.deepEqual(fieldLabelsOf(groups[1]), ['Product', 'Product Category']);
    assert.deepEqual(fieldLabelsOf(groups[2]), ['Analytic Distribution']);
    assert.equal(hasClass(groups[2], 'group-full'), false, 'Distribution to apply is half width');

    const helps = allFind(mounted.host, (n) => hasClass(n, 'field-help')).map((n) => n.textContent.trim());
    assert.deepEqual(helps, [
      def.fields.partner_id.help,
      def.fields.partner_category_id.help,
      def.fields.account_prefix.help,
      def.fields.product_id.help,
      def.fields.product_categ_id.help,
    ]);
  } finally {
    await mounted.done();
  }
});

test('account.analytic.distribution.model validates analytic account company before writing', () => {
  let db = seed();
  const second = createCompany(db, { name: 'Rival Co' });
  db = second.db;
  const co1Analytic = create(db, 'account.analytic.account', { name: 'Co1 Project', company_id: 1 });
  const co2Analytic = create(co1Analytic.db, 'account.analytic.account', { name: 'Co2 Project', company_id: second.id });
  const sharedAnalytic = create(co2Analytic.db, 'account.analytic.account', { name: 'Shared Project' });
  db = sharedAnalytic.db;

  assert.throws(
    () => create(db, 'account.analytic.distribution.model', {
      company_id: 1,
      analytic_distribution: { [co2Analytic.id]: 100 },
    }),
    /must belong to the model company/,
  );

  const valid = create(db, 'account.analytic.distribution.model', {
    company_id: 1,
    analytic_distribution: { [co1Analytic.id]: 60, [sharedAnalytic.id]: 40 },
  });
  assert.throws(
    () => write(valid.db, 'account.analytic.distribution.model', valid.id, { company_id: second.id }),
    /must belong to the model company/,
  );
  assert.throws(
    () => write(valid.db, 'account.analytic.distribution.model', valid.id, { analytic_distribution: { [co2Analytic.id]: 100 } }),
    /must belong to the model company/,
  );

  // Model without company_id allows any valid analytic account.
  const crossCo = create(valid.db, 'account.analytic.distribution.model', {
    company_id: null,
    analytic_distribution: { [co2Analytic.id]: 100 },
  });
  assert.deepEqual(read(crossCo.db, 'account.analytic.distribution.model', crossCo.id).analytic_distribution, { [co2Analytic.id]: 100 });
});

test('findAnalyticDistribution supports comma and semicolon multi-prefixes and preserves single-condition specificity', () => {
  assert.deepEqual(parseAccountPrefixes('600, 610; 620 , ; '), ['600', '610', '620']);
  assert.deepEqual(parseAccountPrefixes(' , ; '), []);

  let db = seed();
  const plan = create(db, 'account.analytic.plan', { name: 'Test Plan' });
  const accA = create(plan.db, 'account.analytic.account', { name: 'Analytic A', plan_id: plan.id });
  const accB = create(accA.db, 'account.analytic.account', { name: 'Analytic B', plan_id: plan.id });
  const partner = create(accB.db, 'res.partner', { name: 'Specific Partner' });
  const product = create(partner.db, 'product', { name: 'Specific Product', type: 'service' });
  db = product.db;

  const multiRule = create(db, 'account.analytic.distribution.model', {
    account_prefix: '600, 610; 620 , ; ',
    company_id: 1,
    sequence: 5,
    analytic_distribution: { [accA.id]: 100 },
  });
  db = multiRule.db;

  assert.deepEqual(findAnalyticDistribution(db, { account_code: '600100', company_id: 1 }), { [accA.id]: 100 });
  assert.deepEqual(findAnalyticDistribution(db, { account_code: '610200', company_id: 1 }), { [accA.id]: 100 });
  assert.deepEqual(findAnalyticDistribution(db, { account_code: '620999', company_id: 1 }), { [accA.id]: 100 });
  assert.deepEqual(findAnalyticDistribution(db, { account_code: '400000', company_id: 1 }), {});
  assert.deepEqual(findAnalyticDistribution(db, { company_id: 1 }), {});

  // Multi-prefix counts as ONE condition (same specificity as single prefix), so 2 conditions (partner + product) beat multi-prefix (1 condition).
  const specificRule = create(db, 'account.analytic.distribution.model', {
    partner_id: partner.id,
    product_id: product.id,
    company_id: 1,
    sequence: 20,
    analytic_distribution: { [accB.id]: 100 },
  });
  assert.deepEqual(
    findAnalyticDistribution(specificRule.db, {
      partner_id: partner.id,
      product_id: product.id,
      account_code: '610200',
      company_id: 1,
    }),
    { [accB.id]: 100 },
  );

  // Separator-only account_prefix is ignored and does not boost score.
  const blankPrefixRule = create(db, 'account.analytic.distribution.model', {
    partner_id: partner.id,
    account_prefix: ' , ; ',
    company_id: 1,
    sequence: 1,
    analytic_distribution: { [accB.id]: 100 },
  });
  const partnerAndRealPrefix = create(blankPrefixRule.db, 'account.analytic.distribution.model', {
    partner_id: partner.id,
    account_prefix: '610',
    company_id: 1,
    sequence: 20,
    analytic_distribution: { [accA.id]: 100 },
  });
  assert.deepEqual(
    findAnalyticDistribution(partnerAndRealPrefix.db, {
      partner_id: partner.id,
      account_code: '610200',
      company_id: 1,
    }),
    { [accA.id]: 100 },
  );
});

test('Arabic i18n translates all Analytic Distribution Model labels, groups, and help texts', async () => {
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem() {} };
  try {
    const { t } = await import(`./i18n.js?ar-dist-parity=${Date.now()}`);
    const def = models['account.analytic.distribution.model'];
    const keys = [
      def.label,
      ...Object.values(def.fields).flatMap((f) => [f.label, f.help].filter(Boolean)),
      def.listLabels.account_prefix,
      'Conditions to meet',
      'Distribution to apply',
      'Analytic accounts in the distribution must belong to the model company',
    ];
    for (const key of keys) {
      assert.notEqual(t(key), key, `missing Arabic translation for: ${key}`);
    }
  } finally {
    globalThis.localStorage = prevStorage;
  }
});
