import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { applyFilters, create, matches, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { menusFor, models, viewsOf } from './models/index.js';
import { createCompany, setCompanies } from './models/company.js';
import { relationCandidates, viewRecords } from './companyView.js';
import { migrate, SCHEMA_VERSION } from './migrations.js';
import { accountId } from './models/ledger.js';

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

const taxGroupsLeaf = () => findLeafByKey(menusFor('accounting'), 'tax-groups');
const roundingLeaf = () => findLeafByKey(menusFor('accounting'), 'cash-roundings');

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

test('account.tax.group list columns, handle, multi-company gating, optional column, and sequence ordering', async () => {
  const def = models['account.tax.group'];
  const leaf = taxGroupsLeaf();
  assert.equal(viewsOf('account.tax.group')[0], 'list');
  assert.deepEqual(def.list, ['sequence', 'name', 'country', 'company_id', 'preceding_subtotal']);
  assert.equal(def.fields.sequence.widget, 'handle');
  assert.equal(def.fields.company_id.multiCompanyOnly, true);
  assert.equal(def.fields.company_id.required, true);
  assert.equal(def.fields.preceding_subtotal.optional, 'hide');
  assert.deepEqual(def.searchFields, ['name']);

  const { visibleListColumns } = await import('./views/List.jsx');
  const { ActionView } = await import('./views/ActionView.jsx');
  let db = seed();
  assert.deepEqual(visibleListColumns(def, db, {}).cols, ['sequence', 'name', 'country']);
  assert.deepEqual(
    visibleListColumns(def, db, { preceding_subtotal: true }).cols,
    ['sequence', 'name', 'country', 'preceding_subtotal'],
  );

  // New group defaults sequence after existing groups and defaults company_id to current company.
  const existing = search(db, 'account.tax.group');
  const maxSeq = Math.max(...existing.map((g) => g.sequence));
  const added = create(db, 'account.tax.group', { name: 'Luxury Tax', country: 'Egypt', preceding_subtotal: 'Before Luxury' });
  db = added.db;
  const addedRec = read(db, 'account.tax.group', added.id);
  assert.ok(addedRec.sequence > maxSeq, 'new group goes last');
  assert.equal(addedRec.company_id, 1);

  // Single-company list renders handle, Name, Country and hides Company & Preceding Subtotal by default.
  const singleCtx = await mountView(
    (React) => React.createElement(ActionView, { leaf, base: '#/accounting/tax-groups', params: new URLSearchParams() }),
    db,
  );
  try {
    const table = find(singleCtx.host, (n) => n.tagName === 'TABLE' && hasClass(n, 'list'));
    assert.ok(table, 'opens in list view');
    const handleTh = find(table, (n) => n.tagName === 'TH' && hasClass(n, 'handle-col'));
    assert.equal(props(handleTh)?.['aria-label'], 'Sequence');
    const headers = allFind(table, (n) => n.tagName === 'TH' && !hasClass(n, 'o2m-cols-th'))
      .map((th) => th.textContent.replace(/[▲▼]/g, '').trim())
      .filter(Boolean);
    assert.deepEqual(headers, ['Name', 'Country']);
    assert.ok(!singleCtx.host.textContent.includes('Before Luxury'), 'optional Preceding Subtotal hidden by default');
  } finally {
    await singleCtx.done();
  }

  // Multi-company adds Company column, defaults new tax group to current company 2, and optional toggle shows Preceding Subtotal.
  const branch = createCompany(db, { name: 'Branch Co' });
  db = setCompanies(branch.db, { current: branch.id, allowed: [1, branch.id] });
  const branchGroup = create(db, 'account.tax.group', { name: 'Branch Excise', preceding_subtotal: 'Subtotal B' });
  db = branchGroup.db;
  assert.equal(read(db, 'account.tax.group', branchGroup.id).company_id, branch.id);
  assert.deepEqual(
    visibleListColumns(def, db, { preceding_subtotal: true }).cols,
    ['sequence', 'name', 'country', 'company_id', 'preceding_subtotal'],
  );

  const multiCtx = await mountView(
    (React) => React.createElement(ActionView, { leaf, base: '#/accounting/tax-groups', params: new URLSearchParams() }),
    db,
  );
  try {
    const table = find(multiCtx.host, (n) => n.tagName === 'TABLE' && hasClass(n, 'list'));
    const headers = allFind(table, (n) => n.tagName === 'TH' && !hasClass(n, 'o2m-cols-th'))
      .map((th) => th.textContent.replace(/[▲▼]/g, '').trim())
      .filter(Boolean);
    assert.deepEqual(headers, ['Name', 'Country', 'Company']);

    const optBtn = find(multiCtx.host, (n) => n.tagName === 'BUTTON' && props(n)?.['aria-label'] === 'Optional columns');
    await multiCtx.React.act(async () => { props(optBtn).onClick(); });
    const precToggle = find(multiCtx.host, (n) => n.tagName === 'BUTTON' && props(n)?.role === 'menuitemcheckbox' && n.textContent?.includes('Preceding Subtotal'));
    await multiCtx.React.act(async () => { props(precToggle).onClick(); });
    assert.ok(multiCtx.host.textContent.includes('Subtotal B'));
  } finally {
    await multiCtx.done();
  }
});

test('account.tax.group form layout has Odoo two groups, multi-company gating, and chatter', async () => {
  const { FormView } = await import('./views/FormView.jsx');
  let db = seed();
  const vat = search(db, 'account.tax.group').find((g) => g.name === 'VAT');
  assert.equal(models['account.tax.group'].form.chatter, true);

  // Single company: Company hidden on form
  const singleCtx = await mountView(
    (React) => React.createElement(FormView, { model: 'account.tax.group', id: vat.id, leaf: taxGroupsLeaf(), base: '#/accounting/tax-groups', params: new URLSearchParams() }),
    db,
  );
  try {
    const groups = allFind(singleCtx.host, (n) => hasClass(n, 'group'));
    assert.equal(groups.length, 2);
    assert.deepEqual(fieldLabelsOf(groups[0]), ['Name', 'Country', 'Sequence', 'Label on PoS Receipts']);
    assert.deepEqual(fieldLabelsOf(groups[1]), ['Preceding Subtotal']);
    assert.ok(find(singleCtx.host, (n) => hasClass(n, 'chatter')), 'keeps chatter');
  } finally {
    await singleCtx.done();
  }

  // Multi-company: Company shown in Left group
  const branch = createCompany(db, { name: 'Branch Co' });
  db = setCompanies(branch.db, { current: 1, allowed: [1, branch.id] });
  const multiCtx = await mountView(
    (React) => React.createElement(FormView, { model: 'account.tax.group', id: vat.id, leaf: taxGroupsLeaf(), base: '#/accounting/tax-groups', params: new URLSearchParams() }),
    db,
  );
  try {
    const groups = allFind(multiCtx.host, (n) => hasClass(n, 'group'));
    assert.deepEqual(fieldLabelsOf(groups[0]), ['Name', 'Country', 'Company', 'Sequence', 'Label on PoS Receipts']);
    assert.deepEqual(fieldLabelsOf(groups[1]), ['Preceding Subtotal']);
  } finally {
    await multiCtx.done();
  }
});

test('account.cash.rounding list columns, search, Active/Inactive filters, and Archived ribbon', async () => {
  const def = models['account.cash.rounding'];
  const leaf = roundingLeaf();
  assert.equal(viewsOf('account.cash.rounding')[0], 'list');
  assert.deepEqual(def.list, ['sequence', 'name', 'rounding', 'strategy', 'rounding_method', 'currency_ids']);
  assert.equal(def.fields.sequence.widget, 'handle');
  assert.equal(def.fields.currency_ids.optional, 'hide');
  assert.equal(def.fields.currency_ids.widget, 'many2many_tags');
  assert.equal(def.fields.company_id.multiCompanyOnly, true);
  assert.deepEqual(def.searchFields, ['name']);

  const { visibleListColumns } = await import('./views/List.jsx');
  const { ActionView } = await import('./views/ActionView.jsx');
  let db = seed();
  const usd = search(db, 'res.currency').find((c) => c.name === 'USD');
  const profit = accountId(db, '450000');
  const loss = accountId(db, '690000');

  const rActive = create(db, 'account.cash.rounding', {
    name: 'Five Cents',
    rounding: 0.05,
    rounding_method: 'HALF-UP',
    strategy: 'add_invoice_line',
    profit_account_id: profit,
    loss_account_id: loss,
    currency_ids: [usd.id],
    active: true,
  });
  db = rActive.db;
  const rArchived = create(db, 'account.cash.rounding', {
    name: 'Legacy Ten',
    rounding: 0.1,
    rounding_method: 'UP',
    strategy: 'biggest_tax',
    active: false,
  });
  db = rArchived.db;

  assert.ok(read(db, 'account.cash.rounding', rArchived.id).sequence > read(db, 'account.cash.rounding', rActive.id).sequence);
  assert.deepEqual(visibleListColumns(def, db, {}).cols, ['sequence', 'name', 'rounding', 'strategy', 'rounding_method']);
  assert.deepEqual(visibleListColumns(def, db, { currency_ids: true }).cols, ['sequence', 'name', 'rounding', 'strategy', 'rounding_method', 'currency_ids']);

  // Search only matches Name, not strategy or method
  const allRecs = search(db, 'account.cash.rounding', { includeArchived: true });
  assert.deepEqual(allRecs.filter((r) => matches(db, 'account.cash.rounding', r, ['Five'])).map((r) => r.name), ['Five Cents']);
  assert.deepEqual(allRecs.filter((r) => matches(db, 'account.cash.rounding', r, ['biggest_tax'])), []);
  assert.deepEqual(applyFilters('account.cash.rounding', allRecs, ['inactive'], db).map((r) => r.name), ['Legacy Ten']);
  assert.deepEqual(applyFilters('account.cash.rounding', allRecs, ['active'], db).map((r) => r.name), ['Five Cents']);

  const ctx = await mountView(
    (React) => React.createElement(ActionView, { leaf, base: '#/accounting/cash-roundings', params: new URLSearchParams() }),
    db,
  );
  try {
    const table = find(ctx.host, (n) => n.tagName === 'TABLE' && hasClass(n, 'list'));
    const headers = allFind(table, (n) => n.tagName === 'TH' && !hasClass(n, 'o2m-cols-th'))
      .map((th) => th.textContent.replace(/[▲▼]/g, '').trim())
      .filter(Boolean);
    assert.deepEqual(headers, ['Name', 'Precision', 'Strategy', 'Method']);
    assert.ok(ctx.host.textContent.includes('Add a rounding line'));
    assert.ok(ctx.host.textContent.includes('Nearest'));
    assert.ok(!ctx.host.textContent.includes('Legacy Ten'), 'archived rounding hidden by default');

    // Toggle optional Currency column and verify tags render
    const optBtn = find(ctx.host, (n) => n.tagName === 'BUTTON' && props(n)?.['aria-label'] === 'Optional columns');
    await ctx.React.act(async () => { props(optBtn).onClick(); });
    const currToggle = find(ctx.host, (n) => n.tagName === 'BUTTON' && props(n)?.role === 'menuitemcheckbox' && n.textContent?.includes('Currency'));
    await ctx.React.act(async () => { props(currToggle).onClick(); });
    assert.ok(find(ctx.host, (n) => hasClass(n, 'tag') && n.textContent.includes('USD')), 'Currency renders as tag');

    // Search panel Inactive filter shows archived rounding
    const togglePanel = find(ctx.host, (n) => n.tagName === 'BUTTON' && props(n)?.['aria-label'] === 'Toggle search panel');
    await ctx.React.act(async () => { props(togglePanel).onClick(); });
    const inactiveBtn = find(ctx.host, (n) => n.tagName === 'BUTTON' && n.textContent.trim() === 'Inactive');
    await ctx.React.act(async () => { props(inactiveBtn).onClick(); });
    assert.ok(ctx.host.textContent.includes('Legacy Ten'));
  } finally {
    await ctx.done();
  }
});

test('account.cash.rounding form layout, Archived ribbon, conditional account fields, and guard validations', async () => {
  const { FormView } = await import('./views/FormView.jsx');
  let db = seed();
  const profit = accountId(db, '450000');
  const loss = accountId(db, '690000');

  // Precision must be > 0 before writing; strategy add_invoice_line requires Profit & Loss accounts
  assert.throws(
    () => create(db, 'account.cash.rounding', { name: '', rounding: 0, rounding_method: 'HALF-UP', strategy: 'biggest_tax' }),
    /Precision must be greater than zero/,
  );
  assert.throws(
    () => create(db, 'account.cash.rounding', { name: '', rounding: -0.05, rounding_method: 'HALF-UP', strategy: 'biggest_tax' }),
    /Precision must be greater than zero/,
  );
  assert.throws(
    () => create(db, 'account.cash.rounding', { name: '', rounding: 0.05, rounding_method: 'HALF-UP', strategy: 'add_invoice_line', loss_account_id: loss }),
    /Configure the profit account/,
  );
  assert.throws(
    () => create(db, 'account.cash.rounding', { name: 'With loss missing', rounding: 0.05, rounding_method: 'HALF-UP', strategy: 'add_invoice_line', profit_account_id: profit }),
    /Configure the loss account on With loss missing/,
  );

  // Name is not required and biggest_tax needs no profit/loss accounts
  const biggest = create(db, 'account.cash.rounding', {
    name: '',
    rounding: 0.05,
    rounding_method: 'HALF-UP',
    strategy: 'biggest_tax',
    active: false,
  });
  db = biggest.db;
  const archivedRec = read(db, 'account.cash.rounding', biggest.id);
  assert.equal(archivedRec.rounding_method, 'HALF-UP');

  // Archived ribbon + title label Name + biggest_tax hides Profit/Loss Account + single company hides Company
  const ctxArchived = await mountView(
    (React) => React.createElement(FormView, { model: 'account.cash.rounding', id: biggest.id, leaf: roundingLeaf(), base: '#/accounting/cash-roundings', params: new URLSearchParams() }),
    db,
  );
  try {
    const ribbon = find(ctxArchived.host, (n) => hasClass(n, 'ribbon'));
    assert.equal(ribbon?.textContent?.trim(), 'Archived');
    const titleLabel = find(ctxArchived.host, (n) => hasClass(n, 'title-label'));
    assert.equal(titleLabel?.textContent?.trim(), 'Name');
    const groupTitles = allFind(ctxArchived.host, (n) => hasClass(n, 'group-title')).map((n) => n.textContent.trim());
    assert.deepEqual(groupTitles, ['Rounding', 'Conditions']);
    const groups = allFind(ctxArchived.host, (n) => hasClass(n, 'group'));
    assert.deepEqual(fieldLabelsOf(groups[0]), ['Precision', 'Method', 'Strategy']);
    assert.deepEqual(fieldLabelsOf(groups[1]), ['Currency']);
  } finally {
    await ctxArchived.done();
  }

  // Multi-company + add_invoice_line shows Profit/Loss Account and Company with "Visible to all" placeholder
  const branch = createCompany(db, { name: 'Branch Co' });
  db = setCompanies(branch.db, { current: 1, allowed: [1, branch.id] });
  const lineRounding = create(db, 'account.cash.rounding', {
    name: 'Nickel Line',
    rounding: 0.05,
    rounding_method: 'UP',
    strategy: 'add_invoice_line',
    profit_account_id: profit,
    loss_account_id: loss,
  });
  db = lineRounding.db;
  assert.equal(read(db, 'account.cash.rounding', lineRounding.id).company_id ?? null, null);
  // Shared rounding ("Visible to all") is visible to branch company too
  assert.ok(viewRecords(db, 'account.cash.rounding').some((r) => r.id === lineRounding.id));

  const ctxMulti = await mountView(
    (React) => React.createElement(FormView, { model: 'account.cash.rounding', id: lineRounding.id, leaf: roundingLeaf(), base: '#/accounting/cash-roundings', params: new URLSearchParams() }),
    db,
  );
  try {
    const groups = allFind(ctxMulti.host, (n) => hasClass(n, 'group'));
    assert.deepEqual(fieldLabelsOf(groups[0]), ['Precision', 'Method', 'Strategy', 'Profit Account', 'Loss Account']);
    assert.deepEqual(fieldLabelsOf(groups[1]), ['Currency', 'Company']);
    const compSelect = find(ctxMulti.host, (n) => n.tagName === 'SELECT' && props(n)?.id === 'f-company_id');
    assert.equal(compSelect?.childNodes?.[0]?.textContent, 'Visible to all');
  } finally {
    await ctxMulti.done();
  }
});

test('archived cash roundings cannot be selected on new invoices or POS configs', () => {
  let db = seed();
  const activeR = create(db, 'account.cash.rounding', {
    name: 'Active R',
    rounding: 0.05,
    rounding_method: 'UP',
    strategy: 'biggest_tax',
    active: true,
  });
  db = activeR.db;
  const archivedR = create(db, 'account.cash.rounding', {
    name: 'Archived R',
    rounding: 0.05,
    rounding_method: 'UP',
    strategy: 'biggest_tax',
    active: false,
  });
  db = archivedR.db;

  // Selection dropdown candidates exclude archived roundings on new documents
  const choices = relationCandidates(db, 'account.cash.rounding', null).map((r) => r.id);
  assert.ok(choices.includes(activeR.id));
  assert.ok(!choices.includes(archivedR.id));

  // Document & POS guards reject archived roundings on new creation or change
  assert.throws(
    () => create(db, 'account.move', {
      move_type: 'out_invoice',
      partner_id: 1,
      invoice_cash_rounding_id: archivedR.id,
      invoice_line_ids: [{ qty: 1, price_unit: 10.02, tax: 0 }],
    }),
    /Select an active cash rounding method/,
  );
  const cfg = search(db, 'pos.config')[0];
  assert.throws(
    () => write(db, 'pos.config', cfg.id, { cash_rounding: true, rounding_method_id: archivedR.id }),
    /Select an active cash rounding method/,
  );
});

test('migration 48 backfills tax group company_id from owning taxes (else main company) and sequence cleanly', () => {
  let db = seed();
  const branch = createCompany(db, { name: 'Branch Co' });
  db = branch.db;
  const branchTaxAccount = create(db, 'account.account', { name: 'Branch VAT', code: '219901', account_type: 'liability_current', company_id: branch.id });
  db = branchTaxAccount.db;
  const groupBranch = create(db, 'account.tax.group', { name: 'VAT - Shared Name' });
  db = groupBranch.db;
  const groupUnowned = create(db, 'account.tax.group', { name: 'Branch Name Hint Should Be Ignored' });
  db = groupUnowned.db;
  const tax = create(db, 'account.tax', {
    name: 'Branch VAT 5%',
    company_id: branch.id,
    tax_group_id: groupBranch.id,
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 100, account_id: branchTaxAccount.id, tag_ids: [] },
    ],
    refund_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 100, account_id: branchTaxAccount.id, tag_ids: [] },
    ],
  });
  db = tax.db;

  const r = create(db, 'account.cash.rounding', {
    name: 'Legacy Rounding',
    rounding: 0.05,
    rounding_method: 'HALF-UP',
    strategy: 'biggest_tax',
  });
  db = r.db;

  const legacy = {
    ...db,
    schema_version: 47,
    records: {
      ...db.records,
      'account.tax.group': (db.records['account.tax.group'] ?? []).map((g) => {
        if (g.id === groupBranch.id || g.id === groupUnowned.id) {
          const { company_id: _c, sequence: _s, ...rest } = g;
          return rest;
        }
        return g;
      }),
      'account.cash.rounding': (db.records['account.cash.rounding'] ?? []).map(({ active: _a, sequence: _s, currency_ids: _cu, ...cr }) => cr),
    },
  };

  const migrated = migrate(legacy);
  assert.equal(SCHEMA_VERSION, 51);
  assert.equal(migrated.schema_version, 51);

  const migratedBranchGroup = read(migrated, 'account.tax.group', groupBranch.id);
  const migratedUnownedGroup = read(migrated, 'account.tax.group', groupUnowned.id);
  assert.equal(migratedBranchGroup.company_id, branch.id, 'group owned by branch tax gets branch company_id');
  assert.equal(migratedUnownedGroup.company_id, 1, 'unowned group falls back to main company without guessing from name');
  assert.ok(Number.isInteger(migratedBranchGroup.sequence) && Number.isInteger(migratedUnownedGroup.sequence));

  const migratedRounding = read(migrated, 'account.cash.rounding', r.id);
  assert.equal(migratedRounding.active, true);
  assert.ok(Number.isInteger(migratedRounding.sequence));
  assert.deepEqual(migratedRounding.currency_ids, []);

  // Idempotent rerun preserves assignments
  const twice = migrate(migrated);
  assert.equal(twice.schema_version, 51);
  assert.deepEqual(read(twice, 'account.tax.group', groupBranch.id), migratedBranchGroup);
  assert.deepEqual(read(twice, 'account.cash.rounding', r.id), migratedRounding);
});

test('Arabic translations cover new Tax Groups and Rounding Methods strings', async () => {
  const prev = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem: () => {}, removeItem: () => {}, clear: () => {} };
  try {
    const { t } = await import(`./i18n.js?lang=ar-cfg-groups-rounding=${Date.now()}`);
    const strings = [
      'The country for which this tax group is applicable.',
      'Preceding Subtotal',
      "If set, this value will be used on documents as the label of a subtotal excluding this tax group before displaying it. If not set, the tax group will be displayed after the 'Untaxed amount' subtotal.",
      'Label on PoS Receipts',
      'Precision',
      'The smallest value used to round the total amount (e.g., 0.05 or 100).',
      'Strategy',
      'Specify how the rounding difference is applied: add a rounding line or adjust the highest tax amount.',
      'Method',
      'The computation rule used to round values (e.g., UP, DOWN, or HALF-UP).',
      'Up',
      'Down',
      'Nearest',
      'Rounding',
      'Conditions',
      'Visible to all',
      'Precision must be greater than zero',
      'Select an active cash rounding method',
    ];
    for (const s of strings) {
      assert.notEqual(t(s), s, `missing Arabic translation for: ${s}`);
    }
  } finally {
    globalThis.localStorage = prev;
  }
});
