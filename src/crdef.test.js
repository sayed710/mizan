import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, write } from './orm.js';
import { seed } from './seed.js';
import { creditNote, postMove } from './models/accounting.js';
import { postDueEntries } from './models/deferred.js';
import { migrate, SCHEMA_VERSION } from './migrations.js';

const move = (db, id) => read(db, 'account.move', id);
const noteId = (result) => result.credit_note_id ?? result.id;

function deferredInvoice(amount = 120) {
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
      name: 'Service', qty: 1, price_unit: amount, tax: 0,
      deferred_start_date: '2026-01-01', deferred_end_date: '2026-03-31',
    }],
  });
  const db = postMove(created.db, created.id);
  const invoice = move(db, created.id);
  const schedule = db.records['account.deferral'].find((record) => record.source_move_id === created.id);
  assert.ok(invoice.invoice_line_ids[0].line_id, 'posting gives the invoice line a stable ID');
  assert.ok(schedule?.source_line_id, 'the deferral schedule points to that invoice line ID');
  return { db, invoiceId: created.id, invoice, schedule };
}

test('posting a full linked credit cancels future recognition and reverses posted recognition', () => {
  const source = deferredInvoice();
  const recognized = postDueEntries(source.db, source.schedule, '2026-01-31');
  const before = read(recognized, 'account.deferral', source.schedule.id);
  assert.equal(before.board[0].posted, true);

  const drafted = creditNote(recognized, move(recognized, source.invoiceId), { date: '2026-02-15' });
  const creditId = noteId(drafted);
  assert.equal(move(drafted.db, creditId).invoice_line_ids[0].source_line_id, source.invoice.invoice_line_ids[0].line_id);
  const posted = postMove(drafted.db, creditId);
  const after = read(posted, 'account.deferral', source.schedule.id);

  assert.equal(after.state, 'cancel');
  assert.equal(after.board[0].posted, true);
  assert.ok(after.board[0].reversal_move_id);
  assert.deepEqual(after.board.slice(1).map((line) => [line.amount, line.cancelled]), [[0, true], [0, true]]);
  const reversal = move(posted, after.board[0].reversal_move_id);
  assert.equal(reversal.reversed_entry_id, before.board[0].move_id);
  assert.equal(reversal.invoice_date, '2026-02-15');
  assert.equal(posted.records['account.deferral'].filter((record) => record.source_move_id === creditId).length, 0);
});

test('partial linked credits reduce only the remaining source schedule by the cumulative credited share', () => {
  const source = deferredInvoice();
  const recognized = postDueEntries(source.db, source.schedule, '2026-01-31');
  let db = recognized;
  for (let creditNumber = 0; creditNumber < 2; creditNumber++) {
    const drafted = creditNote(db, move(db, source.invoiceId), { date: '2026-02-15' });
    const id = noteId(drafted);
    const lines = move(drafted.db, id).invoice_line_ids.map((line) => ({ ...line, price_unit: 30 }));
    db = postMove(write(drafted.db, 'account.move', id, { invoice_line_ids: lines }), id);
  }

  const schedule = read(db, 'account.deferral', source.schedule.id);
  assert.equal(schedule.state, 'running');
  assert.equal(schedule.board[0].amount, 40, 'the already posted source period remains intact');
  assert.deepEqual(schedule.board.slice(1).map((line) => line.amount), [20, 20]);
  const corrections = db.records['account.move'].filter((record) => record.deferred_adjustment_of_id === schedule.board[0].move_id);
  assert.equal(corrections.length, 2);
  assert.deepEqual(corrections.map((record) => record.line_ids[0].debit + record.line_ids[0].credit), [10, 10]);
});

test('a manually added unlinked credit line does not change the source recognition schedule', () => {
  const source = deferredInvoice();
  const before = structuredClone(source.schedule);
  const made = create(source.db, 'account.move', {
    move_type: 'out_refund',
    reversed_entry_id: source.invoiceId,
    partner_id: source.invoice.partner_id,
    currency_id: source.invoice.currency_id ?? null,
    invoice_date: '2026-02-15',
    invoice_line_ids: [{
      name: 'Manual credit', qty: 1, price_unit: 30, tax: 0,
      deferred_start_date: '2026-01-01', deferred_end_date: '2026-03-31',
    }],
  });
  assert.equal(made.db.records['account.move'].find((record) => record.id === made.id).invoice_line_ids[0].source_line_id, undefined);

  const posted = postMove(made.db, made.id);
  assert.deepEqual(read(posted, 'account.deferral', source.schedule.id), before);
});

test('refund, cancel, and modify credit-note methods copy explicit source-line references', () => {
  for (const refund_method of ['refund', 'cancel', 'modify']) {
    const source = deferredInvoice();
    const result = creditNote(source.db, move(source.db, source.invoiceId), { refund_method, date: '2026-02-15' });
    const id = noteId(result);
    const copied = move(result.db, id).invoice_line_ids[0];
    assert.equal(copied.source_line_id, source.invoice.invoice_line_ids[0].line_id, refund_method);
    assert.notEqual(copied.line_id, source.invoice.invoice_line_ids[0].line_id, refund_method);
  }
});

test('credit creation gives a legacy invoice stable line IDs without linking its legacy credit notes', () => {
  const invoice = create(seed(), 'account.move', {
    move_type: 'out_invoice', partner_id: 2, invoice_line_ids: [{ qty: 1, price_unit: 50, tax: 0 }],
  });
  const oldCredit = create(invoice.db, 'account.move', {
    move_type: 'out_refund', reversed_entry_id: invoice.id, partner_id: 2,
    invoice_line_ids: [{ qty: 1, price_unit: 30, tax: 0 }],
  });
  const legacy = {
    ...oldCredit.db,
    schema_version: SCHEMA_VERSION,
    records: {
      ...oldCredit.db.records,
      'account.move': oldCredit.db.records['account.move'].map((record) => {
        if (record.id === invoice.id) return { ...record, state: 'posted', invoice_line_ids: record.invoice_line_ids.map(({ line_id, source_line_id, ...line }) => line) };
        if (record.id === oldCredit.id) return { ...record, state: 'posted', invoice_line_ids: record.invoice_line_ids.map(({ line_id, source_line_id, ...line }) => line) };
        return record;
      }),
    },
  };
  assert.strictEqual(migrate(legacy), legacy);

  const drafted = creditNote(legacy, move(legacy, invoice.id), { refund_method: 'refund' });
  const sourceLine = move(drafted.db, invoice.id).invoice_line_ids[0];
  const legacyCreditLine = move(drafted.db, oldCredit.id).invoice_line_ids[0];
  const newCreditLine = move(drafted.db, noteId(drafted)).invoice_line_ids[0];

  assert.ok(sourceLine.line_id);
  assert.equal(legacyCreditLine.source_line_id, undefined);
  assert.equal(newCreditLine.source_line_id, sourceLine.line_id);
});
