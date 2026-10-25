// Foreign currencies with dated rates; amounts convert to the company currency for the ledger.
import { read } from '../orm.js';
import { today } from './common.js';

const round = (n) => Math.round(n * 100) / 100;

/** Units of `currencyId` per 1 company-currency unit on `date` (latest rate on or before it; 1 for the company currency). */
export function rateAt(db, currencyId, date = today()) {
  const c = currencyId ? read(db, 'res.currency', currencyId) : null;
  if (!c) return 1;
  const rates = (c.rate_ids ?? []).filter((r) => Number(r.rate) > 0).sort((a, b) => a.date.localeCompare(b.date));
  const rate = [...rates].reverse().find((r) => r.date <= date) ?? rates[0];
  return Number(rate?.rate) || 1;
}

/** Amount in `currencyId` expressed in the company currency at `date`. */
export const toCompany = (db, currencyId, amount, date) => round((Number(amount) || 0) / rateAt(db, currencyId, date));

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
