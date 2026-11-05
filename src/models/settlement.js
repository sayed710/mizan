import { read } from '../orm.js';
import { companyCurrencyRecord, documentCurrency, roundCurrency } from '../money.js';
import { invoiceCounterpartAccount } from './ledger.js';

/** Resolve the cash booked for an application, including unambiguous pre-upgrade invoice payments. */
export function paymentCompanyAmount(db, invoice, row) {
  if (row.payment_company_amount != null) return Number.isFinite(row.payment_company_amount) && row.payment_company_amount > 0 ? row.payment_company_amount : null;
  const payments = (db.records['account.payment'] ?? []).filter((p) => p.move_id === row.move_id && p.state === 'posted');
  if (payments.length !== 1) return null;
  const [payment] = payments;
  const source = read(db, 'account.move', row.move_id);
  if (payment.invoice_id !== invoice.id || !payment.outstanding_account_id || source?.state !== 'posted'
    || (payment.company_id ?? 1) !== (invoice.company_id ?? 1) || (source.company_id ?? 1) !== (invoice.company_id ?? 1)
    || payment.date !== row.date || (source.invoice_date ?? source.date) !== row.date) return null;
  const uses = (db.records['account.move'] ?? []).flatMap((m) => (m.payments ?? []).filter((p) => p.move_id === row.move_id));
  if (uses.length !== 1) return null;
  const counterpart = invoiceCounterpartAccount(db, invoice);
  if (!counterpart || counterpart === payment.outstanding_account_id) return null;
  const lines = source.line_ids ?? [];
  const liquidity = lines.filter((l) => l.account_id === payment.outstanding_account_id && l.partner_id === payment.partner_id);
  const partner = lines.filter((l) => l.account_id === counterpart && l.partner_id === invoice.partner_id);
  if (liquidity.length !== 1 || partner.length !== 1) return null;
  const inbound = payment.payment_type === 'inbound';
  const cash = Number(inbound ? liquidity[0].debit : liquidity[0].credit);
  const otherSide = Number(inbound ? liquidity[0].credit : liquidity[0].debit) || 0;
  return Number.isFinite(cash) && cash > 0 && otherSide === 0 ? roundCurrency(cash, companyCurrencyRecord(db, invoice.company_id)) : null;
}

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

/** Whether an application is active at a cutoff. Posting-order history already establishes inclusion. */
export function applicationActiveAt(db, payment, invoice, date, { postingHistory = false } = {}) {
  if (!postingHistory) {
    const effective = applicationEffectiveDate(payment, invoice);
    if (!effective || effective > date) return false;
  }
  if (!payment.reversed) return true;
  const reversalDate = read(db, 'account.move', payment.reversal_move_id)?.invoice_date ?? payment.reversal_date;
  return !!reversalDate && reversalDate > date;
}

/** Derive each application's booked value in its original settlement order. */
export function settlementCompanyAllocations(db, invoice) {
  const docRound = (n) => roundCurrency(n, documentCurrency(db, invoice));
  const round = (n) => roundCurrency(n, companyCurrencyRecord(db, invoice.company_id));
  const booked = invoiceCompanyBalance(db, invoice);
  const total = Number(invoice.amount_total) || 0;
  const history = [];
  for (const payment of invoice.payments ?? []) {
    const effDate = applicationEffectiveDate(payment, invoice);
    const prior = history.filter(({ row }) => applicationActiveAt(db, row, invoice, effDate, { postingHistory: true }));
    const applied = docRound(prior.reduce((sum, item) => sum + Number(item.row.amount || 0), 0));
    const allocated = round(prior.reduce((sum, item) => sum + item.value, 0));
    const remaining = Math.max(0, round(booked - allocated));
    const next = docRound(applied + Number(payment.amount || 0));
    const value = payment.company_amount != null ? Number(payment.company_amount) : (next >= docRound(total) ? remaining : Math.min(remaining, Math.max(0, round(round(next * booked / (total || 1)) - allocated))));
    history.push({ row: payment, value });
  }
  return history;
}

/** Allocate the booked balance cumulatively, excluding reversed applications. */
export function settlementCompanyAmount(db, invoice, amount) {
  const docRound = (n) => roundCurrency(n, documentCurrency(db, invoice));
  const round = (n) => roundCurrency(n, companyCurrencyRecord(db, invoice.company_id));
  const booked = invoiceCompanyBalance(db, invoice);
  const total = Number(invoice.amount_total) || 0;
  const active = settlementCompanyAllocations(db, invoice).filter(({ row }) => !row.reversed);
  const docApplied = docRound(active.reduce((sum, item) => sum + Number(item.row.amount || 0), 0));
  const companyApplied = round(active.reduce((sum, item) => sum + item.value, 0));
  const remaining = Math.max(0, round(booked - companyApplied));
  if (docRound(docApplied + amount) >= docRound(total)) return remaining;
  return Math.min(remaining, Math.max(0, round(round((docApplied + amount) * booked / (total || 1)) - companyApplied)));
}
