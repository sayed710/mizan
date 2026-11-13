import { createCompanyWithDefaultInvoiceJournals } from './test-support/accounting-company.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './models/index.js';
import { models } from './models/index.js';
import { seed } from './seed.js';
import { create, read, search, write } from './orm.js';
import { postMove, payWithDiscount } from './models/accounting.js';
import { postBatch } from './models/payments.js';
import { reversePayment } from './models/pay.js';
import { accountId, journalItems } from './models/ledger.js';
import { defaultTaxRepartitionLines, taxSnapshot } from './models/taxes.js';
import { taxesByTax } from './models/finance.js';
import {currentCompany} from './models/company.js';
import { customerStatement } from './models/reports.js';
import { recordAnalyses } from './models/analysis.js';

const runBtn = (db, model, id, label) => models[model].form.buttons.find((b) => b.label === label).run(db, read(db, model, id)).db;

test('Item 1: One bank statement line matches a batch payment (several outstanding payments) and undo restores every payment', () => {
  let db = seed();
  db = write(db, 'res.company', 1, { outstanding_payments_account_id: accountId(db, '101403') });
  const journal = search(db, 'account.journal').find((j) => j.code === 'BNK1');

  const lines = [];
  for (const amount of [75, 25]) {
    const m = create(db, 'account.move', {
      move_type: 'in_invoice',
      partner_id: 3,
      invoice_date: '2025-01-01',
      invoice_line_ids: [{ qty: 1, price_unit: amount, tax: 0 }],
    });
    db = postMove(m.db, m.id);
    lines.push({ move_id: m.id, amount });
  }

  const batch = create(db, 'account.batch.payment', {
    batch_type: 'outbound',
    journal_id: journal.id,
    check_number_start: 900,
    date: '2025-01-02',
    lines,
  });
  db = postBatch(batch.db, read(batch.db, 'account.batch.payment', batch.id));
  const postedBatch = read(db, 'account.batch.payment', batch.id);
  const p1 = read(db, 'account.payment', postedBatch.lines[0].payment_id);
  const p2 = read(db, 'account.payment', postedBatch.lines[1].payment_id);

  const stmt = create(db, 'account.bank.statement.line', {
    journal_id: journal.id,
    date: '2025-01-03',
    amount: -100,
    batch_payment_id: batch.id,
    payment_ref: postedBatch.name,
  });

  // Matching 100 statement line against batch of 75 and 25 must succeed
  db = runBtn(stmt.db, 'account.bank.statement.line', stmt.id, 'Match Payment');
  const matchedLine = read(db, 'account.bank.statement.line', stmt.id);
  assert.equal(matchedLine.state, 'reconciled');
  assert.equal(matchedLine.open_amount, 0);

  const bankEntry = read(db, 'account.move', matchedLine.bank_move_id);
  assert.equal(bankEntry.state, 'posted');
  const bankAccount = accountId(db, '101401');
  const outstandingAccount = accountId(db, '101403');

  // Bank entry has 1 credit line for bank account (100) and debit lines clearing each payment (75 and 25)
  const bankLines = bankEntry.line_ids.filter((l) => l.account_id === bankAccount);
  assert.equal(bankLines.length, 1);
  assert.equal(bankLines[0].credit, 100);

  const outstandingItems = bankEntry.line_ids.filter((l) => l.account_id === outstandingAccount);
  assert.equal(outstandingItems.length, 2);
  assert.deepEqual(outstandingItems.map((l) => l.debit).sort(), [25, 75]);

  // Double matching guards: another statement line matching either payment must be rejected
  const dup1 = create(db, 'account.bank.statement.line', { journal_id: journal.id, date: '2025-01-04', amount: -75, payment_id: p1.id, payment_ref: 'dup1' });
  assert.throws(() => runBtn(dup1.db, 'account.bank.statement.line', dup1.id, 'Match Payment'), /already matched/);

  const dup2 = create(db, 'account.bank.statement.line', { journal_id: journal.id, date: '2025-01-04', amount: -25, payment_id: p2.id, payment_ref: 'dup2' });
  assert.throws(() => runBtn(dup2.db, 'account.bank.statement.line', dup2.id, 'Match Payment'), /already matched/);

  // While reconciled, reversing any matched payment is blocked
  assert.throws(() => reversePayment(db, p1, '2025-01-04'), /reconciled bank transaction/);
  assert.throws(() => reversePayment(db, p2, '2025-01-04'), /reconciled bank transaction/);

  // Undo (unreconcile) restores every payment
  db = runBtn(db, 'account.bank.statement.line', stmt.id, 'Unreconcile');
  const restoredLine = read(db, 'account.bank.statement.line', stmt.id);
  assert.equal(restoredLine.state, 'to_check');
  assert.equal(restoredLine.move_id, null);
  assert.equal(restoredLine.bank_move_id, null);

  // Payments remain posted
  assert.equal(read(db, 'account.payment', p1.id).state, 'posted');
  assert.equal(read(db, 'account.payment', p2.id).state, 'posted');

  // After undo, a payment can be reversed, cancelling its check on the batch
  db = reversePayment(db, read(db, 'account.payment', p1.id), '2025-01-04');
  const batchAfterReversal = read(db, 'account.batch.payment', batch.id);
  assert.equal(batchAfterReversal.lines[0].cancelled, true);
  assert.equal(read(db, 'account.payment', p1.id).state, 'reversed');
  assert.equal(batchAfterReversal.lines[1].cancelled, false);
  assert.equal(read(db, 'account.payment', p2.id).state, 'posted');
});

test('Item 1b: Matching explicit payment_ids list clears outstanding items and undo restores payments', () => {
  let db = seed();
  db = write(db, 'res.company', 1, { outstanding_payments_account_id: accountId(db, '101403') });
  const journal = search(db, 'account.journal').find((j) => j.code === 'BNK1');

  const lines = [];
  for (const amount of [60, 40]) {
    const m = create(db, 'account.move', {
      move_type: 'in_invoice',
      partner_id: 3,
      invoice_date: '2025-01-01',
      invoice_line_ids: [{ qty: 1, price_unit: amount, tax: 0 }],
    });
    db = postMove(m.db, m.id);
    lines.push({ move_id: m.id, amount });
  }

  const batch = create(db, 'account.batch.payment', {
    batch_type: 'outbound',
    journal_id: journal.id,
    check_number_start: 950,
    date: '2025-01-02',
    lines,
  });
  db = postBatch(batch.db, read(batch.db, 'account.batch.payment', batch.id));
  const postedBatch = read(db, 'account.batch.payment', batch.id);
  const p1 = read(db, 'account.payment', postedBatch.lines[0].payment_id);
  const p2 = read(db, 'account.payment', postedBatch.lines[1].payment_id);

  const stmt = create(db, 'account.bank.statement.line', {
    journal_id: journal.id,
    date: '2025-01-03',
    amount: -100,
    payment_ids: [p1.id, p2.id],
    payment_ref: 'Multi-payment match',
  });

  db = runBtn(stmt.db, 'account.bank.statement.line', stmt.id, 'Match Payment');
  const matched = read(db, 'account.bank.statement.line', stmt.id);
  assert.equal(matched.state, 'reconciled');
  assert.equal(matched.open_amount, 0);

  // Undo restores payments
  db = runBtn(db, 'account.bank.statement.line', stmt.id, 'Unreconcile');
  assert.equal(read(db, 'account.bank.statement.line', stmt.id).state, 'to_check');
  assert.equal(read(db, 'account.payment', p1.id).state, 'posted');
  assert.equal(read(db, 'account.payment', p2.id).state, 'posted');
});

test('Item 1c: A single selected payment belonging to a batch matches only that payment and is rejected when amounts differ', () => {
  let db = seed();
  db = write(db, 'res.company', 1, { outstanding_payments_account_id: accountId(db, '101403') });
  const journal = search(db, 'account.journal').find((j) => j.code === 'BNK1');

  const lines = [];
  for (const amount of [75, 25]) {
    const m = create(db, 'account.move', {
      move_type: 'in_invoice',
      partner_id: 3,
      invoice_date: '2025-01-01',
      invoice_line_ids: [{ qty: 1, price_unit: amount, tax: 0 }],
    });
    db = postMove(m.db, m.id);
    lines.push({ move_id: m.id, amount });
  }

  const batch = create(db, 'account.batch.payment', {
    batch_type: 'outbound',
    journal_id: journal.id,
    check_number_start: 910,
    date: '2025-01-02',
    lines,
  });
  db = postBatch(batch.db, read(batch.db, 'account.batch.payment', batch.id));
  const postedBatch = read(db, 'account.batch.payment', batch.id);
  const p1 = read(db, 'account.payment', postedBatch.lines[0].payment_id);
  const p2 = read(db, 'account.payment', postedBatch.lines[1].payment_id);

  // When amounts differ (statement line 100, single payment 75): must be rejected with the total mismatch message
  const diffStmt = create(db, 'account.bank.statement.line', {
    journal_id: journal.id,
    date: '2025-01-03',
    amount: -100,
    payment_id: p1.id,
    payment_ref: 'Diff amount',
  });
  assert.throws(
    () => runBtn(diffStmt.db, 'account.bank.statement.line', diffStmt.id, 'Match Payment'),
    /The selected payments must total the bank transaction amount/
  );

  // When amounts match (statement line 75, single payment 75): matches ONLY that payment
  const stmt = create(db, 'account.bank.statement.line', {
    journal_id: journal.id,
    date: '2025-01-03',
    amount: -75,
    payment_id: p1.id,
    payment_ref: 'Single payment match',
  });
  db = runBtn(stmt.db, 'account.bank.statement.line', stmt.id, 'Match Payment');
  const matched = read(db, 'account.bank.statement.line', stmt.id);
  assert.equal(matched.state, 'reconciled');
  assert.equal(matched.open_amount, 0);
  assert.equal(matched.payment_id, p1.id);
  assert.equal(matched.batch_payment_id, null);
  assert.deepEqual(matched.payment_ids, [p1.id]);

  // Only p1's outstanding item is cleared in the bank entry
  const bankEntry = read(db, 'account.move', matched.bank_move_id);
  const outstandingAccount = accountId(db, '101403');
  const clearedLines = bankEntry.line_ids.filter((l) => l.account_id === outstandingAccount);
  assert.equal(clearedLines.length, 1);
  assert.equal(clearedLines[0].debit, 75);

  // p1 is matched (reversal blocked), but p2 is NOT matched
  assert.throws(() => reversePayment(db, p1, '2025-01-04'), /reconciled bank transaction/);
  // p2 can be matched independently by another statement line
  const stmt2 = create(db, 'account.bank.statement.line', {
    journal_id: journal.id,
    date: '2025-01-03',
    amount: -25,
    payment_id: p2.id,
    payment_ref: 'Second payment match',
  });
  db = runBtn(stmt2.db, 'account.bank.statement.line', stmt2.id, 'Match Payment');
  assert.equal(read(db, 'account.bank.statement.line', stmt2.id).state, 'reconciled');
});

test('Item 1d: Statement line open amount mismatch with selected payments throws exact message', () => {
  let db = seed();
  db = write(db, 'res.company', 1, { outstanding_payments_account_id: accountId(db, '101403') });
  const journal = search(db, 'account.journal').find((j) => j.code === 'BNK1');

  const m = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 3,
    invoice_date: '2025-01-01',
    invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(m.db, m.id);

  const batch = create(db, 'account.batch.payment', {
    batch_type: 'outbound',
    journal_id: journal.id,
    check_number_start: 920,
    date: '2025-01-02',
    lines: [{ move_id: m.id, amount: 100 }],
  });
  db = postBatch(batch.db, read(batch.db, 'account.batch.payment', batch.id));
  const postedBatch = read(db, 'account.batch.payment', batch.id);
  const payment = read(db, 'account.payment', postedBatch.lines[0].payment_id);

  const stmt = create(db, 'account.bank.statement.line', {
    journal_id: journal.id,
    date: '2025-01-03',
    amount: -80,
    payment_id: payment.id,
    payment_ref: 'Mismatch',
  });

  assert.throws(
    () => runBtn(stmt.db, 'account.bank.statement.line', stmt.id, 'Match Payment'),
    (err) => err.message === 'The selected payments must total the bank transaction amount'
  );
});

test('Item 1e: Statement line rejects batch_payment_id from another company', () => {
  let db = seed();
  const c2 = createCompanyWithDefaultInvoiceJournals(db, { name: 'Branch 2' });
  db = c2.db;

  const bill2 = create(db, 'account.move', {
    company_id: c2.id,
    move_type: 'in_invoice',
    partner_id: 3,
    invoice_date: '2025-01-01',
    invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(bill2.db, bill2.id);

  const liquidity = create(db, 'account.account', { name: 'Bank 2 Liquidity', code: '999802', account_type: 'asset_cash', company_id: c2.id });
  const journal2 = create(liquidity.db, 'account.journal', { name: 'Bank 2', code: 'BNK2', type: 'bank', company_id: c2.id, default_account_id: liquidity.id, suspense_account_id: liquidity.id });
  db = journal2.db;

  const batch2 = create(db, 'account.batch.payment', {
    company_id: c2.id,
    batch_type: 'outbound',
    journal_id: journal2.id,
    check_number_start: 500,
    date: '2025-01-02',
    lines: [{ move_id: bill2.id, amount: 100 }],
  });
  db = postBatch(batch2.db, read(batch2.db, 'account.batch.payment', batch2.id));

  const journal1 = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);

  // lineGuard rejects creating a statement line in company 1 with batch from company 2
  assert.throws(
    () => create(db, 'account.bank.statement.line', {
      company_id: 1,
      journal_id: journal1.id,
      date: '2025-01-03',
      amount: -100,
      batch_payment_id: batch2.id,
      payment_ref: 'Cross-company batch',
    }),
    /The linked payment belongs to another company or does not exist/
  );

  // lineGuard rejects writing batch from company 2 onto an existing company 1 line
  const stmt1 = create(db, 'account.bank.statement.line', {
    company_id: 1,
    journal_id: journal1.id,
    date: '2025-01-03',
    amount: -100,
    payment_ref: 'Co1 line',
  });
  assert.throws(
    () => write(stmt1.db, 'account.bank.statement.line', stmt1.id, { batch_payment_id: batch2.id }),
    /The linked payment belongs to another company or does not exist/
  );
});

test('Item 2: Early payment discount on a cash-basis vendor bill clears transition account to 0', () => {
  let db = seed();
  const tax = create(db, 'account.tax', {
    name: 'Vendor cash VAT',
    amount: 14,
    type_tax_use: 'purchase',
    tax_exigibility: 'on_payment', cash_basis_transition_account_id: accountId(db, '131100'),
    account_id: accountId(db, '131000'), ...defaultTaxRepartitionLines(accountId(db, '131000')),
  });
  const term = create(tax.db, 'account.payment.term', {
    name: '2% tax included',
    early_discount: true,
    discount_percent: 2,
    discount_days: 10,
    discount_tax_computation: 'included',
  });
  const bill = create(term.db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 3,
    invoice_date: '2039-01-01',
    invoice_payment_term_id: term.id,
    invoice_line_ids: [{ qty: 1, price_unit: 100, ...taxSnapshot(read(term.db, 'account.tax', tax.id)) }],
  });
  db = postMove(bill.db, bill.id);
  db = payWithDiscount(db, bill.id, 111.72, '2039-01-05');

  const items = journalItems(db, { from: '2039-01-01', to: '2039-01-31' });
  const balance = (code) => ((Math.round(items.filter((l) => l.account_id === accountId(db, code)).reduce((s, l) => s + l.debit - l.credit, 0) * 100) / 100) + 0) || 0;

  assert.equal(read(db, 'account.move', bill.id).amount_residual, 0);
  assert.equal(balance('131100'), 0); // Transition account must end at 0
  assert.equal(balance('131000'), 13.72); // Released tax reduced by discount tax share (0.28)
  assert.equal(balance('101401'), -111.72);
  assert.equal(balance('450200'), -2.00); // Discount income net of tax share

  const taxRows = taxesByTax(db, { from: '2039-01-01', to: '2039-01-31' }).filter((r) => r.name === 'Vendor cash VAT');
  assert.equal(taxRows.length, 1);
  assert.equal(taxRows[0].tax, 13.72);
  assert.equal(taxRows[0].base, 98);
});

test('Item 2b: Early payment discount on a cash-basis customer invoice clears transition account to 0', () => {
  let db = seed();
  const tax = create(db, 'account.tax', {
    name: 'Customer cash VAT',
    amount: 14,
    type_tax_use: 'sale',
    tax_exigibility: 'on_payment', cash_basis_transition_account_id: accountId(db, '251100'),
    account_id: accountId(db, '251000'), ...defaultTaxRepartitionLines(accountId(db, '251000')),
  });
  const term = create(tax.db, 'account.payment.term', {
    name: '2% customer discount included',
    early_discount: true,
    discount_percent: 2,
    discount_days: 10,
    discount_tax_computation: 'included',
  });
  const inv = create(term.db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 3,
    invoice_date: '2039-01-01',
    invoice_payment_term_id: term.id,
    invoice_line_ids: [{ qty: 1, price_unit: 100, ...taxSnapshot(read(term.db, 'account.tax', tax.id)) }],
  });
  db = postMove(inv.db, inv.id);
  db = payWithDiscount(db, inv.id, 111.72, '2039-01-05');

  const items = journalItems(db, { from: '2039-01-01', to: '2039-01-31' });
  const balance = (code) => ((Math.round(items.filter((l) => l.account_id === accountId(db, code)).reduce((s, l) => s + l.debit - l.credit, 0) * 100) / 100) + 0) || 0;

  assert.equal(read(db, 'account.move', inv.id).amount_residual, 0);
  assert.equal(balance('251100'), 0); // Transition account must end at 0
  assert.equal(balance('251000'), -13.72); // Released tax (credit 13.72)
  assert.equal(balance('101401'), 111.72);
  assert.equal(balance('690200'), 2.00); // Discount expense net of tax share

  const taxRows = taxesByTax(db, { from: '2039-01-01', to: '2039-01-31' }).filter((r) => r.name === 'Customer cash VAT');
  assert.equal(taxRows.length, 1);
  assert.equal(taxRows[0].tax, 13.72);
  assert.equal(taxRows[0].base, 98);
});

test('Item 3: Customer Statement scopes to company and defaults to current company', () => {
  let db = seed();
  const c1 = 1;
  const c2 = createCompanyWithDefaultInvoiceJournals(db, { name: 'Branch 2', currency_id: db.records['res.company'][0].currency_id });
  db = c2.db;

  const partner = create(db, 'res.partner', { name: 'Multi-Company Client' });
  db = partner.db;

  const yr = (db.records['account.move']?.[0]?.invoice_date ?? '2026').slice(0, 4);

  // Company 1: Invoice of 100
  const inv1 = create(db, 'account.move', {
    company_id: c1,
    move_type: 'out_invoice',
    partner_id: partner.id,
    invoice_date: `${yr}-01-10`,
    invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(inv1.db, inv1.id);

  // Company 2: Invoice of 250
  const inv2 = create(db, 'account.move', {
    company_id: c2.id,
    move_type: 'out_invoice',
    partner_id: partner.id,
    invoice_date: `${yr}-01-15`,
    invoice_line_ids: [{ qty: 1, price_unit: 250, tax: 0 }],
  });
  db = postMove(inv2.db, inv2.id);

  // Explicit company_id scoping
  const stmtC1 = customerStatement(db, partner.id, { from: `${yr}-01-01`, to: `${yr}-01-31`, company_id: c1 });
  assert.equal(stmtC1.closing, 100);
  assert.equal(stmtC1.lines.length, 1);

  const stmtC2 = customerStatement(db, partner.id, { from: `${yr}-01-01`, to: `${yr}-01-31`, company_id: c2.id });
  assert.equal(stmtC2.closing, 250);
  assert.equal(stmtC2.lines.length, 1);

  // Opening balance calculation with itemsBefore and company_id
  const stmtOpeningC1 = customerStatement(db, partner.id, { from: `${yr}-01-12`, to: `${yr}-01-31`, company_id: c1 });
  assert.equal(stmtOpeningC1.opening, 100);
  assert.equal(stmtOpeningC1.lines.length, 0);
  assert.equal(stmtOpeningC1.closing, 100);

  const stmtOpeningC2 = customerStatement(db, partner.id, { from: `${yr}-01-12`, to: `${yr}-01-31`, company_id: c2.id });
  assert.equal(stmtOpeningC2.opening, 0);
  assert.equal(stmtOpeningC2.lines.length, 1);
  assert.equal(stmtOpeningC2.closing, 250);

  // Defaulting to current company (default is 1)
  assert.equal(currentCompany(db), 1);
  const stmtDefault = customerStatement(db, partner.id, { from: `${yr}-01-01`, to: `${yr}-01-31` });
  assert.equal(stmtDefault.closing, 100);
  assert.equal(stmtDefault.lines.length, 1);

  // When current company is set to c2.id
  const dbWithC2 = { ...db, settings: { ...db.settings, current_company_id: c2.id } };
  assert.equal(currentCompany(dbWithC2), c2.id);
  const stmtC2Default = customerStatement(dbWithC2, partner.id, { from: `${yr}-01-01`, to: `${yr}-01-31` });
  assert.equal(stmtC2Default.closing, 250);
  assert.equal(stmtC2Default.lines.length, 1);

  // Analysis menu caller passes current company
  const analysisBtn = recordAnalyses['res.partner'].find((a) => a.label === 'Customer Statement This Year');
  assert.ok(analysisBtn);
  const partnerRec = read(db, 'res.partner', partner.id);
  const analysisResult = analysisBtn.run(db, partnerRec);
  assert.equal(analysisResult.closing, 100);
  assert.equal(analysisResult.lines.length, 1);
});
