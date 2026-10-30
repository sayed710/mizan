import { createElement } from 'react';

export const DEFAULT_REPORT_PERIOD = 'year';

/** Reports remount when the selected report changes, resetting its filters. */
export function reportPage(leaf, component) {
  return createElement(component, { key: leaf.report, leaf });
}
