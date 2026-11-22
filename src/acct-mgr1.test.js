import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { create, read, search, updateSettings } from './orm.js';
import { seed } from './seed.js';
import { createCompanyWithDefaultInvoiceJournals } from './test-support/accounting-company.js';
import { postMove } from './models/accounting.js';
import { foreignBalanceReport } from './models/closing.js';
import { cashflowAnalysis } from './models/reports.js';
import { confirmLoan, postDueLines } from './models/loans.js';
import { accountId } from './models/ledger.js';
import { diffDb, applyDiff } from './sync.js';
import { tableToRows } from './csv.js';
import { readXlsx } from './xlsx.js';
import { t } from './i18n.js';
import { setupDom, find } from './test-support/dom.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const props = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];

test('MGR-1: Unrealized Currencies CSV/XLSX export and company selector with foreignBalanceReport company parameter', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();

  const baseSeed = seed();
  const currency = create(baseSeed, 'res.currency', {
    name: 'EURX',
    rate_ids: [{ date: '2026-01-01', rate: 2 }, { date: '2026-02-01', rate: 1 }],
  });

  // Company 1 invoice
  const inv1 = create(currency.db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: 1,
    currency_id: currency.id,
    invoice_date: '2026-01-01',
    invoice_line_ids: [{ name: 'Service C1', qty: 1, price_unit: 100, tax: 0 }],
  });
  let db = postMove(inv1.db, inv1.id);

  // Company 2 setup
  const second = createCompanyWithDefaultInvoiceJournals(db, {
    name: 'Second Company',
    currency_id: db.settings.base_currency_id,
  });
  db = second.db;
  for (const [code, type] of [['400000', 'income'], ['650100', 'expense_other']]) {
    db = create(db, 'account.account', { code, name: code, account_type: type, company_id: second.id }).db;
  }
  db = create(db, 'account.journal', { code: 'MISC2', name: 'Other journal', type: 'general', company_id: second.id }).db;

  const inv2 = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    company_id: second.id,
    currency_id: currency.id,
    invoice_date: '2026-01-01',
    invoice_line_ids: [{ name: 'Service C2', qty: 1, price_unit: 200, tax: 0 }],
  });
  db = updateSettings(postMove(inv2.db, inv2.id), {
    current_company_id: 1,
    allowed_company_ids: [1, second.id],
  });

  // Test guard diff-verifiability via diffDb + applyDiff
  const diff = diffDb(inv2.db, db);
  const syncedDb = applyDiff(inv2.db, diff);
  assert.ok(read(syncedDb, 'account.move', inv2.id));

  // The options signature scopes each company, while the default includes allowed companies.
  const rowsC1 = foreignBalanceReport(db, '2026-02-28', { companyId: 1 });
  assert.equal(rowsC1.length, 1);
  assert.equal(rowsC1[0].invoice_id, inv1.id);
  assert.equal(rowsC1[0].difference, 50);
  const rowsC2 = foreignBalanceReport(db, '2026-02-28', { companyId: second.id });
  assert.equal(rowsC2.length, 1);
  assert.equal(rowsC2[0].invoice_id, inv2.id);
  assert.equal(rowsC2[0].difference, 100);
  assert.equal(foreignBalanceReport(db, '2026-02-28').length, 2);

  // 2. Test UnrealizedCurrencies React view with company selector, print, CSV and XLSX export
  await commit(db);
  const { UnrealizedCurrencies } = await import('./views/UnrealizedCurrencies.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    await React.act(async () => root.render(React.createElement(UnrealizedCurrencies)));

    const findAll = (pred) => {
      const results = [];
      const walk = (n) => {
        if (!n) return;
        if (pred(n)) results.push(n);
        for (const c of n.childNodes ?? []) walk(c);
      };
      walk(host);
      return results;
    };

    // Verify company selector is rendered when available companies > 1
    const companySelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === 'Company');
    assert.ok(companySelect, 'Company selector is present in UnrealizedCurrencies');

    // Verify buttons exist: Print, Download CSV, Export XLSX, Revalue Foreign Currency
    const buttons = findAll((n) => n.tagName === 'BUTTON').map((b) => b.textContent?.trim());
    assert.ok(buttons.includes(t('Print')), 'Print button is present');
    assert.ok(buttons.includes(t('Download CSV')), 'Download CSV button is present');
    assert.ok(buttons.includes(t('Export XLSX')), 'Export XLSX button is present');
    assert.ok(buttons.includes(t('Revalue Foreign Currency')), 'Revalue button is present');

    // Verify table has both company rows when "all" is selected
    const table = find(host, (n) => n.tagName === 'TABLE');
    assert.ok(table, 'Table is rendered');
    const allRowsCsv = tableToRows(table);
    assert.ok(allRowsCsv.length >= 3, 'Table contains header + 2 invoice rows');
    assert.ok(allRowsCsv.some((r) => r.includes('Service C1') || r.includes(read(db, 'account.move', inv1.id)?.name)));
    assert.ok(allRowsCsv.some((r) => r.includes('Service C2') || r.includes(read(db, 'account.move', inv2.id)?.name)));

    // Switch company selector to Company 2
    await React.act(async () => props(companySelect).onChange({ target: { value: String(second.id) } }));

    // Now table should only contain Company 2 rows
    const scopedRowsCsv = tableToRows(table);
    assert.ok(!scopedRowsCsv.some((r) => r.includes(read(db, 'account.move', inv1.id)?.name)));
    assert.ok(scopedRowsCsv.some((r) => r.includes(read(db, 'account.move', inv2.id)?.name)));
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('MGR-2: Loans Analysis Print/CSV/XLSX, company selector, totals row, and and unavailable historical rows', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();

  let db = seed();
  const second = createCompanyWithDefaultInvoiceJournals(db, {
    name: 'Second Co Loans',
    currency_id: db.settings.base_currency_id,
  });
  db = updateSettings(second.db, {
    current_company_id: 1,
    allowed_company_ids: [1, second.id],
  });

  const bnk1 = search(db, 'account.journal').find((j) => j.code === 'BNK1' && (j.company_id ?? 1) === 1);
  const accBank = accountId(db, '101401');
  const accPrincipal = accountId(db, '260000');
  const accInterest = accountId(db, '690400');

  // Loan 1 (Company 1): Normal confirmed and partially paid loan
  const l1 = create(db, 'account.loan', {
    name: 'LOAN-001',
    company_id: 1,
    journal_id: bnk1.id,
    bank_account_id: accBank,
    principal_account_id: accPrincipal,
    interest_account_id: accInterest,
    lender_id: 2,
    amount: 1200,
    start_date: '2026-01-10',
    duration: 6,
    interest_rate: 6,
    method: 'linear',
  });
  db = confirmLoan(l1.db, read(l1.db, 'account.loan', l1.id));
  db = postDueLines(db, read(db, 'account.loan', l1.id), '2026-02-28');

  // Loan 2 (Company 1): Historical loan created with NO receipt_move_id on the record,
  // BUT the posted entry data exists in account.move (posted on start date with ref "Loan received LOAN-HIST")
  const histMove = create(db, 'account.move', {
    name: 'MISC/2026/01/099',
    company_id: 1,
    state: 'posted',
    move_type: 'entry',
    journal_id: bnk1.id,
    date: '2026-01-05',
    ref: 'Loan received LOAN-HIST',
    line_ids: [
      { account_id: accBank, debit: 2000, credit: 0, partner_id: 2 },
      { account_id: accPrincipal, debit: 0, credit: 2000, partner_id: 2 },
    ],
  });
  const l2 = create(histMove.db, 'account.loan', {
    name: 'LOAN-HIST',
    company_id: 1,
    state: 'running',
    receipt_move_id: null, // Link missing on the loan record!
    bank_account_id: accBank,
    principal_account_id: accPrincipal,
    interest_account_id: accInterest,
    lender_id: 2,
    amount: 2000,
    start_date: '2026-01-05',
    duration: 10,
    interest_rate: 0,
    method: 'linear',
    line_ids: [],
  });
  db = l2.db;

  // Loan 3 (Company 1): Truly missing loan where no move exists in account.move
  const l3 = create(db, 'account.loan', {
    name: 'LOAN-ORPHAN',
    company_id: 1,
    state: 'running',
    receipt_move_id: null,
    bank_account_id: accBank,
    principal_account_id: accPrincipal,
    interest_account_id: accInterest,
    lender_id: 2,
    amount: 500,
    start_date: '2026-01-01',
  });
  db = l3.db;

  // Loan 4 (Company 2): Belongs to second company
  const accBank2 = create(db, 'account.account', { code: '101402', name: 'Bank 2', account_type: 'asset_cash', company_id: second.id });
  const accPrin2 = create(accBank2.db, 'account.account', { code: '260002', name: 'Loan Prin 2', account_type: 'liability_current', company_id: second.id });
  const accInt2 = create(accPrin2.db, 'account.account', { code: '690402', name: 'Loan Int 2', account_type: 'expense_other', company_id: second.id });
  const bnk2 = create(accInt2.db, 'account.journal', { code: 'BNK2', name: 'Bank 2', type: 'bank', company_id: second.id, suspense_account_id: accBank2.id });
  const l4 = create(bnk2.db, 'account.loan', {
    name: 'LOAN-C2',
    company_id: second.id,
    journal_id: bnk2.id,
    bank_account_id: accBank2.id,
    principal_account_id: accPrin2.id,
    interest_account_id: accInt2.id,
    lender_id: 2,
    amount: 3000,
    start_date: '2026-01-15',
    duration: 12,
    interest_rate: 4,
    method: 'linear',
  });
  db = confirmLoan(l4.db, read(l4.db, 'account.loan', l4.id));

  // Verify guard diff-verifiability via diffDb + applyDiff
  const syncDiff = diffDb(l4.db, db);
  const syncedDb = applyDiff(l4.db, syncDiff);
  assert.ok(read(syncedDb, 'account.loan', l4.id));

  await commit(db);

  const { LoansAnalysis } = await import('./views/LoansAnalysis.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    await React.act(async () => root.render(React.createElement(LoansAnalysis)));

    const findAll = (pred) => {
      const results = [];
      const walk = (n) => {
        if (!n) return;
        if (pred(n)) results.push(n);
        for (const c of n.childNodes ?? []) walk(c);
      };
      walk(host);
      return results;
    };

    // 1. Verify Company selector and export/print buttons
    const companySelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === 'Company');
    assert.ok(companySelect, 'Company selector is present in LoansAnalysis');

    const buttons = findAll((n) => n.tagName === 'BUTTON').map((b) => b.textContent?.trim());
    assert.ok(buttons.includes(t('Print')), 'Print button is present');
    assert.ok(buttons.includes(t('Download CSV')), 'Download CSV button is present');
    assert.ok(buttons.includes(t('Download XLSX')), 'Download XLSX button is present');

    const table = find(host, (n) => n.tagName === 'TABLE');
    assert.ok(table, 'Table is present');
    let rows = tableToRows(table);

    // 2. A loan without its receipt link is never matched to entries by reference text
    const histRow = rows.find((r) => r.includes('LOAN-HIST'));
    assert.ok(histRow, 'LOAN-HIST is rendered');
    assert.ok(histRow.includes(t('Historical entry links unavailable')), 'LOAN-HIST without receipt_move_id stays unavailable');

    // 3. Verify LOAN-ORPHAN uses fallback because no move exists
    const orphanRow = rows.find((r) => r.includes('LOAN-ORPHAN'));
    assert.ok(orphanRow, 'LOAN-ORPHAN is rendered');
    assert.ok(orphanRow.includes(t('Historical entry links unavailable')), 'LOAN-ORPHAN uses fallback');

    // 4. Verify Totals row exists at the end of the table
    const totalRow = rows.find((r) => r[0] === t('Total'));
    assert.ok(totalRow, 'Totals row is rendered in LoansAnalysis');
    // Sum of available borrowed loans: LOAN-001 (1,200) + LOAN-C2 (3,000) = 4,200
    assert.ok(totalRow.some((cell) => cell.includes('4,200.00')), 'Total amount borrowed sums available loans (4,200.00)');

    // 5. Test company filtering: filter to Company 1
    await React.act(async () => props(companySelect).onChange({ target: { value: '1' } }));

    rows = tableToRows(table);
    assert.ok(!rows.some((r) => r.includes('LOAN-C2')), 'Company 2 loan is excluded when company 1 is selected');
    assert.ok(rows.some((r) => r.includes('LOAN-001')), 'Company 1 loan is included');
    const c1TotalRow = rows.find((r) => r[0] === t('Total'));
    // In Company 1: LOAN-001 (1,200)
    assert.ok(c1TotalRow.some((cell) => cell.includes('1,200.00')), 'Company 1 total amount borrowed is 1,200.00');
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('MGR-3: Cashflow Analysis Print/CSV/XLSX of the current pivot', async () => {
  const { makeEl } = setupDom();
  const origCreateElement = globalThis.document.createElement;
  globalThis.document.createElement = (tag) => {
    const el = origCreateElement(tag);
    el.colSpan = 1;
    el.rowSpan = 1;
    const attrs = {};
    const origSet = el.setAttribute;
    el.setAttribute = (name, val) => {
      origSet?.(name, val);
      const k = String(name).toLowerCase();
      attrs[k] = String(val);
      if (k === 'colspan') el.colSpan = Number(val);
      if (k === 'rowspan') el.rowSpan = Number(val);
    };
    el.getAttribute = (name) => {
      const k = String(name).toLowerCase();
      if (k === 'colspan') return String(el.colSpan);
      if (k === 'rowspan') return String(el.rowSpan);
      return attrs[k] ?? null;
    };
    return el;
  };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();

  let db = seed();
  const bnk1 = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  const cshAccount = accountId(db, '101501');
  const bnk2 = create(db, 'account.journal', { code: 'CSH1', name: 'Cash Register', type: 'cash', company_id: 1, suspense_account_id: cshAccount });
  db = bnk2.db;

  // Create bank statement lines across journals and months
  const st1 = create(db, 'account.bank.statement.line', {
    payment_ref: 'Statement line 1',
    journal_id: bnk1.id,
    date: '2026-05-10',
    amount: 1500,
    company_id: 1,
  });
  const st2 = create(st1.db, 'account.bank.statement.line', {
    payment_ref: 'Statement line 2',
    journal_id: bnk1.id,
    date: '2026-05-20',
    amount: -500,
    company_id: 1,
  });
  const st3 = create(st2.db, 'account.bank.statement.line', {
    payment_ref: 'Statement line 3',
    journal_id: bnk2.id,
    date: '2026-05-15',
    amount: 800,
    company_id: 1,
  });
  db = st3.db;

  // Test cashflowAnalysis with the company_id option
  const cfById = cashflowAnalysis(db, { from: '2026-05-01', to: '2026-05-31', company_id: 1 });
  assert.equal(cfById.rows.length, 1);
  assert.equal(cfById.rows[0].inflow, 2300);
  assert.equal(cfById.rows[0].outflow, 500);
  assert.equal(cfById.rows[0].net, 1800);

  await commit(db);

  const { CashflowAnalysis } = await import('./views/CashflowAnalysis.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    await React.act(async () => root.render(React.createElement(CashflowAnalysis)));

    const findAll = (pred) => {
      const results = [];
      const walk = (n) => {
        if (!n) return;
        if (pred(n)) results.push(n);
        for (const c of n.childNodes ?? []) walk(c);
      };
      walk(host);
      return results;
    };

    // 1. Verify controls: Print, Download CSV, Download XLSX, Pivot toggle
    const buttons = findAll((n) => n.tagName === 'BUTTON');
    const buttonLabels = buttons.map((b) => b.textContent?.trim());
    assert.ok(buttonLabels.includes(t('Print')), 'Print button is present');
    assert.ok(buttonLabels.includes(t('Download CSV')), 'Download CSV button is present');
    assert.ok(buttonLabels.includes(t('Download XLSX')), 'Download XLSX button is present');
    assert.ok(buttonLabels.includes(t('Pivot by Journal')), 'Pivot toggle button is present');

    const table = find(host, (n) => n.tagName === 'TABLE');
    assert.ok(table, 'Table is rendered');

    // 2. In default monthly summary mode, check headers and exported rows
    let rows = tableToRows(table);
    assert.deepEqual(rows[0], [t('Month'), t('Inflow'), t('Outflow'), t('Net')]);
    const summaryRow = rows.find((r) => r[0] === '2026-05');
    assert.ok(summaryRow, 'Summary row for 2026-05 is present');
    assert.ok(summaryRow[1].includes('2,300.00'), 'Inflow 2,300.00');
    assert.ok(summaryRow[2].includes('500.00'), 'Outflow 500.00');
    assert.ok(summaryRow[3].includes('1,800.00'), 'Net 1,800.00');

    // 3. Toggle pivot mode
    const pivotBtn = buttons.find((b) => b.textContent?.trim() === t('Pivot by Journal'));
    await React.act(async () => props(pivotBtn).onClick());

    // 4. In Pivot mode, verify table rows and columns contain journal breakdown
    rows = tableToRows(table);
    assert.ok(rows.length >= 3, 'Pivot table contains multi-level headers and data');
    const headRow0 = rows[0];
    assert.equal(headRow0[0], t('Month'));
    assert.ok(headRow0.some((h) => h.includes('Bank') || h.includes(bnk1.name)), 'First journal in pivot header');
    assert.ok(headRow0.some((h) => h.includes('Cash Register') || h.includes(bnk2.name)), 'Second journal in pivot header');

    const pivotDataRow = rows.find((r) => r[0] === '2026-05');
    assert.ok(pivotDataRow, 'Pivot data row for 2026-05 exists');
    assert.ok(pivotDataRow.some((c) => c.includes('1,500.00')), 'Bank inflow 1,500.00');
    assert.ok(pivotDataRow.some((c) => c.includes('800.00')), 'Cash inflow 800.00');

    // 5. Verify XLSX generation from the current pivot table
    const { buildXlsx } = await import('./xlsx.js');
    const xlsxBytes = buildXlsx(table, { sheetName: t('Cashflow Analysis') });
    const parsedXlsx = readXlsx(xlsxBytes);
    assert.ok(parsedXlsx.merges.length > 0, 'Pivot XLSX contains merged journal header cells');
    assert.ok(parsedXlsx.rows.length >= 3, 'Pivot XLSX contains all rows');
    assert.equal(parsedXlsx.sheetName, t('Cashflow Analysis'));
  } finally {
    await React.act(async () => root.unmount());
  }
});
