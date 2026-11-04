import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from './orm.js';
import { seed } from './seed.js';
import { accountId, isBalanced, postEntry } from './models/ledger.js';
import { payMove, postMove } from './models/accounting.js';
import { reversePayment } from './models/pay.js';
import { unrealizedExchange } from './models/closing.js';
import { cashFlow } from './models/reports.js';
import { confirmLoan, earlyRepayment } from './models/loans.js';
import { confirmAsset, disposeAsset, postDepreciation } from './models/assets.js';
import { createCompany } from './models/company.js';

// ---------------------------------------------------------------------------
// 1. Cash rounding sign
// ---------------------------------------------------------------------------
test('cash rounding sign and accounts on customer invoice, credit note, vendor bill and vendor refund', () => {
  let db = seed();
  const profitAcc = accountId(db, '450000');
  const lossAcc = accountId(db, '690000');

  const roundUp = create(db, 'account.cash.rounding', {
    name: '0.05 UP',
    rounding: 0.05,
    rounding_method: 'UP',
    strategy: 'add_invoice_line',
    profit_account_id: profitAcc,
    loss_account_id: lossAcc,
  });
  db = roundUp.db;

  const roundDown = create(db, 'account.cash.rounding', {
    name: '0.05 DOWN',
    rounding: 0.05,
    rounding_method: 'DOWN',
    strategy: 'add_invoice_line',
    profit_account_id: profitAcc,
    loss_account_id: lossAcc,
  });
  db = roundDown.db;

  const cases = [
    // [move_type, rounding, expectedAccCode, expectedDebit, expectedCredit, expectedCounterpartDebit, expectedCounterpartCredit]
    // 1. Customer invoice: 10.02 rounded UP to 10.05 -> Profit (Credit 0.03)
    ['out_invoice', roundUp.id, '450000', 0, 0.03, 10.05, 0],
    // 2. Customer invoice: 10.02 rounded DOWN to 10.00 -> Loss (Debit 0.02)
    ['out_invoice', roundDown.id, '690000', 0.02, 0, 10.00, 0],
    // 3. Customer credit note: 10.02 rounded UP to 10.05 -> Loss (Debit 0.03)
    ['out_refund', roundUp.id, '690000', 0.03, 0, 0, 10.05],
    // 4. Customer credit note: 10.02 rounded DOWN to 10.00 -> Profit (Credit 0.02)
    ['out_refund', roundDown.id, '450000', 0, 0.02, 0, 10.00],
    // 5. Vendor bill: 10.02 rounded UP to 10.05 -> Loss (Debit 0.03)
    ['in_invoice', roundUp.id, '690000', 0.03, 0, 0, 10.05],
    // 6. Vendor bill: 10.02 rounded DOWN to 10.00 -> Profit (Credit 0.02)
    ['in_invoice', roundDown.id, '450000', 0, 0.02, 0, 10.00],
    // 7. Vendor refund: 10.02 rounded UP to 10.05 -> Profit (Credit 0.03)
    ['in_refund', roundUp.id, '450000', 0, 0.03, 10.05, 0],
    // 8. Vendor refund: 10.02 rounded DOWN to 10.00 -> Loss (Debit 0.02)
    ['in_refund', roundDown.id, '690000', 0.02, 0, 10.00, 0],
  ];

  for (const [move_type, roundingId, expAccCode, expDebit, expCredit, expCpDebit, expCpCredit] of cases) {
    const inv = create(db, 'account.move', {
      move_type,
      partner_id: 1,
      invoice_cash_rounding_id: roundingId,
      invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 10.02, tax: 0 }],
    });
    db = postMove(inv.db, inv.id);
    const posted = read(db, 'account.move', inv.id);
    assert.equal(posted.state, 'posted', `${move_type} must post successfully`);
    assert.ok(isBalanced(posted.line_ids), `${move_type} entry must be balanced`);

    const targetAccId = accountId(db, expAccCode);
    const roundLine = posted.line_ids.find((l) => l.name === 'Cash Rounding');
    assert.ok(roundLine, `${move_type} must have a Cash Rounding line`);
    assert.equal(roundLine.account_id, targetAccId, `${move_type} rounding account should be ${expAccCode}`);
    assert.equal(roundLine.debit, expDebit, `${move_type} rounding debit`);
    assert.equal(roundLine.credit, expCredit, `${move_type} rounding credit`);

    const counterpartCode = ['out_invoice', 'out_refund'].includes(move_type) ? '121000' : '211000';
    const cpLine = posted.line_ids.find((l) => l.account_id === accountId(db, counterpartCode));
    assert.ok(cpLine, `${move_type} must have counterpart line`);
    assert.equal(cpLine.debit, expCpDebit, `${move_type} counterpart debit`);
    assert.equal(cpLine.credit, expCpCredit, `${move_type} counterpart credit`);
  }
});

// ---------------------------------------------------------------------------
// 2. Unrealized currency revaluation counts reversed payments
// ---------------------------------------------------------------------------
test('unrealized currency revaluation excludes reversed payments based on revaluation date', () => {
  let db = seed();
  const fx = create(db, 'res.currency', {
    name: 'FX',
    rate_ids: [
      { date: '2026-01-01', rate: 2 },
      { date: '2026-02-01', rate: 1 },
    ],
  });
  db = fx.db;
  const fxId = fx.id;

  // Invoice for 100 FX dated 2026-01-01
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    currency_id: fxId,
    invoice_date: '2026-01-01',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);

  // Pay 40 EUR on 2026-01-10
  db = payMove(db, inv.id, 40, '2026-01-10');
  const paymentRecord = (db.records['account.payment'] ?? []).find((p) => p.invoice_id === inv.id && p.state === 'posted');
  assert.ok(paymentRecord, 'Posted payment must exist');

  // Reverse payment on 2026-01-20
  db = reversePayment(db, paymentRecord, '2026-01-20');

  // 1. Revaluation dated BEFORE payment (2026-01-05): residual is full 100
  const rowsBefore = unrealizedExchange(db, '2026-01-05');
  const rowBefore = rowsBefore.find((r) => r.invoice_id === inv.id);
  assert.ok(rowBefore, 'Invoice must be found in unrealized exchange before payment');
  assert.equal(rowBefore.residual, 100, 'Residual before payment must be 100');

  // 2. Revaluation dated BETWEEN payment and reversal (2026-01-15): residual is 60 (100 - 40)
  const rowsBetween = unrealizedExchange(db, '2026-01-15');
  const rowBetween = rowsBetween.find((r) => r.invoice_id === inv.id);
  assert.ok(rowBetween, 'Invoice must be found in unrealized exchange between payment and reversal');
  assert.equal(rowBetween.residual, 60, 'Residual between payment and reversal must be 60');

  // 3. Revaluation dated AFTER reversal (2026-01-25): residual is back to 100
  const rowsAfter = unrealizedExchange(db, '2026-01-25');
  const rowAfter = rowsAfter.find((r) => r.invoice_id === inv.id);
  assert.ok(rowAfter, 'Invoice must be found in unrealized exchange after reversal');
  assert.equal(rowAfter.residual, 100, 'Residual after reversal must be 100, not subtracting reversed payment');
});

// ---------------------------------------------------------------------------
// 3. Cash flow statement classification
// ---------------------------------------------------------------------------
test('cash flow statement classifies loan proceeds and repayment as financing, asset purchase as investing, and customer receipt as operating', () => {
  let db = seed();
  // Ensure bank has opening balance or deposit
  db = postEntry(db, {
    journal: 'MISC',
    date: '2026-01-01',
    ref: 'Initial capital',
    lines: [{ account: '101401', debit: 50000 }, { account: '301000', credit: 50000 }],
  }).db;

  // 1. Loan proceeds: receive loan of 10000 on 2026-01-05
  const loan = create(db, 'account.loan', {
    name: 'Bank Term Loan',
    amount: 10000,
    start_date: '2026-01-05',
    duration: 12,
    rate: 0.05,
    state: 'draft',
  });
  db = confirmLoan(loan.db, read(loan.db, 'account.loan', loan.id));

  // 2. Loan repayment: early repayment of 2000 on 2026-01-10
  db = earlyRepayment(db, read(db, 'account.loan', loan.id), { date: '2026-01-10', amount: 2000 });

  // 3. Asset purchase: 5000 on 2026-01-15
  db = postEntry(db, {
    journal: 'MISC',
    date: '2026-01-15',
    ref: 'Asset purchase',
    lines: [{ account: '151000', debit: 5000 }, { account: '101401', credit: 5000 }],
  }).db;

  // 4. Ordinary customer invoice and receipt: 1000 on 2026-01-20
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-01-18',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 1000, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);
  db = payMove(db, inv.id, 1000, '2026-01-20');

  // Verify cash flow for the period 2026-01-02 to 2026-01-31 (excluding initial capital)
  const cf = cashFlow(db, { from: '2026-01-02', to: '2026-01-31' });

  // Operating should only include customer receipt (+1000)
  assert.equal(cf.operating, 1000, 'Operating cash flow must only include customer receipt');
  // Investing should include asset purchase (-5000)
  assert.equal(cf.investing, -5000, 'Investing cash flow must include asset purchase');
  // Financing should include loan proceeds (+10000) and repayment (-2000) = +8000
  assert.equal(cf.financing, 8000, 'Financing cash flow must include loan proceeds and repayments');
});

// ---------------------------------------------------------------------------
// 4. Assets post without company
// ---------------------------------------------------------------------------
test('assets post with company and validate journal and accounts across two companies', () => {
  let db = seed();
  // Create second company
  const co2 = createCompany(db, { name: 'Subsidiary Corp' });
  db = co2.db;
  const co2Id = co2.id;

  // Assets in Company 1
  const asset1 = create(db, 'account.asset', {
    name: 'Co1 Equipment',
    original_value: 12000,
    salvage_value: 0,
    acquisition_date: '2026-01-01',
    method: 'linear',
    method_number: 3,
    method_period: '12',
    company_id: 1,
    state: 'draft',
  });
  db = confirmAsset(asset1.db, read(asset1.db, 'account.asset', asset1.id));
  db = postDepreciation(db, read(db, 'account.asset', asset1.id), '2026-12-31');
  const a1 = read(db, 'account.asset', asset1.id);
  const m1 = read(db, 'account.move', a1.depreciation_ids[0].move_id);
  assert.equal(m1.company_id, 1, 'Co1 depreciation entry must belong to company 1');

  // Assets in Company 2
  const asset2 = create(db, 'account.asset', {
    name: 'Co2 Van',
    original_value: 24000,
    salvage_value: 0,
    acquisition_date: '2026-01-01',
    method: 'linear',
    method_number: 2,
    method_period: '12',
    company_id: co2Id,
    state: 'draft',
  });
  db = confirmAsset(asset2.db, read(asset2.db, 'account.asset', asset2.id));
  db = postDepreciation(db, read(db, 'account.asset', asset2.id), '2026-12-31');
  const a2 = read(db, 'account.asset', asset2.id);
  const m2 = read(db, 'account.move', a2.depreciation_ids[0].move_id);
  assert.equal(m2.company_id, co2Id, 'Co2 depreciation entry must belong to company 2');

  db = disposeAsset(db, read(db, 'account.asset', asset1.id), { date: '2027-12-31', saleValue: 1000 });
  const disp1 = search(db, 'account.move').find((m) => m.ref === 'Co1 Equipment disposal');
  assert.equal(disp1.company_id, 1, 'Co1 disposal move must belong to company 1');
  assert.ok(isBalanced(disp1.line_ids));

  // Dispose Co2 asset and check company_id
  db = disposeAsset(db, read(db, 'account.asset', asset2.id), { date: '2027-12-31', saleValue: 5000 });
  const dispMove = search(db, 'account.move').find((m) => m.ref === 'Co2 Van disposal');
  assert.ok(dispMove, 'Disposal move must exist');
  assert.equal(dispMove.company_id, co2Id, 'Co2 disposal move must belong to company 2');
  assert.ok(isBalanced(dispMove.line_ids));

  // Validation: Asset in Co2 with journal or accounts belonging to Co1 must be rejected if mismatched
  // Create a journal strictly for Co1
  const co1Journal = create(db, 'account.journal', {
    name: 'Co1 Specific Journal',
    code: 'JCO1',
    type: 'general',
    company_id: 1,
  });
  db = co1Journal.db;

  assert.throws(
    () => create(db, 'account.asset', {
      name: 'Cross-company Asset',
      original_value: 10000,
      salvage_value: 0,
      acquisition_date: '2026-01-01',
      method: 'linear',
      method_number: 2,
      method_period: '12',
      company_id: co2Id,
      journal_id: co1Journal.id,
      state: 'draft',
    }),
    /company/i,
    'Asset creation must reject journal from another company'
  );

  assert.throws(
    () => confirmAsset(db, {
      id: 999,
      name: 'Direct mismatched asset',
      original_value: 10000,
      salvage_value: 0,
      acquisition_date: '2026-01-01',
      method: 'linear',
      method_number: 2,
      method_period: '12',
      company_id: co2Id,
      journal_id: co1Journal.id,
      state: 'draft',
    }),
    /company/i,
    'Asset confirmation must reject journal from another company'
  );
});
