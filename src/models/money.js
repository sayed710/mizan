// Document amounts are booked in their own company's currency, then translated into the active reporting currency.
import { read } from '../orm.js';
import { today } from './common.js';

const round = (n) => Math.round(n * 100) / 100;
const docDate = (rec) => rec.invoice_date ?? rec.date_order ?? rec.date ?? today();
export const currencyCode = (db, rec) => (rec?.currency_id ? read(db, 'res.currency', rec.currency_id)?.name ?? null : null);

function ownCurrencyId(db, rec) {
  return read(db, 'res.company', rec.company_id ?? 1)?.currency_id
    ?? (db.records['res.currency'] ?? []).find((c) => c.name === db.settings?.currency)?.id ?? null;
}

const reportingCurrency = (db) => ownCurrencyId(db, { company_id: db.settings?.current_company_id ?? 1 });

/** Missing/future-only rates are unknown, never implicit 1:1; only the configured base currency has a unit rate. */
function baseRate(db, id, date) {
  const currency = read(db, 'res.currency', id);
  if (!currency) return null;
  if (currency.name === db.settings?.currency) return 1;
  const rate = (currency.rate_ids ?? []).filter((r) => r.date <= date && Number.isFinite(Number(r.rate)) && Number(r.rate) > 0)
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  return rate ? Number(rate.rate) : null;
}

function reportingValue(db, rec, amount, at) {
  const own = ownCurrencyId(db, rec), target = reportingCurrency(db);
  let booked = amount;
  if (rec.currency_id && rec.currency_id !== own) {
    const sourceRate = baseRate(db, rec.currency_id, docDate(rec)), ownRate = baseRate(db, own, docDate(rec));
    if (sourceRate === null || ownRate === null) return null;
    booked = round(amount * ownRate / sourceRate);
  }
  if (own === target) return booked;
  const ownRate = baseRate(db, own, at), targetRate = baseRate(db, target, at);
  return ownRate === null || targetRate === null ? null : round(booked * targetRate / ownRate);
}

export const unrated = (db, rec, at = today()) => reportingValue(db, rec, 1, at) === null;
export const companyAmount = (db, rec, field, at = today()) => reportingValue(db, rec, Number(rec?.[field]) || 0, at) ?? 0;
export const companySum = (db, recs, field, at = today()) => round(recs.reduce((s, r) => s + companyAmount(db, r, field, at), 0));
export const unratedCount = (db, recs, at = today()) => recs.filter((r) => unrated(db, r, at)).length;
