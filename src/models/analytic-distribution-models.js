import { read, search } from '../orm.js';

export const planOf = (account) => account?.plan_id ? `plan:${account.plan_id}` : `legacy:${account?.plan || 'project'}`;

// A category reference is an id (legacy rules stored it as text); names are never matched.
const toCategoryId = (val) => {
  const n = Number(typeof val === 'object' && val !== null ? val.id : val);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

export const categoryHierarchy = (db, initialCat) => {
  const categories = new Set();
  let catId = toCategoryId(initialCat);
  while (catId && !categories.has(catId)) {
    categories.add(catId);
    catId = read(db, 'product.category', catId)?.parent_id;
  }
  return categories;
};

/** Find the most specific matching analytic distribution model for line context. */
export function findAnalyticDistribution(db, { partner_id, partner_category_id, product_id, product_categ_id, account_id, account_code, company_id } = {}, fallback = {}) {
  const models = search(db, 'account.analytic.distribution.model');
  if (!models?.length) return fallback;

  const partner = partner_id ? read(db, 'res.partner', partner_id) : null;
  const product = product_id ? read(db, 'product', product_id) : null;
  const code = account_code || (account_id ? read(db, 'account.account', account_id)?.code : '') || '';

  const partnerCat = partner_category_id ?? partner?.partner_category_id ?? partner?.category_id;
  const productCat = product_categ_id ?? product?.categ_id ?? product?.product_categ_id ?? product?.category_id ?? product?.categ;
  const categories = categoryHierarchy(db, productCat);

  const targetCompany = company_id;
  const matched = [];
  for (const model of models) {
    if (model.company_id && model.company_id !== targetCompany) continue;
    if (model.partner_id && model.partner_id !== partner_id) continue;
    if (model.product_id && model.product_id !== product_id) continue;
    if (model.partner_category_id) {
      const matchesCategory = partnerCat === model.partner_category_id || (partner?.tag_ids ?? []).includes(model.partner_category_id);
      if (!matchesCategory) continue;
    }
    if (model.product_categ_id != null && model.product_categ_id !== '') {
      const modelCat = toCategoryId(model.product_categ_id);
      if (!modelCat || !categories.has(modelCat)) continue;
    }
    if (model.account_prefix && (!code || !code.startsWith(model.account_prefix))) continue;

    const score = ['partner_id', 'product_id', 'partner_category_id', 'product_categ_id', 'account_prefix', 'company_id'].filter((field) => model[field]).length;
    matched.push({ model, score, sequence: Number(model.sequence ?? 10) });
  }

  if (!matched.length) return fallback;
  matched.sort((a, b) => b.score - a.score || a.sequence - b.sequence || a.model.id - b.model.id);

  if (matched[0].model.analytic_distribution && Object.keys(matched[0].model.analytic_distribution).length === 0) return {};

  // Each matching model, best first, applies wholly when none of its plans is covered yet.
  const result = {};
  const applied = new Set();
  for (const { model } of matched) {
    const distribution = model.analytic_distribution ?? {};
    const plans = new Set(Object.keys(distribution).map((id) => planOf(read(db, 'account.analytic.account', Number(id)))));
    if ([...plans].some((plan) => applied.has(plan))) continue;
    Object.assign(result, distribution);
    for (const plan of plans) applied.add(plan);
  }
  return result;
}
