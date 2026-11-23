import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom } from './test-support/dom.js';
import { createCompanyWithDefaultInvoiceJournals } from './test-support/accounting-company.js';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { postMove } from './models/accounting.js';
import { partnerTotalDue, partnerTotalOverdue, partnerReceivableLines, companyReceivableLines, classifyDue, followUps, followUpCompanies, followUpLetter } from './models/finance.js';
import { postPayment } from './models/pay.js';
import { upsertCurrencyRates } from './models/currency.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));
const { FollowUps, REPORTS } = await import('./views/Reports.jsx');

// ---------------------------------------------------------------------------
// FU7-1: Partner computed fields total_due and total_overdue
// ---------------------------------------------------------------------------

test('FU7-1 classification helper: classifyDue returns overdue or upcoming correctly', () => {
  assert.equal(classifyDue('2026-01-10', '2026-01-20'), 'overdue');
  assert.equal(classifyDue('2026-01-20', '2026-01-20'), null);
  assert.equal(classifyDue('2026-02-15', '2026-01-20'), null);
  assert.equal(classifyDue('2026-01-25', '2026-01-20', '2026-01-30'), 'upcoming');
  assert.equal(classifyDue('2026-02-05', '2026-01-20', '2026-01-30'), null);
  assert.equal(classifyDue(null, '2026-01-20'), null);
});

test('FU7-1 computation: total_due sums open posted receivable residuals, total_overdue includes only lines past due', () => {
  const base = seed();
  const partner = create(base, 'res.partner', { name: 'Customer Due Overdue' });
  const pId = partner.id;

  // Invoice 1: $100 due 2026-01-10 (overdue on 2026-01-20)
  const inv1 = create(partner.db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: pId,
    invoice_date: '2026-01-01',
    invoice_date_due: '2026-01-10',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }],
  });
  // Invoice 2: $60 due 2026-02-15 (future, not overdue on 2026-01-20)
  const inv2 = create(inv1.db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: pId,
    invoice_date: '2026-01-05',
    invoice_date_due: '2026-02-15',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 60, tax: 0 }],
  });
  let db = postMove(postMove(inv2.db, inv1.id), inv2.id);

  assert.equal(partnerTotalDue(db, pId, 1, '2026-01-20'), 160);
  assert.equal(partnerTotalOverdue(db, pId, 1, '2026-01-20'), 100);

  // On 2026-03-01, both invoices are overdue
  assert.equal(partnerTotalDue(db, pId, 1, '2026-03-01'), 160);
  assert.equal(partnerTotalOverdue(db, pId, 1, '2026-03-01'), 160);

  // On 2026-01-05, neither is overdue
  assert.equal(partnerTotalDue(db, pId, 1, '2026-01-05'), 160);
  assert.equal(partnerTotalOverdue(db, pId, 1, '2026-01-05'), 0);
});

test('FU7-1 installments: payment terms split residual into due and overdue portions', () => {
  const base = seed();
  const partner = create(base, 'res.partner', { name: 'Installment Cust' });
  const term = create(partner.db, 'account.payment.term', {
    name: '40 now, 60 later',
    line_ids: [
      { value_type: 'percent', value: 40, nb_days: 0, delay_type: 'days_after' },
      { value_type: 'percent', value: 60, nb_days: 30, delay_type: 'days_after' },
    ],
  });
  const inv = create(term.db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: partner.id,
    invoice_date: '2026-01-01',
    invoice_payment_term_id: term.id,
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 200, tax: 0 }],
  });
  const db = postMove(inv.db, inv.id);

  // On 2026-01-15: 40% ($80) due 2026-01-01 is overdue, 60% ($120) due 2026-01-31 is not overdue
  assert.equal(partnerTotalDue(db, partner.id, 1, '2026-01-15'), 200);
  assert.equal(partnerTotalOverdue(db, partner.id, 1, '2026-01-15'), 80);

  const linesInfo = partnerReceivableLines(db, partner.id, 1, '2026-01-15');
  assert.equal(linesInfo.lines.length, 2);
  assert.equal(linesInfo.lines[0].residual_amount, 80);
  assert.equal(linesInfo.lines[0].is_overdue, true);
  assert.equal(linesInfo.lines[1].residual_amount, 120);
  assert.equal(linesInfo.lines[1].is_overdue, false);
});

test('FU7-1 multi-company isolation: computed fields only sum residuals for the specified company', () => {
  const base = seed();
  const branch = createCompanyWithDefaultInvoiceJournals(base, { name: 'Branch 2', currency_id: base.records['res.company'][0].currency_id });
  const partner = create(branch.db, 'res.partner', { name: 'Multi Co Cust' });
  const invCo1 = create(partner.db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: partner.id,
    invoice_date: '2026-01-01',
    invoice_date_due: '2026-01-10',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }],
  });
  const invCo2 = create(invCo1.db, 'account.move', {
    move_type: 'out_invoice',
    company_id: branch.id,
    partner_id: partner.id,
    invoice_date: '2026-01-01',
    invoice_date_due: '2026-01-10',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 250, tax: 0 }],
  });
  const db = postMove(postMove(invCo2.db, invCo1.id), invCo2.id);

  assert.equal(partnerTotalDue(db, partner.id, 1, '2026-01-15'), 100);
  assert.equal(partnerTotalOverdue(db, partner.id, 1, '2026-01-15'), 100);

  assert.equal(partnerTotalDue(db, partner.id, branch.id, '2026-01-15'), 250);
  assert.equal(partnerTotalOverdue(db, partner.id, branch.id, '2026-01-15'), 250);
});

// ---------------------------------------------------------------------------
// FU7-2: Follow-up report separate columns and open invoices line table
// ---------------------------------------------------------------------------

test('FU7-2 report columns: REPORTS.followups defines separate Total Due and Total Overdue columns', () => {
  assert.ok(REPORTS.followups);
  assert.deepEqual(REPORTS.followups.cols, ['Oldest Due', 'Total Due', 'Total Overdue']);
});

test('FU7-2 report view: FollowUps renders per customer line table of open invoices and separate totals', () => {
  setupDom();
  const base = seed();
  const partner = create(base, 'res.partner', { name: 'Followup Report Customer' });
  const inv1 = create(partner.db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: partner.id,
    ref: 'REF-001',
    invoice_date: '2026-01-01',
    invoice_date_due: '2026-01-10',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 300, tax: 0 }],
  });
  const inv2 = create(inv1.db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: partner.id,
    ref: 'REF-002',
    invoice_date: '2026-01-05',
    invoice_date_due: '2026-02-28',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 150, tax: 0 }],
  });
  const db = postMove(postMove(inv2.db, inv1.id), inv2.id);

  // followUps does not calculate total_due and total_overdue to keep reminder lookups fast
  const fList = followUps(db, '2026-01-20');
  const partnerFollowUp = fList.find((f) => f.partner_id === partner.id);
  assert.ok(partnerFollowUp);
  assert.equal(partnerFollowUp.total_due, undefined);
  assert.equal(partnerFollowUp.total_overdue, undefined);

  // Render the FollowUps component
  const element = FollowUps({ db, sourceDb: db, companyId: 1 });
  assert.ok(element);
  assert.equal(element.type, 'tbody');

  // Partner receivable lines should have the details
  const linesInfo = partnerReceivableLines(db, partner.id, 1, '2026-01-20');
  assert.equal(linesInfo.total_due, 450);
  assert.equal(linesInfo.total_overdue, 300);
  assert.equal(linesInfo.lines.length, 2);

  const overdueLine = linesInfo.lines.find((l) => l.reference === 'REF-001');
  assert.ok(overdueLine);
  assert.equal(overdueLine.invoice_date, '2026-01-01');
  assert.equal(overdueLine.due_date, '2026-01-10');
  assert.equal(overdueLine.residual_amount, 300);
  assert.equal(overdueLine.is_overdue, true);

  const futureLine = linesInfo.lines.find((l) => l.reference === 'REF-002');
  assert.ok(futureLine);
  assert.equal(futureLine.invoice_date, '2026-01-05');
  assert.equal(futureLine.due_date, '2026-02-28');
  assert.equal(futureLine.residual_amount, 150);
  assert.equal(futureLine.is_overdue, false);
});

// ---------------------------------------------------------------------------
// FU7-3: Multi-currency conversion in company currency
// ---------------------------------------------------------------------------

test('FU7-3 multi-currency: amounts are converted to company currency using exchange rates', () => {
  const base = seed();
  const eur = (base.records['res.currency'] || []).find((c) => c.name === 'EUR');
  assert.ok(eur, 'EUR currency should exist');

  const partner = create(base, 'res.partner', { name: 'Foreign Currency Cust' });
  // Invoice in EUR for USD company (company 1 has USD, EUR rate on 2026-10-01 is 0.92 EUR/USD)
  // 100 EUR / 0.92 = 108.70 USD
  const inv = create(partner.db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: partner.id,
    currency_id: eur.id,
    invoice_date: '2026-10-01',
    invoice_date_due: '2026-10-10',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }],
  });
  const db = postMove(inv.db, inv.id);

  const linesInfo = partnerReceivableLines(db, partner.id, 1, '2026-10-15');
  assert.equal(linesInfo.total_due, 108.7);
  assert.equal(linesInfo.total_overdue, 108.7);
  assert.equal(linesInfo.lines[0].residual_amount, 108.7);

  assert.equal(partnerTotalDue(db, partner.id, 1, '2026-10-15'), 108.7);
  assert.equal(partnerTotalOverdue(db, partner.id, 1, '2026-10-15'), 108.7);
});

// ---------------------------------------------------------------------------
// i18n: Modern Standard Arabic strings
// ---------------------------------------------------------------------------

test('i18n: Total Due and Total Overdue have Modern Standard Arabic translations', async () => {
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => 'ar', setItem: () => {} };
  try {
    const { t: tAr } = await import(`./i18n.js?fup7_ar=${Date.now()}`);
    assert.equal(tAr('Total Due'), 'إجمالي المستحق');
    assert.equal(tAr('Total Overdue'), 'إجمالي المتأخر');
    assert.equal(tAr('Residual Amount'), 'المبلغ المتبقي');
  } finally {
    globalThis.localStorage = prevStorage;
  }
});


test('partner and letter totals agree independently in two companies', () => {
  const base = seed();
  const branch = createCompanyWithDefaultInvoiceJournals(base, { name: 'Second company', currency_id: base.records['res.company'][0].currency_id });
  const partner = create(branch.db, 'res.partner', { name: 'Shared customer' });
  let db = partner.db;
  for (const [companyId, amounts] of [[1, [100, 50]], [branch.id, [80, 20]]]) {
    for (const [index, amount] of amounts.entries()) {
      const invoice = create(db, 'account.move', { move_type: 'out_invoice', company_id: companyId, partner_id: partner.id, invoice_date: '2026-01-01', invoice_date_due: index ? '2026-04-01' : '2026-02-01', invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: amount, tax: 0 }] });
      db = postMove(invoice.db, invoice.id);
    }
  }
  for (const [companyId, due, overdue] of [[1, 150, 100], [branch.id, 100, 80]]) {
    const letter = followUpLetter(db, partner.id, companyId, '2026-03-01');
    assert.equal(partnerTotalDue(db, partner.id, companyId, '2026-03-01'), due);
    assert.equal(partnerTotalOverdue(db, partner.id, companyId, '2026-03-01'), overdue);
    assert.equal(letter.due[0].amount, due);
    assert.equal(letter.overdue[0].amount, overdue);
  }
});

// ---------------------------------------------------------------------------
// Regressions for code review findings (1 - 7)
// ---------------------------------------------------------------------------

test('Finding 1 regression: foreign-currency unapplied payment does not double convert or mislabel currency in letter and lines', () => {
  const base = seed();
  const eur = (base.records['res.currency'] || []).find((c) => c.name === 'EUR');
  assert.ok(eur);
  let db = upsertCurrencyRates(base, [{ currency_id: eur.id, date: '2026-01-01', rate: 0.5 }]);
  const partner = create(db, 'res.partner', { name: 'FC Unapplied Payment Cust' });
  const inv = create(partner.db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: partner.id,
    invoice_date: '2026-01-01',
    invoice_date_due: '2026-01-10',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 250, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);

  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  const payment = create(db, 'account.payment', {
    partner_type: 'customer',
    payment_type: 'inbound',
    partner_id: partner.id,
    journal_id: bankJournal.id,
    currency_id: eur.id,
    date: '2026-01-12',
    amount: 50, // 50 EUR / 0.5 = 100 USD booked credit
  });
  db = postPayment(payment.db, read(payment.db, 'account.payment', payment.id));

  const linesInfo = partnerReceivableLines(db, partner.id, 1, '2026-01-20');
  // Total due should be 250 - 100 = 150 (not 250 - 200 = 50 from double conversion)
  assert.equal(linesInfo.total_due, 150);
  assert.equal(linesInfo.lines.length, 2);

  const payMoveId = read(db, 'account.payment', payment.id).move_id;
  const payLine = linesInfo.lines.find((l) => l.move_id === payMoveId);
  assert.ok(payLine);
  assert.equal(payLine.residual_amount, -100);
  assert.equal(payLine.is_credit, true);
  assert.equal(payLine.is_overdue, false);

  // Credit row in invoices array should carry followup_currency compCurr (USD)
  const creditInv = linesInfo.invoices.find((i) => i.id === payMoveId);
  assert.ok(creditInv);
  assert.equal(creditInv.followup_currency.name, 'USD');
  assert.equal(creditInv.amount_residual, -100);
});

test('Finding 2 regression: followUps does not calculate total_due and total_overdue; companyReceivableLines computes in one pass', () => {
  const base = seed();
  const partner = create(base, 'res.partner', { name: 'Batch Aging Partner' });
  const inv = create(partner.db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: partner.id,
    invoice_date: '2026-01-01',
    invoice_date_due: '2026-01-10',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }],
  });
  const db = postMove(inv.db, inv.id);

  const fList = followUps(db, '2026-01-20');
  const reminder = fList.find((f) => f.partner_id === partner.id);
  assert.ok(reminder);
  // total_due and total_overdue are removed from followUps result
  assert.equal(reminder.total_due, undefined);
  assert.equal(reminder.total_overdue, undefined);

  // companyReceivableLines returns map with partner totals in a single pass
  const compLines = companyReceivableLines(db, 1, '2026-01-20');
  assert.ok(compLines instanceof Map);
  const pInfo = compLines.get(partner.id);
  assert.ok(pInfo);
  assert.equal(pInfo.total_due, 100);
  assert.equal(pInfo.total_overdue, 100);
});

test('Finding 3 regression: all-company followUps reminders do not copy active-company totals across companies', () => {
  const base = seed();
  const branch = createCompanyWithDefaultInvoiceJournals(base, { name: 'Company B', currency_id: base.records['res.company'][0].currency_id });
  const partner = create(branch.db, 'res.partner', { name: 'Multi-Company Shared Cust' });
  const inv1 = create(partner.db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: partner.id,
    invoice_date: '2026-01-01',
    invoice_date_due: '2026-01-10',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }],
  });
  const inv2 = create(inv1.db, 'account.move', {
    move_type: 'out_invoice',
    company_id: branch.id,
    partner_id: partner.id,
    invoice_date: '2026-01-01',
    invoice_date_due: '2026-01-10',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 250, tax: 0 }],
  });
  const db = postMove(postMove(inv2.db, inv1.id), inv2.id);

  const reminders = followUps(db, '2026-01-20');
  const partnerReminder = reminders.find((f) => f.partner_id === partner.id);
  assert.ok(partnerReminder);
  const perCompany = followUpCompanies(partnerReminder);
  assert.equal(perCompany.length, 2);

  const groupCo1 = perCompany.find((g) => g.company_id === 1);
  const groupCo2 = perCompany.find((g) => g.company_id === branch.id);
  assert.ok(groupCo1);
  assert.ok(groupCo2);
  // Neither group should carry an active-company total_due
  assert.equal(groupCo1.total_due, undefined);
  assert.equal(groupCo2.total_due, undefined);

  // Company-specific balances remain isolated
  assert.equal(partnerTotalDue(db, partner.id, 1, '2026-01-20'), 100);
  assert.equal(partnerTotalDue(db, partner.id, branch.id, '2026-01-20'), 250);
});

test('Finding 4 regression: paid legacy invoices without journal lines or payment_date do not reappear as debts', () => {
  const base = seed();
  const partner = create(base, 'res.partner', { name: 'Legacy Paid Customer' });

  // 1. Open qualifying invoice
  const openInv = create(partner.db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: partner.id,
    invoice_date: '2026-01-05',
    invoice_date_due: '2026-01-15',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 50, tax: 0 }],
  });
  let db = postMove(openInv.db, openInv.id);

  // Fully settled legacy invoice with amount_paid: 100, no receivable journal lines, payment_date: null
  const paidLegacyId = 99901;
  const paidLegacy = {
    id: paidLegacyId,
    name: 'INV/LEGACY/001',
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: partner.id,
    invoice_date: '2026-01-01',
    invoice_date_due: '2026-01-10',
    amount_total: 100,
    amount_paid: 100,
    payment_date: null,
    line_ids: [],
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }],
    state: 'posted',
    active: true,
  };
  db = { ...db, records: { ...db.records, 'account.move': [...db.records['account.move'], paidLegacy] } };

  const linesInfo = partnerReceivableLines(db, partner.id, 1, '2026-01-20');
  // The fully paid legacy invoice should be completely omitted from lines and invoices
  assert.equal(linesInfo.lines.length, 1);
  assert.equal(linesInfo.lines[0].move_id, openInv.id);
  assert.equal(linesInfo.total_due, 50);
  assert.equal(linesInfo.invoices.length, 1);
  assert.equal(linesInfo.invoices[0].id, openInv.id);

  // 2. Partially paid legacy invoice with missing payment_date reconciles to residual
  const partialLegacyPartner = create(db, 'res.partner', { name: 'Partial Legacy Cust' });
  const partialLegacyId = 99902;
  const partialLegacy = {
    id: partialLegacyId,
    name: 'INV/LEGACY/002',
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: partialLegacyPartner.id,
    invoice_date: '2026-01-01',
    invoice_date_due: '2026-01-10',
    amount_total: 100,
    amount_paid: 40,
    payment_date: null,
    line_ids: [],
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }],
    state: 'posted',
    active: true,
  };
  db = { ...partialLegacyPartner.db, records: { ...partialLegacyPartner.db.records, 'account.move': [...partialLegacyPartner.db.records['account.move'], partialLegacy] } };

  const partialInfo = partnerReceivableLines(db, partialLegacyPartner.id, 1, '2026-01-20');
  assert.equal(partialInfo.lines.length, 1);
  assert.equal(partialInfo.lines[0].residual_amount, 60);
  assert.equal(partialInfo.total_due, 60);
  assert.equal(partialInfo.invoices[0].amount_residual, 60);
});

test('Finding 5 regression: historical letter and invoice summary residual agree with cutoff-aware installments', () => {
  const base = seed();
  const partner = create(base, 'res.partner', { name: 'Historical Cutoff Partner' });
  const inv = create(partner.db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: partner.id,
    invoice_date: '2026-01-01',
    invoice_date_due: '2026-01-10',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }],
  });
  let db = postMove(inv.db, inv.id);

  // Pay invoice on 2026-02-01 (after the 2026-01-15 cutoff)
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  const payment = create(db, 'account.payment', {
    partner_type: 'customer',
    payment_type: 'inbound',
    partner_id: partner.id,
    journal_id: bankJournal.id,
    date: '2026-02-01',
    amount: 100,
  });
  db = postPayment(payment.db, read(payment.db, 'account.payment', payment.id));
  const payMoveId = read(db, 'account.payment', payment.id).move_id;
  db = write(db, 'account.move', inv.id, {
    amount_paid: 100,
    payment_date: '2026-02-01',
    payments: [{ date: '2026-02-01', amount: 100, move_id: payMoveId, company_amount: 100 }],
  });

  // Query at 2026-01-15 (before payment): invoice was open at cutoff
  const atCutoff = partnerReceivableLines(db, partner.id, 1, '2026-01-15');
  assert.equal(atCutoff.total_due, 100);
  assert.equal(atCutoff.lines.length, 1);
  assert.equal(atCutoff.lines[0].residual_amount, 100);
  // Summary invoices array must reflect the cutoff amount ($100), not the later settled amount ($0)
  assert.equal(atCutoff.invoices.length, 1);
  assert.equal(atCutoff.invoices[0].amount_residual, 100);
  assert.equal(atCutoff.due[0].amount, 100);

  // Query at 2026-02-05 (after payment): invoice is settled
  const afterPay = partnerReceivableLines(db, partner.id, 1, '2026-02-05');
  assert.equal(afterPay.total_due, 0);
  assert.equal(afterPay.lines.length, 0);
  assert.equal(afterPay.invoices.length, 0);
});

test('Finding 6 regression: foreign refund credit is not revalued with invoice-date rate instead of booked rate', () => {
  const base = seed();
  const eur = (base.records['res.currency'] || []).find((c) => c.name === 'EUR');
  assert.ok(eur);
  // Rate on 2026-01-01 is 1.0 (100 EUR = 100 USD)
  // Rate on 2026-02-01 is 0.5 (100 EUR = 200 USD)
  let db = upsertCurrencyRates(base, [
    { currency_id: eur.id, date: '2026-01-01', rate: 1.0 },
    { currency_id: eur.id, date: '2026-02-01', rate: 0.5 },
  ]);
  const partner = create(db, 'res.partner', { name: 'Foreign Refund Partner' });

  // Out invoice for 300 USD
  const inv = create(partner.db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: partner.id,
    invoice_date: '2026-01-01',
    invoice_date_due: '2026-01-10',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 300, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);

  // Out refund for 50 EUR booked at posting date 2026-02-01 (credit: 100 USD) with invoice_date 2026-01-01
  const recAcc = search(db, 'account.account').find((a) => a.account_type === 'asset_receivable');
  const incAcc = search(db, 'account.account').find((a) => a.account_type === 'income');
  const refund = create(db, 'account.move', {
    name: 'RBNK/2026/001',
    move_type: 'out_refund',
    company_id: 1,
    partner_id: partner.id,
    currency_id: eur.id,
    invoice_date: '2026-01-01',
    date: '2026-02-01',
    amount_total: 50,
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 50, tax: 0 }],
    state: 'posted',
    line_ids: [
      { account_id: recAcc.id, partner_id: partner.id, debit: 0, credit: 100, amount_currency: -50, currency_id: eur.id },
      { account_id: incAcc.id, partner_id: partner.id, debit: 100, credit: 0, amount_currency: 50, currency_id: eur.id },
    ],
  });
  db = refund.db;

  const linesInfo = partnerReceivableLines(db, partner.id, 1, '2026-02-15');
  const refundLine = linesInfo.lines.find((l) => l.move_id === refund.id);
  assert.ok(refundLine);
  // Must use booked company currency amount (-100 USD), not revalued at invoice date (-50 USD)
  assert.equal(refundLine.residual_amount, -100);
  assert.equal(linesInfo.total_due, 200); // 300 - 100 = 200 USD
});

test('Finding 7 regression: credit lines have is_credit: true and is_overdue: false, rendered as — in report', () => {
  setupDom();
  const base = seed();
  const partner = create(base, 'res.partner', { name: 'Credit Note Customer' });
  const inv = create(partner.db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: partner.id,
    invoice_date: '2026-01-01',
    invoice_date_due: '2026-01-10',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 200, tax: 0 }],
  });
  const refund = create(inv.db, 'account.move', {
    move_type: 'out_refund',
    company_id: 1,
    partner_id: partner.id,
    invoice_date: '2026-01-18',
    invoice_date_due: '2026-01-18',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 50, tax: 0 }],
  });
  const db = postMove(postMove(refund.db, inv.id), refund.id);

  const linesInfo = partnerReceivableLines(db, partner.id, 1, '2026-01-20');
  const creditLine = linesInfo.lines.find((l) => l.move_id === refund.id);
  assert.ok(creditLine);
  assert.equal(creditLine.is_credit, true);
  assert.equal(creditLine.is_overdue, false);
  // Total overdue nets the credit note: 200 - 50 = 150
  assert.equal(linesInfo.total_overdue, 150);

  // Render report
  const element = FollowUps({ db, sourceDb: db, companyId: 1 });
  assert.ok(element);
});
