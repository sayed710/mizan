import { read } from '../orm.js';
import { priceFor } from './pricelist.js';
import { convert, convertPrice, uomForLegacy } from './uom.js';
import { lineTaxOf, lineUntaxed, productTax, taxSnapshot } from './taxes.js';

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

/** Line subtotal before tax, after the line discount (%); a price-included tax is taken out. */
export const subtotal = lineUntaxed;

/** @returns {{untaxed:number, tax:number, total:number}} */
export function amounts(lines = []) {
  const untaxed = lines.reduce((s, l) => s + subtotal(l), 0);
  const tax = lines.reduce((s, l) => s + lineTaxOf(l), 0);
  const cents = (n) => Math.round(n * 100) / 100;
  return { untaxed: cents(untaxed), tax: cents(tax), total: cents(cents(untaxed) + cents(tax)) };
}

/** One2many product lines; `priceField` is the product field copied into the unit price on product change. */
export const productLines = (label, priceField) => ({
  type: 'one2many',
  label,
  fields: {
    product_id: { type: 'many2one', relation: 'product', label: 'Product' },
    uom_id: { type: 'many2one', relation: 'uom.uom', label: 'Unit of Measure' },
    qty: { type: 'float', label: 'Quantity' },
    price_unit: { type: 'monetary', label: 'Unit Price' },
    discount: { type: 'float', label: 'Disc.%' },
    tax_id: { type: 'many2one', relation: 'account.tax', label: 'Taxes' },
    tax: { type: 'float', label: 'Tax %', readonly: true },
    // Snapshot of the chosen tax, so totals and postings never need the tax record.
    tax_type: { type: 'char', label: 'Tax Computation', hidden: true },
    tax_include: { type: 'boolean', label: 'Included in Price', hidden: true },
    tax_cash_basis: { type: 'boolean', label: 'Cash Basis', hidden: true },
    tax_account_id: { type: 'integer', label: 'Tax Account', hidden: true },
    tax_name: { type: 'char', label: 'Tax Name', hidden: true },
    analytic_account_id: { type: 'many2one', relation: 'account.analytic.account', label: 'Analytic' },
  },
  newLine: () => ({ product_id: null, qty: 1, price_unit: 0, discount: 0, tax: 14 }),
  // Product or quantity change re-prices the line; the parent record's pricelist (if any) applies.
  // The product's tax goes through the record's fiscal position; picking a tax by hand applies it as is.
  onchange: (line, key, db, record) => {
    if (key === 'tax_id') return { ...line, ...taxSnapshot(read(db, 'account.tax', line.tax_id)) };
    if (!['product_id', 'uom_id'].includes(key) && !(key === 'qty' && record?.pricelist_id)) return line;
    const product = read(db, 'product', line.product_id);
    const stock = product?.uom_id ?? uomForLegacy(db, product?.uom ?? 'unit')?.id;
    const uom_id = line.uom_id || (priceField === 'cost' ? product?.uom_po_id ?? product?.uom_id : product?.uom_id);
    const qty = uom_id && stock ? convert(db, line.qty, uom_id, stock, { round: false }) : line.qty;
    const base = product?.[priceField] ?? 0;
    const price = record?.pricelist_id ? priceFor(db, record.pricelist_id, line.product_id, qty, base) : base;
    const tax = key === 'product_id' ? productTax(db, product, priceField === 'cost' ? 'purchase' : 'sale', record?.fiscal_position_id) : null;
    return { ...line, ...(uom_id ? { uom_id } : {}), price_unit: uom_id && stock ? convertPrice(db, price, stock, uom_id) : price, ...(tax ?? {}) };
  },
});

export const amountFields = (lineField) => ({
  amount_untaxed: { type: 'monetary', label: 'Untaxed Amount', compute: (r) => amounts(r[lineField]).untaxed },
  amount_tax: { type: 'monetary', label: 'Taxes', compute: (r) => amounts(r[lineField]).tax },
  amount_total: { type: 'monetary', label: 'Total', compute: (r) => amounts(r[lineField]).total },
});

/** Next "PREFIX00001"-style number among records matching `filter`: one past the highest, so a deleted record never frees its number for reuse. */
export const nextName = (db, model, prefix, filter = () => true) => {
  const used = (db.records[model] ?? []).filter((r) => filter(r) && r.name?.startsWith(prefix)).map((r) => Number(r.name.slice(prefix.length)));
  return prefix + pad(Math.max(0, ...used.filter(Number.isSafeInteger)) + 1);
};

export const monthFilters = (field) => [
  { id: `${field}_month`, label: 'This Month', fn: (r) => r[field]?.slice(0, 7) === today().slice(0, 7) },
  { id: `${field}_year`, label: 'This Year', fn: (r) => r[field]?.slice(0, 4) === today().slice(0, 4) },
];
