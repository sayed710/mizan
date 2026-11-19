import { read, write } from '../src/orm.js';
import { today } from '../src/models/common.js';
import { companyCurrencyRecord } from '../src/money.js';
import { advanceExecutionDate, convertRatesToCompanyCurrency, parseEcbXml, upsertCurrencyRates } from '../src/models/currency.js';

export const ECB_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';

/** Fetch and parse ECB rates. */
export async function fetchEcbRates(fetchFn = globalThis.fetch) {
  const res = await fetchFn(ECB_URL);
  if (!res.ok) {
    const msg = `Failed to fetch ECB rates: ${res.status} ${res.statusText}`;
    throw new Error(msg);
  }
  const xml = await res.text();
  return parseEcbXml(xml);
}

/**
 * Fetch ECB rates and upsert them for a specific company into res.currency.rate.
 */
export async function updateCompanyCurrencyRates(db, companyId, { fetchFn = globalThis.fetch, date = null } = {}) {
  const company = read(db, 'res.company', companyId);
  if (!company) {
    const msg = `Company ${companyId} not found`;
    throw new Error(msg);
  }
  const companyCurrency = companyCurrencyRecord(db, companyId);
  if (!companyCurrency) {
    const msg = `Company currency for company ${companyId} is not configured`;
    throw new Error(msg);
  }

  const { date: feedDate, rates: ecbRates } = await fetchEcbRates(fetchFn);
  const companyRates = convertRatesToCompanyCurrency(ecbRates, companyCurrency.name);
  const rateDate = date ?? feedDate ?? today();

  const nextDb = upsertCurrencyRates(db, companyRates, { date: rateDate, companyId });
  return { db: nextDb, date: rateDate, rates: companyRates };
}

/**
 * Periodic scheduled job runner: updates rates for all companies with due execution dates.
 */
export async function updateDueCurrencyRates(store, { fetchFn = globalThis.fetch, todayDate = today(), log } = {}) {
  if (typeof log !== 'function') throw new TypeError('log function is required');
  const db = store.get();
  const dueCompanies = (db.records['res.company'] ?? []).filter((c) => (
    c.currency_provider === 'ecb'
    && c.currency_interval_unit
    && c.currency_interval_unit !== 'manually'
    && (!c.currency_next_execution_date || c.currency_next_execution_date <= todayDate)
  ));
  if (!dueCompanies.length) return;

  for (const company of dueCompanies) {
    try {
      const currentDb = store.get();
      const { db: updatedDb } = await updateCompanyCurrencyRates(currentDb, company.id, { fetchFn });
      const nextDate = advanceExecutionDate(todayDate, company.currency_interval_unit);
      const finalDb = write(updatedDb, 'res.company', company.id, {
        currency_next_execution_date: nextDate,
      });
      store.commit(finalDb);
    } catch (e) {
      log('error', `scheduled currency rates update failed for company ${company.name || company.id}`, { error: e });
    }
  }
}
