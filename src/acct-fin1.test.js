import test from 'node:test';
import './models/index.js';
import assert from 'node:assert/strict';
import * as reports from './models/reports.js';
import { toggleReportFold, toggleAllReportFolds, reportPrintFooters } from './views/reportFold.js';
import { create } from './orm.js';
import { seed } from './seed.js';
import { accountId } from './models/ledger.js';
import { postMove } from './models/accounting.js';
import { documentCompany } from './models/company.js';

test('untagged accounts default by type and explicit tags override', () => {
  const db = { records: { 'account.account.tag': [{ id: 1, cash_flow_activity: 'financing' }] } };
  for (const account_type of ['income', 'income_other', 'expense', 'expense_depreciation', 'expense_direct_cost', 'asset_receivable', 'liability_payable']) assert.equal(reports.accountCashFlowActivity(db, { account_type }), 'operating');
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
