// Foreign currencies with dated rates; amounts convert to the company currency for the ledger.
import { read } from '../orm.js';
import { today } from './common.js';

const round = (n) => Math.round(n * 100) / 100;

/** Units of `currencyId` per 1 base-currency unit on `date`: the latest rate on or before it (1 without rates). */
function baseRate(db, currencyId, date) {
  const c = currencyId ? read(db, 'res.currency', currencyId) : null;
  const rates = (c?.rate_ids ?? []).filter((r) => Number(r.rate) > 0 && r.date).sort((a, b) => a.date.localeCompare(b.date));
  if (!rates.length) return 1;
  const rate = [...rates].reverse().find((r) => r.date <= date);
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
  if (!currencyId || currencyId === own) return 1;
  return baseRate(db, currencyId, date) / (own ? baseRate(db, own, date) : 1);
}

/** Amount in `currencyId` expressed in the company's currency at `date`. */
export const toCompany = (db, currencyId, amount, date, companyId = null) => round((Number(amount) || 0) / rateAt(db, currencyId, date, companyId));

export const currencyModels = {
  'res.currency': {
    label: 'Currencies',
    fields: {
      name: { type: 'char', label: 'Currency', required: true },
      symbol: { type: 'char', label: 'Symbol' },
      rate_ids: {
        type: 'one2many',
        label: 'Rates',
        fields: { date: { type: 'date', label: 'Date' }, rate: { type: 'float', label: 'Unit per Company Currency' } },
        newLine: () => ({ date: today(), rate: 1 }),
      },
      current_rate: { type: 'float', label: 'Current Rate', compute: (r) => Number([...(r.rate_ids ?? [])].sort((a, b) => b.date.localeCompare(a.date))[0]?.rate) || 1 },
    },
    defaults: () => ({ rate_ids: [] }),
    kanban: { title: 'name', lines: ['symbol', 'current_rate'] },
    list: ['name', 'symbol', 'current_rate'],
    form: { title: 'name', groups: [['symbol'], ['current_rate']], tabs: [{ label: 'Rates', fields: ['rate_ids'] }], chatter: true },
  },
};
