// Data-driven tax return box templates and pure CSV / XML export builders.
import { read } from '../orm.js';
import { toCsv } from '../csv.js';
import { round } from '../money.js';
import { taxReport, taxesByTax } from './finance.js';
import { TAX_RETURN_TEMPLATE_OPTIONS, TAX_RETURN_TEMPLATES } from './taxTemplates.js';

export { TAX_RETURN_TEMPLATE_OPTIONS, TAX_RETURN_TEMPLATES };

/** Escape XML special characters safely for attributes and element text. */
export function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Derive the tax report period object from an account.return record (or period). */
export function taxReturnPeriod(db, retOrPeriod) {
  if (!retOrPeriod) return {};
  if ('from' in retOrPeriod || 'to' in retOrPeriod) return retOrPeriod;
  const companyId = retOrPeriod.company_id ?? 1;
  const unit = retOrPeriod.tax_unit_id ? read(db, 'account.tax.unit', retOrPeriod.tax_unit_id) : null;
  const taxUnitId = unit && (unit.company_ids ?? []).includes(companyId) ? unit.id : null;
  return {
    from: retOrPeriod.date_from,
    to: retOrPeriod.date_to,
    company_id: companyId,
    tax_unit_id: taxUnitId,
  };
}

/** Resolve the explicit box template key from the return or its company, defaulting to `generic`. */
export function resolveTaxReturnTemplate(db, ret) {
  const company = read(db, 'res.company', ret?.company_id ?? 1);
  const explicit = ret?.tax_return_template || company?.tax_return_template || 'generic';
  return Object.hasOwn(TAX_RETURN_TEMPLATES, explicit) ? explicit : 'generic';
}

function buildGenericBoxes(taxRows, totals) {
  const boxes = [];
  let saleIdx = 0;
  let purchIdx = 0;
  let saleBase = 0;
  let purchBase = 0;
  for (const row of taxRows) {
    if (row.side === 'sale') {
      saleIdx += 1;
      saleBase = round(saleBase + row.base);
      boxes.push({ code: `OUT-${saleIdx}`, label: row.name, base: round(row.base), tax: round(row.tax), kind: 'detail' });
    } else if (row.side === 'purchase') {
      purchIdx += 1;
      purchBase = round(purchBase + row.base);
      boxes.push({ code: `IN-${purchIdx}`, label: row.name, base: round(row.base), tax: round(row.tax), kind: 'detail' });
    }
  }
  boxes.push(
    { code: 'TOTAL-OUT', label: 'Output Tax', base: saleBase, tax: totals.output, kind: 'total' },
    { code: 'TOTAL-IN', label: 'Input Tax', base: purchBase, tax: totals.input, kind: 'total' },
    { code: 'PAYABLE', label: 'Tax Payable', base: 0, tax: totals.payable, kind: 'total' },
  );
  return boxes;
}

function buildTemplateBoxes(db, templateSpec, taxRows, totals) {
  const acc = new Map(templateSpec.boxes.map((b) => [b.code, { base: 0, tax: 0 }]));
  let saleBase = 0;
  let purchBase = 0;
  for (const row of taxRows) {
    const taxRec = row.tax_id ? read(db, 'account.tax', row.tax_id) : null;
    const scope = taxRec?.tax_scope ?? null;
    if (row.side === 'sale') saleBase = round(saleBase + row.base);
    else if (row.side === 'purchase') purchBase = round(purchBase + row.base);
    const matched = templateSpec.boxes.find((b) => !b.kind && b.side === row.side && b.tax_scope && b.tax_scope === scope)
      ?? templateSpec.boxes.find((b) => !b.kind && b.side === row.side && b.isDefault);
    if (matched) {
      const slot = acc.get(matched.code);
      slot.base = round(slot.base + row.base);
      slot.tax = round(slot.tax + row.tax);
    }
  }
  return templateSpec.boxes.map((spec) => {
    if (spec.kind === 'total_output') return { code: spec.code, label: spec.label, base: saleBase, tax: totals.output, kind: 'total' };
    if (spec.kind === 'total_input') return { code: spec.code, label: spec.label, base: purchBase, tax: totals.input, kind: 'total' };
    if (spec.kind === 'net_payable') return { code: spec.code, label: spec.label, base: 0, tax: totals.payable, kind: 'total' };
    const slot = acc.get(spec.code);
    return { code: spec.code, label: spec.label, base: slot.base, tax: slot.tax, kind: 'detail' };
  });
}

/** Build structured return boxes and reconciled totals equal to `taxReport(db, period)`. */
export function taxReturnBoxes(db, ret) {
  const period = taxReturnPeriod(db, ret);
  const totals = taxReport(db, period);
  const taxRows = taxesByTax(db, period);
  const template = resolveTaxReturnTemplate(db, ret);
  const spec = TAX_RETURN_TEMPLATES[template];
  const boxes = spec.mode === 'boxes'
    ? buildTemplateBoxes(db, spec, taxRows, totals)
    : buildGenericBoxes(taxRows, totals);
  return {
    template,
    templateLabel: spec.label,
    period,
    company_id: period.company_id ?? ret?.company_id ?? 1,
    boxes,
    totals,
  };
}

/** Build RFC 4180 CSV text of tax return boxes for an `account.return` record. */
export function taxReturnToCsv(db, ret) {
  const { boxes } = taxReturnBoxes(db, ret);
  const rows = [
    ['Box Code', 'Label', 'Base', 'Tax'],
    ...boxes.map((b) => [b.code, b.label, round(b.base).toFixed(2), round(b.tax).toFixed(2)]),
  ];
  return toCsv(rows);
}

/** Build escaped XML document of tax return boxes for an `account.return` record. */
export function taxReturnToXml(db, ret) {
  const { template, period, company_id: companyId, boxes, totals } = taxReturnBoxes(db, ret);
  const returnName = ret?.name ?? 'Tax Return';
  const boxXml = boxes.map((b) => (
    `    <box code="${escapeXml(b.code)}" label="${escapeXml(b.label)}" base="${round(b.base).toFixed(2)}" tax="${round(b.tax).toFixed(2)}" kind="${escapeXml(b.kind)}"/>`
  )).join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<taxReturn name="${escapeXml(returnName)}" template="${escapeXml(template)}" companyId="${escapeXml(companyId)}" dateFrom="${escapeXml(period.from ?? '')}" dateTo="${escapeXml(period.to ?? '')}" output="${round(totals.output).toFixed(2)}" input="${round(totals.input).toFixed(2)}" payable="${round(totals.payable).toFixed(2)}">`,
    '  <boxes>',
    boxXml,
    '  </boxes>',
    '</taxReturn>',
  ].join('\n');
}
