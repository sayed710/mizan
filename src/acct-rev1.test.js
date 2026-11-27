import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { menusFor } from './models/index.js';
import { postMove } from './models/accounting.js';
import { createCompany } from './models/company.js';
import { isRevaluationMovePair, revalueForeignBalances } from './models/closing.js';
import { accountId, journalId } from './models/ledger.js';
import { migrate } from './migrations.js';
import { diffDb, applyDiff } from './sync.js';
import { createCompanyWithDefaultInvoiceJournals } from './test-support/accounting-company.js';
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
      'Select a single company to create an adjustment entry',
    ]) {
      const ar = t(phrase);
      assert.notEqual(ar, phrase, `Missing Arabic translation for: ${phrase}`);
      assert.match(ar, /[\u0600-\u06FF]/, `Expected Arabic characters for: ${phrase}`);
    }
  } finally {
    globalThis.localStorage = prevStorage;
  }
});

test('non-admin sync writes to company revaluation defaults are rejected', () => {
  let db = seed();
  const altJournal = create(db, 'account.journal', { name: 'Alt Reval Journal', code: 'ALTR', type: 'general', company_id: 1 });
  const altExpense = create(altJournal.db, 'account.account', { code: '690190', name: 'Alt Expense Provision', account_type: 'expense_other', company_id: 1 });
  const altIncome = create(altExpense.db, 'account.account', { code: '450190', name: 'Alt Income Provision', account_type: 'income_other', company_id: 1 });
  db = altIncome.db;

  for (const [field, value] of [
    ['account_revaluation_journal_id', altJournal.id],
    ['account_revaluation_expense_provision_account_id', altExpense.id],
    ['account_revaluation_income_provision_account_id', altIncome.id],
  ]) {
    const forged = {
      ...db,
      records: {
        ...db.records,
        'res.company': db.records['res.company'].map((c) => (c.id === 1 ? { ...c, [field]: value } : c)),
      },
    };
    assert.throws(
      () => applyDiff(db, diffDb(db, forged), { isAdmin: false }),
      /Only administrators can change lock dates or the audit trail or other company accounting settings/i,
      `Expected non-admin write to ${field} to be rejected`,
    );
    const adminApplied = applyDiff(db, diffDb(db, forged), { isAdmin: true });
    assert.equal(read(adminApplied, 'res.company', 1)[field], value);
  }
});

test('a journal referenced as account_revaluation_journal_id cannot be archived, retyped, or moved', () => {
  const journal = create(seed(), 'account.journal', { name: 'Locked Reval Journal', code: 'LRVJ', type: 'general', company_id: 1 });
  let db = write(journal.db, 'res.company', 1, { account_revaluation_journal_id: journal.id });
  const other = createCompany(db, { name: 'Second Co' });
  db = other.db;

  for (const change of [{ active: false }, { type: 'sale' }, { company_id: other.id }]) {
    assert.throws(
      () => write(db, 'account.journal', journal.id, change),
      /Clear the Revaluation Journal of company/i,
    );
    const attempt = {
      ...db,
      records: {
        ...db.records,
        'account.journal': db.records['account.journal'].map((j) => (j.id === journal.id ? { ...j, ...change } : j)),
      },
    };
    assert.throws(
      () => applyDiff(db, diffDb(db, attempt), { isAdmin: true }),
      /Clear the Revaluation Journal of company/i,
    );
  }

  const cleared = write(db, 'res.company', 1, { account_revaluation_journal_id: null });
  assert.equal(read(write(cleared, 'account.journal', journal.id, { active: false }), 'account.journal', journal.id).active, false);
});

test('revaluation sync validation succeeds even if company defaults change before applyDiff', () => {
  let db = seed();
  const j1 = create(db, 'account.journal', { name: 'Reval J1', code: 'RVJ1', type: 'general', company_id: 1 });
  const j2 = create(j1.db, 'account.journal', { name: 'Reval J2', code: 'RVJ2', type: 'general', company_id: 1 });
  const inc1 = create(j2.db, 'account.account', { code: '450151', name: 'Income Prov 1', account_type: 'income_other', company_id: 1 });
  const inc2 = create(inc1.db, 'account.account', { code: '450152', name: 'Income Prov 2', account_type: 'income_other', company_id: 1 });
  const exp1 = create(inc2.db, 'account.account', { code: '690151', name: 'Expense Prov 1', account_type: 'expense_other', company_id: 1 });
  const exp2 = create(exp1.db, 'account.account', { code: '690152', name: 'Expense Prov 2', account_type: 'expense_other', company_id: 1 });
  db = write(exp2.db, 'res.company', 1, {
    account_revaluation_journal_id: j1.id,
    account_revaluation_income_provision_account_id: inc1.id,
    account_revaluation_expense_provision_account_id: exp1.id,
  });

  const fx = create(db, 'res.currency', { name: 'DEFCHG', rate_ids: [{ date: '2026-01-01', rate: 2 }, { date: '2026-02-01', rate: 1 }] });
  const inv = create(fx.db, 'account.move', { move_type: 'out_invoice', partner_id: 1, currency_id: fx.id, invoice_date: '2026-01-01', invoice_line_ids: [{ name: 'Gain Item', qty: 1, price_unit: 100, tax: 0 }] });
  const bill = create(postMove(inv.db, inv.id), 'account.move', { move_type: 'in_invoice', partner_id: 2, currency_id: fx.id, invoice_date: '2026-01-01', invoice_line_ids: [{ name: 'Loss Item', qty: 1, price_unit: 40, tax: 0 }] });
  const base = postMove(bill.db, bill.id);

  // Client computes revaluation using omitted arguments (resolved from company defaults J1 / inc1 / exp1).
  const revalued = revalueForeignBalances(base, '2026-02-28', { companyId: 1 });
  const diff = diffDb(base, revalued);

  // Server defaults change before the client diff is applied.
  const serverWithNewDefaults = write(base, 'res.company', 1, {
    account_revaluation_journal_id: j2.id,
    account_revaluation_income_provision_account_id: inc2.id,
    account_revaluation_expense_provision_account_id: exp2.id,
  });
  const saved = applyDiff(serverWithNewDefaults, diff);
  const entry = search(saved, 'account.move').find((m) => m.revaluation_date === '2026-02-28');
  assert.ok(entry);
  assert.equal(entry.journal_id, j1.id);
  assert.equal(entry.line_ids.find((l) => l.account_id === inc1.id)?.credit, 50);
  assert.equal(entry.line_ids.find((l) => l.account_id === exp1.id)?.debit, 20);
});

test('pre-change revaluation adjustment pairs without revaluation_options pass validation', () => {
  const fx = create(seed(), 'res.currency', { name: 'LEGACYFX', rate_ids: [{ date: '2026-01-01', rate: 2 }, { date: '2026-02-01', rate: 1 }] });
  const inv = create(fx.db, 'account.move', { move_type: 'out_invoice', partner_id: 1, currency_id: fx.id, invoice_date: '2026-01-01', invoice_line_ids: [{ name: 'Legacy Service', qty: 1, price_unit: 100, tax: 0 }] });
  const base = postMove(inv.db, inv.id);
  const revalued = revalueForeignBalances(base, '2026-02-28', { companyId: 1 });
  const entry = revalued.records['account.move'].find((m) => m.revaluation_date === '2026-02-28');
  const reversal = revalued.records['account.move'].find((m) => m.id === entry.reversal_move_id);

  // Simulate a pre-change adjustment created without revaluation_options.
  const { revaluation_options: _ignored, ...legacyEntry } = entry;
  const legacyDb = {
    ...revalued,
    records: {
      ...revalued.records,
      'account.move': revalued.records['account.move'].map((m) => (m.id === entry.id ? legacyEntry : m)),
    },
  };
  assert.equal(isRevaluationMovePair(legacyDb, legacyEntry, reversal), true);
  assert.ok(applyDiff(base, diffDb(base, legacyDb)));

  // Tampered lines on a pre-change pair are still rejected.
  const tampered = {
    ...legacyEntry,
    line_ids: legacyEntry.line_ids.map((l) => ({ ...l, debit: l.debit ? l.debit + 1 : 0, credit: l.credit ? l.credit + 1 : 0 })),
  };
  assert.equal(isRevaluationMovePair(legacyDb, tampered, reversal), false);
});

test('migration 85 skips archived default general journal and archived exchange accounts so company saves remain valid', () => {
  let db = seed();
  const archivedGeneral = create(db, 'account.journal', { name: 'Archived Gen', code: 'AGNJ', type: 'general', company_id: 1, active: false });
  const archivedIncome = create(archivedGeneral.db, 'account.account', { code: '450166', name: 'Archived Gain', account_type: 'income_other', company_id: 1, active: false });
  const archivedExpense = create(archivedIncome.db, 'account.account', { code: '690166', name: 'Archived Loss', account_type: 'expense_other', company_id: 1, active: false });
  db = archivedExpense.db;

  const preV85ArchivedAccounts = {
    ...db,
    schema_version: 84,
    records: {
      ...db.records,
      'res.company': db.records['res.company'].map((c) => (c.id !== 1 ? c : {
        ...c,
        default_general_journal_id: archivedGeneral.id,
        income_currency_exchange_account_id: archivedIncome.id,
        expense_currency_exchange_account_id: archivedExpense.id,
        account_revaluation_journal_id: undefined,
        account_revaluation_income_provision_account_id: undefined,
        account_revaluation_expense_provision_account_id: undefined,
      })),
    },
  };
  const migratedWithArchivedAccounts = migrate(preV85ArchivedAccounts);
  const compArchivedAccounts = read(migratedWithArchivedAccounts, 'res.company', 1);
  assert.equal(compArchivedAccounts.account_revaluation_journal_id, null);
  assert.equal(compArchivedAccounts.account_revaluation_income_provision_account_id, null);
  assert.equal(compArchivedAccounts.account_revaluation_expense_provision_account_id, null);

  // With only default_general_journal_id archived (which companyGuard allows on legacy records), unrelated company writes still succeed.
  const preV85ArchivedJournal = {
    ...db,
    schema_version: 84,
    records: {
      ...db.records,
      'res.company': db.records['res.company'].map((c) => (c.id !== 1 ? c : {
        ...c,
        default_general_journal_id: archivedGeneral.id,
        account_revaluation_journal_id: undefined,
        account_revaluation_income_provision_account_id: undefined,
        account_revaluation_expense_provision_account_id: undefined,
      })),
    },
  };
  const migrated = migrate(preV85ArchivedJournal);
  assert.equal(read(migrated, 'res.company', 1).account_revaluation_journal_id, null);
  const renamed = write(migrated, 'res.company', 1, { name: 'Updated Co Name' });
  assert.equal(read(renamed, 'res.company', 1).name, 'Updated Co Name');

  // createCompany also does not copy an archived default_general_journal_id into account_revaluation_journal_id.
  const sharedArchivedGeneral = create(db, 'account.journal', { name: 'Shared Archived Gen', code: 'SAGN', type: 'general', company_id: null, active: false });
  const newCo = createCompany(sharedArchivedGeneral.db, { name: 'Archived Default Co', default_general_journal_id: sharedArchivedGeneral.id });
  assert.equal(read(newCo.db, 'res.company', newCo.id).account_revaluation_journal_id ?? null, null);
});

test('UnrealizedCurrencies disables Adjustment Entry in multi-company all view and scopes wizard when a company is selected', async () => {
  const { makeEl } = setupDom();
  const container = makeEl('div');
  container.ownerDocument = globalThis.document;
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit, getDb } = await import('./store.js');
  await initStore();

  let db = seed();
  const co2 = createCompanyWithDefaultInvoiceJournals(db, { name: 'Branch Co', currency_id: db.settings.base_currency_id });
  const j2 = create(co2.db, 'account.journal', { name: 'Branch Reval', code: 'BRRV', type: 'general', company_id: co2.id });
  db = write(j2.db, 'res.company', co2.id, {
    default_general_journal_id: j2.id,
    account_revaluation_journal_id: j2.id,
  });
  const fx = create(db, 'res.currency', { name: 'MCFX', rate_ids: [{ date: '2026-01-01', rate: 2 }, { date: '2026-02-01', rate: 1 }] });
  const inv1 = create(fx.db, 'account.move', { move_type: 'out_invoice', company_id: 1, partner_id: 1, currency_id: fx.id, invoice_date: '2026-01-01', invoice_line_ids: [{ name: 'Co1 FX', qty: 1, price_unit: 100, tax: 0 }] });
  db = postMove(inv1.db, inv1.id);
  const inv2 = create(db, 'account.move', { move_type: 'out_invoice', company_id: co2.id, partner_id: 1, currency_id: fx.id, invoice_date: '2026-01-01', invoice_line_ids: [{ name: 'Co2 FX', qty: 1, price_unit: 200, tax: 0 }] });
  db = postMove(inv2.db, inv2.id);
  db = { ...db, settings: { ...db.settings, allowed_company_ids: [1, co2.id] } };
  await commit(db);

  const { UnrealizedCurrencies } = await import('./views/UnrealizedCurrencies.jsx');
  const root = createRoot(container);
  try {
    await React.act(async () => root.render(React.createElement(UnrealizedCurrencies)));
    const dateInput = find(container, (n) => n.tagName === 'INPUT' && props(n)?.type === 'date');
    await React.act(async () => props(dateInput).onChange({ target: { value: '2026-02-28' } }));

    // In All Companies view, Adjustment Entry is disabled with an explanatory tooltip.
    const allBtn = find(container, (n) => n.tagName === 'BUTTON' && n.textContent === 'Adjustment Entry');
    assert.equal(props(allBtn).disabled, true);
    assert.equal(props(allBtn).title, 'Select a single company to create an adjustment entry');
    const allBodyText = find(container, (n) => n.tagName === 'TBODY').textContent;
    assert.ok(allBodyText.includes('Mizan Demo Co'));
    assert.ok(allBodyText.includes('Branch Co'));

    // Selecting Branch Co narrows visible rows to Branch Co and enables the wizard scoped to Branch Co.
    const companySel = find(container, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === 'Company');
    await React.act(async () => props(companySel).onChange({ target: { value: String(co2.id) } }));
    const scopedBodyText = find(container, (n) => n.tagName === 'TBODY').textContent;
    assert.ok(!scopedBodyText.includes('Mizan Demo Co'));
    assert.ok(scopedBodyText.includes('Branch Co'));
    const scopedBtn = find(container, (n) => n.tagName === 'BUTTON' && n.textContent === 'Adjustment Entry');
    assert.equal(props(scopedBtn).disabled, false);
    assert.equal(props(scopedBtn).title, undefined);

    await React.act(async () => props(scopedBtn).onClick());
    const dialog = find(container, (n) => props(n)?.role === 'dialog');
    assert.ok(dialog);
    assert.ok(dialog.textContent.includes('Branch Co'));
    const postBtn = find(dialog, (n) => n.tagName === 'BUTTON' && n.textContent === 'Post');
    await React.act(async () => { await props(postBtn).onClick(); });

    const created = search(getDb(), 'account.move').filter((m) => m.revaluation_date === '2026-02-28');
    assert.equal(created.length, 1);
    assert.equal(created[0].company_id, co2.id);
    assert.equal(created[0].journal_id, j2.id);
  } finally {
    await React.act(async () => root.unmount());
  }
});
