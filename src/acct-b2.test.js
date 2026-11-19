import test from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { create, read, search, write } from './orm.js';
import { postMove } from './models/accounting.js';
import { reconcileWith, matchPayment, unreconcile } from './models/bank.js';
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
