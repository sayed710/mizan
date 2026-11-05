import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, write } from './orm.js';
import { seed } from './seed.js';
import { creditNote, postAutoPostMoves, postMove } from './models/accounting.js';
import { postDueEntries } from './models/deferred.js';
import { postPayment, reverseEntry } from './models/pay.js';

const only = (records, label) => {
  assert.equal(records.length, 1, `${label} must have exactly one match`);
  return records[0];
};

const move = (db, id) => read(db, 'account.move', id);
const noteId = (result) => result.credit_note_id ?? result.id;

function offsetDate(date, days) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function postFullCreditWithScheduledReversal(reversalDate) {
  const configured = write(seed(), 'res.company', 1, {
    deferred_generation_method: 'manual',
    deferred_amount_computation_method: 'full_months',
  });
  const created = create(configured, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 2,
    invoice_date: '2026-01-01',
    invoice_date_due: '2026-01-01',
    invoice_line_ids: [{
      name: 'Service', qty: 1, price_unit: 120, tax: 0,
      deferred_start_date: '2026-01-01', deferred_end_date: '2026-03-31',
    }],
  });
  let db = postMove(created.db, created.id);
  const schedule = only(
    (db.records['account.deferral'] ?? []).filter((record) => record.source_move_id === created.id),
    'invoice deferral schedule',
  );
  db = postDueEntries(db, schedule, '2026-01-31');
  const recognitionMoveId = read(db, 'account.deferral', schedule.id).board[0].move_id;
  const scheduled = reverseEntry(db, move(db, recognitionMoveId), { date: reversalDate, scheduled: true });
  db = scheduled.db;

  const payment = create(db, 'account.payment', {
    partner_id: 2,
    partner_type: 'customer',
    payment_type: 'inbound',
    amount: 120,
    date: '2026-01-05',
  });
  db = postPayment(payment.db, read(payment.db, 'account.payment', payment.id));
  db = write(db, 'account.move', created.id, { amount_paid: 120 });

  const credit = creditNote(db, move(db, created.id), { date: '2026-02-15' });
  const creditId = noteId(credit);
  db = postMove(credit.db, creditId);
  const scheduledAfterCredit = only(
    (db.records['account.move'] ?? []).filter((entry) => entry.id === scheduled.id),
    'cancelled scheduled reversal',
  );
  assert.equal(scheduledAfterCredit.state, 'cancel');
  const creditOffset = only(
    (db.records['account.move'] ?? []).filter((entry) => entry.state === 'posted' && entry.reversed_entry_id === recognitionMoveId),
    'immediate credit offset',
  );
  return { db, creditId, scheduleId: schedule.id, recognitionMoveId, scheduledReversalId: scheduled.id, creditOffsetId: creditOffset.id };
}

function assertCreditOffsetIsReversedOnce(db, recognitionMoveId, creditOffsetId, scheduledReversalId) {
  const directPostedReversals = (db.records['account.move'] ?? []).filter((entry) =>
    entry.state === 'posted' && entry.reversed_entry_id === recognitionMoveId
  );
  assert.deepEqual(
    directPostedReversals.map((entry) => entry.id).sort((a, b) => a - b),
    [creditOffsetId, scheduledReversalId].sort((a, b) => a - b),
  );
  const creditOffsetReset = only(
    (db.records['account.move'] ?? []).filter((entry) => entry.state === 'posted' && entry.reversed_entry_id === creditOffsetId),
    'reversal of the immediate credit offset',
  );
  assert.equal(creditOffsetReset.state, 'posted');
}

test('Qodo 1: resetting a full credit restores its scheduled reversal and reverses the immediate offset once', () => {
  const today = new Date().toISOString().slice(0, 10);
  const { db, creditId, scheduleId, recognitionMoveId, scheduledReversalId, creditOffsetId } = postFullCreditWithScheduledReversal(today);

  const reset = write(db, 'account.move', creditId, { state: 'draft' });

  assert.equal(read(reset, 'account.deferral', scheduleId).state, 'running');
  assert.equal(read(reset, 'account.deferral', scheduleId).board[1].amount, 40);
  assert.equal(move(reset, scheduledReversalId).state, 'posted');
  assert.equal(move(reset, scheduledReversalId).auto_post, 'at_date');
  assert.equal(move(reset, recognitionMoveId).reversal_move_id, scheduledReversalId);
  assertCreditOffsetIsReversedOnce(reset, recognitionMoveId, creditOffsetId, scheduledReversalId);
});

test('Qodo 1: resetting a full credit restores a future scheduled reversal for its due date', () => {
  const today = new Date().toISOString().slice(0, 10);
  const reversalDate = offsetDate(today, 30);
  const { db, creditId, scheduleId, recognitionMoveId, scheduledReversalId, creditOffsetId } = postFullCreditWithScheduledReversal(reversalDate);

  const reset = write(db, 'account.move', creditId, { state: 'draft' });
  assert.equal(read(reset, 'account.deferral', scheduleId).state, 'running');
  assert.equal(read(reset, 'account.deferral', scheduleId).board[1].amount, 40);
  assert.equal(move(reset, scheduledReversalId).state, 'draft');
  assert.equal(move(reset, scheduledReversalId).auto_post, 'at_date');
  assert.equal(move(reset, recognitionMoveId).reversal_move_id, scheduledReversalId);
  assert.equal((reset.records['account.move'] ?? []).filter((entry) => entry.state === 'posted' && entry.reversed_entry_id === recognitionMoveId).length, 1);

  const beforeDue = postAutoPostMoves(reset, offsetDate(reversalDate, -1));
  assert.equal(move(beforeDue, scheduledReversalId).state, 'draft');
  const due = postAutoPostMoves(beforeDue, reversalDate);
  assert.equal(move(due, scheduledReversalId).state, 'posted');
  assertCreditOffsetIsReversedOnce(due, recognitionMoveId, creditOffsetId, scheduledReversalId);
});
