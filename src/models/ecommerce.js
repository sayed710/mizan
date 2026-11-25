// eCommerce: website categories, payment providers, and the website fields added to existing models.
import { read } from '../orm.js';
import { documentCurrency, roundCurrency } from '../money.js';
import { isLiquidityJournal } from './ledger.js';
import { crmModels } from './crm.js';
import { logisticsModels } from './logistics.js';
import { pricelistModels } from './pricelist.js';
import { salesModels } from './sales.js';
import { billControlModels } from './billcontrol.js';
import { paymentProviderGuard } from './paymentmethod.js';

const RIBBONS = [['', 'None'], ['sale', 'Sale'], ['new', 'New'], ['sold_out', 'Sold out']];
export const PAYMENT_PROVIDERS = [['wire', 'Wire Transfer'], ['cod', 'Cash on Delivery'], ['demo', 'Demo']];
const IMMUTABLE_TX_FIELDS = ['reference', 'move_id', 'provider_id', 'provider_code', 'amount', 'currency_id', 'company_id'];
const ALLOWED_TX_TRANSITIONS = {
  pending: new Set(['done', 'cancel', 'error', 'superseded']),
  superseded: new Set(['done']),
};

/** Validate `payment.transaction` integrity, immutability, state transitions and settlement linkage. */
function paymentTransactionGuard(db, before, rec) {
  const ref = String(rec.reference ?? '').trim();
  if (!ref) return 'Payment transaction reference is required';
  if ((db.records['payment.transaction'] ?? []).some((t) => t.id !== rec.id && String(t.reference ?? '').trim() === ref)) {
    return 'Payment transaction reference must be unique';
  }
  if (before && IMMUTABLE_TX_FIELDS.some((k) => rec[k] !== before[k])) {
    return 'Payment transaction details cannot be modified after creation';
  }
  if (before?.payment_id && rec.payment_id !== before.payment_id) {
    return 'Payment transaction details cannot be modified after creation';
  }
  const txCompany = rec.company_id ?? 1;
  const move = (db.records['account.move'] ?? []).find((m) => m.id === rec.move_id);
  if (!move || move.move_type !== 'out_invoice' || move.state !== 'posted' || (move.company_id ?? 1) !== txCompany) {
    return 'Payment transaction invoice must be a posted customer invoice of the same company';
  }
  const provider = (db.records['payment.provider'] ?? []).find((p) => p.id === rec.provider_id);
  if (!provider || provider.code !== rec.provider_code || (provider.company_id && provider.company_id !== txCompany)) {
    return 'Payment transaction provider does not match the selected provider or company';
  }
  if (!before) {
    if (rec.state !== 'pending') return 'New payment transactions must start in Pending state';
  } else if (rec.state !== before.state && !ALLOWED_TX_TRANSITIONS[before.state]?.has(rec.state)) {
    return 'Invalid payment transaction status transition';
  }
  if (rec.state === 'pending' && (db.records['payment.transaction'] ?? []).some(
    (t) => t.id !== rec.id && t.move_id === rec.move_id && t.state === 'pending',
  )) {
    return 'An active pending payment transaction already exists for this invoice';
  }
  if (rec.state !== 'done' && rec.payment_id) {
    return 'Only completed payment transactions can link a payment';
  }
  if (rec.state === 'done') {
    const payment = rec.payment_id ? (db.records['account.payment'] ?? []).find((p) => p.id === rec.payment_id) : null;
    if (!payment || payment.state !== 'posted' || (payment.company_id ?? 1) !== txCompany) {
      return 'Completed payment transactions require a posted payment of the same company';
    }
    if (payment.payment_type !== 'inbound' || payment.partner_type !== 'customer') {
      return 'Completed payment transactions require an inbound customer payment';
    }
    if (payment.partner_id !== move.partner_id) {
      return 'Completed payment transaction payment must belong to the invoice partner';
    }
    if (payment.invoice_id && payment.invoice_id !== rec.move_id) {
      return 'Completed payment transaction payment cannot belong to another invoice';
    }
    if ((db.records['payment.transaction'] ?? []).some((t) => t.id !== rec.id && t.payment_id === rec.payment_id)) {
      return 'Payment is already linked to another payment transaction';
    }
    const txCurrency = documentCurrency(db, rec);
    const payCurrency = documentCurrency(db, payment);
    if (!txCurrency || !payCurrency || payCurrency.id !== txCurrency.id || roundCurrency(payment.amount, txCurrency) !== roundCurrency(rec.amount, txCurrency)) {
      return 'Completed payment transaction payment must match the transaction currency and amount';
    }
  }
  return null;
}

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
    payment_provider: { type: 'selection', label: 'Payment Provider', readonly: true, options: PAYMENT_PROVIDERS },
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
      code: { type: 'selection', label: 'Code', required: true, options: PAYMENT_PROVIDERS },
      state: { type: 'selection', label: 'State', tracking: true, options: [['enabled', 'Enabled'], ['disabled', 'Disabled']] },
      journal_id: { type: 'many2one', relation: 'account.journal', label: 'Payment Journal', domain: (j) => isLiquidityJournal(j) },
      company_id: { type: 'many2one', relation: 'res.company', label: 'Company', default: 1 },
      pending_msg: { type: 'text', label: 'Payment Instructions' },
      done_msg: { type: 'text', label: 'Done Message' },
    },
    defaults: () => ({ state: 'disabled', code: 'wire', journal_id: null, company_id: 1, pending_msg: '', done_msg: '' }),
    guard: paymentProviderGuard,
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
      groups: [['code', 'journal_id'], ['company_id']],
      tabs: [{ label: 'Messages', fields: ['pending_msg', 'done_msg'] }],
    },
  },

  'payment.transaction': {
    label: 'Payment Transactions',
    fields: {
      reference: { type: 'char', label: 'Reference', required: true },
      provider_reference: { type: 'char', label: 'Provider Reference' },
      move_id: { type: 'many2one', relation: 'account.move', label: 'Invoice', required: true },
      provider_id: { type: 'many2one', relation: 'payment.provider', label: 'Payment Provider', required: true },
      provider_code: { type: 'selection', label: 'Provider Code', required: true, options: PAYMENT_PROVIDERS },
      payment_id: { type: 'many2one', relation: 'account.payment', label: 'Payment', readonly: true },
      amount: { type: 'monetary', label: 'Amount', required: true },
      currency_id: { type: 'many2one', relation: 'res.currency', label: 'Currency', required: true },
      state: { type: 'selection', label: 'Status', tracking: true, options: [['pending', 'Pending'], ['superseded', 'Superseded'], ['done', 'Done'], ['cancel', 'Cancelled'], ['error', 'Error']] },
      redirect_url: { type: 'char', label: 'Redirect URL', readonly: true },
      company_id: { type: 'many2one', relation: 'res.company', label: 'Company', default: 1 },
    },
    defaults: () => ({ state: 'pending', company_id: 1 }),
    guard: paymentTransactionGuard,
    protectDelete: (_db, r) => (r.state === 'done' ? 'Completed payment transactions cannot be deleted' : null),
    list: ['reference', 'move_id', 'provider_id', 'amount', 'currency_id', 'state'],
    form: {
      title: 'reference',
      statusbar: 'state',
      groups: [['move_id', 'provider_id', 'provider_code'], ['amount', 'currency_id', 'company_id'], ['provider_reference', 'payment_id', 'redirect_url']],
    },
  },
};
