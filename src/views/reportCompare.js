import { balanceSheet, profitAndLoss } from '../models/ledger.js';
import { round } from '../money.js';

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const iso = (date) => date.toISOString().slice(0, 10);

/** Full calendar periods, oldest first; modes are none, previous, lastYear and last3. */
export function periodsFor(periodKey, mode, todayIso) {
  if (periodKey === 'all') return [{ from: '', to: '9999-12-31', label: 'All Dates' }];
  const unit = { month: 1, quarter: 3, year: 12 }[periodKey];
  const date = new Date(`${todayIso}T00:00:00Z`);
  if (!unit || !Number.isFinite(date.getTime()) || iso(date) !== todayIso) throw new Error('Choose a valid period and date');
  if (!['none', 'previous', 'lastYear', 'last3'].includes(mode)) throw new Error('Choose a valid comparison');
  const year = date.getUTCFullYear();
  const month = Math.floor(date.getUTCMonth() / unit) * unit;
  const offsets = { none: [0], previous: [-unit, 0], lastYear: [-12, 0], last3: [-2 * unit, -unit, 0] }[mode];
  return offsets.map((offset) => {
    const start = new Date(Date.UTC(year, month + offset, 1));
    const y = start.getUTCFullYear();
    const m = start.getUTCMonth();
    const label = periodKey === 'year' ? String(y) : periodKey === 'quarter' ? `Q${Math.floor(m / 3) + 1} ${y}` : `${months[m]} ${y}`;
    return { from: iso(start), to: iso(new Date(Date.UTC(y, m + unit, 0))), label };
  });
}

function columns(periods, reports, sectionDefs, totalDefs) {
  const sections = sectionDefs.map(([title, value, detail]) => {
    const lists = reports.map((r) => detail ? detail(r) : []);
    const accounts = new Map(lists.flat().map((r) => [r.account.id, r.account]));
    return {
      title, totals: reports.map(value),
      rows: [...accounts.values()].sort((a, b) => a.code.localeCompare(b.code)).map((account) => ({
        account, values: lists.map((rows) => rows.find((r) => r.account.id === account.id)?.balance ?? 0),
      })),
    };
  });
  const totals = totalDefs.map(([label, value, strong = false]) => ({ label, values: reports.map(value), strong }));
  // Variances follow sections, then totals, in their respective array order.
  const variance = [...sections.map((s) => s.totals), ...totals.map((r) => r.values)].map((values) => {
    const previous = values.at(-2);
    const amount = previous == null ? null : round(values.at(-1) - previous);
    return { amount, pct: amount == null || !previous ? null : round(amount / Math.abs(previous) * 100) };
  });
  return { headers: periods.map((p) => p.label), sections, totals, variance };
}

/** P&L sections and totals with account detail aligned across calendar periods. */
export function pnlColumns(db, periods) {
  return columns(periods, periods.map((p) => profitAndLoss(db, p)), [
    ['Revenue', (p) => p.revenue, (p) => p.detail.revenue],
    ['Cost of Revenue', (p) => p.cost, (p) => p.detail.cost],
    ['Expenses', (p) => p.expense, (p) => p.detail.expense],
    ['Other Income', (p) => p.otherIncome],
    ['Other Expenses', (p) => p.otherExpense],
  ], [
    ['Gross Profit', (p) => p.gross], ['Net Operating Income', (p) => p.operating], ['Net Income', (p) => p.net, true],
  ]);
}

/** Cumulative balance sheets at each period end, retaining the displayed equity split. */
export function balanceColumns(db, periods) {
  return columns(periods, periods.map((p) => balanceSheet(db, p.to)), [
    ['Assets', (b) => b.totalAssets, (b) => b.assets],
    ['Liabilities', (b) => b.totalLiabilities, (b) => b.liabilities],
    ['Equity', (b) => round(b.totalEquity - b.earnings), (b) => b.equity],
    ['Current Year Earnings', (b) => b.earnings],
  ], [
    ['Total Assets', (b) => b.totalAssets, true], ['Liabilities + Equity', (b) => round(b.totalLiabilities + b.totalEquity), true],
  ]);
}
