import { create, postNote, read, search, unlink, write } from '../orm.js';
import { addDays, amounts, companyRoundingMethod, invoiceTaxAmount, monthFilters, nextName, productLines, promptedAmount, sameCommercialPartner, shiftMonth, today, total, validDate } from './common.js';
import { ACCOUNT_TYPES, accountBalance, analyticEligibleAccount, badLineSign, historicalOriginAccounts, invoiceCounterpartAccount, invoiceLineAccount, invoiceLines, isBalanced, isLiquidityJournal, isPaymentMatched, outstandingAccount, paymentJournal, paymentName, postEntry, postedBillLine, reconciledJournalItems, resolveDocumentJournal } from './ledger.js';
import { currentActor, employeeFor } from './authority.js';
import { bookedByBank, creditNotePairError, creditWarning, duplicateBillWarning, accountDeleteGuard, lockedSettlementInvariant, fxProvenanceError, moveDate, moveDeleteGuard, moveGuard, moveInvariant, recordLockDate, taxUnitMemberTypeValidation } from './finance.js';
import { applyPaymentCredit, reverseEntry, SETTLES } from './pay.js';
import { conversionRate, rateAt, toCompany } from './currency.js';
import { bookedStatementAmount } from './bank.js';
import { cashRoundingApplies, cashRoundingError, configuredAccount } from './configured-account.js';
import { accountTax, cashBasisTransitionAccount, cashBasisGroups, fiscalPositionFor, isLegacyCashBasisRelease, isSectionOrNote, mapAccount, productTax, replaceTaxSnapshot, validateTaxCompany } from './taxes.js';
import { discountTaxComputation, dueDate, earlyDiscount } from './terms.js';
import { downPaymentOvercommitted, refreshAdvanceDeductions, syncInvoicedQty } from './sales.js';
import { checkMandatoryPlans, defaultDistributionForLine, distributionOfLine, findAnalyticDistribution, normalizeDistribution, postAnalytic, removeAnalytic } from './analyticplus.js';
import { checkBillMatch, priceDifferenceLines, shouldBePaid } from './billcontrol.js';
import { companyCurrencyRecord, documentCurrency, findCompanyCurrencyRecord, roundCurrency, round as round2 } from '../money.js';
import { settlementCompanyAmount } from './settlement.js';
import { analyzeJournalChains, secureEntries, secureMoveInvariant, secureHeadsGuard, postedBeforeSecuredChain, SECURED_ORDER_ERROR } from './hash_chain.js';
import { t } from '../i18n.js';
import { adjustInvoiceDeferralsForCreditNote, createInvoiceDeferrals, deferralLinksMove, reverseInvoiceDeferrals, revertInvoiceDeferralCreditAdjustment, validateInvoiceDeferralCredit } from './deferred.js';
import { resolveAndValidateRecipientBank } from './partnerbank.js';
import { exchangeAccount } from './exchange-account.js';
import { ASSET_DEPRECIATION_DEFAULTS, assetAccountGuard } from './assets.js';
import { productProperty } from './productconfig-helpers.js';
import { recipientBankCompanyError } from './company.js';
import { openActivitiesText } from './mail.js';

export { invoiceTaxAmount, isLegacyCashBasisRelease, total, applyPaymentCredit };

function accountTypeGuard(db, before, after) {
  if (before && before.account_type !== after.account_type
    && (db.records['account.move'] ?? []).some((move) => move.state === 'posted'
      && (move.line_ids ?? []).some((line) => line.account_id === before.id))) {
    return 'An account type cannot change after journal items have been posted to it';
  }
  return null;
}

function accountCodeGuard(db, before, after) {
  const codeOrCompanyChanged = !before || before.code !== after.code || (before.company_id ?? null) !== (after.company_id ?? null);
  if (codeOrCompanyChanged && (db.records['account.account'] ?? []).some((account) => account.id !== after.id
    && account.code === after.code && (account.company_id ?? null) === (after.company_id ?? null))) {
    return `Account code ${after.code} is already used for this company`;
  }
  return null;
}

const accountLineCounts = (lines = []) => {
  const counts = new Map();
  for (const line of lines) {
    if (!line?.account_id || isSectionOrNote(line)) continue;
    counts.set(line.account_id, (counts.get(line.account_id) ?? 0) + 1);
  }
  return counts;
};

function archivedLineAccountGuard(db, before, after, ctx = {}) {
  const allowedArchived = ctx?.archivedOriginIds?.length
    ? historicalOriginAccounts(db, ctx.archivedOriginIds, { includeCashBasisTargets: Boolean(ctx.includeCashBasisTargets) })
    : null;
  const isAllowedArchived = (accId) => Boolean(allowedArchived?.has(accId));
  const invCounts = accountLineCounts(before?.invoice_line_ids);
  for (const [accId, count] of accountLineCounts(after.invoice_line_ids)) {
    if (count > (invCounts.get(accId) ?? 0) && read(db, 'account.account', accId)?.active === false && !isAllowedArchived(accId)) {
      return 'Archived accounts cannot be selected on journal items or invoice lines';
    }
  }
  // Posting a draft invoice materializes its journal items from invoice_line_ids.
  const postingDraftInvoice = isInvoice(after) && before?.state === 'draft' && after.state === 'posted';
  const beforeLineCounts = accountLineCounts(before?.line_ids);
  for (const [accId, count] of accountLineCounts(after.line_ids)) {
    const allowed = postingDraftInvoice ? Math.max(beforeLineCounts.get(accId) ?? 0, invCounts.get(accId) ?? 0) : (beforeLineCounts.get(accId) ?? 0);
    if (count > allowed && read(db, 'account.account', accId)?.active === false && !isAllowedArchived(accId)) {
      return 'Archived accounts cannot be selected on journal items or invoice lines';
    }
  }
  return null;
}

/**
 * Odoo gives sale and purchase journals their own credit note sequence ("R" + the invoice prefix);
 * any journal given a distinct refund prefix uses it too.
 */
function derivedRefundSequence(j) {
  const own = ['sale', 'purchase'].includes(j.type) && j.invoice_sequence_prefix && !j.refund_sequence_prefix;
  if (own) return { refund_sequence: true, refund_sequence_prefix: `R${j.invoice_sequence_prefix}`, refund_sequence_next_number: j.refund_sequence_next_number ?? 1 };
  return j.refund_sequence_prefix && j.refund_sequence_prefix !== j.invoice_sequence_prefix ? { refund_sequence: true } : {};
}

function journalSequenceGuard(db, before, after) {
  const useRefund = Boolean(after.refund_sequence);
  const sequences = [
    ['invoice_sequence_prefix', 'invoice_sequence_next_number'],
    ...(useRefund ? [['refund_sequence_prefix', 'refund_sequence_next_number']] : []),
  ];
  const allPrefixes = sequences.map(([prefixField]) => after[prefixField]);
  if (allPrefixes.some((prefix) => prefix != null && (!String(prefix).trim() || String(prefix).trim() !== prefix))) {
    return 'Invoice sequence prefixes cannot be empty or start or end with spaces';
  }
  const prefixes = allPrefixes.filter((prefix) => prefix != null && String(prefix).trim() !== '');
  for (const [prefixField, numberField] of sequences) {
    const prefix = after[prefixField];
    const nextNumber = after[numberField];
    if (nextNumber != null && (!Number.isSafeInteger(Number(nextNumber)) || Number(nextNumber) < 1)) {
      return 'Journal sequence next numbers must be positive integers';
    }
    if (nextNumber != null && (!prefix || !String(prefix).trim())) {
      return 'Configure a sequence prefix before its next number';
    }
    if (before?.[numberField] != null && nextNumber != null && Number(nextNumber) < Number(before[numberField])) {
      return 'Journal sequence next numbers cannot move backwards';
    }
    const sequenceUsed = before && (db.records['account.move'] ?? []).some((move) => move.state === 'posted'
      && move.journal_id === before.id && move.move_type != null && move.move_type !== 'entry'
      && (prefixField === 'refund_sequence_prefix') === (isRefund(move) && Boolean(before.refund_sequence)));
    if (sequenceUsed && before[prefixField] !== prefix) {
      return 'A journal sequence prefix cannot change after a document is posted in that sequence';
    }
    if (sequenceUsed && (nextNumber == null || Number(nextNumber) < Number(before[numberField]))) {
      return 'A used journal sequence next number cannot be removed or moved backwards';
    }
  }
  if (new Set(prefixes).size !== prefixes.length) return 'Invoice and refund sequence prefixes must be different';
  const configured = new Set(prefixes);
  const duplicates = (db.records['account.journal'] ?? []).some((journal) => journal.id !== before?.id
    && [journal.invoice_sequence_prefix, ...(journal.refund_sequence ? [journal.refund_sequence_prefix] : [])].some((prefix) => configured.has(prefix)));
  return duplicates ? 'Each journal sequence prefix must be unique' : null;
}

/** Resolve the sequence prefix and next number field to use for posting an invoice or credit note. */
export function journalInvoiceSequence(journal, move) {
  const refund = isRefund(move) && Boolean(journal.refund_sequence);
  const prefixField = refund ? 'refund_sequence_prefix' : 'invoice_sequence_prefix';
  const numberField = refund ? 'refund_sequence_next_number' : 'invoice_sequence_next_number';
  const prefix = journal[prefixField];
  const nextNumber = Number(journal[numberField]);
  if (!prefix || !String(prefix).trim()) {
    throw new Error(`Configure the ${refund ? 'refund' : 'invoice'} sequence prefix on the selected journal`);
  }
  if (!Number.isSafeInteger(nextNumber) || nextNumber < 1) {
    throw new Error(`Configure a positive next ${refund ? 'refund' : 'invoice'} sequence number on the selected journal`);
  }
  const year = (move.invoice_date ?? move.date ?? today()).slice(0, 4);
  return {
    name: `${prefix}${year}/${String(nextNumber).padStart(5, '0')}`,
    numberField,
    nextNumber,
  };
}

/** Compute MOD 97-10 check digits per ISO 11649 for an alphanumeric reference. */
function iso11649CheckDigits(alnum) {
  const rearranged = `${alnum}RF00`;
  let rem = 0;
  for (const ch of rearranged) {
    const digits = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of digits) rem = (rem * 10 + Number(d)) % 97;
  }
  return String(98 - rem).padStart(2, '0');
}

/** Compute invoice payment_reference on posting according to journal communication settings. */
export function computePaymentReference(db, move, journal, moveName) {
  if (!journal || journal.type !== 'sale') return null;
  const refType = journal.invoice_reference_type ?? 'invoice';
  if (refType === 'none') return null;
  const model = journal.invoice_reference_model ?? 'odoo';
  const partner = refType === 'partner' ? read(db, 'res.partner', move.partner_id) : null;
  const rawBase = refType === 'partner'
    ? ((partner?.ref && String(partner.ref).trim()) || String(partner?.id ?? move.partner_id ?? ''))
    : String(moveName ?? move.name ?? '');
  if (!rawBase) return null;
  if (model === 'number') {
    const digits = rawBase.replace(/\D/g, '');
    return digits || rawBase;
  }
  if (model === 'euro') {
    const alnum = rawBase.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    return alnum ? `RF${iso11649CheckDigits(alnum)}${alnum}` : null;
  }
  return rawBase;
}

const exchangeLines = (db, companyId, difference) => {
  if (!difference) return [];
  const account = exchangeAccount(db, companyId, difference);
  return difference > 0
    ? [{ account, credit: difference }]
    : [{ account, debit: -difference }];
};

export const isInvoice = (r) => Boolean(r && r.move_type !== 'entry');
const isRefund = (r) => ['out_refund', 'in_refund'].includes(r?.move_type);
export const isPurchase = (r) => ['in_invoice', 'in_refund'].includes(r?.move_type);
/** Money comes in for customer invoices and vendor refunds, goes out for bills and credit notes. */
export const isInbound = (r) => ['out_invoice', 'in_refund'].includes(r?.move_type);
export const residual = (r, db) => {
  if (!isInvoice(r)) return 0;
  let curr;
  try {
    curr = documentCurrency(db, r);
  } catch (err) {
    if (/configure.*currency/i.test(err?.message)) return null;
    throw err;
  }
  return db ? Math.max(0, roundCurrency(total(r, db) - (Number(r.amount_paid) || 0), curr)) : (r.amount_residual ?? round2(total(r) - (Number(r.amount_paid) || 0)));
};
const paymentState = (r, db) => {
  if (r.state !== 'posted' || !isInvoice(r)) return 'not_paid';
  const res = residual(r, db);
  // Without a resolvable currency the open amount is unknown; say so rather than guess paid or partial.
  if (res == null) return 'unavailable';
  if (res === 0) return 'paid';
  return (Number(r.amount_paid) || 0) > 0 ? 'partial' : 'not_paid';
};

/** Resolve the signed-in user's linked employee id from hr.employee.user_login, or null when unlinked. */
const currentUserId = (db) => (db ? employeeFor(db, currentActor()?.login)?.id ?? null : null);

/** Compute the unsigned untaxed subtotal in the document's own currency, or null if unconfigured. */
const untaxedAmount = (r, db) => {
  let curr;
  try {
    curr = documentCurrency(db, r);
  } catch (err) {
    if (/configure.*currency/i.test(err?.message)) return null;
    throw err;
  }
  return amounts(r.invoice_line_ids, curr, { roundingMethod: companyRoundingMethod(db, r?.company_id) }).untaxed;
};

/** Sign a document-currency amount: credit notes and vendor refunds show as negative, avoiding -0. */
const signedDocumentAmount = (r, value) => {
  if (value == null) return null;
  return value === 0 ? 0 : (isRefund(r) ? -1 : 1) * value;
};

/**
 * Compute Odoo 20 `status_in_payment` for an invoice, credit note, bill, or refund:
 * distinguishes `reversed` (settled solely by reversing credit notes), `in_payment` (settled via an outstanding
 * payment not yet matched to a bank statement), `blocked` (three-way matching exception), and `cancel`/`draft`.
 */
export const statusInPayment = (r, db) => {
  if (r.state === 'draft') return 'draft';
  if (r.state === 'cancel') return 'cancel';
  if (!isInvoice(r)) return r.state ?? 'draft';
  const payState = paymentState(r, db);
  if (payState === 'unavailable') return 'unavailable';
  if (payState === 'paid') {
    const active = (r.payments ?? []).filter((p) => !p.reversed);
    if (db && active.length) {
      const moveById = new Map((db.records['account.move'] ?? []).map((m) => [m.id, m]));
      const paymentByMove = new Map((db.records['account.payment'] ?? []).filter((p) => p.move_id).map((p) => [p.move_id, p]));
      const allReversals = active.every((p) => {
        const m = moveById.get(p.move_id);
        return m && isRefund(m) && m.reversed_entry_id === r.id;
      });
      if (allReversals) return 'reversed';
      const hasOutstanding = active.some((p) => {
        const payment = paymentByMove.get(p.payment_move_id ?? p.move_id);
        return payment && payment.state === 'posted' && payment.outstanding_account_id && !isPaymentMatched(db, payment);
      });
      if (hasOutstanding) return 'in_payment';
    }
    return 'paid';
  }
  if (db && shouldBePaid(db, r) === 'exception') return 'blocked';
  return payState;
};
const money = (n) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

/** Ids of the entries that settle invoices (payments, early-payment discounts, and reconciliation exchange entries). */
export const settlingEntries = (db) => {
  const moves = db.records['account.move'] ?? [];
  const fromPayments = moves.flatMap((m) => (m.payments ?? []).flatMap((p) => [p.move_id, p.payment_fx_move_id]));
  const fromFx = moves.filter((m) => m.move_type === 'entry' && m.fx_payment_move_id && m.fx_invoice_id).map((m) => m.id);
  return new Set([...fromPayments, ...fromFx].filter(Boolean));
};

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
    if (prior?.reversed && (!p.reversed || p.reversal_move_id !== prior.reversal_move_id || p.reversal_date !== prior.reversal_date || p.unapplied !== prior.unapplied)) return 'A reversed payment cannot be restored';
    if (prior && Object.keys({ ...prior, ...p }).some((k) => !['reversed', 'reversal_move_id', 'reversal_date', 'unapplied'].includes(k) && JSON.stringify(p[k]) !== JSON.stringify(prior[k]))) return 'A recorded payment cannot be changed';
    // An unapplied credit leaves its payment entry posted; it only needs the date the matching was removed.
    if (p.unapplied && (!p.reversed || p.reversal_move_id || !p.reversal_date || (p.date && p.reversal_date < p.date))) return 'An unapplied payment needs its unapplication date and no reversing entry';
    if (p.reversed && !p.unapplied) {
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
    const validSide = source?.move_type === 'entry' && (source.line_ids ?? []).some((l) => (l.partner_id === after.partner_id || sameCommercialPartner(db, l.partner_id, after.partner_id)) && ['asset_receivable', 'liability_payable'].includes(read(db, 'account.account', l.account_id)?.account_type));
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
const RECURRENCE_MONTHS = { monthly: 1, quarterly: 3, yearly: 12 };
const RECURRING_EXCLUDED_FIELDS = new Set([
  'id', 'name', 'ref', 'payment_reference', 'state', 'line_ids', 'payments', 'amount_paid', 'payment_date',
  'fx_payment_move_id', 'fx_invoice_id', 'reversed_entry_id', 'reversal_move_id', 'correction_of_id', 'debit_origin_id',
  'inalterable_hash', 'inalterable_hash_version', 'secure_sequence_number', 'auto_post_origin_id',
  'is_closing', 'is_tax_closing', 'is_tax_payment', 'tax_return_id', 'revaluation_date',
  'deferral_date', 'deferral_kind', 'is_deferred_grouped', 'deferred_contributions', 'force_post',
  'intercompany_move_id', // each occurrence gets its own counterpart bill (Qodo 6)
]);
function recurringReversalDate(origin, nextDate) {
  const start = origin.invoice_date ?? origin.date;
  const end = origin.reverse_date;
  if (!validDate(start) || !validDate(end) || end <= start) throw new Error('Reversal date must be after the accounting date');
  const days = (Date.parse(end) - Date.parse(start)) / 86400000;
  return addDays(nextDate, days);
}

function spawnRecurringMove(db, move) {
  const months = RECURRENCE_MONTHS[move.auto_post];
  if (!months) return db;
  const current = move.move_type === 'entry' && move.date ? move.date : move.invoice_date ?? move.date ?? today();
  if (!validDate(current)) throw new Error('Enter a valid date');
  if (move.auto_post_until && !validDate(move.auto_post_until)) throw new Error('Enter a valid recurring end date');
  const nextDate = shiftMonth(current, months);
  if (move.auto_post_until && nextDate > move.auto_post_until) return db;
  const origin = move.auto_post_origin_id ?? move.id;
  if ((db.records['account.move'] ?? []).some((m) => m.id !== move.id && (m.auto_post_origin_id ?? m.id) === origin && (m.invoice_date ?? m.date) === nextDate && m.state !== 'cancel')) return db;
  const term = move.invoice_payment_term_id && read(db, 'account.payment.term', move.invoice_payment_term_id);
  const nextDue = isInvoice(move) ? (term ? dueDate(term, nextDate) : move.invoice_date_due ? shiftMonth(move.invoice_date_due, months) : nextDate) : undefined;
  const raw = (db.records['account.move'] ?? []).find((m) => m.id === move.id) ?? move;
  const base = Object.fromEntries(Object.entries(raw).filter(([k]) => !RECURRING_EXCLUDED_FIELDS.has(k)));
  return create(db, 'account.move', {
    ...base,
    name: '/',
    state: 'draft',
    amount_paid: 0,
    payments: [],
    invoice_date: nextDate,
    date: nextDate,
    ...(nextDue ? { invoice_date_due: nextDue } : {}),
    ...(move.auto_reverse ? { reverse_date: recurringReversalDate(read(db, 'account.move', origin), nextDate) } : {}),
    auto_post_origin_id: origin,
    invoice_line_ids: isInvoice(move) ? copyInvoiceLines(raw.invoice_line_ids, { months, preserveSourceLineId: Boolean(move.reversed_entry_id) }) : [],
    line_ids: !isInvoice(move) ? (raw.line_ids ?? []).map((l) => ({
      ...l,
      ...(l.date_maturity ? { date_maturity: shiftMonth(l.date_maturity, months) } : {}),
    })) : [],
  }).db;
}

function attemptAutoPostMove(db, moveId, onError = null) {
  try {
    return postMove(db, moveId);
  } catch (e) {
    onError?.(`auto-post move ${moveId}`, e);
    const body = `Auto-post failed: ${e.message}`;
    return (db.messages ?? []).some((message) => message.model === 'account.move' && message.res_id === moveId && message.body === body)
      ? db
      : postNote(db, 'account.move', moveId, body);
  }
}

/** Auto-post draft entries scheduled on or before `at`, generating each next recurring entry once up to its end date. */
export function postAutoPostMoves(db, at = today(), { onError = null } = {}) {
  if (!validDate(at)) throw new Error('Enter a valid date');
  let next = db;
  const attempted = new Set();
  while (true) {
    const due = (next.records['account.move'] ?? [])
      .filter((m) => m.active !== false && m.state === 'draft' && m.auto_post && m.auto_post !== 'no' && !attempted.has(m.id))
      .map((m) => ({ move: m, date: m.move_type === 'entry' && m.date ? m.date : m.invoice_date ?? m.date ?? today() }))
      .filter(({ move, date }) => date <= at && (!move.auto_post_until || date <= move.auto_post_until))
      .sort((a, b) => a.date.localeCompare(b.date) || a.move.id - b.move.id);
    if (!due.length) break;
    for (const { move } of due) {
      attempted.add(move.id);
      next = attemptAutoPostMove(next, move.id, onError);
    }
  }
  return next;
}

export function intercompanyBill(db, move) {
  if (!['out_invoice', 'out_refund'].includes(move.move_type)) return null;
  const buyer = (db.records['res.company'] ?? []).find((c) => c.id !== (move.company_id ?? 1) && c.partner_id === move.partner_id && c.active !== false);
  const sale = move.sale_id && read(db, 'sale.order', move.sale_id);
  const purchase = sale?.auto_purchase_id && read(db, 'purchase.order', sale.auto_purchase_id);
  if (!buyer || !(buyer.intercompany_rule === 'invoice_bill' || (buyer.intercompany_rule === 'sale_purchase' && purchase?.auto_sale_id === sale.id && purchase.company_id === buyer.id))) return null;
  if (move.intercompany_move_id && read(db, 'account.move', move.intercompany_move_id)?.state !== 'cancel') return null;
  const seller = read(db, 'res.company', move.company_id ?? 1);
  if (!seller?.partner_id) throw new Error('Configure the selling company contact');
  const journal = read(db, 'account.journal', buyer.intercompany_journal_id);
  if (!journal || journal.type !== 'purchase' || journal.company_id !== buyer.id) throw new Error(`Configure the inter-company purchase journal for ${buyer.name}`);
  const payable = read(db, 'account.account', buyer.account_default_payable_id);
  if (!payable || payable.company_id !== buyer.id || payable.account_type !== 'liability_payable') throw new Error(`Configure the default payable account for ${buyer.name}`);
  const fpId = fiscalPositionFor(db, seller.partner_id, buyer.id);
  const invoice_line_ids = (move.invoice_line_ids ?? []).map((line) => {
    if (isSectionOrNote(line)) return line;
    const product = line.product_id ? read(db, 'product', line.product_id) : null;
    if (!product) throw new Error(`Configure a product for line "${line.name || 'unnamed'}"`);
    // Product accounts are shared across companies, so one that belongs to another company falls through to the buyer's category.
    const ownAccount = read(db, 'account.account', product.property_account_expense_id);
    const source = ownAccount?.company_id && ownAccount.company_id !== buyer.id ? { ...product, property_account_expense_id: null } : product;
    const rawAccount = read(db, 'account.account', productProperty(db, source, 'property_account_expense_id', buyer.id));
    if (!rawAccount || (rawAccount.company_id && rawAccount.company_id !== buyer.id)) throw new Error(`Configure an expense account for ${product.name}`);
    const mappedAccountId = mapAccount(db, fpId, rawAccount.id);
    const account = read(db, 'account.account', mappedAccountId);
    if (!account || (account.company_id && account.company_id !== buyer.id)) {
      throw new Error(`Configure an expense account for ${product.name}`);
    }
    let tax;
    try {
      tax = productTax(db, product, 'purchase', fpId, buyer.id);
      if (tax?.tax_id) validateTaxCompany(db, [tax.tax_id, ...(tax.tax_ids ?? [])], buyer.id);
    } catch {
      throw new Error(`Configure purchase taxes for ${buyer.name} on ${product.name}`);
    }
    return { name: line.name, product_id: line.product_id, qty: line.qty, price_unit: line.price_unit, discount: line.discount, account_id: account.id, ...(tax ?? { tax: 0 }) };
  });
  const original = move.move_type === 'out_refund' && move.reversed_entry_id ? read(db, 'account.move', move.reversed_entry_id) : null;
  const originalBill = original?.intercompany_move_id && read(db, 'account.move', original.intercompany_move_id);
  if (originalBill && (originalBill.move_type !== 'in_invoice' || originalBill.company_id !== buyer.id || originalBill.intercompany_move_id !== original.id)) {
    throw new Error('The original inter-company bill link is invalid');
  }
  return { company_id: buyer.id, move_type: move.move_type === 'out_invoice' ? 'in_invoice' : 'in_refund', partner_id: seller.partner_id, journal_id: journal.id, invoice_date: move.invoice_date, currency_id: move.currency_id, invoice_line_ids, intercompany_move_id: move.id, ...(originalBill ? { reversed_entry_id: originalBill.id } : {}) };
}

const newInvoiceLineId = () => {
  if (typeof globalThis.crypto?.randomUUID !== 'function') throw new Error('Secure ID generation is required to identify invoice lines');
  return globalThis.crypto.randomUUID();
};

/** Give each embedded invoice line a stable unique identity without deriving it from its content or position. */
export function ensureInvoiceLineIds(db, move, reservedIds = null) {
  const used = reservedIds ?? new Set((db.records['account.move'] ?? [])
    .filter((record) => record.id !== move.id)
    .flatMap((record) => record.invoice_line_ids ?? [])
    .map((line) => line.line_id)
    .filter((lineId) => lineId != null && lineId !== '')
    .map(String));
  const seen = new Set();
  const lines = (move.invoice_line_ids ?? []).map((line) => {
    let lineId = line.line_id == null || line.line_id === '' ? null : String(line.line_id);
    if (!lineId || used.has(lineId) || seen.has(lineId)) {
      do { lineId = newInvoiceLineId(); } while (used.has(lineId) || seen.has(lineId));
    }
    seen.add(lineId);
    reservedIds?.add(lineId);
    return line.line_id === lineId ? line : { ...line, line_id: lineId };
  });
  return lines;
}

function storeInvoiceLineIds(db, move) {
  const invoiceLineIds = ensureInvoiceLineIds(db, move);
  if ((move.invoice_line_ids ?? []).every((line, index) => line === invoiceLineIds[index])) return { db, move };
  const nextMove = { ...move, invoice_line_ids: invoiceLineIds };
  const moves = (db.records['account.move'] ?? []).map((record) => record.id === move.id ? nextMove : record);
  return { db: { ...db, records: { ...db.records, 'account.move': moves } }, move: nextMove };
}

/** Copy invoice lines as new records, optionally linking each one to its source line. */
function copyInvoiceLines(lines, { sourceCredit = false, preserveSourceLineId = false, months = null } = {}) {
  return (lines ?? []).map((line) => {
    const sourceLineId = line.line_id;
    if (sourceCredit && (sourceLineId == null || sourceLineId === '')) {
      throw new Error('The source invoice line is missing its stable ID; update the database before creating a credit note');
    }
    const { line_id: ignoredLineId, source_line_id: ignoredSourceLineId, ...copy } = line;
    void ignoredLineId;
    void ignoredSourceLineId;
    return {
      ...copy,
      line_id: newInvoiceLineId(),
      ...(sourceCredit ? { source_line_id: String(sourceLineId) } : {}),
      ...(!sourceCredit && preserveSourceLineId && line.source_line_id ? { source_line_id: line.source_line_id } : {}),
      ...(months != null && line.deferred_start_date ? { deferred_start_date: shiftMonth(line.deferred_start_date, months) } : {}),
      ...(months != null && line.deferred_end_date ? { deferred_end_date: shiftMonth(line.deferred_end_date, months) } : {}),
    };
  });
}

/** Generate balanced journal lines and resolve analytic distributions for a posted invoice or vendor bill. */
export function postedInvoiceLines(db, move, name = move.name) {
  const journalRecord = resolveDocumentJournal(db, move, { required: true });
  const journal = journalRecord.id;
  const postingMove = { ...move, journal_id: journal };
  const resolvedLines = (move.invoice_line_ids ?? []).map((line) => {
    if (line.analytic_distribution && Object.keys(line.analytic_distribution).length > 0) return line;
    const dist = distributionOfLine(line, db, postingMove);
    return Object.keys(dist).length ? { ...line, analytic_distribution: dist } : line;
  });
  const updatedR = { ...move, journal_id: journal, invoice_line_ids: resolvedLines };
  let line_ids = [...invoiceLines(db, { ...updatedR, name }), ...priceDifferenceLines(db, { ...updatedR, name })];
  if (line_ids.some((line) => {
    const account = read(db, 'account.account', line.account_id);
    return account?.company_id && account.company_id !== (move.company_id ?? 1);
  })) throw new Error('Journal account belongs to another company');
  line_ids = line_ids.map((line) => ['asset_receivable', 'liability_payable'].includes(read(db, 'account.account', line.account_id)?.account_type)
    ? { ...line, name } : line);
  return { line_ids, resolvedLines, journalRecord, journal };
}

/** Post a draft move: invoices get their journal items generated; manual entries must balance. */
export function postMove(db, id) {
  let r = read(db, 'account.move', id);
  const bankError = recipientBankCompanyError(db, r);
  if (bankError) throw new Error(bankError);
  const order = r.move_type === 'out_invoice' && r.sale_id && !r.correction_of_id && read(db, 'sale.order', r.sale_id);
  if (order && (r.invoice_line_ids ?? []).some((l) => !l.down_payment_key)
    && !(r.invoice_line_ids ?? []).some((l) => l.down_payment_key && Number(l.qty) > 0)) {
    r = { ...r, invoice_line_ids: refreshAdvanceDeductions(db, order, r.invoice_line_ids, id) };
  }
  if (isInvoice(r)) r = { ...r, invoice_line_ids: ensureInvoiceLineIds(db, r) };
  validateInvoiceDeferralCredit(db, r);
  const enteredName = r.name && r.name !== '/' ? r.name : null;
  const journalRecord = resolveDocumentJournal(db, r, { required: true });
  const journal = journalRecord.id;
  if (!isInvoice(r)) {
  if (journalRecord.company_id && journalRecord.company_id !== (r.company_id ?? 1)) throw new Error('Journal belongs to another company');
  if (!journalRecord.code?.trim()) throw new Error('Set a short code on the journal');
    const year = (r.invoice_date ?? r.date ?? today()).slice(0, 4);
    const name = enteredName ?? nextName(db, 'account.move', `${journalRecord.code}/${year}/`);
    if (postedBeforeSecuredChain(db, { ...r, state: 'posted', name, journal_id: journal }, r)) throw new Error(SECURED_ORDER_ERROR);
    if ((r.line_ids ?? []).some((line) => {
      const account = read(db, 'account.account', line.account_id);
      return account?.company_id && account.company_id !== (r.company_id ?? 1);
    })) throw new Error('Journal account belongs to another company');
    if (badLineSign(r.line_ids)) throw new Error('Debits and credits cannot be negative');
    if (!isBalanced(r.line_ids, companyCurrencyRecord(db, r.company_id))) throw new Error('Journal entry is not balanced: total debit must equal total credit');
    const entryDate = r.invoice_date ?? r.date ?? today();
    if (r.auto_reverse) {
      const revDate = r.reverse_date;
      if (!validDate(revDate) || revDate <= entryDate) {
        throw new Error('Reversal date must be after the accounting date');
      }
      if (r.reverse_journal_id) {
        const revJournal = read(db, 'account.journal', r.reverse_journal_id);
        if (!revJournal) throw new Error('Selected journal does not exist');
        if (revJournal.company_id && revJournal.company_id !== (r.company_id ?? 1)) throw new Error('Journal belongs to another company');
      }
    }
    const line_ids = (r.line_ids ?? []).map((line) => {
      const eligible = analyticEligibleAccount(read(db, 'account.account', line.account_id));
      const distribution = line.analytic_distribution ?? (line.analytic_account_id ? { [line.analytic_account_id]: 100 } : eligible ? findAnalyticDistribution(db, {
        partner_id: line.partner_id ?? r.partner_id, product_id: line.product_id, account_id: line.account_id, company_id: r.company_id ?? 1,
      }) : null);
      if (distribution == null || (!Object.hasOwn(line, 'analytic_distribution') && !Object.keys(distribution).length)) return line;
      return { ...line, analytic_distribution: normalizeDistribution(distribution, db) };
    });
    checkMandatoryPlans(db, { ...r, line_ids });
    const posted = postAnalytic(write(db, 'account.move', id, { state: 'posted', name, journal_id: journal, line_ids }), id);
    const reversed = r.auto_reverse ? reverseEntry(posted, read(posted, 'account.move', id), r.reverse_date, { journal_id: r.reverse_journal_id ?? r.journal_id, scheduled: r.reverse_date > today() }).db : posted;
    return spawnRecurringMove(reversed, read(reversed, 'account.move', id));
  }
  if (!r.partner_id) throw new Error('Partner is required');
  if (!(r.invoice_line_ids ?? []).length) throw new Error('Add at least one invoice line');
  if (!validInvoiceTotal(r, db)) throw new Error('The total must be positive; use a credit note or refund instead');
  if (isRefund(r) && r.reversed_entry_id) creditCheck(db, r);
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
  if (r.invoice_payment_term_id) {
    const term = read(db, 'account.payment.term', r.invoice_payment_term_id);
    if (term?.company_id && term.company_id !== (r.company_id ?? 1)) throw new Error('Payment terms belong to another company');
  }
  for (const line of r.invoice_line_ids ?? []) {
    if (isSectionOrNote(line)) continue;
    validateTaxCompany(db, [line.tax_source_id], r.company_id ?? 1);
    validateTaxCompany(db, [line.tax_id, ...(line.tax_ids ?? []), ...(line.tax_breakdown ?? []).map((tax) => tax.tax_id)], r.company_id ?? 1);
  }
  checkMandatoryPlans(db, r);
  // Vendor bills are matched against the PO and receipts; price differences leave the interim account.
  const matchWarnings = checkBillMatch(db, r);
  const sequence = journalInvoiceSequence(journalRecord, r);
  const name = enteredName ?? sequence.name;
  if (postedBeforeSecuredChain(db, { ...r, state: 'posted', name, journal_id: journal }, r)) throw new Error(SECURED_ORDER_ERROR);
  if (isRefund(r) && r.reversed_entry_id) creditCheck(db, r);
  const counterpart = intercompanyBill(db, r);
  const { line_ids, resolvedLines } = postedInvoiceLines(db, { ...r, journal_id: journal }, name);
  const dueUpdate = r.invoice_payment_term_id ? termDue(db, { ...r, invoice_date: r.invoice_date ?? today() }) : {};
  const originIds = [r.reversed_entry_id, r.debit_origin_id, r.correction_of_id].filter(Boolean);
  const paymentReferenceUpdate = !r.payment_reference?.trim() && r.move_type === 'out_invoice' && journalRecord.type === 'sale'
    ? (() => {
        const ref = computePaymentReference(db, r, journalRecord, name);
        return ref ? { payment_reference: ref } : {};
      })()
    : {};
  let posted = postAnalytic(write(db, 'account.move', id, { state: 'posted', name, journal_id: journal, ...paymentReferenceUpdate, ...dueUpdate, line_ids, invoice_line_ids: resolvedLines }, originIds.length ? { archivedOriginIds: originIds } : {}), id);
  if (counterpart) {
    const bill = create(posted, 'account.move', counterpart);
    posted = write(bill.db, 'account.move', id, { intercompany_move_id: bill.id });
  }
  if (matchWarnings.length) posted = postNote(posted, 'account.move', id, `Purchase price mismatch: ${matchWarnings.map((line) => `${read(db, 'product', line.product_id)?.name ?? 'Unknown product'}, difference ${line.priceDifference}`).join('; ')}`);
  posted = write(posted, 'account.journal', journal, { [sequence.numberField]: sequence.nextNumber + 1 });
  const deferred = createInvoiceDeferrals(posted, read(posted, 'account.move', id));
  if (isRefund(r) && r.reversed_entry_id) {
    const adjusted = adjustInvoiceDeferralsForCreditNote(deferred, read(deferred, 'account.move', id), reverseEntry);
    return spawnRecurringMove(offsetCreditNote(adjusted, id), read(adjusted, 'account.move', id));
  }
  const withAssets = r.move_type === 'in_invoice' ? draftAssetsFromBill(deferred, read(deferred, 'account.move', id)) : deferred;
  return spawnRecurringMove(withAssets, read(withAssets, 'account.move', id));
}

/** Reverse an asset depreciation entry and make its board line available again. */
export function reverseDepreciation(db, move, options = {}) {
  const asset = (db.records['account.asset'] ?? []).find((a) => (a.depreciation_ids ?? []).some((line) => line.posted && line.move_id === move.id));
  if (!asset || move.state !== 'posted' || asset.disposal_date) throw new Error('Select an active posted depreciation entry');
  if ((db.records['account.move'] ?? []).some((m) => m.state === 'posted' && m.reversed_entry_id === move.id)) throw new Error('This depreciation has already been reversed');
  const opts = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  const revDate = opts.date ?? today();
  // A reversal cannot be booked before the depreciation it reverses (Qodo 52).
  if (!validDate(revDate) || revDate < (move.date ?? move.invoice_date)) throw new Error('The reversal date cannot be before the depreciation entry date');
  const revJournal = opts.journal_id ?? move.journal_id;
  const reason = String(opts.reason ?? '').trim();
  const ref = reason ? `Reversal of ${move.name}, ${reason}` : `Reversal of ${move.name}`;
  const reversed = postEntry(db, { journal: revJournal, company: move.company_id ?? 1, date: revDate, ref, archivedOriginIds: [move.id], lines: move.line_ids.map((l) => ({ account: l.account_id, debit: l.credit, credit: l.debit, partner_id: l.partner_id, analytic_distribution: l.analytic_distribution })) });
  const linked = postAnalytic(write(reversed.db, 'account.move', reversed.id, { reversed_entry_id: move.id }), reversed.id);
  return write(linked, 'account.asset', asset.id, { state: 'open', depreciation_ids: asset.depreciation_ids.map((l) => l.move_id === move.id ? { ...l, posted: false, move_id: null } : l) });
}

/** Issued credit notes of an invoice, other than `exceptId`; drafts do not consume credit. */
const creditNotesOf = (db, invoiceId, exceptId = null) => (db.records['account.move'] ?? [])
  .filter((m) => m.reversed_entry_id === invoiceId && m.id !== exceptId && m.state === 'posted');

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

/** Apply an open credit note (reversed_entry_id-linked or standalone) against an open invoice or bill. */
export function applyCreditNote(db, noteId, invoiceId, date = null, amount = null) {
  const note = read(db, 'account.move', noteId);
  const invoice = read(db, 'account.move', invoiceId);
  const pairError = creditNotePairError(db, note, invoice);
  if (pairError) throw new Error(pairError);
  if (amount != null && (!Number.isFinite(Number(amount)) || Number(amount) <= 0)) throw new Error('The applied amount must be a positive number');
  const appDate = date ?? note.invoice_date ?? today();
  if (!validDate(appDate)) throw new Error('Enter a valid reconciliation date');
  if (appDate < (invoice.invoice_date ?? '') || appDate < (note.invoice_date ?? '')) {
    throw new Error('Reconciliation date cannot be before the invoice or credit note date');
  }
  const invResidual = residual(invoice, db);
  const noteResidual = residual(note, db);
  const available = Math.min(noteResidual, invResidual);
  if (!(available > 0)) throw new Error('The invoice or credit note has no remaining open balance');
  const currency = documentCurrency(db, invoice);
  const value = roundCurrency(amount != null ? Math.min(Number(amount), available) : available, currency);
  if (!(value > 0)) return db;
  const invoicePortion = settlementCompanyAmount(db, invoice, value);
  const notePortion = settlementCompanyAmount(db, note, value);
  const invRelease = releaseCashBasis(db, invoice, value / total(invoice, db), appDate, { final: value >= invResidual });
  const noteRelease = releaseCashBasis(invRelease.db, note, value / total(note, invRelease.db), appDate, { final: value >= noteResidual });
  const settle = (next, r, other, cashBasisMoveId) => write(next, 'account.move', r.id, {
    amount_paid: roundCurrency((Number(r.amount_paid) || 0) + value, documentCurrency(next, r)), payment_date: appDate, payments: [...(r.payments ?? []), { date: appDate, amount: value, move_id: other.id, cash_basis_move_id: cashBasisMoveId }],
  });
  let next = settle(settle(noteRelease.db, invoice, note, invRelease.id), note, invoice, noteRelease.id);
  // Each document booked the amount at its own date's rate: the company-currency gap is an exchange difference.
  const sale = !isPurchase(invoice);
  const gap = roundCurrency(invoicePortion - notePortion, companyCurrencyRecord(db, invoice.company_id));
  if (gap) {
    const account = invoiceCounterpartAccount(db, invoice);
    const fxAmount = Math.abs(gap);
    // The receivable/payable balance left by the two rates is cleared against the exchange gain or loss.
    const clearsDebit = sale ? gap < 0 : gap > 0;
    const open = clearsDebit ? { account, debit: fxAmount, partner_id: invoice.partner_id } : { account, credit: fxAmount, partner_id: invoice.partner_id };
    const fxLines = exchangeLines(db, invoice.company_id, clearsDebit ? fxAmount : -fxAmount);
    const fx = postEntry(next, { journal: 'MISC', company: invoice.company_id ?? 1, date: appDate, ref: `Exchange difference ${note.name}`, lines: [open, ...fxLines], archivedOriginIds: [invoice.id, note.id] });
    next = { ...fx.db, records: { ...fx.db.records, 'account.move': fx.db.records['account.move'].map((entry) => entry.id === fx.id ? { ...entry, fx_payment_move_id: note.id, fx_invoice_id: invoice.id } : entry) } };
  }
  return postNote(next, 'account.move', invoice.id, `${money(value)} settled by credit note ${note.name}`);
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
  const noteDate = note.invoice_date ?? today();
  const settlementDate = invoice.invoice_date && invoice.invoice_date > noteDate ? invoice.invoice_date : noteDate;
  return applyCreditNote(db, noteId, invoice.id, settlementDate, value);
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
      account_asset_id: booked.account,
      ...(model ? {
        model_id: model.id,
        method: model.method ?? 'linear',
        method_number: model.method_number ?? 5,
        method_period: model.method_period ?? '12',
        method_progress_factor: model.method_progress_factor ?? 0.3,
        prorata: Boolean(model.prorata),
        account_depreciation_id: model.account_depreciation_id ?? null,
        account_depreciation_expense_id: model.account_depreciation_expense_id ?? null,
        journal_id: model.journal_id ?? null,
        analytic_distribution: model.analytic_distribution ?? null,
      } : {
        model_id: null,
        ...ASSET_DEPRECIATION_DEFAULTS,
        account_depreciation_id: null,
        account_depreciation_expense_id: null,
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
 * Currency metadata of a liquidity journal item in `currencyId` (the bank journal's currency, or the payment's when the
 * journal has none): `docAmount` when known in that currency, otherwise the signed company amount converted at `date`.
 */
export function liquidityForeignFields(db, { currencyId, companyAmount, docAmount = null, date, companyId }) {
  if (!currencyId || currencyId === companyCurrencyRecord(db, companyId)?.id) return {};
  const amount = docAmount ?? companyAmount * rateAt(db, currencyId, date, companyId);
  return { currency_id: currencyId, amount_currency: roundCurrency(amount, read(db, 'res.currency', currencyId)) };
}

/**
 * Record a payment: bank entry against receivable/payable, paid amount on the invoice, and a posted
 * payment record (or `paymentId`, an existing draft payment, gets posted with that entry).
 */
export function payMove(db, id, amount, date = today(), { paymentId, journalId: payJournal, statementLineId, directBank = false, liquidityAccountId = null, checkNumber } = {}) {
  const r = read(db, 'account.move', id);
  if (!Number.isFinite(Number(amount))) throw new Error('Payment amount must be finite');
  if (r?.state !== 'posted' || !isInvoice(r)) throw new Error('Only posted invoices and bills can be paid');
  const moveBankError = recipientBankCompanyError(db, r);
  if (moveBankError) throw new Error(moveBankError);
  const payRec = paymentId ? read(db, 'account.payment', paymentId) : null;
  const payBankError = recipientBankCompanyError(db, payRec);
  if (payBankError) throw new Error(payBankError);
  if (shouldBePaid(db, r) === 'exception') throw new Error('Resolve or approve the three-way matching exception before registering payment');
  const docRound = (n) => roundCurrency(n, documentCurrency(db, r));
  const companyRound = (n) => roundCurrency(n, companyCurrencyRecord(db, r.company_id));
  amount = docRound(amount);
  const value = Math.min(amount, residual(r, db));
  if (!(value > 0)) return db;
  if (paymentId && (!payRec || payRec.partner_id !== r.partner_id || payRec.payment_type !== (isInbound(r) ? 'inbound' : 'outbound') || payRec.partner_type !== (isPurchase(r) ? 'supplier' : 'customer'))) {
    throw new Error('Payment must match the invoice partner and direction');
  }
  // Matching an existing bank statement records money already sent, rather than authorizing a new payout.
  const statement = statementLineId ? read(db, 'account.bank.statement.line', statementLineId) : null;
  // A booked statement in the invoice currency settles its share of the booked company amount, not a fresh conversion.
  const bookedShare = statement?.bank_move_id && statement.amount && read(db, 'account.journal', statement.journal_id)?.currency_id === r.currency_id
    ? companyRound(Math.abs(bookedStatementAmount(db, statement) * value / statement.amount)) : null;
  if (statementLineId && (!statement || statement.state !== 'to_check' || (statement.amount > 0) !== isInbound(r)
    || (statement.date ?? today()) !== date || (statement.company_id ?? 1) !== (r.company_id ?? 1)
    || (bookedShare ?? toCompany(db, r.currency_id, amount, date, r.company_id)) > companyRound(statement.open_amount ?? Math.abs(Number(statement.amount))))) {
    throw new Error('Invalid bank statement settlement');
  }
  if (liquidityAccountId && (!statement?.bank_move_id || directBank)) throw new Error('A bank suspense settlement requires a posted statement entry');
  let recipientBankId = null;
  if (isPurchase(r) && !isInbound(r) && !statement) {
    // The bank is only read for the payment record; the posted bill's own (locked) bank field is never written here.
    recipientBankId = resolveAndValidateRecipientBank(db, r.partner_id, payRec?.partner_bank_id, { invoiceBankId: r.partner_bank_id, companyId: r.company_id ?? 1 });
  }
  // Anything paid above the amount due stays on the partner's account as an outstanding credit.
  const excess = docRound(amount - value);
  const sale = isInbound(r);
  const counterpartCode = invoiceCounterpartAccount(db, r);
  const via = paymentJournal(db, payJournal, r.company_id ?? 1);
  const journal = read(db, 'account.journal', via.id);
  const outstanding = directBank || liquidityAccountId ? null : outstandingAccount(db, journal, r.company_id ?? 1, sale);
  const liquidity = liquidityAccountId ?? outstanding ?? via.accountId;
  // Bank moves at today's rate, the receivable/payable at the invoice rate; the gap is an exchange difference.
  const bank = bookedShare ?? toCompany(db, r.currency_id, value, date, r.company_id);
  // The last payment clears exactly what is left on the receivable/payable, so no cent stays behind.
  const final = value >= residual(r, db);
  const open = settlementCompanyAmount(db, r, value);
  const diff = companyRound(sale ? bank - open : open - bank);
  const fx = exchangeLines(db, r.company_id, diff);
  // The bank line converts what was really received once; the credit is whatever remains after the settled part.
  const extra = excess > 0 ? companyRound(toCompany(db, r.currency_id, value + excess, date, r.company_id) - bank) : 0;
  const foreign = !!r.currency_id && r.currency_id !== companyCurrencyRecord(db, r.company_id)?.id;
  const foreignAmount = (value) => foreign ? { currency_id: r.currency_id, amount_currency: docRound(value) } : {};
  const liquidityForeignAmount = (value) => liquidityForeignFields(db, {
    currencyId: journal?.currency_id ?? null, companyAmount: (bank + extra) * Math.sign(value), date, companyId: r.company_id,
    docAmount: foreign && journal?.currency_id === r.currency_id ? docRound(value) : null,
  });
  const credit = excess > 0 ? [sale ? { account: counterpartCode, credit: extra, partner_id: r.partner_id, name: 'Outstanding credit', ...foreignAmount(-excess) } : { account: counterpartCode, debit: extra, partner_id: r.partner_id, name: 'Outstanding credit', ...foreignAmount(excess) }] : [];
  const { db: withEntry, id: paymentMove } = postEntry(db, {
    journal: via.code, journal_id: journal?.id, date, ref: `Payment ${r.name}`, company: read(db, 'res.company', r.company_id ?? 1) ? (r.company_id ?? 1) : null,
    archivedOriginIds: [r.id],
    lines: sale
      ? [{ account: liquidity, debit: bank + extra, partner_id: r.partner_id, ...liquidityForeignAmount(value + excess) }, { account: counterpartCode, credit: open, partner_id: r.partner_id, ...foreignAmount(-value) }, ...credit, ...fx]
      : [{ account: counterpartCode, debit: open, partner_id: r.partner_id, ...foreignAmount(value) }, ...credit, { account: liquidity, credit: bank + extra, partner_id: r.partner_id, ...liquidityForeignAmount(-value - excess) }, ...fx],
  });
  const record = { state: 'posted', company_id: r.company_id ?? 1, currency_id: r.currency_id ?? null, move_id: paymentMove, outstanding_account_id: liquidityAccountId ?? outstanding, journal_id: via.id, invoice_id: r.id, partner_id: r.partner_id, amount: docRound(value + excess), unapplied: extra, date, payment_type: sale ? 'inbound' : 'outbound', partner_type: isPurchase(r) ? 'supplier' : 'customer', memo: r.name, ...(checkNumber != null ? { check_number: checkNumber } : {}), ...(recipientBankId ? { partner_bank_id: recipientBankId } : {}) };
  const draftName = paymentId ? read(withEntry, 'account.payment', paymentId)?.name : null;
  const moveName = read(withEntry, 'account.move', paymentMove).name;
  const name = draftName && draftName !== '/' ? draftName : paymentName(withEntry, journal, date, moveName);
  const withPayment = paymentId
    ? write(withEntry, 'account.payment', paymentId, { ...record, name })
    : create(withEntry, 'account.payment', { ...record, name }).db;
  const release = releaseCashBasis(withPayment, r, value / total(r, db), date, { final });
  const payments = [...(r.payments ?? []), { date, amount: value, move_id: paymentMove, company_amount: open, payment_company_amount: bank, cash_basis_move_id: release.id }];
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
  if (account.active === false) throw new Error('Archived accounts cannot be selected on journal items or invoice lines');
  if (!String(label ?? '').trim()) throw new Error('Set a write-off label');
  const incoming = isInbound(invoice);
  const counterpart = invoiceCounterpartAccount(db, invoice);
  const open = settlementCompanyAmount(db, invoice, amount);
  const diff = companyRound(incoming ? companyAmount - open : open - companyAmount);
  const fx = exchangeLines(db, invoice.company_id, diff);
  const partner_id = invoice.partner_id;
  const via = paymentJournal(db, journal, invoice.company_id ?? 1);
  const booked = postEntry(db, { journal: via.code, journal_id: via.id, company: invoice.company_id ?? 1, date, ref: label, archivedOriginIds: [invoice.id],
    lines: incoming
      ? [{ account: writeoffAccount, debit: companyAmount, partner_id, name: label }, { account: counterpart, credit: open, partner_id }, ...fx]
      : [{ account: counterpart, debit: open, partner_id }, { account: writeoffAccount, credit: companyAmount, partner_id, name: label }, ...fx] });
  const release = releaseCashBasis(booked.db, invoice, amount / total(invoice, db), date, { final: amount >= residual(invoice, db) });
  const payments = [...(invoice.payments ?? []), { date, amount, move_id: booked.id, company_amount: open, cash_basis_move_id: release.id }];
  return { db: write(release.db, 'account.move', invoiceId, { amount_paid: docRound((Number(invoice.amount_paid) || 0) + amount), payment_date: date, payments }), id: booked.id };
}

const releasedTaxKey = (account, taxId, name, tags = []) => taxId != null
  ? JSON.stringify([account, taxId, [...tags].sort((a, b) => a - b)])
  : `${account}:${name ?? ''}${tags.length ? `:${[...tags].sort((a, b) => a - b).join(',')}` : ''}`;

/** Tax and base already released for an invoice. */
const releasedTaxes = (db, r) => {
  const taxes = new Map();
  const bases = new Map();
  const legacyTagBases = new Map();
  for (const m of db.records['account.move'] ?? []) {
    if (m.cash_basis_origin_move_id !== r.id || (m.company_id ?? 1) !== (r.company_id ?? 1) || m.state !== 'posted') continue;
    const isLegacyMove = isLegacyCashBasisRelease(m);
    for (const l of m.line_ids ?? []) {
      const code = l.account_id;
      const zeroTax = !(Number(l.debit) || Number(l.credit));
      // Signed bases (and older zero-amount bases) include the refund direction.
      // Legacy nonzero reversals retain the original unsigned base, so undo it here.
      const base = (Number(l.tax_base) || 0) * ((l.tax_base_signed || zeroTax) && isRefund(r) ? -1 : 1)
        * (!l.tax_base_signed && !zeroTax && m.reversed_entry_id ? -1 : 1);
      if (l.tax_grid_base) {
        for (const tagId of l.tax_tag_ids ?? []) {
          const key = `${code}:${tagId}`;
          bases.set(key, (bases.get(key) ?? 0) + base);
        }
      } else {
        const key = releasedTaxKey(code, l.tax_id, l.tax_name, l.tax_tag_ids);
        const previous = taxes.get(key) ?? { amount: 0, base: 0 };
        const amount = ((!isPurchase(r) !== isRefund(r)) ? 1 : -1) * ((Number(l.credit) || 0) - (Number(l.debit) || 0));
        taxes.set(key, { amount: previous.amount + amount, base: previous.base + base });
        if (isLegacyMove && l.tax_grid_release && l.tax_name && !l.tax_zero && l.tax_side) {
          for (const tagId of l.tax_tag_ids ?? []) {
            legacyTagBases.set(tagId, (legacyTagBases.get(tagId) ?? 0) + base);
          }
        }
      }
    }
  }
  return { taxes, bases, legacyTagBases };
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
  const roundingMethod = companyRoundingMethod(db, r.company_id);
  const side = refund ? 'refund' : 'invoice';
  const { taxes: rawTaxGroups, bases: baseGroups } = cashBasisGroups(r.invoice_line_ids, rateAt(db, r.currency_id, r.invoice_date ?? date, r.company_id), documentCurrency(db, r), companyCurrency, {
    roundingMethod,
    side,
    lineAccount: (line) => invoiceLineAccount(db, r, line),
    mapAccount: (id) => mapAccount(db, r.fiscal_position_id, id),
  });
  const groups = rawTaxGroups.map((g) => ({ ...g, account: configuredAccount(db, g.account_id, r.company_id, 'tax repartition', g.tax_name || 'the tax', { allowArchived: true }) }));
  const due = groups.map((g) => {
    const accountTotal = groups.filter((x) => x.account === g.account).reduce((s, x) => s + x.amount, 0);
    // Older releases were not tagged; allocate their account total across its taxes.
    const tagged = final ? released.taxes.get(releasedTaxKey(g.account, g.tax_id, g.tax_name, g.tax_tag_ids)) : null;
    const legacy = final ? released.taxes.get(`${g.account}:`) : null;
    const legacyShare = accountTotal ? g.amount / accountTotal : 0;
    const prior = (tagged?.amount ?? 0) + (legacy?.amount ?? 0) * legacyShare;
    const priorBase = (tagged?.base ?? 0) + (legacy?.base ?? 0) * legacyShare;
    return { ...g, amount: companyRound(final ? g.amount - prior : g.amount * Math.abs(share)), base: companyRound(final ? g.base - priorBase : g.base * share) };
  })
    .filter((g) => g.amount || g.base);
  if (!due.length && !baseGroups.length) return { db, id: null };
  // The released tax lands on the tax account tagged with its tax and base, so the return counts it when paid.
  const lines = due.flatMap(({ account, amount, base, tax_id, tax_name, tax_tag_ids }) => {
    // The base is signed independently of the tax amount, including reversals and refunds.
    const transition = cashBasisTransitionAccount(db, tax_id, r.company_id, { allowArchived: true });
    const tax = { account_id: account, partner_id: r.partner_id, name: tax_name, tax_id, tax_name, tax_tag_ids, tax_grid_release: true, tax_base: refund ? -base : base, tax_base_signed: true, tax_side: sale ? 'sale' : 'purchase' };
    const value = Math.abs(amount);
    return ((sale !== refund) === (share > 0)) !== (amount < 0)
      ? [{ account: transition, debit: value, partner_id: r.partner_id }, { ...tax, credit: value }]
      : [{ ...tax, debit: value }, { account: transition, credit: value, partner_id: r.partner_id }];
  });
  const remainingLegacyByTag = final ? new Map(released.legacyTagBases) : null;
  const dueBases = final
    ? baseGroups.flatMap((bg) => {
        const baseAccount = bg.account_id ?? (bg.tax_id ? cashBasisTransitionAccount(db, bg.tax_id, r.company_id, { allowArchived: true }) : null);
        const byAmount = new Map();
        for (const tagId of bg.tax_tag_ids ?? []) {
          const priorGrid = released.bases.get(`${baseAccount}:${tagId}`) ?? 0;
          const remainingAfterGrid = companyRound(bg.base - priorGrid);
          const legacyAvailable = remainingLegacyByTag.get(tagId) ?? 0;
          const consumed = remainingAfterGrid > 0 && legacyAvailable > 0
            ? Math.min(remainingAfterGrid, legacyAvailable)
            : remainingAfterGrid < 0 && legacyAvailable < 0
              ? Math.max(remainingAfterGrid, legacyAvailable)
              : 0;
          remainingLegacyByTag.set(tagId, companyRound(legacyAvailable - consumed));
          const dueBase = companyRound(remainingAfterGrid - consumed);
          if (!dueBase) continue;
          if (!byAmount.has(dueBase)) byAmount.set(dueBase, []);
          byAmount.get(dueBase).push(tagId);
        }
        return [...byAmount.entries()].map(([base, tax_tag_ids]) => ({ ...bg, account_id: baseAccount, tax_tag_ids, base }));
      })
    : baseGroups.map((bg) => {
        const baseAccount = bg.account_id ?? (bg.tax_id ? cashBasisTransitionAccount(db, bg.tax_id, r.company_id, { allowArchived: true }) : null);
        return { ...bg, account_id: baseAccount, base: companyRound(bg.base * share) };
      }).filter((bg) => bg.base);
  if (!lines.length && !dueBases.length) return { db, id: null };
  const baseLines = dueBases.map((bg) => ({
    account_id: bg.account_id,
    partner_id: r.partner_id,
    name: bg.tax_name || 'Cash basis base',
    tax_id: bg.tax_id ?? null,
    tax_name: bg.tax_name || 'Cash basis base',
    tax_tag_ids: bg.tax_tag_ids,
    tax_grid_base: true,
    tax_grid_release: true,
    tax_base: refund ? -bg.base : bg.base,
    tax_base_signed: true,
    tax_side: sale ? 'sale' : 'purchase',
    debit: 0,
    credit: 0,
  }));
  const posted = postEntry(db, {
    journal: 'MISC',
    date,
    ref: `Cash basis taxes ${r.name}`,
    lines: [...lines, ...baseLines],
    company: read(db, 'res.company', r.company_id ?? 1) ? (r.company_id ?? 1) : null,
    system_generated: true,
    archivedOriginIds: [r.id],
    includeCashBasisTargets: true,
  });
  return { ...posted, db: write(posted.db, 'account.move', posted.id, { cash_basis_origin_move_id: r.id, cash_basis_base_grid: true }) };
}

/** Draft, full refund, or full refund + new draft copy reversing a posted invoice or bill. */
export function creditNote(db, r, options = {}) {
  if (!r || r.state !== 'posted' || !['out_invoice', 'in_invoice'].includes(r.move_type)) {
    throw new Error('Only posted invoices and vendor bills can be credited');
  }
  const opts = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  const method = opts.refund_method ?? opts.method ?? 'refund';
  if (!['refund', 'cancel', 'modify'].includes(method)) {
    throw new Error('Choose a valid credit note method');
  }
  const purchase = isPurchase(r);
  const docCurr = documentCurrency(db, r);
  const credited = creditNotesOf(db, r.id).reduce((s, m) => s + total(m, db), 0);
  if (roundCurrency(credited, docCurr) >= roundCurrency(total(r, db), docCurr)) throw new Error(`${r.name} is already fully credited`);
  if (['cancel', 'modify'].includes(method) && (roundCurrency(credited, docCurr) > 0 || roundCurrency(Number(r.amount_paid) || 0, docCurr) > 0)) {
    throw new Error('Full refund and modify require an unpaid invoice with no existing credit notes');
  }
  const date = opts.date ?? opts.invoice_date ?? today();
  if (!validDate(date)) {
    throw new Error('Enter a valid credit note date');
  }
  if (date < (r.invoice_date ?? '')) {
    throw new Error('Credit note date cannot be before the invoice date');
  }
  const journalIdVal = opts.journal_id ?? null;
  if (journalIdVal) {
    const j = read(db, 'account.journal', journalIdVal);
    if (!j) throw new Error('Selected journal does not exist');
    if (j.company_id && j.company_id !== (r.company_id ?? 1)) throw new Error('Journal belongs to another company');
    const expectedType = purchase ? 'purchase' : 'sale';
    if (j.type !== expectedType) throw new Error(`Journal must be of type ${expectedType}`);
  }
  ({ db, move: r } = storeInvoiceLineIds(db, r));
  const reason = String(opts.reason ?? '').trim();
  const ref = reason ? `Reversal of ${r.name}, ${reason}` : `Reversal of ${r.name}`;
  const { db: next, id } = create(db, 'account.move', {
    move_type: purchase ? 'in_refund' : 'out_refund',
    partner_id: r.partner_id,
    ...(journalIdVal ? { journal_id: journalIdVal } : {}),
    invoice_origin: r.name,
    invoice_date: date,
    invoice_date_due: date,
    reversed_entry_id: r.id,
    sale_id: r.sale_id ?? null,
    purchase_id: r.purchase_id ?? null,
    company_id: r.company_id,
    invoice_line_ids: copyInvoiceLines(r.invoice_line_ids, { sourceCredit: true }),
    ref,
    currency_id: r.currency_id ?? null,
    fiscal_position_id: r.fiscal_position_id ?? null,
    ...(r.invoice_cash_rounding_id ? { invoice_cash_rounding_id: r.invoice_cash_rounding_id } : {}),
  }, { archivedOriginIds: [r.id] });
  let synced = syncInvoicedQty(next, read(next, 'account.move', id));
  if (method === 'refund') {
    return { db: synced, id, go: `#/accounting/${purchase ? 'refunds' : 'credit-notes'}/${id}` };
  }
  synced = postMove(synced, id);
  const origNow = read(synced, 'account.move', r.id);
  if (origNow && !origNow.inalterable_hash) {
    synced = write(synced, 'account.move', r.id, { reversal_move_id: id });
  }
  if (method === 'cancel') {
    return { db: synced, id, go: `#/accounting/${purchase ? 'refunds' : 'credit-notes'}/${id}` };
  }
  const term = r.invoice_payment_term_id ? read(synced, 'account.payment.term', r.invoice_payment_term_id) : null;
  const due = term ? dueDate(term, date) : date;
  const draft = create(synced, 'account.move', {
    move_type: r.move_type,
    partner_id: r.partner_id,
    ...(journalIdVal ? { journal_id: journalIdVal } : {}),
    invoice_origin: r.invoice_origin || r.name,
    invoice_date: date,
    invoice_date_due: due,
    ...(r.invoice_payment_term_id ? { invoice_payment_term_id: r.invoice_payment_term_id } : {}),
    ...(r.invoice_cash_rounding_id ? { invoice_cash_rounding_id: r.invoice_cash_rounding_id } : {}),
    ...(r.incoterm_id ? { incoterm_id: r.incoterm_id } : {}),
    ...(r.incoterm_location ? { incoterm_location: r.incoterm_location } : {}),
    sale_id: r.sale_id ?? null,
    purchase_id: r.purchase_id ?? null,
    company_id: r.company_id,
    currency_id: r.currency_id ?? null,
    fiscal_position_id: r.fiscal_position_id ?? null,
    ref: r.ref ?? '',
    invoice_line_ids: copyInvoiceLines(r.invoice_line_ids),
  }, { archivedOriginIds: [r.id] });
  const finalDb = syncInvoicedQty(draft.db, read(draft.db, 'account.move', draft.id));
  return { db: finalDb, id: draft.id, credit_note_id: id, go: `#/accounting/${purchase ? 'bills' : 'invoices'}/${draft.id}` };
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
    invoice_line_ids: note.invoice_line_ids.map(({ purchase_line_id, sale_line_id, line_id, source_line_id, ...line }) => ({ ...line, line_id: newInvoiceLineId() })),
  }, { archivedOriginIds: [note.id] });
  return { db: postNote(out.db, 'account.move', note.id, `Correction invoice drafted for ${note.name}`), go: `#/accounting/${purchase ? 'bills' : 'invoices'}/${out.id}` };
}

/**
 * Draft debit note documenting additional debt on a posted customer invoice or vendor bill:
 * the reason, date, journal and whether the invoice lines are copied are all the caller's choice.
 * The note stays a draft for the user to adjust and confirm; order-line links are stripped so the
 * original's invoiced quantities are never double-counted.
 */
export function debitNote(db, r, options = {}) {
  if (!r || r.state !== 'posted' || !['out_invoice', 'in_invoice'].includes(r.move_type)) {
    throw new Error('Only posted invoices and vendor bills can be debited');
  }
  const opts = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  const copyLines = opts.copy_lines ?? true;
  const date = opts.date ?? today();
  if (!validDate(date)) {
    throw new Error('Enter a valid debit note date');
  }
  const journalIdVal = opts.journal_id ?? null;
  if (journalIdVal) {
    const j = read(db, 'account.journal', journalIdVal);
    if (!j) throw new Error('Selected journal does not exist');
    if (j.company_id && j.company_id !== (r.company_id ?? 1)) throw new Error('Journal belongs to another company');
    const expectedType = isPurchase(r) ? 'purchase' : 'sale';
    if (j.type !== expectedType) throw new Error(`Journal must be of type ${expectedType}`);
  }
  const reason = String(opts.reason ?? '').trim();
  const ref = reason ? `Debit of ${r.name}, ${reason}` : `Debit of ${r.name}`;
  const { db: next, id } = create(db, 'account.move', {
    move_type: r.move_type,
    partner_id: r.partner_id,
    ...(journalIdVal ? { journal_id: journalIdVal } : {}),
    invoice_origin: r.name,
    invoice_date: date,
    invoice_date_due: date,
    debit_origin_id: r.id,
    company_id: r.company_id,
    currency_id: r.currency_id ?? null,
    fiscal_position_id: r.fiscal_position_id ?? null,
    ...(r.invoice_cash_rounding_id ? { invoice_cash_rounding_id: r.invoice_cash_rounding_id } : {}),
    // Order and rental links stay on the source: a debit note never counts as a billed rental charge (Qodo 62).
    invoice_line_ids: copyLines
      ? r.invoice_line_ids.map(({ sale_line_key, purchase_line_key, down_payment_key, rental_id, rental_charge, ...line }) => ({ ...line }))
      : [],
    ref,
  }, { archivedOriginIds: copyLines ? [r.id] : [] });
  return { db: next, id, go: `#/accounting/${isPurchase(r) ? 'bills' : 'invoices'}/${id}` };
}

/** Early-payment discount available on `date` for an unpaid invoice (0 when its term has none or the window passed). */
export function discountAvailable(db, r, date = today()) {
  const term = read(db, 'account.payment.term', r.invoice_payment_term_id);
  const currency = documentCurrency(db, r);
  const roundingMethod = companyRoundingMethod(db, r?.company_id);
  const base = ['excluded', 'mixed'].includes(discountTaxComputation(term)) ? amounts(r.invoice_line_ids, currency, { roundingMethod }).untaxed : total(r, db);
  return term && !(Number(r.amount_paid) > 0) ? earlyDiscount(term, base, r.invoice_date, date, currency) : 0;
}

/** Reverse the discounted share of invoice-basis taxes using their posted accounts and bases. */
function discountTaxLines(db, invoice, term, discount) {
  if (discountTaxComputation(term) !== 'included') return [];
  const share = discount / (total(invoice, db) || 1);
  const companyRound = (n) => roundCurrency(n, companyCurrencyRecord(db, invoice.company_id));
  return (invoice.line_ids ?? []).filter((line) => line.tax_name && !line.tax_zero).map((line) => ({
    account_id: line.account_id, partner_id: invoice.partner_id, name: line.tax_name,
    debit: companyRound((Number(line.credit) || 0) * share), credit: companyRound((Number(line.debit) || 0) * share),
    tax_id: line.tax_id, tax_name: line.tax_name, tax_base: companyRound((isRefund(invoice) ? 1 : -1) * (Number(line.tax_base) || 0) * share), tax_base_signed: true,
    ...(line.tax_tag_ids?.length ? { tax_tag_ids: line.tax_tag_ids } : {}),
    ...(line.tax_side ? { tax_side: line.tax_side } : {}),
  }));
}

/** Pay `amount`; when it settles the invoice net of an early-payment discount, book the discount too. */
export function payWithDiscount(db, id, amount, date = today(), options = {}) {
  const r = read(db, 'account.move', id);
  if (!validDate(date)) throw new Error('Enter a valid payment date');
  const opts = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  const journalIdVal = opts.journalId ?? opts.journal_id ?? null;
  const docRound = (n) => roundCurrency(n, documentCurrency(db, r));
  const companyRound = (n) => roundCurrency(n, companyCurrencyRecord(db, r.company_id));
  amount = docRound(amount);
  const due = residual(r, db);
  const gap = docRound(due - amount);
  const discount = Math.min(discountAvailable(db, r, date), gap);
  const sale = isInbound(r);
  const company = read(db, 'res.company', r.company_id ?? 1);
  const discountAccount = sale ? company?.expense_early_payment_discount_account_id : company?.income_early_payment_discount_account_id;
  if (gap > 0 && discount >= gap && !discountAccount) throw new Error(`Configure the early payment discount ${sale ? 'expense' : 'income'} account on company ${company?.name ?? r.company_id ?? 1}`);
  const paid = payMove(db, id, amount, date, { journalId: journalIdVal, ...(opts.checkNumber != null ? { checkNumber: opts.checkNumber } : {}) });
  if (!(gap > 0) || discount < gap) return paid;
  const value = settlementCompanyAmount(paid, read(paid, 'account.move', id), discount);
  const counterpart = invoiceCounterpartAccount(db, r);
  const term = read(db, 'account.payment.term', r.invoice_payment_term_id);
  const taxes = discountTaxLines(db, r, term, discount);
  const taxValue = companyRound(taxes.reduce((sum, line) => sum + (sale ? line.debit - line.credit : line.credit - line.debit), 0));
  const share = discount / (total(r, db) || 1);
  const bases = discountTaxComputation(term) === 'included'
    ? (r.line_ids ?? []).filter((line) => line.tax_grid_base && line.tax_tag_ids?.length).map((line) => ({
      account: discountAccount, partner_id: r.partner_id, tax_tag_ids: line.tax_tag_ids,
      tax_grid_base: true, tax_side: isPurchase(r) ? 'purchase' : 'sale',
      debit: companyRound((Number(line.credit) || 0) * share), credit: companyRound((Number(line.debit) || 0) * share),
    })) : [];
  const baseValue = companyRound(bases.reduce((sum, line) => sum + (sale ? line.debit - line.credit : line.credit - line.debit), 0));
  const foreign = !!r.currency_id && r.currency_id !== companyCurrencyRecord(db, r.company_id)?.id;
  const foreignAmount = (val) => (foreign ? { currency_id: r.currency_id, amount_currency: docRound(val) } : {});
  const { db: booked, id: discountMove } = postEntry(paid, {
    journal: 'MISC', date, ref: `Early payment discount ${r.name}`, company: company?.id ?? null, archivedOriginIds: [r.id],
    lines: sale
      ? [{ account: discountAccount, debit: value - taxValue - baseValue, partner_id: r.partner_id }, ...bases, ...taxes, { account: counterpart, credit: value, partner_id: r.partner_id, ...foreignAmount(-discount) }]
      : [{ account: counterpart, debit: value, partner_id: r.partner_id, ...foreignAmount(discount) }, ...bases, ...taxes, { account: discountAccount, credit: value - taxValue - baseValue, partner_id: r.partner_id }],
  });
  const after = read(booked, 'account.move', id);
  // Recorded like a payment (dated, pointing at its entry), so locked-period checks can verify it.
  const paymentMove = after.payments.at(-1).move_id;
  const payments = [...(after.payments ?? []), { date, amount: discount, move_id: discountMove, payment_move_id: paymentMove, company_amount: value, cash_basis_move_id: null, discount: true }];
  return postNote(write(booked, 'account.move', id, { amount_paid: docRound((Number(after.amount_paid) || 0) + discount), payment_date: date, payments }), 'account.move', id, `Early payment discount of ${money(discount)} applied`);
}

function registerPayment(db, r, values = {}) {
  if (shouldBePaid(db, r) === 'exception') throw new Error('Resolve or approve the three-way matching exception before registering payment');
  const amount = promptedAmount(values.amount);
  if (amount == null) throw new Error('Enter a payment amount greater than zero');
  const date = values.date;
  const journalIdVal = values.journal_id;
  if (!validDate(date)) throw new Error('Enter a valid payment date');
  if (!journalIdVal) throw new Error('Select a payment journal');
  const payment = paymentJournal(db, journalIdVal, r.company_id ?? 1);
  return { db: payWithDiscount(db, r.id, amount, date, { journalId: payment.id }) };
}

export { isOutstandingCreditFor, isOutstandingCreditNoteFor, outstandingCreditNotes, outstandingCredits, outstandingPaymentCredits };

/** A posted payment with unapplied credit that can settle `r`: same company, same commercial partner, matching direction. */
function isOutstandingCreditFor(db, r, p) {
  return p?.state === 'posted'
    && Number(p.unapplied) > 0
    && !p.destination_account_id
    && !p.destination_account_code
    && !p.is_tax_payment
    && !p.return_id
    && (p.company_id ?? 1) === (r.company_id ?? 1)
    && sameCommercialPartner(db, p.partner_id, r.partner_id)
    && Boolean(SETTLES[p.partner_type]?.[p.payment_type]?.includes(r.move_type))
    && (!p.partner_bank_id || !r.partner_bank_id || p.partner_bank_id === r.partner_bank_id)
    && shouldBePaid(db, r) !== 'exception';
}

/** A posted credit note with open balance that can settle `r`: matching pair, positive residual, bill payable. */
function isOutstandingCreditNoteFor(db, r, note) {
  return !creditNotePairError(db, note, r)
    && residual(note, db) > 0
    && shouldBePaid(db, r) !== 'exception';
}

/** Outstanding (unapplied) payment credits for a posted open invoice or vendor bill, in record order. */
function outstandingPaymentCredits(db, r) {
  if (!r || r.state !== 'posted' || !isInvoice(r) || !(residual(r, db) > 0)) return [];
  return (db?.records['account.payment'] ?? []).filter((p) => isOutstandingCreditFor(db, r, p));
}

/** Outstanding posted credit notes for a posted open invoice or vendor bill, in record order. */
function outstandingCreditNotes(db, r) {
  if (!r || r.state !== 'posted' || !isInvoice(r) || isRefund(r) || !(residual(r, db) > 0)) return [];
  return (db?.records['account.move'] ?? []).filter((m) => isOutstandingCreditNoteFor(db, r, m));
}

/** All outstanding credit rows (unapplied payments + open credit notes) formatted for the invoice form widget. */
function outstandingCredits(db, r) {
  return [
    // Payment credits are kept in company currency; credit-note residuals in the note's own currency.
    ...outstandingPaymentCredits(db, r).map((p) => ({ ...p, display_currency_id: companyCurrencyRecord(db, p.company_id ?? 1)?.id ?? null })),
    ...outstandingCreditNotes(db, r).map((note) => ({
      id: `move:${note.id}`,
      move_id: note.id,
      name: note.name,
      date: note.invoice_date ?? note.date,
      unapplied: residual(note, db),
      company_id: note.company_id,
      currency_id: note.currency_id,
      display_currency_id: note.currency_id,
    })),
  ];
}

const termDue = (db, r, { clear = false } = {}) => {
  const term = read(db, 'account.payment.term', r.invoice_payment_term_id);
  return term && r.invoice_date ? { invoice_date_due: dueDate(term, r.invoice_date) } : clear ? { invoice_date_due: null } : {};
};

const invoiceLineBase = productLines('Invoice Lines', 'list_price');
const billLineBase = productLines('Invoice Lines', 'cost');
const {
  product_id: invoiceLineProduct,
  uom_id: invoiceLineUom,
  qty: invoiceLineQty,
  price_unit: invoiceLinePrice,
  discount: invoiceLineDiscount,
  tax_id: invoiceLineTaxId,
  tax: invoiceLineTaxPct,
  analytic_account_id: invoiceLineAnalytic,
  ...invoiceLineExtraBase
} = invoiceLineBase.fields;
const invoiceLineField = {
  ...invoiceLineBase,
  newLine: (move, db) => (isPurchase(move ?? {}) ? billLineBase : invoiceLineBase).newLine(move, db),
  onchange: (line, key, db, move) => {
    const moveWithJournal = move?.journal_id ? move : (move && db ? { ...move, journal_id: resolveDocumentJournal(db, move)?.id } : move);
    const base = (isPurchase(moveWithJournal ?? {}) ? billLineBase : invoiceLineBase).onchange(line, key, db, moveWithJournal);
    const isDoc = db && ['out_invoice', 'out_refund', 'in_invoice', 'in_refund'].includes(moveWithJournal?.move_type);
    let updated = base;
    if (isDoc && key === 'account_id' && !base.product_id && !isSectionOrNote(base)) {
      const account = base.account_id ? read(db, 'account.account', base.account_id) : null;
      const side = isPurchase(moveWithJournal) ? 'purchase' : 'sale';
      // An account without a default tax for this side keeps the line's current tax.
      const accTax = account ? accountTax(db, account, side, moveWithJournal.fiscal_position_id, moveWithJournal.company_id) : null;
      if (accTax) updated = { ...updated, tax_source_id: null, tax_ids: [], ...replaceTaxSnapshot(accTax) };
    }
    return isDoc && ['product_id', 'account_id'].includes(key)
      ? { ...updated, analytic_distribution: defaultDistributionForLine(db, updated, moveWithJournal) }
      : updated;
  },
  fields: {
    line_id: { type: 'char', label: 'Reference', readonly: true, hidden: true },
    source_line_id: { type: 'char', label: 'Source Document', readonly: true, hidden: true },
    product_id: invoiceLineProduct,
    name: { type: 'char', label: 'Label' },
    account_id: { type: 'many2one', relation: 'account.account', label: 'Account', optional: 'hide' },
    analytic_account_id: { ...invoiceLineAnalytic, optional: 'hide' },
    deferred_start_date: { type: 'date', label: 'Deferred Start Date', optional: 'hide' },
    deferred_end_date: { type: 'date', label: 'Deferred End Date', optional: 'hide' },
    qty: invoiceLineQty,
    uom_id: { ...invoiceLineUom, optional: 'hide' },
    price_unit: invoiceLinePrice,
    discount: { ...invoiceLineDiscount, optional: 'hide' },
    // A numeric rate without a tax record (e.g. a digitized bill) still taxes the line: show it rather than an empty selector.
    tax_id: { ...invoiceLineTaxId, rateOnlyText: (line) => (!line.tax_id && Number.isFinite(Number(line.tax)) && Number(line.tax) !== 0 ? `${Number(line.tax)}%` : null) },
    tax: { ...invoiceLineTaxPct, hidden: true },
    ...invoiceLineExtraBase,
    display_type: { type: 'selection', label: 'Display Type', hidden: true, options: [['line_section', 'Section'], ['line_note', 'Note']] },
    sale_line_key: { type: 'char', label: 'Order Line', readonly: true, hidden: true },
    purchase_line_key: { type: 'char', label: 'Order Line', readonly: true, hidden: true },
    down_payment_key: { type: 'char', label: 'Down Payment', readonly: true, hidden: true },
    rental_id: { type: 'many2one', relation: 'sale.rental', label: 'Rental', readonly: true, hidden: true },
    rental_charge: { type: 'char', label: 'Type', readonly: true, hidden: true },
  },
};

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
    discount_date: { type: 'date', label: 'Discount Date', hidden: true },
    discount_amount_currency: { type: 'monetary', label: 'Discount Amount Currency', hidden: true },
    discount_balance: { type: 'monetary', label: 'Discount Balance', currency: 'company', hidden: true },
    discount_percentage: { type: 'float', label: 'Discount Percentage', hidden: true },
    blocked: { type: 'boolean', label: 'Blocked / In Dispute', hidden: true },
    invoice_sources: { type: 'one2many', label: 'Invoice Sources', hidden: true, fields: {
      index: { type: 'integer', label: 'Line' }, line_id: { type: 'char', label: 'Reference' }, amount: { type: 'monetary', label: 'Amount' },
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
  columnsFor: (record) => (record?.move_type === 'entry'
    ? [
      ['account_id', lineItem.fields.account_id],
      ['partner_id', lineItem.fields.partner_id],
      ['name', lineItem.fields.name],
      ['currency_id', { ...lineItem.fields.currency_id, optional: 'hide' }],
      ['amount_currency', { ...lineItem.fields.amount_currency, optional: 'hide' }],
      ['date_maturity', lineItem.fields.date_maturity],
      ['tax_ids', { ...lineItem.fields.tax_ids, hidden: false }],
      ['debit', lineItem.fields.debit],
      ['credit', lineItem.fields.credit],
      ['tax_tag_ids', { ...lineItem.fields.tax_tag_ids, label: 'Tax Grids', hidden: false, optional: 'hide' }],
      ['discount_date', { ...lineItem.fields.discount_date, hidden: false, optional: 'hide' }],
    ]
    : null),
  totalColumns: (record) => (record?.move_type === 'entry' ? ['debit', 'credit'] : null),
  newLine: () => ({ account_id: null, partner_id: null, name: '', debit: 0, credit: 0 }),
};

/** Reversal entries linked to `r` via `reversed_entry_id`. */
const moveReversalEntries = (db, r) => (db && r?.id ? search(db, 'account.move').filter((m) => m.reversed_entry_id === r.id) : []);

/** Posted or draft payments whose journal entry is `r`. */
const movePayments = (db, r) => (db && r?.id ? search(db, 'account.payment').filter((p) => p.move_id === r.id) : []);

/** Adjusting entries linked to `r` via `deferred_adjustment_of_id`. */
const moveAdjustingEntries = (db, r) => (db && r?.id ? search(db, 'account.move').filter((m) => m.deferred_adjustment_of_id === r.id) : []);

/** Deferral schedules referencing journal entry `r`. */
const moveDeferrals = (db, r) => (db && r?.id ? search(db, 'account.deferral').filter((d) => deferralLinksMove(d, r.id)) : []);

/** Tax return that lists `r` among its closing moves. */
const closingTaxReturn = (db, r) => (db && r?.id
  ? (db.records?.['account.return'] ?? []).find((ret) => (!r.tax_return_id || ret.id === r.tax_return_id) && (ret.closing_move_ids ?? []).includes(r.id))
  : null);

/** Bank statement line that created or wrote off entry `r`. */
const bankStatementLineForMove = (db, r) => (db && r?.id
  ? search(db, 'account.bank.statement.line').find((l) => l.bank_move_id === r.id || l.writeoff_move_id === r.id)
  : null);

/** Visible warning banner on a manual entry form when its non-zero lines do not balance. */
function unbalancedEntryWarning(db, r) {
  if (!r || r.move_type !== 'entry') return '';
  const lines = r.line_ids ?? [];
  const own = db ? companyCurrencyRecord(db, r.company_id ?? 1) : null;
  const hasAmounts = lines.some((l) => (Number(l.debit) || 0) !== 0 || (Number(l.credit) || 0) !== 0);
  if (!hasAmounts || (!badLineSign(lines) && isBalanced(lines, own))) return '';
  return t('Journal entry is not balanced: total debit must equal total credit.');
}

/** Whether a move can be reset back to draft under Mizan's settlement, hash, bank, and lock rules. */
function canResetMove(r, db) {
  if (!r || r.state === 'draft' || r.inalterable_hash || Number(r.amount_paid) > 0) return false;
  if (db && settlingEntries(db).has(r.id)) return false;
  if (r.move_type === 'entry' && db) {
    if (bookedByBank(db, r.id)) return false;
    const lock = recordLockDate(db, r);
    if (lock && moveDate(r) <= lock) return false;
  }
  return true;
}

/** Whether a posted manual entry is in an unhashed restricted journal and can be hash-locked. */
function canLockEntry(r, db) {
  if (!r || r.move_type !== 'entry' || r.state !== 'posted' || r.inalterable_hash || !r.journal_id || !db) return false;
  return Boolean(read(db, 'account.journal', r.journal_id)?.restrict_mode_hash_table);
}

/** Cancel a draft move and clear any dangling reversal link on its source entry. */
function cancelMove(db, r) {
  let next = write(db, 'account.move', r.id, { state: 'cancel' });
  const source = r.reversed_entry_id && read(next, 'account.move', r.reversed_entry_id);
  if (source?.reversal_move_id === r.id) next = write(next, 'account.move', source.id, { reversal_move_id: null });
  return { db: syncInvoicedQty(removeAnalytic(next, r.id), r) };
}

/** Company-currency signed total: posted lines when booked, else the document total at its rate (null without one). */
function signedCompanyTotal(r, db) {
  if (!r || r.move_type === 'entry' || !r.move_type) return total(r, db);
  const sign = isInbound(r) ? 1 : -1;
  if (r.state === 'posted' && (r.line_ids ?? []).length && db) {
    // Receivable/payable lines carry the document total; a zero-total invoice has none and totals 0.
    const counterpartType = ['in_invoice', 'in_refund', 'in_receipt'].includes(r.move_type) ? 'liability_payable' : 'asset_receivable';
    const net = (r.line_ids ?? []).filter((l) => read(db, 'account.account', l.account_id)?.account_type === counterpartType).reduce((s, l) => s + (Number(l.debit) || 0) - (Number(l.credit) || 0), 0);
    return sign * round2(Math.abs(net));
  }
  const base = total(r, db);
  if (base == null || !db) return base == null ? null : sign * base;
  const own = companyCurrencyRecord(db, r.company_id ?? 1);
  const doc = documentCurrency(db, r);
  if (!doc || doc.id === own.id) return sign * base;
  const rate = conversionRate(db, doc.id, own.id, r.invoice_date ?? r.date ?? today(), r.company_id ?? 1);
  return rate == null ? null : sign * roundCurrency(base * rate, own);
}

/** Comma-separated open activity labels on an account move. */
function moveActivities(r, db) {
  return openActivitiesText(db, 'account.move', r.id);
}

const moveJournalType = (db, r) => (db && r?.journal_id ? read(db, 'account.journal', r.journal_id)?.type ?? null : null);

export const journalEntriesView = {
  defaults: { move_type: 'entry' },
  list: ['accounting_date', 'name', 'partner_id', 'ref', 'journal_id', 'amount_total_signed', 'state'],
  optionalList: ['invoice_date', 'activities'],
  listLabels: { accounting_date: 'Date', invoice_date: 'Invoice Date', amount_total_signed: 'Total', state: 'Status' },
  searchFields: ['name', 'ref', 'partner_id', 'journal_id'],
  filters: [
    [{ id: 'unposted', label: 'Unposted', fn: (r) => r.state === 'draft' }, { id: 'posted', label: 'Posted', fn: (r) => r.state === 'posted' }],
    [
      { id: 'reversed', label: 'Reversed', fn: (r, db) => Boolean(r.reversed_entry_id || r.reversal_move_id || (db?.records?.['account.move'] ?? []).some((m) => m.state !== 'cancel' && m.reversed_entry_id === r.id)) },
      { id: 'manual', label: 'Manual', fn: (r) => !((r.auto_post && r.auto_post !== 'no') || r.auto_post_origin_id) },
    ],
    [
      { id: 'sales', label: 'Sales', fn: (r, db) => moveJournalType(db, r) === 'sale' },
      { id: 'purchases', label: 'Purchases', fn: (r, db) => moveJournalType(db, r) === 'purchase' },
      { id: 'bank', label: 'Bank', fn: (r, db) => moveJournalType(db, r) === 'bank' },
      { id: 'cash', label: 'Cash', fn: (r, db) => moveJournalType(db, r) === 'cash' },
      { id: 'credit', label: 'Credit', fn: (r, db) => moveJournalType(db, r) === 'credit' },
      { id: 'misc', label: 'Miscellaneous', fn: (r, db) => moveJournalType(db, r) === 'general' },
    ],
    monthFilters('accounting_date', 'Date', (r) => r.date ?? r.invoice_date),
    monthFilters('invoice_date', 'Invoice Date'),
  ],
  groupBys: ['partner_id', 'journal_id', 'state', 'accounting_date', 'invoice_date'],
};

const INVOICE_LIST_FIELDS = {
  name: { bold: true },
  journal_id: { optional: 'hide' },
  invoice_date: { optional: 'show' },
  date: { optional: 'hide' },
  invoice_date_due: {
    optional: 'show',
    widget: 'remaining_days',
    hideWhen: (r, db) => ['paid', 'in_payment', 'reversed', 'cancel'].includes(statusInPayment(r, db)),
  },
  invoice_origin: { optional: 'hide' },
  payment_reference: { optional: 'hide' },
  ref: { optional: 'hide' },
  invoice_user_id: { optional: 'hide' },
  activities: { optional: 'hide' },
  company_id: { optional: 'hide', multiCompanyOnly: true },
  amount_untaxed_in_currency_signed: { optional: 'show', sum: 'Total' },
  amount_tax_in_currency_signed: { optional: 'hide', sum: 'Total' },
  amount_total_in_currency_signed: { optional: 'show', bold: true, sum: 'Total' },
  amount_residual_in_currency_signed: { optional: 'show', sum: 'Total' },
  currency_id: { optional: 'hide' },
};

/** Highlight draft documents as info and cancelled documents as muted on invoice/bill lists. */
const invoiceListDecoration = (r) => (r.state === 'draft' ? 'info' : r.state === 'cancel' ? 'muted' : null);

/** Build Odoo 20 search panel filter groups for sales or purchase invoice/refund lists. */
const invoiceSearchFilters = ({ purchases = false } = {}) => [
  [{ id: 'myinvoices', label: 'My Invoices', fn: (r, db) => Boolean(r.invoice_user_id && r.invoice_user_id === currentUserId(db)) }],
  [
    { id: 'draft', label: 'Draft', fn: (r) => r.state === 'draft' },
    { id: 'posted', label: 'Posted', fn: (r) => r.state === 'posted' },
    { id: 'cancel', label: 'Cancelled', fn: (r) => r.state === 'cancel' },
  ],
  [
    { id: 'unpaid', label: 'To Pay', fn: (r, db) => r.state !== 'cancel' && isInvoice(r) && ['not_paid', 'partial'].includes(paymentState(r, db)) },
    { id: 'in_payment', label: 'In Payment', fn: (r, db) => r.state === 'posted' && statusInPayment(r, db) === 'in_payment' },
    { id: 'overdue', label: 'Overdue', fn: (r, db) => r.state === 'posted' && isInvoice(r) && ['not_paid', 'partial'].includes(paymentState(r, db)) && Boolean(r.invoice_date_due) && r.invoice_date_due < today() },
  ],
  monthFilters('invoice_date', 'Invoice Date'),
  ...(purchases ? [monthFilters('date', 'Accounting Date')] : []),
  monthFilters('invoice_date_due', 'Due Date'),
];

const INVOICE_GROUP_BYS = ['invoice_user_id', 'partner_id', 'status_in_payment', 'journal_id', 'company_id', 'invoice_date', 'invoice_date_due', 'date'];
const INVOICE_GROUP_BY_LABELS = { partner_id: 'Partner', invoice_date: 'Invoice Date', date: 'Accounting Date', status_in_payment: 'Status' };
const INVOICE_SEARCH_FIELDS = ['name', 'invoice_origin', 'ref', 'payment_reference', 'partner_id', 'journal_id', 'invoice_user_id'];

export const salesInvoiceView = {
  list: [
    'name', 'partner_id', 'journal_id', 'invoice_date', 'date', 'invoice_date_due', 'invoice_origin',
    'ref', 'invoice_user_id', 'activities', 'company_id',
    'amount_untaxed_in_currency_signed', 'amount_tax_in_currency_signed', 'amount_total_in_currency_signed', 'amount_residual_in_currency_signed',
    'currency_id', 'status_in_payment',
  ],
  listFields: INVOICE_LIST_FIELDS,
  listLabels: { partner_id: 'Customer', invoice_date: 'Invoice Date', currency_id: 'Invoice Currency' },
  groupByLabels: INVOICE_GROUP_BY_LABELS,
  listDecoration: invoiceListDecoration,
  searchFields: INVOICE_SEARCH_FIELDS,
  filters: invoiceSearchFilters({ purchases: false }),
  groupBys: INVOICE_GROUP_BYS,
};

export const purchaseInvoiceView = {
  list: [
    'name', 'partner_id', 'journal_id', 'invoice_date', 'date', 'invoice_date_due', 'invoice_origin',
    'payment_reference', 'ref', 'activities', 'company_id',
    'amount_untaxed_in_currency_signed', 'amount_tax_in_currency_signed', 'amount_total_in_currency_signed', 'amount_residual_in_currency_signed',
    'currency_id', 'status_in_payment',
  ],
  listFields: INVOICE_LIST_FIELDS,
  listLabels: { partner_id: 'Vendor', invoice_date: 'Bill Date', currency_id: 'Bill Currency' },
  groupByLabels: INVOICE_GROUP_BY_LABELS,
  listDecoration: invoiceListDecoration,
  searchFields: INVOICE_SEARCH_FIELDS,
  filters: invoiceSearchFilters({ purchases: true }),
  groupBys: INVOICE_GROUP_BYS,
};

export const accountingModels = {
  'account.account': {
    label: 'Chart of Accounts',
    fields: {
      code: { type: 'char', label: 'Code', required: true },
      name: { type: 'char', label: 'Account Name', required: true },
      display_name: { type: 'char', label: 'Display Name', compute: (r) => [r.code, r.name].filter(Boolean).join(' ') },
      account_type: { type: 'selection', label: 'Type', options: ACCOUNT_TYPES },
      tax_ids: { type: 'many2many', relation: 'account.tax', label: 'Default Taxes', domain: (r, acc) => !r.company_id || !acc?.company_id || r.company_id === acc.company_id },
      fiscal_category_id: { type: 'many2one', relation: 'account.fiscal.category', label: 'Fiscal Category' },
      tag_ids: { type: 'many2many', relation: 'account.account.tag', label: 'Tags', domain: (r) => r.applicability === 'accounts' },
      reconcile: { type: 'boolean', label: 'Allow Reconciliation' },
      active: { type: 'boolean', label: 'Active' },
      asset_model_id: { type: 'many2one', relation: 'account.asset.model', label: 'Depreciation Model' },
      description: { type: 'text', label: 'Description' },
      current_balance: { type: 'monetary', label: 'Balance', currency: 'company', readonly: true },
    },
    defaults: () => ({ account_type: 'expense', active: true, tax_ids: [] }),
    guard: (db, before, after) => {
      const useError = accountTypeGuard(db, before, after);
      if (useError) return useError;
      const codeError = accountCodeGuard(db, before, after);
      if (codeError) return codeError;
      if ((after.tag_ids ?? []).some((id) => read(db, 'account.account.tag', id)?.applicability !== 'accounts')) return 'Select only account tags';
      for (const taxId of after.tax_ids ?? []) {
        const tax = read(db, 'account.tax', taxId);
        if (!tax) return 'Select an existing default tax';
        if (tax.company_id && after.company_id && tax.company_id !== after.company_id) return 'Tax belongs to another company';
      }
      if (after.fiscal_category_id) {
        const category = read(db, 'account.fiscal.category', after.fiscal_category_id);
        if (!category) return 'Select an existing fiscal category';
        if (after.company_id && category.company_id !== after.company_id) return 'Fiscal category must belong to the account company';
      }
      if (after.asset_model_id) {
        const model = read(db, 'account.asset.model', after.asset_model_id);
        if (!model) return 'Select an existing asset model';
        if (model.company_id && model.company_id !== after.company_id) return 'Asset model must belong to the account company';
      }
      return null;
    },
    protectDelete: accountDeleteGuard,
    sort: (a, b) => String(a.code ?? '').localeCompare(String(b.code ?? '')),
    groupBys: ['account_type'],
    kanban: { title: 'name', lines: ['code', 'account_type'] },
    list: ['code', 'name', 'account_type', 'reconcile'],
    editableList: ['reconcile'],
    views: ['list', 'kanban'],
    form: {
      title: 'display_name',
      titleFields: ['code', 'name'],
      smart: [{ label: 'Balance', valueField: 'current_balance', value: (db, r) => accountBalance(db, r), target: (r) => `accounting/journal-items?account=${r.id}` }],
      tabs: [
        {
          label: 'Accounting',
          groups: [
            ['account_type', 'tax_ids', 'fiscal_category_id', 'tag_ids', 'reconcile', 'active'],
            ['asset_model_id'],
            ['description'],
          ],
        },
      ],
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

  'account.journal': {
    label: 'Journals',
    guard: (db, before, after) => {
      const companyId = after.company_id ?? 1;
      const checkAccount = (field, label, allowedTypes = null) => {
        if (!after[field]) return null;
        if (allowedTypes && !allowedTypes.includes(after.type)) {
          return `${label} is only valid for ${allowedTypes.join('/')} journals`;
        }
        const account = read(db, 'account.account', after[field]);
        if (!account || account.active === false || (account.company_id && account.company_id !== companyId)) {
          return `Select an active ${label.toLowerCase()} belonging to this journal company`;
        }
        return null;
      };
      const accountErr = checkAccount('default_account_id', 'Default account')
        ?? checkAccount('suspense_account_id', 'Suspense account', ['bank', 'cash', 'credit'])
        ?? checkAccount('non_deductible_account_id', 'Private share account', ['purchase'])
        ?? checkAccount('profit_account_id', 'Profit account', ['cash', 'bank'])
        ?? checkAccount('loss_account_id', 'Loss account', ['cash', 'bank'])
        ?? checkAccount('outstanding_receipts_account_id', 'Outstanding receipts account', ['bank', 'cash', 'credit'])
        ?? checkAccount('outstanding_payments_account_id', 'Outstanding payments account', ['bank', 'cash', 'credit']);
      if (accountErr) return accountErr;
      if (after.bank_account_id) {
        if (after.type !== 'bank') return 'Bank account number is only valid for bank journals';
        const bankAcc = read(db, 'res.partner.bank', after.bank_account_id);
        if (!bankAcc || bankAcc.active === false || (bankAcc.company_id && bankAcc.company_id !== companyId)) {
          return 'Select an active bank account belonging to this journal company';
        }
      }
      return journalSequenceGuard(db, before, after) ?? secureHeadsGuard(db, before, after);
    },
    protectDelete: (db, journal) => (journal.secure_chain_heads ?? []).length ? 'Journals with secure chains cannot be deleted' : null,
    fields: {
      sequence: { type: 'integer', label: 'Sequence', widget: 'handle' },
      name: { type: 'char', label: 'Journal', required: true },
      code: { type: 'char', label: 'Sequence Prefix', required: true },
      type: {
        type: 'selection', label: 'Type', required: true,
        options: [['sale', 'Sales'], ['purchase', 'Purchase'], ['cash', 'Cash'], ['bank', 'Bank'], ['credit', 'Credit Card'], ['general', 'Miscellaneous']],
        help: 'Select "Sales" for customer invoices journals; "Purchase" for vendor bills journals; "Cash", "Bank" or "Credit Card" for customer or vendor payments; "Miscellaneous" for everything else.',
      },
      active: { type: 'boolean', label: 'Active', optional: 'hide' },
      company_id: { type: 'many2one', relation: 'res.company', label: 'Company', multiCompanyOnly: true },
      refund_sequence: {
        type: 'boolean', label: 'Dedicated Credit Note Sequence',
        help: 'Check this box if you don\'t want to share the same sequence for invoices and credit notes made from this journal',
      },
      payment_sequence: {
        type: 'boolean', label: 'Dedicated Payment Sequence',
        help: 'Check this box if you don\'t want to share the same sequence on payments and bank transactions posted on this journal',
      },
      invoice_sequence_prefix: { type: 'char', label: 'Invoice Sequence Prefix' },
      invoice_sequence_next_number: { type: 'integer', label: 'Next Invoice Number' },
      refund_sequence_prefix: { type: 'char', label: 'Refund Sequence Prefix' },
      refund_sequence_next_number: { type: 'integer', label: 'Next Refund Number' },
      default_account_id: {
        type: 'many2one', relation: 'account.account', label: 'Default Account',
        required: (r, _db, { isNew } = {}) => ['sale', 'purchase'].includes(r?.type) || (!isNew && isLiquidityJournal(r)),
      },
      suspense_account_id: {
        type: 'many2one', relation: 'account.account', label: 'Suspense Account',
        required: (r) => isLiquidityJournal(r),
        help: 'Bank statements transactions will be posted on the suspense account until the final reconciliation allowing finding the right account.',
      },
      non_deductible_account_id: {
        type: 'many2one', relation: 'account.account', label: 'Private Share Account',
        help: 'Account used to register the private part of mixed expenses.',
      },
      profit_account_id: { type: 'many2one', relation: 'account.account', label: 'Profit Account' },
      loss_account_id: { type: 'many2one', relation: 'account.account', label: 'Loss Account' },
      default_for_payments: { type: 'boolean', label: 'Default Payment Journal' },
      outstanding_receipts_account_id: { type: 'many2one', relation: 'account.account', label: 'Outstanding Receipts' },
      outstanding_payments_account_id: { type: 'many2one', relation: 'account.account', label: 'Outstanding Payments' },
      check_next_number: { type: 'integer', label: 'Next Check Number' },
      bank_account_id: {
        type: 'many2one', relation: 'res.partner.bank', label: 'Bank Account Number',
        domain: (b, j, db) => {
          const cid = j?.company_id ?? 1;
          const comp = db && read(db, 'res.company', cid);
          return (!b.company_id || b.company_id === cid) && (!comp?.partner_id || b.partner_id === comp.partner_id);
        },
      },
      bank_statements_source: {
        type: 'selection', label: 'Bank Feeds', widget: 'radio',
        options: [
          ['undefined', 'Undefined Yet'],
          ['file_import', 'Manual (or import CAMT, CSV, JPEG, OFX, PDF, PNG, XLS, XLSX)'],
          ['online_sync', 'Online Synchronization'],
        ],
        required: (r) => r?.type === 'bank',
      },
      restrict_mode_hash_table: { type: 'boolean', label: 'Secure Posted Entries with Hash' },
      invoice_reference_type: {
        type: 'selection', label: 'Communication Type',
        options: [['none', 'None'], ['partner', 'Based on Customer'], ['invoice', 'Based on Invoice']],
      },
      invoice_reference_model: {
        type: 'selection', label: 'Communication Standard',
        options: [
          ['odoo', 'Full Reference (INV/2024/00001)'],
          ['euro', 'European (RF83INV202400001)'],
          ['number', 'Numbers only (202400001)'],
        ],
      },
      secure_chain_heads: { type: 'one2many', label: 'Secure Chain Heads', hidden: true, fields: {
        company_id: { type: 'many2one', relation: 'res.company', label: 'Company' },
        count: { type: 'integer', label: 'Count' }, last_sequence: { type: 'integer', label: 'Sequence' },
        last_hash: { type: 'char', label: 'Hash' }, last_move_id: { type: 'many2one', relation: 'account.move', label: 'Last Entry' },
        last_move_name: { type: 'char', label: 'Last Entry Number' },
      } },
    },
    defaults: () => ({
      type: 'general', active: true, sequence: 10,
      refund_sequence: false, payment_sequence: false, restrict_mode_hash_table: false,
    }),
    createDefaults: (_db, vals = {}) => ({
      ...(vals.payment_sequence === undefined ? { payment_sequence: isLiquidityJournal(vals) } : {}),
      ...(vals.refund_sequence === undefined ? derivedRefundSequence(vals) : {}),
      ...(vals.type === 'bank' && vals.bank_statements_source === undefined ? { bank_statements_source: 'undefined' } : {}),
      ...(vals.type === 'sale' && vals.invoice_reference_type === undefined ? { invoice_reference_type: 'invoice' } : {}),
      ...(vals.type === 'sale' && vals.invoice_reference_model === undefined ? { invoice_reference_model: 'odoo' } : {}),
    }),
    onchange: (r, key) => {
      if (key === 'type') {
        return {
          ...(r.type === 'bank' && !r.bank_statements_source ? { bank_statements_source: 'undefined' } : {}),
          ...(r.type === 'sale' && !r.invoice_reference_type ? { invoice_reference_type: 'invoice' } : {}),
          ...(r.type === 'sale' && !r.invoice_reference_model ? { invoice_reference_model: 'odoo' } : {}),
          payment_sequence: isLiquidityJournal(r),
          ...(r.refund_sequence ? {} : derivedRefundSequence(r)),
        };
      }
      return {};
    },
    sort: (a, b) => (a.sequence ?? 10) - (b.sequence ?? 10) || a.id - b.id,
    filters: [[
      { id: 'sales', label: 'Sales', fn: (r) => r.type === 'sale' },
      { id: 'purchases', label: 'Purchases', fn: (r) => r.type === 'purchase' },
      { id: 'liquidity', label: 'Liquidity', fn: (r) => isLiquidityJournal(r) },
      { id: 'miscellaneous', label: 'Miscellaneous', fn: (r) => r.type === 'general' },
    ]],
    kanban: { title: 'name', lines: ['code', 'type'], counter: { label: 'Entries', model: 'account.move', field: 'journal_id' } },
    list: ['sequence', 'name', 'type', 'code', 'default_account_id', 'active', 'company_id'],
    form: {
      title: 'name',
      chatter: true,
      smart: [{ label: 'Entries', model: 'account.move', field: 'journal_id', target: 'accounting/entries' }],
      groups: [['type', 'code']],
      tabs: (j) => {
        const liquidity = isLiquidityJournal(j);
        const invoiced = ['sale', 'purchase'].includes(j.type);
        const cashOrBank = ['cash', 'bank'].includes(j.type);
        const accountLabel = {
          sale: 'Default Income Account',
          purchase: 'Default Expense Account',
          bank: 'Bank Account',
          cash: 'Cash Account',
          credit: 'Credit Card Account',
        }[j.type];
        const entries = [
          { field: 'default_account_id', label: accountLabel },
          ...(liquidity ? ['suspense_account_id'] : []),
          ...(j.type === 'purchase' ? ['non_deductible_account_id'] : []),
          ...(cashOrBank ? ['profit_account_id', 'loss_account_id'] : []),
          ...(invoiced ? [
            'refund_sequence',
            'invoice_sequence_prefix',
            'invoice_sequence_next_number',
            ...(j.refund_sequence ? ['refund_sequence_prefix', 'refund_sequence_next_number'] : []),
          ] : []),
          ...(liquidity ? ['payment_sequence', 'default_for_payments'] : []),
        ];
        const entryGroups = [
          entries,
          ...(j.type === 'bank' ? [{ title: 'Bank Account', fields: ['bank_account_id', 'bank_statements_source'] }] : []),
        ];
        const advancedGroups = [
          ...(j.type !== 'bank' ? [{ title: 'Automation', fields: ['restrict_mode_hash_table'] }] : []),
          ...(j.type === 'sale' ? [{
            title: 'Payment Communications',
            fields: j.invoice_reference_type === 'none'
              ? ['invoice_reference_type']
              : ['invoice_reference_type', 'invoice_reference_model'],
          }] : []),
        ];
        return [
          { label: 'Journal Entries', groups: entryGroups },
          ...(liquidity ? [
            { label: 'Incoming Payments', groups: [['outstanding_receipts_account_id']] },
            { label: 'Outgoing Payments', groups: [['outstanding_payments_account_id', 'check_next_number']] },
          ] : []),
          ...(advancedGroups.length ? [{ label: 'Advanced Settings', groups: advancedGroups }] : []),
        ];
      },
    },
  },

  'account.move': {
    label: 'Invoices',
    actions: { postAutoPostMoves },
    guard: (db, before, after, ctx) => {
      const company = after.company_id ?? 1;
      const roundingErr = cashRoundingError(db, after.invoice_cash_rounding_id, before?.invoice_cash_rounding_id, company, after.currency_id ?? findCompanyCurrencyRecord(db, company)?.id);
      if (roundingErr) return roundingErr;
      if (after.invoice_payment_term_id) {
        const term = read(db, 'account.payment.term', after.invoice_payment_term_id);
        if (term?.company_id && term.company_id !== (after.company_id ?? 1)) return 'Payment terms belong to another company';
      }
      const counterpart = before?.intercompany_move_id ? read(db, 'account.move', before.intercompany_move_id) : null;
      const counterpartBlocked = counterpart && (counterpart.state === 'posted' || Number(counterpart.amount_paid) > 0 || paymentState(counterpart, db) === 'paid');
      if (['out_invoice', 'out_refund'].includes(before?.move_type) && counterpartBlocked && ((before?.state === 'posted' && after.state !== 'posted') || (before?.state !== 'cancel' && after.state === 'cancel'))) {
        return 'The inter-company bill is posted or paid; issue a credit note instead';
      }
      return archivedLineAccountGuard(db, before, after, ctx) ?? moveGuard(db, before, after, ctx) ?? paymentGuard(db, before, after, ctx) ?? (after.state === 'posted' && badLineSign(after.line_ids) ? 'Debits and credits cannot be negative' : null);
    },
    invariant: (db, after, before, stored) => secureMoveInvariant(db, after, before) ?? lockedSettlementInvariant(db, after, before) ?? moveInvariant(db, after, before, stored),
    protectDelete: (db, m, staged) => moveDeleteGuard(db, m, staged) ?? settledByCreditNote(db, m) ?? (settlingEntries(db).has(m.id) || Number(m.amount_paid) > 0 ? 'Entries tied to a payment cannot be deleted' : null),
    // The restrictive audit trail is a setting of the move's own company.
    audited: (db, move) => read(db, 'res.company', move?.company_id ?? 1)?.audit_trail === true,
    onUnlink: (db, r) => syncInvoicedQty(db, r),
    onWrite: (db, after, before, vals) => {
      if (['out_invoice', 'out_refund'].includes(before.move_type) && ['posted', 'draft'].includes(before.state) && (after.state === 'draft' || after.state === 'cancel') && after.state !== before.state) {
        const bill = read(db, 'account.move', before.intercompany_move_id);
        if (bill?.state === 'draft') db = write(db, 'account.move', bill.id, { state: 'cancel' });
      }
      if (before.state === 'posted' && after.state !== 'posted') {
        db = reverseInvoiceDeferrals(db, before);
        db = revertInvoiceDeferralCreditAdjustment(db, before, reverseEntry, attemptAutoPostMove);
      }
      if (!['invoice_line_ids', 'state', 'sale_id', 'purchase_id'].some((key) => key in vals)) return db;
      return syncInvoicedQty(syncInvoicedQty(db, before), after);
    },
    // The partner's payment term becomes the default; the term and invoice date drive the due date.
    onchange: (r, key, db) => {
      if (['partner_id', 'fiscal_position_id', 'company_id'].includes(key)) {
        const partnerChange = key === 'partner_id';
        const partner = partnerChange && r.partner_id ? read(db, 'res.partner', r.partner_id) : null;
        const term = partner ? (isPurchase(r) ? partner.property_supplier_payment_term_id : partner.property_payment_term_id) : null;
        const fiscal = (partnerChange || key === 'company_id') ? { fiscal_position_id: fiscalPositionFor(db, r.partner_id, r.company_id ?? 1) } : {};
        const selectedBank = partnerChange && isPurchase(r) && r.partner_bank_id ? read(db, 'res.partner.bank', r.partner_bank_id) : null;
        const partnerBank = selectedBank && selectedBank.partner_id === r.partner_id && selectedBank.allow_out_payment
          && selectedBank.active !== false && (!selectedBank.company_id || selectedBank.company_id === (r.company_id ?? 1))
          ? selectedBank.id : null;
        const journal = resolveDocumentJournal(db, r)?.id ?? null;
        const context = { ...r, ...fiscal, journal_id: journal };
        const linesUpdate = Array.isArray(r.invoice_line_ids)
          ? { invoice_line_ids: r.invoice_line_ids.map((line) => {
            const remapKey = (key === 'fiscal_position_id' || partnerChange || key === 'company_id') && !['line_section', 'line_note'].includes(line.display_type)
              ? (line.product_id ? 'product_id' : (line.account_id && (read(db, 'account.account', line.account_id)?.tax_ids ?? []).length ? 'account_id' : null))
              : null;
            const updated = remapKey ? invoiceLineField.onchange(line, remapKey, db, context) : line;
            return { ...updated, ...(remapKey ? { price_unit: line.price_unit, qty: line.qty, discount: line.discount } : {}), analytic_distribution: defaultDistributionForLine(db, updated, context, line.analytic_distribution ?? {}) };
          }) }
          : {};
        return {
          ...fiscal,
          ...(partnerChange && isPurchase(r) ? { partner_bank_id: partnerBank } : {}),
          ...linesUpdate,
          ...(partnerChange ? {
            invoice_payment_term_id: term ?? null,
            ...termDue(db, { ...r, invoice_payment_term_id: term ?? null }, { clear: true }),
          } : {}),
        };
      }
      if (r.move_type === 'entry' && key === 'date') return { invoice_date: r.date };
      return ['invoice_payment_term_id', 'invoice_date'].includes(key) ? termDue(db, r) : {};
    },
    fields: {
      name: { type: 'char', label: 'Number', readonly: true },
      move_type: { type: 'selection', label: 'Type', readonly: true, copy: true, options: [['out_invoice', 'Customer Invoice'], ['out_refund', 'Credit Note'], ['in_invoice', 'Vendor Bill'], ['in_refund', 'Vendor Refund'], ['entry', 'Journal Entry']] },
      journal_id: {
        type: 'many2one',
        relation: 'account.journal',
        label: 'Journal',
        domain: (j, r, db) => (!j.company_id || j.company_id === (r?.company_id ?? db?.settings?.current_company_id ?? 1)) && (r?.move_type === 'entry' ? true : isPurchase(r) ? j.type === 'purchase' : j.type === 'sale'),
      },
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Partner' },
      invoice_user_id: { type: 'many2one', relation: 'hr.employee', label: 'Salesperson' },
      partner_bank_id: { type: 'many2one', relation: 'res.partner.bank', label: 'Recipient Bank Account' },
      ref: { type: 'char', label: 'Reference' },
      date: { type: 'date', label: 'Accounting Date' },
      accounting_date: { type: 'date', label: 'Date', compute: (r) => r.date ?? r.invoice_date ?? null },
      invoice_date: { type: 'date', label: 'Date' },
      invoice_date_due: { type: 'date', label: 'Due Date' },
      invoice_origin: { type: 'char', label: 'Source Document', readonly: true },
      payment_reference: { type: 'char', label: 'Payment Reference' },
      currency_id: { type: 'many2one', relation: 'res.currency', label: 'Currency' },
      invoice_payment_term_id: { type: 'many2one', relation: 'account.payment.term', label: 'Payment Terms' },
      invoice_cash_rounding_id: {
        type: 'many2one', relation: 'account.cash.rounding', label: 'Cash Rounding',
        domain: (r, move, db) => r.active !== false && cashRoundingApplies(r, move?.company_id ?? 1, move?.currency_id ?? findCompanyCurrencyRecord(db, move?.company_id ?? 1)?.id),
      },
      fiscal_position_id: { type: 'many2one', relation: 'account.fiscal.position', label: 'Fiscal Position' },
      subscription_id: { type: 'many2one', relation: 'sale.subscription', label: 'Subscription', readonly: true },
      subscription_period: { type: 'date', label: 'Subscription Period', readonly: true },
      state: { type: 'selection', label: 'Status', tracking: true, options: [['draft', 'Draft'], ['posted', 'Posted'], ['cancel', 'Cancelled']], badge: { draft: 'info', posted: 'success', cancel: 'muted' } },
      activities: { type: 'char', label: 'Activities', compute: moveActivities },
      invoice_line_ids: invoiceLineField,
      payments: {
        type: 'one2many', label: 'Payments', readonly: true,
        fields: { date: { type: 'date', label: 'Paid on' }, amount: { type: 'monetary', label: 'Amount' }, move_id: { type: 'many2one', relation: 'account.move', label: 'Payment' }, payment_move_id: { type: 'many2one', relation: 'account.move', label: 'Payment' }, company_amount: { type: 'monetary', label: 'Company Amount', currency: 'company' }, line_index: { type: 'integer', label: 'Closing Line Index', hidden: true }, payment_company_amount: { type: 'monetary', label: 'Payment Company Amount', currency: 'company' }, payment_fx_move_id: { type: 'many2one', relation: 'account.move', label: 'Exchange Entry' }, cash_basis_move_id: { type: 'many2one', relation: 'account.move', label: 'Journal Entry' }, discount: { type: 'boolean', label: 'Early Payment Discount' }, reversed: { type: 'boolean', label: 'Reversed' }, unapplied: { type: 'boolean', label: 'Unreconciled' }, reversal_move_id: { type: 'many2one', relation: 'account.move', label: 'Reversal Entry' }, reversal_date: { type: 'date', label: 'Reversal Date' } },
        newLine: () => ({ date: today(), amount: 0, move_id: null }),
      },
      line_ids: lineItem,
      amount_untaxed: {
        type: 'monetary',
        label: 'Tax Excluded',
        compute: untaxedAmount,
      },
      amount_untaxed_in_currency_signed: {
        type: 'monetary',
        label: 'Tax Excluded',
        compute: (r, db) => signedDocumentAmount(r, untaxedAmount(r, db)),
      },
      amount_tax: { type: 'monetary', label: 'Taxes', compute: (r, db) => invoiceTaxAmount(r, db) },
      amount_tax_in_currency_signed: {
        type: 'monetary',
        label: 'Tax',
        compute: (r, db) => signedDocumentAmount(r, invoiceTaxAmount(r, db)),
      },
      amount_total: { type: 'monetary', label: 'Total', compute: total },
      amount_total_in_currency_signed: {
        type: 'monetary',
        label: 'Total',
        compute: (r, db) => signedDocumentAmount(r, total(r, db)),
      },
      amount_total_signed: { type: 'monetary', label: 'Total', currency: 'company', compute: signedCompanyTotal },
      amount_paid: { type: 'monetary', label: 'Paid', readonly: true },
      amount_residual: { type: 'monetary', label: 'Amount Due', compute: residual },
      amount_residual_in_currency_signed: {
        type: 'monetary',
        label: 'Amount Due',
        compute: (r, db) => signedDocumentAmount(r, residual(r, db)),
      },
      payment_state: {
        type: 'selection',
        label: 'Payment Status',
        compute: paymentState,
        options: [['not_paid', 'Not Paid'], ['partial', 'Partially Paid'], ['paid', 'Paid'], ['unavailable', 'Unavailable']],
      },
      status_in_payment: {
        type: 'selection',
        label: 'Status',
        compute: statusInPayment,
        options: [
          ['draft', 'Draft'],
          ['posted', 'Posted'],
          ['sent', 'Sent'],
          ['cancel', 'Cancelled'],
          ['blocked', 'Blocked'],
          ['not_paid', 'Not Paid'],
          ['partial', 'Partially Paid'],
          ['in_payment', 'In Payment'],
          ['paid', 'Paid'],
          ['reversed', 'Reversed'],
          ['unavailable', 'Unavailable'],
        ],
        badge: {
          draft: 'info',
          cancel: 'danger',
          blocked: 'danger',
          posted: 'muted',
          sent: 'muted',
          not_paid: 'warning',
          partial: 'muted',
          in_payment: 'success',
          paid: 'success',
          reversed: 'success',
          unavailable: 'muted',
        },
      },
      should_be_paid: { type: 'selection', label: 'Should Be Paid', compute: (r, db) => shouldBePaid(db, r), options: [['yes', 'Yes'], ['exception', 'Exception']] },
      payment_date: { type: 'date', label: 'Paid on', readonly: true },
      fx_payment_move_id: { type: 'many2one', relation: 'account.move', label: 'Payment Entry', readonly: true },
      fx_invoice_id: { type: 'many2one', relation: 'account.move', label: 'Settlement Invoice', readonly: true },
      cash_basis_origin_move_id: { type: 'many2one', relation: 'account.move', label: 'Journal Entry', readonly: true, hidden: true },
      cash_basis_base_grid: { type: 'boolean', label: 'Cash Basis Base Grid', readonly: true, hidden: true },
      reversed_entry_id: { type: 'many2one', relation: 'account.move', label: 'Reversal of', readonly: true },
      deferred_adjustment_of_id: { type: 'many2one', relation: 'account.move', label: 'Reversal of', readonly: true, hidden: true },
      // Set by fiscal closing and exchange revaluation only.
      is_closing: { type: 'boolean', label: 'Closing Entry', readonly: true, hidden: true },
      revaluation_date: { type: 'date', label: 'Revaluation Date', readonly: true },
      deferral_date: { type: 'date', label: 'Deferral Date', readonly: true },
      deferral_kind: { type: 'selection', label: 'Deferral Kind', readonly: true, options: [['revenue', 'Deferred Revenue'], ['expense', 'Deferred Expense']] },
      is_deferred_grouped: { type: 'boolean', label: 'Grouped Deferral Entry', readonly: true, hidden: true },
      reversal_move_id: { type: 'many2one', relation: 'account.move', label: 'Reversal Entry', readonly: true },
      auto_reverse: { type: 'boolean', label: 'Reverse Automatically' },
      reverse_date: { type: 'date', label: 'Reversal Date' },
      reverse_journal_id: { type: 'many2one', relation: 'account.journal', label: 'Reversal Journal' },
      correction_of_id: { type: 'many2one', relation: 'account.move', label: 'Correction of', readonly: true },
      // Set by the Debit Note action: the issued document this debit note adds charges to.
      debit_origin_id: { type: 'many2one', relation: 'account.move', label: 'Debit Note of', readonly: true },
      intercompany_move_id: { type: 'many2one', relation: 'account.move', label: 'Inter-company Document', readonly: true },
      sale_id: { type: 'many2one', relation: 'sale.order', label: 'Sales Order', readonly: true },
      purchase_id: { type: 'many2one', relation: 'purchase.order', label: 'Purchase Order', readonly: true },
      inalterable_hash: { type: 'char', label: 'Inalterability Hash', readonly: true },
      inalterable_hash_version: { type: 'integer', label: 'Hash Version', readonly: true, hidden: true },
      secure_sequence_number: { type: 'integer', label: 'Inalterability Sequence Number', readonly: true },
      incoterm_id: { type: 'many2one', relation: 'account.incoterm', label: 'Incoterm', domain: (r) => r.active !== false },
      incoterm_location: { type: 'char', label: 'Incoterm Location' },
      exclude_from_followup: { type: 'boolean', label: 'Exclude from Follow-up' },
      auto_post: {
        type: 'selection',
        label: 'Auto-post',
        options: [
          ['no', 'No'],
          ['at_date', 'At Date'],
          ['monthly', 'Monthly'],
          ['quarterly', 'Quarterly'],
          ['yearly', 'Yearly'],
        ],
      },
      auto_post_until: { type: 'date', label: 'Repeat Until' },
      auto_post_origin_id: { type: 'many2one', relation: 'account.move', label: 'Recurring Origin', readonly: true },
      narration: { type: 'text', label: 'Terms and Conditions' },
    },
    defaults: () => ({ name: '/', move_type: 'out_invoice', state: 'draft', invoice_date: today(), auto_post: 'no', invoice_line_ids: [], line_ids: [], amount_paid: 0 }),
    createDefaults: (db, vals = {}) => {
      if ((vals.move_type ?? 'out_invoice') !== 'entry') {
        const salesperson = vals.invoice_user_id == null ? currentUserId(db) : null;
        return salesperson ? { invoice_user_id: salesperson } : {};
      }
      const date = vals.date ?? vals.invoice_date ?? today();
      const companyId = vals.company_id ?? db?.settings?.current_company_id ?? 1;
      const defaultJournal = vals.journal_id == null ? resolveDocumentJournal(db, { move_type: 'entry', company_id: companyId })?.id ?? null : null;
      return {
        ...(vals.date == null ? { date } : {}),
        ...(vals.invoice_date == null ? { invoice_date: date } : {}),
        ...(defaultJournal ? { journal_id: defaultJournal } : {}),
      };
    },
    searchFields: INVOICE_SEARCH_FIELDS,
    filters: invoiceSearchFilters({ purchases: true }),
    groupBys: INVOICE_GROUP_BYS,
    groupByLabels: INVOICE_GROUP_BY_LABELS,
    views: ['list', 'kanban', 'graph', 'pivot', 'calendar'],
    kanban: { title: 'name', lines: ['partner_id', 'amount_total', 'invoice_date_due'], badge: 'payment_state' },
    list: ['name', 'partner_id', 'invoice_date', 'invoice_date_due', 'amount_untaxed', 'amount_total', 'amount_residual', 'status_in_payment'],
    listDecoration: invoiceListDecoration,
    graph: { groupBy: 'invoice_date', measure: 'amount_total' },
    pivot: { row: 'partner_id', col: 'payment_state', measure: 'amount_total' },
    calendar: { date: 'invoice_date_due' },
    form: {
      statusbar: 'state',
      statusbarHide: ['cancel'],
      lockedWhen: (r) => r.state !== 'draft' || Boolean(r.inalterable_hash),
      smart: [
        {
          label: 'Reversal Entries',
          when: (r, db) => r.move_type === 'entry' && moveReversalEntries(db, r).length > 0,
          value: (db, r) => moveReversalEntries(db, r).length,
          target: (r) => `accounting/entries?view=list&rel=reversed_entry_id:${r.id}`,
        },
        {
          label: 'Reversed Entry',
          when: (r) => r.move_type === 'entry' && Boolean(r.reversed_entry_id),
          value: () => '',
          target: (r) => `accounting/entries/${r.reversed_entry_id}`,
        },
        {
          label: 'Payments',
          when: (r, db) => r.move_type === 'entry' && movePayments(db, r).length > 0,
          value: (db, r) => movePayments(db, r).length,
          target: (r, db) => {
            const list = movePayments(db, r);
            if (list.length === 1) return `${list[0].partner_type === 'supplier' ? 'accounting/vendor-payments' : 'accounting/payments'}/${list[0].id}`;
            return `${list.every((p) => p.partner_type === 'supplier') ? 'accounting/vendor-payments' : 'accounting/payments'}?view=list&rel=move_id:${r.id}`;
          },
        },
        {
          label: 'Reconciled items',
          when: (r, db) => r.move_type === 'entry' && Boolean(r.id) && r.state === 'posted' && reconciledJournalItems(db, r).some((l) => l.reconciled),
          value: () => '',
          target: (r) => `accounting/journal-items?reconciled_of=${r.id}`,
        },
        {
          label: 'Adjusting Entries',
          when: (r, db) => r.move_type === 'entry' && moveAdjustingEntries(db, r).length > 0,
          value: (db, r) => moveAdjustingEntries(db, r).length,
          target: (r) => `accounting/entries?view=list&rel=deferred_adjustment_of_id:${r.id}`,
        },
        {
          label: 'Deferrals',
          when: (r, db) => r.move_type === 'entry' && moveDeferrals(db, r).length > 0,
          value: (db, r) => moveDeferrals(db, r).length,
          target: (r, db) => {
            const list = moveDeferrals(db, r);
            return list.length === 1 ? `accounting/deferrals/${list[0].id}` : `accounting/deferrals?view=list&rel=move_id:${r.id}`;
          },
        },
        {
          label: 'Tax Return',
          when: (r, db) => r.move_type === 'entry' && Boolean(closingTaxReturn(db, r)),
          value: () => '',
          target: (r, db) => `accounting/tax-returns/${closingTaxReturn(db, r).id}`,
        },
        {
          label: 'Bank transaction',
          when: (r, db) => r.move_type === 'entry' && Boolean(bankStatementLineForMove(db, r)),
          value: () => '',
          target: (r, db) => `accounting/bank/${bankStatementLineForMove(db, r).id}`,
        },
      ],
      buttons: [
        { label: 'Confirm', primary: true, when: (r) => r.state === 'draft', visible: (r) => isInvoice(r), run: (db, r) => ({ db: postMove(db, r.id) }) },
        { label: 'Post', primary: true, when: (r) => r.move_type === 'entry' && r.state === 'draft', run: (db, r) => ({ db: postMove(db, r.id) }) },
        {
          label: 'Reverse Entry',
          when: (r, db) => r.state === 'posted' && r.move_type === 'entry' && (!r.reversal_move_id || (db?.records['account.move'] ?? []).some((m) => m.id === r.reversal_move_id && m.state === 'cancel')) && !(db?.records['account.move'] ?? []).some((m) => m.state === 'posted' && m.reversed_entry_id === r.id) && !(db && settlingEntries(db).has(r.id)),
          wizard: (db, r) => ({
            title: 'Reverse Entry',
            fields: [
              { name: 'date', type: 'date', label: 'Reversal Date', required: true, default: today() },
              { name: 'journal_id', type: 'many2one', relation: 'account.journal', label: 'Use Specific Journal', default: r.journal_id ?? null, domain: (j) => !j.company_id || j.company_id === (r?.company_id ?? 1) },
              { name: 'mode', type: 'selection', label: 'Reversal Mode', options: [['reverse', 'Reverse'], ['modify', 'Reverse and Create Draft']], default: 'reverse' },
              { name: 'reason', type: 'char', label: 'Reason', default: '' },
            ],
          }),
          run: (db, r, values = {}) => {
            if (settlingEntries(db).has(r.id)) throw new Error('A settlement entry cannot be reversed directly');
            if ((db.records['account.asset'] ?? []).some((a) => (a.depreciation_ids ?? []).some((l) => l.posted && l.move_id === r.id))) {
              return { db: reverseDepreciation(db, r, values) };
            }
            return reverseEntry(db, r, values);
          },
        },
        {
          label: 'Apply Outstanding Credit',
          when: (r, db) => outstandingPaymentCredits(db, r).length > 0,
          wizard: (db, r) => ({
            title: 'Apply Outstanding Credit',
            fields: [
              {
                name: 'payment_id',
                type: 'many2one',
                relation: 'account.payment',
                label: 'Outstanding Payment',
                required: true,
                domain: (p) => isOutstandingCreditFor(db, r, p),
              },
              { name: 'date', type: 'date', label: 'Application Date', default: today(), required: true },
            ],
          }),
          run: (db, r, values = {}) => {
            if (!values.payment_id) throw new Error('Select a payment to apply credit from');
            return { db: applyPaymentCredit(db, values.payment_id, r.id, values.date) };
          },
        },
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
        {
          label: 'Register Payment', primary: true, when: (r) => r.state === 'posted' && isInvoice(r) && paymentState(r) !== 'paid',
          wizard: (db, r) => ({
            title: 'Register Payment',
            fields: [
              { name: 'amount', type: 'monetary', label: 'Payment Amount', required: true, default: String(roundCurrency(residual(r, db) - discountAvailable(db, r), documentCurrency(db, r))) },
              { name: 'date', type: 'date', label: 'Payment Date', required: true, default: today() },
              { name: 'journal_id', type: 'many2one', relation: 'account.journal', label: 'Payment Journal', required: true, default: null, domain: (j) => (!j.company_id || j.company_id === (r.company_id ?? 1)) && isLiquidityJournal(j) },
            ],
          }),
          run: registerPayment,
        },
        { label: 'Send by Email', email: 'document', when: (r) => r.state === 'posted' && isInvoice(r), run: (db) => ({ db }) },
        {
          label: 'Credit Note',
          when: (r) => r.state === 'posted' && ['out_invoice', 'in_invoice'].includes(r.move_type),
          wizard: (db, r) => ({
            title: 'Credit Note',
            fields: [
              { name: 'refund_method', type: 'selection', label: 'Credit Method', required: true, options: [['refund', 'Partial Refund'], ['cancel', 'Full Refund'], ['modify', 'Full Refund and New Draft Invoice']], default: 'refund' },
              { name: 'reason', type: 'char', label: 'Reason Displayed on Credit Note', default: '' },
              { name: 'date', type: 'date', label: 'Reversal Date', required: true, default: today() },
              { name: 'journal_id', type: 'many2one', relation: 'account.journal', label: 'Use Specific Journal', default: r.journal_id ?? null, domain: (j) => (!j.company_id || j.company_id === (r?.company_id ?? 1)) && j.type === (isPurchase(r) ? 'purchase' : 'sale') },
            ],
          }),
          run: creditNote,
        },
        {
          label: 'Debit Note',
          when: (r) => r.state === 'posted' && ['out_invoice', 'in_invoice'].includes(r.move_type),
          wizard: (db, r) => ({
            title: 'Debit Note',
            fields: [
              { name: 'copy_lines', type: 'boolean', label: 'Copy Lines', default: true },
              { name: 'reason', type: 'char', label: 'Reason Displayed on Debit Note', default: '' },
              { name: 'date', type: 'date', label: 'Debit Note Date', required: true, default: today() },
              { name: 'journal_id', type: 'many2one', relation: 'account.journal', label: 'Use Specific Journal', default: r.journal_id ?? null, domain: (j) => (!j.company_id || j.company_id === (r?.company_id ?? 1)) && j.type === (isPurchase(r) ? 'purchase' : 'sale') },
            ],
          }),
          run: debitNote,
        },
        { label: 'Correct Credit Note', when: (r) => r.state === 'posted' && isRefund(r), run: correctCreditNote },
        { label: 'Print', when: (r) => r.state === 'posted' && isInvoice(r), run: (db, r) => ({ db, go: `#/print/account.move/${r.id}` }) },
        { label: 'Reset to Draft', when: (r, db) => canResetMove(r, db), run: (db, r) => ({ db: removeAnalytic(write(db, 'account.move', r.id, { state: 'draft', ...(isInvoice(r) ? { line_ids: [] } : {}) }), r.id) }) },
        { label: 'Lock', when: canLockEntry, run: (db, r) => ({ db: secureEntries(db, { throughMoveId: r.id }) }) },
        { label: 'Cancel Entry', when: (r) => r.move_type === 'entry' && r.state === 'draft' && Boolean(r.id) && !r.inalterable_hash, run: cancelMove },
        { label: 'Cancel', when: (r) => r.state === 'draft' && !r.inalterable_hash, visible: (r) => isInvoice(r), run: cancelMove },
      ],
      ribbon: (r) => (r.state === 'cancel' ? 'Cancelled' : paymentState(r) === 'paid' ? 'Paid' : paymentState(r) === 'partial' ? 'Partial' : null),
      subtitle: (r) => ({ in_invoice: 'Vendor Bill', in_refund: 'Vendor Refund', out_refund: 'Credit Note', entry: 'Journal Entry' })[r.move_type] ?? 'Customer Invoice',
      title: 'name',
      // Evaluated for the record on screen only: it scans the partner's receivables or vendor bill duplicates.
      warning: (r, db) => (r.move_type === 'out_invoice' ? creditWarning(db, r.partner_id, r.state === 'posted' ? 0 : total(r, db), r) : r.move_type === 'in_invoice' ? duplicateBillWarning(db, r) : unbalancedEntryWarning(db, r)),
      groups: (r) => (isInvoice(r)
        ? [
          [{ field: 'partner_id', label: isPurchase(r) ? 'Vendor' : 'Customer' }],
          [
            { field: 'invoice_date', label: 'Invoice Date' },
            { label: 'Due Date', fields: ['invoice_date_due', 'invoice_payment_term_id'], join: 'or' },
            'journal_id',
            'currency_id',
          ],
        ]
        : [
          ['ref'],
          ['date', 'journal_id'],
        ]),
      tabs: (r) => (isInvoice(r)
        ? [
          { label: 'Invoice Lines', fields: ['invoice_line_ids'], aside: ['narration'] },
          { label: 'Journal Items', fields: ['line_ids'], readonly: true },
          { label: 'Payments', fields: ['payments'], readonly: true },
          {
            label: 'Other Info',
            groups: [
              {
                title: 'Invoice',
                fields: [
                  { field: 'ref', label: isPurchase(r) ? 'Bill Reference' : 'Customer Reference' },
                  'partner_bank_id',
                  'payment_reference',
                ],
              },
              {
                title: 'Accounting',
                fields: [
                  'incoterm_id',
                  'incoterm_location',
                  'fiscal_position_id',
                  'auto_post',
                  'auto_post_until',
                  'invoice_origin',
                  'intercompany_move_id',
                  'auto_reverse',
                  'reverse_date',
                  'reverse_journal_id',
                  'invoice_cash_rounding_id',
                  'payment_date',
                  'should_be_paid',
                  'inalterable_hash',
                  'secure_sequence_number',
                ],
              },
            ],
          },
        ]
        : [
          { label: 'Journal Items', fields: ['line_ids'] },
          {
            label: 'Other Info',
            groups: [
              [
                'auto_post',
                ...(['monthly', 'quarterly', 'yearly'].includes(r?.auto_post) ? [{ field: 'auto_post_until', label: 'Auto-post until' }] : []),
                ...(r?.reversed_entry_id ? ['reversed_entry_id'] : []),
                'auto_reverse',
                ...(r?.auto_reverse ? ['reverse_date', 'reverse_journal_id'] : []),
                'fiscal_position_id',
                'currency_id',
              ],
              ['narration'],
            ],
          },
        ]),
      footer: (r) => (isInvoice(r) ? ['amount_untaxed', 'amount_tax', 'amount_total', 'amount_residual'] : []),
      // The outstanding-credits widget lists unapplied payments and open credit notes and applies a chosen one.
      outstandingCredits: {
        title: 'Outstanding Credits',
        applyLabel: 'Add',
        fields: [
          { name: 'name', label: 'Payment' },
          { name: 'date', label: 'Paid on' },
          { name: 'unapplied', label: 'Available Credit', money: true },
        ],
        list: (db, r) => outstandingCredits(db, r),
        apply: (db, r, creditId) => {
          if (typeof creditId === 'string' && creditId.startsWith('move:')) {
            const noteId = Number(creditId.slice(5));
            const note = read(db, 'account.move', noteId);
            const appDate = [today(), r.invoice_date, note?.invoice_date].filter(Boolean).sort().at(-1);
            return { db: applyCreditNote(db, noteId, r.id, appDate) };
          }
          return { db: applyPaymentCredit(db, creditId, r.id, today()) };
        },
      },
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
      name: {
        type: 'char',
        label: 'Name',
        required: true,
        help: 'Incoterms are series of sales terms. They are used to divide transaction costs and responsibilities between buyer and seller and reflect state-of-the-art transportation practices.',
      },
      code: { type: 'char', label: 'Code', required: true, help: 'Incoterm Standard Code' },
      active: { type: 'boolean', label: 'Active', help: 'By unchecking the active field, you may hide an INCOTERM you will not use.' },
      display_name: { type: 'char', label: 'Display Name', compute: (r) => (r.code && r.name ? `${r.code} - ${r.name}` : r.code || r.name || '') },
    },
    defaults: () => ({ active: true }),
    views: ['list'],
    list: ['code', 'name'],
    searchFields: ['name'],
    form: {
      title: 'name',
      hideTitle: true,
      groups: [['name', 'code']],
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
      member_return_type_ids: {
        type: 'one2many',
        label: 'Member Return Types',
        fields: {
          company_id: { type: 'many2one', relation: 'res.company', label: 'Company', required: true },
          type_id: { type: 'many2one', relation: 'account.return.type', label: 'Return Type', required: true },
        },
        newLine: () => ({ company_id: null, type_id: null }),
      },
    },
    defaults: () => ({ company_ids: [], member_return_type_ids: [] }),
    guard: (db, before, after) => {
      const companies = Array.isArray(after.company_ids) ? after.company_ids : [];
      const unitReturns = (db.records['account.return'] ?? []).filter((ret) => ret.tax_unit_id === (after.id ?? before?.id));
      const submittedReturns = unitReturns.filter((ret) => ['submitted', 'paid'].includes(ret.state));
      if (before && submittedReturns.length) {
        if (JSON.stringify([...new Set(before.company_ids ?? [])].sort()) !== JSON.stringify([...new Set(companies)].sort())) return 'Cannot change companies of a tax unit with submitted returns';
        if (before.main_company_id !== after.main_company_id) return 'Cannot change main company of a tax unit with submitted returns';
        if (JSON.stringify(before.member_return_type_ids ?? []) !== JSON.stringify(after.member_return_type_ids ?? [])) return 'Cannot change member return types of a tax unit with submitted returns';
      }
      if (new Set(companies).size < 2) return 'A tax unit must contain at least 2 companies';
      if (!after.main_company_id || !companies.includes(after.main_company_id)) return 'The main company must be one of the tax unit companies';
      if (companies.some((id) => !read(db, 'res.company', id))) return 'Select existing companies';
      const mainTypes = unitReturns.map((ret) => read(db, 'account.return.type', ret.type_id)).filter(Boolean);
      const { error } = taxUnitMemberTypeValidation(db, after, mainTypes);
      if (error) return error;
      return null;
    },
    list: ['name', 'country', 'vat', 'main_company_id'],
    form: {
      title: 'name',
      groups: [['name', 'country', 'vat'], ['main_company_id', 'company_ids']],
      tabs: [{ label: 'Member Return Types', fields: ['member_return_type_ids'] }],
    },
  },

  'account.account.tag': {
    label: 'Account Tags',
    guard: (db, before, after) => {
      if (!before || before.applicability === after.applicability) return null;
      const inAccounts = (db.records['account.account'] ?? []).some((r) => (r.tag_ids ?? []).includes(after.id));
      const inTaxes = (db.records['account.tax'] ?? []).some((r) =>
        [...(r.invoice_repartition_line_ids ?? []), ...(r.refund_repartition_line_ids ?? [])].some((l) => (l.tag_ids ?? []).includes(after.id)),
      );
      return inAccounts || inTaxes ? 'A tag in use cannot change applicability' : null;
    },
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
      active: { type: 'boolean', label: 'Active', help: 'Set active to false to hide the Account Tag without removing it.' },
      country: { type: 'char', label: 'Country', help: 'Country for which this tag is available, when applied on taxes.' },
      balance_negate: { type: 'boolean', label: 'Negate Balance' },
    },
    defaults: () => ({ applicability: 'accounts', active: true, balance_negate: false, color: 0 }),
    views: ['list'],
    list: ['name', 'applicability', 'country', 'color'],
    searchFields: ['name'],
    form: {
      title: 'name',
      hideTitle: true,
      groups: (r) => [
        ['name', 'applicability', ...(r?.applicability === 'taxes' ? ['country'] : [])],
        ['cash_flow_activity'],
      ],
    },
  },

  'account.asset.model': {
    label: 'Depreciation Models',
    guard: (db, before, after, ctx) => {
      if (before && before.company_id !== after.company_id && after.company_id
        && (db.records['account.account'] ?? []).some((a) => a.asset_model_id === after.id && a.company_id && a.company_id !== after.company_id)) {
        return 'Asset model must belong to the account company';
      }
      return assetAccountGuard(db, before, after, ctx);
    },
    fields: {
      name: { type: 'char', label: 'Model Name', required: true },
      company_id: { type: 'many2one', relation: 'res.company', label: 'Company' },
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
      account_depreciation_expense_id: { type: 'many2one', relation: 'account.account', label: 'Depreciation Expense Account' },
      account_expense_id: { type: 'many2one', relation: 'account.account', label: 'Legacy Expense Account', readonly: true, compute: (r) => r.account_depreciation_expense_id ?? null },
      journal_id: { type: 'many2one', relation: 'account.journal', label: 'Journal' },
      analytic_distribution: { type: 'distribution', label: 'Analytic Distribution' },
    },
    defaults: () => ({ method: 'linear', method_number: 5, method_period: '12', method_progress_factor: 0.3, prorata: false }),
    list: ['name', 'method', 'method_number', 'method_period', 'account_asset_id', 'account_depreciation_id', 'account_depreciation_expense_id'],
    form: {
      title: 'name',
      groups: [
        ['name', 'company_id', 'journal_id', 'account_asset_id', 'account_depreciation_id', 'account_depreciation_expense_id'],
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
