import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, unlink, write } from './orm.js';
import { seed } from './seed.js';
import { createCompanyWithDefaultInvoiceJournals } from './test-support/accounting-company.js';
import { postMove, payMove } from './models/accounting.js';
import { postPayment, reversePayment } from './models/pay.js';
import { agedBalance } from './models/finance.js';
import { revalueForeignBalances, unrealizedExchange, closeFiscalYear } from './models/closing.js';
import { accountId, isBalanced, postEntry } from './models/ledger.js';
import { secureEntries, checkInalterability, computeMoveHash } from './models/hash_chain.js';
import { reconcileWith } from './models/bank.js';
import { postDepreciation, disposeAsset } from './models/assets.js';
import { postDueEntries } from './models/deferred.js';
import { confirmLoan, postDueLines } from './models/loans.js';

// ============================================================================
// DEFECT & CROSS-COMPANY PARTNER BANK TESTS
// ============================================================================

test('Defect: Cross-company partner bank on move or payment is rejected on create and write', () => {
  let db = seed();
  const c2Res = createCompanyWithDefaultInvoiceJournals(db, { name: 'Company Two' });
  db = c2Res.db;
  const c2Id = c2Res.id;

  const c2PartnerBank = create(db, 'res.partner.bank', {
    partner_id: 1,
    account_number: 'C2-IBAN-DEFECT-999',
    company_id: c2Id,
    allow_out_payment: true,
  });
  db = c2PartnerBank.db;

  // 1. Bill in Company 1 create rejecting Company 2 partner bank
  assert.throws(
    () => {
      create(db, 'account.move', {
        move_type: 'in_invoice',
        company_id: 1,
        partner_id: 1,
        partner_bank_id: c2PartnerBank.id,
        invoice_date: '2026-03-01',
        invoice_line_ids: [{ name: 'Expense Item', qty: 1, price_unit: 500 }],
      });
    },
    /select a record shared with or belonging to this company/i,
    'Expected cross-company partner bank on vendor bill create to be rejected'
  );

  // 2. Customer invoice in Company 1 create rejecting Company 2 partner bank
  assert.throws(
    () => {
      create(db, 'account.move', {
        move_type: 'out_invoice',
        company_id: 1,
        partner_id: 1,
        partner_bank_id: c2PartnerBank.id,
        invoice_date: '2026-03-01',
        invoice_line_ids: [{ name: 'Sale Item', qty: 1, price_unit: 500 }],
      });
    },
    /select a record shared with or belonging to this company/i,
    'Expected cross-company partner bank on customer invoice create to be rejected'
  );

  // 3. Bill in Company 1 write rejecting Company 2 partner bank
  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    company_id: 1,
    partner_id: 1,
    invoice_date: '2026-03-01',
    invoice_line_ids: [{ name: 'Expense Item', qty: 1, price_unit: 500 }],
  });
  assert.throws(
    () => {
      write(bill.db, 'account.move', bill.id, { partner_bank_id: c2PartnerBank.id });
    },
    /select a record shared with or belonging to this company/i,
    'Expected cross-company partner bank on vendor bill write to be rejected'
  );

  // 4. Payment in Company 1 create rejecting Company 2 partner bank
  assert.throws(
    () => {
      create(db, 'account.payment', {
        company_id: 1,
        partner_id: 1,
        partner_bank_id: c2PartnerBank.id,
        amount: 250,
        payment_type: 'outbound',
        partner_type: 'supplier',
      });
    },
    /select a record shared with or belonging to this company/i,
    'Expected cross-company partner bank on payment create to be rejected'
  );

  // 5. Payment in Company 1 write rejecting Company 2 partner bank
  const pay = create(db, 'account.payment', {
    company_id: 1,
    partner_id: 1,
    amount: 250,
    payment_type: 'outbound',
    partner_type: 'supplier',
  });
  assert.throws(
    () => {
      write(pay.db, 'account.payment', pay.id, { partner_bank_id: c2PartnerBank.id });
    },
    /select a record shared with or belonging to this company/i,
    'Expected cross-company partner bank on payment write to be rejected'
  );
});

test('Cross-company partner bank: a bank account without a company stays allowed', () => {
  let db = seed();
  const c2Res = createCompanyWithDefaultInvoiceJournals(db, { name: 'Company Two' });
  db = c2Res.db;
  const c2Id = c2Res.id;

  // Bank account without a company (shared master data)
  const sharedBank = create(db, 'res.partner.bank', {
    partner_id: 1,
    account_number: 'SHARED-IBAN-100',
    allow_out_payment: true,
  });
  db = sharedBank.db;
  assert.equal(read(db, 'res.partner.bank', sharedBank.id).company_id, undefined, 'Shared bank account has no company_id');

  // Allowed on Company 1 bill
  const c1Bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    company_id: 1,
    partner_id: 1,
    partner_bank_id: sharedBank.id,
    invoice_date: '2026-03-01',
    invoice_line_ids: [{ name: 'Hosting', qty: 1, price_unit: 100 }],
  });
  const postedC1 = postMove(c1Bill.db, c1Bill.id);
  const readC1 = read(postedC1, 'account.move', c1Bill.id);
  assert.equal(readC1.state, 'posted');
  assert.equal(readC1.partner_bank_id, sharedBank.id);

  // Allowed on Company 1 payment
  const c1Pay = create(postedC1, 'account.payment', {
    company_id: 1,
    partner_id: 1,
    partner_bank_id: sharedBank.id,
    amount: 100,
    payment_type: 'outbound',
    partner_type: 'supplier',
  });
  const postedPay = postPayment(c1Pay.db, read(c1Pay.db, 'account.payment', c1Pay.id));
  assert.equal(read(postedPay, 'account.payment', c1Pay.id).state, 'posted');

  // Allowed on Company 2 bill as well
  const c2Bill = create(postedPay, 'account.move', {
    move_type: 'in_invoice',
    company_id: c2Id,
    partner_id: 1,
    partner_bank_id: sharedBank.id,
    invoice_date: '2026-03-01',
    invoice_line_ids: [{ name: 'C2 Service', qty: 1, price_unit: 150 }],
  });
  const postedC2 = postMove(c2Bill.db, c2Bill.id);
  assert.equal(read(postedC2, 'account.move', c2Bill.id).state, 'posted');
});

test('Cross-company partner bank: postMove and payment posting reject pre-existing foreign-company bank before writing', () => {
  let db = seed();
  const c2Res = createCompanyWithDefaultInvoiceJournals(db, { name: 'Company Two' });
  db = c2Res.db;
  const c2Id = c2Res.id;

  const c2PartnerBank = create(db, 'res.partner.bank', {
    partner_id: 1,
    account_number: 'C2-IBAN-LEGACY-888',
    company_id: c2Id,
    allow_out_payment: true,
  });
  db = c2PartnerBank.db;

  // 1. Pre-existing draft bill carrying foreign partner bank directly in DB records
  const validBill = create(db, 'account.move', {
    move_type: 'in_invoice',
    company_id: 1,
    partner_id: 1,
    invoice_date: '2026-03-01',
    invoice_line_ids: [{ name: 'Expense Item', qty: 1, price_unit: 500 }],
  });
  db = validBill.db;

  // Inject foreign-company bank directly to simulate pre-existing/corrupted state
  const injectedDb = {
    ...db,
    records: {
      ...db.records,
      'account.move': db.records['account.move'].map((m) =>
        m.id === validBill.id ? { ...m, partner_bank_id: c2PartnerBank.id } : m
      ),
    },
  };

  const recordsBeforePost = JSON.stringify(injectedDb.records['account.move']);
  assert.throws(
    () => postMove(injectedDb, validBill.id),
    /select a record shared with or belonging to this company/i,
    'Expected postMove on pre-existing foreign bank to reject before writing'
  );
  assert.equal(
    JSON.stringify(injectedDb.records['account.move']),
    recordsBeforePost,
    'Database records must remain untouched after postMove rejection'
  );

  // 2. Pre-existing draft payment carrying foreign partner bank
  const postedBillDb = postMove(db, validBill.id);
  const validPay = create(postedBillDb, 'account.payment', {
    company_id: 1,
    partner_id: 1,
    amount: 200,
    payment_type: 'outbound',
    partner_type: 'supplier',
  });
  const injectedPayDb = {
    ...validPay.db,
    records: {
      ...validPay.db.records,
      'account.payment': validPay.db.records['account.payment'].map((p) =>
        p.id === validPay.id ? { ...p, partner_bank_id: c2PartnerBank.id } : p
      ),
    },
  };

  const payRecordsBefore = JSON.stringify(injectedPayDb.records['account.payment']);
  assert.throws(
    () => postPayment(injectedPayDb, read(injectedPayDb, 'account.payment', validPay.id)),
    /select a record shared with or belonging to this company/i,
    'Expected postPayment on pre-existing foreign bank to reject before writing'
  );
  assert.equal(
    JSON.stringify(injectedPayDb.records['account.payment']),
    payRecordsBefore,
    'Payment records must remain untouched after postPayment rejection'
  );

  // 3. payMove with pre-existing payment carrying foreign partner bank
  assert.throws(
    () => payMove(injectedPayDb, validBill.id, 100, '2026-03-02', { paymentId: validPay.id }),
    /select a record shared with or belonging to this company/i,
    'Expected payMove with pre-existing foreign bank payment to reject before writing'
  );
});

// ============================================================================
// REGRESSION: ROUNDING PER DOCUMENT TYPE
// ============================================================================

test('Regression: Cash rounding on invoices, bills, credit notes and refunds (add_invoice_line)', () => {
  let baseDb = seed();
  const profitAcc = create(baseDb, 'account.account', { code: '799001', name: 'Cash Rounding Profit', account_type: 'income_other', company_id: 1 });
  let db = profitAcc.db;
  const lossAcc = create(db, 'account.account', { code: '699001', name: 'Cash Rounding Loss', account_type: 'expense_other', company_id: 1 });
  db = lossAcc.db;

  const roundHalfUp = create(db, 'account.cash.rounding', {
    name: 'Half-up 0.05',
    rounding: 0.05,
    rounding_method: 'HALF-UP',
    strategy: 'add_invoice_line',
    profit_account_id: profitAcc.id,
    loss_account_id: lossAcc.id,
    company_id: 1,
  });
  db = roundHalfUp.db;

  const roundUp = create(db, 'account.cash.rounding', {
    name: 'Up 0.05',
    rounding: 0.05,
    rounding_method: 'UP',
    strategy: 'add_invoice_line',
    profit_account_id: profitAcc.id,
    loss_account_id: lossAcc.id,
    company_id: 1,
  });
  db = roundUp.db;

  const roundDown = create(db, 'account.cash.rounding', {
    name: 'Down 0.05',
    rounding: 0.05,
    rounding_method: 'DOWN',
    strategy: 'add_invoice_line',
    profit_account_id: profitAcc.id,
    loss_account_id: lossAcc.id,
    company_id: 1,
  });
  db = roundDown.db;

  const moveTypes = ['out_invoice', 'in_invoice', 'out_refund', 'in_refund'];
  const roundings = [
    { name: 'half-up (up)', roundingId: roundHalfUp.id, price: 100.03 },
    { name: 'half-up (down)', roundingId: roundHalfUp.id, price: 100.02 },
    { name: 'up', roundingId: roundUp.id, price: 100.01 },
    { name: 'down', roundingId: roundDown.id, price: 100.04 },
  ];
  const companyMethods = ['round_per_line', 'round_globally'];

  for (const compMethod of companyMethods) {
    db = write(db, 'res.company', 1, { tax_calculation_rounding_method: compMethod });
    for (const moveType of moveTypes) {
      for (const rCfg of roundings) {
        const move = create(db, 'account.move', {
          move_type: moveType,
          partner_id: 1,
          invoice_date: '2026-03-01',
          invoice_cash_rounding_id: rCfg.roundingId,
          invoice_line_ids: [
            { name: 'Item 1', qty: 1, price_unit: rCfg.price, tax_ids: [1] },
            { name: 'Item 2', qty: 2, price_unit: 10.01, tax_ids: [1] },
          ],
        });
        const posted = postMove(move.db, move.id);
        const postedMove = read(posted, 'account.move', move.id);

        assert.equal(postedMove.state, 'posted', `${moveType} ${rCfg.name} ${compMethod} must post`);
        assert.ok(isBalanced(postedMove.line_ids), `${moveType} ${rCfg.name} ${compMethod} lines must balance in company currency`);

        for (const l of postedMove.line_ids) {
          const acc = read(posted, 'account.account', l.account_id);
          assert.equal(acc?.company_id ?? 1, 1, `Line account ${l.account_id} must belong to company 1`);
        }
      }
    }
  }
});

test('Regression: Cash rounding biggest_tax strategy per document type', () => {
  let db = seed();
  const profitAcc = create(db, 'account.account', { code: '799002', name: 'Cash Rounding Profit', account_type: 'income_other', company_id: 1 });
  db = profitAcc.db;
  const lossAcc = create(db, 'account.account', { code: '699002', name: 'Cash Rounding Loss', account_type: 'expense_other', company_id: 1 });
  db = lossAcc.db;

  const roundBiggestTax = create(db, 'account.cash.rounding', {
    name: 'Biggest Tax 0.05',
    rounding: 0.05,
    rounding_method: 'HALF-UP',
    strategy: 'biggest_tax',
    profit_account_id: profitAcc.id,
    loss_account_id: lossAcc.id,
    company_id: 1,
  });
  db = roundBiggestTax.db;

  const moveTypes = ['out_invoice', 'in_invoice', 'out_refund', 'in_refund'];
  for (const moveType of moveTypes) {
    const move = create(db, 'account.move', {
      move_type: moveType,
      partner_id: 1,
      invoice_date: '2026-03-01',
      invoice_cash_rounding_id: roundBiggestTax.id,
      invoice_line_ids: [{ name: 'Item 1', qty: 1, price_unit: 100.03, tax_ids: [1] }],
    });
    const posted = postMove(move.db, move.id);
    const postedMove = read(posted, 'account.move', move.id);
    assert.equal(postedMove.state, 'posted');
    assert.ok(isBalanced(postedMove.line_ids), `${moveType} biggest_tax must balance`);
  }
});

test('Regression: Foreign currency cash rounding per document type', () => {
  let db = seed();
  const profitAcc = create(db, 'account.account', { code: '799003', name: 'Cash Rounding Profit', account_type: 'income_other', company_id: 1 });
  db = profitAcc.db;
  const lossAcc = create(db, 'account.account', { code: '699003', name: 'Cash Rounding Loss', account_type: 'expense_other', company_id: 1 });
  db = lossAcc.db;

  const roundHalfUp = create(db, 'account.cash.rounding', {
    name: 'Half-up 0.05',
    rounding: 0.05,
    rounding_method: 'HALF-UP',
    strategy: 'add_invoice_line',
    profit_account_id: profitAcc.id,
    loss_account_id: lossAcc.id,
    company_id: 1,
  });
  db = roundHalfUp.db;

  const currency = create(db, 'res.currency', {
    name: 'CAD',
    rate_ids: [{ date: '2026-01-01', rate: 1.4567 }],
  });
  db = currency.db;

  const moveTypes = ['out_invoice', 'in_invoice', 'out_refund', 'in_refund'];
  const testPrices = [100.03, 100.02, 100.04, 100.01];

  for (const moveType of moveTypes) {
    for (const price of testPrices) {
      const move = create(db, 'account.move', {
        move_type: moveType,
        partner_id: 1,
        currency_id: currency.id,
        invoice_date: '2026-01-01',
        invoice_cash_rounding_id: roundHalfUp.id,
        invoice_line_ids: [{ name: 'Item', qty: 1, price_unit: price, tax_ids: [1] }],
      });
      const posted = postMove(move.db, move.id);
      const postedMove = read(posted, 'account.move', move.id);
      assert.ok(isBalanced(postedMove.line_ids), `Foreign ${moveType} price ${price} must balance in company currency`);
    }
  }
});

// ============================================================================
// REGRESSION: TWO-COMPANY OWNERSHIP & CROSS-COMPANY SUBSTITUTIONS
// ============================================================================

test('Regression: Two-company ownership for depreciation, disposal, deferral and loans', () => {
  let db = seed();
  const c2Res = createCompanyWithDefaultInvoiceJournals(db, { name: 'Company Two' });
  db = c2Res.db;
  const c2Id = c2Res.id;

  const c2MiscJournal = create(db, 'account.journal', { name: 'C2 Misc', code: 'MISC2', type: 'general', company_id: c2Id });
  db = c2MiscJournal.db;
  const c2BankJournal = create(db, 'account.journal', { name: 'C2 Bank', code: 'BNK2', type: 'bank', company_id: c2Id });
  db = c2BankJournal.db;

  const c2AssetAcc = create(db, 'account.account', { code: '150000', name: 'C2 Asset', account_type: 'asset_fixed', company_id: c2Id });
  db = c2AssetAcc.db;
  const c2DeprAcc = create(db, 'account.account', { code: '159000', name: 'C2 Depr', account_type: 'asset_fixed', company_id: c2Id });
  db = c2DeprAcc.db;
  const c2ExpAcc = create(db, 'account.account', { code: '680000', name: 'C2 Depr Exp', account_type: 'expense', company_id: c2Id });
  db = c2ExpAcc.db;
  const c2GainAcc = create(db, 'account.account', { code: '750000', name: 'C2 Gain', account_type: 'income_other', company_id: c2Id });
  db = c2GainAcc.db;
  const c2LossAcc = create(db, 'account.account', { code: '650000', name: 'C2 Loss', account_type: 'expense_other', company_id: c2Id });
  db = c2LossAcc.db;
  const c2BankAcc = create(db, 'account.account', { code: '101000', name: 'C2 Bank', account_type: 'asset_cash', company_id: c2Id });
  db = c2BankAcc.db;
  const c2PrincipalAcc = create(db, 'account.account', { code: '260000', name: 'C2 Principal', account_type: 'liability_non_current', company_id: c2Id });
  db = c2PrincipalAcc.db;
  const c2InterestAcc = create(db, 'account.account', { code: '690000', name: 'C2 Interest', account_type: 'expense', company_id: c2Id });
  db = c2InterestAcc.db;
  const c2DefAcc = create(db, 'account.account', { code: '490000', name: 'C2 Deferred Rev', account_type: 'liability_current', company_id: c2Id });
  db = c2DefAcc.db;
  const c2RecAcc = create(db, 'account.account', { code: '700000', name: 'C2 Rev', account_type: 'income', company_id: c2Id });
  db = c2RecAcc.db;

  db = write(db, 'res.company', c2Id, {
    gain_account_id: c2GainAcc.id,
    loss_account_id: c2LossAcc.id,
  });

  // 1. Depreciation on Company 2
  const asset = create(db, 'account.asset', {
    name: 'C2 Machine',
    company_id: c2Id,
    journal_id: c2MiscJournal.id,
    original_value: 1200,
    salvage_value: 0,
    acquisition_date: '2026-01-01',
    method: 'linear',
    method_number: 12,
    method_period: '1',
    account_asset_id: c2AssetAcc.id,
    account_depreciation_id: c2DeprAcc.id,
    account_depreciation_expense_id: c2ExpAcc.id,
    state: 'open',
    depreciation_ids: [
      { date: '2026-01-31', amount: 100, posted: false, move_id: null },
      { date: '2026-02-28', amount: 100, posted: false, move_id: null },
    ],
  });
  db = asset.db;

  db = postDepreciation(db, read(db, 'account.asset', asset.id), '2026-01-31');
  const updatedAsset = read(db, 'account.asset', asset.id);
  const depMoveId = updatedAsset.depreciation_ids[0].move_id;
  assert.ok(depMoveId, 'Depreciation move created');
  const depMove = read(db, 'account.move', depMoveId);
  assert.equal(depMove.company_id, c2Id, 'Depreciation move must belong to Company 2');
  assert.equal(depMove.journal_id, c2MiscJournal.id, 'Depreciation move must use Company 2 journal');
  for (const l of depMove.line_ids) {
    const acc = read(db, 'account.account', l.account_id);
    assert.equal(acc.company_id, c2Id, 'Depreciation move line account must belong to Company 2');
  }

  // 2. Disposal on Company 2
  db = disposeAsset(db, updatedAsset, { date: '2026-02-15' });
  const dispMove = search(db, 'account.move').find((m) => m.ref === 'C2 Machine disposal');
  assert.ok(dispMove, 'Disposal move created');
  assert.equal(dispMove.company_id, c2Id, 'Disposal move must belong to Company 2');
  assert.equal(dispMove.journal_id, c2MiscJournal.id, 'Disposal move must use Company 2 journal');
  for (const l of dispMove.line_ids) {
    const acc = read(db, 'account.account', l.account_id);
    assert.equal(acc.company_id, c2Id, 'Disposal move line account must belong to Company 2');
  }

  // 3. Deferral on Company 2
  const deferral = create(db, 'account.deferral', {
    name: 'C2 Deferral',
    kind: 'revenue',
    company_id: c2Id,
    deferred_account_id: c2DefAcc.id,
    recognition_account_id: c2RecAcc.id,
    start_date: '2026-01-01',
    end_date: '2026-12-31',
    months: 12,
    amount: 1200,
    state: 'running',
    board: [
      { date: '2026-01-31', amount: 100, posted: false },
      { date: '2026-02-28', amount: 100, posted: false },
    ],
  });
  db = deferral.db;
  db = postDueEntries(db, read(db, 'account.deferral', deferral.id), '2026-01-31');
  const updatedDef = read(db, 'account.deferral', deferral.id);
  const defMoveId = updatedDef.board[0].move_id;
  assert.ok(defMoveId, 'Deferral move created');
  const defMove = read(db, 'account.move', defMoveId);
  assert.equal(defMove.company_id, c2Id, 'Deferral move must belong to Company 2');
  for (const l of defMove.line_ids) {
    const acc = read(db, 'account.account', l.account_id);
    assert.equal(acc.company_id, c2Id, 'Deferral move line account must belong to Company 2');
  }

  // 4. Loan on Company 2
  const loan = create(db, 'account.loan', {
    name: 'C2 Loan',
    company_id: c2Id,
    journal_id: c2BankJournal.id,
    bank_account_id: c2BankAcc.id,
    principal_account_id: c2PrincipalAcc.id,
    interest_account_id: c2InterestAcc.id,
    amount: 1200,
    duration: 6,
    interest_rate: 5,
    method: 'annuity',
    start_date: '2026-01-10',
  });
  db = loan.db;
  db = confirmLoan(db, read(db, 'account.loan', loan.id));
  const confirmedLoan = read(db, 'account.loan', loan.id);
  const loanReceiptMove = read(db, 'account.move', confirmedLoan.receipt_move_id);
  assert.equal(loanReceiptMove.company_id, c2Id, 'Loan receipt must belong to Company 2');
  assert.equal(loanReceiptMove.journal_id, c2BankJournal.id, 'Loan receipt must use Company 2 journal');
  for (const l of loanReceiptMove.line_ids) {
    const acc = read(db, 'account.account', l.account_id);
    assert.equal(acc.company_id, c2Id, 'Loan receipt line account must belong to Company 2');
  }

  db = postDueLines(db, confirmedLoan, '2026-02-28');
  const updatedLoan = read(db, 'account.loan', loan.id);
  const loanLineMove = read(db, 'account.move', updatedLoan.line_ids[0].move_id);
  assert.equal(loanLineMove.company_id, c2Id, 'Loan line move must belong to Company 2');
  assert.equal(loanLineMove.journal_id, c2BankJournal.id, 'Loan line move must use Company 2 journal');
  for (const l of loanLineMove.line_ids) {
    const acc = read(db, 'account.account', l.account_id);
    assert.equal(acc.company_id, c2Id, 'Loan line move line account must belong to Company 2');
  }
});

test('Regression: Cross-company substitutions for journal, account and tax', () => {
  let db = seed();
  const c2Res = createCompanyWithDefaultInvoiceJournals(db, { name: 'Company Two' });
  db = c2Res.db;
  const c2Id = c2Res.id;

  const c2Journal = create(db, 'account.journal', { name: 'C2 Sale', code: 'S2', type: 'sale', company_id: c2Id });
  db = c2Journal.db;
  const c2Acc = create(db, 'account.account', { code: '700000', name: 'C2 Revenue', account_type: 'income', company_id: c2Id });
  db = c2Acc.db;
  const c2Tax = create(db, 'account.tax', { name: 'C2 VAT', amount: 20, type_tax_use: 'sale', company_id: c2Id });
  db = c2Tax.db;

  // 1. Cross-company journal on invoice
  assert.throws(
    () => create(db, 'account.move', {
      move_type: 'out_invoice',
      company_id: 1,
      partner_id: 1,
      journal_id: c2Journal.id,
      invoice_date: '2026-03-01',
      invoice_line_ids: [{ name: 'Test', qty: 1, price_unit: 100 }],
    }),
    /select a record shared with or belonging to this company/i,
    'Cross-company journal on invoice must be rejected'
  );

  // 2. Cross-company account on invoice line
  const invAcc = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: 1,
    invoice_date: '2026-03-01',
    invoice_line_ids: [{ name: 'Test', qty: 1, price_unit: 100, account_id: c2Acc.id }],
  });
  assert.throws(
    () => postMove(invAcc.db, invAcc.id),
    /does not exist for the invoice company|belongs to another company/i,
    'Cross-company account on invoice line must be rejected'
  );

  // 3. Cross-company tax on invoice line
  const invTax = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: 1,
    invoice_date: '2026-03-01',
    invoice_line_ids: [{ name: 'Test', qty: 1, price_unit: 100, tax_ids: [c2Tax.id] }],
  });
  assert.throws(
    () => postMove(invTax.db, invTax.id),
    /Tax belongs to another company/i,
    'Cross-company tax on invoice line must be rejected'
  );
});

// ============================================================================
// REGRESSION: LOCKS PER ENTRY POINT
// ============================================================================

test('Regression: Locks apply through every entry point', () => {
  let db = seed();
  const lockDate = '2026-03-31';
  db = write(db, 'res.company', 1, { lock_date: lockDate });

  // 1. Manual entry
  assert.throws(
    () => postEntry(db, {
      journal: 'MISC',
      date: '2026-03-15',
      lines: [
        { account: 1, debit: 100 },
        { account: 2, credit: 100 },
      ],
    }),
    /locked/i,
    'Manual entry on locked date must be rejected'
  );

  // 2. Invoice
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-03-15',
    invoice_line_ids: [{ name: 'Item', qty: 1, price_unit: 100 }],
  });
  assert.throws(
    () => postMove(inv.db, inv.id),
    /locked/i,
    'Invoice on locked date must be rejected'
  );

  // 3. Payment
  const openInv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-04-15',
    invoice_line_ids: [{ name: 'Item', qty: 1, price_unit: 100 }],
  });
  const postedOpenInv = postMove(openInv.db, openInv.id);
  assert.throws(
    () => payMove(postedOpenInv, openInv.id, 100, '2026-03-15'),
    /locked/i,
    'Payment on locked date must be rejected'
  );

  // 4. Bank match
  const stLine = create(postedOpenInv, 'account.bank.statement.line', {
    payment_ref: 'Receipt',
    date: '2026-03-15',
    amount: 100,
    journal_id: search(db, 'account.journal').find((j) => j.type === 'bank').id,
    partner_id: 1,
    state: 'to_check',
  });
  assert.throws(
    () => reconcileWith(stLine.db, read(stLine.db, 'account.bank.statement.line', stLine.id), openInv.id),
    /locked/i,
    'Bank match on locked date must be rejected'
  );

  // 5. Asset depreciation
  const asset = create(postedOpenInv, 'account.asset', {
    name: 'Test Machine',
    company_id: 1,
    original_value: 1200,
    salvage_value: 0,
    acquisition_date: '2026-01-01',
    account_asset_id: search(db, 'account.account').find((a) => a.account_type === 'asset_fixed').id,
    account_depreciation_id: search(db, 'account.account').find((a) => a.code === '159000' || a.account_type === 'asset_fixed').id,
    account_depreciation_expense_id: search(db, 'account.account').find((a) => a.account_type === 'expense').id,
    state: 'open',
    depreciation_ids: [{ date: '2026-03-15', amount: 100, posted: false, move_id: null }],
  });
  assert.throws(
    () => postDepreciation(asset.db, read(asset.db, 'account.asset', asset.id), '2026-03-15'),
    /locked/i,
    'Asset depreciation on locked date must be rejected'
  );

  // 6. Deferral
  const deferral = create(postedOpenInv, 'account.deferral', {
    name: 'Test Deferral',
    kind: 'revenue',
    company_id: 1,
    deferred_account_id: search(db, 'account.account').find((a) => a.code === '490000' || a.account_type === 'liability_current').id,
    recognition_account_id: search(db, 'account.account').find((a) => a.account_type === 'income').id,
    start_date: '2026-01-01',
    end_date: '2026-12-31',
    months: 12,
    amount: 1200,
    state: 'running',
    board: [{ date: '2026-03-15', amount: 100, posted: false }],
  });
  assert.throws(
    () => postDueEntries(deferral.db, read(deferral.db, 'account.deferral', deferral.id), '2026-03-15'),
    /locked/i,
    'Deferral on locked date must be rejected'
  );

  // 7. Closing fiscal year
  const year = create(db, 'account.fiscal.year', {
    name: 'FY 2026',
    date_from: '2026-01-01',
    date_to: '2026-03-31',
    company_id: 1,
    state: 'open',
  });
  assert.throws(
    () => closeFiscalYear(year.db, year.id),
    /locked/i,
    'Closing fiscal year on locked date must be rejected'
  );
});

test('Regression: Asset disposal on locked date is rejected', () => {
  let db = seed();
  const lockDate = '2026-03-31';
  db = write(db, 'res.company', 1, { lock_date: lockDate });

  const asset = create(db, 'account.asset', {
    name: 'Disposal Machine',
    company_id: 1,
    original_value: 1200,
    salvage_value: 0,
    acquisition_date: '2026-01-01',
    account_asset_id: search(db, 'account.account').find((a) => a.account_type === 'asset_fixed').id,
    account_depreciation_id: search(db, 'account.account').find((a) => a.code === '159000' || a.account_type === 'asset_fixed').id,
    account_depreciation_expense_id: search(db, 'account.account').find((a) => a.account_type === 'expense').id,
    state: 'open',
    depreciation_ids: [{ date: '2026-04-15', amount: 100, posted: false, move_id: null }],
  });

  assert.throws(
    () => disposeAsset(asset.db, read(asset.db, 'account.asset', asset.id), { date: '2026-03-15' }),
    /locked/i,
    'Asset disposal on locked date must be rejected'
  );
});

// ============================================================================
// REGRESSION: THE REVALUATION CUTOFFS
// ============================================================================

test('Regression: Foreign currency customer invoice revaluations, partial payment, and reversal across cutoffs', () => {
  let db = seed();
  const gainAcc = create(db, 'account.account', { code: '758000', name: 'Realized FX Gain', account_type: 'income_other', company_id: 1 });
  db = gainAcc.db;
  const lossAcc = create(db, 'account.account', { code: '658000', name: 'Realized FX Loss', account_type: 'expense_other', company_id: 1 });
  db = lossAcc.db;

  db = write(db, 'res.company', 1, {
    income_currency_exchange_account_id: gainAcc.id,
    expense_currency_exchange_account_id: lossAcc.id,
  });

  const currency = create(db, 'res.currency', {
    name: 'USD',
    rate_ids: [
      { date: '2026-01-01', rate: 2.0 },
      { date: '2026-01-10', rate: 1.8 },
      { date: '2026-01-15', rate: 1.6 },
      { date: '2026-01-20', rate: 1.5 },
      { date: '2026-01-25', rate: 1.25 },
      { date: '2026-01-30', rate: 1.0 },
    ],
  });
  db = currency.db;

  // 1. Foreign customer invoice of 1000 USD on 2026-01-01 (booked: 500 EUR)
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    currency_id: currency.id,
    invoice_date: '2026-01-01',
    invoice_line_ids: [{ name: 'Consulting', qty: 1, price_unit: 1000, tax_ids: [] }],
  });
  db = postMove(inv.db, inv.id);
  const postedInv = read(db, 'account.move', inv.id);
  assert.equal(postedInv.state, 'posted');

  // Cutoff 1: 2026-01-10 (Before payment)
  const aged1 = agedBalance(db, 'receivable', '2026-01-10');
  const partnerAged1 = aged1.rows.find((r) => r.partner_id === 1);
  assert.equal(partnerAged1?.total, 500, 'Aged balance at Cutoff 1 must be booked company amount 500');

  const unrx1 = unrealizedExchange(db, '2026-01-10').find((r) => r.invoice_id === inv.id);
  assert.ok(unrx1, 'Unrealized row must exist at Cutoff 1');
  assert.equal(unrx1.residual, 1000);
  assert.equal(unrx1.booked, 500);
  assert.equal(unrx1.value, 555.56);
  assert.equal(unrx1.difference, 55.56);

  const revalDb1 = revalueForeignBalances(db, '2026-01-10');
  const revalEntry1 = search(revalDb1, 'account.move').find((m) => m.revaluation_date === '2026-01-10');
  assert.ok(revalEntry1, 'Revaluation entry exists at Cutoff 1');
  assert.ok(isBalanced(revalEntry1.line_ids), 'Revaluation entry 1 must balance');
  const reversalEntry1 = read(revalDb1, 'account.move', revalEntry1.reversal_move_id);
  assert.ok(reversalEntry1, 'Reversal entry 1 exists');
  assert.ok(isBalanced(reversalEntry1.line_ids), 'Reversal entry 1 must balance');
  assert.equal(reversalEntry1.invoice_date, '2026-01-11', 'Reversal on next day');

  const revalTwice1 = revalueForeignBalances(revalDb1, '2026-01-10');
  assert.equal(revalTwice1, revalDb1, 'Running revaluation twice at Cutoff 1 creates nothing new');

  // 2. Partial payment on 2026-01-15: pay 400 USD
  db = payMove(db, inv.id, 400, '2026-01-15');
  const paidInv = read(db, 'account.move', inv.id);
  assert.equal(paidInv.amount_paid, 400);
  const paymentRow = paidInv.payments[0];
  const paymentMove = read(db, 'account.move', paymentRow.move_id);
  assert.ok(paymentMove, 'Payment move must exist');
  assert.ok(isBalanced(paymentMove.line_ids), 'Payment move must be balanced');

  const gainLine = paymentMove.line_ids.find((l) => l.account_id === gainAcc.id);
  assert.ok(gainLine, 'Realized exchange difference must be booked to configured gain account');
  assert.equal(gainLine.credit, 50, 'Gain must be 50 EUR (250 - 200)');

  // Cutoff 2: 2026-01-20 (After partial payment, before reversal)
  const aged2 = agedBalance(db, 'receivable', '2026-01-20');
  const partnerAged2 = aged2.rows.find((r) => r.partner_id === 1);
  assert.equal(partnerAged2?.total, 300, 'Aged balance at Cutoff 2 must be booked residual 300 (500 - 200)');

  const unrx2 = unrealizedExchange(db, '2026-01-20').find((r) => r.invoice_id === inv.id);
  assert.ok(unrx2, 'Unrealized row must exist at Cutoff 2');
  assert.equal(unrx2.residual, 600);
  assert.equal(unrx2.booked, 300);
  assert.equal(unrx2.value, 400);
  assert.equal(unrx2.difference, 100);

  const revalDb2 = revalueForeignBalances(db, '2026-01-20');
  const revalEntry2 = search(revalDb2, 'account.move').find((m) => m.revaluation_date === '2026-01-20');
  assert.ok(revalEntry2, 'Revaluation entry exists at Cutoff 2');
  assert.ok(isBalanced(revalEntry2.line_ids), 'Revaluation entry 2 must balance');
  const reversalEntry2 = read(revalDb2, 'account.move', revalEntry2.reversal_move_id);
  assert.ok(reversalEntry2, 'Reversal entry 2 exists');
  assert.ok(isBalanced(reversalEntry2.line_ids), 'Reversal entry 2 must balance');
  assert.equal(reversalEntry2.invoice_date, '2026-01-21');

  const revalTwice2 = revalueForeignBalances(revalDb2, '2026-01-20');
  assert.equal(revalTwice2, revalDb2, 'Running revaluation twice at Cutoff 2 creates nothing new');

  // 3. Reverse payment on 2026-01-25
  const payment = search(db, 'account.payment').find((p) => p.invoice_id === inv.id && p.state === 'posted');
  db = reversePayment(db, payment, '2026-01-25');
  const reversedInv = read(db, 'account.move', inv.id);
  assert.equal(reversedInv.amount_paid, 0, 'Invoice amount_paid is 0 after reversal');

  // Cutoff 3: 2026-01-30 (After payment reversal)
  const aged3 = agedBalance(db, 'receivable', '2026-01-30');
  const partnerAged3 = aged3.rows.find((r) => r.partner_id === 1);
  assert.equal(partnerAged3?.total, 500, 'Aged balance at Cutoff 3 must be restored booked amount 500');

  const unrx3 = unrealizedExchange(db, '2026-01-30').find((r) => r.invoice_id === inv.id);
  assert.ok(unrx3, 'Unrealized row must exist at Cutoff 3');
  assert.equal(unrx3.residual, 1000);
  assert.equal(unrx3.booked, 500);
  assert.equal(unrx3.value, 1000);
  assert.equal(unrx3.difference, 500);

  const revalDb3 = revalueForeignBalances(db, '2026-01-30');
  const revalEntry3 = search(revalDb3, 'account.move').find((m) => m.revaluation_date === '2026-01-30');
  assert.ok(revalEntry3, 'Revaluation entry exists at Cutoff 3');
  assert.ok(isBalanced(revalEntry3.line_ids), 'Revaluation entry 3 must balance');
  const reversalEntry3 = read(revalDb3, 'account.move', revalEntry3.reversal_move_id);
  assert.ok(reversalEntry3, 'Reversal entry 3 exists');
  assert.ok(isBalanced(reversalEntry3.line_ids), 'Reversal entry 3 must balance');
  assert.equal(reversalEntry3.invoice_date, '2026-01-31');

  const revalTwice3 = revalueForeignBalances(revalDb3, '2026-01-30');
  assert.equal(revalTwice3, revalDb3, 'Running revaluation twice at Cutoff 3 creates nothing new');
});

test('Regression: Foreign vendor bill revaluations, partial payment, and reversal across cutoffs', () => {
  let db = seed();
  const gainAcc = create(db, 'account.account', { code: '758000', name: 'Realized FX Gain', account_type: 'income_other', company_id: 1 });
  db = gainAcc.db;
  const lossAcc = create(db, 'account.account', { code: '658000', name: 'Realized FX Loss', account_type: 'expense_other', company_id: 1 });
  db = lossAcc.db;

  db = write(db, 'res.company', 1, {
    income_currency_exchange_account_id: gainAcc.id,
    expense_currency_exchange_account_id: lossAcc.id,
  });

  const currency = create(db, 'res.currency', {
    name: 'USD',
    rate_ids: [
      { date: '2026-01-01', rate: 2.0 },
      { date: '2026-01-10', rate: 1.8 },
      { date: '2026-01-15', rate: 1.6 },
      { date: '2026-01-20', rate: 1.5 },
      { date: '2026-01-25', rate: 1.25 },
      { date: '2026-01-30', rate: 1.0 },
    ],
  });
  db = currency.db;

  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 1,
    currency_id: currency.id,
    invoice_date: '2026-01-01',
    invoice_line_ids: [{ name: 'Hosting', qty: 1, price_unit: 1000, tax_ids: [] }],
  });
  db = postMove(bill.db, bill.id);

  // Cutoff 1: 2026-01-10 (Before payment)
  const aged1 = agedBalance(db, 'payable', '2026-01-10');
  assert.equal(aged1.rows.find((r) => r.partner_id === 1)?.total, 500);

  db = revalueForeignBalances(db, '2026-01-10');
  assert.equal(revalueForeignBalances(db, '2026-01-10'), db);

  // Partial payment on 2026-01-15: pay 400 USD
  db = payMove(db, bill.id, 400, '2026-01-15');
  const paidBill = read(db, 'account.move', bill.id);
  const paymentRow = paidBill.payments[0];
  const paymentMove = read(db, 'account.move', paymentRow.move_id);
  assert.ok(isBalanced(paymentMove.line_ids));
  const lossLine = paymentMove.line_ids.find((l) => l.account_id === lossAcc.id);
  assert.ok(lossLine, 'Realized exchange loss must be booked to configured loss account');
  assert.equal(lossLine.debit, 50, 'Loss must be 50 EUR (250 - 200)');

  // Cutoff 2: 2026-01-20 (After partial payment, before reversal)
  const aged2 = agedBalance(db, 'payable', '2026-01-20');
  assert.equal(aged2.rows.find((r) => r.partner_id === 1)?.total, 300);

  db = revalueForeignBalances(db, '2026-01-20');
  assert.equal(revalueForeignBalances(db, '2026-01-20'), db);

  // Reverse payment on 2026-01-25
  const payment = search(db, 'account.payment').find((p) => p.invoice_id === bill.id && p.state === 'posted');
  db = reversePayment(db, payment, '2026-01-25');

  // Cutoff 3: 2026-01-30 (After payment reversal)
  const aged3 = agedBalance(db, 'payable', '2026-01-30');
  assert.equal(aged3.rows.find((r) => r.partner_id === 1)?.total, 500);

  db = revalueForeignBalances(db, '2026-01-30');
  assert.equal(revalueForeignBalances(db, '2026-01-30'), db);
});

test('Regression: Foreign currency cumulative flow with persisted revaluations across cutoffs', () => {
  let db = seed();
  const gainAcc = create(db, 'account.account', { code: '758000', name: 'Realized FX Gain', account_type: 'income_other', company_id: 1 });
  db = gainAcc.db;
  const lossAcc = create(db, 'account.account', { code: '658000', name: 'Realized FX Loss', account_type: 'expense_other', company_id: 1 });
  db = lossAcc.db;

  db = write(db, 'res.company', 1, {
    income_currency_exchange_account_id: gainAcc.id,
    expense_currency_exchange_account_id: lossAcc.id,
  });

  const currency = create(db, 'res.currency', {
    name: 'USD',
    rate_ids: [
      { date: '2026-01-01', rate: 2.0 },
      { date: '2026-01-10', rate: 1.8 },
      { date: '2026-01-15', rate: 1.6 },
      { date: '2026-01-20', rate: 1.5 },
      { date: '2026-01-25', rate: 1.25 },
      { date: '2026-01-30', rate: 1.0 },
    ],
  });
  db = currency.db;

  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    currency_id: currency.id,
    invoice_date: '2026-01-01',
    invoice_line_ids: [{ name: 'Consulting', qty: 1, price_unit: 1000, tax_ids: [] }],
  });
  db = postMove(inv.db, inv.id);

  // Cutoff 1: 2026-01-10
  const aged1 = agedBalance(db, 'receivable', '2026-01-10');
  assert.equal(aged1.rows.find((r) => r.partner_id === 1)?.total, 500);
  db = revalueForeignBalances(db, '2026-01-10');
  assert.equal(revalueForeignBalances(db, '2026-01-10'), db);

  // Partial payment on 2026-01-15: pay 400 USD
  db = payMove(db, inv.id, 400, '2026-01-15');

  // Cutoff 2: 2026-01-20
  const aged2 = agedBalance(db, 'receivable', '2026-01-20');
  assert.equal(aged2.rows.find((r) => r.partner_id === 1)?.total, 300);
  db = revalueForeignBalances(db, '2026-01-20');
  assert.equal(revalueForeignBalances(db, '2026-01-20'), db);

  // Reverse payment on 2026-01-25
  const payment = search(db, 'account.payment').find((p) => p.invoice_id === inv.id && p.state === 'posted');
  db = reversePayment(db, payment, '2026-01-25');

  // Cutoff 3: 2026-01-30
  const aged3 = agedBalance(db, 'receivable', '2026-01-30');
  assert.equal(aged3.rows.find((r) => r.partner_id === 1)?.total, 500);
  db = revalueForeignBalances(db, '2026-01-30');
  assert.equal(revalueForeignBalances(db, '2026-01-30'), db);
});

// ============================================================================
// REGRESSION: THE HASH CHAIN
// ============================================================================

test('Regression: Secured entries, hash chain, edit/delete rejection, tamper detection, audit trail', () => {
  let db = seed();
  const companyId = 1;

  const secJournal = create(db, 'account.journal', {
    name: 'Secured Invoices',
    code: 'SEC',
    type: 'sale',
    company_id: companyId,
    default_account_id: accountId(db, '400000'),
    restrict_mode_hash_table: true,
    invoice_sequence_prefix: 'SEC/2026/',
    invoice_sequence_next_number: 1,
  });
  db = secJournal.db;

  const inv1 = create(db, 'account.move', {
    move_type: 'out_invoice',
    journal_id: secJournal.id,
    partner_id: 1,
    invoice_date: '2026-02-01',
    invoice_line_ids: [{ name: 'Service 1', qty: 1, price_unit: 100 }],
  });
  db = postMove(inv1.db, inv1.id);

  const inv2 = create(db, 'account.move', {
    move_type: 'out_invoice',
    journal_id: secJournal.id,
    partner_id: 1,
    invoice_date: '2026-02-05',
    invoice_line_ids: [{ name: 'Service 2', qty: 1, price_unit: 200 }],
  });
  db = postMove(inv2.db, inv2.id);

  const inv3 = create(db, 'account.move', {
    move_type: 'out_invoice',
    journal_id: secJournal.id,
    partner_id: 1,
    invoice_date: '2026-02-20',
    invoice_line_ids: [{ name: 'Service 3', qty: 1, price_unit: 300 }],
  });
  db = postMove(inv3.db, inv3.id);

  // Secure through 2026-02-10 (secures inv1 and inv2, leaves inv3 unhashed)
  db = secureEntries(db, { companyId, hashDate: '2026-02-10' });

  const sInv1 = read(db, 'account.move', inv1.id);
  const sInv2 = read(db, 'account.move', inv2.id);
  const sInv3 = read(db, 'account.move', inv3.id);

  assert.ok(sInv1.inalterable_hash, 'Inv 1 must have inalterable hash');
  assert.equal(sInv1.secure_sequence_number, 1);
  assert.ok(sInv2.inalterable_hash, 'Inv 2 must have inalterable hash');
  assert.equal(sInv2.secure_sequence_number, 2);
  assert.ok(!sInv3.inalterable_hash, 'Inv 3 must not be secured yet');

  // Verify hash chain
  const expectedHash1 = computeMoveHash(sInv1, '', 2);
  assert.equal(sInv1.inalterable_hash, expectedHash1);
  const expectedHash2 = computeMoveHash(sInv2, sInv1.inalterable_hash, 2);
  assert.equal(sInv2.inalterable_hash, expectedHash2);

  // Inalterability report
  const report = checkInalterability(db, { journalId: secJournal.id, companyId });
  assert.equal(report.length, 1);
  assert.equal(report[0].status, 'ok', 'Status must be OK');
  assert.equal(report[0].first_move, sInv1.name);
  assert.equal(report[0].last_move, sInv2.name);

  // Rejecting edits of secured entries
  assert.throws(
    () => write(db, 'account.move', inv1.id, { invoice_date: '2026-02-02' }),
    /secured entries cannot be modified/i,
    'Editing secured entry date must be rejected'
  );
  assert.throws(
    () => write(db, 'account.move', inv1.id, { state: 'draft' }),
    /secured entries cannot be reset to draft or cancelled/i,
    'Resetting secured entry to draft must be rejected'
  );

  // Rejecting deletions of secured entries
  assert.throws(
    () => unlink(db, 'account.move', [inv1.id]),
    /secured entries with an inalterability hash cannot be deleted/i,
    'Deleting secured entry must be rejected'
  );

  // Detecting tampered persisted data
  const tamperedDb = {
    ...db,
    records: {
      ...db.records,
      'account.move': db.records['account.move'].map((m) =>
        m.id === inv1.id
          ? { ...m, line_ids: m.line_ids.map((l) => ({ ...l, debit: l.debit ? l.debit + 10 : 0 })) }
          : m
      ),
    },
  };
  const tamperedReport = checkInalterability(tamperedDb, { journalId: secJournal.id, companyId });
  assert.equal(tamperedReport[0].status, 'corrupted', 'Tampered data must report corrupted');
  assert.equal(tamperedReport[0].corrupted_move.id, inv1.id);

  // Audit trail records changes on posted entries when enabled
  db = write(db, 'res.company', companyId, { audit_trail: true });
  const messagesBefore = db.messages.length;
  db = write(db, 'account.move', inv3.id, { payment_reference: 'REF-12345' });
  const messagesAfter = db.messages.length;
  assert.ok(messagesAfter > messagesBefore, 'Audit trail message must be added');
  const lastMsg = db.messages.at(-1);
  assert.equal(lastMsg.model, 'account.move');
  assert.equal(lastMsg.res_id, inv3.id);
  assert.equal(lastMsg.kind, 'tracking');
});

test('Cross-company partner bank: batch payment rejects a posted bill that already carries another company bank', async () => {
  const { postBatch } = await import('./models/payments.js');
  let db = seed();
  const c2 = createCompanyWithDefaultInvoiceJournals(db, { name: 'Company Two' });
  db = c2.db;
  const bank = create(db, 'res.partner.bank', { partner_id: 1, account_number: 'C2-IBAN-BATCH-777', company_id: c2.id, allow_out_payment: true });
  const bill = create(bank.db, 'account.move', { move_type: 'in_invoice', company_id: 1, partner_id: 1, invoice_date: '2026-03-01', invoice_line_ids: [{ name: 'Expense Item', qty: 1, price_unit: 500 }] });
  const posted = postMove(bill.db, bill.id);
  // A record saved before the company check existed.
  const legacy = { ...posted, records: { ...posted.records, 'account.move': posted.records['account.move'].map((m) => (m.id === bill.id ? { ...m, partner_bank_id: bank.id } : m)) } };
  const batch = create(legacy, 'account.batch.payment', { batch_type: 'outbound', check_number_start: 1, lines: [{ move_id: bill.id, amount: 500 }] });
  assert.throws(() => postBatch(batch.db, read(batch.db, 'account.batch.payment', batch.id)), /select a record shared with or belonging to this company/i);
  assert.equal(read(batch.db, 'account.move', bill.id).amount_paid ?? 0, 0);
});
