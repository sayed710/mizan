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

test('Finding 1: bank-linked journal items can be reconciled and actioned without visibility rejection', async () => {
  const { makeEl } = setupDom();
  globalThis.document.createElementNS = (_ns, tag) => makeEl(tag);
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const store = await import('./store.js');
  await store.initStore();

  let db = seed();
  const partner = search(db, 'res.partner')[0];
  const receivableId = accountId(db, '121000');
  const revenueId = accountId(db, '400000');
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank');

  // Customer invoice
  const inv = create(db, 'account.move', {
    name: 'INV/2026/F1',
    move_type: 'out_invoice',
    journal_id: search(db, 'account.journal').find((j) => j.type === 'sale').id,
    partner_id: partner.id,
    state: 'draft',
    date: today(),
    invoice_date: today(),
    invoice_line_ids: [{ name: 'Service', qty: 1, price_unit: 100, account_id: revenueId }],
  });
  db = postMove(inv.db, inv.id);

  // Bank entry
  const bankEntry = postEntry(db, {
    journal: 'BNK1',
    date: today(),
    lines: [
      { account: bankJournal.default_account_id, debit: 100, credit: 0 },
      { account: receivableId, partner_id: partner.id, debit: 0, credit: 100 },
    ],
  });
  db = bankEntry.db;
  const bankMove = read(db, 'account.move', bankEntry.id);

  // Bank statement line linked to bankEntry
  const stLine = create(db, 'account.bank.statement.line', {
    journal_id: bankJournal.id,
    date: today(),
    payment_ref: 'Payment F1',
    partner_id: partner.id,
    amount: 100,
    bank_move_id: bankEntry.id,
  });
  db = stLine.db;
  await store.commit(db);

  const { JournalItems } = await import('./views/JournalItems.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  await React.act(async () => {
    root.render(React.createElement(JournalItems, { leaf: { key: 'journal-items', label: 'Journal Items', report: 'journalItems' } }));
  });

  const checkboxes = findAll(host, (n) => n.tagName === 'INPUT' && props(n)?.['aria-label']?.includes('Select journal item'));
  assert.ok(checkboxes.length >= 2, 'Checkboxes found for journal items');

  const receivableAccount = read(db, 'account.account', receivableId);
  for (const cb of checkboxes) {
    const aria = props(cb)?.['aria-label'] ?? '';
    if (aria.includes(receivableAccount.name) && (aria.includes('INV/2026/F1') || aria.includes(bankMove.name))) {
      await React.act(async () => props(cb).onChange({ target: { checked: true } }));
    }
  }

  const reconcileBtn = findAll(host, (n) => n.tagName === 'BUTTON').find((b) => b.textContent === 'Reconcile');
  assert.ok(reconcileBtn, 'Reconcile button exists');
  await React.act(async () => props(reconcileBtn).onClick());

  const form = find(host, (n) => n.tagName === 'FORM');
  assert.ok(form, 'Reconcile form is visible');
  await React.act(async () => props(form).onSubmit({ preventDefault() {} }));

  const alertText = find(host, (n) => props(n)?.role === 'alert')?.textContent;
  assert.equal(alertText, undefined, 'Reconciliation of bank-linked item succeeded without visibility rejection');

  // Verify Unreconcile with bank-linked item
  const unreconcileBtn = findAll(host, (n) => n.tagName === 'BUTTON').find((b) => b.textContent === 'Unreconcile');
  assert.ok(unreconcileBtn, 'Unreconcile button exists');

  const checkboxesRecon = findAll(host, (n) => n.tagName === 'INPUT' && props(n)?.['aria-label']?.includes('Select journal item'));
  for (const cb of checkboxesRecon) {
    const aria = props(cb)?.['aria-label'] ?? '';
    if (aria.includes(receivableAccount.name) && aria.includes(bankMove.name)) {
      await React.act(async () => props(cb).onChange({ target: { checked: true } }));
    }
  }

  await React.act(async () => props(unreconcileBtn).onClick());
  const unrecForm = find(host, (n) => n.tagName === 'FORM');
  assert.ok(unrecForm, 'Unreconcile form is visible');
  await React.act(async () => props(unrecForm).onSubmit({ preventDefault() {} }));
  const unrecAlert = find(host, (n) => props(n)?.role === 'alert')?.textContent;
  assert.equal(unrecAlert, undefined, 'Unreconcile of bank-linked item succeeded without visibility rejection');

  await React.act(async () => root.unmount());
});

test('Finding 2: bank statement lines cannot change journal via kanban drag-and-drop', async () => {
  const { canDropOn } = await import('./views/kanbanDrop.js');
  assert.equal(canDropOn('account.bank.statement.line', 'journal_id'), false, 'bank statement lines cannot drop on journal_id');

  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const store = await import('./store.js');
  await store.initStore();

  let db = seed();
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank');
  const line = create(db, 'account.bank.statement.line', {
    journal_id: bankJournal.id,
    date: today(),
    payment_ref: 'Unlinked transaction',
    amount: 50,
  });
  db = line.db;
  await store.commit(db);

  const { Kanban } = await import('./views/Kanban.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  await React.act(async () => {
    root.render(React.createElement(Kanban, {
      db,
      model: 'account.bank.statement.line',
      records: [read(db, 'account.bank.statement.line', line.id)],
      open: () => {},
      groupBy: 'journal_id',
    }));
  });

  const card = find(host, (n) => n.tagName === 'ARTICLE' && n.className.includes('card'));
  assert.ok(card, 'Card rendered in kanban');
  assert.equal(Boolean(props(card)?.draggable), false, 'Card is not draggable between journal columns');

  await React.act(async () => root.unmount());
});

test('Finding 3: Mark as reviewed throws when selected bank lines have no journal entry to review', () => {
  let db = seed();
  const partner = search(db, 'res.partner')[0];
  const receivableId = accountId(db, '121000');
  const revenueId = accountId(db, '400000');
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank');
  const lineWithoutMove = create(db, 'account.bank.statement.line', {
    journal_id: bankJournal.id,
    date: today(),
    payment_ref: 'No move',
    amount: 100,
  });
  db = lineWithoutMove.db;

  const action = models['account.bank.statement.line'].listActions.find((a) => a.label === 'Mark as reviewed');
  assert.ok(action, 'Mark as reviewed action exists on bank lines');

  assert.throws(
    () => action.run(db, [lineWithoutMove.id]),
    /The selected transactions have no journal entry to review/
  );

  const move = postEntry(db, {
    journal: 'MISC',
    date: today(),
    lines: [
      { account: receivableId, partner_id: partner.id, debit: 200, credit: 0 },
      { account: revenueId, debit: 0, credit: 200 },
    ],
  });
  db = write(move.db, 'account.move', move.id, { to_check: true });
  const lineWithMove = create(db, 'account.bank.statement.line', {
    journal_id: bankJournal.id,
    date: today(),
    payment_ref: 'With move',
    amount: 200,
    bank_move_id: move.id,
  });
  db = lineWithMove.db;

  const reviewed = action.run(db, [lineWithMove.id]);
  assert.equal(read(reviewed, 'account.move', move.id).to_check, false, 'Linked move to_check flag is cleared');
});

test('Finding 4: unpriced open items with null residual stay in unreconciled review report', () => {
  let db = seed();
  const partner = search(db, 'res.partner')[0];
  const receivableId = accountId(db, '121000');
  const revenueId = accountId(db, '400000');
  const saleJournal = search(db, 'account.journal').find((j) => j.type === 'sale');

  const inv = create(db, 'account.move', {
    name: 'INV/2026/UNPRICED',
    move_type: 'out_invoice',
    journal_id: saleJournal.id,
    partner_id: partner.id,
    state: 'draft',
    date: today(),
    invoice_date: today(),
    invoice_line_ids: [{ name: 'Service', qty: 1, price_unit: 100, account_id: revenueId }],
  });
  db = postMove(inv.db, inv.id);

  // Unconfigure company currency so document currency cannot be resolved
  db = write(db, 'res.company', 1, { currency_id: null });

  const unreconciledItems = journalItems(db, { reviewMode: 'unreconciled' });
  const invLines = unreconciledItems.filter((l) => l.move_id === inv.id && l.account_id === receivableId);
  assert.ok(invLines.length > 0, 'Unpriced open item remains visible in journalItems unreconciled report');
  assert.equal(invLines[0].amount_residual, null, 'Unpriced item has null amount_residual');
});

test('Finding 6: scoped journal items report prints only the scoped company, not other allowed companies', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const store = await import('./store.js');
  await store.initStore();

  let db = seed();
  const c2 = create(db, 'res.company', { name: 'Company Two', currency_id: 1 });
  db = c2.db;
  db = {
    ...db,
    settings: {
      ...db.settings,
      allowed_company_ids: [1, c2.id],
      current_company_id: 1,
    },
  };

  const accountC2 = create(db, 'account.account', {
    name: 'C2 Receivable',
    code: '121002',
    account_type: 'asset_receivable',
    company_id: c2.id,
  });
  db = accountC2.db;

  const moveC2 = create(db, 'account.move', {
    name: 'C2/2026/001',
    move_type: 'entry',
    state: 'posted',
    company_id: c2.id,
    date: today(),
    line_ids: [
      { account_id: accountC2.id, debit: 100, credit: 0, company_id: c2.id },
      { account_id: accountId(db, '400000'), debit: 0, credit: 100, company_id: c2.id },
    ],
  });
  db = moveC2.db;
  await store.commit(db);

  globalThis.location = { hash: `#/accounting/journal-items?account=${accountC2.id}` };

  const { JournalItems } = await import('./views/JournalItems.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  await React.act(async () => {
    root.render(React.createElement(JournalItems, { leaf: { key: 'journal-items', label: 'Journal Items', report: 'journalItems' } }));
  });

  const printBtn = findAll(host, (n) => n.tagName === 'BUTTON').find((b) => b.textContent === 'Print');
  await React.act(async () => props(printBtn).onClick());

  const printPage = find(host, (n) => n.className?.includes('print-page'));
  assert.ok(printPage, 'Print view opened');
  const printText = printPage.textContent;
  assert.ok(printText.includes('Company Two'), 'Scoped company appears in print');
  assert.ok(!printText.includes('YourCompany, Company Two'), 'Does not print multiple companies header when scoped to one company');

  await React.act(async () => root.unmount());
  globalThis.location = { hash: '' };
});

test('Finding 7: JournalItems GROUP_OPTIONS has no statement group-by and items have no statement scan', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const store = await import('./store.js');
  await store.initStore();
  await store.commit(seed());

  const { JournalItems } = await import('./views/JournalItems.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  await React.act(async () => {
    root.render(React.createElement(JournalItems, { leaf: { key: 'journal-items', label: 'Journal Items', report: 'journalItems' } }));
  });

  const select = find(host, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === 'Group By');
  assert.ok(select, 'Group By select found');
  const options = findAll(select, (n) => n.tagName === 'OPTION').map((o) => o.value);
  assert.equal(options.includes('statement'), false, 'statement is not in GROUP_OPTIONS');

  await React.act(async () => root.unmount());
});

test('Finding 8: CSV export uses structured export rows with Company Currency and without UI controls', async () => {
  const { makeEl } = setupDom();
  const spy = setupDownloadSpy(makeEl);
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const store = await import('./store.js');
  await store.initStore();

  let db = seed();
  const c2 = create(db, 'res.company', { name: 'Co 2', currency_id: 1 });
  db = c2.db;
  db = { ...db, settings: { ...db.settings, allowed_company_ids: [1, c2.id] } };
  const receivableId = accountId(db, '121000');
  const revenueId = accountId(db, '400000');

  const posted = postEntry(db, {
    journal: 'INV',
    date: today(),
    company_id: c2.id,
    lines: [
      { account: receivableId, debit: 300, credit: 0, company_id: c2.id },
      { account: revenueId, debit: 0, credit: 300, company_id: c2.id },
    ],
  });
  db = posted.db;
  await store.commit(db);

  const { JournalItems } = await import('./views/JournalItems.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    await React.act(async () => {
      root.render(React.createElement(JournalItems, { leaf: { key: 'journal-items', label: 'Journal Items', report: 'journalItems' } }));
    });

    const csvBtn = findAll(host, (n) => n.tagName === 'BUTTON').find((b) => b.textContent.includes('Export CSV'));
    await React.act(async () => props(csvBtn).onClick());

    const csvDl = await spy.takeLast();
    const csvText = await csvDl.text();

    assert.ok(csvText.includes('Company Currency'), 'CSV export contains Company Currency column in multi-company');
    assert.ok(!csvText.includes('"Select",'), 'CSV export does not contain Select UI control column');
  } finally {
    spy.restore();
    await React.act(async () => root.unmount());
  }
});

test('Finding 9: Draft Entries leaf has only Mark as reviewed listAction and does not have Reverse Entries', () => {
  const app = apps.find((a) => a.id === 'accounting');
  const leaf = findLeaf(app, 'draft-entries');
  assert.ok(leaf, 'draft-entries leaf found');

  const actions = (leaf.listActions ?? []).map((a) => a.label);
  assert.ok(actions.includes('Mark as reviewed'), 'draft-entries offers Mark as reviewed');
  assert.equal(actions.includes('Reverse Entries'), false, 'draft-entries does not offer Reverse Entries');
  assert.equal(leaf.list, undefined, 'draft-entries does not override list columns with entry-only list');
});

test('Finding: Draft entries printing renders complete unpaged list exceeding one page in dedicated print view while retaining screen pagination', async () => {
  const { makeEl } = setupDom();
  globalThis.document.createElementNS = (_ns, tag) => makeEl(tag);
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const store = await import('./store.js');
  await store.initStore();

  let db = seed();
  for (let i = 1; i <= 90; i++) {
    const res = create(db, 'account.move', {
      name: `DRAFT/2026/${String(i).padStart(3, '0')}`,
      move_type: 'entry',
      state: 'draft',
      date: today(),
      invoice_date: today(),
    });
    db = res.db;
  }
  const receivableId = accountId(db, '121000');
  const revenueId = accountId(db, '400000');
  const posted = postEntry(db, {
    journal: 'INV',
    date: today(),
    lines: [
      { account: receivableId, debit: 100, credit: 0 },
      { account: revenueId, debit: 0, credit: 100 },
    ],
  });
  db = posted.db;
  await store.commit(db);

  const { ActionView } = await import('./views/ActionView.jsx');
  const app = apps.find((a) => a.id === 'accounting');
  const leaf = findLeaf(app, 'draft-entries');
  assert.ok(leaf, 'draft-entries leaf found');

  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  await React.act(async () => {
    root.render(React.createElement(ActionView, {
      leaf,
      base: '#/accounting/draft-entries',
      params: new URLSearchParams(),
    }));
  });

  const pager = find(host, (n) => n.className?.includes('pager'));
  assert.ok(pager, 'Pager rendered on screen');
  assert.ok(pager.textContent.includes('1-80 / 91'), 'Pager shows page 1 (1-80 / 91)');

  const table = find(host, (n) => n.tagName === 'TABLE');
  assert.ok(table, 'Table rendered on screen');
  const tbody = find(table, (n) => n.tagName === 'TBODY');
  const dataRows = findAll(tbody, (n) => n.tagName === 'TR');
  assert.equal(dataRows.length, 80, 'Normal screen list renders only current page (80 entries)');
  assert.ok(!table.textContent.includes('DRAFT/2026/090'), 'Draft entry outside first page is not on screen before print');

  let printCalled = false;
  const origPrint = globalThis.print;
  globalThis.print = () => { printCalled = true; };

  const buttons = findAll(host, (n) => n.tagName === 'BUTTON');
  const printBtn = buttons.find((b) => b.textContent === 'Print');
  assert.ok(printBtn, 'Print button exists on draft-entries list');

  await React.act(async () => props(printBtn).onClick());

  const printPage = find(host, (n) => n.className?.includes('print-page'));
  assert.ok(printPage, 'Print view opened');

  const backBtn = findAll(host, (n) => n.tagName === 'BUTTON').find((b) => b.textContent === 'Back');
  assert.ok(backBtn, 'Back button exists in print view');

  const printTable = find(printPage, (n) => n.tagName === 'TABLE');
  assert.ok(printTable, 'Table rendered in print view');
  const printTbody = find(printTable, (n) => n.tagName === 'TBODY');
  const printRows = findAll(printTbody, (n) => n.tagName === 'TR');
  assert.equal(printRows.length, 91, 'Print view renders all 91 matching draft entries unpaginated');
  assert.ok(printPage.textContent.includes('DRAFT/2026/001'), 'First draft entry appears in print view');
  assert.ok(printPage.textContent.includes('DRAFT/2026/090'), 'Draft entry outside first page appears in print view');
  assert.ok(!printPage.textContent.includes('POSTED/2026/001'), 'Filtered out posted entries do not appear in print view');
  assert.equal(printCalled, true, 'Print was triggered');

  await React.act(async () => props(backBtn).onClick());
  const restoredPager = find(host, (n) => n.className?.includes('pager'));
  assert.ok(restoredPager, 'Pager restored on screen after exiting print view');
  assert.ok(restoredPager.textContent.includes('1-80 / 91'), 'Pager remains 1-80 / 91');
  const restoredTable = find(host, (n) => n.tagName === 'TABLE');
  const restoredTbody = find(restoredTable, (n) => n.tagName === 'TBODY');
  assert.equal(findAll(restoredTbody, (n) => n.tagName === 'TR').length, 80, 'Normal pagination restored on screen');
  assert.ok(!restoredTable.textContent.includes('DRAFT/2026/090'), 'Draft entry outside first page is not on screen after exiting print view');

  await React.act(async () => root.unmount());
  globalThis.print = origPrint;
});

