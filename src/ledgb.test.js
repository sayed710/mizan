import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { create } from './orm.js';
import './models/index.js';
import { seed } from './seed.js';
import { postEntry } from './models/ledger.js';
import { pnlColumns } from './views/reportCompare.js';
import { tableToRows, toCsv } from './csv.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));
const props = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];

test('P&L Other Income and Other Expenses detail rows appear in comparison and section views (finding 6)', async () => {
  let db = seed();
  const otherInc = create(db, 'account.account', {
    code: '701000',
    name: 'Interest Income',
    account_type: 'income_other',
  });
  db = otherInc.db;
  const otherExp = create(db, 'account.account', {
    code: '702000',
    name: 'Interest Expense',
    account_type: 'expense_other',
  });
  db = otherExp.db;

  const date = '2026-03-15';
  db = postEntry(db, {
    journal: 'MISC',
    date,
    company: 1,
    lines: [
      { account: '101401', debit: 250 },
      { account: otherInc.id, credit: 250 },
    ],
  }).db;
  db = postEntry(db, {
    journal: 'MISC',
    date,
    company: 1,
    lines: [
      { account: otherExp.id, debit: 120 },
      { account: '101401', credit: 120 },
    ],
  }).db;

  // 1. Comparison columns include detail rows
  const periods = [{ from: '2026-03-01', to: '2026-03-31', label: 'Mar 2026' }];
  const comp = pnlColumns(db, periods);
  const otherIncSection = comp.sections.find((s) => s.title === 'Other Income');
  const otherExpSection = comp.sections.find((s) => s.title === 'Other Expenses');
  assert.ok(otherIncSection, 'Other Income section exists');
  assert.ok(otherExpSection, 'Other Expenses section exists');
  assert.equal(otherIncSection.totals[0], 250);
  assert.equal(otherExpSection.totals[0], 120);

  const incRow = otherIncSection.rows.find((r) => r.account.id === otherInc.id);
  assert.ok(incRow, 'Other Income detail row exists');
  assert.deepEqual(incRow.values, [250]);

  const expRow = otherExpSection.rows.find((r) => r.account.id === otherExp.id);
  assert.ok(expRow, 'Other Expenses detail row exists');
  assert.deepEqual(expRow.values, [120]);

  // 2. React component rendering with expandable detail rows
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();
  await commit(db);

  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    await React.act(async () => {
      root.render(React.createElement(Reports, { leaf: { label: 'Profit and Loss', report: 'pnl' } }));
    });

    // Find and expand Other Income
    const incHeader = find(host, (n) => n.tagName === 'TR' && n.textContent.includes('Other Income'));
    assert.ok(incHeader, 'Other Income header rendered');
    await React.act(async () => {
      props(incHeader).onClick();
    });
    assert.ok(host.textContent.includes('Interest Income'), 'Interest Income row rendered in Other Income section');

    // Find and expand Other Expenses
    const expHeader = find(host, (n) => n.tagName === 'TR' && n.textContent.includes('Other Expenses'));
    assert.ok(expHeader, 'Other Expenses header rendered');
    await React.act(async () => {
      props(expHeader).onClick();
    });
    assert.ok(host.textContent.includes('Interest Expense'), 'Interest Expense row rendered in Other Expenses section');
  } finally {
    await React.act(async () => {
      root.unmount();
    });
  }
});

test('Financial reports and configurable report offer Download CSV export (finding 7)', async () => {
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();

  let db = seed();
  const line = (code, formula) => ({ code, name: code, formula, sequence: 10 });
  const report = create(db, 'account.report', {
    name: 'Custom PnL',
    company_id: 1,
    line_ids: [line('REV', '101401')],
  });
  db = report.db;
  await commit(db);

  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    for (const rep of ['trial', 'pnl', 'balance', 'partnerReceivable', 'agedReceivable']) {
      await React.act(async () => {
        root.render(React.createElement(Reports, { leaf: { label: rep, report: rep } }));
      });
      const downloadBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes('Download CSV'));
      assert.ok(downloadBtn, `Download CSV button rendered for report ${rep}`);
      const printBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent === 'Print');
      assert.ok(printBtn, `Print button rendered for report ${rep}`);
    }

    // Test Configurable Report page
    const { ConfigurableReportPage } = await import('./views/ConfigurableReport.jsx');
    await React.act(async () => {
      root.render(React.createElement(ConfigurableReportPage, { id: report.id }));
    });
    const cfgDownloadBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes('Download CSV'));
    assert.ok(cfgDownloadBtn, 'Download CSV button rendered for Configurable Report');
    const cfgPrintBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent === 'Print');
    assert.ok(cfgPrintBtn, 'Print button rendered for Configurable Report');

    // Trigger Download CSV on configurable report
    const table = find(host, (n) => n.tagName === 'TABLE');
    assert.ok(table, 'Table rendered for Configurable Report');
    const rows = tableToRows(table);
    assert.ok(rows.length > 0, 'Table has extracted rows');
    assert.equal(rows[0][0], 'Report Lines');
    const csv = toCsv(rows);
    assert.ok(csv.includes('Report Lines'));
  } finally {
    await React.act(async () => {
      root.unmount();
    });
  }
});

test('P&L, Balance Sheet, and Trial Balance account rows link to account records (finding 8)', async () => {
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();

  let db = seed();
  const acc = create(db, 'account.account', {
    code: '411000',
    name: 'Consulting Sales',
    account_type: 'income',
  });
  db = acc.db;
  db = postEntry(db, {
    journal: 'MISC',
    date: '2026-03-10',
    company: 1,
    lines: [
      { account: '101401', debit: 500 },
      { account: acc.id, credit: 500 },
    ],
  }).db;
  await commit(db);

  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    // 1. Trial Balance links to #/open/account.account/:id
    await React.act(async () => {
      root.render(React.createElement(Reports, { leaf: { label: 'Trial Balance', report: 'trial' } }));
    });
    const tbLink = find(host, (n) => n.tagName === 'A' && props(n)?.href === `#/open/account.account/${acc.id}`);
    assert.ok(tbLink, 'Trial Balance account row has drilldown link to #/open/account.account/:id');

    // 2. P&L links to #/open/account.account/:id
    await React.act(async () => {
      root.render(React.createElement(Reports, { leaf: { label: 'Profit and Loss', report: 'pnl' } }));
    });
    const revHeader = find(host, (n) => n.tagName === 'TR' && n.textContent.includes('Revenue'));
    assert.ok(revHeader);
    await React.act(async () => {
      props(revHeader).onClick();
    });
    const pnlLink = find(host, (n) => n.tagName === 'A' && props(n)?.href === `#/open/account.account/${acc.id}`);
    assert.ok(pnlLink, 'P&L detail row has drilldown link to #/open/account.account/:id');

    // 3. Balance Sheet links to #/open/account.account/:id (cash account 101401)
    await React.act(async () => {
      root.render(React.createElement(Reports, { leaf: { label: 'Balance Sheet', report: 'balance' } }));
    });
    const assetHeader = find(host, (n) => n.tagName === 'TR' && n.textContent.includes('Assets'));
    assert.ok(assetHeader);
    await React.act(async () => {
      props(assetHeader).onClick();
    });
    const bankAcc = db.records['account.account'].find((a) => a.code === '101401');
    const balLink = find(host, (n) => n.tagName === 'A' && props(n)?.href === `#/open/account.account/${bankAcc.id}`);
    assert.ok(balLink, 'Balance Sheet detail row has drilldown link to #/open/account.account/:id');
  } finally {
    await React.act(async () => {
      root.unmount();
    });
  }
});
