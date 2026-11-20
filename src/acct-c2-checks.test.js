import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

import { create, read, search, unlink, write } from './orm.js';
import { seed } from './seed.js';
import { models } from './models/index.js';
import { postMove, payMove } from './models/accounting.js';
import { postBatch, checkRegisterRows } from './models/payments.js';
import {
  paymentPaysByCheck,
  printCheck,
  printBatchChecks,
  voidCheck,
  reprintCheck,
  paymentRemittanceLines,
  postPayment,
  resetPaymentToDraft,
} from './models/pay.js';
import { applyDiff, diffDb } from './sync.js';
import { today } from './models/common.js';
import { fieldReadonly } from './field-metadata.js';

const sync = (db, next, opts = { isAdmin: true }) => applyDiff(db, diffDb(db, next), opts);

test('PAY-4: numbering on print assigns check_number and increments journal check_next_number; non-check payments never get check_number', () => {
  let db = seed();
  const bank = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  assert.ok(bank, 'BNK1 exists');

  // Set next check number on bank journal
  db = write(db, 'account.journal', bank.id, { check_next_number: 500 });

  const checkMethodLine = bank.outbound_payment_method_line_ids.find(
    (l) => read(db, 'account.payment.method', l.payment_method_id).code === 'check_printing'
  );
  const manualMethodLine = bank.outbound_payment_method_line_ids.find(
    (l) => read(db, 'account.payment.method', l.payment_method_id).code === 'manual'
  );
  assert.ok(checkMethodLine, 'check method line exists');
  assert.ok(manualMethodLine, 'manual method line exists');

  const partner = search(db, 'res.partner')[0];

  // 1. Bill paid by check
  const bill1 = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: partner.id,
    invoice_date: today(),
    invoice_line_ids: [{ name: 'Item', price_unit: 100, qty: 1 }],
  });
  db = postMove(bill1.db, bill1.id);

  const draftPay1 = create(db, 'account.payment', {
    payment_type: 'outbound',
    partner_type: 'supplier',
    partner_id: partner.id,
    amount: 100,
    journal_id: bank.id,
    payment_method_line_id: checkMethodLine.id,
  });
  db = payMove(draftPay1.db, bill1.id, 100, today(), {
    paymentId: draftPay1.id,
    journalId: bank.id,
  });

  const checkPay = read(db, 'account.payment', draftPay1.id);
  assert.equal(paymentPaysByCheck(db, checkPay), true);
  assert.ok(checkPay.check_number == null, 'No check number before print');

  // Form button "Print Check" is available
  const printBtn = models['account.payment'].form.buttons.find((b) => b.label === 'Print Check');
  assert.ok(printBtn, 'Print Check button exists on account.payment');
  assert.equal(printBtn.when(checkPay, db), true);

  // Printing assigns next check number and increments journal check_next_number
  db = printCheck(db, checkPay);
  const printedPay = read(db, 'account.payment', checkPay.id);
  assert.equal(printedPay.check_number, 500);

  const updatedBank = read(db, 'account.journal', bank.id);
  assert.equal(updatedBank.check_next_number, 501);

  // After print, "Print Check" button is no longer available
  assert.equal(printBtn.when(printedPay, db), false);

  // 2. Bill paid by manual payment
  const bill2 = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: partner.id,
    invoice_date: today(),
    invoice_line_ids: [{ name: 'Item 2', price_unit: 50, qty: 1 }],
  });
  db = postMove(bill2.db, bill2.id);

  const draftPay2 = create(db, 'account.payment', {
    payment_type: 'outbound',
    partner_type: 'supplier',
    partner_id: partner.id,
    amount: 50,
    journal_id: bank.id,
    payment_method_line_id: manualMethodLine.id,
  });
  db = payMove(draftPay2.db, bill2.id, 50, today(), {
    paymentId: draftPay2.id,
    journalId: bank.id,
  });

  const manualPay = read(db, 'account.payment', draftPay2.id);
  assert.equal(paymentPaysByCheck(db, manualPay), false);
  assert.ok(manualPay.check_number == null, 'Manual payment has no check number');
  assert.equal(printBtn.when(manualPay, db), false, 'Print Check button not shown for non-check payment');

  // Server guard rejects check_number on non-check payment
  assert.throws(() => {
    sync(db, write(db, 'account.payment', manualPay.id, { check_number: 999 }));
  }, /check/i);
});

test('PAY-7: no numbering at batch validation; batch Print Checks numbers check payments in order', () => {
  let db = seed();
  const bank = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  db = write(db, 'account.journal', bank.id, { check_next_number: 700 });

  const partner = search(db, 'res.partner')[0];

  const bill1 = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: partner.id,
    invoice_date: today(),
    invoice_line_ids: [{ name: 'Batch Item 1', price_unit: 120, qty: 1 }],
  });
  db = postMove(bill1.db, bill1.id);

  const bill2 = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: partner.id,
    invoice_date: today(),
    invoice_line_ids: [{ name: 'Batch Item 2', price_unit: 180, qty: 1 }],
  });
  db = postMove(bill2.db, bill2.id);

  const batch = create(db, 'account.batch.payment', {
    batch_type: 'outbound',
    journal_id: bank.id,
    date: today(),
    lines: [
      { move_id: bill1.id, amount: 120 },
      { move_id: bill2.id, amount: 180 },
    ],
  });

  // Validating a batch payment NO LONGER consumes check numbers
  db = postBatch(batch.db, read(batch.db, 'account.batch.payment', batch.id));
  const postedBatch = read(db, 'account.batch.payment', batch.id);
  assert.equal(postedBatch.state, 'posted');

  // Payments and lines have NO check numbers assigned
  for (const line of postedBatch.lines) {
    assert.ok(line.check_number == null, 'Batch line has no check number after postBatch');
    const payment = read(db, 'account.payment', line.payment_id);
    assert.ok(payment.check_number == null, 'Payment has no check number after postBatch');
  }

  // Journal check_next_number was NOT consumed
  assert.equal(read(db, 'account.journal', bank.id).check_next_number, 700);

  // Printing batch checks numbers them in order using the same numbering helper
  const printBatchBtn = models['account.batch.payment'].form.buttons.find((b) => b.label === 'Print Checks');
  assert.ok(printBatchBtn, 'Print Checks button exists on batch');
  const printRes = printBatchBtn.run(db, postedBatch);
  db = printRes.db;

  const printedBatch = read(db, 'account.batch.payment', batch.id);
  assert.equal(printedBatch.lines[0].check_number, 700);
  assert.equal(printedBatch.lines[1].check_number, 701);

  assert.equal(read(db, 'account.payment', printedBatch.lines[0].payment_id).check_number, 700);
  assert.equal(read(db, 'account.payment', printedBatch.lines[1].payment_id).check_number, 701);
  assert.equal(read(db, 'account.journal', bank.id).check_next_number, 702);
});

test('PAY-8: manual sequencing uniqueness guard per journal and journal check fields', () => {
  let db = seed();
  const bank = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  const bankDef = models['account.journal'].fields;
  assert.ok(bankDef.check_manual_sequencing, 'check_manual_sequencing field exists on journal');
  assert.ok(bankDef.check_printing_layout, 'check_printing_layout field exists on journal');

  // Configure journal with manual sequencing and middle layout
  db = write(db, 'account.journal', bank.id, {
    check_manual_sequencing: true,
    check_printing_layout: 'middle',
  });
  const configuredBank = read(db, 'account.journal', bank.id);
  assert.equal(configuredBank.check_manual_sequencing, true);
  assert.equal(configuredBank.check_printing_layout, 'middle');

  const checkMethodLine = bank.outbound_payment_method_line_ids.find(
    (l) => read(db, 'account.payment.method', l.payment_method_id).code === 'check_printing'
  );

  const partner = search(db, 'res.partner')[0];

  // Create payment 1 with manual check number 888
  const bill1 = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: partner.id,
    invoice_date: today(),
    invoice_line_ids: [{ name: 'Item', price_unit: 100, qty: 1 }],
  });
  db = postMove(bill1.db, bill1.id);
  const draftPay1 = create(db, 'account.payment', {
    payment_type: 'outbound',
    partner_type: 'supplier',
    partner_id: partner.id,
    amount: 100,
    journal_id: bank.id,
    payment_method_line_id: checkMethodLine.id,
  });
  db = payMove(draftPay1.db, bill1.id, 100, today(), {
    paymentId: draftPay1.id,
    journalId: bank.id,
  });
  db = sync(db, write(db, 'account.payment', draftPay1.id, { check_number: 888 }));
  assert.equal(read(db, 'account.payment', draftPay1.id).check_number, 888);

  // Create payment 2 on same journal and try to use the same check number 888
  const bill2 = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: partner.id,
    invoice_date: today(),
    invoice_line_ids: [{ name: 'Item 2', price_unit: 100, qty: 1 }],
  });
  db = postMove(bill2.db, bill2.id);
  const draftPay2 = create(db, 'account.payment', {
    payment_type: 'outbound',
    partner_type: 'supplier',
    partner_id: partner.id,
    amount: 100,
    journal_id: bank.id,
    payment_method_line_id: checkMethodLine.id,
  });
  db = payMove(draftPay2.db, bill2.id, 100, today(), {
    paymentId: draftPay2.id,
    journalId: bank.id,
  });

  // Must fail via diffDb + applyDiff because check numbers must be unique per journal
  assert.throws(() => {
    sync(db, write(db, 'account.payment', draftPay2.id, { check_number: 888 }));
  }, /unique/i);
});

test('PAY-9: void check records check as voided, keeps number in register, allows reprint or print on new number or reset', () => {
  let db = seed();
  const bank = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  db = write(db, 'account.journal', bank.id, { check_next_number: 600 });

  const checkMethodLine = bank.outbound_payment_method_line_ids.find(
    (l) => read(db, 'account.payment.method', l.payment_method_id).code === 'check_printing'
  );
  const partner = search(db, 'res.partner')[0];

  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: partner.id,
    invoice_date: today(),
    invoice_line_ids: [{ name: 'Void Test Item', price_unit: 250, qty: 1 }],
  });
  db = postMove(bill.db, bill.id);
  const draftPay = create(db, 'account.payment', {
    payment_type: 'outbound',
    partner_type: 'supplier',
    partner_id: partner.id,
    amount: 250,
    journal_id: bank.id,
    payment_method_line_id: checkMethodLine.id,
  });
  db = payMove(draftPay.db, bill.id, 250, today(), {
    paymentId: draftPay.id,
    journalId: bank.id,
  });

  const pay = read(db, 'account.payment', draftPay.id);
  db = printCheck(db, pay);
  assert.equal(read(db, 'account.payment', pay.id).check_number, 600);

  // Void Check button exists
  const voidBtn = models['account.payment'].form.buttons.find((b) => b.label === 'Void Check');
  assert.ok(voidBtn, 'Void Check button exists');
  assert.equal(voidBtn.when(read(db, 'account.payment', pay.id), db), true);

  // Void the check (diffDb + applyDiff compatible)
  db = voidCheck(db, read(db, 'account.payment', pay.id));
  const voidedPay = read(db, 'account.payment', pay.id);

  // Number is kept and recorded in voided_check_numbers
  assert.equal(voidedPay.check_number, 600);
  assert.deepEqual(voidedPay.voided_check_numbers.map((v) => v.check_number), [600]);

  // Check register shows it as Voided
  const rows = checkRegisterRows(db, [], [voidedPay]);
  assert.ok(rows.some((r) => r.checkNumber === 600 && r.state === 'Voided'));
  assert.ok(!rows.some((r) => r.checkNumber === 600 && r.state === 'Issued'));

  // Void button is now hidden
  assert.equal(voidBtn.when(voidedPay, db), false);

  // Print Check button is available again to print on a new number
  const printBtn = models['account.payment'].form.buttons.find((b) => b.label === 'Print Check');
  assert.equal(printBtn.when(voidedPay, db), true);

  // Printing again assigns a new number (601)
  db = printCheck(db, voidedPay);
  const reprintedPay = read(db, 'account.payment', pay.id);
  assert.equal(reprintedPay.check_number, 601);
  assert.deepEqual(reprintedPay.voided_check_numbers.map((v) => v.check_number), [600]);

  // Standalone unapplied payment can be reset to draft once voided (as existing payment rules allow)
  const draftStandalone = create(db, 'account.payment', {
    payment_type: 'outbound',
    partner_type: 'supplier',
    partner_id: partner.id,
    amount: 150,
    journal_id: bank.id,
    payment_method_line_id: checkMethodLine.id,
  });
  db = postPayment(draftStandalone.db, read(draftStandalone.db, 'account.payment', draftStandalone.id));
  const postedStandalone = read(db, 'account.payment', draftStandalone.id);
  db = printCheck(db, postedStandalone);
  const printedStandalone = read(db, 'account.payment', draftStandalone.id);
  assert.equal(printedStandalone.check_number, 602);

  // Void the check on the standalone payment
  db = voidCheck(db, printedStandalone);
  const voidedStandalone = read(db, 'account.payment', draftStandalone.id);
  assert.doesNotThrow(() => {
    db = resetPaymentToDraft(db, voidedStandalone);
  });
  assert.equal(read(db, 'account.payment', draftStandalone.id).state, 'draft');
});

test('PAY-17: stub lines amounts computes original and paid amounts for bills and credit notes and net total', () => {
  let db = seed();
  const bank = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  const checkMethodLine = bank.outbound_payment_method_line_ids.find(
    (l) => read(db, 'account.payment.method', l.payment_method_id).code === 'check_printing'
  );
  const partner = search(db, 'res.partner')[0];

  // Bill: 1000
  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: partner.id,
    invoice_date: today(),
    invoice_line_ids: [{ name: 'Bill item', price_unit: 1000, qty: 1 }],
  });
  db = postMove(bill.db, bill.id);

  // Credit note (vendor refund): 200
  const refund = create(db, 'account.move', {
    move_type: 'in_refund',
    partner_id: partner.id,
    invoice_date: today(),
    invoice_line_ids: [{ name: 'Refund item', price_unit: 200, qty: 1 }],
  });
  db = postMove(refund.db, refund.id);

  const draftPay = create(db, 'account.payment', {
    payment_type: 'outbound',
    partner_type: 'supplier',
    partner_id: partner.id,
    amount: 1000,
    journal_id: bank.id,
    payment_method_line_id: checkMethodLine.id,
  });
  db = payMove(draftPay.db, bill.id, 1000, today(), {
    paymentId: draftPay.id,
    journalId: bank.id,
  });
  const pay = read(db, 'account.payment', draftPay.id);

  const stubLines = paymentRemittanceLines(db, pay);
  assert.ok(Array.isArray(stubLines));
  assert.ok(stubLines.length >= 1);
  const totalPaid = stubLines.reduce((sum, l) => sum + Number(l.paid_amount), 0);
  assert.equal(totalPaid, 1000);
});

test('Bug 1: Voiding a check saves through diffDb + applyDiff without failing server payment invariant', () => {
  let db = seed();
  const bank = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  db = write(db, 'account.journal', bank.id, { check_next_number: 400 });
  const checkMethodLine = bank.outbound_payment_method_line_ids.find(
    (l) => read(db, 'account.payment.method', l.payment_method_id).code === 'check_printing'
  );
  const partner = search(db, 'res.partner')[0];

  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: partner.id,
    invoice_date: today(),
    invoice_line_ids: [{ name: 'Void Server Sync Test', price_unit: 100, qty: 1 }],
  });
  db = postMove(bill.db, bill.id);
  const draftPay = create(db, 'account.payment', {
    payment_type: 'outbound',
    partner_type: 'supplier',
    partner_id: partner.id,
    amount: 100,
    journal_id: bank.id,
    payment_method_line_id: checkMethodLine.id,
  });
  db = payMove(draftPay.db, bill.id, 100, today(), {
    paymentId: draftPay.id,
    journalId: bank.id,
  });
  const pay = read(db, 'account.payment', draftPay.id);
  db = printCheck(db, pay);
  assert.equal(read(db, 'account.payment', pay.id).check_number, 400);

  // Void check locally
  const voidedDb = voidCheck(db, read(db, 'account.payment', pay.id));

  // Syncing to server via diffDb + applyDiff must not be rejected by paymentInvariant
  assert.doesNotThrow(() => {
    db = sync(db, voidedDb);
  });
  const syncedPay = read(db, 'account.payment', pay.id);
  assert.equal(syncedPay.check_number, 400);
  assert.deepEqual(syncedPay.voided_check_numbers.map((v) => v.check_number), [400]);
});

test('Bug 2: Batch checks book to the payment method line\'s outstanding account, not the default method\'s account', () => {
  let db = seed();
  const bank = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  const partner = search(db, 'res.partner')[0];

  // Create a separate dedicated outstanding account for check printing
  const customCheckAccount = create(db, 'account.account', {
    code: '101402',
    name: 'Outstanding Checks Account',
    account_type: 'asset_current',
    reconcile: true,
    company_id: bank.company_id ?? 1,
  });
  db = customCheckAccount.db;

  const checkMethodLine = bank.outbound_payment_method_line_ids.find(
    (l) => read(db, 'account.payment.method', l.payment_method_id).code === 'check_printing'
  );
  assert.ok(checkMethodLine);

  // Update check method line with custom payment_account_id
  db = write(db, 'account.payment.method.line', checkMethodLine.id, {
    payment_account_id: customCheckAccount.id,
  });

  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: partner.id,
    invoice_date: today(),
    invoice_line_ids: [{ name: 'Batch Check Account Item', price_unit: 300, qty: 1 }],
  });
  db = postMove(bill.db, bill.id);

  const batch = create(db, 'account.batch.payment', {
    batch_type: 'outbound',
    journal_id: bank.id,
    date: today(),
    lines: [{ move_id: bill.id, amount: 300 }],
  });

  db = postBatch(batch.db, read(batch.db, 'account.batch.payment', batch.id));
  const postedBatch = read(db, 'account.batch.payment', batch.id);
  const paymentId = postedBatch.lines[0].payment_id;
  const payment = read(db, 'account.payment', paymentId);

  // Payment method line must be the check method line
  assert.equal(payment.payment_method_line_id, checkMethodLine.id);
  // Payment's outstanding_account_id must be customCheckAccount
  assert.equal(payment.outstanding_account_id, customCheckAccount.id);

  // The journal entry's liquidity line must be booked to customCheckAccount, not the default account
  const entry = read(db, 'account.move', payment.move_id);
  assert.ok(entry);
  const checkLineInEntry = entry.line_ids.find((l) => l.account_id === customCheckAccount.id);
  assert.ok(checkLineInEntry, 'Entry lines must contain customCheckAccount');
});

test('Bug 3: Batch printing on manual numbering journal requires check numbers and does not auto-sequence', () => {
  let db = seed();
  const bank = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  db = write(db, 'account.journal', bank.id, {
    check_next_number: 100,
    check_manual_sequencing: true,
  });
  const partner = search(db, 'res.partner')[0];

  const bill1 = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: partner.id,
    invoice_date: today(),
    invoice_line_ids: [{ name: 'Item 1', price_unit: 50, qty: 1 }],
  });
  db = postMove(bill1.db, bill1.id);

  const bill2 = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: partner.id,
    invoice_date: today(),
    invoice_line_ids: [{ name: 'Item 2', price_unit: 75, qty: 1 }],
  });
  db = postMove(bill2.db, bill2.id);

  const batch = create(db, 'account.batch.payment', {
    batch_type: 'outbound',
    journal_id: bank.id,
    date: today(),
    lines: [
      { move_id: bill1.id, amount: 50 },
      { move_id: bill2.id, amount: 75 },
    ],
  });
  db = postBatch(batch.db, read(batch.db, 'account.batch.payment', batch.id));
  const postedBatch = read(db, 'account.batch.payment', batch.id);

  // 1. Printing without providing check numbers on a manual-sequencing journal must be rejected
  assert.throws(() => {
    printBatchChecks(db, postedBatch.id);
  }, /manual/i);

  // Journal check_next_number must remain unchanged at 100
  assert.equal(read(db, 'account.journal', bank.id).check_next_number, 100);

  // 2. Printing with supplied check numbers assigns them and succeeds without advancing sequence
  const pay1Id = postedBatch.lines[0].payment_id;
  const pay2Id = postedBatch.lines[1].payment_id;
  db = write(db, 'account.batch.payment', postedBatch.id, { lines: postedBatch.lines.map((l, i) => ({ ...l, check_number: [801, 802][i] })) });
  db = printBatchChecks(db, postedBatch.id);

  const printedBatch = read(db, 'account.batch.payment', batch.id);
  assert.equal(read(db, 'account.payment', pay1Id).check_number, 801);
  assert.equal(read(db, 'account.payment', pay2Id).check_number, 802);
  assert.equal(printedBatch.lines[0].check_number, 801);
  assert.equal(printedBatch.lines[1].check_number, 802);
  // Sequence must still NOT be advanced for manual sequencing
  assert.equal(read(db, 'account.journal', bank.id).check_next_number, 100);
});

test('Bug 4: Existing payment with check_number on non-check method line can be edited, voided, and reversed', () => {
  let db = seed();
  const bank = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  const manualMethodLine = bank.outbound_payment_method_line_ids.find(
    (l) => read(db, 'account.payment.method', l.payment_method_id).code === 'manual'
  );
  const partner = search(db, 'res.partner')[0];

  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: partner.id,
    invoice_date: today(),
    invoice_line_ids: [{ name: 'Legacy Batch Check Item', price_unit: 100, qty: 1 }],
  });
  db = postMove(bill.db, bill.id);

  // Create legacy payment with check_number on manual method line
  const draftPay = create(db, 'account.payment', {
    payment_type: 'outbound',
    partner_type: 'supplier',
    partner_id: partner.id,
    amount: 100,
    journal_id: bank.id,
    payment_method_line_id: manualMethodLine.id,
  });
  db = payMove(draftPay.db, bill.id, 100, today(), {
    paymentId: draftPay.id,
    journalId: bank.id,
  });
  // Simulate an existing stored payment created before this PR (numbered on manual method line)
  const legacyPayRecord = {
    ...read(db, 'account.payment', draftPay.id),
    check_number: 333,
  };
  db = {
    ...db,
    records: {
      ...db.records,
      'account.payment': db.records['account.payment'].map((p) => (p.id === draftPay.id ? legacyPayRecord : p)),
    },
  };
  const legacyPay = read(db, 'account.payment', draftPay.id);
  assert.equal(legacyPay.check_number, 333);
  assert.equal(paymentPaysByCheck(db, legacyPay), false);

  // Modifying memo on existing payment should succeed through sync (guard should not reject unchanged check_number)
  assert.doesNotThrow(() => {
    db = sync(db, write(db, 'account.payment', legacyPay.id, { memo: 'Updated Memo' }));
  });
  assert.equal(read(db, 'account.payment', legacyPay.id).memo, 'Updated Memo');

  // Voiding should succeed
  const voidedDb = voidCheck(db, read(db, 'account.payment', legacyPay.id));
  assert.doesNotThrow(() => {
    db = sync(db, voidedDb);
  });
  assert.equal(read(db, 'account.payment', legacyPay.id).check_number, 333);
});

test('Bug 5: Deleting a voided check payment is blocked by protectDelete so check number cannot be reused', () => {
  let db = seed();
  const bank = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  db = write(db, 'account.journal', bank.id, { check_next_number: 950 });
  const checkMethodLine = bank.outbound_payment_method_line_ids.find(
    (l) => read(db, 'account.payment.method', l.payment_method_id).code === 'check_printing'
  );
  const partner = search(db, 'res.partner')[0];

  const draftPay = create(db, 'account.payment', {
    payment_type: 'outbound',
    partner_type: 'supplier',
    partner_id: partner.id,
    amount: 200,
    journal_id: bank.id,
    payment_method_line_id: checkMethodLine.id,
  });
  db = postPayment(draftPay.db, read(draftPay.db, 'account.payment', draftPay.id));
  const postedPay = read(db, 'account.payment', draftPay.id);
  db = printCheck(db, postedPay);
  assert.equal(read(db, 'account.payment', postedPay.id).check_number, 950);

  // Void the check and reset to draft
  db = voidCheck(db, read(db, 'account.payment', postedPay.id));
  db = resetPaymentToDraft(db, read(db, 'account.payment', postedPay.id));
  const draftVoidedPay = read(db, 'account.payment', postedPay.id);
  assert.equal(draftVoidedPay.state, 'draft');

  // Attempting to delete the voided check must be blocked by protectDelete
  assert.throws(() => {
    sync(db, unlink(db, 'account.payment', [draftVoidedPay.id]));
  }, /Issued checks cannot be deleted/i);
});

const textOf = (node) => (node.nodeType === 3 ? node.nodeValue : (node.childNodes ?? []).map(textOf).join(''));
const props = (node) => Object.entries(node ?? {}).find(([k]) => k.startsWith('__reactProps$'))?.[1];

test('Round 2 Bug 1: Register buttons handle errors with feedback and route manual To Print rows to payment form', async () => {
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting/checks' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, getDb, commit } = await import('./store.js');
  const { Checks } = await import('./views/Checks.jsx');

  await initStore();
  let db = getDb();
  const bank = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  db = write(db, 'account.journal', bank.id, { check_manual_sequencing: true });
  const checkMethodLine = bank.outbound_payment_method_line_ids.find(
    (l) => read(db, 'account.payment.method', l.payment_method_id).code === 'check_printing'
  );
  const partner = search(db, 'res.partner')[0];

  // Create a posted payment that needs manual check number (state will be 'To Print' in register)
  const draftPay = create(db, 'account.payment', {
    payment_type: 'outbound',
    partner_type: 'supplier',
    partner_id: partner.id,
    amount: 120,
    journal_id: bank.id,
    payment_method_line_id: checkMethodLine.id,
  });
  db = postPayment(draftPay.db, read(draftPay.db, 'account.payment', draftPay.id));

  // Create an already-voided batch check payment to test onVoid error feedback
  const batchBill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: partner.id,
    invoice_date: today(),
    invoice_line_ids: [{ name: 'Batch item', price_unit: 100, qty: 1 }],
  });
  db = postMove(batchBill.db, batchBill.id);
  const batch = create(db, 'account.batch.payment', {
    batch_type: 'outbound',
    journal_id: bank.id,
    date: today(),
    lines: [{ move_id: batchBill.id, amount: 100 }],
  });
  db = postBatch(batch.db, read(batch.db, 'account.batch.payment', batch.id));
  const postedBatch = read(db, 'account.batch.payment', batch.id);
  db = write(db, 'account.batch.payment', postedBatch.id, {
    lines: [{ ...postedBatch.lines[0], check_number: 999 }],
  });
  db = printBatchChecks(db, postedBatch.id);
  const bPayId = postedBatch.lines[0].payment_id;
  db = voidCheck(db, read(db, 'account.payment', bPayId));

  await React.act(async () => commit(db));

  let alertedMessage = null;
  globalThis.alert = (msg) => { alertedMessage = msg; };

  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(Checks)));
    const printBtn = find(host, (n) => n.tagName === 'BUTTON' && textOf(n) === 'Print');
    assert.ok(printBtn, 'Print button exists for To Print row');

    // Clicking Print on manual To Print row should route to payment form instead of throwing unhandled error
    await React.act(async () => {
      props(printBtn).onClick();
    });
    assert.equal(window.location.hash, `#/open/account.payment/${draftPay.id}`);

    // Clicking Void on already-voided batch row should catch error and show alert feedback
    const voidBtn = find(host, (n) => n.tagName === 'BUTTON' && textOf(n) === 'Void');
    assert.ok(voidBtn, 'Void button exists for batch row');
    await React.act(async () => {
      props(voidBtn).onClick();
    });
    assert.match(alertedMessage, /already voided/i);
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('Round 2 Bug 2: Manual-numbering reprint reuses the voided number', () => {
  let db = seed();
  const bank = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  db = write(db, 'account.journal', bank.id, {
    check_next_number: 100,
    check_manual_sequencing: true,
  });
  const checkMethodLine = bank.outbound_payment_method_line_ids.find(
    (l) => read(db, 'account.payment.method', l.payment_method_id).code === 'check_printing'
  );
  const partner = search(db, 'res.partner')[0];

  const draftPay = create(db, 'account.payment', {
    payment_type: 'outbound',
    partner_type: 'supplier',
    partner_id: partner.id,
    amount: 250,
    journal_id: bank.id,
    payment_method_line_id: checkMethodLine.id,
  });
  db = postPayment(draftPay.db, read(draftPay.db, 'account.payment', draftPay.id));
  db = sync(db, write(db, 'account.payment', draftPay.id, { check_number: 500 }));
  const payment = read(db, 'account.payment', draftPay.id);
  db = printCheck(db, payment);
  assert.equal(read(db, 'account.payment', payment.id).check_number, 500);

  // Void check #500
  db = voidCheck(db, read(db, 'account.payment', payment.id));
  const voidedPay = read(db, 'account.payment', payment.id);

  // printCheck on voided check with manual sequencing must throw, not return db unchanged
  assert.throws(() => {
    printCheck(db, voidedPay);
  }, /manual/i);

  // Form button "Print Check" must be hidden while voided on manual journal
  const printBtn = models['account.payment'].form.buttons.find((b) => b.label === 'Print Check');
  assert.equal(printBtn.when(voidedPay, db), false, 'Print Check must be hidden while check number is voided on manual journal');

  // After setting a new check number, Print Check becomes available again
  db = sync(db, write(db, 'account.payment', voidedPay.id, { check_number: 501 }));
  const renumberedPay = read(db, 'account.payment', voidedPay.id);
  assert.equal(printBtn.when(renumberedPay, db), true);
  assert.doesNotThrow(() => {
    db = printCheck(db, renumberedPay);
  });
});

test('Round 2 Bug 3: Mixed-currency stubs show separate totals by currency instead of summing across currencies', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, getDb, commit } = await import('./store.js');
  const { PrintDoc } = await import('./views/PrintDoc.jsx');

  await initStore();
  let db = getDb();
  const journal = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  const usd = search(db, 'res.currency').find((c) => c.name === 'USD');
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  assert.ok(usd && eur);

  db = write(db, 'res.currency', eur.id, { rate_ids: [{ date: '2026-01-01', rate: 2.0 }] });

  // Bill in USD (50)
  const usdBill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 3,
    currency_id: usd.id,
    invoice_date: '2026-01-01',
    invoice_line_ids: [{ qty: 1, price_unit: 50, tax: 0 }],
  });
  db = postMove(usdBill.db, usdBill.id);

  // Bill in EUR (200)
  const eurBill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 3,
    currency_id: eur.id,
    invoice_date: '2026-01-01',
    invoice_line_ids: [{ qty: 1, price_unit: 200, tax: 0 }],
  });
  db = postMove(eurBill.db, eurBill.id);

  const checkLine = (journal.outbound_payment_method_line_ids ?? []).map((l) => typeof l === 'object' ? l : read(db, 'account.payment.method.line', l))
    .find((l) => read(db, 'account.payment.method', l?.payment_method_id)?.code === 'check_printing');

  const draftPay = create(db, 'account.payment', {
    payment_type: 'outbound',
    partner_type: 'supplier',
    partner_id: 3,
    amount: 150,
    journal_id: journal.id,
    ...(checkLine ? { payment_method_line_id: checkLine.id } : {}),
  });
  db = payMove(draftPay.db, usdBill.id, 150, '2026-01-02', { paymentId: draftPay.id, journalId: journal.id });
  db = printCheck(db, draftPay.id);
  const payment = read(db, 'account.payment', draftPay.id);

  // Settle EUR bill with payment move
  db = {
    ...db,
    records: {
      ...db.records,
      'account.move': db.records['account.move'].map((m) => (
        m.id === eurBill.id
          ? { ...m, payments: [{ date: '2026-01-02', amount: 200, move_id: payment.move_id }], amount_paid: 200 }
          : m
      )),
    },
  };

  const lines = paymentRemittanceLines(db, payment);
  assert.equal(lines.length, 2);
  assert.ok(lines.every((l) => l.currency && l.currency.id));

  await React.act(async () => commit(db));
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(PrintDoc, { model: 'account.payment', id: payment.id })));
    const text = textOf(host);
    assert.match(text, /Remittance Advice/i);
    // Must NOT add 50 USD + 200 EUR into a false total like 250 € or $250
    assert.doesNotMatch(text, /€\s*250|250\.00\s*€|\$\s*250/);
    // Separate totals for EUR and USD must appear
    assert.match(text, /Net Total\s*\(EUR\)/i);
    assert.match(text, /Net Total\s*\(USD\)/i);
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('Round 2 Bug 4: Manual reprintCheck requires replacement check number and does not advance journal sequence', () => {
  let db = seed();
  const bank = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  db = write(db, 'account.journal', bank.id, {
    check_next_number: 100,
    check_manual_sequencing: true,
  });
  const checkMethodLine = bank.outbound_payment_method_line_ids.find(
    (l) => read(db, 'account.payment.method', l.payment_method_id).code === 'check_printing'
  );
  const partner = search(db, 'res.partner')[0];

  const draftPay = create(db, 'account.payment', {
    payment_type: 'outbound',
    partner_type: 'supplier',
    partner_id: partner.id,
    amount: 180,
    journal_id: bank.id,
    payment_method_line_id: checkMethodLine.id,
  });
  db = postPayment(draftPay.db, read(draftPay.db, 'account.payment', draftPay.id));
  db = sync(db, write(db, 'account.payment', draftPay.id, { check_number: 500 }));
  const payment = read(db, 'account.payment', draftPay.id);
  db = printCheck(db, payment);
  assert.equal(read(db, 'account.payment', payment.id).check_number, 500);

  // Calling reprintCheck on manual journal without replacement number must throw
  assert.throws(() => {
    reprintCheck(db, payment);
  }, /manual/i);

  // Calling with replacement number assigns it, voids old number, and leaves check_next_number untouched
  db = reprintCheck(db, payment, 505);
  const reprinted = read(db, 'account.payment', payment.id);
  assert.equal(reprinted.check_number, 505);
  assert.deepEqual(reprinted.voided_check_numbers.map((v) => v.check_number), [500]);
  assert.equal(read(db, 'account.journal', bank.id).check_next_number, 100);
});

test('Round 2 Bug 5: Bottom check layout anchors check body to bottom of sheet with print layout styles', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, getDb, commit } = await import('./store.js');
  const { PrintDoc } = await import('./views/PrintDoc.jsx');
  const fs = await import('node:fs');

  await initStore();
  let db = getDb();
  const bank = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  db = write(db, 'account.journal', bank.id, {
    check_printing_layout: 'bottom',
    check_next_number: 600,
  });
  const checkMethodLine = bank.outbound_payment_method_line_ids.find(
    (l) => read(db, 'account.payment.method', l.payment_method_id).code === 'check_printing'
  );
  const partner = search(db, 'res.partner')[0];

  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: partner.id,
    invoice_date: today(),
    invoice_line_ids: [{ name: 'Bottom Check Item', price_unit: 100, qty: 1 }],
  });
  db = postMove(bill.db, bill.id);

  const draftPay = create(db, 'account.payment', {
    payment_type: 'outbound',
    partner_type: 'supplier',
    partner_id: partner.id,
    amount: 100,
    journal_id: bank.id,
    payment_method_line_id: checkMethodLine.id,
  });
  db = payMove(draftPay.db, bill.id, 100, today(), { paymentId: draftPay.id, journalId: bank.id });
  db = printCheck(db, draftPay.id);

  await React.act(async () => commit(db));
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(PrintDoc, { model: 'account.payment', id: draftPay.id })));
    const article = find(host, (n) => n.tagName === 'ARTICLE' && props(n)?.className?.includes('check-layout-bottom'));
    assert.ok(article, 'Article has check-layout-bottom class');

    // CSS file must contain print bottom-anchor styles for check-layout-bottom and check min-height
    const css = fs.readFileSync('src/views.css', 'utf-8');
    assert.match(css, /\.check-layout-bottom[\s\S]*?(margin-top:\s*auto|justify-content:\s*flex-end)/);
    assert.match(css, /@media print[\s\S]*?\.paper\.check/);
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('Qodo Bug 1: Manual batch check_number readonly uses (record, db) signature and allows entering numbers', () => {
  let db = seed();
  const bank = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  db = write(db, 'account.journal', bank.id, {
    check_manual_sequencing: true,
  });

  const batch = create(db, 'account.batch.payment', {
    batch_type: 'outbound',
    journal_id: bank.id,
    date: today(),
    lines: [{ move_id: 1, amount: 100 }],
  });

  const checkNumberField = models['account.batch.payment'].fields.lines.fields.check_number;

  const batchRecord = read(batch.db, 'account.batch.payment', batch.id);
  const lineRecord = { ...batchRecord.lines[0], batch_id: batch.id };
  const isRo = fieldReadonly(checkNumberField, lineRecord, batch.db);
  assert.equal(isRo, false, 'check_number on draft batch line with manual numbering must be editable');

  // When journal is auto-sequencing, it must remain readonly
  const nextDb = write(batch.db, 'account.journal', bank.id, { check_manual_sequencing: false });
  const isRoAuto = fieldReadonly(checkNumberField, lineRecord, nextDb);
  assert.equal(isRoAuto, true, 'check_number on auto-sequencing journal must be readonly');
});

test('Qodo Bug 2: Pre-numbered draft batches pass validation and assign check numbers at print time', () => {
  let db = seed();
  const bank = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  db = write(db, 'account.journal', bank.id, {
    check_next_number: 100,
    check_manual_sequencing: true,
  });
  const partner = search(db, 'res.partner')[0];

  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: partner.id,
    invoice_date: today(),
    invoice_line_ids: [{ name: 'Pre-numbered Item', price_unit: 100, qty: 1 }],
  });
  db = postMove(bill.db, bill.id);

  const batch = create(db, 'account.batch.payment', {
    batch_type: 'outbound',
    journal_id: bank.id,
    date: today(),
    lines: [{ move_id: bill.id, amount: 100, check_number: 101 }],
  });

  // Validation must succeed without uniqueness violation from the draft batch line itself
  assert.doesNotThrow(() => {
    db = postBatch(batch.db, read(batch.db, 'account.batch.payment', batch.id));
  });

  const postedBatch = read(db, 'account.batch.payment', batch.id);
  assert.equal(postedBatch.state, 'posted');
  assert.equal(postedBatch.lines[0].check_number, 101);

  // Payment record initially has check_number null before print
  const payId = postedBatch.lines[0].payment_id;
  assert.ok(payId, 'Payment was created and linked');
  assert.ok(read(db, 'account.payment', payId).check_number == null, 'Payment has no check number before print');

  // PrintBatchChecks assigns check number 101 to payment and succeeds
  db = printBatchChecks(db, postedBatch.id);
  assert.equal(read(db, 'account.payment', payId).check_number, 101);
  assert.equal(read(db, 'account.batch.payment', batch.id).lines[0].check_number, 101);
  // Manual sequencing must not increment check_next_number
  assert.equal(read(db, 'account.journal', bank.id).check_next_number, 100);
});

test('Qodo Bug 3: Outbound check batch rejects journals without check_printing or payment lines not paying by check', () => {
  let db = seed();
  const bank = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  const partner = search(db, 'res.partner')[0];

  const manualMethod = search(db, 'account.payment.method').find((m) => m.code === 'manual' && m.payment_type === 'outbound');
  const manualMethodLine = bank.outbound_payment_method_line_ids.find((l) => l.payment_method_id === manualMethod.id);

  // 1. Existing payment that does NOT pay by check (paid via manual)
  const bill1 = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: partner.id,
    invoice_date: today(),
    invoice_line_ids: [{ name: 'Bill 1', price_unit: 50, qty: 1 }],
  });
  db = postMove(bill1.db, bill1.id);
  const draftPay = create(db, 'account.payment', {
    payment_type: 'outbound',
    partner_type: 'supplier',
    partner_id: partner.id,
    amount: 50,
    journal_id: bank.id,
    payment_method_line_id: manualMethodLine.id,
  });
  db = payMove(draftPay.db, bill1.id, 50, today(), { paymentId: draftPay.id, journalId: bank.id });
  const paymentRecord = read(db, 'account.payment', draftPay.id);
  assert.equal(paymentPaysByCheck(db, paymentRecord), false);

  const batchWithNonCheckPay = create(db, 'account.batch.payment', {
    batch_type: 'outbound',
    journal_id: bank.id,
    date: today(),
    lines: [{ payment_id: paymentRecord.id, amount: 50 }],
  });

  assert.throws(() => {
    postBatch(batchWithNonCheckPay.db, read(batchWithNonCheckPay.db, 'account.batch.payment', batchWithNonCheckPay.id));
  }, /check batch only holds check payments/i);

  // 2. Journal with NO check_printing payment method line
  let noCheckDb = write(db, 'account.journal', bank.id, {
    outbound_payment_method_line_ids: [manualMethodLine],
  });
  const bill2 = create(noCheckDb, 'account.move', {
    move_type: 'in_invoice',
    partner_id: partner.id,
    invoice_date: today(),
    invoice_line_ids: [{ name: 'Bill 2', price_unit: 60, qty: 1 }],
  });
  noCheckDb = postMove(bill2.db, bill2.id);

  const batchNoCheckMethod = create(noCheckDb, 'account.batch.payment', {
    batch_type: 'outbound',
    journal_id: bank.id,
    date: today(),
    lines: [{ move_id: bill2.id, amount: 60 }],
  });

  assert.throws(() => {
    postBatch(batchNoCheckMethod.db, read(batchNoCheckMethod.db, 'account.batch.payment', batchNoCheckMethod.id));
  }, /batch journal has no check payment method/i);

});

test('Qodo Bug 4: Voided check cannot be renumbered or cleared by ordinary write; allows reprint and unprinted voided list', () => {
  let db = seed();
  const bank = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  db = write(db, 'account.journal', bank.id, { check_next_number: 500 });
  const checkMethodLine = bank.outbound_payment_method_line_ids.find(
    (l) => read(db, 'account.payment.method', l.payment_method_id).code === 'check_printing'
  );
  const partner = search(db, 'res.partner')[0];

  const draftPay = create(db, 'account.payment', {
    payment_type: 'outbound',
    partner_type: 'supplier',
    partner_id: partner.id,
    amount: 100,
    journal_id: bank.id,
    payment_method_line_id: checkMethodLine.id,
  });
  db = postPayment(draftPay.db, read(draftPay.db, 'account.payment', draftPay.id));
  db = printCheck(db, draftPay.id);
  const printed = read(db, 'account.payment', draftPay.id);
  assert.equal(printed.check_number, 500);

  // Void check #500
  db = voidCheck(db, printed);
  const voided = read(db, 'account.payment', draftPay.id);
  assert.equal(voided.check_number, 500);
  assert.deepEqual(voided.voided_check_numbers.map((v) => v.check_number), [500]);

  // 1. Ordinary write clearing check_number to null must be rejected
  assert.throws(() => {
    sync(db, write(db, 'account.payment', voided.id, { check_number: null }));
  }, /Issued check numbers cannot be changed/i);

  // 2. Ordinary write renumbering check_number to arbitrary number (e.g. 9999) must be rejected
  assert.throws(() => {
    sync(db, write(db, 'account.payment', voided.id, { check_number: 9999 }));
  }, /Issued check numbers cannot be changed/i);

  // 3. Changing check number via legitimate reprintCheck succeeds
  db = reprintCheck(db, voided);
  const reprinted = read(db, 'account.payment', voided.id);
  assert.equal(reprinted.check_number, 501);
  assert.deepEqual(reprinted.voided_check_numbers.map((v) => v.check_number), [500]);

  // 4. Payment with check_number == null and existing voided list allows edits with unchanged voided list
  const unprintedWithVoided = {
    ...reprinted,
    id: 99881,
    move_id: null,
    destination_move_id: null,
    check_number: null,
    voided_check_numbers: [{ check_number: 9991, date: today() }],
    state: 'draft',
  };
  db = {
    ...db,
    records: {
      ...db.records,
      'account.payment': [...(db.records['account.payment'] ?? []), unprintedWithVoided],
    },
  };
  assert.doesNotThrow(() => {
    sync(db, write(db, 'account.payment', 99881, { memo: 'Draft memo update' }));
  });
});

test('Qodo Bug 1 (Round 3): Reprint through sync on unvoided check updates check_number and appends to void history', () => {
  let db = seed();
  const bank = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  db = write(db, 'account.journal', bank.id, { check_next_number: 500 });
  const checkMethodLine = bank.outbound_payment_method_line_ids.find(
    (l) => read(db, 'account.payment.method', l.payment_method_id).code === 'check_printing'
  );
  const partner = search(db, 'res.partner')[0];

  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: partner.id,
    invoice_date: today(),
    invoice_line_ids: [{ name: 'Item 1', price_unit: 100, qty: 1 }],
  });
  db = postMove(bill.db, bill.id);

  const draftPay = create(db, 'account.payment', {
    payment_type: 'outbound',
    partner_type: 'supplier',
    partner_id: partner.id,
    amount: 100,
    journal_id: bank.id,
    payment_method_line_id: checkMethodLine.id,
  });
  db = postPayment(draftPay.db, read(draftPay.db, 'account.payment', draftPay.id));
  db = printCheck(db, draftPay.id);
  const printed = read(db, 'account.payment', draftPay.id);
  assert.equal(printed.check_number, 500);

  // Client performs reprintCheck without prior separate void
  const clientDb = reprintCheck(db, printed);
  const clientPay = read(clientDb, 'account.payment', printed.id);
  assert.equal(clientPay.check_number, 501);
  assert.deepEqual(clientPay.voided_check_numbers.map((v) => v.check_number), [500]);

  // Sync round-trip (diffDb + applyDiff) must succeed
  let serverDb = db;
  assert.doesNotThrow(() => {
    serverDb = sync(serverDb, clientDb);
  });
  const syncedPay = read(serverDb, 'account.payment', printed.id);
  assert.equal(syncedPay.check_number, 501);
  assert.deepEqual(syncedPay.voided_check_numbers.map((v) => v.check_number), [500]);
  assert.equal(read(serverDb, 'account.journal', bank.id).check_next_number, 502);
});

test('Qodo Bug 2 (Round 3): Save void through sync, then reprint through sync', () => {
  let db = seed();
  const bank = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  db = write(db, 'account.journal', bank.id, { check_next_number: 500 });
  const checkMethodLine = bank.outbound_payment_method_line_ids.find(
    (l) => read(db, 'account.payment.method', l.payment_method_id).code === 'check_printing'
  );
  const partner = search(db, 'res.partner')[0];

  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: partner.id,
    invoice_date: today(),
    invoice_line_ids: [{ name: 'Item 2', price_unit: 120, qty: 1 }],
  });
  db = postMove(bill.db, bill.id);

  const draftPay = create(db, 'account.payment', {
    payment_type: 'outbound',
    partner_type: 'supplier',
    partner_id: partner.id,
    amount: 120,
    journal_id: bank.id,
    payment_method_line_id: checkMethodLine.id,
  });
  db = postPayment(draftPay.db, read(draftPay.db, 'account.payment', draftPay.id));
  db = printCheck(db, draftPay.id);
  const printed = read(db, 'account.payment', draftPay.id);
  assert.equal(printed.check_number, 500);

  // 1. Save void through sync
  const voidedClient = voidCheck(db, printed);
  let serverDb = sync(db, voidedClient);
  const voidedOnServer = read(serverDb, 'account.payment', printed.id);
  assert.equal(voidedOnServer.check_number, 500);
  assert.deepEqual(voidedOnServer.voided_check_numbers.map((v) => v.check_number), [500]);

  // 2. Reprint through sync
  const reprintClient = reprintCheck(serverDb, voidedOnServer);
  assert.doesNotThrow(() => {
    serverDb = sync(serverDb, reprintClient);
  });
  const reprintedOnServer = read(serverDb, 'account.payment', printed.id);
  assert.equal(reprintedOnServer.check_number, 501);
  assert.deepEqual(reprintedOnServer.voided_check_numbers.map((v) => v.check_number), [500]);
  assert.equal(read(serverDb, 'account.journal', bank.id).check_next_number, 502);
});

test('Qodo Bug 3 (Round 3): Reset to Draft is hidden and action refuses for unvoided issued check', () => {
  let db = seed();
  const bank = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  db = write(db, 'account.journal', bank.id, { check_next_number: 500 });
  const checkMethodLine = bank.outbound_payment_method_line_ids.find(
    (l) => read(db, 'account.payment.method', l.payment_method_id).code === 'check_printing'
  );
  const partner = search(db, 'res.partner')[0];

  const draftPay = create(db, 'account.payment', {
    payment_type: 'outbound',
    partner_type: 'supplier',
    partner_id: partner.id,
    amount: 100,
    journal_id: bank.id,
    payment_method_line_id: checkMethodLine.id,
  });
  db = postPayment(draftPay.db, read(draftPay.db, 'account.payment', draftPay.id));
  db = printCheck(db, draftPay.id);
  const printed = read(db, 'account.payment', draftPay.id);

  const resetBtn = models['account.payment'].form.buttons.find((b) => b.label === 'Reset to Draft');
  assert.ok(resetBtn, 'Reset to Draft button exists');

  // Button must be hidden for issued, unvoided check
  assert.equal(resetBtn.when(printed, db), false, 'Reset to Draft button must be hidden for unvoided check');

  // Action resetPaymentToDraft must refuse with explicit message
  assert.throws(() => {
    resetPaymentToDraft(db, printed);
  }, /Void the check before resetting the payment to draft/);

  // Once check is voided, button becomes visible and reset succeeds
  db = voidCheck(db, printed);
  const voided = read(db, 'account.payment', printed.id);
  assert.equal(resetBtn.when(voided, db), true, 'Reset to Draft button visible after check is voided');
  assert.doesNotThrow(() => {
    db = resetPaymentToDraft(db, voided);
  });
  assert.equal(read(db, 'account.payment', printed.id).state, 'draft');
});

test('Qodo Bug 4 (Round 3): Manual reprint refuses current number and voided numbers and leaves payment unchanged', () => {
  let db = seed();
  const bank = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  db = write(db, 'account.journal', bank.id, {
    check_next_number: 100,
    check_manual_sequencing: true,
  });
  const checkMethodLine = bank.outbound_payment_method_line_ids.find(
    (l) => read(db, 'account.payment.method', l.payment_method_id).code === 'check_printing'
  );
  const partner = search(db, 'res.partner')[0];

  const draftPay = create(db, 'account.payment', {
    payment_type: 'outbound',
    partner_type: 'supplier',
    partner_id: partner.id,
    amount: 200,
    journal_id: bank.id,
    payment_method_line_id: checkMethodLine.id,
  });
  db = postPayment(draftPay.db, read(draftPay.db, 'account.payment', draftPay.id));
  db = sync(db, write(db, 'account.payment', draftPay.id, { check_number: 700 }));
  const printed = read(db, 'account.payment', draftPay.id);

  // 1. Attempt manual reprint with equal number (700)
  assert.throws(() => {
    reprintCheck(db, printed, 700);
  }, /The replacement check number must differ from the current and voided numbers/i);
  assert.equal(read(db, 'account.payment', printed.id).check_number, 700);

  // 2. Void 700 and reprint with 705
  db = reprintCheck(db, printed, 705);
  const reprinted = read(db, 'account.payment', printed.id);
  assert.equal(reprinted.check_number, 705);
  assert.deepEqual(reprinted.voided_check_numbers.map((v) => v.check_number), [700]);

  // 3. Attempt manual reprint reusing previously voided number (700)
  assert.throws(() => {
    reprintCheck(db, reprinted, 700);
  }, /The replacement check number must differ from the current and voided numbers/i);
  assert.equal(read(db, 'account.payment', printed.id).check_number, 705);
});

test('Qodo Bug 5 (Round 3): New unsaved batch and saved batch with changed journal allow entering manual numbers via parent_journal_id', () => {
  let db = seed();
  const bank = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  const cash = search(db, 'account.journal').find((j) => j.code === 'CSH1');
  assert.ok(bank && cash);

  // Bank is manual sequencing, Cash is auto sequencing
  db = write(db, 'account.journal', bank.id, { check_manual_sequencing: true });
  db = write(db, 'account.journal', cash.id, { check_manual_sequencing: false });

  const checkNumberField = models['account.batch.payment'].fields.lines.fields.check_number;

  // 1. New unsaved batch (no id) on manual bank journal
  const unsavedBatch = {
    journal_id: bank.id,
    batch_type: 'outbound',
    lines: [{ move_id: 1, amount: 50 }],
  };
  const unsavedLineRec = { ...unsavedBatch.lines[0], parent_journal_id: unsavedBatch.journal_id };
  const isRoUnsaved = fieldReadonly(checkNumberField, unsavedLineRec, db);
  assert.equal(isRoUnsaved, false, 'New unsaved batch on manual journal must allow entering numbers');

  // 2. Saved batch with in-memory changed journal (saved on cash, changed in form to bank)
  const savedBatch = create(db, 'account.batch.payment', {
    batch_type: 'outbound',
    journal_id: cash.id,
    date: today(),
    lines: [{ move_id: 1, amount: 80 }],
  });
  const savedRecord = read(savedBatch.db, 'account.batch.payment', savedBatch.id);
  // Form has unsaved journal change to bank.id
  const formRecord = { ...savedRecord, journal_id: bank.id };
  const changedJournalLineRec = { ...formRecord.lines[0], parent_journal_id: formRecord.journal_id };
  const isRoChanged = fieldReadonly(checkNumberField, changedJournalLineRec, savedBatch.db);
  assert.equal(isRoChanged, false, 'Saved batch with unsaved journal change to manual must allow entering numbers');
});

test('Qodo Bug 6 (Round 3): Long remittance stubs split across Letter sheets and show VOID on extra sheets', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, getDb, commit } = await import('./store.js');
  const { PrintDoc, STUB_LINES_PER_SHEET, splitStubLines } = await import('./views/PrintDoc.jsx');

  // Test splitting function
  assert.ok(typeof STUB_LINES_PER_SHEET === 'number' && STUB_LINES_PER_SHEET > 0);
  const sampleLines = Array.from({ length: 15 }, (_, i) => ({ name: `Bill ${i + 1}`, paid_amount: 10 }));
  const chunks = splitStubLines(sampleLines);
  assert.equal(chunks.length, Math.ceil(15 / STUB_LINES_PER_SHEET));
  assert.equal(chunks[0].length, STUB_LINES_PER_SHEET);
  assert.equal(chunks[1].length, 15 - STUB_LINES_PER_SHEET);

  // Test rendering of multi-sheet payment
  await initStore();
  let db = getDb();
  const journal = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  db = write(db, 'account.journal', journal.id, { check_next_number: 100 });
  const checkLine = (journal.outbound_payment_method_line_ids ?? []).map((l) => typeof l === 'object' ? l : read(db, 'account.payment.method.line', l))
    .find((l) => read(db, 'account.payment.method', l?.payment_method_id)?.code === 'check_printing');
  const partner = search(db, 'res.partner')[0];

  const bills = [];
  for (let i = 0; i < 12; i++) {
    const b = create(db, 'account.move', {
      move_type: 'in_invoice',
      partner_id: partner.id,
      invoice_date: '2026-01-01',
      invoice_line_ids: [{ qty: 1, price_unit: 10, tax: 0 }],
    });
    db = postMove(b.db, b.id);
    bills.push(b.id);
  }

  const draftPay = create(db, 'account.payment', {
    payment_type: 'outbound',
    partner_type: 'supplier',
    partner_id: partner.id,
    amount: 120,
    journal_id: journal.id,
    ...(checkLine ? { payment_method_line_id: checkLine.id } : {}),
  });
  db = postPayment(draftPay.db, read(draftPay.db, 'account.payment', draftPay.id));
  db = printCheck(db, draftPay.id);

  // Settle all 12 bills with this payment move
  const payment = read(db, 'account.payment', draftPay.id);
  db = {
    ...db,
    records: {
      ...db.records,
      'account.move': db.records['account.move'].map((m) => (
        bills.includes(m.id)
          ? { ...m, payments: [{ date: '2026-01-02', amount: 10, move_id: payment.move_id }], amount_paid: 10 }
          : m
      )),
    },
  };

  await React.act(async () => commit(db));
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(PrintDoc, { model: 'account.payment', id: payment.id })));
    const articles = [];
    const collectArticles = (node) => {
      if (!node) return;
      if (node.tagName === 'ARTICLE' && node.className?.includes('paper') && node.className?.includes('check')) {
        articles.push(node);
      }
      for (const child of node.childNodes ?? []) collectArticles(child);
    };
    collectArticles(host);
    assert.ok(articles.length >= 2, `Expected at least 2 sheets, got ${articles.length}`);
    const hasVoidArea = (art) => Boolean(find(art, (n) => n.className?.includes('check-main-area') && n.className?.includes('void')));
    // First sheet has normal check
    assert.ok(!hasVoidArea(articles[0]), 'Sheet 1 has active check area');
    // Continuation sheet(s) have check area marked VOID
    assert.ok(hasVoidArea(articles[1]), 'Sheet 2 has check area marked VOID');
  } finally {
    await React.act(async () => root.unmount());
  }
});

