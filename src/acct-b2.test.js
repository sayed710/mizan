import test from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { create, read, search, write } from './orm.js';
import { postMove } from './models/accounting.js';
import { postPayment } from './models/pay.js';
import { reconcileWith, matchPayment, unreconcile, eligiblePayments, bookedStatementAmount, isPaymentMatched } from './models/bank.js';
import { journalItems, statementPaymentIds } from './models/ledger.js';
import { models } from './models/index.js';
import { applyDiff, diffDb } from './sync.js';

const LINE = 'account.bank.statement.line';

function setupCompanyWithOutstanding() {
  let db = seed();
  const outstanding = search(db, 'account.account').find((a) => a.code === '101402');
  const configured = write(db, 'res.company', 1, { outstanding_receipts_account_id: outstanding.id });
  const bankJournal = search(configured, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  return { db: configured, bankJournal, outstanding };
}

test('matchPayment matches an outstanding payment to the remaining open balance of a partially allocated statement line', () => {
  const { db: base, bankJournal } = setupCompanyWithOutstanding();

  // 1. Post a customer invoice of 40
  const inv = create(base, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 3,
    invoice_date: '2026-01-01',
    invoice_line_ids: [{ qty: 1, price_unit: 40, tax: 0 }],
  });
  let db = postMove(inv.db, inv.id);

  // 2. Create a statement line of 100 and partially allocate 40 to the invoice
  const line = create(db, LINE, {
    journal_id: bankJournal.id,
    date: '2026-01-02',
    payment_ref: 'Line for BANK-5',
    amount: 100,
  });
  db = line.db;
  db = reconcileWith(db, read(db, LINE, line.id), inv.id);

  const partialLine = read(db, LINE, line.id);
  assert.equal(partialLine.state, 'to_check');
  assert.equal(partialLine.open_amount, 60);
  assert.ok(partialLine.bank_move_id, 'Bank move is booked for the total statement line amount');
  assert.equal(partialLine.allocations.length, 1);

  // 3. Register and confirm an existing customer payment for the remaining 60
  const pay = create(db, 'account.payment', {
    partner_id: 3,
    payment_type: 'inbound',
    partner_type: 'customer',
    amount: 60,
    date: '2026-01-02',
  });
  db = pay.db;
  db = models['account.payment'].form.buttons.find((b) => b.label === 'Confirm').run(db, read(db, 'account.payment', pay.id)).db;

  // 4. Match the payment to the remaining open statement balance
  const lineToMatch = write(db, LINE, line.id, { payment_id: pay.id });
  const matched = matchPayment(lineToMatch, read(lineToMatch, LINE, line.id));

  // Server-side guard validation through diffDb + applyDiff
  const synced = applyDiff(lineToMatch, diffDb(lineToMatch, matched.db), { isAdmin: true });
  const finalLine = read(synced, LINE, line.id);

  assert.equal(finalLine.state, 'reconciled');
  assert.equal(finalLine.open_amount, 0);
  assert.equal(finalLine.bank_move_id, partialLine.bank_move_id, 'Original bank entry is preserved');
  assert.equal(finalLine.allocations.length, 2, 'Allocations include both invoice and payment');
  assert.equal(finalLine.allocations[0].amount, 40);
  assert.equal(finalLine.allocations[1].amount, 60);

  // 5. Unreconciliation cleanly reverses all allocations and bank movement
  const unrec = unreconcile(synced, finalLine);
  const unrecSynced = applyDiff(synced, diffDb(synced, unrec.db), { isAdmin: true });
  const unrecLine = read(unrecSynced, LINE, line.id);
  assert.equal(unrecLine.state, 'to_check');
  assert.equal(unrecLine.open_amount, null);
  assert.equal(unrecLine.bank_move_id, null);
  assert.equal((unrecLine.allocations ?? []).length, 0);
});

test('partial match leaves the rest open with the right open_amount, second payment completes it, and result replays through diffDb + applyDiff', () => {
  const { db: base, bankJournal } = setupCompanyWithOutstanding();

  // 1. Create an unbooked statement line of 100
  const line = create(base, LINE, {
    journal_id: bankJournal.id,
    date: '2026-01-02',
    payment_ref: 'Partial payment match BANK-6',
    amount: 100,
  });
  let db = line.db;

  // 2. Register and confirm payment 1 for 60 (< 100)
  const pay1 = create(db, 'account.payment', {
    partner_id: 3,
    payment_type: 'inbound',
    partner_type: 'customer',
    amount: 60,
    date: '2026-01-02',
  });
  db = pay1.db;
  db = models['account.payment'].form.buttons.find((b) => b.label === 'Confirm').run(db, read(db, 'account.payment', pay1.id)).db;

  // 3. Match payment 1 without write-off: books statement line to suspense and leaves open_amount = 40
  const lineWithPay1 = write(db, LINE, line.id, { payment_id: pay1.id });
  const res1 = matchPayment(lineWithPay1, read(lineWithPay1, LINE, line.id));

  // Replay result through diffDb + applyDiff
  db = applyDiff(lineWithPay1, diffDb(lineWithPay1, res1.db), { isAdmin: true });
  const step1Line = read(db, LINE, line.id);
  assert.equal(step1Line.state, 'to_check', 'Statement line stays to_check because 40 remains open');
  assert.equal(step1Line.open_amount, 40, 'Residual open amount is 40');
  assert.ok(step1Line.bank_move_id, 'Bank move is booked to suspense');
  assert.equal(step1Line.allocations.length, 1);
  assert.equal(step1Line.allocations[0].amount, 60);

  // 4. Register and confirm payment 2 for the remaining 40
  const pay2 = create(db, 'account.payment', {
    partner_id: 3,
    payment_type: 'inbound',
    partner_type: 'customer',
    amount: 40,
    date: '2026-01-02',
  });
  db = pay2.db;
  db = models['account.payment'].form.buttons.find((b) => b.label === 'Confirm').run(db, read(db, 'account.payment', pay2.id)).db;

  // 5. Match payment 2: completes the statement line
  const lineWithPay2 = write(db, LINE, line.id, { payment_id: pay2.id });
  const res2 = matchPayment(lineWithPay2, read(lineWithPay2, LINE, line.id));

  // Replay result through diffDb + applyDiff
  db = applyDiff(lineWithPay2, diffDb(lineWithPay2, res2.db), { isAdmin: true });
  const step2Line = read(db, LINE, line.id);
  assert.equal(step2Line.state, 'reconciled');
  assert.equal(step2Line.open_amount, 0);
  assert.equal(step2Line.bank_move_id, step1Line.bank_move_id, 'Original bank entry is preserved');
  assert.equal(step2Line.allocations.length, 2);
  assert.equal(step2Line.allocations[0].amount, 60);
  assert.equal(step2Line.allocations[1].amount, 40);

  // 6. Unreconciliation cleanly reverses both allocations and the bank entry
  const unrec = unreconcile(db, step2Line);
  const unrecSynced = applyDiff(db, diffDb(db, unrec.db), { isAdmin: true });
  const unrecLine = read(unrecSynced, LINE, line.id);
  assert.equal(unrecLine.state, 'to_check');
  assert.equal(unrecLine.open_amount, null);
  assert.equal(unrecLine.bank_move_id, null);
  assert.equal((unrecLine.allocations ?? []).length, 0);
});

test('matching an outbound payment partially leaves open balance on outbound statement line', () => {
  let db = seed();
  const branch = write(db, 'res.company', 1, {
    outstanding_payments_account_id: search(db, 'account.account').find((a) => a.code === '101403').id,
  });
  const bankJournal = search(branch, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);

  const line = create(branch, LINE, {
    journal_id: bankJournal.id,
    date: '2026-01-02',
    payment_ref: 'Vendor partial payment match',
    amount: -100,
  });
  db = line.db;

  const pay = create(db, 'account.payment', {
    partner_id: 3,
    payment_type: 'outbound',
    partner_type: 'supplier',
    amount: 60,
    date: '2026-01-02',
  });
  db = pay.db;
  db = models['account.payment'].form.buttons.find((b) => b.label === 'Confirm').run(db, read(db, 'account.payment', pay.id)).db;

  const lineWithPay = write(db, LINE, line.id, { payment_id: pay.id });
  const res = matchPayment(lineWithPay, read(lineWithPay, LINE, line.id));
  db = applyDiff(lineWithPay, diffDb(lineWithPay, res.db), { isAdmin: true });

  const finalLine = read(db, LINE, line.id);
  assert.equal(finalLine.state, 'to_check');
  assert.equal(finalLine.open_amount, 40);
  assert.ok(finalLine.bank_move_id);
  assert.equal(finalLine.allocations.length, 1);
  assert.equal(finalLine.allocations[0].amount, 60);
});

test('matching a payment whose amount differs with explicit write-off settles the difference to the write-off account', () => {
  const { db: base, bankJournal } = setupCompanyWithOutstanding();

  const writeoffAccount = search(base, 'account.account').find((a) => a.code === '690000');
  const line = create(base, LINE, {
    journal_id: bankJournal.id,
    date: '2026-01-02',
    payment_ref: 'Payment with explicit write-off',
    amount: 100,
    writeoff_account_id: writeoffAccount.id,
    writeoff_label: 'Agreed settlement discount',
    writeoff_amount: 20,
  });
  let db = line.db;

  // Existing payment of 80
  const pay = create(db, 'account.payment', {
    partner_id: 3,
    payment_type: 'inbound',
    partner_type: 'customer',
    amount: 80,
    date: '2026-01-02',
  });
  db = pay.db;
  db = models['account.payment'].form.buttons.find((b) => b.label === 'Confirm').run(db, read(db, 'account.payment', pay.id)).db;

  const lineWithPay = write(db, LINE, line.id, { payment_id: pay.id });
  const res = matchPayment(lineWithPay, read(lineWithPay, LINE, line.id));
  db = applyDiff(lineWithPay, diffDb(lineWithPay, res.db), { isAdmin: true });

  const finalLine = read(db, LINE, line.id);
  assert.equal(finalLine.state, 'reconciled');
  assert.equal(finalLine.open_amount, 0);

  const bookedEntry = read(db, 'account.move', finalLine.move_id);
  const writeoffItem = (bookedEntry.line_ids ?? []).find((l) => l.account_id === writeoffAccount.id);
  assert.ok(writeoffItem, 'Write-off item is booked');
  assert.equal(writeoffItem.credit, 20);
  assert.equal(writeoffItem.name, 'Agreed settlement discount');
});

test('when payments total MORE than the open amount, matchPayment rejects without write-off', () => {
  const { db: base, bankJournal } = setupCompanyWithOutstanding();

  const line = create(base, LINE, {
    journal_id: bankJournal.id,
    date: '2026-01-02',
    payment_ref: 'Payment exceeds line',
    amount: 100,
  });
  let db = line.db;

  const pay = create(db, 'account.payment', {
    partner_id: 3,
    payment_type: 'inbound',
    partner_type: 'customer',
    amount: 110,
    date: '2026-01-02',
  });
  db = pay.db;
  db = models['account.payment'].form.buttons.find((b) => b.label === 'Confirm').run(db, read(db, 'account.payment', pay.id)).db;

  const lineWithPay = write(db, LINE, line.id, { payment_id: pay.id });
  assert.throws(
    () => matchPayment(lineWithPay, read(lineWithPay, LINE, line.id)),
    /The selected payments must total the bank transaction amount/,
  );
});

test('running_balance computes cumulative statement line balance within the journal', () => {
  let db = seed();
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);

  const l1 = create(db, LINE, { journal_id: bankJournal.id, date: '2026-06-01', sequence: 10, payment_ref: 'Line 1', amount: 250 });
  db = l1.db;
  const l2 = create(db, LINE, { journal_id: bankJournal.id, date: '2026-06-02', sequence: 10, payment_ref: 'Line 2', amount: -50 });
  db = l2.db;
  const l3 = create(db, LINE, { journal_id: bankJournal.id, date: '2026-06-03', sequence: 10, payment_ref: 'Line 3', amount: 100 });
  db = l3.db;

  assert.equal(read(db, LINE, l1.id).running_balance, 250);
  assert.equal(read(db, LINE, l2.id).running_balance, 200);
  assert.equal(read(db, LINE, l3.id).running_balance, 300);
});

test('BUG-1: partial match preserves payment links, blocks reuse across lines while open, and retains all links upon completion', () => {
  const { db: base, bankJournal } = setupCompanyWithOutstanding();

  const line1 = create(base, LINE, {
    journal_id: bankJournal.id,
    date: '2026-01-05',
    payment_ref: 'Line 1 partial',
    amount: 100,
  });
  const line2 = create(line1.db, LINE, {
    journal_id: bankJournal.id,
    date: '2026-01-06',
    payment_ref: 'Line 2 competing',
    amount: 60,
  });
  let db = line2.db;

  const pay1Res = create(db, 'account.payment', {
    partner_id: 3,
    payment_type: 'inbound',
    partner_type: 'customer',
    amount: 60,
    date: '2026-01-05',
  });
  db = postPayment(pay1Res.db, read(pay1Res.db, 'account.payment', pay1Res.id));
  const pay2Res = create(db, 'account.payment', {
    partner_id: 3,
    payment_type: 'inbound',
    partner_type: 'customer',
    amount: 40,
    date: '2026-01-05',
  });
  db = postPayment(pay2Res.db, read(pay2Res.db, 'account.payment', pay2Res.id));

  // Partial match pay1 on line1
  const staged1 = write(db, LINE, line1.id, { payment_id: pay1Res.id });
  const partial1 = matchPayment(staged1, read(staged1, LINE, line1.id));
  db = applyDiff(staged1, diffDb(staged1, partial1.db), { isAdmin: true });

  const openLine1 = read(db, LINE, line1.id);
  const pay1 = read(db, 'account.payment', pay1Res.id);
  assert.equal(openLine1.state, 'to_check');
  assert.equal(openLine1.open_amount, 40);
  assert.ok(statementPaymentIds(db, openLine1).includes(pay1.id), 'Open line retains pay1 link');
  assert.equal(isPaymentMatched(db, pay1), true, 'Partially matched payment is treated as matched');
  assert.equal(
    eligiblePayments(db, read(db, LINE, line2.id)).some((p) => p.id === pay1.id),
    false,
    'Partially matched payment is excluded from other statement lines',
  );
  assert.equal(
    eligiblePayments(db, openLine1).some((p) => p.id === pay1.id),
    false,
    'Partially matched payment is excluded from re-matching on the same open line',
  );
  const dupAttempt = write(db, LINE, line2.id, { payment_id: pay1.id });
  assert.throws(() => matchPayment(dupAttempt, read(dupAttempt, LINE, line2.id)), /already matched/i);
  assert.throws(() => matchPayment(db, read(db, LINE, line1.id)), /already matched/i);

  // Complete line1 with pay2
  const staged2 = write(db, LINE, line1.id, { payment_id: pay2Res.id });
  const done = matchPayment(staged2, read(staged2, LINE, line1.id));
  db = applyDiff(staged2, diffDb(staged2, done.db), { isAdmin: true });

  const closedLine1 = read(db, LINE, line1.id);
  assert.equal(closedLine1.state, 'reconciled');
  assert.deepEqual(new Set(closedLine1.payment_ids), new Set([pay1Res.id, pay2Res.id]), 'Completed line retains every matched payment link');
  assert.deepEqual(new Set(statementPaymentIds(db, closedLine1)), new Set([pay1Res.id, pay2Res.id]));
  assert.equal(isPaymentMatched(db, read(db, 'account.payment', pay1Res.id)), true);
  assert.equal(isPaymentMatched(db, read(db, 'account.payment', pay2Res.id)), true);

  // Unreconciling releases both payments
  const unrec = unreconcile(db, closedLine1);
  db = applyDiff(db, diffDb(db, unrec.db), { isAdmin: true });
  assert.equal(isPaymentMatched(db, read(db, 'account.payment', pay1Res.id)), false);
  assert.equal(isPaymentMatched(db, read(db, 'account.payment', pay2Res.id)), false);
});

test('BUG-2: direct payment finishes an open partial line booked to suspense and replays through diffDb + applyDiff', () => {
  const { db: base, bankJournal } = setupCompanyWithOutstanding();

  const lineRes = create(base, LINE, {
    journal_id: bankJournal.id,
    date: '2026-01-10',
    payment_ref: 'Partial then direct',
    amount: 100,
  });
  let db = lineRes.db;

  // Payment 1 via outstanding receipts (60)
  const outPayRes = create(db, 'account.payment', {
    partner_id: 3,
    payment_type: 'inbound',
    partner_type: 'customer',
    amount: 60,
    date: '2026-01-10',
  });
  db = postPayment(outPayRes.db, read(outPayRes.db, 'account.payment', outPayRes.id));

  // Payment 2 posted directly to the bank journal without an outstanding account (40)
  const noOutDb = write(db, 'res.company', 1, { outstanding_receipts_account_id: null });
  const dirPayRes = create(noOutDb, 'account.payment', {
    company_id: 1,
    journal_id: bankJournal.id,
    partner_id: 3,
    payment_type: 'inbound',
    partner_type: 'customer',
    amount: 40,
    date: '2026-01-10',
  });
  db = postPayment(dirPayRes.db, read(dirPayRes.db, 'account.payment', dirPayRes.id));
  const dirPay = read(db, 'account.payment', dirPayRes.id);
  assert.equal(dirPay.outstanding_account_id ?? null, null);

  // 1. Partial match payment 1 -> books full 100 to suspense, leaves 40 open
  const staged1 = write(db, LINE, lineRes.id, { payment_id: outPayRes.id });
  const partial1 = matchPayment(staged1, read(staged1, LINE, lineRes.id));
  db = applyDiff(staged1, diffDb(staged1, partial1.db), { isAdmin: true });

  // 2. Finish open partial line with direct payment 2 -> must book suspense clearing against bank, keep booked amount 100, and pass diffDb + applyDiff
  const staged2 = write(db, LINE, lineRes.id, { payment_id: dirPayRes.id });
  const completed = matchPayment(staged2, read(staged2, LINE, lineRes.id));
  const finishedLine = read(completed.db, LINE, lineRes.id);
  assert.equal(bookedStatementAmount(completed.db, finishedLine), 100, 'Booked amount counts only the suspense movement, not direct payment again');

  const synced = applyDiff(staged2, diffDb(staged2, completed.db), { isAdmin: true });
  const finalLine = read(synced, LINE, lineRes.id);
  assert.equal(finalLine.state, 'reconciled');
  assert.equal(finalLine.open_amount, 0);
  assert.equal(finalLine.allocations.length, 2);
  assert.equal(bookedStatementAmount(synced, finalLine), 100);
  assert.equal(isPaymentMatched(synced, read(synced, 'account.payment', dirPayRes.id)), true);

  // Verify suspense is cleared to zero on this line's entries
  const moveIds = new Set([finalLine.bank_move_id, ...finalLine.allocations.map((a) => a.payment_move_id)]);
  const suspenseId = read(synced, 'account.journal', bankJournal.id).suspense_account_id;
  const suspenseNet = journalItems(synced)
    .filter((l) => moveIds.has(l.move_id) && l.account_id === suspenseId)
    .reduce((sum, l) => sum + (Number(l.debit) || 0) - (Number(l.credit) || 0), 0);
  assert.equal(suspenseNet, 0);
});

test('BUG-3: foreign partial match decides partial vs complete in statement currency, validates both amounts, and settles payments at different rates', () => {
  let db = seed();
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  const bnk1 = search(db, 'account.journal').find((j) => j.code === 'BNK1' && (j.company_id ?? 1) === 1);
  const outstandingReceipts = search(db, 'account.account').find((a) => a.code === '101402');
  db = write(db, 'res.company', 1, { outstanding_receipts_account_id: outstandingReceipts.id });
  db = write(db, 'res.currency', eur.id, {
    rate_ids: [
      { date: '2026-01-01', rate: 1 }, // 60 EUR = 60 USD
      { date: '2026-01-05', rate: 4 }, // 40 EUR = 10 USD
      { date: '2026-01-10', rate: 2 }, // Statement 100 EUR = 50 USD
    ],
  });
  const fxBnkRes = create(db, 'account.journal', {
    name: 'EUR Bank',
    code: 'EURB2',
    type: 'bank',
    currency_id: eur.id,
    default_account_id: bnk1.default_account_id,
    suspense_account_id: bnk1.suspense_account_id,
    company_id: 1,
  });
  db = fxBnkRes.db;

  // Statement line: 100 EUR on 2026-01-10 (50 USD booked company amount)
  const lineRes = create(db, LINE, {
    journal_id: fxBnkRes.id,
    date: '2026-01-10',
    payment_ref: 'EUR wire',
    amount: 100,
  });
  db = lineRes.db;

  // Payment 1: 60 EUR at rate 1.0 -> 60 USD (exceeds entire 50 USD company amount, yet 40 EUR remains open!)
  const pay1Res = create(db, 'account.payment', {
    journal_id: fxBnkRes.id,
    partner_id: 3,
    payment_type: 'inbound',
    partner_type: 'customer',
    currency_id: eur.id,
    amount: 60,
    date: '2026-01-01',
  });
  db = postPayment(pay1Res.db, read(pay1Res.db, 'account.payment', pay1Res.id));

  // Payment 2: 40 EUR at rate 4.0 -> 10 USD
  const pay2Res = create(db, 'account.payment', {
    journal_id: fxBnkRes.id,
    partner_id: 3,
    payment_type: 'inbound',
    partner_type: 'customer',
    currency_id: eur.id,
    amount: 40,
    date: '2026-01-05',
  });
  db = postPayment(pay2Res.db, read(pay2Res.db, 'account.payment', pay2Res.id));

  // Validation: a foreign shortfall whose proportional company share rounds to full statement amount rejects before posting
  const tinyRes = create(db, 'account.payment', {
    journal_id: fxBnkRes.id,
    partner_id: 3,
    payment_type: 'inbound',
    partner_type: 'customer',
    currency_id: eur.id,
    amount: 99.99,
    date: '2026-01-10',
  });
  const tinyPosted = postPayment(tinyRes.db, read(tinyRes.db, 'account.payment', tinyRes.id));
  const tinyStaged = write(tinyPosted, LINE, lineRes.id, { payment_id: tinyRes.id });
  const movesBeforeReject = search(tinyStaged, 'account.move').length;
  assert.throws(() => matchPayment(tinyStaged, read(tinyStaged, LINE, lineRes.id)), /too small/i);
  assert.equal(search(tinyStaged, 'account.move').length, movesBeforeReject, 'No entry posted when amount validation fails');

  // 1. Partial match 60 EUR (60 USD) on 100 EUR (50 USD) statement -> keeps 40 EUR (20 USD) open!
  const staged1 = write(db, LINE, lineRes.id, { payment_id: pay1Res.id });
  const res1 = matchPayment(staged1, read(staged1, LINE, lineRes.id));
  db = applyDiff(staged1, diffDb(staged1, res1.db), { isAdmin: true });

  const after1 = read(db, LINE, lineRes.id);
  assert.equal(after1.state, 'to_check', 'Line must remain open while 40 EUR is unpaid');
  assert.equal(after1.open_amount, 20, 'Remaining company share for 40 EUR at statement rate is 20 USD');
  assert.equal(after1.allocations.length, 1);
  assert.equal(after1.allocations[0].amount, 30, 'Clears 30 USD (60/100 of 50 USD booked bank amount), never more than booked');
  assert.equal(bookedStatementAmount(db, after1), 50);

  // 2. Match remaining 40 EUR (10 USD) -> completes the line
  const staged2 = write(db, LINE, lineRes.id, { payment_id: pay2Res.id });
  const res2 = matchPayment(staged2, read(staged2, LINE, lineRes.id));
  db = applyDiff(staged2, diffDb(staged2, res2.db), { isAdmin: true });

  const after2 = read(db, LINE, lineRes.id);
  assert.equal(after2.state, 'reconciled');
  assert.equal(after2.open_amount, 0);
  assert.equal(after2.allocations.length, 2);
  assert.equal(after2.allocations[0].amount + after2.allocations[1].amount, 50);
  assert.deepEqual(new Set(after2.payment_ids), new Set([pay1Res.id, pay2Res.id]));
});

test('BUG-4: open partial lines do not store settlement entry in move_id, hiding Match until a real invoice is selected', () => {
  const { db: base, bankJournal } = setupCompanyWithOutstanding();

  const pay1Res = create(base, 'account.payment', {
    partner_id: 3,
    payment_type: 'inbound',
    partner_type: 'customer',
    amount: 30,
    date: '2026-01-02',
  });
  let db = postPayment(pay1Res.db, read(pay1Res.db, 'account.payment', pay1Res.id));

  const pay2Res = create(db, 'account.payment', {
    partner_id: 3,
    payment_type: 'inbound',
    partner_type: 'customer',
    amount: 30,
    date: '2026-01-02',
  });
  db = postPayment(pay2Res.db, read(pay2Res.db, 'account.payment', pay2Res.id));

  // Create invoice after payments so it remains open for manual Match
  const invRes = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 3,
    invoice_date: '2026-01-03',
    invoice_line_ids: [{ qty: 1, price_unit: 40, tax: 0 }],
  });
  db = postMove(invRes.db, invRes.id);

  const lineRes = create(db, LINE, {
    journal_id: bankJournal.id,
    date: '2026-01-03',
    payment_ref: 'Two partials then invoice',
    amount: 100,
  });
  db = lineRes.db;

  // Partial payment 1 (30 of 100)
  const s1 = write(db, LINE, lineRes.id, { payment_id: pay1Res.id });
  db = applyDiff(s1, diffDb(s1, matchPayment(s1, read(s1, LINE, lineRes.id)).db), { isAdmin: true });

  const open1 = read(db, LINE, lineRes.id);
  const matchBtn = models[LINE].form.buttons.find((b) => b.label === 'Match');
  const reconcileBtn = models[LINE].form.buttons.find((b) => b.label === 'Reconcile');
  assert.equal(open1.move_id ?? null, null, 'Settlement entry must not be stored in invoice-selection field move_id');
  assert.equal(Boolean(matchBtn.when(open1)), false, 'Match button must not appear without an invoice');
  assert.equal(Boolean(reconcileBtn.when(open1)), true);

  // Second partial payment (30 of remaining 70 -> still open with 40) replays through diffDb + applyDiff
  const s2 = write(db, LINE, lineRes.id, { payment_id: pay2Res.id });
  db = applyDiff(s2, diffDb(s2, matchPayment(s2, read(s2, LINE, lineRes.id)).db), { isAdmin: true });
  const open2 = read(db, LINE, lineRes.id);
  assert.equal(open2.state, 'to_check');
  assert.equal(open2.open_amount, 40);
  assert.equal(open2.move_id ?? null, null);
  assert.equal(Boolean(matchBtn.when(open2)), false);

  // Select real invoice (40) -> Match button appears and completes reconciliation
  const s3 = write(db, LINE, lineRes.id, { move_id: invRes.id });
  const openWithInv = read(s3, LINE, lineRes.id);
  assert.equal(Boolean(matchBtn.when(openWithInv)), true, 'Match button appears for real invoice');
  const afterMatch = matchBtn.run(s3, openWithInv).db;
  db = applyDiff(s3, diffDb(s3, afterMatch), { isAdmin: true });
  const closed = read(db, LINE, lineRes.id);
  assert.equal(closed.state, 'reconciled');
  assert.equal(closed.open_amount, 0);
  assert.equal(closed.allocations.length, 3);
  assert.deepEqual(new Set(statementPaymentIds(db, closed)), new Set([pay1Res.id, pay2Res.id]));
});
