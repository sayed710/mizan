import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { create, search } from './orm.js';
import { seed } from './seed.js';
import { fromCsv, tableToRows } from './csv.js';
import { readXlsx } from './xlsx.js';
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

test('EXP-1: Report leaves bypassing ReportPage expose Print, CSV, and XLSX exports via Reports routing; Checks stays untouched', async () => {
  const { makeEl } = setupDom();
  const spy = setupDownloadSpy(makeEl);
  let printCount = 0;
  const origPrint = globalThis.print;
  globalThis.print = () => { printCount += 1; };

  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const store = await import('./store.js');
  await store.initStore();

  let db = seed();
  const currency = create(db, 'res.currency', {
    name: 'EUR2',
    rate_ids: [{ date: '2026-01-01', rate: 2 }, { date: '2026-02-01', rate: 1 }],
  });
  const fxInv = create(currency.db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    company_id: 1,
    currency_id: currency.id,
    invoice_date: '2026-01-01',
    invoice_line_ids: [{ name: 'EXP2 FX Item', qty: 1, price_unit: 150, tax: 0 }],
  });
  db = postMove(fxInv.db, fxInv.id);

  const bankJournal = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  const cashAcc = accountId(db, '101401');
  const loan = create(db, 'account.loan', {
    name: 'EXP2 Term Loan',
    amount: 5000,
    duration: 12,
    interest_rate: 5,
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
      { account_id: cashAcc, debit: 800 },
      { account_id: accountId(db, '400000'), credit: 800 },
    ],
  }).db;

  const prod = create(db, 'product', { name: 'EXP2 Desk', list_price: 100, type: 'goods', invoice_policy: 'delivery' });
  const o1 = create(prod.db, 'sale.order', {
    name: 'SO-EXP2-TO-ISSUE',
    partner_id: 1,
    state: 'sale',
    order_line: [{ product_id: prod.id, name: 'EXP2 Desk', qty: 5, qty_delivered: 4, qty_invoiced: 1, price_unit: 100, tax: 0 }],
  });
  const o2 = create(o1.db, 'sale.order', {
    name: 'SO-EXP2-NOT-DELIV',
    partner_id: 1,
    state: 'sale',
    order_line: [{ product_id: prod.id, name: 'EXP2 Desk', qty: 6, qty_delivered: 2, qty_invoiced: 5, price_unit: 80, tax: 0 }],
  });
  db = o2.db;

  await React.act(async () => store.commit(db));

  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    const reportLeaves = [
      { report: 'invoicesToBeIssued', label: 'Invoices To Be Issued', expectedText: 'SO-EXP2-TO-ISSUE', xlsxLabel: 'Export XLSX' },
      { report: 'invoicedNotDelivered', label: 'Invoiced Not Delivered', expectedText: 'SO-EXP2-NOT-DELIV', xlsxLabel: 'Export XLSX' },
      { report: 'loansAnalysis', label: 'Loans Analysis', expectedText: 'EXP2 Term Loan', xlsxLabel: 'Download XLSX' },
      { report: 'cashflowAnalysis', label: 'Cashflow Analysis', expectedText: today().slice(0, 7), xlsxLabel: 'Download XLSX' },
      { report: 'unrealizedCurrencies', label: 'Unrealized Currencies', expectedText: 'EUR2', xlsxLabel: 'Export XLSX' },
    ];

    for (const spec of reportLeaves) {
      await React.act(async () => {
        root.render(React.createElement(Reports, { leaf: { report: spec.report, label: spec.label } }));
      });

      const buttons = findAll(host, (n) => n.tagName === 'BUTTON');
      const printBtn = buttons.find((b) => b.textContent === 'Print');
      const csvBtn = buttons.find((b) => b.textContent === 'Download CSV');
      const xlsxBtn = buttons.find((b) => b.textContent === spec.xlsxLabel);

      assert.ok(printBtn, `${spec.report}: Print button exists`);
      assert.ok(csvBtn, `${spec.report}: CSV button exists`);
      assert.ok(xlsxBtn, `${spec.report}: XLSX button exists`);

      const expectedRows = tableToRows(find(host, (n) => n.tagName === 'TABLE'));
      assert.ok(expectedRows.length >= 2, `${spec.report}: table has header and data rows`);

      await React.act(async () => props(csvBtn).onClick());
      const csvDl = await spy.takeLast();
      assert.ok(csvDl && csvDl.filename.endsWith('.csv'), `${spec.report}: CSV download triggered`);
      const csvRows = fromCsv(await csvDl.text());
      assert.equal(csvRows.length, expectedRows.length, `${spec.report}: CSV row count matches table`);
      assert.ok(csvRows.some((r) => r.some((c) => String(c).includes(spec.expectedText))), `${spec.report}: CSV includes expected record`);

      await React.act(async () => props(xlsxBtn).onClick());
      const xlsxDl = await spy.takeLast();
      assert.ok(xlsxDl && xlsxDl.filename.endsWith('.xlsx'), `${spec.report}: XLSX download triggered`);
      assert.equal(xlsxDl.type, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      const parsedXlsx = readXlsx(xlsxDl.bytes);
      assert.equal(parsedXlsx.rows.length, expectedRows.length, `${spec.report}: XLSX row count matches table`);
      for (let i = 0; i < expectedRows.length; i += 1) {
        assert.deepEqual(parsedXlsx.rows[i].map(normCell), expectedRows[i].map(normCell));
      }

      const beforePrints = printCount;
      await React.act(async () => props(printBtn).onClick());
      assert.equal(printCount, beforePrints + 1, `${spec.report}: Print button opens print view and prints`);
      const printMain = find(host, (n) => n.tagName === 'MAIN' && String(n.className).includes('print-page'));
      assert.ok(printMain, `${spec.report}: print-page container rendered`);
      const backBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent === 'Back');
      assert.ok(backBtn, `${spec.report}: Back button exits print view`);
      await React.act(async () => props(backBtn).onClick());
    }

    // Checks is a check-register list view, not an Odoo account_report, so it must not expose report CSV/XLSX buttons.
    await React.act(async () => {
      root.render(React.createElement(Reports, { leaf: { report: 'checks', label: 'Checks' } }));
    });
    const checkButtons = findAll(host, (n) => n.tagName === 'BUTTON');
    assert.equal(checkButtons.some((b) => /CSV|XLSX/i.test(b.textContent)), false, 'Checks does not get report CSV/XLSX buttons');
  } finally {
    globalThis.print = origPrint;
    await React.act(async () => root.unmount());
    spy.restore();
  }
});

test('EXP-2: ActionView list exports CSV and XLSX via shared writer, respecting selected records and list-only visibility', async () => {
  const { makeEl } = setupDom();
  const spy = setupDownloadSpy(makeEl);
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const store = await import('./store.js');
  await store.initStore();

  let db = seed();
  const inv1 = create(db, 'account.move', {
    name: 'INV-EXP2-001',
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: 1,
    invoice_date: '2026-06-01',
    invoice_line_ids: [{ name: 'Consulting', qty: 2, price_unit: 250, tax: 0 }],
  });
  const inv2 = create(inv1.db, 'account.move', {
    name: 'INV-EXP2-002',
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: 1,
    invoice_date: '2026-06-02',
    invoice_line_ids: [{ name: 'Support', qty: 1, price_unit: 400, tax: 0 }],
  });
  db = inv2.db;
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
    assert.ok(csvBtn, 'List view renders CSV Export button');
    assert.ok(xlsxBtn, 'List view renders Export XLSX button');

    await React.act(async () => props(csvBtn).onClick());
    const csvAll = await spy.takeLast();
    assert.equal(csvAll.filename, 'account.move.csv');
    const csvAllRows = fromCsv(await csvAll.text());

    await React.act(async () => props(xlsxBtn).onClick());
    const xlsxAll = await spy.takeLast();
    assert.equal(xlsxAll.filename, 'account.move.xlsx');
    assert.equal(xlsxAll.type, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const parsedAll = readXlsx(xlsxAll.bytes);
    assert.equal(parsedAll.rows.length, csvAllRows.length);
    for (let i = 0; i < csvAllRows.length; i += 1) {
      assert.deepEqual(parsedAll.rows[i].map(normCell), csvAllRows[i].map(normCell));
    }

    const cb2 = find(host, (n) => n.tagName === 'INPUT' && props(n)?.type === 'checkbox' && props(n)?.['aria-label'] === 'INV-EXP2-002');
    assert.ok(cb2, 'Selection checkbox exists for INV-EXP2-002');
    await React.act(async () => props(cb2).onChange({ target: { checked: true } }));

    await React.act(async () => props(csvBtn).onClick());
    const csvSel = await spy.takeLast();
    const csvSelRows = fromCsv(await csvSel.text());
    assert.equal(csvSelRows.length, 2);

    await React.act(async () => props(xlsxBtn).onClick());
    const xlsxSel = await spy.takeLast();
    const parsedSel = readXlsx(xlsxSel.bytes);
    assert.equal(parsedSel.rows.length, 2, 'Selected XLSX export includes header + 1 selected row');
    assert.deepEqual(parsedSel.rows[1].map(normCell), csvSelRows[1].map(normCell));
    assert.ok(parsedSel.rows[1].includes('INV-EXP2-002'));

    // Non-list views (e.g. kanban) do not render list export buttons.
    await React.act(async () => {
      root.render(React.createElement(ActionView, {
        leaf: { model: 'account.move', label: 'Journal Entries' },
        base: '#/accounting/entries',
        params: new URLSearchParams('view=kanban'),
      }));
    });
    assert.equal(find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes('Export XLSX')), null);
  } finally {
    await React.act(async () => root.unmount());
    spy.restore();
  }
});
