// Fiscal closing and reversing exchange adjustments (comparative reports live in views/reportCompare.js).
import { read, search, write } from '../orm.js';
import { addDays, shiftMonth, today, validDate } from './common.js';
import { balances, balanceSheet, journalItems, postEntry, profitAndLoss } from './ledger.js';
import { exchangeAccount } from './exchange-account.js';
import { companyCurrency, toCompany } from './currency.js';
import { companyCurrencyRecord, documentCurrency, round, roundCurrency } from '../money.js';
import { applicationActiveAt, settlementCompanyAllocations } from './settlement.js';
import { companyViewDb } from '../companyView.js';
import { currentYearEarningsAccount } from './earnings.js';

const pnlTypes = ['income', 'income_other', 'expense', 'expense_direct_cost', 'expense_other'];
export const checkDate = (date) => { if (!validDate(date)) throw new Error('Enter a valid date'); };
const side = (amount) => ({ debit: Math.max(0, round(amount)), credit: Math.max(0, round(-amount)) });

const sameLines = (a, b) => a.length === b.length && a.every((l, i) => l.account_id === b[i].account_id && round(l.debit) === round(b[i].credit) && round(l.credit) === round(b[i].debit));

/** Closing provenance is recorded by the closing workflow, not inferred from entry contents. */
/** The closing lines for a year: each P&L balance cleared against the company's current-year earnings account. */
function closingLines(db, year, earningsAccountId) {
  const companyView = { ...db, settings: { ...db.settings, current_company_id: year.company_id } };
  const rows = balances(companyView, journalItems(db, { from: year.date_from, to: year.date_to, company_id: year.company_id }))
    .filter((r) => (!r.account.company_id || r.account.company_id === year.company_id) && pnlTypes.includes(r.account.account_type) && r.balance);
  const lines = rows.map((r) => ({ account_id: r.account.id, ...side(-r.balance) }));
  lines.push({ account_id: earningsAccountId, ...side(round(rows.reduce((s, r) => s + r.balance, 0))) });
  if (lines.length === 1) lines.push({ account_id: earningsAccountId, debit: 0, credit: 0 });
  return lines;
}

/** The genuine closing entry: posted for the year and booking exactly the year's closing lines (Qodo 13). */
function isClosingEntry(db, year, move) {
  if (!year.closing_earnings_account_id || !move || move.closing_fiscal_year_id !== year.id || (move.company_id ?? 1) !== (year.company_id ?? 1) || move.state !== 'posted' || move.move_type !== 'entry') return false;
  const without = { ...db, records: { ...db.records, 'account.move': (db.records['account.move'] ?? []).filter((m) => m.id !== move.id && m.id !== year.opening_move_id) } };
  return sameLines(closingLines(without, year, year.closing_earnings_account_id).map((l) => ({ ...l, debit: l.credit, credit: l.debit })), move.line_ids ?? []);
}

/** The genuine reopening entry: posted, named for the year, and the exact mirror of its closing entry. */
function isReopeningEntry(db, year, move) {
  const closing = read(db, 'account.move', year.closing_move_id);
  return !!move && !!closing && (move.company_id ?? 1) === (year.company_id ?? 1) && move.state === 'posted' && move.move_type === 'entry' && move.ref === `Reopen fiscal year: ${year.name}`
    && sameLines(closing.line_ids ?? [], move.line_ids ?? []);
}

function yearGuard(db, before, after) {
  if (!read(db, 'res.company', after.company_id)) return 'Select an existing company';
  if (before && before.company_id !== after.company_id) return 'Fiscal year company cannot be changed';
  if (!validDate(after.date_from) || !validDate(after.date_to) || after.date_from > after.date_to) return 'Enter a valid fiscal year date range';
  if (before?.state === 'closed' && (before.date_from !== after.date_from || before.date_to !== after.date_to)) return 'Reopen the fiscal year before changing its dates';
  // Closing and reopening entries leave the P&L, so a year names them only as it closes or reopens, on its end date.
  const entryOff = (id) => { const m = id && read(db, 'account.move', id); return m && (m.date ?? m.invoice_date) !== after.date_to; };
  const closes = after.state === 'closed' && before?.state !== 'closed';
  if ((before?.closing_earnings_account_id ?? null) !== (after.closing_earnings_account_id ?? null) && !closes) return 'The closing earnings account is set by closing the fiscal year';
  if ((before?.closing_move_id ?? null) !== (after.closing_move_id ?? null) && !(closes && after.closing_move_id)) return 'The closing entry is set by closing the fiscal year';
  if (closes && !after.closing_move_id) return 'Close the fiscal year with its closing entry';
  if (after.opening_move_id && after.opening_move_id !== before?.opening_move_id && (before?.opening_move_id || after.state !== 'open')) return 'The reopening entry is set by reopening the fiscal year';
  if (entryOff(after.closing_move_id) || entryOff(after.opening_move_id)) return 'Closing entries are dated on the fiscal year end';
  // Only the real entries made by closing or reopening may be named: an ordinary entry would vanish from the P&L.
  if (closes && !isClosingEntry(db, after, read(db, 'account.move', after.closing_move_id))) return 'The closing entry must be the one made by closing this fiscal year';
  if (closes && after.closing_earnings_account_id !== currentYearEarningsAccount(db, after.company_id).id) return 'The closing earnings account must be the configured earnings account';
  if (after.opening_move_id && after.opening_move_id !== before?.opening_move_id && !isReopeningEntry(db, after, read(db, 'account.move', after.opening_move_id))) return 'The reopening entry must be the one made by reopening this fiscal year';
  if (search(db, 'account.fiscal.year').some((y) => y.id !== after.id && [after.closing_move_id, after.opening_move_id].filter(Boolean).some((m) => y.closing_move_id === m || y.opening_move_id === m))) return 'That entry already belongs to another fiscal year';
  return search(db, 'account.fiscal.year').some((y) => y.id !== after.id && (y.company_id ?? 1) === after.company_id && y.date_from <= after.date_to && y.date_to >= after.date_from)
    ? 'Fiscal years must not overlap' : null;
}

function getYear(db, id) {
  const year = read(db, 'account.fiscal.year', id);
  if (!year) throw new Error('Fiscal year not found');
  const error = yearGuard(db, year, year);
  if (error) throw new Error(error);
  return year;
}

/** Close P&L balances into retained earnings and lock the fiscal year. */
export function closeFiscalYear(db, yearId, { date } = {}) {
  const year = getYear(db, yearId);
  if (year.state === 'closed') throw new Error('This fiscal year is already closed');
  if (date && date !== year.date_to) throw new Error('Close the fiscal year on its end date');
  if (search(db, 'account.move').some((m) => (m.company_id ?? 1) === year.company_id && m.state === 'draft' && (m.date ?? m.invoice_date) >= year.date_from && (m.date ?? m.invoice_date) <= year.date_to)) {
    throw new Error('Post or cancel draft moves inside this fiscal year before closing');
  }
  const earningsAccountId = currentYearEarningsAccount(db, year.company_id).id;
  const lines = closingLines(db, year, earningsAccountId);
  const next = db;
  const entry = postEntry(next, { journal: 'MISC', date: year.date_to, ref: `Fiscal closing: ${year.name}`, company: year.company_id, lines, system_generated: true });
  const marked = { ...entry.db, records: { ...entry.db.records, 'account.move': entry.db.records['account.move'].map((m) => m.id === entry.id ? { ...m, closing_fiscal_year_id: yearId } : m) } };
  // The year references its closing entry first: only such an entry may carry the closing flag.
  const closed = write(marked, 'account.fiscal.year', yearId, { state: 'closed', closing_move_id: entry.id, closing_earnings_account_id: earningsAccountId, opening_move_id: null });
  return write(closed, 'account.move', entry.id, { is_closing: true });
}

/** Reverse the closing on the year end, clearing only that year's fiscal lock. */
export function reopenFiscalYear(db, yearId) {
  const year = getYear(db, yearId);
  if (year.state !== 'closed') throw new Error('This fiscal year is already open');
  const closing = read(db, 'account.move', year.closing_move_id);
  if (!isClosingEntry(db, year, closing)) throw new Error('The recorded closing entry is missing or has no closing provenance');
  // Open the year before booking into it: a closed year locks its period.
  const next = write(db, 'account.fiscal.year', yearId, { state: 'open' });
  const entry = postEntry(next, {
    journal: 'MISC', date: year.date_to, ref: `Reopen fiscal year: ${year.name}`, company: year.company_id,
    lines: closing.line_ids.map((l) => ({ account_id: l.account_id, debit: l.credit, credit: l.debit, partner_id: l.partner_id })),
    system_generated: true,
    archivedOriginIds: [closing.id],
  });
  return write(write(entry.db, 'account.fiscal.year', yearId, { opening_move_id: entry.id }), 'account.move', entry.id, { is_closing: true });
}

const pnlRows = [['revenue', 'Revenue'], ['cost', 'Cost of Revenue'], ['gross', 'Gross Profit'], ['expense', 'Expenses'],
  ['operating', 'Net Operating Income'], ['otherIncome', 'Other Income'], ['otherExpense', 'Other Expenses'], ['net', 'Net Income']];
const sheetRows = [['totalAssets', 'Assets'], ['totalLiabilities', 'Liabilities'], ['equity', 'Equity'],
  ['earnings', 'Current Year Earnings'], ['liabilitiesEquity', 'Liabilities + Equity']];

function comparison(columns, reports, definitions) {
  const rows = definitions.map(([key, label]) => ({ key, label, values: reports.map((r) => r[key]) }));
  const variance = rows.map(({ key, values }) => {
    const previous = values.at(-2);
    const amount = values.length < 2 ? null : round(values.at(-1) - previous);
    return { key, amount, percent: amount == null || !previous ? null : round(amount / Math.abs(previous) * 100) };
  });
  return { columns, rows, variance };
}

/** P&L comparison in caller order; variance compares the last two columns. */
export function compareProfitAndLoss(db, periods) {
  return comparison(periods, periods.map((period) => profitAndLoss(db, period)), pnlRows);
}

/** Balance sheet comparison using the totals displayed by Reports. */
export function compareBalanceSheet(db, dates) {
  return comparison(dates, dates.map((date) => {
    checkDate(date);
    const sheet = balanceSheet(db, date);
    return { ...sheet, equity: round(sheet.totalEquity - sheet.earnings), liabilitiesEquity: round(sheet.totalLiabilities + sheet.totalEquity) };
  }), sheetRows);
}

/** Previous periods, oldest first, excluding the supplied period and preserving month ends. */
export function comparePeriods(period, { count = 1, unit = 'month' } = {}) {
  checkDate(period.from);
  checkDate(period.to);
  const months = { month: 1, quarter: 3, year: 12 }[unit];
  if (!months || !Number.isInteger(count) || count < 0 || period.from > period.to) throw new Error('Choose a valid comparison unit, count and period');
  return Array.from({ length: count }, (_, i) => ({ from: shiftMonth(period.from, -(count - i) * months), to: shiftMonth(period.to, -(count - i) * months) }));
}

/** Open foreign invoices/bills/refunds at a date; positive difference increases the absolute balance. */
export function unrealizedExchange(db, date) {
  checkDate(date);
  return search(db, 'account.move').filter((m) => m.state === 'posted' && ['out_invoice', 'in_invoice', 'out_refund', 'in_refund'].includes(m.move_type)
    && (m.date ?? m.invoice_date) <= date && m.currency_id && m.currency_id !== companyCurrency(db, m.company_id)).flatMap((m) => {
    const docRound = (n) => roundCurrency(n, documentCurrency(db, m));
    const companyRound = (n) => roundCurrency(n, companyCurrencyRecord(db, m.company_id));
    const allocations = settlementCompanyAllocations(db, m);
    const activePaid = docRound(allocations.filter(({ row }) => !row.reversed).reduce((s, { row }) => s + (Number(row.amount) || 0), 0));
    if (docRound(Number(m.amount_paid) || 0) !== activePaid) throw new Error(`Invoice ${m.name || m.id} has payments not explained by settlement allocations`);
    const paid = allocations.filter(({ row: p }) => applicationActiveAt(db, p, m, date));
    const paidForeign = docRound(paid.reduce((s, a) => s + Number(a.row.amount || 0), 0));
    const residual = docRound(m.amount_total - paidForeign);
    if (residual <= 0) return [];
    const accountType = ['out_invoice', 'out_refund'].includes(m.move_type) ? 'asset_receivable' : 'liability_payable';
    const refundSign = ['out_refund', 'in_refund'].includes(m.move_type) ? -1 : 1;
    const counterpart = (m.line_ids ?? []).filter((l) => read(db, 'account.account', l.account_id)?.account_type === accountType);
    const ids = [...new Set(counterpart.map((l) => l.account_id))];
    if (ids.length !== 1) throw new Error(`Invoice ${m.name || m.id} must have one ${accountType} account`);
    const account_id = ids[0];
    const account = read(db, 'account.account', account_id).code;
    const sign = (accountType === 'liability_payable' ? -1 : 1) * refundSign;
    const original = counterpart
      .reduce((s, l) => s + sign * ((Number(l.debit) || 0) - (Number(l.credit) || 0)), 0);
    const paidBooked = companyRound(paid.reduce((s, a) => s + a.value, 0));
    const booked = companyRound(refundSign * (original - paidBooked));
    const value = companyRound(refundSign * toCompany(db, m.currency_id, residual, date, m.company_id));
    return [{ invoice_id: m.id, company_id: m.company_id ?? 1, partner_id: m.partner_id, currency_id: m.currency_id, account, account_id, residual: docRound(refundSign * residual), booked, value, difference: companyRound(value - booked) }];
  });
}

const revaluableTypes = new Set(['asset_receivable', 'asset_cash', 'asset_current', 'liability_payable', 'liability_current']);
const journalLineKey = (moveId, index) => `${moveId}:${index}`;

/** Invoice and settlement receivable/payable lines are represented by their document residual above. */
function documentSettlementLines(db, date) {
  const excluded = new Set();
  for (const move of search(db, 'account.move')) {
    if (move.state !== 'posted' || !['out_invoice', 'in_invoice', 'out_refund', 'in_refund'].includes(move.move_type)
      || (move.date ?? move.invoice_date ?? '') > date) continue;
    const counterpartType = ['in_invoice', 'in_refund'].includes(move.move_type) ? 'liability_payable' : 'asset_receivable';
    (move.line_ids ?? []).forEach((line, index) => {
      if (read(db, 'account.account', line.account_id)?.account_type === counterpartType) excluded.add(journalLineKey(move.id, index));
    });
    for (const { row } of settlementCompanyAllocations(db, move)) {
      if (!applicationActiveAt(db, row, move, date)) continue;
      const settlement = read(db, 'account.move', row.move_id);
      (settlement?.line_ids ?? []).forEach((line, index) => {
        const type = read(db, 'account.account', line.account_id)?.account_type;
        if (type === 'asset_receivable' || type === 'liability_payable') excluded.add(journalLineKey(settlement.id, index));
      });
    }
  }
  return excluded;
}

/** Open foreign-currency balance-sheet journal items grouped by company, account, currency and partner. */
function foreignJournalPositions(db, date, { accountTypes = revaluableTypes, excludedLines = new Set() } = {}) {
  const groups = new Map();
  for (const move of search(db, 'account.move')) {
    if (move.state !== 'posted' || (move.date ?? move.invoice_date ?? '') > date) continue;
    const company = move.company_id ?? 1;
    (move.line_ids ?? []).forEach((line, index) => {
      if (excludedLines.has(journalLineKey(move.id, index)) || !line.currency_id || line.currency_id === companyCurrency(db, company)) return;
      const account = read(db, 'account.account', line.account_id);
      if (!account || !accountTypes.has(account.account_type)) return;
      const key = `${company}:${line.account_id}:${line.currency_id}:${line.partner_id ?? ''}`;
      const row = groups.get(key) ?? { company_id: company, account_id: line.account_id, account: account.code, partner_id: line.partner_id ?? null, currency_id: line.currency_id, foreign: 0, booked: 0, signedBalance: true };
      row.foreign = roundCurrency(row.foreign + (Number(line.amount_currency) || 0), read(db, 'res.currency', line.currency_id));
      row.booked = roundCurrency(row.booked + (Number(line.debit) || 0) - (Number(line.credit) || 0), companyCurrencyRecord(db, company));
      groups.set(key, row);
    });
  }
  // A zero foreign balance can still carry a company-currency balance from different rates; it revalues to zero.
  return [...groups.values()].filter((row) => row.foreign || row.booked).map((row) => {
    const own = companyCurrencyRecord(db, row.company_id);
    const value = roundCurrency(toCompany(db, row.currency_id, row.foreign, date, row.company_id), own);
    return { ...row, residual: row.foreign, value, difference: roundCurrency(value - row.booked, own) };
  });
}

/** Foreign bank positions are reconstructed from posted journal items, grouped by account and currency. */
export function foreignBankBalances(db, date) {
  checkDate(date);
  return foreignJournalPositions(db, date, { accountTypes: new Set(['asset_cash']) });
}

/** Open foreign positions visible to the selected companies, including manual balance-sheet entries. */
export function foreignBalanceReport(db, date, { companyId = null, companyScoped = true } = {}) {
  checkDate(date);
  const scoped = companyId ? db : companyScoped ? companyViewDb(db) : db;
  const source = companyId
    ? { ...db, records: { ...db.records, 'account.move': search(db, 'account.move').filter((move) => (move.company_id ?? 1) === companyId) } }
    : scoped;
  const invoices = unrealizedExchange(source, date);
  const settled = documentSettlementLines(source, date);
  const manual = foreignJournalPositions(source, date, { excludedLines: settled });
  return [...invoices, ...manual];
}

/** Net company-currency amount per account and partner; rejects lines without an account. */
function revaluationTotals(lines, companyRound, totals = new Map()) {
  for (const line of lines) {
    if (!line.account_id) throw new Error('A foreign currency revaluation line has no account');
    const key = `${line.account_id}:${line.partner_id ?? ''}`;
    const row = totals.get(key) ?? { account_id: line.account_id, partner_id: line.partner_id ?? null, amount: 0 };
    totals.set(key, { ...row, amount: companyRound(row.amount + (Number(line.debit) || 0) - (Number(line.credit) || 0)) });
  }
  return totals;
}

function revaluationJournalId(db, company) {
  const settings = read(db, 'res.company', company);
  const journal = settings?.default_general_journal_id
    ? read(db, 'account.journal', settings.default_general_journal_id)
    : null;
  if (!journal || journal.type !== 'general' || (journal.company_id && journal.company_id !== company)) {
    throw new Error(`Configure a default general journal for company ${company} in the company settings before revaluing foreign balances`);
  }
  return journal.id;
}

/**
 * Post the exchange adjustment for a date, with its next-day reversal. Adjustments already posted for that
 * company and date count towards the target, so a rerun posts only the change (nothing when unchanged), and a
 * position that moved or vanished after an earlier run is corrected instead of left stale.
 */
export function revalueForeignBalances(db, date, { companyScoped = false, companyId = null } = {}) {
  checkDate(date);
  const rows = foreignBalanceReport(db, date, { companyId, companyScoped }).filter((r) => r.difference);
  const visible = search(companyId || !companyScoped ? db : companyViewDb(db), 'account.move')
    .filter((m) => (!companyId || (m.company_id ?? 1) === companyId) && m.revaluation_date === date && m.state === 'posted');
  const plans = [];
  // Validate every company and any existing adjustment before constructing entries.
  for (const company of [...new Set([...rows.map((r) => r.company_id), ...visible.map((m) => m.company_id ?? 1)])]) {
    const settings = read(db, 'res.company', company);
    if (!settings) throw new Error('A revaluation company no longer exists');
    let gain = 0;
    let loss = 0;
    const companyRound = (n) => roundCurrency(n, companyCurrencyRecord(db, company));
    const lines = rows.filter((r) => r.company_id === company).map((r) => {
      const account = read(db, 'account.account', r.account_id);
      if (!account || (account.company_id && account.company_id !== company)) throw new Error('A foreign balance account does not belong to its company');
      const amount = companyRound(r.signedBalance ? r.difference : r.difference * (account.account_type === 'liability_payable' ? -1 : 1));
      if (amount > 0) gain = companyRound(gain + amount);
      else loss = companyRound(loss - amount);
      return { account_id: r.account_id, partner_id: r.partner_id, debit: Math.max(0, amount), credit: Math.max(0, -amount) };
    }).filter((line) => line.debit || line.credit);
    const expected = [...lines];
    if (gain) expected.push({ account_id: exchangeAccount(db, company, 1), credit: gain });
    if (loss) expected.push({ account_id: exchangeAccount(db, company, -1), debit: loss });
    const booked = visible.filter((m) => (m.company_id ?? 1) === company)
      .reduce((totals, m) => revaluationTotals(m.line_ids ?? [], companyRound, totals), new Map());
    const wanted = revaluationTotals(expected, companyRound);
    const delta = [...new Set([...wanted.keys(), ...booked.keys()])].map((key) => {
      const row = wanted.get(key) ?? booked.get(key);
      const amount = companyRound((wanted.get(key)?.amount ?? 0) - (booked.get(key)?.amount ?? 0));
      return { account_id: row.account_id, partner_id: row.partner_id, debit: Math.max(0, amount), credit: Math.max(0, -amount) };
    }).filter((line) => line.debit || line.credit);
    if (delta.length) plans.push({ company, journalId: revaluationJournalId(db, company), expected: delta });
  }

  let next = db;
  for (const plan of plans) {
    const { company, journalId, expected } = plan;
    const entry = postEntry(next, { journal: journalId, journal_id: journalId, date, ref: `Foreign currency revaluation: ${date}`, lines: expected, company, system_generated: true });
    const reversal = postEntry(entry.db, {
      journal: journalId, journal_id: journalId, date: addDays(date, 1), ref: `Reversal of ${read(entry.db, 'account.move', entry.id).name}`, company,
      lines: expected.map((l) => ({ ...l, debit: l.credit ?? 0, credit: l.debit ?? 0 })),
      system_generated: true,
      archivedOriginIds: [entry.id],
    });
    next = write(write(reversal.db, 'account.move', entry.id, { revaluation_date: date, reversal_move_id: reversal.id }), 'account.move', reversal.id, { reversed_entry_id: entry.id });
  }
  return next;
}

const revaluationIgnoredFields = new Set(['id', 'name', 'ref', 'system_generated', 'reversal_move_id', 'reversed_entry_id']);
function revaluationMoveContents(move) {
  const lineContents = (move.line_ids ?? []).map((line) => JSON.stringify(Object.fromEntries(
    Object.entries(line).filter(([field]) => field !== 'name').sort(([a], [b]) => a.localeCompare(b)),
  ))).sort();
  return JSON.stringify(Object.fromEntries(Object.entries(move)
    .filter(([field]) => !revaluationIgnoredFields.has(field))
    .map(([field, value]) => [field, field === 'line_ids' ? lineContents : value])
    .sort(([a], [b]) => a.localeCompare(b))));
}

/** A revaluation pair is valid only when it matches the pair the configured workflow produces from this snapshot. */
export function isRevaluationMovePair(db, adjustment, reversal) {
  const date = adjustment?.revaluation_date;
  const company = adjustment?.company_id ?? 1;
  if (!validDate(date) || adjustment.move_type !== 'entry' || adjustment.state !== 'posted'
    || adjustment.date !== date || adjustment.invoice_date !== date
    || reversal?.move_type !== 'entry' || reversal.state !== 'posted'
    || reversal.date !== addDays(date, 1) || reversal.invoice_date !== addDays(date, 1)
    || adjustment.reversal_move_id !== reversal.id || reversal.reversed_entry_id !== adjustment.id
    || (reversal.company_id ?? 1) !== company) return false;

  const moves = (db.records['account.move'] ?? []).filter((m) => m.id !== adjustment.id && m.id !== reversal.id);
  const maxMoveId = Math.max(0, db.seq?.['account.move'] ?? 0, ...moves.map((m) => m.id ?? 0));
  const snapshot = {
    ...db,
    records: { ...db.records, 'account.move': moves },
    seq: { ...db.seq, 'account.move': maxMoveId },
  };
  const expected = revalueForeignBalances(snapshot, date, { companyId: company });
  const existingIds = new Set((snapshot.records['account.move'] ?? []).map((move) => move.id));
  const newAdjustments = (expected.records['account.move'] ?? []).filter((move) => (
    !existingIds.has(move.id) && move.revaluation_date === date
    && (move.company_id ?? 1) === company && move.reversal_move_id
  ));
  if (newAdjustments.length !== 1) return false;
  const expectedAdjustment = newAdjustments[0];
  const expectedReversals = (expected.records['account.move'] ?? []).filter((move) => move.id === expectedAdjustment.reversal_move_id);
  if (expectedReversals.length !== 1) return false;
  const expectedReversal = expectedReversals[0];
  return Boolean(expectedReversal
    && revaluationMoveContents(adjustment) === revaluationMoveContents(expectedAdjustment)
    && revaluationMoveContents(reversal) === revaluationMoveContents(expectedReversal));
}

export const closingModels = {
  'account.fiscal.year': {
    label: 'Fiscal Years',
    fields: {
      name: { type: 'char', label: 'Fiscal Year', required: true },
      company_id: { type: 'many2one', relation: 'res.company', label: 'Company', required: true },
      date_from: { type: 'date', label: 'Start Date', required: true },
      date_to: { type: 'date', label: 'End Date', required: true },
      state: { type: 'selection', label: 'Status', tracking: true, options: [['open', 'Open'], ['closed', 'Closed']] },
      closing_move_id: { type: 'many2one', relation: 'account.move', label: 'Closing Entry', readonly: true },
      closing_earnings_account_id: { type: 'many2one', relation: 'account.account', label: 'Current Year Earnings Account', readonly: true },
      opening_move_id: { type: 'many2one', relation: 'account.move', label: 'Reopening Entry', readonly: true },
    },
    createDefaults: (db) => ({ company_id: db.settings?.current_company_id ?? 1 }),
    defaults: () => ({ state: 'open', date_from: `${today().slice(0, 4)}-01-01`, date_to: `${today().slice(0, 4)}-12-31` }),
    guard: yearGuard,
    protectDelete: (db, r) => r.closing_move_id ? 'Keep fiscal years with closing entries for the audit trail' : null,
    list: ['name', 'date_from', 'date_to', 'state'],
    kanban: { title: 'name', lines: ['date_from', 'date_to'], badge: 'state' },
    form: {
      title: 'name', statusbar: 'state', lockedWhen: (r) => r.state === 'closed',
      groups: [['company_id', 'date_from', 'date_to'], ['closing_move_id', 'opening_move_id']],
      buttons: [
        { label: 'Close Year', primary: true, when: (r) => r.state === 'open', run: (db, r) => ({ db: closeFiscalYear(db, r.id) }) },
        { label: 'Reopen', when: (r) => r.state === 'closed', run: (db, r) => ({ db: reopenFiscalYear(db, r.id) }) },
        {
          label: 'Revalue Foreign Currency', when: (r) => r.state === 'open',
          ask: [{ label: 'Revaluation date (YYYY-MM-DD)', default: (r) => (today() < r.date_from ? r.date_from : today() < r.date_to ? today() : r.date_to) }],
          run: (db, r, [date]) => {
            const year = getYear(db, r.id);
            checkDate(date);
            if (year.state !== 'open' || date < year.date_from || date > year.date_to) throw new Error('Select a revaluation date inside this open fiscal year');
            return { db: revalueForeignBalances(db, date, { companyId: year.company_id }) };
          },
        },
      ],
      chatter: true,
    },
  },
};
