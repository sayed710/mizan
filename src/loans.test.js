import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from './orm.js';
import { accountId, isBalanced } from './models/ledger.js';
import { amortization, confirmLoan, earlyRepayment, loanModels, postDueLines } from './models/loans.js';
import { seed } from './seed.js';

const newLoan = (vals) => {
  const { db, id } = create(seed(), 'account.loan', { name: 'Expansion loan', lender_id: 2, amount: 1200, start_date: '2026-01-10', duration: 6, interest_rate: 5, method: 'annuity', ...vals });
  return { db, id };
};

const button = (label) => loanModels['account.loan'].form.buttons.find((b) => b.label === label);

test('annuity payments are equal except the cent-adjusted last one, and principals sum to the amount', () => {
  const board = amortization({ amount: 12000, start_date: '2026-01-15', duration: 12, interest_rate: 5, method: 'annuity' });
  assert.equal(board.length, 12);
  assert.equal(board[0].date, '2026-02-28');
  assert.deepEqual([board.at(-2).date, board.at(-1).date], ['2026-12-31', '2027-01-31']);
  assert.ok(board.slice(0, -1).every((l) => l.payment === board[0].payment));
  assert.equal(Math.round(board.reduce((s, l) => s + l.principal, 0) * 100), 1200000);
  assert.equal(board.at(-1).outstanding, 0);
});

test('a zero rate charges no interest', () => {
  const board = amortization({ amount: 1000, start_date: '2026-01-31', duration: 4, interest_rate: 0, method: 'annuity' });
  assert.deepEqual(board.map((l) => [l.principal, l.interest, l.payment, l.outstanding]), [
    [250, 0, 250, 750], [250, 0, 250, 500], [250, 0, 250, 250], [250, 0, 250, 0],
  ]);
});

test('the linear method keeps principals equal while interest falls with the balance', () => {
  const board = amortization({ amount: 1200, start_date: '2026-03-10', duration: 6, interest_rate: 6, method: 'linear' });
  assert.equal(board[0].date, '2026-04-30');
  assert.deepEqual(board.map((l) => [l.principal, l.interest, l.payment, l.outstanding]), [
    [200, 6, 206, 1000], [200, 5, 205, 800], [200, 4, 204, 600], [200, 3, 203, 400], [200, 2, 202, 200], [200, 1, 201, 0],
  ]);
});

test('confirming books the loan receipt on the bank and starts the schedule', () => {
  const { db, id } = newLoan({ amount: 5000, duration: 6, interest_rate: 4.5 });
  const confirmed = button('Confirm').run(db, read(db, 'account.loan', id)).db;
  const rec = read(confirmed, 'account.loan', id);
  assert.equal(rec.state, 'running');
  assert.equal(rec.line_ids.length, 6);
  assert.equal(rec.line_ids[0].date, '2026-02-28');
  assert.equal(Math.round(rec.outstanding_balance * 100), 500000);
  assert.ok(rec.total_interest > 0);
  const receipt = search(confirmed, 'account.move').find((m) => m.ref === `Loan received ${rec.name}`);
  assert.ok(isBalanced(receipt.line_ids));
  assert.equal(receipt.invoice_date, '2026-01-10');
  assert.equal(receipt.line_ids.find((l) => l.debit).account_id, accountId(confirmed, '101401'));
  assert.equal(receipt.line_ids.find((l) => l.credit).account_id, accountId(confirmed, '260000'));
  assert.equal(receipt.line_ids.find((l) => l.debit).debit, 5000);
});

test('only due lines are posted, each balanced on the loan, interest and bank accounts', () => {
  const { db, id } = newLoan({});
  const confirmed = confirmLoan(db, read(db, 'account.loan', id));
  const partly = postDueLines(confirmed, read(confirmed, 'account.loan', id), '2026-03-31');
  const rec = read(partly, 'account.loan', id);
  assert.deepEqual(rec.line_ids.map((l) => l.posted), [true, true, false, false, false, false]);
  assert.equal(rec.state, 'running');
  const paid = Math.round((rec.line_ids[0].principal + rec.line_ids[1].principal) * 100);
  assert.equal(Math.round(rec.outstanding_balance * 100), 120000 - paid);
  const move = read(partly, 'account.move', rec.line_ids[0].move_id);
  assert.ok(isBalanced(move.line_ids));
  assert.equal(move.invoice_date, '2026-02-28');
  assert.equal(move.line_ids.find((l) => l.account_id === accountId(partly, '260000')).debit, rec.line_ids[0].principal);
  assert.equal(move.line_ids.find((l) => l.account_id === accountId(partly, '690400')).debit, rec.line_ids[0].interest);
  assert.equal(move.line_ids.find((l) => l.account_id === accountId(partly, '101401')).credit, rec.line_ids[0].payment);
  assert.ok(rec.line_ids.slice(2).every((l) => !l.move_id));
});

test('the loan closes when every line is posted', () => {
  const { db, id } = newLoan({});
  const confirmed = confirmLoan(db, read(db, 'account.loan', id));
  const done = postDueLines(confirmed, read(confirmed, 'account.loan', id), '2026-12-31');
  const rec = read(done, 'account.loan', id);
  assert.equal(rec.state, 'closed');
  assert.equal(rec.outstanding_balance, 0);
  assert.ok(rec.line_ids.every((l) => l.posted && l.move_id && isBalanced(read(done, 'account.move', l.move_id).line_ids)));
});

test('an early repayment lowers the remaining instalments; over-repayment is refused', () => {
  const { db, id } = newLoan({});
  const confirmed = confirmLoan(db, read(db, 'account.loan', id));
  const partly = postDueLines(confirmed, read(confirmed, 'account.loan', id), '2026-02-28');
  const before = read(partly, 'account.loan', id);
  const paid = earlyRepayment(partly, before, { date: '2026-03-05', amount: 300 });
  const after = read(paid, 'account.loan', id);
  const pending = after.line_ids.filter((l) => !l.posted);
  assert.equal(pending.length, 5);
  const original = amortization(before);
  assert.ok(pending.every((l, i) => l.payment < original[i + 1].payment));
  assert.equal(Math.round(pending.reduce((s, l) => s + l.principal, 0) * 100), Math.round((before.outstanding_balance - 300) * 100));
  assert.equal(after.line_ids.at(-1).outstanding, 0);
  assert.equal(after.state, 'running');
  const extra = search(paid, 'account.move').find((m) => m.ref === `Early repayment ${after.name}`);
  assert.ok(isBalanced(extra.line_ids));
  assert.equal(extra.line_ids.find((l) => l.debit).account_id, accountId(paid, '260000'));
  assert.equal(extra.line_ids.find((l) => l.credit).account_id, accountId(paid, '101401'));
  assert.throws(() => earlyRepayment(paid, after, { date: '2026-03-06', amount: after.outstanding_balance + 1 }), /exceed/);
});

test('repaying the whole outstanding balance closes the loan', () => {
  const { db, id } = newLoan({});
  const confirmed = confirmLoan(db, read(db, 'account.loan', id));
  const partly = postDueLines(confirmed, read(confirmed, 'account.loan', id), '2026-02-28');
  const running = read(partly, 'account.loan', id);
  const done = read(earlyRepayment(partly, running, { date: '2026-03-05', amount: running.outstanding_balance }), 'account.loan', id);
  assert.equal(done.state, 'closed');
  assert.equal(done.line_ids.length, 1);
  assert.equal(done.outstanding_balance, 0);
  assert.ok(done.line_ids.every((l) => l.posted));
});

test('invalid amounts, durations, rates and dates are refused', () => {
  const attempt = (vals) => () => {
    const { db, id } = newLoan(vals);
    confirmLoan(db, read(db, 'account.loan', id));
  };
  assert.throws(attempt({ amount: 0 }), /positive/);
  assert.throws(attempt({ amount: -5 }), /positive/);
  assert.throws(attempt({ duration: 0 }), /at least 1/);
  assert.throws(attempt({ duration: 2.5 }), /at least 1/);
  assert.throws(attempt({ interest_rate: -1 }), /negative/);
  assert.throws(attempt({ start_date: null }), /start date/);
});

test('a draft schedule can be previewed without confirming', () => {
  const { db, id } = newLoan({});
  const before = search(db, 'account.move').length;
  const preview = button('Compute Board').run(db, read(db, 'account.loan', id)).db;
  const rec = read(preview, 'account.loan', id);
  assert.equal(rec.state, 'draft');
  assert.equal(rec.line_ids.length, 6);
  assert.ok(rec.line_ids.every((l) => !l.posted && !l.move_id));
  assert.equal(search(preview, 'account.move').length, before);
});
