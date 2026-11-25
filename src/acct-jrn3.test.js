import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { applyFilters, create, matches, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { menusFor, models, viewsOf } from './models/index.js';
import { createCompany, setCompanies } from './models/company.js';
import { ensureBankSuspense } from './models/ledger.js';
import { journalCards } from './models/finance.js';
import { applyDiff, diffDb } from './sync.js';

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

const journalsLeaf = () => findLeafByKey(menusFor('accounting'), 'journals');

async function mountView(renderElement, initialDb = seed()) {
  const prevStorage = globalThis.localStorage;
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
    clear: () => { mem.clear(); },
  };
  const { makeEl } = setupDom();
  globalThis.document.createElementNS = (_ns, tag) => makeEl(tag);
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit, getDb } = await import('./store.js');
  await initStore();
  await commit(initialDb);
  const host = globalThis.document.createElement('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  await React.act(async () => root.render(renderElement(React)));
  return {
    React,
    host,
    getDb,
    done: async () => {
      await React.act(async () => root.unmount());
      globalThis.localStorage = prevStorage;
    },
  };
}

test('JRN-1: Journals menu opens in list view first with kanban switcher intact and dashboard kanban unchanged', async () => {
  const leaf = journalsLeaf();
  assert.equal(leaf?.model, 'account.journal');
  assert.equal(leaf?.view, 'list');
  assert.deepEqual(viewsOf('account.journal'), ['list', 'kanban']);

  const { ActionView } = await import('./views/ActionView.jsx');
  const { Dashboard } = await import('./views/Dashboard.jsx');
  const db = seed();

  const ctx = await mountView(
    (React) => React.createElement(ActionView, { leaf, base: '#/accounting/journals', params: new URLSearchParams() }),
    db,
  );
  try {
    const table = find(ctx.host, (n) => n.tagName === 'TABLE' && hasClass(n, 'list'));
    assert.ok(table, 'Journals menu opens in list view by default');
    const switcher = find(ctx.host, (n) => hasClass(n, 'switcher'));
    const links = allFind(switcher, (n) => n.tagName === 'A');
    assert.deepEqual(links.map((a) => props(a)?.['aria-label']), ['list', 'kanban']);
    assert.equal(hasClass(links[0], 'active'), true);
    assert.equal(hasClass(links[1], 'active'), false);
  } finally {
    await ctx.done();
  }

  // Accounting dashboard kanban cards remain intact
  const dashCtx = await mountView((React) => React.createElement(Dashboard), db);
  try {
    const cards = allFind(dashCtx.host, (n) => n.tagName === 'SECTION' && hasClass(n, 'journal-card'));
    assert.equal(cards.length, journalCards(db).length);
  } finally {
    await dashCtx.done();
  }
});

test('JRN-2: journal search limits text matching to name/code and exposes Odoo type + Archived filters', async () => {
  const def = models['account.journal'];
  assert.deepEqual(def.searchFields, ['name', 'code']);

  let db = seed();
  const invJ = search(db, 'account.journal').find((j) => j.code === 'INV');
  const bankJ = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  const miscJ = search(db, 'account.journal').find((j) => j.code === 'MISC');
  const archived = create(db, 'account.journal', {
    name: 'Old Archived Bank',
    code: 'OBNK',
    type: 'bank',
    company_id: 1,
    suspense_account_id: ensureBankSuspense(db, 1).id,
    active: false,
  });
  db = archived.db;

  // Name/code filter_domain matching
  assert.equal(matches(db, 'account.journal', invJ, ['Customer Invoices']), true);
  assert.equal(matches(db, 'account.journal', invJ, ['INV']), true);
  assert.equal(matches(db, 'account.journal', bankJ, ['BNK1']), true);
  // Fields outside name/code (e.g. bank_statements_source or sequence prefix not equal to code) do not match
  assert.equal(matches(db, 'account.journal', bankJ, ['file_import']), false);
  assert.equal(matches(db, 'account.journal', miscJ, ['general']), false);

  // Sync guard round-trip via diffDb + applyDiff
  const archivedEdit = write(db, 'account.journal', archived.id, { active: true });
  const synced = applyDiff(db, diffDb(db, archivedEdit), { isAdmin: true });
  assert.equal(read(synced, 'account.journal', archived.id).active, true);

  // UI search panel filters & search input
  const { ActionView } = await import('./views/ActionView.jsx');
  const ctx = await mountView(
    (React) => React.createElement(ActionView, { leaf: journalsLeaf(), base: '#/accounting/journals', params: new URLSearchParams() }),
    db,
  );
  try {
    assert.ok(!ctx.host.textContent.includes('Old Archived Bank'), 'archived journal hidden by default');

    const toggle = find(ctx.host, (n) => n.tagName === 'BUTTON' && hasClass(n, 'search-toggle'));
    await ctx.React.act(async () => { props(toggle).onClick(); });

    const panel = find(ctx.host, (n) => hasClass(n, 'search-panel'));
    const filterButtons = allFind(panel, (n) => n.tagName === 'BUTTON' && !hasClass(n, 'link')).map((b) => b.textContent.trim());
    for (const expected of ['Sales', 'Purchases', 'Liquidity', 'Miscellaneous', 'Archived']) {
      assert.ok(filterButtons.includes(expected), `missing search filter ${expected}`);
    }

    // Archived filter reveals archived journal only
    const archivedBtn = allFind(panel, (n) => n.tagName === 'BUTTON').find((b) => b.textContent.trim() === 'Archived');
    await ctx.React.act(async () => { props(archivedBtn).onClick(); });
    assert.ok(ctx.host.textContent.includes('Old Archived Bank'));
    assert.ok(!ctx.host.textContent.includes(invJ.name));

    // Uncheck Archived, filter by Sales, and search by code 'INV'
    await ctx.React.act(async () => { props(archivedBtn).onClick(); });
    const salesBtn = allFind(ctx.host, (n) => n.tagName === 'BUTTON').find((b) => b.textContent.trim() === 'Sales');
    await ctx.React.act(async () => { props(salesBtn).onClick(); });
    assert.ok(ctx.host.textContent.includes(invJ.name));
    assert.ok(!ctx.host.textContent.includes(bankJ.name));

    const input = find(ctx.host, (n) => n.tagName === 'INPUT' && props(n)?.placeholder === 'Search...');
    await ctx.React.act(async () => { props(input).onChange({ target: { value: 'INV' } }); });
    await ctx.React.act(async () => { props(input).onKeyDown({ key: 'Enter' }); });
    assert.ok(ctx.host.textContent.includes(invJ.name));

    // Liquidity filter includes bank, cash, and credit journals
    const allJournals = search(db, 'account.journal');
    assert.deepEqual(
      applyFilters('account.journal', allJournals, ['liquidity'], db).map((j) => j.type).sort(),
      ['bank', 'cash'],
    );
  } finally {
    await ctx.done();
  }
});

test('JRN-3: form smart button opens the journal items and list optional/group-gated columns match Odoo', async () => {
  const def = models['account.journal'];
  assert.deepEqual(def.list, ['sequence', 'name', 'type', 'code', 'default_account_id', 'currency_id', 'active', 'company_id']);
  assert.equal(def.fields.sequence.widget, 'handle');
  assert.equal(def.fields.code.optional, 'show');
  assert.equal(def.fields.default_account_id.optional, 'show');
  assert.equal(def.fields.active.optional, 'hide');
  assert.equal(def.fields.company_id.multiCompanyOnly, true);
  assert.equal(def.fields.company_id.optional, 'hide');
  // jcf1 adds the optional journal currency column; JRN-1/JRN-2 declares journal_group_id on account.journal
  assert.equal(def.fields.currency_id.type, 'many2one');
  assert.equal(def.fields.currency_id.relation, 'res.currency');
  assert.equal(def.fields.currency_id.optional, 'hide');
  assert.equal(Object.hasOwn(def.fields, 'journal_group_id'), true);

  let db = seed();
  const saleJ = search(db, 'account.journal').find((j) => j.code === 'INV');
  const purchJ = search(db, 'account.journal').find((j) => j.code === 'BILL');
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: search(db, 'res.partner')[0].id,
    journal_id: saleJ.id,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  const otherBill = create(inv.db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: search(inv.db, 'res.partner')[0].id,
    journal_id: purchJ.id,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 50, tax: 0 }],
  });
  const { postMove } = await import('./models/accounting.js');
  const { journalItems } = await import('./models/ledger.js');
  db = postMove(otherBill.db, inv.id);
  db = postMove(db, otherBill.id);

  const { FormView } = await import('./views/FormView.jsx');
  const { ActionView } = await import('./views/ActionView.jsx');
  const { JournalItems } = await import('./views/JournalItems.jsx');

  // Form smart button opens the journal's items (jcf1), like Odoo's Journal Items action
  const formCtx = await mountView(
    (React) => React.createElement(FormView, { leaf: journalsLeaf(), id: String(saleJ.id), base: '#/accounting/journals', params: new URLSearchParams('view=list') }),
    db,
  );
  let smartHref;
  let expectedLines;
  try {
    const smart = find(formCtx.host, (n) => n.tagName === 'A' && hasClass(n, 'smart'));
    assert.ok(smart, 'Journal form renders smart button');
    assert.ok(smart.textContent.includes('Journal Items'));
    smartHref = props(smart)?.href ?? '';
    assert.equal(smartHref, `#/accounting/journal-items?journal=${saleJ.id}`);

    const targetParams = new URLSearchParams(smartHref.split('?')[1]);
    const journalParam = Number(targetParams.get('journal'));
    assert.equal(journalParam, saleJ.id);

    expectedLines = journalItems(db).filter((line) => line.journal_id === journalParam);
    const smartCount = Number(find(smart, (n) => n.tagName === 'B')?.textContent);
    assert.equal(smartCount, expectedLines.length);
    assert.ok(expectedLines.some((line) => line.move_id === inv.id), 'Invoice line for saleJ is present');
    assert.ok(expectedLines.every((line) => line.journal_id === saleJ.id), 'Every returned line belongs to saleJ');
  } finally {
    await formCtx.done();
  }

  // Destination view checks: journal-items filtered by journal= lists the journal lines and excludes others
  const previousLocation = globalThis.location;
  globalThis.location = { hash: smartHref };
  const itemsCtx = await mountView(
    (React) => React.createElement(JournalItems),
    db,
  );
  try {
    const invMove = read(db, 'account.move', inv.id);
    const otherMove = read(db, 'account.move', otherBill.id);
    const tbody = find(itemsCtx.host, (n) => n.tagName === 'TBODY');
    const renderedRows = allFind(tbody, (n) => n.tagName === 'TR');
    assert.equal(renderedRows.length, expectedLines.length, 'Rendered JournalItems rows match only the selected journal lines');
    assert.ok(itemsCtx.host.textContent.includes(invMove.name), 'Invoice line is displayed in JournalItems');
    assert.equal(itemsCtx.host.textContent.includes(otherMove.name), false, 'Other journal entries are excluded from JournalItems');
    const facet = find(itemsCtx.host, (n) => n.tagName === 'SPAN' && n.textContent.includes(`Journal: ${saleJ.name}`));
    assert.ok(facet, 'Journal facet is shown in JournalItems');
  } finally {
    globalThis.location = previousLocation;
    await itemsCtx.done();
  }

  // Single-company optional columns menu excludes Company and defaults Active off
  const singleCtx = await mountView(
    (React) => React.createElement(ActionView, { leaf: journalsLeaf(), base: '#/accounting/journals', params: new URLSearchParams() }),
    db,
  );
  try {
    const colsBtn = find(singleCtx.host, (n) => n.tagName === 'BUTTON' && hasClass(n, 'o2m-cols-toggle'));
    await singleCtx.React.act(async () => { props(colsBtn).onClick(); });
    const items = allFind(singleCtx.host, (n) => props(n)?.role === 'menuitemcheckbox')
      .map((b) => [b.textContent.replace('✓', '').trim(), props(b)['aria-checked']]);
    assert.deepEqual(items, [
      ['Sequence Prefix', true],
      ['Default Account', true],
      ['Currency', false],
      ['Active', false],
    ]);
  } finally {
    await singleCtx.done();
  }

  // Multi-company exposes Company in optional columns (hidden by default, toggleable on)
  const branch = createCompany(db, { name: 'Branch Co' });
  const multiDb = setCompanies(branch.db, { current: 1, allowed: [1, branch.id] });
  const multiCtx = await mountView(
    (React) => React.createElement(ActionView, { leaf: journalsLeaf(), base: '#/accounting/journals', params: new URLSearchParams() }),
    multiDb,
  );
  try {
    const headersBefore = allFind(multiCtx.host, (n) => n.tagName === 'TH' && !hasClass(n, 'o2m-cols-th'))
      .map((th) => th.textContent.replace(/[▲▼]/g, '').trim())
      .filter(Boolean);
    assert.deepEqual(headersBefore, ['Journal', 'Type', 'Sequence Prefix', 'Default Account']);

    const colsBtn = find(multiCtx.host, (n) => n.tagName === 'BUTTON' && hasClass(n, 'o2m-cols-toggle'));
    await multiCtx.React.act(async () => { props(colsBtn).onClick(); });
    const items = allFind(multiCtx.host, (n) => props(n)?.role === 'menuitemcheckbox');
    assert.deepEqual(items.map((b) => [b.textContent.replace('✓', '').trim(), props(b)['aria-checked']]), [
      ['Sequence Prefix', true],
      ['Default Account', true],
      ['Currency', false],
      ['Active', false],
      ['Company', false],
    ]);
    const companyItem = items.find((b) => b.textContent.includes('Company'));
    await multiCtx.React.act(async () => { props(companyItem).onClick(); });
    const headersAfter = allFind(multiCtx.host, (n) => n.tagName === 'TH' && !hasClass(n, 'o2m-cols-th'))
      .map((th) => th.textContent.replace(/[▲▼]/g, '').trim())
      .filter(Boolean);
    assert.deepEqual(headersAfter, ['Journal', 'Type', 'Sequence Prefix', 'Default Account', 'Company']);
  } finally {
    await multiCtx.done();
  }
});

test('Arabic translations exist for journal list, search filters, and smart button labels', async () => {
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem: () => {}, removeItem: () => {}, clear: () => {} };
  try {
    const { t } = await import('./i18n.js?lang=ar-acct-jrn3');
    for (const s of ['Journals', 'Journal', 'Type', 'Sequence Prefix', 'Default Account', 'Active', 'Company', 'Sales', 'Purchases', 'Liquidity', 'Miscellaneous', 'Archived', 'Journal Items']) {
      assert.notEqual(t(s), s, `missing Arabic translation for "${s}"`);
    }
  } finally {
    globalThis.localStorage = prevStorage;
  }
});
