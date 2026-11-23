import { purchaseLineId } from './purchase-links.js';
import { create, postNote, read, search, unlink, write } from '../orm.js';
import { addDays, amounts, companyRoundingMethod, invoiceTaxAmount, monthFilters, nextName, productLines, promptedAmount, sameCommercialPartner, shiftMonth, today, total, validDate, withTaxIds } from './common.js';
import { ACCOUNT_TYPES, accountBalance, analyticEligibleAccount, badCurrencyAmountSign, badLineSign, defaultPaymentJournalId, exchangeJournal, historicalOriginAccounts, invoiceCounterpartAccount, invoiceLineAccount, invoiceLineOriginalAccount, invoiceLines, isBalanced, isIncomeOrExpenseAccount, isLiquidityJournal, isOnlineFeedJournal, isPaymentMatched, journalItems, mapLineAccount, outstandingAccount, paymentJournal, paymentName, postEntry, postedBillLine, reconciledJournalItems, resolveCompanyAccount, resolveDocumentJournal, reversalLine, valueOnlyCurrencyFields } from './ledger.js';
import { currentActor, employeeFor } from './authority.js';
import { bookedByBank, creditNotePairError, creditWarning, duplicateBillWarning, accountDeleteGuard, accountCurrencyChangeError, isExchangeEntry, lockedSettlementInvariant, fxProvenanceError, moveDate, moveDeleteGuard, moveGuard, moveInvariant, recordLockDate, taxUnitMemberTypeValidation } from './finance.js';
import { applyPaymentCredit, paymentDocuments, reconcileReversalLines, registerPayments, reverseEntry, SETTLES, unreconcileInvoicePayment } from './pay.js';
import { conversionRate, rateAt, toCompany } from './currency.js';
import { bookedStatementAmount, eligibleCounterpart } from './bank.js';
import { cashRoundingApplies, cashRoundingError, configuredAccount } from './configured-account.js';
import { accountDefaultTaxIds, accountTax, cashBasisTransitionAccount, cashBasisGroups, computeLineTaxes, entryTaxRepartitionSide, expandTaxIds, fiscalPositionFor, isLegacyCashBasisRelease, isSectionOrNote, lineTaxIds, mapAccount, productTax, replaceTaxSnapshot, sameTaxIds, taxBaseTags, taxLabel, taxRepartitionSplits, taxSnapshot, validateTaxCompany } from './taxes.js';
import { discountTaxComputation, dueDate, earlyDiscount } from './terms.js';
import { downPaymentOvercommitted, refreshAdvanceDeductions, syncInvoicedQty } from './sales.js';
import { checkMandatoryPlans, defaultDistributionForLine, distributionOfLine, findAnalyticDistribution, normalizeDistribution, postAnalytic, removeAnalytic, syncDeferredAnalyticDistribution } from './analyticplus.js';
import { billableLines, checkBillMatch, priceDifferenceLines, shouldBePaid } from './billcontrol.js';
import { companyCurrencyRecord, documentCurrency, findCompanyCurrencyRecord, roundCurrency, round as round2 } from '../money.js';
import { hasMultiCurrency } from './money.js';
import { settlementCompanyAmount } from './settlement.js';
import { analyzeJournalChains, secureEntries, secureMoveInvariant, secureHeadsGuard, postedBeforeSecuredChain, SECURED_ORDER_ERROR } from './hash_chain.js';
import { t } from '../i18n.js';
import { adjustInvoiceDeferralsForCreditNote, createInvoiceDeferrals, deferralLinksMove, registerDeferredPostMoveHook, reverseInvoiceDeferrals, revertInvoiceDeferralCreditAdjustment, syncDeferralOnMoveStateChange, validateInvoiceDeferralCredit } from './deferred.js';
import { isEligibleRecipientBank, resolveAndValidateRecipientBank } from './partnerbank.js';
import { exchangeAccount } from './exchange-account.js';
import { ASSET_DEPRECIATION_DEFAULTS, adjustAssetsForCreditNote, assetAccountGuard, assetProrataComputation, confirmAsset, defaultProrataDate, syncMethodRateAndDuration } from './assets.js';
import { productProperty } from './productconfig-helpers.js';
import { currentCompany, recipientBankCompanyError } from './company.js';
import { openActivitiesText } from './mail.js';
import { onlineAccountForJournal } from './onlineSync.js';
import { openingAmounts, setOpeningBalance } from './opening.js';
import { DEFAULT_SEPA_PAIN_VERSION, SEPA_PAIN_VERSIONS, isValidSepaPainVersion } from './sepa.js';
import {
  computeJournalMethodLines,
  defaultJournalLinesForForm,
  defaultNewJournalMethodLine,
  defaultPaymentMethodLineId,
  isMethodLineJournal,
  journalMethodLineGuard,
  METHOD_LINE_FIELDS,
  methodLineAccountDomain,
  methodLineOnchange,
  protectMethodLineDelete,
  syncJournalMethodLines,
  unlinkJournalMethodLines,
} from './paymentmethod.js';

export { invoiceTaxAmount, isLegacyCashBasisRelease, total, applyPaymentCredit, computeEntryTaxLines, refreshDraftEntryTaxes };

function invoiceCompanyDefaults(db, move, previous, context = {}) {
  const company = read(db, 'res.company', move.company_id);
  const oldCompany = previous?.company_id ? read(db, 'res.company', previous.company_id) : null;
  const termsEligible = ['out_invoice', 'out_refund'].includes(move.move_type);
  const result = {};

  const isEdited = (field) => {
    if (!context?.editedFields) return false;
    if (context.editedFields instanceof Set) return context.editedFields.has(field);
    if (Array.isArray(context.editedFields)) return context.editedFields.includes(field);
    return Object.hasOwn(context.editedFields, field);
  };

  const oldTerms = oldCompany?.use_invoice_terms ? (oldCompany.invoice_terms ?? '') : null;
  const termsUntouched = context?.editedFields ? !isEdited('narration') : (move.narration === undefined || (previous && oldTerms !== null && move.narration === oldTerms));

  if (termsEligible && termsUntouched) {
    if (company?.use_invoice_terms) result.narration = company.invoice_terms ?? '';
    else if (previous) result.narration = '';
  }

  const companyIncoterm = company?.incoterm_id ? read(db, 'account.incoterm', company.incoterm_id) : null;
  const companyIncotermId = companyIncoterm && companyIncoterm.active !== false ? companyIncoterm.id : null;
  const incotermUntouched = context?.editedFields ? !isEdited('incoterm_id') : (move.incoterm_id === undefined || (previous && oldCompany?.incoterm_id != null && move.incoterm_id === oldCompany.incoterm_id));

  if (move.move_type === 'out_invoice' && incotermUntouched) {
    if (companyIncotermId != null) result.incoterm_id = companyIncotermId;
    else if (previous) result.incoterm_id = null;
  }
  return result;
}
export const includeInitialBalance = (account) => !['income', 'income_other', 'expense', 'expense_depreciation', 'expense_direct_cost', 'expense_other', 'off_balance'].includes(account?.account_type);
const canBeNonTrade = (account) => ['asset_receivable', 'liability_payable'].includes(account?.account_type);

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
/** Whether a move is a customer credit note or vendor refund. */
export const isRefund = (r) => ['out_refund', 'in_refund'].includes(r?.move_type);
export const isPurchase = (r) => ['in_invoice', 'in_refund'].includes(r?.move_type);
/** Money comes in for customer invoices and vendor refunds, goes out for bills and credit notes. */
export const isInbound = (r) => ['out_invoice', 'in_refund'].includes(r?.move_type);
const recipientBankDomain = (b, r, db) => {
  if (b.active === false) return false;
  const companyId = r?.company_id ?? db?.settings?.current_company_id ?? 1;
  if (b.company_id && b.company_id !== companyId) return false;
  if (isInbound(r)) {
    const companyPartnerId = db ? read(db, 'res.company', companyId)?.partner_id : null;
    return Boolean(b.partner_id && companyPartnerId && b.partner_id === companyPartnerId);
  }
  return !b.partner_id || (db ? sameCommercialPartner(db, b.partner_id, r?.partner_id) : b.partner_id === r?.partner_id);
};
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
/** Payment status (`paid`, `partial`, `not_paid`, or `unavailable`) of an invoice or bill. */
export const paymentState = (r, db) => {
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
  const side = ['out_refund', 'in_refund'].includes(r.move_type) ? 'refund' : 'invoice';
  return amounts(r.invoice_line_ids, curr, { roundingMethod: companyRoundingMethod(db, r?.company_id), side }).untaxed;
};

/** Sign a document-currency amount with the same inbound/outbound convention as signedCompanyTotal, avoiding -0. */
const signedDocumentAmount = (r, value) => {
  if (value == null) return null;
  if (value === 0) return 0;
  if (!r || r.move_type === 'entry' || !r.move_type) return value;
  return (isInbound(r) ? 1 : -1) * value;
};

const moveByIdCache = new WeakMap();
const paymentByMoveCache = new WeakMap();

/** Build and cache a Map over an immutable records array once per array instance. */
const recordIndex = (cache, records, keyOf) => {
  if (!records?.length) return null;
  let index = cache.get(records);
  if (!index) {
    index = new Map();
    for (const rec of records) {
      const key = keyOf(rec);
      if (key != null) index.set(key, rec);
    }
    cache.set(records, index);
  }
  return index;
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
      const moveById = recordIndex(moveByIdCache, db.records?.['account.move'], (m) => m.id);
      const paymentByMove = recordIndex(paymentByMoveCache, db.records?.['account.payment'], (p) => p.move_id || null);
      const allReversals = active.every((p) => {
        const m = moveById?.get(p.move_id);
        return m && isRefund(m) && m.reversed_entry_id === r.id;
      });
      if (allReversals) return 'reversed';
      const hasOutstanding = active.some((p) => {
        const payment = paymentByMove?.get(p.payment_move_id ?? p.move_id);
        return payment && payment.state === 'posted' && payment.outstanding_account_id && !isPaymentMatched(db, payment);
      });
      if (hasOutstanding) return 'in_payment';
    }
    return 'paid';
  }
  if (db && ['exception', 'no'].includes(shouldBePaid(db, r))) return 'blocked';
  return payState;
};
const money = (n) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

/** Ids of the entries that settle invoices (payments, early-payment discounts, and reconciliation exchange entries). */
export const settlingEntries = (db) => {
  const moves = db.records['account.move'] ?? [];
  const partials = db.records['account.partial.reconcile'] ?? [];
  const fromPayments = moves.flatMap((m) => (m.payments ?? []).flatMap((p) => [p.move_id, p.payment_fx_move_id]));
  const fromGl = partials.filter((g) => g && g.active !== false && !g.reversed).flatMap((g) => [g.debit_move_id, g.credit_move_id, g.exchange_move_id]);
  const fromFx = moves.filter((m) => m.move_type === 'entry' && m.fx_payment_move_id && m.fx_invoice_id).map((m) => m.id);
  return new Set([...fromPayments, ...fromGl, ...fromFx].filter(Boolean));
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
  'deferral_date', 'deferral_kind', 'deferred_entry_type', 'is_deferred_grouped', 'deferred_contributions', 'force_post',
  'intercompany_move_id', // each occurrence gets its own counterpart bill (Qodo 6)
  'to_check', // a review flag belongs to the reviewed entry only
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
    return postMove(db, moveId, { autoPost: true });
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
    const mappedAccountId = mapLineAccount(db, { fiscal_position_id: fpId }, rawAccount.id);
    const account = read(db, 'account.account', mappedAccountId);
    if (!account || (account.company_id && account.company_id !== buyer.id)) {
      throw new Error(`Configure an expense account for ${product.name}`);
    }
    const sourceUntaxed = !line.tax_id && !line.tax_ids?.length && !(Number(line.tax) || 0);
    let tax;
    try {
      tax = productTax(db, product, 'purchase', fpId, buyer.id);
      if (sourceUntaxed && !tax?.tax_id && !tax?.tax_ids?.length) tax = { tax: 0 };
      if (tax?.tax_id) validateTaxCompany(db, [tax.tax_id, ...(tax.tax_ids ?? [])], buyer.id);
    } catch {
      throw new Error(`Configure purchase taxes for ${buyer.name} on ${product.name}`);
    }
    return {
      name: line.name,
      product_id: line.product_id,
      qty: line.qty,
      price_unit: line.price_unit,
      discount: line.discount,
      account_id: account.id,
      account_fiscal_position_id: fpId ?? null,
      ...(tax ?? { tax: 0 }),
    };
  });
  const original = move.move_type === 'out_refund' && move.reversed_entry_id ? read(db, 'account.move', move.reversed_entry_id) : null;
  const originalBill = original?.intercompany_move_id && read(db, 'account.move', original.intercompany_move_id);
  if (originalBill && (originalBill.move_type !== 'in_invoice' || originalBill.company_id !== buyer.id || originalBill.intercompany_move_id !== original.id)) {
    throw new Error('The original inter-company bill link is invalid');
  }
  return { company_id: buyer.id, move_type: move.move_type === 'out_invoice' ? 'in_invoice' : 'in_refund', partner_id: seller.partner_id, journal_id: journal.id, invoice_date: move.invoice_date, invoice_date_due: move.invoice_date_due ?? move.invoice_date, currency_id: move.currency_id, invoice_line_ids, intercompany_move_id: move.id, ...(originalBill ? { reversed_entry_id: originalBill.id } : {}) };
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
function copyInvoiceLines(lines, {
  sourceCredit = false,
  preserveSourceLineId = false,
  months = null,
  stripOrderLinks = false,
} = {}) {
  return (lines ?? []).map((line) => {
    const sourceLineId = line.line_id;
    if (sourceCredit && (sourceLineId == null || sourceLineId === '')) {
      throw new Error('The source invoice line is missing its stable ID; update the database before creating a credit note');
    }
    const { line_id: ignoredLineId, source_line_id: ignoredSourceLineId, ...copy } = line;
    void ignoredLineId;
    void ignoredSourceLineId;

    if (stripOrderLinks) {
      delete copy.sale_line_key;
      delete copy.purchase_line_key;
      delete copy.purchase_line_id;
      delete copy.down_payment_key;
      delete copy.rental_id;
      delete copy.rental_charge;
      delete copy.sale_line_id;
    }

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
export function postMove(db, id, { autoPost = false } = {}) {
  let r = read(db, 'account.move', id);
  const scheduledDate = r?.move_type === 'entry' && r.date ? r.date : (r?.invoice_date ?? r?.date ?? today());
  if (!autoPost && r?.state === 'draft' && r.auto_post === 'at_date' && scheduledDate > today()) {
    throw new Error(t('This entry is scheduled to post automatically on {date}', { date: scheduledDate }));
  }
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
    if (r.move_type === 'entry') {
      r = { ...r, line_ids: computeEntryTaxLines(r.line_ids, r, db) };
    }
    if (r.fiscal_position_id) {
      const fp = read(db, 'account.fiscal.position', r.fiscal_position_id);
      if (fp?.company_id && fp.company_id !== (r.company_id ?? 1)) {
        throw new Error('Fiscal position belongs to another company');
      }
    }
    for (const line of r.line_ids ?? []) {
      const taxIds = (line.tax_ids ?? []).filter(Boolean);
      if (line.tax_id) taxIds.push(line.tax_id);
      if (taxIds.length) {
        validateTaxCompany(db, taxIds, r.company_id ?? 1, r.fiscal_position_id);
      }
    }
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
    if (badCurrencyAmountSign(r.line_ids)) throw new Error('The currency amount sign must match the debit/credit balance');
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
    let posted = postAnalytic(write(db, 'account.move', id, { state: 'posted', name, journal_id: journal, line_ids }), id);
    if (r.reversed_entry_id && !isExchangeEntry(posted, id) && !r.reconciliation_reversal) {
      const source = read(posted, 'account.move', r.reversed_entry_id);
      if (source?.state === 'posted') {
        posted = reconcileReversalLines(posted, source.id, id, r.date ?? entryDate);
      }
    }
    let reversed = posted;
    let revMove = null;
    if (r.auto_reverse) {
      const revResult = reverseEntry(posted, read(posted, 'account.move', id), r.reverse_date, {
        journal_id: r.reverse_journal_id ?? r.journal_id,
        scheduled: r.reverse_date > today(),
      });
      reversed = revResult.db;
      revMove = read(reversed, 'account.move', revResult.id);
    }
    if (journalRecord.restrict_mode_hash_table) reversed = secureEntries(reversed, { throughMoveId: id });
    if (revMove && revMove.state === 'posted') {
      const revJournal = read(reversed, 'account.journal', revMove.journal_id);
      if (revJournal?.restrict_mode_hash_table) {
        reversed = secureEntries(reversed, { throughMoveId: revMove.id });
      }
    }
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
    validateTaxCompany(db, [line.tax_source_id, ...lineTaxIds(line)], r.company_id ?? 1);
  }
  checkMandatoryPlans(db, r);
  // Vendor bills are matched against the PO and receipts; price differences leave the interim account.
  const matchWarnings = checkBillMatch(db, r);
  const sequence = journalInvoiceSequence(journalRecord, r);
  const name = enteredName ?? sequence.name;
  if (postedBeforeSecuredChain(db, { ...r, state: 'posted', name, journal_id: journal }, r)) throw new Error(SECURED_ORDER_ERROR);
  if (isRefund(r) && r.reversed_entry_id) creditCheck(db, r);
  const term = r.invoice_payment_term_id ? read(db, 'account.payment.term', r.invoice_payment_term_id) : null;
  const dueDateValue = term
    ? termDue(db, { ...r, invoice_date: r.invoice_date ?? today() }).invoice_date_due
    : (r.invoice_date_due || (r.invoice_date ?? today()));
  const dueUpdate = { invoice_date_due: dueDateValue };
  const counterpart = intercompanyBill(db, { ...r, invoice_date: r.invoice_date ?? today(), ...dueUpdate });
  const { line_ids, resolvedLines } = postedInvoiceLines(db, { ...r, journal_id: journal, ...dueUpdate }, name);
  const originIds = [r.reversed_entry_id, r.debit_origin_id, r.correction_of_id].filter(Boolean);
  const paymentReferenceUpdate = !r.payment_reference?.trim() && r.move_type === 'out_invoice' && journalRecord.type === 'sale'
    ? (() => {
        const ref = computePaymentReference(db, r, journalRecord, name);
        return ref ? { payment_reference: ref } : {};
      })()
    : (!r.payment_reference?.trim() && isPurchase(r) && r.ref?.trim()
        ? { payment_reference: r.ref.trim() }
        : {});
  let posted = postAnalytic(write(db, 'account.move', id, { state: 'posted', name, journal_id: journal, ...paymentReferenceUpdate, ...dueUpdate, line_ids, invoice_line_ids: resolvedLines }, originIds.length ? { archivedOriginIds: originIds } : {}), id);
  if (counterpart) {
    const bill = create(posted, 'account.move', counterpart);
    posted = write(bill.db, 'account.move', id, { intercompany_move_id: bill.id });
  }
  if (matchWarnings.length) posted = postNote(posted, 'account.move', id, `Purchase price mismatch: ${matchWarnings.map((line) => `${read(db, 'product', line.product_id)?.name ?? 'Unknown product'}, difference ${line.priceDifference}`).join('; ')}`);
  posted = write(posted, 'account.journal', journal, { [sequence.numberField]: sequence.nextNumber + 1 });
  if (journalRecord.restrict_mode_hash_table) posted = secureEntries(posted, { throughMoveId: id });
  const deferred = createInvoiceDeferrals(posted, read(posted, 'account.move', id));
  if (isRefund(r) && r.reversed_entry_id) {
    const adjusted = adjustInvoiceDeferralsForCreditNote(deferred, read(deferred, 'account.move', id), reverseEntry);
    const withAssets = adjustAssetsForCreditNote(adjusted, read(adjusted, 'account.move', id));
    return spawnRecurringMove(offsetCreditNote(withAssets, id), read(withAssets, 'account.move', id));
  }
  const withAssets = r.move_type === 'in_invoice' ? draftAssetsFromBill(deferred, read(deferred, 'account.move', id)) : deferred;
  return spawnRecurringMove(withAssets, read(withAssets, 'account.move', id));
}

registerDeferredPostMoveHook(postMove);

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
  const reversed = postEntry(db, { journal: revJournal, company: move.company_id ?? 1, date: revDate, ref, archivedOriginIds: [move.id], lines: move.line_ids.map(reversalLine) });
  const linked = postAnalytic(write(reversed.db, 'account.move', reversed.id, { reversed_entry_id: move.id }), reversed.id);
  return write(linked, 'account.asset', asset.id, { state: 'open', depreciation_ids: asset.depreciation_ids.map((l) => l.move_id === move.id ? { ...l, posted: false, move_id: null } : l) });
}

/** Reverse one posted journal entry: the action behind the form button and the list action. */
function reverseOneEntry(db, r, values = {}) {
  // A reversed entry is reconciled with its reversal, so report the reversal before the settlement.
  if (r && search(db, 'account.move').some((m) => m.state !== 'cancel' && m.reversed_entry_id === r.id)) throw new Error('This entry has already been reversed');
  if (settlingEntries(db).has(r.id)) throw new Error('A settlement entry cannot be reversed directly');
  if (search(db, 'account.asset').some((a) => (a.depreciation_ids ?? []).some((l) => l.posted && l.move_id === r.id))) {
    // Depreciation reversals reopen the board line at once, so they cannot be scheduled or turned into a new draft.
    if (String(values.date ?? '') > today() || (values.mode ?? 'reverse') !== 'reverse') {
      throw new Error('A depreciation entry is reversed immediately: use today or an earlier date and the Reverse mode');
    }
    return { db: reverseDepreciation(db, r, values) };
  }
  const scheduled = values.scheduled ?? (String(values.date ?? '') > today());
  return reverseEntry(db, r, scheduled ? { ...values, scheduled: true } : values);
}

/** Fields of the reversal wizard, shared by the single and the batch reversal. */
const reversalWizardFields = (journalId, companyId) => [
  { name: 'date', type: 'date', label: 'Reversal Date', required: true, default: today() },
  { name: 'journal_id', type: 'many2one', relation: 'account.journal', label: 'Use Specific Journal', default: journalId, domain: (j) => !j.company_id || j.company_id === companyId },
  { name: 'mode', type: 'selection', label: 'Reversal Mode', options: [['reverse', 'Reverse'], ['modify', 'Reverse and Create Draft']], default: 'reverse' },
  { name: 'reason', type: 'char', label: 'Reason', default: '' },
];

/** Reverse several entries at once; any refused entry aborts the whole batch, since nothing is committed until the end. */
export function reverseEntries(db, ids, values = {}) {
  const createdIds = [];
  const next = [...new Set(Array.isArray(ids) ? ids : [ids])].reduce((current, id) => {
    const res = reverseOneEntry(current, read(current, 'account.move', id), values);
    if (res.id) createdIds.push(res.id);
    return res.db;
  }, db);
  return { db: next, ids: createdIds };
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
export function applyCreditNote(db, noteId, invoiceId, date = null, amount = null, { lineIndex = null } = {}) {
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
  let next = appendDocumentSettlement(db, invoice.id, { amount: value, moveId: note.id, date: appDate, lineIndex }).db;
  next = appendDocumentSettlement(next, note.id, { amount: value, moveId: invoice.id, date: appDate }).db;
  // Each document booked the amount at its own date's rate: the company-currency gap is an exchange difference.
  const sale = !isPurchase(invoice);
  const gap = roundCurrency(invoicePortion - notePortion, companyCurrencyRecord(db, invoice.company_id));
  if (gap) {
    const account = invoiceCounterpartAccount(db, invoice);
    const forced = valueOnlyCurrencyFields(next, account, invoice.company_id, invoice.currency_id);
    const fxAmount = Math.abs(gap);
    // The receivable/payable balance left by the two rates is cleared against the exchange gain or loss.
    const clearsDebit = sale ? gap < 0 : gap > 0;
    const open = clearsDebit ? { account, debit: fxAmount, partner_id: invoice.partner_id, ...forced } : { account, credit: fxAmount, partner_id: invoice.partner_id, ...forced };
    const fxLines = exchangeLines(db, invoice.company_id, clearsDebit ? fxAmount : -fxAmount);
    const fxJournalId = exchangeJournal(next, invoice.company_id).id;
    const fx = postEntry(next, { journal_id: fxJournalId, journal: fxJournalId, company: invoice.company_id ?? 1, date: appDate, ref: `Exchange difference ${note.name}`, lines: [open, ...fxLines], archivedOriginIds: [invoice.id, note.id] });
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

/** Bill lines booked on an account configured to create assets generate draft or validated assets (once per bill line). */
function draftAssetsFromBill(db, bill) {
  const billAssets = (db.records['account.asset'] ?? []).filter((a) => a.bill_id === bill.id);
  const existing = billAssets.filter((a) => a.state === 'draft');
  // A line whose asset was already confirmed keeps it; reposting must not create a second one.
  const confirmedLines = new Set(billAssets.filter((a) => a.state !== 'draft').map((a) => a.bill_line));
  const retained = new Set();
  // Without a model journal, assets use the company's configured general journal.
  const defaultJournal = read(db, 'res.company', bill.company_id ?? 1)?.default_general_journal_id ?? null;
  const result = (bill.invoice_line_ids ?? []).reduce((next, line, index) => {
    const booked = postedBillLine(bill, index);
    if (!booked || booked.amount === 0 || confirmedLines.has(index)) return next;
    const account = read(next, 'account.account', booked.account);
    const model = account?.asset_model_id ? read(next, 'account.asset.model', account.asset_model_id) : null;
    // Odoo decides by the account's explicit "Create Asset" setting (a linked model without one means draft); the model supplies the values.
    const mode = account?.create_asset ?? (account?.asset_model_id ? 'draft' : 'no');
    if (mode === 'no') return next;
    const modelJournal = model?.journal_id && read(next, 'account.journal', model.journal_id)?.type === 'general' ? model.journal_id : null;
    const product = read(next, 'product', line.product_id);
    const acquisitionDate = bill.invoice_date ?? today();
    const modelComputation = model ? assetProrataComputation(model) : ASSET_DEPRECIATION_DEFAULTS.prorata_computation_type;
    const modelPeriod = model ? (model.method_period ?? '12') : ASSET_DEPRECIATION_DEFAULTS.method_period;
    const modelNumber = model ? (model.method_number ?? 5) : ASSET_DEPRECIATION_DEFAULTS.method_number;
    const values = {
      name: line.name || product?.name || bill.name, original_value: booked.amount, acquisition_date: acquisitionDate,
      partner_id: bill.partner_id, bill_id: bill.id, bill_line: index, company_id: bill.company_id ?? 1,
      account_asset_id: booked.account,
      ...(model ? {
        model_id: model.id,
        method: model.method ?? 'linear',
        method_number: modelNumber,
        method_period: modelPeriod,
        method_progress_factor: model.method_progress_factor ?? 0.3,
        method_mode: model.method_mode ?? 'duration',
        method_rate: model.method_rate ?? (Number(modelNumber) > 0 ? 1 / Number(modelNumber) : 0.2),
        prorata_computation_type: modelComputation,
        prorata_date: model.prorata_date || defaultProrataDate(acquisitionDate, modelPeriod, modelComputation),
        prorata: modelComputation !== 'none',
        account_depreciation_id: model.account_depreciation_id ?? null,
        account_depreciation_expense_id: model.account_depreciation_expense_id ?? null,
        journal_id: modelJournal ?? defaultJournal,
        analytic_distribution: model.analytic_distribution ?? null,
      } : {
        model_id: null,
        ...ASSET_DEPRECIATION_DEFAULTS,
        prorata_date: defaultProrataDate(acquisitionDate, modelPeriod, modelComputation),
        account_depreciation_id: null,
        account_depreciation_expense_id: null,
        journal_id: defaultJournal,
        analytic_distribution: null,
      }),
    };
    const asset = existing.find((a) => a.bill_line === index);
    let assetId;
    let nextDb;
    if (asset) {
      retained.add(asset.id);
      assetId = asset.id;
      nextDb = write(next, 'account.asset', asset.id, { ...values, depreciation_ids: [] });
    } else {
      const created = create(next, 'account.asset', values);
      assetId = created.id;
      nextDb = created.db;
    }
    if (mode === 'validate') {
      const assetRec = read(nextDb, 'account.asset', assetId);
      if (assetRec && assetRec.state === 'draft') {
        nextDb = confirmAsset(nextDb, assetRec);
      }
    }
    return nextDb;
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
 * Express an invoice-currency amount in the payment currency at `date`.
 * Reused by the wizard (default amount, difference) and by payMove (payValue).
 */
export function paymentCurrencyAmount(db, r, amount, date = today(), currencyId = null) {
  const invCurrId = r.currency_id ?? companyCurrencyRecord(db, r.company_id)?.id;
  const targetId = currencyId ?? invCurrId;
  if (!targetId || targetId === invCurrId) {
    return roundCurrency(amount, documentCurrency(db, r));
  }
  const rate = conversionRate(db, invCurrId, targetId, date, r.company_id);
  if (rate == null) throw new Error('Configure currency conversion rate');
  return roundCurrency(Number(amount) * rate, read(db, 'res.currency', targetId));
}

/**
 * Express an entered payment-currency amount in the invoice currency at `date`.
 * Snaps to the open amount only when converting the open amount into the payment currency gives `amount` exactly.
 */
export function invoiceCurrencyAmount(db, r, amount, date = today(), currencyId = null) {
  const invCurrId = r.currency_id ?? companyCurrencyRecord(db, r.company_id)?.id;
  const sourceId = currencyId ?? invCurrId;
  const docCurr = documentCurrency(db, r);
  if (!sourceId || sourceId === invCurrId) {
    return roundCurrency(amount, docCurr);
  }
  const rate = conversionRate(db, sourceId, invCurrId, date, r.company_id);
  if (rate == null) throw new Error('Configure currency conversion rate');
  const sourceCurr = read(db, 'res.currency', sourceId);
  const entered = roundCurrency(amount, sourceCurr);
  const openAmount = roundCurrency(residual(r, db) - discountAvailable(db, r, date), docCurr);
  if (paymentCurrencyAmount(db, r, openAmount, date, sourceId) === entered) {
    return openAmount;
  }
  return roundCurrency(Number(amount) * rate, docCurr);
}

/**
 * Record a payment: bank entry against receivable/payable, paid amount on the invoice, and a posted
 * payment record (or `paymentId`, an existing draft payment, gets posted with that entry).
 */
export function payMove(db, id, amount, date = today(), { paymentId, journalId: payJournal, statementLineId, directBank = false, liquidityAccountId = null, checkNumber, memo, currencyId, paymentAmount, partnerBankId, paymentMethodLineId, settleAmount = null, excessAmount = null } = {}) {
  const r = read(db, 'account.move', id);
  if (!Number.isFinite(Number(amount))) throw new Error('Payment amount must be finite');
  if (r?.state !== 'posted' || !isInvoice(r)) throw new Error('Only posted invoices and bills can be paid');
  const moveBankError = recipientBankCompanyError(db, r);
  if (moveBankError) throw new Error(moveBankError);
  const payRec = paymentId ? read(db, 'account.payment', paymentId) : null;
  const payBankError = recipientBankCompanyError(db, payRec);
  if (payBankError) throw new Error(payBankError);
  if (['exception', 'no'].includes(shouldBePaid(db, r))) throw new Error('Resolve or approve the three-way matching exception before registering payment');
  const invCurrId = r.currency_id ?? companyCurrencyRecord(db, r.company_id)?.id;
  const payCurrId = currencyId ?? invCurrId;
  const isForeignPayment = payCurrId !== invCurrId;
  const payCurr = isForeignPayment ? read(db, 'res.currency', payCurrId) : null;
  const payAmount = isForeignPayment
    ? (paymentAmount != null ? roundCurrency(paymentAmount, payCurr) : paymentCurrencyAmount(db, r, amount, date, payCurrId))
    : null;
  const docRound = (n) => roundCurrency(n, documentCurrency(db, r));
  const companyRound = (n) => roundCurrency(n, companyCurrencyRecord(db, r.company_id));
  amount = docRound(amount);
  const value = settleAmount != null ? docRound(settleAmount) : Math.min(amount, residual(r, db));
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
    const candidateBankId = partnerBankId ?? payRec?.partner_bank_id;
    recipientBankId = resolveAndValidateRecipientBank(db, r.partner_id, candidateBankId, {
      invoiceBankId: r.partner_bank_id,
      companyId: r.company_id ?? 1,
      allowOverride: !paymentId && partnerBankId != null,
    });
  }
  // Anything paid above the amount due stays on the partner's account as an outstanding credit.
  const excess = excessAmount != null ? docRound(excessAmount) : docRound(amount - value);
  const sale = isInbound(r);
  const counterpartCode = invoiceCounterpartAccount(db, r);
  const via = paymentJournal(db, payJournal, r.company_id ?? 1);
  const journal = read(db, 'account.journal', via.id);
  const chosenMethodLineId = paymentMethodLineId ?? null;
  const methodLineId = payRec?.payment_method_line_id ?? chosenMethodLineId ?? defaultPaymentMethodLineId(db, via.id, sale ? 'inbound' : 'outbound');
  const outstanding = directBank || liquidityAccountId ? null : outstandingAccount(db, journal, r.company_id ?? 1, sale, methodLineId);
  const liquidity = liquidityAccountId ?? outstanding ?? via.accountId;
  const allocatedPay = isForeignPayment ? paymentCurrencyAmount(db, r, value, date, payCurrId) : value;
  const payOverpayment = isForeignPayment && excess > 0
    ? roundCurrency(Math.max(0, payAmount - allocatedPay), payCurr)
    : 0;
  const extra = excess > 0
    ? (isForeignPayment
      ? (payOverpayment > 0 ? toCompany(db, payCurrId, payOverpayment, date, r.company_id) : 0)
      : companyRound(toCompany(db, r.currency_id, value + excess, date, r.company_id) - (bookedShare ?? toCompany(db, r.currency_id, value, date, r.company_id))))
    : 0;
  // Bank moves at today's rate from the entered payment amount; the receivable/payable moves at the invoice rate.
  const totalBank = bookedShare ?? (isForeignPayment
    ? toCompany(db, payCurrId, payAmount, date, r.company_id)
    : toCompany(db, r.currency_id, value + excess, date, r.company_id));
  const bank = bookedShare ?? companyRound(totalBank - extra);
  // The last payment clears exactly what is left on the receivable/payable, so no cent stays behind.
  const final = value >= residual(r, db);
  const open = settlementCompanyAmount(db, r, value);
  const diff = companyRound(sale ? bank - open : open - bank);
  const fx = exchangeLines(db, r.company_id, diff);
  const foreign = !!r.currency_id && r.currency_id !== companyCurrencyRecord(db, r.company_id)?.id;
  const foreignAmount = (value) => foreign ? { currency_id: r.currency_id, amount_currency: docRound(value) } : {};
  const liquidityForeignAmount = (sign, docVal) => liquidityForeignFields(db, {
    currencyId: journal?.currency_id ?? null,
    companyAmount: (bank + extra) * sign,
    date,
    companyId: r.company_id,
    docAmount: isForeignPayment && journal?.currency_id === payCurrId
      ? roundCurrency(sign * payAmount, payCurr)
      : (foreign && journal?.currency_id === r.currency_id ? docRound(sign * docVal) : null),
  });
  const credit = excess > 0 ? [sale ? { account: counterpartCode, credit: extra, partner_id: r.partner_id, name: 'Outstanding credit', ...foreignAmount(-excess) } : { account: counterpartCode, debit: extra, partner_id: r.partner_id, name: 'Outstanding credit', ...foreignAmount(excess) }] : [];
  const { db: withEntry, id: paymentMove } = postEntry(db, {
    journal: via.code, journal_id: journal?.id, date, ref: `Payment ${r.name}`, company: read(db, 'res.company', r.company_id ?? 1) ? (r.company_id ?? 1) : null,
    archivedOriginIds: [r.id],
    lines: sale
      ? [{ account: liquidity, debit: bank + extra, partner_id: r.partner_id, ...liquidityForeignAmount(1, value + excess) }, { account: counterpartCode, credit: open, partner_id: r.partner_id, ...foreignAmount(-value) }, ...credit, ...fx]
      : [{ account: counterpartCode, debit: open, partner_id: r.partner_id, ...foreignAmount(value) }, ...credit, { account: liquidity, credit: bank + extra, partner_id: r.partner_id, ...liquidityForeignAmount(-1, value + excess) }, ...fx],
  });
  const paymentMemo = memo !== undefined ? memo : (r.name || '');
  const record = { state: 'posted', company_id: r.company_id ?? 1, currency_id: isForeignPayment ? payCurrId : (r.currency_id ?? null), move_id: paymentMove, outstanding_account_id: liquidityAccountId ?? outstanding, journal_id: via.id, ...(methodLineId ? { payment_method_line_id: methodLineId } : {}), invoice_id: r.id, partner_id: r.partner_id, amount: isForeignPayment ? roundCurrency(payAmount, payCurr) : docRound(value + excess), unapplied: extra, date, payment_type: sale ? 'inbound' : 'outbound', partner_type: isPurchase(r) ? 'supplier' : 'customer', memo: paymentMemo, ...(checkNumber != null ? { check_number: checkNumber } : {}), ...(recipientBankId ? { partner_bank_id: recipientBankId } : {}) };
  const draftName = paymentId ? read(withEntry, 'account.payment', paymentId)?.name : null;
  const moveName = read(withEntry, 'account.move', paymentMove).name;
  const name = draftName && draftName !== '/' ? draftName : paymentName(withEntry, journal, date, moveName);
  const withPayment = paymentId
    ? write(withEntry, 'account.payment', paymentId, { ...record, name })
    : create(withEntry, 'account.payment', { ...record, name }).db;
  const next = appendDocumentSettlement(withPayment, id, {
    amount: value,
    moveId: paymentMove,
    date,
    companyAmount: open,
    paymentCompanyAmount: bank,
    final,
    note: `Payment of ${money(value)} registered`,
  }).db;
  return excess > 0 ? postNote(next, 'account.move', id, `${money(excess)} paid above the amount due kept as an outstanding credit`) : next;
}

/**
 * Append a settlement row onto a posted document (`account.move`), releasing cash-basis taxes,
 * updating `amount_paid` and `payment_date`, and optionally consuming an unapplied payment credit.
 */
export function appendDocumentSettlement(db, docId, {
  amount,
  moveId,
  date,
  companyAmount,
  paymentCompanyAmount = null,
  paymentMoveId = null,
  paymentFxMoveId = null,
  lineIndex = null,
  partialReconcileId = null,
  partnerBankId = null,
  discount = false,
  final = null,
  releaseCashBasisTaxes = true,
  consumePayment = false,
  note = null,
} = {}) {
  const doc = read(db, 'account.move', docId);
  const docCurr = documentCurrency(db, doc);
  const docRound = (n) => roundCurrency(n, docCurr);
  const value = docRound(amount);
  const openDoc = residual(doc, db);
  const docTotal = total(doc, db);
  const isFinal = final ?? (value >= openDoc);
  let next = db;
  let cashBasisMoveId = null;
  if (releaseCashBasisTaxes) {
    const release = releaseCashBasis(next, doc, docTotal ? value / docTotal : 0, date, { final: isFinal });
    next = release.db;
    cashBasisMoveId = release.id;
  }
  const resolvedCompanyAmount = companyAmount !== undefined && companyAmount !== null
    ? companyAmount
    : (consumePayment ? settlementCompanyAmount(next, doc, value) : undefined);
  let resolvedPayCompanyAmount = paymentCompanyAmount;
  if (consumePayment) {
    const linkedPay = search(next, 'account.payment').find((p) => p.move_id === moveId && p.state === 'posted');
    if (linkedPay && Number(linkedPay.unapplied) > 0) {
      const ownCurr = companyCurrencyRecord(next, doc.company_id);
      const roundOwn = (n) => roundCurrency(n, ownCurr);
      const taken = Math.min(roundOwn(Number(linkedPay.unapplied)), roundOwn(resolvedCompanyAmount));
      if (resolvedPayCompanyAmount == null) resolvedPayCompanyAmount = taken;
      next = write(next, 'account.payment', linkedPay.id, {
        unapplied: Math.max(0, roundOwn(Number(linkedPay.unapplied) - taken)),
      });
    }
  }
  const freshDoc = read(next, 'account.move', docId);
  const existingRows = freshDoc.payments ?? [];
  const maxId = existingRows.reduce((max, r) => (typeof r.id === 'number' && r.id > max ? r.id : max), 0);
  const rowId = maxId + 1;
  const row = {
    id: rowId,
    date,
    amount: value,
    move_id: moveId,
    ...(paymentMoveId != null ? { payment_move_id: paymentMoveId } : {}),
    ...(resolvedCompanyAmount !== undefined ? { company_amount: resolvedCompanyAmount } : {}),
    ...(resolvedPayCompanyAmount != null ? { payment_company_amount: resolvedPayCompanyAmount } : {}),
    ...(paymentFxMoveId != null ? { payment_fx_move_id: paymentFxMoveId } : {}),
    cash_basis_move_id: cashBasisMoveId,
    ...(Number.isInteger(lineIndex) ? { line_index: lineIndex } : {}),
    ...(partialReconcileId != null ? { partial_reconcile_id: partialReconcileId } : {}),
    ...(discount ? { discount: true } : {}),
  };
  next = write(next, 'account.move', docId, {
    amount_paid: docRound((Number(freshDoc.amount_paid) || 0) + value),
    payment_date: date,
    payments: [...(freshDoc.payments ?? []), row],
    ...(!freshDoc.partner_bank_id && partnerBankId ? { partner_bank_id: partnerBankId } : {}),
  });
  if (note) next = postNote(next, 'account.move', docId, note);
  return { db: next, cashBasisMoveId };
}

/** Settle a document with an explicitly chosen company-currency write-off. */
export function settleWriteoff(db, invoiceId, amount, companyAmount, date, { accountId: writeoffAccount, label, journalId: journal, lineIndex = null, analyticDistribution = null } = {}) {
  const invoice = read(db, 'account.move', invoiceId);
  if (!invoice || invoice.state !== 'posted' || !isInvoice(invoice) || !Number.isFinite(Number(amount)) || !(amount > 0) || amount > residual(invoice, db)) throw new Error('Write-off exceeds the remaining invoice');
  const docRound = (n) => roundCurrency(n, documentCurrency(db, invoice));
  const companyRound = (n) => roundCurrency(n, companyCurrencyRecord(db, invoice.company_id));
  amount = docRound(amount);
  if (!Number.isFinite(Number(companyAmount)) || !(companyAmount > 0) || toCompany(db, invoice.currency_id, amount, date, invoice.company_id) !== companyRound(companyAmount)) throw new Error('Invalid write-off amount in company currency');
  const account = read(db, 'account.account', writeoffAccount);
  if (!eligibleCounterpart(account, invoice.company_id ?? 1)) {
    if (!account || (account.company_id && account.company_id !== (invoice.company_id ?? 1))) throw new Error('Write-off account belongs to another company or does not exist');
    if (account.active === false) throw new Error('Archived accounts cannot be selected on journal items or invoice lines');
    throw new Error('Select a valid counterpart account for this company');
  }
  if (!String(label ?? '').trim()) throw new Error('Set a write-off label');
  const incoming = isInbound(invoice);
  const counterpart = invoiceCounterpartAccount(db, invoice);
  const open = settlementCompanyAmount(db, invoice, amount);
  const diff = companyRound(incoming ? companyAmount - open : open - companyAmount);
  const fx = exchangeLines(db, invoice.company_id, diff);
  const partner_id = invoice.partner_id;
  const via = paymentJournal(db, journal, invoice.company_id ?? 1);
  const analytic = analyticDistribution ? { analytic_distribution: analyticDistribution } : {};
  const booked = postEntry(db, { journal: via.code, journal_id: via.id, company: invoice.company_id ?? 1, date, ref: label, archivedOriginIds: [invoice.id],
    lines: incoming
      ? [{ account: writeoffAccount, debit: companyAmount, partner_id, name: label, ...analytic }, { account: counterpart, credit: open, partner_id }, ...fx]
      : [{ account: counterpart, debit: open, partner_id }, { account: writeoffAccount, credit: companyAmount, partner_id, name: label, ...analytic }, ...fx] });
  const settled = appendDocumentSettlement(booked.db, invoiceId, {
    amount,
    moveId: booked.id,
    date,
    companyAmount: open,
    lineIndex,
  });
  return { db: settled.db, id: booked.id };
}

// useInTaxClosing is true, false, or null for releases posted before the closing flag existed.
const releasedTaxKey = (account, taxId, name, tags = [], useInTaxClosing = true) => taxId != null
  ? JSON.stringify([account, taxId, [...tags].sort((a, b) => a - b), useInTaxClosing])
  : `${account}:${name ?? ''}${tags.length ? `:${[...tags].sort((a, b) => a - b).join(',')}` : ''}${useInTaxClosing == null ? '' : `:${useInTaxClosing ? 1 : 0}`}`;

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
        const key = releasedTaxKey(code, l.tax_id, l.tax_name, l.tax_tag_ids, l.use_in_tax_closing ?? null);
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
    const tagged = final ? released.taxes.get(releasedTaxKey(g.account, g.tax_id, g.tax_name, g.tax_tag_ids, g.use_in_tax_closing === true)) : null;
    // Releases posted before the closing flag existed carry no flag; share them across the groups that differ only by the flag.
    const unflaggedKey = releasedTaxKey(g.account, g.tax_id, g.tax_name, g.tax_tag_ids, null);
    const unflagged = final && unflaggedKey !== `${g.account}:` ? released.taxes.get(unflaggedKey) : null;
    const sameTax = (x) => releasedTaxKey(x.account, x.tax_id, x.tax_name, x.tax_tag_ids, null) === releasedTaxKey(g.account, g.tax_id, g.tax_name, g.tax_tag_ids, null);
    const flagTotal = groups.filter(sameTax).reduce((s, x) => s + x.amount, 0);
    const unflaggedShare = flagTotal ? g.amount / flagTotal : 0;
    const legacy = final ? released.taxes.get(`${g.account}:`) : null;
    const legacyShare = accountTotal ? g.amount / accountTotal : 0;
    const prior = (tagged?.amount ?? 0) + (unflagged?.amount ?? 0) * unflaggedShare + (legacy?.amount ?? 0) * legacyShare;
    const priorBase = (tagged?.base ?? 0) + (unflagged?.base ?? 0) * unflaggedShare + (legacy?.base ?? 0) * legacyShare;
    return { ...g, amount: companyRound(final ? g.amount - prior : g.amount * Math.abs(share)), base: companyRound(final ? g.base - priorBase : g.base * share) };
  })
    .filter((g) => g.amount || g.base);
  if (!due.length && !baseGroups.length) return { db, id: null };
  // The released tax lands on the tax account tagged with its tax and base, so the return counts it when paid.
  const lines = due.flatMap(({ account, amount, base, tax_id, tax_name, tax_tag_ids, use_in_tax_closing }) => {
    // The base is signed independently of the tax amount, including reversals and refunds.
    const transition = cashBasisTransitionAccount(db, tax_id, r.company_id, { allowArchived: true });
    const tax = { account_id: account, partner_id: r.partner_id, name: tax_name, tax_id, tax_name, tax_tag_ids, tax_grid_release: true, tax_base: refund ? -base : base, tax_base_signed: true, tax_side: sale ? 'sale' : 'purchase', use_in_tax_closing: use_in_tax_closing === true };
    const value = Math.abs(amount);
    return ((sale !== refund) === (share > 0)) !== (amount < 0)
      ? [{ account: transition, debit: value, partner_id: r.partner_id, use_in_tax_closing: false }, { ...tax, credit: value }]
      : [{ ...tax, debit: value }, { account: transition, credit: value, partner_id: r.partner_id, use_in_tax_closing: false }];
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
  const company = read(db, 'res.company', r.company_id ?? 1);
  const companyId = company ? company.id : null;
  // Configured cash basis journal, then the company's default general journal; companies with neither keep the legacy MISC journal.
  const cashBasisJournalId = company?.tax_cash_basis_journal_id
    || resolveDocumentJournal(db, { move_type: 'entry', company_id: companyId ?? 1 })?.id
    || 'MISC';
  const posted = postEntry(db, {
    journal: cashBasisJournalId,
    date,
    ref: `Cash basis taxes ${r.name}`,
    lines: [...lines, ...baseLines],
    company: companyId,
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
  if (['cancel', 'modify'].includes(method) && roundCurrency(credited, docCurr) > 0) {
    throw new Error('Full refund and modify require an invoice with no existing credit notes');
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
    invoice_line_ids: copyInvoiceLines(note.invoice_line_ids, {
      stripOrderLinks: true,
    }),
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
      ? copyInvoiceLines(r.invoice_line_ids, {
          stripOrderLinks: true,
        })
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

/** Early-payment discount applied when settling `docAmount` (in invoice currency) on `date`. */
export function appliedEarlyDiscount(db, r, docAmount, date = today()) {
  const docRound = (n) => roundCurrency(n, documentCurrency(db, r));
  const due = residual(r, db);
  const gap = docRound(due - docAmount);
  const available = discountAvailable(db, r, date);
  return gap > 0 && available > 0 && available >= gap ? docRound(gap) : 0;
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

/** Book early payment discount for an invoice against a payment entry. */
export function bookEarlyDiscount(db, id, discount, date = today(), paymentMoveId = null) {
  const r = read(db, 'account.move', id);
  if (!(discount > 0)) return db;
  const sale = isInbound(r);
  const company = read(db, 'res.company', r.company_id ?? 1);
  const discountAccount = sale ? company?.expense_early_payment_discount_account_id : company?.income_early_payment_discount_account_id;
  if (!discountAccount) throw new Error(`Configure the early payment discount ${sale ? 'expense' : 'income'} account on company ${company?.name ?? r.company_id ?? 1}`);
  const docRound = (n) => roundCurrency(n, documentCurrency(db, r));
  const companyRound = (n) => roundCurrency(n, companyCurrencyRecord(db, r.company_id));
  const value = settlementCompanyAmount(db, r, discount);
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
  const { db: booked, id: discountMove } = postEntry(db, {
    journal: 'MISC', date, ref: `Early payment discount ${r.name}`, company: company?.id ?? null, archivedOriginIds: [r.id],
    lines: sale
      ? [{ account: discountAccount, debit: value - taxValue - baseValue, partner_id: r.partner_id }, ...bases, ...taxes, { account: counterpart, credit: value, partner_id: r.partner_id, ...foreignAmount(-discount) }]
      : [{ account: counterpart, debit: value, partner_id: r.partner_id, ...foreignAmount(discount) }, ...bases, ...taxes, { account: discountAccount, credit: value - taxValue - baseValue, partner_id: r.partner_id }],
  });
  const after = read(booked, 'account.move', id);
  // Recorded like a payment (dated, pointing at its entry), so locked-period checks can verify it.
  const paymentMove = paymentMoveId ?? after.payments.filter((p) => !p.discount).at(-1)?.move_id;
  return appendDocumentSettlement(booked, id, {
    amount: discount,
    moveId: discountMove,
    date,
    companyAmount: value,
    paymentMoveId: paymentMove,
    discount: true,
    releaseCashBasisTaxes: false,
    note: `Early payment discount of ${money(discount)} applied`,
  }).db;
}

/** Pay `amount`; when it settles the invoice net of an early-payment discount, book the discount too. */
export function payWithDiscount(db, id, amount, date = today(), options = {}) {
  const r = read(db, 'account.move', id);
  if (!validDate(date)) throw new Error('Enter a valid payment date');
  const opts = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  const journalIdVal = opts.journalId ?? opts.journal_id ?? null;
  const docRound = (n) => roundCurrency(n, documentCurrency(db, r));
  const invCurrId = r.currency_id ?? companyCurrencyRecord(db, r.company_id)?.id;
  const payCurrId = opts.currencyId ?? invCurrId;
  const isForeign = payCurrId !== invCurrId;
  const paymentAmount = isForeign ? Number(amount) : null;
  const docAmount = isForeign
    ? invoiceCurrencyAmount(db, r, amount, date, payCurrId)
    : docRound(amount);
  const settleAmount = opts.settleAmount != null ? docRound(opts.settleAmount) : null;
  const discount = appliedEarlyDiscount(db, r, settleAmount != null ? settleAmount : docAmount, date);
  const sale = isInbound(r);
  const company = read(db, 'res.company', r.company_id ?? 1);
  const discountAccount = sale ? company?.expense_early_payment_discount_account_id : company?.income_early_payment_discount_account_id;
  if (discount > 0 && !discountAccount) throw new Error(`Configure the early payment discount ${sale ? 'expense' : 'income'} account on company ${company?.name ?? r.company_id ?? 1}`);
  const paid = payMove(db, id, docAmount, date, {
    journalId: journalIdVal,
    ...(opts.paymentId ? { paymentId: opts.paymentId } : {}),
    ...(opts.checkNumber != null ? { checkNumber: opts.checkNumber } : {}),
    ...(opts.memo !== undefined ? { memo: opts.memo } : {}),
    ...(opts.currencyId ? { currencyId: opts.currencyId } : {}),
    ...(paymentAmount != null ? { paymentAmount } : {}),
    ...(opts.partnerBankId ? { partnerBankId: opts.partnerBankId } : {}),
    ...(opts.paymentMethodLineId ? { paymentMethodLineId: opts.paymentMethodLineId } : {}),
    ...(opts.settleAmount != null ? { settleAmount: opts.settleAmount } : {}),
    ...(opts.excessAmount != null ? { excessAmount: opts.excessAmount } : {}),
  });
  if (!(discount > 0)) return paid;
  return bookEarlyDiscount(paid, id, discount, date);
}

const invoicePaymentMemo = (r) => r?.payment_reference?.trim() || r?.name || '';

function registerPayment(db, r, values = {}) {
  if (['exception', 'no'].includes(shouldBePaid(db, r))) throw new Error('Resolve or approve the three-way matching exception before registering payment');
  const amount = promptedAmount(values.amount);
  if (amount == null) throw new Error('Enter a payment amount greater than zero');
  const date = values.date;
  const journalIdVal = values.journal_id;
  if (!validDate(date)) throw new Error('Enter a valid payment date');
  if (!journalIdVal) throw new Error('Select a payment journal');
  const payment = paymentJournal(db, journalIdVal, r.company_id ?? 1);
  const memo = values.memo !== undefined ? values.memo : invoicePaymentMemo(r);

  const isReconcile = values.payment_difference_handling === 'reconcile';
  if (isReconcile && !values.writeoff_account_id) throw new Error('Select a write-off account');

  const payCurrencyId = values.currency_id ?? r.currency_id ?? companyCurrencyRecord(db, r.company_id)?.id;

  const paid = payWithDiscount(db, r.id, amount, date, {
    journalId: payment.id,
    memo,
    currencyId: payCurrencyId,
    partnerBankId: values.partner_bank_id ?? null,
    ...(values.settleAmount != null ? { settleAmount: values.settleAmount } : {}),
    ...(values.excessAmount != null ? { excessAmount: values.excessAmount } : {}),
  });
  let nextDb = paid;

  if (isReconcile) {
    const docRound = (n) => roundCurrency(n, documentCurrency(nextDb, r));
    const payDocAmount = invoiceCurrencyAmount(db, r, amount, date, payCurrencyId);
    const remaining = docRound(Math.max(0, residual(r, db) - payDocAmount - appliedEarlyDiscount(db, r, payDocAmount, date)));
    if (remaining > 0) {
      const writeoffLabel = values.writeoff_label || 'Write-Off';
      const companyRem = toCompany(nextDb, r.currency_id, remaining, date, r.company_id);
      const writeoffRes = settleWriteoff(nextDb, r.id, remaining, companyRem, date, {
        accountId: values.writeoff_account_id,
        label: writeoffLabel,
        journalId: payment.id,
      });
      nextDb = writeoffRes.db;
    }
  }
  return { db: nextDb };
}

export { registerPayment };
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
    && shouldBePaid(db, r) !== 'exception'
    && shouldBePaid(db, r) !== 'no';
}

/** A posted credit note with open balance that can settle `r`: matching pair, positive residual, bill payable. */
function isOutstandingCreditNoteFor(db, r, note) {
  return !creditNotePairError(db, note, r)
    && residual(note, db) > 0
    && shouldBePaid(db, r) !== 'exception'
    && shouldBePaid(db, r) !== 'no';
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

/** Whether a settlement row on an invoice/bill can be unreconciled. */
export function canUnreconcilePaymentRow(db, r, row) {
  if (!row || row.reversed || row.discount) return false;
  if (r && (r.state !== 'posted' || !isInvoice(r))) return false;
  if (row.partial_reconcile_id != null) {
    const partial = read(db, 'account.partial.reconcile', row.partial_reconcile_id);
    return Boolean(partial && partial.active !== false && !partial.reversed);
  }
  if (row.move_id != null) {
    return search(db, 'account.payment').some((p) => (p.move_id === row.move_id || (row.payment_move_id && p.move_id === row.payment_move_id)) && p.state === 'posted');
  }
  return false;
}

/** Active applied payments of a posted invoice or bill, for the form's Unreconcile list (early-payment discounts follow their payment). */
function appliedPayments(db, r) {
  if (r?.state !== 'posted' || !isInvoice(r)) return [];
  return (r.payments ?? []).filter((row) => canUnreconcilePaymentRow(db, r, row)).map((row) => ({
    id: row.id ?? `${row.move_id}:${row.line_index ?? ''}`,
    row_id: row.id,
    move_id: row.move_id,
    line_index: Number.isInteger(row.line_index) ? row.line_index : null,
    name: search(db, 'account.payment').find((p) => p.move_id === row.move_id && p.state === 'posted')?.name ?? read(db, 'account.move', row.move_id)?.name ?? '',
    date: row.date,
    amount: row.amount,
    company_id: r.company_id,
    display_currency_id: documentCurrency(db, r)?.id ?? null,
  }));
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

const termDue = (db, r, { clear = false, defaultToDate = false } = {}) => {
  const term = read(db, 'account.payment.term', r.invoice_payment_term_id);
  if (term && r.invoice_date) return { invoice_date_due: dueDate(term, r.invoice_date) };
  if (clear) return { invoice_date_due: null };
  if (!term && r.invoice_date && defaultToDate) return { invoice_date_due: r.invoice_date };
  return {};
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
  tax_ids: invoiceLineTaxIds,
  tax: invoiceLineTaxPct,
  analytic_account_id: invoiceLineAnalytic,
  analytic_distribution: invoiceLineAnalyticDist,
  ...invoiceLineExtraBase
} = invoiceLineBase.fields;

const invoiceLineProductDomain = (product, line) => {
  if (product.active === false) return false;
  return isPurchase(line) ? product.purchase_ok !== false : product.sale_ok !== false;
};

const invoiceLineTaxDomain = (tax, line, db) => {
  if (tax.active === false) return false;
  const docCompany = line?.company_id ?? (db ? currentCompany(db) : 1);
  if (tax.company_id && tax.company_id !== docCompany) return false;
  const expectedUse = isPurchase(line) ? 'purchase' : 'sale';
  return tax.type_tax_use === expectedUse;
};

const invoiceLineField = {
  ...invoiceLineBase,
  newLine: (move, db) => (isPurchase(move ?? {}) ? billLineBase : invoiceLineBase).newLine(move, db),
  onchange: (line, key, db, move, context = {}) => {
    const moveWithJournal = move?.journal_id ? move : (move && db ? { ...move, journal_id: resolveDocumentJournal(db, move)?.id } : move);
    const base = (isPurchase(moveWithJournal ?? {}) ? billLineBase : invoiceLineBase).onchange(line, key, db, moveWithJournal);
    const isDoc = db && ['out_invoice', 'out_refund', 'in_invoice', 'in_refund'].includes(moveWithJournal?.move_type);
    let updated = base;
    if (base.purchase_line_id != null && updated.purchase_line_id == null) {
      updated = { ...updated, purchase_line_id: base.purchase_line_id };
    }
    if (db && key === 'purchase_line_id') {
      const poLines = search(db, 'purchase.order').filter((po) => (po.company_id ?? 1) === (moveWithJournal.company_id ?? 1) && (!moveWithJournal.partner_id || sameCommercialPartner(db, po.partner_id, moveWithJournal.partner_id))).flatMap((po) => po.order_line ?? []);
      const pid = updated.purchase_line_id ?? line.purchase_line_id;
      if (key === 'purchase_line_id' && pid != null) {
        const poLine = poLines.find((p) => p.id === pid);
        if (poLine) {
          const prod = poLine.product_id ? read(db, 'product', poLine.product_id) : null;
          updated = {
            ...updated,
            purchase_line_id: poLine.id ?? pid,
            product_id: poLine.product_id ?? updated.product_id,
            name: poLine.name || prod?.name || updated.name,
            qty: poLine.qty ?? updated.qty,
            price_unit: poLine.price_unit ?? updated.price_unit,
            discount: poLine.discount ?? updated.discount ?? 0,
            uom_id: poLine.uom_id ?? updated.uom_id,
            tax_id: poLine.tax_id ?? updated.tax_id,
            tax_ids: poLine.tax_ids ?? updated.tax_ids,
            tax: poLine.tax ?? updated.tax,
          };
        }
      }
    }
    if (isDoc && key === 'product_id' && base.product_id) {
      const product = read(db, 'product', base.product_id);
      if (product && !line.name?.trim()) {
        updated = { ...updated, name: product.name || '' };
      }
      // Show the account the line will post to, before any deferred-account substitution.
      // Ignore any account already on the line so the product's own resolution wins, and never fail here:
      // an unresolved or incomplete setup belongs to posting.
      const journal = resolveDocumentJournal(db, moveWithJournal);
      if (journal) {
        const resolved = invoiceLineOriginalAccount(db, moveWithJournal, { ...updated, account_id: null, income_account_id: null }, journal);
        if (!resolved.error && resolved.account) {
          updated = { ...updated, account_id: resolved.account, account_fiscal_position_id: moveWithJournal?.fiscal_position_id ?? null };
        }
      }
    }
    if (isDoc && key === 'account_id') {
      updated = { ...updated, account_fiscal_position_id: null };
      if (!base.product_id && !isSectionOrNote(base)) {
        const account = base.account_id ? read(db, 'account.account', base.account_id) : null;
        const side = isPurchase(moveWithJournal) ? 'purchase' : 'sale';
        // An account without a default tax for this side keeps the line's current tax.
        const accTax = account ? accountTax(db, account, side, moveWithJournal.fiscal_position_id, moveWithJournal.company_id) : null;
        if (accTax) updated = { ...updated, tax_source_id: null, tax_ids: [], ...replaceTaxSnapshot(accTax) };
      }
    }
    if (isDoc && ['product_id', 'account_id'].includes(key)) {
      return withTaxIds({ ...updated, analytic_distribution: defaultDistributionForLine(db, updated, moveWithJournal) });
    }
    if (isDoc && ['deferred_start_date', 'deferred_end_date'].includes(key)) {
      const prevLine = context?.previous ?? (context && !Array.isArray(context.invoice_line_ids) && (context.product_id || context.account_id) ? context : null) ?? (move?.invoice_line_ids?.find((l) => (line.line_id && l.line_id === line.line_id) || (line.id && l.id === line.id))) ?? null;
      return withTaxIds(syncDeferredAnalyticDistribution(db, updated, line, prevLine, moveWithJournal));
    }
    return withTaxIds(updated);
  },
  fields: {
    line_id: { type: 'char', label: 'Reference', readonly: true, hidden: true },
    source_line_id: { type: 'char', label: 'Source Document', readonly: true, hidden: true },
    product_id: { ...invoiceLineProduct, domain: invoiceLineProductDomain },
    name: { type: 'char', label: 'Label' },
    account_id: { type: 'many2one', relation: 'account.account', label: 'Account', optional: 'hide' },
    analytic_account_id: { ...invoiceLineAnalytic, hidden: true },
    analytic_distribution: { ...invoiceLineAnalyticDist, label: 'Analytic', hidden: false, optional: 'hide' },
    deferred_start_date: { type: 'date', label: 'Deferred Start Date', optional: 'hide' },
    deferred_end_date: { type: 'date', label: 'Deferred End Date', optional: 'hide' },
    qty: invoiceLineQty,
    uom_id: { ...invoiceLineUom, optional: 'hide' },
    price_unit: invoiceLinePrice,
    discount: { ...invoiceLineDiscount, optional: 'hide' },
    // A numeric rate without a tax record (e.g. a digitized bill) still taxes the line: show it rather than an empty selector.
    // The Taxes tags (tax_ids) are the editable field; tax_id is kept as the first tax and stays hidden.
    tax_id: { ...invoiceLineTaxId, domain: invoiceLineTaxDomain },
    tax_ids: { ...invoiceLineTaxIds, domain: invoiceLineTaxDomain, rateOnlyText: (line) => (!line.tax_id && Number.isFinite(Number(line.tax)) && Number(line.tax) !== 0 ? `${Number(line.tax)}%` : null) },
    tax: { ...invoiceLineTaxPct, hidden: true },
    ...invoiceLineExtraBase,
    display_type: { type: 'selection', label: 'Display Type', hidden: true, options: [['line_section', 'Section'], ['line_note', 'Note']] },
    sale_line_key: { type: 'char', label: 'Order Line', readonly: true, hidden: true },
    purchase_line_id: { type: 'many2one', relation: 'purchase.order.line', label: 'Purchase Order Line', optional: 'hide', domain: (line, row, db) => { const po = db && read(db, 'purchase.order', line.purchase_id); return Boolean(po && (po.company_id ?? 1) === (row?.company_id ?? 1) && (!row?.parent_partner_id || sameCommercialPartner(db, po.partner_id, row.parent_partner_id))); } },

    down_payment_key: { type: 'char', label: 'Down Payment', readonly: true, hidden: true },
    rental_id: { type: 'many2one', relation: 'sale.rental', label: 'Rental', readonly: true, hidden: true },
    rental_charge: { type: 'char', label: 'Type', readonly: true, hidden: true },
    account_fiscal_position_id: { type: 'many2one', relation: 'account.fiscal.position', label: 'Fiscal Position', readonly: true, hidden: true },
  },
};

/** Determine base repartition tags for a manual entry line based on debit/credit side. */
function updateBaseLineTags(line, move, db) {
  const taxIds = (line?.tax_ids ?? []).filter(Boolean);
  if (!taxIds.length || !db) return { ...line, tax_tag_ids: [] };
  const debit = Number(line.debit) || 0;
  const credit = Number(line.credit) || 0;
  const baseSide = debit >= credit ? 'debit' : 'credit';
  const allBaseTags = new Set();
  let firstTax = null;
  for (const id of taxIds) {
    const tax = read(db, 'account.tax', id);
    if (!tax) continue;
    if (!firstTax) firstTax = tax;
    const side = entryTaxRepartitionSide(tax, baseSide);
    for (const tagId of taxBaseTags(tax, side)) allBaseTags.add(tagId);
  }
  const reportingTaxSide = (firstTax?.type_tax_use === 'sale' || firstTax?.type_tax_use === 'purchase')
    ? firstTax.type_tax_use
    : (baseSide === 'credit' ? 'sale' : 'purchase');
  return { ...line, tax_tag_ids: [...allBaseTags].sort((a, b) => a - b), tax_side: reportingTaxSide };
}

/** Compute and sync tax lines on manual journal entry lines (move_type 'entry'). */
function computeEntryTaxLines(lines = [], move = {}, db = null) {
  if (!db || !Array.isArray(lines)) return lines;

  const companyId = move.company_id ?? db?.settings?.current_company_id ?? 1;
  const companyCurrencyRec = companyCurrencyRecord(db, companyId);
  const roundingMethod = companyRoundingMethod(db, companyId);
  const entryDate = moveDate(move);

  if (move.fiscal_position_id) {
    const fp = read(db, 'account.fiscal.position', move.fiscal_position_id);
    if (fp?.company_id && fp.company_id !== companyId) {
      throw new Error('Fiscal position belongs to another company');
    }
  }

  const existingTaxLinesByBaseKey = new Map();
  for (const l of lines) {
    if (l.tax_base_line_key && (l.tax_repartition_line_id != null || l.tax_id != null)) {
      const k = String(l.tax_base_line_key);
      if (!existingTaxLinesByBaseKey.has(k)) existingTaxLinesByBaseKey.set(k, []);
      existingTaxLinesByBaseKey.get(k).push(l);
    }
  }

  const resultLines = [];
  let baseCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];

    // Case 1: Generated tax line - skip; will be regenerated with its base line
    if (l.tax_base_line_key && (l.tax_repartition_line_id != null || l.tax_id != null)) {
      continue;
    }

    // Case 2: Manual tax item (Finding 4) - preserve as-is
    if (!l.tax_base_line_key && (l.tax_repartition_line_id != null || (l.tax_id != null && !Array.isArray(l.tax_ids)))) {
      resultLines.push(l);
      continue;
    }

    // Case 3: Base line
    baseCount += 1;
    let baseLine = { ...l };

    const baseKey = baseLine.line_id
      || (baseLine.id != null ? String(baseLine.id) : null)
      || (baseLine.tax_base_line_key ? String(baseLine.tax_base_line_key) : null)
      || `b_${baseCount}`;

    baseLine.tax_base_line_key = baseKey;

    const existingForBase = existingTaxLinesByBaseKey.get(baseKey) ?? [];
    const taxIds = (baseLine.tax_ids ?? []).filter(Boolean);
    if (taxIds.length) {
      validateTaxCompany(db, taxIds, companyId, move.fiscal_position_id);
    }

    const debit = Number(baseLine.debit) || 0;
    const credit = Number(baseLine.credit) || 0;
    const baseSide = debit >= credit ? 'debit' : 'credit';
    const baseAmount = Math.max(debit, credit);

    const isForeign = Boolean(baseLine.currency_id && companyCurrencyRec && baseLine.currency_id !== companyCurrencyRec.id);
    const docCurrency = (isForeign && baseLine.currency_id) ? read(db, 'res.currency', baseLine.currency_id) : companyCurrencyRec;
    const foreignAmount = isForeign && baseLine.amount_currency != null ? Math.abs(Number(baseLine.amount_currency) || 0) : null;
    const docAmount = (isForeign && foreignAmount != null) ? foreignAmount : baseAmount;

    if (!taxIds.length || docAmount === 0) {
      const hadTaxGeneratedTags = existingForBase.length > 0;
      const updatedBase = {
        ...baseLine,
        tax_tag_ids: hadTaxGeneratedTags ? [] : (baseLine.tax_tag_ids ?? []),
        tax_grid_base: hadTaxGeneratedTags ? false : (baseLine.tax_grid_base ?? false),
      };
      resultLines.push(updatedBase);
      continue;
    }

    let grossDocAmount = docAmount;
    if (existingForBase.length) {
      const existingPriceInclDoc = existingForBase.reduce((sum, el) => {
        const isIncl = el.tax_include !== undefined
          ? Boolean(el.tax_include)
          : Boolean(read(db, 'account.tax', el.tax_id)?.price_include);
        if (!isIncl) return sum;
        const amt = isForeign
          ? Math.abs(Number(el.amount_currency) || 0)
          : (Number(el.debit) || Number(el.credit) || 0);
        return sum + amt;
      }, 0);
      grossDocAmount += existingPriceInclDoc;
    }

    // Finding 9: group taxes by resolved side
    const taxesBySide = new Map();
    for (const id of taxIds) {
      const tax = read(db, 'account.tax', id);
      if (!tax) continue;
      const s = entryTaxRepartitionSide(tax, baseSide);
      if (!taxesBySide.has(s)) taxesBySide.set(s, []);
      taxesBySide.get(s).push(id);
    }

    const allBaseTags = new Set();
    const rawSplits = [];
    let totalUntaxedDoc = grossDocAmount;
    let hasPriceInclude = false;

    for (const [side, groupTaxIds] of taxesBySide) {
      const expanded = expandTaxIds(db, groupTaxIds, move.fiscal_position_id);
      const lineObj = {
        qty: 1,
        price_unit: grossDocAmount,
        discount: 0,
        tax_ids: groupTaxIds,
        tax_breakdown: expanded.map((t) => taxSnapshot(t, db, move.fiscal_position_id, companyId)),
      };

      const computed = computeLineTaxes(lineObj, { currency: docCurrency, roundingMethod, side });

      if (computed.untaxed < grossDocAmount) {
        hasPriceInclude = true;
        totalUntaxedDoc -= (grossDocAmount - computed.untaxed);
      }

      for (const t of computed.taxes) {
        const taxRec = read(db, 'account.tax', t.tax_id);
        for (const tagId of taxBaseTags(t, side, lineObj)) {
          allBaseTags.add(tagId);
        }

        const { splits } = taxRepartitionSplits(t, lineObj, side, docCurrency);
        for (const split of splits) {
          const { row, amount: splitDocAmount, base: splitDocBase } = split;

          let taxAccountId;
          if (t.tax_cash_basis) {
            taxAccountId = cashBasisTransitionAccount(db, t.tax_id, companyId);
          } else if (row.account_id) {
            const mapped = mapAccount(db, move.fiscal_position_id, row.account_id);
            taxAccountId = resolveCompanyAccount(db, mapped, companyId) ?? mapped;
          } else {
            taxAccountId = baseLine.account_id;
          }

          const taxTagIds = [...(row.tag_ids ?? [])].sort((a, b) => a - b);
          const analytic = (taxRec?.analytic && baseLine.analytic_distribution)
            ? baseLine.analytic_distribution
            : null;

          // Finding 11: neutral tax reporting tax_side follows base direction
          const reportingTaxSide = (t.type_tax_use === 'sale' || t.type_tax_use === 'purchase')
            ? t.type_tax_use
            : (baseSide === 'credit' ? 'sale' : 'purchase');

          rawSplits.push({
            t,
            taxRec,
            row,
            taxAccountId,
            taxTagIds,
            analytic,
            splitDocAmount,
            splitDocBase, // Finding 1: direct base, including zero
            reportingTaxSide,
          });
        }
      }
    }

    // Finding 5 & 11: update base line
    const baseTags = [...allBaseTags].sort((a, b) => a - b);
    const firstTax = read(db, 'account.tax', taxIds[0]);
    const baseReportingSide = (firstTax?.type_tax_use === 'sale' || firstTax?.type_tax_use === 'purchase')
      ? firstTax.type_tax_use
      : (baseSide === 'credit' ? 'sale' : 'purchase');

    const roundedUntaxedDoc = roundCurrency(totalUntaxedDoc, docCurrency);
    // The base is rewritten only when a tax is included in price now, or when included tax amounts were added back to it.
    const rewriteBase = hasPriceInclude || grossDocAmount !== docAmount;
    const untaxedCompany = rewriteBase
      ? (isForeign ? toCompany(db, baseLine.currency_id, roundedUntaxedDoc, entryDate, companyId) : roundCurrency(roundedUntaxedDoc, companyCurrencyRec))
      : baseAmount;

    const updatedBase = {
      ...baseLine,
      debit: baseSide === 'debit' ? (rewriteBase ? untaxedCompany : baseLine.debit) : 0,
      credit: baseSide === 'credit' ? (rewriteBase ? untaxedCompany : baseLine.credit) : 0,
      tax_tag_ids: baseTags,
      tax_grid_base: baseTags.length > 0,
      tax_side: baseReportingSide,
      ...(isForeign && rewriteBase ? {
        amount_currency: baseSide === 'debit' ? roundedUntaxedDoc : -roundedUntaxedDoc,
      } : {}),
    };
    resultLines.push(updatedBase);

    // Finding 10: aggregate splits sharing taxAccountId, tax_id, taxTagIds, reportingTaxSide
    const splitGroups = new Map();
    for (const split of rawSplits) {
      const key = `${split.taxAccountId}|${split.t.tax_id ?? ''}|${split.taxTagIds.join(',')}|${split.reportingTaxSide}`;
      if (!splitGroups.has(key)) {
        splitGroups.set(key, {
          ...split,
          docAmount: 0,
          docBase: 0,
          rows: [],
        });
      }
      const g = splitGroups.get(key);
      g.docAmount += split.splitDocAmount;
      g.docBase += split.splitDocBase;
      g.rows.push(split.row);
    }

    const matchedIndexesForBase = new Set();

    for (const g of splitGroups.values()) {
      const taxAmount = isForeign
        ? toCompany(db, baseLine.currency_id, g.docAmount, entryDate, companyId)
        : roundCurrency(g.docAmount, companyCurrencyRec);

      const taxBase = isForeign
        ? (g.docBase === 0 ? 0 : toCompany(db, baseLine.currency_id, g.docBase, entryDate, companyId))
        : (g.docBase === 0 ? 0 : roundCurrency(g.docBase, companyCurrencyRec));

      // Finding 6: debit/credit choice uses base direction and split sign; amounts non-negative
      const splitSign = Math.sign(g.docAmount) < 0 ? -1 : 1;
      const effectiveSide = splitSign === 1
        ? baseSide
        : (baseSide === 'debit' ? 'credit' : 'debit');

      const absTaxAmount = Math.abs(taxAmount);
      const absDocAmount = roundCurrency(Math.abs(g.docAmount), docCurrency);

      const existingIdx = existingForBase.findIndex((cand, idx) => {
        if (matchedIndexesForBase.has(idx)) return false;
        return cand.tax_id === g.t.tax_id && (cand.tax_repartition_line_id == null || g.row.id == null || cand.tax_repartition_line_id === g.row.id);
      });
      const existing = existingIdx >= 0 ? existingForBase[existingIdx] : null;
      if (existingIdx >= 0) matchedIndexesForBase.add(existingIdx);

      const cleanExisting = { ...(existing ?? {}) };
      // Finding 8: clear stale currency fields
      delete cleanExisting.currency_id;
      delete cleanExisting.amount_currency;

      const taxLine = {
        ...cleanExisting,
        account_id: g.taxAccountId,
        partner_id: baseLine.partner_id ?? move.partner_id ?? null,
        name: g.t.name || g.t.tax_name || taxLabel(g.t),
        debit: effectiveSide === 'debit' ? absTaxAmount : 0,
        credit: effectiveSide === 'credit' ? absTaxAmount : 0,
        tax_id: g.t.tax_id,
        tax_include: Boolean(g.t.tax_include),
        tax_name: g.t.name || g.t.tax_name || taxLabel(g.t),
        tax_repartition_line_id: g.row.id ?? null,
        tax_base: taxBase,
        tax_tag_ids: g.taxTagIds,
        tax_side: g.reportingTaxSide,
        tax_base_line_key: baseKey, // Finding 4: explicit provenance
        ...(g.analytic && Object.keys(g.analytic).length ? { analytic_distribution: g.analytic } : {}),
        ...(isForeign ? {
          currency_id: baseLine.currency_id,
          amount_currency: effectiveSide === 'debit' ? absDocAmount : -absDocAmount,
        } : {}),
      };
      if (!g.analytic || !Object.keys(g.analytic).length) {
        delete taxLine.analytic_distribution;
      }
      if (!isForeign) {
        delete taxLine.currency_id;
        delete taxLine.amount_currency;
      }
      resultLines.push(taxLine);
    }
  }

  return resultLines;
}

/** Recompute tax lines on all draft manual entries of a company (e.g. after default sales price inclusion changes). */
function refreshDraftEntryTaxes(db, companyId) {
  if (!db?.records?.['account.move']) return db;
  const targetCompany = companyId ?? db.settings?.current_company_id ?? 1;
  const draftMoves = (db.records['account.move'] ?? []).filter((m) =>
    m.move_type === 'entry' &&
    m.state === 'draft' &&
    (m.company_id ?? 1) === targetCompany &&
    Array.isArray(m.line_ids) &&
    m.line_ids.some((l) => (l.tax_ids?.length || l.tax_id != null))
  );
  if (!draftMoves.length) return db;
  let next = db;
  for (const m of draftMoves) {
    const refreshedLines = computeEntryTaxLines(m.line_ids, m, next);
    next = write(next, 'account.move', m.id, { line_ids: refreshedLines });
  }
  return next;
}

/** A journal item tied to one tax (tax_id or repartition line): its tags come from that tax, so base-line tag updates must skip it. */
export const isEntryTaxLine = (l) => Boolean(l && (l.tax_repartition_line_id != null || l.tax_id != null));

export function revalueForeignLine(db, line, entryDate, companyId) {
  if (!db || !line) return line;
  const companyCurr = companyCurrencyRecord(db, companyId);
  const account = line.account_id ? read(db, 'account.account', line.account_id) : null;
  const lineCurrencyId = line.currency_id ?? (account?.currency_id && account.currency_id !== companyCurr?.id ? account.currency_id : null);
  const isForeign = Boolean(lineCurrencyId && companyCurr && lineCurrencyId !== companyCurr.id);
  if (!isForeign) {
    if (!line.currency_id || line.currency_id === companyCurr?.id) {
      return { ...line, amount_currency: 0 };
    }
    return line;
  }
  const amt = Number(line.amount_currency) || 0;
  if (amt !== 0) {
    if (amt > 0) {
      return {
        ...line,
        currency_id: line.currency_id ?? lineCurrencyId,
        debit: toCompany(db, lineCurrencyId, amt, entryDate, companyId),
        credit: 0,
      };
    }
    return {
      ...line,
      currency_id: line.currency_id ?? lineCurrencyId,
      debit: 0,
      credit: toCompany(db, lineCurrencyId, -amt, entryDate, companyId),
    };
  }
  const debit = Number(line.debit) || 0;
  const credit = Number(line.credit) || 0;
  if (debit > 0 || credit > 0) {
    const rate = rateAt(db, lineCurrencyId, entryDate, companyId);
    const foreignCurrency = read(db, 'res.currency', lineCurrencyId);
    return {
      ...line,
      currency_id: line.currency_id ?? lineCurrencyId,
      amount_currency: debit > 0 ? roundCurrency(debit * rate, foreignCurrency) : -roundCurrency(credit * rate, foreignCurrency),
    };
  }
  return {
    ...line,
    currency_id: line.currency_id ?? lineCurrencyId,
    debit: 0,
    credit: 0,
    amount_currency: 0,
  };
}

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
    tax_include: { type: 'boolean', label: 'Included in Price', hidden: true },
    tax_ids: { type: 'many2many', relation: 'account.tax', label: 'Taxes', widget: 'many2many_tags', hidden: true },
    tax_tag_ids: { type: 'many2many', relation: 'account.account.tag', label: 'Tax Tags', hidden: true },
    tax_grid_base: { type: 'boolean', label: 'Tax Grid Base', hidden: true },
    tax_grid_release: { type: 'boolean', label: 'Tax Grid Release', hidden: true },
    use_in_tax_closing: { type: 'boolean', label: 'Use in Tax Closing', hidden: true },
    tag_ids: { type: 'many2many', relation: 'account.account.tag', label: 'Tags', hidden: true },
    is_opening_balancing: { type: 'boolean', label: 'Opening Balancing Line', hidden: true },
    analytic_distribution: { type: 'distribution', label: 'Analytic Distribution', hidden: true },
    tax_repartition_line_id: { type: 'integer', label: 'Tax Repartition Line', hidden: true },
    tax_base_line_key: { type: 'char', label: 'Base Line Key', hidden: true },
  },
  onchange: (line, key, db, move, _context = {}) => {
    let updated = { ...line };
    const companyId = move?.company_id ?? db?.settings?.current_company_id ?? 1;
    const companyCurr = db ? companyCurrencyRecord(db, companyId) : null;
    const account = updated.account_id && db ? read(db, 'account.account', updated.account_id) : null;
    const lineCurrencyId = updated.currency_id ?? (account?.currency_id && account.currency_id !== companyCurr?.id ? account.currency_id : null);
    const isForeign = Boolean(lineCurrencyId && companyCurr && lineCurrencyId !== companyCurr.id);
    const entryDate = moveDate(move);

    if (key === 'account_id') {
      updated = { ...updated, tax_ids: accountDefaultTaxIds(db, account, companyId) };
      if (account?.currency_id && account.currency_id !== companyCurr?.id && !updated.currency_id) {
        updated.currency_id = account.currency_id;
      }
      if (db && !isEntryTaxLine(updated)) {
        updated = updateBaseLineTags(updated, move, db);
      }
    } else if (key === 'tax_ids' || key === 'debit' || key === 'credit') {
      if (db && !isEntryTaxLine(updated)) {
        updated = updateBaseLineTags(updated, move, db);
      }
    }

    if (isForeign && db && (!move || move.move_type === 'entry')) {
      if (key === 'currency_id') {
        updated = revalueForeignLine(db, updated, entryDate, companyId);
        if (!isEntryTaxLine(updated)) {
          updated = updateBaseLineTags(updated, move, db);
        }
      } else if (key === 'amount_currency') {
        const amt = Number(updated.amount_currency) || 0;
        if (amt === 0) {
          updated.debit = 0;
          updated.credit = 0;
        } else {
          updated = revalueForeignLine(db, updated, entryDate, companyId);
        }
        if (!isEntryTaxLine(updated)) {
          updated = updateBaseLineTags(updated, move, db);
        }
      } else if (key === 'debit' || key === 'credit') {
        if (Number(updated.amount_currency || 0) === 0) {
          updated = revalueForeignLine(db, updated, entryDate, companyId);
        }
      }
    } else if (key === 'currency_id' && (!lineCurrencyId || lineCurrencyId === companyCurr?.id)) {
      updated.amount_currency = 0;
      if (updated.currency_id === companyCurr?.id) updated.currency_id = null;
    }
    return updated;
  },
  columnsFor: (record, db) => (record?.move_type === 'entry'
    ? [
      ['account_id', lineItem.fields.account_id],
      ['partner_id', lineItem.fields.partner_id],
      ['name', lineItem.fields.name],
      ['currency_id', { ...lineItem.fields.currency_id, optional: 'hide' }],
      ['amount_currency', { ...lineItem.fields.amount_currency, optional: 'hide' }],
      ['date_maturity', lineItem.fields.date_maturity],
      ['tax_ids', { ...lineItem.fields.tax_ids, widget: 'many2many_tags', hidden: false }],
      ['debit', lineItem.fields.debit],
      ['credit', lineItem.fields.credit],
      ...(db && search(db, 'account.analytic.plan').length
        ? [['analytic_distribution', { ...lineItem.fields.analytic_distribution, hidden: false }]]
        : []),
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

/** Deferral schedules referencing journal entry or invoice/bill `r`. */
const moveDeferrals = (db, r) => {
  if (!db || !r?.id) return [];
  const ids = [r.id, r.reversed_entry_id].filter(Boolean);
  return search(db, 'account.deferral').filter((d) => ids.some((mid) => deferralLinksMove(d, mid)));
};

/** Assets linked to bill or refund `r`. */
const moveAssets = (db, r) => {
  if (!db || !r?.id) return [];
  const ids = new Set([r.id, r.reversed_entry_id].filter(Boolean));
  return search(db, 'account.asset').filter((a) => ids.has(a.bill_id));
};

/** Purchase orders linked to bill or refund `r` (via purchase_id or purchase_line_id). */
const movePurchaseOrders = (db, r) => {
  if (!db || !r) return [];
  const poRecords = search(db, 'purchase.order');
  const poIds = new Set();
  const movesToCheck = [r];
  if (r.reversed_entry_id) {
    const orig = read(db, 'account.move', r.reversed_entry_id);
    if (orig) movesToCheck.push(orig);
  }
  for (const m of movesToCheck) {
    if (m.purchase_id) poIds.add(m.purchase_id);
    const lines = m.invoice_line_ids ?? [];
    const pkeys = new Set(lines.map((l) => purchaseLineId(db, l, m.purchase_id)).filter((id) => id != null));
    if (pkeys.size > 0) {
      for (const po of poRecords) {
        if (poIds.has(po.id)) continue;
        const poLines = po.order_line ?? [];
        if (poLines.some((pol) => pkeys.has(pol.id))) {
          poIds.add(po.id);
        }
      }
    }
  }
  return poRecords.filter((po) => poIds.has(po.id));
};

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
function canResetMove(r, db, ctx = null) {
  if (!r || r.state === 'draft' || r.inalterable_hash || Number(r.amount_paid) > 0) return false;
  if (db && settlingEntries(db).has(r.id)) return false;
  if (r.move_type === 'entry' && db) {
    if (bookedByBank(db, r.id)) return false;
    const lock = recordLockDate(db, r, ctx);
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
  list: ['accounting_date', 'display_name', 'partner_id', 'ref', 'journal_id', 'amount_total_signed', 'state'],
  optionalList: ['invoice_date', 'activities'],
  listLabels: { display_name: 'Number', accounting_date: 'Date', invoice_date: 'Invoice Date', amount_total_signed: 'Total', state: 'Status' },
  searchFields: ['name', 'display_name', 'ref', 'partner_id', 'journal_id'],
  listActions: [
    {
      label: 'Reverse Entries',
      requiresSelection: true,
      wizard: (db) => ({ title: 'Reverse Entries', fields: reversalWizardFields(null, db?.settings?.current_company_id ?? 1) }),
      run: (db, ids, values = {}) => reverseEntries(db, ids, values),
    },
  ],
  filters: [
    [{ id: 'unposted', label: 'Unposted', fn: (r) => r.state === 'draft' }, { id: 'posted', label: 'Posted', fn: (r) => r.state === 'posted' }],
    [
      { id: 'reversed', label: 'Reversed', fn: (r, db) => Boolean(r.reversed_entry_id || r.reversal_move_id || (db?.records?.['account.move'] ?? []).some((m) => m.state !== 'cancel' && m.reversed_entry_id === r.id)) },
      { id: 'manual', label: 'Manual', fn: (r) => !((r.auto_post && r.auto_post !== 'no') || r.auto_post_origin_id) },
      { id: 'recurring', label: 'Recurring', fn: (r) => Boolean(RECURRENCE_MONTHS[r.auto_post] || r.auto_post_origin_id) },
    ],
    [{ id: 'to_check', label: 'To Check', fn: (r) => r.to_check === true }],
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
  display_name: { bold: true },
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
  ...(!purchases ? [[
    { id: 'sent', label: 'Sent', fn: (r) => Boolean(r.is_move_sent) },
    { id: 'is_not_sent', label: 'Not Sent', fn: (r) => !r.is_move_sent },
  ]] : []),
  monthFilters('invoice_date', 'Invoice Date'),
  ...(purchases ? [monthFilters('date', 'Accounting Date')] : []),
  monthFilters('invoice_date_due', 'Due Date'),
];

/** List action: pay every selected invoice or bill at once, one payment per partner group or one per document. */
const registerPaymentsListAction = {
  label: 'Register Payment',
  requiresSelection: true,
  wizard: (db, ids) => {
    const docs = paymentDocuments(db, ids);
    const partnerGroups = new Map();
    for (const doc of docs) {
      const key = JSON.stringify([doc.partner_id, invoiceCounterpartAccount(db, doc), doc.currency_id ?? companyCurrencyRecord(db, doc.company_id)?.id ?? null, doc.partner_bank_id ?? null]);
      partnerGroups.set(key, [...(partnerGroups.get(key) ?? []), doc]);
    }
    for (const group of partnerGroups.values()) {
      const invTotal = group.filter((d) => !isRefund(d)).reduce((sum, d) => sum + Math.max(0, residual(d, db) - discountAvailable(db, d, today())), 0);
      const noteTotal = group.filter((d) => isRefund(d)).reduce((sum, d) => sum + residual(d, db), 0);
      if (!(invTotal - noteTotal > 0)) throw new Error('The net payment amount must be greater than zero');
    }
    const companyId = docs[0].company_id ?? 1;
    return {
      title: 'Register Payment',
      fields: [
        ...(docs.length > 1 ? [{ name: 'group_payment', type: 'boolean', label: 'Group Payments', default: true }] : []),
        { name: 'date', type: 'date', label: 'Payment Date', required: true, default: today() },
        {
          name: 'journal_id',
          type: 'many2one',
          relation: 'account.journal',
          label: 'Payment Journal',
          required: true,
          default: defaultPaymentJournalId(db, companyId),
          domain: (j) => (!j.company_id || j.company_id === companyId) && isLiquidityJournal(j),
        },
        { name: 'memo', type: 'char', label: 'Memo', default: '' },
      ],
    };
  },
  run: (db, ids, values = {}) => registerPayments(db, ids, values),
};

const INVOICE_GROUP_BYS = ['invoice_user_id', 'partner_id', 'status_in_payment', 'journal_id', 'company_id', 'invoice_date', 'invoice_date_due', 'date'];
const INVOICE_GROUP_BY_LABELS = { partner_id: 'Partner', invoice_date: 'Invoice Date', date: 'Accounting Date', status_in_payment: 'Status' };
const INVOICE_SEARCH_FIELDS = ['name', 'display_name', 'invoice_origin', 'ref', 'payment_reference', 'partner_id', 'journal_id', 'invoice_user_id'];

export const salesInvoiceView = {
  list: [
    'display_name', 'partner_id', 'journal_id', 'invoice_date', 'date', 'invoice_date_due', 'invoice_origin',
    'ref', 'invoice_user_id', 'activities', 'company_id',
    'amount_untaxed_in_currency_signed', 'amount_tax_in_currency_signed', 'amount_total_in_currency_signed', 'amount_residual_in_currency_signed',
    'currency_id', 'status_in_payment',
  ],
  listFields: INVOICE_LIST_FIELDS,
  listLabels: { display_name: 'Number', partner_id: 'Customer', invoice_date: 'Invoice Date', currency_id: 'Invoice Currency' },
  groupByLabels: INVOICE_GROUP_BY_LABELS,
  listDecoration: invoiceListDecoration,
  listActions: [registerPaymentsListAction],
  searchFields: INVOICE_SEARCH_FIELDS,
  filters: invoiceSearchFilters({ purchases: false }),
  groupBys: INVOICE_GROUP_BYS,
};

export const purchaseInvoiceView = {
  list: [
    'display_name', 'partner_id', 'journal_id', 'invoice_date', 'date', 'invoice_date_due', 'invoice_origin',
    'payment_reference', 'ref', 'activities', 'company_id',
    'amount_untaxed_in_currency_signed', 'amount_tax_in_currency_signed', 'amount_total_in_currency_signed', 'amount_residual_in_currency_signed',
    'currency_id', 'status_in_payment', 'should_be_paid',
  ],
  listFields: INVOICE_LIST_FIELDS,
  listLabels: { display_name: 'Number', partner_id: 'Vendor', invoice_date: 'Bill Date', currency_id: 'Bill Currency' },
  groupByLabels: INVOICE_GROUP_BY_LABELS,
  listDecoration: invoiceListDecoration,
  listActions: [registerPaymentsListAction],
  searchFields: INVOICE_SEARCH_FIELDS,
  filters: invoiceSearchFilters({ purchases: true }),
  groupBys: INVOICE_GROUP_BYS,
};

/** Create a statement line for cash moved into or out of a cash journal. */
export function cashMove(db, journalId, { amount, label, date, statementId } = {}, sign = 1) {
  const journal = read(db, 'account.journal', journalId);
  if (!journal || journal.type !== 'cash') throw new Error('Cash operations are only available for cash journals');
  const num = typeof amount === 'number' ? amount : promptedAmount(amount);
  if (!Number.isFinite(num) || !(num > 0)) throw new Error('Enter a valid amount greater than 0');
  const moveLabel = (label ? String(label).trim() : '') || (sign >= 0 ? 'Put Money In' : 'Take Money Out');
  const moveDate = date || today();

  let resolvedStatementId = statementId ?? null;
  if (resolvedStatementId) {
    const stmt = read(db, 'account.bank.statement', resolvedStatementId);
    if (!stmt || stmt.journal_id !== journal.id || (stmt.company_id ?? 1) !== (journal.company_id ?? 1)) {
      throw new Error('Statement does not exist or belongs to another journal');
    }
    if (stmt.state === 'closed') throw new Error('Cannot add lines to a closed statement');
  } else {
    const openStmt = search(db, 'account.bank.statement').find(
      (s) => s.journal_id === journal.id && s.state === 'open' && s.active !== false
    );
    if (openStmt) resolvedStatementId = openStmt.id;
  }

  return create(db, 'account.bank.statement.line', {
    journal_id: journal.id,
    company_id: journal.company_id ?? 1,
    date: moveDate,
    payment_ref: moveLabel,
    amount: sign * Math.abs(num),
    state: 'to_check',
    ...(resolvedStatementId ? { statement_id: resolvedStatementId } : {}),
  });
}

export const putMoneyIn = (db, journalId, args) => cashMove(db, journalId, args, 1);
export const takeMoneyOut = (db, journalId, args) => cashMove(db, journalId, args, -1);

export const accountingModels = {
  'account.account': {
    label: 'Chart of Accounts',
    auditDelete: true,
    // Currency validation looks at the journal items of the whole change set, so it runs after move changes.
    guardLast: true,
    fields: {
      code: { type: 'char', label: 'Code', required: true, tracking: true },
      name: { type: 'char', label: 'Account Name', required: true, tracking: true },
      display_name: { type: 'char', label: 'Display Name', compute: (r) => [r.code, r.name].filter(Boolean).join(' ') },
      account_type: { type: 'selection', label: 'Type', options: ACCOUNT_TYPES, tracking: true },
      include_initial_balance: { type: 'boolean', label: 'Bring Accounts Balance Forward', readonly: true, compute: includeInitialBalance },
      non_trade: { type: 'boolean', label: 'Non Trade', hideWhen: (r) => !canBeNonTrade(r) },
      note: { type: 'text', label: 'Internal Notes' },
      currency_id: {
        type: 'many2one',
        relation: 'res.currency',
        label: 'Account Currency',
        tracking: true,
        hideWhen: (_r, db) => !hasMultiCurrency(db),
      },
      tax_ids: { type: 'many2many', relation: 'account.tax', label: 'Default Taxes', tracking: true, domain: (r, acc) => !r.company_id || !acc?.company_id || r.company_id === acc.company_id },
      fiscal_category_id: { type: 'many2one', relation: 'account.fiscal.category', label: 'Fiscal Category', tracking: true },
      tag_ids: { type: 'many2many', relation: 'account.account.tag', label: 'Tags', domain: (r) => r.applicability === 'accounts' },
      reconcile: { type: 'boolean', label: 'Allow Reconciliation', tracking: true },
      active: { type: 'boolean', label: 'Active', tracking: true },
      is_deferred: {
        type: 'boolean',
        label: 'Deferred',
        help: 'Check to enable deferred accounting, deferred dates will be required on invoice / bill',
        hideWhen: (r) => !isIncomeOrExpenseAccount(r),
      },
      deferred_account_id: {
        type: 'many2one',
        relation: 'account.account',
        label: 'Deferred Account',
        help: 'Account automatically used for deferred entries on this account.',
        domain: (candidate, acc) => candidate.active !== false && candidate.id !== acc?.id && (!acc?.company_id || !candidate.company_id || candidate.company_id === acc.company_id),
        hideWhen: (r) => !isIncomeOrExpenseAccount(r),
      },
      asset_model_id: { type: 'many2one', relation: 'account.asset.model', label: 'Depreciation Model' },
      create_asset: {
        type: 'selection',
        label: 'Create Asset',
        options: [['no', 'No'], ['draft', 'Draft'], ['validate', 'Validated']],
        help: 'Create an asset in draft or validated status upon bill validation.',
      },
      description: { type: 'text', label: 'Description' },
      current_balance: { type: 'monetary', label: 'Balance', currency: 'company', readonly: true },
      opening_debit: {
        type: 'monetary',
        label: 'Opening Debit',
        currency: 'company',
        compute: (r, db) => openingAmounts(db, r).debit,
      },
      opening_credit: {
        type: 'monetary',
        label: 'Opening Credit',
        currency: 'company',
        compute: (r, db) => openingAmounts(db, r).credit,
      },
    },
    defaults: () => ({ account_type: 'expense', active: true, tax_ids: [] }),
    guard: (db, before, after) => {
      if (after.non_trade && !canBeNonTrade(after)) return 'Non Trade requires a receivable or payable account';
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
      if (after.create_asset === 'validate') {
        const model = after.asset_model_id ? read(db, 'account.asset.model', after.asset_model_id) : null;
        if (!model?.account_depreciation_id || !model?.account_depreciation_expense_id) return 'Validated asset creation needs a depreciation model with depreciation accounts';
      }
      if (after.deferred_account_id) {
        const defAcc = read(db, 'account.account', after.deferred_account_id);
        if (!defAcc || defAcc.active === false) return 'Select an active deferred account';
        if (after.id && defAcc.id === after.id) return 'An account cannot defer to itself';
        if (after.company_id && defAcc.company_id && defAcc.company_id !== after.company_id) return 'Deferred account must belong to the account company';
      }
      if (after.currency_id) {
        const currency = read(db, 'res.currency', after.currency_id);
        if (!currency) return 'Select an existing account currency';
        if (currency.active === false) return 'Select an active account currency';
      }
      const currencyError = accountCurrencyChangeError(db, before, after);
      if (currencyError) return currencyError;
      if (before && (before.company_id ?? null) !== (after.company_id ?? null)) {
        const openingMoveIds = new Set((db.records['res.company'] ?? []).map((c) => c.account_opening_move_id).filter(Boolean));
        const isReferencedInOpeningMove = (db.records['account.move'] ?? []).some(
          (m) => openingMoveIds.has(m.id) && (m.line_ids ?? []).some((l) => l.account_id === before.id),
        );
        if (isReferencedInOpeningMove) {
          return 'An account referenced by an opening entry cannot be moved to another company';
        }
      }
      return null;
    },
    protectDelete: accountDeleteGuard,
    sort: (a, b) => String(a.code ?? '').localeCompare(String(b.code ?? '')),
    groupBys: ['account_type'],
    kanban: { title: 'name', lines: ['code', 'account_type'] },
    list: ['code', 'name', 'account_type', 'opening_debit', 'opening_credit', 'reconcile', 'currency_id'],
    listFields: { currency_id: { optional: (db) => (hasMultiCurrency(db) ? 'show' : 'hide') }, opening_debit: { optional: 'hide' }, opening_credit: { optional: 'hide' } },
    editableList: ['reconcile', 'opening_debit', 'opening_credit'],
    onchange: (r, key) => key === 'account_type' && !canBeNonTrade(r) ? { non_trade: false } : {},
    prepareWrite: (db, vals, before) => {
      const hasOpeningDebit = vals && 'opening_debit' in vals;
      const hasOpeningCredit = vals && 'opening_credit' in vals;
      if (!hasOpeningDebit && !hasOpeningCredit) return null;
      const current = openingAmounts(db, before);
      const d = hasOpeningDebit ? (Number(vals.opening_debit) || 0) : current.debit;
      const c = hasOpeningCredit ? (Number(vals.opening_credit) || 0) : current.credit;
      const nextDb = setOpeningBalance(db, before.id, { debit: d, credit: c, companyId: before.company_id ?? null });
      // The amounts live on the opening entry; the account only computes them.
      const { opening_debit: _debit, opening_credit: _credit, ...rest } = vals;
      return { db: nextDb, vals: rest };
    },
    views: ['list', 'kanban'],
    form: {
      title: 'display_name',
      titleFields: ['code', 'name'],
      smart: [{ label: 'Balance', valueField: 'current_balance', value: (db, r) => accountBalance(db, r), target: (r) => `accounting/journal-items?account=${r.id}` }],
      tabs: [
        {
          label: 'Accounting',
          groups: [
            ['account_type', 'currency_id', 'tax_ids', 'fiscal_category_id', 'tag_ids', 'reconcile', 'non_trade', 'active'],
            ['is_deferred', 'deferred_account_id', 'create_asset', 'asset_model_id'],
            ['description', 'note'],
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
    views: ['list', 'kanban'],
    searchFields: ['name', 'code'],
    guard: (db, before, after, _ctx, vals) => {
      const companyId = after.company_id ?? 1;
      if (before?.id) {
        const companies = db.records['res.company'] ?? [];
        for (const [field, label] of [
          ['tax_cash_basis_journal_id', 'Cash Basis Journal'],
          ['currency_exchange_journal_id', 'Exchange Difference Journal'],
        ]) {
          const blockedOwner = companies.find((c) => c[field] === before.id && (after.active === false || after.type !== 'general' || (after.company_id && after.company_id !== c.id)));
          if (blockedOwner) {
            return `Clear the ${label} of company ${blockedOwner.name} before archiving this journal or changing its type or company`;
          }
        }
      }
      const linkedOnlineAccount = before?.id ? onlineAccountForJournal(db, before.id) : null;
      if (linkedOnlineAccount) {
        if (!isOnlineFeedJournal(after)) return 'A journal linked to an online account must remain a bank or credit card journal';
        if (after.company_id && after.company_id !== (linkedOnlineAccount.company_id ?? 1)) return 'Cannot change the company of a journal linked to an online account';
        if (before?.bank_statements_source === 'online_sync' && after.bank_statements_source !== 'online_sync') {
          return 'Cannot change the bank feeds source of a journal linked to an online account';
        }
      }
      if (after.previous_bank_statements_source != null && after.bank_statements_source !== 'online_sync') {
        return 'Previous bank feeds source can only be stored while online synchronization is active';
      }
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
      if (after.sepa_pain_version != null && after.sepa_pain_version !== '') {
        if (after.type !== 'bank') return 'SEPA Pain Version is only valid for bank journals';
        if (!isValidSepaPainVersion(after.sepa_pain_version)) return 'Select a valid SEPA Pain Version';
      }
      return journalSequenceGuard(db, before, after) ?? secureHeadsGuard(db, before, after) ?? journalMethodLineGuard(db, before, after, vals);
    },
    protectDelete: (db, journal, staged) => ((journal.secure_chain_heads ?? []).length ? 'Journals with secure chains cannot be deleted' : null)
      ?? (db.records?.['account.payment.method.line'] ?? []).filter((l) => l.journal_id === journal.id).map((l) => protectMethodLineDelete(db, l, staged)).find(Boolean),
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
      currency_id: { type: 'many2one', relation: 'res.currency', label: 'Currency', optional: 'hide' },
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
      inbound_payment_method_line_ids: {
        type: 'one2many',
        relation: 'account.payment.method.line',
        label: 'Incoming Payments',
        editable: true,
        copy: false,
        compute: (r, db) => computeJournalMethodLines(r, db, 'inbound'),
        fields: {
          id: { type: 'integer', label: 'ID', hidden: true },
          sequence: { type: 'integer', label: 'Sequence', widget: 'handle' },
          payment_method_id: {
            type: 'many2one',
            relation: 'account.payment.method',
            label: 'Payment Method',
            required: true,
            domain: (m) => m.payment_type === 'inbound',
          },
          name: { type: 'char', label: 'Name', required: true },
          payment_account_id: {
            type: 'many2one',
            relation: 'account.account',
            label: 'Outstanding Receipts Account',
            domain: methodLineAccountDomain,
          },
        },
        newLine: (_r, db) => defaultNewJournalMethodLine(db, 'inbound'),
        onchange: methodLineOnchange,
      },
      outbound_payment_method_line_ids: {
        type: 'one2many',
        relation: 'account.payment.method.line',
        label: 'Outgoing Payments',
        editable: true,
        copy: false,
        compute: (r, db) => computeJournalMethodLines(r, db, 'outbound'),
        fields: {
          id: { type: 'integer', label: 'ID', hidden: true },
          sequence: { type: 'integer', label: 'Sequence', widget: 'handle' },
          payment_method_id: {
            type: 'many2one',
            relation: 'account.payment.method',
            label: 'Payment Method',
            required: true,
            domain: (m) => m.payment_type === 'outbound',
          },
          name: { type: 'char', label: 'Name', required: true },
          payment_account_id: {
            type: 'many2one',
            relation: 'account.account',
            label: 'Outstanding Payments Account',
            domain: methodLineAccountDomain,
          },
        },
        newLine: (_r, db) => defaultNewJournalMethodLine(db, 'outbound'),
        onchange: methodLineOnchange,
      },
      check_next_number: { type: 'integer', label: 'Next Check Number' },
      check_manual_sequencing: { type: 'boolean', label: 'Manual Numbering' },
      check_printing_layout: {
        type: 'selection',
        label: 'Check Layout',
        options: [
          ['top', 'Top'],
          ['middle', 'Middle'],
          ['bottom', 'Bottom'],
        ],
      },
      sepa_pain_version: {
        type: 'selection',
        label: 'SEPA Pain Version',
        options: SEPA_PAIN_VERSIONS,
      },
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
      previous_bank_statements_source: {
        type: 'selection', label: 'Previous Bank Feeds', hidden: true,
        options: [
          ['none', 'Not Set'],
          ['undefined', 'Undefined Yet'],
          ['file_import', 'Manual (or import CAMT, CSV, JPEG, OFX, PDF, PNG, XLS, XLSX)'],
          ['online_sync', 'Online Synchronization'],
        ],
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
      check_manual_sequencing: false, check_printing_layout: 'top',
    }),
    prepareCreate: (db, vals) => {
      let nextVals = { ...vals };
      for (const [field] of METHOD_LINE_FIELDS) {
        if (Array.isArray(nextVals[field]) && nextVals[field].some((l) => l?.id != null && l.id !== '')) {
          delete nextVals[field];
        }
      }
      return { db, vals: nextVals };
    },
    prepareWrite: (db, vals, before) => {
      let nextVals = { ...vals };
      if (nextVals.type !== undefined) {
        if (nextVals.type === 'bank') {
          if (nextVals.sepa_pain_version === undefined && (before?.type !== 'bank' || !before?.sepa_pain_version)) {
            nextVals.sepa_pain_version = DEFAULT_SEPA_PAIN_VERSION;
          }
        } else if (nextVals.sepa_pain_version === undefined) {
          nextVals.sepa_pain_version = null;
        }
      }
      return { db, vals: nextVals };
    },
    createDefaults: (db, vals = {}) => ({
      ...(isLiquidityJournal(vals) && vals.company_id === undefined ? { company_id: currentCompany(db) } : {}),
      ...(vals.payment_sequence === undefined ? { payment_sequence: isLiquidityJournal(vals) } : {}),
      ...(vals.refund_sequence === undefined ? derivedRefundSequence(vals) : {}),
      ...(vals.type === 'bank' && vals.bank_statements_source === undefined ? { bank_statements_source: 'undefined' } : {}),
      ...(vals.type === 'bank' && vals.sepa_pain_version === undefined ? { sepa_pain_version: DEFAULT_SEPA_PAIN_VERSION } : {}),
      ...(vals.type === 'sale' && vals.invoice_reference_type === undefined ? { invoice_reference_type: 'invoice' } : {}),
      ...(vals.type === 'sale' && vals.invoice_reference_model === undefined ? { invoice_reference_model: 'odoo' } : {}),
    }),
    onchange: (r, key, db) => {
      if (key === 'type') {
        const cashOrBank = isMethodLineJournal(r);
        const methodLines = db && !r.id
          ? {
              inbound_payment_method_line_ids: cashOrBank ? defaultJournalLinesForForm(db, r.type, 'inbound') : [],
              outbound_payment_method_line_ids: cashOrBank ? defaultJournalLinesForForm(db, r.type, 'outbound') : [],
            }
          : {};
        return {
          ...(isLiquidityJournal(r) && !r.company_id ? { company_id: db ? currentCompany(db) : 1 } : {}),
          ...(r.type === 'bank' && !r.bank_statements_source ? { bank_statements_source: 'undefined' } : {}),
          ...(r.type === 'bank' && !r.sepa_pain_version ? { sepa_pain_version: DEFAULT_SEPA_PAIN_VERSION } : r.type !== 'bank' && r.sepa_pain_version ? { sepa_pain_version: null } : {}),
          ...(r.type === 'sale' && !r.invoice_reference_type ? { invoice_reference_type: 'invoice' } : {}),
          ...(r.type === 'sale' && !r.invoice_reference_model ? { invoice_reference_model: 'odoo' } : {}),
          payment_sequence: isLiquidityJournal(r),
          ...(r.refund_sequence ? {} : derivedRefundSequence(r)),
          ...methodLines,
        };
      }
      return {};
    },
    onCreate: (db, after, _before, vals) => syncJournalMethodLines(db, after, vals),
    onWrite: (db, after, before, vals) => syncJournalMethodLines(db, after, vals, before),
    onUnlink: (db, removed) => unlinkJournalMethodLines(db, removed),
    sort: (a, b) => (a.sequence ?? 10) - (b.sequence ?? 10) || a.id - b.id,
    filters: [[
      { id: 'sales', label: 'Sales', fn: (r) => r.type === 'sale' },
      { id: 'purchases', label: 'Purchases', fn: (r) => r.type === 'purchase' },
      { id: 'liquidity', label: 'Liquidity', fn: (r) => isLiquidityJournal(r) },
      { id: 'miscellaneous', label: 'Miscellaneous', fn: (r) => r.type === 'general' },
    ], [
      { id: 'archived', label: 'Archived', includeArchived: true, fn: (r) => r.active === false },
    ]],
    kanban: { title: 'name', lines: ['code', 'type'], counter: { label: 'Entries', model: 'account.move', field: 'journal_id' } },
    list: ['sequence', 'name', 'type', 'code', 'default_account_id', 'currency_id', 'active', 'company_id'],
    form: {
      title: 'name',
      chatter: true,
      buttons: [
        {
          label: 'Put Money In',
          when: (j) => j?.type === 'cash',
          ask: [{ label: 'Amount', type: 'number' }],
          run: (db, j, input) => {
            const amount = Array.isArray(input) ? input[0] : input;
            const res = putMoneyIn(db, j.id, { amount });
            return { db: res.db };
          },
        },
        {
          label: 'Take Money Out',
          when: (j) => j?.type === 'cash',
          ask: [{ label: 'Amount', type: 'number' }],
          run: (db, j, input) => {
            const amount = Array.isArray(input) ? input[0] : input;
            const res = takeMoneyOut(db, j.id, { amount });
            return { db: res.db };
          },
        },
      ],
      smart: [{ label: 'Journal Items', value: (db, j) => journalItems(db).filter((line) => line.journal_id === j.id).length, target: (j) => `accounting/journal-items?journal=${j.id}` }],
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
          'currency_id',
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
            { label: 'Incoming Payments', ...(cashOrBank ? { fields: ['inbound_payment_method_line_ids'] } : {}), groups: [['outstanding_receipts_account_id']] },
            { label: 'Outgoing Payments', ...(cashOrBank ? { fields: ['outbound_payment_method_line_ids'] } : {}), groups: [['outstanding_payments_account_id', ...(j.type === 'bank' ? ['sepa_pain_version'] : []), 'check_next_number', 'check_manual_sequencing', 'check_printing_layout']] },
          ] : []),
          ...(advancedGroups.length ? [{ label: 'Advanced Settings', groups: advancedGroups }] : []),
        ];
      },
    },
  },

  'account.move': {
    label: 'Invoices',
    auditDelete: true,
    actions: { postAutoPostMoves },
    prepareCreate: (db, vals) => {
      let nextVals = { ...vals };
      if (nextVals.move_type === 'entry' && (!nextVals.state || nextVals.state === 'draft') && Array.isArray(nextVals.line_ids)) {
        nextVals.line_ids = computeEntryTaxLines(nextVals.line_ids, nextVals, db);
      }
      if (['in_invoice', 'in_refund'].includes(nextVals.move_type) && Array.isArray(nextVals.invoice_line_ids)) {
        nextVals.invoice_line_ids = nextVals.invoice_line_ids.map(({ purchase_line_key, ...line }) => line);
      }
      return { db, vals: nextVals };
    },
    prepareWrite: (db, vals, before) => {
      let nextVals = { ...vals };
      const moveType = nextVals.move_type ?? before.move_type;
      const state = nextVals.state ?? before.state;
      if (moveType === 'entry' && state === 'draft') {
        const touches = ['line_ids', 'date', 'invoice_date', 'currency_id'].some((k) => k in nextVals);
        if (touches) {
          const effectiveMove = { ...before, ...nextVals };
          const lines = nextVals.line_ids ?? before.line_ids ?? [];
          nextVals.line_ids = computeEntryTaxLines(lines, effectiveMove, db);
        }
      }
      if (['in_invoice', 'in_refund'].includes(moveType) && Array.isArray(nextVals.invoice_line_ids)) {
        nextVals.invoice_line_ids = nextVals.invoice_line_ids.map(({ purchase_line_key, ...line }) => line);
      }
      return { db, vals: nextVals };
    },
    guard: (db, before, after, ctx) => {
      if (['in_invoice', 'in_refund'].includes(after.move_type)) {
        const previous = before?.invoice_line_ids ?? [];
        for (const [index, line] of (after.invoice_line_ids ?? []).entries()) {
          if (!line.purchase_line_id || (previous[index]?.purchase_line_id === line.purchase_line_id && previous[index]?.product_id === line.product_id && before?.partner_id === after.partner_id && before?.company_id === after.company_id)) continue;
          const orders = (db.records['purchase.order'] ?? []).filter((po) => (po.order_line ?? []).some((pol) => pol.id === line.purchase_line_id));
          const po = orders[0];
          const source = po?.order_line.find((pol) => pol.id === line.purchase_line_id);
          if (orders.length !== 1 || (po.company_id ?? 1) !== (after.company_id ?? 1) || (after.partner_id && !sameCommercialPartner(db, po.partner_id, after.partner_id)) || (line.product_id && source.product_id !== line.product_id)) return 'Purchase order line must match the vendor, company, and product';
        }
      }
      const roundingTarget = (m) => ({ id: m.invoice_cash_rounding_id, companyId: m.company_id ?? 1, currencyId: m.currency_id ?? findCompanyCurrencyRecord(db, m.company_id ?? 1)?.id });
      const roundingErr = cashRoundingError(db, roundingTarget(after), before && roundingTarget(before));
      if (roundingErr) return roundingErr;
      if (after.invoice_payment_term_id) {
        const term = read(db, 'account.payment.term', after.invoice_payment_term_id);
        if (term?.company_id && term.company_id !== (after.company_id ?? 1)) return 'Payment terms belong to another company';
      }
      if (['out_invoice', 'out_refund', 'in_invoice', 'in_refund'].includes(after.move_type)) {
        const expectedUse = isPurchase(after) ? 'purchase' : 'sale';
        const beforeLines = before?.invoice_line_ids ?? [];
        const beforeMap = new Map();
        beforeLines.forEach((l, idx) => {
          const key = l.line_id ?? l.id;
          if (key != null) beforeMap.set(String(key), l);
          beforeMap.set(`idx:${idx}`, l);
        });

        const linesToCheck = [];
        if (!before) {
          linesToCheck.push(...(after.invoice_line_ids ?? []));
        } else {
          for (let i = 0; i < (after.invoice_line_ids ?? []).length; i++) {
            const line = after.invoice_line_ids[i];
            const key = line.line_id ?? line.id;
            const beforeLine = key != null ? beforeMap.get(String(key)) : beforeMap.get(`idx:${i}`);
            if (!beforeLine || !sameTaxIds(line, beforeLine)) {
              linesToCheck.push(line);
            }
          }
        }

        for (const line of linesToCheck) {
          if (isSectionOrNote(line)) continue;
          for (const taxId of lineTaxIds(line)) {
            const tax = read(db, 'account.tax', taxId);
            if (tax && tax.type_tax_use && tax.type_tax_use !== expectedUse) {
              return expectedUse === 'sale'
                ? 'Customer invoices and credit notes only accept sale taxes'
                : 'Vendor bills and refunds only accept purchase taxes';
            }
          }
        }
      }
      const counterpart = before?.intercompany_move_id ? read(db, 'account.move', before.intercompany_move_id) : null;
      const counterpartBlocked = counterpart && (counterpart.state === 'posted' || Number(counterpart.amount_paid) > 0 || paymentState(counterpart, db) === 'paid');
      if (['out_invoice', 'out_refund'].includes(before?.move_type) && counterpartBlocked && ((before?.state === 'posted' && after.state !== 'posted') || (before?.state !== 'cancel' && after.state === 'cancel'))) {
        return 'The inter-company bill is posted or paid; issue a credit note instead';
      }
      return archivedLineAccountGuard(db, before, after, ctx) ?? moveGuard(db, before, after, ctx) ?? paymentGuard(db, before, after, ctx) ?? (after.state === 'posted' && badLineSign(after.line_ids) ? 'Debits and credits cannot be negative' : null) ?? (after.state === 'posted' && badCurrencyAmountSign(after.line_ids) ? 'The currency amount sign must match the debit/credit balance' : null);
    },
    invariant: (db, after, before, stored, ctx) => secureMoveInvariant(db, after, before) ?? lockedSettlementInvariant(db, after, before, ctx) ?? moveInvariant(db, after, before, stored),
    protectDelete: (db, m, staged, ctx) => ((db.records['res.company'] ?? []).some((c) => c.account_opening_move_id === m.id) || (staged?.records?.['res.company'] ?? []).some((c) => c.account_opening_move_id === m.id) ? 'Opening entries cannot be deleted' : null) ?? moveDeleteGuard(db, m, staged, ctx) ?? settledByCreditNote(db, m) ?? (settlingEntries(db).has(m.id) || Number(m.amount_paid) > 0 ? 'Entries tied to a payment cannot be deleted' : null),
    // The restrictive audit trail is a setting of the move's own company.
    audited: (db, move) => read(db, 'res.company', move?.company_id ?? 1)?.audit_trail === true,
    onCreate: (db, after) => ['in_invoice', 'in_refund'].includes(after.move_type) ? syncInvoicedQty(db, after) : db,
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
      if (after.state === 'cancel' && before?.state !== 'cancel') {
        const draftAssets = (db.records['account.asset'] ?? []).filter((a) => a.bill_id === (before?.id ?? after.id) && a.state === 'draft').map((a) => a.id);
        if (draftAssets.length) {
          db = unlink(db, 'account.asset', draftAssets);
        }
      }
      if (before?.state !== after.state) {
        db = syncDeferralOnMoveStateChange(db, after, before?.state);
      }
      if (!['invoice_line_ids', 'state', 'sale_id', 'purchase_id'].some((key) => key in vals)) return db;
      return syncInvoicedQty(syncInvoicedQty(db, before), after);
    },
    // The partner's payment term becomes the default; the term and invoice date drive the due date.
    onchange: (r, key, db, context = {}) => {
      if (['partner_id', 'fiscal_position_id', 'company_id'].includes(key)) {
        const partnerChange = key === 'partner_id';
        const partner = partnerChange && r.partner_id ? read(db, 'res.partner', r.partner_id) : null;
        const term = partner ? (isPurchase(r) ? partner.property_supplier_payment_term_id : partner.property_payment_term_id) : null;
        const fiscal = (partnerChange || key === 'company_id') ? { fiscal_position_id: fiscalPositionFor(db, r.partner_id, r.company_id ?? 1) } : {};
        const isEligibleVendorBank = (b) => b.active !== false && (!b.company_id || b.company_id === (r.company_id ?? 1)) && sameCommercialPartner(db, b.partner_id, r.partner_id);
        const selectedBank = partnerChange && isPurchase(r) && r.partner_bank_id ? read(db, 'res.partner.bank', r.partner_bank_id) : null;
        const eligibleBanks = partnerChange && isPurchase(r) ? search(db, 'res.partner.bank').filter(isEligibleVendorBank).sort((a, b) => Number(Boolean(b.allow_out_payment)) - Number(Boolean(a.allow_out_payment))) : [];
        const partnerBank = isInbound(r) ? (selectedBank && recipientBankDomain(selectedBank, r, db) ? selectedBank.id : null) : selectedBank && isEligibleVendorBank(selectedBank) && (selectedBank.allow_out_payment || !eligibleBanks[0]?.allow_out_payment)
          ? selectedBank.id : (eligibleBanks[0]?.id ?? null);
        const journal = resolveDocumentJournal(db, r)?.id ?? null;
        const nextContext = { ...r, ...fiscal, journal_id: journal };
        // The state before this change: the form's previous values, else the stored record.
        const previous = context.previous ?? (r.id ? read(db, 'account.move', r.id) : null) ?? {};
        // Accounts filled by a product are already mapped for the fiscal position the document had before this change.
        const previousContext = {
          ...r,
          company_id: previous.company_id ?? r.company_id,
          journal_id: previous.journal_id ?? r.journal_id,
          fiscal_position_id: key === 'fiscal_position_id' ? (previous.fiscal_position_id ?? null) : (r.fiscal_position_id ?? null),
        };
        const previousJournal = resolveDocumentJournal(db, previousContext);
        const linesUpdate = Array.isArray(r.invoice_line_ids)
          ? { invoice_line_ids: r.invoice_line_ids.map((line) => {
            const remapKey = (key === 'fiscal_position_id' || partnerChange || key === 'company_id') && !['line_section', 'line_note'].includes(line.display_type)
              ? (line.product_id ? 'product_id' : (line.account_id && (read(db, 'account.account', line.account_id)?.tax_ids ?? []).length ? 'account_id' : null))
              : null;
            // A line account still equal to the one this document auto-computed before the change follows the new
            // fiscal position. Any other account was chosen by the user and is preserved.
            const autoBefore = line.product_id
              ? invoiceLineOriginalAccount(db, previousContext, { ...line, account_id: null, income_account_id: null }, previousJournal)
              : null;
            const autoFilled = Boolean(autoBefore?.account) && line.account_id === autoBefore.account;
            const autoAfter = autoFilled
              ? invoiceLineOriginalAccount(db, nextContext, { ...line, account_id: null, income_account_id: null }, resolveDocumentJournal(db, nextContext))
              : null;
            const accountId = autoFilled ? (autoAfter.error ? null : autoAfter.account) : (line.account_id ?? null);
            const accountFiscalPositionId = autoFilled ? (nextContext.fiscal_position_id ?? null) : (line.account_fiscal_position_id ?? null);
            const updated = remapKey ? invoiceLineField.onchange(line, remapKey, db, nextContext) : line;
            return { ...updated, account_id: accountId, account_fiscal_position_id: accountFiscalPositionId, ...(remapKey ? { price_unit: line.price_unit, qty: line.qty, discount: line.discount } : {}), analytic_distribution: defaultDistributionForLine(db, { ...updated, account_id: accountId }, nextContext, line.analytic_distribution ?? {}) };
          }) }
          : {};
        return {
          ...fiscal,
          ...(key === 'company_id' && !r.id ? invoiceCompanyDefaults(db, r, previous, context) : {}),
          ...(partnerChange && isPurchase(r) ? { partner_bank_id: partnerBank } : {}),
          ...linesUpdate,
          ...(partnerChange ? {
            invoice_payment_term_id: term ?? null,
            ...termDue(db, { ...r, invoice_payment_term_id: term ?? null }, { clear: true }),
          } : {}),
        };
      }
      if (r.move_type === 'entry') {
        if (key === 'date') {
          const entryDate = moveDate(r);
          const companyId = r.company_id ?? db?.settings?.current_company_id ?? 1;
          const lines = (!r.state || r.state === 'draft')
            ? (r.line_ids ?? []).map((l) => revalueForeignLine(db, l, entryDate, companyId))
            : (r.line_ids ?? []);
          const updatedMove = { ...r, date: r.date, invoice_date: r.date, line_ids: lines };
          return { invoice_date: r.date, line_ids: computeEntryTaxLines(lines, updatedMove, db) };
        }
        if (key === 'line_ids' || key === 'currency_id') return { line_ids: computeEntryTaxLines(r.line_ids, r, db) };
      }
      if (key === 'invoice_date') {
        if (r.invoice_payment_term_id) return termDue(db, r);
        const prev = context.previous ?? (r.id ? read(db, 'account.move', r.id) : null);
        const prevDate = prev?.invoice_date;
        const shouldFollow = !r.invoice_date_due || Boolean(prevDate && r.invoice_date_due === prevDate);
        return shouldFollow && r.invoice_date ? { invoice_date_due: r.invoice_date } : {};
      }
      if (key === 'invoice_payment_term_id') return termDue(db, r);
      if (key === 'purchase_id') {
        const previous = context.previous ?? (r.id ? read(db, 'account.move', r.id) : null) ?? {};
        const prevPoId = previous.purchase_id ?? null;
        const clearing = !r.purchase_id;
        const changingPo = prevPoId != null && prevPoId !== r.purchase_id;
        const prevPo = prevPoId ? read(db, 'purchase.order', prevPoId) : null;
        const dropOrder = prevPo;
        const dropLineIds = new Set((dropOrder?.order_line ?? []).map((l) => l.id).filter((id) => id != null));
        const shouldKeepLine = (line) => {
          if (!clearing && !changingPo) return true;
          if (dropOrder) {
            const pid = purchaseLineId(db, line, dropOrder.id);
            return !(pid != null && dropLineIds.has(pid));
          }
          if (prevPoId != null) {
            const pid = purchaseLineId(db, line, prevPoId);
            if (pid == null) return !line.purchase_line_key;
            return search(db, 'purchase.order').some((order) => (order.order_line ?? []).some((pol) => pol.id === pid));
          }
          return line.purchase_line_id == null && !line.purchase_line_key;
        };
        const baseLines = (r.invoice_line_ids ?? []).filter(shouldKeepLine);
        if (clearing) {
          const clearOrigin = Boolean(dropOrder && r.invoice_origin === dropOrder.name);
          return {
            ...(Array.isArray(r.invoice_line_ids) ? { invoice_line_ids: baseLines } : {}),
            ...(clearOrigin ? { invoice_origin: null } : {}),
          };
        }
        const po = read(db, 'purchase.order', r.purchase_id);
        if (!po) return {};
        const eligible = billableLines(db, po.id);
        const companyChanged = (po.company_id ?? 1) !== (r.company_id ?? 1);
        const journal = resolveDocumentJournal(db, { ...r, ...(companyChanged ? { id: null, journal_id: null } : {}), partner_id: po.partner_id, company_id: po.company_id ?? 1, move_type: r.move_type ?? 'in_invoice' });
        const unbilledLines = (po.order_line ?? []).map((l, i) => {
          const toBill = eligible[i]?.toBill ?? Math.max(0, (Number(l.qty) || 0) - (Number(l.qty_invoiced) || 0));
          const { qty_delivered, qty_invoiced, purchase_method, purchase_line_key, id, ...lineData } = l;
          let accId = lineData.account_id ?? null;
          if (!accId && journal && lineData.product_id) {
            const resolved = invoiceLineOriginalAccount(db, { ...r, partner_id: po.partner_id, fiscal_position_id: po.fiscal_position_id ?? r.fiscal_position_id, company_id: po.company_id ?? r.company_id ?? 1, move_type: r.move_type ?? 'in_invoice' }, lineData, journal);
            if (!resolved.error && resolved.account) accId = resolved.account;
          }
          return {
            ...lineData,
            account_id: accId,
            purchase_line_id: id,
            qty: toBill,
          };
        }).filter((l) => Number(l.qty) > 0);
        const dueInfo = termDue(db, { ...r, partner_id: po.partner_id, invoice_payment_term_id: po.payment_term_id ?? null }, { clear: true });
        return {
          partner_id: po.partner_id ?? null,
          company_id: po.company_id ?? 1,
          ...(companyChanged ? { journal_id: journal?.id ?? null } : {}),
          currency_id: po.currency_id ?? null,
          invoice_payment_term_id: po.payment_term_id ?? null,
          invoice_origin: po.name ?? r.invoice_origin,
          invoice_line_ids: [...baseLines, ...unbilledLines.filter((line) => !baseLines.some((existing) => existing.purchase_line_id === line.purchase_line_id))],
          ...dueInfo,
        };
      }
      // BILL-4: auto-populate payment_reference from ref on vendor bills
      if (key === 'ref' && isPurchase(r)) {
        const previous = context.previous ?? (r.id ? read(db, 'account.move', r.id) : null) ?? {};
        const prevRef = String(previous.ref ?? '').trim();
        const shouldUpdate = !r.payment_reference || r.payment_reference === prevRef;
        if (shouldUpdate) return { payment_reference: r.ref ?? '' };
      }
      return {};
    },
    fields: {
      tax_closing_lines: { type: 'json', label: 'Tax Closing Lines', readonly: true, hidden: true },
      name: { type: 'char', label: 'Number', readonly: true, tracking: true },
      display_name: { type: 'char', label: 'Display Name', compute: (r) => (r.name && r.name !== '/' ? r.name : t('Draft (* {id})', { id: r.id })) },
      move_type: { type: 'selection', label: 'Type', readonly: true, copy: true, options: [['out_invoice', 'Customer Invoice'], ['out_refund', 'Credit Note'], ['in_invoice', 'Vendor Bill'], ['in_refund', 'Vendor Refund'], ['entry', 'Journal Entry']] },
      journal_id: {
        type: 'many2one',
        relation: 'account.journal',
        label: 'Journal',
        tracking: true,
        domain: (j, r, db) => (!j.company_id || j.company_id === (r?.company_id ?? db?.settings?.current_company_id ?? 1)) && (r?.move_type === 'entry' ? true : isPurchase(r) ? j.type === 'purchase' : j.type === 'sale'),
      },
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Partner', tracking: true },
      invoice_user_id: { type: 'many2one', relation: 'hr.employee', label: 'Salesperson' },
      partner_bank_id: {
        type: 'many2one',
        relation: 'res.partner.bank',
        label: 'Recipient Bank Account',
        domain: recipientBankDomain,
      },
      ref: { type: 'char', label: 'Reference', tracking: true },
      date: { type: 'date', label: 'Accounting Date', tracking: true },
      accounting_date: { type: 'date', label: 'Date', compute: (r) => r.date ?? r.invoice_date ?? null },
      invoice_date: { type: 'date', label: 'Date', tracking: true },
      invoice_date_due: { type: 'date', label: 'Due Date', tracking: true },
      invoice_origin: { type: 'char', label: 'Source Document', readonly: true },
      payment_reference: { type: 'char', label: 'Payment Reference', tracking: true },
      currency_id: { type: 'many2one', relation: 'res.currency', label: 'Currency', tracking: true, emptyAsCompanyCurrency: true },
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
        fields: { id: { type: 'integer', label: 'ID', hidden: true }, date: { type: 'date', label: 'Paid on' }, amount: { type: 'monetary', label: 'Amount' }, move_id: { type: 'many2one', relation: 'account.move', label: 'Payment' }, payment_move_id: { type: 'many2one', relation: 'account.move', label: 'Payment' }, company_amount: { type: 'monetary', label: 'Company Amount', currency: 'company' }, line_index: { type: 'integer', label: 'Closing Line Index', hidden: true }, payment_company_amount: { type: 'monetary', label: 'Payment Company Amount', currency: 'company' }, payment_fx_move_id: { type: 'many2one', relation: 'account.move', label: 'Exchange Entry' }, cash_basis_move_id: { type: 'many2one', relation: 'account.move', label: 'Journal Entry' }, discount: { type: 'boolean', label: 'Early Payment Discount' }, partial_reconcile_id: { type: 'many2one', relation: 'account.partial.reconcile', label: 'Partial Reconcile', hidden: true }, reversed: { type: 'boolean', label: 'Reversed' }, unapplied: { type: 'boolean', label: 'Unreconciled' }, reversal_move_id: { type: 'many2one', relation: 'account.move', label: 'Reversal Entry' }, reversal_date: { type: 'date', label: 'Reversal Date' } },
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
      should_be_paid: { type: 'selection', label: 'Should Be Paid', compute: (r, db) => shouldBePaid(db, r), options: [['yes', 'Yes'], ['no', 'No'], ['exception', 'Exception']] },
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
      deferred_entry_type: { type: 'selection', label: 'Deferred Entry Type', readonly: true, hidden: true, options: [['expense', 'Expense'], ['revenue', 'Revenue'], ['misc', 'Misc']] },
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
      purchase_id: { type: 'many2one', relation: 'purchase.order', label: 'Purchase Order', readonly: (r) => r.state !== 'draft' },
      inalterable_hash: { type: 'char', label: 'Inalterability Hash', readonly: true },
      inalterable_hash_version: { type: 'integer', label: 'Hash Version', readonly: true, hidden: true },
      secure_sequence_number: { type: 'integer', label: 'Inalterability Sequence Number', readonly: true },
      incoterm_id: { type: 'many2one', relation: 'account.incoterm', label: 'Incoterm', domain: (r) => r.active !== false },
      incoterm_location: { type: 'char', label: 'Incoterm Location' },
      exclude_from_followup: { type: 'boolean', label: 'Exclude from Follow-up' },
      to_check: { type: 'boolean', label: 'To Check', copy: false },
      is_move_sent: { type: 'boolean', label: 'Is Move Sent', copy: false, readonly: true },
      auto_post: {
        type: 'selection',
        label: 'Auto-post',
        copy: false,
        options: [
          ['no', 'No'],
          ['at_date', 'At Date'],
          ['monthly', 'Monthly'],
          ['quarterly', 'Quarterly'],
          ['yearly', 'Yearly'],
        ],
      },
      auto_post_until: { type: 'date', label: 'Repeat Until', copy: false },
      auto_post_origin_id: { type: 'many2one', relation: 'account.move', label: 'Recurring Origin', readonly: true },
      narration: { type: 'text', label: 'Terms and Conditions' },
    },
    defaults: () => ({ name: '/', move_type: 'out_invoice', state: 'draft', invoice_date: today(), auto_post: 'no', invoice_line_ids: [], line_ids: [], amount_paid: 0, is_move_sent: false }),
    // Gear-menu Print, like Odoo's report binding: prints in any state (drafts as Draft Invoice); the header Print stays posted-only.
    menuActions: [
      { label: 'Print', when: (r) => isInvoice(r), run: (db, r) => ({ db, go: `#/print/account.move/${r.id}` }) },
      {
        label: 'Proforma Invoice',
        when: (r) => r.state === 'draft' && ['out_invoice', 'in_invoice'].includes(r.move_type),
        run: (db, r) => ({ db, go: `#/print/account.move/${r.id}?report=proforma` }),
      },
    ],
    createDefaults: (db, vals = {}) => {
      const moveType = vals.move_type ?? 'out_invoice';
      const companyId = vals.company_id ?? currentCompany(db);
      if (moveType !== 'entry') {
        const salesperson = vals.invoice_user_id == null ? currentUserId(db) : null;
        const defaultJournal = vals.journal_id == null && !vals.invoice_line_ids?.length && !vals.line_ids?.length
          ? resolveDocumentJournal(db, { move_type: moveType, company_id: companyId })?.id ?? null
          : null;
        return {
          ...invoiceCompanyDefaults(db, { ...vals, move_type: moveType, company_id: companyId }),
          ...(salesperson ? { invoice_user_id: salesperson } : {}),
          ...(defaultJournal ? { journal_id: defaultJournal } : {}),
        };
      }
      const date = vals.date ?? vals.invoice_date ?? today();
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
    kanban: { title: 'display_name', lines: ['partner_id', 'amount_total', 'invoice_date_due'], badge: 'payment_state' },
    list: ['display_name', 'partner_id', 'invoice_date', 'invoice_date_due', 'amount_untaxed', 'amount_total', 'amount_residual', 'status_in_payment'],
    listLabels: { display_name: 'Number' },
    listDecoration: invoiceListDecoration,
    graph: { groupBy: 'invoice_date', measure: 'amount_total' },
    pivot: { row: 'partner_id', col: 'payment_state', measure: 'amount_total' },
    calendar: { date: 'invoice_date_due' },
    form: {
      statusbar: 'state',
      statusbarHide: ['cancel'],
      lockedWhen: (r) => r.state !== 'draft' || Boolean(r.inalterable_hash),
      unlockedFields: ['to_check'],
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
          label: (r) => (['in_invoice', 'in_refund'].includes(r?.move_type) ? 'Deferred Expenses' : 'Deferrals'),
          when: (r, db) => moveDeferrals(db, r).length > 0,
          value: (db, r) => moveDeferrals(db, r).length,
          target: (r, db) => {
            const list = moveDeferrals(db, r);
            const targetBase = ['in_invoice', 'in_refund'].includes(r?.move_type) ? 'accounting/deferred-expenses' : 'accounting/deferrals';
            return list.length === 1 ? `${targetBase}/${list[0].id}` : `${targetBase}?view=list&rel=${r.reversed_entry_id ? `id:${list.map((item) => item.id).join(',')}` : `move_id:${r.id}`}`;
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
        {
          label: 'Assets',
          when: (r, db) => ['in_invoice', 'in_refund'].includes(r?.move_type) && moveAssets(db, r).length > 0,
          value: (db, r) => moveAssets(db, r).length,
          target: (r, db) => {
            const list = moveAssets(db, r);
            return list.length === 1 ? `accounting/assets/${list[0].id}` : `accounting/assets?view=list&rel=${r.reversed_entry_id ? `id:${list.map((item) => item.id).join(',')}` : `bill_id:${r.id}`}`;
          },
        },
        {
          label: 'Purchase Orders', app: 'purchase',
          when: (r, db) => ['in_invoice', 'in_refund'].includes(r?.move_type) && movePurchaseOrders(db, r).length > 0,
          value: (db, r) => movePurchaseOrders(db, r).length,
          target: (r, db) => {
            const list = movePurchaseOrders(db, r);
            return list.length === 1 ? (list[0].state === 'purchase' ? `purchase/po/${list[0].id}` : `purchase/rfq/${list[0].id}`) : `purchase/rfq?view=list&rel=id:${list.map((po) => po.id).join(',')}`;
          },
        },
      ],
      buttons: [
        { label: 'Confirm', primary: true, when: (r) => r.state === 'draft', visible: (r) => isInvoice(r), run: (db, r) => ({ db: postMove(db, r.id) }) },
        { label: 'Post', primary: true, when: (r) => r.move_type === 'entry' && r.state === 'draft', run: (db, r) => ({ db: postMove(db, r.id) }) },
        {
          label: 'Reverse Entry',
          when: (r, db) => r.state === 'posted' && r.move_type === 'entry' && (!r.reversal_move_id || (db?.records['account.move'] ?? []).some((m) => m.id === r.reversal_move_id && m.state === 'cancel')) && !(db?.records['account.move'] ?? []).some((m) => m.state === 'posted' && m.reversed_entry_id === r.id) && !(db && settlingEntries(db).has(r.id)),
          wizard: (db, r) => ({ title: 'Reverse Entry', fields: reversalWizardFields(r.journal_id ?? null, r?.company_id ?? 1) }),
          run: (db, r, values = {}) => reverseOneEntry(db, r, values),
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
          wizard: (db, r) => {
            const initialDate = today();
            const initialCurrId = r.currency_id ?? companyCurrencyRecord(db, r.company_id)?.id;
            const docRound = (n) => roundCurrency(n, documentCurrency(db, r));
            const openDocAmount = (date) => docRound(residual(r, db) - discountAvailable(db, r, date || today()));
            const computeDiff = (vals) => {
              const d = vals?.date || today();
              const c = vals?.currency_id ?? initialCurrId;
              const entered = Number(vals?.amount);
              if (!Number.isFinite(entered)) return 0;
              const docAmount = invoiceCurrencyAmount(db, r, entered, d, c);
              const target = docRound(residual(r, db) - appliedEarlyDiscount(db, r, docAmount, d));
              const open = paymentCurrencyAmount(db, r, target, d, c);
              const currRec = read(db, 'res.currency', c);
              return roundCurrency(Math.max(0, open - entered), currRec);
            };
            const hasDiff = (vals) => computeDiff(vals) > 0.000001;

            const fields = [
              {
                name: 'amount',
                type: 'monetary',
                label: 'Payment Amount',
                required: true,
                default: String(paymentCurrencyAmount(db, r, openDocAmount(initialDate), initialDate, initialCurrId)),
              },
              {
                name: 'currency_id',
                type: 'many2one',
                relation: 'res.currency',
                label: 'Currency',
                required: true,
                default: initialCurrId,
                domain: (c) => c.active !== false,
              },
              { name: 'date', type: 'date', label: 'Payment Date', required: true, default: initialDate },
              {
                name: 'journal_id',
                type: 'many2one',
                relation: 'account.journal',
                label: 'Payment Journal',
                required: true,
                default: defaultPaymentJournalId(db, r.company_id ?? 1),
                domain: (j) => (!j.company_id || j.company_id === (r.company_id ?? 1)) && isLiquidityJournal(j),
              },
            ];

            if (isPurchase(r) && !isInbound(r)) {
              fields.push({
                name: 'partner_bank_id',
                type: 'many2one',
                relation: 'res.partner.bank',
                label: 'Recipient Bank Account',
                default: r.partner_bank_id ?? null,
                domain: (b) => isEligibleRecipientBank(db, b, r.partner_id, r.company_id ?? 1),
              });
            }

            fields.push(
              { name: 'memo', type: 'char', label: 'Memo', default: invoicePaymentMemo(r) },
              {
                name: 'payment_difference',
                type: 'monetary',
                label: 'Payment Difference',
                readonly: true,
                default: 0,
                invisible: (vals) => !hasDiff(vals),
                compute: (vals) => computeDiff(vals),
              },
              {
                name: 'payment_difference_handling',
                type: 'selection',
                label: 'Payment Difference Handling',
                options: [['open', 'Keep open'], ['reconcile', 'Mark as fully paid']],
                default: 'open',
                invisible: (vals) => !hasDiff(vals),
              },
              {
                name: 'writeoff_account_id',
                type: 'many2one',
                relation: 'account.account',
                label: 'Write-off Account',
                domain: (a) => eligibleCounterpart(a, r.company_id ?? 1),
                invisible: (vals) => !hasDiff(vals) || vals?.payment_difference_handling !== 'reconcile',
                required: (vals) => hasDiff(vals) && vals?.payment_difference_handling === 'reconcile',
              },
              {
                name: 'writeoff_label',
                type: 'char',
                label: 'Label',
                default: 'Write-Off',
                invisible: (vals) => !hasDiff(vals) || vals?.payment_difference_handling !== 'reconcile',
              },
            );

            return {
              title: 'Register Payment',
              fields,
              onchange: (vals, key) => {
                if (key === 'date' || key === 'currency_id') {
                  const d = vals?.date || today();
                  const c = vals?.currency_id ?? initialCurrId;
                  return { amount: String(paymentCurrencyAmount(db, r, openDocAmount(d), d, c)) };
                }
                return {};
              },
            };
          },
          run: registerPayment,
        },
        {
          label: 'Send',
          email: 'document',
          primary: (r) => !r.is_move_sent,
          when: (r) => r.state === 'posted' && ['out_invoice', 'out_refund'].includes(r.move_type),
          wizard: (db, r) => {
            const partner = r.partner_id ? read(db, 'res.partner', r.partner_id) : null;
            return {
              title: 'Send',
              fields: [
                { name: 'email', type: 'boolean', label: 'Email', default: Boolean(partner?.email?.trim?.()) },
                { name: 'download', type: 'boolean', label: 'Download', default: false },
              ],
            };
          },
          run: (db, r, values = {}) => {
            if (!values?.email && !values?.download) {
              throw new Error('Select at least one channel: Email or Download');
            }
            const markSent = !values.live && Boolean(values.download);
            return {
              db: markSent ? write(db, 'account.move', r.id, { is_move_sent: true }) : db,
              ...(values.download ? { go: `#/print/account.move/${r.id}` } : {}),
            };
          },
        },
        {
          label: 'Credit Note',
          when: (r) => r.state === 'posted' && r.move_type === 'out_invoice',
          wizard: (db, r) => ({
            title: isPurchase(r) ? 'Refund' : 'Credit Note',
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
          label: 'Refund',
          when: (r) => r.state === 'posted' && r.move_type === 'in_invoice',
          wizard: (db, r) => ({
            title: isPurchase(r) ? 'Refund' : 'Credit Note',
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
        {
          label: 'Reset to Draft',
          when: (r, db) => canResetMove(r, db),
          run: (db, r) => {
            const draftReversals = (db.records['account.move'] ?? []).filter(
              (m) => m.state === 'draft' && m.auto_post && m.auto_post !== 'no' && (m.reversed_entry_id === r.id || m.id === r.reversal_move_id)
            );
            const cancelledDb = draftReversals.reduce((acc, m) => write(cancelMove(acc, m).db, 'account.move', m.id, { auto_post: 'no' }), db);
            const nextDb = write(cancelledDb, 'account.move', r.id, {
              state: 'draft',
              is_move_sent: false,
              ...(draftReversals.some((m) => m.id === r.reversal_move_id) ? { reversal_move_id: null } : {}),
              ...(isInvoice(r) ? { line_ids: [] } : {})
            });
            return { db: removeAnalytic(nextDb, r.id) };
          },
        },
        { label: 'Lock', when: canLockEntry, run: (db, r) => ({ db: secureEntries(db, { throughMoveId: r.id }) }) },
        { label: 'Cancel Entry', when: (r) => r.move_type === 'entry' && r.state === 'draft' && Boolean(r.id) && !r.inalterable_hash, run: cancelMove },
        { label: 'Cancel', when: (r) => r.state === 'draft' && !r.inalterable_hash, visible: (r) => isInvoice(r), run: cancelMove },
      ],
      ribbon: (r) => (r.state === 'cancel' ? 'Cancelled' : paymentState(r) === 'paid' ? 'Paid' : paymentState(r) === 'partial' ? 'Partial' : null),
      subtitle: (r) => ({ in_invoice: 'Vendor Bill', in_refund: 'Vendor Refund', out_refund: 'Credit Note', entry: 'Journal Entry' })[r.move_type] ?? 'Customer Invoice',
      title: 'name',
      // Evaluated for the record on screen only: it scans the partner's receivables or vendor bill duplicates.
      warning: (r, db) => (r.move_type === 'out_invoice' ? creditWarning(db, r.partner_id, r.state === 'posted' ? 0 : total(r, db), r) : ['in_invoice', 'in_refund'].includes(r.move_type) ? duplicateBillWarning(db, r) : unbalancedEntryWarning(db, r)),
      groups: (r) => (isInvoice(r)
        ? [
          [{ field: 'partner_id', label: isPurchase(r) ? 'Vendor' : 'Customer' }, ...(isPurchase(r) ? ['purchase_id', { field: 'ref', label: 'Bill Reference' }] : [])],
          [
            { field: 'invoice_date', label: isPurchase(r) ? 'Bill Date' : 'Invoice Date' },
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
          { label: 'Payments', fields: ['payments'], readonly: true, widget: 'appliedPayments' },
          {
            label: 'Other Info',
            groups: [
              {
                title: 'Invoice',
                fields: [
                  ...(isPurchase(r) ? [] : [{ field: 'ref', label: 'Customer Reference' }]),
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
                'to_check',
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
      // The payments tab lists each active applied payment with an Unreconcile action that removes only that matching.
      appliedPayments: {
        title: 'Applied Payments',
        unreconcileLabel: 'Unreconcile',
        fields: [
          { name: 'name', label: 'Payment' },
          { name: 'date', label: 'Paid on' },
          { name: 'amount', label: 'Amount', money: true },
        ],
        list: (db, r) => appliedPayments(db, r),
        canUnreconcile: (db, r, row) => canUnreconcilePaymentRow(db, r, row),
        unreconcile: (db, r, row) => ({
          db: unreconcileInvoicePayment(db, r.id, row.move_id, {
            lineIndex: row.line_index,
            rowId: typeof row.row_id === 'number' ? row.row_id : (typeof row.id === 'number' ? row.id : null),
          }),
        }),
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

/** Check compatibility of companies within a tax unit (same country, each has currency, same currency). */
export function taxUnitCompatibilityError(db, unit) {
  const companies = Array.isArray(unit?.company_ids) ? unit.company_ids : [];
  const companyRecords = companies.map((id) => read(db, 'res.company', id));
  if (companyRecords.some((c) => !c)) return null;
  const mainCompany = read(db, 'res.company', unit.main_company_id);
  const normCountry = (v) => String(v ?? '').trim().toLowerCase();
  const unitCountry = normCountry(unit.country) || normCountry(mainCompany?.country);
  const hasAnyCompanyCountry = companyRecords.some((company) => normCountry(company?.country));
  if (unitCountry && hasAnyCompanyCountry) {
    if (companyRecords.some((company) => !normCountry(company?.country))) {
      return 'Set a country on every company in the tax unit';
    }
    if (companyRecords.some((company) => normCountry(company.country) !== unitCountry)) {
      return 'All companies in a tax unit must have the same country';
    }
  }
  const currencyRecords = companies.map((id) => findCompanyCurrencyRecord(db, id));
  if (currencyRecords.some((c) => !c?.id)) {
    return 'Set a currency on every company in the tax unit';
  }
  if (new Set(currencyRecords.map((c) => c.id)).size > 1) {
    return 'All companies in a tax unit must use the same currency';
  }
  return null;
}

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
      const compatErr = taxUnitCompatibilityError(db, after);
      if (compatErr) return compatErr;
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
      if ((!after.account_depreciation_id || !after.account_depreciation_expense_id)
        && (db.records['account.account'] ?? []).some((a) => a.asset_model_id === after.id && a.create_asset === 'validate')) {
        return 'Validated asset creation needs a depreciation model with depreciation accounts';
      }
      if (after.method === 'linear' && after.method_mode === 'rate' && !(Number(after.method_rate) > 0 && Number(after.method_rate) <= 1)) {
        return 'Rate must be greater than zero and at most one';
      }
      if (after.method !== 'no_depreciation' && (!Number.isFinite(Number(after.method_number)) || Number(after.method_number) <= 0)) {
        return 'The duration must be positive';
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
          ['no_depreciation', 'No Depreciation'],
        ],
      },
      method_number: { type: 'float', label: 'Number of Depreciations', required: true },
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
      method_mode: { type: 'selection', label: 'Based On', options: [['duration', 'Duration'], ['rate', 'Rate']] },
      method_rate: { type: 'float', label: 'Rate' },
      prorata_computation_type: { type: 'selection', label: 'Computation', options: [['none', 'No Prorata'], ['constant_periods', 'Constant Periods'], ['daily_computation', 'Based on days per period']] },
      prorata_date: { type: 'date', label: 'Prorata Date' },
      prorata: { type: 'boolean', label: 'Prorata Temporis' },
      account_asset_id: { type: 'many2one', relation: 'account.account', label: 'Asset Account' },
      account_depreciation_id: { type: 'many2one', relation: 'account.account', label: 'Depreciation Account' },
      account_depreciation_expense_id: { type: 'many2one', relation: 'account.account', label: 'Depreciation Expense Account' },
      account_expense_id: { type: 'many2one', relation: 'account.account', label: 'Legacy Expense Account', readonly: true, compute: (r) => r.account_depreciation_expense_id ?? null },
      journal_id: { type: 'many2one', relation: 'account.journal', label: 'Journal' },
      analytic_distribution: { type: 'distribution', label: 'Analytic Distribution' },
    },
    defaults: () => ({ method: 'linear', method_mode: 'duration', method_number: 5, method_rate: 0.2, method_period: '12', method_progress_factor: 0.3, prorata: false }),
    onchange: (r, key) => syncMethodRateAndDuration(r, key),
    list: ['name', 'method', 'method_number', 'method_period', 'account_asset_id', 'account_depreciation_id', 'account_depreciation_expense_id'],
    form: {
      title: 'name',
      groups: [
        ['name', 'company_id', 'journal_id', 'account_asset_id', 'account_depreciation_id', 'account_depreciation_expense_id'],
        ['method', 'method_mode', 'method_rate', 'method_number', 'method_period', 'method_progress_factor', 'prorata_computation_type', 'prorata_date', 'analytic_distribution'],
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
      title: 'hash_date',
      hideTitle: true,
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
