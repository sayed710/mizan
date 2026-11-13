// Taxes (percent/fixed, price-included, cash basis) and fiscal positions that remap taxes and accounts per partner.
import { read, search } from '../orm.js';
import { allocateCents, roundCurrency } from '../money.js';

import { configuredAccount } from './configured-account.js';

/** Whether a cash-basis release move pre-dates separate tax_grid_base lines. */
export const isLegacyCashBasisRelease = (move) => Boolean(move && !move.cash_basis_base_grid && !(move.line_ids ?? []).some((l) => l.tax_grid_base));

/** Whether a journal item is a non-zero tax's base-grid line (excluded from tax totals because its tax line carries the base). */
export const isNonZeroBaseGridLine = (line) => Boolean(line?.tax_grid_base && !line.tax_zero);

/** Cash basis uses the originating tax's explicit transition setting. */
export function cashBasisTransitionAccount(db, taxId, company) {
  const tax = read(db, 'account.tax', taxId);
  if (tax?.company_id && tax.company_id !== (company ?? 1)) throw new Error('The cash basis tax belongs to another company');
  return configuredAccount(db, tax?.cash_basis_transition_account_id, company, 'cash basis transition', tax?.name ?? 'the tax');
}

export function cashBasisTransitionAccounts(db, company) {
  // Only configured taxes can have booked a transition line; an incomplete tax must not block reports and locks.
  return search(db, 'account.tax').filter((tax) => tax.tax_exigibility === 'on_payment' && tax.cash_basis_transition_account_id && (!company || !tax.company_id || tax.company_id === company))
    .map((tax) => cashBasisTransitionAccount(db, tax.id, company ?? tax.company_id));
}

/** Repartition lines of a tax or line snapshot for the requested side ('invoice' or 'refund'). */
export function taxRepartitionLines(tax, side = 'invoice') {
  if (!tax) return [];
  const isRefund = side === 'refund' || ['out_refund', 'in_refund'].includes(side);
  const key = isRefund ? 'refund_repartition_line_ids' : 'invoice_repartition_line_ids';
  return tax[key] ?? [];
}

/** The applicable repartition line for a tax or line snapshot (defaults to the tax row on invoice side). */
/** Net share of a tax amount posted by its tax rows on one side (sum of factors / 100; 1 without explicit rows). */
export function taxRowsFactor(tax, side = 'invoice') {
  const rows = taxRepartitionLines(tax, side).filter((row) => row.repartition_type === 'tax');
  return rows.length ? rows.reduce((sum, row) => sum + (Number(row.factor_percent) || 0), 0) / 100 : 1;
}

export function taxRepartitionLine(tax, side = 'invoice', type = 'tax') {
  if (!tax) return null;
  if (tax.repartition_type) return tax;
  if (side === 'base' || side === 'tax') {
    type = side;
    side = 'invoice';
  } else if (typeof side === 'object' && side !== null) {
    type = side.type ?? 'tax';
    side = side.side ?? 'invoice';
  }
  return taxRepartitionLines(tax, side).find((l) => l.repartition_type === type) ?? null;
}

/** Base repartition tags for a tax or line snapshot on the requested side. */
export function taxBaseTags(tax, side = 'invoice', fallback = null) {
  const row = taxRepartitionLine(tax, side, 'base') ?? (fallback ? taxRepartitionLine(fallback, side, 'base') : null);
  return row?.tag_ids ?? [];
}

/** Default 1 base row and 1 100% tax row per side. */
export const defaultTaxRepartitionLines = (accountId = null, tagIds = [], baseTagIds = null) => {
  const baseTags = baseTagIds ? [...baseTagIds] : [...tagIds];
  const taxTags = [...tagIds];
  return {
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: baseTags },
      { repartition_type: 'tax', factor_percent: 100, account_id: accountId ?? null, tag_ids: taxTags },
    ],
    refund_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: baseTags },
      { repartition_type: 'tax', factor_percent: 100, account_id: accountId ?? null, tag_ids: taxTags },
    ],
  };
};

/** What an order/invoice line keeps of its tax, so totals never need the db. */
export const taxSnapshot = (tax, db = null, fpId = null) => {
  if (!tax) return { tax_id: null, tax: 0, tax_type: 'percent', tax_include: false, tax_cash_basis: false, tax_name: '', invoice_repartition_line_ids: [], refund_repartition_line_ids: [] };
  const invRepart = (tax.invoice_repartition_line_ids ?? []).map((l) => ({ ...l, tag_ids: [...(l.tag_ids ?? [])] }));
  const refRepart = (tax.refund_repartition_line_ids ?? []).map((l) => ({ ...l, tag_ids: [...(l.tag_ids ?? [])] }));
  const base = {
    tax_id: tax.id,
    tax: Number(tax.amount) || 0,
    tax_type: tax.amount_type || 'percent',
    tax_include: !!tax.price_include,
    tax_cash_basis: tax.tax_exigibility === 'on_payment',
    tax_name: tax.name,
    invoice_repartition_line_ids: invRepart,
    refund_repartition_line_ids: refRepart,
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

/** Replace all snapshot fields when merging a newly selected tax into a line. */
export const replaceTaxSnapshot = (snapshot) => ({ tax_breakdown: [], tax_include_base_amount: false, tax_is_base_affected: true, tax_sequence: 1, invoice_repartition_line_ids: [], refund_repartition_line_ids: [], ...snapshot });

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
  if (l.tax_id || l.tax_name || (Number(l.tax) || 0) !== 0 || l.tax_cash_basis || l.invoice_repartition_line_ids?.length || l.refund_repartition_line_ids?.length) {
    return [{
      tax_id: l.tax_id ?? null,
      tax: Number(l.tax) || 0,
      tax_type: l.tax_type || 'percent',
      tax_include: !!l.tax_include,
      tax_cash_basis: !!l.tax_cash_basis,
      tax_name: l.tax_name || '',
      tax_include_base_amount: !!l.tax_include_base_amount,
      tax_is_base_affected: l.tax_is_base_affected !== false,
      tax_sequence: Number(l.tax_sequence ?? 1),
      invoice_repartition_line_ids: [...(l.invoice_repartition_line_ids ?? [])],
      refund_repartition_line_ids: [...(l.refund_repartition_line_ids ?? [])],
    }];
  }
  return [];
}

/** Validate tax ownership, including mapped and grouped taxes. */
export function validateTaxCompany(db, ids, companyId, fpId = null) {
  if (!companyId) return;
  const seen = new Set();
  const visit = (id, map = true) => {
    if (!id || seen.has(`${id}:${map}`)) return;
    seen.add(`${id}:${map}`);
    const tax = read(db, 'account.tax', id);
    if (!tax) throw new Error('Selected tax does not exist');
    if (tax.company_id && tax.company_id !== companyId) throw new Error('Tax belongs to another company');
    const mapped = map && fpId ? mapTax(db, fpId, id) : id;
    if (mapped !== id) { visit(mapped, false); return; }
    for (const child of tax.children_tax_ids ?? []) visit(child);
  };
  for (const id of ids) visit(id);
}

/** Fiscal position for a partner: its own one, else the first auto-applied position for its country. */
export function fiscalPositionFor(db, partnerId, companyId = null) {
  const p = read(db, 'res.partner', partnerId);
  if (!p) return null;
  if (p.property_account_position_id) {
    const position = read(db, 'account.fiscal.position', p.property_account_position_id);
    if (!companyId || !position?.company_id || position.company_id === companyId) return p.property_account_position_id;
  }
  const country = (p.country ?? '').trim().toLowerCase();
  const matches = search(db, 'account.fiscal.position').filter((fp) => (!companyId || !fp.company_id || fp.company_id === companyId) && fp.auto_apply && country && (fp.country ?? '').trim().toLowerCase() === country && (!fp.vat_required || String(p.vat ?? '').trim()));
  matches.sort((a, b) => (Number(a.sequence ?? 10) - Number(b.sequence ?? 10)) || a.id - b.id);
  return matches[0]?.id ?? null;
}

/** Line tax values for a product (sales or purchase side) after the fiscal position. */
export function productTax(db, product, side, fpId, companyId = null) {
  const own = product?.[side === 'purchase' ? 'supplier_tax_id' : 'tax_id'];
  // A product without a tax record carries only a plain percentage; it never borrows a tax record by matching rates.
  const percent = product?.[side === 'purchase' ? 'purchase_tax' : 'sale_tax'];
  if (own == null) return percent != null ? { ...taxSnapshot(null), tax: Number(percent) || 0 } : null;
  validateTaxCompany(db, [own], companyId, fpId);
  const mapped = mapTax(db, fpId, own);
  return { ...taxSnapshot(read(db, 'account.tax', mapped), db, fpId), ...(mapped !== own ? { tax_source_id: own } : {}) };
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
export function computeLineTaxes(l, { currency = null, roundingMethod = null, side = 'invoice' } = {}) {
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
    const factor = taxRowsFactor(t, side);
    const baseA = t.tax_is_base_affected !== false ? 1 + extraA : 1;
    const baseC = t.tax_is_base_affected !== false ? extraC : 0;
    const amt = Number(t.tax) || 0;
    const taxA = t.tax_type === 'fixed' ? 0 : baseA * (amt / 100);
    const taxC = t.tax_type === 'fixed' ? qty * amt : baseC * (amt / 100);
    if (t.tax_include) {
      inclA += taxA * factor;
      inclC += taxC * factor;
    }
    if (t.tax_include_base_amount) {
      extraA += taxA * factor;
      extraC += taxC * factor;
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
      extraBase += taxAmt * taxRowsFactor(t, side);
    }
  }
  if (roundPerLine && specs.some((t) => t.tax_include)) {
    const inclSum = roundCurrency(taxes.filter((t) => t.tax_include).reduce((s, t) => s + taxRepartitionSplits(t, l, side, currency).splits.reduce((sum, split) => sum + split.amount, 0), 0), currency);
    const roundedGross = roundCurrency(g, currency);
    if (roundCurrency(base0 + inclSum - roundedGross, currency) !== 0) {
      base0 = roundCurrency(roundedGross - inclSum, currency);
      if (taxes.length && taxes[0].tax_is_base_affected !== false) taxes[0].base = base0;
    }
  }
  const totalTax = taxes.reduce((sum, t) => {
    const net = t.amount * taxRowsFactor(t, side);
    return sum + (roundPerLine ? roundCurrency(net, currency) : net);
  }, 0);
  const total = roundPerLine ? roundCurrency(base0 + totalTax, currency) : base0 + totalTax;
  return { untaxed: base0, tax: totalTax, total, taxes };
}

/** Tax and base per (account, tax) in company currency; `accountOf(line)` picks each line's tax account. */
export function taxGroups(lines, accountOf, rate = 1, documentCurrency = null, companyCurrency = null, { roundingMethod = null, taxFilter = () => true, side = 'invoice' } = {}) {
  const by = new Map();
  for (const l of lines ?? []) {
    if (isSectionOrNote(l)) continue;
    const computed = computeLineTaxes(l, { currency: documentCurrency, roundingMethod, side });
    for (const t of computed.taxes) {
      if (!taxFilter(t)) continue;
      if (t.amount === 0 && !t.tax_cash_basis) continue;
      for (const { row, amount, base } of taxRepartitionSplits(t, l, side, documentCurrency).splits) {
        const account_id = accountOf({ ...l, ...t, repartition_line: row });
        const tax_name = taxLabel(t);
        const tax_id = t.tax_id ?? null;
        const tax_tag_ids = [...(row.tag_ids ?? [])].sort((a, b) => a - b);
        const key = `${account_id}|${tax_id ?? ''}|${tax_tag_ids.join(',')}`;
        const g = by.get(key) ?? { account_id, tax_id, tax_name, tax_tag_ids, document_base: 0, document_amount: 0 };
        by.set(key, { ...g, document_base: g.document_base + base, document_amount: g.document_amount + amount });
      }
    }
  }
  return [...by.values()].map(({ document_base, document_amount, ...group }) => {
    const tax = roundCurrency(document_amount, documentCurrency);
    const base = roundCurrency(document_base, documentCurrency);
    return { ...group, amount: roundCurrency(tax / rate, companyCurrency), base: roundCurrency(base / rate, companyCurrency), document_amount: tax };
  });
}

/**
 * Split one computed tax over its 'tax' repartition rows (the tax's own, else the line snapshot's) by factor.
 * `explicit` is false for a plain-rate tax with no repartition, which then gets one row with the snapshot's account.
 */
export function taxRepartitionSplits(t, line, side, currency) {
  const own = taxRepartitionLines(t, side);
  const rows = (own.length ? own : taxRepartitionLines(line, side)).filter((r) => r.repartition_type === 'tax');
  const explicit = rows.length > 0;
  const taxRows = explicit ? rows : [{ repartition_type: 'tax', factor_percent: 100, account_id: t.tax_account_id ?? line.tax_account_id ?? null, tag_ids: t.tax_tag_ids ?? line.tax_tag_ids ?? [] }];
  const factors = taxRows.map((r) => Number(r.factor_percent) || 0);
  const split = (value) => {
    if (factors.length === 1 && factors[0] === 100) return [value];
    const portions = factors.map(() => 0);
    for (const sign of [1, -1]) {
      const indexes = factors.map((factor, index) => ({ factor, index })).filter(({ factor }) => Math.sign(factor) === sign);
      if (!indexes.length) continue;
      const total = roundCurrency(value * indexes.reduce((sum, item) => sum + item.factor, 0) / 100, currency);
      const allocated = allocateCents(total, indexes.map((item) => Math.abs(item.factor)), currency, { tieBreak: 'last' });
      indexes.forEach((item, i) => { portions[item.index] = allocated[i]; });
    }
    return portions;
  };
  const amounts = split(t.amount);
  const contributing = factors.reduce((best, f, i) => (Math.abs(f) > Math.abs(factors[best]) ? i : best), 0);
  return { explicit, splits: taxRows.map((row, i) => ({ row, amount: amounts[i], base: i === contributing ? t.base : 0 })) };
}

/** Cash-basis tax and base turnover per account and tags carried by an invoice's lines. */
export function cashBasisGroups(lines, rate = 1, documentCurrency = null, companyCurrency = null, options = {}) {
  const side = options.side ?? 'invoice';
  const byTax = new Map();
  const byBase = new Map();
  for (const l of lines ?? []) {
    if (isSectionOrNote(l)) continue;
    const computed = computeLineTaxes(l, { currency: documentCurrency, roundingMethod: options.roundingMethod ?? null, side });
    const accrualBaseTags = new Set(
      computed.taxes.filter((t) => !t.tax_cash_basis).flatMap((t) => taxBaseTags(t, side, l))
    );
    for (const t of computed.taxes) {
      if (!t.tax_cash_basis) continue;
      const { explicit, splits } = taxRepartitionSplits(t, l, side, documentCurrency);
      for (const { row, amount, base } of splits) {
        const rawAccount = row.account_id ? (options.mapAccount ? options.mapAccount(row.account_id) : row.account_id) : null;
        const account_id = rawAccount ?? (explicit ? options.lineAccount?.(l) : null) ?? null;
        const tax_id = t.tax_id ?? null;
        const tax_tag_ids = [...(row.tag_ids ?? [])].sort((x, y) => x - y);
        const key = `${account_id}|${tax_id ?? ''}|${tax_tag_ids.join(',')}`;
        const g = byTax.get(key) ?? { account_id, tax_id, tax_name: taxLabel(t), tax_tag_ids, cash_basis: true, document_base: 0, document_amount: 0 };
        byTax.set(key, { ...g, document_base: g.document_base + base, document_amount: g.document_amount + amount });
      }
    }
    const cbTaxes = computed.taxes.filter((t) => t.tax_cash_basis);
    if (cbTaxes.length) {
      const baseTags = [
        ...new Set(cbTaxes.flatMap((t) => taxBaseTags(t, side, l)))
      ]
        .filter((tagId) => !accrualBaseTags.has(tagId))
        .sort((a, b) => a - b);
      if (baseTags.length) {
        const account_id = options.lineAccount?.(l) ?? null;
        const key = `${account_id}|${baseTags.join(',')}`;
        const g = byBase.get(key) ?? { account_id, tax_tag_ids: baseTags, cash_basis: true, document_base: 0 };
        byBase.set(key, { ...g, document_base: g.document_base + computed.untaxed });
      }
    }
  }
  const taxes = [...byTax.values()].map(({ document_base, document_amount, ...group }) => {
    const tax = roundCurrency(document_amount, documentCurrency);
    const base = roundCurrency(document_base, documentCurrency);
    return { ...group, amount: roundCurrency(tax / rate, companyCurrency), base: roundCurrency(base / rate, companyCurrency), document_amount: tax };
  }).filter((g) => g.amount || g.base);
  const bases = [...byBase.values()].map(({ document_base, ...group }) => {
    const base = roundCurrency(document_base, documentCurrency);
    return { ...group, base: roundCurrency(base / rate, companyCurrency) };
  }).filter((g) => g.base);
  return { taxes, bases };
}

/** Tax of one line: fixed per unit, or a percentage added to / included in the price. */
export function lineTaxOf(l) {
  if (isSectionOrNote(l)) return 0;
  return computeLineTaxes(l).tax;
}
export const lineUntaxed = (l) => isSectionOrNote(l) ? 0 : computeLineTaxes(l).untaxed;

const TAX_TYPES = [['sale', 'Sales'], ['purchase', 'Purchases'], ['none', 'None']];

function validateRepartitionSide(lines, sideName) {
  if (!Array.isArray(lines) || !lines.length) {
    return `A tax must have repartition lines for ${sideName}`;
  }
  const baseRows = lines.filter((l) => l.repartition_type === 'base');
  if (baseRows.length !== 1) {
    return `A tax must have exactly one base row for ${sideName}`;
  }
  const taxRows = lines.filter((l) => l.repartition_type === 'tax');
  if (taxRows.length < 1) {
    return `A tax must have at least one tax row for ${sideName}`;
  }
  const factorSum = taxRows.reduce((sum, l) => sum + (Number(l.factor_percent) || 0), 0);
  if (Math.abs(factorSum - 100) > 1e-4 && !(Math.abs(factorSum) < 1e-4 && taxRows.some((l) => Number(l.factor_percent) < 0))) {
    return `Tax repartition factors must sum to 100 for ${sideName}`;
  }
  return null;
}

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
      // An on-payment tax cannot post without its transition account, so it is required when saving.
      if (after.cash_basis_transition_account_id || after.tax_exigibility === 'on_payment') {
        try { configuredAccount(db, after.cash_basis_transition_account_id, after.company_id, 'cash basis transition', after.name); } catch (error) { return error.message; }
      }
      for (const row of [...(after.invoice_repartition_line_ids ?? []), ...(after.refund_repartition_line_ids ?? [])]) {
        if (row.account_id) {
          const account = read(db, 'account.account', row.account_id);
          if (!account || (account.company_id && account.company_id !== (after.company_id ?? 1))) return 'Tax repartition account must belong to the tax company';
        }
      }
      const allTags = [
        ...(after.tag_ids ?? []),
        ...(after.invoice_repartition_line_ids ?? []).flatMap((l) => l.tag_ids ?? []),
        ...(after.refund_repartition_line_ids ?? []).flatMap((l) => l.tag_ids ?? []),
      ];
      if (allTags.some((id) => read(db, 'account.account.tag', id)?.applicability !== 'taxes')) return 'Select only tax tags';
      if (after.amount_type === 'group') {
        const children = after.children_tax_ids ?? [];
        if (after.id && children.includes(after.id)) return 'A group tax cannot include itself';
        if (children.some((id) => !read(db, 'account.tax', id))) return 'Select existing child taxes';
      } else {
        const invErr = validateRepartitionSide(after.invoice_repartition_line_ids, 'invoices');
        if (invErr) return invErr;
        const refErr = validateRepartitionSide(after.refund_repartition_line_ids, 'refunds');
        if (refErr) return refErr;
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
      cash_basis_transition_account_id: { type: 'many2one', relation: 'account.account', label: 'Cash Basis Transition Account' },
      tax_group: { type: 'char', label: 'Tax Group' },
      tax_group_id: { type: 'many2one', relation: 'account.tax.group', label: 'Tax Group' },
      invoice_repartition_line_ids: {
        type: 'one2many',
        label: 'Distribution for Invoices',
        fields: {
          repartition_type: { type: 'selection', label: 'Based On', options: [['base', 'Base'], ['tax', 'of Tax']], required: true },
          factor_percent: { type: 'float', label: '%', required: true },
          account_id: { type: 'many2one', relation: 'account.account', label: 'Account' },
          tag_ids: { type: 'many2many', relation: 'account.account.tag', label: 'Tax Grids', domain: (r) => r.applicability === 'taxes' },
        },
        newLine: () => ({ repartition_type: 'tax', factor_percent: 100, account_id: null, tag_ids: [] }),
      },
      refund_repartition_line_ids: {
        type: 'one2many',
        label: 'Distribution for Refunds',
        fields: {
          repartition_type: { type: 'selection', label: 'Based On', options: [['base', 'Base'], ['tax', 'of Tax']], required: true },
          factor_percent: { type: 'float', label: '%', required: true },
          account_id: { type: 'many2one', relation: 'account.account', label: 'Account' },
          tag_ids: { type: 'many2many', relation: 'account.account.tag', label: 'Tax Grids', domain: (r) => r.applicability === 'taxes' },
        },
        newLine: () => ({ repartition_type: 'tax', factor_percent: 100, account_id: null, tag_ids: [] }),
      },
      active: { type: 'boolean', label: 'Active' },
    },
    defaults: () => ({
      sequence: 1,
      amount_type: 'percent',
      amount: 14,
      children_tax_ids: [],
      type_tax_use: 'sale',
      tax_exigibility: 'on_invoice',
      price_include: false,
      include_base_amount: false,
      is_base_affected: true,
      active: true,
      tax_group: 'VAT',
      ...defaultTaxRepartitionLines(null, []),
    }),
    createDefaults: (db, vals) => {
      const invLines = vals.invoice_repartition_line_ids;
      const refLines = vals.refund_repartition_line_ids;
      if (!invLines && !refLines) {
        return defaultTaxRepartitionLines(null, []);
      }
      return {
        ...(invLines ? {} : { invoice_repartition_line_ids: defaultTaxRepartitionLines(null, []).invoice_repartition_line_ids }),
        ...(refLines ? {} : { refund_repartition_line_ids: defaultTaxRepartitionLines(null, []).refund_repartition_line_ids }),
      };
    },
    onchange: () => ({}),
    groupBys: ['type_tax_use', 'tax_group'],
    filters: [[{ id: 'sale', label: 'Sales', fn: (r) => r.type_tax_use === 'sale' }, { id: 'purchase', label: 'Purchases', fn: (r) => r.type_tax_use === 'purchase' }]],
    kanban: { title: 'name', lines: ['type_tax_use', 'amount'] },
    list: ['name', 'type_tax_use', 'amount_type', 'amount', 'price_include', 'include_base_amount', 'tax_exigibility'],
    form: {
      title: 'name',
      groups: [
        ['amount_type', 'amount', 'children_tax_ids', 'sequence', 'description', 'type_tax_use'],
        ['tax_group_id', 'tax_group', 'price_include', 'include_base_amount', 'is_base_affected', 'tax_exigibility', 'cash_basis_transition_account_id', 'active'],
      ],
      tabs: [
        { label: 'Distribution for Invoices', fields: ['invoice_repartition_line_ids'] },
        { label: 'Distribution for Refunds', fields: ['refund_repartition_line_ids'] },
      ],
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
