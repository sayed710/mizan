import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { create, search } from './orm.js';
import { seed } from './seed.js';
import { decodeEntities, fromCsv, tableToRows } from './csv.js';
import { parseZip } from './xlsx.js';
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

function readXlsx(bytes) {
  const { files } = parseZip(bytes);
  const workbookXml = files['xl/workbook.xml'] ? new TextDecoder().decode(files['xl/workbook.xml'].data) : '';
  const sheetMatch = workbookXml.match(/<sheet[^>]*name="([^"]+)"/);
  const sheetName = sheetMatch ? sheetMatch[1] : 'Sheet1';
  const sheetXml = files['xl/worksheets/sheet1.xml'] ? new TextDecoder().decode(files['xl/worksheets/sheet1.xml'].data) : '';
  const rows = [];
  const rowRegex = /<row[^>]*>([\s\S]*?)<\/row>/gi;
  const cellRegex = /<c\b([^/>]*)\/>|<c\b([^>]*)>([\s\S]*?)<\/c>/gi;
  for (let rowMatch; (rowMatch = rowRegex.exec(sheetXml)) !== null;) {
    const rowCells = [];
    for (let cellMatch; (cellMatch = cellRegex.exec(rowMatch[1])) !== null;) {
      const attrs = cellMatch[1] ?? cellMatch[2] ?? '';
      const body = cellMatch[3] ?? '';
      const refMatch = attrs.match(/r="([A-Z]+)(\d+)"/i);
      let colIdx = rowCells.length;
      if (refMatch) {
        colIdx = [...refMatch[1].toUpperCase()].reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
      }
      let val = '';
      if (body.includes('<is><t>')) {
        const tMatch = body.match(/<is><t>([\s\S]*?)<\/t><\/is>/);
        val = tMatch ? decodeEntities(tMatch[1]) : '';
      } else if (body.includes('<v>')) {
        const vMatch = body.match(/<v>([\s\S]*?)<\/v>/);
        const raw = vMatch ? vMatch[1] : '';
        const num = Number(raw);
        val = Number.isFinite(num) ? num : raw;
      }
      rowCells[colIdx] = val;
    }
    for (let i = 0; i < rowCells.length; i += 1) {
      if (rowCells[i] === undefined) rowCells[i] = '';
    }
    rows.push(rowCells);
  }
  const merges = [];
  const mergeRegex = /<mergeCell\b[^>]*ref="([^"]+)"/gi;
  for (let mMatch; (mMatch = mergeRegex.exec(sheetXml)) !== null;) {
    merges.push(mMatch[1]);
  }
  return { sheetName, rows, merges };
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
    assert.equal(jiParsed.rows.length, 3, 'Header + 2 matching journal items exported');
    assert.ok(!jiParsed.rows[0].includes('Select'), 'Select checkbox column is excluded from XLSX');
    assert.ok(!jiParsed.rows[0].includes('⋯'), 'Optional columns toggle is excluded from XLSX');
    assert.ok(jiParsed.rows.some((r) => r.includes('EXP4 Visible Debit') && r.includes(420)));
    assert.ok(!jiParsed.rows.some((r) => r.includes('EXP4 Filtered Out')));

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
