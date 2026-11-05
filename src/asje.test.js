import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { accountId, journalId } from './models/ledger.js';
import { postMove, postAutoPostMoves } from './models/accounting.js';

test('an unlinked manual credit line does not alter a deferred invoice schedule', () => {
  let db = seed();
  db = write(db, 'res.company', 1, {
    deferred_generation_method: 'manual',
    deferred_revenue_account_id: accountId(db, '212000'),
  });
  const invoice = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: 2, invoice_date: '2096-01-01',
    invoice_line_ids: [{ name: 'Service', qty: 1, price_unit: 100, tax: 0, account_id: accountId(db, '410000'), deferred_start_date: '2096-01-01', deferred_end_date: '2096-02-29' }],
  });
  db = postMove(invoice.db, invoice.id);
  const schedule = search(db, 'account.deferral').find((d) => d.source_move_id === invoice.id);
  const note = create(db, 'account.move', {
    move_type: 'out_refund', partner_id: 2, invoice_date: '2096-01-15', reversed_entry_id: invoice.id,
    invoice_line_ids: [{ name: 'Manual credit', qty: 1, price_unit: 50, tax: 0, account_id: accountId(db, '410000') }],
  });
  db = postMove(note.db, note.id);
  assert.deepEqual(read(db, 'account.deferral', schedule.id), schedule);
});

test('recurring automatic reversals shift and post only when due', () => {
  let db = seed();
  const entry = create(db, 'account.move', {
    move_type: 'entry', journal_id: journalId(db, 'MISC'), date: '2096-01-01', invoice_date: '2096-01-01',
    auto_post: 'monthly', auto_post_until: '2096-02-01', auto_reverse: true, reverse_date: '2096-01-02',
    line_ids: [
      { account_id: accountId(db, '600000'), debit: 50, credit: 0 },
      { account_id: accountId(db, '101401'), debit: 0, credit: 50 },
    ],
  });
  db = postMove(entry.db, entry.id);
  const reversal = search(db, 'account.move').find((m) => m.reversed_entry_id === entry.id);
  assert.equal(reversal.state, 'draft');
  const feb = search(db, 'account.move').find((m) => m.auto_post_origin_id === entry.id);
  assert.equal(feb.reverse_date, '2096-02-02');
  db = postAutoPostMoves(db, '2096-02-01');
  assert.equal(read(db, 'account.move', reversal.id).state, 'posted');
  assert.equal(read(db, 'account.move', feb.id).state, 'posted');
  const febReversal = search(db, 'account.move').find((m) => m.reversed_entry_id === feb.id);
  assert.equal(febReversal.state, 'draft');
  db = postAutoPostMoves(db, '2096-02-02');
  db = postAutoPostMoves(db, '2096-02-02');
  assert.equal(read(db, 'account.move', febReversal.id).state, 'posted');
  assert.equal(search(db, 'account.move').filter((m) => m.reversed_entry_id === feb.id).length, 1);
});

test('month-end recurring reversal preserves the original day offset', () => {
  let db = seed();
  const entry = create(db, 'account.move', {
    move_type: 'entry', journal_id: journalId(db, 'MISC'), date: '2097-01-31', invoice_date: '2097-01-31',
    auto_post: 'monthly', auto_post_until: '2097-03-31', auto_reverse: true, reverse_date: '2097-02-01',
    line_ids: [
      { account_id: accountId(db, '600000'), debit: 50, credit: 0 },
      { account_id: accountId(db, '101401'), debit: 0, credit: 50 },
    ],
  });
  db = postMove(entry.db, entry.id);
  const feb = search(db, 'account.move').find((m) => m.auto_post_origin_id === entry.id);
  assert.equal(feb.date, '2097-02-28');
  assert.equal(feb.reverse_date, '2097-03-01');
  db = postAutoPostMoves(db, '2097-02-28');
  assert.equal(read(db, 'account.move', feb.id).state, 'posted');
  const march = search(db, 'account.move').find((m) => m.auto_post_origin_id === entry.id && m.date === '2097-03-31');
  assert.equal(march.reverse_date, '2097-04-01');
});
