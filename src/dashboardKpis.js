import { applyFilters, search } from './orm.js';
import { companyAmount, companySum, unratedCount } from './models/money.js';

const posted = (db, type) => search(db, 'account.move').filter((m) => m.state === 'posted' && m.move_type === type);

/** Invoicing KPIs net of credit notes and refunds; counts use the same filters the linked lists apply. */
export function invoiceKpis(db, month, at) {
  const [invoices, refunds, bills, vendorRefunds] = ['out_invoice', 'out_refund', 'in_invoice', 'in_refund'].map((type) => posted(db, type));
  const inMonth = (m) => m.invoice_date?.startsWith(month);
  const byPartner = [...invoices.map((m) => [m.partner_id, companyAmount(db, m, 'amount_total', at)]), ...refunds.map((m) => [m.partner_id, -companyAmount(db, m, 'amount_total', at)])]
    .reduce((acc, [partner, amount]) => ({ ...acc, [partner]: Math.round(((acc[partner] ?? 0) + amount) * 100) / 100 }), {});
  return {
    invoicedThisMonth: Math.round((companySum(db, invoices.filter(inMonth), 'amount_total', at) - companySum(db, refunds.filter(inMonth), 'amount_total', at)) * 100) / 100,
    receivable: Math.round((companySum(db, invoices, 'amount_residual', at) - companySum(db, refunds, 'amount_residual', at)) * 100) / 100,
    payable: Math.round((companySum(db, bills, 'amount_residual', at) - companySum(db, vendorRefunds, 'amount_residual', at)) * 100) / 100,
    unratedCount: unratedCount(db, [...invoices, ...refunds, ...bills, ...vendorRefunds], at),
    overdue: applyFilters('account.move', invoices, ['overdue']).length,
    topCustomers: Object.entries(byPartner).sort((a, b) => b[1] - a[1]).slice(0, 5),
  };
}
