import { test } from 'node:test';
import assert from 'node:assert/strict';
import { models } from './models/index.js';
import { postMove } from './models/accounting.js';
import { create, search } from './orm.js';
import { seed } from './seed.js';
import { CURRENCY_AMOUNT_SIGN_ERROR, accountId, journalId, postEntry } from './models/ledger.js';
import { companyCurrencyRecord } from './money.js';
import { applyDiff, diffDb } from './sync.js';

test('Preview is available for customer invoices and credit notes', () => {
  const previewButtons = models['account.move'].form.buttons.filter((button) => button.label === 'Preview');
  assert.equal(previewButtons.length, 1);
  const [action] = previewButtons;
  assert.equal(action.name, 'preview_invoice');
  for (const move_type of ['out_invoice', 'out_refund', 'out_receipt', 'in_invoice', 'in_refund', 'entry']) {
    for (const state of ['draft', 'posted', 'cancel']) {
      const move = { id: 42, move_type, state };
      assert.equal(action.when(move), ['out_invoice', 'out_refund'].includes(move_type));
    }
  }
  const db = { records: { 'account.move': [{ id: 42, state: 'posted', move_type: 'out_invoice' }] } };
  assert.deepEqual(action.run(db, { id: 42, move_type: 'out_invoice' }), { db, go: '#/preview/account.move/42' });
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

test('company-currency amount_currency must strictly equal the line balance on posting and posted-move validation', () => {
  const db = seed();
  const debit = accountId(db, '101401', 1);
  const credit = accountId(db, '400000', 1);
  const misc = journalId(db, 'MISC', 1);
  const companyCurr = companyCurrencyRecord(db, 1);
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  const force = (snapshot, id, changes) => ({ ...snapshot, records: { ...snapshot.records, 'account.move': snapshot.records['account.move'].map((move) => move.id === id ? { ...move, ...changes } : move) } });

  for (const line of [
    { account_id: debit, debit: 100, credit: 0, amount_currency: 3 },
    { account_id: debit, debit: 100, credit: 0, currency_id: companyCurr.id, amount_currency: 3 },
    { account_id: debit, debit: 100, credit: 0, currency_id: companyCurr.id, amount_currency: 0 },
  ]) {
    const draft = create(db, 'account.move', {
      move_type: 'entry',
      journal_id: misc,
      date: '2026-01-01',
      line_ids: [line, { account_id: credit, debit: 0, credit: 100 }],
    });
    assert.throws(() => postMove(draft.db, draft.id), (err) => err.message === CURRENCY_AMOUNT_SIGN_ERROR);
    const forged = force(draft.db, draft.id, { state: 'posted', name: 'MISC/2026/0002' });
    assert.throws(() => applyDiff(draft.db, diffDb(draft.db, forged), { isAdmin: true }), (err) => err.message === CURRENCY_AMOUNT_SIGN_ERROR);
  }

  assert.throws(() => postEntry(db, {
    journal: 'MISC',
    date: '2026-01-01',
    lines: [
      { account_id: debit, debit: 100, amount_currency: 3 },
      { account_id: credit, credit: 100 },
    ],
  }), (err) => err.message === CURRENCY_AMOUNT_SIGN_ERROR);

  for (const validLine of [
    { account_id: debit, debit: 100, credit: 0, amount_currency: 100 },
    { account_id: debit, debit: 100, credit: 0, currency_id: companyCurr.id, amount_currency: 100 },
    { account_id: debit, debit: 100, credit: 0, currency_id: null, amount_currency: 0 },
    { account_id: debit, debit: 100, credit: 0, currency_id: eur.id, amount_currency: 0 },
  ]) {
    const draft = create(db, 'account.move', {
      move_type: 'entry',
      journal_id: misc,
      date: '2026-01-01',
      line_ids: [validLine, { account_id: credit, debit: 0, credit: 100 }],
    });
    assert.doesNotThrow(() => postMove(draft.db, draft.id));
  }

  const revalued = models['account.move'].onchange({
    move_type: 'entry',
    journal_id: misc,
    date: '2026-01-02',
    state: 'draft',
    line_ids: [
      { account_id: debit, debit: 100, credit: 0, currency_id: companyCurr.id, amount_currency: 100 },
      { account_id: credit, debit: 0, credit: 100 },
    ],
  }, 'date', db);
  assert.equal(revalued.line_ids[0].amount_currency, 100);

  const editedLine = models['account.move'].fields.line_ids.onchange(
    { account_id: debit, debit: 150, credit: 0, currency_id: companyCurr.id, amount_currency: 100 },
    'debit',
    db,
    { move_type: 'entry', company_id: 1, date: '2026-01-02' },
  );
  assert.equal(editedLine.amount_currency, 150);
});
