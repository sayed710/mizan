import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, write } from './orm.js';
import { seed } from './seed.js';
import { creditNote, postMove } from './models/accounting.js';
import { postPayment, reverseEntry } from './models/pay.js';
import { postDueEntries, generateGroupedEntries } from './models/deferred.js';

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
  const db = postMove(created.db, created.id);
  const invoice = move(db, created.id);
  const schedule = db.records['account.deferral'].find((record) => record.source_move_id === created.id);
  return { db, invoiceId: created.id, invoice, schedule };
}

test('Qodo 3: credit note line linked to deferred schedule must book to the schedule deferred account', () => {
  const source = deferredInvoice(120);

  // Case A: Draft credit note line has deferred dates removed
  const drafted1 = creditNote(source.db, move(source.db, source.invoiceId), { date: '2026-02-15' });
  const id1 = noteId(drafted1);
  const linesWithoutDates = move(drafted1.db, id1).invoice_line_ids.map((line) => ({
    ...line,
    deferred_start_date: null,
    deferred_end_date: null,
  }));
  const updated1 = write(drafted1.db, 'account.move', id1, { invoice_line_ids: linesWithoutDates });
  assert.throws(
    () => postMove(updated1, id1),
    /deferred account/i,
  );

  // Case B: Company deferred revenue account changed since invoice was posted
  const otherDeferredAcc = create(source.db, 'account.account', {
    code: '212999',
    name: 'Alternative Deferred Revenue',
    account_type: 'liability_current',
    company_id: 1,
  });
  let dbWithNewCompanyAcc = write(otherDeferredAcc.db, 'res.company', 1, {
    deferred_revenue_account_id: otherDeferredAcc.id,
  });
  const drafted2 = creditNote(dbWithNewCompanyAcc, move(dbWithNewCompanyAcc, source.invoiceId), { date: '2026-02-15' });
  const id2 = noteId(drafted2);
  assert.throws(
    () => postMove(drafted2.db, id2),
    /deferred account/i,
  );
});

test('Qodo 4: credit note that completes a refund across multiple notes can be posted and net recognition is zero', () => {
  const source = deferredInvoice(120);
  // 3 months: Jan, Feb, Mar (40 each). Post January recognition (40).
  const recognized = postDueEntries(source.db, source.schedule, '2026-01-31');

  // Credit 1: Partial credit of 60 (50%).
  const drafted1 = creditNote(recognized, move(recognized, source.invoiceId), { date: '2026-02-15' });
  const id1 = noteId(drafted1);
  const lines1 = move(drafted1.db, id1).invoice_line_ids.map((line) => ({ ...line, price_unit: 60 }));
  const posted1 = postMove(write(drafted1.db, 'account.move', id1, { invoice_line_ids: lines1 }), id1);

  const schedAfterCredit1 = read(posted1, 'account.deferral', source.schedule.id);
  assert.equal(schedAfterCredit1.state, 'running');

  // Credit 2: Completes the refund to 100% (remaining 60).
  const drafted2 = creditNote(posted1, move(posted1, source.invoiceId), { date: '2026-02-20' });
  const id2 = noteId(drafted2);
  const lines2 = move(drafted2.db, id2).invoice_line_ids.map((line) => ({ ...line, price_unit: 60 }));
  // Must post without throwing 'Reverse the recognition entries before cancelling this deferral'
  const posted2 = postMove(write(drafted2.db, 'account.move', id2, { invoice_line_ids: lines2 }), id2);

  const schedAfterCredit2 = read(posted2, 'account.deferral', source.schedule.id);
  assert.equal(schedAfterCredit2.state, 'cancel');
  assert.equal(schedAfterCredit2.board[0].posted, true);
  assert.deepEqual(schedAfterCredit2.board.slice(1).map((line) => [line.amount, line.cancelled]), [[0, true], [0, true]]);

  // Net recognition is 0:
  // Jan move was 40 credit to revenue (recognition).
  // Credit 1 posted 20 correction (debit to revenue).
  // Credit 2 posted 20 correction (debit to revenue).
  const recognitionAccount = schedAfterCredit2.recognition_account_id;
  const recognitionMoves = (posted2.records['account.move'] ?? []).filter((m) =>
    m.state === 'posted' && (m.id === schedAfterCredit2.board[0].move_id || m.deferred_adjustment_of_id === schedAfterCredit2.board[0].move_id)
  );
  let netRecognition = 0;
  for (const m of recognitionMoves) {
    for (const l of m.line_ids ?? []) {
      if (l.account_id === recognitionAccount) {
        netRecognition += (l.credit - l.debit);
      }
    }
  }
  assert.equal(netRecognition, 0);
});

test('Qodo 5: second partial credits correct remaining posted recognition proportionally', () => {
  // 3 months: Jan, Feb, Mar (30 each = 90 total).
  const source = deferredInvoice(90);
  // Post Jan recognition (30).
  let db = postDueEntries(source.db, source.schedule, '2026-01-31');

  // Credit 1 for 30 (1/3 of original 90).
  const drafted1 = creditNote(db, move(db, source.invoiceId), { date: '2026-02-15' });
  const id1 = noteId(drafted1);
  const lines1 = move(drafted1.db, id1).invoice_line_ids.map((line) => ({ ...line, price_unit: 30 }));
  db = postMove(write(drafted1.db, 'account.move', id1, { invoice_line_ids: lines1 }), id1);

  // Jan was posted for 30, corrected by 10 (net 20).
  // Feb and Mar were reduced from 30 to 20.
  let sched = read(db, 'account.deferral', source.schedule.id);
  assert.equal(sched.board[1].amount, 20);

  // Now Feb recognition is posted (20).
  db = postDueEntries(db, sched, '2026-02-28');
  sched = read(db, 'account.deferral', source.schedule.id);
  assert.equal(sched.board[1].posted, true);

  // Credit 2 for 30 (another 1/3 of original 90, which is 50% of the remaining 60).
  const drafted2 = creditNote(db, move(db, source.invoiceId), { date: '2026-03-05' });
  const id2 = noteId(drafted2);
  const lines2 = move(drafted2.db, id2).invoice_line_ids.map((line) => ({ ...line, price_unit: 30 }));
  db = postMove(write(drafted2.db, 'account.move', id2, { invoice_line_ids: lines2 }), id2);

  // Feb was posted for 20. Since Credit 2 is 50% of remaining, Feb must be corrected by 10 (not by 6.67).
  // Net recognized for Feb must be 10!
  const recognitionAccount = sched.recognition_account_id;
  const febMoveId = sched.board[1].move_id;
  const febRelatedMoves = (db.records['account.move'] ?? []).filter((m) =>
    m.state === 'posted' && (m.id === febMoveId || m.deferred_adjustment_of_id === febMoveId)
  );
  let febNetRecognition = 0;
  for (const m of febRelatedMoves) {
    for (const l of m.line_ids ?? []) {
      if (l.account_id === recognitionAccount) {
        febNetRecognition += (l.credit - l.debit);
      }
    }
  }
  assert.equal(febNetRecognition, 10);
});

test('Qodo 10: resetting a linked credit note to draft reverts adjustments and source schedule can be reposted', () => {
  const source = deferredInvoice(120);
  // Mark invoice paid so credit note is not auto-offset and can be reset to draft
  const p = create(source.db, 'account.payment', {
    partner_id: 2,
    partner_type: 'customer',
    payment_type: 'inbound',
    amount: 120,
    date: '2026-01-05',
  });
  let db = postPayment(p.db, read(p.db, 'account.payment', p.id));
  db = write(db, 'account.move', source.invoiceId, { amount_paid: 120 });

  // Post Jan recognition (40).
  db = postDueEntries(db, source.schedule, '2026-01-31');
  const schedBefore = read(db, 'account.deferral', source.schedule.id);

  // Post credit note for 60.
  const drafted = creditNote(db, move(db, source.invoiceId), { date: '2026-02-15' });
  const id = noteId(drafted);
  const lines = move(drafted.db, id).invoice_line_ids.map((line) => ({ ...line, price_unit: 60 }));
  const posted = postMove(write(drafted.db, 'account.move', id, { invoice_line_ids: lines }), id);

  const schedAfterCredit = read(posted, 'account.deferral', source.schedule.id);
  assert.equal(schedAfterCredit.board[1].amount, 20);

  // Reset credit note to draft
  const resetDb = write(posted, 'account.move', id, { state: 'draft' });
  const schedAfterReset = read(resetDb, 'account.deferral', source.schedule.id);

  // Schedule board must be restored to its pre-credit state
  assert.equal(schedAfterReset.state, 'running');
  assert.equal(schedAfterReset.board[1].amount, schedBefore.board[1].amount);
  assert.equal(schedAfterReset.board[2].amount, schedBefore.board[2].amount);

  // Reposting the credit note must succeed without error
  const repostedDb = postMove(resetDb, id);
  const schedAfterRepost = read(repostedDb, 'account.deferral', source.schedule.id);
  assert.equal(schedAfterRepost.board[1].amount, 20);
});

test('Qodo 11: small credit distributes company currency units without rounding loss across posted periods', () => {
  // 3 periods with 0.01 in each (total 0.03).
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
      name: 'Service', qty: 1, price_unit: 0.03, tax: 0,
      deferred_start_date: '2026-01-01', deferred_end_date: '2026-03-31',
    }],
  });
  let db = postMove(created.db, created.id);
  const invoice = move(db, created.id);
  const schedule = db.records['account.deferral'].find((record) => record.source_move_id === created.id);

  // Post all 3 periods (Jan, Feb, Mar: 0.01 each)
  db = postDueEntries(db, schedule, '2026-03-31');

  // Post 1-cent credit (0.01)
  const drafted = creditNote(db, invoice, { date: '2026-04-01' });
  const id = noteId(drafted);
  const lines = move(drafted.db, id).invoice_line_ids.map((line) => ({ ...line, price_unit: 0.01 }));
  db = postMove(write(drafted.db, 'account.move', id, { invoice_line_ids: lines }), id);

  // Assert exactly 1 cent total correction was posted across all periods
  const corrections = (db.records['account.move'] ?? []).filter((m) =>
    m.state === 'posted' && (m.ref ?? '').includes('Deferred recognition adjustment')
  );
  const totalCorrection = corrections.reduce((sum, m) => sum + (m.line_ids?.[0]?.debit || m.line_ids?.[0]?.credit || 0), 0);
  assert.equal(Math.round(totalCorrection * 100), 1);
});

test('Qodo 12: manually reversed recognition entry is skipped and not reversed or corrected again by credit note', () => {
  const source = deferredInvoice(120);
  // Post Jan recognition (40).
  let db = postDueEntries(source.db, source.schedule, '2026-01-31');
  const sched = read(db, 'account.deferral', source.schedule.id);
  const janMoveId = sched.board[0].move_id;
  const janMove = move(db, janMoveId);

  // User manually reverses Jan recognition move
  db = reverseEntry(db, janMove, '2026-02-01', { reason: 'Manual adjustment' }).db;

  // Now post a full credit note. It should NOT throw 'This entry has already been reversed'
  const drafted = creditNote(db, move(db, source.invoiceId), { date: '2026-02-15' });
  const id = noteId(drafted);
  assert.doesNotThrow(() => {
    db = postMove(drafted.db, id);
  });
});

test('Qodo 13: grouped deferrals adjust contributions for linked credit notes and allow idempotent regeneration', () => {
  const configured = write(seed(), 'res.company', 1, {
    deferred_generation_method: 'manual_grouped',
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
  const invoice = move(db, created.id);

  // Generate grouped entry for Jan 31
  db = generateGroupedEntries(db, { company_id: 1, kind: 'revenue', date: '2026-01-31' });

  // Post partial credit note for 60 (50%)
  const drafted = creditNote(db, invoice, { date: '2026-02-15' });
  const id = noteId(drafted);
  const lines = move(drafted.db, id).invoice_line_ids.map((line) => ({ ...line, price_unit: 60 }));
  db = postMove(write(drafted.db, 'account.move', id, { invoice_line_ids: lines }), id);

  // Assert grouped adjustment entry was posted
  const adjustments = (db.records['account.move'] ?? []).filter((m) =>
    m.state === 'posted' && (m.ref ?? '').includes('Deferred recognition adjustment')
  );
  assert.ok(adjustments.length > 0);

  // Calling generateGroupedEntries again for Jan 31 must accept the adjusted contribution and not throw
  assert.doesNotThrow(() => {
    db = generateGroupedEntries(db, { company_id: 1, kind: 'revenue', date: '2026-01-31' });
  });
});

test('an earlier credit note cannot be reset while a later credit note still adjusts the same deferral', () => {
  const source = deferredInvoice(90);
  // A paid invoice keeps its credit notes unreconciled, so they can be reset to draft.
  const payment = create(source.db, 'account.payment', { partner_id: 2, partner_type: 'customer', payment_type: 'inbound', amount: 90, date: '2026-01-05' });
  let db = write(postPayment(payment.db, read(payment.db, 'account.payment', payment.id)), 'account.move', source.invoiceId, { amount_paid: 90 });
  db = postDueEntries(db, source.schedule, '2026-01-31');
  const postPartialCredit = (state, date) => {
    const drafted = creditNote(state, move(state, source.invoiceId), { date });
    const id = noteId(drafted);
    const lines = move(drafted.db, id).invoice_line_ids.map((line) => ({ ...line, price_unit: 30 }));
    return { db: postMove(write(drafted.db, 'account.move', id, { invoice_line_ids: lines }), id), id };
  };
  const first = postPartialCredit(db, '2026-02-15');
  const second = postPartialCredit(first.db, '2026-02-20');
  db = second.db;
  assert.throws(() => write(db, 'account.move', first.id, { state: 'draft' }), /Reset the later credit notes/);
  const afterSecondReset = write(db, 'account.move', second.id, { state: 'draft' });
  const restored = read(afterSecondReset, 'account.deferral', source.schedule.id);
  assert.deepEqual(restored.board.map((line) => line.amount), read(first.db, 'account.deferral', source.schedule.id).board.map((line) => line.amount));
});
