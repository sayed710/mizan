import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, write } from './orm.js';
import { seed } from './seed.js';
import { creditNote, postMove } from './models/accounting.js';
import { postDueEntries } from './models/deferred.js';
import { postPayment, reverseEntry } from './models/pay.js';
import { runScheduledJobs } from './models/scheduler.js';

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

test('Qodo 1: resetting a full credit leaves a secured recognition entry untouched while restoring its scheduled reversal', () => {
  const reversalDate = offsetDate(new Date().toISOString().slice(0, 10), 30);
  const { db, creditId, recognitionMoveId, scheduledReversalId } = postFullCreditWithScheduledReversal(reversalDate);
  // Secure the recognition entry as a hash-restricted journal would.
  const secured = { ...db, records: { ...db.records, 'account.move': db.records['account.move'].map((m) => (m.id === recognitionMoveId ? { ...m, inalterable_hash: 'h' } : m)) } };
  const before = move(secured, recognitionMoveId);
  const reset = write(secured, 'account.move', creditId, { state: 'draft' });
  assert.equal(move(reset, scheduledReversalId).state, 'draft');
  assert.equal(move(reset, scheduledReversalId).reversed_entry_id, recognitionMoveId);
  assert.deepEqual(move(reset, recognitionMoveId), before);
});

test('Qodo 3: a due entry that cannot auto-post is reported to the scheduler while other due entries still post', () => {
  let db = seed();
  const bad = create(db, 'account.move', { move_type: 'entry', date: '2026-01-10', auto_post: 'at_date', line_ids: [{ account_id: 1, debit: 10, credit: 0 }] });
  const good = create(bad.db, 'account.move', { move_type: 'entry', date: '2026-01-10', auto_post: 'at_date', line_ids: [{ account_id: 1, debit: 10, credit: 0 }, { account_id: 2, debit: 0, credit: 10 }] });
  const errors = [];
  db = runScheduledJobs(good.db, '2026-01-15', { onError: (job, e) => errors.push([job, e.message]) });
  assert.equal(move(db, good.id).state, 'posted');
  assert.equal(move(db, bad.id).state, 'draft');
  assert.ok(errors.some(([job]) => job === `auto-post move ${bad.id}`), JSON.stringify(errors));
  assert.ok((db.messages ?? []).some((m) => m.res_id === bad.id && m.body.startsWith('Auto-post failed')));
});
