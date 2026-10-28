import { read } from '../orm.js';
import { priceFor } from './pricelist.js';
import { convert, convertPrice, uomForLegacy } from './uom.js';
import { lineTaxOf, lineUntaxed, productTax, taxSnapshot } from './taxes.js';

// Field/line helpers shared by order-like models (sales, purchase, invoices).

/** Local calendar date as YYYY-MM-DD (not UTC, so "today" matches the user's wall clock). */
export const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
/** Calendar day (YYYY-MM-DD) of a date, or of a datetime in the viewer's timezone (the day the forms show). */
export const dayOf = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? s : isoDate(new Date(s)));
/** Move a date, or a datetime keeping its time of day, by whole calendar days. */
export const shiftDay = (s, n) => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return addDays(s, n);
  const d = new Date(s);
  d.setDate(d.getDate() + n);
  return d.toISOString();
};
/** The input has minute precision: keep the stored seconds when the minute is unchanged or only re-typed. */
export const pickedInstant = (input, old) => {
  if (!input) return null;
  const next = new Date(input);
  if (!Number.isFinite(next.getTime())) return null;
  if (old) {
    const prev = new Date(old);
    if (Number.isFinite(prev.getTime())) next.setSeconds(prev.getSeconds(), prev.getMilliseconds());
  }
  return next.toISOString();
};
export const today = () => isoDate(new Date());
export const addDays = (date, n) => {
  const d = new Date(date + 'T00:00');
  d.setDate(d.getDate() + n);
  return isoDate(d);
};
export const pad = (n, size = 5) => String(n).padStart(size, '0');

/** Line subtotal before tax, after the line discount (%); a price-included tax is taken out. */
export const subtotal = lineUntaxed;

/**
 * A number typed by a person: Arabic-Indic digits, the Arabic decimal and thousands separators, spaces and
 * well-formed thousands commas are accepted. NaN for anything else (a lone "1,5" is ambiguous, so it is refused).
 */
export function parseAmount(text) {
  if (text == null) return NaN;
  const s = String(text).trim()
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06F0))
    .replace(/\u066B/g, '.').replace(/\u066C/g, ',').replace(/\u2212/g, '-')
    .replace(/[\s\u00A0\u200E\u200F\u2066-\u2069]/g, '');
  if (s.includes(',') && !/^[-+]?\d{1,3}(,\d{3})+(\.\d*)?$/.test(s)) return NaN;
  const plain = s.replace(/,/g, '');
  return /^[-+]?(\d+\.?\d*|\.\d+)$/.test(plain) ? Number(plain) : NaN;
}

/** Amount answered in a prompt: null when cancelled or left empty, otherwise a positive number or an error. */
export function promptedAmount(input) {
  if (input == null || String(input).trim() === '') return null;
  const amount = parseAmount(input);
  if (!(amount > 0)) throw new Error(`"${input}" is not a valid amount`);
  return amount;
}

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
    tax_account_id: { type: 'integer', ref: 'account.account', label: 'Tax Account', hidden: true }, // ref: id remaps follow it
    tax_name: { type: 'char', label: 'Tax Name', hidden: true },
    analytic_account_id: { type: 'many2one', relation: 'account.analytic.account', label: 'Analytic' },
    analytic_distribution: { type: 'distribution', label: 'Analytic Distribution', hidden: true },
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

/**
 * Next "PREFIX00001"-style number among records matching `filter`: one past the highest. The server keeps a
 * high-water mark per model and prefix (`db.numbering`), so deleting the latest record never frees its number.
 */
export const nextName = (db, model, prefix, filter = () => true) => {
  const used = (db.records[model] ?? []).filter((r) => filter(r) && r.name?.startsWith(prefix)).map((r) => Number(r.name.slice(prefix.length)));
  return prefix + pad(Math.max(0, db.numbering?.[model]?.[prefix] ?? 0, ...used.filter(Number.isSafeInteger)) + 1);
};

export const monthFilters = (field) => [
  { id: `${field}_month`, label: 'This Month', fn: (r) => r[field]?.slice(0, 7) === today().slice(0, 7) },
  { id: `${field}_year`, label: 'This Year', fn: (r) => r[field]?.slice(0, 4) === today().slice(0, 4) },
];
