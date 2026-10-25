// Pure eCommerce logic shared by the public site (on the data the server publishes) and the server (on the real db).
import { read, search } from '../orm.js';
import { amounts, subtotal } from './common.js';
import { shippingPrice } from './logistics.js';
import { priceFor } from './pricelist.js';
import { lineTaxOf, productTax } from './taxes.js';

export const SORTS = ['featured', 'newest', 'name', 'price_asc', 'price_desc'];
const cents = (n) => Math.round(n * 100) / 100;

/** Visible on the website: published (new flag and the older "Sold Online" one), sellable and priced. */
export const isSellable = (p) => !!p && p.active !== false && p.sale_ok !== false && p.is_published !== false && p.website_published !== false && Number(p.list_price) > 0;

/** Can go in a cart: sellable, a variant of a published template, and not a template that has variants. */
export function isPurchasable(db, p) {
  if (!isSellable(p)) return false;
  if (p.variant_of) return isSellable(read(db, 'product', p.variant_of));
  return !search(db, 'product').some((v) => v.variant_of === p.id && isSellable(v));
}

/** The category and all its sub-categories (loop-safe). */
function withChildren(db, id) {
  const all = search(db, 'product.public.category');
  const ids = new Set([id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const c of all) if (ids.has(c.parent_id) && !ids.has(c.id)) { ids.add(c.id); grew = true; }
  }
  return ids;
}

const COMPARE = {
  featured: (a, b) => (Number(a.website_sequence) || 0) - (Number(b.website_sequence) || 0) || a.id - b.id,
  newest: (a, b) => b.id - a.id,
  name: (a, b) => String(a.name).localeCompare(String(b.name)),
  price_asc: (a, b) => a.list_price - b.list_price || a.id - b.id,
  price_desc: (a, b) => b.list_price - a.list_price || a.id - b.id,
};

/**
 * Product grid of /shop: published sellable templates (variants are reached from their template).
 * @returns {{ items: object[], total: number, pages: number, page: number }}
 */
export function shopProducts(db, { category = null, search: text = '', sort = 'featured', page = 1, perPage = 12 } = {}) {
  const cats = category ? withChildren(db, Number(category)) : null;
  const terms = String(text ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const found = search(db, 'product')
    .filter((p) => isSellable(p) && !p.variant_of)
    .filter((p) => !cats || (p.public_categ_ids ?? []).some((l) => cats.has(l.category_id)))
    .filter((p) => {
      const hay = `${p.name} ${p.default_code ?? ''} ${p.website_description ?? ''}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    })
    .sort(COMPARE[sort] ?? COMPARE.featured);
  const pages = Math.max(1, Math.ceil(found.length / perPage));
  const current = Math.min(pages, Math.max(1, Math.floor(Number(page)) || 1));
  return { items: found.slice((current - 1) * perPage, current * perPage), total: found.length, pages, page: current };
}

/** "Color: White, Black; Legs: Steel" → [['Color', ['White', 'Black']], ['Legs', ['Steel']]]. */
export const namedAttributes = (text = '') => String(text ?? '').split(';')
  .map((part, i) => {
    const [name, values] = part.includes(':') ? [part.slice(0, part.indexOf(':')).trim(), part.slice(part.indexOf(':') + 1)] : [`#${i + 1}`, part];
    return [name, values.split(',').map((v) => v.trim()).filter(Boolean)];
  })
  .filter(([, values]) => values.length);

/**
 * Attribute groups of a template and its sellable variants (one value per attribute, in order).
 * @returns {{ attributes: [string, string[]][], variants: { id: number, values: string[], price: number, qty: number }[] }}
 */
export function productVariants(db, template) {
  const variants = search(db, 'product')
    .filter((v) => v.variant_of === template.id && isSellable(v))
    .map((v) => ({ id: v.id, values: v.variant_values ?? [], price: Number(v.list_price) || 0, qty: Number(v.qty_available) || 0 }));
  return { attributes: namedAttributes(template.attributes), variants };
}

/** Auto-applied fiscal position for a country (the visitor has no partner record yet). */
function fiscalPositionOf(db, country) {
  const c = String(country ?? '').trim().toLowerCase();
  return c ? search(db, 'account.fiscal.position').find((fp) => fp.auto_apply && String(fp.country ?? '').trim().toLowerCase() === c)?.id ?? null : null;
}

/** Order line for a product at its website price (pricelist applied) with its sales tax. */
export function shopLine(db, productId, qty, { pricelistId = null, fiscalPositionId = null } = {}) {
  const product = read(db, 'product', productId);
  const base = Number(product?.list_price) || 0;
  const price_unit = pricelistId ? priceFor(db, pricelistId, productId, qty, base) : base;
  return { product_id: productId, qty, price_unit, discount: 0, ...(productTax(db, product, 'sale', fiscalPositionId) ?? { tax: 0 }) };
}

/** Delivery line on the shipping service product (reference SHIP) when it exists. */
export function deliveryLine(db, price, fiscalPositionId = null) {
  const ship = search(db, 'product', { includeArchived: true }).find((p) => p.default_code === 'SHIP');
  return { product_id: ship?.id ?? null, qty: 1, price_unit: cents(price), discount: 0, ...(productTax(db, ship, 'sale', fiscalPositionId) ?? { tax: 0 }) };
}

/** Carriers offered on the website: published and priced locally (API carriers need the server integration). */
export const websiteCarriers = (db) => search(db, 'delivery.carrier').filter((c) => c.is_published && c.delivery_type !== 'api');

/**
 * Cart summary with server-side prices: pricelist, product taxes (after the country's fiscal position) and delivery.
 * @returns {{ lines: { product_id: number, qty: number, price_unit: number, subtotal: number, tax: number }[], untaxed: number, tax: number, delivery: number, total: number, orderLines: object[] }}
 */
export function cartTotals(db, lines, { pricelistId = null, carrierId = null, partnerCountry = '' } = {}) {
  const fiscalPositionId = fiscalPositionOf(db, partnerCountry);
  const productLines = (lines ?? []).map((l) => shopLine(db, l.product_id, l.qty, { pricelistId, fiscalPositionId }));
  const untaxed = amounts(productLines).untaxed;
  const carrier = carrierId ? read(db, 'delivery.carrier', carrierId) : null;
  const delivery = carrier ? cents(shippingPrice(db, carrier, { amount_untaxed: untaxed, order_line: productLines })) : 0;
  const orderLines = carrier ? [...productLines, deliveryLine(db, delivery, fiscalPositionId)] : productLines;
  const all = amounts(orderLines);
  return {
    lines: productLines.map((l) => ({ product_id: l.product_id, qty: l.qty, price_unit: l.price_unit, subtotal: cents(subtotal(l)), tax: cents(lineTaxOf(l)) })),
    untaxed, tax: all.tax, delivery, total: all.total, orderLines,
  };
}
