import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, updateSettings, write } from './orm.js';
import { seed } from './seed.js';
import { accountId, balances, balanceSheet, isBalanced, journalItems, postEntry, profitAndLoss } from './models/ledger.js';
import { payMove, postMove } from './models/accounting.js';
import { closeFiscalYear, closingModels, compareBalanceSheet, comparePeriods, compareProfitAndLoss, fiscalYearOf,
  reopenFiscalYear, revalueForeignBalances, unrealizedExchange } from './models/closing.js';

const period = { from: '2024-01-01', to: '2024-12-31' };
const year = (db) => create(db, 'account.fiscal.year', { name: 'FY 2024', date_from: period.from, date_to: period.to });
const entry = (db, date, lines) => postEntry(db, { journal: 'MISC', date, lines }).db;
const business = () => entry(seed(), '2024-06-15', [
  { account: '101401', debit: 750 }, { account: '400000', credit: 1000 },
  { account: '450000', credit: 100 }, { account: '500000', debit: 200 },
  { account: '600000', debit: 100 }, { account: '690000', debit: 50 },
]);
const run = (db, id, label) => closingModels['account.fiscal.year'].form.buttons.find((b) => b.label === label)
  .run(db, read(db, 'account.fiscal.year', id)).db;
const row = (report, key) => report.rows.find((r) => r.key === key);

test('fiscal years use inclusive boundaries, fall back to calendar years, and reject overlaps on create/write', () => {
  const { db, id } = year(seed());
  assert.equal(fiscalYearOf(db, period.from).id, id);
  assert.equal(fiscalYearOf(db, period.to).id, id);
  assert.deepEqual(fiscalYearOf(db, '2023-07-01'), { date_from: '2023-01-01', date_to: '2023-12-31' });
  assert.throws(() => year(db), /overlap/);
  const other = create(db, 'account.fiscal.year', { name: 'Next', date_from: '2025-01-01', date_to: '2025-12-31' });
  assert.throws(() => write(other.db, 'account.fiscal.year', other.id, { date_from: period.to }), /overlap/);
  assert.throws(() => write(db, 'account.fiscal.year', id, { date_to: '2024-02-30' }), /valid/);
  assert.throws(() => write(db, 'account.fiscal.year', id, { date_to: '2023-01-01' }), /valid/);
  assert.throws(() => fiscalYearOf(db, 'invalid'), /valid date/);
});

test('closing clears all five P&L types into retained earnings, balances, and preserves the original db', () => {
  const { db, id } = year(business());
  const snapshot = JSON.stringify(db);
  assert.equal(profitAndLoss(db, period).net, 750);
  const closed = run(db, id, 'Close Year');
  assert.equal(JSON.stringify(db), snapshot);
  const fy = read(closed, 'account.fiscal.year', id);
  const closing = read(closed, 'account.move', fy.closing_move_id);
  assert.equal(fy.state, 'closed');
  assert.equal(closing.invoice_date, period.to);
  assert.ok(isBalanced(closing.line_ids));
  assert.equal(closing.line_ids.length, 6);
  const retained = closing.line_ids.find((l) => l.account_id === accountId(closed, '302000'));
  assert.equal(retained.credit, 750);
  assert.equal(read(closed, 'account.account', retained.account_id).name, 'Retained Earnings');
  assert.ok(balances(closed, journalItems(closed, period)).filter((r) => /^(income|expense)/.test(r.account.account_type)).every((r) => r.balance === 0));
  assert.equal(profitAndLoss(closed, period).net, 0);
  const sheet = balanceSheet(closed, period.to);
  assert.equal(sheet.earnings, 0);
  assert.equal(sheet.totalAssets, sheet.totalLiabilities + sheet.totalEquity);
  assert.equal(sheet.equity.find((r) => r.account.code === '302000').balance, 750);
  assert.equal(closed.settings.lock_date, period.to);
  assert.throws(() => entry(closed, '2024-03-01', [{ account: '101401', debit: 1 }, { account: '301000', credit: 1 }]), /locked/);
  assert.throws(() => write(closed, 'account.fiscal.year', id, { date_to: '2025-12-31' }), /Reopen/);
});

test('closing refuses an already closed year, draft moves, missing years and a different closing date', () => {
  const { db, id } = year(business());
  assert.throws(() => closeFiscalYear(closeFiscalYear(db, id), id), /already closed/);
  for (const date of [period.from, period.to]) {
    const draft = create(db, 'account.move', { move_type: 'entry', invoice_date: date }).db;
    assert.throws(() => closeFiscalYear(draft, id), /draft moves/);
  }
  assert.throws(() => closeFiscalYear(db, 999), /not found/);
  assert.throws(() => closeFiscalYear(db, id, { date: '2025-01-01' }), /end date/);
  const outside = create(db, 'account.move', { invoice_date: '2025-01-01' }).db;
  assert.equal(read(closeFiscalYear(outside, id), 'account.fiscal.year', id).state, 'closed');
});

test('reopening reverses the close in the same year and permits a balanced reclose', () => {
  const { db, id } = year(business());
  const closed = closeFiscalYear(db, id);
  const reopened = run(closed, id, 'Reopen');
  const fy = read(reopened, 'account.fiscal.year', id);
  assert.equal(fy.state, 'open');
  assert.equal(reopened.settings.lock_date, '');
  assert.equal(profitAndLoss(reopened, period).net, 750);
  assert.equal(balanceSheet(reopened, period.to).totalEquity, 750);
  const reversal = read(reopened, 'account.move', fy.opening_move_id);
  assert.equal(reversal.invoice_date, period.to);
  assert.ok(isBalanced(reversal.line_ids));
  assert.throws(() => reopenFiscalYear(reopened, id), /already open/);
  assert.equal(profitAndLoss(closeFiscalYear(reopened, id), period).net, 0);
  assert.throws(() => reopenFiscalYear(updateSettings(closed, { lock_date: '2025-12-31' }), id), /locked/);
  assert.throws(() => reopenFiscalYear(updateSettings(closed, { hard_lock_date: period.to }), id), /locked/);
  const differentLock = reopenFiscalYear(updateSettings(closed, { lock_date: '2023-12-31' }), id);
  assert.equal(differentLock.settings.lock_date, '2023-12-31');
});

test('loss years debit retained earnings; empty years close with a balanced zero entry', () => {
  const loss = year(entry(seed(), '2024-02-01', [{ account: '600000', debit: 80 }, { account: '101401', credit: 80 }]));
  const closed = closeFiscalYear(loss.db, loss.id, { retainedEarningsCode: '302100' });
  assert.equal(balanceSheet(closed, period.to).equity.find((r) => r.account.code === '302100').balance, -80);
  assert.equal(balanceSheet(closed, period.to).earnings, 0);
  const empty = year(seed());
  const done = closeFiscalYear(empty.db, empty.id);
  assert.ok(isBalanced(read(done, 'account.move', read(done, 'account.fiscal.year', empty.id).closing_move_id).line_ids));
});

test('three monthly P&L columns and variance follow caller order with explicit undefined percentages', () => {
  let db = seed();
  for (const [date, amount] of [['2024-01-15', 100], ['2024-02-15', 200], ['2024-03-15', 300]]) {
    db = entry(db, date, [{ account: '101401', debit: amount }, { account: '400000', credit: amount }]);
  }
  const current = { from: '2024-03-01', to: '2024-03-31' };
  const periods = [...comparePeriods(current, { count: 2, unit: 'month' }), current];
  assert.deepEqual(periods, [{ from: '2024-01-01', to: '2024-01-31' }, { from: '2024-02-01', to: '2024-02-29' }, current]);
  const report = compareProfitAndLoss(db, periods);
  assert.deepEqual(report.columns, periods);
  assert.deepEqual(row(report, 'net').values, [100, 200, 300]);
  assert.deepEqual(report.variance.find((r) => r.key === 'net'), { key: 'net', amount: 100, percent: 50 });
  assert.equal(report.variance.find((r) => r.key === 'expense').percent, null);
  assert.equal(compareProfitAndLoss(db, [current]).variance[0].amount, null);
  assert.deepEqual(compareProfitAndLoss(db, []).rows[0].values, []);
});

test('comparison periods preserve leap days, quarter boundaries and year boundaries', () => {
  assert.deepEqual(comparePeriods({ from: '2024-01-01', to: '2024-03-31' }, { count: 1, unit: 'quarter' }), [{ from: '2023-10-01', to: '2023-12-31' }]);
  assert.deepEqual(comparePeriods({ from: '2024-02-01', to: '2024-02-29' }, { count: 1, unit: 'year' }), [{ from: '2023-02-01', to: '2023-02-28' }]);
  assert.deepEqual(comparePeriods(period, { count: 0 }), []);
  assert.throws(() => comparePeriods(period, { count: -1 }), /valid comparison/);
  assert.throws(() => comparePeriods(period, { unit: 'week' }), /valid comparison/);
});

test('balance sheet comparisons expose assets, liabilities, equity and earnings with matching totals', () => {
  const { db, id } = year(business());
  const closed = closeFiscalYear(db, id);
  const dates = ['2024-01-01', '2024-06-30', period.to];
  const report = compareBalanceSheet(closed, dates);
  assert.deepEqual(report.columns, dates);
  assert.deepEqual(row(report, 'earnings').values, [0, 750, 0]);
  assert.deepEqual(row(report, 'equity').values, [0, 0, 750]);
  assert.deepEqual(row(report, 'totalAssets').values, row(report, 'liabilitiesEquity').values);
  assert.deepEqual(report.variance.find((r) => r.key === 'equity'), { key: 'equity', amount: 750, percent: null });
});

function foreign(moveType = 'out_invoice', amount = 100, db = seed()) {
  const currency = create(db, 'res.currency', { name: 'FX', rate_ids: [{ date: '2024-01-01', rate: 2 }, { date: '2024-02-01', rate: 1 }] });
  const invoice = create(currency.db, 'account.move', { move_type: moveType, partner_id: 1, currency_id: currency.id,
    invoice_date: '2024-01-15', invoice_line_ids: [{ name: 'Service', qty: 1, price_unit: amount, tax: 0 }] });
  return { db: postMove(invoice.db, invoice.id), id: invoice.id, currencyId: currency.id };
}

test('foreign invoices revalue residuals after rate changes with a balanced next-day reversal and idempotence', () => {
  const { db, id } = foreign();
  const snapshot = JSON.stringify(db);
  assert.deepEqual(unrealizedExchange(db, '2024-02-29'), [{ invoice_id: id, partner_id: 1,
    currency_id: read(db, 'account.move', id).currency_id, account: '121000', residual: 100, booked: 50, value: 100, difference: 50 }]);
  const done = revalueForeignBalances(db, '2024-02-29');
  assert.equal(JSON.stringify(db), snapshot);
  const adjustment = search(done, 'account.move').find((m) => m.revaluation_date === '2024-02-29');
  const reversal = read(done, 'account.move', adjustment.reversal_move_id);
  assert.ok(isBalanced(adjustment.line_ids));
  assert.ok(isBalanced(reversal.line_ids));
  assert.equal(reversal.invoice_date, '2024-03-01');
  assert.equal(adjustment.line_ids.find((l) => l.account_id === accountId(done, '450100')).credit, 50);
  assert.equal(adjustment.line_ids.find((l) => l.account_id === accountId(done, '121000')).debit, 50);
  assert.deepEqual(reversal.line_ids.map((l) => [l.account_id, l.debit, l.credit]), adjustment.line_ids.map((l) => [l.account_id, l.credit, l.debit]));
  assert.equal(revalueForeignBalances(done, '2024-02-29'), done);
  const withoutMetadata = write(done, 'account.move', adjustment.id, { revaluation_date: null, reversal_move_id: null });
  assert.equal(revalueForeignBalances(withoutMetadata, '2024-02-29'), withoutMetadata);
  assert.equal(read(done, 'account.move', id).amount_residual, 100);
  assert.equal(revalueForeignBalances(db, '2024-01-31'), db);
});

test('bills reverse the exchange sign and partial/future payments use their actual historical settlement amounts', () => {
  const invoice = foreign();
  const partial = payMove(invoice.db, invoice.id, 40, '2024-02-10');
  const outstanding = unrealizedExchange(partial, '2024-02-29')[0];
  assert.deepEqual([outstanding.residual, outstanding.booked, outstanding.value, outstanding.difference], [60, 30, 60, 30]);
  const settled = payMove(partial, invoice.id, 60, '2024-03-10');
  assert.deepEqual(unrealizedExchange(settled, '2024-02-29'), [outstanding]);
  assert.deepEqual(unrealizedExchange(settled, '2024-03-31'), []);
  const bill = foreign('in_invoice');
  const done = revalueForeignBalances(bill.db, '2024-02-29');
  const adjustment = search(done, 'account.move').find((m) => m.revaluation_date);
  assert.equal(adjustment.line_ids.find((l) => l.account_id === accountId(done, '211000')).credit, 50);
  assert.equal(adjustment.line_ids.find((l) => l.account_id === accountId(done, '650100')).debit, 50);
  assert.equal(read(done, 'account.account', accountId(done, '650100')).account_type, 'expense_other');
  assert.ok(isBalanced(adjustment.line_ids));
});

test('mixed receivables/payables share one adjustment; falling rates produce invoice losses and bill gains', () => {
  const invoice = foreign();
  const bill = foreign('in_invoice', 80, invoice.db);
  const changed = write(write(bill.db, 'res.currency', invoice.currencyId, { rate_ids: [{ date: '2024-01-01', rate: 2 }, { date: '2024-02-01', rate: 4 }] }),
    'res.currency', bill.currencyId, { rate_ids: [{ date: '2024-01-01', rate: 2 }, { date: '2024-02-01', rate: 4 }] });
  const done = revalueForeignBalances(changed, '2024-02-29');
  const adjustments = search(done, 'account.move').filter((m) => m.revaluation_date);
  assert.equal(adjustments.length, 1);
  assert.equal(adjustments[0].line_ids.find((l) => l.account_id === accountId(done, '450100')).credit, 20);
  assert.equal(adjustments[0].line_ids.find((l) => l.account_id === accountId(done, '650100')).debit, 25);
  assert.ok(isBalanced(adjustments[0].line_ids));
});

test('seed still loads with fiscal year metadata available and no seeded fiscal years', () => {
  const db = seed();
  assert.ok(search(db, 'account.move').length > 0);
  assert.deepEqual(search(db, 'account.fiscal.year'), []);
  assert.equal(closingModels['account.fiscal.year'].label, 'Fiscal Years');
});
