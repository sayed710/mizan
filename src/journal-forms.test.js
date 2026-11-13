import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom } from './test-support/dom.js';
import { create, search } from './orm.js';
import { seed } from './seed.js';
import { ensureBankSuspense } from './models/ledger.js';
import { menusFor } from './models/index.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const props = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];
const textOf = (node) => (node?.nodeType === 3 ? node.nodeValue : (node?.childNodes ?? []).map(textOf).join(''));
const allFind = (root, pred, out = []) => {
  if (!root) return out;
  if (pred(root)) out.push(root);
  for (const child of root.childNodes ?? []) allFind(child, pred, out);
  return out;
};
const journalsLeaf = () => menusFor('accounting').flatMap((m) => m.children ?? []).flatMap((m) => [m, ...(m.children ?? [])]).find((m) => m.key === 'journals');

async function mount(View, viewProps, db) {
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k), clear: () => mem.clear() };
  const { makeEl } = setupDom();
  globalThis.document.createElementNS = (_n, tag) => makeEl(tag);
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const views = await import('./views/ActionView.jsx');
  const form = await import('./views/FormView.jsx');
  await initStore();
  await commit(db);
  const host = globalThis.document.createElement('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  await React.act(async () => root.render(React.createElement(View === 'form' ? form.FormView : views.ActionView, viewProps)));
  return { React, host, done: () => React.act(async () => root.unmount()) };
}

const labelsOf = (host) => allFind(host, (n) => n.tagName === 'LABEL' || String(props(n)?.className ?? '').split(' ').includes('field-label'))
  .map((n) => textOf(n).replace(/\*$/, '').trim());
const tabButtons = (host) => allFind(host, (n) => n.getAttribute?.('role') === 'tab' || props(n)?.role === 'tab');
const tabNames = (host) => tabButtons(host).map((b) => textOf(b).trim());
const openTab = async (ctx, name) => {
  const btn = tabButtons(ctx.host).find((b) => textOf(b).trim() === name);
  await ctx.React.act(async () => props(btn).onClick());
  return labelsOf(ctx.host);
};
const formFor = async (journal, db) => mount('form', { leaf: journalsLeaf(), id: journal.id, base: '#/accounting/journals', params: new URLSearchParams() }, db);
const has = (labels, label) => labels.includes(label);

test('journals list shows Journal, Type, Sequence Prefix, Default Account', async () => {
  const ctx = await mount('list', { leaf: journalsLeaf(), base: '#/accounting/journals', params: new URLSearchParams('view=list') }, seed());
  try {
    const heads = allFind(ctx.host, (n) => n.tagName === 'TH').map((th) => th.textContent.trim()).filter((h) => h && h !== '⋯');
    assert.deepEqual(heads, ['Journal', 'Type', 'Sequence Prefix', 'Default Account']);
  } finally { await ctx.done(); }
});

test('bank journal form shows three tabs, Bank Account group, and no invoice sequence fields', async () => {
  const db = seed();
  const bank = search(db, 'account.journal').find((j) => j.type === 'bank');
  const ctx = await formFor(bank, db);
  try {
    assert.deepEqual(tabNames(ctx.host), ['Journal Entries', 'Incoming Payments', 'Outgoing Payments']);
    assert.ok(has(labelsOf(ctx.host), 'Sequence Prefix') && has(labelsOf(ctx.host), 'Type'));
    let text = await openTab(ctx, 'Journal Entries');
    for (const l of ['Bank Account', 'Suspense Account', 'Profit Account', 'Loss Account', 'Dedicated Payment Sequence', 'Default Payment Journal', 'Bank Account Number', 'Bank Feeds']) {
      assert.ok(has(text, l), l);
    }
    for (const l of ['Invoice Sequence Prefix', 'Next Invoice Number', 'Refund Sequence Prefix', 'Next Refund Number']) assert.ok(!has(text, l), l);
    text = await openTab(ctx, 'Incoming Payments');
    assert.ok(has(text, 'Outstanding Receipts'));
    text = await openTab(ctx, 'Outgoing Payments');
    assert.ok(has(text, 'Outstanding Payments') && has(text, 'Next Check Number'));
    assert.ok(allFind(ctx.host, (n) => n.className === 'chatter' || props(n)?.className === 'chatter').length > 0, 'chatter');
  } finally { await ctx.done(); }
});

test('sales journal form shows Default Income Account, sequence fields, Advanced Settings, and no outstanding accounts', async () => {
  const db = seed();
  const sale = search(db, 'account.journal').find((j) => j.type === 'sale');
  const ctx = await formFor(sale, db);
  try {
    assert.deepEqual(tabNames(ctx.host), ['Journal Entries', 'Advanced Settings']);
    let text = await openTab(ctx, 'Journal Entries');
    for (const l of ['Default Income Account', 'Dedicated Credit Note Sequence', 'Invoice Sequence Prefix', 'Next Invoice Number', 'Refund Sequence Prefix', 'Next Refund Number']) assert.ok(has(text, l), l);
    for (const l of ['Outstanding Receipts', 'Outstanding Payments', 'Next Check Number', 'Suspense Account', 'Default Payment Journal']) assert.ok(!has(text, l), l);
    text = await openTab(ctx, 'Advanced Settings');
    for (const l of ['Secure Posted Entries with Hash', 'Communication Type', 'Communication Standard']) assert.ok(has(text, l), l);
  } finally { await ctx.done(); }
});

test('cash journal form shows profit and loss accounts and Cash Account label', async () => {
  let db = seed();
  const cash = create(db, 'account.journal', { name: 'Petty Cash', code: 'PTY', type: 'cash', company_id: 1, suspense_account_id: ensureBankSuspense(db, 1).id });
  db = cash.db;
  const ctx = await formFor({ id: cash.id }, db);
  try {
    const text = await openTab(ctx, 'Journal Entries');
    for (const l of ['Cash Account', 'Suspense Account', 'Profit Account', 'Loss Account', 'Default Payment Journal']) assert.ok(has(text, l), l);
    assert.ok(!has(text, 'Invoice Sequence Prefix'));
    assert.equal(tabNames(ctx.host).length, 4);
  } finally { await ctx.done(); }
});
