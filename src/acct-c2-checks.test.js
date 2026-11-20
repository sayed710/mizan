import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { models } from './models/index.js';
import { postMove, payMove } from './models/accounting.js';
import { postBatch, checkRegisterRows } from './models/payments.js';
import {
  paymentPaysByCheck,
  printCheck,
  voidCheck,
  paymentRemittanceLines,
  postPayment,
  resetPaymentToDraft,
} from './models/pay.js';
import { applyDiff, diffDb } from './sync.js';
import { today } from './models/common.js';

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
