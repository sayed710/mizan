import { read } from '../orm.js';
import { priceFor } from './pricelist.js';
import { convert, convertPrice, uomForLegacy } from './uom.js';
import { computeLineTaxes, expandTaxIds, lineUntaxed, mapTax, productTax, replaceTaxSnapshot, taxLabel, taxSnapshot, validateTaxCompany } from './taxes.js';
import { cashRound, documentCurrency, roundCurrency } from '../money.js';
import { mixedDiscountFactor } from './terms.js';
import { invoiceTaxGroups } from './ledger.js';

/** Compare explicit partner hierarchies at their commercial parent; contacts without a parent match only themselves. */
export function sameCommercialPartner(db, leftId, rightId) {
  const commercialId = (id) => {
    let partner = read(db, 'res.partner', id);
    const seen = new Set();
    while (partner?.parent_id) {
      if (seen.has(partner.id)) return null;
      seen.add(partner.id);
      partner = read(db, 'res.partner', partner.parent_id);
    }
    return partner?.id ?? null;
  };
  const left = commercialId(leftId);
  return left != null && left === commercialId(rightId);
}

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
export const validDate = (date) => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
  && Number.isFinite(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
/** Shift a YYYY-MM-DD date by `months`, preserving month-end dates and clamping shorter target months. */
export function shiftMonth(date, months) {
  if (!validDate(date)) return date;
  const source = new Date(`${date}T00:00:00Z`);
  const target = new Date(Date.UTC(source.getUTCFullYear(), source.getUTCMonth() + months, 1));
  const end = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  const sourceEnd = new Date(Date.UTC(source.getUTCFullYear(), source.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(source.getUTCDate() === sourceEnd ? end : Math.min(source.getUTCDate(), end));
  return target.toISOString().slice(0, 10);
}
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
  const amount = /^[-+]?(\d+\.?\d*|\.\d+)$/.test(plain) ? Number(plain) : NaN;
  return Number.isFinite(amount) ? amount : NaN;
}

/** Amount answered in a prompt: null when cancelled or left empty, otherwise a positive number or an error. */
export function promptedAmount(input) {
  if (input == null || String(input).trim() === '') return null;
  const amount = parseAmount(input);
  if (!(amount > 0)) throw new Error(`"${input}" is not a valid amount`);
  return amount;
}

/** Company tax rounding method ('round_per_line' | 'round_globally' | null). */
export const companyRoundingMethod = (db, companyId) => (db ? read(db, 'res.company', companyId ?? 1)?.tax_calculation_rounding_method ?? null : null);

/** @returns {{untaxed:number, tax:number, total:number}} */
export function amounts(lines = [], currency = null, { roundingMethod = null } = {}) {
  const rounded = (n) => roundCurrency(n, currency);
  let untaxed = 0;
  let lineTaxSum = 0;
  const byTax = new Map();
  for (const l of lines ?? []) {
    const c = computeLineTaxes(l, { currency, roundingMethod });
    untaxed += c.untaxed;
    lineTaxSum += c.tax;
    for (const t of c.taxes) {
      const tags = [...(t.tax_tag_ids ?? [])].sort((a, b) => a - b).join(',');
      const key = `${t.tax_account_id ?? ''}|${taxLabel(t)}|${tags}`;
      byTax.set(key, (byTax.get(key) ?? 0) + t.amount);
    }
  }
  const finalUntaxed = rounded(untaxed);
  const finalTax = roundingMethod === 'round_globally'
    ? rounded([...byTax.values()].reduce((s, v) => s + rounded(v), 0))
    : rounded(lineTaxSum);
  return { untaxed: finalUntaxed, tax: finalTax, total: rounded(finalUntaxed + finalTax) };
}

/** Tax amount of an invoice/bill, applying mixed early-payment discount factor and cash rounding tax adjustment when present. */
export function invoiceTaxAmount(r, db, roundingMethod = companyRoundingMethod(db, r?.company_id)) {
  const docCurr = documentCurrency(db, r);
  const term = db && r.invoice_payment_term_id && read(db, 'account.payment.term', r.invoice_payment_term_id);
  const baseTax = mixedDiscountFactor(term) !== 1
    ? roundCurrency(invoiceTaxGroups(db, r, roundingMethod).reduce((s, g) => s + g.document_amount, 0), docCurr)
    : roundCurrency(amounts(r.invoice_line_ids, docCurr, { roundingMethod }).tax, docCurr);
  const rounding = db && r.invoice_cash_rounding_id ? read(db, 'account.cash.rounding', r.invoice_cash_rounding_id) : null;
  if (rounding && rounding.strategy === 'biggest_tax' && baseTax !== 0) {
    const rawTotal = mixedDiscountFactor(term) !== 1
      ? roundCurrency(amounts(r.invoice_line_ids, docCurr, { roundingMethod }).untaxed + baseTax, docCurr)
      : amounts(r.invoice_line_ids, docCurr, { roundingMethod }).total;
    const roundedTotal = roundCurrency(cashRound(rawTotal, rounding.rounding, rounding.rounding_method), docCurr);
    const diff = roundCurrency(roundedTotal - rawTotal, docCurr);
    return roundCurrency(baseTax + diff, docCurr);
  }
  return baseTax;
}

/** Total of an account.move (invoice, bill, refund, or manual entry). */
export function total(r, db) {
  if (r.move_type === 'entry') return (r.line_ids ?? []).reduce((s, l) => s + (Number(l.debit) || 0), 0);
  const term = db && r.invoice_payment_term_id && read(db, 'account.payment.term', r.invoice_payment_term_id);
  const mixed = mixedDiscountFactor(term) !== 1;
  const docCurr = documentCurrency(db, r);
  const roundingMethod = companyRoundingMethod(db, r?.company_id);
  const base = !db && r.amount_total != null
    ? r.amount_total
    : mixed
      ? roundCurrency(amounts(r.invoice_line_ids, docCurr, { roundingMethod }).untaxed + invoiceTaxAmount(r, db, roundingMethod), docCurr)
      : amounts(r.invoice_line_ids, docCurr, { roundingMethod }).total;
  if (r.invoice_cash_rounding_id && r.state === 'posted') {
    const main = (r.line_ids ?? []).filter((l) => l.name === r.name);
    if (main.length) return main.some((l) => l.currency_id) ? Math.abs(main.reduce((sum, l) => sum + (Number(l.amount_currency) || 0), 0)) : main.reduce((sum, l) => sum + (Number(l.debit) || 0) + (Number(l.credit) || 0), 0) || base;
  }
  const rounding = db && r.invoice_cash_rounding_id ? read(db, 'account.cash.rounding', r.invoice_cash_rounding_id) : null;
  if (rounding) return roundCurrency(cashRound(base, rounding.rounding, rounding.rounding_method), docCurr);
  return base;
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
    tax_source_id: { type: 'many2one', relation: 'account.tax', label: 'Taxes', hidden: true },
    tax_ids: { type: 'many2many', relation: 'account.tax', label: 'Taxes', hidden: true },
    tax: { type: 'float', label: 'Tax %', readonly: true },
    // Snapshot of the chosen tax, so totals and postings never need the tax record.
    tax_type: { type: 'char', label: 'Tax Computation', hidden: true },
    tax_include: { type: 'boolean', label: 'Included in Price', hidden: true },
    tax_include_base_amount: { type: 'boolean', label: 'Affect Base of Subsequent Taxes', hidden: true },
    tax_is_base_affected: { type: 'boolean', label: 'Base Affected by Previous Taxes', hidden: true },
    tax_sequence: { type: 'integer', label: 'Tax Sequence', hidden: true },
    tax_breakdown: { type: 'json', label: 'Tax Breakdown', hidden: true },
    tax_cash_basis: { type: 'boolean', label: 'Cash Basis', hidden: true },
    tax_tag_ids: { type: 'many2many', relation: 'account.account.tag', label: 'Tax Tags', hidden: true },
    tax_account_id: { type: 'integer', ref: 'account.account', label: 'Tax Account', hidden: true }, // ref: id remaps follow it
    tax_name: { type: 'char', label: 'Tax Name', hidden: true },
    analytic_account_id: { type: 'many2one', relation: 'account.analytic.account', label: 'Analytic' },
    analytic_distribution: { type: 'distribution', label: 'Analytic Distribution', hidden: true },
  },
  newLine: (record, db) => {
    const isCost = priceField === 'cost';
    const isPurch = record ? ['in_invoice', 'in_refund'].includes(record.move_type) || isCost : isCost;
    const companyId = record?.company_id ?? 1;
    const company = db ? read(db, 'res.company', companyId) : null;
    const taxId = company ? (isPurch ? company.account_purchase_tax_id : company.account_sale_tax_id) : null;
    const tax = db && taxId ? read(db, 'account.tax', mapTax(db, record?.fiscal_position_id, taxId)) : null;
    const snap = tax ? taxSnapshot(tax, db, record?.fiscal_position_id) : taxSnapshot(null);
    return { product_id: null, qty: 1, price_unit: 0, discount: 0, ...snap };
  },
  // Product or quantity change re-prices the line; the parent record's pricelist (if any) applies.
  // The product's tax goes through the record's fiscal position; picking a tax by hand applies it as is.
  onchange: (line, key, db, record) => {
    if (key === 'tax_id') {
      validateTaxCompany(db, [line.tax_id], record?.company_id);
      return { ...line, ...replaceTaxSnapshot(taxSnapshot(read(db, 'account.tax', line.tax_id), db)), tax_source_id: null, tax_ids: [] };
    }
    if (key === 'tax_ids') {
      validateTaxCompany(db, line.tax_ids ?? [], record?.company_id);
      const expanded = expandTaxIds(db, line.tax_ids ?? []);
      return { ...line, ...replaceTaxSnapshot(expanded[0] ? taxSnapshot(expanded[0], db) : taxSnapshot(null)), tax_source_id: null, tax_breakdown: expanded.map((t) => taxSnapshot(t)) };
    }
    if (!['product_id', 'uom_id'].includes(key) && !(key === 'qty' && record?.pricelist_id)) return line;
    const product = read(db, 'product', line.product_id);
    const stock = product?.uom_id ?? uomForLegacy(db, product?.uom ?? 'unit')?.id;
    const uom_id = line.uom_id || (priceField === 'cost' ? product?.uom_po_id ?? product?.uom_id : product?.uom_id);
    const qty = uom_id && stock ? convert(db, line.qty, uom_id, stock, { round: false }) : line.qty;
    const base = product?.[priceField] ?? 0;
    const price = record?.pricelist_id ? priceFor(db, record.pricelist_id, line.product_id, qty, base) : base;
    const tax = key === 'product_id' ? (productTax(db, product, priceField === 'cost' ? 'purchase' : 'sale', record?.fiscal_position_id, record?.company_id) ?? taxSnapshot(null)) : null;
    return { ...line, ...(uom_id ? { uom_id } : {}), price_unit: uom_id && stock ? convertPrice(db, price, stock, uom_id) : price, ...(tax ? { tax_source_id: null, tax_ids: [], ...replaceTaxSnapshot(tax) } : {}) };
  },
});

export const amountFields = (lineField) => ({
  amount_untaxed: { type: 'monetary', label: 'Untaxed Amount', compute: (r, db) => amounts(r[lineField], documentCurrency(db, r), { roundingMethod: companyRoundingMethod(db, r?.company_id) }).untaxed },
  amount_tax: { type: 'monetary', label: 'Taxes', compute: (r, db) => amounts(r[lineField], documentCurrency(db, r), { roundingMethod: companyRoundingMethod(db, r?.company_id) }).tax },
  amount_total: { type: 'monetary', label: 'Total', compute: (r, db) => amounts(r[lineField], documentCurrency(db, r), { roundingMethod: companyRoundingMethod(db, r?.company_id) }).total },
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
