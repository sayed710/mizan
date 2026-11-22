import test from 'node:test';
import { register } from 'node:module';
import './models/index.js';
import assert from 'node:assert/strict';
import * as reports from './models/reports.js';
import { toggleReportFold, toggleAllReportFolds, reportPrintFooters } from './views/reportFold.js';
import { create, search } from './orm.js';
import { seed } from './seed.js';
import { accountId } from './models/ledger.js';
import { postMove } from './models/accounting.js';
import { documentCompany } from './models/company.js';
import { today } from './models/common.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

test('untagged accounts default by type and explicit tags override', () => {
  const db = { records: { 'account.account.tag': [{ id: 1, cash_flow_activity: 'financing' }] } };
  for (const account_type of ['income', 'income_other', 'expense', 'expense_depreciation', 'expense_direct_cost', 'expense_other', 'asset_receivable', 'liability_payable']) assert.equal(reports.accountCashFlowActivity(db, { account_type }), 'operating');
  for (const account_type of ['asset_fixed', 'liability_non_current', 'equity']) assert.equal(reports.accountCashFlowActivity(db, { account_type }), 'unclassified');
  assert.equal(reports.accountCashFlowActivity(db, { account_type: 'asset_fixed', tag_ids: [1] }), 'financing');
  assert.equal(reports.accountCashFlowActivity(db, { account_type: 'off_balance' }), 'unclassified');
});

test('fold state supports individual sections and all sections', () => {
  const keys = ['operating', 'investing', 'financing'];
  let open = toggleReportFold(new Set(), 'operating');
  assert.deepEqual([...open], ['operating']);
  open = toggleAllReportFolds(open, keys);
  assert.deepEqual([...open], keys);
  assert.equal(toggleAllReportFolds(open, keys).size, 0);
});

test('report print data retains the selected company legal footer', () => {
  const db = { records: { 'res.company': [{ id: 1, name: 'Example', report_footer: 'Legal details' }], 'res.currency': [] } };
  const company = documentCompany(db, { company_id: 1 });
  assert.deepEqual(reportPrintFooters([company]), ['Legal details']);
  assert.deepEqual(reportPrintFooters([{ name: 'No footer' }]), []);
});

test('cash flow leaves untagged fixed asset movement unclassified and reconciles to cash', () => {
  let db = seed();
  const cash = accountId(db, '101401');
  const asset = create(db, 'account.account', { code: '159903', name: 'Equipment', account_type: 'asset_fixed' });
  const move = create(asset.db, 'account.move', { move_type: 'entry', invoice_date: '2040-05-10', line_ids: [{ account_id: cash, credit: 300 }, { account_id: asset.id, debit: 300 }] });
  db = postMove(move.db, move.id);
  const flow = reports.cashFlow(db, { from: '2040-05-10', to: '2040-05-10', company_id: 1 });
  assert.equal(flow.unclassified, -300);
  assert.equal(flow.lines.find((line) => line.account.id === asset.id).section, 'unclassified');
  assert.equal(flow.operating + flow.investing + flow.financing + flow.unclassified, flow.net);
  assert.equal(flow.opening + flow.net, flow.closing);
});

test('cash flow treats untagged expense_other movement as operating activity and reconciles to cash', () => {
  let db = seed();
  const cash = accountId(db, '101401');
  const fee = create(db, 'account.account', { code: '690998', name: 'Bank Service Charges', account_type: 'expense_other' });
  const move = create(fee.db, 'account.move', { move_type: 'entry', invoice_date: '2040-05-12', line_ids: [{ account_id: cash, credit: 75 }, { account_id: fee.id, debit: 75 }] });
  db = postMove(move.db, move.id);
  const flow = reports.cashFlow(db, { from: '2040-05-12', to: '2040-05-12', company_id: 1 });
  assert.equal(flow.operating, -75);
  assert.equal(flow.unclassified, 0);
  assert.equal(flow.lines.find((line) => line.account.id === fee.id).section, 'operating');
  assert.equal(flow.operating + flow.investing + flow.financing + flow.unclassified, flow.net);
  assert.equal(flow.opening + flow.net, flow.closing);
});

test('printed financial report retains base footer when company has no legal footer and replaces it when configured', async () => {
  const { setupDom, find } = await import('./test-support/dom.js');
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { ReportPrintView } = await import('./views/FinancialReportPrint.jsx');

  // Case 1: Company with no report_footer configured -> retains base paper footer
  const hostNoFooter = makeEl('div');
  hostNoFooter.ownerDocument = globalThis.document;
  const rootNoFooter = createRoot(hostNoFooter);
  try {
    await React.act(async () => {
      rootNoFooter.render(React.createElement(ReportPrintView, {
        active: true,
        company: { id: 1, name: 'Plain Co' },
        title: 'Balance Sheet',
        autoPrint: false,
      }));
    });
    const styleEl = find(hostNoFooter, (n) => n.tagName === 'STYLE');
    assert.ok(styleEl, 'Print style tag exists');
    assert.doesNotMatch(styleEl.textContent, /\.paper > \.paper-foot \{ display: none; \}/, 'Does not hide base footer when no legal footer exists');
    const baseFoot = find(hostNoFooter, (n) => n.className?.includes('paper-foot'));
    assert.ok(baseFoot, 'Base paper-foot footer is rendered');
    assert.match(baseFoot.textContent, /Plain Co · Generated by Mizan/);
    const legalFoot = find(hostNoFooter, (n) => n.className?.includes('report-legal-footer'));
    assert.equal(legalFoot, null, 'No report-legal-footer when report_footer is empty');
  } finally {
    await React.act(async () => rootNoFooter.unmount());
  }

  // Case 2: Company with report_footer configured -> replaces base paper footer
  const hostWithFooter = makeEl('div');
  hostWithFooter.ownerDocument = globalThis.document;
  const rootWithFooter = createRoot(hostWithFooter);
  try {
    await React.act(async () => {
      rootWithFooter.render(React.createElement(ReportPrintView, {
        active: true,
        company: { id: 1, name: 'Legal Co', report_footer: 'Commercial Reg: 12345' },
        title: 'Balance Sheet',
        autoPrint: false,
      }));
    });
    const styleEl = find(hostWithFooter, (n) => n.tagName === 'STYLE');
    assert.ok(styleEl, 'Print style tag exists');
    assert.match(styleEl.textContent, /\.paper > \.paper-foot \{ display: none; \}/, 'Hides base paper footer when legal footer is present');
    const legalFoot = find(hostWithFooter, (n) => n.className?.includes('report-legal-footer'));
    assert.ok(legalFoot, 'Legal footer is rendered');
    assert.match(legalFoot.textContent, /Commercial Reg: 12345/);
  } finally {
    await React.act(async () => rootWithFooter.unmount());
  }
});

test('unrealized currencies report prints company legal footer and repeating header', async () => {
  const { setupDom, find } = await import('./test-support/dom.js');
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const store = await import('./store.js');
  await store.initStore();

  let db = seed();
  db = {
    ...db,
    settings: { ...db.settings, current_company_id: 1, allowed_company_ids: [1] },
    records: {
      ...db.records,
      'res.company': db.records['res.company'].map((c) => c.id === 1 ? { ...c, report_footer: 'Currency Legal Footer 789' } : c),
    },
  };
  await React.act(async () => store.commit(db));

  const { UnrealizedCurrencies } = await import('./views/UnrealizedCurrencies.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => {
      root.render(React.createElement(UnrealizedCurrencies));
    });
    const printBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent === 'Print');
    assert.ok(printBtn, 'Print button exists');
    const props = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];
    await React.act(async () => {
      props(printBtn).onClick();
    });

    const repeatHeader = find(host, (n) => n.className?.includes('report-repeat-header'));
    assert.ok(repeatHeader, 'Repeating company header rendered in print mode');
    const legalFoot = find(host, (n) => n.className?.includes('report-legal-footer'));
    assert.ok(legalFoot, 'Legal footer rendered in Unrealized Currencies print view');
    assert.match(legalFoot.textContent, /Currency Legal Footer 789/);
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('cash flow comparison renders Unfold All control and toggles section detail rows while preserving folded rows', async () => {
  const { setupDom, find } = await import('./test-support/dom.js');
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const store = await import('./store.js');
  await store.initStore();

  let db = seed();
  db = { ...db, records: { ...db.records, 'account.move': [], 'account.payment': [] } };
  const yr = Number(today().slice(0, 4));
  const cashAcc = search(db, 'account.account').find((a) => a.code === '101401');
  const revAcc = search(db, 'account.account').find((a) => a.code === '400000');

  const m1 = create(db, 'account.move', { move_type: 'entry', invoice_date: `${yr}-01-15`, line_ids: [{ account_id: cashAcc.id, debit: 1000 }, { account_id: revAcc.id, credit: 1000 }] });
  db = postMove(m1.db, m1.id);
  const m2 = create(db, 'account.move', { move_type: 'entry', invoice_date: `${yr}-02-15`, line_ids: [{ account_id: cashAcc.id, debit: 1500 }, { account_id: revAcc.id, credit: 1500 }] });
  db = postMove(m2.db, m2.id);

  await React.act(async () => store.commit(db));

  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  const props = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];

  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'cashflow', title: 'Cash Flow Statement' } })));

    const compSelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.value === 'none');
    assert.ok(compSelect, 'Comparison dropdown must exist');
    await React.act(async () => {
      props(compSelect).onChange({ target: { value: 'previous' } });
    });

    const foldAllBtn = find(host, (n) => n.tagName === 'BUTTON' && (n.textContent === 'Unfold All' || n.textContent === 'Collapse All'));
    assert.ok(foldAllBtn, 'Unfold All button rendered in cash flow comparison');
    assert.equal(foldAllBtn.textContent, 'Unfold All');

    const foldedRow = find(host, (n) => n.className?.includes('report-folded-row'));
    assert.ok(foldedRow, 'Folded rows are preserved with report-folded-row class');

    await React.act(async () => {
      props(foldAllBtn).onClick();
    });
    assert.equal(foldAllBtn.textContent, 'Collapse All');
    const unfoldedRow = find(host, (n) => n.className === 'rep-detail');
    assert.ok(unfoldedRow, 'Rows are now unfolded with class rep-detail');

    await React.act(async () => {
      props(foldAllBtn).onClick();
    });
    assert.equal(foldAllBtn.textContent, 'Unfold All');
    const reFoldedRow = find(host, (n) => n.className?.includes('report-folded-row'));
    assert.ok(reFoldedRow, 'Rows are folded again with report-folded-row');
  } finally {
    await React.act(async () => root.unmount());
  }
});
