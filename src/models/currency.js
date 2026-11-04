// Foreign currencies with dated rates; amounts convert to the company currency for the ledger.
import { read } from '../orm.js';
import { today } from './common.js';
import { companyCurrencyRecord, currencyDecimalPlaces, roundCurrency } from '../money.js';


/** Units of `currencyId` per 1 base-currency unit on `date`: the latest configured rate on or before it. */
const applicableRate = (currency, date) => (currency.rate_ids ?? []).filter((r) => Number(r.rate) > 0 && r.date && r.date <= date).sort((a, b) => b.date.localeCompare(a.date))[0];

function baseRate(db, currencyId, date) {
  const c = currencyId ? read(db, 'res.currency', currencyId) : null;
  if (!c) throw new Error('Select an existing currency before converting an amount');
  const rates = (c?.rate_ids ?? []).filter((r) => Number(r.rate) > 0 && r.date).sort((a, b) => a.date.localeCompare(b.date));
  if (!rates.length) throw new Error(`No ${c.name} exchange rate is configured`);
  const rate = applicableRate(c, date);
  if (!rate) throw new Error(`No ${c.name} rate on or before ${date}`);
  return Number(rate.rate);
}

/** The currency a company keeps its books in (null: the base currency). */
export const companyCurrency = (db, companyId) => (companyId ? read(db, 'res.company', companyId)?.currency_id ?? null : null);

/**
 * Units of `currencyId` per 1 unit of the company's currency on `date` (1 for the company currency itself).
 * Without a company the base currency (settings.currency) is the reference.
 */
export function rateAt(db, currencyId, date = today(), companyId = null) {
  const own = companyCurrency(db, companyId);
  if (!currencyId) return 1;
  const currency = read(db, 'res.currency', currencyId);
  if (!currency) throw new Error('Select an existing currency before converting an amount');
  const baseCurrency = (db.records['res.currency'] ?? []).find((item) => item.name === db.settings?.currency)?.id;
  if (currencyId === own || (companyId == null && currencyId === baseCurrency)) return 1;
  const currencyRate = currencyId === baseCurrency ? 1 : baseRate(db, currencyId, date);
  const companyRate = own && own !== baseCurrency ? baseRate(db, own, date) : 1;
  return currencyRate / companyRate;
}

/** Amount in `currencyId` expressed in the company's currency at `date`. */
export const toCompany = (db, currencyId, amount, date, companyId = null) => roundCurrency(
  (Number(amount) || 0) / rateAt(db, currencyId, date, companyId),
  companyId == null ? (db.records['res.currency'] ?? []).find((currency) => currency.name === db.settings?.currency) : companyCurrencyRecord(db, companyId),
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
      rounding: { type: 'float', label: 'Rounding', required: true, digits: 15 },
      decimal_places: { type: 'integer', label: 'Decimal Places', compute: (r) => currencyDecimalPlaces(r) },
      rate_ids: {
        type: 'one2many',
        label: 'Rates',
        fields: { date: { type: 'date', label: 'Date' }, rate: { type: 'float', label: 'Unit per Company Currency' } },
        newLine: () => ({ date: today(), rate: 1 }),
      },
      current_rate: {
        type: 'float', label: 'Current Rate',
        compute: (r, db) => {
          if (companyCurrencyRecord(db, db.settings?.current_company_id ?? 1)?.id === r.id) return 1;
          const rate = applicableRate(r, today());
          return rate ? Number(rate.rate) : null;
        },
      },
    },
    defaults: () => ({ rounding: 0.01, rate_ids: [] }),
    kanban: { title: 'name', lines: ['symbol', 'current_rate'] },
    list: ['name', 'symbol', 'rounding', 'decimal_places', 'current_rate'],
    form: { title: 'name', groups: [['symbol', 'rounding', 'decimal_places'], ['current_rate']], tabs: [{ label: 'Rates', fields: ['rate_ids'] }], chatter: true },
  },
};
