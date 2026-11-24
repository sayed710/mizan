import { createElement } from 'react';
import { today, validDate } from '../models/common.js';

export const DEFAULT_REPORT_PERIOD = 'year';

/** Validate a custom report period range (From/To); returns an English error message or null when valid. */
export function customPeriodError(periodKey, period) {
  if (periodKey !== 'custom') return null;
  const from = period?.from;
  const to = period?.to;
  // An empty From means "from the beginning" (as-of reports, statements opened from aged balances).
  if (!to) return 'Enter a To date';
  if ((from && !validDate(from)) || !validDate(to)) return 'Enter valid From and To dates';
  if (from && from > to) return 'From date cannot be after To date';
  return null;
}

const monthEnd = (y, m) => `${y}-${String(m).padStart(2, '0')}-${new Date(y, m, 0).getDate()}`;

/** Standard accounting period presets shared across statement and analysis views. */
export const PERIODS = {
  month: () => {
    const d = new Date();
    return { from: `${today().slice(0, 7)}-01`, to: monthEnd(d.getFullYear(), d.getMonth() + 1) };
  },
  quarter: () => {
    const d = new Date();
    const q = Math.floor(d.getMonth() / 3) * 3;
    return { from: `${d.getFullYear()}-${String(q + 1).padStart(2, '0')}-01`, to: monthEnd(d.getFullYear(), q + 3) };
  },
  year: () => ({ from: `${today().slice(0, 4)}-01-01`, to: `${today().slice(0, 4)}-12-31` }),
  all: () => ({ from: '', to: '9999-12-31' }),
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
