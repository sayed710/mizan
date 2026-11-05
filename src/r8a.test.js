import { createCompanyWithDefaultInvoiceJournals } from './test-support/accounting-company.js';
import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, updateSettings, write } from './orm.js';
import { models } from './models/index.js';
import { seed } from './seed.js';
import { postMove } from './models/accounting.js';
import { accountId, isBalanced, journalItems, profitAndLoss, postEntry } from './models/ledger.js';
import { closingModels, foreignBalanceReport, revalueForeignBalances } from './models/closing.js';
import { candidates } from './models/bank.js';
import { taxReport, validateTaxReturnPeriod } from './models/finance.js';
import { computeAuditChecks } from './models/taxreturn.js';
import { rateAt, toCompany } from './models/currency.js';
import { taxSnapshot } from './models/taxes.js';
import { configureRevaluationLoss } from './test-support/revaluation-accounts.js';

const LINE = 'account.bank.statement.line';
const bankJournalId = (db) => search(db, 'account.journal').find((j) => j.type === 'bank').id;
const run = (db, model, id, label, values = []) => models[model].form.buttons.find((button) => button.label === label)
  .run(db, read(db, model, id), values).db;
const invoice = (db, { type = 'out_invoice', partner, company = 1, currency = null, date, invoiceDate = date, amount }) => {
  const made = create(db, 'account.move', {
    move_type: type, partner_id: partner, company_id: company, currency_id: currency,
    date, invoice_date: invoiceDate,
    invoice_line_ids: [{ name: 'Service', qty: 1, price_unit: amount, tax: 0 }],
  });
  return { db: postMove(made.db, made.id), id: made.id };
};

test('ledger reports use the accounting date when it differs from the bill date', () => {
  const db = seed();
  const bill = invoice(db, { type: 'in_invoice', partner: 3, invoiceDate: '2030-12-31', date: '2031-01-05', amount: 100 });
  const december = journalItems(bill.db, { from: '2030-12-01', to: '2030-12-31' });
  const january = journalItems(bill.db, { from: '2031-01-01', to: '2031-01-31' });
  assert.equal(december.some((line) => line.move_id === bill.id), false);
  assert.ok(january.some((line) => line.move_id === bill.id && line.date === '2031-01-05'));
  assert.equal(profitAndLoss(bill.db, { from: '2030-12-01', to: '2030-12-31' }).expense, 0);
  assert.equal(profitAndLoss(bill.db, { from: '2031-01-01', to: '2031-01-31' }).expense, 100);
});

test('a fiscal-year revaluation button posts only for the fiscal-year company', () => {
  const currency = create(seed(), 'res.currency', { name: 'R8A_SCOPE_FX', rate_ids: [{ date: '2030-01-01', rate: 2 }, { date: '2030-02-01', rate: 1 }] });
  const first = invoice(currency.db, { partner: 3, currency: currency.id, date: '2030-01-15', amount: 100 });
  const secondCompany = createCompanyWithDefaultInvoiceJournals(first.db, { name: 'R8A second company', currency_id: first.db.records['res.company'][0].currency_id });
  const second = invoice(secondCompany.db, { partner: 3, company: secondCompany.id, currency: currency.id, date: '2030-01-20', amount: 200 });
  const year = create(second.db, 'account.fiscal.year', {
    name: 'R8A first company 2030', company_id: 1, date_from: '2030-01-01', date_to: '2030-12-31', state: 'open',
  });
  const button = closingModels['account.fiscal.year'].form.buttons.find((item) => item.label === 'Revalue Foreign Currency');
  const done = button.run(year.db, read(year.db, 'account.fiscal.year', year.id), ['2030-02-28']).db;
  const entries = search(done, 'account.move').filter((move) => move.revaluation_date === '2030-02-28');
  assert.deepEqual(entries.map((move) => move.company_id), [1]);
  assert.ok(read(done, 'account.move', second.id));
  assert.ok(foreignBalanceReport(done, '2030-02-01', { companyId: secondCompany.id }).some((row) => row.company_id === secondCompany.id));
});

test('automatic bank and rule matching require the same commercial partner', () => {
  const base = seed();
  const customerA = create(base, 'res.partner', { name: 'R8A Customer A', is_company: true });
  const customerB = create(customerA.db, 'res.partner', { name: 'R8A Customer B', is_company: true });
  const invoiceA = invoice(customerB.db, { partner: customerA.id, date: '2030-01-01', amount: 150 });
  const invoiceB = invoice(invoiceA.db, { partner: customerB.id, date: '2030-01-01', amount: 100 });
  const statement = create(invoiceB.db, LINE, { journal_id: bankJournalId(invoiceB.db), date: '2030-01-05', payment_ref: 'Customer transfer', amount: 100, partner_id: customerA.id });
  assert.throws(() => run(statement.db, LINE, statement.id, 'Reconcile'), /No open invoice or bill with this exact amount belongs to the statement partner/);
  assert.equal(read(statement.db, LINE, statement.id).state, 'to_check');
  assert.equal(read(statement.db, 'account.move', invoiceB.id).amount_residual, 100);

  const noPartner = create(invoiceB.db, LINE, { journal_id: bankJournalId(invoiceB.db), date: '2030-01-05', payment_ref: 'Customer transfer', amount: 100 });
  assert.ok(candidates(noPartner.db, read(noPartner.db, LINE, noPartner.id)).some((move) => move.id === invoiceB.id));
  const rule = create(noPartner.db, 'account.reconcile.model', {
    name: 'R8A invoice suggestions', rule_type: 'invoice_matching', active: true, match_partner: false,
  });
  assert.throws(() => run(rule.db, LINE, noPartner.id, 'Apply Reconciliation Model'), /Select the statement partner/);
  assert.equal(read(rule.db, LINE, noPartner.id).state, 'to_check');
  assert.equal(read(rule.db, 'account.move', invoiceB.id).amount_residual, 100);
});

test('matching a posted payment allows an explicitly configured difference write-off', () => {
  let db = seed();
  const outstanding = accountId(db, '101402');
  db = write(db, 'res.company', 1, { outstanding_receipts_account_id: outstanding });
  const draft = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: 3, invoice_date: '2030-01-01', date: '2030-01-01',
    invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(draft.db, draft.id);
  const payment = create(db, 'account.payment', { invoice_id: draft.id, partner_id: 3, payment_type: 'inbound', partner_type: 'customer', amount: 100, date: '2030-01-02' });
  db = run(payment.db, 'account.payment', payment.id, 'Confirm');
  const plain = create(db, LINE, { journal_id: bankJournalId(db), date: '2030-01-03', payment_ref: 'Received less bank fee', amount: 95, payment_id: payment.id });
  assert.throws(() => run(plain.db, LINE, plain.id, 'Match Payment'), /selected payments must total the bank transaction amount/i);

  const fee = accountId(db, '690000');
  const configured = create(db, LINE, {
    journal_id: bankJournalId(db),
    date: '2030-01-03', payment_ref: 'Received less bank fee', amount: 95, payment_id: payment.id,
    writeoff_account_id: fee, writeoff_label: 'Withheld bank fee', writeoff_amount: 5,
  });
  const done = run(configured.db, LINE, configured.id, 'Match Payment');
  const line = read(done, LINE, configured.id);
  const entry = read(done, 'account.move', line.move_id);
  assert.equal(line.state, 'reconciled');
  assert.ok(isBalanced(entry.line_ids));
  assert.equal(entry.line_ids.find((item) => item.account_id === fee && item.name === 'Withheld bank fee').debit, 5);
  assert.equal(entry.line_ids.find((item) => item.account_id === accountId(done, '101401')).debit, 95);
  assert.equal(entry.line_ids.find((item) => item.account_id === outstanding).credit, 100);
  assert.equal(read(done, 'account.move', draft.id).amount_residual, 0);
});

test('tax return periods and tax locks use accounting date rather than invoice date', () => {
  const db = seed();
  const tax = search(db, 'account.tax').find((item) => item.type_tax_use === 'purchase' && Number(item.amount) > 0);
  const bill = create(db, 'account.move', {
    move_type: 'in_invoice', partner_id: 3, invoice_date: '2030-12-31', date: '2031-01-05',
    invoice_line_ids: [{ name: 'Taxable service', qty: 1, price_unit: 100, ...taxSnapshot(tax) }],
  });
  const checks = computeAuditChecks(bill.db, { company_id: 1, date_from: '2030-12-01', date_to: '2030-12-31' });
  assert.equal(checks.find((check) => check.name === 'Draft Entries').status, 'passed');
  const posted = postMove(bill.db, bill.id);
  assert.ok(read(posted, 'account.move', bill.id).line_ids.some((line) => line.tax_name), 'vendor bill should post a tax line');
  const december = validateTaxReturnPeriod(posted, { company_id: 1, date_from: '2030-12-01', date_to: '2030-12-31' });
  const january = taxReport(posted, { company_id: 1, from: '2031-01-01', to: '2031-01-31' });
  assert.deepEqual(december, { output: 0, input: 0, payable: 0 });
  assert.ok(january.input > 0);

  const locked = updateSettings(posted, { tax_lock_dates: { 1: '2030-12-31' } });
  const nextBill = create(locked, 'account.move', {
    move_type: 'in_invoice', partner_id: 3, invoice_date: '2030-12-31', date: '2031-01-06',
    invoice_line_ids: [{ name: 'Taxable service', qty: 1, price_unit: 25, ...taxSnapshot(tax) }],
  });
  assert.doesNotThrow(() => postMove(nextBill.db, nextBill.id));
});

test('foreign balance report and revaluation include manual foreign journal items', () => {
  const currency = create(configureRevaluationLoss(seed()), 'res.currency', { name: 'R8A_LOAN_FX', rate_ids: [{ date: '2030-01-01', rate: 2 }, { date: '2030-02-01', rate: 1 }] });
  const loan = accountId(currency.db, '260000');
  const entry = postEntry(currency.db, {
    journal: 'MISC', date: '2030-01-15', company: 1,
    lines: [
      { account_id: loan, credit: 50, currency_id: currency.id, amount_currency: -100 },
      { account: '301000', debit: 50 },
    ],
  });
  const report = foreignBalanceReport(entry.db, '2030-02-28', { companyId: 1 });
  const position = report.find((row) => row.account_id === loan && row.currency_id === currency.id);
  assert.equal(position?.difference, -50);
  const done = revalueForeignBalances(entry.db, '2030-02-28', { companyId: 1 });
  const adjustment = search(done, 'account.move').find((move) => move.revaluation_date === '2030-02-28');
  assert.equal(adjustment.line_ids.find((line) => line.account_id === loan).credit, 50);
  assert.equal(adjustment.line_ids.find((line) => line.account_id === accountId(done, '650100')).debit, 50);
});

test('foreign conversion fails when its currency has no applicable rate, while company currency remains one', () => {
  const currency = create(seed(), 'res.currency', { name: 'R8A_UNRATED_FX', rate_ids: [] });
  const companyCurrency = read(currency.db, 'res.company', 1).currency_id;
  assert.equal(rateAt(currency.db, companyCurrency, '2030-01-01', 1), 1);
  assert.throws(() => toCompany(currency.db, currency.id, 100, '2030-01-01', 1), /No R8A_UNRATED_FX exchange rate is configured/);
});

test('a changed exposure cannot be silently skipped by a repeated revaluation', () => {
  const currency = create(seed(), 'res.currency', { name: 'R8A_LATE_FX', rate_ids: [{ date: '2030-01-01', rate: 2 }, { date: '2030-02-01', rate: 1 }] });
  const firstInvoice = invoice(currency.db, { partner: 3, currency: currency.id, date: '2030-01-15', amount: 100 });
  const first = revalueForeignBalances(firstInvoice.db, '2030-02-28', { companyId: 1 });
  const lateInvoice = invoice(first, { partner: 3, currency: currency.id, date: '2030-01-20', amount: 100 });
  // Qodo 32: the rerun posts the change on top of the earlier adjustment instead of skipping or blocking the date.
  const second = revalueForeignBalances(lateInvoice.db, '2030-02-28', { companyId: 1 });
  const adjustments = search(second, 'account.move').filter((m) => m.revaluation_date === '2030-02-28');
  assert.equal(adjustments.length, 2);
  const receivable = accountId(second, '121000');
  const net = (moves) => moves.flatMap((m) => m.line_ids).filter((l) => l.account_id === receivable).reduce((sum, l) => sum + l.debit - l.credit, 0);
  const once = net(search(first, 'account.move').filter((m) => m.revaluation_date === '2030-02-28'));
  assert.notEqual(once, 0);
  // Both invoices are identical, so the date's adjustments together must cover twice the first exposure.
  assert.equal(net(adjustments), 2 * once);
  assert.equal(revalueForeignBalances(second, '2030-02-28', { companyId: 1 }), second);
});
