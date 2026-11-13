import { read } from '../orm.js';
import { commercialPartnerId, companyRoundingMethod, monthFilters, today } from './common.js';
import { companyCurrencyRecord, documentCurrency } from '../money.js';
import { companyCurrency, conversionRate, toCompany } from './currency.js';
import { computeLineTaxes, isSectionOrNote } from './taxes.js';
import { invoiceLineAccount } from './ledger.js';
import { isInbound, isRefund, paymentState } from './accounting.js';

const REPORT_TYPES = ['out_invoice', 'out_refund', 'in_invoice', 'in_refund'];
const REPORT_STATES = ['draft', 'posted'];

/** Collect posted journal line bookings indexed by originating invoice line index. */
function bookedLineMap(move) {
  const byIndex = new Map();
  if (move.state !== 'posted') return byIndex;
  for (const item of move.line_ids ?? []) {
    for (const src of item.invoice_sources ?? []) {
      if (src?.index == null) continue;
      const prev = byIndex.get(src.index);
      byIndex.set(src.index, {
        amount: (prev?.amount ?? 0) + (Number(src.amount) || 0),
        accountId: prev?.accountId ?? src.original_account_id ?? item.account_id ?? null,
      });
    }
  }
  return byIndex;
}

/**
 * Compute read-only line-level rows for Odoo 20 `account.invoice.report`
 * across draft and posted customer invoices, credit notes, vendor bills, and vendor refunds.
 */
export function invoiceReportLines(db) {
  const rows = [];
  for (const move of db.records['account.move'] ?? []) {
    if (!REPORT_TYPES.includes(move.move_type) || !REPORT_STATES.includes(move.state)) continue;
    const companyId = move.company_id ?? 1;
    const ownCurr = companyCurrencyRecord(db, companyId);
    const ownCurrId = ownCurr?.id ?? companyCurrency(db, companyId);
    const docCurr = documentCurrency(db, move);
    const date = move.invoice_date ?? move.date ?? today();
    const roundingMethod = companyRoundingMethod(db, companyId);
    const side = isRefund(move) ? 'refund' : 'invoice';
    const sign = isInbound(move) ? 1 : -1;
    const partner = move.partner_id ? read(db, 'res.partner', move.partner_id) : null;
    const commercialId = move.partner_id ? commercialPartnerId(db, move.partner_id) : null;
    const payState = paymentState(move, db);
    const booked = bookedLineMap(move);
    const canConvert = !docCurr?.id || docCurr.id === ownCurrId || conversionRate(db, docCurr.id, ownCurrId, date, companyId) != null;
    const toCompanyOrNull = (docAmount) => (canConvert ? toCompany(db, docCurr?.id ?? ownCurrId, docAmount, date, companyId) : null);

    (move.invoice_line_ids ?? []).forEach((line, index) => {
      if (isSectionOrNote(line)) return;
      const product = line.product_id ? read(db, 'product', line.product_id) : null;
      const qtyRaw = sign * (Number(line.qty) || 0);
      const quantity = qtyRaw === 0 ? 0 : qtyRaw;
      const lineTaxes = computeLineTaxes(line, { currency: docCurr, roundingMethod, side });
      const bookedLine = booked.get(index);
      const rawSubtotal = bookedLine ? bookedLine.amount : toCompanyOrNull(lineTaxes.excluded);
      const price_subtotal = rawSubtotal == null ? null : (rawSubtotal === 0 ? 0 : sign * rawSubtotal);
      const rawTotal = lineTaxes.total === lineTaxes.excluded ? rawSubtotal : toCompanyOrNull(lineTaxes.total);
      const price_total = rawTotal == null ? null : (lineTaxes.total === lineTaxes.excluded ? price_subtotal : (rawTotal === 0 ? 0 : sign * rawTotal));
      const price_average = price_subtotal == null ? null : (quantity ? price_subtotal / quantity : 0);

      rows.push({
        id: move.id * 10000 + index + 1,
        move_id: move.id,
        invoice_date: date,
        invoice_date_due: move.invoice_date_due ?? null,
        journal_id: move.journal_id ?? null,
        company_id: companyId,
        partner_id: move.partner_id ?? null,
        commercial_partner_id: commercialId,
        country_id: partner?.country ?? null,
        invoice_user_id: move.invoice_user_id ?? null,
        move_type: move.move_type,
        state: move.state,
        payment_state: payState,
        fiscal_position_id: move.fiscal_position_id ?? null,
        account_id: bookedLine?.accountId ?? invoiceLineAccount(db, move, line),
        product_id: line.product_id ?? null,
        product_categ_id: product?.categ_id ?? null,
        product_uom_id: line.uom_id ?? product?.uom_id ?? null,
        quantity,
        price_subtotal,
        price_total,
        price_average,
        currency_id: ownCurrId,
      });
    });
  }
  return rows;
}

export const invoiceReportModels = {
  'account.invoice.report': {
    label: 'Invoice Analysis',
    readonly: true,
    records: invoiceReportLines,
    openHash: (r) => (r?.move_id ? `#/open/account.move/${r.move_id}` : null),
    views: ['graph', 'pivot', 'list'],
    pivot: { row: 'invoice_date', col: null, measure: 'price_subtotal' },
    graph: { groupBy: 'invoice_date', measure: 'price_subtotal' },
    searchFields: ['move_id', 'partner_id', 'commercial_partner_id', 'product_id', 'product_categ_id', 'account_id', 'journal_id', 'invoice_user_id'],
    filters: [
      [
        { id: 'customer', label: 'Invoices', fn: (r) => ['out_invoice', 'out_refund'].includes(r.move_type) },
        { id: 'supplier', label: 'Vendors Bills', fn: (r) => ['in_invoice', 'in_refund'].includes(r.move_type) },
      ],
      [
        { id: 'draft', label: 'Draft', fn: (r) => r.state === 'draft' },
        { id: 'posted', label: 'Posted', fn: (r) => r.state === 'posted' },
      ],
      monthFilters('invoice_date', 'Invoice Date'),
    ],
    defaultFilters: ['posted'],
    groupBys: ['invoice_user_id', 'partner_id', 'product_id', 'product_categ_id', 'state', 'company_id', 'invoice_date'],
    list: ['move_id', 'invoice_date', 'partner_id', 'product_id', 'product_categ_id', 'quantity', 'price_subtotal', 'price_total', 'price_average', 'state'],
    form: {
      title: 'move_id',
      lockedWhen: () => true,
      groups: [
        ['move_id', 'move_type', 'state', 'payment_state', 'invoice_date', 'invoice_date_due', 'journal_id', 'company_id'],
        ['partner_id', 'commercial_partner_id', 'country_id', 'invoice_user_id', 'fiscal_position_id', 'account_id'],
        ['product_id', 'product_categ_id', 'product_uom_id', 'quantity', 'price_subtotal', 'price_total', 'price_average', 'currency_id'],
      ],
    },
    fields: {
      move_id: { type: 'many2one', relation: 'account.move', label: 'Invoice', readonly: true },
      invoice_date: { type: 'date', label: 'Invoice Date', readonly: true },
      invoice_date_due: { type: 'date', label: 'Due Date', readonly: true },
      journal_id: { type: 'many2one', relation: 'account.journal', label: 'Journal', readonly: true },
      company_id: { type: 'many2one', relation: 'res.company', label: 'Company', readonly: true },
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Partner', readonly: true },
      commercial_partner_id: { type: 'many2one', relation: 'res.partner', label: 'Partner Company', readonly: true },
      country_id: { type: 'char', label: 'Country', readonly: true },
      invoice_user_id: { type: 'many2one', relation: 'hr.employee', label: 'Salesperson', readonly: true },
      move_type: {
        type: 'selection',
        label: 'Type',
        readonly: true,
        options: [['out_invoice', 'Customer Invoice'], ['out_refund', 'Credit Note'], ['in_invoice', 'Vendor Bill'], ['in_refund', 'Vendor Refund']],
      },
      state: {
        type: 'selection',
        label: 'Status',
        readonly: true,
        options: [['draft', 'Draft'], ['posted', 'Posted']],
      },
      payment_state: {
        type: 'selection',
        label: 'Payment Status',
        readonly: true,
        options: [['not_paid', 'Not Paid'], ['partial', 'Partially Paid'], ['paid', 'Paid'], ['unavailable', 'Unavailable']],
      },
      fiscal_position_id: { type: 'many2one', relation: 'account.fiscal.position', label: 'Fiscal Position', readonly: true },
      account_id: { type: 'many2one', relation: 'account.account', label: 'Revenue/Expense Account', readonly: true },
      product_id: { type: 'many2one', relation: 'product', label: 'Product', readonly: true },
      product_categ_id: { type: 'many2one', relation: 'product.category', label: 'Product Category', readonly: true },
      product_uom_id: { type: 'many2one', relation: 'uom.uom', label: 'Unit of Measure', readonly: true },
      quantity: { type: 'float', label: 'Product Quantity', readonly: true },
      price_subtotal: { type: 'monetary', label: 'Untaxed Total', currency: 'company', readonly: true },
      price_total: { type: 'monetary', label: 'Total', currency: 'company', readonly: true },
      price_average: { type: 'float', label: 'Average Price', groupOperator: 'avg', readonly: true },
      currency_id: { type: 'many2one', relation: 'res.currency', label: 'Currency', readonly: true },
    },
  },
};
