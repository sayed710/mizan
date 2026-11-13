import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { create, read, search, write } from './orm.js';
import { models } from './models/index.js';
import { seed } from './seed.js';
import { createCompany } from './models/company.js';
import { companyViewDb } from './companyView.js';
import { total } from './models/common.js';
import { discountAvailable, payMove, postMove } from './models/accounting.js';
import { agedBalance } from './models/finance.js';
import { duplicateValues } from './duplicate.js';
import { confirmLoan } from './models/loans.js';
import { handleApi } from '../server/api.js';
import { approveSheet, createSheet, postSheet, registerPayment, submitSheet } from './models/expenseplus.js';
import { budgetReport } from './models/analyticplus.js';
import { applyDiff, diffDb } from './sync.js';
import { fromCsv, importCsvRows, toCsv } from './csv.js';
import { postPayment } from './models/pay.js';
import { taxSnapshot } from './models/taxes.js';
import { formatCurrency } from './money.js';
import { AgedDetailRow } from './views/aged-detail-row.js';
import { budgetCurrency, BudgetMoneyCell } from './views/budget-currency.js';

test('Qodo 4: branch invoice with mixed-discount tax rule and legacy company-1 term in restricted view', () => {
  let db = seed();
  const main = read(db, 'res.company', 1);
  const branchRes = createCompany(db, { name: 'Branch 2', parent_id: 1, currency_id: main.currency_id });
  db = branchRes.db;
  const branch = read(db, 'res.company', branchRes.id);

  const income = create(db, 'account.account', { name: 'Branch Sales', code: '400088', account_type: 'income', company_id: branch.id });
  db = income.db;
  const journal = create(db, 'account.journal', {
    name: 'Branch Sales Journal',
    code: 'BS88',
    type: 'sale',
    company_id: branch.id,
    default_account_id: income.id,
    invoice_sequence_prefix: 'BS88/INV/',
    invoice_sequence_next_number: 1,
  });
  db = journal.db;

  const taxAccount = create(db, 'account.account', { name: 'Branch Output Tax', code: '220088', account_type: 'liability_current', company_id: branch.id });
  db = taxAccount.db;
  const salesTax = create(db, 'account.tax', {
    name: 'Branch Sales 15%',
    type_tax_use: 'sale',
    amount: 15,
    amount_type: 'percent',
    tax_exigibility: 'on_invoice',
    company_id: branch.id,
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null },
      { repartition_type: 'tax', factor_percent: 100, account_id: taxAccount.id },
    ],
  });
  db = salesTax.db;

  // Create this term as branch-owned so the normal create path accepts it.
  const term = create(db, 'account.payment.term', {
    name: 'Company 1 Mixed 5%',
    company_id: branch.id,
    early_discount: true,
    discount_percent: 5,
    discount_days: 10,
    discount_tax_computation: 'mixed',
    line_ids: [{ value: 100, value_type: 'percent', nb_days: 30, delay_type: 'days_after' }],
  });
  db = term.db;

  const unreferencedTerm = create(db, 'account.payment.term', {
    name: 'Company 1 Other Term',
    company_id: 1,
    line_ids: [{ value: 100, value_type: 'percent', nb_days: 15, delay_type: 'days_after' }],
  });
  db = unreferencedTerm.db;

  // Branch invoices reference the term before the legacy company-1 ownership stamp is restored below.
  const inv = create(db, 'account.move', {
    company_id: branch.id,
    journal_id: journal.id,
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-03-01',
    invoice_payment_term_id: term.id,
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 200, tax_ids: [salesTax.id] }],
  });
  db = postMove(inv.db, inv.id);

  // Older posted invoice whose receivable items were later removed from its legacy stored entry.
  const oldInvoiceResult = create(db, 'account.move', {
    company_id: branch.id,
    journal_id: journal.id,
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-01-01',
    invoice_date_due: '2026-01-31',
    invoice_payment_term_id: term.id,
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax_ids: [salesTax.id] }],
  });
  db = postMove(oldInvoiceResult.db, oldInvoiceResult.id);
  const oldInvoice = read(db, 'account.move', oldInvoiceResult.id);

  // Recreate the two legacy conditions after both branch invoices were posted: the term has a company-1 stamp, and
  // the older entry has no receivable lines from which aging can read its original installment schedule.
  db = {
    ...db,
    records: {
      ...db.records,
      'account.move': db.records['account.move'].map((row) => row.id === oldInvoice.id ? {
        ...row,
        line_ids: row.line_ids.filter((line) => read(db, 'account.account', line.account_id)?.account_type !== 'asset_receivable'),
      } : row),
      'account.payment.term': db.records['account.payment.term'].map((row) => row.id === term.id ? { ...row, company_id: 1 } : row),
    },
  };
  const oldInv = read(db, 'account.move', oldInvoice.id);
  const posted = read(db, 'account.move', inv.id);
  assert.equal(oldInv.line_ids.some((line) => read(db, 'account.account', line.account_id)?.account_type === 'asset_receivable'), false);

  const view = companyViewDb({ ...db, settings: { ...db.settings, current_company_id: branch.id, allowed_company_ids: [branch.id] } });

  // 1. Referenced term is preserved in view; unreferenced term remains hidden
  assert.ok(read(view, 'account.payment.term', term.id), 'referenced term is preserved in restricted view');
  assert.ok(!read(view, 'account.payment.term', unreferencedTerm.id), 'unreferenced foreign term is not in restricted view');

  // 2. Totals match between full and restricted view
  assert.equal(total(posted, view), total(posted, db), 'totals match between full and restricted views');
  assert.equal(total(posted, view), posted.amount_total);

  // 3. Early-payment discount is offered in restricted view
  const disc = discountAvailable(view, posted, '2026-03-05');
  assert.ok(disc > 0, 'early-payment discount is available');
  assert.equal(disc, discountAvailable(db, posted, '2026-03-05'));

  // 4. Aging report preserves installment schedule for older posted invoice without receivable items
  const aged = agedBalance(view, 'receivable', '2026-03-15');
  const partnerRow = aged.rows.find((r) => r.partner_id === 1);
  assert.ok(partnerRow, 'partner appears in aged balance');
  const oldInvoiceDetail = partnerRow.invoices.find((detail) => detail.move_id === oldInv.id);
  assert.ok(oldInvoiceDetail, 'older invoice detail is present');
  assert.equal(oldInvoiceDetail.total, oldInv.amount_total, 'legacy term schedule leaves the full invoice open');
  assert.equal(oldInvoiceDetail['31_60'], oldInv.amount_total, 'legacy term due date puts the installment in the 31–60 day bucket');
});

test('Qodo 6: payment releases cash-basis tax to mapped destination account under fiscal position', () => {
  let db = seed();
  const taxAccount = create(db, 'account.account', { code: '220090', name: 'Raw Tax Account', account_type: 'liability_current', company_id: 1 });
  db = taxAccount.db;
  const mappedAccount = create(db, 'account.account', { code: '220091', name: 'Mapped Tax Account', account_type: 'liability_current', company_id: 1 });
  db = mappedAccount.db;
  const transAccount = create(db, 'account.account', { code: '220092', name: 'Tax Transition Account', account_type: 'liability_current', company_id: 1 });
  db = transAccount.db;

  const tax = create(db, 'account.tax', {
    name: 'Cash Basis 10% Mapped',
    type_tax_use: 'sale',
    amount: 10,
    amount_type: 'percent',
    tax_exigibility: 'on_payment',
    cash_basis_transition_account_id: transAccount.id,
    company_id: 1,
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null },
      { repartition_type: 'tax', factor_percent: 100, account_id: taxAccount.id },
    ],
  });
  db = tax.db;

  const fp = create(db, 'account.fiscal.position', {
    name: 'Tax Map FP',
    company_id: 1,
    account_ids: [{ account_src_id: taxAccount.id, account_dest_id: mappedAccount.id }],
  });
  db = fp.db;

  const inv = create(db, 'account.move', {
    company_id: 1,
    move_type: 'out_invoice',
    partner_id: 1,
    fiscal_position_id: fp.id,
    invoice_date: '2026-04-01',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, ...taxSnapshot(read(db, 'account.tax', tax.id), db) }],
  });
  assert.equal(read(inv.db, 'account.tax', tax.id).tax_exigibility, 'on_payment');
  const draftInvoice = read(inv.db, 'account.move', inv.id);
  assert.equal(draftInvoice.invoice_line_ids[0].tax_cash_basis, true, 'invoice line snapshots the configured cash-basis tax');
  db = postMove(inv.db, inv.id);
  const postedInv = read(db, 'account.move', inv.id);

  // Initial posting put tax in transition account
  assert.ok(postedInv.line_ids.some((l) => l.account_id === transAccount.id && Number(l.credit) === 10), 'transition account credited on invoice');

  // Pay invoice in full
  db = payMove(db, postedInv.id, postedInv.amount_total, '2026-04-05');

  // Release entry moves tax from transition to mapped destination account
  const releaseMove = db.records['account.move'].find((m) => m.cash_basis_origin_move_id === postedInv.id && m.state === 'posted');
  assert.ok(releaseMove, 'cash-basis release move created');

  const releaseLines = releaseMove.line_ids;
  assert.ok(releaseLines.some((l) => l.account_id === transAccount.id && Number(l.debit) === 10), 'transition account debited on payment');
  assert.ok(releaseLines.some((l) => l.account_id === mappedAccount.id && Number(l.credit) === 10), 'tax credited to mapped destination account');
  assert.ok(!releaseLines.some((l) => l.account_id === taxAccount.id), 'raw tax account was NOT credited');
});

test('Qodo 7: reimbursement validates against posting journal and posted journal changes are blocked', () => {
  let db = seed();
  const managerCreated = create(db, 'hr.employee', { name: 'Qodo 7 Manager', user_login: 'qodo7.manager' });
  db = managerCreated.db;
  const employeeCreated = create(db, 'hr.employee', { name: 'Qodo 7 Employee', parent_id: managerCreated.id });
  db = employeeCreated.db;
  const emp = read(db, 'hr.employee', employeeCreated.id);
  const mgr = read(db, 'hr.employee', managerCreated.id);

  const origExpenseAcc = create(db, 'account.account', { code: '600098', name: 'Original Expense Acc', account_type: 'expense', company_id: 1 });
  db = origExpenseAcc.db;
  // Original expense journal
  const origJournal = create(db, 'account.journal', {
    name: 'Orig Expense Journal',
    code: 'OEXP',
    type: 'general',
    company_id: 1,
    default_account_id: origExpenseAcc.id,
  });
  db = origJournal.db;

  // Second journal with different default expense account
  const diffExpenseAcc = create(db, 'account.account', { code: '600099', name: 'Other Expense Acc', account_type: 'expense', company_id: 1 });
  db = diffExpenseAcc.db;
  const newJournal = create(db, 'account.journal', {
    name: 'New Expense Journal',
    code: 'NEXP',
    type: 'general',
    company_id: 1,
    default_account_id: diffExpenseAcc.id,
  });
  db = newJournal.db;

  const exp = create(db, 'hr.expense', {
    name: 'Lunch',
    employee_id: emp.id,
    total_amount: 50,
    payment_mode: 'own_account',
    tax: 0,
    company_id: 1,
  });
  db = exp.db;

  const sheetCreated = createSheet(db, [exp.id], { name: 'EXP/QODO7' });
  db = write(sheetCreated.db, 'hr.expense.sheet', sheetCreated.id, { expense_journal_id: origJournal.id, manager_id: mgr.id });
  let sheet = read(db, 'hr.expense.sheet', sheetCreated.id);

  db = submitSheet(db, sheet.id);
  db = approveSheet(db, sheet.id, mgr.id);
  db = postSheet(db, sheet.id, '2026-04-01');

  sheet = read(db, 'hr.expense.sheet', sheet.id);
  assert.equal(sheet.state, 'post');

  // Guard blocks changing expense_journal_id on posted report
  assert.throws(
    () => write(db, 'hr.expense.sheet', sheet.id, { expense_journal_id: newJournal.id }),
    /expense journal cannot be changed on a posted expense report/i,
  );

  // Simulate a legacy report whose journal was changed before the immutability guard existed.
  const forcedDb = {
    ...db,
    records: {
      ...db.records,
      'hr.expense.sheet': db.records['hr.expense.sheet'].map((s) => (s.id === sheet.id ? { ...s, expense_journal_id: newJournal.id } : s)),
    },
  };

  const reimbursementCandidate = registerPayment(forcedDb, sheet.id, 50, '2026-04-02');
  const reimbursed = applyDiff(forcedDb, diffDb(forcedDb, reimbursementCandidate), { isAdmin: false, login: 'qodo7.manager' });
  const paidSheet = read(reimbursed, 'hr.expense.sheet', sheet.id);
  assert.equal(paidSheet.state, 'done');
  assert.equal(paidSheet.amount_paid, 50);
});

test('Qodo 8: loan duplicate preserves posting accounts, CSV import imports them, and API metadata reports them editable', () => {
  let db = seed();
  const bankAcc = create(db, 'account.account', { code: '101088', name: 'Loan Bank Acc', account_type: 'asset_cash', company_id: 1 });
  db = bankAcc.db;
  const princAcc = create(db, 'account.account', { code: '201088', name: 'Loan Principal Acc', account_type: 'liability_current', company_id: 1 });
  db = princAcc.db;
  const intAcc = create(db, 'account.account', { code: '601088', name: 'Loan Interest Acc', account_type: 'expense', company_id: 1 });
  db = intAcc.db;
  const journal = create(db, 'account.journal', { code: 'LNJ88', name: 'Loan Journal', type: 'general', company_id: 1 });
  db = journal.db;

  const loan = create(db, 'account.loan', {
    name: 'Original Loan',
    lender_id: 1,
    amount: 10000,
    duration: 12,
    interest_rate: 5,
    method: 'annuity',
    start_date: '2026-01-01',
    journal_id: journal.id,
    bank_account_id: bankAcc.id,
    principal_account_id: princAcc.id,
    interest_account_id: intAcc.id,
    company_id: 1,
  });
  db = confirmLoan(loan.db, read(loan.db, 'account.loan', loan.id));
  const running = read(db, 'account.loan', loan.id);
  assert.equal(running.state, 'running');

  // 1. duplicateValues preserves the four fields
  const dupVals = duplicateValues('account.loan', running);
  assert.equal(dupVals.journal_id, journal.id, 'journal_id preserved in copy');
  assert.equal(dupVals.bank_account_id, bankAcc.id, 'bank_account_id preserved in copy');
  assert.equal(dupVals.principal_account_id, princAcc.id, 'principal_account_id preserved in copy');
  assert.equal(dupVals.interest_account_id, intAcc.id, 'interest_account_id preserved in copy');

  // 2. Confirming the duplicated loan succeeds without re-entering accounts
  const createdCopy = create(db, 'account.loan', dupVals);
  db = confirmLoan(createdCopy.db, read(createdCopy.db, 'account.loan', createdCopy.id));
  const runningCopy = read(db, 'account.loan', createdCopy.id);
  assert.equal(runningCopy.state, 'running');

  // 3. CSV import evaluates conditional readonly fields against a new draft record.
  const existingIds = new Set(search(db, 'account.loan').map((record) => record.id));
  const lender = read(db, 'res.partner', 1);
  const company = read(db, 'res.company', 1);
  const csv = toCsv([
    ['name', 'lender_id', 'amount', 'start_date', 'duration', 'interest_rate', 'method', 'journal_id', 'bank_account_id', 'principal_account_id', 'interest_account_id', 'company_id'],
    ['Imported Loan', String(lender.id), '2500', '2026-01-01', '12', '5', 'annuity', String(journal.id), String(bankAcc.id), String(princAcc.id), String(intAcc.id), String(company.id)],
  ]);
  const imported = importCsvRows(db, 'account.loan', models['account.loan'].defaults(0), fromCsv(csv));
  assert.equal(imported.count, 1, 'one loan imported');
  const importedLoan = search(imported.db, 'account.loan').find((record) => !existingIds.has(record.id));
  assert.ok(importedLoan, 'imported loan record created');
  assert.equal(importedLoan.journal_id, journal.id);
  assert.equal(importedLoan.bank_account_id, bankAcc.id);
  assert.equal(importedLoan.principal_account_id, princAcc.id);
  assert.equal(importedLoan.interest_account_id, intAcc.id);
  const bookedImport = confirmLoan(imported.db, importedLoan);
  assert.equal(read(bookedImport, 'account.loan', importedLoan.id).state, 'running', 'imported loan confirms without re-entering accounts');

  // 4. API model metadata reports these fields editable (readonly: false) for draft creation.
  const modelsRes = handleApi({ method: 'GET', path: '/api/v1/models', db: bookedImport, user: { name: 'admin', isAdmin: true } });
  const loanMeta = modelsRes.body.find((m) => m.model === 'account.loan');
  assert.ok(loanMeta, 'account.loan metadata found');
  assert.equal(loanMeta.fields.journal_id.readonly, false, 'journal_id is not readonly in API metadata');
  assert.equal(loanMeta.fields.bank_account_id.readonly, false, 'bank_account_id is not readonly in API metadata');
  assert.equal(loanMeta.fields.principal_account_id.readonly, false, 'principal_account_id is not readonly in API metadata');
  assert.equal(loanMeta.fields.interest_account_id.readonly, false, 'interest_account_id is not readonly in API metadata');
});

test('Qodo 12: budget amount cells use the assigned company currency', () => {
  let db = seed();
  // Ensure EUR currency exists
  let eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  if (!eur) {
    const res = create(db, 'res.currency', { name: 'EUR', symbol: '€', rounding: 0.01 });
    db = res.db;
    eur = read(db, 'res.currency', res.id);
  }
  const companyRes = createCompany(db, { name: 'EUR Company', currency_id: eur.id });
  db = companyRes.db;
  const eurCompany = read(db, 'res.company', companyRes.id);

  const analytic = create(db, 'account.analytic.account', { name: 'EUR Project', company_id: eurCompany.id });
  db = analytic.db;

  const budget = create(db, 'account.budget', {
    name: 'EUR Branch Budget',
    company_id: eurCompany.id,
    date_from: '2026-01-01',
    date_to: '2026-12-31',
    state: 'confirm',
    lines: [{
      analytic_account_id: analytic.id,
      planned: 5000,
      general_account: '6',
    }],
  });
  db = budget.db;

  // The active company is company 1 (USD), while this budget belongs to the EUR branch.
  const company1 = read(db, 'res.company', 1);
  const usd = read(db, 'res.currency', company1.currency_id);
  assert.equal(usd.name, 'USD');
  const budgetRecord = read(db, 'account.budget', budget.id);
  const budgetCompany = read(db, 'res.company', budgetRecord.company_id);
  const assignedCurrency = budgetCurrency(db, budgetCompany.id);
  assert.equal(assignedCurrency.name, 'EUR');

  const repLines = budgetReport(db, budget.id, '2026-06-30', { company_id: eurCompany.id });
  assert.equal(repLines.length, 1);
  assert.equal(repLines[0].planned, 5000);

  const formatter = (value, code, currency) => formatCurrency(value, currency, code);
  const markup = renderToStaticMarkup(createElement('table', null, createElement('tbody', null,
    ...[repLines[0].planned, repLines[0].practical, repLines[0].committed, repLines[0].variance]
      .map((value, index) => createElement(BudgetMoneyCell, { key: index, value, currency: assignedCurrency, money: formatter })))));
  assert.equal((markup.match(/<td/g) ?? []).length, 4, 'planned, actual, committed and variance each render through the currency cell');
  assert.match(markup, /€/u, 'budget cells render the company currency');
  assert.ok(!markup.includes('$'), 'budget cells do not retain the active USD symbol');
  assert.match(markup, /5,000/);
});

test('Qodo 14: unapplied payments render as linked detail rows summing to aged partner totals', () => {
  let db = seed();
  const partner = read(db, 'res.partner', 1);

  const bankAccount = create(db, 'account.account', { code: '101089', name: 'Aging Payment Bank', account_type: 'asset_cash', company_id: 1 });
  db = bankAccount.db;
  const bankJournal = create(db, 'account.journal', { code: 'AGB88', name: 'Aging Payment Bank', type: 'bank', default_account_id: bankAccount.id, suspense_account_id: bankAccount.id, company_id: 1 });
  db = bankJournal.db;

  // Post an advance before the invoice exists, so the public payment workflow leaves it unapplied.
  const pmt = create(db, 'account.payment', {
    payment_type: 'inbound',
    partner_type: 'customer',
    partner_id: partner.id,
    amount: 200,
    date: '2026-01-15',
    journal_id: bankJournal.id,
    company_id: 1,
  });
  db = postPayment(pmt.db, read(pmt.db, 'account.payment', pmt.id));
  const postedPayment = read(db, 'account.payment', pmt.id);
  const paymentMove = read(db, 'account.move', postedPayment.move_id);
  assert.equal(postedPayment.state, 'posted');

  // 1. Invoice of 500
  const inv = create(db, 'account.move', {
    company_id: 1,
    move_type: 'out_invoice',
    partner_id: partner.id,
    invoice_date: '2026-02-01',
    invoice_date_due: '2026-02-15',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 500, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);
  const postedInv = read(db, 'account.move', inv.id);

  // 2. Aged balance at 2026-03-01
  const aged = agedBalance(db, 'receivable', '2026-03-01');
  const partnerRow = aged.rows.find((r) => r.partner_id === partner.id);
  assert.ok(partnerRow, 'partner is in aged balance');

  // Verify partner summary total is net (500 - 200 = 300)
  assert.equal(partnerRow.total, 300);

  // Verify r.invoices has detail rows for BOTH invoice and payment
  assert.equal(partnerRow.invoices.length, 2, 'two detail rows: invoice and unapplied payment');
  const invDetail = partnerRow.invoices.find((i) => i.move_id === postedInv.id);
  const pmtDetail = partnerRow.invoices.find((i) => i.move_id === paymentMove.id);
  assert.ok(invDetail, 'invoice detail row present');
  assert.ok(pmtDetail, 'payment detail row present');
  assert.equal(invDetail.total, 500);
  assert.equal(pmtDetail.total, -200);

  // Verify visible details sum to partner's summary for every bucket and total
  for (const [bucket] of aged.buckets) {
    const detailSum = partnerRow.invoices.reduce((s, d) => s + (d[bucket] || 0), 0);
    assert.equal(Math.round(detailSum * 100) / 100, Math.round(partnerRow[bucket] * 100) / 100, `bucket ${bucket} sums match`);
  }
  const detailTotalSum = partnerRow.invoices.reduce((s, d) => s + (d.total || 0), 0);
  assert.equal(Math.round(detailTotalSum * 100) / 100, partnerRow.total, 'detail totals sum to partner total');

  // Render the same row used by the expanded Reports view; the payment entry link and signed credit stay visible.
  const detailMarkup = renderToStaticMarkup(createElement(AgedDetailRow, { buckets: aged.buckets, detail: pmtDetail, money: (value) => String(value) }));
  assert.ok(detailMarkup.includes(`#/open/account.move/${paymentMove.id}`), 'expanded detail links to the payment journal entry');
  assert.ok(detailMarkup.includes(paymentMove.name), 'expanded detail labels the linked payment entry');
  assert.ok(detailMarkup.includes('-200'), 'expanded detail renders the signed payment credit');
});
