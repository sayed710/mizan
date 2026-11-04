import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, write } from './orm.js';
import { seed } from './seed.js';
import { postMove } from './models/accounting.js';
import { accountId } from './models/ledger.js';
import { confirmAsset, depreciationReport, disposeAsset, modifyAsset, pauseAsset, postDepreciation, resumeAsset } from './models/assets.js';
import { confirmLoan, postDueLines, earlyRepayment } from './models/loans.js';

test('asset disposal rejects a sale invoice dated after disposal', () => {
  const created = create(seed(), 'account.asset', { name: 'Asset', acquisition_date: '2026-01-01', original_value: 1000, salvage_value: 0, method_number: 5, method_period: '12' });
  let db = confirmAsset(created.db, read(created.db, 'account.asset', created.id));
  const invoice = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_date: '2027-12-31', invoice_line_ids: [{ qty: 1, price_unit: 700, tax: 0, account_id: accountId(db, '101401') }] });
  db = postMove(invoice.db, invoice.id);
  assert.throws(() => disposeAsset(db, read(db, 'account.asset', created.id), { date: '2027-01-01', invoiceId: invoice.id }), /cannot precede the sale invoice date/);
});

test('bill asset retains and clears the booked fixed asset account', () => {
  let db = seed();
  const bookedAccount = accountId(db, '151000');
  const model = create(db, 'account.asset.model', { name: 'Other account', account_asset_id: accountId(db, '101401'), method_number: 5, method_period: '12' });
  db = write(model.db, 'account.account', bookedAccount, { asset_model_id: model.id });
  const bill = create(db, 'account.move', { move_type: 'in_invoice', partner_id: 2, invoice_date: '2026-01-01', invoice_line_ids: [{ name: 'Machine', account_id: bookedAccount, qty: 1, price_unit: 500, tax: 0 }] });
  db = postMove(bill.db, bill.id);
  const asset = db.records['account.asset'].find((a) => a.bill_id === bill.id);
  assert.equal(asset.account_asset_id, bookedAccount);
  db = confirmAsset(db, asset);
  db = disposeAsset(db, read(db, 'account.asset', asset.id), { date: '2026-01-02' });
  const disposal = db.records['account.move'].find((m) => m.ref === 'Machine disposal');
  assert.equal(disposal.line_ids.find((l) => l.account_id === bookedAccount).credit, 500);
});

test('depreciation report filters company rows and totals', () => {
  let db = seed();
  for (const [name, company_id, original_value] of [['One', 1, 100], ['Two', 2, 900]]) db = create(db, 'account.asset', { name, company_id, original_value, acquisition_date: '2026-01-01', state: 'open' }).db;
  const result = depreciationReport(db, { from: '2026-01-01', to: '2026-12-31' }, '1');
  assert.ok(result.rows.some((r) => r.a.name === 'One'));
  assert.ok(!result.rows.some((r) => r.a.name === 'Two'));
  assert.equal(result.totals.original, result.rows.reduce((s, r) => s + r.original, 0));
  assert.equal(result.totals.original, 100);
});

test('loan posting uses explicit company accounts and rejects missing configuration', () => {
  let db = seed();
  const fields = { journal_id: db.records['account.journal'].find((j) => j.code === 'MISC').id, bank_account_id: accountId(db, '101501'), principal_account_id: accountId(db, '211000'), interest_account_id: accountId(db, '600000') };
  const loan = create(db, 'account.loan', { name: 'Configured', amount: 1200, start_date: '2026-01-01', duration: 12, interest_rate: 6, ...fields });
  assert.throws(() => confirmLoan(loan.db, { ...read(loan.db, 'account.loan', loan.id), bank_account_id: null }), /bank account/);
  db = confirmLoan(loan.db, read(loan.db, 'account.loan', loan.id));
  let record = read(db, 'account.loan', loan.id);
  assert.throws(() => postDueLines(db, { ...record, interest_account_id: null }, '2026-02-28'), /interest expense account/);
  assert.throws(() => earlyRepayment(db, { ...record, principal_account_id: null }, { date: '2026-02-01', amount: 20 }), /principal liability account/);
  const other = create(db, 'res.company', { name: 'Other company' });
  const foreign = create(other.db, 'account.account', { name: 'Foreign bank', code: 'FOREIGN', account_type: 'asset_cash', company_id: other.id });
  assert.throws(() => postDueLines(foreign.db, { ...record, bank_account_id: foreign.id }, '2026-02-28'), /another company/);
  const receipt = read(db, 'account.move', record.receipt_move_id);
  assert.equal(receipt.journal_id, fields.journal_id);
  assert.equal(receipt.line_ids.find((l) => l.debit).account_id, fields.bank_account_id);
  db = postDueLines(db, record, '2026-02-28');
  record = read(db, 'account.loan', loan.id);
  const payment = read(db, 'account.move', record.line_ids[0].move_id);
  assert.ok(payment.line_ids.some((l) => l.account_id === fields.principal_account_id));
  assert.ok(payment.line_ids.some((l) => l.account_id === fields.interest_account_id));
  db = earlyRepayment(db, record, { date: '2026-03-01', amount: 20 });
  assert.equal(read(db, 'account.move', read(db, 'account.loan', loan.id).early_moves[0].move_id).journal_id, fields.journal_id);
});

test('depreciation report excludes later asset value adjustments', () => {
  const made = create(seed(), 'account.asset', { name: 'Revalued', acquisition_date: '2026-01-01', original_value: 1000, salvage_value: 0, method_number: 5, method_period: '12', account_asset_id: accountId(seed(), '151000') });
  let db = confirmAsset(made.db, read(made.db, 'account.asset', made.id));
  db = modifyAsset(db, read(db, 'account.asset', made.id), { date: '2027-01-01', valueChange: 500, accountId: accountId(db, '301000') });
  const report = (to) => depreciationReport(db, { to }, '1').rows.find((row) => row.a.id === made.id);
  assert.equal(report('2026-12-31').original, 1000);
  assert.equal(report('2026-12-31').book, 800);
  assert.equal(report('2027-01-01').original, 1500);
});

test('resume shifts unposted depreciation past the paused interval', () => {
  const made = create(seed(), 'account.asset', { name: 'Paused', acquisition_date: '2026-01-01', original_value: 1200, salvage_value: 0, method_number: 3, method_period: '1' });
  let db = confirmAsset(made.db, read(made.db, 'account.asset', made.id));
  db = pauseAsset(db, read(db, 'account.asset', made.id), '2026-01-15');
  db = resumeAsset(db, read(db, 'account.asset', made.id), '2026-03-15');
  let asset = read(db, 'account.asset', made.id);
  assert.ok(asset.depreciation_ids[0].date > '2026-03-15');
  db = postDepreciation(db, asset, '2026-03-15');
  asset = read(db, 'account.asset', made.id);
  assert.ok(asset.depreciation_ids.every((line) => !line.posted));
  assert.equal(asset.depreciation_ids.reduce((sum, line) => sum + line.amount, 0), 1200);
});
