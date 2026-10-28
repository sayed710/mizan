import { create, read } from '../orm.js';

export function categoryPath(db, id) {
  const names = [], seen = new Set();
  const find = (key) => (db.records['product.category'] ?? []).find((c) => c.id === key);
  for (let c = find(id); c && !seen.has(c.id); c = find(c.parent_id)) {
    seen.add(c.id); names.unshift(c.name);
  }
  return names.join(' / ');
}

export function productProperty(db, product, key) {
  const productKey = key === 'property_cost_method' ? 'cost_method' : key === 'property_valuation' ? 'valuation' : key;
  if (product?.[productKey] != null && product[productKey] !== '') return product[productKey];
  const seen = new Set();
  for (let c = read(db, 'product.category', product?.categ_id); c && !seen.has(c.id); c = read(db, 'product.category', c.parent_id)) {
    seen.add(c.id);
    if (c[key] != null && c[key] !== '') return c[key];
  }
  return null;
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

