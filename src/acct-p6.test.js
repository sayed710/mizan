import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { models } from './models/index.js';
import { seed } from './seed.js';
import { postMove, registerPayment, residual } from './models/accounting.js';
import { postBatch } from './models/payments.js';
import { postPayment, customerPaymentView, vendorPaymentView } from './models/pay.js';
import { applyDiff, diffDb } from './sync.js';
import { today } from './models/common.js';
import { documentCurrency } from './money.js';
import { exchangeAccount } from './models/exchange-account.js';

function postedInvoice(db, { moveType = 'out_invoice', partnerId = 3, companyId = 1, amount = 100, currencyId = null, date = '2026-01-01' } = {}) {
  const line = [{ name: 'Service', qty: 1, price_unit: amount, tax: 0 }];
  const created = create(db, 'account.move', {
    move_type: moveType,
    partner_id: partnerId,
    company_id: companyId,
    invoice_date: date,
    date,
    ...(currencyId ? { currency_id: currencyId } : {}),
    invoice_line_ids: line,
  });
  return { db: postMove(created.db, created.id), id: created.id };
}

function createPayment(db, values) {
  const res = create(db, 'account.payment', {
    amount: 100,
    date: today(),
    state: 'draft',
    ...values,
  });
  return { db: res.db, id: res.id };
}

test('PAY-10: "Create Batch Payment" list action is defined on account.payment and views', () => {
  const payModel = models['account.payment'];
  assert.ok(payModel.listActions, 'account.payment must have listActions');
  const modelAction = payModel.listActions.find((a) => a.label === 'Create Batch Payment');
  assert.ok(modelAction, 'account.payment must have "Create Batch Payment" list action');
  assert.equal(modelAction.requiresSelection, true);

  const custAction = (customerPaymentView.listActions ?? []).find((a) => a.label === 'Create Batch Payment');
  assert.ok(custAction, 'customerPaymentView must have "Create Batch Payment" list action');

  const vendAction = (vendorPaymentView.listActions ?? []).find((a) => a.label === 'Create Batch Payment');
  assert.ok(vendAction, 'vendorPaymentView must have "Create Batch Payment" list action');
});

test('PAY-10: "Create Batch Payment" refuses when selection is empty or mixes journals, directions, or methods', () => {
  let db = seed();
  const payModel = models['account.payment'];
  const action = payModel?.listActions?.find((a) => a.label === 'Create Batch Payment');
  assert.ok(action, 'action exists');

  // Empty selection
  assert.throws(() => action.run(db, []), /Select at least one payment/i);

  // Setup journals
  const bank1 = search(db, 'account.journal').find((j) => j.type === 'bank');
  const cash1 = search(db, 'account.journal').find((j) => j.type === 'cash');

  // Create two payments with different journals
  const p1 = createPayment(db, { payment_type: 'inbound', partner_type: 'customer', partner_id: 3, journal_id: bank1.id, state: 'posted' });
  db = p1.db;
  const p2 = createPayment(db, { payment_type: 'inbound', partner_type: 'customer', partner_id: 3, journal_id: cash1.id, state: 'posted' });
  db = p2.db;

  assert.throws(() => action.run(db, [p1.id, p2.id]), /same journal/i);

  // Create payments with different directions
  const p3 = createPayment(db, { payment_type: 'outbound', partner_type: 'supplier', partner_id: 2, journal_id: bank1.id, state: 'posted' });
  db = p3.db;
  assert.throws(() => action.run(db, [p1.id, p3.id]), /same direction|direction/i);

  // Create payments with different payment methods
  const manualMethod = search(db, 'account.payment.method').find((m) => m.code === 'manual' && m.payment_type === 'inbound');
  const otherMethod = search(db, 'account.payment.method').find((m) => m.payment_type === 'inbound' && m.id !== manualMethod.id);
  if (otherMethod) {
    const l1 = create(db, 'account.payment.method.line', { journal_id: bank1.id, payment_method_id: manualMethod.id, name: 'Manual' });
    db = l1.db;
    const l2 = create(db, 'account.payment.method.line', { journal_id: bank1.id, payment_method_id: otherMethod.id, name: 'Other' });
    db = l2.db;
    const pm1 = createPayment(db, { payment_type: 'inbound', partner_type: 'customer', partner_id: 3, journal_id: bank1.id, payment_method_line_id: l1.id, state: 'posted' });
    db = pm1.db;
    const pm2 = createPayment(db, { payment_type: 'inbound', partner_type: 'customer', partner_id: 3, journal_id: bank1.id, payment_method_line_id: l2.id, state: 'posted' });
    db = pm2.db;
    assert.throws(() => action.run(db, [pm1.id, pm2.id]), /payment method/i);
  }
});

test('PAY-10: "Create Batch Payment" refuses payments not posted, already matched, or already in a batch', () => {
  let db = seed();
  const bank1 = search(db, 'account.journal').find((j) => j.type === 'bank');
  const action = models['account.payment']?.listActions?.find((a) => a.label === 'Create Batch Payment');
  assert.ok(action, 'action exists');

  // Not posted
  const draftPay = createPayment(db, { payment_type: 'inbound', partner_type: 'customer', partner_id: 3, journal_id: bank1.id, state: 'draft' });
  db = draftPay.db;
  const postedPay = createPayment(db, { payment_type: 'inbound', partner_type: 'customer', partner_id: 3, journal_id: bank1.id, state: 'posted' });
  db = postedPay.db;
  assert.throws(() => action.run(db, [draftPay.id, postedPay.id]), /posted/i);

  // Already matched in bank reconciliation
  const st = create(db, 'account.bank.statement', { name: 'BNK/001', journal_id: bank1.id, date: today() });
  db = st.db;
  const payToMatch = createPayment(db, {
    payment_type: 'inbound', partner_type: 'customer', partner_id: 3, journal_id: bank1.id,
  });
  db = postPayment(payToMatch.db, read(payToMatch.db, 'account.payment', payToMatch.id));
  const postedPayToMatch = read(db, 'account.payment', payToMatch.id);
  const stLine = create(db, 'account.bank.statement.line', {
    statement_id: st.id,
    journal_id: bank1.id,
    amount: 100,
    payment_ref: 'Test',
    state: 'reconciled',
    payment_id: postedPayToMatch.id,
    payment_move_id: postedPayToMatch.move_id,
    move_id: postedPayToMatch.move_id,
    open_amount: 0,
  });
  db = stLine.db;
  assert.throws(() => action.run(db, [payToMatch.id]), /matched/i);

  // Already in a batch
  const existingBatch = create(db, 'account.batch.payment', {
    batch_type: 'inbound',
    journal_id: bank1.id,
    lines: [{ payment_id: postedPay.id, amount: 100 }],
  });
  db = existingBatch.db;
  assert.throws(() => action.run(db, [postedPay.id]), /already in a batch|batch/i);
});

test('PAY-10: "Create Batch Payment" builds a draft batch from valid payments, redirects, and validates cleanly', () => {
  let db = seed();
  const bank1 = search(db, 'account.journal').find((j) => j.type === 'bank');
  const methodLine = search(db, 'account.payment.method.line').find((l) => l.journal_id === bank1.id && l.payment_type === 'inbound');

  const inv1 = postedInvoice(db, { partnerId: 3, amount: 150 });
  db = inv1.db;
  const inv2 = postedInvoice(db, { partnerId: 4, amount: 250 });
  db = inv2.db;

  const p1 = createPayment(db, { payment_type: 'inbound', partner_type: 'customer', partner_id: 3, journal_id: bank1.id, payment_method_line_id: methodLine?.id, amount: 150, invoice_id: inv1.id });
  db = postPayment(p1.db, read(p1.db, 'account.payment', p1.id));
  const p2 = createPayment(db, { payment_type: 'inbound', partner_type: 'customer', partner_id: 4, journal_id: bank1.id, payment_method_line_id: methodLine?.id, amount: 250, invoice_id: inv2.id });
  db = postPayment(p2.db, read(p2.db, 'account.payment', p2.id));

  const action = models['account.payment']?.listActions?.find((a) => a.label === 'Create Batch Payment');
  assert.ok(action, 'action exists');

  const res = action.run(db, [p1.id, p2.id]);
  assert.ok(res.db, 'returns db');
  assert.ok(res.id, 'returns batch id');
  assert.equal(res.go, `#/accounting/batch-payments/${res.id}`);

  const batch = read(res.db, 'account.batch.payment', res.id);
  assert.equal(batch.state, 'draft');
  assert.equal(batch.batch_type, 'inbound');
  assert.equal(batch.journal_id, bank1.id);
  assert.equal(batch.payment_method_id, methodLine.payment_method_id);
  assert.equal(batch.lines.length, 2);
  assert.equal(batch.lines[0].payment_id, p1.id);
  assert.equal(batch.lines[0].amount, 150);
  assert.equal(batch.lines[1].payment_id, p2.id);
  assert.equal(batch.lines[1].amount, 250);

  const postedBatchDb = postBatch(res.db, batch);
  assert.equal(read(postedBatchDb, 'account.batch.payment', res.id).state, 'posted');

  // Outbound check payments also batch and validate cleanly
  const outCheckLine = search(db, 'account.payment.method.line').find((l) => l.journal_id === bank1.id && l.payment_type === 'outbound' && read(db, 'account.payment.method', l.payment_method_id)?.code === 'check_printing');
  const bill = postedInvoice(db, { moveType: 'in_invoice', partnerId: 2, amount: 80 });
  db = bill.db;
  const op1 = createPayment(db, { payment_type: 'outbound', partner_type: 'supplier', partner_id: 2, journal_id: bank1.id, payment_method_line_id: outCheckLine?.id, amount: 80, invoice_id: bill.id });
  db = postPayment(op1.db, read(op1.db, 'account.payment', op1.id));
  const outRes = action.run(db, [op1.id]);
  const outBatch = read(outRes.db, 'account.batch.payment', outRes.id);
  assert.equal(outBatch.payment_method_id, outCheckLine.payment_method_id);
  const postedOutDb = postBatch(outRes.db, outBatch);
  assert.equal(read(postedOutDb, 'account.batch.payment', outRes.id).state, 'posted');
});

test('FX-9: currency_id is editable when invoice_id is set and rejects inactive currency', () => {
  let db = seed();
  const invoice = postedInvoice(db);
  db = invoice.db;

  const payDef = models['account.payment'].fields.currency_id;
  const isReadonly = typeof payDef.readonly === 'function' ? payDef.readonly({ invoice_id: invoice.id }) : payDef.readonly;
  assert.notEqual(isReadonly, true, 'currency_id must not be readonly when invoice_id is set');

  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  db = write(db, 'res.currency', eur.id, { active: false });

  // Creation with inactive currency is rejected by guard
  assert.throws(() => createPayment(db, {
    invoice_id: invoice.id,
    currency_id: eur.id,
    amount: 50,
  }), /active/i);

  // Server guard through diffDb + applyDiff
  assert.throws(() => applyDiff(db, {
    upserts: {
      'account.payment': [{
        id: 9999,
        invoice_id: invoice.id,
        currency_id: eur.id,
        amount: 50,
      }],
    },
  }, { isAdmin: true }), /active/i);

  // postPayment also refuses inactive currency
  const invRec = read(db, 'account.move', invoice.id);
  const activePay = createPayment(db, {
    invoice_id: invoice.id,
    partner_id: invRec.partner_id,
    partner_type: 'customer',
    payment_type: 'inbound',
    amount: 50,
  });
  // Setting inactive currency is refused by guard on write
  assert.throws(() => write(activePay.db, 'account.payment', activePay.id, { currency_id: eur.id }), /active/i);
});

test('FX-9: account.payment settles invoice in another active currency with exchange difference', () => {
  let db = seed();
  const usd = search(db, 'res.currency').find((c) => c.name === 'USD');
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');

  // Set EUR rates: on invoice date 2026-01-01, 1 USD = 0.8 EUR (100 EUR = 125 USD).
  // On payment date 2026-02-01, 1 USD = 1.0 EUR (100 USD = 100 EUR) -> 25 USD exchange difference.
  db = write(db, 'res.currency', eur.id, {
    rate_ids: [
      { date: '2026-01-01', rate: 0.8, company_id: null },
      { date: '2026-02-01', rate: 1.0, company_id: null },
    ],
  });

  // Invoice in EUR for 100 EUR on 2026-01-01 (booked at 125 USD receivable)
  const inv = postedInvoice(db, { amount: 100, currencyId: eur.id, date: '2026-01-01' });
  db = inv.db;
  const invRec = read(db, 'account.move', inv.id);
  assert.equal(documentCurrency(db, invRec).name, 'EUR');

  // Create draft payment in USD for 100 USD on 2026-02-01
  const bank = search(db, 'account.journal').find((j) => j.type === 'bank');
  const pay = createPayment(db, {
    invoice_id: inv.id,
    currency_id: usd.id,
    amount: 100,
    date: '2026-02-01',
    journal_id: bank.id,
    payment_type: 'inbound',
    partner_type: 'customer',
    partner_id: invRec.partner_id,
  });
  db = pay.db;

  const wizardDb = registerPayment(db, invRec, {
    amount: 100, date: '2026-02-01', journal_id: bank.id, currency_id: usd.id,
    memo: read(db, 'account.payment', pay.id).memo,
  }).db;
  const wizardInvoice = read(wizardDb, 'account.move', inv.id);
  const wizardEntry = read(wizardDb, 'account.move', wizardInvoice.payments.find((p) => !p.discount).move_id);

  const postedDb = postPayment(db, read(db, 'account.payment', pay.id));
  const postedPay = read(postedDb, 'account.payment', pay.id);
  assert.equal(postedPay.state, 'posted');
  assert.equal(postedPay.currency_id, usd.id);
  assert.equal(postedPay.amount, 100);

  const entry = read(postedDb, 'account.move', postedPay.move_id);
  assert.equal(entry.state, 'posted');
  assert.deepEqual(entry.line_ids, wizardEntry.line_ids);

  // Verify exchange difference line (25 USD loss) is booked on the payment entry
  const lossAccId = exchangeAccount(postedDb, 1, -25);
  const fxLine = entry.line_ids.find((l) => l.account_id === lossAccId);
  assert.ok(fxLine, 'FX loss line must be booked');
  assert.equal(fxLine.debit, 25);

  const updatedInv = read(postedDb, 'account.move', inv.id);
  assert.equal(residual(updatedInv, postedDb), 0);
  assert.equal(updatedInv.payment_state, 'paid');

  // Server-side guard diffDb + applyDiff replay
  const synced = applyDiff(db, diffDb(db, postedDb), { isAdmin: true });
  assert.equal(read(synced, 'account.payment', pay.id).state, 'posted');
  assert.deepEqual(read(synced, 'account.move', postedPay.move_id).line_ids, wizardEntry.line_ids);

  // Also verify USD invoice settled in EUR (rate 1 USD = 0.8 EUR -> 80 EUR settles 100 USD)
  const usdInv = postedInvoice(postedDb, { amount: 100, currencyId: usd.id, date: '2026-01-01' });
  const eurPay = createPayment(usdInv.db, {
    invoice_id: usdInv.id,
    currency_id: eur.id,
    amount: 80,
    date: '2026-01-01',
    journal_id: bank.id,
    payment_type: 'inbound',
    partner_type: 'customer',
    partner_id: 3,
  });
  const wizardEurDb = registerPayment(eurPay.db, read(eurPay.db, 'account.move', usdInv.id), {
    amount: 80, date: '2026-01-01', journal_id: bank.id, currency_id: eur.id,
    memo: read(eurPay.db, 'account.payment', eurPay.id).memo,
  }).db;
  const wizardEurInvoice = read(wizardEurDb, 'account.move', usdInv.id);
  const wizardEurEntry = read(wizardEurDb, 'account.move', wizardEurInvoice.payments.find((p) => !p.discount).move_id);

  const postedEurDb = postPayment(eurPay.db, read(eurPay.db, 'account.payment', eurPay.id));
  const postedEurPay = read(postedEurDb, 'account.payment', eurPay.id);
  assert.equal(postedEurPay.state, 'posted');
  assert.equal(postedEurPay.currency_id, eur.id);
  assert.equal(postedEurPay.amount, 80);
  assert.equal(residual(read(postedEurDb, 'account.move', usdInv.id), postedEurDb), 0);
  assert.deepEqual(read(postedEurDb, 'account.move', postedEurPay.move_id).line_ids, wizardEurEntry.line_ids);
  const syncedEur = applyDiff(eurPay.db, diffDb(eurPay.db, postedEurDb), { isAdmin: true });
  assert.equal(read(syncedEur, 'account.payment', eurPay.id).state, 'posted');
  assert.deepEqual(read(syncedEur, 'account.move', postedEurPay.move_id).line_ids, wizardEurEntry.line_ids);
});

test('Regression PR #208: createBatchPayment supports non-check payouts and refund payments, enforces same payment method, and strictly declares payment_method_id', () => {
  let db = seed();
  const bank = search(db, 'account.journal').find((j) => j.type === 'bank');
  const cash = search(db, 'account.journal').find((j) => j.type === 'cash');
  const action = models['account.payment'].listActions.find((a) => a.label === 'Create Batch Payment');
  assert.ok(action, 'Create Batch Payment action exists');

  const checkMethod = search(db, 'account.payment.method').find((m) => m.code === 'check_printing' && m.payment_type === 'outbound');
  const manualOutMethod = search(db, 'account.payment.method').find((m) => m.code === 'manual' && m.payment_type === 'outbound');
  const outCheckLine = search(db, 'account.payment.method.line').find((l) => l.journal_id === bank.id && l.payment_method_id === checkMethod.id);
  const outManualLine = search(db, 'account.payment.method.line').find((l) => l.journal_id === bank.id && l.payment_method_id === manualOutMethod.id);

  // Finding 1: Outbound batches can be manual (non-check) payments
  // a) Outbound payment with manual method creates batch and posts cleanly
  const nonCheckPay = createPayment(db, {
    payment_type: 'outbound',
    partner_type: 'supplier',
    partner_id: 2,
    journal_id: bank.id,
    payment_method_line_id: outManualLine?.id,
    amount: 100,
  });
  db = postPayment(nonCheckPay.db, read(nonCheckPay.db, 'account.payment', nonCheckPay.id));
  const manualRes = action.run(db, [nonCheckPay.id]);
  assert.ok(manualRes.id, 'manual batch created');
  const manualBatch = read(manualRes.db, 'account.batch.payment', manualRes.id);
  assert.equal(manualBatch.payment_method_id, manualOutMethod.id);
  const postedManualDb = postBatch(manualRes.db, manualBatch);
  assert.equal(read(postedManualDb, 'account.batch.payment', manualRes.id).state, 'posted');

  // Print Checks button is hidden for manual batches
  const printChecksBtn = models['account.batch.payment'].form.buttons.find((b) => b.label === 'Print Checks');
  assert.equal(printChecksBtn.when(read(postedManualDb, 'account.batch.payment', manualRes.id), postedManualDb), false);

  // Enforce all selected payments use the same payment method
  const checkPayForMix = createPayment(db, {
    payment_type: 'outbound',
    partner_type: 'supplier',
    partner_id: 2,
    journal_id: bank.id,
    payment_method_line_id: outCheckLine.id,
    amount: 50,
  });
  db = postPayment(checkPayForMix.db, read(checkPayForMix.db, 'account.payment', checkPayForMix.id));
  assert.throws(() => action.run(db, [nonCheckPay.id, checkPayForMix.id]), /Selected payments must use the same payment method/);

  // b) Outbound check payment on a cash journal rejected
  const cashCheckLine = create(db, 'account.payment.method.line', {
    name: 'Checks',
    journal_id: cash.id,
    payment_method_id: checkMethod.id,
    payment_type: 'outbound',
  });
  db = cashCheckLine.db;
  const cashCheckPay = createPayment(db, {
    payment_type: 'outbound',
    partner_type: 'supplier',
    partner_id: 2,
    journal_id: cash.id,
    payment_method_line_id: cashCheckLine.id,
    state: 'posted',
  });
  db = cashCheckPay.db;
  assert.throws(() => action.run(db, [cashCheckPay.id]), /Checks require a bank journal/);

  // c) Outbound check payment on bank journal without check method line rejected
  const bank2 = create(db, 'account.journal', {
    name: 'Bank 2',
    code: 'BNK2',
    type: 'bank',
    suspense_account_id: bank.suspense_account_id,
    default_account_id: bank.default_account_id,
  });
  db = bank2.db;
  const bank2CheckLine = search(db, 'account.payment.method.line').find((l) => l.journal_id === bank2.id && l.payment_method_id === checkMethod.id);
  const noCheckLinePay = createPayment(db, {
    payment_type: 'outbound',
    partner_type: 'supplier',
    partner_id: 2,
    journal_id: bank2.id,
    state: 'posted',
    payment_method_line_id: bank2CheckLine?.id,
  });
  db = noCheckLinePay.db;
  // Reassign bank2's check line to bank so the line still exists (paymentPaysByCheck remains true),
  // but bank2 itself has no check method line.
  db = {
    ...db,
    records: {
      ...db.records,
      'account.payment.method.line': db.records['account.payment.method.line'].map((l) => (l.journal_id === bank2.id && l.payment_method_id === checkMethod.id ? { ...l, journal_id: bank.id } : l)),
    },
  };
  assert.throws(() => action.run(db, [noCheckLinePay.id]), /The batch journal has no check payment method/);

  // Finding 2: Mixed-currency batches cannot be posted
  const usd = search(db, 'res.currency').find((c) => c.name === 'USD');
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  const inMethodLine = search(db, 'account.payment.method.line').find((l) => l.journal_id === bank.id && l.payment_type === 'inbound');

  const payUsd = createPayment(db, {
    payment_type: 'inbound',
    partner_type: 'customer',
    partner_id: 3,
    journal_id: bank.id,
    payment_method_line_id: inMethodLine.id,
    currency_id: usd.id,
    state: 'posted',
  });
  db = payUsd.db;
  const payEur = createPayment(db, {
    payment_type: 'inbound',
    partner_type: 'customer',
    partner_id: 3,
    journal_id: bank.id,
    payment_method_line_id: inMethodLine.id,
    currency_id: eur.id,
    state: 'posted',
  });
  db = payEur.db;
  // Mixed currencies rejected
  assert.throws(() => action.run(db, [payUsd.id, payEur.id]), /Batch invoices must use the same currency/);

  // Fixed journal currency mismatch rejected
  const fixedBankDb = {
    ...db,
    records: {
      ...db.records,
      'account.journal': db.records['account.journal'].map((j) => (j.id === bank.id ? { ...j, currency_id: usd.id } : j)),
    },
  };
  const payEurOnFixedBank = createPayment(fixedBankDb, {
    payment_type: 'inbound',
    partner_type: 'customer',
    partner_id: 3,
    journal_id: bank.id,
    payment_method_line_id: inMethodLine.id,
    currency_id: eur.id,
    state: 'posted',
  });
  assert.throws(() => action.run(payEurOnFixedBank.db, [payEurOnFixedBank.id]), /Batch currency must match the journal currency/);

  // Finding 3: Refund payments can sit in batches and post cleanly
  // Outbound batch holding a vendor payment and a customer refund posts
  const billForBatch = postedInvoice(db, { moveType: 'in_invoice', partnerId: 2, amount: 80 });
  db = billForBatch.db;
  const vendorPay = createPayment(db, {
    payment_type: 'outbound',
    partner_type: 'supplier',
    partner_id: 2,
    journal_id: bank.id,
    payment_method_line_id: outCheckLine.id,
    amount: 80,
    invoice_id: billForBatch.id,
  });
  db = postPayment(vendorPay.db, read(vendorPay.db, 'account.payment', vendorPay.id));

  const custRefund = createPayment(db, {
    payment_type: 'outbound',
    partner_type: 'customer',
    partner_id: 3,
    journal_id: bank.id,
    payment_method_line_id: outCheckLine.id,
    amount: 45,
  });
  db = postPayment(custRefund.db, read(custRefund.db, 'account.payment', custRefund.id));

  const refundBatchRes = action.run(db, [vendorPay.id, custRefund.id]);
  assert.ok(refundBatchRes.id, 'batch created with vendor payment and customer refund');
  const refundBatch = read(refundBatchRes.db, 'account.batch.payment', refundBatchRes.id);
  assert.equal(refundBatch.lines.length, 2);
  assert.equal(refundBatch.batch_type, 'outbound');
  assert.equal(refundBatch.payment_method_id, checkMethod.id);

  const postedRefundDb = postBatch(refundBatchRes.db, refundBatch);
  const postedRefundBatch = read(postedRefundDb, 'account.batch.payment', refundBatchRes.id);
  assert.equal(postedRefundBatch.state, 'posted');
  assert.equal(printChecksBtn.when(postedRefundBatch, postedRefundDb), true);

  // Inbound batch holding a customer payment and a vendor refund also batches and posts
  const custPayIn = createPayment(db, {
    payment_type: 'inbound',
    partner_type: 'customer',
    partner_id: 3,
    journal_id: bank.id,
    payment_method_line_id: inMethodLine.id,
    amount: 50,
  });
  db = postPayment(custPayIn.db, read(custPayIn.db, 'account.payment', custPayIn.id));
  const vendRefundIn = createPayment(db, {
    payment_type: 'inbound',
    partner_type: 'supplier',
    partner_id: 2,
    journal_id: bank.id,
    payment_method_line_id: inMethodLine.id,
    amount: 30,
  });
  db = postPayment(vendRefundIn.db, read(vendRefundIn.db, 'account.payment', vendRefundIn.id));
  const inBatchRes = action.run(db, [custPayIn.id, vendRefundIn.id]);
  assert.ok(inBatchRes.id);
  const postedInDb = postBatch(inBatchRes.db, read(inBatchRes.db, 'account.batch.payment', inBatchRes.id));
  assert.equal(read(postedInDb, 'account.batch.payment', inBatchRes.id).state, 'posted');

  // Finding 4: Strict-field mode and diffDb+applyDiff replay for payment_method_id
  const origStrict = process.env.MIZAN_STRICT_FIELDS;
  try {
    process.env.MIZAN_STRICT_FIELDS = '1';
    const validPay1 = createPayment(db, {
      payment_type: 'inbound',
      partner_type: 'customer',
      partner_id: 3,
      journal_id: bank.id,
      payment_method_line_id: inMethodLine.id,
      state: 'posted',
    });
    db = validPay1.db;
    const res = action.run(db, [validPay1.id]);
    assert.ok(res.id, 'batch created under strict fields');
    const createdBatch = read(res.db, 'account.batch.payment', res.id);
    assert.equal(createdBatch.payment_method_id, inMethodLine.payment_method_id);

    // Diff/applyDiff server sync preserves payment_method_id
    const synced = applyDiff(db, diffDb(db, res.db), { isAdmin: true });
    const syncedBatch = read(synced, 'account.batch.payment', res.id);
    assert.equal(syncedBatch.payment_method_id, inMethodLine.payment_method_id, 'payment_method_id must persist across sync');
  } finally {
    if (origStrict === undefined) delete process.env.MIZAN_STRICT_FIELDS;
    else process.env.MIZAN_STRICT_FIELDS = origStrict;
  }
});
