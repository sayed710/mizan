// Document amounts are booked in their own company's currency, then translated into the active reporting currency.
import { read } from '../orm.js';
import { today } from './common.js';
import { companyCurrencyRecord, roundCurrency } from '../money.js';
import { companyCurrency, conversionRate } from './currency.js';
const docDate = (rec) => rec.invoice_date ?? rec.date_order ?? rec.date ?? today();
export const currencyCode = (db, rec) => (rec?.currency_id ? read(db, 'res.currency', rec.currency_id)?.name ?? null : null);

/** True when more than one currency is active in the database. */
export const hasMultiCurrency = (db) => (db?.records?.['res.currency'] ?? []).filter((c) => c.active !== false).length > 1;

export function reportingValue(db, rec, amount, at = today(), { companyBooked = false } = {}) {
  if (amount == null) return null;
  const own = companyCurrency(db, rec?.company_id);
  const target = companyCurrency(db, db.settings?.current_company_id);
  let booked = amount;
  if (!companyBooked && rec.currency_id && rec.currency_id !== own) {
    const rate = conversionRate(db, rec.currency_id, own, docDate(rec), rec.company_id ?? 1);
    if (rate == null) return null;
    booked = roundCurrency(amount * rate, companyCurrencyRecord(db, rec.company_id));
  }
  if (own === target) return booked;
  const rate = conversionRate(db, own, target, at, db.settings?.current_company_id ?? 1);
  return rate == null ? null : roundCurrency(booked * rate, companyCurrencyRecord(db, db.settings?.current_company_id));
}

export const unrated = (db, rec, at = today(), { companyBooked = false, field = null } = {}) =>
  (companyBooked && field && rec?.[field] == null) || reportingValue(db, rec, 1, at, { companyBooked }) == null;
/** Translate an amount already booked in its company's currency at its accounting date; null without a rate. */
export function reportingBookedOrNull(db, rec, amount) {
  const date = rec?.date ?? rec?.invoice_date;
  if (!date) throw new Error('An accounting date is required for currency conversion');
  const companyId = rec.company_id ?? 1;
  const reportingId = db.settings?.current_company_id ?? 1;
  // A company's own books are already in the reporting currency; no second currency needs to be configured.
  if (companyId === reportingId) return Number(amount) || 0;
  const own = companyCurrencyRecord(db, companyId);
  const target = companyCurrencyRecord(db, reportingId);
  if (own.id === target.id) return Number(amount) || 0;
  const rate = conversionRate(db, own.id, target.id, date, reportingId);
  return rate == null ? null : roundCurrency((Number(amount) || 0) * rate, target);
}
/** Translate an amount already booked in its company's currency at its accounting date. */
export function reportingBookedAmount(db, rec, amount) {
  const value = reportingBookedOrNull(db, rec, amount);
  if (value == null) {
    const own = companyCurrencyRecord(db, rec.company_id ?? 1);
    const target = companyCurrencyRecord(db, db.settings?.current_company_id ?? 1);
    throw new Error(`Configure an exchange rate for ${own.name} and ${target.name} on or before ${rec.date ?? rec.invoice_date}`);
  }
  return value;
}
export const companyAmount = (db, rec, field, at = today(), { companyBooked = false } = {}) => {
  const raw = rec?.[field];
  if (companyBooked && raw == null) return 0;
  return reportingValue(db, rec, Number(raw) || 0, at, { companyBooked }) ?? 0;
};
export const companySum = (db, recs, field, at = today(), opts = {}) => roundCurrency(recs.reduce((s, r) => s + companyAmount(db, r, field, at, opts), 0), companyCurrencyRecord(db, db.settings?.current_company_id));
export const unratedCount = (db, recs, at = today(), opts = {}) => recs.filter((r) => unrated(db, r, at, opts)).length;
