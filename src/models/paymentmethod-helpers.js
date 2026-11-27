import { read } from '../orm.js';

const METHOD_LINE_JOURNAL_TYPES = ['bank', 'cash'];

/** True when a journal (or journal type) supports payment method lines (bank or cash). */
export const isMethodLineJournal = (journalOrType) =>
  METHOD_LINE_JOURNAL_TYPES.includes(typeof journalOrType === 'string' ? journalOrType : journalOrType?.type);

/** Validate partner preferred payment method line references for ORM and diff+sync. */
export function preferredPaymentMethodLineError(db, partner, fields = null) {
  if (!db || !partner) return null;
  const fieldSet = fields ? new Set(fields) : null;
  for (const [field, direction] of [
    ['property_inbound_payment_method_line_id', 'inbound'],
    ['property_outbound_payment_method_line_id', 'outbound'],
  ]) {
    if (fieldSet && !fieldSet.has(field)) continue;
    const lineId = partner[field];
    if (lineId == null || lineId === '') continue;
    const line = read(db, 'account.payment.method.line', lineId);
    if (!line || line.active === false) return 'Select an active payment method';
    if (line.payment_type !== direction) {
      return direction === 'inbound'
        ? 'Customer preferred payment method must be inbound'
        : 'Vendor preferred payment method must be outbound';
    }
    if (partner.company_id && line.company_id && line.company_id !== partner.company_id) {
      return 'Preferred payment method must belong to the partner company';
    }
    if (line.journal_id) {
      const journal = read(db, 'account.journal', line.journal_id);
      if (!journal || journal.active === false || !isMethodLineJournal(journal)) {
        return 'Select an active payment method';
      }
      if (partner.company_id && journal.company_id && journal.company_id !== partner.company_id) {
        return 'Preferred payment method must belong to the partner company';
      }
    }
  }
  return null;
}
