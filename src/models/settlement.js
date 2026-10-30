import { read } from '../orm.js';
import { round } from '../money.js';

function invoiceCompanyBalance(db, invoice) {
  const type = ['in_invoice', 'in_refund'].includes(invoice.move_type) ? 'liability_payable' : 'asset_receivable';
  return Math.abs((invoice.line_ids ?? []).filter((line) => read(db, 'account.account', line.account_id)?.account_type === type && line.partner_id === invoice.partner_id)
    .reduce((sum, line) => sum + (Number(line.debit) || 0) - (Number(line.credit) || 0), 0));
}

/** The effective date of an application for date-based reporting: max(application date, invoice date). */
export function applicationEffectiveDate(payment, invoice) {
  const paymentDate = payment?.date ?? '';
  const invoiceDate = invoice?.invoice_date ?? '';
  if (paymentDate && invoiceDate) return paymentDate > invoiceDate ? paymentDate : invoiceDate;
  return paymentDate || invoiceDate || '';
}

/** Derive each application's booked value in its original settlement order. */
export function settlementCompanyAllocations(db, invoice) {
  const booked = invoiceCompanyBalance(db, invoice);
  const total = Number(invoice.amount_total) || 0;
  const history = [];
  for (const payment of invoice.payments ?? []) {
    const effDate = applicationEffectiveDate(payment, invoice);
    const prior = history.filter(({ row }) => !row.reversed || (read(db, 'account.move', row.reversal_move_id)?.invoice_date ?? row.reversal_date ?? '') > effDate);
    const applied = round(prior.reduce((sum, item) => sum + Number(item.row.amount || 0), 0));
    const allocated = round(prior.reduce((sum, item) => sum + item.value, 0));
    const remaining = Math.max(0, round(booked - allocated));
    const next = round(applied + Number(payment.amount || 0));
    const value = payment.company_amount != null ? Number(payment.company_amount) : (next >= round(total) ? remaining : Math.min(remaining, Math.max(0, round(round(next * booked / (total || 1)) - allocated))));
    history.push({ row: payment, value });
  }
  return history;
}

/** Allocate the booked balance cumulatively, excluding reversed applications. */
export function settlementCompanyAmount(db, invoice, amount) {
  const booked = invoiceCompanyBalance(db, invoice);
  const total = Number(invoice.amount_total) || 0;
  const active = settlementCompanyAllocations(db, invoice).filter(({ row }) => !row.reversed);
  const docApplied = round(active.reduce((sum, item) => sum + Number(item.row.amount || 0), 0));
  const companyApplied = round(active.reduce((sum, item) => sum + item.value, 0));
  const remaining = Math.max(0, round(booked - companyApplied));
  if (round(docApplied + amount) >= round(total)) return remaining;
  return Math.min(remaining, Math.max(0, round(round((docApplied + amount) * booked / (total || 1)) - companyApplied)));
}
