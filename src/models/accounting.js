import { create, postNote, read, search, unlink, write } from '../orm.js';
import { amounts, nextName, productLines, promptedAmount, today } from './common.js';
import { ACCOUNT_TYPES, badLineSign, invoiceCounterpartAccount, invoiceLines, isBalanced, journalId, outstandingAccount, paymentJournal, postEntry, postedBillLine } from './ledger.js';
import { creditWarning, accountDeleteGuard, lockedSettlementInvariant, fxProvenanceError, moveDeleteGuard, moveGuard, moveInvariant } from './finance.js';
import { rateAt, toCompany } from './currency.js';
import { TRANSITION, cashBasisTaxes, fiscalPositionFor } from './taxes.js';
import { dueDate, earlyDiscount } from './terms.js';
import { downPaymentOvercommitted, refreshAdvanceDeductions, syncInvoicedQty } from './sales.js';
import { checkMandatoryPlans, defaultDistributionForLine, distributionOfLine, findAnalyticDistribution, normalizeDistribution, postAnalytic, removeAnalytic } from './analyticplus.js';
import { checkBillMatch, priceDifferenceLines, shouldBePaid } from './billcontrol.js';
import { cashRound, companyCurrencyRecord, documentCurrency, roundCurrency, round as round2 } from '../money.js';
import { settlementCompanyAmount } from './settlement.js';
import { analyzeJournalChains, secureEntries, secureMoveInvariant, secureHeadsGuard } from './hash_chain.js';
import { t } from '../i18n.js';
import { createInvoiceDeferrals, reverseInvoiceDeferrals } from './deferred.js';
import { resolveAndValidateRecipientBank } from './partnerbank.js';
import { exchangeAccount } from './exchange-account.js';
import { ASSET_DEPRECIATION_DEFAULTS } from './assets.js';

const exchangeLines = (db, companyId, difference) => {
  if (!difference) return [];
  const account = exchangeAccount(db, companyId, difference);
  return difference > 0
    ? [{ account, credit: difference }]
    : [{ account, debit: -difference }];
};

const isInvoice = (r) => r.move_type !== 'entry';
const isRefund = (r) => ['out_refund', 'in_refund'].includes(r.move_type);
export const isPurchase = (r) => ['in_invoice', 'in_refund'].includes(r.move_type);
/** Money comes in for customer invoices and vendor refunds, goes out for bills and credit notes. */
export const isInbound = (r) => ['out_invoice', 'in_refund'].includes(r.move_type);
const total = (r, db) => {
  if (!isInvoice(r)) return (r.line_ids ?? []).reduce((s, l) => s + (Number(l.debit) || 0), 0);
  const base = !db && r.amount_total != null ? r.amount_total : amounts(r.invoice_line_ids, documentCurrency(db, r)).total;
  if (r.invoice_cash_rounding_id && r.state === 'posted') {
    const main = (r.line_ids ?? []).filter((l) => l.name === r.name);
    if (main.length) return main.some((l) => l.currency_id) ? Math.abs(main.reduce((sum, l) => sum + (Number(l.amount_currency) || 0), 0)) : main.reduce((sum, l) => sum + (Number(l.debit) || 0) + (Number(l.credit) || 0), 0) || base;
  }
  const rounding = db && r.invoice_cash_rounding_id ? read(db, 'account.cash.rounding', r.invoice_cash_rounding_id) : null;
  if (rounding) return roundCurrency(cashRound(base, rounding.rounding, rounding.rounding_method), documentCurrency(db, r));
  return base;
};
const residual = (r, db) => (isInvoice(r) ? Math.max(0, db ? roundCurrency(total(r, db) - (Number(r.amount_paid) || 0), documentCurrency(db, r)) : (r.amount_residual ?? round2(total(r) - (Number(r.amount_paid) || 0)))) : 0);
const paymentState = (r, db) => {
  if (r.state !== 'posted' || !isInvoice(r)) return 'not_paid';
  if (residual(r, db) === 0) return 'paid';
  return (Number(r.amount_paid) || 0) > 0 ? 'partial' : 'not_paid';
};
const money = (n) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const PREFIX = { out_invoice: 'INV', out_refund: 'RINV', in_invoice: 'BILL', in_refund: 'RBILL', entry: 'MISC' };

/** Ids of the entries that settle invoices (payments and early-payment discounts). */
const settlingEntries = (db) => new Set((db.records['account.move'] ?? []).flatMap((m) => (m.payments ?? []).flatMap((p) => [p.move_id, p.payment_fx_move_id]).filter(Boolean)));

/**
 * The paid amount is the sum of the recorded payments and never above the total; a paid invoice and the
 * entries that pay it stay posted, so the books and the payment status cannot drift apart.
 */
export function paymentGuard(db, before, after, ctx) {
  const docRound = (n) => roundCurrency(n, documentCurrency(db, after));
  if (!before && (after.fx_payment_move_id || after.fx_invoice_id)) return ctx ? fxProvenanceError(db, after) : 'Exchange provenance cannot be supplied on creation';
  if (after.correction_of_id && after.state !== 'cancel') {
    const note = read(db, 'account.move', after.correction_of_id);
    if (!note || note.state !== 'posted' || !isRefund(note) || after.move_type !== (note.move_type === 'out_refund' ? 'out_invoice' : 'in_invoice')
      || after.partner_id !== note.partner_id || after.company_id !== note.company_id || (after.currency_id ?? null) !== (note.currency_id ?? null)) return 'A correction must match its posted credit note';
    if ((db.records['account.move'] ?? []).some((m) => m.id !== after.id && m.correction_of_id === note.id && m.state !== 'cancel')) return 'This credit note already has a correction';
    if (after.state === 'posted' && docRound(total(after, db)) !== docRound(total(note, db))) return 'A correction must restore the full credit note amount';
  }
  if (after.state === 'posted' && isInvoice(after) && !validInvoiceTotal(after, db)) return 'The total must be positive; use a credit note or refund instead';
  // Any sales invoice can overcommit an order with advances, not just an advance itself.
  if (after.state === 'posted' && before?.state !== 'posted' && after.move_type === 'out_invoice' && after.sale_id
    && [after, ...(db.records['account.move'] ?? []).filter((m) => m.sale_id === after.sale_id && m.state === 'posted')]
      .some((m) => (m.invoice_line_ids ?? []).some((l) => l.down_payment_key && Number(l.qty) > 0))) {
    const order = read(db, 'sale.order', after.sale_id);
    if (order) {
      const moves = [...(db.records['account.move'] ?? []).filter((m) => m.id !== after.id && m.sale_id === after.sale_id
        && m.state === 'posted' && ['out_invoice', 'out_refund'].includes(m.move_type)), after];
      if (downPaymentOvercommitted(order, moves)) return 'Down payment exceeds the remaining order amount';
    }
  }
  const leavesPosted = before?.state === 'posted' && after.state !== 'posted';
  if (leavesPosted && before.move_type === 'in_invoice' && (db.records['account.asset'] ?? []).some((asset) => asset.bill_id === before.id
    && (['open', 'paused', 'close'].includes(asset.state) || (asset.depreciation_ids ?? []).some((line) => line.posted)))) return 'Handle the bill\'s running or depreciated assets before resetting it';
  // A posted credit may have enabled an advance; resetting it must not undo that protection.
  if (leavesPosted && before.move_type === 'out_refund' && before.sale_id) {
    const order = read(db, 'sale.order', before.sale_id);
    const moves = (db.records['account.move'] ?? []).filter((m) => m.id !== before.id && m.sale_id === before.sale_id
      && m.state === 'posted' && ['out_invoice', 'out_refund'].includes(m.move_type));
    if (order && moves.some((m) => m.move_type === 'out_invoice' && (m.invoice_line_ids ?? []).some((l) => l.down_payment_key && Number(l.qty) > 0))) {
      if (downPaymentOvercommitted(order, moves)) return 'Down payment exceeds the remaining order amount';
    }
  }
  if (leavesPosted && (Number(before.amount_paid) > 0)) return 'Paid invoices cannot be reset or cancelled; reverse the payment with a credit note instead';
  if (leavesPosted && settlingEntries(db).has(before.id)) return 'This entry settles an invoice payment and cannot be reset or cancelled';
  // The books of a settlement entry are fixed once an invoice records it as a payment.
  if (before && ['fx_payment_move_id', 'fx_invoice_id'].some((k) => (before[k] ?? null) !== (after[k] ?? null))) return 'Exchange entry linkage cannot be changed';
  if (before?.state === 'posted' && settlingEntries(db).has(before.id)
    && ['line_ids', 'journal_id', 'partner_id'].some((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null))) {
    return 'This entry settles an invoice payment and cannot be changed';
  }
  const unchanged = before && JSON.stringify(before.payments ?? []) === JSON.stringify(after.payments ?? []) && Number(before.amount_paid || 0) === Number(after.amount_paid || 0);
  // Older data is left alone while its payments are untouched, unless the total moved below what was paid.
  if (unchanged) {
    const reduced = isInvoice(after) && docRound(total(after, db)) !== docRound(total(before, db)) && docRound(Number(after.amount_paid) || 0) > docRound(total(after, db));
    return reduced ? 'The paid amount cannot exceed the invoice total' : null;
  }
  const payments = after.payments ?? [];
  if (!Array.isArray(payments) || payments.some((p) => !p || !(Number(p.amount) > 0))) return 'Invalid payments';
  const paid = Number(after.amount_paid) || 0;
  // Compare deltas against the previous state so legacy/drifted rows (where
  // amount_paid and payments[] already disagree) can still be paid or discounted.
  // For new records there is no previous state, so the baseline is 0 and the full invariant applies.
  const prevPayments = Array.isArray(before?.payments) ? before.payments : [];
  const prevPaid = Number(before?.amount_paid) || 0;
  const activeSum = (list) => list.filter((p) => !p?.reversed).reduce((s, p) => s + (Number(p?.amount) || 0), 0);
  const paymentsSum = activeSum(payments);
  const prevPaymentsSum = activeSum(prevPayments);
  if (docRound(paymentsSum - prevPaymentsSum) !== docRound(paid - prevPaid)) return 'The change in paid amount must equal the change in recorded payments';
  if (isInvoice(after) && paid > 0 && docRound(paid) > docRound(total(after, db))) return 'The paid amount cannot exceed the invoice total';
  // A recorded payment keeps pointing at its posted settlement entry (so that entry stays protected); new ones must name one.
  const old = before?.payments ?? [];
  if (old.some((p, i) => p?.move_id && payments[i]?.move_id !== p.move_id)) return 'A recorded payment cannot be removed or re-linked';
  for (const [i, p] of payments.entries()) {
    const prior = old[i];
    if (prior?.reversed && (!p.reversed || p.reversal_move_id !== prior.reversal_move_id || p.reversal_date !== prior.reversal_date)) return 'A reversed payment cannot be restored';
    if (prior && Object.keys(prior).some((k) => !['reversed', 'reversal_move_id', 'reversal_date'].includes(k) && JSON.stringify(p[k]) !== JSON.stringify(prior[k]))) return 'A recorded payment cannot be changed';
    if (p.reversed) {
      const original = read(db, 'account.move', p.move_id);
      const reversal = read(db, 'account.move', p.reversal_move_id);
      if (!original || reversal?.state !== 'posted' || reversal.reversed_entry_id !== original.id
        || JSON.stringify((original.line_ids ?? []).map((l) => [l.account_id, l.partner_id, l.debit || 0, l.credit || 0]))
        !== JSON.stringify((reversal.line_ids ?? []).map((l) => [l.account_id, l.partner_id, l.credit || 0, l.debit || 0]))) return 'A reversed payment needs a posted reversing journal entry';
      if (p.date && p.date > reversal.invoice_date) return 'Reversal date cannot be before the application date';
      if (p.reversal_date && p.reversal_date !== reversal?.invoice_date) return 'Reversal date must match the posted reversal entry';
    }
  }
  if (payments.slice(old.length).some((p) => (!p.date || !/^\d{4}-\d{2}-\d{2}$/.test(p.date) || !Number.isFinite(Date.parse(p.date)) || new Date(p.date).toISOString().slice(0, 10) !== p.date) || ['amount', 'company_amount', 'payment_company_amount'].some((key) => p[key] != null && (!Number.isFinite(Number(p[key])) || Number(p[key]) < 0)))) return 'Invalid payment date or amount';
  const invalidDate = payments.slice(old.length).some((p) => {
    const source = read(db, 'account.move', p.move_id);
    const reversal = p.move_id && (db.records['account.move'] ?? []).find((m) => m.move_type === 'entry' && m.state === 'posted' && m.reversed_entry_id === p.move_id);
    const validSide = source?.move_type === 'entry' && (source.line_ids ?? []).some((l) => l.partner_id === after.partner_id && ['asset_receivable', 'liability_payable'].includes(read(db, 'account.account', l.account_id)?.account_type));
    return (validSide && source.state === 'posted' && p.date && p.date < source.invoice_date) || (reversal && p.date > reversal.invoice_date);
  });
  if (invalidDate) return 'Payment application date must be after payment and before reversal';
  const bad = payments.slice(old.length).find((p) => read(db, 'account.move', p.move_id)?.state !== 'posted');
  if (bad) return 'A payment must point at a posted journal entry';
  if (before?.state === 'posted' && payments.length > old.length) {
    const staged = { ...db, records: { ...db.records, 'account.move': (db.records['account.move'] ?? []).map((m) => m.id === after.id ? after : m) } };
    return moveInvariant(staged, after, before);
  }
  return null;
}

const validInvoiceTotal = (r, db) => total(r, db) > 0 || (total(r, db) === 0 && r.move_type === 'out_invoice' && r.sale_id && (r.invoice_line_ids ?? []).some((l) => l.down_payment_key && Number(l.qty) < 0));

/** Post a draft move: invoices get their journal items generated; manual entries must balance. */
export function postMove(db, id) {
  let r = read(db, 'account.move', id);
  const order = r.move_type === 'out_invoice' && r.sale_id && !r.correction_of_id && read(db, 'sale.order', r.sale_id);
  if (order && (r.invoice_line_ids ?? []).some((l) => !l.down_payment_key)
    && !(r.invoice_line_ids ?? []).some((l) => l.down_payment_key && Number(l.qty) > 0)) {
    r = { ...r, invoice_line_ids: refreshAdvanceDeductions(db, order, r.invoice_line_ids, id) };
  }
  const year = (r.invoice_date ?? today()).slice(0, 4);
  const name = r.name && r.name !== '/' ? r.name : nextName(db, 'account.move', `${PREFIX[r.move_type]}/${year}/`);
  if (!isInvoice(r)) {
    if (badLineSign(r.line_ids)) throw new Error('Debits and credits cannot be negative');
    if (!isBalanced(r.line_ids, companyCurrencyRecord(db, r.company_id))) throw new Error('Journal entry is not balanced: total debit must equal total credit');
    const line_ids = (r.line_ids ?? []).map((line) => {
      const type = read(db, 'account.account', line.account_id)?.account_type;
      const eligible = ['income', 'income_other', 'expense', 'expense_direct_cost', 'expense_other'].includes(type);
      const distribution = line.analytic_distribution ?? (line.analytic_account_id ? { [line.analytic_account_id]: 100 } : eligible ? findAnalyticDistribution(db, {
        partner_id: line.partner_id ?? r.partner_id, product_id: line.product_id, account_id: line.account_id, company_id: r.company_id ?? 1,
      }) : null);
      if (distribution == null || (!Object.hasOwn(line, 'analytic_distribution') && !Object.keys(distribution).length)) return line;
      return { ...line, analytic_distribution: normalizeDistribution(distribution, db) };
    });
    checkMandatoryPlans(db, { ...r, line_ids });
    return postAnalytic(write(db, 'account.move', id, { state: 'posted', name, line_ids }), id);
  }
  if (!r.partner_id) throw new Error('Partner is required');
  if (!(r.invoice_line_ids ?? []).length) throw new Error('Add at least one invoice line');
  if (!validInvoiceTotal(r, db)) throw new Error('The total must be positive; use a credit note or refund instead');
  const journal = r.journal_id || journalId(db, isPurchase(r) ? 'BILL' : 'INV', r.company_id ?? 1);
  if (!journal) throw new Error(`No ${isPurchase(r) ? 'vendor bill' : 'customer invoice'} journal for this company`);
  const journalRecord = read(db, 'account.journal', journal);
  if (!journalRecord) throw new Error('Selected journal does not exist');
  if (journalRecord.company_id && journalRecord.company_id !== (r.company_id ?? 1)) throw new Error('Journal belongs to another company');
  const expectedType = isPurchase(r) ? 'purchase' : 'sale';
  if (journalRecord.type !== expectedType) throw new Error(`Journal must be of type ${expectedType}`);
  if (r.sale_id) {
    const sale = read(db, 'sale.order', r.sale_id);
    if (sale && (sale.company_id ?? 1) !== (r.company_id ?? 1)) throw new Error('Invoice and sales order must belong to the same company');
  }
  if (r.purchase_id) {
    const po = read(db, 'purchase.order', r.purchase_id);
    if (po && (po.company_id ?? 1) !== (r.company_id ?? 1)) throw new Error('Bill and purchase order must belong to the same company');
  }
  if (r.fiscal_position_id) {
    const fp = read(db, 'account.fiscal.position', r.fiscal_position_id);
    if (fp?.company_id && fp.company_id !== (r.company_id ?? 1)) throw new Error('Fiscal position belongs to another company');
  }
  checkMandatoryPlans(db, r);
  // Vendor bills are matched against the PO and receipts; price differences leave the interim account.
  checkBillMatch(db, r);
  const resolvedLines = (r.invoice_line_ids ?? []).map((line) => {
    if (line.analytic_distribution && Object.keys(line.analytic_distribution).length > 0) return line;
    const dist = distributionOfLine(line, db, r);
    return Object.keys(dist).length ? { ...line, analytic_distribution: dist } : line;
  });
  const updatedR = { ...r, invoice_line_ids: resolvedLines };
  const line_ids = [...invoiceLines(db, { ...updatedR, name }), ...priceDifferenceLines(db, { ...updatedR, name })];
  if (line_ids.some((line) => {
    const account = read(db, 'account.account', line.account_id);
    return account?.company_id && account.company_id !== (r.company_id ?? 1);
  })) throw new Error('Journal account belongs to another company');
  if (isRefund(r) && r.reversed_entry_id) creditCheck(db, r);
  const posted = postAnalytic(write(db, 'account.move', id, { state: 'posted', name, journal_id: journal, line_ids, invoice_line_ids: resolvedLines }), id);
  if (isRefund(r) && r.reversed_entry_id) return offsetCreditNote(posted, id);
  const deferred = createInvoiceDeferrals(posted, read(posted, 'account.move', id));
  return r.move_type === 'in_invoice' ? draftAssetsFromBill(deferred, read(deferred, 'account.move', id)) : deferred;
}

/** Reverse an asset depreciation entry and make its board line available again. */
export function reverseDepreciation(db, move) {
  const asset = (db.records['account.asset'] ?? []).find((a) => (a.depreciation_ids ?? []).some((line) => line.posted && line.move_id === move.id));
  if (!asset || move.state !== 'posted' || asset.disposal_date) throw new Error('Select an active posted depreciation entry');
  if ((db.records['account.move'] ?? []).some((m) => m.state === 'posted' && m.reversed_entry_id === move.id)) throw new Error('This depreciation has already been reversed');
  const reversed = postEntry(db, { journal: move.journal_id, company: move.company_id ?? 1, date: today(), ref: `Reversal of ${move.name}`, lines: move.line_ids.map((l) => ({ account: l.account_id, debit: l.credit, credit: l.debit, partner_id: l.partner_id, analytic_distribution: l.analytic_distribution })) });
  const linked = postAnalytic(write(reversed.db, 'account.move', reversed.id, { reversed_entry_id: move.id }), reversed.id);
  return write(linked, 'account.asset', asset.id, { state: 'open', depreciation_ids: asset.depreciation_ids.map((l) => l.move_id === move.id ? { ...l, posted: false, move_id: null } : l) });
}

/** Credit notes of an invoice that are not cancelled, other than `exceptId`. */
const creditNotesOf = (db, invoiceId, exceptId = null) => (db.records['account.move'] ?? [])
  .filter((m) => m.reversed_entry_id === invoiceId && m.id !== exceptId && m.state !== 'cancel');

/** A credit note that settled its invoice (and the invoice it settled) stays: deleting either would leave the other falsely paid. */
function settledByCreditNote(db, m) {
  if (m.reversed_entry_id && (m.payments ?? []).some((p) => p.move_id)) return `${m.name} settled ${read(db, 'account.move', m.reversed_entry_id)?.name ?? 'its invoice'} and cannot be deleted; cancel it instead`;
  if (creditNotesOf(db, m.id).some((n) => n.state === 'posted')) return `${m.name} was credited by a posted credit note and cannot be deleted`;
  return null;
}

/** An invoice is credited at most once in total: its posted credit notes together cannot exceed it. */
function creditCheck(db, note) {
  const invoice = read(db, 'account.move', note.reversed_entry_id);
  if (!invoice || invoice.state !== 'posted') throw new Error('A credit note must reverse a posted invoice');
  // It must be the matching kind of document for the same partner and currency, and a real (positive) credit.
  if (invoice.move_type !== (note.move_type === 'out_refund' ? 'out_invoice' : 'in_invoice')) throw new Error(`A ${note.move_type === 'out_refund' ? 'credit note' : 'refund'} can only reverse a ${note.move_type === 'out_refund' ? 'customer invoice' : 'vendor bill'}`);
  if (invoice.partner_id !== note.partner_id) throw new Error(`The partner must be the one of ${invoice.name}`);
  if ((invoice.currency_id ?? null) !== (note.currency_id ?? null)) throw new Error(`The currency must be the one of ${invoice.name}`);
  if ((invoice.company_id ?? 1) !== (note.company_id ?? 1)) throw new Error('The credit note must belong to the invoice company');
  const docRound = (n) => roundCurrency(n, documentCurrency(db, invoice));
  if (!(total(note, db) > 0)) throw new Error('A credit note must have a positive total');
  const credited = creditNotesOf(db, invoice.id, note.id).filter((m) => m.state === 'posted').reduce((s, m) => s + total(m, db), 0);
  if (docRound(credited + total(note, db)) > docRound(total(invoice, db))) throw new Error(`Credit notes would exceed ${invoice.name}: ${money(docRound(total(invoice, db) - credited))} is left to credit`);
}

/**
 * A posted credit note settles what is still due on its invoice: both record the other in their payments and paid
 * amount, as a reconciliation would. Their receivable/payable lines already offset in the ledger.
 */
function offsetCreditNote(db, noteId) {
  const note = read(db, 'account.move', noteId);
  const invoice = read(db, 'account.move', note.reversed_entry_id);
  const value = Math.min(total(note, db), residual(invoice, db));
  if (!(value > 0)) return db;
  const date = note.invoice_date ?? today();
  const invoicePortion = settlementCompanyAmount(db, invoice, value);
  const notePortion = settlementCompanyAmount(db, note, value);
  const settle = (next, r, other) => write(next, 'account.move', r.id, {
    amount_paid: roundCurrency((Number(r.amount_paid) || 0) + value, documentCurrency(next, r)), payment_date: date, payments: [...(r.payments ?? []), { date, amount: value, move_id: other.id, cash_basis_move_id: null }],
  });
  let next = settle(settle(db, invoice, note), note, invoice);
  // Each document booked the amount at its own date's rate: the company-currency gap is an exchange difference.
  const sale = !isPurchase(invoice);
  const gap = roundCurrency(invoicePortion - notePortion, companyCurrencyRecord(db, invoice.company_id));
  if (gap) {
    const account = invoiceCounterpartAccount(db, invoice);
    const amount = Math.abs(gap);
    // The receivable/payable balance left by the two rates is cleared against the exchange gain or loss.
    const clearsDebit = sale ? gap < 0 : gap > 0;
    const open = clearsDebit ? { account, debit: amount, partner_id: invoice.partner_id } : { account, credit: amount, partner_id: invoice.partner_id };
    const fxLines = exchangeLines(db, invoice.company_id, clearsDebit ? amount : -amount);
    next = postEntry(next, { journal: 'MISC', company: invoice.company_id ?? 1, date, ref: `Exchange difference ${note.name}`, lines: [open, ...fxLines] }).db;
  }
  return postNote(next, 'account.move', invoice.id, `${money(value)} settled by credit note ${note.name}`);
}

/** Bill lines booked on a fixed-asset account become draft assets (once per bill line). */
function draftAssetsFromBill(db, bill) {
  const fixed = new Set((db.records['account.account'] ?? []).filter((a) => a.account_type === 'asset_fixed').map((a) => a.id));
  const existing = (db.records['account.asset'] ?? []).filter((a) => a.bill_id === bill.id && a.state === 'draft');
  const retained = new Set();
  const result = (bill.invoice_line_ids ?? []).reduce((next, line, index) => {
    const booked = postedBillLine(bill, index);
    if (!booked || booked.amount === 0) return next;
    const account = read(next, 'account.account', booked.account);
    const model = account?.asset_model_id ? read(next, 'account.asset.model', account.asset_model_id) : null;
    if (!fixed.has(booked.account) && !model) return next;
    const product = read(next, 'product', line.product_id);
    const values = {
      name: line.name || product?.name || bill.name, original_value: booked.amount, acquisition_date: bill.invoice_date ?? today(),
      partner_id: bill.partner_id, bill_id: bill.id, bill_line: index, company_id: bill.company_id ?? 1,
      account_asset_id: model?.account_asset_id ?? booked.account,
      ...(model ? {
        model_id: model.id,
        method: model.method ?? 'linear',
        method_number: model.method_number ?? 5,
        method_period: model.method_period ?? '12',
        method_progress_factor: model.method_progress_factor ?? 0.3,
        prorata: Boolean(model.prorata),
        account_depreciation_id: model.account_depreciation_id ?? null,
        account_expense_id: model.account_expense_id ?? null,
        journal_id: model.journal_id ?? null,
        analytic_distribution: model.analytic_distribution ?? null,
      } : {
        model_id: null,
        ...ASSET_DEPRECIATION_DEFAULTS,
        account_depreciation_id: null,
        account_expense_id: null,
        journal_id: null,
        analytic_distribution: null,
      }),
    };
    const asset = existing.find((a) => a.bill_line === index);
    if (asset) {
      retained.add(asset.id);
      return write(next, 'account.asset', asset.id, { ...values, depreciation_ids: [] });
    }
    return create(next, 'account.asset', values).db;
  }, db);
  const obsolete = existing.filter((asset) => !retained.has(asset.id)).map((asset) => asset.id);
  return obsolete.length ? unlink(result, 'account.asset', obsolete) : result;
}

/**
 * Record a payment: bank entry against receivable/payable, paid amount on the invoice, and a posted
 * payment record (or `paymentId`, an existing draft payment, gets posted with that entry).
 */
export function payMove(db, id, amount, date = today(), { paymentId, journalId: payJournal, statementLineId, directBank = false, liquidityAccountId = null, checkNumber } = {}) {
  const r = read(db, 'account.move', id);
  if (!Number.isFinite(Number(amount))) throw new Error('Payment amount must be finite');
  if (r?.state !== 'posted' || !isInvoice(r)) throw new Error('Only posted invoices and bills can be paid');
  const docRound = (n) => roundCurrency(n, documentCurrency(db, r));
  const companyRound = (n) => roundCurrency(n, companyCurrencyRecord(db, r.company_id));
  amount = docRound(amount);
  const value = Math.min(amount, residual(r, db));
  if (!(value > 0)) return db;
  const payRec = paymentId ? read(db, 'account.payment', paymentId) : null;
  if (paymentId && (!payRec || payRec.partner_id !== r.partner_id || payRec.payment_type !== (isInbound(r) ? 'inbound' : 'outbound') || payRec.partner_type !== (isPurchase(r) ? 'supplier' : 'customer'))) {
    throw new Error('Payment must match the invoice partner and direction');
  }
  // Matching an existing bank statement records money already sent, rather than authorizing a new payout.
  const statement = statementLineId ? read(db, 'account.bank.statement.line', statementLineId) : null;
  if (statementLineId && (!statement || statement.state !== 'to_check' || (statement.amount > 0) !== isInbound(r)
    || (statement.date ?? today()) !== date || (statement.company_id ?? 1) !== (r.company_id ?? 1)
    || toCompany(db, r.currency_id, amount, date, r.company_id) > companyRound(statement.open_amount ?? Math.abs(Number(statement.amount))))) {
    throw new Error('Invalid bank statement settlement');
  }
  if (liquidityAccountId && (!statement?.bank_move_id || directBank)) throw new Error('A bank suspense settlement requires a posted statement entry');
  let recipientBankId = null;
  if (isPurchase(r) && !isInbound(r) && !statement) {
    recipientBankId = resolveAndValidateRecipientBank(db, r.partner_id, payRec?.partner_bank_id, { invoiceBankId: r.partner_bank_id, companyId: r.company_id ?? 1 });
    if (recipientBankId && !r.partner_bank_id) db = write(db, 'account.move', r.id, { partner_bank_id: recipientBankId });
  }
  // Anything paid above the amount due stays on the partner's account as an outstanding credit.
  const excess = docRound(amount - value);
  const sale = isInbound(r);
  const counterpartCode = invoiceCounterpartAccount(db, r);
  const via = paymentJournal(db, payJournal);
  const journal = read(db, 'account.journal', payJournal ?? journalId(db, via.code, r.company_id));
  const outstanding = directBank || liquidityAccountId ? null : outstandingAccount(db, journal, r.company_id ?? 1, sale);
  const liquidity = liquidityAccountId ?? outstanding ?? via.account;
  // Bank moves at today's rate, the receivable/payable at the invoice rate; the gap is an exchange difference.
  const bank = toCompany(db, r.currency_id, value, date, r.company_id);
  // The last payment clears exactly what is left on the receivable/payable, so no cent stays behind.
  const final = value >= residual(r, db);
  const open = settlementCompanyAmount(db, r, value);
  const diff = companyRound(sale ? bank - open : open - bank);
  const fx = exchangeLines(db, r.company_id, diff);
  // The bank line converts what was really received once; the credit is whatever remains after the settled part.
  const extra = excess > 0 ? companyRound(toCompany(db, r.currency_id, value + excess, date, r.company_id) - bank) : 0;
  const foreign = !!r.currency_id && r.currency_id !== companyCurrencyRecord(db, r.company_id)?.id;
  const foreignAmount = (value) => foreign ? { currency_id: r.currency_id, amount_currency: docRound(value) } : {};
  const liquidityForeignAmount = (value) => journal?.currency_id === r.currency_id ? foreignAmount(value) : {};
  const credit = excess > 0 ? [sale ? { account: counterpartCode, credit: extra, partner_id: r.partner_id, name: 'Outstanding credit', ...foreignAmount(-excess) } : { account: counterpartCode, debit: extra, partner_id: r.partner_id, name: 'Outstanding credit', ...foreignAmount(excess) }] : [];
  const { db: withEntry, id: paymentMove } = postEntry(db, {
    journal: via.code, journal_id: journal?.id, date, ref: `Payment ${r.name}`, company: read(db, 'res.company', r.company_id ?? 1) ? (r.company_id ?? 1) : null,
    lines: sale
      ? [{ account: liquidity, debit: bank + extra, partner_id: r.partner_id, ...liquidityForeignAmount(value + excess) }, { account: counterpartCode, credit: open, partner_id: r.partner_id, ...foreignAmount(-value) }, ...credit, ...fx]
      : [{ account: counterpartCode, debit: open, partner_id: r.partner_id, ...foreignAmount(value) }, ...credit, { account: liquidity, credit: bank + extra, partner_id: r.partner_id, ...liquidityForeignAmount(-value - excess) }, ...fx],
  });
  const record = { state: 'posted', company_id: r.company_id ?? 1, currency_id: r.currency_id ?? null, move_id: paymentMove, outstanding_account_id: liquidityAccountId ?? outstanding, journal_id: journal?.id ?? journalId(db, via.code, r.company_id), invoice_id: r.id, partner_id: r.partner_id, amount: docRound(value + excess), unapplied: extra, date, payment_type: sale ? 'inbound' : 'outbound', partner_type: isPurchase(r) ? 'supplier' : 'customer', memo: r.name, ...(checkNumber != null ? { check_number: checkNumber } : {}), ...(recipientBankId ? { partner_bank_id: recipientBankId } : {}) };
  const draftName = paymentId ? read(withEntry, 'account.payment', paymentId)?.name : null;
  const name = draftName && draftName !== '/' ? draftName : nextName(withEntry, 'account.payment', `P${via.code}/${date.slice(0, 4)}/`);
  const withPayment = paymentId
    ? write(withEntry, 'account.payment', paymentId, { ...record, name })
    : create(withEntry, 'account.payment', { ...record, name }).db;
  const release = releaseCashBasis(withPayment, r, value / total(r, db), date, { final });
  const payments = [...(r.payments ?? []), { date, amount: value, move_id: paymentMove, company_amount: open, cash_basis_move_id: release.id }];
  const next = write(release.db, 'account.move', id, { amount_paid: docRound((Number(r.amount_paid) || 0) + value), payment_date: date, payments });
  const noted = postNote(next, 'account.move', id, `Payment of ${money(value)} registered`);
  return excess > 0 ? postNote(noted, 'account.move', id, `${money(excess)} paid above the amount due kept as an outstanding credit`) : noted;
}

/** Settle a document with an explicitly chosen company-currency write-off. */
export function settleWriteoff(db, invoiceId, amount, companyAmount, date, { accountId: writeoffAccount, label, journalId: journal } = {}) {
  const invoice = read(db, 'account.move', invoiceId);
  if (!invoice || invoice.state !== 'posted' || !isInvoice(invoice) || !Number.isFinite(Number(amount)) || !(amount > 0) || amount > residual(invoice, db)) throw new Error('Write-off exceeds the remaining invoice');
  const docRound = (n) => roundCurrency(n, documentCurrency(db, invoice));
  const companyRound = (n) => roundCurrency(n, companyCurrencyRecord(db, invoice.company_id));
  amount = docRound(amount);
  if (!Number.isFinite(Number(companyAmount)) || !(companyAmount > 0) || toCompany(db, invoice.currency_id, amount, date, invoice.company_id) !== companyRound(companyAmount)) throw new Error('Invalid write-off amount in company currency');
  const account = read(db, 'account.account', writeoffAccount);
  if (!account || (account.company_id && account.company_id !== (invoice.company_id ?? 1))) throw new Error('Write-off account belongs to another company or does not exist');
  if (!String(label ?? '').trim()) throw new Error('Set a write-off label');
  const incoming = isInbound(invoice);
  const counterpart = invoiceCounterpartAccount(db, invoice);
  const open = settlementCompanyAmount(db, invoice, amount);
  const diff = companyRound(incoming ? companyAmount - open : open - companyAmount);
  const fx = exchangeLines(db, invoice.company_id, diff);
  const partner_id = invoice.partner_id;
  const booked = postEntry(db, { journal: 'BNK1', journal_id: journal, company: invoice.company_id ?? 1, date, ref: label,
    lines: incoming
      ? [{ account: writeoffAccount, debit: companyAmount, partner_id, name: label }, { account: counterpart, credit: open, partner_id }, ...fx]
      : [{ account: counterpart, debit: open, partner_id }, { account: writeoffAccount, credit: companyAmount, partner_id, name: label }, ...fx] });
  const release = releaseCashBasis(booked.db, invoice, amount / total(invoice, db), date, { final: amount >= residual(invoice, db) });
  const payments = [...(invoice.payments ?? []), { date, amount, move_id: booked.id, company_amount: open, cash_basis_move_id: release.id }];
  return { db: write(release.db, 'account.move', invoiceId, { amount_paid: docRound((Number(invoice.amount_paid) || 0) + amount), payment_date: date, payments }), id: booked.id };
}

const releasedTaxKey = (account, name, tags = []) => `${account}:${name ?? ''}${tags.length ? `:${[...tags].sort((a, b) => a - b).join(',')}` : ''}`;

/** Tax already released for an invoice, per tax account code. */
const releasedTaxes = (db, r) => {
  const released = new Map();
  for (const m of db.records['account.move'] ?? []) {
    if (m.ref !== `Cash basis taxes ${r.name}` || m.state !== 'posted') continue;
    for (const l of m.line_ids ?? []) {
      const code = read(db, 'account.account', l.account_id)?.code;
      const key = releasedTaxKey(code, l.tax_name, l.tax_tag_ids);
      const previous = released.get(key) ?? { amount: 0, base: 0 };
      const zeroTax = !(Number(l.debit) || Number(l.credit));
      // Signed bases (and older zero-amount bases) include the refund direction.
      // Legacy nonzero reversals retain the original unsigned base, so undo it here.
      const base = (Number(l.tax_base) || 0) * ((l.tax_base_signed || zeroTax) && isRefund(r) ? -1 : 1)
        * (!l.tax_base_signed && !zeroTax && m.reversed_entry_id ? -1 : 1);
      released.set(key, { amount: previous.amount + ((!isPurchase(r) !== isRefund(r)) ? 1 : -1) * ((Number(l.credit) || 0) - (Number(l.debit) || 0)), base: previous.base + base });
    }
  }
  return released;
};

/**
 * Cash-basis taxes become due in proportion to what was paid: moved from the transition account to the tax account.
 * The final payment releases whatever is left, so the transition account ends at zero.
 */
export function releaseCashBasis(db, r, share, date, { final = false } = {}) {
  const sale = !isPurchase(r);
  // A refund carries the tax the other way round: its release reverses the invoice's.
  const refund = isRefund(r);
  const released = final ? releasedTaxes(db, r) : null;
  const companyCurrency = companyCurrencyRecord(db, r.company_id);
  const companyRound = (n) => roundCurrency(n, companyCurrency);
  const groups = cashBasisTaxes(r.invoice_line_ids, rateAt(db, r.currency_id, r.invoice_date ?? date, r.company_id), documentCurrency(db, r), companyCurrency)
    .map((g) => ({ ...g, account: read(db, 'account.account', g.account_id)?.code ?? (sale ? '251000' : '131000') }));
  const due = groups.map((g) => {
    const accountTotal = groups.filter((x) => x.account === g.account).reduce((s, x) => s + x.amount, 0);
    // Older releases were not tagged; allocate their account total across its taxes.
    const tagged = final ? released.get(releasedTaxKey(g.account, g.tax_name, g.tax_tag_ids)) : null;
    const legacy = final ? released.get(`${g.account}:`) : null;
    const legacyShare = accountTotal ? g.amount / accountTotal : 0;
    const prior = (tagged?.amount ?? 0) + (legacy?.amount ?? 0) * legacyShare;
    const priorBase = (tagged?.base ?? 0) + (legacy?.base ?? 0) * legacyShare;
    return { ...g, amount: companyRound(final ? g.amount - prior : g.amount * Math.abs(share)), base: companyRound(final ? g.base - priorBase : g.base * share) };
  })
    .filter((g) => g.amount || g.base);
  if (!due.length) return { db, id: null };
  const transition = TRANSITION[sale ? 'sale' : 'purchase'];
  // The released tax lands on the tax account tagged with its tax and base, so the return counts it when paid.
  const lines = due.flatMap(({ account, amount, base, tax_name, tax_tag_ids }) => {
    // The base is signed independently of the tax amount, including reversals and refunds.
    const tax = { account, partner_id: r.partner_id, name: tax_name, tax_name, tax_tag_ids, tax_grid_release: true, tax_base: refund ? -base : base, tax_base_signed: true, tax_side: sale ? 'sale' : 'purchase' };
    return (sale !== refund) === (share > 0)
      ? [{ account: transition, debit: amount, partner_id: r.partner_id }, { ...tax, credit: amount }]
      : [{ ...tax, debit: amount }, { account: transition, credit: amount, partner_id: r.partner_id }];
  });
  return postEntry(db, { journal: 'MISC', date, ref: `Cash basis taxes ${r.name}`, lines, company: read(db, 'res.company', r.company_id ?? 1) ? (r.company_id ?? 1) : null });
}

/** Draft credit note (customer) or refund (vendor) reversing a posted invoice or bill, while some of it is left to credit. */
export function creditNote(db, r) {
  const purchase = isPurchase(r);
  const credited = creditNotesOf(db, r.id).reduce((s, m) => s + total(m, db), 0);
  if (roundCurrency(credited, documentCurrency(db, r)) >= roundCurrency(total(r, db), documentCurrency(db, r))) throw new Error(`${r.name} is already fully credited`);
  const { db: next, id } = create(db, 'account.move', {
    move_type: purchase ? 'in_refund' : 'out_refund', partner_id: r.partner_id, invoice_origin: r.name, invoice_date: today(), invoice_date_due: today(), reversed_entry_id: r.id,
    sale_id: r.sale_id ?? null, purchase_id: r.purchase_id ?? null, company_id: r.company_id,
    invoice_line_ids: r.invoice_line_ids.map((l) => ({ ...l })), ref: `Reversal of ${r.name}`, currency_id: r.currency_id ?? null, fiscal_position_id: r.fiscal_position_id ?? null,
  });
  return { db: syncInvoicedQty(next, read(next, 'account.move', id)), go: `#/accounting/${purchase ? 'refunds' : 'credit-notes'}/${id}` };
}

/** Correct an issued credit with a fresh debit invoice; never reopen or erase its historical settlement. */
export function correctCreditNote(db, note) {
  if (note.state !== 'posted' || !isRefund(note)) throw new Error('Only posted credit notes can be corrected');
  if ((db.records['account.move'] ?? []).some((m) => m.correction_of_id === note.id && m.state !== 'cancel')) throw new Error('This credit note already has a correction');
  const purchase = isPurchase(note);
  const out = create(db, 'account.move', {
    move_type: purchase ? 'in_invoice' : 'out_invoice', correction_of_id: note.id, company_id: note.company_id,
    partner_id: note.partner_id, currency_id: note.currency_id ?? null, fiscal_position_id: note.fiscal_position_id ?? null,
    invoice_origin: note.name, ref: `Correction of ${note.name}`, invoice_date: today(), invoice_date_due: today(),
    invoice_line_ids: note.invoice_line_ids.map(({ purchase_line_id, sale_line_id, ...line }) => ({ ...line })),
  });
  return { db: postNote(out.db, 'account.move', note.id, `Correction invoice drafted for ${note.name}`), go: `#/accounting/${purchase ? 'bills' : 'invoices'}/${out.id}` };
}

/** Early-payment discount available on `date` for an unpaid invoice (0 when its term has none or the window passed). */
export function discountAvailable(db, r, date = today()) {
  const term = read(db, 'account.payment.term', r.invoice_payment_term_id);
  const currency = documentCurrency(db, r);
  const base = term?.discount_tax_computation === 'excluded' ? amounts(r.invoice_line_ids, currency).untaxed : total(r, db);
  return term && !(Number(r.amount_paid) > 0) ? earlyDiscount(term, base, r.invoice_date, date, currency) : 0;
}

/** Reverse the discounted share of invoice-basis taxes using their posted accounts and bases. */
function discountTaxLines(db, invoice, term, discount) {
  if (term?.discount_tax_computation !== 'included') return [];
  const share = discount / (total(invoice, db) || 1);
  const companyRound = (n) => roundCurrency(n, companyCurrencyRecord(db, invoice.company_id));
  return (invoice.line_ids ?? []).filter((line) => line.tax_name && !line.tax_zero).map((line) => ({
    account_id: line.account_id, partner_id: invoice.partner_id, name: line.tax_name,
    debit: companyRound((Number(line.credit) || 0) * share), credit: companyRound((Number(line.debit) || 0) * share),
    tax_name: line.tax_name, tax_base: companyRound((isRefund(invoice) ? 1 : -1) * (Number(line.tax_base) || 0) * share), tax_base_signed: true,
    ...(line.tax_side ? { tax_side: line.tax_side } : {}),
  }));
}

/** Pay `amount`; when it settles the invoice net of an early-payment discount, book the discount too. */
export function payWithDiscount(db, id, amount, date = today()) {
  const r = read(db, 'account.move', id);
  const docRound = (n) => roundCurrency(n, documentCurrency(db, r));
  const companyRound = (n) => roundCurrency(n, companyCurrencyRecord(db, r.company_id));
  amount = docRound(amount);
  const due = residual(r, db);
  const paid = payMove(db, id, amount, date);
  const gap = docRound(due - amount);
  const discount = Math.min(discountAvailable(db, r, date), gap);
  if (!(gap > 0) || discount < gap) return paid;
  const sale = isInbound(r);
  const value = settlementCompanyAmount(paid, read(paid, 'account.move', id), discount);
  const company = read(db, 'res.company', r.company_id ?? 1);
  const discountAccount = sale ? company?.expense_early_payment_discount_account_id ?? '690200' : company?.income_early_payment_discount_account_id ?? '450200';
  const counterpart = invoiceCounterpartAccount(db, r);
  const taxes = discountTaxLines(db, r, read(db, 'account.payment.term', r.invoice_payment_term_id), discount);
  const taxValue = companyRound(taxes.reduce((sum, line) => sum + (sale ? line.debit - line.credit : line.credit - line.debit), 0));
  const { db: booked, id: discountMove } = postEntry(paid, {
    journal: 'MISC', date, ref: `Early payment discount ${r.name}`, company: company?.id ?? null,
    lines: sale
      ? [{ account: discountAccount, debit: value - taxValue, partner_id: r.partner_id }, ...taxes, { account: counterpart, credit: value, partner_id: r.partner_id }]
      : [{ account: counterpart, debit: value, partner_id: r.partner_id }, ...taxes, { account: discountAccount, credit: value - taxValue, partner_id: r.partner_id }],
  });
  const after = read(booked, 'account.move', id);
  // Recorded like a payment (dated, pointing at its entry), so locked-period checks can verify it.
  const paymentMove = after.payments.at(-1).move_id;
  const payments = [...(after.payments ?? []), { date, amount: discount, move_id: discountMove, payment_move_id: paymentMove, company_amount: value, cash_basis_move_id: null, discount: true }];
  return postNote(write(booked, 'account.move', id, { amount_paid: docRound((Number(after.amount_paid) || 0) + discount), payment_date: date, payments }), 'account.move', id, `Early payment discount of ${money(discount)} applied`);
}

function registerPayment(db, r) {
  const due = roundCurrency(residual(r, db) - discountAvailable(db, r), documentCurrency(db, r));
  const amount = promptedAmount(prompt(`Payment amount (due ${money(due)})`, String(due)));
  if (amount == null) return { db };
  return { db: payWithDiscount(db, r.id, amount) };
}

const termDue = (db, r) => {
  const term = read(db, 'account.payment.term', r.invoice_payment_term_id);
  return term && r.invoice_date ? { invoice_date_due: dueDate(term, r.invoice_date) } : {};
};

const invoiceLineBase = productLines('Invoice Lines', 'list_price');
const invoiceLineField = { ...invoiceLineBase, onchange: (line, key, db, move) => {
  const updated = invoiceLineBase.onchange(line, key, db, move);
  return db && ['product_id', 'account_id'].includes(key) ? { ...updated, analytic_distribution: defaultDistributionForLine(db, updated, move) } : updated;
}, fields: { name: { type: 'char', label: 'Label' }, ...invoiceLineBase.fields, account_id: { type: 'many2one', relation: 'account.account', label: 'Account' }, display_type: { type: 'selection', label: 'Display Type', options: [['line_section', 'Section'], ['line_note', 'Note']] }, deferred_start_date: { type: 'date', label: 'Deferred Start Date' }, deferred_end_date: { type: 'date', label: 'Deferred End Date' }, sale_line_key: { type: 'char', label: 'Order Line', readonly: true, hidden: true }, down_payment_key: { type: 'char', label: 'Down Payment', readonly: true, hidden: true }, rental_id: { type: 'many2one', relation: 'sale.rental', label: 'Rental', readonly: true, hidden: true }, rental_charge: { type: 'char', label: 'Type', readonly: true, hidden: true } } };

const lineItem = {
  type: 'one2many',
  label: 'Journal Items',
  fields: {
    account_id: { type: 'many2one', relation: 'account.account', label: 'Account' },
    partner_id: { type: 'many2one', relation: 'res.partner', label: 'Partner' },
    name: { type: 'char', label: 'Label' },
    debit: { type: 'monetary', label: 'Debit', currency: 'company' },
    credit: { type: 'monetary', label: 'Credit', currency: 'company' },
    currency_id: { type: 'many2one', relation: 'res.currency', label: 'Currency' },
    amount_currency: { type: 'monetary', label: 'Amount in Currency' },
    date_maturity: { type: 'date', label: 'Due Date' },
    invoice_sources: { type: 'one2many', label: 'Invoice Sources', hidden: true, fields: {
      index: { type: 'integer', label: 'Line' }, amount: { type: 'monetary', label: 'Amount' },
      original_account_id: { type: 'many2one', relation: 'account.account', label: 'Recognition Account' },
    } },
    // Tax lines name their tax and the base it was charged on (company currency) for the tax return.
    tax_name: { type: 'char', label: 'Tax', hidden: true },
    tax_base: { type: 'monetary', label: 'Tax Base', currency: 'company', hidden: true },
    tax_base_signed: { type: 'boolean', label: 'Tax Base', hidden: true },
    tax_zero: { type: 'boolean', label: 'Tax', hidden: true },
    tax_side: { type: 'selection', label: 'Tax', hidden: true, options: [['sale', 'Sales'], ['purchase', 'Purchases']] },
    tax_id: { type: 'many2one', relation: 'account.tax', label: 'Tax', hidden: true },
    tax_ids: { type: 'many2many', relation: 'account.tax', label: 'Taxes', hidden: true },
    tax_tag_ids: { type: 'many2many', relation: 'account.account.tag', label: 'Tax Tags', hidden: true },
    tax_grid_base: { type: 'boolean', label: 'Tax Grid Base', hidden: true },
    tax_grid_release: { type: 'boolean', label: 'Tax Grid Release', hidden: true },
    tag_ids: { type: 'many2many', relation: 'account.account.tag', label: 'Tags', hidden: true },
    analytic_distribution: { type: 'distribution', label: 'Analytic Distribution', hidden: true },
  },
  newLine: () => ({ account_id: null, partner_id: null, name: '', debit: 0, credit: 0 }),
};

export const accountingModels = {
  'account.account': {
    label: 'Chart of Accounts',
    fields: {
      code: { type: 'char', label: 'Code', required: true },
      name: { type: 'char', label: 'Account Name', required: true },
      account_type: { type: 'selection', label: 'Type', options: ACCOUNT_TYPES },
      reconcile: { type: 'boolean', label: 'Allow Reconciliation' },
      tag_ids: { type: 'many2many', relation: 'account.account.tag', label: 'Tags', domain: (r) => r.applicability === 'accounts' },
      asset_model_id: { type: 'many2one', relation: 'account.asset.model', label: 'Depreciation Model' },
      fiscal_category_id: { type: 'many2one', relation: 'account.fiscal.category', label: 'Fiscal Category' },
    },
    defaults: () => ({ account_type: 'expense' }),
    guard: (db, before, after) => {
      if ((after.tag_ids ?? []).some((id) => read(db, 'account.account.tag', id)?.applicability !== 'accounts')) return 'Select only account tags';
      if (after.fiscal_category_id) {
        const category = read(db, 'account.fiscal.category', after.fiscal_category_id);
        if (!category) return 'Select an existing fiscal category';
        if (after.company_id && category.company_id !== after.company_id) return 'Fiscal category must belong to the account company';
      }
      return null;
    },
    protectDelete: accountDeleteGuard,
    groupBys: ['account_type'],
    kanban: { title: 'name', lines: ['code', 'account_type'] },
    list: ['code', 'name', 'account_type'],
    views: ['list', 'kanban'],
    form: {
      title: 'name',
      groups: [['code', 'account_type', 'asset_model_id', 'fiscal_category_id'], ['reconcile', 'tag_ids']],
    },
  },

  'account.fiscal.category': {
    label: 'Fiscal Categories',
    fields: {
      name: { type: 'char', label: 'Name', required: true },
      code: { type: 'char', label: 'Code' },
      active: { type: 'boolean', label: 'Active' },
      company_id: { type: 'many2one', relation: 'res.company', label: 'Company', required: true },
      account_ids: {
        type: 'one2many', label: 'Accounts', readonly: true,
        compute: (r, db) => (db.records['account.account'] ?? []).filter((a) => a.fiscal_category_id === r.id && (!a.company_id || a.company_id === r.company_id)),
        fields: { code: { type: 'char', label: 'Code' }, name: { type: 'char', label: 'Account Name' } },
      },
    },
    defaults: () => ({ active: true }),
    guard: (db, before, after) => before && before.company_id !== after.company_id && (db.records['account.account'] ?? []).some((a) => a.fiscal_category_id === after.id && a.company_id && a.company_id !== after.company_id) ? 'Fiscal category must belong to the account company' : null,
    list: ['name', 'code', 'company_id'],
    form: { title: 'name', groups: [['name', 'code'], ['company_id', 'active']], tabs: [{ label: 'Accounts', fields: ['account_ids'], readonly: true }] },
  },

  'account.account.tag': {
    label: 'Account Tags',
    fields: {
      name: { type: 'char', label: 'Tag Name', required: true },
    },
    list: ['name'],
    form: { title: 'name', groups: [['name']] },
  },

  'account.journal': {
    label: 'Journals',
    guard: secureHeadsGuard,
    protectDelete: (db, journal) => (journal.secure_chain_heads ?? []).length ? 'Journals with secure chains cannot be deleted' : null,
    fields: {
      name: { type: 'char', label: 'Journal Name', required: true },
      code: { type: 'char', label: 'Short Code', required: true },
      type: { type: 'selection', label: 'Type', options: [['sale', 'Sales'], ['purchase', 'Purchase'], ['bank', 'Bank'], ['cash', 'Cash'], ['general', 'Miscellaneous']] },
      default_account_id: { type: 'many2one', relation: 'account.account', label: 'Default Account' },
      outstanding_receipts_account_id: { type: 'many2one', relation: 'account.account', label: 'Outstanding Receipts' },
      outstanding_payments_account_id: { type: 'many2one', relation: 'account.account', label: 'Outstanding Payments' },
      check_next_number: { type: 'integer', label: 'Next Check Number' },
      restrict_mode_hash_table: { type: 'boolean', label: 'Secure Posted Entries with Hash' },
      secure_chain_heads: { type: 'one2many', label: 'Secure Chain Heads', hidden: true, fields: {
        company_id: { type: 'many2one', relation: 'res.company', label: 'Company' },
        count: { type: 'integer', label: 'Count' }, last_sequence: { type: 'integer', label: 'Sequence' },
        last_hash: { type: 'char', label: 'Hash' }, last_move_id: { type: 'many2one', relation: 'account.move', label: 'Last Entry' },
        last_move_name: { type: 'char', label: 'Last Entry Number' },
      } },
    },
    defaults: () => ({ type: 'general', restrict_mode_hash_table: false }),
    kanban: { title: 'name', lines: ['code', 'type'], counter: { label: 'Entries', model: 'account.move', field: 'journal_id' } },
    list: ['code', 'name', 'type', 'default_account_id', 'restrict_mode_hash_table'],
    form: {
      title: 'name',
      smart: [{ label: 'Entries', model: 'account.move', field: 'journal_id', target: 'accounting/entries' }],
      groups: [['code', 'type'], ['default_account_id', 'outstanding_receipts_account_id', 'outstanding_payments_account_id', 'restrict_mode_hash_table', 'check_next_number']],
    },
  },

  'account.move': {
    label: 'Invoices',
    guard: (db, before, after, ctx) => moveGuard(db, before, after, ctx) ?? paymentGuard(db, before, after, ctx) ?? (after.state === 'posted' && badLineSign(after.line_ids) ? 'Debits and credits cannot be negative' : null),
    invariant: (db, after, before) => secureMoveInvariant(db, after, before) ?? lockedSettlementInvariant(db, after, before) ?? moveInvariant(db, after, before),
    protectDelete: (db, m, staged) => moveDeleteGuard(db, m, staged) ?? settledByCreditNote(db, m) ?? (settlingEntries(db).has(m.id) || Number(m.amount_paid) > 0 ? 'Entries tied to a payment cannot be deleted' : null),
    audited: (db) => db.settings?.audit_trail === true,
    onUnlink: (db, r) => syncInvoicedQty(db, r),
    onWrite: (db, after, before, vals) => {
      if (before.state === 'posted' && after.state !== 'posted') db = reverseInvoiceDeferrals(db, before);
      if (!['invoice_line_ids', 'state', 'sale_id', 'purchase_id'].some((key) => key in vals)) return db;
      return syncInvoicedQty(syncInvoicedQty(db, before), after);
    },
    // The partner's payment term becomes the default; the term and invoice date drive the due date.
    onchange: (r, key, db) => {
      if (['partner_id', 'fiscal_position_id', 'company_id'].includes(key)) {
        const partnerChange = key === 'partner_id';
        const term = partnerChange && r.partner_id ? read(db, 'res.partner', r.partner_id)?.property_payment_term_id : null;
        const fiscal = partnerChange ? { fiscal_position_id: fiscalPositionFor(db, r.partner_id) } : {};
        const partnerBank = partnerChange && isPurchase(r)
          ? search(db, 'res.partner.bank').find((b) => b.partner_id === r.partner_id && b.allow_out_payment && b.active !== false)?.id ?? null
          : null;
        const context = { ...r, ...fiscal };
        const linesUpdate = Array.isArray(r.invoice_line_ids)
          ? { invoice_line_ids: r.invoice_line_ids.map((line) => ({ ...line, analytic_distribution: defaultDistributionForLine(db, line, context, line.analytic_distribution ?? {}) })) }
          : {};
        return {
          ...fiscal,
          ...(partnerBank ? { partner_bank_id: partnerBank } : {}),
          ...linesUpdate,
          ...(term ? { invoice_payment_term_id: term, ...termDue(db, { ...r, invoice_payment_term_id: term }) } : {}),
        };
      }
      return ['invoice_payment_term_id', 'invoice_date'].includes(key) ? termDue(db, r) : {};
    },
    fields: {
      name: { type: 'char', label: 'Number', readonly: true },
      move_type: { type: 'selection', label: 'Type', readonly: true, options: [['out_invoice', 'Customer Invoice'], ['out_refund', 'Credit Note'], ['in_invoice', 'Vendor Bill'], ['in_refund', 'Vendor Refund'], ['entry', 'Journal Entry']] },
      journal_id: {
        type: 'many2one',
        relation: 'account.journal',
        label: 'Journal',
        domain: (j, r) => (!j.company_id || j.company_id === (r?.company_id ?? 1)) && (r?.move_type === 'entry' ? true : isPurchase(r) ? j.type === 'purchase' : j.type === 'sale'),
      },
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Partner' },
      partner_bank_id: { type: 'many2one', relation: 'res.partner.bank', label: 'Recipient Bank Account' },
      ref: { type: 'char', label: 'Reference' },
      date: { type: 'date', label: 'Accounting Date' },
      invoice_date: { type: 'date', label: 'Date' },
      invoice_date_due: { type: 'date', label: 'Due Date' },
      invoice_origin: { type: 'char', label: 'Source Document', readonly: true },
      payment_reference: { type: 'char', label: 'Payment Reference' },
      currency_id: { type: 'many2one', relation: 'res.currency', label: 'Currency' },
      invoice_payment_term_id: { type: 'many2one', relation: 'account.payment.term', label: 'Payment Terms' },
      invoice_cash_rounding_id: { type: 'many2one', relation: 'account.cash.rounding', label: 'Cash Rounding' },
      fiscal_position_id: { type: 'many2one', relation: 'account.fiscal.position', label: 'Fiscal Position' },
      subscription_id: { type: 'many2one', relation: 'sale.subscription', label: 'Subscription', readonly: true },
      subscription_period: { type: 'date', label: 'Subscription Period', readonly: true },
      state: { type: 'selection', label: 'Status', tracking: true, options: [['draft', 'Draft'], ['posted', 'Posted'], ['cancel', 'Cancelled']] },
      invoice_line_ids: invoiceLineField,
      payments: {
        type: 'one2many', label: 'Payments', readonly: true,
        fields: { date: { type: 'date', label: 'Paid on' }, amount: { type: 'monetary', label: 'Amount' }, move_id: { type: 'many2one', relation: 'account.move', label: 'Payment' }, payment_move_id: { type: 'many2one', relation: 'account.move', label: 'Payment' }, company_amount: { type: 'monetary', label: 'Company Amount', currency: 'company' }, line_index: { type: 'integer', label: 'Closing Line Index', hidden: true }, payment_company_amount: { type: 'monetary', label: 'Payment Company Amount', currency: 'company' }, payment_fx_move_id: { type: 'many2one', relation: 'account.move', label: 'Exchange Entry' }, cash_basis_move_id: { type: 'many2one', relation: 'account.move', label: 'Journal Entry' }, discount: { type: 'boolean', label: 'Early Payment Discount' }, reversed: { type: 'boolean', label: 'Reversed' }, reversal_move_id: { type: 'many2one', relation: 'account.move', label: 'Reversal Entry' }, reversal_date: { type: 'date', label: 'Reversal Date' } },
        newLine: () => ({ date: today(), amount: 0, move_id: null }),
      },
      line_ids: lineItem,
      credit_warning: { type: 'text', label: 'Credit Warning', readonly: true, compute: (r, db) => r.move_type === 'out_invoice' ? creditWarning(db, r.partner_id, r.state === 'posted' ? 0 : total(r, db)) : '' },
      amount_untaxed: { type: 'monetary', label: 'Tax Excluded', compute: (r, db) => amounts(r.invoice_line_ids, documentCurrency(db, r)).untaxed },
      amount_tax: { type: 'monetary', label: 'Taxes', compute: (r, db) => amounts(r.invoice_line_ids, documentCurrency(db, r)).tax },
      amount_total: { type: 'monetary', label: 'Total', compute: total },
      amount_paid: { type: 'monetary', label: 'Paid', readonly: true },
      amount_residual: { type: 'monetary', label: 'Amount Due', compute: residual },
      payment_state: {
        type: 'selection',
        label: 'Payment Status',
        compute: paymentState,
        options: [['not_paid', 'Not Paid'], ['partial', 'Partially Paid'], ['paid', 'Paid']],
      },
      should_be_paid: { type: 'selection', label: 'Should Be Paid', compute: (r, db) => shouldBePaid(db, r), options: [['yes', 'Yes'], ['exception', 'Exception']] },
      payment_date: { type: 'date', label: 'Paid on', readonly: true },
      fx_payment_move_id: { type: 'many2one', relation: 'account.move', label: 'Payment Entry', readonly: true },
      fx_invoice_id: { type: 'many2one', relation: 'account.move', label: 'Settlement Invoice', readonly: true },
      reversed_entry_id: { type: 'many2one', relation: 'account.move', label: 'Reversal of', readonly: true },
      // Set by fiscal closing and exchange revaluation only.
      is_closing: { type: 'boolean', label: 'Closing Entry', readonly: true, hidden: true },
      revaluation_date: { type: 'date', label: 'Revaluation Date', readonly: true },
      deferral_date: { type: 'date', label: 'Deferral Date', readonly: true },
      deferral_kind: { type: 'selection', label: 'Deferral Kind', readonly: true, options: [['revenue', 'Deferred Revenue'], ['expense', 'Deferred Expense']] },
      is_deferred_grouped: { type: 'boolean', label: 'Grouped Deferral Entry', readonly: true, hidden: true },
      reversal_move_id: { type: 'many2one', relation: 'account.move', label: 'Reversal Entry', readonly: true },
      correction_of_id: { type: 'many2one', relation: 'account.move', label: 'Correction of', readonly: true },
      sale_id: { type: 'many2one', relation: 'sale.order', label: 'Sales Order', readonly: true },
      purchase_id: { type: 'many2one', relation: 'purchase.order', label: 'Purchase Order', readonly: true },
      inalterable_hash: { type: 'char', label: 'Inalterability Hash', readonly: true },
      inalterable_hash_version: { type: 'integer', label: 'Hash Version', readonly: true, hidden: true },
      secure_sequence_number: { type: 'integer', label: 'Inalterability Sequence Number', readonly: true },
      incoterm_id: { type: 'many2one', relation: 'account.incoterm', label: 'Incoterm' },
      incoterm_location: { type: 'char', label: 'Incoterm Location' },
      narration: { type: 'text', label: 'Terms and Conditions' },
    },
    defaults: () => ({ name: '/', move_type: 'out_invoice', state: 'draft', invoice_date: today(), invoice_line_ids: [], line_ids: [], amount_paid: 0 }),
    filters: [
      [{ id: 'draft', label: 'Draft', fn: (r) => r.state === 'draft' }, { id: 'posted', label: 'Posted', fn: (r) => r.state === 'posted' }],
      [
        { id: 'unpaid', label: 'Not Paid', fn: (r) => r.state === 'posted' && isInvoice(r) && paymentState(r) !== 'paid' },
        { id: 'overdue', label: 'Overdue', fn: (r) => r.state === 'posted' && isInvoice(r) && paymentState(r) !== 'paid' && r.invoice_date_due < today() },
      ],
    ],
    groupBys: ['partner_id', 'journal_id', 'state', 'payment_state', 'invoice_date', 'invoice_date_due'],
    views: ['list', 'kanban', 'graph', 'pivot', 'calendar'],
    kanban: { title: 'name', lines: ['partner_id', 'amount_total', 'invoice_date_due'], badge: 'payment_state' },
    list: ['name', 'partner_id', 'invoice_date', 'invoice_date_due', 'amount_untaxed', 'amount_total', 'amount_residual', 'payment_state'],
    listDecoration: (r) => (r.state === 'draft' ? 'info' : r.state === 'posted' && isInvoice(r) && paymentState(r) !== 'paid' && r.invoice_date_due < today() ? 'danger' : null),
    graph: { groupBy: 'invoice_date', measure: 'amount_total' },
    pivot: { row: 'partner_id', col: 'payment_state', measure: 'amount_total' },
    calendar: { date: 'invoice_date_due' },
    form: {
      statusbar: 'state',
      statusbarHide: ['cancel'],
      lockedWhen: (r) => r.state !== 'draft' || Boolean(r.inalterable_hash),
      buttons: [
        { label: 'Confirm', primary: true, when: (r) => r.state === 'draft', run: (db, r) => ({ db: postMove(db, r.id) }) },
        { label: 'Reverse Entry', when: (r, db) => r.state === 'posted' && r.move_type === 'entry' && (db.records['account.asset'] ?? []).some((a) => (a.depreciation_ids ?? []).some((l) => l.posted && l.move_id === r.id)), run: (db, r) => ({ db: reverseDepreciation(db, r) }) },
        { label: 'Create Landed Costs', when: (r) => r.move_type === 'in_invoice' && r.state === 'posted', run: (db, r) => {
          if ((db.records['stock.landed.cost'] ?? []).some((lc) => lc.bill_id === r.id)) throw new Error('Landed costs have already been created for this bill');
          const warnings = [];
          const legacy = !(r.line_ids ?? []).some((line) => Array.isArray(line.invoice_sources));
          const lines = (r.invoice_line_ids ?? []).flatMap((l, index) => {
            const product = read(db, 'product', l.product_id);
            if (!product?.landed_cost_ok) return [];
            if (legacy) {
              warnings.push(`Bill line ${index + 1} (${product.name}): posted expense could not be identified unambiguously. Record it as a manual landed cost instead.`);
              return [];
            }
            const posted = postedBillLine(r, index);
            if (!posted) throw new Error('Bill line has no identifiable posted journal amount');
            const { amount, account } = posted;
            return [{ name: product.name || 'Freight', amount, account_id: account, split_method: 'quantity', source_bill_line: index, source_bill_amount: amount, source_bill_account_id: account }];
          });
          if (!lines.length) {
            if (warnings.length) throw new Error(warnings.join('\n'));
            throw new Error('Select a landed cost product on the vendor bill');
          }
          const source_warning = warnings.join('\n');
          const created = create(db, 'stock.landed.cost', { name: r.name, bill_id: r.id, company_id: r.company_id, cost_lines: lines, source_warning });
          return { db: source_warning ? postNote(created.db, 'stock.landed.cost', created.id, source_warning) : created.db, go: `#/inventory/landed/${created.id}` };
        } },
        { label: 'Approve for Payment', when: (r) => r.move_type === 'in_invoice' && r.state === 'posted' && r.should_be_paid === 'exception', run: (db, r) => ({ db: write(db, 'account.move', r.id, { force_post: true }) }) },
        { label: 'Reset Payment Review', when: (r) => r.move_type === 'in_invoice' && r.state === 'posted' && r.force_post, run: (db, r) => ({ db: write(db, 'account.move', r.id, { force_post: false }) }) },
        // Server-only: Claude reads an uploaded bill (image/PDF) into this draft.
        { label: 'Digitize Document', upload: 'image/*,application/pdf', server: '/api/integrations/digitize', requires: 'ai', when: (r) => r.state === 'draft' && r.move_type === 'in_invoice' },
        { label: 'Register Payment', primary: true, when: (r) => r.state === 'posted' && isInvoice(r) && paymentState(r) !== 'paid', run: registerPayment },
        { label: 'Send by Email', email: 'document', when: (r) => r.state === 'posted' && isInvoice(r), run: (db) => ({ db }) },
        { label: 'Credit Note', when: (r) => r.state === 'posted' && ['out_invoice', 'in_invoice'].includes(r.move_type), run: creditNote },
        { label: 'Correct Credit Note', when: (r) => r.state === 'posted' && isRefund(r), run: correctCreditNote },
        { label: 'Print', when: (r) => r.state === 'posted' && isInvoice(r), run: (db, r) => ({ db, go: `#/print/account.move/${r.id}` }) },
        { label: 'Reset to Draft', when: (r, db) => r.state !== 'draft' && !r.inalterable_hash && !(Number(r.amount_paid) > 0) && !(db && settlingEntries(db).has(r.id)), run: (db, r) => ({ db: removeAnalytic(write(db, 'account.move', r.id, { state: 'draft', ...(isInvoice(r) ? { line_ids: [] } : {}) }), r.id) }) },
        { label: 'Cancel', when: (r) => r.state === 'draft' && !r.inalterable_hash, run: (db, r) => ({ db: syncInvoicedQty(removeAnalytic(write(db, 'account.move', r.id, { state: 'cancel' }), r.id), r) }) },
      ],
      ribbon: (r) => (r.state === 'cancel' ? 'Cancelled' : paymentState(r) === 'paid' ? 'Paid' : paymentState(r) === 'partial' ? 'Partial' : null),
      subtitle: (r) => ({ in_invoice: 'Vendor Bill', in_refund: 'Vendor Refund', out_refund: 'Credit Note', entry: 'Journal Entry' })[r.move_type] ?? 'Customer Invoice',
      title: 'name',
      groups: [['credit_warning', 'partner_id', 'ref', 'invoice_origin', 'incoterm_id', 'incoterm_location'], ['invoice_date', 'invoice_payment_term_id', 'invoice_date_due', 'journal_id', 'currency_id', 'fiscal_position_id', 'invoice_cash_rounding_id', 'payment_date', 'should_be_paid', 'inalterable_hash', 'secure_sequence_number']],
      tabs: (r) => (isInvoice(r)
        ? [{ label: 'Invoice Lines', fields: ['invoice_line_ids'] }, { label: 'Journal Items', fields: ['line_ids'], readonly: true }, { label: 'Payments', fields: ['payments'], readonly: true }, { label: 'Other Info', fields: ['narration', 'incoterm_id', 'incoterm_location'] }]
        : [{ label: 'Journal Items', fields: ['line_ids'] }]),
      footer: (r) => (isInvoice(r) ? ['amount_untaxed', 'amount_tax', 'amount_total', 'amount_residual'] : ['amount_total']),
      chatter: true,
    },
  },
};

export const INCOTERMS_2020 = [
  ['EXW', 'Ex Works'],
  ['FCA', 'Free Carrier'],
  ['FAS', 'Free Alongside Ship'],
  ['FOB', 'Free On Board'],
  ['CFR', 'Cost and Freight'],
  ['CIF', 'Cost, Insurance and Freight'],
  ['CPT', 'Carriage Paid To'],
  ['CIP', 'Carriage and Insurance Paid To'],
  ['DAP', 'Delivered at Place'],
  ['DPU', 'Delivered at Place Unloaded'],
  ['DDP', 'Delivered Duty Paid'],
];

Object.assign(accountingModels, {
  'account.incoterm': {
    label: 'Incoterms',
    fields: {
      name: { type: 'char', label: 'Name', required: true },
      code: { type: 'char', label: 'Code', required: true },
      active: { type: 'boolean', label: 'Active' },
      display_name: { type: 'char', label: 'Display Name', compute: (r) => (r.code && r.name ? `${r.code} - ${r.name}` : r.code || r.name || '') },
    },
    defaults: () => ({ active: true }),
    list: ['code', 'name', 'active'],
    form: {
      title: 'code',
      groups: [['code', 'name'], ['active']],
    },
  },

  'account.tax.unit': {
    label: 'Tax Units',
    fields: {
      name: { type: 'char', label: 'Name', required: true },
      country: { type: 'char', label: 'Country' },
      vat: { type: 'char', label: 'Tax ID' },
      company_ids: { type: 'many2many', relation: 'res.company', label: 'Companies', required: true },
      main_company_id: { type: 'many2one', relation: 'res.company', label: 'Main Company', required: true },
    },
    defaults: () => ({ company_ids: [] }),
    guard: (db, before, after) => {
      const companies = Array.isArray(after.company_ids) ? after.company_ids : [];
      if (new Set(companies).size < 2) return 'A tax unit must contain at least 2 companies';
      if (!after.main_company_id || !companies.includes(after.main_company_id)) return 'The main company must be one of the tax unit companies';
      if (companies.some((id) => !read(db, 'res.company', id))) return 'Select existing companies';
      return null;
    },
    list: ['name', 'country', 'vat', 'main_company_id'],
    form: {
      title: 'name',
      groups: [['name', 'country', 'vat'], ['main_company_id', 'company_ids']],
    },
  },

  'account.account.tag': {
    label: 'Account Tags',
    guard: (db, before, after) => before && before.applicability !== after.applicability && ['account.account', 'account.tax'].some((model) => (db.records[model] ?? []).some((r) => (r.tag_ids ?? []).includes(after.id))) ? 'A tag in use cannot change applicability' : null,
    fields: {
      name: { type: 'char', label: 'Tag Name', required: true },
      applicability: {
        type: 'selection',
        label: 'Applicability',
        required: true,
        options: [
          ['accounts', 'Accounts'],
          ['taxes', 'Taxes'],
          ['products', 'Products'],
        ],
      },
      color: { type: 'integer', label: 'Color' },
      cash_flow_activity: { type: 'selection', label: 'Cash Flow Activity', options: [['operating', 'Operating'], ['investing', 'Investing'], ['financing', 'Financing']] },
      active: { type: 'boolean', label: 'Active' },
      country: { type: 'char', label: 'Country' },
      balance_negate: { type: 'boolean', label: 'Negate Balance' },
    },
    defaults: () => ({ applicability: 'accounts', active: true, balance_negate: false, color: 0 }),
    list: ['name', 'applicability', 'country', 'balance_negate', 'active'],
    form: {
      title: 'name',
      groups: [
        ['name', 'applicability', 'color'],
        ['country', 'balance_negate', 'cash_flow_activity', 'active'],
      ],
    },
  },

  'account.asset.model': {
    label: 'Depreciation Models',
    fields: {
      name: { type: 'char', label: 'Model Name', required: true },
      method: {
        type: 'selection',
        label: 'Depreciation Method',
        required: true,
        options: [
          ['linear', 'Linear'],
          ['degressive', 'Degressive'],
          ['degressive_then_linear', 'Degressive Then Linear'],
        ],
      },
      method_number: { type: 'integer', label: 'Number of Depreciations', required: true },
      method_period: {
        type: 'selection',
        label: 'Period Length',
        required: true,
        options: [
          ['1', 'Monthly'],
          ['12', 'Yearly'],
        ],
      },
      method_progress_factor: { type: 'float', label: 'Degressive Factor' },
      prorata: { type: 'boolean', label: 'Prorata Temporis' },
      account_asset_id: { type: 'many2one', relation: 'account.account', label: 'Asset Account' },
      account_depreciation_id: { type: 'many2one', relation: 'account.account', label: 'Depreciation Account' },
      account_expense_id: { type: 'many2one', relation: 'account.account', label: 'Expense Account' },
      journal_id: { type: 'many2one', relation: 'account.journal', label: 'Journal' },
      analytic_distribution: { type: 'distribution', label: 'Analytic Distribution' },
    },
    defaults: () => ({ method: 'linear', method_number: 5, method_period: '12', method_progress_factor: 0.3, prorata: false }),
    list: ['name', 'method', 'method_number', 'method_period', 'account_asset_id', 'account_depreciation_id', 'account_expense_id'],
    form: {
      title: 'name',
      groups: [
        ['name', 'journal_id', 'account_asset_id', 'account_depreciation_id', 'account_expense_id'],
        ['method', 'method_number', 'method_period', 'method_progress_factor', 'prorata', 'analytic_distribution'],
      ],
    },
  },

  'account.secure.entries.wizard': {
    label: 'Secure Entries',
    fields: {
      company: { type: 'many2one', relation: 'res.company', label: 'Company', required: true },
      hash_date: { type: 'date', label: 'Secure entries up to', required: true },
      max_hash_date: { type: 'date', label: 'Max Hash Date', readonly: true },
      warnings: { type: 'text', label: 'Warnings', readonly: true },
      entries_count: { type: 'integer', label: 'Number of Entries to Secure', readonly: true },
      move_to_hash_ids: { type: 'many2many', relation: 'account.move', label: 'Entries to Secure', readonly: true },
      not_hashable_unlocked_move_ids: { type: 'many2many', relation: 'account.move', label: 'Draft Entries', readonly: true, openDirect: true },
      chains_to_hash_with_gaps: { type: 'char', label: 'Chains with Gaps', readonly: true },
    },
    onchange: (r, key, db) => {
      if (['hash_date', 'company'].includes(key)) {
        const analysis = analyzeJournalChains(db, { companyId: r.company, hashDate: r.hash_date });
        return {
          warnings: analysis.warnings,
          entries_count: analysis.entries_count,
          move_to_hash_ids: analysis.move_to_hash_ids,
          not_hashable_unlocked_move_ids: analysis.not_hashable_unlocked_move_ids,
          chains_to_hash_with_gaps: analysis.chains_to_hash_with_gaps,
          max_hash_date: analysis.max_hash_date,
        };
      }
      return {};
    },
    createDefaults: (db, vals) => {
      const analysis = analyzeJournalChains(db, { companyId: vals?.company, hashDate: vals?.hash_date });
      return {
        company: vals?.company ?? analysis.company,
        hash_date: vals?.hash_date ?? analysis.hash_date,
        max_hash_date: analysis.max_hash_date,
        warnings: analysis.warnings,
        entries_count: analysis.entries_count,
        move_to_hash_ids: analysis.move_to_hash_ids,
        not_hashable_unlocked_move_ids: analysis.not_hashable_unlocked_move_ids,
        chains_to_hash_with_gaps: analysis.chains_to_hash_with_gaps,
      };
    },
    defaults: () => ({ move_to_hash_ids: [], not_hashable_unlocked_move_ids: [] }),
    list: ['company', 'hash_date', 'max_hash_date', 'chains_to_hash_with_gaps'],
    form: {
      title: 'Secure Entries',
      buttons: [
        {
          label: 'Confirm',
          primary: true,
          when: (r, db) => !analyzeJournalChains(db, { companyId: r.company, hashDate: r.hash_date }).not_hashable_unlocked_move_ids?.length,
          run: (db, r) => {
            const analysis = analyzeJournalChains(db, { companyId: r.company, hashDate: r.hash_date });
            if (analysis.not_hashable_unlocked_move_ids?.length) {
              throw new Error(t('Cannot secure entries while draft entries exist on or before the secured date'));
            }
            const count = analysis.entries_count;
            return { db: secureEntries(db, { companyId: r.company, hashDate: r.hash_date }), ...(count ? { go: '#/accounting/entries' } : { message: t('No entries were secured; the hard lock date was not changed.') }) };
          },
        },
        { label: 'Cancel', run: (db) => ({ db, go: '#/accounting/entries' }) },
      ],
      groups: [['company', 'hash_date', 'max_hash_date', 'entries_count'], ['chains_to_hash_with_gaps', 'warnings']],
      tabs: [
        { label: 'Entries to Secure', fields: ['move_to_hash_ids'] },
        { label: 'Draft Entries', fields: ['not_hashable_unlocked_move_ids'] },
      ],
    },
  },
});
