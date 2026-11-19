import { balanceSheet, journalItems, profitAndLoss } from '../models/ledger.js';
import { cashFlow, reportReviewMode } from '../models/reports.js';
import { round } from '../money.js';
import { groupBuckets, targetCompanyIds } from '../models/configurableReports.js';
import { shiftMonth, validDate } from '../models/common.js';

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const iso = (date) => date.toISOString().slice(0, 10);
const addUtcDays = (isoStr, days) => {
  const date = new Date(`${isoStr}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return iso(date);
};
const isMonthEnd = (isoStr) => {
  const date = new Date(`${isoStr}T00:00:00Z`);
  return iso(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0))) === isoStr;
};

/** Parse selected numeric IDs from a multi-select change event (with single-value fallback). */
export const selectedOptionIds = (event) => (
  event?.target?.selectedOptions
    ? Array.from(event.target.selectedOptions).map((o) => Number(o.value)).filter((id) => Number.isSafeInteger(id) && id > 0)
    : (event?.target?.value ? [Number(event.target.value)].filter((id) => Number.isSafeInteger(id) && id > 0) : [])
);

/** Horizontal groups are defined only for the balance sheet and profit and loss comparisons. */
export const supportsHorizontalGroupComparison = (report) => ['pnl', 'balance'].includes(report);

function customRangePeriods(from, to, mode) {
  if (!validDate(from) || !validDate(to) || from > to) throw new Error('Choose a valid period and date');
  if (!['none', 'previous', 'lastYear', 'last3'].includes(mode)) throw new Error('Choose a valid comparison');
  const fmt = (f, t) => ({ from: f, to: t, label: `${f} → ${t}` });
  if (mode === 'none') return [fmt(from, to)];
  if (mode === 'lastYear') return [fmt(shiftMonth(from, -12), shiftMonth(to, -12)), fmt(from, to)];
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  const wholeMonths = start.getUTCDate() === 1 && isMonthEnd(to)
    ? (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + (end.getUTCMonth() - start.getUTCMonth()) + 1
    : null;
  const spanDays = Math.round((end - start) / 864e5) + 1;
  const shiftBack = (steps) => {
    if (steps === 0) return fmt(from, to);
    if (wholeMonths) {
      const s = shiftMonth(from, -steps * wholeMonths);
      const sYear = Number(s.slice(0, 4));
      const sMonth = Number(s.slice(5, 7)) - 1;
      return fmt(s, iso(new Date(Date.UTC(sYear, sMonth + wholeMonths, 0))));
    }
    const pTo = addUtcDays(from, -((steps - 1) * spanDays + 1));
    return fmt(addUtcDays(pTo, -(spanDays - 1)), pTo);
  };
  return (mode === 'previous' ? [1, 0] : [2, 1, 0]).map(shiftBack);
}

/** Full calendar or custom periods, oldest first; modes are none, previous, lastYear and last3. */
export function periodsFor(periodKey, mode, anchor) {
  if (periodKey === 'all') return [{ from: '', to: '9999-12-31', label: 'All Dates' }];
  if (periodKey === 'custom') {
    const from = typeof anchor === 'object' && anchor !== null ? anchor.from : anchor;
    const to = typeof anchor === 'object' && anchor !== null ? anchor.to : anchor;
    return customRangePeriods(from, to, mode);
  }
  const anchorIso = typeof anchor === 'object' && anchor !== null ? (anchor.to || anchor.from || '') : anchor;
  const unit = { month: 1, quarter: 3, year: 12 }[periodKey];
  const date = new Date(`${anchorIso}T00:00:00Z`);
  if (!unit || !Number.isFinite(date.getTime()) || iso(date) !== anchorIso) throw new Error('Choose a valid period and date');
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

function columns(periods, reports, sectionDefs, totalDefs, { showVariance = true } = {}) {
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
  const variance = showVariance ? [...sections.map((s) => s.totals), ...totals.map((r) => r.values)].map((values) => {
    const previous = values.at(-2);
    const amount = previous == null ? null : round(values.at(-1) - previous);
    return { amount, pct: amount == null || !previous ? null : round(amount / Math.abs(previous) * 100) };
  }) : null;
  return { headers: periods.map((p) => p.label), sections, totals, variance };
}

const PNL_SECTIONS = [
  ['Revenue', (p) => p.revenue, (p) => p.detail.revenue],
  ['Cost of Revenue', (p) => p.cost, (p) => p.detail.cost],
  ['Expenses', (p) => p.expense, (p) => p.detail.expense],
  ['Other Income', (p) => p.otherIncome, (p) => p.detail.otherIncome],
  ['Other Expenses', (p) => p.otherExpense, (p) => p.detail.otherExpense],
];

const PNL_TOTALS = [
  ['Gross Profit', (p) => p.gross], ['Net Operating Income', (p) => p.operating], ['Net Income', (p) => p.net, true],
];

const BALANCE_SECTIONS = [
  ['Assets', (b) => b.totalAssets, (b) => b.assets],
  ['Liabilities', (b) => b.totalLiabilities, (b) => b.liabilities],
  ['Equity', (b) => round(b.totalEquity - b.earnings), (b) => b.equity],
  ['Current Year Earnings', (b) => b.earnings],
];

const BALANCE_TOTALS = [
  ['Total Assets', (b) => b.totalAssets, true], ['Liabilities + Equity', (b) => round(b.totalLiabilities + b.totalEquity), true],
];

const modeFilterFor = (reviewMode, includeUnposted) => {
  if (reviewMode == null && !includeUnposted) return {};
  return { reviewMode: reportReviewMode({ reviewMode, includeUnposted }) };
};
const hasCompanyRule = (group) => (group?.rule_ids ?? []).some((rule) => rule.field === 'company');

/** P&L sections and totals with account detail aligned across calendar periods. */
export function pnlColumns(db, periods, { analyticAccountIds, includeUnposted, reviewMode } = {}) {
  const modeFilter = modeFilterFor(reviewMode, includeUnposted);
  return columns(periods, periods.map((p) => profitAndLoss(db, { ...p, ...modeFilter }, { analyticAccountIds })), PNL_SECTIONS, PNL_TOTALS);
}

/** Cumulative balance sheets at each period end, retaining the displayed equity split. */
export function balanceColumns(db, periods, { analyticAccountIds, includeUnposted, reviewMode } = {}) {
  const modeFilter = modeFilterFor(reviewMode, includeUnposted);
  return columns(periods, periods.map((p) => balanceSheet(db, { to: p.to, ...modeFilter }, { analyticAccountIds })), BALANCE_SECTIONS, BALANCE_TOTALS);
}

/** Horizontal comparison columns partitioned by a horizontal group for Profit & Loss. */
export function pnlAnalyticColumns(db, group, period, { analyticAccountIds, includeUnposted, reviewMode } = {}) {
  const allowedCompanies = hasCompanyRule(group) ? new Set(targetCompanyIds(db, { company_id: group?.company_id ?? 1 }, group)) : null;
  const scopedDb = allowedCompanies
    ? { ...db, records: { ...db.records, 'account.move': (db.records?.['account.move'] ?? []).filter((m) => allowedCompanies.has(m.company_id ?? 1)) } }
    : db;
  const companyFilter = hasCompanyRule(group) ? {} : { company_id: group?.company_id ?? period?.company_id ?? 1 };
  const filter = { ...period, ...companyFilter, ...modeFilterFor(reviewMode, includeUnposted) };
  const buckets = groupBuckets(scopedDb, group, journalItems(scopedDb, filter), { analyticAccountIds });
  return columns(buckets, buckets.map((b) => profitAndLoss(scopedDb, filter, { weight: b.weight, analyticAccountIds })), PNL_SECTIONS, PNL_TOTALS, { showVariance: false });
}

/** Horizontal comparison columns partitioned by a horizontal group for the Balance Sheet. */
export function balanceAnalyticColumns(db, group, period, { analyticAccountIds, includeUnposted, reviewMode } = {}) {
  const periodObj = typeof period === 'object' && period !== null ? period : null;
  const allowedCompanies = hasCompanyRule(group) ? new Set(targetCompanyIds(db, { company_id: group?.company_id ?? 1 }, group)) : null;
  const scopedDb = allowedCompanies
    ? { ...db, records: { ...db.records, 'account.move': (db.records?.['account.move'] ?? []).filter((m) => allowedCompanies.has(m.company_id ?? 1)) } }
    : db;
  const companyFilter = hasCompanyRule(group) ? {} : { company_id: group?.company_id ?? periodObj?.company_id ?? 1 };
  const filter = {
    to: periodObj ? periodObj.to : period,
    ...companyFilter,
    ...modeFilterFor(reviewMode, includeUnposted),
  };
  const buckets = groupBuckets(scopedDb, group, journalItems(scopedDb, filter), { analyticAccountIds });
  return columns(buckets, buckets.map((b) => balanceSheet(scopedDb, filter, { weight: b.weight, analyticAccountIds })), BALANCE_SECTIONS, BALANCE_TOTALS, { showVariance: false });
}

const cashLines = (section) => (c) => c.lines.filter((l) => l.section === section).map((l) => ({ account: l.account, balance: l.amount }));
const CASHFLOW_SECTIONS = [['operating', 'Operating Activities'], ['investing', 'Investing Activities'], ['financing', 'Financing Activities'], ['unclassified', 'Unclassified']]
  .map(([section, title]) => [title, (c) => c[section], cashLines(section)]);
const CASHFLOW_TOTALS = [
  ['Net Change in Cash', (c) => c.net], ['Cash at Beginning', (c) => c.opening], ['Cash at End', (c) => c.closing, true],
];

/** Cash flow statement per calendar period, activity lines aligned by account. */
export function cashflowColumns(db, periods, { analyticAccountIds, company_id, includeUnposted, reviewMode, docDb, unfilteredDb } = {}) {
  return columns(periods, periods.map((p) => cashFlow(db, { ...p, company_id, analyticAccountIds, includeUnposted, reviewMode, docDb, unfilteredDb })), CASHFLOW_SECTIONS, CASHFLOW_TOTALS);
}
