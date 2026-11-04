import { test } from 'node:test';
import './models/index.js';
import assert from 'node:assert/strict';
import { installments } from './models/terms.js';
import { checkMandatoryPlans } from './models/analyticplus.js';
import { disposeAsset } from './models/assets.js';
import { create, messagesOf, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { models } from './registry.js';
import { createCompany } from './models/company.js';
import { addDays, today } from './models/common.js';
import { postMove, payMove } from './models/accounting.js';
import { taxSnapshot } from './models/taxes.js';
import { journalAudit } from './models/journal_audit.js';
import { checkRegisterRows } from './models/payments.js';

test('payment terms reject an incomplete percentage split', () => {
  assert.throws(() => installments({ line_ids: [{ value_type: 'percent', value: 10 }, { value_type: 'percent', value: 10 }] }, 1000, '2026-01-01'), /100%/);
});

test('mandatory analytic plan requires full allocation', () => {
  const db = { records: { 'account.analytic.plan': [{ id: 1, name: 'Project', default_applicability: 'mandatory' }], 'account.analytic.account': [{ id: 1, plan_id: 1 }] } };
  assert.throws(() => checkMandatoryPlans(db, { move_type: 'entry', line_ids: [{ analytic_distribution: { 1: 1 } }] }), /mandatory/i);
});

test('paused asset disposal refuses unresolved due depreciation', () => {
  const asset = { id: 1, state: 'paused', depreciation_ids: [{ date: '2026-03-31', amount: 100, posted: false }] };
  const db = { records: { 'account.asset': [asset] } };
  assert.throws(() => disposeAsset(db, asset, { date: '2026-04-15', saleValue: 0 }), /post.*depreciation/i);
});

test('tax return types need explicit settlement accounts and authority before close or payment', async () => {
  const { reviewReturn, submitReturn, payReturn } = await import('./models/taxreturn.js');
  const base = seed();
  const mainType = search(base, 'account.return.type').find((type) => (type.company_id ?? 1) === 1 && type.category === 'account_return');
  assert.ok(mainType.tax_payable_account_id);
  assert.ok(mainType.tax_receivable_account_id);
  assert.ok(mainType.payment_partner_id);
  assert.notEqual(mainType.payment_partner_id, 1);

  const company = read(base, 'res.company', 1);
  const branch = createCompany(base, { name: 'Unconfigured tax branch', currency_id: company.currency_id });
  let db = branch.db;
  const branchType = search(db, 'account.return.type').find((type) => type.company_id === branch.id && type.category === 'account_return');
  assert.ok(branchType.tax_payable_account_id == null);
  assert.ok(branchType.tax_receivable_account_id == null);
  assert.ok(branchType.payment_partner_id == null);

  const start = `${today().slice(0, 7)}-01`;
  const end = `${today().slice(0, 7)}-${String(new Date(Number(today().slice(0, 4)), Number(today().slice(5, 7)), 0).getDate()).padStart(2, '0')}`;
  const made = create(db, 'account.return', {
    name: 'Explicit tax setup check', type_id: branchType.id, company_id: branch.id,
    date_from: start, date_to: end,
  });
  db = reviewReturn(made.db, made.id);
  assert.throws(() => submitReturn(db, made.id), /tax_payable_account_id/);

  db = write(db, 'account.return.type', branchType.id, { tax_payable_account_id: mainType.tax_payable_account_id });
  assert.throws(() => submitReturn(db, made.id), /tax_receivable_account_id/);
  db = write(db, 'account.return.type', branchType.id, { tax_receivable_account_id: mainType.tax_receivable_account_id });
  assert.throws(() => submitReturn(db, made.id), /payment_partner_id/);

  db = write(db, 'account.return.type', branchType.id, { payment_partner_id: mainType.payment_partner_id });
  db = submitReturn(db, made.id);
  const noAuthority = write(db, 'account.return.type', branchType.id, { payment_partner_id: null });
  assert.throws(() => payReturn(noAuthority, made.id), /payment_partner_id/);
});

test('grouped deferrals prorate an unfinished board period through each cut-off and reverse prior snapshots', () => {
  const start = `${today().slice(0, 4)}-01-01`;
  const db0 = seed();
  const deferred = create(db0, 'account.account', { code: 'R8B-DEF-1', name: 'R8B Deferred', account_type: 'liability_current' });
  const revenue = create(deferred.db, 'account.account', { code: 'R8B-REV-1', name: 'R8B Revenue', account_type: 'income' });
  let db = write(revenue.db, 'res.company', 1, { deferred_generation_method: 'manual_grouped', deferred_amount_computation_method: 'days' });
  const schedule = create(db, 'account.deferral', {
    name: 'January service', kind: 'revenue', amount: 3100, start_date: start, end_date: `${start.slice(0, 7)}-31`,
    months: 1, company_id: 1, deferred_account_id: deferred.id, recognition_account_id: revenue.id,
  });
  const compute = models['account.deferral'].form.buttons.find((button) => button.label === 'Compute');
  db = compute.run(schedule.db, read(schedule.db, 'account.deferral', schedule.id)).db;
  assert.equal(read(db, 'account.deferral', schedule.id).board[0].date, `${start.slice(0, 7)}-31`);

  const generate = models['account.deferral'].actions.generateGroupedEntries;
  const recognizedByCutoff = [];
  for (const date of [`${start.slice(0, 7)}-15`, `${start.slice(0, 7)}-20`, `${start.slice(0, 7)}-31`]) {
    db = generate(db, { date, company_id: 1, kind: 'revenue' });
    const move = search(db, 'account.move').find((item) => item.is_deferred_grouped && !item.reversed_entry_id && item.deferral_date === date);
    const line = move.line_ids.find((item) => item.account_id === revenue.id);
    recognizedByCutoff.push(line.credit - line.debit);
  }
  assert.deepEqual(recognizedByCutoff, [1500, 2000, 3100]);
  const netRecognized = search(db, 'account.move')
    .filter((move) => move.is_deferred_grouped && move.deferral_kind === 'revenue' && move.deferral_date <= `${start.slice(0, 7)}-31`)
    .flatMap((move) => move.line_ids)
    .filter((line) => line.account_id === revenue.id)
    .reduce((sum, line) => sum + (line.credit || 0) - (line.debit || 0), 0);
  assert.equal(netRecognized, 3100);
});

test('automatic follow-ups record email delivery and leave levels unchanged when the email action cannot send', async () => {
  const { partnerFollowUp, runFollowUps, logManualFollowUp } = await import('./models/finance.js');
  const db0 = seed();
  const partner = create(db0, 'res.partner', { name: 'No-email reminder customer' });
  const invoice = create(partner.db, 'account.move', {
    move_type: 'out_invoice', partner_id: partner.id,
    invoice_date: addDays(today(), -60), invoice_date_due: addDays(today(), -20),
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }],
  });
  const posted = postMove(invoice.db, invoice.id);
  assert.throws(() => logManualFollowUp(posted, partner.id, today(), { channel: 'email' }), /customer email address/);

  const attempted = runFollowUps(posted, today());
  const progress = partnerFollowUp(read(attempted, 'res.partner', partner.id), 1);
  assert.equal(progress.followup_delivery_state, 'not_sent');
  assert.equal(progress.followup_level_delay, null);
  assert.equal(progress.followup_level, null);
  assert.ok(messagesOf(attempted, 'res.partner', partner.id).some((message) => /no email address.*not advanced/i.test(message.body)));
  assert.equal(messagesOf(runFollowUps(attempted, today()), 'res.partner', partner.id).length, messagesOf(attempted, 'res.partner', partner.id).length);

  const withEmail = write(attempted, 'res.partner', partner.id, { email: 'reminder@example.test' });
  const failed = await runFollowUps(withEmail, addDays(today(), 1), async () => { throw new Error('SMTP unavailable'); });
  assert.equal(partnerFollowUp(read(failed, 'res.partner', partner.id), 1).followup_delivery_state, 'not_sent');
  assert.equal(partnerFollowUp(read(failed, 'res.partner', partner.id), 1).followup_level_delay, null);
  const sent = await runFollowUps(failed, addDays(today(), 1), async () => {});
  const sentProgress = partnerFollowUp(read(sent, 'res.partner', partner.id), 1);
  assert.equal(sentProgress.followup_delivery_state, 'sent');
  assert.equal(sentProgress.followup_level_delay, 15);
  assert.ok(messagesOf(sent, 'res.partner', partner.id).some((message) => /Payment reminder sent by email/.test(message.body)));
});

test('check register includes issued checks and voided reprints alongside batch checks', () => {
  let db = seed();
  const vendor = create(db, 'res.partner', { name: 'R8B Check Vendor' });
  db = vendor.db;
  const makeBill = () => {
    const bill = create(db, 'account.move', {
      move_type: 'in_invoice', partner_id: vendor.id, invoice_date: today(), invoice_date_due: today(),
      invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }],
    });
    db = postMove(bill.db, bill.id);
    return read(db, 'account.move', bill.id);
  };
  const bankJournal = search(db, 'account.journal').find((journal) => journal.code === 'BNK1');
  const batchBill = makeBill();
  const batch = create(db, 'account.batch.payment', {
    batch_type: 'outbound', date: today(), journal_id: bankJournal.id, check_number_start: 9100,
    lines: [{ move_id: batchBill.id, amount: batchBill.amount_residual }],
  });
  const validate = models['account.batch.payment'].form.buttons.find((button) => button.label === 'Validate');
  db = validate.run(batch.db, read(batch.db, 'account.batch.payment', batch.id)).db;

  const individualBill = makeBill();
  db = payMove(db, individualBill.id, read(db, 'account.move', individualBill.id).amount_residual, today(), { journalId: bankJournal.id, checkNumber: 9200 });
  const individualPayment = search(db, 'account.payment').find((payment) => payment.move_id === read(db, 'account.move', individualBill.id).payments.at(-1).move_id);
  const reprint = models['account.payment'].form.buttons.find((button) => button.label === 'Reprint Check');
  db = reprint.run(db, individualPayment).db;

  const rows = checkRegisterRows(db);
  assert.ok(rows.some((row) => row.batchId === batch.id && row.checkNumber === 9100));
  assert.ok(rows.some((row) => row.paymentId === individualPayment.id && row.checkNumber === 9200 && row.state === 'Voided'));
  assert.ok(rows.some((row) => row.paymentId === individualPayment.id && row.checkNumber !== 9200 && row.state === 'Issued'));
});

test('journal audit and ledger tax lines preserve distinct tax IDs when display names match', () => {
  let db = seed();
  const taxAccountId = search(db, 'account.return.type').find((type) => type.category === 'account_return').tax_payable_account_id;
  const income = create(db, 'account.account', { code: 'R8B-TAX-REV', name: 'R8B Taxable Income', account_type: 'income' });
  db = income.db;
  const firstTax = create(db, 'account.tax', { name: 'Same display label', type_tax_use: 'sale', amount_type: 'percent', amount: 10, account_id: taxAccountId });
  const secondTax = create(firstTax.db, 'account.tax', { name: 'Same display label', type_tax_use: 'sale', amount_type: 'percent', amount: 10, account_id: taxAccountId });
  db = secondTax.db;
  const invoiceIds = [];
  for (const taxId of [firstTax.id, secondTax.id]) {
    const tax = read(db, 'account.tax', taxId);
    const invoice = create(db, 'account.move', {
      move_type: 'out_invoice', partner_id: 1, invoice_date: today(), invoice_date_due: today(),
      invoice_line_ids: [{ account_id: income.id, qty: 1, price_unit: 100, ...taxSnapshot(tax) }],
    });
    db = postMove(invoice.db, invoice.id);
    invoiceIds.push(invoice.id);
  }
  const taxLines = invoiceIds.flatMap((id) => read(db, 'account.move', id).line_ids).filter((line) => line.tax_name === 'Same display label' && !line.tax_zero);
  assert.equal(taxLines.length, 2);
  assert.deepEqual(new Set(taxLines.map((line) => line.tax_id)), new Set([firstTax.id, secondTax.id]));
  const rows = journalAudit(db, { from: today(), to: today(), companyId: 1 }).flatMap((group) => group.taxes)
    .filter((tax) => tax.name === 'Same display label');
  assert.equal(rows.length, 2);
  assert.deepEqual(new Set(rows.map((tax) => tax.tax_id)), new Set([firstTax.id, secondTax.id]));
});

