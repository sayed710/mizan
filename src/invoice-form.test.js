import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { create } from './orm.js';
import { seed } from './seed.js';
import { menusFor } from './models/index.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const props = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];
const classOf = (node) => props(node)?.className ?? node?.className ?? '';
const hasClass = (node, cls) => typeof classOf(node) === 'string' && classOf(node).split(/\s+/).includes(cls);
const fieldLabelsOf = (container) => allFind(container, (n) => hasClass(n, 'field'))
  .map((f) => f.childNodes[0]?.textContent?.replaceAll('*', '').trim());
const allFind = (root, pred, out = []) => {
  if (!root) return out;
  if (pred(root)) out.push(root);
  for (const child of root.childNodes ?? []) allFind(child, pred, out);
  return out;
};
const leafFor = (sectionLabel, key) => {
  const top = menusFor('accounting').find((m) => m.label === sectionLabel);
  const direct = top.children.find((c) => c.key === key);
  if (direct) return direct;
  for (const child of top.children) {
    const nested = child.children?.find((c) => c.key === key);
    if (nested) return nested;
  }
  return null;
};

async function mountMoveForm({ leaf, id }) {
  const prevStorage = globalThis.localStorage;
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
    clear: () => { mem.clear(); },
  };
  setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit, getDb } = await import('./store.js');
  const { FormView } = await import('./views/FormView.jsx');
  await initStore();
  let db = seed();
  await commit(db);
  const host = globalThis.document.createElement('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  const params = new URLSearchParams('view=form');
  const render = async (renderId = id, renderLeaf = leaf) => {
    await React.act(async () => root.render(React.createElement(FormView, {
      leaf: renderLeaf,
      id: renderId,
      base: `#/accounting/${renderLeaf.key}`,
      params,
    })));
  };
  await render();
  return {
    React,
    createRoot,
    host,
    root,
    render,
    commit,
    getDb,
    createMove: async (vals) => {
      const res = create(getDb(), 'account.move', vals);
      await commit(res.db);
      return res.id;
    },
    storage: mem,
    done: async () => {
      await React.act(async () => root.unmount());
      globalThis.localStorage = prevStorage;
    },
  };
}

test('customer invoice form matches Odoo 20 main sheet, tabs, and Other Info groups', async () => {
  const leaf = leafFor('Customers', 'invoices');
  const ctx = await mountMoveForm({ leaf, id: 'new' });
  try {
    const groups = allFind(ctx.host, (n) => n.tagName === 'DIV' && hasClass(n, 'group'));
    assert.equal(groups.length, 2, 'main sheet has left and right groups');

    const leftFields = fieldLabelsOf(groups[0]);
    assert.deepEqual(leftFields, ['Customer']);

    const rightLabels = fieldLabelsOf(groups[1]);
    assert.deepEqual(rightLabels, ['Invoice Date', 'Due Date', 'Journal', 'Currency']);

    const pair = find(groups[1], (n) => hasClass(n, 'field-pair'));
    assert.ok(pair, 'Due Date and Payment Terms share one row');
    assert.ok(pair.textContent.includes('or'), 'pair is joined by "or"');
    const pairInputs = allFind(pair, (n) => n.tagName === 'INPUT' || n.tagName === 'SELECT');
    assert.equal(pairInputs.length, 2);
    assert.equal(props(pairInputs[0])?.id, 'f-invoice_date_due');
    assert.equal(props(pairInputs[1])?.id, 'f-invoice_payment_term_id');

    const tabLabels = allFind(ctx.host, (n) => n.tagName === 'BUTTON' && props(n)?.role === 'tab').map((n) => n.textContent.trim());
    assert.deepEqual(tabLabels, ['Invoice Lines', 'Journal Items', 'Payments', 'Other Info']);

    const tabFooter = find(ctx.host, (n) => hasClass(n, 'tab-footer'));
    assert.ok(tabFooter, 'Invoice Lines tab renders footer with narration beside totals');
    assert.ok(find(tabFooter, (n) => hasClass(n, 'tab-aside') && find(n, (c) => c.tagName === 'TEXTAREA' && props(c)?.placeholder === 'Terms and Conditions')));
    assert.ok(find(tabFooter, (n) => n.tagName === 'DL' && hasClass(n, 'totals')));

    const otherInfoTab = find(ctx.host, (n) => n.tagName === 'BUTTON' && props(n)?.role === 'tab' && n.textContent.trim() === 'Other Info');
    await ctx.React.act(async () => props(otherInfoTab).onClick());

    const otherTitles = allFind(ctx.host, (n) => n.tagName === 'H3' && hasClass(n, 'group-title')).map((n) => n.textContent.trim());
    assert.deepEqual(otherTitles, ['Invoice', 'Accounting']);

    const otherPanel = find(ctx.host, (n) => props(n)?.role === 'tabpanel');
    const otherGroups = allFind(otherPanel, (n) => hasClass(n, 'group'));
    const invoiceGroupLabels = fieldLabelsOf(otherGroups[0]);
    assert.deepEqual(invoiceGroupLabels, ['Customer Reference', 'Recipient Bank Account', 'Payment Reference']);

    const accountingGroupLabels = fieldLabelsOf(otherGroups[1]);
    assert.deepEqual(accountingGroupLabels, [
      'Incoterm',
      'Incoterm Location',
      'Fiscal Position',
      'Auto-post',
      'Repeat Until',
      'Source Document',
      'Inter-company Document',
      'Reverse Automatically',
      'Reversal Date',
      'Reversal Journal',
      'Cash Rounding',
      'Paid on',
      'Should Be Paid',
      'Inalterability Hash',
      'Inalterability Sequence Number',
    ]);
    assert.equal(find(otherPanel, (n) => n.tagName === 'TEXTAREA' && props(n)?.['aria-label'] === 'Terms and Conditions'), null, 'narration is not in Other Info');
  } finally {
    await ctx.done();
  }
});

test('invoice lines show Odoo 20 default columns, persist optional toggles in localStorage, and add sections/notes', async () => {
  const leaf = leafFor('Customers', 'invoices');
  const ctx = await mountMoveForm({ leaf, id: 'new' });
  try {
    const headerTexts = () => allFind(ctx.host, (n) => n.tagName === 'TH')
      .map((n) => n.textContent.trim())
      .filter((t) => t && t !== '⋯' && !t.includes('AccountAnalytic'));

    const ths = () => allFind(ctx.host, (n) => n.tagName === 'TH' && !hasClass(n, 'o2m-cols-th')).map((n) => n.textContent.trim());
    assert.deepEqual(ths(), ['Product', 'Label', 'Quantity', 'Unit Price', 'Taxes', 'Subtotal']);
    assert.ok(headerTexts().length >= 6);

    const toggle = find(ctx.host, (n) => n.tagName === 'BUTTON' && props(n)?.['aria-label'] === 'Optional columns');
    assert.ok(toggle, 'optional columns button rendered');
    await ctx.React.act(async () => props(toggle).onClick());

    const menuItems = allFind(ctx.host, (n) => props(n)?.role === 'menuitemcheckbox');
    assert.deepEqual(
      menuItems.map((n) => n.textContent.replace('✓', '').trim()),
      ['Account', 'Analytic', 'Deferred Start Date', 'Deferred End Date', 'Unit of Measure', 'Disc.%'],
    );
    assert.ok(menuItems.every((n) => props(n)['aria-checked'] === false), 'optional columns hidden by default');

    const accountItem = menuItems.find((n) => n.textContent.includes('Account'));
    await ctx.React.act(async () => props(accountItem).onClick());
    assert.equal(ths().includes('Account'), true, 'Account column becomes visible');

    const saved = JSON.parse(ctx.storage.get('mizan-o2m-cols:account.move.invoice_line_ids'));
    assert.equal(saved.account_id, true, 'choice persisted in localStorage under model.field');

    // Re-mount into a fresh host while keeping localStorage to prove persistence.
    const host2 = globalThis.document.createElement('div');
    host2.ownerDocument = globalThis.document;
    const root2 = ctx.createRoot(host2);
    const { FormView } = await import('./views/FormView.jsx');
    await ctx.React.act(async () => root2.render(ctx.React.createElement(FormView, {
      leaf,
      id: 'new',
      base: `#/accounting/${leaf.key}`,
      params: new URLSearchParams('view=form'),
    })));
    const remountThs = allFind(host2, (n) => n.tagName === 'TH' && !hasClass(n, 'o2m-cols-th')).map((n) => n.textContent.trim());
    assert.equal(remountThs.includes('Account'), true, 'toggled optional column persists after remount');
    await ctx.React.act(async () => root2.unmount());

    const addSectionBtn = find(ctx.host, (n) => n.tagName === 'BUTTON' && n.textContent.trim() === 'Add a section');
    const addNoteBtn = find(ctx.host, (n) => n.tagName === 'BUTTON' && n.textContent.trim() === 'Add a note');
    assert.ok(addSectionBtn, 'Add a section button is rendered');
    assert.ok(addNoteBtn, 'Add a note button is rendered');
    await ctx.React.act(async () => props(addSectionBtn).onClick());
    await ctx.React.act(async () => props(addNoteBtn).onClick());
    assert.ok(find(ctx.host, (n) => n.tagName === 'TR' && hasClass(n, 'o2m-section')), 'section row inserted');
    assert.ok(find(ctx.host, (n) => n.tagName === 'TR' && hasClass(n, 'o2m-note')), 'note row inserted');
  } finally {
    await ctx.done();
  }
});

test('vendor bill form shows Vendor and Bill Reference', async () => {
  const leaf = leafFor('Vendors', 'bills');
  const ctx = await mountMoveForm({ leaf, id: 'new' });
  try {
    const groups = allFind(ctx.host, (n) => n.tagName === 'DIV' && hasClass(n, 'group'));
    const leftFields = fieldLabelsOf(groups[0]);
    assert.deepEqual(leftFields, ['Vendor']);

    const otherInfoTab = find(ctx.host, (n) => n.tagName === 'BUTTON' && props(n)?.role === 'tab' && n.textContent.trim() === 'Other Info');
    await ctx.React.act(async () => props(otherInfoTab).onClick());
    const otherPanel = find(ctx.host, (n) => props(n)?.role === 'tabpanel');
    const otherGroups = allFind(otherPanel, (n) => hasClass(n, 'group'));
    const billGroupLabels = fieldLabelsOf(otherGroups[0]);
    assert.equal(billGroupLabels[0], 'Bill Reference');
  } finally {
    await ctx.done();
  }
});

test('journal entry form remains unchanged', async () => {
  const leaf = leafFor('Accounting', 'misc');
  const ctx = await mountMoveForm({ leaf, id: 'new' });
  try {
    const labels = fieldLabelsOf(ctx.host);
    assert.ok(labels.includes('Partner'));
    assert.ok(labels.includes('Reference'));
    assert.ok(labels.includes('Date'));
    assert.ok(labels.includes('Payment Terms'));
    assert.ok(labels.includes('Due Date'));
    assert.ok(labels.includes('Journal'));
    assert.ok(labels.includes('Cash Rounding'));
    assert.equal(find(ctx.host, (n) => hasClass(n, 'field-pair')), null, 'entry form does not pair Due Date or Payment Terms');

    const tabLabels = allFind(ctx.host, (n) => n.tagName === 'BUTTON' && props(n)?.role === 'tab').map((n) => n.textContent.trim());
    assert.deepEqual(tabLabels, ['Journal Items']);
  } finally {
    await ctx.done();
  }
});
