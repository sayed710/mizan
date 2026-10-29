import { t } from '../i18n.js';

/** Visible on every incomplete reporting-currency aggregate, not only in a hover tooltip. */
export function RateNote({ count }) {
  return count ? <small className="muted" role="note">{t('includes {n} items without a rate', { n: count })}</small> : null;
}
