// Document amounts are booked in their own company's currency, then translated into the active reporting currency.
import { read } from '../orm.js';
import { today } from './common.js';
import { companyCurrencyRecord, roundCurrency } from '../money.js';
import { conversionRate } from './currency.js';
const docDate = (rec) => rec.invoice_date ?? rec.date_order ?? rec.date ?? today();
export const currencyCode = (db, rec) => (rec?.currency_id ? read(db, 'res.currency', rec.currency_id)?.name ?? null : null);

function ownCurrencyId(db, rec) {
  const company = read(db, 'res.company', rec.company_id ?? 1);
  if (!company?.currency_id || !read(db, 'res.currency', company.currency_id)) throw new Error(`Company ${company?.name ?? rec.company_id ?? 1} requires a configured currency`);
  return company.currency_id;
}

const reportingCurrency = (db) => ownCurrencyId(db, { company_id: db.settings?.current_company_id ?? 1 });

function reportingValue(db, rec, amount, at) {
  const own = ownCurrencyId(db, rec), target = reportingCurrency(db);
  let booked = amount;
  if (rec.currency_id && rec.currency_id !== own) {
    const rate = conversionRate(db, rec.currency_id, own, docDate(rec), rec.company_id ?? 1);
    if (rate == null) return null;
    booked = roundCurrency(amount * rate, companyCurrencyRecord(db, rec.company_id));
  }
  if (own === target) return booked;
  const rate = conversionRate(db, own, target, at, db.settings?.current_company_id ?? 1);
  return rate == null ? null : roundCurrency(booked * rate, companyCurrencyRecord(db, db.settings?.current_company_id));
}

export const unrated = (db, rec, at = today()) => reportingValue(db, rec, 1, at) == null;
/** Translate an amount already booked in its company's currency at its accounting date. */
export function reportingBookedAmount(db, rec, amount) {
  const date = rec?.date ?? rec?.invoice_date;
  if (!date) throw new Error('An accounting date is required for currency conversion');
  const companyId = rec.company_id ?? 1;
  const reportingId = db.settings?.current_company_id ?? 1;
  const own = read(db, 'res.currency', ownCurrencyId(db, { company_id: companyId }));
  const target = read(db, 'res.currency', ownCurrencyId(db, { company_id: reportingId }));
  if (own.id === target.id) return Number(amount) || 0;
  const rate = conversionRate(db, own.id, target.id, date, reportingId);
  if (rate == null) throw new Error(`Configure an exchange rate for ${own.name} and ${target.name} on or before ${date}`);
  return roundCurrency((Number(amount) || 0) * rate, target);
}
export const companyAmount = (db, rec, field, at = today()) => reportingValue(db, rec, Number(rec?.[field]) || 0, at) ?? 0;
export const companySum = (db, recs, field, at = today()) => roundCurrency(recs.reduce((s, r) => s + companyAmount(db, r, field, at), 0), companyCurrencyRecord(db, db.settings?.current_company_id));
export const unratedCount = (db, recs, at = today()) => recs.filter((r) => unrated(db, r, at)).length;
