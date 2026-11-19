import { read, write } from '../src/orm.js';
import { addDays, shiftMonth, today } from '../src/models/common.js';
import { companyCurrencyRecord } from '../src/money.js';
import { upsertCurrencyRates } from '../src/models/currency.js';

export const ECB_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';

function fail(message) {
  throw new Error(message);
}

/** Parse ECB daily XML into { date, rates } with rates relative to EUR (EUR = 1.0). */
export function parseEcbXml(xml) {
  if (typeof xml !== 'string' || !xml) fail('Invalid ECB XML feed: empty response');
  let date = null;
  const timeMatch = xml.match(/<Cube[^>]*\stime=['"](\d{4}-\d{2}-\d{2})['"]/i);
  if (timeMatch) date = timeMatch[1];

  const rates = { EUR: 1.0 };
  const cubeRegex = /<Cube\s+([^>]+)\/>/gi;
  let match;
  while ((match = cubeRegex.exec(xml)) !== null) {
    const attrs = match[1];
    const currMatch = attrs.match(/currency=['"]([A-Za-z]{3})['"]/i);
    const rateMatch = attrs.match(/rate=['"]([0-9.]+)['"]/i);
    if (currMatch && rateMatch) {
      const rateVal = Number(rateMatch[1]);
      if (Number.isFinite(rateVal) && rateVal > 0) {
        rates[currMatch[1].toUpperCase()] = rateVal;
      }
    }
  }
  return { date, rates };
}

/**
 * Convert EUR-based rates to the company currency:
 * rate of currency X in terms of 1 unit of company currency (rateAt convention).
 */
export function convertRatesToCompanyCurrency(ecbRates, companyCurrencyCode) {
  if (!ecbRates || typeof ecbRates !== 'object') fail('Invalid ECB rates');
  const code = (companyCurrencyCode || '').toUpperCase();
  const compRateInEur = ecbRates[code];
  if (compRateInEur == null || !Number.isFinite(compRateInEur) || compRateInEur <= 0) {
    fail(`Company currency ${code} is not in the ECB feed`);
  }
  const out = {};
  for (const [curr, eurRate] of Object.entries(ecbRates)) {
    if (Number.isFinite(eurRate) && eurRate > 0) {
      out[curr] = eurRate / compRateInEur;
    }
  }
  return out;
}

/** Advance a date string by the company currency interval unit. */
export function advanceExecutionDate(date, intervalUnit) {
  if (!date) return today();
  switch (intervalUnit) {
    case 'daily':
      return addDays(date, 1);
    case 'weekly':
      return addDays(date, 7);
    case 'monthly':
      return shiftMonth(date, 1);
    default:
      return date;
  }
}

/**
 * Fetch ECB rates and upsert them for a specific company into res.currency.rate.
 */
export async function updateCompanyCurrencyRates(db, companyId, { fetchFn = globalThis.fetch, date = null } = {}) {
  const company = read(db, 'res.company', companyId);
  if (!company) fail(`Company ${companyId} not found`);
  const companyCurrency = companyCurrencyRecord(db, companyId);
  if (!companyCurrency) fail(`Company currency for company ${companyId} is not configured`);

  const { date: feedDate, rates: ecbRates } = await fetchEcbRates(fetchFn);
  const companyRates = convertRatesToCompanyCurrency(ecbRates, companyCurrency.name);
  const rateDate = date ?? feedDate ?? today();

  const nextDb = upsertCurrencyRates(db, companyRates, { date: rateDate, companyId });
  return { db: nextDb, date: rateDate, rates: companyRates };
}

/** Fetch and parse ECB rates. */
export async function fetchEcbRates(fetchFn = globalThis.fetch) {
  const res = await fetchFn(ECB_URL);
  if (!res.ok) {
    fail(`Failed to fetch ECB rates: ${res.status} ${res.statusText}`);
  }
  const xml = await res.text();
  return parseEcbXml(xml);
}

/**
 * Periodic scheduled job runner: updates rates for all companies with due execution dates.
 */
export async function updateDueCurrencyRates(store, { fetchFn = globalThis.fetch, todayDate = today(), log = console.error } = {}) {
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
      if (typeof log === 'function') {
        log('error', `scheduled currency rates update failed for company ${company.name || company.id}`, { error: e });
      } else {
        console.error(`Scheduled currency rates update failed for company ${company.name || company.id}:`, e);
      }
    }
  }
}
