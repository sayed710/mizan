// Foreign currencies with dated rates; amounts convert to the company currency for the ledger.
import { read, write } from '../orm.js';
import { addDays, shiftMonth, today } from './common.js';
import { companyCurrencyRecord, currencyDecimalPlaces, findCompanyCurrencyRecord, roundCurrency } from '../money.js';


/** Units of `currencyId` per 1 base-currency unit on `date`: the latest configured rate on or before it. */
const applicableRate = (currency, date, companyId = null) => {
  const rows = (currency.rate_ids ?? []).filter((r) => Number.isFinite(Number(r.rate)) && Number(r.rate) > 0 && r.date && r.date <= date);
  const latest = (id) => rows.filter((r) => (id == null ? r.company_id == null : Number(r.company_id) === Number(id))).sort((a, b) => b.date.localeCompare(a.date))[0];
  return (companyId == null ? null : latest(companyId)) ?? latest(null);
};

// Raw lookup: read() would compute this currency's own rate fields, which call back into here.
const findBaseCurrency = (db) => (db?.settings?.base_currency_id ? (db.records?.['res.currency'] ?? []).find((c) => c.id === db.settings.base_currency_id) ?? null : null);

/** Base-relative rate and effective date for `currency` on `date`: the base currency is always 1 with no rate row. */
const baseRateInfo = (currency, date, baseId, companyId = null) => {
  if (currency.id === baseId) return { rate: 1, date: null };
  const row = applicableRate(currency, date, companyId);
  return row ? { rate: Number(row.rate), date: row.date } : { rate: null, date: null };
};

/** Effective rate and date today for `currency` in the current company, without throwing when unconfigured. */
function currentRateInfo(currency, db) {
  const companyId = db?.settings?.current_company_id ?? 1;
  const own = findCompanyCurrencyRecord(db, companyId);
  // The company currency is the unit of every rate: Odoo shows it at 1 with no rate date.
  if (own?.id === currency.id) return { rate: 1, date: null };
  const base = findBaseCurrency(db);
  const date = today();
  const { rate, date: rateDate } = baseRateInfo(currency, date, base?.id, companyId);
  if (rate == null) return { rate: null, date: null };
  if (!own || !base || own.id === base.id) return { rate, date: rateDate };
  const ownInfo = baseRateInfo(own, date, base.id, companyId);
  return ownInfo.rate ? { rate: rate / ownInfo.rate, date: rateDate } : { rate: null, date: null };
}

export function baseCurrency(db) {
  const currency = findBaseCurrency(db);
  if (!currency) throw new Error('Configure the base currency before converting currencies');
  return currency;
}

export function conversionRate(db, sourceId, targetId, date, companyId = null) {
  const source = read(db, 'res.currency', sourceId);
  const target = read(db, 'res.currency', targetId);
  if (!source || !target) throw new Error('Configure a valid company and document currency before converting currencies');
  if (source.id === target.id) return 1;
  const base = baseCurrency(db);
  const targetRate = baseRate(db, target.id, date, base.id, companyId);
  const sourceRate = baseRate(db, source.id, date, base.id, companyId);
  return targetRate == null || sourceRate == null ? null : targetRate / sourceRate;
}

/** Base-relative exchange rate for `currencyId` on `date`, throwing if the currency does not exist. */
function baseRate(db, currencyId, date, baseId, companyId = null) {
  const c = currencyId ? read(db, 'res.currency', currencyId) : null;
  if (!c) throw new Error('Select an existing currency before converting an amount');
  return baseRateInfo(c, date, baseId, companyId).rate;
}

/** The currency a company keeps its books in. */
export const companyCurrency = (db, companyId = null) => companyCurrencyRecord(db, companyId).id;

/**
 * Units of `currencyId` per 1 unit of the company's currency on `date` (1 for the company currency itself).
 * Without a company the main company's currency is the reference.
 */
export function rateAt(db, currencyId, date = today(), companyId = null) {
  if (!currencyId) return 1;
  const own = companyCurrency(db, companyId);
  const rate = conversionRate(db, own, currencyId, date, companyId);
  if (rate == null) {
    const base = baseCurrency(db);
    const missing = [currencyId, own].map((id) => read(db, 'res.currency', id)).find((currency) => baseRate(db, currency.id, date, base.id, companyId) == null);
    const hasRates = (missing.rate_ids ?? []).some((row) => row.date && Number.isFinite(Number(row.rate)) && Number(row.rate) > 0);
    throw new Error(hasRates ? `No ${missing.name} rate on or before ${date}; configure an exchange rate` : `No ${missing.name} exchange rate is configured`);
  }
  return rate;
}

/** Amount in `currencyId` expressed in the company's currency at `date`. */
export const toCompany = (db, currencyId, amount, date, companyId = null) => roundCurrency(
  (Number(amount) || 0) / rateAt(db, currencyId, date, companyId),
  companyCurrencyRecord(db, companyId),
);

/** Replace or append a rate row for `(date, companyId)` without creating duplicates. */
function upsertRateRow(rows = [], { date = today(), rate, companyId = null }) {
  const targetCompany = companyId == null || companyId === '' ? null : Number(companyId);
  let replaced = false;
  const nextRows = [];
  for (const r of rows) {
    const isMatch = r.date === date && (r.company_id == null ? null : Number(r.company_id)) === targetCompany;
    if (isMatch) {
      if (!replaced) {
        nextRows.push({ ...r, rate, date, company_id: targetCompany });
        replaced = true;
      }
    } else {
      nextRows.push(r);
    }
  }
  if (!replaced) {
    nextRows.push({ date, rate, company_id: targetCompany });
  }
  return nextRows;
}

/**
 * Upsert an exchange rate row on `currencyId` for (currency, date, company).
 * Applies only for active currencies, never creating duplicates.
 */
export function upsertCurrencyRate(db, currencyId, { date = today(), rate, companyId = null } = {}) {
  const numericRate = Number(rate);
  if (!Number.isFinite(numericRate) || numericRate <= 0) return db;
  const currency = read(db, 'res.currency', currencyId);
  if (!currency || currency.active === false) return db;
  const nextRows = upsertRateRow(currency.rate_ids ?? [], { date, rate: numericRate, companyId });
  return write(db, 'res.currency', currency.id, { rate_ids: nextRows });
}

/**
 * Upsert exchange rates for active currencies in `db` for a date and company.
 */
export function upsertCurrencyRates(db, rates, { date = today(), companyId = null } = {}) {
  let nextDb = db;
  if (Array.isArray(rates)) {
    const baseId = baseCurrency(nextDb)?.id;
    for (const item of rates) {
      const cId = item.currency_id ?? item.currencyId ?? item.currency;
      if (baseId != null && Number(cId) === Number(baseId)) continue;
      nextDb = upsertCurrencyRate(nextDb, cId, {
        date: item.date ?? date,
        rate: item.rate,
        companyId: item.company_id ?? item.companyId ?? companyId,
      });
    }
    return nextDb;
  }
  if (rates && typeof rates === 'object') {
    const currencies = nextDb.records['res.currency'] ?? [];
    const baseId = baseCurrency(nextDb)?.id;
    for (const c of currencies) {
      if (c.active === false || (baseId && c.id === baseId)) continue;
      const rate = rates[c.name] ?? rates[c.id];
      if (rate != null) {
        nextDb = upsertCurrencyRate(nextDb, c.id, { date, rate, companyId });
      }
    }
  }
  return nextDb;
}

/** Parse ECB daily XML into { date, rates } with rates relative to EUR (EUR = 1.0). */
export function parseEcbXml(xml) {
  if (typeof xml !== 'string' || !xml) throw new Error('Invalid ECB XML feed: empty response');
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
  const nonEurRates = Object.keys(rates).filter((k) => k !== 'EUR');
  if (!date || nonEurRates.length === 0) {
    throw new Error('Invalid ECB XML feed: missing date or currency rates');
  }
  return { date, rates };
}

/**
 * Convert EUR-based rates to the database base currency:
 * rate of currency X in terms of 1 unit of database base currency (rateAt convention).
 * The base currency itself is omitted as the base currency is always 1 and never has a rate row.
 */
export function convertRatesToBaseCurrency(ecbRates, baseCurrencyCode) {
  if (!ecbRates || typeof ecbRates !== 'object') throw new Error('Invalid ECB rates');
  const code = (baseCurrencyCode || '').toUpperCase();
  const baseRateInEur = ecbRates[code];
  if (baseRateInEur == null || !Number.isFinite(baseRateInEur) || baseRateInEur <= 0) {
    const msg = 'Base currency ' + code + ' is not in the ECB feed';
    throw new Error(msg);
  }
  const out = {};
  for (const [curr, eurRate] of Object.entries(ecbRates)) {
    if (curr === code) continue;
    if (Number.isFinite(eurRate) && eurRate > 0) {
      out[curr] = eurRate / baseRateInEur;
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

/** Rate rows a write adds or changes must be strictly positive and unique per date and company; rows a write leaves untouched are not rechecked, so a currency with a legacy bad row stays editable. */
function rateRowsError(beforeRows = [], afterRows = []) {
  const unchanged = new Set((beforeRows ?? []).map((row) => JSON.stringify(row)));
  const keyOf = (row) => `${row.date ?? ''}:${row.company_id == null || row.company_id === '' ? 'all' : String(Number(row.company_id))}`;
  const changed = (afterRows ?? []).filter((row) => !unchanged.has(JSON.stringify(row)));
  for (const row of changed) {
    if (!row || typeof row !== 'object') return 'Exchange rate must be strictly positive';
    const rate = typeof row.rate === 'boolean' || row.rate === null || row.rate === '' ? NaN : Number(row.rate);
    if (!Number.isFinite(rate) || rate <= 0) return 'Exchange rate must be strictly positive';
    if ((afterRows ?? []).filter((other) => other && typeof other === 'object' && keyOf(other) === keyOf(row)).length > 1) {
      return 'Duplicate exchange rate row for the same date and company';
    }
  }
  return null;
}

/** Base-relative rate of the rate line's effective company currency on `line.date` (1 when base/unconfigured, null if missing). */
function companyCurrencyRate(line, db) {
  if (!db) return 1;
  const companyId = line?.company_id || (db.settings?.current_company_id ?? 1);
  const own = findCompanyCurrencyRecord(db, companyId);
  const base = findBaseCurrency(db);
  if (!own || (base && own.id === base.id)) return 1;
  return baseRateInfo(own, line?.date || today(), base?.id, companyId).rate;
}

/** True when `record` is the active company's currency and differs from the database base currency. */
function isNonBaseCompanyCurrency(record, db) {
  if (!record?.id || !db) return false;
  const companyId = db.settings?.current_company_id ?? 1;
  const own = findCompanyCurrencyRecord(db, companyId);
  const base = findBaseCurrency(db);
  return Boolean(own && base && own.id === record.id && own.id !== base.id);
}

export const currencyModels = {
  'res.currency': {
    label: 'Currencies',
    guard: (db, before, after) => {
      const rounding = Number(after.rounding ?? 0.01);
      if (!Number.isFinite(rounding) || rounding <= 0) return 'Currency rounding must be positive';
      if (before && findBaseCurrency(db)?.id === before.id && JSON.stringify(before.rate_ids ?? []) !== JSON.stringify(after.rate_ids ?? [])) {
        return 'The base currency rate is fixed at 1 and cannot be modified';
      }
      const rateError = rateRowsError(before?.rate_ids, after.rate_ids);
      if (rateError) return rateError;
      if (!before || Number(before.rounding ?? 0.01) === rounding) return null;
      const id = before.id;
      const used = (db.records['res.company'] ?? []).some((company) => company.currency_id === id)
        || (db.records['account.payment'] ?? []).some((payment) => payment.state === 'posted' && payment.currency_id === id)
        || (db.records['account.move'] ?? []).some((move) => (move.state === 'posted' && move.currency_id === id)
          || (move.line_ids ?? []).some((line) => line.currency_id === id));
      return used ? 'Currency rounding cannot be changed while the currency is in use' : null;
    },
    fields: {
      name: { type: 'char', label: 'Currency', required: true },
      full_name: { type: 'char', label: 'Name', optional: 'show' },
      symbol: { type: 'char', label: 'Symbol' },
      currency_unit_label: { type: 'char', label: 'Currency Unit' },
      currency_subunit_label: { type: 'char', label: 'Currency Subunit' },
      position: { type: 'selection', label: 'Symbol Position', options: [['after', 'After Amount'], ['before', 'Before Amount']] },
      active: { type: 'boolean', label: 'Active', widget: 'toggle' },
      rounding: { type: 'float', label: 'Rounding Factor', required: true, digits: 15 },
      decimal_places: { type: 'integer', label: 'Decimal Places', compute: (r) => currencyDecimalPlaces(r) },
      rate_date: { type: 'date', label: 'Date', compute: (r, db) => currentRateInfo(r, db).date },
      rate: { type: 'float', label: 'Current Rate', digits: [6, 6], compute: (r, db) => currentRateInfo(r, db).rate },
      inverse_rate: {
        type: 'float',
        label: 'Inverse Rate',
        digits: [6, 6],
        optional: 'hide',
        compute: (r, db) => {
          const v = currentRateInfo(r, db).rate;
          return v ? Number((1 / v).toPrecision(12)) : null;
        },
      },
      current_rate: { type: 'float', label: 'Current Rate', hidden: true, compute: (r, db) => currentRateInfo(r, db).rate },
      base_rate_date: {
        type: 'date',
        label: 'Base Rate Date',
        editable: true,
        hideWhen: (r, db) => !isNonBaseCompanyCurrency(r, db),
        compute: (r, db) => (isNonBaseCompanyCurrency(r, db) ? today() : null),
      },
      base_rate: {
        type: 'float',
        label: 'Base Currency Rate',
        digits: [6, 6],
        editable: true,
        help: 'Units of this currency per 1 unit of the base currency.',
        hideWhen: (r, db) => !isNonBaseCompanyCurrency(r, db),
        compute: (r, db) => {
          if (!isNonBaseCompanyCurrency(r, db)) return null;
          const companyId = db.settings?.current_company_id ?? 1;
          const base = findBaseCurrency(db);
          return baseRateInfo(r, r.base_rate_date || today(), base?.id, companyId).rate;
        },
      },
      rate_ids: {
        type: 'one2many',
        label: 'Rates',
        readonly: (r, db) => Boolean(r?.id && findBaseCurrency(db)?.id === r.id),
        sort: (a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')),
        fields: {
          date: { type: 'date', label: 'Date' },
          company_id: { type: 'many2one', relation: 'res.company', label: 'Company', multiCompanyOnly: true, placeholder: 'Visible to all' },
          company_currency_id: {
            type: 'many2one',
            relation: 'res.currency',
            label: 'Base Currency',
            compute: (line, db) => findCompanyCurrencyRecord(db, line?.company_id || (db?.settings?.current_company_id ?? 1))?.id ?? null,
          },
          company_rate: {
            type: 'float',
            label: 'Unit/Base',
            digits: [6, 6],
            editable: true,
            readonly: (line, db) => companyCurrencyRate(line, db) == null,
            compute: (line, db, record) => {
              const ownRate = companyCurrencyRate(line, db);
              if (ownRate == null) return null;
              const rate = record?.id && findBaseCurrency(db)?.id === record.id ? 1 : Number(line.rate || 0);
              if (!(rate > 0)) return rate;
              return ownRate === 1 ? rate : Number((rate / ownRate).toPrecision(12));
            },
          },
          inverse_company_rate: {
            type: 'float',
            label: 'Base/Unit',
            digits: [6, 6],
            editable: true,
            readonly: (line, db) => companyCurrencyRate(line, db) == null,
            compute: (line, db, record) => {
              const ownRate = companyCurrencyRate(line, db);
              if (ownRate == null) return null;
              const rate = record?.id && findBaseCurrency(db)?.id === record.id ? 1 : Number(line.rate);
              if (!(rate > 0)) return 0;
              return Number((ownRate / rate).toPrecision(12));
            },
          },
          rate: { type: 'float', label: 'Technical Rate', digits: [6, 6], optional: 'hide' },
        },
        newLine: (record, db) => ({ date: today(), rate: 1, company_id: db?.settings?.current_company_id ?? null }),
        onchange: (line, changed, db) => {
          if (changed === 'company_rate') {
            const { company_rate: v, ...rest } = line;
            const ownRate = companyCurrencyRate(line, db);
            if (ownRate == null) return rest;
            const num = Number(v);
            if (!Number.isFinite(num)) return { ...rest, rate: line.rate };
            return { ...rest, rate: ownRate === 1 ? num : Number((num * ownRate).toPrecision(12)) };
          }
          if (changed === 'inverse_company_rate') {
            const { inverse_company_rate: v, ...rest } = line;
            const ownRate = companyCurrencyRate(line, db);
            if (ownRate == null) return rest;
            const num = Number(v);
            if (!Number.isFinite(num) || num <= 0) return { ...rest, rate: 0 };
            return { ...rest, rate: ownRate === 1 ? 1 / num : Number((ownRate / num).toPrecision(12)) };
          }
          return line;
        },
      },
    },
    onchange: (r, changed, db) => {
      if (!isNonBaseCompanyCurrency(r, db)) return {};
      const companyId = db?.settings?.current_company_id ?? 1;
      const base = findBaseCurrency(db);
      const date = r.base_rate_date || today();
      if (changed === 'base_rate_date') {
        return { base_rate: baseRateInfo(r, date, base?.id, companyId).rate };
      }
      if (changed === 'base_rate') {
        const num = r.base_rate == null || r.base_rate === '' ? 0 : Number(r.base_rate);
        return { rate_ids: upsertRateRow(r.rate_ids ?? [], { date, rate: Number.isFinite(num) ? num : 0, companyId }) };
      }
      return {};
    },
    defaults: () => ({ rounding: 0.01, position: 'before', active: true, rate_ids: [] }),
    views: ['list', 'kanban'],
    kanban: { title: 'name', lines: ['symbol', 'rate'] },
    list: ['name', 'symbol', 'full_name', 'rate_date', 'rate', 'inverse_rate', 'active'],
    editableList: ['active'],
    listDecoration: (r) => (r.active === false ? 'muted' : ''),
    searchFields: ['name', 'full_name', 'symbol', 'currency_unit_label', 'currency_subunit_label'],
    filters: [[
      { id: 'active', label: 'Active', fn: (r) => r.active !== false },
      { id: 'inactive', label: 'Inactive', includeArchived: true, fn: (r) => r.active === false },
    ]],
    form: {
      title: 'name',
      hideTitle: true,
      banner: (r, db) => (r?.id && findCompanyCurrencyRecord(db, db?.settings?.current_company_id ?? 1)?.id === r.id ? "This is your company's currency." : null),
      groups: (r, db) => [
        ['name', 'full_name', 'active'],
        ['symbol', 'currency_unit_label', 'currency_subunit_label', 'position'],
        { title: 'Price Accuracy', fields: ['rounding', 'decimal_places'] },
        ...(isNonBaseCompanyCurrency(r, db) ? [{ title: 'Base Currency Rate', fields: ['base_rate_date', 'base_rate'] }] : []),
      ],
      // Hide the Rates tab only on the active company's own currency, matching Odoo's is_current_company_currency.
      // Base currency rates are read-only because conversions always treat the global base currency as 1.
      tabs: (r, db) => {
        if (r?.id && findCompanyCurrencyRecord(db, db?.settings?.current_company_id ?? 1)?.id === r.id) return [];
        const isBase = Boolean(r?.id && findBaseCurrency(db)?.id === r.id);
        return [{
          label: 'Rates',
          fields: ['rate_ids'],
          ...(isBase ? { readonly: true, help: 'The base currency rate is fixed at 1.' } : {}),
        }];
      },
      chatter: true,
    },
  },
};
