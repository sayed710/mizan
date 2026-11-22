import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { create, search, write } from './orm.js';
import { seed } from './seed.js';
import { fromCsv, tableToRows } from './csv.js';
import { parseCellNumber, readXlsx } from './xlsx.js';
import { today } from './models/common.js';
import { postMove } from './models/accounting.js';
import { accountId, postEntry } from './models/ledger.js';
import { confirmLoan } from './models/loans.js';

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

function normCell(v) {
  if (v == null) return '';
  if (typeof v === 'number') return v;
  const s = String(v).replace(/[\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069]/g, '').trim();
  const stripped = s.replace(/[$€£¥\s]/g, '').replace(/,/g, '');
  const paren = stripped.match(/^\((.*)\)$/);
  if (paren && /^[-+]?\d+(?:\.\d+)?$/.test(paren[1])) return -Number(paren[1]);
  if (/^[-+]?\d+(?:\.\d+)?$/.test(stripped)) return Number(stripped);
  return s;
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

test('EXP-1: ActionView list exports XLSX next to CSV with identical rows/columns and respects selection', async () => {
  const { makeEl } = setupDom();
  const spy = setupDownloadSpy(makeEl);
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const store = await import('./store.js');
  await store.initStore();

  let db = seed();
  const invA = create(db, 'account.move', {
    name: 'INV-EXP1-A',
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: 1,
    invoice_date: '2026-03-01',
    invoice_line_ids: [{ name: 'Item A', qty: 2, price_unit: 125, tax: 0 }],
  });
  const invB = create(invA.db, 'account.move', {
    name: 'INV-EXP1-B',
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: 1,
    invoice_date: '2026-03-02',
    invoice_line_ids: [{ name: 'Item B', qty: 1, price_unit: 300, tax: 0 }],
  });
  db = invB.db;
  await React.act(async () => store.commit(db));

  const { ActionView } = await import('./views/ActionView.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => {
      root.render(React.createElement(ActionView, {
        leaf: { model: 'account.move', view: 'list', label: 'Journal Entries' },
        base: '#/accounting/entries',
        params: new URLSearchParams(),
      }));
    });

    const csvBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes('Export') && !n.textContent.includes('XLSX'));
    const xlsxBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes('Export XLSX'));
    assert.ok(csvBtn, 'CSV Export button exists');
    assert.ok(xlsxBtn, 'Export XLSX button exists next to CSV export');

    await React.act(async () => props(csvBtn).onClick());
    const csvDl = await spy.takeLast();
    const csvRows = fromCsv(await csvDl.text());

    await React.act(async () => props(xlsxBtn).onClick());
    const xlsxDl = await spy.takeLast();
    assert.equal(xlsxDl.type, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const parsedAll = readXlsx(xlsxDl.bytes);
    assert.equal(parsedAll.rows.length, csvRows.length);
    for (let i = 0; i < csvRows.length; i += 1) {
      assert.deepEqual(parsedAll.rows[i].map(normCell), csvRows[i].map(normCell));
    }

    const cbA = find(host, (n) => n.tagName === 'INPUT' && props(n)?.type === 'checkbox' && props(n)?.['aria-label'] === 'INV-EXP1-A');
    assert.ok(cbA, 'Checkbox for INV-EXP1-A exists');
    await React.act(async () => props(cbA).onChange({ target: { checked: true } }));

    await React.act(async () => props(csvBtn).onClick());
    const csvSelDl = await spy.takeLast();
    const csvSelRows = fromCsv(await csvSelDl.text());

    await React.act(async () => props(xlsxBtn).onClick());
    const xlsxSelDl = await spy.takeLast();
    const parsedSel = readXlsx(xlsxSelDl.bytes);
    assert.equal(parsedSel.rows.length, 2, 'Selected export contains header + 1 selected row');
    assert.equal(parsedSel.rows.length, csvSelRows.length);
    assert.deepEqual(parsedSel.rows[1].map(normCell), csvSelRows[1].map(normCell));
    assert.ok(parsedSel.rows[1].includes('INV-EXP1-A'));
  } finally {
    await React.act(async () => root.unmount());
    spy.restore();
  }
});

test('EXP-2: UnrealizedCurrencies exports displayed table to XLSX next to Print', async () => {
  const { makeEl } = setupDom();
  const spy = setupDownloadSpy(makeEl);
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const store = await import('./store.js');
  await store.initStore();

  let db = seed();
  const currency = create(db, 'res.currency', {
    name: 'EURX',
    rate_ids: [{ date: '2026-01-01', rate: 2 }, { date: '2026-02-01', rate: 1 }],
  });
  const inv = create(currency.db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    company_id: 1,
    currency_id: currency.id,
    invoice_date: '2026-01-01',
    invoice_line_ids: [{ name: 'FX Service', qty: 1, price_unit: 200, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);
  await React.act(async () => store.commit(db));

  const { UnrealizedCurrencies } = await import('./views/UnrealizedCurrencies.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => {
      root.render(React.createElement(UnrealizedCurrencies));
    });

    const buttons = findAll(host, (n) => n.tagName === 'BUTTON');
    const printIdx = buttons.findIndex((b) => b.textContent === 'Print');
    const xlsxIdx = buttons.findIndex((b) => b.textContent.includes('Export XLSX'));
    assert.ok(printIdx >= 0, 'Print button exists');
    assert.ok(xlsxIdx >= 0, 'Export XLSX button exists');
    assert.ok(xlsxIdx > printIdx, 'Export XLSX button appears next to Print');

    const table = find(host, (n) => n.tagName === 'TABLE');
    const expected = tableToRows(table);
    assert.ok(expected.length >= 2, 'Unrealized Currencies table has data rows');

    await React.act(async () => props(buttons[xlsxIdx]).onClick());
    const dl = await spy.takeLast();
    assert.ok(dl, 'XLSX download triggered');
    const parsed = readXlsx(dl.bytes);
    assert.equal(parsed.rows.length, expected.length);
    for (let i = 0; i < expected.length; i += 1) {
      assert.deepEqual(parsed.rows[i].map(normCell), expected[i].map(normCell));
    }
  } finally {
    await React.act(async () => root.unmount());
    spy.restore();
  }
});

test('EXP-3: LoansAnalysis and CashflowAnalysis provide Download XLSX matching displayed tables', async () => {
  const { makeEl } = setupDom();
  const spy = setupDownloadSpy(makeEl);
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const store = await import('./store.js');
  await store.initStore();

  let db = seed();
  const bankJournal = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  const cashAcc = accountId(db, '101401');
  const loan = create(db, 'account.loan', {
    name: 'EXP3 Term Loan',
    amount: 10000,
    duration: 12,
    interest_rate: 6,
    method: 'annuity',
    start_date: today(),
    journal_id: bankJournal.id,
    bank_account_id: cashAcc,
    principal_account_id: accountId(db, '260000'),
    interest_account_id: accountId(db, '690400'),
    company_id: 1,
    state: 'draft',
  });
  db = confirmLoan(loan.db, search(loan.db, 'account.loan').find((l) => l.id === loan.id));
  db = postEntry(db, {
    journal: 'BNK1',
    company: 1,
    date: today(),
    lines: [
      { account_id: cashAcc, debit: 500 },
      { account_id: accountId(db, '400000'), credit: 500 },
    ],
  }).db;
  await React.act(async () => store.commit(db));

  const { LoansAnalysis } = await import('./views/LoansAnalysis.jsx');
  const { CashflowAnalysis } = await import('./views/CashflowAnalysis.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(LoansAnalysis)));
    const loanXlsxBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes('Download XLSX'));
    assert.ok(loanXlsxBtn, 'LoansAnalysis has Download XLSX button');
    const loanTable = find(host, (n) => n.tagName === 'TABLE');
    const loanExpected = tableToRows(loanTable);
    assert.ok(loanExpected.some((r) => r.includes('EXP3 Term Loan')));

    await React.act(async () => props(loanXlsxBtn).onClick());
    const loanDl = await spy.takeLast();
    assert.ok(loanDl, 'LoansAnalysis triggered XLSX download');
    const loanParsed = readXlsx(loanDl.bytes);
    assert.equal(loanParsed.rows.length, loanExpected.length);
    for (let i = 0; i < loanExpected.length; i += 1) {
      assert.deepEqual(loanParsed.rows[i].map(normCell), loanExpected[i].map(normCell));
    }
    assert.equal(typeof loanParsed.rows[1][2], 'number', 'Loan amount borrowed exported as numeric cell');

    await React.act(async () => root.render(React.createElement(CashflowAnalysis)));
    const cfXlsxBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes('Download XLSX'));
    assert.ok(cfXlsxBtn, 'CashflowAnalysis has Download XLSX button');
    const cfSummaryExpected = tableToRows(find(host, (n) => n.tagName === 'TABLE'));
    assert.ok(cfSummaryExpected.length >= 2);

    await React.act(async () => props(cfXlsxBtn).onClick());
    const cfDl = await spy.takeLast();
    const cfParsed = readXlsx(cfDl.bytes);
    assert.equal(cfParsed.rows.length, cfSummaryExpected.length);
    for (let i = 0; i < cfSummaryExpected.length; i += 1) {
      assert.deepEqual(cfParsed.rows[i].map(normCell), cfSummaryExpected[i].map(normCell));
    }

    const pivotBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes('Pivot by Journal'));
    assert.ok(pivotBtn, 'Pivot by Journal button exists');
    await React.act(async () => props(pivotBtn).onClick());

    await React.act(async () => props(find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes('Download XLSX'))).onClick());
    const cfPivotDl = await spy.takeLast();
    const cfPivotParsed = readXlsx(cfPivotDl.bytes);
    const cfPivotTableRows = tableToRows(find(host, (n) => n.tagName === 'TABLE'));
    assert.equal(cfPivotParsed.rows.length, cfPivotTableRows.length, 'Pivot XLSX includes both header rows and data rows');
    assert.ok(cfPivotParsed.merges.length > 0, 'Pivot XLSX preserves merged journal group headers');
  } finally {
    await React.act(async () => root.unmount());
    spy.restore();
  }
});

test('EXP-4: JournalItems and SalesReview export displayed rows to XLSX', async () => {
  const { makeEl } = setupDom();
  const spy = setupDownloadSpy(makeEl);
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const store = await import('./store.js');
  await store.initStore();

  let db = seed();
  db = postEntry(db, {
    journal: 'MISC',
    company: 1,
    date: '2026-04-10',
    ref: 'EXP4-REF-1',
    lines: [
      { account_id: accountId(db, '101401'), name: 'EXP4 Visible Debit', debit: 420 },
      { account_id: accountId(db, '400000'), name: 'EXP4 Visible Credit', credit: 420 },
    ],
  }).db;
  db = postEntry(db, {
    journal: 'MISC',
    company: 1,
    date: '2026-04-11',
    ref: 'EXP4-OTHER',
    lines: [
      { account_id: accountId(db, '101401'), name: 'EXP4 Filtered Out', debit: 99 },
      { account_id: accountId(db, '400000'), name: 'EXP4 Filtered Out Credit', credit: 99 },
    ],
  }).db;

  const prod = create(db, 'product', { name: 'EXP4 Desk', list_price: 100, type: 'goods' });
  const o1 = create(prod.db, 'sale.order', {
    name: 'SO-EXP4-TO-ISSUE',
    partner_id: 1,
    state: 'sale',
    order_line: [{ product_id: prod.id, name: 'EXP4 Desk', qty: 5, qty_delivered: 4, qty_invoiced: 1, price_unit: 100, tax: 0 }],
  });
  const o2 = create(o1.db, 'sale.order', {
    name: 'SO-EXP4-NOT-DELIV',
    partner_id: 1,
    state: 'sale',
    order_line: [{ product_id: prod.id, name: 'EXP4 Desk', qty: 6, qty_delivered: 2, qty_invoiced: 5, price_unit: 80, tax: 0 }],
  });
  db = o2.db;
  await React.act(async () => store.commit(db));

  const { JournalItems } = await import('./views/JournalItems.jsx');
  const { SalesReview } = await import('./views/SalesReview.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(JournalItems, { leaf: { label: 'Journal Items', report: 'journalItems' } })));
    const searchInput = find(host, (n) => n.tagName === 'INPUT' && props(n)?.['aria-label'] === 'Search');
    assert.ok(searchInput, 'JournalItems Search input exists');
    await React.act(async () => props(searchInput).onChange({ target: { value: 'EXP4-REF-1' } }));

    const jiXlsxBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes('Export XLSX'));
    assert.ok(jiXlsxBtn, 'JournalItems has Export XLSX button');
    await React.act(async () => props(jiXlsxBtn).onClick());
    const jiDl = await spy.takeLast();
    const jiParsed = readXlsx(jiDl.bytes);
    assert.equal(jiParsed.rows.length, 4, 'Header + 2 matching journal items + totals row exported');
    assert.ok(!jiParsed.rows[0].includes('Select'), 'Select checkbox column is excluded from XLSX');
    assert.ok(!jiParsed.rows[0].includes('⋯'), 'Optional columns toggle is excluded from XLSX');
    assert.ok(jiParsed.rows.some((r) => r.includes('EXP4 Visible Debit') && r.includes(420)));
    assert.ok(!jiParsed.rows.some((r) => r.includes('EXP4 Filtered Out')));
    const debitIdx = jiParsed.rows[0].indexOf('Debit');
    const creditIdx = jiParsed.rows[0].indexOf('Credit');
    assert.equal(jiParsed.rows[3][debitIdx], 420);
    assert.equal(jiParsed.rows[3][creditIdx], 420);
    assert.ok(jiParsed.rows[3].includes('Total'));

    await React.act(async () => root.render(React.createElement(SalesReview, { leaf: { report: 'invoicesToBeIssued', label: 'Invoices To Be Issued' } })));
    const srBtn1 = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes('Export XLSX'));
    assert.ok(srBtn1, 'SalesReview Invoices To Be Issued has Export XLSX button');
    const srExpected1 = tableToRows(find(host, (n) => n.tagName === 'TABLE'));
    await React.act(async () => props(srBtn1).onClick());
    const srDl1 = await spy.takeLast();
    const srParsed1 = readXlsx(srDl1.bytes);
    assert.equal(srParsed1.rows.length, srExpected1.length);
    for (let i = 0; i < srExpected1.length; i += 1) {
      assert.deepEqual(srParsed1.rows[i].map(normCell), srExpected1[i].map(normCell));
    }
    assert.ok(srParsed1.rows.some((r) => r.includes('SO-EXP4-TO-ISSUE') && r.includes(3) && r.includes(300)));

    await React.act(async () => root.render(React.createElement(SalesReview, { leaf: { report: 'invoicedNotDelivered', label: 'Invoiced Not Delivered' } })));
    const srBtn2 = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes('Export XLSX'));
    assert.ok(srBtn2, 'SalesReview Invoiced Not Delivered has Export XLSX button');
    const srExpected2 = tableToRows(find(host, (n) => n.tagName === 'TABLE'));
    await React.act(async () => props(srBtn2).onClick());
    const srDl2 = await spy.takeLast();
    const srParsed2 = readXlsx(srDl2.bytes);
    assert.equal(srParsed2.rows.length, srExpected2.length);
    for (let i = 0; i < srExpected2.length; i += 1) {
      assert.deepEqual(srParsed2.rows[i].map(normCell), srExpected2[i].map(normCell));
    }
    assert.ok(srParsed2.rows.some((r) => r.includes('SO-EXP4-NOT-DELIV') && r.includes(3) && r.includes(240)));
  } finally {
    await React.act(async () => root.unmount());
    spy.restore();
  }
});

test('EXP-5: Finding 1 & Finding 4: Multi-company Journal Items export includes Company Currency and reporting totals row matching visible footer', async () => {
  const { makeEl } = setupDom();
  const spy = setupDownloadSpy(makeEl);
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const store = await import('./store.js');
  await store.initStore();

  const { createCompanyWithDefaultInvoiceJournals, withDefaultBankJournal } = await import('./test-support/accounting-company.js');
  let db = seed();
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  // 1 USD = 0.5 EUR => 1 EUR = 2 USD
  db = write(db, 'res.currency', eur.id, {
    rate_ids: [{ date: '2026-01-01', rate: 0.5 }],
  });
  const co2 = createCompanyWithDefaultInvoiceJournals(db, { name: 'Branch EUR', currency_id: eur.id });
  db = withDefaultBankJournal(co2.db, co2.id);

  // Co1 item: debit 100 USD
  db = postEntry(db, {
    journal: 'MISC',
    company: 1,
    date: '2026-05-01',
    ref: 'MC-EXP1-CO1',
    lines: [
      { account_id: accountId(db, '101401'), name: 'Co1 Item', debit: 100 },
      { account_id: accountId(db, '400000'), credit: 100 },
    ],
  }).db;

  // Co2 item: debit 50 EUR (which is 100 USD reporting value)
  const co2Bnk = search(db, 'account.journal').find((j) => j.company_id === co2.id && j.type === 'bank');
  db = postEntry(db, {
    journal: co2Bnk.id,
    company: co2.id,
    date: '2026-05-02',
    ref: 'MC-EXP1-CO2',
    lines: [
      { account_id: co2Bnk.default_account_id, name: 'Co2 Item', debit: 50 },
      { account_id: accountId(db, '600000', co2.id), credit: 50 },
    ],
  }).db;

  // Co3 item: debit 77 in unrated currency (excluded from reporting totals)
  const unratedCurr = create(db, 'res.currency', { name: 'UNR', rate_ids: [] });
  const co3 = createCompanyWithDefaultInvoiceJournals(unratedCurr.db, { name: 'Branch UNR', currency_id: unratedCurr.id });
  db = withDefaultBankJournal(co3.db, co3.id);
  const co3Bnk = search(db, 'account.journal').find((j) => j.company_id === co3.id && j.type === 'bank');
  db = postEntry(db, {
    journal: co3Bnk.id,
    company: co3.id,
    date: '2026-05-03',
    ref: 'MC-EXP1-CO3',
    lines: [
      { account_id: co3Bnk.default_account_id, name: 'Co3 Item', debit: 77 },
      { account_id: accountId(db, '600000', co3.id), credit: 77 },
    ],
  }).db;

  db = { ...db, settings: { ...db.settings, current_company_id: 1, allowed_company_ids: [1, co2.id, co3.id] } };
  await React.act(async () => store.commit(db));

  const { JournalItems } = await import('./views/JournalItems.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(JournalItems, { leaf: { label: 'Journal Items', report: 'journalItems' } })));
    const searchInput = find(host, (n) => n.tagName === 'INPUT' && props(n)?.['aria-label'] === 'Search');
    await React.act(async () => props(searchInput).onChange({ target: { value: 'MC-EXP1' } }));

    const xlsxBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes('Export XLSX'));
    assert.ok(xlsxBtn, 'Export XLSX button exists');
    await React.act(async () => props(xlsxBtn).onClick());
    const dl = await spy.takeLast();
    assert.ok(dl, 'XLSX download triggered');
    const parsed = readXlsx(dl.bytes);

    // Finding 1: Company Currency column included in multi-company export
    const header = parsed.rows[0];
    const currColIdx = header.indexOf('Company Currency');
    assert.ok(currColIdx >= 0, 'Export has "Company Currency" column when multi-company');
    const debitColIdx = header.indexOf('Debit');
    const creditColIdx = header.indexOf('Credit');
    assert.ok(debitColIdx >= 0 && creditColIdx >= 0, 'Debit and Credit columns exist');

    // Detail rows
    const co1Row = parsed.rows.find((r) => r.includes('Co1 Item'));
    const co2Row = parsed.rows.find((r) => r.includes('Co2 Item'));
    const co3Row = parsed.rows.find((r) => r.includes('Co3 Item'));
    assert.ok(co1Row && co2Row && co3Row, 'All three company items exported');
    assert.equal(co1Row[currColIdx], 'USD');
    assert.equal(co2Row[currColIdx], 'EUR');
    assert.equal(co3Row[currColIdx], 'UNR');
    assert.equal(co1Row[debitColIdx], 100);
    assert.equal(co2Row[debitColIdx], 50);
    assert.equal(co3Row[debitColIdx], 77);

    // Finding 4: Labelled totals row appended at bottom
    // Total debit = 100 USD (Co1) + 50 EUR / 0.5 (Co2) = 200 USD (excluding unrated Co3)
    const totalsRow = parsed.rows.at(-1);
    assert.ok(totalsRow.includes('Total'), 'Totals row has Total label');
    assert.equal(totalsRow[debitColIdx], 200, 'Exported total debit matches reporting currency conversion in visible footer');
    assert.equal(totalsRow[creditColIdx], 200, 'Exported total credit matches reporting currency conversion');
    assert.ok(totalsRow.some((c) => String(c).includes('Excludes 2 documents in a currency with no exchange rate')), 'Exclusion note preserved for unrated line');
  } finally {
    await React.act(async () => root.unmount());
    spy.restore();
  }
});

test('EXP-6: Finding 2: Exchange rates use 6-decimal rate format and fractional quantities retain precision in Excel', async () => {
  const { makeEl } = setupDom();
  const spy = setupDownloadSpy(makeEl);
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const store = await import('./store.js');
  await store.initStore();

  let db = seed();
  const currency = create(db, 'res.currency', {
    name: 'PREC',
    rate_ids: [{ date: '2026-01-01', rate: 0.123456 }],
  });
  const inv = create(currency.db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    company_id: 1,
    currency_id: currency.id,
    invoice_date: '2026-01-01',
    invoice_line_ids: [{ name: 'Precise FX', qty: 1, price_unit: 200, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);
  await React.act(async () => store.commit(db));

  const { UnrealizedCurrencies } = await import('./views/UnrealizedCurrencies.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(UnrealizedCurrencies)));
    const xlsxBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes('Export XLSX'));
    await React.act(async () => props(xlsxBtn).onClick());
    const dl = await spy.takeLast();
    const parsed = readXlsx(dl.bytes);
    const header = parsed.rows[0];
    const rateColIdx = header.indexOf('Exchange Rate');
    assert.ok(rateColIdx >= 0, 'Exchange Rate column found');
    const dataRow = parsed.rows[1];
    assert.equal(dataRow[rateColIdx], 0.123456);

    // Verify cell style is rate format (6 decimals) and displayed value is 0.123456 not 0.12
    assert.ok(parsed.cellStyles, 'readXlsx provides cellStyles');
    const rateStyle = parsed.cellStyles[1][rateColIdx];
    assert.notEqual(rateStyle, 2, 'Rate column must not use the 2-decimal monetary style (s=2)');
    assert.ok(parsed.formattedRows, 'readXlsx provides formattedRows');
    assert.equal(parsed.formattedRows[1][rateColIdx], '0.123456', 'Workbook displays 6 decimals for exchange rate');
  } finally {
    await React.act(async () => root.unmount());
    spy.restore();
  }
});

test('EXP-7: Finding 3: Tiny sales quantities with exponent notation export as numeric cells', async () => {
  const { makeEl } = setupDom();
  const spy = setupDownloadSpy(makeEl);
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const store = await import('./store.js');
  await store.initStore();

  let db = seed();
  const prod = create(db, 'product', { name: 'EXP7 Precision Product', list_price: 100, type: 'goods' });
  const o = create(prod.db, 'sale.order', {
    name: 'SO-EXP7-TINY',
    partner_id: 1,
    state: 'sale',
    order_line: [{ product_id: prod.id, name: 'EXP7 Line', qty: 2, qty_delivered: 1.0000001, qty_invoiced: 1, price_unit: 100, tax: 0 }],
  });
  db = o.db;
  await React.act(async () => store.commit(db));

  const { SalesReview } = await import('./views/SalesReview.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(SalesReview, { leaf: { report: 'invoicesToBeIssued', label: 'Invoices To Be Issued' } })));
    const xlsxBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes('Export XLSX'));
    await React.act(async () => props(xlsxBtn).onClick());
    const dl = await spy.takeLast();
    const parsed = readXlsx(dl.bytes);
    const header = parsed.rows[0];
    const diffColIdx = header.indexOf('Difference');
    assert.ok(diffColIdx >= 0, 'Difference column exists');
    const dataRow = parsed.rows.find((r) => r.includes('SO-EXP7-TINY'));
    assert.ok(dataRow, 'Tiny difference row exported');
    assert.equal(typeof dataRow[diffColIdx], 'number', 'Tiny difference with exponent notation exported as number, not string');
    assert.ok(Math.abs(dataRow[diffColIdx] - 1e-7) < 1e-12);

    assert.equal(parseCellNumber('1e-7'), 1e-7);
    assert.equal(parseCellNumber('-2.5e-6'), -2.5e-6);
    assert.equal(parseCellNumber('١e-7'), 1e-7);
  } finally {
    await React.act(async () => root.unmount());
    spy.restore();
  }
});
