// Foreign currencies with dated rates; amounts convert to the company currency for the ledger.
import { read } from '../orm.js';
import { today } from './common.js';
import { companyCurrencyRecord, currencyDecimalPlaces, findCompanyCurrencyRecord, roundCurrency } from '../money.js';


/** Units of `currencyId` per 1 base-currency unit on `date`: the latest configured rate on or before it. */
const applicableRate = (currency, date, companyId = null) => {
  const rows = (currency.rate_ids ?? []).filter((r) => Number.isFinite(Number(r.rate)) && Number(r.rate) > 0 && r.date && r.date <= date);
  const latest = (id) => rows.filter((r) => (r.company_id || null) === id).sort((a, b) => b.date.localeCompare(a.date))[0];
  return (companyId == null ? null : latest(companyId)) ?? latest(null);
};

// Raw lookup: read() would compute this currency's own rate fields, which call back into here.
const findBaseCurrency = (db) => (db?.settings?.base_currency_id ? (db.records?.['res.currency'] ?? []).find((c) => c.id === db.settings.base_currency_id) ?? null : null);

/** Effective rate and date today for `currency` in the current company, without throwing when unconfigured. */
function currentRateInfo(currency, db) {
  const companyId = db?.settings?.current_company_id ?? 1;
  const own = findCompanyCurrencyRecord(db, companyId);
  const date = today();
  const row = applicableRate(currency, date, companyId);
  // The company currency is the unit of every rate: Odoo shows it at 1 with no rate date.
  if (own?.id === currency.id) return { rate: 1, date: null };
  if (!row) return { rate: null, date: null };
  const base = findBaseCurrency(db);
  if (!own || !base || own.id === base.id) return { rate: Number(row.rate), date: row.date };
  const ownRow = applicableRate(own, date, companyId);
  return ownRow ? { rate: Number(row.rate) / Number(ownRow.rate), date: row.date } : { rate: null, date: null };
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

function baseRate(db, currencyId, date, baseId, companyId = null) {
  const c = currencyId ? read(db, 'res.currency', currencyId) : null;
  if (!c) throw new Error('Select an existing currency before converting an amount');
  if (currencyId === baseId) return 1;
  const rate = applicableRate(c, date, companyId);
  return rate ? Number(rate.rate) : null;
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
      rate_ids: {
        type: 'one2many',
        label: 'Rates',
        sort: (a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')),
        fields: {
          date: { type: 'date', label: 'Date' },
          company_id: { type: 'many2one', relation: 'res.company', label: 'Company', multiCompanyOnly: true, placeholder: 'Visible to all' },
          company_currency_id: {
            type: 'many2one',
            relation: 'res.currency',
            label: 'Base Currency',
            compute: (line, db) => findCompanyCurrencyRecord(db, line.company_id ?? db?.settings?.current_company_id ?? 1)?.id ?? null,
          },
          company_rate: {
            type: 'float',
            label: 'Unit/Base',
            digits: [6, 6],
            editable: true,
            compute: (line) => Number(line.rate || 0),
          },
          inverse_company_rate: {
            type: 'float',
            label: 'Base/Unit',
            digits: [6, 6],
            editable: true,
            compute: (line) => (Number(line.rate) > 0 ? Number((1 / Number(line.rate)).toPrecision(12)) : 0),
          },
          rate: { type: 'float', label: 'Technical Rate', digits: [6, 6], optional: 'hide' },
        },
        newLine: (record, db) => ({ date: today(), rate: 1, company_id: db?.settings?.current_company_id ?? null }),
        onchange: (line, changed) => {
          if (changed === 'company_rate') {
            const { company_rate: v, ...rest } = line;
            const num = Number(v);
            return { ...rest, rate: Number.isFinite(num) ? num : line.rate };
          }
          if (changed === 'inverse_company_rate') {
            const { inverse_company_rate: v, ...rest } = line;
            const num = Number(v);
            return { ...rest, rate: Number.isFinite(num) && num > 0 ? 1 / num : 0 };
          }
          return line;
        },
      },
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
      groups: [
        ['name', 'full_name', 'active'],
        ['symbol', 'currency_unit_label', 'currency_subunit_label', 'position'],
        { title: 'Price Accuracy', fields: ['rounding', 'decimal_places'] },
      ],
      // A company currency still needs base-relative rates when it is not the base currency.
      tabs: (r, db) => (r?.id && findCompanyCurrencyRecord(db, db?.settings?.current_company_id ?? 1)?.id === r.id && findBaseCurrency(db)?.id === r.id
        ? []
        : [{ label: 'Rates', fields: ['rate_ids'] }]),
      chatter: true,
    },
  },
};
