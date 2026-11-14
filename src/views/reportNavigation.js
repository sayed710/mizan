import { createElement } from 'react';
import { today } from '../models/common.js';

export const DEFAULT_REPORT_PERIOD = 'year';

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
export function reportPage(leaf, component) {
  return createElement(component, { key: leaf.report, leaf });
}
