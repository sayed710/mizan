// Loans: borrowings repaid by monthly instalments (annuity or fixed principal), posted as they fall due.
import { read, write } from '../orm.js';
import { promptedAmount, today } from './common.js';
import { postEntry } from './ledger.js';
import { cents } from '../money.js';
import { postMove } from './accounting.js';
import { t } from '../i18n.js';

const monthEnd = (y, m) => `${y}-${String(m).padStart(2, '0')}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;

const DAY_COUNTS = ['30A/360', '30U/360', '30E/360', '30E/360 ISDA', 'A/360', 'A/365F', 'A/A ISDA', 'A/A AFB'];
const dateParts = (s) => s.split('-').map(Number);
const utc = (s) => { const [y, m, d] = dateParts(s); return Date.UTC(y, m - 1, d); };
const days = (a, b) => (utc(b) - utc(a)) / 86400000;
const leap = (y) => y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
const dateInMonth = (date, offset, end = false) => {
  const [y, m, d] = dateParts(date);
  const first = new Date(Date.UTC(y, m - 1 + offset, 1));
  const year = first.getUTCFullYear(); const month = first.getUTCMonth() + 1;
  const last = Number(monthEnd(year, month).slice(-2));
  return `${year}-${String(month).padStart(2, '0')}-${String(end ? last : Math.min(d, last)).padStart(2, '0')}`;
};

/** Year fraction for the selected accounting convention. */
export function loanYearFraction(start, end, method, maturity = end) {
  if (utc(end) < utc(start)) throw new Error('Payment dates must follow the start date');
  if (!DAY_COUNTS.includes(method)) throw new Error('Select a valid day-count method');
  if (method === 'A/360' || method === 'A/365F') return days(start, end) / (method === 'A/360' ? 360 : 365);
  if (method === 'A/A ISDA') {
    let cursor = start; let result = 0;
    while (cursor < end) {
      const year = dateParts(cursor)[0]; const next = `${year + 1}-01-01`; const stop = next < end ? next : end;
      result += days(cursor, stop) / (leap(year) ? 366 : 365); cursor = stop;
    }
    return result;
  }
  if (method === 'A/A AFB') {
    const [endYear, endMonth, endDay] = dateParts(end);
    let cursor = end; let years = 0;
    while (true) {
      const y = endYear - (years + 1);
      const last = Number(monthEnd(y, endMonth).slice(-2));
      const previous = `${y}-${String(endMonth).padStart(2, '0')}-${String(Math.min(endDay, last)).padStart(2, '0')}`;
      if (previous < start) break;
      cursor = previous; years += 1;
    }
    const hasLeapDay = Array.from({ length: dateParts(cursor)[0] - dateParts(start)[0] + 1 }, (_, i) => dateParts(start)[0] + i)
      .some((y) => leap(y) && start <= `${y}-02-29` && `${y}-02-29` < cursor);
    return years + days(start, cursor) / (hasLeapDay ? 366 : 365);
  }
  const [y1, m1, original1] = dateParts(start); const [y2, m2, original2] = dateParts(end);
  const febEnd = (y, m, d) => m === 2 && d === (leap(y) ? 29 : 28);
  let d1 = original1; let d2 = original2;
  if (method === '30E/360') { d1 = Math.min(d1, 30); d2 = Math.min(d2, 30); }
  else if (method === '30E/360 ISDA') {
    if (d1 === Number(monthEnd(y1, m1).slice(-2))) d1 = 30;
    if (d2 === Number(monthEnd(y2, m2).slice(-2)) && !(m2 === 2 && end === maturity)) d2 = 30;
  } else {
    if (method === '30U/360' && febEnd(y1, m1, d1) && febEnd(y2, m2, d2)) d2 = 30;
    if (method === '30U/360' && febEnd(y1, m1, d1)) d1 = 30;
    if (d1 === 31) d1 = 30;
    if (d2 === 31 && d1 === 30) d2 = 30;
  }
  return (360 * (y2 - y1) + 30 * (m2 - m1) + d2 - d1) / 360;
}

export function loanSchedule(loan, values = {}) {
  const terms = { ...loan, amount: values.loan_amount ?? loan.amount, duration: values.loan_term ?? loan.duration,
    interest_rate: values.interest_rate ?? loan.interest_rate, start_date: values.start_date ?? loan.start_date };
  check(terms);
  const first = values.first_payment_date;
  if (!first) return amortization(terms);
  if (first <= terms.start_date) throw new Error('First payment date must follow the start date');
  const dates = Array.from({ length: Number(terms.duration) }, (_, i) => dateInMonth(first, i, values.payment_end_of_month === 'end_of_month'));
  const factors = dates.map((date, i) => loanYearFraction(i ? dates[i - 1] : terms.start_date, date, values.compounding_method ?? '30A/360', dates.at(-1)) * Number(terms.interest_rate) / 100);
  const opening = cents(terms.amount); let balance = opening; let discount = 1; let sum = 0;
  for (const factor of factors) { discount /= 1 + factor; sum += discount; }
  const payment = Math.round(opening / sum);
  return dates.map((date, i) => {
    const interest = Math.round(balance * factors[i]);
    const scheduled = terms.method === 'linear' ? Math.floor(opening / dates.length) + (i < opening % dates.length ? 1 : 0) : payment - interest;
    const principal = i === dates.length - 1 ? balance : Math.min(balance, Math.max(0, scheduled));
    balance -= principal;
    return { date, principal: principal / 100, interest: interest / 100, payment: (principal + interest) / 100, outstanding: balance / 100 };
  });
}

export function loanBalances(lines) {
  return lines.map((line, i) => {
    const cutoff = dateInMonth(line.date, 12);
    const short = lines.slice(i + 1).filter((next) => next.date <= cutoff).reduce((sum, next) => sum + cents(next.principal), 0);
    return { ...line, short_term_theoretical_balance: short / 100, long_term_theoretical_balance: (cents(line.outstanding) - short) / 100 };
  });
}

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
    const scheduled = method === 'linear' ? Math.floor(opening / months) + (i < opening % months ? 1 : 0) : annuity - interest;
    const principal = i === months - 1 ? outstanding : Math.min(outstanding, Math.max(0, scheduled));
    outstanding -= principal;
    return { principal, interest, payment: principal + interest, outstanding };
  });
}

const rateOf = (loan) => (Number(loan.interest_rate) || 0) / 12 / 100;
const board = (loan) => loanBalances(amortization(loan)).map((l) => ({ ...l, posted: false, move_id: null }));
const modern = (loan) => Boolean(loan.long_term_account_id || loan.short_term_account_id || loan.expense_account_id);

function postingConfig(db, loan) {
  const company = loan.company_id ?? 1;
  const accounts = modern(loan) ? [
    ['long_term_account_id', 'account.account', 'long-term liability account'],
    ['short_term_account_id', 'account.account', 'short-term liability account'],
    ['expense_account_id', 'account.account', 'interest expense account'],
  ] : [
    ['principal_account_id', 'account.account', 'principal liability account'],
    ['interest_account_id', 'account.account', 'interest expense account'],
  ];
  for (const [field, model, label] of [
    ['journal_id', 'account.journal', 'journal'],
    ['bank_account_id', 'account.account', 'bank account'],
    ...accounts,
  ]) {
    const record = loan[field] && read(db, model, loan[field]);
    if (!record) throw new Error(`Configure the loan ${label}`);
    if (record.company_id && record.company_id !== company) throw new Error(`Loan ${label} belongs to another company`);
  }
  if (modern(loan) && loan.long_term_account_id === loan.short_term_account_id) throw new Error('Loan liability accounts must be different');
}

function moveLinesMatch(move, expected) {
  const actual = move?.line_ids ?? [];
  if (actual.length !== expected.length) return false;
  const remaining = [...actual];
  return expected.every((exp) => {
    const index = remaining.findIndex((item) => item.account_id === exp.account_id
      && cents(item.debit) === exp.debit
      && cents(item.credit) === exp.credit
      && (item.partner_id ?? null) === (exp.partner_id ?? null));
    if (index < 0) return false;
    remaining.splice(index, 1);
    return true;
  });
}

function loanMoveIds(loan) {
  return [...new Set([
    ...(loan.receipt_move_id ? [loan.receipt_move_id] : []),
    ...(loan.early_moves ?? []).map((m) => m.move_id).filter(Boolean),
    ...(loan.line_ids ?? []).flatMap((line) => [
      ...(line.generated_move_ids ?? []),
      ...(line.move_id ? [line.move_id] : []),
    ]),
  ])];
}

function hasPostedAfterDate(db, loan, date) {
  if ((loan.line_ids ?? []).some((line) => line.posted && line.date > date)) return true;
  return loanMoveIds(loan).some((id) => {
    const move = read(db, 'account.move', id);
    return move?.state === 'posted' && (move.date || move.invoice_date) > date;
  });
}

function generatedLoanEntriesValid(db, loan) {
  if (!loan.journal_id || !loan.bank_account_id || !loan.long_term_account_id || !loan.short_term_account_id || !loan.expense_account_id) return false;
  if (loan.long_term_account_id === loan.short_term_account_id) return false;
  const company = loan.company_id ?? 1;
  const lines = loan.line_ids ?? [];
  if (!lines.length) return false;
  const lender = loan.lender_id ?? null;
  return lines.every((line, i) => {
    const ids = line.generated_move_ids ?? [];
    if (loan.skip_until_date && line.date < loan.skip_until_date) return !ids.length && !line.move_id;
    if (new Set(ids).size !== ids.length) return false;
    const payment = read(db, 'account.move', line.move_id);
    if (!payment || !ids.includes(payment.id) || payment.state !== 'draft' || payment.date !== line.date || payment.journal_id !== loan.journal_id || (payment.company_id ?? 1) !== company) return false;
    const reclassAmount = cents(line.principal) + cents(line.short_term_theoretical_balance) - (i ? cents(lines[i - 1].short_term_theoretical_balance) : 0);
    const reclass = ids.filter((id) => id !== payment.id).map((id) => read(db, 'account.move', id));
    if (reclass.length !== (reclassAmount ? 1 : 0)) return false;
    if (reclassAmount) {
      const move = reclass[0];
      const expectedReclass = reclassAmount > 0
        ? [
            { account_id: loan.long_term_account_id, debit: reclassAmount, credit: 0, partner_id: null },
            { account_id: loan.short_term_account_id, debit: 0, credit: reclassAmount, partner_id: null },
          ]
        : [
            { account_id: loan.short_term_account_id, debit: -reclassAmount, credit: 0, partner_id: null },
            { account_id: loan.long_term_account_id, debit: 0, credit: -reclassAmount, partner_id: null },
          ];
      if (!move || move.state !== 'draft' || move.date !== line.date || move.journal_id !== loan.journal_id || (move.company_id ?? 1) !== company || !moveLinesMatch(move, expectedReclass)) return false;
    }
    const expectedPayment = [
      { account_id: loan.short_term_account_id, debit: cents(line.principal), credit: 0, partner_id: lender },
      { account_id: loan.expense_account_id, debit: cents(line.interest), credit: 0, partner_id: lender },
      { account_id: loan.bank_account_id, debit: 0, credit: cents(line.payment), partner_id: lender },
    ];
    return moveLinesMatch(payment, expectedPayment);
  });
}

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
  const line_ids = board(loan);
  return write(db, 'account.loan', loan.id, {
    interest: line_ids.reduce((sum, line) => sum + cents(line.interest), 0) / 100,
    line_ids,
  });
}

export function computeLoan(db, loan, values = {}) {
  if (loan.state !== 'draft') throw new Error('Only a draft loan can be computed');
  const amount = Number(values.loan_amount ?? loan.amount);
  const duration = Number(values.loan_term ?? loan.duration);
  const interest_rate = Number(values.interest_rate ?? loan.interest_rate);
  const start_date = values.start_date ?? loan.start_date;
  const lines = loanBalances(loanSchedule(loan, values)).map((line) => ({ ...line, posted: false, move_id: null }));
  return write(db, 'account.loan', loan.id, {
    amount, duration, interest_rate, start_date,
    interest: lines.reduce((sum, line) => sum + cents(line.interest), 0) / 100, line_ids: lines,
  });
}

function computeWizard(loan) {
  const start = loan.start_date || today();
  return {
    title: 'Compute Loan', fields: [
      { name: 'loan_amount', type: 'monetary', label: 'Loan Amount', default: loan.amount, required: true },
      { name: 'interest_rate', type: 'float', label: 'Interest Rate (%/year)', default: loan.interest_rate, required: true },
      { name: 'loan_term', type: 'integer', label: 'Loan Term (months)', default: loan.duration, required: true },
      { name: 'start_date', type: 'date', label: 'Start Date', default: start, required: true },
      { name: 'first_payment_date', type: 'date', label: 'First Payment Date', default: dateInMonth(start, 1, true), required: true },
      { name: 'payment_end_of_month', type: 'selection', label: 'Payment Timing', default: 'end_of_month', options: [['end_of_month', 'End of Month'], ['at_anniversary', 'At Anniversary']] },
      { name: 'compounding_method', type: 'selection', label: 'Day-count Method', default: '30A/360', options: DAY_COUNTS.map((x) => [x, x]) },
      { name: 'preview', type: 'text', label: 'Preview', readonly: true, compute: (values) => loanSchedule(loan, values).map((line) => `${line.date}: ${line.principal.toFixed(2)} + ${line.interest.toFixed(2)} = ${line.payment.toFixed(2)}`).join('\n') },
    ],
  };
}

/** Check the terms, book the money received from the lender and start the schedule. */
export function confirmLoan(db, loan) {
  check(loan);
  if (loan.state !== 'draft') throw new Error('Only a draft loan can be confirmed');
  postingConfig(db, loan);
  if (modern(loan)) return confirmModernLoan(db, loan);
  const generatedFromTerms = !loan.line_ids?.length;
  const lines = loanBalances(generatedFromTerms ? board(loan) : loan.line_ids).map((l) => ({ ...l, posted: false, move_id: null }));
  const { db: booked, id: receiptId } = postEntry(db, {
    journal: loan.journal_id, company: loan.company_id, date: loan.start_date, ref: `Loan received ${loan.name}`,
    lines: [
      { account: loan.bank_account_id, debit: loan.amount, partner_id: loan.lender_id ?? undefined },
      { account: loan.principal_account_id, credit: loan.amount, partner_id: loan.lender_id ?? undefined },
    ],
  });
  return write(booked, 'account.loan', loan.id, {
    receipt_move_id: receiptId,
    ...(loan.interest == null ? { interest: lines.reduce((sum, l) => sum + cents(l.interest), 0) / 100 } : {}),
    line_ids: lines,
    state: 'running',
  });
}

function confirmModernLoan(db, loan) {
  const generatedFromTerms = !loan.line_ids?.length;
  const lines = loanBalances(generatedFromTerms ? board(loan) : loan.line_ids);
  let next = db;
  const generated = lines.map((line, i) => {
    if (loan.skip_until_date && line.date < loan.skip_until_date) return { ...line, posted: false, move_id: null, generated_move_ids: [] };
    const common = { journal: loan.journal_id, company: loan.company_id, date: line.date, state: 'draft', auto_post: 'at_date' };
    const previousShort = i ? cents(lines[i - 1].short_term_theoretical_balance) : 0;
    const reclass = cents(line.principal) + cents(line.short_term_theoretical_balance) - previousShort;
    const ids = [];
    if (reclass) {
      const amount = Math.abs(reclass) / 100;
      const entry = postEntry(next, { ...common, ref: `${loan.name} reclassification ${line.date}`, lines: reclass > 0
        ? [{ account: loan.long_term_account_id, debit: amount }, { account: loan.short_term_account_id, credit: amount }]
        : [{ account: loan.short_term_account_id, debit: amount }, { account: loan.long_term_account_id, credit: amount }] });
      next = entry.db; ids.push(entry.id);
    }
    const payment = postEntry(next, { ...common, ref: `${loan.name} ${line.date.slice(0, 7)}`, lines: [
      { account: loan.short_term_account_id, debit: line.principal, partner_id: loan.lender_id ?? undefined },
      { account: loan.expense_account_id, debit: line.interest, partner_id: loan.lender_id ?? undefined },
      { account: loan.bank_account_id, credit: line.payment, partner_id: loan.lender_id ?? undefined },
    ] });
    next = payment.db; ids.push(payment.id);
    return { ...line, posted: false, move_id: payment.id, generated_move_ids: ids };
  });
  return write(next, 'account.loan', loan.id, {
    ...(generatedFromTerms && loan.interest == null ? { interest: lines.reduce((sum, l) => sum + cents(l.interest), 0) / 100 } : {}),
    line_ids: generated,
    state: 'running',
  });
}

/** Post every unposted line dated on or before `upTo`; the loan closes once all lines are paid. */
export function postDueLines(db, loan, upTo = today()) {
  if (loan.state !== 'running') return db;
  postingConfig(db, loan);
  if (modern(loan)) {
    let next = db; let changed = false;
    const line_ids = (loan.line_ids ?? []).map((line) => {
      if (line.posted || line.date > upTo || (loan.skip_until_date && line.date < loan.skip_until_date)) return line;
      for (const id of line.generated_move_ids ?? []) {
        const move = read(next, 'account.move', id);
        if (!move || move.state === 'cancel') throw new Error('A generated loan entry is missing or cancelled');
        if (move.state === 'draft') next = postMove(next, id, { autoPost: true });
      }
      if (!line.move_id || read(next, 'account.move', line.move_id)?.state !== 'posted') throw new Error('A generated loan entry is missing or cancelled');
      changed = true; return { ...line, posted: true };
    });
    if (!changed) return db;
    const complete = line_ids.every((line) => line.posted || (loan.skip_until_date && line.date < loan.skip_until_date));
    return write(next, 'account.loan', loan.id, { line_ids, state: complete ? 'closed' : 'running' });
  }
  const { db: next, line_ids } = (loan.line_ids ?? []).reduce((acc, l) => {
    if (l.posted || l.date > upTo) return { ...acc, line_ids: [...acc.line_ids, l] };
    const { db: booked, id } = postEntry(acc.db, {
      journal: loan.journal_id, company: loan.company_id, date: l.date, ref: `${loan.name} ${l.date.slice(0, 7)}`,
      lines: [
        { account: loan.principal_account_id, debit: l.principal, partner_id: loan.lender_id ?? undefined },
        { account: loan.interest_account_id, debit: l.interest, partner_id: loan.lender_id ?? undefined },
        { account: loan.bank_account_id, credit: l.payment, partner_id: loan.lender_id ?? undefined },
      ],
    });
    return { db: booked, line_ids: [...acc.line_ids, { ...l, posted: true, move_id: id }] };
  }, { db, line_ids: [] });
  return write(next, 'account.loan', loan.id, { line_ids, state: line_ids.every((l) => l.posted) ? 'closed' : 'running' });
}

export function closeLoan(db, loan, date) {
  if (loan.state !== 'running') throw new Error('Only a running loan can be closed');
  if (!modern(loan)) throw new Error('Close Loan is only available for loans with scheduled liability accounts');
  if (!date) throw new Error('Set a closing date');
  if (hasPostedAfterDate(db, loan, date)) throw new Error('Cannot close a loan before a posted entry');
  let next = db;
  for (const line of loan.line_ids ?? []) {
    if (line.date <= date) continue;
    for (const id of new Set([...(line.generated_move_ids ?? []), ...(line.move_id ? [line.move_id] : [])])) {
      const move = read(next, 'account.move', id);
      if (move?.state === 'draft') next = write(next, 'account.move', id, { state: 'cancel', auto_post: 'no' });
    }
  }
  return write(next, 'account.loan', loan.id, { state: 'closed', close_date: date });
}

/** Pay extra principal and re-spread the remaining balance over the remaining months. */
export function earlyRepayment(db, loan, { date, amount }) {
  const pending = (loan.line_ids ?? []).filter((l) => !l.posted);
  const outstanding = pending.reduce((s, l) => s + cents(l.principal), 0);
  const pay = cents(amount);
  if (!(pay > 0)) throw new Error('The repayment amount must be positive');
  if (pay > outstanding) throw new Error('The repayment cannot exceed the outstanding balance');
  postingConfig(db, loan);
  const { db: booked, id: repaymentId } = postEntry(db, {
    journal: loan.journal_id, company: loan.company_id, date, ref: `Early repayment ${loan.name}`,
    lines: [
      { account: loan.principal_account_id, debit: amount, partner_id: loan.lender_id ?? undefined },
      { account: loan.bank_account_id, credit: amount, partner_id: loan.lender_id ?? undefined },
    ],
  });
  const posted = (loan.line_ids ?? []).filter((l) => l.posted);
  const earlyRepaid = (cents(loan.early_repaid) + pay) / 100;
  const early_moves = [...(loan.early_moves ?? []), { move_id: repaymentId }];
  if (pay === outstanding) return write(booked, 'account.loan', loan.id, { line_ids: posted, state: 'closed', early_repaid: earlyRepaid, early_moves });
  const fresh = instalments(outstanding - pay, pending.length, rateOf(loan), loan.method);
  return write(booked, 'account.loan', loan.id, {
    early_repaid: earlyRepaid, early_moves,
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
      lender_id: { type: 'many2one', relation: 'res.partner', label: 'Lender', readonly: (r) => r?.state && r.state !== 'draft' },
      journal_id: { type: 'many2one', relation: 'account.journal', label: 'Journal', readonly: (r) => r?.state && r.state !== 'draft' },
      bank_account_id: { type: 'many2one', relation: 'account.account', label: 'Bank Account', readonly: (r) => r?.state && r.state !== 'draft' },
      principal_account_id: { type: 'many2one', relation: 'account.account', label: 'Principal Liability Account', readonly: (r) => r?.state && r.state !== 'draft' },
      interest_account_id: { type: 'many2one', relation: 'account.account', label: 'Interest Expense Account', readonly: (r) => r?.state && r.state !== 'draft' },
      long_term_account_id: { type: 'many2one', relation: 'account.account', label: 'Long-term Liability Account', readonly: (r) => r?.state && r.state !== 'draft' },
      short_term_account_id: { type: 'many2one', relation: 'account.account', label: 'Short-term Liability Account', readonly: (r) => r?.state && r.state !== 'draft' },
      expense_account_id: { type: 'many2one', relation: 'account.account', label: 'Interest Expense Account', readonly: (r) => r?.state && r.state !== 'draft' },
      amount: { type: 'monetary', label: 'Amount Borrowed', readonly: (r) => r?.state && r.state !== 'draft' },
      interest: { type: 'monetary', label: 'Total Interest', readonly: (r) => r?.state && r.state !== 'draft' },
      start_date: { type: 'date', label: 'Start Date', readonly: (r) => r?.state && r.state !== 'draft' },
      skip_until_date: { type: 'date', label: 'Skip Until Date', readonly: (r) => r?.state && r.state !== 'draft' },
      close_date: { type: 'date', label: 'Closing Date', readonly: true, hideWhen: (r) => !r?.close_date },
      duration: { type: 'integer', label: 'Duration (months)', readonly: (r) => r?.state && r.state !== 'draft' },
      interest_rate: { type: 'float', label: 'Interest Rate (%/year)', readonly: (r) => r?.state && r.state !== 'draft' },
      method: { type: 'selection', label: 'Method', readonly: (r) => r?.state && r.state !== 'draft', options: [['annuity', 'Fixed Payments (annuity)'], ['linear', 'Fixed Principal']] },
      state: { type: 'selection', label: 'Status', tracking: true, options: [['draft', 'Draft'], ['running', 'Running'], ['closed', 'Closed'], ['cancelled', 'Cancelled']], badge: { draft: 'info', running: 'success', closed: 'muted', cancelled: 'muted' } },
      line_ids: {
        type: 'one2many',
        label: 'Amortization Schedule',
        fields: {
          date: { type: 'date', label: 'Date' },
          principal: { type: 'monetary', label: 'Principal' },
          interest: { type: 'monetary', label: 'Interest' },
          payment: { type: 'monetary', label: 'Payment' },
          outstanding: { type: 'monetary', label: 'Balance After' },
          long_term_theoretical_balance: { type: 'monetary', label: 'Long-term Theoretical Balance', readonly: true },
          short_term_theoretical_balance: { type: 'monetary', label: 'Short-term Theoretical Balance', readonly: true },
          posted: { type: 'boolean', label: 'Posted' },
          move_id: { type: 'many2one', relation: 'account.move', label: 'Entry' },
          generated_move_ids: { type: 'many2many', relation: 'account.move', label: 'Generated Entries', readonly: true },
        },
        newLine: () => ({ date: today(), principal: 0, interest: 0, payment: 0, outstanding: 0, posted: false, move_id: null }),
      },
      outstanding_balance: {
        type: 'monetary', label: 'Outstanding Balance',
        compute: (r) => {
          const repaid = (r.line_ids ?? [])
            .filter((l) => l.posted || (modern(r) && r.skip_until_date && l.date < r.skip_until_date))
            .reduce((s, l) => s + cents(l.principal), 0);
          return (cents(r.amount) - cents(r.early_repaid) - repaid) / 100 || 0;
        },
      },
      receipt_move_id: { type: 'many2one', relation: 'account.move', label: 'Receipt Entry', readonly: true },
      company_id: { type: 'many2one', relation: 'res.company', label: 'Company' },
      early_moves: { type: 'one2many', label: 'Early Repayment Entries', readonly: true, fields: { move_id: { type: 'many2one', relation: 'account.move', label: 'Entry' } } },
      early_repaid: { type: 'monetary', label: 'Repaid Early', readonly: true },
      total_interest: {
        type: 'monetary', label: 'Total Interest',
        compute: (r) => cents((r.line_ids ?? []).reduce((s, l) => s + (Number(l.interest) || 0), 0)) / 100,
      },
      amount_borrowed_difference: { type: 'monetary', label: 'Principal Difference', readonly: true, compute: (r) => (cents(r.amount) - (r.line_ids ?? []).reduce((sum, l) => sum + cents(l.principal), 0)) / 100 },
      interest_difference: { type: 'monetary', label: 'Interest Difference', readonly: true, compute: (r) => (cents(r.interest) - (r.line_ids ?? []).reduce((sum, l) => sum + cents(l.interest), 0)) / 100 },
      duration_difference: { type: 'integer', label: 'Duration Difference', readonly: true, compute: (r) => Number(r.duration || 0) - (r.line_ids ?? []).length },
    },
    defaults: () => ({ start_date: today(), duration: 12, interest_rate: 5, method: 'annuity', state: 'draft', line_ids: [], company_id: 1 }),
    guard: (db, before, r) => {
      if (r.state === 'closed' && (!before || ['draft', 'cancelled', 'cancel'].includes(before.state))) return 'Only a running loan can be closed';
      if (!modern(r) && r.state === 'closed' && (!before || before.state !== 'closed') && (r.line_ids ?? []).some((l) => !l.posted)) {
        return 'Legacy loans cannot be closed with unpaid instalments';
      }
      if (modern(r) && r.state === 'running' && before && ['cancelled', 'cancel'].includes(before.state)) return 'Only a draft loan can be confirmed';
      if (before?.state === 'closed' && modern(before) && (r.state !== 'closed' || r.close_date !== before.close_date)) {
        return 'A closed loan cannot be reopened';
      }
      if (modern(r) && r.state === 'running' && before?.state !== 'running' && !generatedLoanEntriesValid(db, r)) {
        return 'Generated loan entries do not match the schedule';
      }
      if (before && ['running', 'closed'].includes(before.state) && modern(before)) {
        if (before.state === 'running' && !['running', 'closed'].includes(r.state)) return 'Cannot change a running loan schedule or accounts';
        for (const field of ['lender_id', 'journal_id', 'bank_account_id', 'long_term_account_id', 'short_term_account_id', 'expense_account_id', 'amount', 'duration', 'start_date', 'skip_until_date', 'interest_rate', 'method', 'interest']) {
          if ((r[field] ?? null) !== (before[field] ?? null)) return 'Cannot change a running loan schedule or accounts';
        }
        const oldLines = before.line_ids ?? []; const newLines = r.line_ids ?? [];
        if (oldLines.length !== newLines.length || oldLines.some((line, i) => {
          const { posted: oldPosted, ...oldRest } = line; const { posted: newPosted, ...newRest } = newLines[i] ?? {};
          const keys = new Set([...Object.keys(oldRest), ...Object.keys(newRest)]);
          return [...keys].some((key) => JSON.stringify(oldRest[key]) !== JSON.stringify(newRest[key])) || (oldPosted && !newPosted)
            || (!oldPosted && newPosted && !(newRest.generated_move_ids ?? []).every((id) => read(db, 'account.move', id)?.state === 'posted'));
        })) return 'Cannot change a running loan schedule or accounts';
        if (before.state === 'running' && r.state === 'closed') {
          if (r.close_date && hasPostedAfterDate(db, r, r.close_date)) return 'Cannot close a loan before a posted entry';
          const allPosted = newLines.every((line) => line.posted || (r.skip_until_date && line.date < r.skip_until_date));
          if (!allPosted) {
            if (!r.close_date) return 'Set a closing date';
            const uncancelledFuture = newLines.some((line) => line.date > r.close_date
              && (line.generated_move_ids ?? []).some((id) => read(db, 'account.move', id)?.state === 'draft'));
            if (uncancelledFuture) return 'Future draft loan entries must be cancelled when closing';
          }
        }
      }
      if (before?.receipt_move_id) {
        for (const f of ['journal_id', 'bank_account_id', 'principal_account_id', 'interest_account_id', 'long_term_account_id', 'short_term_account_id', 'expense_account_id']) {
          if (before[f] && r[f] !== before[f]) {
            return 'Cannot change loan accounts or journal once money is booked';
          }
        }
      }
      return null;
    },
    groupBys: ['state'],
    filters: [[{ id: 'running', label: 'Running', fn: (r) => r.state === 'running' }, { id: 'closed', label: 'Closed', fn: (r) => r.state === 'closed' }]],
    kanban: { title: 'name', lines: ['lender_id', 'amount', 'duration'], badge: 'state' },
    list: ['name', 'lender_id', 'amount', 'interest_rate', 'start_date', 'duration', 'outstanding_balance', 'state'],
    form: {
      statusbar: 'state',
      warning: (r) => (!r.early_repaid && r.line_ids?.length && (cents(r.amount) !== r.line_ids.reduce((sum, l) => sum + cents(l.principal), 0)
        || cents(r.interest) !== r.line_ids.reduce((sum, l) => sum + cents(l.interest), 0)
        || Number(r.duration) !== r.line_ids.length)) ? t('Loan schedule differs from the loan totals') : '',
      lockedWhen: (r) => ['closed', 'cancelled', 'cancel'].includes(r.state),
      buttons: [
        { label: 'Confirm', primary: true, when: (r) => r.state === 'draft', run: (db, r) => ({ db: confirmLoan(db, r) }) },
        { label: 'Compute Board', when: (r) => r.state === 'draft', run: (db, r) => ({ db: computeBoard(db, r) }) },
        { label: 'Compute', when: (r) => r.state === 'draft', wizard: (db, r) => computeWizard(r), run: (db, r, values) => ({ db: computeLoan(db, r, values) }) },
        { label: 'Close Loan', when: (r) => r.state === 'running' && modern(r), wizard: () => ({ title: 'Close Loan', fields: [{ name: 'date', type: 'date', label: 'Closing Date', default: today(), required: true }] }), run: (db, r, values) => ({ db: closeLoan(db, r, values.date) }) },
        { label: 'Post Due Lines', primary: true, when: (r) => r.state === 'running', run: (db, r) => ({ db: postDueLines(db, read(db, 'account.loan', r.id)) }) },
        {
          label: 'Early Repayment', when: (r) => r.state === 'running' && !modern(r), run: (db, r) => {
            const amount = promptedAmount(prompt(`Early repayment amount (outstanding ${r.outstanding_balance})`, String(r.outstanding_balance)));
            if (amount == null) return { db };
            return { db: earlyRepayment(db, r, { date: today(), amount }) };
          },
        },
        { label: 'Cancel', when: (r) => r.state === 'draft', vals: { state: 'cancelled' } },
      ],
      title: 'name',
      groups: [['lender_id', 'amount', 'interest'], ['journal_id', 'bank_account_id', 'long_term_account_id', 'short_term_account_id', 'expense_account_id', 'principal_account_id', 'interest_account_id', 'company_id'], ['start_date', 'skip_until_date', 'close_date', 'duration', 'interest_rate', 'method'], ['outstanding_balance', 'total_interest', 'amount_borrowed_difference', 'interest_difference', 'duration_difference']],
      tabs: [{ label: 'Amortization Schedule', fields: ['line_ids'] }],
      chatter: true,
    },
  },
};
