// Pricelists: per-product fixed prices or % discounts from a minimum quantity.
import { read } from '../orm.js';

/**
 * Best matching rule for (product, qty): product-specific rules beat global ones, then the highest min qty wins.
 * @returns {number} unit price
 */
export function priceFor(db, pricelistId, productId, qty, basePrice) {
  const pl = read(db, 'product.pricelist', pricelistId);
  if (!pl) return basePrice;
  const rule = (pl.items ?? [])
    .filter((i) => (!i.product_id || i.product_id === productId) && (Number(qty) || 0) >= (Number(i.min_qty) || 0))
    .sort((a, b) => Number(!!b.product_id) - Number(!!a.product_id) || (Number(b.min_qty) || 0) - (Number(a.min_qty) || 0))[0];
  if (!rule) return basePrice;
  if (Number(rule.fixed_price) > 0) return Number(rule.fixed_price);
  return Math.round(basePrice * (1 - (Number(rule.percent) || 0) / 100) * 100) / 100;
}

export const pricelistModels = {
  'product.pricelist': {
    label: 'Pricelists',
    fields: {
      name: { type: 'char', label: 'Pricelist Name', required: true },
      items: {
        type: 'one2many',
        label: 'Price Rules',
        fields: {
          product_id: { type: 'many2one', relation: 'product', label: 'Product (empty = all)' },
          min_qty: { type: 'float', label: 'Min. Quantity' },
          fixed_price: { type: 'monetary', label: 'Fixed Price' },
          percent: { type: 'float', label: 'Discount %' },
        },
        newLine: () => ({ product_id: null, min_qty: 1, fixed_price: 0, percent: 10 }),
      },
    },
    defaults: () => ({ items: [] }),
    kanban: { title: 'name', lines: [] },
    list: ['name'],
    form: { title: 'name', groups: [[], []], tabs: [{ label: 'Price Rules', fields: ['items'] }], chatter: true },
  },
};
