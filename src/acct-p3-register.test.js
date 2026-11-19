import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

import { seed } from './seed.js';
import { create, read, search, write } from './orm.js';
import { postMove, registerPayment, residual } from './models/accounting.js';
import { models } from './models/index.js';
import { createCompanyWithDefaultInvoiceJournals } from './test-support/accounting-company.js';

const { wizardDefaults } = await import('./views/Wizard.jsx');

test('PAY-1: payment difference keep-open vs mark-as-fully-paid with write-off line and invoice paid', () => {
  const base = seed();
  const bankJournal = search(base, 'account.journal').find((j) => j.default_for_payments === true && (j.company_id ?? 1) === 1);
  const writeoffAccount = search(base, 'account.account').find((a) => a.code === '690000' && (a.company_id ?? 1) === 1)
    || create(base, 'account.account', { name: 'Write-off Account', code: '690000', account_type: 'expense', company_id: 1 });
  let db = writeoffAccount.db ?? base;

  // 1. Keep-open keeps residual and does not create write-off entry
  const inv1 = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-05-01',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(inv1.db, inv1.id);
  const posted1 = read(db, 'account.move', inv1.id);

  const keepOpenRes = registerPayment(db, posted1, {
    amount: '80',
    date: '2026-05-05',
    journal_id: bankJournal.id,
    payment_difference_handling: 'open',
  });
  const afterKeepOpen = read(keepOpenRes.db, 'account.move', inv1.id);
  assert.equal(afterKeepOpen.payment_state, 'partial', 'Invoice must stay partially paid when keep-open is selected');
  assert.equal(residual(afterKeepOpen, keepOpenRes.db), 20, 'Invoice must keep 20 open balance');
  const woLinesKeepOpen = search(keepOpenRes.db, 'account.move').flatMap((m) => m.line_ids ?? []).filter((l) => l.account_id === writeoffAccount.id);
  assert.equal(woLinesKeepOpen.length, 0, 'No write-off line should be created for keep-open');

  // 2. Mark-as-fully-paid books difference on write-off account and invoice ends paid
  const inv2 = create(keepOpenRes.db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-05-01',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(inv2.db, inv2.id);
  const posted2 = read(db, 'account.move', inv2.id);

  const fullPaidRes = registerPayment(db, posted2, {
    amount: '80',
    date: '2026-05-05',
    journal_id: bankJournal.id,
    payment_difference_handling: 'reconcile',
    writeoff_account_id: writeoffAccount.id,
    writeoff_label: 'Write-Off',
  });
  const afterFullPaid = read(fullPaidRes.db, 'account.move', inv2.id);
  assert.equal(residual(afterFullPaid, fullPaidRes.db), 0, 'Invoice residual must be 0 after mark-as-fully-paid');
  assert.equal(afterFullPaid.payment_state, 'paid', 'Invoice payment state must be paid');

  const woLine = search(fullPaidRes.db, 'account.move')
    .flatMap((m) => m.line_ids ?? [])
    .find((l) => l.account_id === writeoffAccount.id && l.name === 'Write-Off');
  assert.ok(woLine, 'Write-off line must be booked on the write-off account');
  assert.equal(woLine.debit, 20, 'Write-off debit must cover the 20 difference');
});

test('PAY-1: wrong-company write-off account rejected', () => {
  let db = seed();
  const bankJournal = search(db, 'account.journal').find((j) => j.default_for_payments === true && (j.company_id ?? 1) === 1);
  const co2 = createCompanyWithDefaultInvoiceJournals(db, { name: 'Branch 2' });
  db = co2.db;
  const co2Account = create(db, 'account.account', { name: 'Co2 Expense', code: '990002', account_type: 'expense', company_id: co2.id });
  db = co2Account.db;

  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: 1,
    invoice_date: '2026-05-01',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);
  const posted = read(db, 'account.move', inv.id);

  assert.throws(
    () => registerPayment(db, posted, {
      amount: '80',
      date: '2026-05-05',
      journal_id: bankJournal.id,
      payment_difference_handling: 'reconcile',
      writeoff_account_id: co2Account.id,
      writeoff_label: 'Write-Off',
    }),
    /Write-off account belongs to another company/,
    'Must reject write-off account belonging to another company',
  );
});

test('PAY-3: foreign-currency payment paying an invoice fully', () => {
  let db = seed();
  const bankJournal = search(db, 'account.journal').find((j) => j.default_for_payments === true && (j.company_id ?? 1) === 1);
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  assert.ok(eur, 'EUR currency must exist');

  // Configure EUR rate on 2026-05-01: 1 USD = 0.8 EUR (so 100 USD = 80 EUR)
  const existingRates = (eur.rate_ids ?? []).filter((r) => r.date !== '2026-05-01');
  db = write(db, 'res.currency', eur.id, {
    rate_ids: [...existingRates, { date: '2026-05-01', rate: 0.8, company_id: null }],
  });

  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-05-01',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);
  const posted = read(db, 'account.move', inv.id);

  // Paying 80 EUR converts to 100 USD and pays the 100 USD invoice fully
  const payRes = registerPayment(db, posted, {
    amount: '80',
    currency_id: eur.id,
    date: '2026-05-01',
    journal_id: bankJournal.id,
  });
  const afterPay = read(payRes.db, 'account.move', inv.id);
  assert.equal(residual(afterPay, payRes.db), 0, 'Invoice residual must be 0 after full foreign payment');
  assert.equal(afterPay.payment_state, 'paid', 'Invoice payment state must be paid');

  const payment = search(payRes.db, 'account.payment').find((p) => p.invoice_id === inv.id);
  assert.ok(payment, 'Payment record must be created');
  assert.equal(payment.currency_id, eur.id, 'Payment must record chosen foreign currency');
  assert.equal(payment.amount, 80, 'Payment amount must be the 80 EUR paid');
});

test('PAY-15: recipient bank passed to the payment', () => {
  let db = seed();
  const bankJournal = search(db, 'account.journal').find((j) => j.default_for_payments === true && (j.company_id ?? 1) === 1);
  const vendor = search(db, 'res.partner').find((p) => p.is_company && p.id !== 1);
  const bankAcc = create(db, 'res.partner.bank', {
    partner_id: vendor.id,
    account_number: 'EG-VEND-PAY-99',
    allow_out_payment: true,
    company_id: 1,
  });
  db = bankAcc.db;

  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: vendor.id,
    partner_bank_id: bankAcc.id,
    invoice_date: '2026-05-01',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(bill.db, bill.id);
  const postedBill = read(db, 'account.move', bill.id);

  const regBtn = models['account.move'].form.buttons.find((b) => b.label === 'Register Payment');
  const wiz = regBtn.wizard(db, postedBill);
  const bankField = wiz.fields.find((f) => f.name === 'partner_bank_id');
  assert.ok(bankField, 'Wizard must include partner_bank_id for vendor bill');
  assert.equal(bankField.label, 'Recipient Bank Account');
  assert.equal(bankField.default, bankAcc.id, 'partner_bank_id must default to bill bank');

  const payRes = regBtn.run(db, postedBill, {
    amount: '100',
    date: '2026-05-01',
    journal_id: bankJournal.id,
    partner_bank_id: bankAcc.id,
  });
  const payment = search(payRes.db, 'account.payment').find((p) => p.invoice_id === bill.id);
  assert.ok(payment, 'Payment record must be created');
  assert.equal(payment.partner_bank_id, bankAcc.id, 'Recipient bank account must be passed to payment');
});

test('PAY-16: discount recomputed on date change', () => {
  let db = seed();
  const term = create(db, 'account.payment.term', {
    name: '2% 10 days',
    early_discount: true,
    discount_percent: 2,
    discount_days: 10,
    discount_tax_computation: 'excluded',
  });
  db = term.db;
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-01-01',
    invoice_payment_term_id: term.id,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);
  const postedInv = read(db, 'account.move', inv.id);

  const regBtn = models['account.move'].form.buttons.find((b) => b.label === 'Register Payment');
  const wiz = regBtn.wizard(db, postedInv);

  // Initial defaults
  const defaults = wizardDefaults(wiz);

  // Date on or before 2026-01-11 offers discounted amount 98
  const withinDiscount = wiz.onchange({ ...defaults, date: '2026-01-05' }, 'date', db);
  assert.equal(withinDiscount.amount, '98', 'Amount must be 98 on early discount date');

  // Date after 2026-01-11 offers full amount 100
  const afterDiscount = wiz.onchange({ ...defaults, date: '2026-01-15' }, 'date', db);
  assert.equal(afterDiscount.amount, '100', 'Amount must be 100 after discount date');

  // Changing date back to within discount window re-offers 98
  const backWithin = wiz.onchange({ ...defaults, date: '2026-01-10' }, 'date', db);
  assert.equal(backWithin.amount, '98', 'Amount must return to 98 when date is within discount window');
});

test('PAY-1 & PAY-3 & PAY-15: wizard field definitions, defaults and visibility', () => {
  let db = seed();
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  const existingRates = (eur.rate_ids ?? []).filter((r) => r.date !== '2026-05-01');
  db = write(db, 'res.currency', eur.id, {
    rate_ids: [...existingRates, { date: '2026-05-01', rate: 0.8, company_id: null }],
  });

  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-05-01',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);
  const postedInv = read(db, 'account.move', inv.id);

  const regBtn = models['account.move'].form.buttons.find((b) => b.label === 'Register Payment');
  const wiz = regBtn.wizard(db, postedInv);

  // Currency field exists, defaults to invoice currency (USD = 1), options/domain active currencies
  const currField = wiz.fields.find((f) => f.name === 'currency_id');
  assert.ok(currField, 'Wizard must include Currency field');
  assert.equal(currField.default, 1, 'Currency must default to invoice currency');
  assert.equal(currField.domain(eur), true, 'Active currency must be included in domain');

  // Changing currency in onchange updates amount to follow chosen currency (100 USD -> 80 EUR)
  const defaults = wizardDefaults(wiz);
  const onCurrChange = wiz.onchange({ ...defaults, currency_id: eur.id, date: '2026-05-01' }, 'currency_id', db);
  assert.equal(onCurrChange.amount, '80', 'Default amount must follow chosen currency');

  // When entered amount is below open amount, difference fields appear
  const diffField = wiz.fields.find((f) => f.name === 'payment_difference');
  assert.ok(diffField, 'payment_difference field must exist');
  assert.equal(diffField.invisible({ amount: 100 }), true, 'payment_difference hidden when amount covers open amount');
  assert.equal(diffField.invisible({ amount: 80 }), false, 'payment_difference visible when amount below open amount');

  const diffHandlingField = wiz.fields.find((f) => f.name === 'payment_difference_handling');
  assert.ok(diffHandlingField, 'payment_difference_handling field must exist');
  assert.equal(diffHandlingField.default, 'open', 'payment_difference_handling defaults to keep open');
  assert.equal(diffHandlingField.invisible({ amount: 100 }), true, 'handling hidden when amount covers open amount');
  assert.equal(diffHandlingField.invisible({ amount: 80 }), false, 'handling visible when amount below open amount');

  const woAccField = wiz.fields.find((f) => f.name === 'writeoff_account_id');
  assert.ok(woAccField, 'writeoff_account_id field must exist');
  assert.equal(woAccField.invisible({ amount: 80, payment_difference_handling: 'open' }), true, 'writeoff_account_id hidden when keep open');
  assert.equal(woAccField.invisible({ amount: 80, payment_difference_handling: 'reconcile' }), false, 'writeoff_account_id visible when reconcile');
  assert.equal(woAccField.required({ amount: 80, payment_difference_handling: 'reconcile' }), true, 'writeoff_account_id required when reconcile');

  const woLabelField = wiz.fields.find((f) => f.name === 'writeoff_label');
  assert.ok(woLabelField, 'writeoff_label field must exist');
  assert.equal(woLabelField.default, 'Write-Off', 'writeoff_label defaults to Write-Off');
  assert.equal(woLabelField.invisible({ amount: 80, payment_difference_handling: 'reconcile' }), false, 'writeoff_label visible when reconcile');
});

test('PAY-3: foreign-currency overpayment leaves the excess as outstanding credit', () => {
  let db = seed();
  const bankJournal = search(db, 'account.journal').find((j) => j.default_for_payments === true && (j.company_id ?? 1) === 1);
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  assert.ok(eur, 'EUR currency must exist');

  // Rate: 1 USD = 0.8 EUR (so 100 USD = 80 EUR, and 120 EUR = 150 USD)
  const existingRates = (eur.rate_ids ?? []).filter((r) => r.date !== '2026-05-01');
  db = write(db, 'res.currency', eur.id, {
    rate_ids: [...existingRates, { date: '2026-05-01', rate: 0.8, company_id: null }],
  });

  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-05-01',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);
  const posted = read(db, 'account.move', inv.id);

  // Paying 120 EUR (converts to 150 USD) against 100 USD invoice
  const payRes = registerPayment(db, posted, {
    amount: '120',
    currency_id: eur.id,
    date: '2026-05-01',
    journal_id: bankJournal.id,
  });
  const afterPay = read(payRes.db, 'account.move', inv.id);
  assert.equal(residual(afterPay, payRes.db), 0, 'Invoice must be fully paid');
  assert.equal(afterPay.payment_state, 'paid', 'Invoice payment state must be paid');

  const payment = search(payRes.db, 'account.payment').find((p) => p.invoice_id === inv.id);
  assert.ok(payment, 'Payment record must be created');
  assert.equal(payment.currency_id, eur.id, 'Payment must record chosen foreign currency');
  assert.equal(payment.amount, 120, 'Payment amount must be 120 EUR');
  assert.equal(payment.unapplied, 50, 'Excess of 50 USD must stay as unapplied outstanding credit');
});

test('PAY-3: missing conversion rate throws Configure currency conversion rate', () => {
  let db = seed();
  const bankJournal = search(db, 'account.journal').find((j) => j.default_for_payments === true && (j.company_id ?? 1) === 1);
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  assert.ok(eur, 'EUR currency must exist');

  // Remove EUR rates so no rate exists
  db = write(db, 'res.currency', eur.id, { rate_ids: [] });

  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-05-01',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);
  const posted = read(db, 'account.move', inv.id);

  // registerPayment with missing rate throws
  assert.throws(
    () => registerPayment(db, posted, {
      amount: '80',
      currency_id: eur.id,
      date: '2026-05-01',
      journal_id: bankJournal.id,
    }),
    /Configure currency conversion rate/,
    'Must throw when currency rate is missing on payment',
  );

  // Wizard onchange with missing rate throws
  const regBtn = models['account.move'].form.buttons.find((b) => b.label === 'Register Payment');
  const wiz = regBtn.wizard(db, posted);
  const defaults = wizardDefaults(wiz);
  assert.throws(
    () => wiz.onchange({ ...defaults, currency_id: eur.id, date: '2026-05-01' }, 'currency_id', db),
    /Configure currency conversion rate/,
    'Must throw when currency rate is missing on wizard onchange',
  );
});

test('PAY-3 & PAY-16: EUR invoice with early-payment discount paid in USD within discount period', () => {
  let db = seed();
  const bankJournal = search(db, 'account.journal').find((j) => j.default_for_payments === true && (j.company_id ?? 1) === 1);
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  const usd = search(db, 'res.currency').find((c) => c.name === 'USD');
  assert.ok(eur, 'EUR currency must exist');
  assert.ok(usd, 'USD currency must exist');

  // Configure early discount expense account on company 1
  const discAccount = search(db, 'account.account').find((a) => a.code === '690000' && (a.company_id ?? 1) === 1)
    || create(db, 'account.account', { name: 'Early discount expense', code: '690000', account_type: 'expense', company_id: 1 });
  db = discAccount.db ?? db;
  db = write(db, 'res.company', 1, {
    expense_early_payment_discount_account_id: discAccount.id,
  });

  // Set exchange rate on 2026-05-01: 1 USD = 0.8 EUR (so 1 EUR = 1.25 USD)
  const existingRates = (eur.rate_ids ?? []).filter((r) => r.date !== '2026-05-01');
  db = write(db, 'res.currency', eur.id, {
    rate_ids: [...existingRates, { date: '2026-05-01', rate: 0.8, company_id: null }],
  });

  // Payment term: 2% within 10 days
  const term = create(db, 'account.payment.term', {
    name: '2% 10 days',
    early_discount: true,
    discount_percent: 2,
    discount_days: 10,
    discount_tax_computation: 'excluded',
  });
  db = term.db;

  // EUR invoice of 100 EUR dated 2026-05-01
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    currency_id: eur.id,
    partner_id: 1,
    invoice_date: '2026-05-01',
    invoice_payment_term_id: term.id,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);
  const posted = read(db, 'account.move', inv.id);

  // 100 EUR invoice with 2% discount = 98 EUR net due within 10 days (on or before 2026-05-11).
  // At 1 USD = 0.8 EUR, 98 EUR = 98 / 0.8 = 122.5 USD.
  // Paying 122.5 USD on 2026-05-05 (within discount period)
  const payRes = registerPayment(db, posted, {
    amount: '122.5',
    currency_id: usd.id,
    date: '2026-05-05',
    journal_id: bankJournal.id,
  });

  const afterPay = read(payRes.db, 'account.move', inv.id);
  assert.equal(residual(afterPay, payRes.db), 0, 'EUR invoice must end fully paid');
  assert.equal(afterPay.payment_state, 'paid', 'Invoice payment state must be paid');

  // Verify early payment discount was booked
  const discPayment = (afterPay.payments ?? []).find((p) => p.discount);
  assert.ok(discPayment, 'Early payment discount settlement must be recorded');
  assert.equal(discPayment.amount, 2, 'Discount amount must be 2 EUR');

  // Verify payment record shows USD amount
  const payment = search(payRes.db, 'account.payment').find((p) => p.invoice_id === inv.id);
  assert.ok(payment, 'Payment record must be created');
  assert.equal(payment.currency_id, usd.id, 'Payment must record USD currency');
  assert.equal(payment.amount, 122.5, 'Payment must record 122.5 USD amount');
});

