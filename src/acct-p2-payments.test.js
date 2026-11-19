import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { isBalanced } from './models/ledger.js';
import { payMove, postMove } from './models/accounting.js';
import {
  applyPaymentCredit,
  resetToDraftError,
  postPayment,
  resetPaymentToDraft,
  reversePayment,
} from './models/pay.js';
import { applyDiff, diffDb } from './sync.js';
import { seed } from './seed.js';

const postInvoice = (db, vals = {}) => {
  const { db: next, id } = create(db, 'account.move', {
    partner_id: 2,
    invoice_date: '2026-05-01',
    invoice_date_due: '2026-05-30',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
    ...vals,
  });
  return { db: postMove(next, id), id };
};

// ---------------------------------------------------------------------------
// 1. PAY-2: Standalone payment posting does NOT auto-allocate to open invoices
// ---------------------------------------------------------------------------
test('PAY-2: posting a standalone payment does not auto-allocate to open invoices', () => {
  const seeded = seed();
  const partner = create(seeded, 'res.partner', { name: 'Customer PAY-2' });
  const inv1 = postInvoice(partner.db, {
    move_type: 'out_invoice',
    partner_id: partner.id,
    invoice_date: '2026-05-01',
    invoice_date_due: '2026-05-15',
  });
  const inv2 = postInvoice(inv1.db, {
    move_type: 'out_invoice',
    partner_id: partner.id,
    invoice_date: '2026-05-02',
    invoice_date_due: '2026-05-20',
  });

  // Create standalone payment from Payments menu (invoice_id is NOT set)
  const pmt = create(inv2.db, 'account.payment', {
    partner_id: partner.id,
    amount: 150,
    date: '2026-05-10',
    payment_type: 'inbound',
    partner_type: 'customer',
  });

  const postedDb = postPayment(pmt.db, read(pmt.db, 'account.payment', pmt.id));

  // Invoices must remain completely open and unallocated
  const afterInv1 = read(postedDb, 'account.move', inv1.id);
  const afterInv2 = read(postedDb, 'account.move', inv2.id);
  assert.equal(afterInv1.payment_state, 'not_paid');
  assert.equal(afterInv1.amount_residual, 100);
  assert.equal(afterInv2.payment_state, 'not_paid');
  assert.equal(afterInv2.amount_residual, 100);

  // Standalone payment is posted with full amount as unapplied credit
  const afterPayment = read(postedDb, 'account.payment', pmt.id);
  assert.equal(afterPayment.state, 'posted');
  assert.equal(afterPayment.unapplied, 150);
  assert.ok(afterPayment.move_id);
  const entry = read(postedDb, 'account.move', afterPayment.move_id);
  assert.ok(isBalanced(entry.line_ids));

  // Explicit matching works later via applyPaymentCredit
  const matchedDb = applyPaymentCredit(postedDb, afterPayment.id, inv1.id, '2026-05-11', 100);
  assert.equal(read(matchedDb, 'account.move', inv1.id).payment_state, 'paid');
  assert.equal(read(matchedDb, 'account.payment', afterPayment.id).unapplied, 50);

  // Register payment wizard still settles its own invoice directly
  const inv3 = postInvoice(matchedDb, {
    move_type: 'out_invoice',
    partner_id: partner.id,
    invoice_date: '2026-05-03',
  });
  const regPaidDb = payMove(inv3.db, inv3.id, 100, '2026-05-12');
  assert.equal(read(regPaidDb, 'account.move', inv3.id).payment_state, 'paid');
});

// ---------------------------------------------------------------------------
// 2. PAY-13 / BANK-1: Internal transfers between bank/cash journals
// ---------------------------------------------------------------------------
test('PAY-13: fails when company transfer_account_id is not set', () => {
  const db = seed();
  const bank1 = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  const cash = search(db, 'account.journal').find((j) => j.code === 'CSH1');

  // Ensure company has no transfer_account_id
  const noTransferDb = write(db, 'res.company', 1, { transfer_account_id: null });

  const pmt = create(noTransferDb, 'account.payment', {
    is_internal_transfer: true,
    journal_id: bank1.id,
    destination_journal_id: cash.id,
    amount: 250,
    date: '2026-06-01',
    payment_type: 'outbound',
  });

  assert.throws(
    () => postPayment(pmt.db, read(pmt.db, 'account.payment', pmt.id)),
    /transfer account/i,
  );
});

test('PAY-13: destination_journal_id must be bank/cash, same company, and distinct from journal_id', () => {
  let db = seed();
  const bank1 = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  const general = search(db, 'account.journal').find((j) => j.type === 'general');

  // Create an active current asset transfer account on company 1
  const transferAcc = create(db, 'account.account', {
    code: '101700',
    name: 'Internal Transfers',
    account_type: 'asset_current',
    reconcile: true,
    company_id: 1,
  });
  db = write(transferAcc.db, 'res.company', 1, { transfer_account_id: transferAcc.id });

  // 1. Same source and destination journal
  const p1 = create(db, 'account.payment', {
    is_internal_transfer: true,
    journal_id: bank1.id,
    destination_journal_id: bank1.id,
    amount: 100,
  });
  assert.throws(() => postPayment(p1.db, read(p1.db, 'account.payment', p1.id)), /destination journal/i);

  // 2. Non-bank/cash destination journal
  const p2 = create(db, 'account.payment', {
    is_internal_transfer: true,
    journal_id: bank1.id,
    destination_journal_id: general.id,
    amount: 100,
  });
  assert.throws(() => postPayment(p2.db, read(p2.db, 'account.payment', p2.id)), /bank|cash/i);
});

test('PAY-13: posting internal transfer creates two balanced entries, reconciles transfer lines, and reversal undoes both', () => {
  let db = seed();
  const bank1 = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  const cash = search(db, 'account.journal').find((j) => j.code === 'CSH1');

  // Create active current-asset transfer account and set on company
  const transferAcc = create(db, 'account.account', {
    code: '101700',
    name: 'Internal Transfers',
    account_type: 'asset_current',
    reconcile: true,
    company_id: 1,
  });
  db = write(transferAcc.db, 'res.company', 1, { transfer_account_id: transferAcc.id });

  // Create internal transfer without partner
  const pmt = create(db, 'account.payment', {
    is_internal_transfer: true,
    journal_id: bank1.id,
    destination_journal_id: cash.id,
    amount: 300,
    date: '2026-06-05',
    memo: 'Transfer BNK1 to CSH1',
  });

  const postedDb = postPayment(pmt.db, read(pmt.db, 'account.payment', pmt.id));
  const payment = read(postedDb, 'account.payment', pmt.id);
  assert.equal(payment.state, 'posted');
  assert.ok(payment.move_id);
  assert.ok(payment.destination_move_id);

  const sourceMove = read(postedDb, 'account.move', payment.move_id);
  const destMove = read(postedDb, 'account.move', payment.destination_move_id);

  assert.equal(sourceMove.journal_id, bank1.id);
  assert.equal(destMove.journal_id, cash.id);
  assert.ok(isBalanced(sourceMove.line_ids));
  assert.ok(isBalanced(destMove.line_ids));

  // Source journal: credit liquidity/outstanding, debit transfer account; no partner
  const sourceTransferLine = sourceMove.line_ids.find((l) => l.account_id === transferAcc.id);
  const sourceLiquidityLine = sourceMove.line_ids.find((l) => l.account_id !== transferAcc.id);
  assert.equal(sourceTransferLine.debit, 300);
  assert.equal(sourceLiquidityLine.credit, 300);
  assert.equal(sourceTransferLine.partner_id ?? null, null);
  assert.equal(sourceLiquidityLine.partner_id ?? null, null);

  // Destination journal: debit liquidity/outstanding, credit transfer account; no partner
  const destTransferLine = destMove.line_ids.find((l) => l.account_id === transferAcc.id);
  const destLiquidityLine = destMove.line_ids.find((l) => l.account_id !== transferAcc.id);
  assert.equal(destLiquidityLine.debit, 300);
  assert.equal(destTransferLine.credit, 300);
  assert.equal(destTransferLine.partner_id ?? null, null);
  assert.equal(destLiquidityLine.partner_id ?? null, null);

  // The two transfer account lines are reconciled together
  const partials = search(postedDb, 'account.partial.reconcile').filter(
    (g) => g && g.active !== false && !g.reversed
      && ((g.debit_move_id === sourceMove.id && g.credit_move_id === destMove.id)
        || (g.debit_move_id === destMove.id && g.credit_move_id === sourceMove.id)),
  );
  assert.equal(partials.length, 1);
  assert.equal(partials[0].amount, 300);

  // Reversing the internal transfer undoes both entries
  const reversedDb = reversePayment(postedDb, payment, '2026-06-06');
  const revPayment = read(reversedDb, 'account.payment', payment.id);
  assert.equal(revPayment.state, 'reversed');

  // Both moves must be reversed
  const afterSource = read(reversedDb, 'account.move', sourceMove.id);
  const afterDest = read(reversedDb, 'account.move', destMove.id);
  assert.ok(afterSource.reversal_move_id || search(reversedDb, 'account.move').some((m) => m.reversed_entry_id === sourceMove.id));
  assert.ok(afterDest.reversal_move_id || search(reversedDb, 'account.move').some((m) => m.reversed_entry_id === destMove.id));
});

// ---------------------------------------------------------------------------
// 3. PAY-14: Reset to draft
// ---------------------------------------------------------------------------
test('PAY-14: unreconciled posted payment can be reset to draft, corrected, and posted again', () => {
  const seeded = seed();
  const partner = create(seeded, 'res.partner', { name: 'Customer PAY-14' });
  const pmt = create(partner.db, 'account.payment', {
    partner_id: partner.id,
    amount: 200,
    date: '2026-07-01',
    payment_type: 'inbound',
    partner_type: 'customer',
  });

  const postedDb = postPayment(pmt.db, read(pmt.db, 'account.payment', pmt.id));
  const postedPmt = read(postedDb, 'account.payment', pmt.id);
  assert.equal(postedPmt.state, 'posted');
  const originalMoveId = postedPmt.move_id;
  assert.ok(originalMoveId);

  // Reset to Draft is available and works
  assert.equal(resetToDraftError(postedDb, postedPmt), null);
  const resetDb = resetPaymentToDraft(postedDb, postedPmt);
  const draftPmt = read(resetDb, 'account.payment', pmt.id);
  assert.equal(draftPmt.state, 'draft');
  assert.equal(draftPmt.move_id, null);

  // Original move was cancelled or removed
  const origMove = read(resetDb, 'account.move', originalMoveId);
  assert.ok(!origMove || origMove.state === 'cancel');

  // Payment in draft can be corrected and posted again
  const correctedDb = write(resetDb, 'account.payment', pmt.id, { amount: 250 });
  const repostedDb = postPayment(correctedDb, read(correctedDb, 'account.payment', pmt.id));
  const finalPmt = read(repostedDb, 'account.payment', pmt.id);
  assert.equal(finalPmt.state, 'posted');
  assert.equal(finalPmt.amount, 250);
  assert.equal(finalPmt.unapplied, 250);
  assert.ok(finalPmt.move_id);
  assert.notEqual(finalPmt.move_id, originalMoveId);
});

test('PAY-14: cancelled payment can also be reset to draft', () => {
  const db = seed();
  const pmt = create(db, 'account.payment', {
    partner_id: 1,
    amount: 50,
    state: 'cancel',
  });
  assert.equal(resetToDraftError(pmt.db, read(pmt.db, 'account.payment', pmt.id)), null);
  const resetDb = resetPaymentToDraft(pmt.db, read(pmt.db, 'account.payment', pmt.id));
  assert.equal(read(resetDb, 'account.payment', pmt.id).state, 'draft');
});

test('PAY-14: reconciled payments cannot be reset to draft, keeping only reverse', () => {
  const seeded = seed();
  const partner = create(seeded, 'res.partner', { name: 'Customer PAY-14-REC' });
  const inv = postInvoice(partner.db, {
    move_type: 'out_invoice',
    partner_id: partner.id,
    invoice_date: '2026-07-01',
  });
  const pmt = create(inv.db, 'account.payment', {
    partner_id: partner.id,
    amount: 100,
    date: '2026-07-05',
    payment_type: 'inbound',
    partner_type: 'customer',
  });
  const postedDb = postPayment(pmt.db, read(pmt.db, 'account.payment', pmt.id));
  const reconciledDb = applyPaymentCredit(postedDb, pmt.id, inv.id, '2026-07-06');
  const reconciledPmt = read(reconciledDb, 'account.payment', pmt.id);

  assert.ok(resetToDraftError(reconciledDb, reconciledPmt));
  assert.throws(
    () => resetPaymentToDraft(reconciledDb, reconciledPmt),
    /reconcil/i,
  );

  // Direct state tampering is blocked by guard via diffDb + applyDiff
  const forgedReset = {
    ...reconciledDb,
    records: {
      ...reconciledDb.records,
      'account.payment': reconciledDb.records['account.payment'].map((p) => (p.id === pmt.id ? { ...p, state: 'draft' } : p)),
    },
  };
  assert.throws(
    () => applyDiff(reconciledDb, diffDb(reconciledDb, forgedReset), { isAdmin: true }),
    /reconcil|draft|locked/i,
  );
});

test('PAY-14: reset to draft is blocked for payments in posted batch, bank-matched, or locked', () => {
  const seeded = seed();
  const partner = create(seeded, 'res.partner', { name: 'Customer PAY-14-LOCKS' });
  const pmt = create(partner.db, 'account.payment', {
    partner_id: partner.id,
    amount: 100,
    date: '2026-01-10',
    payment_type: 'inbound',
    partner_type: 'customer',
  });
  const postedDb = postPayment(pmt.db, read(pmt.db, 'account.payment', pmt.id));
  const postedPmt = read(postedDb, 'account.payment', pmt.id);

  // 1. Bank-matched payment cannot be reset
  const bankMatchedDb = create(postedDb, 'account.bank.statement.line', {
    journal_id: postedPmt.journal_id,
    date: '2026-01-11',
    payment_ref: 'Bank Statement Line',
    amount: 100,
    state: 'reconciled',
    move_id: postedPmt.move_id,
    payment_move_id: postedPmt.move_id,
  }).db;
  assert.ok(resetToDraftError(bankMatchedDb, postedPmt));
  assert.throws(() => resetPaymentToDraft(bankMatchedDb, postedPmt), /bank/i);

  // 2. Payment in posted batch cannot be reset
  const batchDb = create(postedDb, 'account.batch.payment', {
    batch_type: 'inbound',
    journal_id: postedPmt.journal_id,
    state: 'posted',
    lines: [{ payment_id: postedPmt.id, amount: 100, cancelled: false }],
  }).db;
  assert.ok(resetToDraftError(batchDb, postedPmt));
  assert.throws(() => resetPaymentToDraft(batchDb, postedPmt), /batch/i);

  // 3. Locked payment cannot be reset
  const lockedDb = write(postedDb, 'res.company', 1, { lock_date: '2026-02-01' });
  assert.ok(resetToDraftError(lockedDb, postedPmt));
  assert.throws(() => resetPaymentToDraft(lockedDb, postedPmt), /lock/i);
});
