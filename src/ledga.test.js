import test from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { balanceSheet, profitAndLoss } from './models/ledger.js';
import { agedBalance, agedReportDate } from './models/finance.js';
import { partnerLedger, customerStatement, trialBalance, cashFlow, defaultCashFlowActivity } from './models/reports.js';

test('balance sheet includes non-current accounts', () => {
  const db = seed();
  const accounts = db.records['account.account'];
  const asset = { ...accounts[0], id: 9001, account_type: 'asset_non_current' };
  const liability = { ...accounts[0], id: 9002, account_type: 'liability_non_current' };
  const move = { id: 9001, state: 'posted', date: '2026-01-01', line_ids: [{ account_id: asset.id, debit: 100 }, { account_id: liability.id, credit: 100 }] };
  const fixture = { ...db, records: { ...db.records, 'account.account': [...accounts, asset, liability], 'account.move': [...db.records['account.move'], move] } };
  const sheet = balanceSheet(fixture, '2026-01-01');
  assert.ok(sheet.assets.some((row) => row.account.id === asset.id));
  assert.ok(sheet.liabilities.some((row) => row.account.id === liability.id));
});

test('ageing uses accounting date rather than invoice date', () => {
  const db = seed();
  const account = db.records['account.account'].find((a) => a.account_type === 'asset_receivable');
  const move = { id: 9001, state: 'posted', move_type: 'out_invoice', date: '2026-11-20', invoice_date: '2026-10-15', invoice_date_due: '2026-11-14', partner_id: 9999, amount_total: 100, line_ids: [{ account_id: account.id, debit: 100 }] };
  const fixture = { ...db, records: { ...db.records, 'account.move': [...db.records['account.move'], move] } };
  assert.equal(agedBalance(fixture, 'receivable', '2026-11-10').rows.some((row) => row.partner_id === 9999), false);
  assert.equal(agedBalance(fixture, 'receivable', '2026-11-21').rows.find((row) => row.partner_id === 9999).total, 100);
});

test('partner ledger and customer statement include archived receivable accounts', () => {
  const db = seed();
  const account = { ...db.records['account.account'].find((a) => a.account_type === 'asset_receivable'), id: 9001, active: false };
  const move = { id: 9001, state: 'posted', date: '2026-01-01', company_id: 1, line_ids: [{ account_id: account.id, partner_id: 9999, debit: 100 }] };
  const fixture = { ...db, records: { ...db.records, 'account.account': [...db.records['account.account'], account], 'account.move': [...db.records['account.move'], move] } };
  assert.equal(partnerLedger(fixture, { to: '2026-01-01' }).find((row) => row.partner_id === 9999).end, 100);
  assert.equal(customerStatement(fixture, 9999, { to: '2026-01-01', company_id: 1 }).closing, 100);
});

test('aged report uses the earlier of the period end and today', () => {
  assert.equal(agedReportDate('9999-12-31', '2026-11-04'), '2026-11-04');
  assert.equal(agedReportDate('2026-11-30', '2026-11-04'), '2026-11-04');
  assert.equal(agedReportDate('2026-10-31', '2026-11-04'), '2026-10-31');
});

test('multi-company ledger reports translate booked amounts and cash flow', () => {
  const db = seed();
  const currency = db.records['res.currency'].find((c) => c.id === db.records['res.company'][0].currency_id);
  const foreign = { id: 9999, name: 'FX', rounding: 0.01, rate_ids: [{ date: '2000-01-01', rate: 10 / 11 }] };
  const accounts = db.records['account.account'];
  const recv = accounts.find((a) => a.account_type === 'asset_receivable');
  const cash = accounts.find((a) => a.account_type === 'asset_cash');
  const income = accounts.find((a) => a.account_type === 'income');
  const invoice = (id, company_id) => ({ id, company_id, state: 'posted', move_type: 'out_invoice', date: '2026-01-01', invoice_date: '2026-01-01', invoice_date_due: '2026-02-01', partner_id: 9999, amount_total: 100, line_ids: [{ account_id: recv.id, partner_id: 9999, debit: 100 }, { account_id: income.id, credit: 100 }] });
  const receipt = (id, company_id) => ({ id, company_id, state: 'posted', move_type: 'entry', date: '2026-01-01', line_ids: [{ account_id: cash.id, debit: 100 }, { account_id: income.id, credit: 100 }] });
  const fixture = { ...db, records: { ...db.records, 'res.currency': [...db.records['res.currency'].map((c) => c.id === currency.id ? { ...c, rate_ids: [{ date: '2000-01-01', rate: 1 }] } : c), foreign], 'res.company': [...db.records['res.company'], { id: 9999, name: 'Second', currency_id: foreign.id }], 'account.move': [invoice(9001, 1), invoice(9002, 9999), receipt(9003, 1), receipt(9004, 9999)], 'account.payment': [] } };
  assert.equal(trialBalance(fixture, {}).rows.find((r) => r.account.id === recv.id).debit, 210);
  assert.equal(partnerLedger(fixture, {}).find((r) => r.partner_id === 9999).end, 210);
  assert.equal(agedBalance(fixture, 'receivable', '2026-01-02').rows.find((r) => r.partner_id === 9999).total, 210);
  assert.equal(balanceSheet(fixture, '2026-01-02').totalAssets, 420);
  const flow = cashFlow(fixture, { from: '2026-01-01', to: '2026-01-01' });
  assert.equal(flow.net, 210);
  assert.equal(flow.operating + flow.investing + flow.financing + flow.unclassified, 210);
  const missing = { ...fixture, records: { ...fixture.records, 'res.company': fixture.records['res.company'].map((c) => c.id === 9999 ? { ...c, currency_id: null } : c) } };
  assert.throws(() => trialBalance(missing, {}), /company.*currency/i);
});

test('new account types appear in their balance sheet sections and preserve the equation', () => {
  const db = seed();
  const types = ['asset_non_current', 'asset_prepayments', 'liability_non_current', 'liability_credit_card', 'equity_unaffected', 'off_balance'];
  const accounts = types.map((type, i) => ({ id: 9000 + i, code: String(9000 + i), name: type, account_type: type }));
  const amounts = [100, 50, -40, -30, -80, 0];
  const lines = accounts.map((account, i) => ({ account_id: account.id, debit: Math.max(0, amounts[i]), credit: Math.max(0, -amounts[i]) }));
  lines.push({ account_id: accounts[5].id, debit: 25, credit: 0 }, { account_id: accounts[5].id, debit: 0, credit: 25 });
  const fixture = { ...db, records: { ...db.records, 'account.account': [...db.records['account.account'], ...accounts], 'account.move': [{ id: 9000, state: 'posted', date: '2026-01-01', line_ids: lines }] } };
  const sheet = balanceSheet(fixture, '2026-01-01');
  assert.deepEqual(sheet.assets.map((r) => r.account.account_type), types.slice(0, 2));
  assert.deepEqual(sheet.liabilities.map((r) => r.account.account_type), types.slice(2, 4));
  assert.equal(sheet.equity[0].account.account_type, 'equity_unaffected');
  assert.equal(sheet.totalAssets, sheet.totalLiabilities + sheet.totalEquity);
  assert.equal(profitAndLoss(fixture, { to: '2026-01-01' }).net, 0);
  assert.equal(trialBalance(fixture, {}).rows.find((r) => r.account.id === accounts[5].id).debit, 25);
  assert.deepEqual(types.map(defaultCashFlowActivity), ['investing', 'operating', 'financing', 'operating', 'financing', 'unclassified']);
});
