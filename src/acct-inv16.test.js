import { test } from 'node:test';
import assert from 'node:assert/strict';
import { models } from './models/index.js';
import { create } from './orm.js';
import { seed } from './seed.js';
import { accountId, postEntry } from './models/ledger.js';
import { applyDiff, diffDb } from './sync.js';

test('Preview is available for posted customer invoices and credit notes', () => {
  const action = models['account.move'].form.buttons.find((button) => button.label === 'Preview');
  for (const move_type of ['out_invoice', 'out_refund', 'out_receipt', 'in_invoice', 'in_refund', 'entry']) {
    for (const state of ['draft', 'posted', 'cancel']) {
      const move = { id: 42, move_type, state };
      assert.equal(action.when(move), state === 'posted' && ['out_invoice', 'out_refund'].includes(move_type));
    }
  }
  const db = { records: { 'account.move': [{ id: 42, state: 'posted', move_type: 'out_invoice' }] } };
  assert.deepEqual(action.run(db, { id: 42 }), { db, go: '#/print/account.move/42?report=preview' });
});

test('move validation messages survive synchronization', () => {
  const db = seed();
  const debit = accountId(db, '101401', 1);
  const credit = accountId(db, '400000', 1);
  const force = (snapshot, id, changes) => ({ ...snapshot, records: { ...snapshot.records, 'account.move': snapshot.records['account.move'].map((move) => move.id === id ? { ...move, ...changes } : move) } });
  for (const [lines, message] of [
    [[], "Even magicians can't post nothing!"],
    [[{ account_id: debit, debit: 10 }, { account_id: credit, credit: 5 }], 'The entry is not balanced.'],
    [[{ account_id: debit, debit: 10, amount_currency: -10 }, { account_id: credit, credit: 10 }], 'The amount expressed in the secondary currency must be positive when account is debited and negative when account is credited. If the currency is the same as the one from the company, this amount must strictly be equal to the balance.'],
  ]) {
    const draft = create(db, 'account.move', { move_type: 'entry', date: '2026-01-01', line_ids: lines });
    const forged = force(draft.db, draft.id, { state: 'posted', name: 'MISC/2026/0001' });
    assert.throws(() => applyDiff(draft.db, diffDb(draft.db, forged), { isAdmin: true }), (err) => err.message === message);
  }
  const posted = postEntry(db, { journal: 'MISC', date: '2026-01-01', lines: [{ account_id: debit, debit: 10 }, { account_id: credit, credit: 10 }] });
  const removed = { ...posted.db, records: { ...posted.db.records, 'account.move': posted.db.records['account.move'].filter((move) => move.id !== posted.id) } };
  assert.throws(() => applyDiff(posted.db, diffDb(posted.db, removed), { isAdmin: true }), (err) => err.message === 'You cannot delete an entry which has been posted once.');
});
