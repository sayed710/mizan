// Taxes (percent/fixed, price-included, cash basis) and fiscal positions that remap taxes and accounts per partner.
import { read, search } from '../orm.js';
import { roundCurrency } from '../money.js';

/** Cash-basis taxes wait on these transition accounts until the invoice is paid. */
export const TRANSITION = { sale: '251100', purchase: '131100' };

/** What an order/invoice line keeps of its tax, so totals never need the db. */
export const taxSnapshot = (tax, db = null, fpId = null) => {
  if (!tax) return { tax_id: null, tax: 0, tax_type: 'percent', tax_include: false, tax_cash_basis: false, tax_tag_ids: [], tax_account_id: null, tax_name: '' };
  const base = {
    tax_id: tax.id,
    tax: Number(tax.amount) || 0,
    tax_type: tax.amount_type || 'percent',
    tax_include: !!tax.price_include,
    tax_cash_basis: tax.tax_exigibility === 'on_payment',
    tax_tag_ids: [...(tax.tag_ids ?? [])],
    tax_account_id: tax.account_id ?? null,
    tax_name: tax.name,
    ...(tax.include_base_amount ? { tax_include_base_amount: true } : {}),
    ...(tax.is_base_affected === false ? { tax_is_base_affected: false } : {}),
    ...(tax.sequence != null && Number(tax.sequence) !== 1 ? { tax_sequence: Number(tax.sequence) } : {}),
  };
  if (tax.amount_type === 'group') {
    const children = db
      ? expandTaxIds(db, [tax.id], fpId)
      : Array.isArray(tax.children_taxes) ? tax.children_taxes : [];
    return { ...base, tax_breakdown: children.map((c) => taxSnapshot(c)) };
  }
  return base;
};

/** The tax a fiscal position substitutes for `taxId` (the same tax when unmapped; null when mapped to no tax). */
export function mapTax(db, fpId, taxId) {
  const rule = (read(db, 'account.fiscal.position', fpId)?.tax_ids ?? []).find((m) => m.tax_src_id === taxId);
  return rule ? rule.tax_dest_id ?? null : taxId;
}

export function mapAccount(db, fpId, accountId) {
  const rule = (read(db, 'account.fiscal.position', fpId)?.account_ids ?? []).find((m) => m.account_src_id === accountId);
  return rule?.account_dest_id ?? accountId;
}

/** Expand tax IDs (including group taxes and fiscal position mappings) into flat sorted component tax records at selection time. */
export function expandTaxIds(db, taxIds = [], fpId = null) {
  if (!db) return [];
  const seen = new Set();
  const flatten = (ids) => {
    const recs = ids
      .map((id) => (fpId ? mapTax(db, fpId, id) : id))
      .filter(Boolean)
      .map((id) => read(db, 'account.tax', id))
      .filter(Boolean)
      .sort((a, b) => (Number(a.sequence ?? 1) - Number(b.sequence ?? 1)) || ((a.id ?? 0) - (b.id ?? 0)));
    const out = [];
    for (const t of recs) {
      if (t.amount_type === 'group') {
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        out.push(...flatten(t.children_tax_ids ?? []));
      } else {
        out.push(t);
      }
    }
    return out;
  };
  return flatten(taxIds);
}

/** Resolve the sequence of component tax descriptors strictly from the line's stored tax snapshot (never reading account.tax from db). */
export function resolveLineTaxes(l) {
  if (!l || isSectionOrNote(l)) return [];
  if (Array.isArray(l.tax_breakdown) && l.tax_breakdown.length) {
    return [...l.tax_breakdown].sort((a, b) => (Number(a.tax_sequence ?? 1) - Number(b.tax_sequence ?? 1)) || ((a.tax_id ?? 0) - (b.tax_id ?? 0)));
  }
  if (l.tax_id || l.tax_name || (Number(l.tax) || 0) !== 0 || l.tax_cash_basis || l.tax_tag_ids?.length) {
    return [{
      tax_id: l.tax_id ?? null,
      tax: Number(l.tax) || 0,
      tax_type: l.tax_type || 'percent',
      tax_include: !!l.tax_include,
      tax_cash_basis: !!l.tax_cash_basis,
      tax_tag_ids: [...(l.tax_tag_ids ?? [])],
      tax_account_id: l.tax_account_id ?? null,
      tax_name: l.tax_name || '',
      tax_include_base_amount: !!l.tax_include_base_amount,
      tax_is_base_affected: l.tax_is_base_affected !== false,
      tax_sequence: Number(l.tax_sequence ?? 1),
    }];
  }
  return [];
}

/** Fiscal position for a partner: its own one, else the first auto-applied position for its country. */
export function fiscalPositionFor(db, partnerId) {
  const p = read(db, 'res.partner', partnerId);
  if (!p) return null;
  if (p.property_account_position_id) return p.property_account_position_id;
  const country = (p.country ?? '').trim().toLowerCase();
  const matches = search(db, 'account.fiscal.position').filter((fp) => fp.auto_apply && country && (fp.country ?? '').trim().toLowerCase() === country && (!fp.vat_required || String(p.vat ?? '').trim()));
  matches.sort((a, b) => (Number(a.sequence ?? 10) - Number(b.sequence ?? 10)) || a.id - b.id);
  return matches[0]?.id ?? null;
}

/** Line tax values for a product (sales or purchase side) after the fiscal position. */
export function productTax(db, product, side, fpId) {
  const own = product?.[side === 'purchase' ? 'supplier_tax_id' : 'tax_id'];
  // A product without a tax record carries only a plain percentage; it never borrows a tax record by matching rates.
  const percent = product?.[side === 'purchase' ? 'purchase_tax' : 'sale_tax'];
  if (own == null) return percent != null ? { ...taxSnapshot(null), tax: Number(percent) || 0 } : null;
  return taxSnapshot(read(db, 'account.tax', mapTax(db, fpId, own)), db, fpId);
}

/** Name a tax goes by on journal items and in the tax return: the tax's own name, else its rate. */
export const taxLabel = (l) => l.tax_name || `${Number(l.tax) || 0}%`;

/** Display-only lines must not contribute to accounting amounts. */
export const isSectionOrNote = (line) => Boolean(line && ['line_section', 'line_note'].includes(line.display_type));

const gross = (l) => (Number(l.qty) || 0) * (Number(l.price_unit) || 0) * (1 - (Number(l.discount) || 0) / 100);

/**
 * Compute untaxed base and per-tax breakdown for a single line strictly from its snapshot (Odoo 20 tax engine:
 * price-included taxes, include_base_amount / is_base_affected, group taxes, fixed taxes,
 * and round_per_line vs round_globally).
 */
export function computeLineTaxes(l, { currency = null, roundingMethod = null } = {}) {
  const roundPerLine = roundingMethod === 'round_per_line';
  if (!l || isSectionOrNote(l)) return { untaxed: 0, tax: 0, total: 0, taxes: [] };
  const qty = Number(l.qty) || 0;
  const g = gross(l);
  const specs = resolveLineTaxes(l);
  if (!specs.length) {
    const base = roundPerLine ? roundCurrency(g, currency) : g;
    return { untaxed: base, tax: 0, total: base, taxes: [] };
  }
  // 1. Solve the exact affine relation G = a * B0 + c for price-included taxes in sequence.
  let inclA = 1;
  let inclC = 0;
  let extraA = 0;
  let extraC = 0;
  for (const t of specs) {
    const baseA = t.tax_is_base_affected !== false ? 1 + extraA : 1;
    const baseC = t.tax_is_base_affected !== false ? extraC : 0;
    const amt = Number(t.tax) || 0;
    const taxA = t.tax_type === 'fixed' ? 0 : baseA * (amt / 100);
    const taxC = t.tax_type === 'fixed' ? qty * amt : baseC * (amt / 100);
    if (t.tax_include) {
      inclA += taxA;
      inclC += taxC;
    }
    if (t.tax_include_base_amount) {
      extraA += taxA;
      extraC += taxC;
    }
  }
  const rawBase0 = inclA !== 0 ? (g - inclC) / inclA : g;
  let base0 = roundPerLine ? roundCurrency(rawBase0, currency) : rawBase0;
  // 2. Forward pass through all taxes in sequence.
  let extraBase = 0;
  const taxes = [];
  for (const t of specs) {
    const curBase = (t.tax_is_base_affected !== false ? base0 + extraBase : base0);
    const amt = Number(t.tax) || 0;
    const rawTax = t.tax_type === 'fixed' ? qty * amt : (curBase * amt) / 100;
    const taxAmt = roundPerLine ? roundCurrency(rawTax, currency) : rawTax;
    const baseAmt = roundPerLine ? roundCurrency(curBase, currency) : curBase;
    taxes.push({ ...t, base: baseAmt, amount: taxAmt });
    if (t.tax_include_base_amount) {
      extraBase += taxAmt;
    }
  }
  if (roundPerLine && specs.some((t) => t.tax_include)) {
    const inclSum = roundCurrency(taxes.filter((t) => t.tax_include).reduce((s, t) => s + t.amount, 0), currency);
    const roundedGross = roundCurrency(g, currency);
    if (roundCurrency(base0 + inclSum - roundedGross, currency) !== 0) {
      base0 = roundCurrency(roundedGross - inclSum, currency);
      if (taxes.length && taxes[0].tax_is_base_affected !== false) taxes[0].base = base0;
    }
  }
  const totalTax = roundPerLine
    ? roundCurrency(taxes.reduce((s, t) => s + t.amount, 0), currency)
    : taxes.reduce((s, t) => s + t.amount, 0);
  const total = roundPerLine ? roundCurrency(base0 + totalTax, currency) : base0 + totalTax;
  return { untaxed: base0, tax: totalTax, total, taxes };
}

/** Tax and base per (account, tax) in company currency; `accountOf(line)` picks each line's tax account. */
export function taxGroups(lines, accountOf, rate = 1, documentCurrency = null, companyCurrency = null, { roundingMethod = null, taxFilter = () => true } = {}) {
  const by = new Map();
  for (const l of lines ?? []) {
    if (isSectionOrNote(l)) continue;
    const computed = computeLineTaxes(l, { currency: documentCurrency, roundingMethod });
    for (const t of computed.taxes) {
      if (!taxFilter(t)) continue;
      if (t.amount === 0 && !t.tax_cash_basis) continue;
      const account_id = accountOf({ ...l, ...t });
      const tax_name = taxLabel(t);
      const tax_id = t.tax_id ?? null;
      const tax_tag_ids = [...(t.tax_tag_ids ?? [])].sort((a, b) => a - b);
      const key = `${account_id}|${tax_id ?? ''}|${tax_tag_ids.join(',')}`;
      const g = by.get(key) ?? { account_id, tax_id, tax_name, tax_tag_ids, document_base: 0, document_amount: 0 };
      by.set(key, { ...g, document_base: g.document_base + t.base, document_amount: g.document_amount + t.amount });
    }
  }
  return [...by.values()].map(({ document_base, document_amount, ...group }) => {
    const tax = roundCurrency(document_amount, documentCurrency);
    const base = roundCurrency(document_base, documentCurrency);
    return { ...group, amount: roundCurrency(tax / rate, companyCurrency), base: roundCurrency(base / rate, companyCurrency), document_amount: tax };
  });
}

/** Cash-basis tax per final account and tax (company currency) carried by an invoice's lines. */
export const cashBasisTaxes = (lines, rate = 1, documentCurrency = null, companyCurrency = null, options = {}) =>
  taxGroups(
    (lines ?? []).filter((l) => resolveLineTaxes(l).some((t) => t.tax_cash_basis)),
    (l) => l.tax_account_id,
    rate,
    documentCurrency,
    companyCurrency,
    { ...options, taxFilter: (t) => t.tax_cash_basis },
  ).filter((g) => g.amount || g.base);

/** Tax of one line: fixed per unit, or a percentage added to / included in the price. */
export function lineTaxOf(l) {
  if (isSectionOrNote(l)) return 0;
  return computeLineTaxes(l).tax;
}
export const lineUntaxed = (l) => isSectionOrNote(l) ? 0 : computeLineTaxes(l).untaxed;

const TAX_TYPES = [['sale', 'Sales'], ['purchase', 'Purchases'], ['none', 'None']];

export const taxModels = {
  'account.tax.group': {
    label: 'Tax Groups',
    fields: {
      name: { type: 'char', label: 'Name', required: true },
    },
    list: ['name'],
    form: { title: 'name', groups: [[], []], chatter: true },
  },
  'account.tax': {
    label: 'Taxes',
    guard: (db, before, after) => {
      if ((after.tag_ids ?? []).some((id) => read(db, 'account.account.tag', id)?.applicability !== 'taxes')) return 'Select only tax tags';
      if (after.amount_type === 'group') {
        const children = after.children_tax_ids ?? [];
        if (after.id && children.includes(after.id)) return 'A group tax cannot include itself';
        if (children.some((id) => !read(db, 'account.tax', id))) return 'Select existing child taxes';
      }
      return null;
    },
    fields: {
      name: { type: 'char', label: 'Tax Name', required: true },
      sequence: { type: 'integer', label: 'Sequence' },
      amount_type: { type: 'selection', label: 'Tax Computation', options: [['percent', 'Percentage'], ['fixed', 'Fixed'], ['group', 'Group of Taxes']] },
      amount: { type: 'float', label: 'Amount' },
      children_tax_ids: { type: 'many2many', relation: 'account.tax', label: 'Child Taxes' },
      type_tax_use: { type: 'selection', label: 'Tax Type', options: TAX_TYPES },
      description: { type: 'char', label: 'Label on Invoices' },
      price_include: { type: 'boolean', label: 'Included in Price' },
      include_base_amount: { type: 'boolean', label: 'Affect Base of Subsequent Taxes' },
      is_base_affected: { type: 'boolean', label: 'Base Affected by Previous Taxes' },
      tax_exigibility: { type: 'selection', label: 'Tax Exigibility', options: [['on_invoice', 'Based on Invoice'], ['on_payment', 'Based on Payment']] },
      account_id: { type: 'many2one', relation: 'account.account', label: 'Tax Account' },
      tax_group: { type: 'char', label: 'Tax Group' },
      tax_group_id: { type: 'many2one', relation: 'account.tax.group', label: 'Tax Group' },
      tag_ids: { type: 'many2many', relation: 'account.account.tag', label: 'Tags', domain: (r) => r.applicability === 'taxes' },
      active: { type: 'boolean', label: 'Active' },
    },
    defaults: () => ({ sequence: 1, amount_type: 'percent', amount: 14, children_tax_ids: [], type_tax_use: 'sale', tax_exigibility: 'on_invoice', price_include: false, include_base_amount: false, is_base_affected: true, active: true, tax_group: 'VAT', tag_ids: [] }),
    groupBys: ['type_tax_use', 'tax_group'],
    filters: [[{ id: 'sale', label: 'Sales', fn: (r) => r.type_tax_use === 'sale' }, { id: 'purchase', label: 'Purchases', fn: (r) => r.type_tax_use === 'purchase' }]],
    kanban: { title: 'name', lines: ['type_tax_use', 'amount'] },
    list: ['name', 'type_tax_use', 'amount_type', 'amount', 'price_include', 'include_base_amount', 'tax_exigibility', 'tag_ids'],
    form: {
      title: 'name',
      groups: [['amount_type', 'amount', 'children_tax_ids', 'sequence', 'description', 'type_tax_use', 'tag_ids'], ['account_id', 'tax_group_id', 'tax_group', 'price_include', 'include_base_amount', 'is_base_affected', 'tax_exigibility', 'active']],
      chatter: true,
    },
  },

  'account.fiscal.position': {
    label: 'Fiscal Positions',
    fields: {
      name: { type: 'char', label: 'Fiscal Position', required: true },
      sequence: { type: 'integer', label: 'Sequence' },
      auto_apply: { type: 'boolean', label: 'Detect Automatically' },
      vat_required: { type: 'boolean', label: 'VAT Required' },
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
    defaults: () => ({ sequence: 10, auto_apply: false, vat_required: false, tax_ids: [], account_ids: [] }),
    kanban: { title: 'name', lines: ['country'] },
    list: ['sequence', 'name', 'country', 'auto_apply'],
    form: {
      title: 'name',
      groups: [['sequence', 'auto_apply', 'country', 'vat_required'], []],
      tabs: [{ label: 'Tax Mapping', fields: ['tax_ids'] }, { label: 'Account Mapping', fields: ['account_ids'] }, { label: 'Legal Notes', fields: ['note'] }],
      chatter: true,
    },
  },
};
