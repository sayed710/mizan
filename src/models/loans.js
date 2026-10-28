// Loans: borrowings repaid by monthly instalments (annuity or fixed principal), posted as they fall due.
import { read, write } from '../orm.js';
import { promptedAmount, today } from './common.js';
import { postEntry } from './ledger.js';

const cents = (n) => Math.round((Number(n) || 0) * 100);
const monthEnd = (y, m) => `${y}-${String(m).padStart(2, '0')}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;

/** @throws a user-readable message when the loan cannot be scheduled. */
function check(loan) {
  if (!(Number(loan.amount) > 0)) throw new Error('The amount must be positive');
  if (!Number.isInteger(Number(loan.duration)) || Number(loan.duration) < 1) throw new Error('The duration must be at least 1 month');
  if (!(Number(loan.interest_rate) >= 0)) throw new Error('The interest rate cannot be negative');
  if (!loan.start_date) throw new Error('Set a start date');
}

/**
 * Instalments in integer cents for an opening balance over `months` whole months.
 * Interest accrues on the outstanding balance; the last line absorbs rounding so
 * the principals sum to the opening balance and end at exactly zero.
 */
function instalments(opening, months, rate, method) {
  const annuity = rate ? Math.round((opening * rate) / (1 - (1 + rate) ** -months)) : Math.round(opening / months);
  let outstanding = opening;
  return Array.from({ length: months }, (_, i) => {
    const interest = Math.round(outstanding * rate);
    const principal = i === months - 1 ? outstanding : method === 'linear' ? Math.round(opening / months) : annuity - interest;
    outstanding -= principal;
    return { principal, interest, payment: principal + interest, outstanding };
  });
}

const rateOf = (loan) => (Number(loan.interest_rate) || 0) / 12 / 100;
const board = (loan) => amortization(loan).map((l) => ({ ...l, posted: false, move_id: null }));

/** Monthly schedule: one line per month end, starting the month after the start date. */
export function amortization(loan) {
  check(loan);
  const [y, m] = loan.start_date.split('-').map(Number);
  return instalments(cents(loan.amount), Number(loan.duration), rateOf(loan), loan.method).map((l, i) => ({
    date: monthEnd(y + Math.floor((m + i) / 12), ((m + i) % 12) + 1),
    principal: l.principal / 100,
    interest: l.interest / 100,
    payment: l.payment / 100,
    outstanding: l.outstanding / 100,
  }));
}

/** Fill the schedule without booking anything (draft preview). */
function computeBoard(db, loan) {
  return write(db, 'account.loan', loan.id, { line_ids: board(loan) });
}

/** Check the terms, book the money received from the lender and start the schedule. */
export function confirmLoan(db, loan) {
  check(loan);
  const { db: booked } = postEntry(db, {
    journal: 'BNK1', date: loan.start_date, ref: `Loan received ${loan.name}`,
    lines: [
      { account: '101401', debit: loan.amount, partner_id: loan.lender_id ?? undefined },
      { account: '260000', credit: loan.amount, partner_id: loan.lender_id ?? undefined },
    ],
  });
  return write(booked, 'account.loan', loan.id, { line_ids: board(loan), state: 'running' });
}

/** Post every unposted line dated on or before `upTo`; the loan closes once all lines are paid. */
export function postDueLines(db, loan, upTo = today()) {
  const { db: next, line_ids } = (loan.line_ids ?? []).reduce((acc, l) => {
    if (l.posted || l.date > upTo) return { ...acc, line_ids: [...acc.line_ids, l] };
    const { db: booked, id } = postEntry(acc.db, {
      journal: 'BNK1', date: l.date, ref: `${loan.name} ${l.date.slice(0, 7)}`,
      lines: [
        { account: '260000', debit: l.principal, partner_id: loan.lender_id ?? undefined },
        { account: '690400', debit: l.interest, partner_id: loan.lender_id ?? undefined },
        { account: '101401', credit: l.payment, partner_id: loan.lender_id ?? undefined },
      ],
    });
    return { db: booked, line_ids: [...acc.line_ids, { ...l, posted: true, move_id: id }] };
  }, { db, line_ids: [] });
  return write(next, 'account.loan', loan.id, { line_ids, state: line_ids.every((l) => l.posted) ? 'closed' : 'running' });
}

/** Pay extra principal and re-spread the remaining balance over the remaining months. */
export function earlyRepayment(db, loan, { date, amount }) {
  const pending = (loan.line_ids ?? []).filter((l) => !l.posted);
  const outstanding = pending.reduce((s, l) => s + cents(l.principal), 0);
  const pay = cents(amount);
  if (!(pay > 0)) throw new Error('The repayment amount must be positive');
  if (pay > outstanding) throw new Error('The repayment cannot exceed the outstanding balance');
  const { db: booked } = postEntry(db, {
    journal: 'BNK1', date, ref: `Early repayment ${loan.name}`,
    lines: [
      { account: '260000', debit: amount, partner_id: loan.lender_id ?? undefined },
      { account: '101401', credit: amount, partner_id: loan.lender_id ?? undefined },
    ],
  });
  const posted = (loan.line_ids ?? []).filter((l) => l.posted);
  const earlyRepaid = (cents(loan.early_repaid) + pay) / 100;
  if (pay === outstanding) return write(booked, 'account.loan', loan.id, { line_ids: posted, state: 'closed', early_repaid: earlyRepaid });
  const fresh = instalments(outstanding - pay, pending.length, rateOf(loan), loan.method);
  return write(booked, 'account.loan', loan.id, {
    early_repaid: earlyRepaid,
    line_ids: [...posted, ...pending.map((l, i) => ({
      ...l,
      principal: fresh[i].principal / 100,
      interest: fresh[i].interest / 100,
      payment: fresh[i].payment / 100,
      outstanding: fresh[i].outstanding / 100,
    }))],
  });
}

export const loanModels = {
  'account.loan': {
    label: 'Loans',
    fields: {
      name: { type: 'char', label: 'Name', required: true },
      lender_id: { type: 'many2one', relation: 'res.partner', label: 'Lender' },
      amount: { type: 'monetary', label: 'Amount Borrowed' },
      start_date: { type: 'date', label: 'Start Date' },
      duration: { type: 'integer', label: 'Duration (months)' },
      interest_rate: { type: 'float', label: 'Interest Rate (%/year)' },
      method: { type: 'selection', label: 'Method', options: [['annuity', 'Fixed Payments (annuity)'], ['linear', 'Fixed Principal']] },
      state: { type: 'selection', label: 'Status', tracking: true, options: [['draft', 'Draft'], ['running', 'Running'], ['closed', 'Closed'], ['cancel', 'Cancelled']] },
      line_ids: {
        type: 'one2many',
        label: 'Amortization Schedule',
        fields: {
          date: { type: 'date', label: 'Date' },
          principal: { type: 'monetary', label: 'Principal' },
          interest: { type: 'monetary', label: 'Interest' },
          payment: { type: 'monetary', label: 'Payment' },
          outstanding: { type: 'monetary', label: 'Balance After' },
          posted: { type: 'boolean', label: 'Posted' },
          move_id: { type: 'many2one', relation: 'account.move', label: 'Entry' },
        },
        newLine: () => ({ date: today(), principal: 0, interest: 0, payment: 0, outstanding: 0, posted: false, move_id: null }),
      },
      outstanding_balance: {
        type: 'monetary', label: 'Outstanding Balance',
        compute: (r) => cents((Number(r.amount) || 0) - (Number(r.early_repaid) || 0) - (r.line_ids ?? []).filter((l) => l.posted).reduce((s, l) => s + (Number(l.principal) || 0), 0)) / 100 || 0,
      },
      early_repaid: { type: 'monetary', label: 'Repaid Early', readonly: true },
      total_interest: {
        type: 'monetary', label: 'Total Interest',
        compute: (r) => cents((r.line_ids ?? []).reduce((s, l) => s + (Number(l.interest) || 0), 0)) / 100,
      },
    },
    defaults: () => ({ start_date: today(), duration: 12, interest_rate: 5, method: 'annuity', state: 'draft', line_ids: [] }),
    groupBys: ['state'],
    filters: [[{ id: 'running', label: 'Running', fn: (r) => r.state === 'running' }, { id: 'closed', label: 'Closed', fn: (r) => r.state === 'closed' }]],
    kanban: { title: 'name', lines: ['lender_id', 'amount', 'duration'], badge: 'state' },
    list: ['name', 'lender_id', 'amount', 'interest_rate', 'start_date', 'duration', 'outstanding_balance', 'state'],
    form: {
      statusbar: 'state',
      lockedWhen: (r) => ['closed', 'cancel'].includes(r.state),
      buttons: [
        { label: 'Confirm', primary: true, when: (r) => r.state === 'draft', run: (db, r) => ({ db: confirmLoan(db, r) }) },
        { label: 'Compute Board', when: (r) => r.state === 'draft', run: (db, r) => ({ db: computeBoard(db, r) }) },
        { label: 'Post Due Lines', primary: true, when: (r) => r.state === 'running', run: (db, r) => ({ db: postDueLines(db, read(db, 'account.loan', r.id)) }) },
        {
          label: 'Early Repayment', when: (r) => r.state === 'running', run: (db, r) => {
            const amount = promptedAmount(prompt(`Early repayment amount (outstanding ${r.outstanding_balance})`, String(r.outstanding_balance)));
            if (amount == null) return { db };
            return { db: earlyRepayment(db, r, { date: today(), amount }) };
          },
        },
        { label: 'Cancel', when: (r) => r.state === 'draft', vals: { state: 'cancel' } },
      ],
      title: 'name',
      groups: [['lender_id', 'amount'], ['start_date', 'duration', 'interest_rate', 'method'], ['outstanding_balance', 'total_interest']],
      tabs: [{ label: 'Amortization Schedule', fields: ['line_ids'] }],
      chatter: true,
    },
  },
};
