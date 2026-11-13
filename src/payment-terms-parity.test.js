import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { create, read, search, write } from './orm.js';
import { cleanRecord } from './validate.js';
import { migrate, SCHEMA_VERSION } from './migrations.js';
import { seed } from './seed.js';
import { today } from './models/common.js';
import { menusFor, models, viewsOf } from './models/index.js';
import { formatTermPreview } from './models/terms.js';

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

const paymentTermsLeaf = () => findLeafByKey(menusFor('accounting'), 'payment-terms');

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
      return el;
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
  const render = async (el) => {
    await React.act(async () => root.render(renderElement(React, el)));
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

test('payment terms opens in list view with kanban/form available, drag handle, and multi-company Company column gating', async () => {
  const def = models['account.payment.term'];
  assert.deepEqual(viewsOf('account.payment.term'), ['list', 'kanban']);
  assert.ok(def.form, 'form view remains available');
  assert.deepEqual(def.list, ['sequence', 'name', 'company_id']);
  assert.deepEqual(def.searchFields, ['name']);

  const { ActionView } = await import('./views/ActionView.jsx');
  const singleCtx = await mountView(
    (React) => React.createElement(ActionView, {
      leaf: paymentTermsLeaf(),
      base: '#/accounting/payment-terms',
      params: new URLSearchParams(),
    }),
    seed(),
  );
  try {
    const table = find(singleCtx.host, (n) => n.tagName === 'TABLE' && hasClass(n, 'list'));
    assert.ok(table, 'opens in list view by default');
    const headers = allFind(table, (n) => n.tagName === 'TH').map((th) => th.textContent.trim()).filter(Boolean);
    assert.deepEqual(headers, ['Payment Terms']);
    const firstRow = find(table, (n) => n.tagName === 'TBODY').childNodes[0];
    assert.ok(find(firstRow, (n) => hasClass(n, 'drag-handle')), 'renders sequence drag handle');
    assert.equal(props(firstRow)?.draggable, true);
  } finally {
    await singleCtx.done();
  }

  const multiDb = create(seed(), 'res.company', { name: 'Subsidiary Co' }).db;
  const multiCtx = await mountView(
    (React) => React.createElement(ActionView, {
      leaf: paymentTermsLeaf(),
      base: '#/accounting/payment-terms',
      params: new URLSearchParams(),
    }),
    multiDb,
  );
  try {
    const table = find(multiCtx.host, (n) => n.tagName === 'TABLE' && hasClass(n, 'list'));
    const headers = allFind(table, (n) => n.tagName === 'TH').map((th) => th.textContent.trim()).filter(Boolean);
    assert.deepEqual(headers, ['Payment Terms', 'Company']);
  } finally {
    await multiCtx.done();
  }
});

test('archived payment terms are hidden by default, shown via Archived filter with muted row, and show Archived ribbon on form', async () => {
  let db = seed();
  const created = create(db, 'account.payment.term', { name: 'Legacy 120 Days', active: false });
  db = created.db;

  assert.equal(search(db, 'account.payment.term').some((r) => r.id === created.id), false);
  assert.equal(search(db, 'account.payment.term', { includeArchived: true }).some((r) => r.id === created.id), true);

  const { ActionView } = await import('./views/ActionView.jsx');
  const listCtx = await mountView(
    (React) => React.createElement(ActionView, {
      leaf: paymentTermsLeaf(),
      base: '#/accounting/payment-terms',
      params: new URLSearchParams('view=list'),
    }),
    db,
  );
  try {
    const visibleText = () => find(listCtx.host, (n) => n.tagName === 'TBODY').textContent;
    assert.equal(visibleText().includes('Legacy 120 Days'), false);

    const toggleSearch = find(listCtx.host, (n) => n.tagName === 'BUTTON' && hasClass(n, 'search-toggle'));
    assert.ok(toggleSearch, 'search panel toggle button exists');
    await listCtx.React.act(async () => props(toggleSearch).onClick());

    const archivedBtn = find(listCtx.host, (n) => n.tagName === 'BUTTON' && n.textContent.trim() === 'Archived');
    assert.ok(archivedBtn, 'control panel exposes Archived filter');
    await listCtx.React.act(async () => props(archivedBtn).onClick());

    const rows = find(listCtx.host, (n) => n.tagName === 'TBODY').childNodes;
    const archivedRow = rows.find((tr) => tr.textContent.includes('Legacy 120 Days'));
    assert.ok(archivedRow, 'Archived filter reveals archived payment term');
    assert.ok(hasClass(archivedRow, 'muted'), 'archived row uses muted decoration');
  } finally {
    await listCtx.done();
  }

  const { FormView } = await import('./views/FormView.jsx');
  const formCtx = await mountView(
    (React) => React.createElement(FormView, {
      leaf: paymentTermsLeaf(),
      id: created.id,
      base: '#/accounting/payment-terms',
      params: new URLSearchParams('view=form'),
    }),
    db,
  );
  try {
    const ribbon = find(formCtx.host, (n) => hasClass(n, 'ribbon'));
    assert.ok(ribbon, 'renders ribbon on archived record');
    assert.equal(ribbon.textContent.trim(), 'Archived');
  } finally {
    await formCtx.done();
  }
});

test('form renders Odoo 20 layout: title label/placeholder, company placeholder, inline early discount, due terms headers, and preview group without Note tab', async () => {
  const multiDb = create(seed(), 'res.company', { name: 'Second Co' }).db;
  const term = search(multiDb, 'account.payment.term').find((t) => t.name === '30 Days');
  const { FormView } = await import('./views/FormView.jsx');
  const ctx = await mountView(
    (React) => React.createElement(FormView, {
      leaf: paymentTermsLeaf(),
      id: term.id,
      base: '#/accounting/payment-terms',
      params: new URLSearchParams('view=form'),
    }),
    multiDb,
  );
  try {
    const titleLabel = find(ctx.host, (n) => n.tagName === 'LABEL' && hasClass(n, 'title-label'));
    assert.equal(titleLabel?.textContent?.trim(), 'Payment Terms');
    const titleInput = find(ctx.host, (n) => n.tagName === 'INPUT' && props(n)?.id === 'f-name');
    assert.equal(props(titleInput)?.placeholder, 'e.g. 30 days');

    const groups = allFind(ctx.host, (n) => n.tagName === 'DIV' && hasClass(n, 'group'));
    assert.ok(hasClass(groups[0], 'group-full'));
    assert.deepEqual(fieldLabelsOf(groups[0]), ['Company', 'Early Discount']);

    const companySelect = find(groups[0], (n) => n.tagName === 'SELECT' && props(n)?.id === 'f-company_id');
    const blankCompanyOption = find(companySelect, (n) => n.tagName === 'OPTION' && props(n)?.value === '');
    assert.equal(blankCompanyOption?.textContent?.trim(), 'Visible to all');

    // Before toggling early_discount: discount inputs and Reduced tax are absent.
    assert.equal(find(groups[0], (n) => props(n)?.id === 'f-discount_percent'), null);
    assert.equal(find(groups[0], (n) => props(n)?.id === 'f-discount_days'), null);
    assert.equal(find(groups[0], (n) => props(n)?.id === 'f-discount_tax_computation'), null);

    // Toggle early_discount on: inline fields & Reduced tax: appear.
    const earlyCheckbox = find(groups[0], (n) => n.tagName === 'INPUT' && props(n)?.id === 'f-early_discount');
    await ctx.React.act(async () => props(earlyCheckbox).onChange({ target: { checked: true } }));

    const inlineRow = find(groups[0], (n) => hasClass(n, 'field-inline'));
    assert.ok(inlineRow, 'early discount renders inline row');
    assert.ok(find(inlineRow, (n) => props(n)?.id === 'f-discount_percent'));
    assert.ok(find(inlineRow, (n) => props(n)?.id === 'f-discount_days'));
    const joins = allFind(inlineRow, (n) => hasClass(n, 'field-join')).map((n) => n.textContent.trim());
    assert.deepEqual(joins, ['% if paid within', 'days']);
    assert.deepEqual(fieldLabelsOf(groups[0]), ['Company', 'Early Discount', 'Reduced tax:']);

    // Side-by-side groups: Due Terms & Preview, no Note tab, chatter kept.
    const groupTitles = allFind(ctx.host, (n) => hasClass(n, 'group-title')).map((n) => n.textContent.trim());
    assert.deepEqual(groupTitles, ['Due Terms', 'Preview']);
    assert.equal(allFind(ctx.host, (n) => n.tagName === 'BUTTON' && props(n)?.role === 'tab').length, 0);
    assert.ok(find(ctx.host, (n) => n.tagName === 'ASIDE' && hasClass(n, 'chatter')));

    // Due Terms columns: Due, (no header), After, (no header), On the; value_type dropdown has percent/fixed only.
    const linesTable = find(ctx.host, (n) => n.tagName === 'TABLE' && hasClass(n, 'lines'));
    const lineHeaders = allFind(linesTable, (n) => n.tagName === 'TH' && !hasClass(n, 'o2m-cols-th')).map((th) => th.textContent.trim());
    assert.deepEqual(lineHeaders, ['Due', '', 'After', '', 'On the']);
    const firstRow = find(linesTable, (n) => n.tagName === 'TBODY').childNodes[0];
    const valueTypeSelect = firstRow.childNodes[1].childNodes[0];
    const valueTypeOpts = allFind(valueTypeSelect, (n) => n.tagName === 'OPTION' && props(n)?.value).map((o) => props(o).value);
    assert.deepEqual(valueTypeOpts, ['percent', 'fixed']);
    assert.equal(allFind(firstRow.childNodes[4], (n) => n.tagName === 'INPUT').length, 0);

    // Preview group: Display terms on invoice, Example: <amount> on <date>, Note with placeholder, Preview text.
    const previewGroup = groups[2];
    const displayCheck = find(previewGroup, (n) => n.tagName === 'INPUT' && props(n)?.id === 'f-display_on_invoice');
    assert.equal(props(displayCheck)?.checked, true);
    const exampleAmountInput = find(previewGroup, (n) => n.tagName === 'INPUT' && props(n)?.id === 'f-example_amount');
    const exampleDateInput = find(previewGroup, (n) => n.tagName === 'INPUT' && props(n)?.id === 'f-example_date');
    assert.equal(String(props(exampleAmountInput)?.value), '1000');
    assert.equal(props(exampleDateInput)?.value, today());
    const exampleJoin = find(previewGroup, (n) => hasClass(n, 'field-join'));
    assert.equal(exampleJoin?.textContent?.trim(), 'on');
    const noteInput = find(previewGroup, (n) => n.tagName === 'TEXTAREA' && props(n)?.id === 'f-note');
    assert.equal(props(noteInput)?.placeholder, 'Description on invoice (e.g. Payment terms: 30 days after invoice date)');
  } finally {
    await ctx.done();
  }
});

test('preview updates live from example_amount, example_date, early_discount, and display_on_invoice without storing example inputs', async () => {
  const db = seed();
  const net = search(db, 'account.payment.term').find((t) => t.name === '2/7 Net 30');
  assert.equal(read(db, 'account.payment.term', net.id).example_amount, 1000);
  assert.equal(read(db, 'account.payment.term', net.id).example_date, today());
  const rawStored = db.records['account.payment.term'].find((t) => t.id === net.id);
  assert.equal(Object.hasOwn(rawStored, 'example_amount'), false);
  assert.equal(Object.hasOwn(rawStored, 'example_date'), false);
  assert.equal(Object.hasOwn(cleanRecord('account.payment.term', read(db, 'account.payment.term', net.id)), 'example_amount'), false);

  // Custom example amount & date with early discount on
  assert.equal(
    formatTermPreview({ ...net, example_amount: 2500, example_date: '2026-05-01', display_on_invoice: true }),
    'Early Payment Discount: 2,450.00 if paid before 2026-05-08\n1 - Installment of 2,500.00 due on 2026-05-31',
  );
  // Without early discount
  assert.equal(
    formatTermPreview({ ...net, early_discount: false, example_amount: 2500, example_date: '2026-05-01', display_on_invoice: true }),
    '1 - Installment of 2,500.00 due on 2026-05-31',
  );
  // Display terms on invoice disabled -> hides both early discount and installment preview lines
  assert.equal(
    formatTermPreview({ ...net, example_amount: 2500, example_date: '2026-05-01', display_on_invoice: false }),
    '',
  );

  // Live FormView reactivity for example_amount, example_date, and display_on_invoice
  const { FormView } = await import('./views/FormView.jsx');
  const ctx = await mountView(
    (React) => React.createElement(FormView, {
      leaf: paymentTermsLeaf(),
      id: net.id,
      base: '#/accounting/payment-terms',
      params: new URLSearchParams('view=form'),
    }),
    db,
  );
  try {
    const amountInput = find(ctx.host, (n) => props(n)?.id === 'f-example_amount');
    const dateInput = find(ctx.host, (n) => props(n)?.id === 'f-example_date');
    await ctx.React.act(async () => props(amountInput).onChange({ target: { value: '2000' } }));
    await ctx.React.act(async () => props(dateInput).onChange({ target: { value: '2026-06-01' } }));
    const previewSpan = () => find(allFind(ctx.host, (n) => hasClass(n, 'group'))[2], (n) => hasClass(n, 'readonly'));
    assert.equal(
      previewSpan().textContent,
      'Early Payment Discount: 1,960.00 if paid before 2026-06-08\n1 - Installment of 2,000.00 due on 2026-07-01',
    );
    const displayCheck = find(ctx.host, (n) => props(n)?.id === 'f-display_on_invoice');
    await ctx.React.act(async () => props(displayCheck).onChange({ target: { checked: false } }));
    assert.equal(previewSpan().textContent, '');
  } finally {
    await ctx.done();
  }
});

test('example inputs validate before writing and bad terms produce explicit preview validation errors without swallowing bugs', () => {
  const db = seed();
  const net = search(db, 'account.payment.term').find((t) => t.name === '30 Days');

  assert.throws(() => create(db, 'account.payment.term', { name: 'Bad 0', example_amount: 0 }), /positive number/);
  assert.throws(() => create(db, 'account.payment.term', { name: 'Bad Neg', example_amount: -50 }), /positive number/);
  assert.throws(() => create(db, 'account.payment.term', { name: 'Bad Date', example_date: '2026-02-30' }), /valid date/);
  assert.throws(() => write(db, 'account.payment.term', net.id, { example_amount: 'abc' }), /positive number/);
  assert.throws(() => write(db, 'account.payment.term', net.id, { example_date: 'not-a-date' }), /valid date/);

  // Explicit validation in preview compute
  assert.equal(formatTermPreview({ ...net, example_amount: -10 }), 'Example amount must be a positive number');
  assert.equal(formatTermPreview({ ...net, example_date: '2026-02-30' }), 'Example date must be a valid date');
  assert.equal(formatTermPreview({ ...net, line_ids: [] }), 'Add at least one due term');
  assert.equal(
    formatTermPreview({ ...net, line_ids: [{ value: 100, value_type: 'percent', nb_days: 0, delay_type: 'days_end_of_month_on_the', days_next_month: 40 }] }),
    'Enter the day of the next month (1-31) for Days end of month on the',
  );
  // Real bugs (non-validation failures) are not swallowed
  assert.throws(() => formatTermPreview({ ...net, line_ids: [{ get value_type() { throw new TypeError('boom'); } }] }), /boom/);
});

test('migration 44 backfills active and display_on_invoice on existing payment terms', () => {
  const base = seed();
  const legacy = {
    ...base,
    schema_version: 43,
    records: {
      ...base.records,
      'account.payment.term': (base.records['account.payment.term'] ?? []).map(({ active: _a, display_on_invoice: _d, ...t }) => t),
    },
  };
  const migrated = migrate(legacy);
  assert.equal(migrated.schema_version, SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, 47);
  for (const term of migrated.records['account.payment.term']) {
    assert.equal(term.active, true);
    assert.equal(term.display_on_invoice, true);
  }
});

test('Arabic i18n translates all new payment-term labels, placeholders, joins, and errors', async () => {
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => (k === 'mizan-lang' ? 'ar' : null),
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  };
  try {
    const { t } = await import(`./i18n.js?ar-pterm=${Date.now()}`);
    const keys = [
      'Payment Terms',
      'e.g. 30 days',
      'Visible to all',
      'Early Discount',
      '% if paid within',
      'days',
      'Reduced tax:',
      'Due Terms',
      'Due',
      'After',
      'On the',
      'Preview',
      'Display terms on invoice',
      'Example:',
      'Example Amount',
      'Example Date',
      'on',
      'Description on invoice (e.g. Payment terms: 30 days after invoice date)',
      'Example amount must be a positive number',
      'Example date must be a valid date',
      'Add at least one due term',
      'Fixed amounts exceed the total',
      'The balance due term must be the last one',
      'Payment terms must allocate 100% of the total',
      'Enter the day of the next month (1-31) for Days end of month on the',
    ];
    for (const k of keys) {
      assert.notEqual(t(k), k, `Missing Arabic translation for "${k}"`);
    }
    assert.notEqual(
      t('Early Payment Discount: {amount} if paid before {date}', { amount: '980.00', date: '2026-05-08' }),
      'Early Payment Discount: 980.00 if paid before 2026-05-08',
    );
    assert.notEqual(
      t('{index} - Installment of {amount} due on {date}', { index: 1, amount: '1,000.00', date: '2026-05-31' }),
      '1 - Installment of 1,000.00 due on 2026-05-31',
    );
  } finally {
    globalThis.localStorage = prevStorage;
  }
});
