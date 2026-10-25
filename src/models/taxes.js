// Taxes (percent/fixed, price-included, cash basis) and fiscal positions that remap taxes and accounts per partner.
import { read, search } from '../orm.js';

const round = (n) => Math.round(n * 100) / 100;
/** Cash-basis taxes wait on these transition accounts until the invoice is paid. */
export const TRANSITION = { sale: '251100', purchase: '131100' };

/** What an order/invoice line keeps of its tax, so totals never need the db. */
export const taxSnapshot = (tax) => (tax
  ? { tax_id: tax.id, tax: Number(tax.amount) || 0, tax_type: tax.amount_type, tax_include: !!tax.price_include, tax_account_id: tax.account_id ?? null, tax_cash_basis: tax.tax_exigibility === 'on_payment', tax_name: tax.name }
  : { tax_id: null, tax: 0, tax_type: 'percent', tax_include: false, tax_account_id: null, tax_cash_basis: false, tax_name: '' });

/** The tax a fiscal position substitutes for `taxId` (the same tax when unmapped; null when mapped to no tax). */
export function mapTax(db, fpId, taxId) {
  const rule = (read(db, 'account.fiscal.position', fpId)?.tax_ids ?? []).find((m) => m.tax_src_id === taxId);
  return rule ? rule.tax_dest_id ?? null : taxId;
}

export function mapAccount(db, fpId, accountId) {
  const rule = (read(db, 'account.fiscal.position', fpId)?.account_ids ?? []).find((m) => m.account_src_id === accountId);
  return rule?.account_dest_id ?? accountId;
}

/** Fiscal position for a partner: its own one, else the first auto-applied position for its country. */
export function fiscalPositionFor(db, partnerId) {
  const p = read(db, 'res.partner', partnerId);
  if (!p) return null;
  if (p.property_account_position_id) return p.property_account_position_id;
  const country = (p.country ?? '').trim().toLowerCase();
  return search(db, 'account.fiscal.position').find((fp) => fp.auto_apply && (fp.country ?? '').trim().toLowerCase() === country && country)?.id ?? null;
}

/** Line tax values for a product (sales or purchase side) after the fiscal position. */
export function productTax(db, product, side, fpId) {
  const own = product?.[side === 'purchase' ? 'supplier_tax_id' : 'tax_id'];
  // Products without a tax record fall back to the plain percentage they carry.
  const percent = product?.[side === 'purchase' ? 'purchase_tax' : 'sale_tax'];
  const legacy = own ?? search(db, 'account.tax').find((t) => t.type_tax_use === side && t.amount_type === 'percent' && !t.price_include && t.tax_exigibility !== 'on_payment' && Number(t.amount) === Number(percent))?.id;
  if (legacy == null) return percent != null ? { ...taxSnapshot(null), tax: Number(percent) || 0 } : null;
  return taxSnapshot(read(db, 'account.tax', mapTax(db, fpId, legacy)));
}

/** Cash-basis tax per final account (company currency) carried by an invoice's lines. */
export function cashBasisTaxes(lines, rate = 1) {
  const by = new Map();
  for (const l of lines ?? []) {
    if (!l.tax_cash_basis) continue;
    by.set(l.tax_account_id, (by.get(l.tax_account_id) ?? 0) + lineTaxOf(l) / rate);
  }
  return [...by].map(([account_id, amount]) => [account_id, round(amount)]).filter(([, a]) => a);
}

const gross = (l) => (Number(l.qty) || 0) * (Number(l.price_unit) || 0) * (1 - (Number(l.discount) || 0) / 100);
/** Tax of one line: fixed per unit, or a percentage added to / included in the price. */
export function lineTaxOf(l) {
  const t = Number(l.tax) || 0;
  if (l.tax_type === 'fixed') return (Number(l.qty) || 0) * t;
  return l.tax_include ? gross(l) - gross(l) / (1 + t / 100) : (gross(l) * t) / 100;
}
export const lineUntaxed = (l) => gross(l) - (l.tax_include ? lineTaxOf(l) : 0);

const TAX_TYPES = [['sale', 'Sales'], ['purchase', 'Purchases'], ['none', 'None']];

export const taxModels = {
  'account.tax': {
    label: 'Taxes',
    fields: {
      name: { type: 'char', label: 'Tax Name', required: true },
      amount_type: { type: 'selection', label: 'Tax Computation', options: [['percent', 'Percentage'], ['fixed', 'Fixed']] },
      amount: { type: 'float', label: 'Amount' },
      type_tax_use: { type: 'selection', label: 'Tax Type', options: TAX_TYPES },
      description: { type: 'char', label: 'Label on Invoices' },
      price_include: { type: 'boolean', label: 'Included in Price' },
      tax_exigibility: { type: 'selection', label: 'Tax Exigibility', options: [['on_invoice', 'Based on Invoice'], ['on_payment', 'Based on Payment']] },
      account_id: { type: 'many2one', relation: 'account.account', label: 'Tax Account' },
      tax_group: { type: 'char', label: 'Tax Group' },
      active: { type: 'boolean', label: 'Active' },
    },
    defaults: () => ({ amount_type: 'percent', amount: 14, type_tax_use: 'sale', tax_exigibility: 'on_invoice', price_include: false, active: true, tax_group: 'VAT' }),
    groupBys: ['type_tax_use', 'tax_group'],
    filters: [[{ id: 'sale', label: 'Sales', fn: (r) => r.type_tax_use === 'sale' }, { id: 'purchase', label: 'Purchases', fn: (r) => r.type_tax_use === 'purchase' }]],
    kanban: { title: 'name', lines: ['type_tax_use', 'amount'] },
    list: ['name', 'type_tax_use', 'amount_type', 'amount', 'price_include', 'tax_exigibility'],
    form: {
      title: 'name',
      groups: [['amount_type', 'amount', 'description', 'type_tax_use'], ['account_id', 'tax_group', 'price_include', 'tax_exigibility', 'active']],
      chatter: true,
    },
  },

  'account.fiscal.position': {
    label: 'Fiscal Positions',
    fields: {
      name: { type: 'char', label: 'Fiscal Position', required: true },
      auto_apply: { type: 'boolean', label: 'Detect Automatically' },
      country: { type: 'char', label: 'Country' },
      note: { type: 'text', label: 'Legal Notes' },
      tax_ids: {
        type: 'one2many', label: 'Tax Mapping',
        fields: { tax_src_id: { type: 'many2one', relation: 'account.tax', label: 'Tax on Product' }, tax_dest_id: { type: 'many2one', relation: 'account.tax', label: 'Tax to Apply' } },
        newLine: () => ({ tax_src_id: null, tax_dest_id: null }),
      },
      account_ids: {
        type: 'one2many', label: 'Account Mapping',
        fields: { account_src_id: { type: 'many2one', relation: 'account.account', label: 'Account on Product' }, account_dest_id: { type: 'many2one', relation: 'account.account', label: 'Account to Use Instead' } },
        newLine: () => ({ account_src_id: null, account_dest_id: null }),
      },
    },
    defaults: () => ({ auto_apply: false, tax_ids: [], account_ids: [] }),
    kanban: { title: 'name', lines: ['country'] },
    list: ['name', 'country', 'auto_apply'],
    form: {
      title: 'name',
      groups: [['auto_apply', 'country'], []],
      tabs: [{ label: 'Tax Mapping', fields: ['tax_ids'] }, { label: 'Account Mapping', fields: ['account_ids'] }, { label: 'Legal Notes', fields: ['note'] }],
      chatter: true,
    },
  },
};
