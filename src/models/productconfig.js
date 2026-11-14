import { read } from '../orm.js';
import { configuredAccount } from './configured-account.js';
import { categoryPath, categoryProperty } from './productconfig-helpers.js';
export { categoryPath, categoryProperty, productProperty, migrateProductCategories } from './productconfig-helpers.js';
import { ecommerceModels } from './ecommerce.js';

const relation = (relation, label) => ({ type: 'many2one', relation, label });
const many = (relation, label) => ({ type: 'many2many', relation, label });
const account = (label, extra = {}) => ({ ...relation('account.account', label), ...extra });
const costing = {
  type: 'selection',
  label: 'Costing Method',
  required: true,
  options: [['standard', 'Standard Price'], ['average', 'Average Cost (AVCO)'], ['fifo', 'FIFO']],
};
const valuation = {
  type: 'selection',
  label: 'Inventory Valuation',
  options: [['periodic', 'Periodic (at closing)'], ['real_time', 'Perpetual (at invoicing)']],
};

const categoryFields = {
  name: { type: 'char', label: 'Product Categories', required: true, placeholder: 'e.g. Lamps' },
  display_name: { type: 'char', label: 'Full Path', compute: (r, db) => categoryPath(db, r.id) },
  parent_id: { ...relation('product.category', 'Parent Category'), placeholder: 'None' },
  route_id: relation('stock.route', 'Routes'),
  company_id: relation('res.company', 'Company'),
  property_cost_method: costing,
  property_valuation: valuation,
  property_account_income_categ_id: account('Income Account', {
    help: 'This account will be used when validating a customer invoice.',
  }),
  property_account_expense_categ_id: account('Expense Account', {
    help: 'The expense is accounted for when a vendor bill is validated, except in anglo-saxon accounting with perpetual inventory valuation in which case the expense (Cost of Goods Sold account) is recognized at the customer invoice validation.',
  }),
  account_invoices_to_be_issued_id: account('Invoices to be Issued Account', {
    help: 'Account holding the accrued value of the goods delivered but not invoiced yet. With perpetual valuation, it counterbalances the stock valuation account at closing.',
  }),
  account_invoiced_not_delivered_id: account('Invoiced Not Delivered Account', {
    help: 'Account holding the accrued value of the goods invoiced but not delivered yet. With perpetual valuation, it counterbalances the stock valuation account at closing.',
  }),
  property_stock_valuation_account_id: account('Stock Account'),
  account_stock_variation_id: account('Stock Variation', {
    help: 'At closing, register the inventory variation of the period into a specific account',
  }),
  property_stock_journal: relation('account.journal', 'Stock Journal'),
  property_stock_account_input_categ_id: account('Stock Input Account'),
  property_stock_account_output_categ_id: account('Stock Output Account'),
  property_account_creditor_price_difference_categ: account('Price Difference Account', {
    hideWhen: (r) => r?.property_cost_method !== 'standard' || !['real_time', 'automated'].includes(r?.property_valuation),
  }),
  removal_strategy: { type: 'selection', label: 'Removal Strategy', options: [['fifo', 'FIFO'], ['lifo', 'LIFO'], ['fefo', 'FEFO']] },
};

const CATEGORY_ACCOUNT_FIELDS = Object.entries(categoryFields).filter(([, f]) => f.relation === 'account.account');

const LEGACY_CATEGORY_ACCOUNT_FIELDS = [
  ['property_account_income_id', 'Income Account'],
  ['property_account_expense_id', 'Expense Account'],
];

/**
 * Validate `product.category` writes: forbid parent hierarchy cycles and ensure configured
 * accounts belong to the category's company when scoped to one.
 */
function guardProductCategory(db, before, r) {
  let id = r.parent_id;
  const seen = new Set([before?.id ?? r.id]);
  while (id) {
    if (seen.has(id)) return 'Category hierarchy cannot contain a cycle';
    seen.add(id);
    id = read(db, 'product.category', id)?.parent_id;
  }
  if (r.company_id) {
    const owner = r.name || 'this category';
    for (const [key, field] of CATEGORY_ACCOUNT_FIELDS) {
      if (r[key] != null && r[key] !== '') configuredAccount(db, r[key], r.company_id, field.label, owner);
    }
    for (const [key, label] of LEGACY_CATEGORY_ACCOUNT_FIELDS) {
      if (r[key] != null && r[key] !== '') configuredAccount(db, r[key], r.company_id, label, owner);
    }
  }
  return null;
}

const lineFields = { attribute_id: { ...relation('product.attribute', 'Attribute'), required: true }, value_ids: { ...many('product.attribute.value', 'Values'), domain: (v, line) => v.attribute_id === line?.attribute_id }, sequence: { type: 'integer', label: 'Sequence' } };

export const productConfigModels = {
  'product.category': {
    label: 'Product Categories',
    views: ['list'],
    fields: categoryFields,
    createDefaults: (db, vals) => ({ property_cost_method: categoryProperty(db, vals?.parent_id, 'property_cost_method') ?? 'standard' }),
    guard: guardProductCategory,
    list: ['display_name'],
    listLabels: { display_name: 'Product Category' },
    searchFields: ['name', 'parent_id'],
    form: {
      title: 'name',
      titleLabel: 'Category',
      smart: [{ label: 'Products', model: 'product', field: 'categ_id', target: 'inventory/products' }],
      groups: [['parent_id']],
      tabs: [
        {
          label: 'Accounting',
          groups: [
            [
              'property_account_income_categ_id',
              'property_account_expense_categ_id',
              'account_invoices_to_be_issued_id',
              'account_invoiced_not_delivered_id',
            ],
            [
              'property_valuation',
              'property_cost_method',
              'property_stock_valuation_account_id',
              'account_stock_variation_id',
              'property_account_creditor_price_difference_categ',
            ],
          ],
        },
        {
          label: 'Inventory',
          fields: ['route_id', 'removal_strategy'],
        },
      ],
      chatter: true,
    },
  },
  'product.attribute': {
    label: 'Attributes', fields: { name: { type: 'char', label: 'Name', required: true }, active: { type: 'boolean', label: 'Active' }, display_type: { type: 'selection', label: 'Display Type', required: true, options: [['radio', 'Radio'], ['pills', 'Pills'], ['select', 'Select'], ['color', 'Color'], ['multi', 'Multi-checkbox']] }, sequence: { type: 'integer', label: 'Sequence' }, visibility: { type: 'selection', label: 'Visibility', options: [['visible', 'Visible'], ['hidden', 'Hidden']] }, value_ids: { ...many('product.attribute.value', 'Values'), compute: (r, db) => (db.records['product.attribute.value'] ?? []).filter((v) => v.attribute_id === r.id).map((v) => v.id) } },
    defaults: () => ({ active: true, display_type: 'radio', sequence: 10, visibility: 'visible' }), list: ['name', 'display_type', 'sequence', 'visibility', 'active'], form: { title: 'name', groups: [['display_type', 'sequence', 'visibility', 'active'], ['value_ids']], smart: [{ label: 'Values', model: 'product.attribute.value', field: 'attribute_id', target: 'inventory/attribute-values' }] },
  },
  'product.attribute.value': {
    label: 'Attribute Values', fields: { name: { type: 'char', label: 'Name', required: true }, sequence: { type: 'integer', label: 'Sequence' }, attribute_id: { ...relation('product.attribute', 'Attribute'), required: true }, default_extra_price: { type: 'float', label: 'Extra Price' }, is_custom: { type: 'boolean', label: 'Custom Value' }, html_color: { type: 'char', label: 'HTML Color' }, color: { type: 'integer', label: 'Color' }, active: { type: 'boolean', label: 'Active' } },
    defaults: () => ({ sequence: 10, default_extra_price: 0, active: true }), list: ['name', 'attribute_id', 'sequence', 'default_extra_price', 'active'], form: { title: 'name', groups: [['attribute_id', 'sequence', 'default_extra_price'], ['is_custom', 'html_color', 'color', 'active']] },
  },
  'product.template.attribute.line': { label: 'Attribute Lines', fields: { ...lineFields, product_id: relation('product', 'Product') }, defaults: () => ({ value_ids: [], sequence: 10 }), list: ['product_id', 'attribute_id', 'value_ids', 'sequence'], form: { groups: [['product_id', 'attribute_id', 'value_ids', 'sequence']] } },
  'product.tag': { label: 'Product Tags', fields: { name: { type: 'char', label: 'Name', required: true }, sequence: { type: 'integer', label: 'Sequence' }, color: { type: 'integer', label: 'Color' }, visible_to_customers: { type: 'boolean', label: 'Visible to Customers' } }, defaults: () => ({ sequence: 10, color: 0, visible_to_customers: false }), list: ['name', 'sequence', 'color', 'visible_to_customers'], form: { title: 'name', groups: [['sequence', 'color', 'visible_to_customers']] } },
  get product() {
    const base = ecommerceModels.product;
    return { ...base, fields: { ...base.fields, categ_id: relation('product.category', 'Product Category'), property_stock_valuation_account_id: account('Stock Valuation Account'), property_stock_journal: relation('account.journal', 'Stock Journal'), tag_ids: many('product.tag', 'Product Tags'), attribute_line_ids: { type: 'one2many', label: 'Attribute Lines', fields: lineFields, newLine: () => ({ attribute_id: null, value_ids: [], sequence: 10 }), onchange: (line, key) => key === 'attribute_id' ? { ...line, value_ids: [] } : line }, variant_value_ids: { ...many('product.attribute.value', 'Variant Values'), readonly: true } },
      defaults: (id) => ({ ...base.defaults(id), tag_ids: [], attribute_line_ids: [] }),
      createDefaults: (_db, vals) => vals.categ_id ? { cost_method: null, valuation: null } : {},
      onchange: (r, key, db) => ({ ...base.onchange?.(r, key, db), ...(key === 'categ_id' ? { cost_method: null, valuation: null } : {}) }),
      guard: (db, before, r) => base.guard?.(db, before, r) || ((r.attribute_line_ids ?? []).some((l) => !read(db, 'product.attribute', l.attribute_id) || !l.value_ids?.length || l.value_ids.some((id) => read(db, 'product.attribute.value', id)?.attribute_id !== l.attribute_id)) ? 'Select values belonging to each attribute' : null),
      filters: [...base.filters, [{ id: 'tagged', label: 'Tagged Products', fn: (r) => !!r.tag_ids?.length }]],
      list: base.list.map((f) => f === 'categ' ? 'categ_id' : f), groupBys: base.groupBys.map((f) => f === 'categ' ? 'categ_id' : f),
      graph: { ...base.graph, groupBy: 'categ_id' }, pivot: { ...base.pivot, row: 'categ_id' },
      form: { ...base.form, groups: base.form.groups.map((g) => g.map((f) => f === 'categ' ? 'categ_id' : f)).concat([['tag_ids', 'property_stock_valuation_account_id', 'property_stock_journal']]), tabs: [...base.form.tabs, { label: 'Attributes & Variants', fields: ['attribute_line_ids', 'variant_value_ids'] }] },
    };
  },
};
