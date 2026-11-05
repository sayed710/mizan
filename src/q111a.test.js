import test from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { create, read, search, write } from './orm.js';
import { defaultTaxRepartitionLines, taxSnapshot } from './models/taxes.js';
import { createSheet, submitSheet, approveSheet, postSheet, registerPayment } from './models/expenseplus.js';
import { expenseDebits } from './models/expense-accounts.js';
import { invoiceLines, isBalanced } from './models/ledger.js';
import { postMove, releaseCashBasis } from './models/accounting.js';
import { invoiceTaxAmount, total } from './models/common.js';
import { round } from './money.js';
import { applyDiff, diffDb } from './sync.js';

const linked = () => [[2, 'mona'], [3, 'youssef'], [4, 'hana'], [5, 'karim']].reduce((db, [id, login]) => write(db, 'hr.employee', id, { user_login: login }), seed());
const as = (login, name = login) => ({ isAdmin: false, login, author: name });
const save = (db, next, who) => applyDiff(db, diffDb(db, next), who);

test('qodo 1: expenseDebits rounds base and tax so that debits add up exactly to line.total_amount (e.g. 10.00 at 21%)', () => {
  let db = seed();
  const expenseAccount = create(db, 'account.account', { name: 'Travel Expense', code: '610001', account_type: 'expense', company_id: 1 });
  const taxAccount = create(expenseAccount.db, 'account.account', { name: 'Input Tax 21%', code: '131021', account_type: 'asset_current', company_id: 1 });
  const tax = create(taxAccount.db, 'account.tax', {
    name: 'VAT 21%',
    type_tax_use: 'purchase',
    amount: 21,
    amount_type: 'percent',
    ...defaultTaxRepartitionLines(taxAccount.id),
    company_id: 1,
  });
  const journal = search(tax.db, 'account.journal').find((j) => j.type === 'purchase');
  db = write(tax.db, 'account.journal', journal.id, { default_account_id: expenseAccount.id });
  const expense = create(db, 'hr.expense', {
    name: 'Small meal',
    employee_id: 2,
    total_amount: 10.00,
    tax: 21,
    tax_id: tax.id,
    payment_mode: 'own_account',
  });
  const expenseRec = read(expense.db, 'hr.expense', expense.id);
  const debits = expenseDebits(expense.db, { company_id: 1, expense_journal_id: journal.id }, [expenseRec]);
  const totalDebits = round(debits.reduce((sum, d) => sum + (Number(d.debit) || 0) - (Number(d.credit) || 0), 0));
  assert.equal(totalDebits, 10.00, 'Sum of expense debits must equal 10.00 exactly');
  const report = createSheet(expense.db, [expense.id], { name: 'Cent Test Report' });
  db = submitSheet(report.db, report.id);
  db = approveSheet(db, report.id, read(db, 'hr.expense.sheet', report.id).manager_id || 1);
  const posted = postSheet(db, report.id, '2026-10-01');
  const sheetRec = read(posted, 'hr.expense.sheet', report.id);
  assert.equal(sheetRec.state, 'post');
  const entry = read(posted, 'account.move', sheetRec.move_id);
  assert.ok(isBalanced(entry.line_ids), 'Posted expense move must be balanced');
});

test('qodo 3: price-included cash-basis refund uses refund side factor in cashBasisTaxes and cash-basis release', () => {
  let db = seed();
  const taxAccountInv = create(db, 'account.account', { name: 'VAT Invoice Tax', code: '251091', account_type: 'liability_current', company_id: 1 });
  const taxAccountRef = create(taxAccountInv.db, 'account.account', { name: 'VAT Refund Tax', code: '251092', account_type: 'liability_current', company_id: 1 });
  const transitionAccount = create(taxAccountRef.db, 'account.account', { name: 'VAT Transition', code: '251199', account_type: 'liability_current', company_id: 1 });

  // Invoice factor 100%, refund side reverse charge (+100%, -100% -> factor 0%)
  const invRows = [
    { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
    { repartition_type: 'tax', factor_percent: 100, account_id: taxAccountInv.id, tag_ids: [] },
  ];
  const refRows = [
    { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
    { repartition_type: 'tax', factor_percent: 100, account_id: taxAccountRef.id, tag_ids: [] },
    { repartition_type: 'tax', factor_percent: -100, account_id: taxAccountInv.id, tag_ids: [] },
  ];
  const tax = create(transitionAccount.db, 'account.tax', {
    name: 'Cash basis 20% Diff',
    type_tax_use: 'sale',
    amount: 20,
    amount_type: 'percent',
    price_include: true,
    tax_exigibility: 'on_payment',
    cash_basis_transition_account_id: transitionAccount.id,
    invoice_repartition_line_ids: invRows,
    refund_repartition_line_ids: refRows,
    company_id: 1,
  });

  // Price-included 120. Under refund factor 0%: base = 120 / (1 + 0) = 120. Tax = 120 * 0.20 = 24.
  const refund = create(tax.db, 'account.move', {
    move_type: 'out_refund',
    partner_id: 1,
    invoice_date: '2026-06-03',
    invoice_line_ids: [{ qty: 1, price_unit: 120, ...taxSnapshot(read(tax.db, 'account.tax', tax.id), tax.db) }],
  });
  db = postMove(refund.db, refund.id);
  const postedRefund = read(db, 'account.move', refund.id);

  const release = releaseCashBasis(db, postedRefund, 1, '2026-06-04', { final: true });
  const releaseMove = read(release.db, 'account.move', release.id);
  assert.ok(releaseMove, 'Release move must be created');
  const releaseTaxLine = releaseMove.line_ids.find((l) => l.account_id === taxAccountRef.id);
  assert.ok(releaseTaxLine, 'Release move must post to the refund tax account');
  assert.equal(releaseTaxLine.debit, 24, 'Release move must debit 24 on the refund tax account');
  assert.equal(releaseTaxLine.tax_base, -120, 'Release tax base must be -120');
});

test('qodo 4: refund with differing invoice/refund factors agrees with posted entry under mixed terms and cash rounding', () => {
  let db = seed();
  const taxAccountInv = create(db, 'account.account', { name: 'VAT Invoice Tax 4', code: '251093', account_type: 'liability_current', company_id: 1 });
  const taxAccountRef = create(taxAccountInv.db, 'account.account', { name: 'VAT Refund Tax 4', code: '251094', account_type: 'liability_current', company_id: 1 });

  // Invoice factor 100%, refund side reverse charge (+100%, -100% -> factor 0%)
  const invRows = [
    { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
    { repartition_type: 'tax', factor_percent: 100, account_id: taxAccountInv.id, tag_ids: [] },
  ];
  const refRows = [
    { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
    { repartition_type: 'tax', factor_percent: 100, account_id: taxAccountRef.id, tag_ids: [] },
    { repartition_type: 'tax', factor_percent: -100, account_id: taxAccountInv.id, tag_ids: [] },
  ];
  const tax = create(taxAccountRef.db, 'account.tax', {
    name: 'Diff Tax 20%',
    type_tax_use: 'sale',
    amount: 20,
    amount_type: 'percent',
    price_include: true,
    invoice_repartition_line_ids: invRows,
    refund_repartition_line_ids: refRows,
    company_id: 1,
  });

  // Condition 1: Mixed payment terms
  const mixedTerm = create(tax.db, 'account.payment.term', {
    name: '3% 7 mixed',
    early_discount: true,
    discount_percent: 3,
    discount_days: 7,
    discount_tax_computation: 'mixed',
  });

  const refundMixed = create(mixedTerm.db, 'account.move', {
    move_type: 'out_refund',
    partner_id: 1,
    invoice_payment_term_id: mixedTerm.id,
    invoice_line_ids: [{ qty: 1, price_unit: 120, ...taxSnapshot(read(mixedTerm.db, 'account.tax', tax.id), mixedTerm.db) }],
  });

  const recMixed = read(refundMixed.db, 'account.move', refundMixed.id);
  const postedMixedLines = invoiceLines(refundMixed.db, recMixed);
  const receivableMixedLine = postedMixedLines.find((l) => l.credit > 0 && (l.account === '121000' || l.partner_id));
  const expectedTotalMixed = receivableMixedLine ? receivableMixedLine.credit : 120;
  assert.equal(total(recMixed, refundMixed.db), expectedTotalMixed, 'total(refund, db) under mixed terms must match posted credit note total');

  // Condition 2: Cash rounding with biggest_tax strategy
  const invRows2 = [
    { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
    { repartition_type: 'tax', factor_percent: 100, account_id: taxAccountInv.id, tag_ids: [] },
    { repartition_type: 'tax', factor_percent: -100, account_id: taxAccountRef.id, tag_ids: [] },
  ];
  const refRows2 = [
    { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
    { repartition_type: 'tax', factor_percent: 100, account_id: taxAccountRef.id, tag_ids: [] },
  ];
  const tax2 = create(taxAccountRef.db, 'account.tax', {
    name: 'Diff Tax 20% Excl',
    type_tax_use: 'sale',
    amount: 20,
    amount_type: 'percent',
    price_include: false,
    invoice_repartition_line_ids: invRows2,
    refund_repartition_line_ids: refRows2,
    company_id: 1,
  });

  const cashRounding = create(tax2.db, 'account.cash.rounding', {
    name: '5 Cents Biggest Tax',
    rounding: 0.05,
    rounding_method: 'HALF-UP',
    strategy: 'biggest_tax',
  });

  const refundRounding = create(cashRounding.db, 'account.move', {
    move_type: 'out_refund',
    partner_id: 1,
    invoice_cash_rounding_id: cashRounding.id,
    invoice_line_ids: [{ qty: 1, price_unit: 100.03, ...taxSnapshot(read(cashRounding.db, 'account.tax', tax2.id), cashRounding.db) }],
  });

  const recRounding = read(refundRounding.db, 'account.move', refundRounding.id);
  const postedRoundingLines = invoiceLines(refundRounding.db, recRounding);
  const receivableRoundLine = postedRoundingLines.find((l) => l.credit > 0 && (l.account === '121000' || l.partner_id));
  assert.equal(total(recRounding, refundRounding.db), receivableRoundLine.credit, 'total(refund, db) under cash rounding must match posted credit note total');
  const taxPosted = postedRoundingLines.find((l) => l.tax_id === tax2.id)?.debit;
  assert.equal(invoiceTaxAmount(recRounding, refundRounding.db), taxPosted, 'invoiceTaxAmount under biggest_tax cash rounding must match posted tax');
});

test('qodo 6: reverse-charge expense reports can be submitted, approved, posted, and updated', () => {
  let db = linked();
  const expenseAccount = create(db, 'account.account', { name: 'EU Services Expense', code: '610099', account_type: 'expense', company_id: 1 });
  const taxDedAccount = create(expenseAccount.db, 'account.account', { name: 'EU Input VAT Deductible', code: '131099', account_type: 'asset_current', company_id: 1 });
  const taxDueAccount = create(taxDedAccount.db, 'account.account', { name: 'EU Output VAT Due', code: '251099', account_type: 'liability_current', company_id: 1 });

  const revRows = [
    { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
    { repartition_type: 'tax', factor_percent: 100, account_id: taxDedAccount.id, tag_ids: [] },
    { repartition_type: 'tax', factor_percent: -100, account_id: taxDueAccount.id, tag_ids: [] },
  ];
  const revTax = create(taxDueAccount.db, 'account.tax', {
    name: 'Reverse Charge 20%',
    type_tax_use: 'purchase',
    amount: 20,
    amount_type: 'percent',
    invoice_repartition_line_ids: revRows,
    refund_repartition_line_ids: revRows,
    company_id: 1,
  });

  const journal = search(revTax.db, 'account.journal').find((j) => j.type === 'purchase');
  db = write(revTax.db, 'account.journal', journal.id, { default_account_id: expenseAccount.id });

  // Employee 3 (Youssef), managed by 2 (Mona)
  const expense = create(db, 'hr.expense', {
    name: 'Foreign cloud service',
    employee_id: 3,
    total_amount: 100.00,
    tax: 20,
    tax_id: revTax.id,
    payment_mode: 'own_account',
  });

  const report = createSheet(expense.db, [expense.id], { name: 'Reverse Charge Sheet' });
  const submitted = submitSheet(report.db, report.id);
  const approved = approveSheet(submitted, report.id, 2);

  // Posting the report and saving through authority check as Mona (the manager)
  const posted = postSheet(approved, report.id, '2026-10-01');
  const stored = save(approved, posted, as('mona'));
  let sheetRec = read(stored, 'hr.expense.sheet', report.id);
  assert.equal(sheetRec.state, 'post');
  const entry = read(stored, 'account.move', sheetRec.move_id);
  assert.ok(entry, 'Journal entry for reverse charge expense must exist');
  assert.ok(isBalanced(entry.line_ids), 'Journal entry must be balanced');

  // Also verify reimbursement through authority check as Mona
  const paid = registerPayment(stored, report.id, 100.00, '2026-10-02');
  const storedPaid = save(stored, paid, as('mona'));
  sheetRec = read(storedPaid, 'hr.expense.sheet', report.id);
  assert.equal(sheetRec.state, 'done');
  assert.equal(sheetRec.amount_paid, 100.00);
});
