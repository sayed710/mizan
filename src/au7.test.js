import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { models } from './models/index.js';
import { seed } from './seed.js';
import { postMove, payMove, payWithDiscount, discountAvailable } from './models/accounting.js';
import { importStatement } from './models/statements.js';
import { isBalanced } from './models/ledger.js';
import { createCompany } from './models/company.js';
import { invoiceJournalDefaults } from './test-support/accounting-company.js';
import { postCompanyDeferrals } from './models/deferred.js';
import { disposeAsset, postDepreciation } from './models/assets.js';
import { agedBalance, followUps, followUpCompanies } from './models/finance.js';
import { postBatch, checkRegisterRows } from './models/payments.js';
import { reversePayment } from './models/pay.js';

const button = (db, model, id, label) => models[model].form.buttons.find((b) => b.label === label).run(db, read(db, model, id)).db;

const balance = (d, acc) => (d.records['account.move'] ?? [])
  .filter((m) => m.state === 'posted')
  .flatMap((m) => m.line_ids ?? [])
  .filter((l) => l.account_id === acc)
  .reduce((sum, l) => sum + (Number(l.debit) || 0) - (Number(l.credit) || 0), 0);

test('Area A: Bank reconciliation - happy path through import, matching, partial settlement, write-off, and unlocked unreconciliation', () => {
  const base = seed();
  const outstandingReceipts = search(base, 'account.account').find((a) => a.code === '101402').id;
  const outstandingPayments = search(base, 'account.account').find((a) => a.code === '101403').id;
  const bankAcc = search(base, 'account.account').find((a) => a.code === '101401').id;
  const receivableAcc = search(base, 'account.account').find((a) => a.code === '121000').id;
  const expenseAcc = search(base, 'account.account').find((a) => a.code === '600000').id;
  const bankJournal = search(base, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);

  let db = write(base, 'res.company', 1, {
    outstanding_receipts_account_id: outstandingReceipts,
    outstanding_payments_account_id: outstandingPayments,
  });

  const initBank = balance(db, bankAcc);
  const initOut = balance(db, outstandingReceipts);
  const initRec = balance(db, receivableAcc);

  // 1. Import bank statement lines
  const ofxContent = `
OFXHEADER:100
DATA:OFXSGML
<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>CREDIT</TRNTYPE>
<DTPOSTED>20260105120000</DTPOSTED>
<TRNAMT>100.00</TRNAMT>
<FITID>OFX001</FITID>
<NAME>Customer Payment 1</NAME>
</STMTTRN>
<STMTTRN>
<TRNTYPE>CREDIT</TRNTYPE>
<DTPOSTED>20260106120000</DTPOSTED>
<TRNAMT>40.00</TRNAMT>
<FITID>OFX002</FITID>
<NAME>Partial Settle Invoice 2</NAME>
</STMTTRN>
<STMTTRN>
<TRNTYPE>DEBIT</TRNTYPE>
<DTPOSTED>20260107120000</DTPOSTED>
<TRNAMT>-15.00</TRNAMT>
<FITID>OFX003</FITID>
<NAME>Bank Service Fee</NAME>
</STMTTRN>
</BANKTRANLIST>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>
`;
  const imported = importStatement(db, 'stmt.ofx', ofxContent, { journal_id: bankJournal.id, company_id: 1 });
  db = imported.db;
  assert.equal(imported.count, 3);

  const lines = search(db, 'account.bank.statement.line').filter((l) => ['OFX001', 'OFX002', 'OFX003'].includes(l.unique_import_id));
  const [line1, line2, line3] = [
    lines.find((l) => l.unique_import_id === 'OFX001'),
    lines.find((l) => l.unique_import_id === 'OFX002'),
    lines.find((l) => l.unique_import_id === 'OFX003'),
  ];

  // 2. Match line1 to an existing posted payment (no second bank posting)
  const inv1 = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 3,
    invoice_date: '2026-01-01',
    invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(inv1.db, inv1.id);

  const p1 = create(db, 'account.payment', {
    invoice_id: inv1.id,
    partner_id: 3,
    payment_type: 'inbound',
    partner_type: 'customer',
    amount: 100,
    date: '2026-01-02',
    journal_id: bankJournal.id,
  });
  db = button(p1.db, 'account.payment', p1.id, 'Confirm');
  const paymentRecord = read(db, 'account.payment', p1.id);
  const paymentEntry = read(db, 'account.move', paymentRecord.move_id);

  // Check payment entry uses outstanding receipts, NOT bank
  assert.ok(paymentEntry.line_ids.some((l) => l.account_id === outstandingReceipts && l.debit === 100));
  assert.ok(!paymentEntry.line_ids.some((l) => l.account_id === bankAcc));

  // Match line1 to payment p1
  db = write(db, 'account.bank.statement.line', line1.id, { payment_id: p1.id });
  const paymentCountBefore = search(db, 'account.payment').length;
  db = button(db, 'account.bank.statement.line', line1.id, 'Match Payment');

  // Verify no second payment created
  assert.equal(search(db, 'account.payment').length, paymentCountBefore);
  const matchedLine1 = read(db, 'account.bank.statement.line', line1.id);
  assert.equal(matchedLine1.state, 'reconciled');
  const bankEntry1 = read(db, 'account.move', matchedLine1.bank_move_id);
  assert.ok(bankEntry1.line_ids.some((l) => l.account_id === bankAcc && l.debit === 100));
  assert.ok(bankEntry1.line_ids.some((l) => l.account_id === outstandingReceipts && l.credit === 100));

  // 3. Partially settle an invoice from a statement line
  const inv2 = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 3,
    invoice_date: '2026-01-01',
    invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(inv2.db, inv2.id);

  db = write(db, 'account.bank.statement.line', line2.id, { move_id: inv2.id });
  db = button(db, 'account.bank.statement.line', line2.id, 'Match');

  const matchedLine2 = read(db, 'account.bank.statement.line', line2.id);
  assert.equal(matchedLine2.state, 'reconciled');
  assert.equal(read(db, 'account.move', inv2.id).amount_residual, 60);

  // 4. Apply a reconciliation model rule with a write-off
  const rule = create(db, 'account.reconcile.model', {
    name: 'Bank Fees',
    rule_type: 'writeoff_button',
    match_nature: 'amount_paid',
    match_label: 'contains',
    match_label_param: 'Bank Service Fee',
    line_ids: [{
      account_id: expenseAcc,
      amount_type: 'percentage',
      amount: 100,
      label: 'Bank Fee Expense',
    }],
  });
  db = rule.db;

  db = button(db, 'account.bank.statement.line', line3.id, 'Apply Reconciliation Model');
  const matchedLine3 = read(db, 'account.bank.statement.line', line3.id);
  assert.equal(matchedLine3.state, 'reconciled');
  const bankEntry3 = read(db, 'account.move', matchedLine3.bank_move_id);
  assert.ok(bankEntry3.line_ids.some((l) => l.account_id === bankAcc && l.credit === 15));
  assert.ok(bankEntry3.line_ids.some((l) => l.account_id === expenseAcc && l.debit === 15));

  // 5. Check bank, outstanding and receivable balances
  assert.equal(balance(db, bankAcc) - initBank, 125, 'Bank delta should be +100 (line1) +40 (line2) -15 (line3) = +125');
  assert.equal(balance(db, outstandingReceipts) - initOut, 0, 'Outstanding receipts delta should be +100 (p1) -100 (matched line1) = 0');
  assert.equal(balance(db, receivableAcc) - initRec, 60, 'Receivable delta should be +100 (inv1) -100 (p1) +100 (inv2) -40 (line2) = +60');

  // 6. Unreconciling restores all balances
  db = button(db, 'account.bank.statement.line', line1.id, 'Unreconcile');
  db = button(db, 'account.bank.statement.line', line2.id, 'Unreconcile');
  db = button(db, 'account.bank.statement.line', line3.id, 'Unreconcile');

  assert.equal(balance(db, bankAcc) - initBank, 0, 'Bank balance restored to initial');
  assert.equal(balance(db, outstandingReceipts) - initOut, 100, 'Outstanding receipts restored to payment balance (100)');
  assert.equal(balance(db, receivableAcc) - initRec, 100, 'Receivable restored to invoice 2 remaining balance (100)');
  assert.equal(read(db, 'account.move', inv1.id).amount_residual, 0, 'Invoice 1 remains settled by payment p1');
  assert.equal(read(db, 'account.move', inv2.id).amount_residual, 100, 'Invoice 2 residual restored to 100');
});

test('Area A DEFECT: Unreconciling a matched payment or write-off in a locked period bypasses lock guards', () => {
  const base = seed();
  const outstandingReceipts = search(base, 'account.account').find((a) => a.code === '101402').id;
  const bankJournal = search(base, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);

  let db = write(base, 'res.company', 1, { outstanding_receipts_account_id: outstandingReceipts });

  const inv1 = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 3,
    invoice_date: '2026-01-01',
    invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(inv1.db, inv1.id);

  const p1 = create(db, 'account.payment', {
    invoice_id: inv1.id,
    partner_id: 3,
    payment_type: 'inbound',
    partner_type: 'customer',
    amount: 100,
    date: '2026-01-02',
    journal_id: bankJournal.id,
  });
  db = button(p1.db, 'account.payment', p1.id, 'Confirm');

  const line1 = create(db, 'account.bank.statement.line', {
    journal_id: bankJournal.id,
    date: '2026-01-05',
    payment_ref: 'line1',
    amount: 100,
    payment_id: p1.id,
  });
  db = button(line1.db, 'account.bank.statement.line', line1.id, 'Match Payment');

  // Hard lock the period covering 2026-01-05
  db = write(db, 'res.company', 1, { hard_lock_date: '2026-01-31' });

  // In Odoo 20, unreconciling transactions falling inside a locked period is strictly blocked
  // because modifying the reconciliation status of closed/locked periods violates accounting integrity.
  assert.throws(
    () => button(db, 'account.bank.statement.line', line1.id, 'Unreconcile'),
    /lock/i,
    'Unreconciling a transaction in a locked period must be blocked'
  );
});

test('Area B: Assets - vendor bill with model, depreciation, sale and scrap', () => {
  let db = seed();
  const companyId = 1;
  const assetAcc = search(db, 'account.account').find((a) => a.code === '151000').id;
  const depAcc = search(db, 'account.account').find((a) => a.code === '152000').id;
  const depExpAcc = search(db, 'account.account').find((a) => a.code === '680000').id;
  const miscJournal = search(db, 'account.journal').find((j) => j.type === 'general' && (j.company_id ?? 1) === companyId).id;

  // 1. Create asset model
  const model = create(db, 'account.asset.model', {
    name: 'Machinery Model',
    company_id: companyId,
    method: 'linear',
    method_number: 12,
    method_period: '1',
    account_asset_id: assetAcc,
    account_depreciation_id: depAcc,
    account_depreciation_expense_id: depExpAcc,
    journal_id: miscJournal,
  });
  db = model.db;

  // Link asset model to a fixed asset account
  const fixedAcc = create(db, 'account.account', {
    name: 'Special Machinery',
    code: '151100',
    account_type: 'asset_fixed',
    company_id: companyId,
    asset_model_id: model.id,
  });
  db = fixedAcc.db;

  // Post vendor bill with line linked to the asset model account
  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    company_id: companyId,
    partner_id: 2,
    invoice_date: '2026-01-01',
    invoice_line_ids: [
      { name: 'Machine 1 (to sell)', qty: 1, price_unit: 1200, tax: 0, account_id: fixedAcc.id },
      { name: 'Machine 2 (to scrap)', qty: 1, price_unit: 600, tax: 0, account_id: fixedAcc.id },
    ],
  });
  db = postMove(bill.db, bill.id);

  // Check draft assets were created
  const createdAssets = search(db, 'account.asset').filter((a) => a.bill_id === bill.id);
  assert.equal(createdAssets.length, 2, 'Two draft assets should be generated from the bill');
  const [asset1, asset2] = createdAssets;
  assert.equal(asset1.state, 'draft');
  assert.equal(asset1.original_value, 1200);
  assert.equal(asset1.model_id, model.id);
  assert.equal(asset2.state, 'draft');
  assert.equal(asset2.original_value, 600);
  assert.equal(asset2.model_id, model.id);

  // Confirm both assets
  db = button(db, 'account.asset', asset1.id, 'Confirm');
  db = button(db, 'account.asset', asset2.id, 'Confirm');
  assert.equal(read(db, 'account.asset', asset1.id).state, 'open');
  assert.equal(read(db, 'account.asset', asset2.id).state, 'open');

  // Depreciate across period boundary (up to 2026-01-31)
  db = postDepreciation(db, read(db, 'account.asset', asset1.id), '2026-01-31');
  db = postDepreciation(db, read(db, 'account.asset', asset2.id), '2026-01-31');

  const updatedAsset1 = read(db, 'account.asset', asset1.id);
  const postedDep1 = updatedAsset1.depreciation_ids.filter((l) => l.posted);
  assert.equal(postedDep1.length, 1);
  assert.equal(postedDep1[0].amount, 100);
  assert.equal(updatedAsset1.book_value, 1100);

  const updatedAsset2 = read(db, 'account.asset', asset2.id);
  const postedDep2 = updatedAsset2.depreciation_ids.filter((l) => l.posted);
  assert.equal(postedDep2.length, 1);
  assert.equal(postedDep2[0].amount, 50);
  assert.equal(updatedAsset2.book_value, 550);

  // Sell asset 1 through customer invoice
  const saleAcc = search(db, 'account.account').find((a) => a.code === '400000').id;
  const saleInvoice = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: companyId,
    partner_id: 3,
    invoice_date: '2026-02-01',
    invoice_line_ids: [{ name: 'Sale Machine 1', qty: 1, price_unit: 1150, tax: 0, account_id: saleAcc }],
  });
  db = postMove(saleInvoice.db, saleInvoice.id);

  // Dispose asset 1 (sale)
  db = disposeAsset(db, read(db, 'account.asset', asset1.id), {
    date: '2026-02-01',
    saleValue: 1150,
    invoiceId: saleInvoice.id,
    invoiceLine: 0,
  });
  const soldAsset = read(db, 'account.asset', asset1.id);
  assert.equal(soldAsset.state, 'close');
  assert.equal(soldAsset.disposal_date, '2026-02-01');
  const disposalMove1 = search(db, 'account.move').find((m) => m.ref === `${asset1.name} disposal`);
  assert.ok(disposalMove1);
  assert.ok(isBalanced(disposalMove1.line_ids));

  // Separately scrap asset 2
  db = disposeAsset(db, read(db, 'account.asset', asset2.id), {
    date: '2026-02-01',
    saleValue: 0,
    invoiceId: null,
  });
  const scrappedAsset = read(db, 'account.asset', asset2.id);
  assert.equal(scrappedAsset.state, 'close');
  assert.equal(scrappedAsset.disposal_date, '2026-02-01');
  const disposalMove2 = search(db, 'account.move').find((m) => m.ref === `${asset2.name} disposal`);
  assert.ok(disposalMove2);
  assert.ok(isBalanced(disposalMove2.line_ids));
  const lossAcc = search(db, 'account.account').find((a) => a.code === '690300').id;
  assert.ok(disposalMove2.line_ids.some((l) => l.account_id === lossAcc && l.debit === 550));
});

test('Area B: Cross-company account asset model validation and bill posting', () => {
  let db = seed();
  const c2 = createCompany(db, { name: 'Branch 2', ...invoiceJournalDefaults(db) });
  db = c2.db;
  const company2Id = c2.id;

  const depAccC1 = create(db, 'account.account', { name: 'Dep C1', code: '152001', account_type: 'asset_fixed', company_id: 1 });
  db = depAccC1.db;
  const depExpAccC1 = create(db, 'account.account', { name: 'Dep Exp C1', code: '680001', account_type: 'expense', company_id: 1 });
  db = depExpAccC1.db;

  const modelC1 = create(db, 'account.asset.model', {
    name: 'Model C1',
    company_id: 1,
    method: 'linear',
    method_number: 5,
    method_period: '12',
    account_asset_id: search(db, 'account.account').find((a) => a.code === '151000').id,
    account_depreciation_id: depAccC1.id,
    account_depreciation_expense_id: depExpAccC1.id,
    journal_id: search(db, 'account.journal').find((j) => j.code === 'MISC').id,
  });
  db = modelC1.db;

  // In Odoo, an account belonging to Company 2 MUST NOT be allowed to link to an Asset Model belonging to Company 1.
  assert.throws(
    () => create(db, 'account.account', {
      name: 'Machinery C2',
      code: '151200',
      account_type: 'asset_fixed',
      company_id: company2Id,
      asset_model_id: modelC1.id,
    }),
    /Asset model must belong to the account company/i,
    'Linking an asset model of another company to an account must be rejected'
  );

  // Posting a bill on a valid same-company account keeps working
  const depAccC2 = create(db, 'account.account', { name: 'Dep C2', code: '152002', account_type: 'asset_fixed', company_id: company2Id });
  db = depAccC2.db;
  const depExpAccC2 = create(db, 'account.account', { name: 'Dep Exp C2', code: '680002', account_type: 'expense', company_id: company2Id });
  db = depExpAccC2.db;
  const miscJournalC2 = search(db, 'account.journal').find((j) => j.type === 'general' && j.company_id === company2Id);

  const modelC2 = create(db, 'account.asset.model', {
    name: 'Model C2',
    company_id: company2Id,
    method: 'linear',
    method_number: 5,
    method_period: '12',
    account_asset_id: depAccC2.id,
    account_depreciation_id: depAccC2.id,
    account_depreciation_expense_id: depExpAccC2.id,
    journal_id: miscJournalC2?.id ?? search(db, 'account.journal').find((j) => j.code === 'MISC').id,
  });
  db = modelC2.db;

  const validAccC2 = create(db, 'account.account', {
    name: 'Machinery Valid C2',
    code: '151201',
    account_type: 'asset_fixed',
    company_id: company2Id,
    asset_model_id: modelC2.id,
  });
  db = validAccC2.db;

  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    company_id: company2Id,
    partner_id: 2,
    invoice_date: '2026-01-01',
    invoice_line_ids: [{ name: 'Equipment', qty: 1, price_unit: 1000, tax: 0, account_id: validAccC2.id }],
  });

  let postedBillDb;
  assert.doesNotThrow(
    () => { postedBillDb = postMove(bill.db, bill.id); },
    'Posting a vendor bill on a valid same-company account should succeed'
  );
  const createdAssets = search(postedBillDb, 'account.asset').filter((a) => a.bill_id === bill.id);
  assert.equal(createdAssets.length, 1);
  assert.equal(createdAssets[0].company_id, company2Id);
  assert.equal(createdAssets[0].model_id, modelC2.id);
});

test('Area B: Deferrals - invoice and bill across period boundary, double run, balanced entries, two companies', () => {
  let db = seed();
  const c2 = createCompany(db, { name: 'Branch 2', ...invoiceJournalDefaults(db) });
  db = c2.db;
  const company2Id = c2.id;

  // Setup company 1 and company 2 for manual deferrals
  const defRev1 = search(db, 'account.account').find((a) => a.code === '212000').id;
  const defExp1 = search(db, 'account.account').find((a) => a.code === '132000').id;
  db = write(db, 'res.company', 1, {
    deferred_generation_method: 'manual',
    deferred_revenue_account_id: defRev1,
    deferred_expense_account_id: defExp1,
  });

  const defRev2Acc = create(db, 'account.account', { name: 'Prepaid Rev C2', code: '212002', account_type: 'liability_current', company_id: company2Id });
  db = defRev2Acc.db;
  const defExp2Acc = create(db, 'account.account', { name: 'Prepaid Exp C2', code: '132002', account_type: 'asset_current', company_id: company2Id });
  db = defExp2Acc.db;
  const rev2Acc = create(db, 'account.account', { name: 'Sales C2', code: '400002', account_type: 'income', company_id: company2Id });
  db = rev2Acc.db;
  const exp2Acc = create(db, 'account.account', { name: 'Expenses C2', code: '600002', account_type: 'expense', company_id: company2Id });
  db = exp2Acc.db;

  db = write(db, 'res.company', company2Id, {
    deferred_generation_method: 'manual',
    deferred_revenue_account_id: defRev2Acc.id,
    deferred_expense_account_id: defExp2Acc.id,
  });

  // Create deferred invoice and bill for Company 1 across period boundary (2026-01-15 to 2026-03-15)
  const inv1 = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: 3,
    invoice_date: '2026-01-15',
    invoice_line_ids: [{ name: 'Service Subscription', qty: 1, price_unit: 600, tax: 0, account_id: search(db, 'account.account').find((a) => a.code === '400000').id, deferred_start_date: '2026-01-15', deferred_end_date: '2026-03-15' }],
  });
  db = postMove(inv1.db, inv1.id);

  const bill1 = create(db, 'account.move', {
    move_type: 'in_invoice',
    company_id: 1,
    partner_id: 2,
    invoice_date: '2026-01-15',
    invoice_line_ids: [{ name: 'Server Hosting', qty: 1, price_unit: 300, tax: 0, account_id: search(db, 'account.account').find((a) => a.code === '600000').id, deferred_start_date: '2026-01-15', deferred_end_date: '2026-03-15' }],
  });
  db = postMove(bill1.db, bill1.id);

  // Run generation twice for Company 1 at 2026-01-31
  const entriesCountBefore = search(db, 'account.move').length;
  db = postCompanyDeferrals(db, 1, '2026-01-31');
  const entriesCountAfterFirst = search(db, 'account.move').length;
  assert.ok(entriesCountAfterFirst > entriesCountBefore, 'First generation should create entries');

  db = postCompanyDeferrals(db, 1, '2026-01-31');
  const entriesCountAfterSecond = search(db, 'account.move').length;
  assert.equal(entriesCountAfterSecond, entriesCountAfterFirst, 'Running generation twice must not create duplicate entries');

  // Verify all created deferral entries are balanced and belong to company 1
  const newEntries = search(db, 'account.move').slice(entriesCountBefore, entriesCountAfterFirst);
  for (const entry of newEntries) {
    assert.equal(entry.company_id, 1, 'Entry must belong to company 1');
    assert.ok(isBalanced(entry.line_ids), 'Deferral entry must be balanced');
    for (const line of entry.line_ids) {
      const acc = read(db, 'account.account', line.account_id);
      assert.ok(!acc.company_id || acc.company_id === 1, 'Account must belong to company 1');
    }
  }

  // Check remaining balances on deferrals
  const schedInv = search(db, 'account.deferral').find((d) => d.source_move_id === inv1.id);
  const schedBill = search(db, 'account.deferral').find((d) => d.source_move_id === bill1.id);
  assert.ok(schedInv && schedBill);
  const postedRev = schedInv.board.filter((l) => l.posted).reduce((s, l) => s + l.amount, 0);
  const postedExp = schedBill.board.filter((l) => l.posted).reduce((s, l) => s + l.amount, 0);
  assert.ok(postedRev > 0 && postedRev < 600);
  assert.ok(postedExp > 0 && postedExp < 300);

  // Check Company 2 in two-company database
  const inv2 = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: company2Id,
    partner_id: 3,
    invoice_date: '2026-01-15',
    invoice_line_ids: [{ name: 'Service C2', qty: 1, price_unit: 400, tax: 0, account_id: rev2Acc.id, deferred_start_date: '2026-01-15', deferred_end_date: '2026-03-15' }],
  });
  db = postMove(inv2.db, inv2.id);

  db = postCompanyDeferrals(db, company2Id, '2026-01-31');
  const c2Entries = search(db, 'account.move').filter((m) => m.company_id === company2Id && m.move_type === 'entry');
  assert.ok(c2Entries.length > 0, 'Company 2 deferrals should generate entries');
  for (const entry of c2Entries) {
    assert.equal(entry.company_id, company2Id);
    assert.ok(isBalanced(entry.line_ids));
    for (const line of entry.line_ids) {
      const acc = read(db, 'account.account', line.account_id);
      assert.equal(acc.company_id, company2Id, 'Company 2 entry accounts must belong to Company 2');
    }
  }
});

test('Area C: Terms, partial payment, aging by due date, early discount, follow-up for overdue installment only, check numbering and cancellation history', () => {
  const base = seed();
  let db = base;

  // 1. Payment terms: 30% immediate / 70% in 30 days
  const term = create(db, 'account.payment.term', {
    name: '30% now / 70% in 30 days',
    line_ids: [
      { value_type: 'percent', value: 30, nb_days: 0, delay_type: 'days_after' },
      { value_type: 'percent', value: 70, nb_days: 30, delay_type: 'days_after' },
    ],
  });
  db = term.db;

  const customer1 = create(db, 'res.partner', { name: 'Customer Installment' });
  db = customer1.db;

  const invoice1 = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: customer1.id,
    invoice_date: '2026-01-01',
    invoice_payment_term_id: term.id,
    invoice_line_ids: [{ name: 'Consulting', qty: 1, price_unit: 1000, tax: 0 }],
  });
  db = postMove(invoice1.db, invoice1.id);

  const postedInv1 = read(db, 'account.move', invoice1.id);
  const receivableItems = postedInv1.line_ids.filter((l) => read(db, 'account.account', l.account_id)?.account_type === 'asset_receivable');
  assert.equal(receivableItems.length, 2, 'Must create two receivable items');
  assert.deepEqual(
    receivableItems.map((l) => [l.date_maturity, l.debit]),
    [['2026-01-01', 300], ['2026-01-31', 700]],
    'Each receivable item must have its own due date and proportion'
  );

  // 2. Partially pay and check aged receivables by due date
  // Partially pay 200 on 2026-01-10 (leaving 100 of first installment, 700 of second installment)
  db = payMove(db, invoice1.id, 200, '2026-01-10');
  assert.equal(read(db, 'account.move', invoice1.id).amount_residual, 800);

  // Check aging on 2026-01-15:
  // First installment (due 2026-01-01) is 14 days overdue -> bucket '1_30': 100
  // Second installment (due 2026-01-31) is not overdue -> bucket 'current': 700
  // Total: 800
  const agingRow = agedBalance(db, 'receivable', '2026-01-15').rows.find((r) => r.partner_id === customer1.id);
  assert.ok(agingRow);
  assert.equal(agingRow['1_30'], 100, 'Overdue installment should be in 1-30 bucket');
  assert.equal(agingRow.current, 700, 'Non-due installment should be in current bucket');
  assert.equal(agingRow.total, 800, 'Total residual should be 800');

  // 3. Follow-up reminder for overdue installment only
  const reminders = followUps(db, '2026-01-15');
  const custReminder = reminders.find((f) => f.partner_id === customer1.id);
  assert.ok(custReminder, 'Partner with overdue installment must be in follow-ups');
  const [custGroup] = followUpCompanies(custReminder);
  assert.equal(custGroup.total, 100, 'Follow-up reminder total must be for the overdue installment only (100), not full residual (800)');
  assert.equal(custGroup.invoices[0].amount_residual, 100, 'Invoice amount in reminder must reflect only the overdue installment');

  // 4. Early-payment discount
  const discountTerm = create(db, 'account.payment.term', {
    name: '2% 10 Net 30',
    early_discount: true,
    discount_percent: 2,
    discount_days: 10,
    discount_tax_computation: 'excluded',
  });
  db = discountTerm.db;

  const customer2 = create(db, 'res.partner', { name: 'Customer Discount' });
  db = customer2.db;

  const invoice2 = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: customer2.id,
    invoice_date: '2026-01-01',
    invoice_payment_term_id: discountTerm.id,
    invoice_line_ids: [{ name: 'Product', qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(invoice2.db, invoice2.id);

  assert.equal(discountAvailable(db, read(db, 'account.move', invoice2.id), '2026-01-10'), 2);
  assert.equal(discountAvailable(db, read(db, 'account.move', invoice2.id), '2026-01-12'), 0);

  // Pay with discount on 2026-01-05 (pay 98, discount 2)
  db = payWithDiscount(db, invoice2.id, 98, '2026-01-05');
  assert.equal(read(db, 'account.move', invoice2.id).amount_residual, 0);

  // 5. Outbound check numbering and cancellation keeping history
  const bankAcc = search(db, 'account.account').find((a) => a.code === '101401').id;
  const checkJournal = create(db, 'account.journal', {
    name: 'Check Journal',
    code: 'CHK',
    type: 'bank',
    company_id: 1,
    default_account_id: bankAcc,
    check_next_number: 501,
  });
  db = checkJournal.db;

  const vendor = create(db, 'res.partner', { name: 'Supplier Checks' });
  db = vendor.db;

  const bill1 = create(db, 'account.move', {
    move_type: 'in_invoice',
    company_id: 1,
    partner_id: vendor.id,
    invoice_date: '2026-01-01',
    invoice_line_ids: [{ name: 'Goods', qty: 1, price_unit: 500, tax: 0 }],
  });
  db = postMove(bill1.db, bill1.id);

  const bill2 = create(db, 'account.move', {
    move_type: 'in_invoice',
    company_id: 1,
    partner_id: vendor.id,
    invoice_date: '2026-01-01',
    invoice_line_ids: [{ name: 'Services', qty: 1, price_unit: 300, tax: 0 }],
  });
  db = postMove(bill2.db, bill2.id);

  // Batch payment to issue checks
  const batch = create(db, 'account.batch.payment', {
    batch_type: 'outbound',
    journal_id: checkJournal.id,
    date: '2026-01-02',
    lines: [
      { move_id: bill1.id, amount: 500 },
      { move_id: bill2.id, amount: 300 },
    ],
  });
  db = postBatch(batch.db, read(batch.db, 'account.batch.payment', batch.id));

  const postedBatch = read(db, 'account.batch.payment', batch.id);
  assert.equal(postedBatch.lines[0].check_number, 501);
  assert.equal(postedBatch.lines[1].check_number, 502);
  assert.equal(read(db, 'account.journal', checkJournal.id).check_next_number, 503);

  const payment1 = read(db, 'account.payment', postedBatch.lines[0].payment_id);
  assert.equal(payment1.check_number, 501);

  // Cancel / Reverse check 501
  db = reversePayment(db, payment1, '2026-01-03');
  const reversedPayment1 = read(db, 'account.payment', payment1.id);
  assert.equal(reversedPayment1.state, 'reversed');
  assert.equal(reversedPayment1.check_number, 501, 'Check number must be preserved after cancellation');

  // Verify check register maintains history
  const registerRows = checkRegisterRows(db);
  const row501 = registerRows.find((r) => r.checkNumber === 501);
  assert.ok(row501, 'Cancelled check 501 must exist in check register');
  assert.equal(row501.state, 'Cancelled');

  // Ensure cancelled check number is NOT reused
  const bill3 = create(db, 'account.move', {
    move_type: 'in_invoice',
    company_id: 1,
    partner_id: vendor.id,
    invoice_date: '2026-01-04',
    invoice_line_ids: [{ name: 'More goods', qty: 1, price_unit: 200, tax: 0 }],
  });
  db = postMove(bill3.db, bill3.id);

  // Reset check_next_number to 501 manually to see if it refuses reusing 501
  db = write(db, 'account.journal', checkJournal.id, { check_next_number: 501 });

  const batch2 = create(db, 'account.batch.payment', {
    batch_type: 'outbound',
    journal_id: checkJournal.id,
    date: '2026-01-05',
    lines: [{ move_id: bill3.id, amount: 200 }],
  });
  db = postBatch(batch2.db, read(batch2.db, 'account.batch.payment', batch2.id));
  const postedBatch2 = read(db, 'account.batch.payment', batch2.id);
  assert.equal(postedBatch2.lines[0].check_number, 503, 'Next check number must skip already used/cancelled numbers (501, 502) and be 503');
});
