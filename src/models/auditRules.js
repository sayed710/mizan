// Canonical audit-trail scope constants and message-classification predicate.

/** Models tracked by the Accounting Audit Trail. */
export const AUDIT_MODELS = ['account.move', 'account.payment', 'account.account', 'account.tax', 'res.company'];

/** Lock-date fields tracked on res.company. */
export const LOCK_DATE_FIELDS = ['lock_date', 'sale_lock_date', 'purchase_lock_date', 'tax_lock_date', 'hard_lock_date'];

/**
 * Whether a chatter/tracking message belongs to the financial Audit Trail.
 * Legacy res.company tracking messages without `field` stay protected conservatively.
 * @param {any} msg
 * @returns {boolean}
 */
export function isAuditTrackingMessage(msg) {
  if (!msg || !AUDIT_MODELS.includes(msg.model)) return false;
  if (msg.model === 'res.company') {
    if (msg.kind !== 'tracking') return false;
    return msg.field ? LOCK_DATE_FIELDS.includes(msg.field) : true;
  }
  return true;
}
