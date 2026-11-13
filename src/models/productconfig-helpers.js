import { create, read } from '../orm.js';

export function categoryPath(db, id) {
  const names = [], seen = new Set();
  const find = (key) => (db.records['product.category'] ?? []).find((c) => c.id === key);
  for (let c = find(id); c && !seen.has(c.id); c = find(c.parent_id)) {
    seen.add(c.id); names.unshift(c.name);
  }
  return names.join(' / ');
}

const PRODUCT_KEY_MAP = {
  property_cost_method: 'cost_method',
  property_valuation: 'valuation',
};

const CATEGORY_KEY_MAP = {
  property_account_income_id: 'property_account_income_categ_id',
  property_account_expense_id: 'property_account_expense_categ_id',
};

/**
 * Walk `product.category` upward from `categoryId` along `parent_id` and return the first set value for `key`.
 * Categories belonging to a different company are skipped when `companyId` is provided.
 */
export function categoryProperty(db, categoryId, key, companyId = null) {
  const categoryKey = CATEGORY_KEY_MAP[key] ?? key;
  const seen = new Set();
  for (let c = read(db, 'product.category', categoryId); c && !seen.has(c.id); c = read(db, 'product.category', c.parent_id)) {
    seen.add(c.id);
    if ((companyId == null || c.company_id == null || c.company_id === companyId) && c[categoryKey] != null && c[categoryKey] !== '') {
      return c[categoryKey];
    }
  }
  return null;
}

/** Resolve a product property value, falling back to inherited settings on its category hierarchy. */
export function productProperty(db, product, key, companyId = null) {
  const productKey = PRODUCT_KEY_MAP[key] ?? key;
  if (product?.[productKey] != null && product[productKey] !== '') return product[productKey];
  return categoryProperty(db, product?.categ_id, key, companyId);
}

export function migrateProductCategories(db) {
  let next = db;
  for (const p of db.records.product ?? []) {
    if (p.categ_id || !String(p.categ ?? '').trim()) continue;
    let parent = null;
    for (const name of String(p.categ).split('/').map((s) => s.trim()).filter(Boolean)) {
      let category = (next.records['product.category'] ?? []).find((c) => c.name === name && (c.parent_id ?? null) === parent);
      if (!category) { const made = create(next, 'product.category', { name, parent_id: parent }); next = made.db; category = { id: made.id }; }
      parent = category.id;
    }
    next = { ...next, records: { ...next.records, product: next.records.product.map((r) => r.id === p.id ? { ...r, categ_id: parent } : r) } };
  }
  return next;
}

