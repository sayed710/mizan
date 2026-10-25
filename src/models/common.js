import { priceFor } from './pricelist.js';

// Field/line helpers shared by order-like models (sales, purchase, invoices).

/** Local calendar date as YYYY-MM-DD (not UTC, so "today" matches the user's wall clock). */
export const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const today = () => isoDate(new Date());
export const addDays = (date, n) => {
  const d = new Date(date + 'T00:00');
  d.setDate(d.getDate() + n);
  return isoDate(d);
};
export const pad = (n, size = 5) => String(n).padStart(size, '0');

/** Line subtotal before tax, after the line discount (%). */
export const subtotal = (l) => (Number(l.qty) || 0) * (Number(l.price_unit) || 0) * (1 - (Number(l.discount) || 0) / 100);

/** @returns {{untaxed:number, tax:number, total:number}} */
export function amounts(lines = []) {
  const untaxed = lines.reduce((s, l) => s + subtotal(l), 0);
  const tax = lines.reduce((s, l) => s + (subtotal(l) * (Number(l.tax) || 0)) / 100, 0);
  return { untaxed, tax, total: untaxed + tax };
}

/** One2many product lines; `priceField` is the product field copied into the unit price on product change. */
export const productLines = (label, priceField) => ({
  type: 'one2many',
  label,
  fields: {
    product_id: { type: 'many2one', relation: 'product', label: 'Product' },
    qty: { type: 'float', label: 'Quantity' },
    price_unit: { type: 'monetary', label: 'Unit Price' },
    discount: { type: 'float', label: 'Disc.%' },
    tax: { type: 'float', label: 'Tax %' },
    analytic_account_id: { type: 'many2one', relation: 'account.analytic.account', label: 'Analytic' },
  },
  newLine: () => ({ product_id: null, qty: 1, price_unit: 0, discount: 0, tax: 14 }),
  // Product or quantity change re-prices the line; the parent record's pricelist (if any) applies.
  onchange: (line, key, db, record) => {
    if (key !== 'product_id' && !(key === 'qty' && record?.pricelist_id)) return line;
    const product = (db.records.product ?? []).find((p) => p.id === line.product_id);
    const base = product?.[priceField] ?? 0;
    const tax = key === 'product_id' ? product?.[priceField === 'cost' ? 'purchase_tax' : 'sale_tax'] : undefined;
    return { ...line, price_unit: record?.pricelist_id ? priceFor(db, record.pricelist_id, line.product_id, line.qty, base) : base, ...(tax != null ? { tax } : {}) };
  },
});

export const amountFields = (lineField) => ({
  amount_untaxed: { type: 'monetary', label: 'Untaxed Amount', compute: (r) => amounts(r[lineField]).untaxed },
  amount_tax: { type: 'monetary', label: 'Taxes', compute: (r) => amounts(r[lineField]).tax },
  amount_total: { type: 'monetary', label: 'Total', compute: (r) => amounts(r[lineField]).total },
});

/** Next "PREFIX00001"-style number among records matching `filter`. */
export const nextName = (db, model, prefix, filter = () => true) =>
  prefix + pad((db.records[model] ?? []).filter((r) => filter(r) && r.name?.startsWith(prefix)).length + 1);

export const monthFilters = (field) => [
  { id: `${field}_month`, label: 'This Month', fn: (r) => r[field]?.slice(0, 7) === today().slice(0, 7) },
  { id: `${field}_year`, label: 'This Year', fn: (r) => r[field]?.slice(0, 4) === today().slice(0, 4) },
];
