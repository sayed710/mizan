import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { models } from './registry.js';
import { seed } from './seed.js';
import { creditNote, postMove } from './models/accounting.js';
import { postPayment } from './models/pay.js';
import { postDueEntries } from './models/deferred.js';

const move = (db, id) => read(db, 'account.move', id);
const noteId = (result) => result.credit_note_id ?? result.id;

function deferredInvoice(amount = 120, opts = {}) {
  const configured = write(seed(), 'res.company', 1, {
    deferred_generation_method: opts.method ?? 'manual',
    deferred_amount_computation_method: 'full_months',
  });
  const created = create(configured, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 2,
    invoice_date: '2026-01-01',
    invoice_date_due: '2026-01-01',
    invoice_line_ids: [{
      name: 'Service', qty: 1, price_unit: amount, tax: 0,
      deferred_start_date: opts.start ?? '2026-01-01', deferred_end_date: opts.end ?? '2026-03-31',
    }],
  });
  let db = postMove(created.db, created.id);
  // Mark invoice paid so credit notes remain unreconciled and can leave posted / reset to draft
  const p = create(db, 'account.payment', {
    partner_id: 2,
    partner_type: 'customer',
    payment_type: 'inbound',
    amount,
    date: '2026-01-05',
  });
  db = postPayment(p.db, read(p.db, 'account.payment', p.id));
  db = write(db, 'account.move', created.id, { amount_paid: amount });

  const invoice = move(db, created.id);
  const schedule = db.records['account.deferral'].find((record) => record.source_move_id === created.id);
  return { db, invoiceId: created.id, invoice, schedule };
}

function netAccountRecognition(db, accountId) {
  return (db.records['account.move'] ?? [])
    .filter((m) => m.state === 'posted')
    .flatMap((m) => m.line_ids ?? [])
    .filter((l) => l.account_id === accountId)
    .reduce((sum, l) => sum + ((Number(l.credit) || 0) - (Number(l.debit) || 0)), 0);
}

test('Qodo 1 — Reset credits can duplicate recognition: interim period entries reversed and restored schedule can be posted without duplicate recognition', () => {
  const source = deferredInvoice(120);
  const baselineRevenue = netAccountRecognition(source.db, source.schedule.recognition_account_id);

  // 3 months: Jan, Feb, Mar (40 each). Post Jan recognition (40).
  let db = postDueEntries(source.db, source.schedule, '2026-01-31');

  // Partial credit of 30 (25% of 120). Unposted Feb and Mar become 30 each.
  const drafted = creditNote(db, move(db, source.invoiceId), { date: '2026-02-15' });
  const creditId = noteId(drafted);
  const lines = move(drafted.db, creditId).invoice_line_ids.map((l) => ({ ...l, price_unit: 30 }));
  db = postMove(write(drafted.db, 'account.move', creditId, { invoice_line_ids: lines }), creditId);

  let sched = read(db, 'account.deferral', source.schedule.id);
  assert.equal(sched.board[1].amount, 30);

  // Accountant posts February recognition (30) while credit is active
  db = postDueEntries(db, sched, '2026-02-28');
  sched = read(db, 'account.deferral', source.schedule.id);
  assert.equal(sched.board[1].posted, true);
  const febInterimMoveId = sched.board[1].move_id;
  assert.ok(febInterimMoveId);

  // Accountant resets the credit note to draft
  db = write(db, 'account.move', creditId, { state: 'draft' });
  sched = read(db, 'account.deferral', source.schedule.id);

  // The restored board must have Feb unposted with its pre-credit full amount (40)
  assert.equal(sched.board[1].amount, 40);
  assert.equal(sched.board[1].posted, false);
  assert.equal(sched.board[1].move_id, null);

  // The interim entry for Feb must be reversed
  const febInterimReversal = search(db, 'account.move').find((m) => m.state === 'posted' && m.reversed_entry_id === febInterimMoveId);
  assert.ok(febInterimReversal, 'Interim posted recognition move was reversed');

  // Next deferral run posts February recognition
  db = postDueEntries(db, sched, '2026-02-28');
  sched = read(db, 'account.deferral', source.schedule.id);
  assert.equal(sched.board[1].posted, true);
  assert.equal(sched.board[1].amount, 40);
  assert.notEqual(sched.board[1].move_id, febInterimMoveId);

  // Net revenue recognised across all posted entries for Jan and Feb must be exactly 80 (40 Jan + 40 Feb)
  const netRevenue = netAccountRecognition(db, sched.recognition_account_id) - baselineRevenue;
  assert.equal(netRevenue, 80);
});

test('Qodo 2 — Reposted full credits retain revenue: full credit posted, reset, and reposted offsets recognition revenue', () => {
  const source = deferredInvoice(120);
  const baselineRevenue = netAccountRecognition(source.db, source.schedule.recognition_account_id);

  // Post Jan recognition (40).
  let db = postDueEntries(source.db, source.schedule, '2026-01-31');
  assert.equal(netAccountRecognition(db, source.schedule.recognition_account_id) - baselineRevenue, 40);

  // Post full credit note of 120
  const drafted = creditNote(db, move(db, source.invoiceId), { date: '2026-02-15' });
  const creditId = noteId(drafted);
  db = postMove(drafted.db, creditId);

  let sched = read(db, 'account.deferral', source.schedule.id);
  assert.equal(sched.state, 'cancel');
  assert.equal(netAccountRecognition(db, source.schedule.recognition_account_id) - baselineRevenue, 0);

  // Reset full credit note to draft
  db = write(db, 'account.move', creditId, { state: 'draft' });
  sched = read(db, 'account.deferral', source.schedule.id);
  assert.equal(sched.state, 'running');
  assert.equal(netAccountRecognition(db, source.schedule.recognition_account_id) - baselineRevenue, 40);

  // Repost the full credit note
  db = postMove(db, creditId);
  sched = read(db, 'account.deferral', source.schedule.id);
  assert.equal(sched.state, 'cancel');

  // Net revenue must be 0 (all recognized revenue offset, none retained)
  const repostRevenue = netAccountRecognition(db, source.schedule.recognition_account_id) - baselineRevenue;
  assert.equal(repostRevenue, 0);
});

test('Qodo 5 — Reversed corrections block credit resets: credit note reset succeeds when adjustment was reversed through Reverse Entry action', () => {
  const source = deferredInvoice(120);
  // Post Jan recognition (40).
  let db = postDueEntries(source.db, source.schedule, '2026-01-31');

  // Post partial credit of 60 (50%). This creates a correction entry for Jan (20).
  const drafted = creditNote(db, move(db, source.invoiceId), { date: '2026-02-15' });
  const creditId = noteId(drafted);
  const lines = move(drafted.db, creditId).invoice_line_ids.map((l) => ({ ...l, price_unit: 60 }));
  db = postMove(write(drafted.db, 'account.move', creditId, { invoice_line_ids: lines }), creditId);

  const correctionMoves = (db.records['account.move'] ?? []).filter((m) =>
    m.state === 'posted' && (m.ref ?? '').includes(`Deferred recognition adjustment for ${read(db, 'account.move', creditId).name}`)
  );
  assert.equal(correctionMoves.length, 1);
  const correction = correctionMoves[0];

  // Accountant reverses the correction entry using the "Reverse Entry" action on the entry
  const reverseButton = models['account.move'].form.buttons.find((b) => b.label === 'Reverse Entry');
  assert.ok(reverseButton);
  const reversedEntryResult = reverseButton.run(db, correction, { date: '2026-02-20', reason: 'Reversed by accountant' });
  db = reversedEntryResult.db;

  // Now reset the linked credit note to draft. Must NOT throw 'This entry has already been reversed'
  assert.doesNotThrow(() => {
    db = write(db, 'account.move', creditId, { state: 'draft' });
  });

  const schedAfterReset = read(db, 'account.deferral', source.schedule.id);
  assert.equal(schedAfterReset.state, 'running');
  assert.equal(schedAfterReset.board[1].amount, 40);
  assert.equal(schedAfterReset.board[2].amount, 40);
});
