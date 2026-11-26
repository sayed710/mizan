import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { create, read, search, write } from './orm.js';
import { setActor } from './models/authority.js';
import { seed } from './seed.js';
import { fromCsv, tableToRows } from './csv.js';
import { parseCellNumber, readXlsx } from './xlsx.js';
import { today } from './models/common.js';
import { payMove, postMove } from './models/accounting.js';
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

    const openExport = async (format) => {
      const button = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes('Export'));
      await React.act(async () => props(button).onClick());
      const dialog = find(host, (n) => props(n)?.role === 'dialog');
      assert.ok(dialog, 'Export dialog opens');
      const formatSelect = find(dialog, (n) => props(n)?.['aria-label'] === 'Format');
      await React.act(async () => props(formatSelect).onChange({ target: { value: format } }));
      const exportButton = find(dialog, (n) => n.tagName === 'BUTTON' && n.textContent === 'Export');
      await React.act(async () => props(exportButton).onClick());
      return spy.takeLast();
    };
    const csvDl = await openExport('csv');
    const csvRows = fromCsv(await csvDl.text());
    const xlsxDl = await openExport('xlsx');
    assert.equal(xlsxDl.type, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const parsedAll = readXlsx(xlsxDl.bytes);
    assert.equal(parsedAll.rows.length, csvRows.length);
    for (let i = 0; i < csvRows.length; i += 1) {
      assert.deepEqual(parsedAll.rows[i].map(normCell), csvRows[i].map(normCell));
    }

    const cbA = find(host, (n) => n.tagName === 'INPUT' && props(n)?.type === 'checkbox' && props(n)?.['aria-label'] === 'INV-EXP1-A');
    assert.ok(cbA, 'Checkbox for INV-EXP1-A exists');
    await React.act(async () => props(cbA).onChange({ target: { checked: true } }));

    const csvSelDl = await openExport('csv');
    const csvSelRows = fromCsv(await csvSelDl.text());

    const xlsxSelDl = await openExport('xlsx');
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

  const prod = create(db, 'product', { name: 'EXP4 Desk', list_price: 100, type: 'goods', invoice_policy: 'delivery' });
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
  const prod = create(db, 'product', { name: 'EXP7 Precision Product', list_price: 100, type: 'goods', invoice_policy: 'delivery' });
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

test('EXP-8: Filtered JournalItems totals round with reporting company currency instead of filtered company currency', async () => {
  const { makeEl } = setupDom();
  const spy = setupDownloadSpy(makeEl);
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const store = await import('./store.js');
  await store.initStore();

  const { createCompanyWithDefaultInvoiceJournals, withDefaultBankJournal } = await import('./test-support/accounting-company.js');
  let db = seed();
  // Whole-unit currency (increment = 1) where 1 USD = 100 WHOLE => 149 WHOLE = 1.49 USD.
  const wholeCurr = create(db, 'res.currency', {
    name: 'WHOLE',
    symbol: 'W',
    rounding: 1,
    decimal_places: 0,
    rate_ids: [{ date: '2026-01-01', rate: 100 }],
  });
  const co2 = createCompanyWithDefaultInvoiceJournals(wholeCurr.db, { name: 'Whole Unit Branch', currency_id: wholeCurr.id });
  db = withDefaultBankJournal(co2.db, co2.id);

  const co2Bnk = search(db, 'account.journal').find((j) => j.company_id === co2.id && j.type === 'bank');
  db = postEntry(db, {
    journal: co2Bnk.id,
    company: co2.id,
    date: '2026-05-01',
    ref: 'EXP8-WHOLE',
    lines: [
      { account_id: co2Bnk.default_account_id, name: 'Whole Debit', debit: 149 },
      { account_id: accountId(db, '600000', co2.id), name: 'Whole Credit', credit: 149 },
    ],
  }).db;
  // Unrelated entry in reporting company (co1) to verify the company filter isolates co2.
  db = postEntry(db, {
    journal: 'MISC',
    company: 1,
    date: '2026-05-01',
    ref: 'EXP8-CO1',
    lines: [
      { account_id: accountId(db, '101401'), name: 'Co1 Excluded', debit: 500 },
      { account_id: accountId(db, '400000'), name: 'Co1 Excluded Credit', credit: 500 },
    ],
  }).db;

  db = { ...db, settings: { ...db.settings, current_company_id: 1, allowed_company_ids: [1, co2.id] } };
  await React.act(async () => store.commit(db));

  const prevLocation = globalThis.location;
  globalThis.location = { hash: `#/accounting/journal-items?company=${co2.id}` };
  const { JournalItems } = await import('./views/JournalItems.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(JournalItems, { leaf: { label: 'Journal Items', report: 'journalItems' } })));

    const tfoot = find(host, (n) => n.tagName === 'TFOOT');
    assert.ok(tfoot, 'Totals footer rendered');
    assert.ok(tfoot.textContent.includes('$1.49'), `Footer rounds using reporting currency USD ($1.49), got: ${tfoot.textContent}`);

    const xlsxBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes('Export XLSX'));
    assert.ok(xlsxBtn, 'Export XLSX button exists');
    await React.act(async () => props(xlsxBtn).onClick());
    const dl = await spy.takeLast();
    assert.ok(dl, 'XLSX download triggered');
    const parsed = readXlsx(dl.bytes);

    const header = parsed.rows[0];
    const debitColIdx = header.indexOf('Debit');
    const creditColIdx = header.indexOf('Credit');
    const currColIdx = header.indexOf('Company Currency');
    assert.ok(debitColIdx >= 0 && creditColIdx >= 0 && currColIdx >= 0);
    assert.ok(!parsed.rows.some((r) => r.includes('Co1 Excluded')), 'Filtered to co2 only');

    const detailRow = parsed.rows.find((r) => r.includes('Whole Debit'));
    assert.ok(detailRow, 'Filtered co2 line exported');
    assert.equal(detailRow[currColIdx], 'WHOLE');
    assert.equal(detailRow[debitColIdx], 149);

    const totalsRow = parsed.rows.at(-1);
    assert.ok(totalsRow.includes('Total'));
    assert.equal(totalsRow[debitColIdx], 1.49, 'Exported total debit retains reporting currency USD precision (1.49, not 1)');
    assert.equal(totalsRow[creditColIdx], 1.49, 'Exported total credit retains reporting currency USD precision (1.49, not 1)');
  } finally {
    globalThis.location = prevLocation;
    await React.act(async () => root.unmount());
    spy.restore();
  }
});

test('EXP dialog adds, removes, reorders and searches fields including related fields', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { ExportDialog } = await import('./views/ExportDialog.jsx');
  const host = makeEl('div'); host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(ExportDialog, { db: seed(), model: 'account.move', records: [], columns: ['name', 'partner_id'], title: 'Journal Entries', onClose: () => {} })));
    const search = find(host, (n) => props(n)?.['aria-label'] === 'Search fields');
    await React.act(async () => props(search).onChange({ target: { value: 'partner_id/name' } }));
    const add = find(host, (n) => n.tagName === 'BUTTON' && n.textContent === 'Partner/Name');
    assert.ok(add);
    await React.act(async () => props(add).onClick());
    let buttons = findAll(host, (n) => n.tagName === 'BUTTON');
    assert.ok(buttons.some((n) => props(n)?.['aria-label'] === 'Move up: Partner/Name'));
    await React.act(async () => props(buttons.find((n) => props(n)?.['aria-label'] === 'Move up: Partner/Name')).onClick());
    buttons = findAll(host, (n) => n.tagName === 'BUTTON');
    assert.ok(buttons.findIndex((n) => props(n)?.['aria-label'] === 'Remove field: Partner/Name') < buttons.findLastIndex((n) => String(props(n)?.['aria-label'] ?? '').startsWith('Remove field:')));
    await React.act(async () => props(buttons.find((n) => props(n)?.['aria-label'] === 'Remove field: Partner/Name')).onClick());
    assert.equal(find(host, (n) => props(n)?.['aria-label'] === 'Remove field: Partner/Name'), null);
  } finally { await React.act(async () => root.unmount()); }
});

test('EXP templates persist ordered fields through sync and reject cross-user and invalid writes', async () => {
  const { applyDiff, diffDb } = await import('./sync.js');
  const { unlink } = await import('./orm.js');
  const db = seed();
  const actor = { login: 'alice', companies: new Set([1]) };
  const created = create(db, 'ir.exports', { name: 'My export', resource: 'res.partner', owner_login: 'alice', company_id: 1, export_fields: [{ name: 'name', sequence: 10 }, { name: 'email', sequence: 20 }] });
  const saved = applyDiff(db, diffDb(db, created.db), actor);
  assert.deepEqual(search(saved, 'ir.exports')[0].export_fields.map((line) => line.name), ['name', 'email']);
  const changed = write(saved, 'ir.exports', created.id, { name: 'Changed' });
  assert.throws(() => applyDiff(saved, diffDb(saved, changed), { login: 'bob', companies: new Set([1]) }), /another user/);
  const deleted = unlink(saved, 'ir.exports', [created.id]);
  assert.throws(() => applyDiff(saved, diffDb(saved, deleted), { login: 'bob', companies: new Set([1]) }), /another user/);
  assert.equal(search(applyDiff(saved, diffDb(saved, deleted), actor), 'ir.exports').length, 0);
  const bad = { ...created.db, records: { ...created.db.records, 'ir.exports': [{ ...created.db.records['ir.exports'][0], export_fields: [{ name: 'not_a_field', sequence: 10 }] }] } };
  assert.throws(() => applyDiff(db, diffDb(db, bad), actor), /Invalid export fields/);
  const forged = { ...created.db, records: { ...created.db.records, 'ir.exports': [{ ...created.db.records['ir.exports'][0], owner_login: 'bob' }] } };
  assert.throws(() => applyDiff(db, diffDb(db, forged), actor), /another user/);
  const foreignCompany = { ...created.db, records: { ...created.db.records, 'ir.exports': [{ ...created.db.records['ir.exports'][0], company_id: 2 }] } };
  assert.throws(() => applyDiff(db, diffDb(db, foreignCompany), actor), /No access/);
});

test('EXP update-compatible rows contain database IDs and raw selection and numeric values', async () => {
  const { exportTable } = await import('./views/ExportDialog.jsx');
  const db = seed();
  assert.equal(exportTable(db, 'res.partner', [search(db, 'res.partner')[0]], ['name'], false, null).rows[0][0], 'Name');
  const record = { id: 42, partner_id: 1, state: 'draft', amount_total: 12.5 };
  const table = exportTable(db, 'account.move', [record], ['partner_id', 'state', 'amount_total'], true);
  assert.deepEqual(table.rows[0], ['.id', 'partner_id', 'state', 'amount_total']);
  assert.deepEqual(table.rows[1], [42, 1, 'draft', 12.5]);
});


test('EXP compatible export updates the existing record on import', async () => {
  const { exportTable } = await import('./views/ExportDialog.jsx');
  const { importCsvRows } = await import('./csv.js');
  const db = seed();
  const partner = search(db, 'res.partner')[0];
  const exported = exportTable(db, 'res.partner', [partner], ['name'], true).rows.map((row) => row.map(String));
  exported[1][1] = 'Updated through export';
  const result = importCsvRows(db, 'res.partner', {}, exported);
  assert.equal(search(result.db, 'res.partner').length, search(db, 'res.partner').length);
  assert.equal(search(result.db, 'res.partner').find((r) => r.id === partner.id).name, 'Updated through export');
});


test('EXP dialog saves, loads and deletes a template', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const store = await import('./store.js');
  await store.initStore();
  await React.act(async () => store.commit(seed()));
  const { ExportDialog } = await import('./views/ExportDialog.jsx');
  function Wrapper() { const db = store.useDb(); return React.createElement(ExportDialog, { db, model: 'res.partner', records: [], columns: ['name', 'email'], title: 'Contacts', onClose: () => {} }); }
  const host = makeEl('div'); host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(Wrapper)));
    const name = find(host, (n) => props(n)?.['aria-label'] === 'Export template name');
    await React.act(async () => props(name).onChange({ target: { value: 'Contact fields' } }));
    await React.act(async () => props(find(host, (n) => n.tagName === 'BUTTON' && n.textContent === 'Save template')).onClick());
    const template = search(store.getDb(), 'ir.exports')[0];
    assert.deepEqual(template.export_fields.map((line) => line.name), ['name', 'email']);
    const remove = find(host, (n) => props(n)?.['aria-label'] === 'Remove field: Email');
    await React.act(async () => props(remove).onClick());
    const selector = find(host, (n) => props(n)?.['aria-label'] === 'Saved exports');
    await React.act(async () => props(selector).onChange({ target: { value: String(template.id) } }));
    assert.ok(find(host, (n) => props(n)?.['aria-label'] === 'Remove field: Email'));
    await React.act(async () => props(find(host, (n) => n.tagName === 'BUTTON' && n.textContent === 'Delete template')).onClick());
    assert.equal(search(store.getDb(), 'ir.exports').length, 0);
  } finally { await React.act(async () => root.unmount()); }
});

test('EXP review F1 & F6: ExportDialog awaits server save/delete, surfaces refusal errors, and reconciles remapped template IDs', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const store = await import('./store.js');
  const { ExportDialog } = await import('./views/ExportDialog.jsx');

  const baseDb = seed();
  const origFetch = globalThis.fetch;
  const origSetInterval = globalThis.setInterval;
  const origAlert = globalThis.alert;
  const alerts = [];
  globalThis.alert = (msg) => alerts.push(msg);
  globalThis.setInterval = () => ({ unref() {} });
  const jsonResponse = (data, ok = true) => new Response(JSON.stringify(data), {
    status: ok ? 200 : 400,
    headers: { 'Content-Type': 'application/json' },
  });

  let mode = 'reject-save';
  let lastDeletedId = null;
  let serverDb = baseDb;
  globalThis.fetch = async (url, opts) => {
    if (url === '/api/session') return jsonResponse({ login: 'admin', name: 'Admin', isAdmin: true });
    if (url === '/api/db') return jsonResponse(serverDb);
    if (url === '/api/diff') {
      const diff = JSON.parse(opts?.body ?? '{}');
      if (mode === 'reject-save') return jsonResponse({ error: 'Template refused by server' }, false);
      if (mode === 'remap-save') {
        const created = diff.upserts?.['ir.exports']?.[0];
        const serverId = 42;
        const stored = { ...created, id: serverId };
        serverDb = {
          ...serverDb,
          records: { ...serverDb.records, 'ir.exports': [...(serverDb.records['ir.exports'] ?? []), stored] },
          seq: { ...serverDb.seq, 'ir.exports': serverId },
        };
        return jsonResponse({
          ok: true,
          remapped: { 'ir.exports': { [created.id]: serverId } },
          ...serverDb,
        });
      }
      if (mode === 'reject-delete') return jsonResponse({ error: 'Delete refused by server' }, false);
      if (mode === 'accept-delete') {
        lastDeletedId = diff.deletes?.['ir.exports']?.[0] ?? null;
        serverDb = {
          ...serverDb,
          records: {
            ...serverDb.records,
            'ir.exports': (serverDb.records['ir.exports'] ?? []).filter((r) => r.id !== lastDeletedId),
          },
        };
        return jsonResponse({ ok: true, ...serverDb });
      }
    }
    return jsonResponse({});
  };

  await store.initStore();
  function Wrapper() {
    const db = store.useDb();
    return React.createElement(ExportDialog, { db, model: 'res.partner', records: [], columns: ['name', 'email'], title: 'Contacts', onClose: () => {} });
  }
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    await React.act(async () => root.render(React.createElement(Wrapper)));
    const nameInput = find(host, (n) => props(n)?.['aria-label'] === 'Export template name');
    const saveBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent === 'Save template');
    const selector = () => find(host, (n) => props(n)?.['aria-label'] === 'Saved exports');
    const deleteBtn = () => find(host, (n) => n.tagName === 'BUTTON' && n.textContent === 'Delete template');

    // F1: rejected save keeps template unselected and shows dialog error instead of clearing it
    await React.act(async () => props(nameInput).onChange({ target: { value: 'Server Export' } }));
    await React.act(async () => props(saveBtn).onClick());
    assert.equal(props(selector()).value, '', 'Rejected save must not select the optimistic template');
    assert.equal(find(host, (n) => props(n)?.role === 'alert')?.textContent, 'Template refused by server');
    assert.equal(alerts.length, 0, 'Dialog owns commit error handling quietly');

    // F6: accepted save with server ID remap updates templateId to the remapped ID
    mode = 'remap-save';
    await React.act(async () => props(saveBtn).onClick());
    assert.equal(find(host, (n) => props(n)?.role === 'alert'), null, 'Error clears only after server acceptance');
    assert.equal(props(selector()).value, '42', 'Selected template uses the remapped server ID');
    const optionValues = findAll(selector(), (n) => n.tagName === 'OPTION').map((o) => String(props(o)?.value ?? ''));
    assert.ok(optionValues.includes('42'), 'Refreshed select options include the remapped server ID');

    // F1: rejected delete keeps template selected and surfaces server refusal
    mode = 'reject-delete';
    await React.act(async () => props(deleteBtn()).onClick());
    assert.equal(props(selector()).value, '42', 'Rejected delete must not clear selected template');
    assert.equal(find(host, (n) => props(n)?.role === 'alert')?.textContent, 'Delete refused by server');

    // F6: accepted delete targets the reconciled ID (42) and clears selection
    mode = 'accept-delete';
    await React.act(async () => props(deleteBtn()).onClick());
    assert.equal(lastDeletedId, 42, 'Delete targets the reconciled server ID');
    assert.equal(props(selector()).value, '', 'Selection clears after confirmed delete');
    assert.equal(find(host, (n) => props(n)?.role === 'alert'), null);
  } finally {
    await React.act(async () => root.unmount());
    globalThis.fetch = origFetch;
    globalThis.setInterval = origSetInterval;
    globalThis.alert = origAlert;
    setActor(null);
    await store.initStore();
  }
});

test('EXP review F2 & F9: CSV import validates one2many nested relations and reports translatable errors on bad JSON', async () => {
  const { importCsvRows } = await import('./csv.js');
  const { exportTable } = await import('./views/ExportDialog.jsx');
  const { translatePattern } = await import('./i18n-patterns.js');
  const { t } = await import('./i18n.js');

  let db = seed();
  const product = create(db, 'product', { name: 'Valid Product', list_price: 50, type: 'consu' });
  const inv = create(product.db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: 1,
    invoice_date: '2026-06-01',
    invoice_line_ids: [{ product_id: product.id, name: 'Valid Line', qty: 1, price_unit: 50, tax: 0 }],
  });
  db = inv.db;

  // F2: nonexistent nested product_id in one2many JSON is rejected
  const badProductRows = [
    ['.id', 'invoice_line_ids'],
    [String(inv.id), JSON.stringify([{ product_id: 999999, name: 'Broken', qty: 1, price_unit: 10 }])],
  ];
  assert.throws(
    () => importCsvRows(db, 'account.move', {}, badProductRows),
    /Enter an existing record ID for Product/,
  );

  // F2 follow-up: nested string id for missing/non-numeric record and non-array many2many are rejected; numeric-string id imports as number
  assert.throws(
    () => importCsvRows(db, 'account.move', {}, [
      ['.id', 'invoice_line_ids'],
      [String(inv.id), JSON.stringify([{ product_id: '999999', name: 'Missing Str ID', qty: 1, price_unit: 10 }])],
    ]),
    /Enter an existing record ID for Product/,
  );
  assert.throws(
    () => importCsvRows(db, 'account.move', {}, [
      ['.id', 'invoice_line_ids'],
      [String(inv.id), JSON.stringify([{ account_id: 'abc', name: 'Bad Str ID', qty: 1, price_unit: 10 }])],
    ]),
    /Enter an existing record ID for Account/,
  );
  assert.throws(
    () => importCsvRows(db, 'account.move', {}, [
      ['.id', 'invoice_line_ids'],
      [String(inv.id), JSON.stringify([{ product_id: product.id, name: 'Bad Tax Type', qty: 1, price_unit: 10, tax_ids: '1' }])],
    ]),
    /Invalid value for Taxes/,
  );
  const tax = search(db, 'account.tax')[0];
  const numericStrImported = importCsvRows(db, 'account.move', {}, [
    ['.id', 'invoice_line_ids'],
    [String(inv.id), JSON.stringify([{ product_id: String(product.id), name: 'String ID Line', qty: 1, price_unit: 50, ...(tax ? { tax_ids: [String(tax.id)] } : {}) }])],
  ]);
  const importedLine = read(numericStrImported.db, 'account.move', inv.id).invoice_line_ids[0];
  assert.equal(typeof importedLine.product_id, 'number');
  assert.equal(importedLine.product_id, product.id);
  if (tax) assert.deepEqual(importedLine.tax_ids, [tax.id]);

  // F2: nonexistent nested many2many tax_ids in one2many JSON is rejected
  const badTaxRows = [
    ['.id', 'invoice_line_ids'],
    [String(inv.id), JSON.stringify([{ product_id: product.id, name: 'Bad Tax', qty: 1, price_unit: 10, tax_ids: [999999] }])],
  ];
  assert.throws(
    () => importCsvRows(db, 'account.move', {}, badTaxRows),
    /Enter existing record IDs for Taxes/,
  );

  // F2: invalid one2many JSON shape (object instead of array) is rejected
  const badShapeRows = [
    ['.id', 'invoice_line_ids'],
    [String(inv.id), JSON.stringify({ product_id: product.id })],
  ];
  assert.throws(
    () => importCsvRows(db, 'account.move', {}, badShapeRows),
    /Invalid value for Invoice Lines/,
  );

  // F2: valid compatible round-trip updates invoice lines
  const exported = exportTable(db, 'account.move', [read(db, 'account.move', inv.id)], ['invoice_line_ids'], true).rows.map((r) => r.map(String));
  const updated = importCsvRows(db, 'account.move', {}, exported);
  assert.equal(updated.count, 1);

  // F9: malformed JSON in one2many/distribution/binary throws a translatable Invalid value message (not raw SyntaxError)
  for (const [model, col, badCell, expectedLabel] of [
    ['account.move', 'invoice_line_ids', '{not-json', 'Invoice Lines'],
    ['account.asset.model', 'analytic_distribution', '{not-json', 'Analytic Distribution'],
    ['blog.post', 'cover', '{not-json', 'Cover Image'],
  ]) {
    let thrown = null;
    try {
      importCsvRows(db, model, {}, [[col], [badCell]]);
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown, `${model}.${col} rejects malformed JSON`);
    assert.equal(thrown instanceof SyntaxError, false, 'Must not leak raw SyntaxError');
    assert.equal(thrown.message, `Invalid value for ${expectedLabel}`);
    const arabic = translatePattern(thrown.message, (label) => (t(label) === label ? null : label));
    assert.ok(arabic && arabic.includes('قيمة غير صالحة للحقل'), 'Error matches Arabic translation pattern');
  }
});

test('EXP review F3 & F5: Compatible export/import round-trips binary attachments and comma/semicolon tags', async () => {
  const { exportTable } = await import('./views/ExportDialog.jsx');
  const { fromCsv, importCsvRows, toCsv } = await import('./csv.js');
  const { applyDiff, diffDb } = await import('./sync.js');

  let db = seed();
  const blog = create(db, 'blog.blog', { name: 'Engineering' });
  const originalCover = { name: 'cover.png', type: 'image/png', size: 12, data: 'data:image/png;base64,AAAA' };
  const post = create(blog.db, 'blog.post', {
    blog_id: blog.id,
    name: 'Release Notes',
    cover: originalCover,
    tag_ids: ['red,blue', 'a;b', 'plain'],
  });
  db = post.db;

  const exportedRows = exportTable(db, 'blog.post', [read(db, 'blog.post', post.id)], ['name', 'cover', 'tag_ids'], true).rows;
  const roundTripped = fromCsv(toCsv(exportedRows));
  const newCover = { name: 'cover-v2.png', type: 'image/png', size: 16, data: 'data:image/png;base64,BBBB' };
  const coverCol = roundTripped[0].indexOf('cover');
  const tagsCol = roundTripped[0].indexOf('tag_ids');
  roundTripped[1][coverCol] = JSON.stringify(newCover);

  // Import unchanged tags and updated cover attachment
  const imported = importCsvRows(db, 'blog.post', {}, roundTripped);
  const updatedPost = read(imported.db, 'blog.post', post.id);
  assert.deepEqual(updatedPost.cover, newCover, 'Binary attachment round-trips and updates as attachment object');
  assert.deepEqual(updatedPost.tag_ids, ['red,blue', 'a;b', 'plain'], 'Tags containing commas and semicolons do not split');
  assert.doesNotThrow(() => applyDiff(db, diffDb(db, imported.db), { isAdmin: true }), 'Re-imported attachment passes server diff validation');

  // Legacy delimiter-separated tag imports remain supported
  const legacyTags = importCsvRows(db, 'blog.post', {}, [
    ['.id', 'tag_ids'],
    [String(post.id), 'one, two; three'],
  ]);
  assert.deepEqual(read(legacyTags.db, 'blog.post', post.id).tag_ids, ['one', 'two', 'three']);

  // Invalid binary payload is rejected against attachment contract
  assert.throws(
    () => importCsvRows(db, 'blog.post', {}, [['.id', 'cover'], [String(post.id), JSON.stringify('plain-string')]]),
    /Invalid value for Cover Image/,
  );

  // Unchanged export (without editing cover) also round-trips cleanly
  assert.equal(JSON.parse(roundTripped[1][tagsCol]).length, 3);
});

test('EXP review F4: Import-compatible mode excludes unsupported related paths and explains the limitation', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { ExportDialog, exportFields, exportTable } = await import('./views/ExportDialog.jsx');

  const db = seed();
  assert.ok(exportFields('blog.post', null, false).some((f) => f.path === 'blog_id/name'), 'Display mode includes related paths');
  assert.equal(exportFields('blog.post', null, true).some((f) => f.path === 'blog_id/name'), false, 'Compatible mode excludes unsupported related paths');
  assert.ok(exportFields('res.partner', null, true).some((f) => f.path === 'country_id/code'), 'Compatible mode retains supported country_id/code alias');
  assert.throws(
    () => exportTable(db, 'blog.post', [], ['blog_id/name'], true),
    /Invalid export fields/,
  );

  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(ExportDialog, {
      db,
      model: 'account.move',
      records: [],
      columns: ['name', 'partner_id/name'],
      title: 'Journal Entries',
      onClose: () => {},
    })));
    assert.ok(find(host, (n) => props(n)?.['aria-label'] === 'Remove field: Partner/Name'));
    const compatCheckbox = find(host, (n) => n.tagName === 'INPUT' && props(n)?.type === 'checkbox');
    await React.act(async () => props(compatCheckbox).onChange({ target: { checked: true } }));

    assert.equal(find(host, (n) => props(n)?.['aria-label'] === 'Remove field: Partner/Name'), null, 'Checking compatible strips unsupported related fields from chosen list');
    const searchInput = find(host, (n) => props(n)?.['aria-label'] === 'Search fields');
    await React.act(async () => props(searchInput).onChange({ target: { value: 'partner_id/name' } }));
    assert.equal(find(host, (n) => n.tagName === 'BUTTON' && n.textContent === 'Partner/Name'), null, 'Picker hides unsupported related paths in compatible mode');
    assert.ok(find(host, (n) => n.tagName === 'P' && n.textContent.includes('Related fields cannot be updated through import')), 'Field picker explains limitation');
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('EXP review F7: Display export runs empty-value fallbacks for empty currency_id and legacy analytic account', async () => {
  const { exportTable } = await import('./views/ExportDialog.jsx');
  let db = seed();
  const plan = search(db, 'account.analytic.plan')[0] ?? create(db, 'account.analytic.plan', { name: 'Projects' });
  if (plan.db) db = plan.db;
  const analytic = create(db, 'account.analytic.account', { name: 'Legacy Project', company_id: 1, plan_id: plan.id });
  db = analytic.db;
  const inv = create(db, 'account.move', {
    name: 'INV-F7-EMPTY-CURR',
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: 1,
    currency_id: null,
    invoice_date: '2026-06-01',
    invoice_line_ids: [{ name: 'Line', qty: 1, price_unit: 100, tax: 0 }],
  });
  db = inv.db;
  const invRec = { ...read(db, 'account.move', inv.id), currency_id: null };
  const legacyAsset = { id: 9001, name: 'Legacy Asset', company_id: 1, analytic_account_id: analytic.id, analytic_distribution: null };

  const invTable = exportTable(db, 'account.move', [invRec], ['currency_id'], false);
  assert.equal(invTable.rows[1][0], 'USD', 'Empty currency_id exports company currency in display mode');
  const invCompat = exportTable(db, 'account.move', [invRec], ['currency_id'], true);
  assert.equal(invCompat.rows[1][1], '', 'Empty currency_id remains blank in compatible mode');

  const assetTable = exportTable(db, 'account.asset', [legacyAsset], ['analytic_distribution'], false);
  assert.equal(assetTable.rows[1][0], 'Legacy Project 100%', 'Legacy analytic_account_id exports as 100% distribution in display mode');
  const assetCompat = exportTable(db, 'account.asset', [legacyAsset], ['analytic_distribution'], true);
  assert.equal(assetCompat.rows[1][1], '', 'Null analytic_distribution remains blank in compatible mode');
});

test('EXP review F8: ExportDialog download passes listFields overrides for labels, widgets, and hideWhen rules', async () => {
  const { makeEl } = setupDom();
  const spy = setupDownloadSpy(makeEl);
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { ExportDialog } = await import('./views/ExportDialog.jsx');
  const { apps, findLeaf } = await import('./models/index.js');

  let db = seed();
  const inv = create(db, 'account.move', {
    name: 'INV-F8-DUE',
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: 1,
    invoice_date: today(),
    invoice_date_due: today(),
    invoice_line_ids: [{ name: 'Item', qty: 1, price_unit: 100, tax: 0 }],
  });
  db = inv.db;
  const paidInv = create(db, 'account.move', {
    name: 'INV-F8-PAID',
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: 1,
    invoice_date: today(),
    invoice_date_due: today(),
    invoice_line_ids: [{ name: 'Item', qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(paidInv.db, paidInv.id);
  db = payMove(db, paidInv.id, 100, today());

  const invoicesLeaf = findLeaf(apps.find((a) => a.id === 'accounting'), 'invoices');
  const customListFields = {
    ...invoicesLeaf.listFields,
    invoice_date_due: { ...invoicesLeaf.listFields.invoice_date_due, label: 'Due Window' },
  };
  const records = [read(db, 'account.move', inv.id), read(db, 'account.move', paidInv.id)];
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    await React.act(async () => root.render(React.createElement(ExportDialog, {
      db,
      model: 'account.move',
      records,
      columns: ['name', 'invoice_date_due'],
      labels: {},
      listFields: customListFields,
      title: 'Invoices',
      onClose: () => {},
    })));
    const exportBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent === 'Export');
    await React.act(async () => props(exportBtn).onClick());
    const dl = await spy.takeLast();
    assert.ok(dl, 'CSV downloaded');
    const rows = fromCsv(await dl.text());
    assert.deepEqual(rows[0], ['Number', 'Due Window'], 'Header uses listFields overridden label');
    assert.deepEqual(rows[1], ['INV-F8-DUE', 'Today'], 'Unpaid invoice due date uses listFields remaining_days widget');
    assert.deepEqual(rows[2], ['INV-F8-PAID', ''], 'Paid invoice due date is hidden by listFields hideWhen rule');
  } finally {
    await React.act(async () => root.unmount());
    spy.restore();
  }
});
