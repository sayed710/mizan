import { COUNTRY_DATA, CURRENCY_DATA, STATE_DATA } from './country-data.js';

// Legacy address fields are text; only an unambiguous exact name or code is a match.
export function countryIdFor(db, value) {
  if (Number.isInteger(value)) return (db.records['res.country'] ?? []).some((r) => r.id === value) ? value : null;
  const matches = (db.records['res.country'] ?? []).filter((r) => value && (r.name === value || r.code === value));
  return matches.length === 1 ? matches[0].id : null;
}

export function stateIdFor(db, value, countryId) {
  if (Number.isInteger(value)) return (db.records['res.country.state'] ?? []).some((r) => r.id === value && (countryId == null || r.country_id === countryId)) ? value : null;
  const matches = (db.records['res.country.state'] ?? []).filter((r) => (countryId == null || r.country_id === countryId) && value && (r.name === value || r.code === value));
  return matches.length === 1 ? matches[0].id : null;
}

export function countryReferenceError(db, record) {
  return record.country_id && !countryIdFor(db, record.country_id) ? 'Selected country does not exist' : null;
}

export function ensureCountries(db) {
  const countries = [...(db.records['res.country'] ?? [])];
  const states = [...(db.records['res.country.state'] ?? [])];
  const currencies = [...(db.records['res.currency'] ?? [])];
  let countrySeq = Math.max(db.seq?.['res.country'] ?? 0, 0, ...countries.map((r) => r.id));
  let stateSeq = Math.max(db.seq?.['res.country.state'] ?? 0, 0, ...states.map((r) => r.id));
  let currencySeq = Math.max(db.seq?.['res.currency'] ?? 0, 0, ...currencies.map((r) => r.id));
  const inactiveCurrencyBase = Math.max(currencySeq, 1000);
  const currencyIds = new Map();
  for (const [externalId, name, fullName, symbol, rounding, position] of CURRENCY_DATA) {
    let currency = currencies.find((r) => r.name === name);
    if (!currency) {
      currencySeq = Math.max(currencySeq, inactiveCurrencyBase) + 1;
      currency = { id: currencySeq, name, full_name: fullName, symbol, rounding, position, active: false, rate_ids: [] };
      currencies.push(currency);
    }
    currencyIds.set(externalId, currency.id);
  }
  for (const [name, code, currency, phone] of COUNTRY_DATA) {
    if (countries.some((r) => r.code === code)) continue;
    const currencyId = currencyIds.get(currency) ?? null;
    countries.push({ id: ++countrySeq, name, code, currency_id: currencyId, phone_code: phone });
  }
  for (const [name, code, countryCode] of STATE_DATA) {
    const countryId = countries.find((r) => r.code === countryCode)?.id;
    if (countryId && !states.some((r) => r.country_id === countryId && r.code === code)) states.push({ id: ++stateSeq, name, code, country_id: countryId });
  }
  return { ...db, records: { ...db.records, 'res.country': countries, 'res.country.state': states, 'res.currency': currencies }, seq: { ...db.seq, 'res.country': countrySeq, 'res.country.state': stateSeq, 'res.currency': currencySeq } };
}

export const countryModels = {
  'res.country': {
    label: 'Countries',
    fields: {
      name: { type: 'char', label: 'Name', required: true },
      code: { type: 'char', label: 'Code', required: true },
      currency_id: { type: 'many2one', relation: 'res.currency', label: 'Currency' },
      phone_code: { type: 'integer', label: 'Phone Code' },
    },
    searchFields: ['name', 'code'], list: ['name', 'code', 'currency_id', 'phone_code'],
    form: { title: 'name', groups: [['name', 'code'], ['currency_id', 'phone_code']] },
  },
  'res.country.state': {
    label: 'Federal States',
    guard: (db, _before, r) => (r.country_id && !(db.records['res.country'] ?? []).some((c) => c.id === r.country_id) ? 'Selected country does not exist' : null),
    fields: {
      name: { type: 'char', label: 'Name', required: true },
      code: { type: 'char', label: 'Code', required: true },
      country_id: { type: 'many2one', relation: 'res.country', label: 'Country', required: true },
    },
    searchFields: ['name', 'code'], list: ['name', 'code', 'country_id'],
    form: { title: 'name', groups: [['name', 'code', 'country_id']] },
  },
};
