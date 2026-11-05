import { test } from 'node:test';
import assert from 'node:assert/strict';
import './models/index.js';
import { create, read, search, messagesOf } from './orm.js';
import { seed } from './seed.js';
import { addDays, today } from './models/common.js';
import { postMove, payMove } from './models/accounting.js';
import { runScheduledJobs } from './models/scheduler.js';
import { agedBalance, followUps, followUpCompanies, followUpText, formatFollowUpTotals, logManualFollowUp, runFollowUps } from './models/finance.js';
import { checkRegisterRows, postBatch } from './models/payments.js';
import { toCsv } from './csv.js';
import { documentText } from '../server/mail.js';
import { documentCompany } from './models/company.js';
import { applyDiff, diffDb } from './sync.js';

test('Qodo 1: scheduler commits retain earlier job changes through follow-up commit', async () => {
  const db = seed();
  // 1. Create a draft move with auto_post enabled, due in the past (handled by postAutoPostMoves before follow-ups)
  const draftAuto = create(db, 'account.move', {
    move_type: 'entry',
    ref: 'Auto-posted scheduler test',
    date: addDays(today(), -5),
    auto_post: 'at_date',
    line_ids: [
      { account_id: 1, debit: 50, credit: 0 },
      { account_id: 2, debit: 0, credit: 50 },
    ],
  });

  // 2. Create an overdue invoice for a customer that triggers follow-ups
  const partner = create(draftAuto.db, 'res.partner', { name: 'Follow-up recipient', email: 'followup@example.test' });
  const invoice = create(partner.db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner.id,
    invoice_date: addDays(today(), -60),
    invoice_date_due: addDays(today(), -20),
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 200, tax: 0 }],
  });
  let state = postMove(invoice.db, invoice.id);

  // Simulate server/index.js runJobs commitFollowUps
  let base = state;
  let serverDb = state;
  const commitFollowUps = (_before, after) => {
    serverDb = applyDiff(serverDb, diffDb(base, after), { author: 'Scheduler', isAdmin: true });
    base = serverDb;
    return serverDb;
  };

  const next = await runScheduledJobs(base, today(), {
    commitFollowUps,
    deliverFollowUp: async () => { throw new Error('SMTP delivery failure'); },
  });
  if (next !== base) {
    serverDb = applyDiff(serverDb, diffDb(base, next), { author: 'Scheduler', isAdmin: true });
  }

  // Verify that the earlier job change (draftAuto became posted) is retained
  assert.equal(read(serverDb, 'account.move', draftAuto.id).state, 'posted');
  // Verify that the follow-up failure was also committed
  assert.ok(messagesOf(serverDb, 'res.partner', partner.id).some((m) => m.body.includes('SMTP delivery failure')));
});

test('Qodo 29: mixed-currency reminder notes do not claim "0 overdue"', () => {
  const currency = create(seed(), 'res.currency', { name: 'Q9CFX', rate_ids: [{ date: '2020-01-01', rate: 2 }] });
  let db = currency.db;
  const partner = create(db, 'res.partner', { name: 'Multi-currency Customer', email: 'multicurrency@example.test' });
  db = partner.db;

  for (const currency_id of [null, currency.id]) {
    const inv = create(db, 'account.move', {
      move_type: 'out_invoice',
      partner_id: partner.id,
      currency_id,
      invoice_date: addDays(today(), -60),
      invoice_date_due: addDays(today(), -20),
      invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }],
    });
    db = postMove(inv.db, inv.id);
  }

  const manual = logManualFollowUp(db, partner.id);
  const notes = messagesOf(manual, 'res.partner', partner.id).map((m) => m.body).join('\n');
  assert.ok(notes.includes('overdue'));
  assert.ok(!/: 0 overdue/.test(notes));
  assert.ok(!/ 0 overdue/.test(notes));
});

test('Qodo 30: postBatch allocates check numbers to unnumbered outbound payments', () => {
  let db = seed();
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank');
  assert.ok(bankJournal);
  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 7,
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 300, tax: 0 }],
  });
  db = postMove(bill.db, bill.id);

  // Pay bill without a check number (e.g. created directly via payment or bank)
  const paidDb = payMove(db, bill.id, 300, today(), { journalId: bankJournal.id });
  const payment = search(paidDb, 'account.payment').findLast((p) => p.payment_type === 'outbound');
  assert.ok(payment.check_number == null);

  // Create an outbound batch containing this unnumbered payment
  const batch = create(paidDb, 'account.batch.payment', {
    batch_type: 'outbound',
    journal_id: bankJournal.id,
    check_number_start: 8500,
    lines: [{ payment_id: payment.id, amount: 300 }],
  });

  const posted = postBatch(batch.db, read(batch.db, 'account.batch.payment', batch.id));
  const postedBatch = read(posted, 'account.batch.payment', batch.id);
  assert.equal(postedBatch.lines[0].check_number, 8500);

  // Payment record in account.payment must also have check_number set
  const updatedPayment = read(posted, 'account.payment', payment.id);
  assert.equal(updatedPayment.check_number, 8500);

  // Journal check_next_number must be advanced
  const journal = read(posted, 'account.journal', bankJournal.id);
  assert.equal(journal.check_next_number, 8501);

  // checkRegisterRows must include this check
  const rows = checkRegisterRows(posted, [postedBatch], [updatedPayment]);
  assert.ok(rows.some((r) => r.checkNumber === 8500 && r.paymentId === payment.id));
});

test('Qodo 31: followUpText formats invoices and totals with matching currency precision', () => {
  let db = seed();
  const jpy = create(db, 'res.currency', { name: 'JPY', rounding: 1, rate_ids: [{ date: '2020-01-01', rate: 150 }] });
  db = jpy.db;
  const kwd = create(db, 'res.currency', { name: 'KWD', rounding: 0.001, rate_ids: [{ date: '2020-01-01', rate: 0.3 }] });
  db = kwd.db;

  const partnerJpy = create(db, 'res.partner', { name: 'JPY Customer' });
  db = partnerJpy.db;
  const invJpy = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: partnerJpy.id, currency_id: jpy.id,
    invoice_date: addDays(today(), -30), invoice_date_due: addDays(today(), -15),
    invoice_line_ids: [{ name: 'Service', qty: 1, price_unit: 1500, tax: 0 }],
  });
  db = postMove(invJpy.db, invJpy.id);

  const groupJpy = followUpCompanies(followUps(db, today()).find((f) => f.partner_id === partnerJpy.id))[0];
  const textJpy = followUpText(db, groupJpy);
  // JPY has 0 decimals: 1,500 JPY on line and 1,500 JPY on Total
  assert.match(textJpy, /1,500 JPY/);
  assert.doesNotMatch(textJpy, /1500\.00/);

  const partnerKwd = create(db, 'res.partner', { name: 'KWD Customer' });
  db = partnerKwd.db;
  const invKwd = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: partnerKwd.id, currency_id: kwd.id,
    invoice_date: addDays(today(), -30), invoice_date_due: addDays(today(), -15),
    invoice_line_ids: [{ name: 'Service', qty: 1, price_unit: 10.125, tax: 0 }],
  });
  db = postMove(invKwd.db, invKwd.id);

  const groupKwd = followUpCompanies(followUps(db, today()).find((f) => f.partner_id === partnerKwd.id))[0];
  const textKwd = followUpText(db, groupKwd);
  // KWD has 3 decimals: 10.125 KWD on line and 10.125 KWD on Total
  assert.match(textKwd, /10\.125 KWD/);
});

test('Qodo 33: toCsv neutralizes spreadsheet formula prefixes in non-numeric cells', () => {
  const rows = [
    ['Name', 'Formula', 'Amount', 'Negative', 'Phone'],
    ['=SUM(A1)', '+cmd|calc', '100.00', '-100.00', '+50'],
    ['@HYPERLINK("http://evil.test")', '\t=1+1', '1,234.56', '-1,234.56', 'Normal text'],
  ];
  const csv = toCsv(rows);

  // Formula prefixes must be prepended with single quote
  assert.ok(csv.includes('"\'=SUM(A1)"'));
  assert.ok(csv.includes('"\'\t=1+1"'));
  assert.ok(csv.includes('"\'@HYPERLINK(""http://evil.test"")"'));
  assert.ok(csv.includes('"\'\t=1+1"'));
  assert.ok(csv.includes('"\'\t=1+1"'));

  // Legitimate numbers must NOT be prepended with single quote
  assert.ok(csv.includes('"-100.00"'));
  assert.ok(csv.includes('"+50"'));
  assert.ok(csv.includes('"1,234.56"'));
  assert.ok(csv.includes('"-1,234.56"'));
  assert.ok(csv.includes('"Normal text"'));
});

test('Qodo 34: failed reminders without email delivery capability do not spam customer notes', async () => {
  let db = seed();
  // Partner without email address
  const partner = create(db, 'res.partner', { name: 'No Email Partner', email: '' });
  const inv = create(partner.db, 'account.move', {
    move_type: 'out_invoice', partner_id: partner.id,
    invoice_date: addDays(today(), -60), invoice_date_due: addDays(today(), -20),
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);

  // First run with deliver callback configured
  const first = await runFollowUps(db, today(), async () => {});
  const failureNotes = (d) => messagesOf(d, 'res.partner', partner.id).filter((m) => m.kind === 'note');
  assert.equal(failureNotes(first).length, 1);
  assert.ok(failureNotes(first)[0].body.includes('customer has no email address'));

  // Second run on the same date with deliver callback configured
  const second = await runFollowUps(first, today(), async () => {});
  assert.equal(failureNotes(second).length, 1, 'no duplicate failure note was recorded on the same date');
});

test('Qodo 39: unapplied credits appear in agedBalance partner detail rows', () => {
  let db = seed();
  const receivableAccount = search(db, 'account.account').find((a) => a.account_type === 'asset_receivable');
  const bankAccount = search(db, 'account.account').find((a) => a.account_type === 'asset_cash');
  assert.ok(receivableAccount && bankAccount);

  const partner = create(db, 'res.partner', { name: 'Credit Customer' });
  db = partner.db;

  // Invoice for 500
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: partner.id,
    invoice_date: addDays(today(), -45), invoice_date_due: addDays(today(), -45),
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 500, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);

  // Unapplied payment of 200
  const paymentMove = create(db, 'account.move', {
    move_type: 'entry', date: addDays(today(), -10),
    line_ids: [
      { account_id: bankAccount.id, debit: 200, credit: 0 },
      { account_id: receivableAccount.id, partner_id: partner.id, debit: 0, credit: 200 },
    ],
  });
  db = postMove(paymentMove.db, paymentMove.id);
  const payment = create(db, 'account.payment', {
    partner_id: partner.id, partner_type: 'customer', payment_type: 'inbound',
    amount: 200, date: addDays(today(), -10), move_id: paymentMove.id, state: 'posted',
  });
  db = payment.db;

  const result = agedBalance(db, 'receivable', today());
  const partnerRow = result.rows.find((r) => r.partner_id === partner.id);
  assert.ok(partnerRow, 'partner exists in aged balance');
  assert.equal(partnerRow.total, 300); // 500 - 200

  // The expanded invoices list must include the unapplied payment
  const unappliedDetail = partnerRow.invoices.find((i) => i.move_id === paymentMove.id);
  assert.ok(unappliedDetail, 'unapplied payment exists in expanded invoices list');
  assert.equal(unappliedDetail.total, -200);

  // Total of expanded rows must equal partnerRow.total
  const expandedTotal = partnerRow.invoices.reduce((s, i) => s + i.total, 0);
  assert.equal(expandedTotal, partnerRow.total);
});

test('Qodo 45: documentText labels counterparty as Vendor for purchase orders and vendor bills', () => {
  let db = seed();
  const vendor = create(db, 'res.partner', { name: 'Acme Supplies', street: '123 Market St' });
  db = vendor.db;

  const po = create(db, 'purchase.order', {
    name: 'PO-001', partner_id: vendor.id,
    order_line: [{ product_id: 5, qty: 2, price_unit: 50, tax: 0 }],
  });
  const poText = documentText(po.db, 'purchase.order', read(po.db, 'purchase.order', po.id));
  assert.ok(poText.includes('Vendor: Acme Supplies'));
  assert.ok(!poText.includes('Customer: Acme Supplies'));

  const bill = create(db, 'account.move', {
    name: 'BILL-001', move_type: 'in_invoice', partner_id: vendor.id,
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }],
  });
  const billText = documentText(bill.db, 'account.move', read(bill.db, 'account.move', bill.id));
  assert.ok(billText.includes('Vendor: Acme Supplies'));
  assert.ok(!billText.includes('Customer: Acme Supplies'));

  const customer = create(db, 'res.partner', { name: 'Client Corp' });
  const so = create(customer.db, 'sale.order', {
    name: 'SO-001', partner_id: customer.id,
    order_line: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }],
  });
  const soText = documentText(so.db, 'sale.order', read(so.db, 'sale.order', so.id));
  assert.ok(soText.includes('Customer: Client Corp'));
});

test('Qodo 46: formatFollowUpTotals formats numbers with thousands separators and decimals', () => {
  const followUp = {
    totals: [
      { currency: { name: 'USD', rounding: 0.01 }, amount: 1140.5 },
      { currency: { name: 'EUR', rounding: 0.01 }, amount: 1000 },
    ],
  };
  const formatted = formatFollowUpTotals(followUp);
  assert.equal(formatted, '1,140.50 USD, 1,000.00 EUR');
});

test('Qodo 48: older documents without company_id resolve company 1 for printing', () => {
  const db = seed();
  const olderInvoice = {
    id: 9999,
    name: 'INV/OLD/001',
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_line_ids: [],
  };
  const company = documentCompany(db, olderInvoice);
  assert.ok(company);
  assert.equal(company.id, 1);
  assert.equal(company.name, read(db, 'res.company', 1).name);
});
