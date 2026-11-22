import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { tableToRows } from './csv.js';
import { readXlsx } from './xlsx.js';
import { today } from './models/common.js';
import { postMove, markAsReviewed } from './models/accounting.js';
import { accountId, isReconcilableAccount, journalItems, postEntry } from './models/ledger.js';
import { reconcileWith } from './models/bank.js';
import { applyDiff, diffDb } from './sync.js';
import { apps, findLeaf, models } from './models/index.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const props = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];

function findAll(node, predicate) {
  const result = [];
  const walk = (n) => {
    if (!n) return;
    if (predicate(n)) result.push(n);
    for (const child of n.childNodes ?? []) walk(child);
  };
  walk(node);
  return result;
}

function setupDownloadSpy(makeEl) {
  const downloads = [];
  const origCreateElement = globalThis.document.createElement;
  const origCreateElementNS = globalThis.document.createElementNS;
  const origCreateUrl = URL.createObjectURL;
  const origRevokeUrl = URL.revokeObjectURL;

  globalThis.document.createElementNS = (_ns, tag) => makeEl(tag);
  globalThis.document.createElement = (tag) => {
    const el = makeEl(tag);
    el.ownerDocument = globalThis.document;
    const origSetAttr = el.setAttribute;
    el.setAttribute = (name, value) => {
      origSetAttr(name, value);
      if (name === 'colspan' || name === 'colSpan') el.colSpan = Number(value);
      if (name === 'rowspan' || name === 'rowSpan') el.rowSpan = Number(value);
    };
    el.click = () => {
      if (tag.toLowerCase() === 'a') {
        downloads.push({ filename: el.download, blob: el._blob ?? downloads.at(-1)?.blob });
      }
    };
    return el;
  };
  URL.createObjectURL = (blob) => {
    downloads.push({ filename: null, blob });
    return 'blob:test';
  };
  URL.revokeObjectURL = () => {};

  const takeLast = async () => {
    const entry = downloads.pop();
    if (!entry?.blob) return null;
    const buf = new Uint8Array(await entry.blob.arrayBuffer());
    return {
      filename: entry.filename,
      type: entry.blob.type,
      bytes: buf,
      text: async () => entry.blob.text(),
    };
  };

  const restore = () => {
    globalThis.document.createElement = origCreateElement;
    globalThis.document.createElementNS = origCreateElementNS;
    URL.createObjectURL = origCreateUrl;
    URL.revokeObjectURL = origRevokeUrl;
  };

  return { takeLast, restore };
}

test('REV-1: Journal Items and Unreconciled reports support Print, CSV and XLSX export', async () => {
  const { makeEl } = setupDom();
  const spy = setupDownloadSpy(makeEl);
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const store = await import('./store.js');
  await store.initStore();

  let db = seed();
  const receivableId = accountId(db, '121000');
  const revenueId = accountId(db, '400000');
  const partner = search(db, 'res.partner')[0];

  // 1 posted entry
  const posted = postEntry(db, {
    journal: 'INV',
    date: today(),
    lines: [
      { account: receivableId, partner_id: partner.id, debit: 500, credit: 0 },
      { account: revenueId, debit: 0, credit: 500 },
    ],
  });
  db = posted.db;

  // 1 draft entry
  const draft = create(db, 'account.move', {
    name: '/',
    move_type: 'entry',
    state: 'draft',
    date: today(),
    invoice_date: today(),
    line_ids: [
      { account_id: receivableId, partner_id: partner.id, debit: 200, credit: 0 },
      { account_id: revenueId, debit: 0, credit: 200 },
    ],
  });
  db = draft.db;

  await store.commit(db);

  const { JournalItems } = await import('./views/JournalItems.jsx');

  const leaves = [
    { leaf: { key: 'journal-items', label: 'Journal Items', report: 'journalItems' }, baseName: 'journal_items' },
    { leaf: { key: 'unreconciled', label: 'Unreconciled', report: 'unreconciledItems', reviewMode: 'unreconciled' }, baseName: 'unreconciled' },
  ];

  try {
    for (const { leaf, baseName } of leaves) {
      const host = makeEl('div');
      host.ownerDocument = globalThis.document;
      const root = createRoot(host);

      await React.act(async () => {
        root.render(React.createElement(JournalItems, { leaf }));
      });

      const buttons = findAll(host, (n) => n.tagName === 'BUTTON');
      const printBtn = buttons.find((b) => b.textContent === 'Print');
      const csvBtn = buttons.find((b) => b.textContent.includes('Export CSV'));
      const xlsxBtn = buttons.find((b) => b.textContent.includes('Export XLSX'));

      assert.ok(printBtn, `Print button exists for ${leaf.label}`);
      assert.ok(csvBtn, `Export CSV button exists for ${leaf.label}`);
      assert.ok(xlsxBtn, `Export XLSX button exists for ${leaf.label}`);

      const table = find(host, (n) => n.tagName === 'TABLE');
      assert.ok(table, `Table rendered for ${leaf.label}`);
      const tableRowsList = tableToRows(table);
      assert.ok(tableRowsList.length >= 1, `Table has rows for ${leaf.label}`);

      // Test Export CSV
      await React.act(async () => props(csvBtn).onClick());
      const csvDl = await spy.takeLast();
      assert.ok(csvDl, `CSV download triggered for ${leaf.label}`);
      assert.equal(csvDl.filename, `${baseName}.csv`, `CSV filename matches ${baseName}.csv`);
      const csvText = await csvDl.text();
      assert.ok(csvText.length > 0, `CSV text generated for ${leaf.label}`);

      // Test Export XLSX
      await React.act(async () => props(xlsxBtn).onClick());
      const xlsxDl = await spy.takeLast();
      assert.ok(xlsxDl, `XLSX download triggered for ${leaf.label}`);
      assert.equal(xlsxDl.filename, `${baseName}.xlsx`, `XLSX filename matches ${baseName}.xlsx`);
      const parsedXlsx = readXlsx(xlsxDl.bytes);
      assert.ok(parsedXlsx.rows.length >= 1, `XLSX rows parsed for ${leaf.label}`);

      // Test Print view activation
      await React.act(async () => props(printBtn).onClick());
      const backBtn = findAll(host, (n) => n.tagName === 'BUTTON').find((b) => b.textContent === 'Back');
      assert.ok(backBtn, `Print view opened with Back button for ${leaf.label}`);

      // Exit print view
      await React.act(async () => props(backBtn).onClick());

      await React.act(async () => root.unmount());
    }
  } finally {
    spy.restore();
  }
});

test('REV-2: Unreconciled default filter matches open residual (amount_residual != 0 on reconcilable accounts), ignoring abs(balance) > 0 with residual 0', () => {
  let db = seed();
  const partner = search(db, 'res.partner')[0];
  const receivableId = accountId(db, '121000');
  const revenueId = accountId(db, '400000');
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank');

  assert.ok(isReconcilableAccount(read(db, 'account.account', receivableId)), 'Receivable is reconcilable');
  assert.ok(!isReconcilableAccount(read(db, 'account.account', revenueId)), 'Revenue is not reconcilable');

  // Customer invoice for 1000: posted, open residual = 1000
  const openInv = create(db, 'account.move', {
    name: 'INV/2026/001',
    move_type: 'out_invoice',
    journal_id: search(db, 'account.journal').find((j) => j.type === 'sale').id,
    partner_id: partner.id,
    state: 'draft',
    date: today(),
    invoice_date: today(),
    invoice_line_ids: [{ name: 'Service', qty: 1, price_unit: 1000, account_id: revenueId }],
  });
  db = postMove(openInv.db, openInv.id);

  // Paid invoice for 500: posted, then paid by bank line -> amount_residual = 0, but line.balance = 500
  const paidInv = create(db, 'account.move', {
    name: 'INV/2026/002',
    move_type: 'out_invoice',
    journal_id: search(db, 'account.journal').find((j) => j.type === 'sale').id,
    partner_id: partner.id,
    state: 'draft',
    date: today(),
    invoice_date: today(),
    invoice_line_ids: [{ name: 'Service 2', qty: 1, price_unit: 500, account_id: revenueId }],
  });
  db = postMove(paidInv.db, paidInv.id);

  const stLine = create(db, 'account.bank.statement.line', {
    journal_id: bankJournal.id,
    date: today(),
    payment_ref: 'Payment for INV/2026/002',
    partner_id: partner.id,
    amount: 500,
  });
  const stLineRecord = read(stLine.db, 'account.bank.statement.line', stLine.id);
  db = reconcileWith(stLine.db, stLineRecord, paidInv.id);

  // Verify invoice state
  const invPaidRecord = read(db, 'account.move', paidInv.id);
  assert.equal(invPaidRecord.amount_residual, 0, 'Paid invoice has amount_residual === 0');

  // Check ledger journalItems reviewMode: 'unreconciled'
  const unreconciledItems = journalItems(db, { reviewMode: 'unreconciled' });
  const openInvLines = unreconciledItems.filter((l) => l.move_id === openInv.id);
  const paidInvLines = unreconciledItems.filter((l) => l.move_id === paidInv.id);
  const revenueLines = unreconciledItems.filter((l) => l.account_id === revenueId);

  assert.ok(openInvLines.length > 0, 'Open invoice with residual > 0 is present in unreconciled');
  assert.equal(paidInvLines.length, 0, 'Fully paid invoice with residual 0 is excluded, even though original balance > 0');
  assert.equal(revenueLines.length, 0, 'Non-reconcilable accounts are excluded from unreconciled');
});

test('REV-3: review actions update only linked move flags and survive diff validation', () => {
  let db = seed();
  const journal = search(db, 'account.journal').find((j) => j.type === 'bank');
  const line = create(db, 'account.bank.statement.line', { journal_id: journal.id, date: today(), payment_ref: 'Review', amount: 100 });
  db = line.db;
  const entry = create(db, 'account.move', { move_type: 'entry', state: 'draft', date: today(), to_check: true });
  db = entry.db;
  // A persisted bank link, like one produced by reconciliation, identifies the owning entry.
  db = { ...db, records: { ...db.records, 'account.bank.statement.line': db.records['account.bank.statement.line'].map((r) => r.id === line.id ? { ...r, bank_move_id: entry.id } : r) } };
  const action = models['account.bank.statement.line'].listActions.find((a) => a.label === 'Mark as reviewed');
  const button = models['account.bank.statement.line'].form.buttons.find((a) => a.label === 'Mark as reviewed');
  assert.equal(button.when(read(db, 'account.bank.statement.line', line.id), db), true);
  assert.equal(models['account.bank.statement.line'].fields.to_check, undefined);
  const reviewed = action.run(db, [line.id]);
  assert.equal(read(reviewed, 'account.move', entry.id).to_check, false);
  assert.equal(read(reviewed, 'account.bank.statement.line', line.id).state, 'to_check');
  const diff = diffDb(db, reviewed);
  assert.equal(diff.upserts['account.bank.statement.line'], undefined);
  const synced = applyDiff(db, diff, { isAdmin: false, author: 'Reviewer' });
  assert.equal(read(synced, 'account.move', entry.id).to_check, false);
  assert.equal(button.when(read(synced, 'account.bank.statement.line', line.id), synced), false);
  const flagged = write(synced, 'account.move', entry.id, { to_check: true });
  const direct = markAsReviewed(flagged, entry.id);
  assert.equal(read(applyDiff(flagged, diffDb(flagged, direct), { isAdmin: false, author: 'Reviewer' }), 'account.move', entry.id).to_check, false);
  assert.equal(models['account.move'].fields.statement_id, undefined);
  assert.ok(!models['account.move'].groupBys.includes('statement_id'));
});

test('REV-4: review leaves retain model lists, actions, and list exports', async () => {
  const { makeEl } = setupDom();
  globalThis.document.createElementNS = (_ns, tag) => makeEl(tag);
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const store = await import('./store.js');
  await store.initStore();
  await store.commit(seed());
  const { ActionView } = await import('./views/ActionView.jsx');
  const app = apps.find((a) => a.id === 'accounting');
  for (const [key, model] of [['draft-entries', 'account.move'], ['to-check', 'account.bank.statement.line']]) {
    const leaf = findLeaf(app, key);
    assert.equal(leaf.model, model);
    assert.notEqual(leaf.type, 'report');
    const host = makeEl('div');
    host.ownerDocument = globalThis.document;
    const root = createRoot(host);
    await React.act(async () => root.render(React.createElement(ActionView, { leaf, base: `#/accounting/${key}`, params: new URLSearchParams() })));
    const buttons = findAll(host, (n) => n.tagName === 'BUTTON').map((n) => n.textContent);
    assert.ok(buttons.includes('Print'));
    assert.ok(buttons.some((label) => label.includes('Export')));
    assert.ok(buttons.some((label) => label.includes('Export XLSX')));
    assert.ok(buttons.includes('Mark as reviewed'));
    if (key === 'draft-entries') assert.ok(models[model].form.buttons.some((button) => button.label === 'Post')); 
    assert.ok(find(host, (n) => n.tagName === 'TABLE'));
    await React.act(async () => root.unmount());
  }
});
