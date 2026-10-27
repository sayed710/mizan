import { applyFilters, search } from './orm.js';

const sum = (recs, f) => recs.reduce((s, r) => s + (Number(r[f]) || 0), 0);
const posted = (db, type) => search(db, 'account.move').filter((m) => m.state === 'posted' && m.move_type === type);

/** Invoicing KPIs net of credit notes and refunds; counts use the same filters the linked lists apply. */
export function invoiceKpis(db, month) {
  const [invoices, refunds, bills, vendorRefunds] = ['out_invoice', 'out_refund', 'in_invoice', 'in_refund'].map((type) => posted(db, type));
  const inMonth = (m) => m.invoice_date?.startsWith(month);
  const byPartner = [...invoices.map((m) => [m.partner_id, m.amount_total]), ...refunds.map((m) => [m.partner_id, -m.amount_total])]
    .reduce((acc, [partner, amount]) => ({ ...acc, [partner]: (acc[partner] ?? 0) + amount }), {});
  return {
    invoicedThisMonth: sum(invoices.filter(inMonth), 'amount_total') - sum(refunds.filter(inMonth), 'amount_total'),
    receivable: sum(invoices, 'amount_residual') - sum(refunds, 'amount_residual'),
    payable: sum(bills, 'amount_residual') - sum(vendorRefunds, 'amount_residual'),
    overdue: applyFilters('account.move', invoices, ['overdue']).length,
    topCustomers: Object.entries(byPartner).sort((a, b) => b[1] - a[1]).slice(0, 5),
  };
}
