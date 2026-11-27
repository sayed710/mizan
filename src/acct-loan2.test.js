import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { accountId } from './models/ledger.js';
import { confirmLoan, computeLoan, closeLoan, loanModels, loanSchedule, postDueLines } from './models/loans.js';
import { runScheduledJobs } from './models/scheduler.js';
import { migrate } from './migrations.js';
import { diffDb, applyDiff } from './sync.js';

const methods = {
  '30A/360': [11.6, 8.53, 4], '30U/360': [11.6, 8, 4], '30E/360': [11.6, 8.27, 4],
  '30E/360 ISDA': [12, 8, 4], 'A/360': [11.6, 8.27, 4], 'A/365F': [11.44, 8.15, 3.95],
  'A/A ISDA': [11.41, 8.13, 3.93], 'A/A AFB': [11.44, 8.13, 3.95],
};

for (const [method, interest] of Object.entries(methods)) {
  test(`loan schedule uses ${method}`, () => {
    const lines = loanSchedule({ amount: 1200, duration: 3, interest_rate: 12, start_date: '2024-01-31', method: 'linear' },
      { first_payment_date: '2024-02-29', payment_end_of_month: 'end_of_month', compounding_method: method });
    assert.deepEqual(lines.map((line) => line.interest), interest);
    assert.equal(lines.reduce((sum, line) => sum + line.principal, 0), 1200);
  });
}

test('compute wizard preserves annuity/linear default, previews schedule, and warns on header differences', () => {
  const { db, id } = modernLoan();
  const baseLoan = { ...read(db, 'account.loan', id), amount: 1200, duration: 3, interest_rate: 12, method: 'annuity' };
  const defaultLines = loanSchedule(baseLoan);
  assert.equal(defaultLines.length, 3);
  assert.equal(defaultLines[0].interest, 12);
  assert.equal(Math.round(defaultLines.reduce((sum, line) => sum + line.principal, 0) * 100), 120000);

  const computeBtn = loanModels['account.loan'].form.buttons.find((b) => b.label === 'Compute');
  const spec = computeBtn.wizard(db, read(db, 'account.loan', id));
  const previewField = spec.fields.find((f) => f.name === 'preview');
  const previewText = previewField.compute({
    loan_amount: 1200, interest_rate: 12, loan_term: 3, start_date: '2024-01-31',
    first_payment_date: '2024-02-29', payment_end_of_month: 'end_of_month', compounding_method: '30U/360',
  });
  assert.match(previewText, /2024-02-29:/);
  assert.match(previewText, /2024-04-30:/);

  const boardBtn = loanModels['account.loan'].form.buttons.find((b) => b.label === 'Compute Board');
  const boarded = boardBtn.run(db, { ...read(db, 'account.loan', id), interest_rate: 6 }).db;
  const boardedLoan = read(boarded, 'account.loan', id);
  assert.equal(boardedLoan.interest_difference, 0);
  assert.equal(loanModels['account.loan'].form.warning(boardedLoan), '');

  const mismatch = write(boarded, 'account.loan', id, { amount: 2500 });
  const mismatchedLoan = read(mismatch, 'account.loan', id);
  assert.equal(mismatchedLoan.amount_borrowed_difference, 100);
  assert.ok(loanModels['account.loan'].form.warning(mismatchedLoan));

  const durationMismatch = read(write(boarded, 'account.loan', id, { duration: 12 }), 'account.loan', id);
  assert.equal(durationMismatch.duration_difference, -12);
  assert.ok(loanModels['account.loan'].form.warning(durationMismatch));

  const interestMismatch = read(write(boarded, 'account.loan', id, { interest: boardedLoan.interest + 15 }), 'account.loan', id);
  assert.equal(interestMismatch.interest_difference, 15);
  assert.ok(loanModels['account.loan'].form.warning(interestMismatch));
});

function modernLoan() {
  let db = seed();
  const short = create(db, 'account.account', { code: '260101', name: 'Current loan liability', account_type: 'liability_current', company_id: 1 });
  db = short.db;
  return create(db, 'account.loan', { name: 'Modern loan', amount: 2400, duration: 24, interest_rate: 0, method: 'linear', start_date: '2040-01-01',
    journal_id: search(db, 'account.journal').find((j) => j.code === 'BNK1').id, bank_account_id: accountId(db, '101401'),
    long_term_account_id: accountId(db, '260000'), short_term_account_id: short.id, expense_account_id: accountId(db, '690400') });
}

test('wizard schedule has anniversary dates and twelve-month theoretical balances', () => {
  const { db, id } = modernLoan();
  const values = { loan_amount: 2400, loan_term: 24, interest_rate: 0, start_date: '2040-01-01', first_payment_date: '2040-02-15', payment_end_of_month: 'at_anniversary', compounding_method: 'A/365F' };
  const result = computeLoan(db, read(db, 'account.loan', id), values);
  const loan = read(result, 'account.loan', id);
  assert.equal(loan.line_ids[0].date, '2040-02-15');
  assert.equal(loan.line_ids[0].short_term_theoretical_balance, 1200);
  assert.equal(loan.line_ids[0].long_term_theoretical_balance, 1100);
  assert.equal(loan.line_ids.at(-1).short_term_theoretical_balance, 0);
  assert.equal(loan.amount_borrowed_difference, 0);
});

test('confirmation generates balanced draft entries, skips early lines, and posts due entries', () => {
  const { db, id } = modernLoan();
  const loan = { ...read(db, 'account.loan', id), skip_until_date: '2040-04-01' };
  const configured = computeLoan(db, loan, { loan_amount: 2400, loan_term: 24, interest_rate: 0, start_date: '2040-01-01', first_payment_date: '2040-02-29', payment_end_of_month: 'end_of_month', compounding_method: 'A/360' });
  const withSkip = write(configured, 'account.loan', id, { skip_until_date: '2040-04-01' });
  const confirmed = confirmLoan(withSkip, read(withSkip, 'account.loan', id));
  const lines = read(confirmed, 'account.loan', id).line_ids;
  assert.deepEqual(lines.slice(0, 2).map((l) => l.generated_move_ids), [[], []]);
  assert.equal(lines[2].generated_move_ids.length, 2);
  for (const moveId of lines[2].generated_move_ids) {
    const move = read(confirmed, 'account.move', moveId);
    assert.equal(move.state, 'draft');
    assert.equal(move.auto_post, 'at_date');
  }
  const reclass = read(confirmed, 'account.move', lines[2].generated_move_ids[0]);
  assert.equal(reclass.line_ids.find((l) => l.account_id === loan.long_term_account_id).debit, 100);
  const errors = [];
  const posted = runScheduledJobs(confirmed, '2040-04-30', { onError: (name, error) => errors.push([name, error.message]) });
  assert.deepEqual(errors, []);
  assert.equal(read(posted, 'account.loan', id).line_ids[2].posted, true);
  assert.ok(lines[2].generated_move_ids.every((moveId) => read(posted, 'account.move', moveId).state === 'posted'));
  assert.doesNotThrow(() => applyDiff(withSkip, diffDb(withSkip, confirmed)));
  assert.doesNotThrow(() => applyDiff(confirmed, diffDb(confirmed, posted)));
  assert.throws(() => write(withSkip, 'account.loan', id, { state: 'closed' }), /Only a running loan/);
  const cancelled = write(withSkip, 'account.loan', id, { state: 'cancelled' });
  assert.throws(() => write(cancelled, 'account.loan', id, { state: 'running' }), /Only a draft loan/);
  assert.throws(() => write(posted, 'account.loan', id, { long_term_account_id: loan.short_term_account_id }), /running loan/);
  assert.throws(() => write(posted, 'account.loan', id, { state: 'draft' }), /running loan/);
  const finished = postDueLines(posted, read(posted, 'account.loan', id), '2043-01-01');
  assert.equal(read(finished, 'account.loan', id).state, 'closed');
  assert.throws(() => write(finished, 'account.loan', id, { state: 'running' }), /reopened/);
});

test('close wizard cancels future drafts and preserves already posted moves', () => {
  const { db, id } = modernLoan();
  const confirmed = confirmLoan(db, read(db, 'account.loan', id));
  const posted = postDueLines(confirmed, read(confirmed, 'account.loan', id), '2040-02-29');
  const before = read(posted, 'account.loan', id);
  assert.throws(() => write(posted, 'account.loan', id, { state: 'closed', close_date: '2040-03-01' }), /cancelled/);
  const closeBtn = loanModels['account.loan'].form.buttons.find((b) => b.label === 'Close Loan');
  const closed = closeBtn.run(posted, before, { date: '2040-03-01' }).db;
  assert.equal(read(closed, 'account.loan', id).state, 'closed');
  assert.equal(read(closed, 'account.loan', id).close_date, '2040-03-01');
  assert.equal(read(closed, 'account.move', before.line_ids[0].move_id).state, 'posted');
  for (const moveId of before.line_ids[1].generated_move_ids) {
    const cancelledMove = read(closed, 'account.move', moveId);
    assert.equal(cancelledMove.state, 'cancel');
    assert.equal(cancelledMove.auto_post, 'no');
  }
  assert.equal(postDueLines(closed, read(closed, 'account.loan', id), '2045-01-01'), closed);
  assert.doesNotThrow(() => applyDiff(posted, diffDb(posted, closed), { isAdmin: true }));
  assert.equal(closeLoan(posted, before, '2040-03-01').records['account.loan'].length, closed.records['account.loan'].length);
});

test('migration preserves old loan lines and entry references', () => {
  const { db, id } = modernLoan();
  const legacy = { ...db, schema_version: 84, records: { ...db.records, 'account.loan': [
    { id, name: 'Old', state: 'running', principal_account_id: 42, line_ids: [{ date: '2020-01-31', principal: 10, posted: true, move_id: 77 }] },
    { id: id + 1, name: 'Old Cancelled', state: 'cancel', principal_account_id: 42, line_ids: [] },
  ] } };
  const result = migrate(legacy);
  assert.equal(result.schema_version, 85);
  assert.deepEqual(result.records['account.loan'][0].line_ids[0], { date: '2020-01-31', principal: 10, posted: true, move_id: 77, generated_move_ids: [77] });
  assert.equal(result.records['account.loan'][1].state, 'cancelled');
});

test('scheduler posts due loan instalments once', () => {
  const base = seed();
  const { db, id } = create(base, 'account.loan', {
    name: 'Scheduled loan', amount: 1200, duration: 6, interest_rate: 6, method: 'linear',
    start_date: '2040-01-01', journal_id: search(base, 'account.journal').find((j) => j.code === 'BNK1').id,
    bank_account_id: accountId(base, '101401'), principal_account_id: accountId(base, '260000'),
    interest_account_id: accountId(base, '690400'),
  });
  const confirmed = confirmLoan(db, read(db, 'account.loan', id));
  const posted = runScheduledJobs(confirmed, '2040-02-29');
  const loan = read(posted, 'account.loan', id);
  assert.deepEqual(loan.line_ids.map((line) => line.posted), [true, false, false, false, false, false]);
  assert.equal(read(posted, 'account.move', loan.line_ids[0].move_id).state, 'posted');
  const again = runScheduledJobs(posted, '2040-02-29');
  assert.equal(read(again, 'account.loan', id).line_ids[0].move_id, loan.line_ids[0].move_id);
});

test('loan2 labels and messages have Arabic translations', async () => {
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => 'ar', setItem: () => {} };
  try {
    const { t: tAr } = await import(`./i18n.js?loan2_ar=${Date.now()}`);
    for (const label of [
      'Compute Loan', 'Loan Amount', 'Loan Term (months)', 'First Payment Date', 'Payment Timing',
      'End of Month', 'At Anniversary', 'Day-count Method', 'Long-term Liability Account',
      'Short-term Liability Account', 'Long-term Theoretical Balance', 'Short-term Theoretical Balance',
      'Skip Until Date', 'Close Loan', 'Principal Difference', 'Interest Difference', 'Duration Difference',
      'Only a draft loan can be confirmed', 'Only a draft loan can be computed', 'Only a running loan can be closed',
      'Set a closing date', 'First payment date must follow the start date', 'Payment dates must follow the start date',
      'Select a valid day-count method', 'A generated loan entry is missing or cancelled',
      'Cannot change a running loan schedule or accounts', 'A closed loan cannot be reopened',
      'Future draft loan entries must be cancelled when closing', 'Loan schedule differs from the loan totals',
      'Generated Entries', 'Loan liability accounts must be different', 'Generated loan entries do not match the schedule',
    ]) {
      assert.notEqual(tAr(label), label, `${label} must translate to Arabic`);
    }
  } finally {
    if (prevStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = prevStorage;
  }
});
