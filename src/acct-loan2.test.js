import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { tableToRows } from './csv.js';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { accountId, postEntry } from './models/ledger.js';
import { confirmLoan, computeLoan, closeLoan, earlyRepayment, loanModels, loanSchedule, loanYearFraction, postDueLines } from './models/loans.js';
import { runScheduledJobs } from './models/scheduler.js';
import { migrate } from './migrations.js';
import { diffDb, applyDiff } from './sync.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

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
      'Close Loan is only available for loans with scheduled liability accounts',
      'Legacy loans cannot be closed with unpaid instalments',
      'Cannot close a loan before a posted entry',
    ]) {
      assert.notEqual(tAr(label), label, `${label} must translate to Arabic`);
    }
  } finally {
    if (prevStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = prevStorage;
  }
});

function legacyLoan(db = seed(), overrides = {}) {
  return create(db, 'account.loan', {
    name: 'Legacy loan', amount: 1200, duration: 12, interest_rate: 6, method: 'linear', start_date: '2025-01-01',
    journal_id: search(db, 'account.journal').find((j) => j.code === 'BNK1').id,
    bank_account_id: accountId(db, '101401'),
    principal_account_id: accountId(db, '260000'),
    interest_account_id: accountId(db, '690400'),
    ...overrides,
  });
}

test('Finding 2: legacy loans cannot use Close Loan or close with unpaid instalments', () => {
  const { db, id } = legacyLoan();
  const confirmed = confirmLoan(db, read(db, 'account.loan', id));
  const running = read(confirmed, 'account.loan', id);
  const closeBtn = loanModels['account.loan'].form.buttons.find((b) => b.label === 'Close Loan');
  assert.equal(closeBtn.when(running), false);
  assert.throws(() => closeLoan(confirmed, running, '2025-03-01'), /scheduled liability accounts/);
  assert.throws(() => write(confirmed, 'account.loan', id, { state: 'closed' }), /unpaid instalments/);
  const settled = earlyRepayment(confirmed, running, { date: '2025-02-01', amount: running.outstanding_balance });
  assert.equal(read(settled, 'account.loan', id).state, 'closed');
});

test('Finding 3: running and closed modern loans lock lender, interest rate, method and total interest', () => {
  const { db, id } = modernLoan();
  const withLender = write(db, 'account.loan', id, { lender_id: 1 });
  const confirmed = confirmLoan(withLender, read(withLender, 'account.loan', id));
  const running = read(confirmed, 'account.loan', id);
  assert.equal(loanModels['account.loan'].fields.lender_id.readonly({ state: 'draft' }), false);
  assert.equal(loanModels['account.loan'].fields.lender_id.readonly(running), true);
  assert.throws(() => write(confirmed, 'account.loan', id, { lender_id: 2 }), /running loan/);
  assert.throws(() => write(confirmed, 'account.loan', id, { interest_rate: 9 }), /running loan/);
  assert.throws(() => write(confirmed, 'account.loan', id, { method: 'annuity' }), /running loan/);
  assert.throws(() => write(confirmed, 'account.loan', id, { interest: 99 }), /running loan/);
  const closed = closeLoan(confirmed, running, '2040-01-15');
  assert.throws(() => write(closed, 'account.loan', id, { lender_id: 2 }), /running loan/);
  assert.throws(() => write(closed, 'account.loan', id, { interest_rate: 9 }), /running loan/);
  assert.throws(() => write(closed, 'account.loan', id, { method: 'annuity' }), /running loan/);
  assert.throws(() => write(closed, 'account.loan', id, { interest: 99 }), /running loan/);
});

test('Finding 4: closeLoan and guard reject closing before a posted instalment or move', () => {
  const { db, id } = modernLoan();
  const confirmed = confirmLoan(db, read(db, 'account.loan', id));
  const posted = postDueLines(confirmed, read(confirmed, 'account.loan', id), '2040-03-31');
  const running = read(posted, 'account.loan', id);
  assert.throws(() => closeLoan(posted, running, '2040-03-01'), /before a posted entry/);
  // Direct write with future drafts manually cancelled also fails when a posted move exists after close_date.
  let cancelledFuture = posted;
  for (const line of running.line_ids.filter((l) => l.date > '2040-03-01')) {
    for (const moveId of line.generated_move_ids) {
      const m = read(cancelledFuture, 'account.move', moveId);
      if (m?.state === 'draft') cancelledFuture = write(cancelledFuture, 'account.move', moveId, { state: 'cancel', auto_post: 'no' });
    }
  }
  assert.throws(() => write(cancelledFuture, 'account.loan', id, { state: 'closed', close_date: '2040-03-01' }), /before a posted entry/);
});

test('Finding 5: skipped instalments reduce outstanding_balance and LoansAnalysis balance to zero at closure', async () => {
  let db = seed();
  const short = create(db, 'account.account', { code: '260102', name: 'Current loan liability 2', account_type: 'liability_current', company_id: 1 });
  db = short.db;
  const created = create(db, 'account.loan', {
    name: 'Midlife loan', lender_id: 1, amount: 2400, duration: 24, interest_rate: 12, method: 'linear',
    start_date: '2024-01-01', skip_until_date: '2024-04-01',
    journal_id: search(db, 'account.journal').find((j) => j.code === 'BNK1').id,
    bank_account_id: accountId(db, '101401'),
    long_term_account_id: accountId(db, '260000'),
    short_term_account_id: short.id,
    expense_account_id: accountId(db, '690400'),
  });
  db = created.db;
  const confirmed = confirmLoan(db, read(db, 'account.loan', created.id));
  const atStart = read(confirmed, 'account.loan', created.id);
  const skippedPrincipal = atStart.line_ids.slice(0, 2).reduce((s, l) => s + l.principal, 0);
  assert.equal(atStart.outstanding_balance, 2400 - skippedPrincipal);

  const closedDb = postDueLines(confirmed, atStart, '2026-12-31');
  const closedLoan = read(closedDb, 'account.loan', created.id);
  assert.equal(closedLoan.state, 'closed');
  assert.equal(closedLoan.outstanding_balance, 0);

  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const store = await import('./store.js');
  await store.initStore();
  await React.act(async () => store.commit(closedDb));
  const { LoansAnalysis } = await import('./views/LoansAnalysis.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(LoansAnalysis)));
    const rows = tableToRows(find(host, (n) => n.tagName === 'TABLE'));
    const row = rows.find((r) => r[0] === 'Midlife loan');
    assert.ok(row, 'Midlife loan appears in LoansAnalysis');
    assert.equal(row[2], '$2,400.00');
    assert.equal(row[3], '$2,400.00');
    assert.equal(row[4], `$${closedLoan.total_interest.toFixed(2)}`);
    assert.equal(row[5], '$0.00');
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('Finding 6: loanYearFraction A/A AFB preserves Feb-29 anniversaries across multiple years', () => {
  assert.equal(loanYearFraction('2020-02-29', '2024-02-29', 'A/A AFB'), 4);
  assert.equal(loanYearFraction('2020-02-29', '2028-02-29', 'A/A AFB'), 8);
  assert.equal(loanYearFraction('2020-02-29', '2021-02-28', 'A/A AFB'), 365 / 366);
  assert.equal(loanYearFraction('2020-02-29', '2024-05-01', 'A/A AFB'), 4 + 62 / 366);
});

test('Finding 7: confirmation guard rejects generated moves with extra balanced accounting lines', () => {
  const { db, id } = modernLoan();
  const computed = computeLoan(db, read(db, 'account.loan', id), {
    loan_amount: 200, loan_term: 2, interest_rate: 0, start_date: '2040-01-01',
    first_payment_date: '2040-02-29', payment_end_of_month: 'end_of_month', compounding_method: '30A/360',
  });
  const confirmed = confirmLoan(computed, read(computed, 'account.loan', id));
  const confirmedLoan = read(confirmed, 'account.loan', id);
  const firstPaymentMoveId = confirmedLoan.line_ids[0].move_id;
  const firstPaymentMove = read(confirmed, 'account.move', firstPaymentMoveId);
  const extraDebitAcc = accountId(confirmed, '600000');
  const extraCreditAcc = accountId(confirmed, '400000');
  const tamperedPayment = postEntry(db, {
    journal: confirmedLoan.journal_id, company: confirmedLoan.company_id, date: firstPaymentMove.date, state: 'draft',
    lines: [
      ...firstPaymentMove.line_ids.map((l) => ({ account_id: l.account_id, debit: l.debit, credit: l.credit })),
      { account_id: extraDebitAcc, debit: 50 },
      { account_id: extraCreditAcc, credit: 50 },
    ],
  });
  const line0 = { ...confirmedLoan.line_ids[0], move_id: tamperedPayment.id, generated_move_ids: [
    ...confirmedLoan.line_ids[0].generated_move_ids.filter((mId) => mId !== firstPaymentMoveId),
    tamperedPayment.id,
  ] };
  const seededMoves = confirmed.records['account.move'].filter((m) => m.id !== firstPaymentMoveId);
  const prepDb = { ...tamperedPayment.db, records: { ...tamperedPayment.db.records, 'account.move': [...seededMoves, read(tamperedPayment.db, 'account.move', tamperedPayment.id)] } };
  assert.throws(() => write(prepDb, 'account.loan', id, {
    state: 'running',
    line_ids: [line0, confirmedLoan.line_ids[1]],
  }), /Generated loan entries do not match the schedule/);

  const reclassId = confirmedLoan.line_ids[0].generated_move_ids.find((mId) => mId !== firstPaymentMoveId);
  const reclassMove = read(confirmed, 'account.move', reclassId);
  const tamperedReclass = postEntry(db, {
    journal: confirmedLoan.journal_id, company: confirmedLoan.company_id, date: reclassMove.date, state: 'draft',
    lines: [
      ...reclassMove.line_ids.map((l) => ({ account_id: l.account_id, debit: l.debit, credit: l.credit })),
      { account_id: extraDebitAcc, debit: 50 },
      { account_id: extraCreditAcc, credit: 50 },
    ],
  });
  const line0Reclass = { ...confirmedLoan.line_ids[0], generated_move_ids: [tamperedReclass.id, firstPaymentMoveId] };
  const prepReclassDb = { ...tamperedReclass.db, records: { ...tamperedReclass.db.records, 'account.move': [...confirmed.records['account.move'].filter((m) => m.id !== reclassId), read(tamperedReclass.db, 'account.move', tamperedReclass.id)] } };
  assert.throws(() => write(prepReclassDb, 'account.loan', id, {
    state: 'running',
    line_ids: [line0Reclass, confirmedLoan.line_ids[1]],
  }), /Generated loan entries do not match the schedule/);
});

test('Finding 8: migration 85 backfills missing interest totals without overwriting existing totals', () => {
  const { db, id } = legacyLoan();
  const legacy = {
    ...db,
    schema_version: 84,
    records: {
      ...db.records,
      'account.loan': [
        {
          ...read(db, 'account.loan', id),
          state: 'running',
          line_ids: [
            { date: '2025-02-28', principal: 600, interest: 6, payment: 606, outstanding: 600, posted: false, move_id: null },
            { date: '2025-03-31', principal: 600, interest: 3, payment: 603, outstanding: 0, posted: false, move_id: null },
          ],
          duration: 2,
        },
        {
          ...read(db, 'account.loan', id),
          id: id + 1,
          interest: 12,
          state: 'running',
          line_ids: [
            { date: '2025-02-28', principal: 600, interest: 6, payment: 606, outstanding: 600, posted: false, move_id: null },
            { date: '2025-03-31', principal: 600, interest: 3, payment: 603, outstanding: 0, posted: false, move_id: null },
          ],
          duration: 2,
        },
      ],
    },
  };
  const migrated = migrate(legacy);
  const backfilled = migrated.records['account.loan'][0];
  assert.equal(backfilled.interest, 9);
  assert.equal(backfilled.interest_difference, 0);
  assert.equal(loanModels['account.loan'].form.warning(backfilled), '');
  assert.equal(migrated.records['account.loan'][1].interest, 12);
});

test('Finding 9: confirming a legacy loan preserves its Compute wizard schedule', () => {
  const { db, id } = legacyLoan();
  const computed = computeLoan(db, read(db, 'account.loan', id), {
    loan_amount: 1200, loan_term: 3, interest_rate: 12, start_date: '2025-01-15',
    first_payment_date: '2025-02-15', payment_end_of_month: 'at_anniversary', compounding_method: 'A/365F',
  });
  const beforeConfirm = read(computed, 'account.loan', id);
  const confirmed = confirmLoan(computed, beforeConfirm);
  const running = read(confirmed, 'account.loan', id);
  assert.equal(running.state, 'running');
  assert.ok(running.receipt_move_id);
  assert.deepEqual(running.line_ids.map((l) => l.date), beforeConfirm.line_ids.map((l) => l.date));
  assert.deepEqual(running.line_ids.map((l) => l.interest), beforeConfirm.line_ids.map((l) => l.interest));
  assert.equal(running.interest_difference, 0);
  assert.equal(loanModels['account.loan'].form.warning(running), '');
});

test('two same-date same-amount instalments confirm and post distinct payments, while guard rejects shared generated moves', () => {
  const { db, id } = modernLoan();
  const sameDateLines = [
    { date: '2040-02-29', principal: 100, interest: 5, payment: 105, outstanding: 100, posted: false, move_id: null },
    { date: '2040-02-29', principal: 100, interest: 5, payment: 105, outstanding: 0, posted: false, move_id: null },
  ];
  const draftDb = write(db, 'account.loan', id, { amount: 200, duration: 2, interest: 10, interest_rate: 0, line_ids: sameDateLines });
  const confirmed = confirmLoan(draftDb, read(draftDb, 'account.loan', id));
  const running = read(confirmed, 'account.loan', id);
  assert.equal(running.state, 'running');
  assert.notEqual(running.line_ids[0].move_id, running.line_ids[1].move_id);
  const allMoveIds = running.line_ids.flatMap((line) => line.generated_move_ids);
  assert.equal(new Set(allMoveIds).size, allMoveIds.length);
  assert.doesNotThrow(() => applyDiff(draftDb, diffDb(draftDb, confirmed)));

  const closedDb = postDueLines(confirmed, running, '2040-02-29');
  const closedLoan = read(closedDb, 'account.loan', id);
  assert.equal(closedLoan.state, 'closed');
  assert.equal(closedLoan.outstanding_balance, 0);
  assert.deepEqual(closedLoan.line_ids.map((line) => line.posted), [true, true]);
  assert.ok(allMoveIds.every((moveId) => read(closedDb, 'account.move', moveId).state === 'posted'));
  assert.doesNotThrow(() => applyDiff(confirmed, diffDb(confirmed, closedDb)));

  // Guard boundary: sharing a payment move across two same-date/same-amount instalments is rejected.
  const sharedMoveId = running.line_ids[0].move_id;
  const prepDb = {
    ...confirmed,
    records: {
      ...confirmed.records,
      'account.loan': confirmed.records['account.loan'].map((loan) => (
        loan.id === id ? { ...read(draftDb, 'account.loan', id), state: 'draft' } : loan
      )),
    },
  };
  assert.throws(() => write(prepDb, 'account.loan', id, {
    state: 'running',
    line_ids: [
      running.line_ids[0],
      { ...running.line_ids[1], move_id: sharedMoveId, generated_move_ids: [sharedMoveId] },
    ],
  }), /Generated loan entries do not match the schedule/);

  // Guard boundary: confirming with an already-posted instalment flag while moves are draft is rejected.
  assert.throws(() => write(prepDb, 'account.loan', id, {
    state: 'running',
    line_ids: [
      { ...running.line_ids[0], posted: true },
      running.line_ids[1],
    ],
  }), /Generated loan entries do not match the schedule/);

  // Guard boundary: another loan cannot reuse the first loan's generated move.
  const second = create(confirmed, 'account.loan', {
    ...read(draftDb, 'account.loan', id),
    name: 'Second modern loan',
  });
  assert.throws(() => write(second.db, 'account.loan', second.id, {
    state: 'running',
    line_ids: running.line_ids,
  }), /Generated loan entries do not match the schedule/);

  // Supported skip_until_date and legacy same-date/same-amount behaviour remain intact.
  const skipLines = [
    { date: '2040-01-31', principal: 100, interest: 5, payment: 105, outstanding: 200, posted: false, move_id: null },
    { date: '2040-02-29', principal: 100, interest: 5, payment: 105, outstanding: 100, posted: false, move_id: null },
    { date: '2040-02-29', principal: 100, interest: 5, payment: 105, outstanding: 0, posted: false, move_id: null },
  ];
  const skipDraft = write(db, 'account.loan', id, { amount: 300, duration: 3, interest: 15, interest_rate: 0, skip_until_date: '2040-02-01', line_ids: skipLines });
  const skipConfirmed = confirmLoan(skipDraft, read(skipDraft, 'account.loan', id));
  const skipRunning = read(skipConfirmed, 'account.loan', id);
  assert.deepEqual(skipRunning.line_ids[0].generated_move_ids, []);
  assert.equal(skipRunning.line_ids[0].move_id, null);
  assert.notEqual(skipRunning.line_ids[1].move_id, skipRunning.line_ids[2].move_id);

  const legacy = legacyLoan(db, {
    amount: 200,
    duration: 2,
    interest: 10,
    interest_rate: 0,
    line_ids: sameDateLines,
  });
  const legacyRunning = confirmLoan(legacy.db, read(legacy.db, 'account.loan', legacy.id));
  const legacyClosed = postDueLines(legacyRunning, read(legacyRunning, 'account.loan', legacy.id), '2040-02-29');
  const legacyLoanRec = read(legacyClosed, 'account.loan', legacy.id);
  assert.equal(legacyLoanRec.state, 'closed');
  assert.notEqual(legacyLoanRec.line_ids[0].move_id, legacyLoanRec.line_ids[1].move_id);
});
