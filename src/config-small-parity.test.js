import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { create, search, write } from './orm.js';
import { seed } from './seed.js';
import { menusFor, models, viewsOf } from './models/index.js';

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

const leafFor = (key) => findLeafByKey(menusFor('accounting'), key);

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

test('incoterms: list-first view, columns, form layout, archived ribbon, and search', async () => {
  const def = models['account.incoterm'];
  assert.deepEqual(viewsOf('account.incoterm'), ['list']);
  assert.deepEqual(def.list, ['code', 'name']);
  assert.deepEqual(def.searchFields, ['name']);
  assert.equal(def.fields.name.required, true);
  assert.equal(def.fields.code.required, true);
  assert.equal(
    def.fields.name.help,
    'Incoterms are series of sales terms. They are used to divide transaction costs and responsibilities between buyer and seller and reflect state-of-the-art transportation practices.',
  );
  assert.equal(def.fields.code.help, 'Incoterm Standard Code');
  assert.equal(def.fields.active.help, 'By unchecking the active field, you may hide an INCOTERM you will not use.');

  let db = seed();
  const fob = search(db, 'account.incoterm').find((i) => i.code === 'FOB');
  db = write(db, 'account.incoterm', fob.id, { active: false });

  const { ActionView } = await import('./views/ActionView.jsx');
  const { FormView } = await import('./views/FormView.jsx');

  const listCtx = await mountView(
    (React) => React.createElement(ActionView, { leaf: leafFor('incoterms'), base: '#/accounting/incoterms', params: new URLSearchParams() }),
    db,
  );
  try {
    const table = find(listCtx.host, (n) => n.tagName === 'TABLE' && hasClass(n, 'list'));
    assert.ok(table, 'opens in list view');
    const headers = allFind(table, (n) => n.tagName === 'TH').map((th) => th.textContent.replace(/[▲▼]/g, '').trim()).filter(Boolean);
    assert.deepEqual(headers, ['Code', 'Name']);
    assert.ok(!table.textContent.includes('Free On Board'), 'archived incoterm hidden by default');

    const toggle = find(listCtx.host, (n) => n.tagName === 'BUTTON' && hasClass(n, 'search-toggle'));
    await listCtx.React.act(async () => { props(toggle).onClick(); });
    const archivedBtn = find(listCtx.host, (n) => n.tagName === 'BUTTON' && n.textContent.trim() === 'Archived');
    await listCtx.React.act(async () => { props(archivedBtn).onClick(); });
    assert.ok(table.textContent.includes('Free On Board'), 'archived incoterm reachable via Archived toggle');
  } finally {
    await listCtx.done();
  }

  const formCtx = await mountView(
    (React) => React.createElement(FormView, { leaf: leafFor('incoterms'), id: String(fob.id), base: '#/accounting/incoterms', params: new URLSearchParams('view=list') }),
    db,
  );
  try {
    assert.equal(find(formCtx.host, (n) => hasClass(n, 'title-field')), null, 'no separate title field');
    assert.deepEqual(fieldLabelsOf(formCtx.host), ['Name', 'Code']);
    const ribbon = find(formCtx.host, (n) => hasClass(n, 'ribbon'));
    assert.equal(ribbon?.textContent?.trim(), 'Archived');
  } finally {
    await formCtx.done();
  }
});

test('archived incoterms are excluded from many2one pickers on new documents', async () => {
  let db = seed();
  const fob = search(db, 'account.incoterm').find((i) => i.code === 'FOB');
  const cif = search(db, 'account.incoterm').find((i) => i.code === 'CIF');
  const archivedDb = write(db, 'account.incoterm', fob.id, { active: false });

  const { FormView } = await import('./views/FormView.jsx');
  const { menusFor: allMenus } = await import('./models/index.js');
  const invoiceLeaf = findLeafByKey(allMenus('accounting'), 'invoices');
  const quoteLeaf = findLeafByKey(allMenus('sales'), 'quotations');
  const rfqLeaf = findLeafByKey(allMenus('purchase'), 'rfq');

  for (const [leaf, base, tabLabel] of [
    [invoiceLeaf, '#/accounting/invoices', 'Other Info'],
    [quoteLeaf, '#/sales/quotations', null],
    [rfqLeaf, '#/purchase/rfq', null],
  ]) {
    const ctx = await mountView(
      (React) => React.createElement(FormView, { leaf, id: 'new', base, params: new URLSearchParams('view=list') }),
      archivedDb,
    );
    try {
      if (tabLabel) {
        const tabBtn = find(ctx.host, (n) => n.tagName === 'BUTTON' && props(n)?.role === 'tab' && n.textContent.trim() === tabLabel);
        await ctx.React.act(async () => { props(tabBtn).onClick(); });
      }
      const select = find(ctx.host, (n) => n.tagName === 'SELECT' && props(n)?.id === 'f-incoterm_id');
      assert.ok(select, `${leaf.model} renders incoterm_id select`);
      const options = allFind(select, (n) => n.tagName === 'OPTION').map((o) => o.textContent);
      assert.ok(options.some((t) => t.includes(cif.name)), `${leaf.model} includes active incoterm`);
      assert.ok(!options.some((t) => t.includes(fob.name)), `${leaf.model} excludes archived incoterm`);
    } finally {
      await ctx.done();
    }
  }

  // Existing document referencing an archived incoterm keeps its current value selectable/displayed
  const existingInv = create(db, 'account.move', { move_type: 'out_invoice', partner_id: search(db, 'res.partner')[0].id, incoterm_id: fob.id });
  const existingDb = write(existingInv.db, 'account.incoterm', fob.id, { active: false });
  const existingCtx = await mountView(
    (React) => React.createElement(FormView, { leaf: invoiceLeaf, id: String(existingInv.id), base: '#/accounting/invoices', params: new URLSearchParams('view=list') }),
    existingDb,
  );
  try {
    const tabBtn = find(existingCtx.host, (n) => n.tagName === 'BUTTON' && props(n)?.role === 'tab' && n.textContent.trim() === 'Other Info');
    await existingCtx.React.act(async () => { props(tabBtn).onClick(); });
    const select = find(existingCtx.host, (n) => n.tagName === 'SELECT' && props(n)?.id === 'f-incoterm_id');
    const options = allFind(select, (n) => n.tagName === 'OPTION').map((o) => o.textContent);
    assert.ok(options.some((t) => t.includes(fob.name)), 'existing document retains its archived incoterm');
  } finally {
    await existingCtx.done();
  }
});

test('fiscal years: list-first view, Odoo labels/help/placeholder, multi-company gating, form layout, and date range guard', async () => {
  const def = models['account.fiscal.year'];
  assert.equal(viewsOf('account.fiscal.year')[0], 'list');
  assert.deepEqual(def.list, ['name', 'date_from', 'date_to', 'company_id']);
  assert.deepEqual(def.searchFields, ['name']);
  assert.equal(def.fields.name.label, 'Name');
  assert.equal(def.fields.name.placeholder, 'Fiscal Year 2018');
  assert.equal(def.fields.date_from.label, 'Start Date');
  assert.equal(def.fields.date_from.help, 'Start Date, included in the fiscal year.');
  assert.equal(def.fields.date_to.label, 'End Date');
  assert.equal(def.fields.date_to.help, 'Ending Date, included in the fiscal year.');
  assert.equal(def.fields.company_id.multiCompanyOnly, true);

  const singleDb = create(seed(), 'account.fiscal.year', { name: 'FY 2027', date_from: '2027-01-01', date_to: '2027-12-31' }).db;
  assert.throws(
    () => create(singleDb, 'account.fiscal.year', { name: 'Bad FY', date_from: '2028-12-31', date_to: '2028-01-01' }),
    /valid fiscal year date range/,
  );

  const { ActionView } = await import('./views/ActionView.jsx');
  const { FormView } = await import('./views/FormView.jsx');
  const leaf = leafFor('fiscal-years');

  const singleList = await mountView(
    (React) => React.createElement(ActionView, { leaf, base: '#/accounting/fiscal-years', params: new URLSearchParams() }),
    singleDb,
  );
  try {
    const table = find(singleList.host, (n) => n.tagName === 'TABLE' && hasClass(n, 'list'));
    assert.ok(table, 'opens in list view');
    const headers = allFind(table, (n) => n.tagName === 'TH').map((th) => th.textContent.replace(/[▲▼]/g, '').trim()).filter(Boolean);
    assert.deepEqual(headers, ['Name', 'Start Date', 'End Date']);
  } finally {
    await singleList.done();
  }

  const multiDb = create(singleDb, 'res.company', { name: 'Branch Co' }).db;
  const multiList = await mountView(
    (React) => React.createElement(ActionView, { leaf, base: '#/accounting/fiscal-years', params: new URLSearchParams() }),
    multiDb,
  );
  try {
    const table = find(multiList.host, (n) => n.tagName === 'TABLE' && hasClass(n, 'list'));
    const headers = allFind(table, (n) => n.tagName === 'TH').map((th) => th.textContent.replace(/[▲▼]/g, '').trim()).filter(Boolean);
    assert.deepEqual(headers, ['Name', 'Start Date', 'End Date', 'Company']);
  } finally {
    await multiList.done();
  }

  const fyId = search(singleDb, 'account.fiscal.year')[0].id;
  const singleForm = await mountView(
    (React) => React.createElement(FormView, { leaf, id: String(fyId), base: '#/accounting/fiscal-years', params: new URLSearchParams('view=list') }),
    singleDb,
  );
  try {
    assert.equal(find(singleForm.host, (n) => hasClass(n, 'title-field')), null, 'name not duplicated as title');
    assert.deepEqual(fieldLabelsOf(singleForm.host), ['Name', 'Start Date', 'End Date', 'Closing Entry', 'Reopening Entry']);
    assert.ok(find(singleForm.host, (n) => hasClass(n, 'statusbar')), 'Mizan statusbar retained');
    assert.ok(find(singleForm.host, (n) => n.tagName === 'BUTTON' && n.textContent.trim() === 'Close Year'), 'Mizan Close Year button retained');
  } finally {
    await singleForm.done();
  }

  const multiForm = await mountView(
    (React) => React.createElement(FormView, { leaf, id: String(fyId), base: '#/accounting/fiscal-years', params: new URLSearchParams('view=list') }),
    multiDb,
  );
  try {
    assert.deepEqual(fieldLabelsOf(multiForm.host), ['Name', 'Start Date', 'End Date', 'Company', 'Closing Entry', 'Reopening Entry']);
  } finally {
    await multiForm.done();
  }
});

test('account tags: single definition, list columns, conditional Country, ribbon, and guard', async () => {
  const accountingSrc = readFileSync(new URL('./models/accounting.js', import.meta.url), 'utf8');
  assert.equal((accountingSrc.match(/'account\.account\.tag':\s*\{/g) ?? []).length, 1, 'only one account.account.tag definition exists');

  const def = models['account.account.tag'];
  assert.deepEqual(viewsOf('account.account.tag'), ['list']);
  assert.deepEqual(def.list, ['name', 'applicability', 'country', 'color']);
  assert.deepEqual(def.searchFields, ['name']);
  assert.equal(def.fields.applicability.required, true);
  assert.equal(def.fields.active.help, 'Set active to false to hide the Account Tag without removing it.');
  assert.equal(def.fields.country.type, 'char');
  assert.equal(def.fields.country.help, 'Country for which this tag is available, when applied on taxes.');

  let db = seed();
  const accTag = create(db, 'account.account.tag', { name: 'Audit Tag', applicability: 'accounts', color: 3 });
  db = accTag.db;
  const account = search(db, 'account.account')[0];
  db = write(db, 'account.account', account.id, { tag_ids: [accTag.id] });
  assert.throws(() => write(db, 'account.account.tag', accTag.id, { applicability: 'taxes' }), /cannot change applicability/);

  const archivedTag = create(db, 'account.account.tag', { name: 'Archived Tax Tag', applicability: 'taxes', country: 'EG', active: false, color: 5 });
  db = archivedTag.db;

  const { ActionView } = await import('./views/ActionView.jsx');
  const { FormView } = await import('./views/FormView.jsx');
  const leaf = leafFor('account-tags');

  const listCtx = await mountView(
    (React) => React.createElement(ActionView, { leaf, base: '#/accounting/account-tags', params: new URLSearchParams() }),
    db,
  );
  try {
    const table = find(listCtx.host, (n) => n.tagName === 'TABLE' && hasClass(n, 'list'));
    assert.ok(table, 'opens in list view');
    const headers = allFind(table, (n) => n.tagName === 'TH').map((th) => th.textContent.replace(/[▲▼]/g, '').trim()).filter(Boolean);
    assert.deepEqual(headers, ['Tag Name', 'Applicability', 'Country', 'Color']);
  } finally {
    await listCtx.done();
  }

  const accForm = await mountView(
    (React) => React.createElement(FormView, { leaf, id: String(accTag.id), base: '#/accounting/account-tags', params: new URLSearchParams('view=list') }),
    db,
  );
  try {
    assert.equal(find(accForm.host, (n) => hasClass(n, 'title-field')), null, 'name not duplicated as title');
    assert.deepEqual(fieldLabelsOf(accForm.host), ['Tag Name', 'Applicability', 'Cash Flow Activity']);
    const select = find(accForm.host, (n) => n.tagName === 'SELECT' && props(n)?.id === 'f-applicability');
    await accForm.React.act(async () => { props(select).onChange({ target: { value: 'taxes' } }); });
    assert.deepEqual(fieldLabelsOf(accForm.host), ['Tag Name', 'Applicability', 'Country', 'Cash Flow Activity']);
  } finally {
    await accForm.done();
  }

  const taxForm = await mountView(
    (React) => React.createElement(FormView, { leaf, id: String(archivedTag.id), base: '#/accounting/account-tags', params: new URLSearchParams('view=list') }),
    db,
  );
  try {
    assert.deepEqual(fieldLabelsOf(taxForm.host), ['Tag Name', 'Applicability', 'Country', 'Cash Flow Activity']);
    const ribbon = find(taxForm.host, (n) => hasClass(n, 'ribbon'));
    assert.equal(ribbon?.textContent?.trim(), 'Archived');
  } finally {
    await taxForm.done();
  }
});

test('Arabic translations cover Incoterms, Fiscal Years, and Account Tags labels, helps, and placeholders', async () => {
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem: () => {}, removeItem: () => {}, clear: () => {} };
  try {
    const { t } = await import('./i18n.js?lang=ar-config-small-parity');
    const strings = [
      'Incoterms', 'Name', 'Code', 'Active',
      'Incoterms are series of sales terms. They are used to divide transaction costs and responsibilities between buyer and seller and reflect state-of-the-art transportation practices.',
      'Incoterm Standard Code',
      'By unchecking the active field, you may hide an INCOTERM you will not use.',
      'Fiscal Years', 'Fiscal Year 2018', 'Start Date', 'End Date', 'Company',
      'Start Date, included in the fiscal year.',
      'Ending Date, included in the fiscal year.',
      'Account Tags', 'Tag Name', 'Applicability', 'Country', 'Color',
      'Cash Flow Activity', 'Operating', 'Investing', 'Financing', 'Archived',
      'Set active to false to hide the Account Tag without removing it.',
      'Country for which this tag is available, when applied on taxes.',
    ];
    for (const s of strings) {
      assert.notEqual(t(s), s, `missing Arabic translation for "${s}"`);
    }
  } finally {
    globalThis.localStorage = prevStorage;
  }
});
