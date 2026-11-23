import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { seed } from './seed.js';
import { postEntry } from './models/ledger.js';
import { findStatementReport } from './models/statementReports.js';
import { compareConfigurableReport } from './models/configurableReports.js';
import { generalLedger, trialBalance } from './models/reports.js';
import { today } from './models/common.js';
import { fromCsv, tableToRows, toCsv } from './csv.js';
import { buildXlsx, readXlsx } from './xlsx.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));
const props = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];
const table = (host) => find(host, (node) => node.tagName === 'TABLE');
const names = (host) => tableToRows(table(host)).map((row) => row[0]);

test('OPT-1: zero lines are selectable across reports, comparisons, print and export table', async () => {
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { Reports } = await import('./views/Reports.jsx');
  await initStore();
  let db = seed();
  db = { ...db, records: { ...db.records, 'account.move': [], 'account.payment': [] } };
  const year = Number(today().slice(0, 4));
  for (const [date, debit, credit] of [[`${year - 1}-01-01`, '101401', '301000'], [`${year - 1}-02-01`, '301000', '101401']]) {
    db = postEntry(db, { journal: 'MISC', company: 1, date, lines: [{ account: debit, debit: 10 }, { account: credit, credit: 10 }] }).db;
  }
  const period = { from: `${year}-01-01`, to: `${year}-12-31` };
  const pnl = findStatementReport(db, 'pnl', 1);
  const plain = compareConfigurableReport(db, pnl, [period], period);
  const hidden = compareConfigurableReport(db, pnl, [period], period, null, { hideZeroLines: true });
  assert.ok(plain.rows.some((row) => row.code === 'DEP'));
  assert.ok(!hidden.rows.some((row) => row.code === 'DEP'));
  assert.ok(hidden.rows.some((row) => row.code === 'NET'));
  const comparison = compareConfigurableReport(db, findStatementReport(db, 'balance', 1), [
    { from: `${year - 1}-01-01`, to: `${year - 1}-01-31`, label: 'Earlier' },
    { ...period, label: 'Current' },
  ], period, null, { hideZeroLines: true });
  assert.ok(comparison.rows.some((row) => row.code === 'CASH' && row.values[0] !== 0 && row.values[1] === 0));
  const ledgerPlain = generalLedger(db, period);
  const ledgerHidden = generalLedger(db, { ...period, hideZeroLines: true });
  assert.ok(ledgerPlain.rows.length > ledgerHidden.rows.length);
  assert.ok(trialBalance(db, { ...period, includeZeroRows: true }).rows.length > trialBalance(db, period).rows.length);
  await React.act(async () => commit(db));
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    for (const [report, zeroName, totalName] of [
      ['pnl', 'Depreciation', 'Net Profit'],
      ['balance', 'Prepayments', 'ASSETS'],
      ['trial', '101401', 'Total'],
      ['ledger', '101401', null],
    ]) {
      await React.act(async () => root.render(React.createElement(Reports, { key: report, leaf: { report } })));
      assert.ok(names(host).some((name) => name.includes(zeroName)), `${report}: zero row initially visible`);
      const label = find(host, (node) => node.tagName === 'LABEL' && node.textContent.includes('Hide lines at 0'));
      const checkbox = find(label, (node) => node.tagName === 'INPUT');
      assert.ok(checkbox, `${report}: option exists`);
      await React.act(async () => props(checkbox).onChange({ target: { checked: true } }));
      assert.ok(!names(host).some((name) => name.includes(zeroName)), `${report}: zero row hidden in exported table`);
      if (totalName) assert.ok(names(host).some((name) => name === totalName));
      const csvRows = fromCsv(toCsv(tableToRows(table(host))));
      const xlsxRows = readXlsx(buildXlsx(table(host))).rows;
      assert.ok(!csvRows.some((row) => String(row[0]).includes(zeroName)), `${report}: CSV omits zero row`);
      assert.ok(!xlsxRows.some((row) => String(row[0]).includes(zeroName)), `${report}: XLSX omits zero row`);
      await React.act(async () => props(checkbox).onChange({ target: { checked: false } }));
      assert.ok(names(host).some((name) => name.includes(zeroName)), `${report}: clearing option restores row`);
      await React.act(async () => props(checkbox).onChange({ target: { checked: true } }));
      const button = find(host, (node) => node.tagName === 'BUTTON' && node.textContent === 'Print');
      await React.act(async () => props(button).onClick());
      assert.ok(!names(host).some((name) => name.includes(zeroName)), `${report}: zero row hidden in print`);
    }
  } finally {
    await React.act(async () => root.unmount());
  }
});
