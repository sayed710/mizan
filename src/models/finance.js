// Credit limits, lock date, audit trail, tax report, aged balances, follow-ups, analytic accounting and budgets.
import { indexGlMatchings, lineKey } from './glMatchIndex.js';
import { installments } from './terms.js';
import { normalizePhone, queueSms } from './sms.js';
import { models } from '../registry.js';
import { create, postNote, read, search, write } from '../orm.js';
import { addDays, commercialPartnerId, sameCommercialPartner, today, total, validDate } from './common.js';
import { ACTIVITY_TYPES } from './mail.js';
import { currentActor, employeeFor } from './actor.js';
import { bookedStatementAmount, distributeInstallmentSettlements, invoiceCounterpartAccount, isBalanced, isLiquidityJournal, isPaymentMatched, isStatementJournal, journalItems, outstandingAccount, partnerAccount, paymentJournal, postEntry, resolveDocumentJournal, validStornoMove } from './ledger.js';
import { toCompany } from './currency.js';
import { cashBasisTransitionAccounts, isLegacyCashBasisRelease, isNonZeroBaseGridLine, isSectionOrNote, resolveLineTaxes, taxBaseTags, taxRepartitionLines } from './taxes.js';
import { deduplicatedTaxBase, taxItemBase } from './taxBase.js';
import { companySum, reportingBookedAmount, unratedCount } from './money.js';
import { companyCurrencyRecord, documentCurrency, findCompanyCurrencyRecord, formatCurrency, round, roundCurrency } from '../money.js';
import { paymentCompanyAmount, settlementCompanyAmount, settlementCompanyAllocations, applicationEffectiveDate, applicationActiveAt } from './settlement.js';
import { exchangeAccount } from './exchange-account.js';
import { onlineAccountForJournal } from './onlineSync.js';
import { effectiveCompanyLockDates } from './lockexception.js';

export { applicationEffectiveDate };

/** Whether Sales Credit Limit is enabled on the target (or current) company. */
export const creditLimitEnabled = (db, companyId = null) => {
  if (!db) return false;
  const cid = companyId ?? db.settings?.current_company_id ?? 1;
  return Boolean(read(db, 'res.company', cid)?.account_use_credit_limit);
};

/** Open receivable (posted, unpaid invoices) of a partner's commercial entity. */
export const receivableOf = (db, partnerId, companyId = 1) => {
  const commercialId = commercialPartnerId(db, partnerId);
  if (!commercialId) return 0;
  return roundCurrency((db.records['account.move'] ?? [])
    .filter((m) => m.active !== false && m.state === 'posted' && m.move_type === 'out_invoice' && sameCommercialPartner(db, m.partner_id, commercialId) && (m.company_id ?? 1) === companyId)
    .reduce((s, m) => s + toCompany(db, m.currency_id, models['account.move'].fields.amount_residual.compute(m, db), m.invoice_date ?? m.date, companyId), 0), companyCurrencyRecord(db, companyId));
};

/** Warning for additional credit exposure (0 = no limit). */
export function creditWarning(db, partnerId, amount, document = {}) {
  if (!db || !partnerId || document.state === 'cancel') return '';
  const companyId = document.company_id ?? 1;
  if (!creditLimitEnabled(db, companyId)) return '';
  const p = read(db, 'res.partner', partnerId);
  if (!p) return '';
  const company = read(db, 'res.company', companyId);
  const commercialId = commercialPartnerId(db, partnerId);
  const commercial = (commercialId ? read(db, 'res.partner', commercialId) : null) ?? p;
  const target = commercial.use_partner_credit_limit ? commercial : (p.use_partner_credit_limit ? p : commercial);
  const limit = target.use_partner_credit_limit
    ? (Number(target.credit_limit) || 0)
    : (Number(company.account_default_credit_limit) || 0);
  if (!(limit > 0)) return '';
  const compCurrency = companyCurrencyRecord(db, companyId);
  const docDate = document.invoice_date ?? document.date_order ?? document.date;
  const docCompanyAmount = toCompany(db, document.currency_id, amount, docDate, companyId);
  const exposure = roundCurrency(receivableOf(db, commercial.id, companyId) + docCompanyAmount, compCurrency);
  if (!(exposure > limit)) return '';
  return `${commercial.name} has reached its credit limit of: ${formatCurrency(limit, compCurrency)}. Total amount due (including this document): ${formatCurrency(exposure, compCurrency)}`;
}

/**
 * Non-blocking warning when another vendor bill for the same vendor has the same reference,
 * or (when no reference is set) the same amount and bill date.
 */
export function duplicateBillWarning(db, bill) {
  if (!bill || !['in_invoice', 'in_refund'].includes(bill.move_type) || bill.state === 'cancel' || !bill.partner_id || !db) return '';
  const companyId = bill.company_id ?? 1;
  const ref = String(bill.ref ?? '').trim();
  const docCurr = documentCurrency(db, bill);
  const billTotal = roundCurrency(total(bill, db), docCurr);
  const candidates = search(db, 'account.move').filter((m) =>
    m.id !== bill.id
    && m.active !== false
    && m.move_type === bill.move_type
    && m.state !== 'cancel'
    && (m.company_id ?? 1) === companyId
    && sameCommercialPartner(db, m.partner_id, bill.partner_id)
  );
  const dups = ref
    ? candidates.filter((m) => String(m.ref ?? '').trim().toLowerCase() === ref.toLowerCase())
    : candidates.filter((m) => {
        if (!bill.invoice_date || m.invoice_date !== bill.invoice_date) return false;
        if (!(billTotal > 0)) return false;
        if ((m.currency_id ?? null) !== (bill.currency_id ?? null)) return false;
        const mTotal = roundCurrency(total(m, db), documentCurrency(db, m));
        return mTotal === billTotal;
      });
  if (!dups.length) return '';
  const vendor = read(db, 'res.partner', bill.partner_id)?.name ?? 'this vendor';
  const labels = dups.map((d) => (d.name && d.name !== '/' ? d.name : `#${d.id}`)).join(', ');
  return ref
    ? `Duplicate bill warning: ${vendor} already has bill ${labels} with reference ${ref}`
    : `Duplicate bill warning (amount/date heuristic only; matching details do not establish document identity): ${vendor} already has bill ${labels} on ${bill.invoice_date} for the same amount`;
}

const LOCKED_FIELDS = ['name', 'invoice_line_ids', 'line_ids', 'invoice_date', 'date', 'state', 'partner_id', 'currency_id', 'move_type', 'journal_id', 'company_id', 'fiscal_position_id', 'tax_return_id', 'active'];
/** Hashed fields that can never change once an entry receives an inalterability hash. */
const HASHED_FIELDS = ['ref', 'name', 'line_ids', 'invoice_line_ids', 'invoice_date', 'date', 'state', 'partner_id', 'journal_id', 'company_id', 'inalterable_hash', 'secure_sequence_number', 'inalterable_hash_version', 'move_type', 'reversed_entry_id', 'reversal_move_id', 'correction_of_id', 'is_closing', 'currency_id', 'fiscal_position_id'];
/** Paid status of a locked entry, which only payments dated after the lock may move. */
const SETTLEMENT_FIELDS = ['amount_paid', 'payments', 'payment_date'];
export const moveDate = (m) => m?.date ?? m?.invoice_date ?? today();
/** Archiving hides a record from every report, so `active` counts as changed only between kept and archived; `blocked` (dispute flag) may toggle on posted lines. */
const stripBlocked = (lines) => (lines ?? []).map((l) => Object.fromEntries(Object.entries(l ?? {}).filter(([k]) => k !== 'blocked')));
const valueOf = (r, k) => JSON.stringify(k === 'active' ? r?.active !== false : k === 'line_ids' ? stripBlocked(r?.line_ids) : r?.[k]);
const changedFields = (before, after, fields) => fields.some((k) => valueOf(before, k) !== valueOf(after, k));

/** True when the paid status moved only by appending payments dated after the lock, and by exactly their amount. */
function settlesAfterLock(db, before, after, lock) {
  const was = Array.isArray(before.payments) ? before.payments : [];
  const now = Array.isArray(after.payments) ? after.payments : [];
  if (now.length < was.length || JSON.stringify(now.slice(0, was.length)) !== JSON.stringify(was)) return false;
  const added = now.slice(was.length);
  if (!added.every((p) => p && typeof p.date === 'string' && p.date > lock && Number(p.amount) > 0)) return false;
  const docRound = (n) => roundCurrency(n, documentCurrency(db, after));
  const paid = docRound((Number(before.amount_paid) || 0) + added.reduce((sum, p) => sum + Number(p.amount), 0));
  const date = added.length ? added.at(-1).date : before.payment_date;
  return docRound(paid - (Number(after.amount_paid) || 0)) === 0 && after.payment_date === date;
}

/**
 * Entries in a locked period cannot be created posted or have their accounting changed (payments dated after the
 * lock date may still settle them); with the audit trail on, a posted entry keeps its number.
 */
/**
 * The latest lock date configured on the move's company: general and hard locks always apply, then
 * the sales or purchase lock by journal type. Empty when nothing is locked.
 */
/** Whether a move carries any tax line, tax identifier/rate, or tax-grid indicator. */
export function hasTaxLines(move = {}) {
  return (move.line_ids ?? []).some((line) => Boolean(
    line.tax_name
    || line.tax_id
    || (Array.isArray(line.tax_ids) && line.tax_ids.length > 0)
    || line.tax_grid_base
    || line.tax_grid_release
    || (Array.isArray(line.tax_tag_ids) && line.tax_tag_ids.length > 0)
    || Number(line.tax),
  ))
  || (move.invoice_line_ids ?? []).some((line) => Boolean(
    line.tax_id
    || line.tax_name
    || (Array.isArray(line.tax_ids) && line.tax_ids.length > 0)
    || (Array.isArray(line.tax_breakdown) && line.tax_breakdown.length > 0)
    || Number(line.tax),
  ));
}

/**
 * The strictest lock date configured on the move's company: general and hard locks always apply, then
 * the sales or purchase lock by journal type, and tax lock for taxable moves. Empty when nothing is locked.
 */
export function lockDateFor(company = {}, move = {}, journal = null) {
  const globalLock = company.lock_date ?? '';
  const hardLock = company.hard_lock_date ?? '';
  const sales = String(move.move_type ?? '').startsWith('out_') || journal?.type === 'sale';
  const purchases = String(move.move_type ?? '').startsWith('in_') || journal?.type === 'purchase';
  const salesLock = sales ? (company.sale_lock_date ?? '') : '';
  const purchasesLock = purchases ? (company.purchase_lock_date ?? '') : '';
  const taxable = hasTaxLines(move);
  const taxLock = taxable ? (company.tax_lock_date ?? '') : '';

  return [globalLock, hardLock, salesLock, purchasesLock, taxLock].filter(Boolean).sort().at(-1) ?? '';
}

export const companyLockDate = (db, move, ctx = null) => {
  if (!move) return '';
  const compId = move.company_id ?? 1;
  const rawComp = read(db, 'res.company', compId) ?? {};
  const comp = effectiveCompanyLockDates(rawComp, db, ctx);
  const journal = move.journal_id ? read(db, 'account.journal', move.journal_id) : null;
  return lockDateFor(comp, move, journal);
};

/** The applicable lock date for an entry or record: company lock, tax lock, and closed fiscal-year lock. */
export function recordLockDate(db, record, ctx = null) {
  if (!record) return '';
  const compId = record.company_id ?? 1;
  return [companyLockDate(db, record, ctx), taxLockFor(db, record, ctx), closedYearLock(db, compId)].filter(Boolean).sort().at(-1) ?? '';
}

export const companyTaxLock = (db, companyId, ctx = null) => {
  const comp = read(db, 'res.company', companyId);
  const effComp = effectiveCompanyLockDates(comp, db, ctx);
  return effComp?.tax_lock_date ?? null;
};

export function returnCompanies(db, ret) {
  if (!ret.tax_unit_id) return [ret.company_id ?? 1];
  const unit = read(db, 'account.tax.unit', ret.tax_unit_id);
  if (!unit || !(unit.company_ids ?? []).includes(ret.company_id ?? 1)) throw new Error('Tax unit must contain the return company');
  return [...new Set(unit.company_ids)];
}

export const returnTaxLock = (db, companyId, excludeId = null) => (db.records?.['account.return'] ?? [])
  .filter((r) => r.id !== excludeId && ['submitted', 'paid'].includes(r.state) && returnCompanies(db, r).includes(companyId))
  .map((r) => r.date_to).filter(Boolean).sort().at(-1) ?? '';

export const isReturnEntry = (db, move) => !!move.tax_return_id && (read(db, 'account.return', move.tax_return_id)?.closing_move_ids ?? []).includes(move.id);

/** Tax locks apply only to entries carrying tax information or touching a tax account. */
export function taxLockFor(db, move, ctx = null) {
  if (!move) return '';
  const compId = move?.company_id ?? 1;
  // A submitted or paid return keeps its period locked even if the company setting is lowered below it.
  // A return's own closing entry is unlocked by resetting that return, so it is not held by the floor.
  const lock = [companyTaxLock(db, compId, ctx), returnTaxLock(db, compId, isReturnEntry(db, move) ? move.tax_return_id : null)].filter(Boolean).sort().at(-1);
  if (!lock) return '';
  const accounts = taxAccounts(db, compId);
  const ids = new Set([...accounts.sale, ...accounts.purchase,
    ...cashBasisTransitionAccounts(db, compId)]);
  const taxable = hasTaxLines(move) || (move.line_ids ?? []).some((line) => ids.has(line.account_id));
  return taxable ? lock : '';
}

/** A reconciled bank transaction points at this entry: it has to stay posted and in place. */
export const bookedByBank = (db, id) => (db.records['account.bank.statement.line'] ?? []).some((l) => l.bank_move_id === id || l.writeoff_move_id === id || (l.allocations ?? []).some((a) => a.payment_move_id === id || a.writeoff_move_id === id) || (l.state === 'reconciled' && (l.move_id === id || l.payment_move_id === id)));

/**
 * Journal items of a posted entry need an existing account: reports group by account and silently skip unknown
 * ones, so a single bad line would stop the trial balance and balance sheet from closing.
 */
export function accountsError(db, before, after) {
  if (after.state !== 'posted') return null;
  if (before?.state === 'posted' && JSON.stringify(before.line_ids) === JSON.stringify(after.line_ids)) return null;
  const known = new Set((db.records?.['account.account'] ?? []).map((a) => a.id));
  const bad = (after.line_ids ?? []).findIndex((l) => ((Number(l.debit) || 0) || (Number(l.credit) || 0)) && !known.has(l.account_id));
  return bad < 0 ? null : `Journal item ${bad + 1} needs an existing account`;
}

/**
 * Whether `line` is stated in a currency other than its account's currency. A line without an explicit currency is
 * stated in the entry company's currency; an empty line without a currency has no amount to state.
 */
function lineCurrencyMismatch(db, line, account, companyId) {
  if (!account?.currency_id) return false;
  const amount = (Number(line.debit) || 0) + (Number(line.credit) || 0);
  if (!amount && !line.currency_id) return false;
  const currencyId = line.currency_id ?? companyCurrencyRecord(db, companyId).id;
  return currencyId !== account.currency_id;
}

/** A posted entry keeps every journal item in its account's currency. */
export function accountCurrencyError(db, before, after) {
  if (after.state !== 'posted') return null;
  if (before?.state === 'posted' && JSON.stringify(before.line_ids) === JSON.stringify(after.line_ids)) return null;
  const companyId = after.company_id ?? 1;
  const accounts = new Map((db.records?.['account.account'] ?? []).map((account) => [account.id, account]));
  const bad = (after.line_ids ?? []).some((line) => lineCurrencyMismatch(db, line, accounts.get(line.account_id), companyId));
  return bad ? 'The account forces journal items in its currency' : null;
}

/** An account cannot adopt a currency that its already posted journal items do not use. */
export function accountCurrencyChangeError(db, before, after) {
  if ((before?.currency_id ?? null) === (after?.currency_id ?? null) || !after.currency_id) return null;
  const moves = db.records?.['account.move'] ?? [];
  const bad = moves.some((move) => move.state === 'posted'
    && (move.line_ids ?? []).some((line) => line.account_id === after.id
      && lineCurrencyMismatch(db, line, after, move.company_id ?? after.company_id ?? 1)));
  return bad ? 'The account has journal items in another currency' : null;
}

/** Accounts used by journal items cannot be deleted (archive them instead): their balances would vanish from reports. */
export function accountDeleteGuard(db, account, pending = db) {
  // `pending` is the database as the diff leaves it, so moves created in the same diff count too.
  const used = [...(db.records['account.move'] ?? []), ...(pending.records['account.move'] ?? [])].some((m) => (m.line_ids ?? []).some((l) => l.account_id === account.id));
  return used ? `${account.code} ${account.name} has journal items and cannot be deleted` : null;
}

/** What a posted entry keeps until it is reset to draft. */
const POSTED_FIELDS = ['name', 'line_ids', 'invoice_line_ids', 'partner_id', 'currency_id', 'move_type', 'journal_id', 'invoice_date', 'invoice_date_due', 'date', 'company_id', 'fiscal_position_id', 'tax_return_id', 'tax_closing_lines', 'active', 'is_storno'];

/** Workflow rules for posted entries that the browser's buttons follow and a forged change must follow too. */
function postedMoveRule(db, before, after) {
  if (before && changedFields(before, after, ['tax_closing_lines'])) return 'Tax closing line links cannot be changed';
  if (before?.state === 'posted' && after.state === 'posted') {
    if (changedFields(before, after, POSTED_FIELDS)) return 'Posted entries cannot be edited; reset them to draft first';
    if (before.reversed_entry_id && before.reversed_entry_id !== after.reversed_entry_id) return 'Posted entries cannot be edited; reset them to draft first';
    if ((before.is_storno || after.is_storno) && before.reversed_entry_id !== after.reversed_entry_id) return 'Posted entries cannot be edited; reset them to draft first';
  }
  if (before?.state === 'posted' && after.state !== 'posted') {
    // A sync may collapse the two reset steps; the return retains its link to the cancelled closing.
    const ret = before.tax_return_id && read(db, 'account.return', before.tax_return_id);
    const closingReset = after.state === 'cancel' && ret?.state === 'new' && (ret.closing_move_ids ?? []).includes(before.id)
      && !changedFields(before, after, [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((key) => key !== 'state'));
    if (after.state !== 'draft' && !closingReset) return 'Posted entries go back to draft before anything else';
    if (Number(before.amount_paid) > 0 || Number(after.amount_paid) > 0) return 'Paid entries cannot be reset to draft';
  }
  if (after.state === 'posted' && before?.state !== 'posted') {
    if (before && before.state !== 'draft') return 'Only draft entries can be posted';
    if (after.sale_id) {
      const sale = read(db, 'sale.order', after.sale_id);
      if (sale && (sale.company_id ?? 1) !== (after.company_id ?? 1)) return 'Invoice and sales order must belong to the same company';
    }
    if (after.purchase_id) {
      const po = read(db, 'purchase.order', after.purchase_id);
      if (po && (po.company_id ?? 1) !== (after.company_id ?? 1)) return 'Bill and purchase order must belong to the same company';
    }
    const lines = Array.isArray(after.line_ids) ? after.line_ids : [];
    if ((lines.some((l) => Number(l.debit) < 0 || Number(l.credit) < 0) || after.is_storno) && !validStornoMove(db, after)) return 'Debits and credits cannot be negative';
    if (!isBalanced(lines, companyCurrencyRecord(db, after.company_id))) return 'A posted entry needs balanced journal items';
    if (!after.name || after.name === '/') return 'A posted entry needs a number';
  }
  return null;
}

/** Whether invoice `inv` is settled by the credit (customer invoice, vendor refund) or the debit side of its partner's balance. */
const settledByCredit = (inv) => !['in_invoice', 'out_refund'].includes(inv.move_type);
/** Derive settlement consumption from the document and booking dates, never from caller-supplied amounts. */
export const appliedValue = (db, inv, p) => {
  const payment = (db.records['account.payment'] ?? []).find((x) => x.move_id === p.move_id && ['posted', 'reversed'].includes(x.state));
  const source = read(db, 'account.move', p.move_id);
  const date = p.partial_reconcile_id != null && !payment && source
    ? (source.invoice_date ?? source.date ?? p.date)
    : source?.move_type !== 'entry' && source?.invoice_date
      ? source.invoice_date
      : payment && !payment.invoice_id
        ? p.date
        : (inv.invoice_date ?? p.date);
  return toCompany(db, inv.currency_id, p.amount, date, inv.company_id);
};

/** Reason a credit note cannot settle an invoice (direction/type, link, company, partner, account, currency), or null. */
export function creditNotePairError(db, note, invoice, { allowDifferentCurrencies = false } = {}) {
  if (!note || note.state !== 'posted' || !['out_refund', 'in_refund'].includes(note.move_type)) return 'A posted credit note or refund is required';
  if (!invoice || invoice.state !== 'posted' || !['out_invoice', 'in_invoice'].includes(invoice.move_type)) return 'A posted invoice or bill is required';
  const expectedNoteType = invoice.move_type === 'out_invoice' ? 'out_refund' : 'in_refund';
  if (note.move_type !== expectedNoteType) return 'The credit note cannot settle this document type';
  if (note.reversed_entry_id && note.reversed_entry_id !== invoice.id) return 'This credit note is linked to another invoice';
  if ((note.company_id ?? 1) !== (invoice.company_id ?? 1)) return 'The credit note and invoice must belong to the same company';
  if (!sameCommercialPartner(db, note.partner_id, invoice.partner_id)) return 'The credit note and invoice must belong to the same partner';
  if (invoiceCounterpartAccount(db, note) !== invoiceCounterpartAccount(db, invoice)) return 'The credit note and invoice must share the same receivable or payable account';
  if (!allowDifferentCurrencies && (note.currency_id ?? null) !== (invoice.currency_id ?? null)) return 'The credit note and invoice must use the same currency';
  return null;
}

/** What a payment or discount entry can settle for `inv`: its partner's receivable/payable on the settling side. */
function settlementCapacity(db, entry, inv) {
  if (!entry || entry.state !== 'posted' || entry.id === inv.id || (entry.company_id ?? 1) !== (inv.company_id ?? 1)) return 0;
  const companyRound = (n) => roundCurrency(n, companyCurrencyRecord(db, inv.company_id));
  const taxReturn = (db.records['account.return'] ?? []).find((r) => (r.closing_move_ids ?? []).includes(inv.id) && ['submitted', 'paid'].includes(r.state));
  if (taxReturn) {
    const invCompanyId = inv.company_id ?? 1;
    let obligations;
    try {
      if (!returnCompanies(db, taxReturn).includes(invCompanyId)) return 0;
      obligations = taxClosingSpec(db, taxReturn, invCompanyId).obligations ?? [];
    } catch { return 0; }
    const payment = (db.records['account.payment'] ?? []).find((p) => p.state === 'posted' && p.is_tax_payment && p.return_id === taxReturn.id && p.move_id === entry.id);
    const settlement = (inv.payments ?? []).find((p) => p.move_id === entry.id && !p.reversed);
    const closingLine = Number.isInteger(settlement?.line_index) ? inv.line_ids?.[settlement.line_index] : null;
    if (!payment || !closingLine || closingLine.account_id !== payment.destination_account_id || closingLine.partner_id !== payment.partner_id
      || (payment.company_id ?? 1) !== invCompanyId) return 0;
    const signed = round((Number(closingLine.credit) || 0) - (Number(closingLine.debit) || 0));
    const obligation = obligations.find((o) => o.account_id === closingLine.account_id && o.partner_id === closingLine.partner_id);
    const paid = round((entry.line_ids ?? []).filter((line) => line.account_id === closingLine.account_id && line.partner_id === payment.partner_id)
      .reduce((sum, line) => sum + (Number(line.debit) || 0) - (Number(line.credit) || 0), 0));
    if (!signed || !obligation || signed !== obligation.amount || Math.sign(signed) !== Math.sign(paid)) return 0;
    return Math.min(Math.abs(signed), Math.abs(paid));
  }
  // A credit note and an invoice of matching partner, company, account and currency settle each other through their opposite receivable/payable lines.
  const creditPair = (note, original) => !creditNotePairError(db, note, original);
  if (entry.move_type !== 'entry' && !creditPair(entry, inv) && !creditPair(inv, entry)) return 0;
  const account = invoiceCounterpartAccount(db, inv);
  return companyRound((entry.line_ids ?? []).filter((l) => (l.partner_id === inv.partner_id || sameCommercialPartner(db, l.partner_id, inv.partner_id)) && l.account_id === account)
    .reduce((s, l) => s + (settledByCredit(inv) ? 1 : -1) * ((Number(l.credit) || 0) - (Number(l.debit) || 0)), 0));
}

/** Whether entry `id` records a posted payment or settles another entry, so resetting or deleting it would orphan them. */
function backsSettlement(db, id) {
  return (db.records['account.payment'] ?? []).some((p) => p.state === 'posted' && p.move_id === id)
    || (db.records['account.partial.reconcile'] ?? []).some((g) => g && g.active !== false && !g.reversed && (g.debit_move_id === id || g.credit_move_id === id || g.exchange_move_id === id))
    || (db.records['account.move'] ?? []).some((m) => m.id !== id && (m.payments ?? []).some((p) => p?.move_id === id || p?.payment_fx_move_id === id));
}

/** Whether a document `payments` row is backed by an existing `account.partial.reconcile` record whose moves and amount agree. */
function hasMatchingPartialLink(db, doc, row, { reversed = false } = {}) {
  if (row?.partial_reconcile_id == null) return false;
  const link = read(db, 'account.partial.reconcile', row.partial_reconcile_id);
  if (!link) return false;
  if (reversed ? (!link.reversed || link.active !== false) : (link.reversed || link.active === false)) return false;
  if (reversed && row.reversal_date && link.reversal_date && row.reversal_date !== link.reversal_date) return false;
  if ((link.company_id ?? 1) !== (doc.company_id ?? 1)) return false;
  const matchesPair = row.move_id !== doc.id && (
    (link.debit_move_id === doc.id && link.credit_move_id === row.move_id)
    || (link.credit_move_id === doc.id && link.debit_move_id === row.move_id)
  );
  if (!matchesPair) return false;
  if (read(db, 'account.move', row.move_id)?.state !== 'posted') return false;
  const docLineIndex = link.debit_move_id === doc.id ? link.debit_line_index : link.credit_line_index;
  if (doc.line_ids?.[docLineIndex]?.account_id !== link.account_id) return false;
  if (row.line_index != null && row.line_index !== docLineIndex) return false;
  const ownCurrency = companyCurrencyRecord(db, doc.company_id);
  const companyRound = (n) => roundCurrency(n, ownCurrency);
  const companyStep = Number(ownCurrency?.rounding ?? 0.01);
  const rowCompany = row.company_amount != null ? companyRound(Number(row.company_amount)) : companyRound(appliedValue(db, doc, row));
  const gapPartials = link.exchange_move_id
    ? (db.records['account.partial.reconcile'] ?? []).filter((g) => (
        g && (reversed ? g.reversed : (!g.reversed && g.active !== false))
        && (g.debit_move_id === doc.id || g.credit_move_id === doc.id)
        && (g.debit_move_id === link.exchange_move_id || g.credit_move_id === link.exchange_move_id)
      ))
    : [];
  const totalAmount = companyRound(Number(link.amount) + gapPartials.reduce((s, g) => s + Number(g.amount), 0));
  return Math.abs(totalAmount - rowCompany) <= companyStep + 1e-9;
}

/**
 * Checked once the whole change set is applied: the paid amount of an entry only moves by appending payments that point
 * at posted payment or discount entries for its partner, by exactly their amount and within what those entries settle;
 * an entry that records a payment stays posted while the payment does.
 */
/**
 * Credit released by unapplied rows must reach the payment, and their settlement-specific entries must be reversed,
 * in the same change. Compares the stored and resulting databases, so other applications in that change count too.
 */
function reversesJournalLines(source, reversal) {
  return Array.isArray(source?.line_ids) && source.line_ids.length > 0
    && JSON.stringify(source.line_ids.map((l) => [l.account_id, l.partner_id ?? null, l.debit || 0, l.credit || 0]))
      === JSON.stringify((reversal?.line_ids ?? []).map((l) => [l.account_id, l.partner_id ?? null, l.credit || 0, l.debit || 0]));
}

function unapplicationError(db, stored, after, before) {
  const moves = db.records['account.move'] ?? [];
  const entries = new Map(moves.map((m) => [m.id, m]));
  const released = (before?.payments ?? []).flatMap((p, i) => !p.reversed && after.payments?.[i]?.unapplied ? [{ row: p, date: after.payments[i].reversal_date }] : []);
  const mirrored = (source, reversal, date) => source?.state === 'posted' && source.move_type === 'entry'
    && (source.company_id ?? 1) === (after.company_id ?? 1)
    && reversal.state === 'posted' && reversal.move_type === 'entry' && reversal.reversed_entry_id === source.id
    && (reversal.company_id ?? 1) === (after.company_id ?? 1)
    && validDate(date) && reversal.invoice_date === date && date >= (source.invoice_date ?? source.date ?? '')
    && reversesJournalLines(source, reversal);
  if (released.some(({ row, date }) => [row.payment_fx_move_id, row.cash_basis_move_id].some((id) => id && !moves.some((move) => mirrored(entries.get(id), move, date))))) {
    return 'Unapplying a payment must reverse its exchange and cash-basis entries';
  }
  if (!stored) return null;
  const storedMoves = new Map((stored.records['account.move'] ?? []).map((m) => [m.id, m]));
  for (const moveId of new Set(released.map(({ row }) => row.move_id))) {
    // Net credit change for this payment across every move in the change: released rows add, new applications take.
    let change = 0;
    for (const move of moves) {
      const old = storedMoves.get(move.id)?.payments ?? [];
      (move.payments ?? []).forEach((row, i) => {
        if (row.move_id !== moveId) return;
        if (i >= old.length && !row.reversed) change -= Number(row.payment_company_amount) || 0;
        else if (i < old.length && !old[i].reversed && row.unapplied) {
          const amount = paymentCompanyAmount(stored, storedMoves.get(move.id), old[i]);
          if (!(amount > 0)) { change = NaN; return; }
          change += amount;
        }
      });
    }
    const payment = (db.records['account.payment'] ?? []).find((x) => x.move_id === moveId && x.state === 'posted');
    const glOnly = !payment && released.filter(({ row }) => row.move_id === moveId).every(({ row }) => hasMatchingPartialLink(db, after, row, { reversed: true }));
    if (glOnly) continue;
    const prior = (stored.records['account.payment'] ?? []).find((x) => x.id === payment?.id);
    const companyRound = (n) => roundCurrency(n, companyCurrencyRecord(db, after.company_id));
    if (!payment || !prior || !Number.isFinite(change) || companyRound(Number(payment.unapplied) - Number(prior.unapplied)) !== companyRound(change)) {
      return 'Unapplying a payment must restore its outstanding credit';
    }
  }
  return null;
}

/** Check whether a move is a generated currency exchange entry (or a reversal of one). */
export function isExchangeEntry(db, moveOrId) {
  // Walk the reversal chain iteratively; a client-supplied cycle ends the walk instead of recursing forever.
  const seen = new Set();
  let move = typeof moveOrId === 'object' && moveOrId !== null ? moveOrId : read(db, 'account.move', moveOrId);
  while (move && move.move_type === 'entry' && !seen.has(move.id)) {
    seen.add(move.id);
    const id = move.id;
    if (move.fx_payment_move_id && move.fx_invoice_id) return true;
    if ((db.records['account.partial.reconcile'] ?? []).some((g) => g && g.exchange_move_id === id)
      || (db.records['account.move'] ?? []).some((m) => (m.payments ?? []).some((p) => p.payment_fx_move_id === id))) return true;
    move = move.reversed_entry_id ? read(db, 'account.move', move.reversed_entry_id) : null;
  }
  return false;
}

export function moveInvariant(db, after, before, stored = null) {
  if (before?.state === 'posted' && after.state !== 'posted' && backsSettlement(db, after.id)) return 'This entry records a payment; reverse the payment instead';
  if (after.state === 'posted' && after.reversed_entry_id) {
    const target = read(db, 'account.move', after.reversed_entry_id);
    if (target && isExchangeEntry(db, target)) {
      if (target.reversed_entry_id) {
        return 'An exchange difference entry linked to a settlement cannot be reversed independently';
      }
      const hasActiveSettlement = (
        Boolean(target.fx_payment_move_id && target.fx_invoice_id)
        && (db.records['account.move'] ?? []).some((m) => (m.payments ?? []).some((p) => !p.reversed && !p.unapplied && p.payment_fx_move_id === target.id))
      ) || (db.records['account.partial.reconcile'] ?? []).some((g) => (
        g && g.active !== false && !g.reversed
        && g.exchange_move_id === target.id
      ));
      if (hasActiveSettlement) {
        return 'An exchange difference entry linked to a settlement cannot be reversed independently';
      }
    }
  }
  const was = Array.isArray(before?.payments) ? before.payments : [];
  const now = Array.isArray(after.payments) ? after.payments : [];
  const paidBefore = Number(before?.amount_paid) || 0;
  const paidAfter = Number(after.amount_paid) || 0;
  const docRound = (n) => roundCurrency(n, documentCurrency(db, after));
  const companyStep = Number(companyCurrencyRecord(db, after.company_id)?.rounding ?? 0.01);
  if (docRound(paidAfter - paidBefore) === 0 && JSON.stringify(was) === JSON.stringify(now)) return null;
  const reversed = was.filter((p, i) => !p.reversed && now[i]?.reversed);
  if (now.length < was.length || was.some((p, i) => {
    const current = now[i];
    if (JSON.stringify(current) === JSON.stringify(p)) return false;
    if (p.reversed || !current?.reversed) return true;
    // Unreconcile removes a credit application: the payment entry stays posted, so no reversing entry exists.
    if (current.unapplied) {
      const { reversed: flag, unapplied, reversal_date: unappliedOn, ...kept } = current;
      const payment = (db.records['account.payment'] ?? []).find((x) => x.move_id === p.move_id && x.state === 'posted');
      const glEntry = hasMatchingPartialLink(db, after, current, { reversed: true });
      return JSON.stringify(kept) !== JSON.stringify(p) || current.reversal_move_id || (!payment && !glEntry)
        || !unappliedOn || (p.date && unappliedOn < p.date);
    }
    const { reversed: flag, reversal_move_id: reversalId, reversal_date: revDate, ...original } = current;
    const entry = (db.records['account.move'] ?? []).find((m) => m.id === reversalId);
    const source = (db.records['account.move'] ?? []).find((m) => m.id === p.move_id);
    return JSON.stringify(original) !== JSON.stringify(p) || !source || entry?.state !== 'posted' || (revDate && revDate !== entry.invoice_date) || (p.date && p.date > entry.invoice_date) || entry.reversed_entry_id !== source.id
      || !reversesJournalLines(source, entry);
  })) return 'Registered payments cannot be changed without a posted reversing journal entry';
  const unapplication = unapplicationError(db, stored, after, before);
  if (unapplication) return unapplication;
  const added = now.slice(was.length);
  const entries = new Map((db.records['account.move'] ?? []).map((m) => [m.id, m]));
  if (!added.every((p) => {
    if (!p || !(Number(p.amount) > 0)) return false;
    if (settlementCapacity(db, entries.get(p.move_id), after) > 0) return true;
    const payment = (db.records['account.payment'] ?? []).find((x) => x.move_id === p.move_id && x.invoice_id === after.id && x.state === 'posted');
    return payment && entries.get(p.move_id)?.state === 'posted' && p.company_amount === 0
      && settlementCompanyAmount(db, { ...read(db, 'account.move', after.id), payments: was }, Number(p.amount)) === 0;
  })) return 'Payments must point at a posted journal entry';
  if (added.some((p) => !p.date || !/^\d{4}-\d{2}-\d{2}$/.test(p.date) || !Number.isFinite(Date.parse(p.date)) || new Date(p.date).toISOString().slice(0, 10) !== p.date)) return 'A valid payment application date is required';
  if (added.some((p) => {
    const source = entries.get(p.move_id);
    const reversal = p.move_id && [...entries.values()].find((m) => m.state === 'posted' && m.move_type === 'entry' && m.reversed_entry_id === p.move_id);
    return (source?.state === 'posted' && p.date && p.date < source.invoice_date) || (reversal && p.date > reversal.invoice_date);
  })) return 'Payment application date must be after payment and before reversal';
  if (docRound(paidBefore - reversed.reduce((sum, p) => sum + Number(p.amount), 0) + added.reduce((sum, p) => sum + Number(p.amount), 0) - paidAfter) !== 0) return 'The paid amount must match the registered payments';
  // One entry may settle several invoices (a payment applied oldest first), but never more than it booked.
  for (const moveId of new Set(added.map((p) => p.move_id))) {
    const used = [...entries.values()].reduce((sum, m) => sum + (m.payments ?? []).filter((p) => !p.reversed && p?.move_id === moveId).reduce((s, p) => s + appliedValue(db, m, p), 0), 0);
    // ponytail: a cent of slack for foreign-currency rounding on partial payments.
    if (used > settlementCapacity(db, entries.get(moveId), after) + companyStep + 1e-9) return 'A payment cannot settle more than its journal entry booked';
  }
  if (added.some((p) => p.partial_reconcile_id != null && !hasMatchingPartialLink(db, after, p, { reversed: false }))) {
    return 'GL reconciliation rows must reference a matching active partial reconciliation';
  }
  if (added.some((p) => p.payment_company_amount != null && Math.abs(Number(p.payment_company_amount) - toCompany(db, after.currency_id, p.amount, p.date, after.company_id)) > companyStep + 1e-9)) return 'Payment company amount does not match the booked conversion';
  for (const [index, p] of added.entries()) {
    const prior = { ...read(db, 'account.move', after.id), payments: now.slice(0, was.length + index) };
    const isTaxClosing = after.move_type === 'entry' && isReturnEntry(db, after);
    const booked = isTaxClosing ? Number(p.amount) : settlementCompanyAmount(db, prior, Number(p.amount));
    if (p.company_amount != null && (!Number.isFinite(Number(p.company_amount)) || Number(p.company_amount) !== booked)) return 'Settlement company amount does not match the invoice booking';
    const error = isTaxClosing ? null : settlementFxError(db, after, p, booked);
    if (error) return error;
  }
  return null;
}

/** Validate the exclusive FX entry for a settlement, including legacy rows read during reversal. */
export function settlementFxError(db, invoice, p, allocated) {
  const moves = db.records['account.move'] ?? [];
  const payment = (db.records['account.payment'] ?? []).find((x) => x.move_id === p.move_id && ['posted', 'reversed'].includes(x.state));
  const cash = appliedValue(db, invoice, p);
  const index = (invoice.payments ?? []).findIndex((row) => row === p || (row.move_id === p.move_id && row.payment_fx_move_id === p.payment_fx_move_id));
  const earlier = index < 0 ? invoice.payments ?? [] : invoice.payments.slice(0, index);
  const prior = { ...invoice, ...read(db, 'account.move', invoice.id), payments: earlier.map((row) => {
    const reversalDate = read(db, 'account.move', row.reversal_move_id)?.invoice_date ?? row.reversal_date;
    return row.reversed && reversalDate && reversalDate > p.date ? { ...row, reversed: false } : row;
  }) };
  const booked = allocated ?? settlementCompanyAmount(db, prior, Number(p.amount));
  const companyRound = (n) => roundCurrency(n, companyCurrencyRecord(db, invoice.company_id));
  const difference = payment && !payment.invoice_id ? companyRound((cash - booked) * (payment.payment_type === 'inbound' ? 1 : -1)) : 0;
  if (!difference) return p.payment_fx_move_id ? 'An exchange entry is not required for this settlement' : null;
  const fx = read(db, 'account.move', p.payment_fx_move_id);
  const uses = moves.reduce((count, m) => count + (m.payments ?? []).filter((x) => x.payment_fx_move_id === p.payment_fx_move_id).length, 0);
  if (uses > 1) return 'Exchange entry is already used by another settlement';
  const account = invoiceCounterpartAccount(db, invoice);
  const net = (fx?.line_ids ?? []).filter((l) => l.account_id === account && (l.partner_id === invoice.partner_id || sameCommercialPartner(db, l.partner_id, invoice.partner_id))).reduce((sum, l) => sum + (Number(l.debit) || 0) - (Number(l.credit) || 0), 0);
  const configured = exchangeAccount(db, invoice.company_id, difference);
  const offset = configured;
  const lines = fx?.line_ids ?? [];
  const other = lines.filter((l) => l.account_id === offset && !l.partner_id);
  const otherNet = other.reduce((sum, l) => sum + (Number(l.debit) || 0) - (Number(l.credit) || 0), 0);
  if (fx?.state !== 'posted' || fx.move_type !== 'entry' || fx.fx_payment_move_id !== p.move_id || fx.fx_invoice_id !== invoice.id || (fx.company_id ?? 1) !== (invoice.company_id ?? 1) || fx.invoice_date !== p.date || lines.length !== 2 || other.length !== 1 || companyRound(net) !== companyRound(difference) || companyRound(otherNet) !== companyRound(-difference)) return 'A dedicated posted exchange entry must match the settlement';
  return null;
}

/** Validate a synchronized newly-created FX entry against its staged settlement. */
export function fxProvenanceError(db, entry) {
  const invoice = read(db, 'account.move', entry.fx_invoice_id);
  const source = read(db, 'account.move', entry.fx_payment_move_id);
  if (source && ['out_refund', 'in_refund'].includes(source.move_type)) {
    if (source.state !== 'posted' || (source.reversed_entry_id && source.reversed_entry_id !== invoice?.id) || invoice?.state !== 'posted') {
      return 'Exchange provenance requires its settlement';
    }
    const invIndex = (invoice.payments ?? []).findIndex((p) => p.move_id === source.id);
    const noteIndex = (source.payments ?? []).findIndex((p) => p.move_id === invoice.id);
    if (invIndex < 0 || noteIndex < 0) return 'Exchange provenance requires its settlement';
    const invRow = invoice.payments[invIndex];
    const noteRow = source.payments[noteIndex];
    const priorInv = { ...invoice, payments: invoice.payments.slice(0, invIndex) };
    const priorNote = { ...source, payments: source.payments.slice(0, noteIndex) };
    const invoicePortion = settlementCompanyAmount(db, priorInv, invRow.amount);
    const notePortion = settlementCompanyAmount(db, priorNote, noteRow.amount);
    const companyCurrency = companyCurrencyRecord(db, invoice.company_id);
    const companyRound = (n) => roundCurrency(n, companyCurrency);
    const gap = companyRound(invoicePortion - notePortion);
    if (!gap) return 'An exchange entry is not required for this settlement';
    const sale = !['in_invoice', 'in_refund'].includes(invoice.move_type);
    const clearsDebit = sale ? gap < 0 : gap > 0;
    const account = invoiceCounterpartAccount(db, invoice);
    const amount = Math.abs(gap);
    let offset;
    try {
      offset = exchangeAccount(db, invoice.company_id, clearsDebit ? amount : -amount);
    } catch (error) {
      return error.message;
    }
    // Exactly the open-item line and the configured gain/loss line, both for this amount (as offsetCreditNote posts it).
    const lines = entry.line_ids ?? [];
    const side = (l, field) => companyRound(Number(l[field]) || 0);
    const openLine = lines.find((l) => l.account_id === account && l.partner_id === invoice.partner_id);
    const fxLine = lines.find((l) => l !== openLine && l.account_id === offset && !l.partner_id);
    const [open, close] = clearsDebit ? ['debit', 'credit'] : ['credit', 'debit'];
    if (entry.state !== 'posted' || entry.move_type !== 'entry' || (entry.company_id ?? 1) !== (invoice.company_id ?? 1) || entry.invoice_date !== invRow.date
      || lines.length !== 2 || !openLine || !fxLine || side(openLine, open) !== amount || side(openLine, close) || side(fxLine, close) !== amount || side(fxLine, open)) {
      return 'A dedicated posted exchange entry must match the settlement';
    }
    // One settlement books its exchange difference once; a reversed earlier entry no longer counts.
    const moves = db.records['account.move'] ?? [];
    const live = (m) => m.state === 'posted' && !m.reversal_move_id && !moves.some((r) => r.state === 'posted' && r.reversed_entry_id === m.id);
    if (moves.some((m) => m.id !== entry.id && m.fx_payment_move_id === source.id && m.fx_invoice_id === invoice.id && live(m))) {
      return 'Exchange entry is already used by another settlement';
    }
    return null;
  }
  const row = (invoice?.payments ?? []).find((p) => p.payment_fx_move_id === entry.id && p.move_id === entry.fx_payment_move_id);
  if (!row) return 'Exchange provenance requires its settlement';
  return settlementFxError(db, invoice, row);
}

/** A posted payment must have its own posted journal entry, booked for its partner. */
export function paymentInvariant(db, after) {
  if (after.check_number != null) {
    if (!Number.isSafeInteger(after.check_number) || after.check_number < 1 || !after.journal_id || after.payment_type !== 'outbound') {
      return 'Check number must be unique within its journal';
    }
    if ((db.records['account.payment'] ?? []).some((p) => p.id !== after.id && p.journal_id === after.journal_id && (p.check_number === after.check_number || (p.voided_check_numbers ?? []).some((v) => v.check_number === after.check_number)))) {
      return 'Check number must be unique within its journal';
    }
  }
  if ((after.voided_check_numbers ?? []).some((v) => (db.records['account.payment'] ?? []).some((p) => p.id !== after.id && p.journal_id === after.journal_id && (p.check_number === v.check_number || (p.voided_check_numbers ?? []).some((pv) => pv.check_number === v.check_number))))) {
    return 'Check number must be unique within its journal';
  }
  if (after.state !== 'posted') return null;
  const entry = (db.records['account.move'] ?? []).find((m) => m.id === after.move_id);
  if (entry?.state !== 'posted' || entry.move_type !== 'entry') return 'A posted payment needs its posted journal entry';
  if (after.is_tax_payment || after.return_id) {
    const ret = (db.records['account.return'] ?? []).find((r) => r.id === after.return_id && r.state === 'paid');
    if (!ret) return 'The tax payment must settle its closing entry';
    if (ret.tax_unit_id) {
      const spec = taxUnitSettlementSpec(db, ret);
      const { mainCompanyId, mainSpec, destinationAccount, netPayable } = spec;
      if (!netPayable
        || (after.company_id ?? 1) !== mainCompanyId
        || (entry.company_id ?? 1) !== mainCompanyId
        || after.partner_id !== mainSpec.partner
        || round(Number(after.amount) || 0) !== Math.abs(netPayable)
        || after.payment_type !== (netPayable < 0 ? 'inbound' : 'outbound')
        || after.destination_account_id !== destinationAccount?.id) {
        return 'The tax payment must settle its closing entry';
      }
      const entryErr = taxUnitPaymentEntryError(db, after, entry, spec);
      if (entryErr) return entryErr;
    } else {
      const closings = (ret?.closing_move_ids ?? []).map((id) => (db.records['account.move'] ?? []).find((m) => m.id === id));
      if (!closings.some((closing) => closing && settlementCapacity(db, entry, closing) >= round(Number(after.amount) || 0))) {
        return 'The tax payment must settle its closing entry';
      }
    }
  } else {
  if (!after.partner_id || !Number.isFinite(Number(after.amount)) || !(Number(after.amount) > 0)) return 'A posted payment needs a partner and a positive amount';
  if ((entry.company_id ?? 1) !== (after.company_id ?? 1)) return 'The journal entry does not belong to this payment';
  const inbound = after.payment_type === 'inbound';
  const invoice = (db.records['account.move'] ?? []).find((m) => m.id === after.invoice_id);
  let account;
  try {
    account = invoice
      ? invoiceCounterpartAccount(db, invoice)
      : partnerAccount(db, after.partner_id, after.company_id, after.partner_type === 'supplier' ? 'payable' : 'receivable');
  } catch (error) {
    return error.message;
  }
  const companyRound = (n) => roundCurrency(n, companyCurrencyRecord(db, after.company_id));
  const companyStep = Number(companyCurrencyRecord(db, after.company_id)?.rounding ?? 0.01);
  const net = (id) => companyRound((entry.line_ids ?? []).filter((l) => l.account_id === id && l.partner_id === after.partner_id).reduce((s, l) => s + (Number(l.debit) || 0) - (Number(l.credit) || 0), 0));
  const currencyId = after.currency_id ?? invoice?.currency_id;
  const expected = currencyId
    ? toCompany(db, currencyId, after.amount, after.date, invoice?.company_id ?? after.company_id)
    : companyRound(Number(after.amount));
  let bank;
  try {
    bank = after.outstanding_account_id ?? paymentJournal(db, after.journal_id, after.company_id ?? 1).accountId;
  } catch (error) {
    return error.message;
  }
  const counterpart = (inbound ? -1 : 1) * net(account);
  const document = invoice && read(db, 'account.move', invoice.id);
  const prior = document && { ...document, payments: (document.payments ?? []).filter((p) => p.move_id !== after.move_id) };
  if (counterpart < 0 || (!counterpart && (!prior || settlementCompanyAmount(db, prior, Number(after.amount)) !== 0)) || Math.abs((inbound ? 1 : -1) * net(bank) - expected) > companyStep + 1e-9
    || (!invoice && Math.abs((inbound ? -1 : 1) * net(account) - expected) > companyStep + 1e-9)) return 'The journal entry must book this payment amount and direction';
  }
  if ((db.records['account.payment'] ?? []).some((p) => p.id !== after.id && p.state === 'posted' && p.move_id === entry.id)) return 'The journal entry already records another payment';
  return null;
}

/** Whether a fiscal year names this entry as its closing or reopening entry. */
const isYearEntry = (db, id) => (db.records?.['account.fiscal.year'] ?? []).some((y) => y.closing_move_id === id || y.opening_move_id === id);

/** A closed fiscal year locks its period whoever closed it. */
export function closedYearLock(db, companyId = 1) {
  return (db.records?.['account.fiscal.year'] ?? []).filter((y) => (y.company_id ?? 1) === companyId && y.state === 'closed').map((y) => y.date_to).sort().at(-1) ?? '';
}

function securedMoveRule(before, after) {
  if (!before?.inalterable_hash) return null;
  if (after.state !== 'posted') return 'Secured entries cannot be reset to draft or cancelled';
  if (changedFields(before, after, HASHED_FIELDS)) return 'Secured entries cannot be modified';
  return null;
}

export function moveGuard(db, before, after, ctx) {
  return securedMoveRule(before, after) ?? lockRule(db, before, after, ctx) ?? accountsError(db, before, after) ?? accountCurrencyError(db, before, after) ?? postedMoveRule(db, before, after) ?? pendingReversalRule(db, before, after);
}

/** A scheduled reversal posts only while the entry it reverses is still posted (Qodo 24). */
function pendingReversalRule(db, before, after) {
  if (after.state !== 'posted' || before?.state === 'posted' || !after.reversed_entry_id) return null;
  return read(db, 'account.move', after.reversed_entry_id)?.state === 'posted' ? null : 'The entry this reverses is no longer posted';
}

function lockRule(db, before, after, ctx = null) {
  if ((before?.closing_fiscal_year_id ?? null) !== (after.closing_fiscal_year_id ?? null)) {
    if (before || !after.closing_fiscal_year_id || read(db, 'account.fiscal.year', after.closing_fiscal_year_id)?.closing_move_id !== after.id) return 'Closing provenance is set only by closing the fiscal year';
  }
  if (before?.state === 'posted' && after.state !== 'posted' && bookedByBank(db, before.id)) return 'This entry is matched with a reconciled bank transaction and has to stay posted';
  const companyId = before?.company_id ?? after.company_id ?? 1;
  const company = read(db, 'res.company', companyId);
  if (company?.audit_trail && before?.state === 'posted' && before.name !== after.name) return 'Posted entries keep their number while the audit trail is active';
  // The closing flag takes an entry out of the P&L, so only fiscal-year closing sets it, and nothing clears it.
  if (!!after.is_closing !== !!before?.is_closing && (before?.is_closing || !isYearEntry(db, after.id))) return 'Only fiscal year closing marks closing entries';
  if (before && (before.system_generated ?? false) !== (after.system_generated ?? false)) return 'System-generated status cannot be changed';
  if (!before && after.system_generated && after.state === 'draft') return 'Draft moves cannot be system generated';
  if (!before && after.system_generated && after.move_type !== 'entry') return 'Invoices cannot be system generated';
  // A year's own closing or reopening entry is booked into it once, as it is created.
  const beforeCompanyId = before?.company_id ?? 1;
  const afterCompanyId = after?.company_id ?? beforeCompanyId;
  const beforeYearLock = before ? closedYearLock(db, beforeCompanyId) : '';
  const afterYearLock = !before && isYearEntry(db, after.id) ? '' : closedYearLock(db, afterCompanyId);
  const afterTaxLock = !before && isReturnEntry(db, after) ? returnTaxLock(db, afterCompanyId, after.tax_return_id) : taxLockFor(db, after, ctx);
  const beforeLock = before ? [companyLockDate(db, before, ctx), taxLockFor(db, before, ctx), beforeYearLock].sort().at(-1) : '';
  const afterLock = [companyLockDate(db, after, ctx), afterTaxLock, afterYearLock].sort().at(-1);

  const beforePostedLocked = before?.state === 'posted' && Boolean(beforeLock && moveDate(before) <= beforeLock);
  const afterPostedLocked = after?.state === 'posted' && Boolean(afterLock && moveDate(after) <= afterLock);
  const movedIntoLock = Boolean(
    before
    && (!beforeLock || moveDate(before) > beforeLock)
    && moveDate(before) !== moveDate(after)
    && afterLock
    && moveDate(after) <= afterLock,
  );

  if (movedIntoLock) {
    return `The period up to ${afterLock} is locked`;
  }

  if (!beforePostedLocked && !afterPostedLocked) return null;

  const lock = [beforePostedLocked && beforeLock, afterPostedLocked && afterLock].filter(Boolean).sort().at(-1);
  const changed = !before || changedFields(before, after, LOCKED_FIELDS)
    || (beforePostedLocked && changedFields(before, after, SETTLEMENT_FIELDS) && !settlesAfterLock(db, before, after, beforeLock));
  return changed ? `The period up to ${lock} is locked` : null;
}

/**
 * Checked once the whole change set is applied: payments that settle a locked entry must point at posted journal
 * entries dated after the lock that book something for the entry's partner, so a forged object cannot mark it paid.
 */
export function lockedSettlementInvariant(db, after, before, ctx = null) {
  const lock = before && recordLockDate(db, before, ctx);
  if (!lock || moveDate(before) > lock || !changedFields(before, after, SETTLEMENT_FIELDS)) return null;
  const was = Array.isArray(before.payments) ? before.payments.length : 0;
  const entries = new Map((db.records['account.move'] ?? []).map((m) => [m.id, m]));
  const backed = (p) => {
    const entry = entries.get(p.move_id);
    return entry && entry.id !== after.id && entry.state === 'posted' && moveDate(entry) > lock && p.date === moveDate(entry)
      && (entry.line_ids ?? []).some((l) => l.partner_id === after.partner_id);
  };
  return (after.payments ?? []).slice(was).every(backed) ? null : `The period up to ${lock} is locked: payments must be booked after it`;
}

/**
 * Lock guard for records that carry their own date (payments, reconciled bank lines): once dated on or before the
 * lock they cannot change, and nothing new can be booked into the locked period.
 */
export const datedLockGuard = (fields, booked) => (db, before, after, ctx) => {
  const locks = [before, after].filter((r) => r && booked(r))
    .map((r) => ({ record: r, lock: recordLockDate(db, r, ctx) }))
    .filter(({ record, lock }) => lock && String(record.date ?? today()) <= lock)
    .map(({ lock }) => lock);
  if (!locks.length) return null;
  const lock = locks.sort().at(-1);
  return !before || changedFields(before, after, fields) ? `The period up to ${lock} is locked` : null;
};

/** Delete guard to pair with datedLockGuard: booked records dated inside the lock stay. */
export const datedLockDelete = (booked) => (db, r, staged, ctx) => {
  const lock = recordLockDate(db, r, ctx);
  return lock && booked(r) && String(r.date ?? today()) <= lock ? `The period up to ${lock} is locked` : null;
};

/** With the audit trail on, numbered entries are kept forever (they can be cancelled, not deleted). */
export function moveDeleteGuard(db, move, staged = db, ctx = null) {
  if (move.inalterable_hash || staged?.inalterable_hash) return 'Secured entries with an inalterability hash cannot be deleted';
  // `staged` is the database as the change set leaves it: a year that starts naming this entry in the same set counts.
  if (isYearEntry(db, move.id) || isYearEntry(staged, move.id)) return 'Fiscal year closing entries are kept; reopen the fiscal year instead';
  if (isReturnEntry(db, move) || isReturnEntry(staged, move)) return 'Tax return closing entries are kept';
  if (bookedByBank(db, move.id) || bookedByBank(staged, move.id)) return 'This entry is matched with a reconciled bank transaction and cannot be deleted';
  const lock = recordLockDate(db, move, ctx);
  if (move.state === 'posted' && lock && moveDate(move) <= lock) return `The period up to ${lock} is locked`;
  // The trail counts if it is on before or after the change set (enabling it alongside a deletion still protects).
  const audited = [db, staged].some((d) => read(d, 'res.company', move.company_id ?? 1)?.audit_trail);
  if (audited && move.name && move.name !== '/') return 'Numbered entries cannot be deleted while the audit trail is active; cancel them instead';
  if (move.state === 'posted') return 'Posted entries cannot be deleted; reset them to draft first';
  if ((db.records['account.asset'] ?? []).some((a) => a.source_move_id === move.id && a.state !== 'cancel')) return "Handle the entry's linked assets before deleting it";
  if (backsSettlement(db, move.id) || backsSettlement(staged, move.id)) return 'This entry records a payment; reverse the payment instead';
  return null;
}

/** All repartition lines of type 'tax' belonging to the company's taxes, paired with their tax. */
export function companyTaxRepartitionRows(db, companyId) {
  const taxes = search(db, 'account.tax').filter((x) => !companyId || !x.company_id || (x.company_id ?? 1) === companyId);
  return taxes.flatMap((tax) => [
    ...taxRepartitionLines(tax, 'invoice').filter((l) => l.repartition_type === 'tax').map((line) => ({ line, tax })),
    ...taxRepartitionLines(tax, 'refund').filter((l) => l.repartition_type === 'tax').map((line) => ({ line, tax })),
  ]);
}

/** Stored closing eligibility of a repartition row (`use_in_tax_closing` must be explicitly true). */
export function isClosableRepartitionLine(line) {
  return line?.use_in_tax_closing === true;
}

/** Tax accounts per side: the default VAT accounts plus every account a sale / purchase tax books to. */
export function taxAccounts(db, companyId) {
  // Tax accounts come from repartition lines and from the return types' explicit payable/receivable accounts.
  const returnTypes = search(db, 'account.return.type').filter((t) => !companyId || (t.company_id ?? 1) === companyId);
  const returnField = { sale: 'tax_payable_account_id', purchase: 'tax_receivable_account_id' };
  const rows = companyTaxRepartitionRows(db, companyId);
  const of = (use) => new Set([
    ...returnTypes.map((t) => t[returnField[use]]),
    ...rows.filter(({ tax }) => tax.type_tax_use === use).map(({ line }) => line.account_id),
  ].filter(Boolean));
  return { sale: of('sale'), purchase: of('purchase') };
}

const normalizeTaxIds = (ids) => {
  const list = ids instanceof Set ? [...ids] : Array.isArray(ids) ? ids : [];
  return [...new Set(list.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
};

/** Expand `account.tax` IDs (including group children) into a deduplicated Set of positive integer IDs. */
function expandTaxIdSet(db, ids) {
  const expanded = new Set();
  const visit = (rawId) => {
    const id = Number(rawId);
    if (!Number.isSafeInteger(id) || id <= 0 || expanded.has(id)) return;
    expanded.add(id);
    const tax = read(db, 'account.tax', id);
    for (const childId of tax?.children_tax_ids ?? []) visit(childId);
  };
  for (const id of ids ?? []) visit(id);
  return expanded;
}

/** Expand selected `account.tax` IDs (including group children), or null when unfiltered. */
function selectedTaxIdSet(db, period) {
  const raw = normalizeTaxIds(period?.taxIds);
  return raw.length ? expandTaxIdSet(db, raw) : null;
}

/** Posted journal items on tax accounts in the period, with their side and signed tax (output credit / input debit positive). */
export function taxItems(db, period) {
  if (period?.tax_unit_id) return returnCompanies(db, period).flatMap((company_id) => taxItems(db, { ...period, tax_unit_id: null, company_id }));
  const companyId = period?.company_id ?? period?.company;
  const accounts = taxAccounts(db, companyId);
  const moves = new Map((db.records['account.move'] ?? []).map((m) => [m.id, m]));
  const transitions = new Set(cashBasisTransitionAccounts(db, companyId));
  const selectedTaxes = selectedTaxIdSet(db, period);
  return journalItems(db, period).flatMap((l) => {
    if (l.is_closing || l.is_tax_closing || l.is_tax_payment || isNonZeroBaseGridLine(l)) return [];
    if (selectedTaxes && (l.tax_id == null || !selectedTaxes.has(Number(l.tax_id)))) return [];
    const move = l.tax_name && moves.get(l.move_id);
    const documentSide = ['out_invoice', 'out_refund'].includes(move?.move_type) ? 'sale' : ['in_invoice', 'in_refund'].includes(move?.move_type) ? 'purchase' : null;
    const sale = accounts.sale.has(l.account_id), purchase = accounts.purchase.has(l.account_id);
    // A manual item on a tax account used by both sides has no explicit side, so it stays out of the tax report.
    const accountSide = sale && purchase ? null : sale ? 'sale' : purchase ? 'purchase' : null;
    const side = l.tax_side || (!transitions.has(l.account_id) && documentSide) || l.type_tax_use || accountSide;
    if (!side) return [];
    const balance = (Number(l.debit) || 0) - (Number(l.credit) || 0);
    // Invoice tax bases retain the signed document base; a refund reverses that sign.
    // Zero-value items already carry the refund sign, as do zero-rated base lines.
    const invoiceBase = documentSide && balance && !l.tax_zero
      ? (Number(l.tax_base) || 0) * (move.move_type.endsWith('_refund') ? -1 : 1)
      : null;
    return [{ ...l, side, tax: l.tax_zero ? 0 : side === 'sale' ? -balance : balance, invoiceBase }];
  });
}

/** VAT return for a period, read from the ledger: output tax (sales) − input tax (purchases) = payable. */
export function taxReport(db, period) {
  const items = taxItems(db, period);
  const sum = (side) => round(items.filter((l) => l.side === side).reduce((s, l) => s + l.tax, 0));
  const output = sum('sale');
  const input = sum('purchase');
  return { output, input, payable: round(output - input) };
}

/** Deduplicated taxable base across posted tax items matching `matchItem` for the period. */
export function taxBaseTotal(db, period = {}, matchItem = null) {
  return deduplicatedTaxBase(db, taxItems(db, period), matchItem);
}


export function validateTaxReturnPeriod(db, ret) {
  if (ret.tax_unit_id) {
    const reports = returnCompanies(db, ret).map((company_id) => validateTaxReturnPeriod(db, { ...ret, company_id, tax_unit_id: null }));
    return { output: round(reports.reduce((s, r) => s + r.output, 0)), input: round(reports.reduce((s, r) => s + r.input, 0)), payable: round(reports.reduce((s, r) => s + r.payable, 0)) };
  }
  // 1. Check for draft moves in the period
  const drafts = search(db, 'account.move').filter(
    (m) => m.state === 'draft'
      && moveDate(m) >= ret.date_from
      && moveDate(m) <= ret.date_to
      && (!ret.company_id || (m.company_id ?? 1) === ret.company_id)
  );
  if (drafts.length > 0) {
    throw new Error('Draft entries exist in the period; post or cancel them before reviewing');
  }

  // 2. Check for unbalanced tax accounts
  const accounts = taxAccounts(db, ret.company_id);
  const taxAccountIds = new Set([
    ...accounts.sale,
    ...accounts.purchase,
  ].filter(Boolean));

  const items = journalItems(db, { from: ret.date_from, to: ret.date_to, company_id: ret.company_id })
    .filter((l) => taxAccountIds.has(l.account_id) && !l.is_closing && !l.is_tax_closing && !l.is_tax_payment);

  if (items.some((l) => !l.tax_name)) {
    throw new Error('Unbalanced tax account: untagged entry exists on tax account');
  }

  return taxReport(db, { from: ret.date_from, to: ret.date_to, company_id: ret.company_id });
}


function resolveCompanyTaxAccount(db, type, field, label, companyId) {
  const configuredId = type?.[field];
  if (!configuredId) {
    throw new Error(`Missing ${label.toLowerCase()} configuration: Tax return type "${type?.name ?? ''}" needs ${label} configured (${field})`);
  }
  const account = read(db, 'account.account', configuredId);
  if (!account || (account.company_id && account.company_id !== companyId)) {
    throw new Error(`Tax return type "${type.name}" has an invalid ${label} for company ${companyId} (${field})`);
  }
  return account;
}

const TAX_GROUP_ACCOUNT_ERRORS = {
  tax_payable_account_id: {
    prefix: 'liability_',
    missing: 'Tax group payable account does not exist',
    company: 'Tax payable account must belong to the tax group company',
    type: 'Tax payable account must be a liability account',
    archived: 'Tax group payable account is archived',
  },
  tax_receivable_account_id: {
    prefix: 'asset_',
    missing: 'Tax group receivable account does not exist',
    company: 'Tax receivable account must belong to the tax group company',
    type: 'Tax receivable account must be an asset account',
    archived: 'Tax group receivable account is archived',
  },
};

function resolveTaxGroupAccount(db, group, field, fallbackAccount, companyId) {
  const accountId = group?.[field];
  if (!accountId) return fallbackAccount;
  const rules = TAX_GROUP_ACCOUNT_ERRORS[field];
  const account = read(db, 'account.account', accountId);
  if (!account) throw new Error(rules.missing);
  if (account.company_id && account.company_id !== companyId) throw new Error(rules.company);
  if (!account.account_type || !account.account_type.startsWith(rules.prefix)) throw new Error(rules.type);
  if (account.active === false) throw new Error(rules.archived);
  return account;
}

/** Validate explicit return-type mappings configured on a tax unit. */
export function taxUnitMemberTypeValidation(db, unit, mainTypes = [], requiredCompanyId = null) {
  const companyIds = unit?.company_ids ?? [];
  const types = new Map();
  for (const line of unit?.member_return_type_ids ?? []) {
    const companyId = line?.company_id;
    const company = read(db, 'res.company', companyId);
    if (!Number.isInteger(companyId) || !company || companyId === (unit.main_company_id ?? 1) || !companyIds.includes(companyId)) {
      return { error: 'Tax return type lines must use member companies in the tax unit', types };
    }
    if (types.has(companyId)) return { error: 'Set only one tax return type for each member company', types };
    const type = read(db, 'account.return.type', line.type_id);
    if (!type || (type.company_id ?? 1) !== companyId) {
      return { error: `Tax return type must belong to ${company.name}`, types };
    }
    if (mainTypes.some((mainType) => mainType && type.category !== mainType.category)) {
      return { error: `Tax return type for ${company.name} must match the main return type category`, types };
    }
    types.set(companyId, type);
  }
  if (requiredCompanyId != null && !types.has(requiredCompanyId)) {
    const companyName = read(db, 'res.company', requiredCompanyId)?.name ?? String(requiredCompanyId);
    return { error: `Set the tax return type for ${companyName} on the tax unit`, types };
  }
  return { error: null, types };
}

/**
 * Largest ledger-vs-report difference a tax closing books to the return type's rounding accounts,
 * in minor units of the company currency (0.05 for a cent-based currency). Per-line tax rounding
 * leaves differences of a few minor units; anything larger is a real mismatch and still fails.
 */
const TAX_CLOSING_ROUNDING_MINOR_UNITS = 5;

/**
 * Shared read-only closable calculation for one company's period: determines per-line closing eligibility,
 * closable ledger balances by account and tax group, and the matching closable report payable.
 */
function closingPeriodCalculation(db, ret, companyId) {
  const currency = findCompanyCurrencyRecord(db, companyId);
  const moneyRound = (n) => roundCurrency(n, currency);
  const accounts = taxAccounts(db, companyId);
  const allRows = companyTaxRepartitionRows(db, companyId);
  const closingRows = allRows.filter(({ line }) => isClosableRepartitionLine(line));
  const closingRowAccountIds = new Set(closingRows.map(({ line }) => line.account_id).filter(Boolean));
  const excludedOnlyAccounts = new Set(
    allRows
      .filter(({ line }) => line.account_id && !isClosableRepartitionLine(line) && !closingRowAccountIds.has(line.account_id))
      .map(({ line }) => line.account_id),
  );
  const fallbackClosableAccountIds = new Set([...accounts.sale, ...accounts.purchase].filter((id) => !excludedOnlyAccounts.has(id)));

  const transitions = new Set(cashBasisTransitionAccounts(db, companyId));
  const taxAccountIds = new Set([...accounts.sale, ...accounts.purchase, ...closingRowAccountIds]);

  // Per-item eligibility: honor stored journal item `use_in_tax_closing` when present;
  // fall back to closable tax account membership only for untagged manual/legacy items without the flag.
  // Transition accounts and accounts outside closable tax accounts are never closable.
  const isItemClosable = (line) => (
    !transitions.has(line.account_id) &&
    (line.use_in_tax_closing != null
      ? (Boolean(line.use_in_tax_closing) && taxAccountIds.has(line.account_id))
      : (fallbackClosableAccountIds.has(line.account_id) && !line.tax_grid_base))
  );

  const accountClosingGroups = new Map();
  for (const { line, tax } of closingRows) {
    if (!line.account_id) continue;
    if (!accountClosingGroups.has(line.account_id)) {
      accountClosingGroups.set(line.account_id, new Set());
    }
    accountClosingGroups.get(line.account_id).add(tax.tax_group_id ?? null);
  }
  const resolveAccountGroup = (accountId) => {
    const groups = accountClosingGroups.get(accountId);
    if (!groups || groups.size !== 1) return null;
    return [...groups][0];
  };

  // References use the move and the ledger's stable embedded-line identity. A linked
  // posted closing is the authority; cancelled closings no longer cover anything.
  const closingIds = ret.closing_move_ids ?? (ret.id ? read(db, 'account.return', ret.id)?.closing_move_ids : null) ?? [];
  const ownClosing = ['submitted', 'paid'].includes(ret.state)
    ? closingIds.map((id) => read(db, 'account.move', id))
      .find((move) => move?.state === 'posted' && (move.company_id ?? 1) === companyId)
    : null;
  const ref = (line) => {
    const identity = JSON.parse(line.line_identity);
    delete identity.blocked;
    return JSON.stringify([line.move_id, JSON.stringify(identity)]);
  };
  const ownRefs = Array.isArray(ownClosing?.tax_closing_lines) ? new Set(ownClosing.tax_closing_lines) : null;
  const covered = new Set();
  const legacyPeriods = [];
  for (const other of db.records['account.return'] ?? []) {
    if (other.id === ret.id) continue;
    for (const id of other.closing_move_ids ?? []) {
      const move = read(db, 'account.move', id);
      if (!move || move.state !== 'posted' || move.tax_return_id !== other.id || (move.company_id ?? 1) !== companyId) continue;
      if (Array.isArray(move.tax_closing_lines)) move.tax_closing_lines.forEach((key) => covered.add(key));
      else legacyPeriods.push(other);
    }
  }
  const isLegacyOwnClosing = Boolean(ownClosing && !Array.isArray(ownClosing.tax_closing_lines));
  const available = (line) => {
    if (ownRefs) return ownRefs.has(ref(line));
    if (isLegacyOwnClosing) return true;
    return !covered.has(ref(line))
      && !legacyPeriods.some((period) => line.date >= period.date_from && line.date <= period.date_to);
  };
  const itemScope = isLegacyOwnClosing
    ? { from: ret.date_from, to: ret.date_to, company_id: companyId }
    : { to: ret.date_to, company_id: companyId };
  const sourceLines = journalItems(db, itemScope)
    .filter((line) => !line.is_closing && !line.is_tax_closing && !line.is_tax_payment && isItemClosable(line) && available(line));
  const sourceRefs = [...new Set(sourceLines.map(ref))].sort();
  const balances = new Map();
  const groupNets = new Map();
  for (const line of sourceLines) {
    if (line.is_closing || line.is_tax_closing || line.is_tax_payment) continue;
    if (isItemClosable(line)) {
      const net = (Number(line.debit) || 0) - (Number(line.credit) || 0);
      balances.set(line.account_id, (balances.get(line.account_id) ?? 0) + net);
      const tax = line.tax_id ? read(db, 'account.tax', line.tax_id) : null;
      const groupId = tax ? (tax.tax_group_id ?? null) : resolveAccountGroup(line.account_id);
      groupNets.set(groupId, (groupNets.get(groupId) ?? 0) - net);
    }
  }

  const periodItems = taxItems(db, itemScope);
  const closableItems = periodItems.filter((line) => isItemClosable(line) && available(line));
  const closableOutput = moneyRound(closableItems.filter((l) => l.side === 'sale').reduce((s, l) => s + l.tax, 0));
  const closableInput = moneyRound(closableItems.filter((l) => l.side === 'purchase').reduce((s, l) => s + l.tax, 0));
  const closablePayable = moneyRound(closableOutput - closableInput);

  return { currency, moneyRound, balances, groupNets, closablePayable, sourceRefs };
}

/** Closable payable/recoverable total for a return (single company or tax unit), without posting a closing entry. */
export function closableTaxPayable(db, ret) {
  return round(returnCompanies(db, ret).reduce(
    (sum, companyId) => sum + closingPeriodCalculation(db, ret, companyId).closablePayable,
    0,
  ));
}

/** Calculate the closing from posted tax accounts and the return's payment configuration. */
export function taxClosingSpec(db, ret, companyId = ret.company_id ?? 1) {
  const mainType = read(db, 'account.return.type', ret.type_id);
  if (!mainType || (mainType.company_id ?? 1) !== (ret.company_id ?? 1)) throw new Error('Invalid tax return type or company');
  const isMember = companyId !== (ret.company_id ?? 1);
  let type = mainType;
  if (isMember) {
    const unit = read(db, 'account.tax.unit', ret.tax_unit_id);
    const { error, types } = taxUnitMemberTypeValidation(db, unit, [mainType], companyId);
    if (error) throw new Error(error);
    type = types.get(companyId);
  }
  ret = { ...ret, company_id: companyId, tax_unit_id: null };
  validateTaxReturnPeriod(db, ret);
  const { currency, moneyRound, balances, groupNets, closablePayable, sourceRefs } = closingPeriodCalculation(db, ret, companyId);
  const tolerance = moneyRound(TAX_CLOSING_ROUNDING_MINOR_UNITS * Number(currency?.rounding ?? 0.01));

  const lines = [];
  let netClosed = 0;
  for (const [id, raw] of balances) {
    const balance = moneyRound(raw);
    if (!balance) continue;
    lines.push(balance > 0 ? { account_id: id, credit: balance } : { account_id: id, debit: -balance });
    netClosed = moneyRound(netClosed - balance);
  }

  const roundingDiff = moneyRound(netClosed - closablePayable);
  if (Math.abs(roundingDiff) > tolerance) throw new Error('Unbalanced tax account: ledger balance does not match tax report');
  const payableAccount = resolveCompanyTaxAccount(db, type, 'tax_payable_account_id', 'Tax Payable Account', companyId);
  const receivableAccount = resolveCompanyTaxAccount(db, type, 'tax_receivable_account_id', 'Tax Receivable Account', companyId);
  const partner = read(db, 'res.partner', type?.payment_partner_id);
  if (!partner) {
    throw new Error(`Tax return type "${type?.name ?? ''}" needs a Payment Partner configured (payment_partner_id)`);
  }
  const sortedGroupIds = [...groupNets.keys()].sort((a, b) => {
    if (a == null && b == null) return 0;
    if (a == null) return 1;
    if (b == null) return -1;
    return a - b;
  });
  const nonZeroGroups = sortedGroupIds.filter((gid) => moneyRound(groupNets.get(gid) ?? 0) !== 0);
  const largestGroupId = nonZeroGroups.length
    ? nonZeroGroups.reduce(
      (best, gid) => (Math.abs(moneyRound(groupNets.get(gid) ?? 0)) > Math.abs(moneyRound(groupNets.get(best) ?? 0)) ? gid : best),
      nonZeroGroups[0],
    )
    : null;

  const obligations = [];
  let remainingRounding = roundingDiff;
  if (!nonZeroGroups.length && closablePayable) {
    const account = closablePayable > 0 ? payableAccount : receivableAccount;
    obligations.push({ account_id: account.id, account, amount: closablePayable, partner_id: partner.id });
    lines.push(closablePayable > 0
      ? { account_id: account.id, credit: closablePayable, partner_id: partner.id }
      : { account_id: account.id, debit: -closablePayable, partner_id: partner.id });
  } else {
    // Combine groups that resolve to the exact same payable/receivable account (e.g. default fallback) so one line is posted per account.
    const accountAmounts = new Map();
    const resolvedAccounts = new Map();
    for (const groupId of sortedGroupIds) {
      let groupAmount = moneyRound(groupNets.get(groupId) ?? 0);
      if (groupId === largestGroupId && remainingRounding !== 0) {
        groupAmount = moneyRound(groupAmount - remainingRounding);
        remainingRounding = 0;
      }
      if (!groupAmount) continue;
      const group = groupId ? read(db, 'account.tax.group', groupId) : null;
      const targetAccount = groupAmount > 0
        ? resolveTaxGroupAccount(db, group, 'tax_payable_account_id', payableAccount, companyId)
        : resolveTaxGroupAccount(db, group, 'tax_receivable_account_id', receivableAccount, companyId);
      resolvedAccounts.set(targetAccount.id, targetAccount);
      accountAmounts.set(targetAccount.id, moneyRound((accountAmounts.get(targetAccount.id) ?? 0) + groupAmount));
    }
    for (const [accountId, amount] of accountAmounts) {
      if (!amount) continue;
      const account = resolvedAccounts.get(accountId);
      obligations.push({ account_id: accountId, account, amount, partner_id: partner.id });
      lines.push(amount > 0
        ? { account_id: accountId, credit: amount, partner_id: partner.id }
        : { account_id: accountId, debit: -amount, partner_id: partner.id });
    }
  }
  if (roundingDiff > 0) {
    const account = resolveCompanyTaxAccount(db, type, 'rounding_profit_account_id', 'Rounding Profit Account', companyId);
    lines.push({ account_id: account.id, credit: roundingDiff });
  } else if (roundingDiff < 0) {
    const account = resolveCompanyTaxAccount(db, type, 'rounding_loss_account_id', 'Rounding Loss Account', companyId);
    lines.push({ account_id: account.id, debit: -roundingDiff });
  }
  if (!lines.length) {
    lines.push({ account_id: payableAccount.id, debit: 0, credit: 0 }, { account_id: receivableAccount.id, debit: 0, credit: 0 });
  }
  return { lines, obligations, payable: closablePayable, payableAccount, receivableAccount, partner: partner.id, sourceRefs };
}

/** Build the representative company payment summary and per-company inter-company settlement entries for a tax unit return. */
export function taxUnitSettlementSpec(db, ret) {
  const unit = read(db, 'account.tax.unit', ret.tax_unit_id);
  if (!unit) throw new Error('Tax unit not found');
  const companies = returnCompanies(db, ret);
  const mainCompanyId = unit.main_company_id ?? ret.company_id ?? 1;
  if (!companies.includes(mainCompanyId) || (ret.company_id ?? 1) !== mainCompanyId) {
    throw new Error('Tax return company must match the tax unit main company');
  }
  const mainCompany = read(db, 'res.company', mainCompanyId);
  if (!mainCompany?.partner_id || !read(db, 'res.partner', mainCompany.partner_id)) {
    throw new Error('Configure a company contact for every company in the tax unit');
  }

  const specs = companies.map((companyId) => ({ companyId, spec: taxClosingSpec(db, ret, companyId) }));
  const mainSpec = specs.find((s) => s.companyId === mainCompanyId)?.spec;
  if (!mainSpec) throw new Error('Main company is missing from the tax unit');
  const netPayable = round(specs.reduce((sum, s) => sum + s.spec.payable, 0));

  const destinationAccount = (netPayable > 0 || (netPayable === 0 && mainSpec.payable >= 0))
    ? mainSpec.payableAccount
    : mainSpec.receivableAccount;

  const mainLines = [];
  const memberEntries = [];

  // Reclassify every main-company obligation sitting outside `destinationAccount` (group accounts or opposite side) into `destinationAccount`.
  for (const o of mainSpec.obligations ?? []) {
    if (!o.amount || o.account_id === destinationAccount.id) continue;
    const absAmt = Math.abs(o.amount);
    if (o.amount > 0) {
      mainLines.push(
        { account_id: o.account_id, debit: absAmt, partner_id: o.partner_id },
        { account_id: destinationAccount.id, credit: absAmt, partner_id: mainSpec.partner },
      );
    } else {
      mainLines.push(
        { account_id: destinationAccount.id, debit: absAmt, partner_id: mainSpec.partner },
        { account_id: o.account_id, credit: absAmt, partner_id: o.partner_id },
      );
    }
  }

  for (const { companyId: memberId, spec } of specs) {
    if (memberId === mainCompanyId) continue;
    const memberObligations = spec.obligations ?? [];
    if (!memberObligations.length && !spec.payable) continue;
    const memberCompany = read(db, 'res.company', memberId);
    if (spec.payable && (!memberCompany?.partner_id || !read(db, 'res.partner', memberCompany.partner_id))) {
      throw new Error('Configure a company contact for every company in the tax unit');
    }

    // Clear every affected group/default tax obligation line in the member's closing.
    const memberLines = memberObligations.map((o) => (
      o.amount > 0
        ? { account_id: o.account_id, debit: o.amount, partner_id: o.partner_id }
        : { account_id: o.account_id, credit: -o.amount, partner_id: o.partner_id }
    ));

    if (spec.payable) {
      const amount = Math.abs(spec.payable);
      const positive = spec.payable > 0;
      const mainIcAccount = partnerAccount(db, memberCompany.partner_id, mainCompanyId, positive ? 'receivable' : 'payable');
      const memberIcAccount = partnerAccount(db, mainCompany.partner_id, memberId, positive ? 'payable' : 'receivable');
      if (positive) {
        mainLines.push(
          { account_id: mainIcAccount, debit: amount, partner_id: memberCompany.partner_id },
          { account_id: destinationAccount.id, credit: amount, partner_id: mainSpec.partner },
        );
        memberLines.push({ account_id: memberIcAccount, credit: amount, partner_id: mainCompany.partner_id });
      } else {
        mainLines.push(
          { account_id: destinationAccount.id, debit: amount, partner_id: mainSpec.partner },
          { account_id: mainIcAccount, credit: amount, partner_id: memberCompany.partner_id },
        );
        memberLines.push({ account_id: memberIcAccount, debit: amount, partner_id: mainCompany.partner_id });
      }
    }

    if (memberLines.length) {
      memberEntries.push({ companyId: memberId, lines: memberLines });
    }
  }

  const entries = [
    ...(mainLines.length ? [{ companyId: mainCompanyId, lines: mainLines }] : []),
    ...memberEntries,
  ];
  return { mainCompanyId, mainCompany, mainSpec, destinationAccount, netPayable, entries };
}

/** Validate the journal entry backing a tax unit return payment. */
export function taxUnitPaymentEntryError(db, payment, entry, spec = null) {
  if (!entry || entry.state !== 'posted' || entry.move_type !== 'entry') return 'A posted payment needs its posted journal entry';
  const { mainCompanyId, mainSpec, destinationAccount, netPayable } = spec ?? taxUnitSettlementSpec(db, read(db, 'account.return', payment.return_id));
  if ((entry.company_id ?? 1) !== (payment.company_id ?? 1) || (entry.company_id ?? 1) !== mainCompanyId) {
    return 'The journal entry does not belong to this payment';
  }
  const inbound = payment.payment_type === 'inbound';
  const companyCurrency = companyCurrencyRecord(db, mainCompanyId);
  const companyRound = (n) => roundCurrency(n, companyCurrency);
  const net = (id) => companyRound((entry.line_ids ?? []).filter((l) => l.account_id === id && l.partner_id === mainSpec.partner).reduce((s, l) => s + (Number(l.debit) || 0) - (Number(l.credit) || 0), 0));
  const expected = companyRound(Math.abs(netPayable));
  let bank;
  try {
    bank = payment.outstanding_account_id ?? paymentJournal(db, payment.journal_id, mainCompanyId).accountId;
  } catch (error) {
    return error.message;
  }
  const counterpart = (inbound ? -1 : 1) * net(destinationAccount.id);
  const liquidity = (inbound ? 1 : -1) * net(bank);
  if (counterpart < 0 || Math.abs(liquidity - expected) > 1e-9
    || Math.abs(counterpart - expected) > 1e-9) {
    return 'The journal entry must book this payment amount and direction';
  }
  if ((db.records['account.payment'] ?? []).some((p) => p.id !== payment.id && p.state === 'posted' && p.move_id === entry.id)) {
    return 'The journal entry already records another payment';
  }
  return null;
}

/** Validate a submitted closing against its linked return and the posted ledger. */
export function taxClosingMatchesReturn(db, ret, validateCoverage = false) {
  const ids = ret.closing_move_ids ?? [];
  // The candidate link may not yet be written on a local transition.
  const staged = { ...db, records: { ...db.records, 'account.return': (db.records['account.return'] ?? []).map((r) => r.id === ret.id ? ret : r) } };
  try {
    const companies = returnCompanies(staged, ret);
    if (ids.length !== companies.length || new Set(ids).size !== ids.length) return false;
    let payable = 0;
    for (const companyId of companies) {
      const move = ids.map((id) => read(db, 'account.move', id)).find((m) => (m?.company_id ?? 1) === companyId);
      if (!move || move.tax_return_id !== ret.id || move.state !== 'posted' || move.move_type !== 'entry'
        || move.date !== ret.date_to || move.invoice_date !== ret.date_to) return false;
      const spec = taxClosingSpec(staged, ret, companyId);
      if (validateCoverage) {
        const open = closingPeriodCalculation(staged, { ...ret, state: 'reviewed' }, companyId);
        if (JSON.stringify(move.tax_closing_lines) !== JSON.stringify(open.sourceRefs)) return false;
      }
      const currency = findCompanyCurrencyRecord(staged, companyId);
      payable = round(payable + spec.payable);
      const expected = spec.lines.map((line) => {
        const net = roundCurrency((line.debit ?? 0) - (line.credit ?? 0), currency);
        return [line.account_id, line.partner_id ?? null, Math.max(0, net), Math.max(0, -net)];
      });
      const actual = (move.line_ids ?? []).map((line) => [line.account_id, line.partner_id ?? null, Number(line.debit) || 0, Number(line.credit) || 0]);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) return false;
    }
    return round(Number(ret.total_amount_to_pay) || 0) === payable;
  } catch {
    return false;
  }
}

/** Construct and post only the validated closing of a reviewed return. */
export function postTaxReturnClosing(db, returnId) {
  const ret = read(db, 'account.return', returnId);
  if (!ret || ret.state !== 'reviewed') throw new Error('A reviewed tax return is required for closing');
  const specs = returnCompanies(db, ret).map((company) => ({ company, ...taxClosingSpec(db, ret, company) }));
  let next = db;
  const ids = [];
  for (const { company, lines, sourceRefs } of specs) {
    const entry = postEntry(next, { journal: 'MISC', date: ret.date_to, ref: `Tax Closing: ${ret.name}`, lines, company, tax_return_id: ret.id });
    next = { ...entry.db, records: { ...entry.db.records, 'account.move': entry.db.records['account.move'].map((move) =>
      move.id === entry.id ? { ...move, tax_closing_lines: sourceRefs } : move) } };
    ids.push(entry.id);
  }
  return { db: next, ids, payable: round(specs.reduce((s, spec) => s + spec.payable, 0)) };
}

export const BUCKETS = (interval = 30) => {
  const length = Number.isSafeInteger(Number(interval)) && Number(interval) > 0 ? Number(interval) : 30;
  return [['current', 'At Date', -Infinity, 0], ...Array.from({ length: 4 }, (_, i) => {
    const from = i * length + 1, to = (i + 1) * length;
    return [`${from}_${to}`, `${from}-${to}`, from, to];
  }), ['older', 'Older', 4 * length + 1, Infinity]];
};

/** Per-tax report row a tax item belongs to: its side and tax, or its tax name when it has no tax. */
export function taxItemKey(l) {
  return JSON.stringify([l.side, l.tax_id ?? null, l.tax_id == null ? (l.tax_name || 'Untagged') : null]);
}

/**
 * Base and tax per tax from the same journal items as the totals, so the rows always add up to them:
 * invoices, POS, expenses and cash-basis releases alike, in company currency; refunds come out negative.
 */
export function taxesByTax(db, period = {}) {
  return taxRowsFromItems(taxItems(db, period));
}

/** Group tax items into per-tax rows (side, tax, base, tax amount), sorted by side then name. */
export function taxRowsFromItems(items) {
  const rows = new Map();
  for (const l of items) {
    const name = l.tax_name || 'Untagged';
    const key = taxItemKey(l);
    const row = rows.get(key) ?? { side: l.side, tax_id: l.tax_id ?? null, name, base: 0, tax: 0 };
    rows.set(key, { ...row, base: round(row.base + taxItemBase(l)), tax: round(row.tax + l.tax) });
  }
  return [...rows.values()].sort((a, b) => a.side.localeCompare(b.side) || a.name.localeCompare(b.name));
}

/** Resolve originating tax IDs per base tag from an invoice or cash-basis origin's immutable line snapshots. */
function snapshotBaseTagTaxes(move, line, { cashBasis = false } = {}) {
  const invLines = move?.invoice_line_ids ?? [];
  if (!invLines.length) return null;
  const side = ['out_refund', 'in_refund'].includes(move.move_type) ? 'refund' : 'invoice';
  const indices = !cashBasis && Array.isArray(line?.invoice_sources) && line.invoice_sources.length
    ? [...new Set(line.invoice_sources.map((s) => s.index).filter((idx) => Number.isInteger(idx) && idx >= 0 && idx < invLines.length))]
    : invLines.map((_, idx) => idx);
  const tagMap = new Map();
  for (const idx of indices) {
    const invLine = invLines[idx];
    if (!invLine || isSectionOrNote(invLine)) continue;
    for (const t of resolveLineTaxes(invLine)) {
      if (Boolean(t.tax_cash_basis) !== cashBasis || t.tax_id == null) continue;
      for (const tagId of taxBaseTags(t, side, invLine)) {
        if (!tagMap.has(tagId)) tagMap.set(tagId, new Set());
        tagMap.get(tagId).add(Number(t.tax_id));
      }
    }
  }
  return tagMap;
}

/** Resolve which base-grid tag IDs on `line` belong to `selectedTaxes` using posted provenance. */
function matchingBaseGridTagIds(db, moves, move, line, selectedTaxes) {
  const tagIds = line.tax_tag_ids ?? [];
  if (!tagIds.length) return new Set();

  const isRelease = Boolean(line.tax_grid_release && move?.cash_basis_origin_move_id);
  const originMove = isRelease
    ? moves.get(move.cash_basis_origin_move_id)
    : (move?.reversed_entry_id && !(move?.invoice_line_ids?.length) ? moves.get(move.reversed_entry_id) : move);
  const snapshotMap = originMove?.invoice_line_ids?.length
    ? snapshotBaseTagTaxes(originMove, isRelease ? null : line, { cashBasis: isRelease })
    : null;

  let rawTaxIds = Array.isArray(line.tax_ids) && line.tax_ids.length
    ? line.tax_ids
    : null;

  if (!rawTaxIds && snapshotMap) {
    const inferred = new Set();
    for (const tagId of tagIds) {
      for (const taxId of snapshotMap.get(tagId) ?? []) inferred.add(taxId);
    }
    rawTaxIds = [...inferred];
  }
  if (!rawTaxIds && move) {
    const siblingTaxIds = (move.line_ids ?? [])
      .filter((l) => !l.tax_grid_base && l.tax_id != null && (!line.tax_base_line_key || !l.tax_base_line_key || l.tax_base_line_key === line.tax_base_line_key))
      .map((l) => Number(l.tax_id));
    rawTaxIds = [...new Set(siblingTaxIds)];
  }
  if (!rawTaxIds?.length) return new Set();

  const lineTaxes = [...expandTaxIdSet(db, rawTaxIds)];
  if (!lineTaxes.some((id) => selectedTaxes.has(id))) return new Set();
  if (lineTaxes.every((id) => selectedTaxes.has(id))) return new Set(tagIds);

  if (snapshotMap) {
    const allowedLineTaxSet = new Set(lineTaxes);
    return new Set(tagIds.filter((tagId) => {
      const owners = snapshotMap.get(tagId);
      return owners && [...owners].some((id) => allowedLineTaxSet.has(id) && selectedTaxes.has(id));
    }));
  }

  // Multi-tax manual/legacy line without an invoice snapshot: attribute tags across the line's taxes.
  const currentOwners = new Map();
  for (const id of lineTaxes) {
    const tax = read(db, 'account.tax', id);
    for (const row of [...(tax?.invoice_repartition_line_ids ?? []), ...(tax?.refund_repartition_line_ids ?? [])]) {
      if (row.repartition_type !== 'base') continue;
      for (const tagId of row.tag_ids ?? []) {
        if (!currentOwners.has(tagId)) currentOwners.set(tagId, []);
        currentOwners.get(tagId).push(id);
      }
    }
  }
  return new Set(tagIds.filter((tagId) => {
    const owners = currentOwners.get(tagId);
    return owners ? owners.some((id) => selectedTaxes.has(id)) : true;
  }));
}

/** Tax grid amounts from tags on posted journal items. */
export function taxesByGrid(db, period = {}) {
  const rows = new Map();
  const moves = new Map((db.records['account.move'] ?? []).map((m) => [m.id, m]));
  const selectedTaxes = selectedTaxIdSet(db, period);
  const items = period.tax_unit_id
    ? returnCompanies(db, period).flatMap((company_id) => journalItems(db, { ...period, tax_unit_id: null, company_id }))
    : journalItems(db, period);
  for (const line of items) {
    if (line.is_closing || line.is_tax_closing || line.is_tax_payment) continue;
    if (selectedTaxes) {
      if (line.tax_id != null) {
        if (!selectedTaxes.has(Number(line.tax_id))) continue;
      } else if (!line.tax_grid_base) {
        continue;
      }
    }
    const move = moves.get(line.move_id);
    const side = line.tax_side || (['out_invoice', 'out_refund'].includes(move?.move_type) ? 'sale' : ['in_invoice', 'in_refund'].includes(move?.move_type) ? 'purchase' : null);
    if (!side) continue;
    const allowedBaseTags = selectedTaxes && line.tax_grid_base && line.tax_id == null
      ? matchingBaseGridTagIds(db, moves, move, line, selectedTaxes)
      : null;
    if (allowedBaseTags && !allowedBaseTags.size) continue;
    const balance = (Number(line.debit) || 0) - (Number(line.credit) || 0);
    const value = side === 'sale' ? -balance : balance;
    const isLegacyRelease = Boolean(line.tax_grid_release && move?.cash_basis_origin_move_id && isLegacyCashBasisRelease(move));
    for (const id of line.tax_tag_ids ?? []) {
      if (allowedBaseTags && !allowedBaseTags.has(id)) continue;
      const tag = read(db, 'account.account.tag', id);
      if (!tag) continue;
      const row = rows.get(id) ?? { id, name: tag.name, base: 0, tax: 0 };
      if (line.tax_grid_base) row.base = round(row.base + (line.tax_grid_release ? (Number(line.tax_base) || 0) : value));
      else if (line.tax_name && !line.tax_zero && line.tax_side) {
        row.tax = round(row.tax + value);
        if (isLegacyRelease) row.base = round(row.base + (Number(line.tax_base) || 0));
      }
      rows.set(id, row);
    }
  }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
}

/** Open installments in company currency, using the schedule recorded when the document was posted. */
export function openInstallments(db, m, kind, at, { includeBlocked = true } = {}) {
  const companyRound = (n) => roundCurrency(n, companyCurrencyRecord(db, m.company_id));
  const payments = m.payments ?? [];
  const accountType = kind === 'receivable' ? 'asset_receivable' : 'liability_payable';
  const items = (m.line_ids ?? [])
    .map((l, index) => ({ l, index }))
    .filter(({ l }) => read(db, 'account.account', l.account_id)?.account_type === accountType);
  const counterpart = items.reduce((sum, { l }) => sum + (Number(l.debit) || 0) - (Number(l.credit) || 0), 0);
  const currency = documentCurrency(db, m);
  const booked = Math.abs(counterpart) || toCompany(db, currency?.id ?? m.currency_id, Number(m.amount_total) || 0, m.invoice_date ?? m.date, m.company_id) || Number(m.amount_total) || 0;
  const active = payments.filter((p) => !p.reversed).reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
  const legacy = Math.max(0, (Number(m.amount_paid) || 0) - active);
  const legacyPaid = m.payment_date && m.payment_date <= at ? companyRound(booked * legacy / (Number(m.amount_total) || 1)) : 0;
  const allocations = settlementCompanyAllocations(db, m).filter(({ row: p }) => applicationActiveAt(db, p, m, at));
  let dues = items.map(({ l, index }) => ({
    index,
    date: l.date_maturity ?? m.invoice_date_due ?? m.invoice_date,
    total: Math.abs((Number(l.debit) || 0) - (Number(l.credit) || 0)),
    blocked: l.blocked,
  }));
  if (!items.length) {
    const term = read(db, 'account.payment.term', m.invoice_payment_term_id);
    const docDues = term?.line_ids?.length ? installments(term, m.amount_total, m.invoice_date, documentCurrency(db, m)) : [{ date: m.invoice_date_due ?? m.invoice_date, amount: m.amount_total }];
    let assigned = 0;
    dues = docDues.map((d, i) => {
      const total = i === docDues.length - 1 ? companyRound(booked - assigned) : companyRound(booked * d.amount / (Number(m.amount_total) || 1));
      assigned = companyRound(assigned + total);
      return { index: i, date: d.date, total, blocked: d.blocked };
    });
  }
  const dueIndices = new Set(dues.map((d) => d.index));
  const lineIndexByPayMove = new Map(payments.filter((p) => !p.reversed && !p.discount && Number.isInteger(p.line_index)).map((p) => [p.move_id, p.line_index]));
  const targeted = new Map();
  let untargetedAlloc = 0;
  for (const { row, value } of allocations) {
    const targetIndex = Number.isInteger(row.line_index) ? row.line_index : (row.discount ? lineIndexByPayMove.get(row.payment_move_id) : null);
    if (Number.isInteger(targetIndex) && dueIndices.has(targetIndex)) {
      targeted.set(targetIndex, companyRound((targeted.get(targetIndex) ?? 0) + value));
    } else {
      untargetedAlloc = companyRound(untargetedAlloc + value);
    }
  }
  const { remaining } = distributeInstallmentSettlements(dues, targeted, companyRound(legacyPaid + untargetedAlloc), { roundAmount: companyRound });
  return dues
    .sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')) || a.index - b.index)
    .map((due) => ({ date: due.date, amount: companyRound(remaining.get(due.index) ?? 0), blocked: due.blocked }))
    .filter((due) => due.amount > 0 && (includeBlocked || !due.blocked));
}

/** Add the open installments of posted invoices and refunds. */
function ageDocumentInstallments(db, kind, at, moves, add) {
  const types = kind === 'receivable' ? ['out_invoice', 'out_refund'] : ['in_invoice', 'in_refund'];
  for (const m of moves.filter((x) => x.state === 'posted' && types.includes(x.move_type) && (x.date ?? x.invoice_date) <= at)) {
    for (const due of openInstallments(db, m, kind, at)) add(m.partner_id, due.date, (m.move_type.endsWith('refund') ? -1 : 1) * due.amount, m);
  }
}

/** Add each payment's unallocated portion until it is applied or reversed. */
function ageUnappliedCredits(db, kind, at, moves, add, companyId) {
  for (const payment of search(db, 'account.payment')) {
    if (companyId != null && (payment.company_id ?? 1) !== companyId) continue;
    if (!payment.move_id || !['posted', 'reversed'].includes(payment.state) || payment.date > at) continue;
    if (payment.partner_type !== (kind === 'receivable' ? 'customer' : 'supplier')) continue;
    const sign = (kind === 'receivable' ? payment.payment_type === 'inbound' : payment.payment_type === 'outbound') ? -1 : 1;
    const reversal = moves.find((m) => m.state === 'posted' && m.reversed_entry_id === payment.move_id && m.move_type === 'entry');
    if (reversal && (reversal.date ?? reversal.invoice_date) <= at) continue;
    const entry = read(db, 'account.move', payment.move_id);
    const accountType = kind === 'receivable' ? 'asset_receivable' : 'liability_payable';
    const bookedCredit = (entry?.line_ids ?? []).filter((l) => l.partner_id === payment.partner_id && read(db, 'account.account', l.account_id)?.account_type === accountType)
      .reduce((sum, l) => sum + (kind === 'receivable' ? 1 : -1) * ((Number(l.credit) || 0) - (Number(l.debit) || 0)), 0);
    const applied = moves.reduce((sum, m) => {
      return sum + (m.payments ?? []).filter((p) => p.move_id === payment.move_id && applicationActiveAt(db, p, m, at)).reduce((n, p) => n + appliedValue(db, m, p), 0);
    }, 0);
    const remaining = round(Math.abs(bookedCredit) - applied);
    if (remaining > 0) add(payment.partner_id, payment.date, sign * remaining, entry, entry);
  }
}

/** Include other posted receivable/payable journal lines, with matching effective at the cutoff. */
function ageOtherEntries(db, kind, at, moves, add) {
  // Settlement entries and their reversals are already reflected by document/payment residuals.
  const paymentMoves = new Set(search(db, 'account.payment').map((payment) => payment.move_id).filter(Boolean));
  for (const move of moves) for (const application of move.payments ?? []) {
    for (const id of [application.move_id, application.payment_fx_move_id, application.cash_basis_move_id]) if (id) paymentMoves.add(id);
  }
  for (const matching of db.records['account.partial.reconcile'] ?? []) if (matching.exchange_move_id) paymentMoves.add(matching.exchange_move_id);
  for (const move of moves) if (paymentMoves.has(move.reversed_entry_id)) paymentMoves.add(move.id);
  const matchings = indexGlMatchings(db);
  const accountType = kind === 'receivable' ? 'asset_receivable' : 'liability_payable';
  const sign = kind === 'receivable' ? 1 : -1;
  for (const move of moves) {
    if (move.state !== 'posted' || move.move_type !== 'entry' || paymentMoves.has(move.id)) continue;
    const moveDate = move.date ?? move.invoice_date;
    if (!moveDate || moveDate > at) continue;
    (move.line_ids ?? []).forEach((line, index) => {
      const date = line.date ?? moveDate;
      if (date > at || read(db, 'account.account', line.account_id)?.account_type !== accountType) return;
      const balance = (Number(line.debit) || 0) - (Number(line.credit) || 0);
      const matched = (matchings.byLine.get(lineKey(move.id, index)) ?? []).reduce((sum, link) => {
        const otherId = link.debit_move_id === move.id ? link.credit_move_id : link.debit_move_id;
        const other = read(db, 'account.move', otherId);
        if (!other || other.state !== 'posted' || other.move_type !== 'entry') return sum;
        const otherIndex = link.debit_move_id === move.id ? link.credit_line_index : link.debit_line_index;
        const otherDate = other?.line_ids?.[otherIndex]?.date ?? other?.date ?? other?.invoice_date;
        return otherDate && otherDate <= at && (!link.date || link.date <= at) ? sum + Number(link.amount) : sum;
      }, 0);
      const remaining = Math.max(0, round(Math.abs(balance) - matched));
      if (remaining) add(line.partner_id ?? move.partner_id ?? null, line.date_maturity ?? date, sign * Math.sign(balance) * remaining, move);
    });
  }
}

/** Use the requested reporting cutoff, defaulting to today. */
export const agedReportDate = (end, now = today()) => {
  const date = end || now;
  if (!validDate(date)) throw new Error('Enter a valid As of Date');
  return date;
};

/** Validate an As of Date edit against the last valid date, keeping it and returning an inline error when empty or invalid. */
export function resolveAgedAsOfDate(input, lastValidDate) {
  if (validDate(input)) return { input, date: input, error: '' };
  if (!validDate(lastValidDate)) throw new Error('Enter a valid As of Date');
  const raw = input == null ? '' : String(input);
  return {
    input: raw,
    date: lastValidDate,
    error: raw.trim() === '' ? 'As of Date is required' : 'Enter a valid As of Date',
  };
}

/** Aged receivable/payable per partner, bucketed by days past due. */
export function agedBalance(db, kind = 'receivable', at = today(), companyId = null, { aging_interval = 30, aging_based_on = 'base_on_maturity_date' } = {}) {
  if (!validDate(at)) throw new Error('Enter a valid As of Date');
  const buckets = BUCKETS(aging_interval);
  const rows = new Map();
  const add = (partner, date, amount, document = null, source = document) => {
    amount = reportingBookedAmount(db, source, amount);
    const ageDate = aging_based_on === 'base_on_invoice_date' ? (document?.invoice_date ?? date) : date;
    const days = Math.floor((new Date(at) - new Date(ageDate)) / 864e5);
    const bucket = buckets.find(([, , from, to]) => days >= from && days <= to)[0];
    const row = rows.get(partner) ?? { partner_id: partner, total: 0, invoices: [], ...Object.fromEntries(buckets.map(([k]) => [k, 0])) };
    row[bucket] = round(row[bucket] + amount);
    row.total = round(row.total + amount);
    if (document) {
      let detail = row.invoices.find((item) => item.move_id === document.id);
      if (!detail) {
        detail = { move_id: document.id, name: document.name, invoice_date: document.invoice_date ?? null, date: document.date ?? date ?? null, total: 0, ...Object.fromEntries(buckets.map(([k]) => [k, 0])) };
        row.invoices.push(detail);
      }
      detail[bucket] = round(detail[bucket] + amount);
      detail.total = round(detail.total + amount);
    }
    rows.set(partner, row);
  };
  const moves = search(db, 'account.move').filter((m) => companyId == null || (m.company_id ?? 1) === companyId);
  ageDocumentInstallments(db, kind, at, moves, add);
  ageUnappliedCredits(db, kind, at, moves, add, companyId);
  ageOtherEntries(db, kind, at, moves, add);
  return { buckets: buckets.map(([k, label]) => [k, label]), rows: [...rows.values()].sort((a, b) => b.total - a.total) };
}

function lastMonths(at, count = 13) {
  const [year, month] = at.slice(0, 7).split('-').map(Number);
  return Array.from({ length: count }, (_, i) => new Date(Date.UTC(year, month - count + i, 1)).toISOString().slice(0, 7));
}

/**
 * One summary card per journal, as on the accounting dashboard: documents to validate, unpaid, late and
 * 13-month totals for sales/purchase journals; balance, outstanding payments, misc operations and lines
 * to reconcile for bank/cash journals.
 */
export function journalCards(db, at = today()) {
  const moves = search(db, 'account.move');
  const journals = search(db, 'account.journal');
  const generalJournalIds = new Set(journals.filter((jr) => jr.type === 'general').map((jr) => jr.id));
  const companyByMove = new Map(moves.map((m) => [m.id, m.company_id]));
  const postedPaymentsByMove = new Map(
    search(db, 'account.payment')
      .filter((p) => p.state === 'posted' && p.move_id)
      .map((p) => [p.move_id, p]),
  );
  const visibleCompanyIds = search(db, 'res.company').map((c) => c.id);
  const items = journalItems(db);
  const itemBalances = (lines) => lines.map((l) => ({
    company_id: l.company_id ?? companyByMove.get(l.move_id),
    balance: (Number(l.debit) || 0) - (Number(l.credit) || 0),
  }));
  const months = lastMonths(at);
  // Draft invoices count against the journal explicitly configured for their company.
  const draftJournal = (m) => (m.move_type === 'entry' ? null : resolveDocumentJournal(db, m)?.id ?? null);
  const cardOf = (j) => {
    const own = moves.filter((m) => m.journal_id === j.id || (m.state === 'draft' && !m.journal_id && draftJournal(m) === j.id));
    if (['sale', 'purchase'].includes(j.type)) {
      const documents = own.filter((m) => m.move_type === (j.type === 'sale' ? 'out_invoice' : 'in_invoice'));
      const drafts = documents.filter((m) => m.state === 'draft');
      const posted = documents.filter((m) => m.state === 'posted');
      const unpaid = posted.filter((m) => m.amount_residual > 0);
      const late = unpaid.filter((m) => m.invoice_date_due < at);
      const monthlyTotals = months.map((month) => ({
        month,
        total: companySum(db, posted.filter((m) => (m.invoice_date ?? m.date ?? '').startsWith(month)), 'amount_total', at),
      }));
      return {
        journal: j,
        kind: j.type,
        entries: own.filter((m) => m.state === 'posted').length,
        postedDocuments: posted.length,
        draft: drafts.length,
        draftAmount: companySum(db, drafts, 'amount_total', at),
        unpaid: unpaid.length,
        unpaidAmount: companySum(db, unpaid, 'amount_residual', at),
        unratedCount: unratedCount(db, [...drafts, ...posted], at),
        late: late.length,
        lateAmount: companySum(db, late, 'amount_residual', at),
        monthlyTotals,
      };
    }
    if (isLiquidityJournal(j)) {
      const defaultItems = j.default_account_id ? items.filter((l) => l.account_id === j.default_account_id) : [];
      const balances = itemBalances(defaultItems);
      const balance = companySum(db, balances, 'balance', at);
      const miscItems = defaultItems.filter((l) => generalJournalIds.has(l.journal_id));
      const miscBalances = itemBalances(miscItems);
      const miscCount = miscItems.length;
      const miscBalance = companySum(db, miscBalances, 'balance', at);
      const toCheck = isStatementJournal(j) ? search(db, 'account.bank.statement.line').filter((l) => l.state === 'to_check' && l.journal_id === j.id) : [];
      const open = toCheck.map((line) => ({ company_id: line.company_id, balance: (line.amount < 0 ? -1 : 1) * (line.open_amount ?? bookedStatementAmount(db, line)) }));
      const outstandingByCompany = new Map();
      const outstandingIdsFor = (companyId) => {
        if (!outstandingByCompany.has(companyId)) {
          outstandingByCompany.set(
            companyId,
            [...new Set([true, false].map((inbound) => outstandingAccount(db, j, companyId, inbound)).filter(Boolean))],
          );
        }
        return outstandingByCompany.get(companyId);
      };
      const outstandingItems = isStatementJournal(j)
        ? items.filter((l) => {
            if (l.journal_id !== j.id || l.reconciled === true) return false;
            const payment = postedPaymentsByMove.get(l.move_id);
            if (!payment || isPaymentMatched(db, payment)) return false;
            const paymentCompany = payment.company_id ?? l.company_id ?? 1;
            return outstandingIdsFor(paymentCompany).includes(l.account_id);
          })
        : [];
      const companyIds = j.company_id ? [j.company_id] : visibleCompanyIds;
      const hasOutstandingAccounts = isStatementJournal(j) && (
        outstandingItems.length > 0
        || companyIds.some((cid) => outstandingIdsFor(cid).length > 0)
      );
      const outstandingBalances = itemBalances(outstandingItems);
      const onlineAccount = isStatementJournal(j) ? onlineAccountForJournal(db, j.id) : null;
      const onlineLink = onlineAccount?.link_id ? read(db, 'account.online.link', onlineAccount.link_id) : null;
      const hasPosted = own.some((m) => m.state === 'posted') || defaultItems.length > 0 || outstandingItems.length > 0;
      return {
        journal: j,
        kind: j.type,
        balance,
        hasPosted,
        unratedCount: unratedCount(db, [...balances, ...open, ...outstandingBalances, ...miscBalances], at),
        toReconcile: toCheck.length,
        toReconcileAmount: companySum(db, open, 'balance', at),
        hasOutstandingAccounts,
        outstandingCount: outstandingItems.length,
        outstandingBalance: companySum(db, outstandingBalances, 'balance', at),
        miscCount,
        miscBalance,
        onlineSync: onlineLink ? {
          linkId: onlineLink.id,
          accountId: onlineAccount.id,
          state: onlineLink.state,
          lastRefresh: onlineLink.last_refresh ?? null,
          errorMessage: onlineLink.error_message || null,
          balance: onlineAccount.balance ?? null,
          cursor: onlineAccount.last_sync_cursor ?? null,
        } : null,
      };
    }
    return { journal: j, kind: 'general', entries: own.filter((m) => m.state === 'posted').length, draft: own.filter((m) => m.state === 'draft').length };
  };
  // One misconfigured journal must not hide the others: its card carries the configuration error to show.
  return journals.map((j) => {
    try {
      return cardOf(j);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return { journal: j, kind: 'error', error: error.message };
    }
  });
}

export function followUpSummary(invoices) {
  const byCurrency = new Map();
  for (const invoice of invoices) {
    const currency = invoice.followup_currency;
    if (!currency) throw new Error('Configure an invoice currency before preparing follow-ups');
    const previous = byCurrency.get(currency.id) ?? { currency, amount: 0 };
    byCurrency.set(currency.id, { currency, amount: roundCurrency(previous.amount + invoice.amount_residual, currency) });
  }
  const totals = [...byCurrency.values()];
  return { totals, total: totals.length === 1 ? totals[0].amount : null };
}

export function classifyDue(dueDate, at = today(), beforeCutoff = null) {
  if (!dueDate) return null;
  if (dueDate < at) return 'overdue';
  if (beforeCutoff && dueDate <= beforeCutoff) return 'upcoming';
  return null;
}

function buildPartnerReceivable(db, partnerId, moves, partnerCredits, cId, compCurr, at, upcoming = false) {
  if (!moves || moves.length === 0) {
    return { total_due: 0, total_overdue: 0, lines: [], invoices: [], due: [], overdue: [] };
  }
  const lines = [];
  const invoices = [];
  for (const m of moves) {
    const hasReceivableLines = (m.line_ids ?? []).some((l) => read(db, 'account.account', l.account_id)?.account_type === 'asset_receivable');
    if (!hasReceivableLines) {
      const res = models['account.move'].fields.amount_residual.compute(m, db);
      if (!(res > 0)) {
        continue;
      }
      const compResidual = toCompany(db, m.currency_id, res, m.invoice_date ?? m.date, cId);
      const rawDues = openInstallments(db, m, 'receivable', at, { includeBlocked: true });
      const duesTotal = rawDues.reduce((s, d) => s + d.amount, 0);
      let dues = [];
      if (rawDues.length && duesTotal > compResidual) {
        let toDeduct = roundCurrency(duesTotal - compResidual, compCurr);
        for (const due of rawDues) {
          if (toDeduct > 0) {
            const deduct = Math.min(due.amount, toDeduct);
            const newAmt = roundCurrency(due.amount - deduct, compCurr);
            toDeduct = roundCurrency(toDeduct - deduct, compCurr);
            if (newAmt > 0) dues.push({ ...due, amount: newAmt });
          } else {
            dues.push(due);
          }
        }
      } else if (rawDues.length) {
        dues = rawDues;
      } else {
        dues = [{ date: m.invoice_date_due ?? m.invoice_date ?? m.date, amount: compResidual, blocked: false }];
      }
      for (const due of dues) {
        const isOverdue = !due.blocked && classifyDue(due.date, at) === 'overdue';
        lines.push({
          move_id: m.id,
          invoice_date: m.invoice_date ?? m.date,
          due_date: due.date,
          number: m.name,
          reference: m.ref ?? '',
          residual_amount: roundCurrency(due.amount, compCurr),
          is_credit: false,
          is_overdue: isOverdue,
          move: m,
        });
      }
    } else {
      const dues = openInstallments(db, m, 'receivable', at, { includeBlocked: true });
      for (const due of dues) {
        const isOverdue = !due.blocked && classifyDue(due.date, at) === 'overdue';
        lines.push({
          move_id: m.id,
          invoice_date: m.invoice_date ?? m.date,
          due_date: due.date,
          number: m.name,
          reference: m.ref ?? '',
          residual_amount: roundCurrency(due.amount, compCurr),
          is_credit: false,
          is_overdue: isOverdue,
          move: m,
        });
      }
    }

    const moveLines = lines.filter((line) => line.move_id === m.id);
    const openCompanyAmount = moveLines.reduce((sum, line) => sum + line.residual_amount, 0);
    if (openCompanyAmount > 0) {
      const currency = documentCurrency(db, m);
      const booked = (m.line_ids ?? []).filter((l) => read(db, 'account.account', l.account_id)?.account_type === 'asset_receivable').reduce((sum, l) => sum + (Number(l.debit) || 0) - (Number(l.credit) || 0), 0);
      const bookedAmount = Math.abs(booked) || toCompany(db, currency.id, Number(m.amount_total) || 0, m.invoice_date ?? m.date, cId) || Number(m.amount_total) || 1;
      const residual = roundCurrency(openCompanyAmount * (Number(m.amount_total) || 0) / bookedAmount, currency);
      const late = moveLines.filter((line) => line.is_overdue).reduce((sum, line) => sum + line.residual_amount, 0);
      const overdueAmount = roundCurrency(late * (Number(m.amount_total) || 0) / bookedAmount, currency);
      invoices.push({ ...m, amount_residual: residual, followup_currency: currency, overdue: overdueAmount > 0, overdueAmount });
    }
  }

  const creditList = partnerCredits instanceof Map ? [...partnerCredits.values()] : (partnerCredits ?? []);
  const creditRows = creditList.map(({ document, date, amount }) => {
    const isRefund = document.move_type === 'out_refund';
    const docCurr = documentCurrency(db, document) ?? compCurr;
    const currency = isRefund ? docCurr : compCurr;
    let residual;
    if (isRefund) {
      const booked = (document.line_ids ?? []).filter((l) => read(db, 'account.account', l.account_id)?.account_type === 'asset_receivable').reduce((sum, l) => sum + (Number(l.credit) || 0) - (Number(l.debit) || 0), 0);
      const bookedAmount = Math.abs(booked) || toCompany(db, docCurr.id, Number(document.amount_total) || 0, document.invoice_date ?? document.date, cId) || Number(document.amount_total) || 1;
      residual = roundCurrency(amount * (Number(document.amount_total) || 0) / bookedAmount, docCurr);
    } else {
      residual = roundCurrency(amount, compCurr);
    }
    const compAmount = roundCurrency(amount, compCurr);
    return {
      ...document,
      invoice_date: document.invoice_date ?? document.date ?? '',
      invoice_date_due: document.invoice_date_due ?? date,
      amount_residual: residual,
      followup_currency: currency,
      overdue: false,
      overdueAmount: 0,
      companyAmount: compAmount,
    };
  });

  for (const credit of creditRows) {
    lines.push({
      move_id: credit.id,
      invoice_date: credit.invoice_date,
      due_date: credit.invoice_date_due,
      number: credit.name,
      reference: credit.ref ?? '',
      residual_amount: credit.companyAmount,
      is_credit: true,
      is_overdue: false,
      move: credit,
    });
  }

  invoices.push(...creditRows);
  lines.sort((a, b) => String(a.due_date ?? '').localeCompare(String(b.due_date ?? '')) || String(a.number ?? '').localeCompare(String(b.number ?? '')));
  const total_due = roundCurrency(Math.max(0, lines.reduce((s, l) => s + l.residual_amount, 0)), compCurr);
  const total_overdue = roundCurrency(Math.max(0, lines.filter((l) => l.is_overdue || l.is_credit).reduce((s, l) => s + l.residual_amount, 0)), compCurr);
  return {
    total_due,
    total_overdue,
    lines,
    invoices,
    due: followUpSummary(invoices).totals,
    overdue: upcoming || total_overdue === 0 ? [] : followUpSummary([...invoices.filter((m) => m.overdue).map((m) => ({ ...m, amount_residual: m.overdueAmount })), ...creditRows]).totals,
  };
}

export function companyReceivableLines(db, companyId = 1, at = today(), { upcoming = false } = {}) {
  const cId = companyId ?? db?.settings?.current_company_id ?? 1;
  const compCurr = companyCurrencyRecord(db, cId);
  const scopeMoves = search(db, 'account.move').filter((m) => (m.company_id ?? 1) === cId);

  const movesByPartner = new Map();
  for (const m of scopeMoves) {
    if (m.active !== false && m.state === 'posted' && m.move_type === 'out_invoice' && !m.exclude_from_followup && (!m.invoice_date || m.invoice_date <= at)) {
      let list = movesByPartner.get(m.partner_id);
      if (!list) {
        list = [];
        movesByPartner.set(m.partner_id, list);
      }
      list.push(m);
    }
  }

  const creditsByPartner = new Map();
  const addCredit = (partner, date, amount, document) => {
    if (!(amount < 0) || !document || document.exclude_from_followup || (document.company_id ?? 1) !== cId) return;
    let partnerCredits = creditsByPartner.get(partner);
    if (!partnerCredits) {
      partnerCredits = new Map();
      creditsByPartner.set(partner, partnerCredits);
    }
    const previous = partnerCredits.get(document.id) ?? { document, date, amount: 0 };
    previous.amount += amount;
    partnerCredits.set(document.id, previous);
  };
  ageDocumentInstallments(db, 'receivable', at, scopeMoves, addCredit);
  ageUnappliedCredits(db, 'receivable', at, scopeMoves, addCredit, cId);

  const result = new Map();
  for (const [partnerId, moves] of movesByPartner.entries()) {
    const credits = creditsByPartner.get(partnerId);
    result.set(partnerId, buildPartnerReceivable(db, partnerId, moves, credits, cId, compCurr, at, upcoming));
  }
  return result;
}

export function partnerReceivableLines(db, partnerId, companyId = 1, at = today(), { upcoming = false } = {}) {
  const cId = companyId ?? db?.settings?.current_company_id ?? 1;
  const byPartner = companyReceivableLines(db, cId, at, { upcoming });
  return byPartner.get(partnerId) ?? { total_due: 0, total_overdue: 0, lines: [], invoices: [], due: [], overdue: [] };
}

export function partnerTotalDue(db, partnerId, companyId = null, at = today()) {
  if (!partnerId || !db) return 0;
  if (companyId == null) {
    const companies = db.records?.['res.company'] ?? [{ id: 1 }];
    return roundCurrency(companies.reduce((sum, c) => sum + partnerReceivableLines(db, partnerId, c.id, at).total_due, 0), companyCurrencyRecord(db, 1));
  }
  return partnerReceivableLines(db, partnerId, companyId, at).total_due;
}

export function partnerTotalOverdue(db, partnerId, companyId = null, at = today()) {
  if (!partnerId || !db) return 0;
  if (companyId == null) {
    const companies = db.records?.['res.company'] ?? [{ id: 1 }];
    return roundCurrency(companies.reduce((sum, c) => sum + partnerReceivableLines(db, partnerId, c.id, at).total_overdue, 0), companyCurrencyRecord(db, 1));
  }
  return partnerReceivableLines(db, partnerId, companyId, at).total_overdue;
}


/**
 * Derive the signed day offset (`delay`) from non-negative `display_delay`
 * and `reminder_timing` (`'before'` -> negative, `'after'` -> positive, `0` -> `0`).
 */
export function followUpSignedDelay(displayDelay, reminderTiming = 'after') {
  const days = Math.max(0, Math.trunc(Number(displayDelay) || 0));
  if (days === 0) return 0;
  return reminderTiming === 'before' ? -days : days;
}

/**
 * Compute the Odoo display name (`"<display_delay> days <before|after>"`) for a follow-up level.
 */
export function followUpLevelName(level) {
  if (!level) return '';
  const hasDisplayDelay = level.display_delay != null && level.display_delay !== '';
  const days = Math.max(0, Math.trunc(hasDisplayDelay ? Number(level.display_delay) : Math.abs(Number(level.delay) || 0)));
  const timing = level.reminder_timing === 'before' || (!level.reminder_timing && Number(level.delay) < 0)
    ? 'before'
    : 'after';
  return `${days} days ${timing}`;
}

export function levelChannels(level) {
  if (!level) return [];
  const channels = [];
  if (level.send_email) channels.push('email');
  if (level.send_sms) channels.push('sms');
  if (!channels.length && level.channel && !['email', 'sms'].includes(level.channel)) channels.push(level.channel);
  return channels;
}

export function levelChannel(level) { return levelChannels(level)[0] ?? null; }

const followUpSmsText = (db, part, level) => String(level?.sms_message ?? '').trim() || followUpText(db, part);

function queueFollowUpSms(db, partner, part, level, at, automatic = false) {
  if (automatic && search(db, 'sms.campaign').some((campaign) => campaign.followup_sms && campaign.followup_partner_id === partner.id && campaign.followup_company_id === part.company_id && campaign.followup_level_id === level?.id && campaign.followup_oldest === part.oldest)) return db;
  if (!String(partner.mobile || partner.phone || '').trim()) throw new Error('The customer has no mobile or phone number.');
  const body = followUpSmsText(db, part, level);
  const campaign = create(db, 'sms.campaign', {
    name: 'Payment reminder', mailing_model: 'res.partner', body, followup_sms: true, company_id: part.company_id,
    ...(automatic ? { followup_partner_id: partner.id, followup_company_id: part.company_id, followup_level_id: level?.id, followup_oldest: part.oldest } : {}),
  });
  return queueSms(campaign.db, read(campaign.db, 'sms.campaign', campaign.id), { now: at, partnerId: partner.id });
}

function resolveFollowUpActivityUser(db, partner, companyId, part, responsibleType = 'followup') {
  const fallbackUserId = employeeFor(db, currentActor()?.login)?.id ?? null;
  if (responsibleType === 'salesperson') {
    const invoiceUser = part.invoices
      .map((inv) => inv.invoice_user_id ?? read(db, 'account.move', inv.id)?.invoice_user_id)
      .find(Boolean);
    return invoiceUser ?? fallbackUserId;
  }
  if (responsibleType === 'account_manager') {
    return partner?.user_id ?? fallbackUserId;
  }
  return partnerFollowUp(partner, companyId)?.followup_responsible_id ?? partner?.followup_responsible_id ?? fallbackUserId;
}

const oldestOverdueDate = (invoices) => invoices.filter((m) => Number(m.amount_residual) > 0).map((m) => m.invoice_date_due).sort()[0];

/** Allocate company-currency credits to overdue and then upcoming debits without changing the inputs. */
function applyCreditsOldestFirst(overdueAmount, upcomingAmount, upcomingDebits, credits, currency) {
  const totalCredit = credits.reduce((sum, credit) => sum - credit.companyAmount, 0);
  const overdueNet = overdueAmount - totalCredit;
  if (roundCurrency(overdueNet, currency) > 0) return { overdueNet, upcomingNet: upcomingAmount, upcomingDebits, remainingCredits: credits };

  let absorbed = Math.min(overdueAmount, totalCredit);
  let available = totalCredit - absorbed;
  const upcomingNet = upcomingAmount - available;
  const remainingDebits = [];
  for (const debit of [...upcomingDebits].sort((a, b) => a.invoice_date_due.localeCompare(b.invoice_date_due))) {
    if (roundCurrency(available - debit.followup_company_amount, currency) >= 0) {
      available -= debit.followup_company_amount;
      absorbed += debit.followup_company_amount;
    } else remainingDebits.push(debit);
  }
  const remainingCredits = [];
  for (const credit of credits) {
    const used = Math.min(absorbed, -credit.companyAmount);
    absorbed -= used;
    remainingCredits.push({ ...credit, companyAmount: credit.companyAmount + used });
  }
  return { overdueNet, upcomingNet, upcomingDebits: remainingDebits, remainingCredits };
}

/** Partners with overdue invoices (or upcoming invoices matching a "before" reminder), netted by open receivable credits. */
export function followUps(db, at = today(), { ignoreNextActionDate = false, companyId = null } = {}) {
  const levels = search(db, 'account.followup.level');
  const minNegative = levels.reduce((min, l) => Math.min(min, Number(l.delay) || 0), 0);
  const beforeCutoff = minNegative < 0 ? addDays(at, -minNegative) : null;
  const bucketDue = (dueDate) => classifyDue(dueDate, at, beforeCutoff);

  const groups = new Map();
  const ensureGroup = (partnerId, compId) => {
    const key = `${partnerId}:${compId}`;
    let group = groups.get(key);
    if (!group) {
      group = { partnerId, companyId: compId, overdueDebits: [], upcomingDebits: [], credits: new Map(), overdueNet: 0, upcomingNet: 0 };
      groups.set(key, group);
    }
    return group;
  };

  for (const m of search(db, 'account.move')) {
    const compId = m.company_id ?? 1;
    if ((companyId != null && compId !== companyId) || m.state !== 'posted' || m.move_type !== 'out_invoice') continue;
    if (m.invoice_date && m.invoice_date > at) continue;
    if (m.exclude_from_followup) continue;
    const partner = read(db, 'res.partner', m.partner_id);
    if (!partner) continue;
    const compLine = partnerFollowUp(partner, compId);
    if (compLine?.no_followup || compLine?.followup_status === 'no_action_needed') continue;
    if (!ignoreNextActionDate && compLine?.followup_next_action_date && compLine.followup_next_action_date > at) continue;

    if (!m.invoice_date || !(m.line_ids ?? []).length) {
      const bucket = m.amount_residual > 0 ? bucketDue(m.invoice_date_due) : null;
      if (!bucket) continue;
      const group = ensureGroup(m.partner_id, compId);
      const companyAmount = Number(m.amount_residual);
      const row = { ...m, followup_currency: documentCurrency(db, m), ...(bucket === 'upcoming' ? { upcoming: true, followup_company_amount: companyAmount } : {}) };
      if (bucket === 'overdue') { group.overdueDebits.push(row); group.overdueNet += companyAmount; }
      else { group.upcomingDebits.push(row); group.upcomingNet += companyAmount; }
      continue;
    }

    const openDues = openInstallments(db, m, 'receivable', at, { includeBlocked: false });
    const overdueDues = openDues.filter((due) => due.date < at);
    const upcomingDues = openDues.filter((due) => bucketDue(due.date) === 'upcoming');
    if (!overdueDues.length && !upcomingDues.length) continue;
    const booked = (m.line_ids ?? []).filter((l) => read(db, 'account.account', l.account_id)?.account_type === 'asset_receivable').reduce((sum, l) => sum + (Number(l.debit) || 0) - (Number(l.credit) || 0), 0);
    const docCurr = documentCurrency(db, m);
    const scaleAmount = (amt) => roundCurrency(amt * (Number(m.amount_total) || 0) / (Math.abs(booked) || Number(m.amount_total) || 1), docCurr);
    const group = ensureGroup(m.partner_id, compId);
    if (overdueDues.length) {
      const companyAmount = overdueDues.reduce((sum, due) => sum + due.amount, 0);
      group.overdueDebits.push({ ...m, invoice_date_due: overdueDues[0].date, amount_residual: scaleAmount(companyAmount), followup_currency: docCurr });
      group.overdueNet += companyAmount;
    }
    if (upcomingDues.length) {
      const companyAmount = upcomingDues.reduce((sum, due) => sum + due.amount, 0);
      group.upcomingDebits.push({ ...m, invoice_date_due: upcomingDues[0].date, amount_residual: scaleAmount(companyAmount), followup_currency: docCurr, upcoming: true, followup_company_amount: companyAmount });
      group.upcomingNet += companyAmount;
    }
  }

  if (groups.size) {
    const scopeMoves = search(db, 'account.move').filter((m) => companyId == null || (m.company_id ?? 1) === companyId);
    const addCredit = (partner, date, amount, document = null) => {
      if (!(amount < 0) || !document || document.exclude_from_followup) return;
      const cId = document.company_id ?? 1;
      const group = groups.get(`${partner}:${cId}`);
      if (!group) return;
      const prev = group.credits.get(document.id) ?? { document, date, companyAmount: 0 };
      prev.companyAmount += amount;
      group.credits.set(document.id, prev);
    };
    ageDocumentInstallments(db, 'receivable', at, scopeMoves, addCredit);
    ageUnappliedCredits(db, 'receivable', at, scopeMoves, addCredit, companyId);
  }

  const by = new Map();
  for (const group of groups.values()) {
    const compCurr = companyCurrencyRecord(db, group.companyId);
    const allocation = applyCreditsOldestFirst(group.overdueNet, group.upcomingNet, group.upcomingDebits, [...group.credits.values()], compCurr);
    const hasOverdue = group.overdueDebits.length > 0 && roundCurrency(allocation.overdueNet, compCurr) > 0;
    const debits = hasOverdue ? group.overdueDebits : allocation.upcomingDebits;
    const companyNet = hasOverdue ? allocation.overdueNet : allocation.upcomingNet;
    if (!debits.length || !(roundCurrency(companyNet, compCurr) > 0)) continue;
    if (!hasOverdue) {
      const oldestUpcoming = debits.map((d) => d.invoice_date_due).sort()[0];
      const days = Math.floor((new Date(at) - new Date(oldestUpcoming)) / 864e5);
      const hasBeforeLevel = levels.some((l) => (l.reminder_timing === 'before' || Number(l.delay) < 0)
        && days >= (Number(l.delay) || 0));
      if (!hasBeforeLevel) continue;
    }
    const creditRows = allocation.remainingCredits.map(({ document, date, companyAmount }) => {
      const creditAbs = -companyAmount;
      if (document.move_type === 'out_refund') {
        const docCurr = documentCurrency(db, document);
        const booked = (document.line_ids ?? []).filter((l) => read(db, 'account.account', l.account_id)?.account_type === 'asset_receivable').reduce((sum, l) => sum + (Number(l.credit) || 0) - (Number(l.debit) || 0), 0);
        const amount = roundCurrency(creditAbs * (Number(document.amount_total) || 0) / (Math.abs(booked) || Number(document.amount_total) || 1), docCurr);
        return { ...document, invoice_date_due: document.invoice_date_due ?? date, amount_residual: -amount, followup_currency: docCurr };
      }
      return { ...document, partner_id: group.partnerId, company_id: group.companyId, invoice_date_due: date, amount_residual: -roundCurrency(creditAbs, compCurr), followup_currency: compCurr };
    }).filter((row) => row.amount_residual < 0);
    (by.get(group.partnerId) ?? by.set(group.partnerId, []).get(group.partnerId)).push(...debits, ...creditRows);
  }
  return [...by].map(([partner_id, invoices]) => {
    const upcoming = invoices.some((m) => Number(m.amount_residual) > 0 && m.upcoming)
      && !invoices.some((m) => Number(m.amount_residual) > 0 && !m.upcoming);
    const summary = followUpSummary(invoices);
    return {
      partner_id,
      invoices,
      ...summary,
      oldest: oldestOverdueDate(invoices),
      ...(upcoming ? { upcoming: true } : {}),
    };
  });
}

// A shared contact can have invoices in several companies; never combine their private notes.
export const followUpCompanies = (f) => {
  const groups = new Map();
  for (const invoice of f.invoices) {
    const cId = invoice.company_id ?? 1;
    if (!groups.has(cId)) groups.set(cId, []);
    groups.get(cId).push(invoice);
  }
  return [...groups.entries()].map(([company_id, invoices]) => {
    const upcoming = invoices.some((m) => Number(m.amount_residual) > 0 && m.upcoming)
      && !invoices.some((m) => Number(m.amount_residual) > 0 && !m.upcoming);
    return { ...f, company_id, invoices, ...followUpSummary(invoices), oldest: oldestOverdueDate(invoices), ...(upcoming ? { upcoming: true } : {}) };
  });
};
const reminderSource = (f) => ({ model: 'account.move', id: f.invoices[0].id, company_id: f.company_id ?? f.invoices[0].company_id ?? 1 });

/**
 * Automatic reminders: for each overdue customer, the highest follow-up level reached by its oldest overdue
 * invoice is logged on the contact once (the contact remembers the last level sent).
 *
 * Mail transport contract for `deliver(message)`:
 * - Resolves to `{ status: 'sent' }` on delivery.
 * - Resolves to `{ status: 'outbox_only', reason }` when automatic mail is unconfigured (reminder stays unsent).
 * - Rejects/throws on delivery failure.
 * - Legacy void/`Array.prototype.push` callbacks returning `undefined` or a non-negative integer count are accepted as sent.
 * - Any other return value is treated as a failure (`delivery_state: 'failed'`) and never marked sent.
 */
export function partnerFollowUp(partner, companyId = 1) {
  if (!partner) return null;
  const line = (partner.followup_lines ?? []).find((l) => l.company_id === companyId);
  return line ?? null;
}

export function updatePartnerFollowUp(partner, companyId, vals) {
  const existing = [...(partner.followup_lines ?? [])];
  const idx = existing.findIndex((l) => l.company_id === companyId);
  const current = idx >= 0 ? existing[idx] : null;
  const updated = {
    company_id: companyId,
    followup_level_delay: vals.followup_level_delay !== undefined ? vals.followup_level_delay : current?.followup_level_delay ?? null,
    followup_date: vals.followup_date !== undefined ? vals.followup_date : current?.followup_date ?? null,
    followup_oldest_date: vals.followup_oldest_date !== undefined ? vals.followup_oldest_date : current?.followup_oldest_date ?? null,
    followup_level: vals.followup_level !== undefined ? vals.followup_level : current?.followup_level ?? null,
    followup_activity_level: vals.followup_activity_level !== undefined ? vals.followup_activity_level : current?.followup_activity_level ?? null,
    followup_last_level: vals.followup_last_level !== undefined ? vals.followup_last_level : current?.followup_last_level ?? null,
    followup_channel: vals.followup_channel !== undefined ? vals.followup_channel : current?.followup_channel ?? null,
    followup_delivery_state: vals.followup_delivery_state !== undefined ? vals.followup_delivery_state : current?.followup_delivery_state ?? null,
    followup_delivery_outcome: vals.followup_delivery_outcome !== undefined ? vals.followup_delivery_outcome : current?.followup_delivery_outcome ?? null,
    followup_next_action_date: vals.followup_next_action_date !== undefined ? vals.followup_next_action_date : current?.followup_next_action_date ?? null,
    followup_status: vals.followup_status !== undefined ? vals.followup_status : current?.followup_status ?? null,
    followup_responsible_id: vals.followup_responsible_id !== undefined ? vals.followup_responsible_id : current?.followup_responsible_id ?? null,
    no_followup: vals.no_followup !== undefined ? vals.no_followup : current?.no_followup ?? false,
  };
  if (idx >= 0) existing[idx] = updated;
  else existing.push(updated);

  return {
    ...partner,
    followup_lines: existing,
  };
}

function reminderDetails(levels, level, date, channel, oldest = null) {
  const delay = Number(level?.delay) || 0;
  const next = levels.filter((candidate) => Number(candidate.delay) > delay).sort((a, b) => Number(a.delay) - Number(b.delay))[0];
  return { followup_last_level: level?.id ?? null, followup_channel: channel, followup_next_action_date: next ? (oldest ? addDays(oldest, Number(next.delay)) : addDays(date, Number(next.delay) - delay)) : null };
}

/** Create a configured follow-up activity once per partner, company, level and oldest-invoice cycle. */
function ensureFollowUpActivity(db, partnerId, part, level, at) {
  if (!level?.create_activity) return db;
  const partner = read(db, 'res.partner', partnerId);
  if (!partner) return db;
  const cId = part.company_id;
  const progress = partnerFollowUp(partner, cId);
  const oldest = part.oldest ?? null;
  const sameCycle = (progress?.followup_oldest_date ?? null) === oldest;
  if (sameCycle && level.id != null && (progress?.followup_activity_level === level.id || progress?.followup_level === level.id)) {
    return db;
  }
  const assignedUserId = resolveFollowUpActivityUser(db, partner, cId, part, level.activity_default_responsible_type);
  const withActivity = create(db, 'mail.activity', {
    res_model: 'res.partner',
    res_id: partnerId,
    res_name: partner.name ?? '',
    activity_type: level.activity_type_id || 'todo',
    summary: level.activity_summary ?? '',
    note: level.activity_note ?? '',
    date_deadline: at,
    company_id: cId,
    user_id: assignedUserId,
  }).db;
  const currentPartner = read(withActivity, 'res.partner', partnerId) ?? partner;
  return write(withActivity, 'res.partner', partnerId, {
    followup_lines: updatePartnerFollowUp(currentPartner, cId, {
      followup_activity_level: level.id ?? null,
      followup_oldest_date: oldest,
    }).followup_lines,
  });
}

function applyFollowUpReminder(db, scope, partnerId, groups, at, channel, nextLevelBaseDate) {
  const levels = search(scope, 'account.followup.level').sort((a, b) => (Number(b.delay) || 0) - (Number(a.delay) || 0));
  let nextDb = db;

  for (const part of groups) {
    const cId = part.company_id;
    const level = followUpLevel(scope, part, at);
    const levelName = level ? followUpLevelName(level) : 'Payment reminder';

    const invoices = part.invoices.map((move) => `${move.name} (${move.invoice_date_due}): ${round(move.amount_residual)}`).join('; ');
    // Mixed-currency groups have no single total; the invoice amounts below carry the detail (Qodo 42).
    const summaryAmount = part.total == null ? 'Amounts' : round(part.total);
    const dueWord = part.upcoming || (part.oldest && part.oldest >= at) ? 'due' : 'overdue';
    const detail = `${levelName}: ${summaryAmount} ${dueWord} — ${invoices}. ${level?.message ?? ''}`.trim();
    const channelText = channel ? `sent by ${channel}` : 'processed';
    const noteBody = `Payment reminder ${channelText}${level ? ` (${levelName})` : ''}:\n${followUpText(scope, part)}\n${detail}`;
    for (const invoice of part.invoices.filter((move) => Number(move.amount_residual) > 0 && (part.upcoming ? Boolean(move.upcoming) : !move.upcoming))) {
      nextDb = postNote(nextDb, 'account.move', invoice.id, `Payment reminder ${channelText}${level ? ` (${levelName})` : ''}.`, null, {
        ...(channel ? { delivery_channel: channel } : {}),
        delivery_state: 'sent',
      });
    }
    nextDb = postNote(nextDb, 'res.partner', partnerId, noteBody, reminderSource(part), {
      ...(channel ? { delivery_channel: channel } : {}),
      delivery_state: 'sent',
    });
    nextDb = ensureFollowUpActivity(nextDb, partnerId, part, level, at);

    const partner = read(nextDb, 'res.partner', partnerId);
    const previous = partnerFollowUp(partner, cId)?.followup_level_delay;
    const updatedPartner = (level && (previous == null || Number(level.delay) > Number(previous)))
      ? updatePartnerFollowUp(partner, cId, {
        followup_level_delay: Number(level.delay),
        followup_date: at,
        followup_oldest_date: part.oldest ?? null,
        followup_level: level.id,
        followup_delivery_state: 'sent',
        followup_delivery_outcome: 'sent',
        ...reminderDetails(levels, level, at, channel, nextLevelBaseDate),
      })
      : updatePartnerFollowUp(partner, cId, {
        followup_date: at,
        followup_oldest_date: part.oldest ?? null,
        followup_delivery_state: 'sent',
        followup_delivery_outcome: 'sent',
        ...reminderDetails(levels, level, at, channel, nextLevelBaseDate),
      });
    nextDb = write(nextDb, 'res.partner', partnerId, {
      followup_lines: updatedPartner.followup_lines,
    });
  }

  return nextDb;
}

/**
 * Automatic reminders: for each overdue customer, the highest follow-up level reached by its oldest overdue
 * invoice is logged on the contact once (the contact remembers the last level sent).
 *
 * Mail transport contract for `deliver(message)`:
 * - Resolves to `{ status: 'sent' }` on delivery.
 * - Resolves to `{ status: 'outbox_only', reason }` when automatic mail is unconfigured (reminder stays unsent).
 * - Rejects/throws on delivery failure.
 * - Legacy void/`Array.prototype.push` callbacks returning `undefined` or a non-negative integer count are accepted as sent.
 * - Any other return value is treated as a failure (`delivery_state: 'failed'`) and never marked sent.
 */
export function runFollowUps(db, at = today(), deliver = null) {
  const levels = search(db, 'account.followup.level').sort((a, b) => (Number(a.delay) || 0) - (Number(b.delay) || 0));
  if (!levels.length) return db;
  const activeLateMap = new Map(followUps(db, at, { ignoreNextActionDate: true }).flatMap(followUpCompanies).map((f) => [`${f.partner_id}:${f.company_id}`, f]));

  const partners = new Map((db.records['res.partner'] ?? []).map((p) => [p.id, p]));
  let nextDb = db;

  for (const partner of partners.values()) {
    if (partner.followup_reminder_type === 'manual') continue;
    const lines = partner.followup_lines ?? [];
    for (const line of lines) {
      const hasProgress = line.followup_level_delay != null || line.followup_date != null || line.followup_level != null || line.followup_activity_level != null || line.followup_delivery_state != null || line.followup_delivery_outcome != null;
      if (!hasProgress) continue;
      const activeGroup = activeLateMap.get(`${partner.id}:${line.company_id}`) ?? null;
      const oldestChanged = Boolean(activeGroup && line.followup_oldest_date && activeGroup.oldest !== line.followup_oldest_date);
      if (!activeGroup || oldestChanged) {
        const current = read(nextDb, 'res.partner', partner.id) ?? partner;
        nextDb = write(nextDb, 'res.partner', partner.id, {
          followup_lines: updatePartnerFollowUp(current, line.company_id, {
            followup_level_delay: null, followup_level: null, followup_activity_level: null, followup_date: null, followup_oldest_date: null,
            followup_last_level: null, followup_channel: null, followup_delivery_state: null, followup_delivery_outcome: null,
            followup_next_action_date: null,
          }).followup_lines,
        });
      }
    }
  }

  const overdueGroups = followUps(nextDb, at).flatMap(followUpCompanies);

  const processReminder = (state, f) => {
    nextDb = state;
    const companyId = f.invoices[0].company_id ?? 1;
    const level = followUpLevel(nextDb, f, at);
    const partner = partners.get(f.partner_id);
    if (!level || !partner || partner.followup_reminder_type === 'manual') return nextDb;

    const currentPartner = read(nextDb, 'res.partner', partner.id) ?? partner;
    const progress = partnerFollowUp(currentPartner, companyId);
    const currentDelay = progress?.followup_level_delay != null ? Number(progress.followup_level_delay) : -Infinity;

    if (currentDelay >= Number(level.delay)) return nextDb;
    const channels = levelChannels(level);
    let channel = channels.includes('email') ? 'email' : channels[0] ?? null;
    const levelName = followUpLevelName(level);
    const canDeliverEmail = channels.includes('email') && Boolean(partner.email?.trim()) && Boolean(deliver);
    const hasPendingActivity = Boolean(level.create_activity && (
      (progress?.followup_oldest_date ?? null) !== (f.oldest ?? null)
      || progress?.followup_activity_level !== level.id
    ));
    const hasPhone = Boolean(String(partner.mobile || partner.phone || '').trim());
    const sameDaySmsFailure = Boolean(
      channels.includes('sms')
      && !hasPhone
      && progress?.followup_date === at
      && (progress?.followup_oldest_date ?? null) === (f.oldest ?? null)
      && (progress?.followup_last_level === level.id || progress?.followup_level === level.id)
      && progress?.followup_delivery_outcome === 'failed'
      && progress?.followup_channel === 'sms'
    );
    if (!canDeliverEmail && (!channels.includes('sms') || sameDaySmsFailure) && !hasPendingActivity && progress?.followup_delivery_state !== 'sent' && progress?.followup_date === at) return nextDb;
    const sameDayOutboxOnly = Boolean(
      !hasPendingActivity
      && progress?.followup_delivery_state !== 'sent'
      && progress?.followup_delivery_outcome === 'outbox_only'
      && progress?.followup_date === at,
    );

    const dueWord = f.upcoming || (f.oldest && f.oldest >= at) ? 'due' : 'overdue';
    const recordFailure = (reason, meta = { delivery_state: 'outbox_only', delivery_error: reason }) => {
      nextDb = ensureFollowUpActivity(nextDb, partner.id, f, level, at);
      const deliveryState = channel ? 'not_sent' : 'not_configured';
      const deliveryOutcome = meta?.delivery_state === 'failed' ? 'failed' : 'outbox_only';
      const invoiceList = f.invoices.map((move) => `${move.name} (${move.invoice_date_due}): ${round(move.amount_residual)}`).join('; ');
      nextDb = postNote(
        nextDb,
        'res.partner',
        partner.id,
        `${levelName}: ${formatFollowUpTotals(f)} ${dueWord} — ${invoiceList}. ${reason} The follow-up level was not advanced.`,
        reminderSource(f),
        { ...(channel ? { delivery_channel: channel } : {}), ...meta },
      );
      const current = read(nextDb, 'res.partner', partner.id) ?? currentPartner;
      const updated = updatePartnerFollowUp(current, companyId, {
        followup_date: at,
        followup_oldest_date: f.oldest ?? null,
        followup_channel: channel ?? null,
        followup_delivery_state: deliveryState,
        followup_delivery_outcome: deliveryOutcome,
        followup_last_level: level?.id ?? null,
        followup_next_action_date: null,
      });
      return write(nextDb, 'res.partner', partner.id, { followup_lines: updated.followup_lines });
    };
    let smsFailed = false;
    let smsQueued = false;
    const emailAlreadySent = progress?.followup_last_level === level.id && progress?.followup_channel === 'sms'
      && progress?.followup_delivery_outcome === 'failed' && progress?.followup_oldest_date === (f.oldest ?? null);
    if (channels.includes('sms')) {
      if (sameDaySmsFailure) {
        smsFailed = true;
        if (!channels.includes('email') || emailAlreadySent) return nextDb;
      } else {
        try {
          nextDb = queueFollowUpSms(nextDb, partner, f, level, at, true);
          smsQueued = true;
          if (!channels.includes('email') || emailAlreadySent) return applyFollowUpReminder(nextDb, nextDb, partner.id, [f], at, 'sms', f.oldest);
        } catch (error) {
          smsFailed = true;
          const msg = error?.message ?? String(error);
          const previousChannel = channel;
          channel = 'sms';
          nextDb = recordFailure(`SMS delivery failed: ${msg}`, { delivery_state: 'failed', delivery_error: msg });
          channel = previousChannel;
          if (!channels.includes('email') || emailAlreadySent) return nextDb;
        }
      }
    }
    if (channel === 'email' && partner.email?.trim() && deliver) {
      const message = followUpEmail(nextDb, f, level, partner);
      // Validate the bookkeeping before attempting an irreversible delivery.
      const sent = applyFollowUpReminder(nextDb, nextDb, partner.id, [f], at, channel, f.oldest);
      const emailSent = () => {
        if (!smsFailed) return sent;
        const sentPartner = read(sent, 'res.partner', partner.id);
        const failure = partnerFollowUp(read(nextDb, 'res.partner', partner.id), companyId);
        return write(sent, 'res.partner', partner.id, {
          followup_lines: updatePartnerFollowUp(sentPartner, companyId, {
            ...failure, followup_level_delay: progress?.followup_level_delay ?? null,
            followup_level: progress?.followup_level ?? null, followup_last_level: level.id,
          }).followup_lines,
        });
      };
      /** Interpret mail-transport outcome strictly per the single delivery contract. */
      const settleDelivery = (result) => {
        if (result === undefined || (typeof result === 'number' && Number.isInteger(result) && result >= 0)) return emailSent();
        if (result && typeof result === 'object') {
          if (result.status === 'sent') return emailSent();
          if (result.status === 'outbox_only' && typeof result.reason === 'string' && result.reason.trim()) {
            // Suppress duplicate outbox-only notes within the same day while still keeping state not_sent so live SMTP sends later.
            if (sameDayOutboxOnly) return nextDb;
            const reason = result.reason.trim();
            return recordFailure(reason, { delivery_state: 'outbox_only', delivery_error: reason });
          }
        }
        const msg = 'Mail transport returned an invalid delivery result';
        return recordFailure(`Email delivery failed: ${msg}`, { delivery_state: 'failed', delivery_error: msg });
      };
      try {
        const result = deliver(message);
        if (result && typeof result.then === 'function') {
          return result.then(settleDelivery, (error) => {
            const msg = error?.message ?? String(error);
            return recordFailure(`Email delivery failed: ${msg}`, { delivery_state: 'failed', delivery_error: msg });
          });
        }
        return settleDelivery(result);
      } catch (error) {
        const msg = error?.message ?? String(error);
        return recordFailure(`Email delivery failed: ${msg}`, { delivery_state: 'failed', delivery_error: msg });
      }
    }
    if (smsQueued) {
      const emailReason = partner.email?.trim() ? 'Automatic email delivery is not configured.' : 'The customer has no email address.';
      const invoiceList = f.invoices.map((move) => `${move.name} (${move.invoice_date_due}): ${round(move.amount_residual)}`).join('; ');
      nextDb = postNote(
        nextDb,
        'res.partner',
        partner.id,
        `${levelName}: ${formatFollowUpTotals(f)} ${dueWord} — ${invoiceList}. ${emailReason}`,
        reminderSource(f),
        { delivery_channel: 'email', delivery_state: partner.email?.trim() ? 'outbox_only' : 'failed', delivery_error: emailReason },
      );
      return applyFollowUpReminder(nextDb, nextDb, partner.id, [f], at, 'sms', f.oldest);
    }
    if (!channel && level.create_activity) {
      return applyFollowUpReminder(nextDb, nextDb, partner.id, [f], at, null, f.oldest);
    }
    const reason = !channel
      ? 'No delivery action is configured for this follow-up level.'
      : channel === 'email'
        ? (partner.email?.trim() ? 'Automatic email delivery is not configured.' : 'The customer has no email address.')
        : `Automatic ${channel} delivery is unavailable; this reminder needs manual delivery.`;
    return recordFailure(reason);
  };

  return overdueGroups.reduce((state, f) => state && typeof state.then === 'function'
    ? state.then((resolved) => processReminder(resolved, f)) : processReminder(state, f), nextDb);
}

export function followUpLevel(db, reminder, at = today()) {
  const days = Math.floor((new Date(at) - new Date(reminder.oldest)) / 864e5);
  const isUpcoming = Boolean(reminder?.upcoming || (reminder?.oldest && reminder.oldest >= at));
  return search(db, 'account.followup.level')
    .filter((level) => (!isUpcoming || level.reminder_timing === 'before' || Number(level.delay) < 0)
      && days >= (Number(level.delay) || 0))
    .sort((a, b) => (Number(b.delay) || 0) - (Number(a.delay) || 0))[0];
}

const currencyOf = (db, move) => {
  const currency = documentCurrency(db, move);
  if (!currency) throw new Error('Configure an invoice currency before preparing follow-ups');
  return currency.name;
};

/** Reminder text for one customer's overdue invoices, each amount with its currency. */
export const formatFollowUpTotals = (f) => f.totals.map(({ currency, amount }) => `${formatCurrency(amount, currency, '')} ${currency.name}`).join(', ');
export const followUpText = (db, f) => `${f.invoices.map((m) => `${m.name} (${m.invoice_date_due}): ${formatCurrency(m.amount_residual, documentCurrency(db, m), '')} ${currencyOf(db, m)}`.trim()).join('\n')}\nTotal: ${formatFollowUpTotals(f)}`;

/** Current open invoices and per-currency balances for a customer letter. */
export function followUpLetter(db, partnerId, companyId, at = today()) {
  const reminder = followUps(db, at, { companyId, ignoreNextActionDate: true }).flatMap(followUpCompanies).find((f) => f.partner_id === partnerId && f.company_id === companyId);
  if (!reminder) throw new Error('This customer has no overdue invoices');
  const level = followUpLevel(db, reminder, at);
  if (!level) throw new Error('No follow-up level applies to this customer');
  const { invoices, due, overdue } = partnerReceivableLines(db, partnerId, companyId, at, { upcoming: reminder.upcoming });
  return { reminder, level, invoices, due, overdue };
}

/** The automatic and manual email share the same subject and introductory text. */
export function followUpEmail(db, reminder, level, partner) {
  return { to: partner.email.trim(), subject: followUpLevelName(level), text: `${level.message ?? ''}\n${followUpText(db, reminder)}`.trim() };
}

const manualFollowUpGroups = (db, scope, partnerId, at, reminder, companyId, { ignoreNextActionDate = true } = {}) => {
  const allowed = new Set(search(scope, 'account.move').map((move) => move.id));
  const f = followUps(db, at, { companyId: companyId ?? reminder?.company_id ?? null, ignoreNextActionDate }).find((x) => x.partner_id === partnerId);
  if (!f) throw new Error('This customer has no overdue invoices');
  const allGroups = followUpCompanies({ ...f, invoices: f.invoices.filter((invoice) => allowed.has(invoice.id)) });
  const targetCompany = companyId ?? reminder?.company_id ?? null;
  const groups = targetCompany ? allGroups.filter((g) => g.company_id === targetCompany) : allGroups;
  if (!groups.length) throw new Error('This customer has no overdue invoices');
  return groups;
};

/** Record preparation without claiming that the email was sent. */
export function openManualFollowUp(db, partnerId, at = today(), { scope = db, reminder = null, companyId = null, ignoreNextActionDate = true } = {}) {
  const groups = manualFollowUpGroups(db, scope, partnerId, at, reminder, companyId, { ignoreNextActionDate });
  return groups.reduce((next, part) => postNote(next, 'res.partner', partnerId,
    `Payment reminder opened in mail app:\n${followUpText(scope, part)}`, reminderSource(part)), db);
}

/** Record a reminder confirmed sent by hand. */
export function logManualFollowUp(db, partnerId, at = today(), { scope = db, reminder = null, companyId = null, channel = 'email', nextLevelBaseDate = null, ignoreNextActionDate = true } = {}) {
  if (!['email', 'sms', 'phone', 'letter'].includes(channel)) throw new Error('Invalid reminder channel');
  if (channel === 'email' && !read(db, 'res.partner', partnerId)?.email?.trim()) {
    throw new Error('A customer email address is required to send an email reminder');
  }
  const groups = manualFollowUpGroups(db, scope, partnerId, at, reminder, companyId, { ignoreNextActionDate });
  const queued = channel === 'sms'
    ? groups.reduce((state, part) => queueFollowUpSms(state, read(state, 'res.partner', partnerId), part, followUpLevel(scope, part, at), at), db)
    : db;
  return applyFollowUpReminder(queued, scope, partnerId, groups, at, channel, nextLevelBaseDate);
}

const ALLOWED_FOLLOWUP_CAMPAIGN_FIELDS = new Set([
  'id', 'name', 'mailing_model', 'body', 'followup_sms', 'company_id',
  'followup_partner_id', 'followup_company_id', 'followup_level_id', 'followup_oldest',
  'stage_id', 'sent_date', 'sent', 'delivered', 'failed',
]);

const ALLOWED_FOLLOWUP_TRACE_FIELDS = new Set([
  'id', 'campaign_id', 'company_id', 'phone', 'name', 'res_model', 'res_id',
  'state', 'delivery_pending', 'attempted_at', 'error', 'date',
]);

/**
 * Whether a diff contains only validated follow-up SMS campaigns and traces.
 * Used to grant narrowly scoped sync permission to accounting users without granting general SMS Marketing write access.
 */
export function isFollowUpSmsDiff(diff, db) {
  if (!diff || typeof diff !== 'object') return false;
  if (diff.deletes?.['sms.campaign']?.length || diff.deletes?.['sms.trace']?.length || diff.deletes?.['phone.blacklist']?.length) {
    return false;
  }
  if (diff.upserts?.['phone.blacklist']?.length) return false;

  const campaigns = diff.upserts?.['sms.campaign'] ?? [];
  const traces = diff.upserts?.['sms.trace'] ?? [];
  if (!campaigns.length && !traces.length) return false;

  const banned = new Set(search(db, 'phone.blacklist').filter((b) => b.active !== false).map((b) => normalizePhone(b.number)));

  const existingCampaigns = new Map(search(db, 'sms.campaign').map((c) => [c.id, c]));
  const resultingCampaigns = new Map(existingCampaigns);
  const touched = new Set();
  for (const campaign of campaigns) {
    if (Object.keys(campaign).some((k) => !ALLOWED_FOLLOWUP_CAMPAIGN_FIELDS.has(k))) return false;
    const prior = existingCampaigns.get(campaign.id);
    if (campaign.followup_sms !== true || (prior && prior.followup_sms !== true)) return false;
    if (prior) {
      if ((campaign.delivered ?? 0) !== (prior.delivered ?? 0)) return false;
      if ((campaign.failed ?? 0) !== (prior.failed ?? 0)) return false;
      if ((campaign.sent ?? 0) !== (prior.sent ?? 0)) return false;
      if (campaign.stage_id !== prior.stage_id) return false;
      if (campaign.body !== prior.body) return false;
      if ((campaign.company_id ?? 1) !== (prior.company_id ?? 1)) return false;
    } else {
      if (campaign.mailing_model !== 'res.partner') return false;
      if ((campaign.delivered ?? 0) !== 0 || (campaign.failed ?? 0) !== 0) return false;
      if (campaign.stage_id !== 'sent') return false;
    }
    resultingCampaigns.set(campaign.id, campaign);
    touched.add(campaign.id);
  }

  const existingTraces = new Map(search(db, 'sms.trace').map((t) => [t.id, t]));
  const resultingTraces = new Map(existingTraces);
  for (const trace of traces) {
    if (Object.keys(trace).some((k) => !ALLOWED_FOLLOWUP_TRACE_FIELDS.has(k))) return false;
    const prior = existingTraces.get(trace.id);
    if (prior) {
      if (prior.campaign_id !== trace.campaign_id) return false;
      if (trace.state !== prior.state) return false;
      if ((trace.delivery_pending ?? false) !== (prior.delivery_pending ?? false)) return false;
      if ((trace.attempted_at ?? null) !== (prior.attempted_at ?? null)) return false;
      if ((trace.error ?? '') !== (prior.error ?? '')) return false;
      if (trace.phone !== prior.phone) return false;
      if (trace.res_model !== prior.res_model || trace.res_id !== prior.res_id) return false;
      if (trace.state === 'outgoing' && banned.has(normalizePhone(trace.phone))) return false;
    } else {
      if (existingCampaigns.has(trace.campaign_id)) return false;
      if (trace.state !== 'outgoing') return false;
      if (trace.delivery_pending !== true) return false;
      if (trace.attempted_at != null) return false;
      if (trace.error) return false;
      if (trace.res_model !== 'res.partner') return false;
      if (banned.has(normalizePhone(trace.phone))) return false;
    }
    resultingTraces.set(trace.id, trace);
    touched.add(trace.campaign_id);
  }

  const at = today();
  const groups = followUps(db, at).flatMap(followUpCompanies);
  for (const id of touched) {
    const campaign = resultingCampaigns.get(id);
    if (!campaign || campaign.followup_sms !== true || campaign.mailing_model !== 'res.partner') return false;
    const campaignTraces = [...resultingTraces.values()].filter((trace) => trace.campaign_id === id);
    if (!campaignTraces.length) return false;
    for (const trace of campaignTraces) {
      const partner = read(db, 'res.partner', trace.res_id);
      const group = groups.find((f) => f.partner_id === trace.res_id && f.company_id === (campaign.company_id ?? 1) && !f.upcoming);
      const level = group && followUpLevel(db, group, at);
      if (trace.res_model !== 'res.partner' || !partner || !group || !level?.send_sms) return false;
      const phone = normalizePhone(partner.mobile || partner.phone);
      if (!phone || trace.phone !== phone || campaign.body !== followUpSmsText(db, group, level)) return false;
      if (banned.has(phone)) return false;
    }
  }

  return true;
}


/** Analytic entries included in an actuals calculation. */
export function analyticActualLines(db, period = {}) {
  return search(db, 'account.analytic.line').filter((line) => {
    if (!line.account_id || (period.from && line.date < period.from) || (period.to && line.date > period.to)) return false;
    if (period.company_id != null && (line.company_id ?? 1) !== period.company_id) return false;
    if (period.account_id != null && line.account_id !== period.account_id) return false;
    if (period.general_account && !(read(db, 'account.account', line.general_account)?.code ?? '').startsWith(period.general_account)) return false;
    const move = line.move_id && read(db, 'account.move', line.move_id);
    return (!line.move_id && !period.posted_only) || (move?.state === 'posted' && (move.company_id ?? 1) === (line.company_id ?? 1));
  });
}

/** An analytic line's amount in the reporting company's currency, translated at the line's accounting date. */
export const analyticReportAmount = (db, line) => {
  const amount = Number(line.amount) || 0;
  return amount === 0 ? 0 : reportingBookedAmount(db, line, amount);
};

/** Actual amount per analytic account from posted invoice/bill lines (income positive, costs negative). */
export function analyticActuals(db, period = {}) {
  const totals = new Map();
  for (const line of analyticActualLines(db, period)) {
    totals.set(line.account_id, round((totals.get(line.account_id) ?? 0) + analyticReportAmount(db, line)));
  }
  return totals;
}

export const financeModels = {
  'account.journal.group': {
    label: 'Multi-Ledger',
    emptyHelp: { title: 'Ledger group allows managing multiple accounting standards.' },
    views: ['list'],
    fields: {
      name: { type: 'char', label: 'Ledger group', placeholder: 'e.g. CONSO, IFRS, ...', required: true },
      sequence: { type: 'integer', label: 'Sequence', widget: 'handle', hidden: true },
      company_id: { type: 'many2one', relation: 'res.company', label: 'Company', required: true, hidden: true },
      journal_ids: { type: 'many2many', relation: 'account.journal', label: 'Included Journals', domain: (journal, record) => !journal.company_id || journal.company_id === record.company_id },
    },
    defaults: () => ({ sequence: 10, journal_ids: [] }),
    createDefaults: (db) => ({ company_id: db.settings?.current_company_id ?? 1 }),
    guard: (db, before, record) => ((!before || record.name !== before.name) && (db.records['account.journal.group'] ?? []).some((group) => group.id !== record.id && group.name === record.name))
      ? 'A Ledger group name must be unique.' : (record.journal_ids ?? []).some((id) => {
      const journal = read(db, 'account.journal', id);
      return !journal || (journal.company_id && journal.company_id !== record.company_id);
    }) ? 'Select journals belonging to this company or shared journals' : null,
    sort: (a, b) => (a.sequence ?? 10) - (b.sequence ?? 10) || a.id - b.id,
    list: ['sequence', 'name', 'journal_ids'],
    listFields: {
      sequence: { widget: 'handle', label: '' },
      journal_ids: { widget: 'many2many_tags', optional: 'show' },
    },
    searchFields: ['name'],
    form: { title: 'name', hideTitle: true, groups: [['name', 'journal_ids']] },
  },
  'account.followup.level': {
    label: 'Follow-up Levels',
    views: ['list', 'kanban'],
    fields: {
      display_name: { type: 'char', label: 'Level', hidden: true, compute: (r) => followUpLevelName(r) },
      display_delay: {
        type: 'integer',
        label: 'Due Days',
        required: true,
        help: 'The number of days after or before the due date of the invoice to wait before sending the reminder.',
      },
      reminder_timing: {
        type: 'selection',
        label: 'Reminder Timing',
        required: true,
        options: [['before', 'before'], ['after', 'after']],
        help: 'Indicates whether the reminder should be sent before or after the invoice due date.',
      },
      delay: { type: 'integer', label: 'Days Overdue', hidden: true },
      send_email: { type: 'boolean', label: 'Email' },
      send_sms: { type: 'boolean', label: 'SMS' },
      sms_message: { type: 'text', label: 'SMS Text', hideWhen: (r) => !r?.send_sms },
      create_activity: { type: 'boolean', label: 'Schedule Activity' },
      activity_default_responsible_type: {
        type: 'selection',
        label: 'Responsible',
        required: true,
        options: [
          ['followup', 'Reminder Responsible'],
          ['salesperson', 'Salesperson'],
          ['account_manager', 'Account Manager'],
        ],
        hideWhen: (r) => !r?.create_activity,
        help: 'Determine who will be assigned to the activity:\n- Follow-up Responsible (default)\n- Salesperson: Sales Person defined on the invoice\n- Account Manager: Sales Person defined on the customer',
      },
      activity_type_id: {
        type: 'selection',
        label: 'Activity Type',
        options: ACTIVITY_TYPES,
        required: (r) => Boolean(r?.create_activity),
        hideWhen: (r) => !r?.create_activity,
      },
      activity_summary: {
        type: 'char',
        label: 'Summary',
        required: (r) => Boolean(r?.create_activity),
        hideWhen: (r) => !r?.create_activity,
      },
      activity_note: {
        type: 'text',
        label: 'Note',
        placeholder: 'Activity Notes',
        hideWhen: (r) => !r?.create_activity,
      },
      company_id: { type: 'many2one', relation: 'res.company', label: 'Company', multiCompanyOnly: true },
      // Legacy stored fields kept for compatibility with existing records and follow-up channel/body readers.
      name: { type: 'char', label: 'Level', hidden: true, readonly: true },
      channel: { type: 'selection', label: 'Automatic Delivery', options: [['email', 'Email'], ['sms', 'SMS'], ['phone', 'Phone'], ['letter', 'Letter']], hidden: true },
      message: {
        type: 'text',
        label: 'Email Message',
        placeholder: 'Optional email reminder message',
        hideWhen: (r) => !r?.send_email,
      },
    },
    defaults: () => ({
      display_delay: 15,
      reminder_timing: 'after',
      delay: 15,
      send_email: true,
      send_sms: false,
      create_activity: false,
      activity_default_responsible_type: 'followup',
    }),
    createDefaults: (db) => ({ company_id: db.settings?.current_company_id ?? 1 }),
    prepareCreate(db, vals) {
      const next = { ...vals };
      if (next.display_delay === undefined && next.delay != null) {
        const raw = Number(next.delay) || 0;
        next.display_delay = Math.abs(Math.trunc(raw));
        if (next.reminder_timing === undefined) next.reminder_timing = raw < 0 ? 'before' : 'after';
      }
      if (next.send_email === undefined && next.channel !== undefined) {
        next.send_email = next.channel === 'email';
      }
      if (next.send_sms === undefined && next.channel === 'sms') {
        next.send_sms = true;
      }
      const effectiveSendEmail = next.send_email !== undefined ? next.send_email : true;
      if (next.channel === undefined) {
        if (effectiveSendEmail) next.channel = 'email';
        else if (next.send_sms) next.channel = 'sms';
      }
      const effDays = next.display_delay !== undefined ? next.display_delay : 15;
      const effTiming = next.reminder_timing ?? 'after';
      if (next.delay === undefined || 'display_delay' in vals || 'reminder_timing' in vals) {
        next.delay = followUpSignedDelay(effDays, effTiming);
      }
      return { db, vals: next };
    },
    onchange(rec, field) {
      if (field === 'display_delay' || field === 'reminder_timing') {
        return { delay: followUpSignedDelay(rec.display_delay, rec.reminder_timing) };
      }
      if (field === 'delay') {
        const raw = Number(rec.delay) || 0;
        return {
          display_delay: Math.abs(Math.trunc(raw)),
          reminder_timing: raw < 0 ? 'before' : 'after',
        };
      }
      if (field === 'send_email' || field === 'send_sms') {
        return { channel: rec.send_email ? 'email' : rec.send_sms ? 'sms' : (['email', 'sms'].includes(rec.channel) ? null : rec.channel) };
      }
      return null;
    },
    guard: (db, before, record) => {
      if (record.display_delay == null || Number(record.display_delay) < 0 || !Number.isInteger(Number(record.display_delay))) {
        return 'Due Days must be a non-negative integer';
      }
      if (record.create_activity && (!record.activity_type_id || !String(record.activity_summary ?? '').trim())) {
        return 'Activity Type and Summary are required when Schedule Activity is enabled';
      }
      return null;
    },
    sort: (a, b) => (Number(a.delay) || 0) - (Number(b.delay) || 0) || a.id - b.id,
    kanban: { title: 'display_name', lines: ['send_email', 'send_sms', 'create_activity'] },
    list: ['display_delay', 'reminder_timing', 'send_email', 'send_sms', 'activity_type_id', 'company_id'],
    listLabels: { activity_type_id: 'Activity' },
    searchFields: ['display_name', 'activity_summary', 'activity_note'],
    filters: [[
      { id: 'email', label: 'Email', fn: (r) => Boolean(r.send_email) },
      { id: 'sms', label: 'SMS', fn: (r) => Boolean(r.send_sms) },
      { id: 'activity', label: 'Schedule Activity', fn: (r) => Boolean(r.create_activity) },
    ]],
    groupBys: ['reminder_timing', 'company_id'],
    form: {
      title: 'display_name',
      hideTitle: true,
      groups: [
        [{ label: 'Remind', fields: ['display_delay', 'reminder_timing'], joins: ['days'], inline: true }],
        ['company_id'],
      ],
      tabs: [
        {
          label: 'Notification',
          groups: [
            { title: 'Actions', fields: ['send_email', 'send_sms'] },
            { fullWidth: true, fields: ['message', 'sms_message'] },
          ],
        },
        {
          label: 'Activity',
          groups: [
            ['create_activity', 'activity_default_responsible_type'],
            ['activity_type_id', 'activity_summary'],
            { fullWidth: true, fields: ['activity_note'] },
          ],
        },
      ],
    },
  },

  'account.analytic.account': {
    label: 'Analytic Accounts',
    fields: {
      name: { type: 'char', label: 'Analytic Account', required: true },
      code: { type: 'char', label: 'Reference' },
      plan: { type: 'selection', label: 'Plan', options: [['project', 'Projects'], ['department', 'Departments'], ['region', 'Regions']] },
      balance: { type: 'monetary', label: 'Balance', readonly: true },
    },
    defaults: () => ({ plan: 'project' }),
    groupBys: ['plan'],
    kanban: { title: 'name', lines: ['code', 'plan'] },
    list: ['code', 'name', 'plan'],
    form: { title: 'name', groups: [['code', 'plan'], []], chatter: true },
  },

  'account.budget': {
    label: 'Budgets',
    fields: {
      company_id: { type: 'many2one', relation: 'res.company', label: 'Company', required: true },
      name: { type: 'char', label: 'Budget Name', required: true },
      budget_type: { type: 'selection', label: 'Budget Type', required: true, options: [['expense', 'Expense'], ['revenue', 'Revenue'], ['both', 'Both']] },
      date_from: { type: 'date', label: 'Start Date' },
      date_to: { type: 'date', label: 'End Date' },
      lines: {
        type: 'one2many',
        label: 'Budget Lines',
        fields: { analytic_account_id: { type: 'many2one', relation: 'account.analytic.account', label: 'Analytic Account' }, planned: { type: 'monetary', label: 'Planned Amount' } },
        newLine: () => ({ analytic_account_id: null, planned: 0 }),
      },
      state: { type: 'selection', label: 'Status', tracking: true, options: [['draft', 'Draft'], ['confirmed', 'Confirmed'], ['done', 'Done']] },
    },
    defaults: () => ({ state: 'draft', budget_type: 'expense', date_from: today().slice(0, 4) + '-01-01', date_to: today().slice(0, 4) + '-12-31', lines: [] }),
    kanban: { title: 'name', lines: ['date_from', 'date_to'], badge: 'state' },
    list: ['name', 'date_from', 'date_to', 'state'],
    form: {
      statusbar: 'state',
      statusbarClickable: true,
      buttons: [{ label: 'Budget vs Actual', run: (db) => ({ db, go: '#/accounting/budget-report' }) }],
      title: 'name',
      groups: [['date_from', 'company_id'], ['date_to', 'budget_type']],
      tabs: [{ label: 'Budget Lines', fields: ['lines'] }],
      chatter: true,
    },
  },
};
