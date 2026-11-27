import { createElement } from 'react';
import { addUtcDays, daysInMonth, today, validDate } from '../models/common.js';
import { fiscalYearDates } from '../models/ledger.js';

export const DEFAULT_REPORT_PERIOD = 'year';

let reportDbProvider = () => null;

/** Register the active database reader so zero-arg PERIODS callers pick up company fiscal settings. */
export function setReportDbProvider(provider) {
  reportDbProvider = typeof provider === 'function' ? provider : () => null;
}

/** Validate a custom report period range (From/To); returns an English error message or null when valid. */
export function customPeriodError(periodKey, period, { requireFrom = false } = {}) {
  if (periodKey !== 'custom') return null;
  const from = period?.from;
  const to = period?.to;
  // An empty From means "from the beginning" (as-of reports, statements opened from aged balances),
  // unless comparison periods must shift a bounded range.
  if (requireFrom && !from) return to ? 'Enter a From date' : 'Enter both From and To dates';
  if (!to) return 'Enter a To date';
  if ((from && !validDate(from)) || !validDate(to)) return 'Enter valid From and To dates';
  if (from && from > to) return 'From date cannot be after To date';
  return null;
}

const addMonthsClamped = (date, months) => {
  const [y0, m0, d0] = date.split('-').map(Number);
  const target = new Date(Date.UTC(y0, m0 - 1 + months, 1));
  const y = target.getUTCFullYear();
  const m = target.getUTCMonth() + 1;
  return `${y}-${String(m).padStart(2, '0')}-${String(Math.min(d0, daysInMonth(y, m))).padStart(2, '0')}`;
};

function fiscalQuarterRange(db, date, companyId) {
  const fy = fiscalYearDates(db, date, companyId);
  for (let k = 0; ; k++) {
    const from = k === 0 ? fy.from : addMonthsClamped(fy.from, k * 3);
    if (from > fy.to) break;
    const nextFrom = addMonthsClamped(fy.from, (k + 1) * 3);
    const to = nextFrom <= fy.to ? addUtcDays(nextFrom, -1) : fy.to;
    if (from <= date && date <= to) return { from, to };
  }
  return fy;
}

function stepRange(initialRange, offset, computeAtDate) {
  let range = initialRange;
  for (let i = 0; i < -offset; i++) range = computeAtDate(addUtcDays(range.from, -1));
  for (let i = 0; i < offset; i++) range = computeAtDate(addUtcDays(range.to, 1));
  return range;
}

/**
 * Canonical fiscal-year-aware report preset range ({ from, to }).
 * Reuses `fiscalYearDates` for company fiscal settings and supports stepping `offset` periods back/forward.
 */
export function reportPeriodRange(db, periodKey, { companyId = null, date = today(), offset = 0 } = {}) {
  if (periodKey === 'all') return { from: '', to: '9999-12-31' };
  const refDate = date || today();
  if (!validDate(refDate)) throw new Error('Enter a valid date');
  const steps = Number.isInteger(offset) ? offset : 0;
  const resolvedCompanyId = companyId != null && companyId !== '' && companyId !== 'all'
    ? Number(companyId)
    : (db?.settings?.current_company_id ?? 1);
  if (periodKey === 'month') {
    const [y0, m0] = refDate.split('-').map(Number);
    const d = new Date(Date.UTC(y0, m0 - 1 + steps, 1));
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;
    const mm = String(m).padStart(2, '0');
    return { from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(daysInMonth(y, m)).padStart(2, '0')}` };
  }
  if (periodKey === 'quarter') {
    return stepRange(fiscalQuarterRange(db, refDate, resolvedCompanyId), steps, (d) => fiscalQuarterRange(db, d, resolvedCompanyId));
  }
  if (periodKey === 'year') {
    return stepRange(fiscalYearDates(db, refDate, resolvedCompanyId), steps, (d) => fiscalYearDates(db, d, resolvedCompanyId));
  }
  throw new Error('Choose a valid period');
}

/** Standard accounting period presets shared across statement and analysis views. */
export const PERIODS = {
  month: (db = reportDbProvider(), companyId = null, opts = {}) => reportPeriodRange(db, 'month', { companyId, ...opts }),
  quarter: (db = reportDbProvider(), companyId = null, opts = {}) => reportPeriodRange(db, 'quarter', { companyId, ...opts }),
  year: (db = reportDbProvider(), companyId = null, opts = {}) => reportPeriodRange(db, 'year', { companyId, ...opts }),
  all: (db = reportDbProvider(), companyId = null, opts = {}) => reportPeriodRange(db, 'all', { companyId, ...opts }),
};

/** Reports remount when the selected report changes, resetting its filters. */
export function reportPage(leaf, component, params) {
  return createElement(component, { key: `${leaf.report}:${params?.toString() ?? ''}`, leaf, params });
}

/** Update a query parameter on the current report route in location.hash without a hash navigation that remounts the view. */
export function updateReportParam(key, value, leaf) {
  if (typeof location === 'undefined') return;
  const rawHash = location.hash || '';
  const [hashPath, query = ''] = rawHash.replace(/^#\/?/, '').split('?');
  const path = hashPath || `accounting/${leaf?.key ?? 'partner-ledger'}`;
  const searchParams = new URLSearchParams(query);
  if (value == null) searchParams.delete(key);
  else searchParams.set(key, value);
  const q = searchParams.toString();
  const nextHash = `#/${path}${q ? `?${q}` : ''}`;
  let replaced = false;
  if (typeof history !== 'undefined' && typeof history.replaceState === 'function') {
    try {
      history.replaceState(history.state, '', nextHash);
      replaced = true;
    } catch {
      replaced = false;
    }
  }
  if (!replaced || location.hash !== nextHash) {
    if (typeof location.replace === 'function') {
      try {
        location.replace(nextHash);
      } catch {
        location.hash = nextHash;
      }
    } else {
      location.hash = nextHash;
    }
  }
}
