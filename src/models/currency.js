// Foreign currencies with dated rates; amounts convert to the company currency for the ledger.
import { read } from '../orm.js';
import { today } from './common.js';
import { companyCurrencyRecord, currencyDecimalPlaces, roundCurrency } from '../money.js';


/** Units of `currencyId` per 1 base-currency unit on `date`: the latest configured rate on or before it. */
const applicableRate = (currency, date, companyId = null) => {
  const rows = (currency.rate_ids ?? []).filter((r) => Number.isFinite(Number(r.rate)) && Number(r.rate) > 0 && r.date && r.date <= date);
  const latest = (id) => rows.filter((r) => (r.company_id || null) === id).sort((a, b) => b.date.localeCompare(a.date))[0];
  return (companyId == null ? null : latest(companyId)) ?? latest(null);
};

export function baseCurrency(db) {
  const currency = read(db, 'res.currency', db.settings?.base_currency_id);
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

function baseRate(db, currencyId, date, baseId, companyId = null) {
  const c = currencyId ? read(db, 'res.currency', currencyId) : null;
  if (!c) throw new Error('Select an existing currency before converting an amount');
  if (currencyId === baseId) return 1;
  const rate = applicableRate(c, date, companyId);
  return rate ? Number(rate.rate) : null;
}

/** The currency a company keeps its books in (null: the base currency). */
export const companyCurrency = (db, companyId) => (companyId ? read(db, 'res.company', companyId)?.currency_id ?? null : null);

/**
 * Units of `currencyId` per 1 unit of the company's currency on `date` (1 for the company currency itself).
 * Without a company the base currency (settings.currency) is the reference.
 */
export function rateAt(db, currencyId, date = today(), companyId = null) {
  if (!currencyId) return 1;
  const own = companyId == null ? baseCurrency(db).id : companyCurrency(db, companyId);
  if (!own) throw new Error('Configure the company currency before converting currencies');
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
  companyId == null ? baseCurrency(db) : companyCurrencyRecord(db, companyId),
);

export const currencyModels = {
  'res.currency': {
    label: 'Currencies',
    guard: (db, before, after) => {
      const rounding = Number(after.rounding ?? 0.01);
      if (!Number.isFinite(rounding) || rounding <= 0) return 'Currency rounding must be positive';
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
      symbol: { type: 'char', label: 'Symbol' },
      unit_name: { type: 'char', label: 'Whole Unit Name for Amounts in Words' },
      rounding: { type: 'float', label: 'Rounding', required: true, digits: 15 },
      decimal_places: { type: 'integer', label: 'Decimal Places', compute: (r) => currencyDecimalPlaces(r) },
      rate_ids: {
        type: 'one2many',
        label: 'Rates',
        fields: { date: { type: 'date', label: 'Date' }, rate: { type: 'float', label: 'Unit per Company Currency' }, company_id: { type: 'many2one', relation: 'res.company', label: 'Company' } },
        newLine: () => ({ date: today(), rate: 1, company_id: null }),
      },
      current_rate: { type: 'float', label: 'Current Rate', compute: (r, db) => Number(applicableRate(r, today(), db.settings?.current_company_id ?? null)?.rate) || 1 },
    },
    defaults: () => ({ rounding: 0.01, rate_ids: [] }),
    kanban: { title: 'name', lines: ['symbol', 'current_rate'] },
    list: ['name', 'symbol', 'unit_name', 'rounding', 'decimal_places', 'current_rate'],
    form: { title: 'name', groups: [['symbol', 'unit_name', 'rounding', 'decimal_places'], ['current_rate']], tabs: [{ label: 'Rates', fields: ['rate_ids'] }], chatter: true },
  },
};
