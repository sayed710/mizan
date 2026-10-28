import { read } from '../orm.js';
import { categoryPath } from './productconfig-helpers.js';
export { categoryPath, productProperty, migrateProductCategories } from './productconfig-helpers.js';
import { ecommerceModels } from './ecommerce.js';

const relation = (relation, label) => ({ type: 'many2one', relation, label });
const many = (relation, label) => ({ type: 'many2many', relation, label });
const account = (label) => relation('account.account', label);
const costing = { type: 'selection', label: 'Costing Method', options: [['standard', 'Standard Price'], ['average', 'Average Cost'], ['fifo', 'FIFO']] };
const valuation = { type: 'selection', label: 'Inventory Valuation', options: [['periodic', 'Manual Periodic'], ['real_time', 'Automated']] };

const lineFields = { attribute_id: { ...relation('product.attribute', 'Attribute'), required: true }, value_ids: { ...many('product.attribute.value', 'Values'), domain: (v, line) => v.attribute_id === line?.attribute_id }, sequence: { type: 'integer', label: 'Sequence' } };

export const productConfigModels = {
  'product.category': {
    label: 'Product Categories', fields: {
      name: { type: 'char', label: 'Name', required: true },
      display_name: { type: 'char', label: 'Full Path', compute: (r, db) => categoryPath(db, r.id) },
      parent_id: relation('product.category', 'Parent Category'), company_id: relation('res.company', 'Company'),
      property_cost_method: costing, property_valuation: valuation,
      property_account_income_id: account('Income Account'), property_account_expense_id: account('Expense Account'),
      property_stock_valuation_account_id: account('Stock Valuation Account'), property_stock_journal: relation('account.journal', 'Stock Journal'),
      removal_strategy: { type: 'selection', label: 'Removal Strategy', options: [['fifo', 'FIFO'], ['lifo', 'LIFO'], ['fefo', 'FEFO']] },
    },
    guard: (db, before, r) => { let id = r.parent_id; const seen = new Set([before?.id ?? r.id]); while (id) { if (seen.has(id)) return 'Category hierarchy cannot contain a cycle'; seen.add(id); id = read(db, 'product.category', id)?.parent_id; } return null; },
    list: ['display_name', 'parent_id', 'property_cost_method', 'property_valuation'],
    form: { title: 'name', groups: [['parent_id', 'company_id', 'removal_strategy'], ['property_cost_method', 'property_valuation'], ['property_account_income_id', 'property_account_expense_id', 'property_stock_valuation_account_id', 'property_stock_journal']] },
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
