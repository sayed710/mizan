// Canonical audit-trail scope constants and message-classification predicate.

/** Models tracked by the Accounting Audit Trail. */
export const AUDIT_MODELS = ['account.move', 'account.payment', 'account.account', 'account.tax', 'res.company'];

/** Lock-date fields tracked on res.company. */
export const LOCK_DATE_FIELDS = ['lock_date', 'sale_lock_date', 'purchase_lock_date', 'tax_lock_date', 'hard_lock_date'];

/**
 * Canonical message kind: anything other than `'note'` is treated as `'tracking'`.
 * @param {any} kind
 * @returns {'note' | 'tracking'}
 */
export const messageKind = (kind) => (kind === 'note' ? 'note' : 'tracking');

/** Whether a `res.company` tracking message modifies a tracked lock-date field (legacy entries without `field` stay covered). */
const isProtectedCompanyTracking = (msg) =>
  messageKind(msg.kind) === 'tracking' && (msg.field ? LOCK_DATE_FIELDS.includes(msg.field) : true);

/**
 * Whether a chatter/tracking message belongs to the financial Audit Trail (tracking events only).
 * @param {any} msg
 * @returns {boolean}
 */
export function isAuditTrackingMessage(msg) {
  if (!msg || !AUDIT_MODELS.includes(msg.model) || messageKind(msg.kind) !== 'tracking') return false;
  return msg.model === 'res.company' ? isProtectedCompanyTracking(msg) : true;
}

/**
 * Whether a chatter/tracking message is protected from client-side removal during sync.
 * Keeps all messages on core financial models protected, plus lock-date tracking on `res.company`.
 * @param {any} msg
 * @returns {boolean}
 */
export function isProtectedAuditMessage(msg) {
  if (!msg || !AUDIT_MODELS.includes(msg.model)) return false;
  return msg.model === 'res.company' ? isProtectedCompanyTracking(msg) : true;
}
