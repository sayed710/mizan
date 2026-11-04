import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read } from './orm.js';
import { accountId, isBalanced } from './models/ledger.js';
import { computeBoard, deferralBoard, postDueEntries } from './models/deferred.js';
import { seed } from './seed.js';

const schedule = (vals) => {
  const { db, id } = create(seed(), 'account.deferral', { name: 'Support contract', amount: 1000, start_date: '2026-01-15', months: 3, ...vals });
  return { db: computeBoard(db, read(db, 'account.deferral', id)), id };
};

test('the board splits cents evenly at month ends by largest remainder', () => {
  assert.deepEqual(deferralBoard(1000, '2026-01-15', 3), [
    { date: '2026-01-31', amount: 333.34 }, { date: '2026-02-28', amount: 333.33 }, { date: '2026-03-31', amount: 333.33 },
  ]);
  assert.equal(deferralBoard(100, '2028-02-10', 1)[0].date, '2028-02-29');
  assert.equal(deferralBoard(120, '2026-11-01', 3).at(-1).date, '2027-01-31');
});

test('only due lines are posted, each balanced, and the schedule ends when all are posted', () => {
  const { db, id } = schedule({});
  const partly = postDueEntries(db, read(db, 'account.deferral', id), '2026-02-28');
  const d = read(partly, 'account.deferral', id);
  assert.deepEqual(d.board.map((l) => l.posted), [true, true, false]);
  assert.equal(d.state, 'running');
  const moves = d.board.filter((l) => l.posted).map((l) => read(partly, 'account.move', l.move_id));
  assert.ok(moves.every((m) => isBalanced(m.line_ids)));
  assert.equal(moves[0].line_ids.find((l) => l.debit).account_id, accountId(partly, '212000'));
  const done = postDueEntries(partly, d, '2026-12-31');
  assert.equal(read(done, 'account.deferral', id).state, 'done');
});

test('expense schedules recognise the expense against prepaid expenses', () => {
  const { db, id } = schedule({ kind: 'expense' });
  const posted = postDueEntries(db, read(db, 'account.deferral', id), '2026-01-31');
  const move = read(posted, 'account.move', read(posted, 'account.deferral', id).board[0].move_id);
  assert.equal(move.line_ids.find((l) => l.debit).account_id, accountId(posted, '600000'));
  assert.equal(move.line_ids.find((l) => l.credit).account_id, accountId(posted, '132000'));
});

test('invalid amounts and periods are refused', () => {
  assert.throws(() => schedule({ amount: 0 }), /positive/);
  assert.throws(() => schedule({ months: 0 }), /at least 1/);
  assert.throws(() => schedule({ months: 1.5 }), /at least 1/);
});
