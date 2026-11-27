import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { menusFor } from './models/index.js';
import { postMove } from './models/accounting.js';
import { isRevaluationMovePair, revalueForeignBalances } from './models/closing.js';
import { accountId, journalId } from './models/ledger.js';
import { diffDb, applyDiff } from './sync.js';
import { invoiceSelectedSalesOrders } from './models/sales.js';
import { find, setupDom } from './test-support/dom.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const props = (node) => node[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];

test('review regularization opens the three reports and preserves hidden deferral routes', () => {
  const menus = menusFor('accounting');
  const review = menus.find((m) => m.label === 'Review');
  assert.deepEqual(review.children.map((m) => m.label), ['Control', 'Audit', 'Inventory', 'Regularization Entries', 'Sales']);
  const leaves = review.children.find((m) => m.label === 'Regularization Entries').children;
  assert.deepEqual(leaves.map((m) => m.report), ['unrealizedCurrencies', 'deferredRevenue', 'deferredExpense']);
  assert.deepEqual(leaves.map((m) => m.label), ['Unrealized Currencies', 'Deferred Revenues', 'Deferred Expenses']);
  const config = menus.find((m) => m.label === 'Configuration');
  for (const key of ['deferrals', 'deferred-revenues', 'deferred-expenses']) {
    assert.ok(config.children.find((m) => m.key === key && m.hidden && m.model === 'account.deferral'));
  }
  const management = menus.find((m) => m.label === 'Reporting').children.find((m) => m.label === 'Management');
  assert.ok(management.children.every((m) => !leaves.some((leaf) => leaf.report && leaf.report === m.report)));
});

test('selected sales orders create invoices once per order and reject empty or draft selection', () => {
  const product = create(seed(), 'product', { name: 'Review service', type: 'service', invoice_policy: 'delivery' });
  const order = create(product.db, 'sale.order', { partner_id: 1, state: 'sale', order_line: [{ product_id: product.id, name: 'Review service', qty: 3, qty_delivered: 2, price_unit: 10, tax: 0 }] });
  const draft = create(order.db, 'sale.order', { partner_id: 1, state: 'draft', order_line: [{ product_id: product.id, name: 'Review service', qty: 1, price_unit: 10, tax: 0 }] });
  assert.throws(() => invoiceSelectedSalesOrders(draft.db, []), /confirmed sales order/);
  assert.throws(() => invoiceSelectedSalesOrders(draft.db, [draft.id]), /confirmed sales order/);
  const result = invoiceSelectedSalesOrders(order.db, [order.id, order.id]);
  const invoices = search(result, 'account.move').filter((m) => m.sale_id === order.id);
  assert.equal(invoices.length, 1);
  assert.equal(invoices[0].invoice_line_ids[0].qty, 2);
  assert.ok(applyDiff(order.db, diffDb(order.db, result)));
});

test('revaluation selection uses provision accounts, excludes accounts and survives diff validation', () => {
  const currency = create(seed(), 'res.currency', { name: 'REV1FX', rate_ids: [{ date: '2026-01-01', rate: 2 }, { date: '2026-02-01', rate: 1 }] });
  const invoice = create(currency.db, 'account.move', { move_type: 'out_invoice', partner_id: 1, currency_id: currency.id, invoice_date: '2026-01-01', invoice_line_ids: [{ name: 'Service', qty: 1, price_unit: 100, tax: 0 }] });
  const db = postMove(invoice.db, invoice.id);
  const options = { companyId: 1, journalId: journalId(db, 'MISC'), incomeAccountId: accountId(db, '450100'), expenseAccountId: accountId(db, '690100'), excludedAccountIds: [] };
  const preview = revalueForeignBalances(db, '2026-02-28', options);
  const posted = revalueForeignBalances(db, '2026-02-28', options);
  const entry = search(posted, 'account.move').find((m) => m.revaluation_date === '2026-02-28');
  assert.deepEqual(entry.line_ids, search(preview, 'account.move').find((m) => m.revaluation_date === '2026-02-28').line_ids);
  assert.ok(entry.line_ids.some((line) => line.account_id === options.incomeAccountId));
  assert.equal(revalueForeignBalances(db, '2026-02-28', { ...options, excludedAccountIds: [accountId(db, '121000')] }), db);
  assert.ok(applyDiff(db, diffDb(db, posted)));

  const reversal = search(posted, 'account.move').find((m) => m.id === entry.reversal_move_id);
  assert.equal(isRevaluationMovePair(posted, { ...entry, revaluation_options: { journalId: 999999 } }, reversal), false);
  assert.equal(isRevaluationMovePair(posted, { ...entry, revaluation_options: { journalId: 'bad' } }, reversal), false);
  assert.equal(isRevaluationMovePair(posted, { ...entry, revaluation_options: 'bad' }, reversal), false);
});

test('a loss uses the selected expense provision account', () => {
  const currency = create(seed(), 'res.currency', { name: 'REV1LOSS', rate_ids: [{ date: '2026-01-01', rate: 1 }, { date: '2026-02-01', rate: 2 }] });
  const invoice = create(currency.db, 'account.move', { move_type: 'out_invoice', partner_id: 1, currency_id: currency.id, invoice_date: '2026-01-01', invoice_line_ids: [{ name: 'Service', qty: 1, price_unit: 100, tax: 0 }] });
  const db = postMove(invoice.db, invoice.id);
  const expenseAccountId = accountId(db, '690100');
  const result = revalueForeignBalances(db, '2026-02-28', { companyId: 1, journalId: journalId(db, 'MISC'), expenseAccountId, incomeAccountId: accountId(db, '450100') });
  const entry = search(result, 'account.move').find((m) => m.revaluation_date === '2026-02-28');
  assert.ok(entry.line_ids.some((line) => line.account_id === expenseAccountId && line.debit > 0));
  assert.ok(applyDiff(db, diffDb(db, result)));
});

test('revalueForeignBalances called with no options posts to the company configured revaluation journal and provision accounts', () => {
  let db = seed();
  const revalJournal = create(db, 'account.journal', { name: 'Reval Default Journal', code: 'RVDF', type: 'general', company_id: 1 });
  const incomeProvision = create(revalJournal.db, 'account.account', { code: '450177', name: 'Configured Income Provision', account_type: 'income_other', company_id: 1 });
  const expenseProvision = create(incomeProvision.db, 'account.account', { code: '690177', name: 'Configured Expense Provision', account_type: 'expense_other', company_id: 1 });
  db = write(expenseProvision.db, 'res.company', 1, {
    account_revaluation_journal_id: revalJournal.id,
    account_revaluation_income_provision_account_id: incomeProvision.id,
    account_revaluation_expense_provision_account_id: expenseProvision.id,
  });

  const fx = create(db, 'res.currency', { name: 'REV1NOOPT', rate_ids: [{ date: '2026-01-01', rate: 2 }, { date: '2026-02-01', rate: 1 }] });
  const invoice = create(fx.db, 'account.move', { move_type: 'out_invoice', partner_id: 1, currency_id: fx.id, invoice_date: '2026-01-01', invoice_line_ids: [{ name: 'Gain Service', qty: 1, price_unit: 100, tax: 0 }] });
  const bill = create(postMove(invoice.db, invoice.id), 'account.move', { move_type: 'in_invoice', partner_id: 2, currency_id: fx.id, invoice_date: '2026-01-01', invoice_line_ids: [{ name: 'Loss Service', qty: 1, price_unit: 60, tax: 0 }] });
  const ready = postMove(bill.db, bill.id);

  const result = revalueForeignBalances(ready, '2026-02-28');
  const entry = search(result, 'account.move').find((m) => m.revaluation_date === '2026-02-28');
  assert.ok(entry);
  assert.equal(entry.journal_id, revalJournal.id);
  assert.equal(entry.line_ids.find((l) => l.account_id === incomeProvision.id)?.credit, 50);
  assert.equal(entry.line_ids.find((l) => l.account_id === expenseProvision.id)?.debit, 30);
  assert.ok(applyDiff(ready, diffDb(ready, result)));

  // Explicit options still win over company defaults.
  const explicitJournal = journalId(ready, 'MISC');
  const explicitIncome = accountId(ready, '450100');
  const explicitExpense = accountId(ready, '690100');
  const overridden = revalueForeignBalances(ready, '2026-02-28', {
    journalId: explicitJournal,
    incomeAccountId: explicitIncome,
    expenseAccountId: explicitExpense,
  });
  const overriddenEntry = search(overridden, 'account.move').find((m) => m.revaluation_date === '2026-02-28');
  assert.equal(overriddenEntry.journal_id, explicitJournal);
  assert.equal(overriddenEntry.line_ids.find((l) => l.account_id === explicitIncome)?.credit, 50);
  assert.equal(overriddenEntry.line_ids.find((l) => l.account_id === explicitExpense)?.debit, 30);
  assert.ok(applyDiff(ready, diffDb(ready, overridden)));
});

test('UnrealizedCurrencies wizard previews lines, posts with company defaults, excludes accounts, and opens entry', async () => {
  const { makeEl } = setupDom();
  const container = makeEl('div');
  container.ownerDocument = globalThis.document;
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit, getDb } = await import('./store.js');
  await initStore();
  let db = seed();
  const extraJournal = create(db, 'account.journal', { name: 'FX Reval Journal', code: 'FXRV', type: 'general', company_id: 1 });
  const customIncome = create(extraJournal.db, 'account.account', { code: '450199', name: 'FX Gain Provision', account_type: 'income_other', company_id: 1 });
  const customExpense = create(customIncome.db, 'account.account', { code: '690199', name: 'FX Loss Provision', account_type: 'expense', company_id: 1 });
  db = write(customExpense.db, 'res.company', 1, {
    account_revaluation_journal_id: extraJournal.id,
    account_revaluation_income_provision_account_id: customIncome.id,
    account_revaluation_expense_provision_account_id: customExpense.id,
  });
  const fx = create(db, 'res.currency', { name: 'UIFX', rate_ids: [{ date: '2026-01-01', rate: 2 }, { date: '2026-02-01', rate: 1 }] });
  const inv = create(fx.db, 'account.move', { move_type: 'out_invoice', partner_id: 1, currency_id: fx.id, invoice_date: '2026-01-01', invoice_line_ids: [{ name: 'UI FX Service', qty: 1, price_unit: 100, tax: 0 }] });
  db = postMove(inv.db, inv.id);
  await commit(db);

  const { UnrealizedCurrencies } = await import('./views/UnrealizedCurrencies.jsx');
  const root = createRoot(container);
  try {
    await React.act(async () => root.render(React.createElement(UnrealizedCurrencies)));
    const dateInput = find(container, (n) => n.tagName === 'INPUT' && props(n)?.type === 'date');
    await React.act(async () => props(dateInput).onChange({ target: { value: '2026-02-28' } }));
    assert.ok(container.textContent.includes('UIFX'));

    // Exclude account drops it from the report; Restore brings it back.
    const excludeBtn = find(container, (n) => n.tagName === 'BUTTON' && n.textContent === 'Exclude Account');
    assert.ok(excludeBtn);
    await React.act(async () => props(excludeBtn).onClick());
    assert.ok(!container.textContent.includes('UIFX'));
    const restoreBtn = find(container, (n) => n.tagName === 'BUTTON' && n.textContent === 'Restore Accounts');
    assert.ok(restoreBtn);
    await React.act(async () => props(restoreBtn).onClick());
    assert.ok(container.textContent.includes('UIFX'));

    // Open Adjustment Entry wizard: company defaults are preselected and preview lines are rendered.
    const openBtn = find(container, (n) => n.tagName === 'BUTTON' && n.textContent === 'Adjustment Entry');
    await React.act(async () => props(openBtn).onClick());
    const dialog = find(container, (n) => props(n)?.role === 'dialog');
    assert.ok(dialog);
    const selects = [];
    const collectSelects = (node) => {
      if (node.tagName === 'SELECT') selects.push(node);
      for (const c of node.childNodes ?? []) collectSelects(c);
    };
    collectSelects(dialog);
    assert.deepEqual(selects.map((s) => props(s).value), [extraJournal.id, customExpense.id, customIncome.id]);
    assert.ok(dialog.textContent.includes('FX Gain Provision'));

    const previewRows = [];
    const collectRows = (node) => {
      if (node.tagName === 'TR' && node.parentNode?.tagName === 'TBODY') previewRows.push(node.textContent);
      for (const c of node.childNodes ?? []) collectRows(c);
    };
    collectRows(dialog);
    assert.equal(previewRows.length, 2);

    const postBtn = find(dialog, (n) => n.tagName === 'BUTTON' && n.textContent === 'Post');
    await React.act(async () => { await props(postBtn).onClick(); });

    const created = search(getDb(), 'account.move').find((m) => m.revaluation_date === '2026-02-28');
    assert.ok(created);
    assert.equal(created.journal_id, extraJournal.id);
    assert.ok(created.line_ids.some((l) => l.account_id === customIncome.id && l.credit > 0));
    assert.equal(previewRows.length, created.line_ids.length);
    for (const line of created.line_ids) {
      const acc = search(getDb(), 'account.account').find((a) => a.id === line.account_id);
      assert.ok(previewRows.some((row) => row.includes(acc.name) && row.includes((line.debit || line.credit).toFixed(2))));
    }
    assert.equal(location.hash, `#/accounting/entries/${created.id}`);
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('SalesReview Invoices To Be Issued creates invoices for selected orders', async () => {
  const { makeEl } = setupDom();
  const container = makeEl('div');
  container.ownerDocument = globalThis.document;
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit, getDb } = await import('./store.js');
  await initStore();
  let db = seed();
  const product = create(db, 'product', { name: 'Deliverable Review Service', type: 'service', invoice_policy: 'delivery' });
  const order = create(product.db, 'sale.order', {
    partner_id: 1,
    state: 'sale',
    order_line: [{ product_id: product.id, name: 'Deliverable Review Service', qty: 4, qty_delivered: 2, price_unit: 25, tax: 0 }],
  });
  await commit(order.db);

  const { SalesReview } = await import('./views/SalesReview.jsx');
  const leaf = { key: 'invoices-to-be-issued', label: 'Invoices To Be Issued', type: 'report', report: 'invoicesToBeIssued' };
  const root = createRoot(container);
  try {
    await React.act(async () => root.render(React.createElement(SalesReview, { leaf })));
    const periodSelect = find(container, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === 'Period');
    await React.act(async () => props(periodSelect).onChange({ target: { value: 'all' } }));
    const orderRec = read(order.db, 'sale.order', order.id);
    const checkbox = find(container, (n) => n.tagName === 'INPUT' && props(n)?.['aria-label'] === `Select Order ${orderRec.name}`);
    assert.ok(checkbox);
    const createBtn = find(container, (n) => n.tagName === 'BUTTON' && n.textContent === 'Create Invoices');
    assert.equal(props(createBtn).disabled, true);
    await React.act(async () => props(checkbox).onChange({ target: { checked: true } }));
    assert.equal(props(find(container, (n) => n.tagName === 'BUTTON' && n.textContent === 'Create Invoices')).disabled, false);
    await React.act(async () => { await props(find(container, (n) => n.tagName === 'BUTTON' && n.textContent === 'Create Invoices')).onClick(); });

    const invoices = search(getDb(), 'account.move').filter((m) => m.sale_id === order.id);
    assert.equal(invoices.length, 1);
    assert.equal(invoices[0].invoice_line_ids[0].qty, 2);
    assert.ok(!container.textContent.includes('Deliverable Review Service'));
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('Settings edits company revaluation defaults and Deferred reports link to deferrals', async () => {
  const { makeEl } = setupDom();
  const container = makeEl('div');
  container.ownerDocument = globalThis.document;
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit, getDb } = await import('./store.js');
  await initStore();
  let db = seed();
  const journal = create(db, 'account.journal', { name: 'Settings Reval Journal', code: 'SRVL', type: 'general', company_id: 1 });
  const income = create(journal.db, 'account.account', { code: '450188', name: 'Settings Income Prov', account_type: 'income_other', company_id: 1 });
  const expense = create(income.db, 'account.account', { code: '690188', name: 'Settings Expense Prov', account_type: 'expense', company_id: 1 });
  await commit(expense.db);

  const { Settings } = await import('./views/Settings.jsx');
  const root = createRoot(container);
  try {
    await React.act(async () => root.render(React.createElement(Settings)));
    const jSel = find(container, (n) => n.tagName === 'SELECT' && props(n)?.id === 'account_revaluation_journal_id');
    const eSel = find(container, (n) => n.tagName === 'SELECT' && props(n)?.id === 'account_revaluation_expense_provision_account_id');
    const iSel = find(container, (n) => n.tagName === 'SELECT' && props(n)?.id === 'account_revaluation_income_provision_account_id');
    assert.ok(jSel && eSel && iSel);
    await React.act(async () => props(jSel).onChange({ target: { value: String(journal.id) } }));
    await React.act(async () => props(eSel).onChange({ target: { value: String(expense.id) } }));
    await React.act(async () => props(iSel).onChange({ target: { value: String(income.id) } }));
    const company = getDb().records['res.company'].find((c) => c.id === 1);
    assert.equal(company.account_revaluation_journal_id, journal.id);
    assert.equal(company.account_revaluation_expense_provision_account_id, expense.id);
    assert.equal(company.account_revaluation_income_provision_account_id, income.id);
  } finally {
    await React.act(async () => root.unmount());
  }

  const { Reports } = await import('./views/Reports.jsx');
  const repHost = makeEl('div');
  repHost.ownerDocument = globalThis.document;
  const repRoot = createRoot(repHost);
  try {
    await React.act(async () => repRoot.render(React.createElement(Reports, { leaf: { report: 'deferredRevenue' } })));
    assert.ok(find(repHost, (n) => n.tagName === 'A' && props(n)?.href === '#/accounting/deferred-revenues'));
  } finally {
    await React.act(async () => repRoot.unmount());
  }
});

test('company revaluation defaults guard and Arabic translations', async () => {
  const db = seed();
  const archivedJournal = create(db, 'account.journal', { name: 'Archived General', code: 'ARRV', type: 'general', company_id: 1, active: false });
  const saleJournal = search(archivedJournal.db, 'account.journal').find((j) => j.type === 'sale' && (j.company_id ?? 1) === 1);
  const secondCompany = create(archivedJournal.db, 'res.company', { name: 'Other Co' });
  const foreignAcc = create(secondCompany.db, 'account.account', { code: '450999', name: 'Other Co Income', account_type: 'income_other', company_id: secondCompany.id });
  const base = foreignAcc.db;

  assert.throws(
    () => applyDiff(base, diffDb(base, write(base, 'res.company', 1, { account_revaluation_journal_id: archivedJournal.id }))),
    /Revaluation Journal must be an active general journal/,
  );
  assert.throws(
    () => applyDiff(base, diffDb(base, write(base, 'res.company', 1, { account_revaluation_journal_id: saleJournal.id }))),
    /Revaluation Journal must be an active general journal/,
  );
  assert.throws(
    () => applyDiff(base, diffDb(base, write(base, 'res.company', 1, { account_revaluation_income_provision_account_id: foreignAcc.id }))),
    /Income Provision Account belonging to this company/,
  );

  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem() {} };
  try {
    const { t } = await import(`./i18n.js?rev1_ar=${Date.now()}`);
    for (const phrase of [
      'Revaluation Journal',
      'Expense Provision Account',
      'Income Provision Account',
      'Adjustment Entry',
      'Exclude Account',
      'Restore Accounts',
      'Create Invoices',
      'Select Order',
      'Select an active general journal for this company',
      'Select an active provision account for this company',
      'Select a journal and provision accounts',
      'Select a confirmed sales order',
      'Revaluation Options',
      'Default for currency adjustment entries.',
      'No adjustment lines to post.',
      'Select an active account belonging to this company',
      'Revaluation Journal must be an active general journal shared with or belonging to this company',
      'Select an active Expense Provision Account belonging to this company',
      'Select an active Income Provision Account belonging to this company',
    ]) {
      const ar = t(phrase);
      assert.notEqual(ar, phrase, `Missing Arabic translation for: ${phrase}`);
      assert.match(ar, /[\u0600-\u06FF]/, `Expected Arabic characters for: ${phrase}`);
    }
  } finally {
    globalThis.localStorage = prevStorage;
  }
});
