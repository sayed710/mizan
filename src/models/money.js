// Document currency: amounts of a record with a currency_id are in that currency, not the company's.
import { read } from '../orm.js';
import { toCompany } from './currency.js';
import { today } from './common.js';

const round = (n) => Math.round(n * 100) / 100;
const docDate = (rec) => rec.invoice_date ?? rec.date_order ?? rec.date ?? today();

/** ISO code of the record's own currency, or null when it is in the company currency. */
export const currencyCode = (db, rec) => (rec?.currency_id ? read(db, 'res.currency', rec.currency_id)?.name ?? null : null);

/** The currency record id of the company a document belongs to (the settings currency code when there are no companies). */
function ownCurrencyId(db, rec) {
  const company = read(db, 'res.company', rec.company_id ?? 1);
  if (company?.currency_id) return company.currency_id;
  return (db.records['res.currency'] ?? []).find((c) => c.name === db.settings?.currency)?.id ?? null;
}

/** True when the record is in a foreign currency that has no usable rate, so it cannot be converted. */
export const unrated = (db, rec) => {
  if (!rec?.currency_id || rec.currency_id === ownCurrencyId(db, rec)) return false;
  return !(read(db, 'res.currency', rec.currency_id)?.rate_ids ?? []).some((r) => Number(r.rate) > 0);
};

/**
 * One amount of a record converted to the company currency at the document date. A document already in its own
 * company's currency is not revalued; one in a currency with no rate counts as 0 (see `unrated`), never as 1:1.
 */
export const companyAmount = (db, rec, field) => {
  if (!rec?.currency_id || rec.currency_id === ownCurrencyId(db, rec)) return Number(rec?.[field]) || 0;
  return unrated(db, rec) ? 0 : toCompany(db, rec.currency_id, rec[field], docDate(rec));
};

/** Sum of a monetary field over records in possibly different currencies, in the company currency. */
export const companySum = (db, recs, field) => round(recs.reduce((s, r) => s + companyAmount(db, r, field), 0));

/** How many of the records are left out of a company-currency total for lack of an exchange rate. */
export const unratedCount = (db, recs) => recs.filter((r) => unrated(db, r)).length;
