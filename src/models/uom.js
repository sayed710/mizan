import { create, read } from '../orm.js';

const units = (db) => db.records['uom.uom'] ?? [];
const tolerance = (n) => Number.EPSILON * Math.max(1, Math.abs(n)) * 8;
const finite = (n, label) => {
  const value = Number(n);
  if (!Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  return value;
};
const positive = (n) => Number.isFinite(Number(n)) && Number(n) > 0;

function unit(db, id) {
  const r = read(db, 'uom.uom', id);
  if (!r) throw new Error('Select an existing unit of measure');
  if (!positive(r.ratio) || !positive(r.rounding)) throw new Error('Unit ratio and rounding must be positive');
  return r;
}

function pair(db, fromId, toId) {
  const from = unit(db, fromId);
  const to = unit(db, toId);
  if (from.category_id !== to.category_id) throw new Error('Cannot convert units from different categories');
  return { from, to };
}

/** Convert quantity; UP (away from zero), not HALF-UP, matches product quantity rounding. */
export function convert(db, qty, fromUomId, toUomId, { round = true } = {}) {
  const { from, to } = pair(db, fromUomId, toUomId);
  const value = finite(finite(qty, 'Quantity') * Number(from.ratio) / Number(to.ratio), 'Converted quantity');
  if (!round) return value;
  const steps = Math.abs(value) / Number(to.rounding);
  return Number((Math.sign(value) * Math.ceil(steps - tolerance(steps)) * Number(to.rounding)).toPrecision(15));
}

/** Convert a price per source unit to a price per target unit, without currency rounding. */
export function convertPrice(db, price, fromUomId, toUomId) {
  const { from, to } = pair(db, fromUomId, toUomId);
  return finite(finite(price, 'Price') * Number(to.ratio) / Number(from.ratio), 'Converted price');
}

/** Resolve a legacy product unit; a box has no implied pack size and equals one unit. */
export function uomForLegacy(db, code) {
  const names = { unit: 'Units', kg: 'kg', m: 'm', l: 'L', hour: 'Hours', box: 'Units' };
  const categories = { unit: 'Unit', kg: 'Weight', m: 'Length', l: 'Volume', hour: 'Time', box: 'Unit' };
  const category = (db.records['uom.category'] ?? []).find((r) => r.name === categories[code]);
  return units(db).find((r) => r.name === names[code] && r.category_id === category?.id) ?? null;
}

/** Convert an explicitly unit-bearing order line to stock units; legacy lines stay unchanged. */
export function lineToStockQty(db, line, product) {
  const qty = finite(line.qty ?? 0, 'Quantity');
  if (!line.uom_id) return qty;
  const stock = product?.uom_id ?? uomForLegacy(db, product?.uom ?? 'unit')?.id;
  if (!stock) throw new Error('Set the product stock unit of measure before converting');
  return convert(db, qty, line.uom_id, stock);
}

/** Fresh, seed-independent category specifications, with ratios in reference units. */
export function defaultUoms() {
  return [
    ['Unit', [['Units', 1], ['Dozens', 12]]],
    ['Weight', [['kg', 1], ['g', 0.001], ['t', 1000]]],
    ['Length', [['m', 1], ['cm', 0.01], ['km', 1000]]],
    ['Volume', [['L', 1], ['mL', 0.001]]],
    ['Time', [['Hours', 1], ['Days', 8]]],
  ].map(([name, definitions]) => ({ name, uoms: definitions.map(([name, ratio], i) => ({
    name, ratio, uom_type: i === 0 ? 'reference' : ratio < 1 ? 'smaller' : 'bigger',
    rounding: 0.01, active: true,
  })) }));
}

/** Create missing standard categories and units once, preserving existing configuration. */
export function ensureUoms(db) {
  let next = db;
  for (const spec of defaultUoms()) {
    let category = (next.records['uom.category'] ?? []).find((r) => r.name === spec.name);
    if (!category) {
      const made = create(next, 'uom.category', { name: spec.name });
      next = made.db;
      category = read(next, 'uom.category', made.id);
    }
    for (const vals of spec.uoms) {
      if (units(next).some((r) => r.category_id === category.id && r.name === vals.name)) continue;
      next = create(next, 'uom.uom', { ...vals, category_id: category.id }).db;
    }
  }
  return next;
}

function packaging(db, productId, packagingId) {
  const r = read(db, 'product.packaging', packagingId);
  if (!r || r.product_id !== productId) throw new Error('Select a packaging for this product');
  if (!positive(r.qty)) throw new Error('Packaging quantity must be positive');
  return r;
}

/** Greedily fill the largest product packagings first; quantities are in stock units. */
export function packagingSuggestion(db, productId, qty) {
  let remainder = finite(qty, 'Quantity');
  if (remainder < 0) throw new Error('Packaging quantity cannot be negative');
  const choices = (db.records['product.packaging'] ?? []).filter((r) => r.product_id === productId)
    .sort((a, b) => Number(b.qty) - Number(a.qty) || a.id - b.id);
  const packages = [];
  for (const r of choices) {
    const pack = packaging(db, productId, r.id);
    const steps = remainder / Number(pack.qty);
    const count = Math.floor(steps + tolerance(steps));
    if (!count) continue;
    packages.push({ packaging: pack, count });
    remainder = Number(Math.max(0, remainder - count * Number(pack.qty)).toPrecision(15));
  }
  return { packages, remainder };
}

/** Sale warning for a non-multiple of the selected product packaging, otherwise null. */
export function checkPackagingMultiple(db, productId, qty, packagingId) {
  const pack = packaging(db, productId, packagingId);
  const count = finite(qty, 'Quantity') / Number(pack.qty);
  return Math.abs(count - Math.round(count)) <= tolerance(count) ? null
    : `Quantity should be a multiple of ${pack.qty} for ${pack.name}.`;
}

function guardUom(db, before, r) {
  if (!read(db, 'uom.category', r.category_id)) return 'Select an existing UoM category';
  if (!positive(r.ratio) || !positive(r.rounding)) return 'Ratio and rounding must be positive finite numbers';
  if (!['reference', 'bigger', 'smaller'].includes(r.uom_type)) return 'Select a valid unit type';
  if ((r.uom_type === 'reference' && Number(r.ratio) !== 1)
    || (r.uom_type === 'bigger' && Number(r.ratio) <= 1)
    || (r.uom_type === 'smaller' && Number(r.ratio) >= 1)) return 'The ratio must match the unit type';
  const others = units(db).filter((u) => u.id !== before?.id);
  if (before?.uom_type === 'reference' && (r.uom_type !== 'reference' || r.category_id !== before.category_id)) return 'A category must keep its reference unit';
  const reference = others.find((u) => u.category_id === r.category_id && u.uom_type === 'reference');
  if (r.uom_type === 'reference' && reference) return 'Only one reference unit is allowed per category';
  if (r.uom_type !== 'reference' && !reference) return 'Create the category reference unit first';
  return null;
}

export const uomModels = {
  'uom.category': {
    label: 'UoM Categories',
    fields: { name: { type: 'char', label: 'Category', required: true } },
    list: ['name'],
    form: { title: 'name', groups: [['name']] },
    protectDelete: (db, r) => units(db).some((u) => u.category_id === r.id) ? 'Remove the category units first' : null,
  },
  'uom.uom': {
    label: 'Units of Measure',
    fields: {
      name: { type: 'char', label: 'Unit', required: true },
      category_id: { type: 'many2one', relation: 'uom.category', label: 'Category', required: true },
      uom_type: { type: 'selection', label: 'Type', required: true, options: [['reference', 'Reference'], ['bigger', 'Bigger'], ['smaller', 'Smaller']] },
      ratio: { type: 'float', label: 'Reference Units', required: true },
      rounding: { type: 'float', label: 'Rounding', required: true },
      active: { type: 'boolean', label: 'Active' },
    },
    defaults: () => ({ uom_type: 'reference', ratio: 1, rounding: 0.01, active: true }),
    guard: guardUom,
    protectDelete: (db, r) => r.uom_type === 'reference' ? 'A category must keep its reference unit' : null,
    groupBys: ['category_id'],
    list: ['name', 'category_id', 'uom_type', 'ratio', 'rounding', 'active'],
    form: { title: 'name', groups: [['category_id', 'uom_type'], ['ratio', 'rounding', 'active']] },
  },
  'product.packaging': {
    label: 'Packagings',
    fields: {
      name: { type: 'char', label: 'Packaging', required: true },
      product_id: { type: 'many2one', relation: 'product', label: 'Product', required: true },
      qty: { type: 'float', label: 'Contained Quantity', required: true },
      barcode: { type: 'char', label: 'Barcode' },
      sales: { type: 'boolean', label: 'Sales' },
      purchase: { type: 'boolean', label: 'Purchase' },
    },
    defaults: () => ({ qty: 1, sales: true, purchase: true }),
    guard: (db, before, r) => !read(db, 'product', r.product_id) ? 'Select an existing product'
      : !positive(r.qty) ? 'Packaging quantity must be positive and finite' : null,
    list: ['name', 'product_id', 'qty', 'barcode', 'sales', 'purchase'],
    form: { title: 'name', groups: [['product_id', 'qty'], ['barcode', 'sales', 'purchase']] },
  },
};
