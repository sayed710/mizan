import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, updateSettings, write } from './orm.js';
import { seed } from './seed.js';
import { models } from './models/index.js';
import { postMove, payMove } from './models/accounting.js';
import { postPayment, applyPaymentCredit, reverseEntry } from './models/pay.js';
import { createCompany } from './models/company.js';

test('P1 finding 1: unapplied payment credit from overpayment can be applied to later open invoices', () => {
  const db0 = seed();
  const partner = create(db0, 'res.partner', { name: 'Acme Corp', is_company: true });
  const inv1 = create(partner.db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner.id,
    invoice_date: '2026-06-01',
    invoice_line_ids: [{ name: 'Service A', qty: 1, price_unit: 100, tax: 0 }],
  });
  let db = postMove(inv1.db, inv1.id);
  assert.equal(read(db, 'account.move', inv1.id).amount_residual, 100);

  // Pay 150 against invoice of 100 -> 50 excess as unapplied credit
  db = payMove(db, inv1.id, 150, '2026-06-02');
  const paidInv1 = read(db, 'account.move', inv1.id);
  assert.equal(paidInv1.amount_residual, 0);
  assert.equal(paidInv1.payment_state, 'paid');

  const payment = (db.records['account.payment'] ?? []).find((p) => p.invoice_id === inv1.id);
  assert.ok(payment, 'Payment record must be created');
  assert.equal(payment.state, 'posted');
  assert.equal(payment.amount, 150);
  assert.equal(payment.unapplied, 50);

  // Later invoice is created for the same partner
  const inv2 = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner.id,
    invoice_date: '2026-06-10',
    invoice_line_ids: [{ name: 'Service B', qty: 1, price_unit: 80, tax: 0 }],
  });
  db = postMove(inv2.db, inv2.id);
  assert.equal(read(db, 'account.move', inv2.id).amount_residual, 80);

  // Apply the outstanding credit to inv2
  db = applyPaymentCredit(db, payment.id, inv2.id, '2026-06-10');

  const afterInv2 = read(db, 'account.move', inv2.id);
  assert.equal(afterInv2.amount_paid, 50);
  assert.equal(afterInv2.amount_residual, 30);
  assert.equal(afterInv2.payment_state, 'partial');
  assert.ok((afterInv2.payments ?? []).some((p) => p.move_id === payment.move_id && p.amount === 50));

  const afterPayment = read(db, 'account.payment', payment.id);
  assert.equal(afterPayment.unapplied, 0);
});

test('P1 finding 1: standalone advance payment credit can be matched against multiple later invoices', () => {
  const db0 = seed();
  const partner = create(db0, 'res.partner', { name: 'Globex Inc', is_company: true });
  // Standalone payment with no invoice
  const draftPay = create(partner.db, 'account.payment', {
    partner_id: partner.id,
    partner_type: 'customer',
    payment_type: 'inbound',
    amount: 100,
    date: '2026-07-01',
  });
  let db = postPayment(draftPay.db, read(draftPay.db, 'account.payment', draftPay.id));
  const payment = read(db, 'account.payment', draftPay.id);
  assert.equal(payment.state, 'posted');
  assert.equal(payment.unapplied, 100);

  // Later invoice 1 for 60
  const inv1 = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner.id,
    invoice_date: '2026-07-05',
    invoice_line_ids: [{ name: 'Item 1', qty: 1, price_unit: 60, tax: 0 }],
  });
  db = postMove(inv1.db, inv1.id);

  // Apply credit to inv1 -> settles full 60, 40 credit left
  db = applyPaymentCredit(db, payment.id, inv1.id, '2026-07-05');
  assert.equal(read(db, 'account.move', inv1.id).amount_residual, 0);
  assert.equal(read(db, 'account.move', inv1.id).payment_state, 'paid');
  assert.equal(read(db, 'account.payment', payment.id).unapplied, 40);

  // Later invoice 2 for 50
  const inv2 = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner.id,
    invoice_date: '2026-07-10',
    invoice_line_ids: [{ name: 'Item 2', qty: 1, price_unit: 50, tax: 0 }],
  });
  db = postMove(inv2.db, inv2.id);

  // Apply remaining 40 credit to inv2 -> 10 residual left, 0 credit left
  db = applyPaymentCredit(db, payment.id, inv2.id, '2026-07-10');
  assert.equal(read(db, 'account.move', inv2.id).amount_residual, 10);
  assert.equal(read(db, 'account.move', inv2.id).amount_paid, 40);
  assert.equal(read(db, 'account.payment', payment.id).unapplied, 0);
});

test('P1 finding 1: applyPaymentCredit validates company, commercial partner, document type, and dates', () => {
  const db0 = seed();
  const company2 = createCompany(db0, { name: 'Second Co' });
  let db = updateSettings(company2.db, { allowed_company_ids: [1, company2.id] });

  const parent = create(db, 'res.partner', { name: 'Parent Org', is_company: true });
  const child = create(parent.db, 'res.partner', { name: 'Child Branch', parent_id: parent.id, is_company: false });
  const stranger = create(child.db, 'res.partner', { name: 'Stranger Co', is_company: true });

  const pay = create(stranger.db, 'account.payment', {
    partner_id: parent.id,
    partner_type: 'customer',
    payment_type: 'inbound',
    amount: 100,
    date: '2026-08-05',
  });
  db = postPayment(pay.db, read(pay.db, 'account.payment', pay.id));

  // Child belongs to the same commercial partner -> allowed
  const invChild = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: child.id,
    invoice_date: '2026-08-06',
    invoice_line_ids: [{ qty: 1, price_unit: 30, tax: 0 }],
  });
  db = postMove(invChild.db, invChild.id);
  assert.doesNotThrow(() => {
    applyPaymentCredit(db, pay.id, invChild.id, '2026-08-06');
  });

  // Stranger belongs to different commercial partner -> rejected
  const invStranger = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: stranger.id,
    invoice_date: '2026-08-06',
    invoice_line_ids: [{ qty: 1, price_unit: 30, tax: 0 }],
  });
  db = postMove(invStranger.db, invStranger.id);
  assert.throws(() => applyPaymentCredit(db, pay.id, invStranger.id, '2026-08-06'), /commercial partner/i);

  // Different company -> rejected
  const invOtherCompany = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: company2.id,
    partner_id: parent.id,
    invoice_date: '2026-08-06',
    invoice_line_ids: [{ qty: 1, price_unit: 30, tax: 0 }],
  });
  db = postMove(invOtherCompany.db, invOtherCompany.id);
  assert.throws(() => applyPaymentCredit(db, pay.id, invOtherCompany.id, '2026-08-06'), /company/i);

  // Vendor bill with customer inbound payment -> rejected
  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: parent.id,
    invoice_date: '2026-08-06',
    invoice_line_ids: [{ qty: 1, price_unit: 30, tax: 0 }],
  });
  db = postMove(bill.db, bill.id);
  assert.throws(() => applyPaymentCredit(db, pay.id, bill.id, '2026-08-06'), /settle|type/i);

  // Date before payment date -> rejected
  const invPast = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: parent.id,
    invoice_date: '2026-08-01',
    invoice_line_ids: [{ qty: 1, price_unit: 30, tax: 0 }],
  });
  db = postMove(invPast.db, invPast.id);
  assert.throws(() => applyPaymentCredit(db, pay.id, invPast.id, '2026-08-01'), /application date.*before.*payment date/i);
});

test('P1 finding 2: foreign credit note exchange difference cannot be independently reversed', () => {
  let db = seed();
  const company = createCompany(db, { name: 'Exchange Co' });
  db = updateSettings(company.db, { current_company_id: 1, allowed_company_ids: [1, company.id] });

  for (const [code, accountType] of [['121000', 'asset_receivable'], ['211000', 'liability_payable'], ['FXGAIN', 'income_other'], ['FXLOSS', 'expense_other']]) {
    const account = create(db, 'account.account', { company_id: company.id, code, name: code, account_type: accountType });
    db = account.db;
    if (code === 'FXGAIN') db = write(db, 'res.company', company.id, { income_currency_exchange_account_id: account.id });
    if (code === 'FXLOSS') db = write(db, 'res.company', company.id, { expense_currency_exchange_account_id: account.id });
  }

  const currency = create(db, 'res.currency', { name: 'FC1', rate_ids: [{ date: '2037-01-01', rate: 2 }, { date: '2037-02-01', rate: 1 }] });
  const partner = 2;

  // Invoice posted at rate 2: 100 foreign = 50 company currency
  const document = create(currency.db, 'account.move', {
    move_type: 'out_invoice',
    company_id: company.id,
    partner_id: partner,
    currency_id: currency.id,
    invoice_date: '2037-01-02',
    invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(document.db, document.id);

  // Credit note posted at rate 1: 100 foreign = 100 company currency -> 50 exchange gap
  const note = create(db, 'account.move', {
    move_type: 'out_refund',
    company_id: company.id,
    partner_id: partner,
    currency_id: currency.id,
    reversed_entry_id: document.id,
    invoice_date: '2037-02-02',
    invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(note.db, note.id);

  const fxEntry = search(db, 'account.move').find((m) => m.ref === `Exchange difference ${read(db, 'account.move', note.id).name}`);
  assert.ok(fxEntry, 'Exchange difference entry must exist');
  assert.equal(fxEntry.company_id, company.id);

  // Verify explicit provenance is set on the exchange entry
  assert.equal(fxEntry.fx_payment_move_id, note.id);
  assert.equal(fxEntry.fx_invoice_id, document.id);

  // Check the Reverse Entry button guard on account.move
  const reverseButton = models['account.move'].form.buttons.find((b) => b.label === 'Reverse Entry');
  assert.ok(reverseButton, 'Reverse Entry button must exist');

  // The button's "when" condition must evaluate to FALSE for the credit note exchange entry
  const canReverse = reverseButton.when(fxEntry, db);
  assert.equal(canReverse, false, 'Reverse Entry button must be hidden for reconciliation exchange difference entry');

  // Attempting to run the Reverse Entry button runner directly must throw
  assert.throws(() => {
    reverseButton.run(db, fxEntry, { date: '2037-02-03' });
  }, /available|settle|reconciliation|exchange/i);

  // Attempting to call reverseEntry directly on the fxEntry must throw
  assert.throws(() => {
    reverseEntry(db, fxEntry, '2037-02-03');
  }, /settle|reconciliation|exchange/i);
});
