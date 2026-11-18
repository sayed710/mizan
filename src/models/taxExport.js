// Data-driven tax return box templates and pure CSV / XML export builders.
import { read } from '../orm.js';
import { toCsv } from '../csv.js';
import { round } from '../money.js';
import { taxBaseTotal, taxItemKey, taxItems, taxReport, taxesByTax } from './finance.js';
import { TAX_RETURN_TEMPLATE_OPTIONS, TAX_RETURN_TEMPLATES } from './taxTemplates.js';

export { TAX_RETURN_TEMPLATE_OPTIONS, TAX_RETURN_TEMPLATES };

const XML_CHAR_ESCAPE = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

const isXml10CharCodePoint = (cp) => cp === 0x09 || cp === 0x0A || cp === 0x0D
  || (cp >= 0x20 && cp <= 0xD7FF)
  || (cp >= 0xE000 && cp <= 0xFFFD)
  || (cp >= 0x10000 && cp <= 0x10FFFF);

/** Escape XML 1.0 text safely, dropping invalid code points and normalizing attribute whitespace controls. */
export function escapeXml(value, { attribute = false } = {}) {
  let out = '';
  for (const ch of String(value ?? '')) {
    const cp = ch.codePointAt(0);
    if (cp === undefined || !isXml10CharCodePoint(cp)) continue;
    if (attribute && (cp === 0x09 || cp === 0x0A || cp === 0x0D)) {
      out += `&#x${cp.toString(16).toUpperCase()};`;
    } else {
      out += XML_CHAR_ESCAPE[ch] ?? ch;
    }
  }
  return out;
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

/** Resolve the template detail box matching a tax row or tax item using explicit side and tax_scope. */
function templateBoxSpec(db, templateSpec, taxItem) {
  const taxRec = taxItem.tax_id ? read(db, 'account.tax', taxItem.tax_id) : null;
  const scope = taxRec?.tax_scope ?? null;
  return templateSpec.boxes.find((b) => !b.kind && b.side === taxItem.side && b.tax_scope && b.tax_scope === scope)
    ?? templateSpec.boxes.find((b) => !b.kind && b.side === taxItem.side && b.isDefault)
    ?? null;
}

/** Per-tax rows with their generic box codes: OUT-n for sales and IN-n for purchases, in report order. */
export function genericTaxRows(taxRows) {
  const counts = { sale: 0, purchase: 0 };
  return taxRows.filter((row) => row.side in counts).map((row) => {
    counts[row.side] += 1;
    return { ...row, code: `${row.side === 'sale' ? 'OUT' : 'IN'}-${counts[row.side]}` };
  });
}

function buildGenericBoxes(db, period, taxRows, totals) {
  const boxes = genericTaxRows(taxRows).map((row) => ({ code: row.code, label: row.name, base: round(row.base), tax: round(row.tax), kind: 'detail' }));
  const saleBase = taxBaseTotal(db, period, (item) => item.side === 'sale');
  const purchBase = taxBaseTotal(db, period, (item) => item.side === 'purchase');
  boxes.push(
    { code: 'TOTAL-OUT', label: 'Output Tax', base: saleBase, tax: totals.output, kind: 'total' },
    { code: 'TOTAL-IN', label: 'Input Tax', base: purchBase, tax: totals.input, kind: 'total' },
    { code: 'PAYABLE', label: 'Tax Payable', base: 0, tax: totals.payable, kind: 'total' },
  );
  return boxes;
}

function buildTemplateBoxes(db, period, templateSpec, taxRows, totals) {
  const acc = new Map(templateSpec.boxes.map((b) => [b.code, { hasRows: false, tax: 0 }]));
  for (const row of taxRows) {
    const matched = templateBoxSpec(db, templateSpec, row);
    if (matched) {
      const slot = acc.get(matched.code);
      slot.hasRows = true;
      slot.tax = round(slot.tax + row.tax);
    }
  }
  const saleBase = taxBaseTotal(db, period, (item) => item.side === 'sale');
  const purchBase = taxBaseTotal(db, period, (item) => item.side === 'purchase');
  return templateSpec.boxes.map((spec) => {
    if (spec.kind === 'total_output') return { code: spec.code, label: spec.label, base: saleBase, tax: totals.output, kind: 'total' };
    if (spec.kind === 'total_input') return { code: spec.code, label: spec.label, base: purchBase, tax: totals.input, kind: 'total' };
    if (spec.kind === 'net_payable') return { code: spec.code, label: spec.label, base: 0, tax: totals.payable, kind: 'total' };
    const slot = acc.get(spec.code);
    const base = slot.hasRows
      ? taxBaseTotal(db, period, (item) => templateBoxSpec(db, templateSpec, item)?.code === spec.code)
      : 0;
    return { code: spec.code, label: spec.label, base, tax: slot.tax, kind: 'detail' };
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
    ? buildTemplateBoxes(db, period, spec, taxRows, totals)
    : buildGenericBoxes(db, period, taxRows, totals);
  return {
    template,
    templateLabel: spec.label,
    period,
    company_id: period.company_id ?? ret?.company_id ?? 1,
    boxes,
    totals,
  };
}

/** Drill down into journal items that contribute to a return box. */
export function taxBoxItems(db, ret, code) {
  const period = taxReturnPeriod(db, ret);
  const template = resolveTaxReturnTemplate(db, ret);
  const spec = TAX_RETURN_TEMPLATES[template];
  const allItems = taxItems(db, period);

  let matcher;
  let isNetPayable = false;

  if (spec.mode === 'boxes') {
    const boxSpec = spec.boxes.find((b) => b.code === code);
    if (!boxSpec) return { items: [], tax: 0, base: 0 };
    if (boxSpec.kind === 'total_output') {
      matcher = (item) => item.side === 'sale';
    } else if (boxSpec.kind === 'total_input') {
      matcher = (item) => item.side === 'purchase';
    } else if (boxSpec.kind === 'net_payable') {
      isNetPayable = true;
      matcher = () => true;
    } else {
      matcher = (item) => templateBoxSpec(db, spec, item)?.code === code;
    }
  } else {
    if (code === 'TOTAL-OUT') {
      matcher = (item) => item.side === 'sale';
    } else if (code === 'TOTAL-IN') {
      matcher = (item) => item.side === 'purchase';
    } else if (code === 'PAYABLE') {
      isNetPayable = true;
      matcher = () => true;
    } else {
      const targetRow = genericTaxRows(taxesByTax(db, period)).find((row) => row.code === code);
      if (!targetRow) return { items: [], tax: 0, base: 0 };
      const targetKey = taxItemKey({ side: targetRow.side, tax_id: targetRow.tax_id, tax_name: targetRow.name });
      matcher = (item) => taxItemKey(item) === targetKey;
    }
  }

  const moves = new Map((db.records?.['account.move'] ?? []).map((m) => [m.id, m]));
  const matched = allItems.filter(matcher);
  const items = matched.map((item) => {
    const move = moves.get(item.move_id);
    const partnerId = item.partner_id ?? move?.partner_id ?? null;
    const signedContribution = isNetPayable
      ? (item.side === 'sale' ? item.tax : -item.tax)
      : item.tax;
    return {
      move_id: item.move_id,
      move_name: item.move_name,
      date: item.date,
      account_id: item.account_id,
      partner_id: partnerId,
      name: item.name,
      tax: signedContribution,
    };
  });

  const tax = round(items.reduce((s, it) => s + it.tax, 0));
  const base = isNetPayable ? 0 : taxBaseTotal(db, period, matcher);
  return { items, tax, base };
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
    `    <box code="${escapeXml(b.code, { attribute: true })}" label="${escapeXml(b.label, { attribute: true })}" base="${round(b.base).toFixed(2)}" tax="${round(b.tax).toFixed(2)}" kind="${escapeXml(b.kind, { attribute: true })}"/>`
  )).join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<taxReturn name="${escapeXml(returnName, { attribute: true })}" template="${escapeXml(template, { attribute: true })}" companyId="${escapeXml(companyId, { attribute: true })}" dateFrom="${escapeXml(period.from ?? '', { attribute: true })}" dateTo="${escapeXml(period.to ?? '', { attribute: true })}" output="${round(totals.output).toFixed(2)}" input="${round(totals.input).toFixed(2)}" payable="${round(totals.payable).toFixed(2)}">`,
    '  <boxes>',
    boxXml,
    '  </boxes>',
    '</taxReturn>',
  ].join('\n');
}
