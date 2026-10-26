// eCommerce: website categories, payment providers, and the website fields added to existing models.
import { read } from '../orm.js';
import { crmModels } from './crm.js';
import { logisticsModels } from './logistics.js';
import { pricelistModels } from './pricelist.js';
import { salesModels } from './sales.js';
import { billControlModels } from './billcontrol.js';

const RIBBONS = [['', 'None'], ['sale', 'Sale'], ['new', 'New'], ['sold_out', 'Sold out']];

/** A copy of `base` with extra fields (and optional overrides); the original definition stays untouched. */
const extend = (base, fields, rest = {}) => ({ ...base, ...rest, fields: { ...base.fields, ...fields } });

/** "Furniture / Desks": a public category name with its parents (stops on loops). */
export function categoryPath(db, id) {
  const names = [];
  const seen = new Set();
  for (let c = read(db, 'product.public.category', id); c && !seen.has(c.id); c = read(db, 'product.public.category', c.parent_id)) {
    seen.add(c.id);
    names.unshift(c.name);
  }
  return names.join(' / ');
}

// Built on the bill-control product (itself built on valuation's), so costing, valuation and bill control fields survive.
const product = billControlModels.product;
const order = salesModels['sale.order'];

export const ecommerceModels = {
  product: extend(product, {
    is_published: { type: 'boolean', label: 'Published on Website' },
    public_categ_ids: {
      type: 'one2many',
      label: 'Website Categories',
      fields: { category_id: { type: 'many2one', relation: 'product.public.category', label: 'Category' } },
      newLine: () => ({ category_id: null }),
    },
    website_description: { type: 'text', label: 'Website Description' },
    image: { type: 'binary', label: 'Image' },
    website_sequence: { type: 'integer', label: 'Website Sequence' },
    ribbon: { type: 'selection', label: 'Ribbon', options: RIBBONS },
  }, {
    defaults: (id) => {
      const base = product.defaults(id);
      return { ...base, is_published: base.sale_ok !== false, website_sequence: id * 10, ribbon: '', public_categ_ids: [] };
    },
    form: { ...product.form, tabs: [...product.form.tabs, { label: 'eCommerce', fields: ['is_published', 'website_sequence', 'ribbon', 'image', 'public_categ_ids', 'website_description'] }] },
  }),

  'res.partner': extend(crmModels['res.partner'], {
    street: { type: 'char', label: 'Street' },
    zip: { type: 'char', label: 'Zip' },
  }),

  'sale.order': extend(order, {
    payment_provider: { type: 'selection', label: 'Payment Provider', readonly: true, options: [['wire', 'Wire Transfer'], ['cod', 'Cash on Delivery'], ['demo', 'Demo']] },
    payment_state: { type: 'selection', label: 'Payment Status', readonly: true, options: [['pending', 'Pending'], ['paid', 'Paid']] },
    // SHA-256 of the visitor's order-status token; the raw token is only ever given to the visitor.
    access_token_hash: { type: 'char', label: 'Access Token Hash', readonly: true, hidden: true },
  }, {
    form: { ...order.form, groups: [order.form.groups[0], [...order.form.groups[1], 'payment_provider', 'payment_state']] },
  }),

  'delivery.carrier': extend(logisticsModels['delivery.carrier'], {
    is_published: { type: 'boolean', label: 'Published on Website' },
  }, {
    defaults: () => ({ ...logisticsModels['delivery.carrier'].defaults(), is_published: false }),
    form: { ...logisticsModels['delivery.carrier'].form, groups: [[...logisticsModels['delivery.carrier'].form.groups[0], 'is_published'], logisticsModels['delivery.carrier'].form.groups[1]] },
  }),

  'product.pricelist': extend(pricelistModels['product.pricelist'], {
    selectable: { type: 'boolean', label: 'Selectable on Website' },
  }, {
    form: { ...pricelistModels['product.pricelist'].form, groups: [['selectable'], []] },
  }),

  'product.public.category': {
    label: 'Product Categories',
    fields: {
      name: { type: 'char', label: 'Name', required: true },
      parent_id: { type: 'many2one', relation: 'product.public.category', label: 'Parent Category' },
      sequence: { type: 'integer', label: 'Sequence' },
      image: { type: 'binary', label: 'Image' },
    },
    defaults: (id) => ({ sequence: id * 10, parent_id: null }),
    kanban: { title: 'name', lines: ['parent_id'] },
    list: ['sequence', 'name', 'parent_id'],
    form: { title: 'name', groups: [['parent_id', 'sequence'], ['image']] },
  },

  'payment.provider': {
    label: 'Payment Providers',
    fields: {
      name: { type: 'char', label: 'Name', required: true },
      code: { type: 'selection', label: 'Code', required: true, options: [['wire', 'Wire Transfer'], ['cod', 'Cash on Delivery'], ['demo', 'Demo']] },
      state: { type: 'selection', label: 'State', tracking: true, options: [['enabled', 'Enabled'], ['disabled', 'Disabled']] },
      pending_msg: { type: 'text', label: 'Payment Instructions' },
      done_msg: { type: 'text', label: 'Done Message' },
    },
    defaults: () => ({ state: 'disabled', code: 'wire', pending_msg: '', done_msg: '' }),
    filters: [[{ id: 'enabled', label: 'Enabled', fn: (r) => r.state === 'enabled' }]],
    kanban: { title: 'name', lines: ['code'], badge: 'state' },
    list: ['name', 'code', 'state'],
    form: {
      title: 'name',
      buttons: [
        { label: 'Enable', primary: true, vals: { state: 'enabled' }, when: (r) => r.state !== 'enabled' },
        { label: 'Disable', vals: { state: 'disabled' }, when: (r) => r.state === 'enabled' },
      ],
      statusbar: 'state',
      groups: [['code'], []],
      tabs: [{ label: 'Messages', fields: ['pending_msg', 'done_msg'] }],
    },
  },
};
