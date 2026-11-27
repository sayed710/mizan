import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { create, read, search } from './orm.js';
import { seed } from './seed.js';
import { today } from './models/common.js';
import { accountId, postEntry } from './models/ledger.js';
import { createCompany, setCompanies } from './models/company.js';
import { invoiceJournalDefaults } from './test-support/accounting-company.js';
import { depreciationReport } from './models/assets.js';
import { accountCashFlowActivity, cashFlow, generalLedger, trialBalance } from './models/reports.js';
import { filterReportBudgets, groupBudgetReportEntries } from './models/analyticplus.js';
import { cashflowColumns } from './views/reportCompare.js';
import { fromCsv } from './csv.js';
import { readXlsx } from './xlsx.js';
import { setupDom, find } from './test-support/dom.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const props = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];

function findAll(node, predicate, out = []) {
  if (!node) return out;
  if (predicate(node)) out.push(node);
  for (const child of node.childNodes ?? []) findAll(child, predicate, out);
  return out;
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

  return {
    async takeLast() {
      const entry = downloads.pop();
      if (!entry?.blob) return null;
      return {
        filename: entry.filename,
        type: entry.blob.type,
        bytes: new Uint8Array(await entry.blob.arrayBuffer()),
        text: async () => entry.blob.text(),
      };
    },
    restore() {
      globalThis.document.createElement = origCreateElement;
      globalThis.document.createElementNS = origCreateElementNS;
      URL.createObjectURL = origCreateUrl;
      URL.revokeObjectURL = origRevokeUrl;
    },
  };
}

// Item 4 (model): Depreciation grouping
test('depreciation groups assets by model, account and company with subtotals', () => {
  let db = seed();
  const account = search(db, 'account.account')[0];
  const model = create(db, 'account.asset.model', { name: 'Equipment model', company_id: 1 });
  db = model.db;
  db = create(db, 'account.asset', { name: 'Machine', company_id: 1, model_id: model.id, account_asset_id: account.id, original_value: 100, acquisition_date: '2026-01-01', state: 'open' }).db;
  for (const [field, id, name] of [['model_id', model.id, 'Equipment model'], ['account_asset_id', account.id, account.name], ['company_id', 1, search(db, 'res.company').find((c) => c.id === 1).name]]) {
    const group = depreciationReport(db, { to: '2026-12-31' }, 1, { groupBy: field }).groups.find((g) => g.id === id);
    assert.equal(group.name, name);
    assert.equal(group.totals.original, 100);
  }
});

// Item 4 (UI): Depreciation report Group By selector includes model, account, company, asset_group_id
test('depreciation report UI exposes Group By Asset Group, Depreciation Model, Asset Account and Company', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();

  let db = seed();
  const branch = createCompany(db, { name: 'Dep Branch', ...invoiceJournalDefaults(db) });
  db = setCompanies(branch.db, { current: 1, allowed: [1, branch.id] });
  const account = search(db, 'account.account').find((a) => a.account_type === 'asset_fixed');
  const model = create(db, 'account.asset.model', { name: 'Server Model', company_id: 1 });
  db = model.db;
  db = create(db, 'account.asset', {
    name: 'Rack Server',
    company_id: 1,
    model_id: model.id,
    account_asset_id: account.id,
    original_value: 1200,
    acquisition_date: today(),
    state: 'open',
  }).db;
  await React.act(async () => commit(db));

  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'depreciation', title: 'Depreciation Schedule' } })));
    const groupSelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === 'Group By');
    assert.ok(groupSelect, 'Group By select exists on Depreciation report');
    const optionValues = findAll(groupSelect, (n) => n.tagName === 'OPTION').map((o) => props(o)?.value);
    assert.deepEqual(optionValues, ['', 'asset_group_id', 'model_id', 'account_asset_id', 'company_id']);

    for (const [value, expectedGroupName] of [
      ['model_id', 'Server Model'],
      ['account_asset_id', account.name],
      ['company_id', read(db, 'res.company', 1).name],
    ]) {
      await React.act(async () => props(groupSelect).onChange({ target: { value } }));
      const section = findAll(host, (n) => n.tagName === 'TR' && n.className === 'rep-section').find((tr) => tr.textContent.includes(expectedGroupName));
      assert.ok(section, `Grouped section ${expectedGroupName} renders for ${value}`);
    }
  } finally {
    await React.act(async () => root.unmount());
  }
});

// Item 1: General Ledger columns (Date, Entry, Ref, Label, Partner, Currency, Initial Balance, Debit, Credit, Balance) & account-level Initial Balance
test('General Ledger splits Date, Entry, Ref, Label, Partner, Currency into separate columns and shows account-level Initial Balance', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { money } = await import('./ui.jsx');
  await initStore();

  let db = seed();
  db = { ...db, records: { ...db.records, 'account.move': [], 'account.payment': [] } };
  const yr = Number(today().slice(0, 4));
  const partner = create(db, 'res.partner', { name: 'GL Column Partner' });
  db = partner.db;
  const cashAcc = search(db, 'account.account').find((a) => a.code === '101401');
  const revAcc = search(db, 'account.account').find((a) => a.code === '400000');

  // Prior-year entry -> becomes account Initial Balance for this year
  db = postEntry(db, {
    journal: 'MISC',
    company: 1,
    date: `${yr - 1}-12-15`,
    ref: 'PRIOR-REF',
    lines: [
      { account_id: cashAcc.id, partner_id: partner.id, debit: 500, name: 'Opening cash' },
      { account_id: accountId(db, '301000'), credit: 500, name: 'Opening capital' },
    ],
  }).db;

  // Current-year entry with Ref, Label, Partner, and Currency
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  const curEntry = postEntry(db, {
    journal: 'MISC',
    company: 1,
    date: `${yr}-02-10`,
    ref: 'INV-REF-77',
    lines: [
      { account_id: cashAcc.id, partner_id: partner.id, debit: 200, currency_id: eur.id, amount_currency: 184, name: 'Customer receipt line' },
      { account_id: revAcc.id, partner_id: partner.id, credit: 200, name: 'Service fee' },
    ],
  });
  db = curEntry.db;
  const moveName = read(db, 'account.move', curEntry.id).name;

  const gl = generalLedger(db, { from: `${yr}-01-01`, to: `${yr}-12-31`, company_id: 1 });
  assert.equal(gl.rows.find((r) => r.account.id === cashAcc.id).initial, 500);
  assert.equal(gl.totals.initial, 0);

  await React.act(async () => commit(db));
  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'ledger', title: 'General Ledger' } })));

    const headers = findAll(host, (n) => n.tagName === 'TH').map((th) => th.textContent);
    assert.deepEqual(headers, ['Account', 'Date', 'Entry', 'Ref', 'Label', 'Partner', 'Currency', 'Initial Balance', 'Debit', 'Credit', 'Balance']);

    // Account-level Initial Balance is shown on the collapsed account row itself
    const cashSection = findAll(host, (n) => n.tagName === 'TR' && n.className === 'rep-section').find((tr) => tr.textContent.includes('101401'));
    assert.ok(cashSection, 'Cash account row exists');
    const cashCells = findAll(cashSection, (n) => n.tagName === 'TD').map((td) => td.textContent);
    assert.equal(cashCells[headers.indexOf('Initial Balance')], money(500));
    assert.equal(cashCells[headers.indexOf('Debit')], money(200));
    assert.equal(cashCells[headers.indexOf('Credit')], money(0));
    assert.equal(cashCells[headers.indexOf('Balance')], money(700));

    // Expand cash account and verify Initial Balance line + split move line columns
    await React.act(async () => props(cashSection).onClick());
    const detailRows = findAll(host, (n) => n.tagName === 'TR' && n.className === 'rep-detail');
    const initialRow = detailRows.find((tr) => tr.textContent.includes('Initial Balance'));
    assert.ok(initialRow, 'Initial Balance detail row rendered inside expanded account');
    const initCells = findAll(initialRow, (n) => n.tagName === 'TD').map((td) => td.textContent);
    assert.equal(initCells[headers.indexOf('Initial Balance')], money(500));
    assert.equal(initCells[headers.indexOf('Balance')], money(500));

    const moveRow = detailRows.find((tr) => tr.textContent.includes('Customer receipt line'));
    assert.ok(moveRow, 'Move line row rendered');
    const moveCells = findAll(moveRow, (n) => n.tagName === 'TD').map((td) => td.textContent);
    assert.equal(moveCells[headers.indexOf('Date')], `${yr}-02-10`);
    assert.equal(moveCells[headers.indexOf('Entry')], moveName);
    assert.equal(moveCells[headers.indexOf('Ref')], 'INV-REF-77');
    assert.equal(moveCells[headers.indexOf('Label')], 'Customer receipt line');
    assert.equal(moveCells[headers.indexOf('Partner')], 'GL Column Partner');
    assert.ok(moveCells[headers.indexOf('Currency')].includes('184'), 'Currency column shows amount_currency');
    assert.equal(moveCells[headers.indexOf('Debit')], money(200));
    assert.equal(moveCells[headers.indexOf('Balance')], money(700));
  } finally {
    await React.act(async () => root.unmount());
  }
});

// Item 2: Trial Balance group-by (Account Type and Account Group hierarchy) + diffDb/applyDiff guards
test('Trial Balance keeps flat view as default and supports Group By Account Type and Account Group hierarchy', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { money } = await import('./ui.jsx');
  await initStore();

  let db = seed();
  db = { ...db, records: { ...db.records, 'account.move': [], 'account.payment': [] } };
  const yr = Number(today().slice(0, 4));
  const branch = createCompany(db, { name: 'TB Guard Branch', ...invoiceJournalDefaults(db) });
  db = branch.db;

  // Create hierarchical account.group records: Root "Assets (1)" -> Child "Cash & Bank (101)"
  const rootGrp = create(db, 'account.group', { name: 'Assets Group', code_prefix_start: '1', code_prefix_end: '1', company_id: 1 });
  const childGrp = create(rootGrp.db, 'account.group', { name: 'Liquid Assets', code_prefix_start: '101', code_prefix_end: '101', company_id: 1 });
  const branchGrp = create(childGrp.db, 'account.group', { name: 'Branch Group', company_id: branch.id });
  db = branchGrp.db;

  const accCash = search(db, 'account.account').find((a) => a.code === '101401');
  assert.equal(accCash.group_id, childGrp.id);
  assert.equal(read(db, 'account.group', childGrp.id).parent_id, rootGrp.id);

  // Post entries to 101401 (Liquid Assets -> Assets Group) and 400000 (Income, ungrouped)
  db = postEntry(db, {
    journal: 'MISC',
    company: 1,
    date: `${yr}-03-01`,
    lines: [
      { account_id: accCash.id, debit: 450 },
      { account: '400000', credit: 450 },
    ],
  }).db;

  // Model check for trialBalance groupBy
  const byType = trialBalance(db, { from: `${yr}-01-01`, to: `${yr}-12-31`, company_id: 1, groupBy: 'account_type' });
  assert.equal(byType.groups.find((g) => g.id === 'asset_cash').periodTotals[0].debit, 450);
  const byGroup = trialBalance(db, { from: `${yr}-01-01`, to: `${yr}-12-31`, company_id: 1, groupBy: 'account_group' });
  assert.equal(byGroup.groups.find((g) => g.id === rootGrp.id).periodTotals[0].debit, 450);
  assert.equal(byGroup.groups.find((g) => g.id === childGrp.id).depth, 1);

  await React.act(async () => commit(db));
  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'trial', title: 'Trial Balance' } })));

    // Default is flat account view (no .rep-section group headers)
    const groupSelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === 'Group By');
    assert.ok(groupSelect, 'Group By select exists on Trial Balance');
    assert.equal(props(groupSelect).value, '', 'Flat view is selected by default');
    assert.equal(findAll(host, (n) => n.tagName === 'TR' && n.className === 'rep-section').length, 0);

    // Switch to Account Type
    await React.act(async () => props(groupSelect).onChange({ target: { value: 'account_type' } }));
    const typeSections = findAll(host, (n) => n.tagName === 'TR' && n.className === 'rep-section');
    const cashTypeRow = typeSections.find((tr) => tr.textContent.includes('Bank and Cash'));
    assert.ok(cashTypeRow, 'Bank and Cash group row rendered');
    assert.ok(cashTypeRow.textContent.includes(money(450)), 'Account Type subtotal includes 450');

    // Switch to Account Group
    await React.act(async () => props(groupSelect).onChange({ target: { value: 'account_group' } }));
    const groupSections = findAll(host, (n) => n.tagName === 'TR' && n.className === 'rep-section');
    assert.ok(groupSections.some((tr) => tr.textContent.includes('Assets Group') && tr.textContent.includes(money(450))), 'Parent account.group rolls up child balance');
    assert.ok(groupSections.some((tr) => tr.textContent.includes('Liquid Assets') && tr.textContent.includes(money(450))), 'Child account.group shows subtotal');
  } finally {
    await React.act(async () => root.unmount());
  }
});

// Item 3: Cash Flow keeps Unclassified for untagged balance-sheet accounts and routes untagged expense/income/receivable/payable to operating
test('Cash Flow routes untagged balance-sheet accounts to Unclassified and untagged expense accounts to Operating across model, comparison columns, and UI', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();

  let db = seed();
  db = { ...db, records: { ...db.records, 'account.move': [], 'account.payment': [] } };
  const yr = Number(today().slice(0, 4));
  const cashAcc = search(db, 'account.account').find((a) => a.code === '101401');
  const untaggedBsAcc = create(db, 'account.account', { code: '159888', name: 'Untagged Equipment', account_type: 'asset_fixed', tag_ids: [] });
  const untaggedExpAcc = create(untaggedBsAcc.db, 'account.account', { code: '659888', name: 'Untagged Office Expense', account_type: 'expense', tag_ids: [] });
  db = untaggedExpAcc.db;

  assert.equal(accountCashFlowActivity(db, read(db, 'account.account', untaggedBsAcc.id)), 'unclassified');
  assert.equal(accountCashFlowActivity(db, read(db, 'account.account', untaggedExpAcc.id)), 'operating');

  db = postEntry(db, {
    journal: 'MISC',
    company: 1,
    date: `${yr}-04-10`,
    lines: [{ account_id: cashAcc.id, credit: 300 }, { account_id: untaggedBsAcc.id, debit: 300 }],
  }).db;
  db = postEntry(db, {
    journal: 'MISC',
    company: 1,
    date: `${yr}-04-11`,
    lines: [{ account_id: cashAcc.id, credit: 120 }, { account_id: untaggedExpAcc.id, debit: 120 }],
  }).db;

  const period = { from: `${yr}-04-01`, to: `${yr}-04-30` };
  const cf = cashFlow(db, { ...period, company_id: 1 });
  assert.equal(cf.operating, -120);
  assert.equal(cf.unclassified, -300);
  assert.equal(cf.lines.find((l) => l.account.id === untaggedBsAcc.id)?.section, 'unclassified');
  assert.equal(cf.lines.find((l) => l.account.id === untaggedExpAcc.id)?.section, 'operating');

  const cols = cashflowColumns(db, [{ ...period, label: 'Apr' }], { company_id: 1 });
  const unclassCol = cols.sections.find((s) => s.title === 'Unclassified');
  assert.ok(unclassCol, 'Comparison columns include Unclassified section');
  assert.deepEqual(unclassCol.totals, [-300]);
  assert.equal(cols.sections.find((s) => s.title === 'Operating Activities')?.totals[0], -120);

  await React.act(async () => commit(db));
  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'cashflow', title: 'Cash Flow Statement' } })));
    assert.ok(host.textContent.includes('Unclassified'));
    assert.ok(host.textContent.includes('Untagged Equipment'));
    assert.ok(host.textContent.includes('Operating Activities'));
    assert.ok(host.textContent.includes('Untagged Office Expense'));
  } finally {
    await React.act(async () => root.unmount());
  }
});

// Item 5: Budget report selector, group-by, and Include draft budgets
test('Budget report supports budget selector, group-by, and Include draft budgets option', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { money } = await import('./ui.jsx');
  await initStore();

  let db = seed();
  const yr = Number(today().slice(0, 4));
  const planId = db.records['account.analytic.plan'][0].id;
  const a1 = create(db, 'account.analytic.account', { name: 'Marketing Proj', plan_id: planId, company_id: 1 });
  const a2 = create(a1.db, 'account.analytic.account', { name: 'Ops Proj', plan_id: planId, company_id: 1 });
  db = a2.db;

  const confirmedBud = create(db, 'account.budget', {
    name: 'Confirmed Budget A',
    budget_type: 'expense',
    company_id: 1,
    state: 'confirmed',
    date_from: `${yr}-01-01`,
    date_to: `${yr}-12-31`,
    lines: [
      { analytic_account_id: a1.id, planned: 400 },
      { analytic_account_id: a2.id, planned: 600 },
    ],
  });
  const draftBud = create(confirmedBud.db, 'account.budget', {
    name: 'Draft Budget B',
    budget_type: 'expense',
    company_id: 1,
    state: 'draft',
    date_from: `${yr}-01-01`,
    date_to: `${yr}-12-31`,
    lines: [{ analytic_account_id: a1.id, planned: 250 }],
  });
  db = draftBud.db;

  assert.equal(filterReportBudgets(db, { includeDraft: false }).some((b) => b.id === draftBud.id), false);
  assert.equal(filterReportBudgets(db, { includeDraft: true }).some((b) => b.id === draftBud.id), true);
  assert.equal(typeof groupBudgetReportEntries, 'function');

  await React.act(async () => commit(db));
  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'budget', title: 'Budget vs Actual' } })));

    // Draft budget hidden by default
    assert.ok(host.textContent.includes('Confirmed Budget A'));
    assert.ok(!host.textContent.includes('Draft Budget B'));

    // Toggle Include draft budgets
    const draftCheckbox = find(host, (n) => n.tagName === 'INPUT' && props(n)?.type === 'checkbox' && n.parentNode?.textContent?.includes('Include draft budgets'));
    assert.ok(draftCheckbox, 'Include draft budgets checkbox exists');
    await React.act(async () => props(draftCheckbox).onChange({ target: { checked: true } }));
    assert.ok(host.textContent.includes('Draft Budget B'), 'Draft budget appears when Include draft budgets is checked');

    // Group By Analytic Account rolls up Marketing Proj (400 + 250 = 650 for full year, or proportional for period)
    const groupSelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === 'Group By');
    assert.ok(groupSelect, 'Group By select exists on Budget report');
    await React.act(async () => props(groupSelect).onChange({ target: { value: 'analytic_account_id' } }));
    const periodSelect = find(host, (n) => n.tagName === 'SELECT' && findAll(n, (o) => o.tagName === 'OPTION').some((o) => props(o)?.value === 'year'));
    await React.act(async () => props(periodSelect).onChange({ target: { value: 'year' } }));
    const mktSection = findAll(host, (n) => n.tagName === 'TR' && n.className === 'rep-section').find((tr) => tr.textContent.includes('Marketing Proj'));
    assert.ok(mktSection && mktSection.textContent.includes(money(650)), 'Grouped Analytic Account section sums confirmed + draft budgets');

    // Filter via Budget selector to Draft Budget B only
    const budgetSelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === 'Budget');
    assert.ok(budgetSelect, 'Budget selector exists');
    await React.act(async () => props(budgetSelect).onChange({ target: { value: String(draftBud.id) } }));
    const budgetTableText = find(host, (n) => n.tagName === 'TABLE').textContent;
    assert.ok(budgetTableText.includes('Draft Budget B'));
    assert.ok(!budgetTableText.includes('Confirmed Budget A'));
  } finally {
    await React.act(async () => root.unmount());
  }
});

// Item 6: ConfigurableReport exports CSV & XLSX from report data (hierarchy indent + numeric values)
test('ConfigurableReport builds CSV and XLSX exports from report data with indentation and numeric values', async () => {
  const { makeEl } = setupDom();
  const spy = setupDownloadSpy(makeEl);
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();

  let db = seed();
  db = { ...db, records: { ...db.records, 'account.move': [], 'account.payment': [] } };
  const yr = Number(today().slice(0, 4));
  const cashAcc = search(db, 'account.account').find((a) => a.code === '101401');
  const revAcc = search(db, 'account.account').find((a) => a.code === '400000');

  db = postEntry(db, {
    journal: 'MISC',
    company: 1,
    date: `${yr}-03-15`,
    lines: [{ account_id: cashAcc.id, debit: 1234.5 }, { account_id: revAcc.id, credit: 1234.5 }],
  }).db;
  await React.act(async () => commit(db));

  const { ConfigurableReportPage, configurableReportExportRows } = await import('./views/ConfigurableReport.jsx');
  const sampleRows = configurableReportExportRows({
    headers: ['Balance'],
    showVariance: false,
    rows: [
      { code: 'TOP', name: 'ASSETS', depth: 0, values: [1234.5], foldable: true, accountRows: [{ account: cashAcc, values: [1234.5] }] },
      { code: 'SUB', name: 'Current Assets', depth: 1, values: [1234.5], foldable: false, accountRows: [] },
    ],
  }, new Set(['TOP']));
  assert.deepEqual(sampleRows, [
    ['Report Lines', 'Balance'],
    ['ASSETS', 1234.5],
    [`  ${cashAcc.code} ${cashAcc.name}`, 1234.5],
    ['  Current Assets', 1234.5],
  ]);

  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(ConfigurableReportPage, { statementKind: 'pnl', title: 'Profit and Loss' })));
    const revLine = findAll(host, (n) => n.tagName === 'TR').find((tr) => tr.textContent.includes('Operating Income'));
    assert.ok(revLine, 'Operating Income row rendered');
    await React.act(async () => props(revLine).onClick());

    const csvBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes('Download CSV'));
    const xlsxBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes('Export XLSX'));
    assert.ok(csvBtn && xlsxBtn);

    await React.act(async () => props(csvBtn).onClick());
    const csvDl = await spy.takeLast();
    const csvRows = fromCsv(await csvDl.text());
    const opIncCsv = csvRows.find((r) => r[0].trim() === 'Operating Income');
    assert.ok(opIncCsv, 'Operating Income exported to CSV');
    assert.equal(opIncCsv[0], '  Operating Income', 'Depth 1 line preserves two-space indent');
    assert.equal(opIncCsv[1], '1234.5', 'CSV numeric value is unformatted number, not currency string');

    const accCsv = csvRows.find((r) => r[0].includes(`${revAcc.code} ${revAcc.name}`));
    assert.ok(accCsv && accCsv[0].startsWith('    '), 'Unfolded account row is indented to depth + 1');

    await React.act(async () => props(xlsxBtn).onClick());
    const xlsxDl = await spy.takeLast();
    const parsedXlsx = readXlsx(xlsxDl.bytes);
    const opIncXlsx = parsedXlsx.rows.find((r) => r[0].trim() === 'Operating Income');
    assert.equal(opIncXlsx[0], '  Operating Income');
    assert.equal(typeof opIncXlsx[1], 'number');
    assert.equal(opIncXlsx[1], 1234.5);
  } finally {
    await React.act(async () => root.unmount());
    spy.restore();
  }
});
