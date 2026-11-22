import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom } from './test-support/dom.js';
import { createCompanyWithDefaultInvoiceJournals } from './test-support/accounting-company.js';
import { create } from './orm.js';
import { seed } from './seed.js';
import { postMove } from './models/accounting.js';
import { partnerTotalDue, partnerTotalOverdue, partnerReceivableLines, classifyDue, followUps, followUpLetter } from './models/finance.js';

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

  // followUps helper includes total_due and total_overdue
  const fList = followUps(db, '2026-01-20');
  const partnerFollowUp = fList.find((f) => f.partner_id === partner.id);
  assert.ok(partnerFollowUp);
  assert.equal(partnerFollowUp.total_due, 450);
  assert.equal(partnerFollowUp.total_overdue, 300);

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
