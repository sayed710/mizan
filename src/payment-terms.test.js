import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { addDays, today } from './models/common.js';
import { menusFor, models } from './models/index.js';
import { dueDate, installments } from './models/terms.js';

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
  .map((f) => f.childNodes[0]?.textContent?.replace('*', '').trim());

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

test('lineDate computes due dates for all four delay types on 2026-11-13', () => {
  const invDate = '2026-11-13';
  const cases = [
    [{ value: 100, value_type: 'percent', nb_days: 15, delay_type: 'days_after' }, '2026-11-28'],
    [{ value: 100, value_type: 'percent', nb_days: 10, delay_type: 'days_end_of_month' }, '2026-12-10'],
    [{ value: 100, value_type: 'percent', nb_days: 0, delay_type: 'days_after_end_of_next_month' }, '2026-12-31'],
    [{ value: 100, value_type: 'percent', nb_days: 10, delay_type: 'days_after_end_of_next_month' }, '2027-01-10'],
    [{ value: 100, value_type: 'percent', nb_days: 90, delay_type: 'days_end_of_month_on_the', days_next_month: 10 }, '2027-03-10'],
  ];
  for (const [line, expected] of cases) {
    const term = { line_ids: [line] };
    assert.deepEqual(installments(term, 1000, invDate), [{ date: expected, amount: 1000 }]);
    assert.equal(dueDate(term, invDate), expected);
  }
});

test('days_end_of_month_on_the clamps day 31 in a 30-day month', () => {
  const term = {
    line_ids: [{ value: 100, value_type: 'percent', nb_days: 120, delay_type: 'days_end_of_month_on_the', days_next_month: 31 }],
  };
  // 2026-11-13 + 120 days = 2027-03-13 -> end of March -> following month is April (30 days), clamped to 2027-04-30.
  assert.equal(dueDate(term, '2026-11-13'), '2027-04-30');
  assert.deepEqual(installments(term, 1000, '2026-11-13'), [{ date: '2027-04-30', amount: 1000 }]);

  // 2026-03-15 + 0 days = March -> following month April (30 days), clamped to 2026-04-30.
  const zeroDays = {
    line_ids: [{ value: 100, value_type: 'percent', nb_days: 0, delay_type: 'days_end_of_month_on_the', days_next_month: 31 }],
  };
  assert.equal(dueDate(zeroDays, '2026-03-15'), '2026-04-30');
});

test('guard rejects days_end_of_month_on_the without a valid days_next_month (1-31)', () => {
  const db = seed();
  assert.throws(
    () => create(db, 'account.payment.term', {
      name: 'Missing On The',
      line_ids: [{ value: 100, value_type: 'percent', nb_days: 90, delay_type: 'days_end_of_month_on_the' }],
    }),
    /day of the next month/i,
  );
  assert.throws(
    () => create(db, 'account.payment.term', {
      name: 'Zero On The',
      line_ids: [{ value: 100, value_type: 'percent', nb_days: 90, delay_type: 'days_end_of_month_on_the', days_next_month: 0 }],
    }),
    /day of the next month/i,
  );
  assert.throws(
    () => create(db, 'account.payment.term', {
      name: 'Too Large On The',
      line_ids: [{ value: 100, value_type: 'percent', nb_days: 90, delay_type: 'days_end_of_month_on_the', days_next_month: 32 }],
    }),
    /day of the next month/i,
  );

  const valid = create(db, 'account.payment.term', {
    name: 'Valid On The',
    line_ids: [{ value: 100, value_type: 'percent', nb_days: 90, delay_type: 'days_end_of_month_on_the', days_next_month: 10 }],
  });
  assert.equal(read(valid.db, 'account.payment.term', valid.id).line_ids[0].days_next_month, 10);
  assert.throws(
    () => write(valid.db, 'account.payment.term', valid.id, {
      line_ids: [{ value: 100, value_type: 'percent', nb_days: 90, delay_type: 'days_end_of_month_on_the', days_next_month: null }],
    }),
    /day of the next month/i,
  );
});

test('seeded Odoo standard payment terms exist with the right due dates on 2026-11-13', () => {
  const db = seed();
  const terms = new Map(search(db, 'account.payment.term').map((t) => [t.name, t]));
  const invDate = '2026-11-13';
  const expectedDue = [
    ['Immediate Payment', '2026-11-13'],
    ['15 Days', '2026-11-28'],
    ['21 Days', '2026-12-04'],
    ['30 Days', '2026-12-13'],
    ['45 Days', '2026-12-28'],
    ['End of Following Month', '2026-12-31'],
    ['10 Days after End of Next Month', '2027-01-10'],
    ['30% Now, Balance 60 Days', '2027-01-12'],
    ['2/7 Net 30', '2026-12-13'],
    ['90 days, on the 10th', '2027-03-10'],
  ];
  for (const [name, expected] of expectedDue) {
    const term = terms.get(name);
    assert.ok(term, `seeded payment term "${name}" exists`);
    assert.equal(dueDate(term, invDate), expected, `dueDate for "${name}"`);
  }
  assert.deepEqual(installments(terms.get('30% Now, Balance 60 Days'), 1000, invDate), [
    { date: '2026-11-13', amount: 300 },
    { date: '2027-01-12', amount: 700 },
  ]);
});

test('payment terms list shows Name only and sorts by sequence in Odoo order', async () => {
  const db = seed();
  const expectedOrder = [
    'Immediate Payment',
    '15 Days',
    '21 Days',
    '30 Days',
    '45 Days',
    'End of Following Month',
    '10 Days after End of Next Month',
    '30% Now, Balance 60 Days',
    '2/7 Net 30',
    '90 days, on the 10th',
  ];
  const def = models['account.payment.term'];
  assert.deepEqual(def.list, ['name']);
  const sortedNames = [...search(db, 'account.payment.term')].sort(def.sort).map((t) => t.name);
  assert.deepEqual(sortedNames, expectedOrder);

  const { ActionView } = await import('./views/ActionView.jsx');
  const ctx = await mountView(
    (React) => React.createElement(ActionView, {
      leaf: paymentTermsLeaf(),
      base: '#/accounting/payment-terms',
      params: new URLSearchParams('view=list'),
    }),
    db,
  );
  try {
    const table = find(ctx.host, (n) => n.tagName === 'TABLE' && hasClass(n, 'list'));
    assert.ok(table, 'renders payment terms list table');
    const headers = allFind(table, (n) => n.tagName === 'TH')
      .map((th) => th.textContent.trim())
      .filter(Boolean);
    assert.deepEqual(headers, ['Name']);
    const tbody = find(table, (n) => n.tagName === 'TBODY');
    const rowNames = (tbody?.childNodes ?? []).map((tr) => tr.childNodes?.[1]?.textContent?.trim());
    assert.deepEqual(rowNames, expectedOrder);
  } finally {
    await ctx.done();
  }
});

test('preview text formats note, early payment discount, and numbered installments for 2/7 Net 30 and 30% Now, Balance 60 Days', () => {
  const db = seed();
  const computePreview = models['account.payment.term'].fields.preview.compute;
  const date = today();

  const net = search(db, 'account.payment.term').find((t) => t.name === '2/7 Net 30');
  assert.equal(
    computePreview(net),
    `Early Payment Discount: 980.00 if paid before ${addDays(date, 7)}\n1 - Installment of 1,000.00 due on ${addDays(date, 30)}`,
  );
  assert.equal(
    computePreview({ ...net, note: 'Pay early to save 2%' }),
    `Pay early to save 2%\nEarly Payment Discount: 980.00 if paid before ${addDays(date, 7)}\n1 - Installment of 1,000.00 due on ${addDays(date, 30)}`,
  );

  const split = search(db, 'account.payment.term').find((t) => t.name === '30% Now, Balance 60 Days');
  assert.equal(
    computePreview(split),
    `1 - Installment of 300.00 due on ${date}\n2 - Installment of 700.00 due on ${addDays(date, 60)}`,
  );
});

test('payment term form hides discount fields when early_discount is off, renders Due Terms and Preview titled groups, and shows On the only for days_end_of_month_on_the', async () => {
  const db = seed();
  const t30 = search(db, 'account.payment.term').find((t) => t.name === '30 Days');
  const t90 = search(db, 'account.payment.term').find((t) => t.name === '90 days, on the 10th');
  const { FormView } = await import('./views/FormView.jsx');
  const ctx = await mountView(
    (React, id = t30.id) => React.createElement(FormView, {
      leaf: paymentTermsLeaf(),
      id,
      base: '#/accounting/payment-terms',
      params: new URLSearchParams('view=form'),
    }),
    db,
  );
  try {
    const titleInput = find(ctx.host, (n) => n.tagName === 'INPUT' && props(n)?.value === '30 Days');
    assert.ok(titleInput, 'title input renders record name');

    const groups = allFind(ctx.host, (n) => n.tagName === 'DIV' && hasClass(n, 'group'));
    assert.deepEqual(fieldLabelsOf(groups[0]), ['Early Discount']);

    const groupTitles = allFind(ctx.host, (n) => hasClass(n, 'group-title')).map((n) => n.textContent.trim());
    assert.deepEqual(groupTitles, ['Due Terms', 'Preview']);

    const tabButtons = allFind(ctx.host, (n) => n.tagName === 'BUTTON' && props(n)?.role === 'tab');
    assert.deepEqual(tabButtons.map((b) => b.textContent.trim()), ['Note']);
    assert.ok(find(ctx.host, (n) => n.tagName === 'ASIDE' && hasClass(n, 'chatter')), 'chatter is rendered');

    // Due Terms table columns and readonly/blank On the cell when delay_type is days_after.
    const linesTable = find(ctx.host, (n) => n.tagName === 'TABLE' && hasClass(n, 'lines'));
    const lineHeaders = allFind(linesTable, (n) => n.tagName === 'TH' && !hasClass(n, 'o2m-cols-th')).map((th) => th.textContent.trim());
    assert.deepEqual(lineHeaders, ['Due', 'Value Type', 'After', 'Delay Type', 'On the']);
    const firstRowCells = find(linesTable, (n) => n.tagName === 'TBODY').childNodes[0].childNodes;
    const onTheCell30 = firstRowCells[4];
    assert.equal(allFind(onTheCell30, (n) => n.tagName === 'INPUT').length, 0, 'On the is readonly/blank for days_after');
    assert.equal(onTheCell30.textContent.trim(), '');

    // Toggle early_discount on -> reveals Discount %, Within (days), Reduced tax.
    const earlyCheckbox = find(groups[0], (n) => n.tagName === 'INPUT' && props(n)?.type === 'checkbox');
    await ctx.React.act(async () => props(earlyCheckbox).onChange({ target: { checked: true } }));
    const updatedGroups = allFind(ctx.host, (n) => n.tagName === 'DIV' && hasClass(n, 'group'));
    assert.deepEqual(fieldLabelsOf(updatedGroups[0]), ['Early Discount', 'Discount %', 'Within (days)', 'Reduced tax']);
    const reducedTaxSelect = find(updatedGroups[0], (n) => n.tagName === 'SELECT' && props(n)?.id === 'f-discount_tax_computation');
    const optionLabels = allFind(reducedTaxSelect, (n) => n.tagName === 'OPTION' && props(n)?.value)
      .map((o) => [props(o).value, o.textContent.trim()]);
    assert.deepEqual(optionLabels, [
      ['included', 'On early payment'],
      ['excluded', 'Never'],
      ['mixed', 'Always (upon invoice)'],
    ]);

    // Render 90 days, on the 10th -> On the cell has an editable input with value 10.
    await ctx.render(t90.id);
    const linesTable90 = find(ctx.host, (n) => n.tagName === 'TABLE' && hasClass(n, 'lines'));
    const onTheCell90 = find(linesTable90, (n) => n.tagName === 'TBODY').childNodes[0].childNodes[4];
    const onTheInput = find(onTheCell90, (n) => n.tagName === 'INPUT');
    assert.ok(onTheInput, 'On the renders an input for days_end_of_month_on_the');
    assert.equal(String(props(onTheInput)?.value), '10');
  } finally {
    await ctx.done();
  }
});
