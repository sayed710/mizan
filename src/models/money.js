// Document currency: amounts of a record with a currency_id are in that currency, not the company's.
import { read } from '../orm.js';
import { toCompany } from './currency.js';
import { today } from './common.js';

const round = (n) => Math.round(n * 100) / 100;
const docDate = (rec) => rec.invoice_date ?? rec.date_order ?? rec.date ?? today();

/** ISO code of the record's own currency, or null when it is in the company currency. */
export const currencyCode = (db, rec) => (rec?.currency_id ? read(db, 'res.currency', rec.currency_id)?.name ?? null : null);

/** One amount of a record converted to the company currency at the document date. */
export const companyAmount = (db, rec, field) =>
  (rec?.currency_id ? toCompany(db, rec.currency_id, rec[field], docDate(rec)) : Number(rec?.[field]) || 0);

/** Sum of a monetary field over records in possibly different currencies, in the company currency. */
export const companySum = (db, recs, field) => round(recs.reduce((s, r) => s + companyAmount(db, r, field), 0));
