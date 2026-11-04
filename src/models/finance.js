// Credit limits, lock date, audit trail, tax report, aged balances, follow-ups, analytic accounting and budgets.
import { installments } from './terms.js';
import { models } from '../registry.js';
import { postNote, read, search, write } from '../orm.js';
import { addDays, today, total } from './common.js';
import { accountId, invoiceCounterpartAccount, isBalanced, journalItems, paymentJournal, postEntry, resolveCounterpartAccount } from './ledger.js';
import { toCompany } from './currency.js';
import { TRANSITION } from './taxes.js';
import { companySum, reportingBookedAmount, unratedCount } from './money.js';
import { companyCurrencyRecord, documentCurrency, round, roundCurrency } from '../money.js';
import { settlementCompanyAmount, settlementCompanyAllocations, applicationEffectiveDate, applicationActiveAt } from './settlement.js';
import { exchangeAccount } from './exchange-account.js';

export { applicationEffectiveDate };

/** Open receivable (posted, unpaid invoices) of a partner. */
export const receivableOf = (db, partnerId, companyId = 1) => roundCurrency((db.records['account.move'] ?? [])
  .filter((m) => m.active !== false && m.state === 'posted' && m.move_type === 'out_invoice' && m.partner_id === partnerId && (m.company_id ?? 1) === companyId)
  .reduce((s, m) => s + toCompany(db, m.currency_id, models['account.move'].fields.amount_residual.compute(m, db), m.invoice_date ?? m.date, companyId), 0), companyCurrencyRecord(db, companyId));

/** Warning for additional credit exposure (0 = no limit). */
export function creditWarning(db, partnerId, amount, document = {}) {
  if (document.state === 'cancel') return '';
  const p = read(db, 'res.partner', partnerId);
  const limit = Number(p?.credit_limit) || 0;
  if (!limit) return;
  const companyId = document.company_id ?? 1;
  const exposure = roundCurrency(receivableOf(db, partnerId, companyId) + toCompany(db, document.currency_id, amount, document.invoice_date ?? document.date_order ?? document.date, companyId), companyCurrencyRecord(db, companyId));
  return exposure > limit ? `${p.name} would exceed the credit limit (${exposure} > ${limit})` : '';
}

/**
 * Non-blocking warning when another vendor bill for the same vendor has the same reference,
 * or (when no reference is set) the same amount and bill date.
 */
export function duplicateBillWarning(db, bill) {
  if (!bill || bill.move_type !== 'in_invoice' || bill.state === 'cancel' || !bill.partner_id || !db) return '';
  const companyId = bill.company_id ?? 1;
  const ref = String(bill.ref ?? '').trim();
  const docCurr = documentCurrency(db, bill);
  const billTotal = roundCurrency(total(bill, db), docCurr);
  const candidates = (db.records?.['account.move'] ?? []).filter((m) =>
    m.id !== bill.id
    && m.active !== false
    && m.move_type === 'in_invoice'
    && m.state !== 'cancel'
    && (m.company_id ?? 1) === companyId
    && m.partner_id === bill.partner_id
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
const HASHED_FIELDS = ['name', 'line_ids', 'invoice_line_ids', 'invoice_date', 'date', 'state', 'partner_id', 'journal_id', 'company_id', 'inalterable_hash', 'secure_sequence_number', 'inalterable_hash_version', 'move_type', 'reversed_entry_id', 'reversal_move_id', 'correction_of_id', 'is_closing', 'currency_id', 'fiscal_position_id'];
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
 * The latest lock date that applies to a move: the global and hard locks always, the sales or purchase lock
 * by journal type. Empty when nothing is locked.
 */
export function lockDateFor(settings = {}, move = {}, journal = null) {
  const sales = String(move.move_type ?? '').startsWith('out_') || journal?.type === 'sale';
  const purchases = String(move.move_type ?? '').startsWith('in_') || journal?.type === 'purchase';
  return [settings.lock_date, settings.hard_lock_date, sales && settings.sale_lock_date, purchases && settings.purchase_lock_date].filter(Boolean).sort().at(-1) ?? '';
}

const companyLockDate = (db, move) => move ? [lockDateFor(db.settings, move, (db.records['account.journal'] ?? []).find((journal) => journal.id === move.journal_id)), (db.records['res.company'] ?? []).find((c) => c.id === (move.company_id ?? 1))?.hard_lock_date].filter(Boolean).sort().at(-1) ?? '' : '';
const companyTaxLock = (settings, companyId) => settings?.tax_lock_dates?.[companyId];
export function returnCompanies(db, ret) {
  if (!ret.tax_unit_id) return [ret.company_id ?? 1];
  const unit = read(db, 'account.tax.unit', ret.tax_unit_id);
  if (!unit || !(unit.company_ids ?? []).includes(ret.company_id ?? 1)) throw new Error('Tax unit must contain the return company');
  return [...new Set(unit.company_ids)];
}
export const returnTaxLock = (db, companyId, excludeId = null) => (db.records?.['account.return'] ?? [])
  .filter((r) => r.id !== excludeId && ['submitted', 'paid'].includes(r.state) && returnCompanies(db, r).includes(companyId))
  .map((r) => r.date_to).filter(Boolean).sort().at(-1) ?? '';
/** Tax locks apply only to entries carrying tax information or touching a tax account. */
function taxLockFor(db, move, settings = db.settings) {
  const lock = companyTaxLock(settings, move?.company_id ?? 1);
  if (!move || !lock) return '';
  const accounts = taxAccounts(db, move.company_id);
  const ids = new Set([...accounts.sale, ...accounts.purchase,
    accountId(db, TRANSITION.sale, move.company_id), accountId(db, TRANSITION.purchase, move.company_id)]);
  const taxable = (move.line_ids ?? []).some((line) => line.tax_name || line.tax_id || ids.has(line.account_id))
    || (move.invoice_line_ids ?? []).some((line) => line.tax_id || line.tax_name || Number(line.tax));
  return taxable ? lock : '';
}

/** A reconciled bank transaction points at this entry: it has to stay posted and in place. */
const bookedByBank = (db, id) => (db.records['account.bank.statement.line'] ?? []).some((l) => l.bank_move_id === id || l.writeoff_move_id === id || (l.allocations ?? []).some((a) => a.payment_move_id === id || a.writeoff_move_id === id) || (l.state === 'reconciled' && (l.move_id === id || l.payment_move_id === id)));

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

/** Accounts used by journal items cannot be deleted (archive them instead): their balances would vanish from reports. */
export function accountDeleteGuard(db, account, pending = db) {
  // `pending` is the database as the diff leaves it, so moves created in the same diff count too.
  const used = [...(db.records['account.move'] ?? []), ...(pending.records['account.move'] ?? [])].some((m) => (m.line_ids ?? []).some((l) => l.account_id === account.id));
  return used ? `${account.code} ${account.name} has journal items and cannot be deleted` : null;
}

/** What a posted entry keeps until it is reset to draft. */
const POSTED_FIELDS = ['name', 'line_ids', 'invoice_line_ids', 'partner_id', 'currency_id', 'move_type', 'journal_id', 'invoice_date', 'invoice_date_due', 'date', 'company_id', 'fiscal_position_id', 'tax_return_id', 'active'];

/** Workflow rules for posted entries that the browser's buttons follow and a forged change must follow too. */
function postedMoveRule(db, before, after) {
  if (before?.state === 'posted' && after.state === 'posted') {
    if (changedFields(before, after, POSTED_FIELDS)) return 'Posted entries cannot be edited; reset them to draft first';
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
    if (lines.some((l) => Number(l.debit) < 0 || Number(l.credit) < 0)) return 'Debits and credits cannot be negative';
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
  const date = source?.move_type !== 'entry' && source?.invoice_date ? source.invoice_date : payment && !payment.invoice_id ? p.date : (inv.invoice_date ?? p.date);
  return toCompany(db, inv.currency_id, p.amount, date, inv.company_id);
};

/** What a payment or discount entry can settle for `inv`: its partner's receivable/payable on the settling side. */
function settlementCapacity(db, entry, inv) {
  if (!entry || entry.state !== 'posted' || entry.id === inv.id || (entry.company_id ?? 1) !== (inv.company_id ?? 1)) return 0;
  const companyRound = (n) => roundCurrency(n, companyCurrencyRecord(db, inv.company_id));
  const taxReturn = (db.records['account.return'] ?? []).find((r) => (r.closing_move_ids ?? []).includes(inv.id) && ['submitted', 'paid'].includes(r.state));
  if (taxReturn) {
    const invCompanyId = inv.company_id ?? 1;
    let expected;
    try {
      if (!returnCompanies(db, taxReturn).includes(invCompanyId)) return 0;
      expected = taxClosingSpec(db, taxReturn, invCompanyId).payable;
    } catch { return 0; }
    const payment = (db.records['account.payment'] ?? []).find((p) => p.state === 'posted' && p.is_tax_payment && p.return_id === taxReturn.id && p.move_id === entry.id);
    const settlement = (inv.payments ?? []).find((p) => p.move_id === entry.id && !p.reversed);
    const closingLine = Number.isInteger(settlement?.line_index) ? inv.line_ids?.[settlement.line_index] : null;
    if (!payment || !closingLine || closingLine.account_id !== payment.destination_account_id || closingLine.partner_id !== payment.partner_id
      || (payment.company_id ?? 1) !== invCompanyId) return 0;
    const signed = round((Number(closingLine.credit) || 0) - (Number(closingLine.debit) || 0));
    const paid = round((entry.line_ids ?? []).filter((line) => line.account_id === closingLine.account_id && line.partner_id === payment.partner_id)
      .reduce((sum, line) => sum + (Number(line.debit) || 0) - (Number(line.credit) || 0), 0));
    if (!signed || signed !== expected || Math.sign(signed) !== Math.sign(paid)) return 0;
    return Math.min(Math.abs(signed), Math.abs(paid));
  }
  // A credit note and its original invoice settle each other through their opposite receivable/payable lines.
  const creditPair = (note, original) => note.reversed_entry_id === original.id
    && note.move_type === (original.move_type === 'out_invoice' ? 'out_refund' : original.move_type === 'in_invoice' ? 'in_refund' : null)
    && note.partner_id === original.partner_id && (note.currency_id ?? null) === (original.currency_id ?? null);
  if (entry.move_type !== 'entry' && !creditPair(entry, inv) && !creditPair(inv, entry)) return 0;
  const account = invoiceCounterpartAccount(db, inv);
  return companyRound((entry.line_ids ?? []).filter((l) => l.partner_id === inv.partner_id && l.account_id === account)
    .reduce((s, l) => s + (settledByCredit(inv) ? 1 : -1) * ((Number(l.credit) || 0) - (Number(l.debit) || 0)), 0));
}

/** Whether entry `id` records a posted payment or settles another entry, so resetting or deleting it would orphan them. */
function backsSettlement(db, id) {
  return (db.records['account.payment'] ?? []).some((p) => p.state === 'posted' && p.move_id === id)
    || (db.records['account.move'] ?? []).some((m) => m.id !== id && (m.payments ?? []).some((p) => p?.move_id === id || p?.payment_fx_move_id === id));
}

/**
 * Checked once the whole change set is applied: the paid amount of an entry only moves by appending payments that point
 * at posted payment or discount entries for its partner, by exactly their amount and within what those entries settle;
 * an entry that records a payment stays posted while the payment does.
 */
export function moveInvariant(db, after, before) {
  if (before?.state === 'posted' && after.state !== 'posted' && backsSettlement(db, after.id)) return 'This entry records a payment; reverse the payment instead';
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
    const { reversed: flag, reversal_move_id: reversalId, reversal_date: revDate, ...original } = current;
    const entry = (db.records['account.move'] ?? []).find((m) => m.id === reversalId);
    const source = (db.records['account.move'] ?? []).find((m) => m.id === p.move_id);
    return JSON.stringify(original) !== JSON.stringify(p) || !source || entry?.state !== 'posted' || (revDate && revDate !== entry.invoice_date) || (p.date && p.date > entry.invoice_date) || entry.reversed_entry_id !== source.id
      || JSON.stringify((source.line_ids ?? []).map((l) => [l.account_id, l.partner_id, l.debit || 0, l.credit || 0]))
      !== JSON.stringify((entry.line_ids ?? []).map((l) => [l.account_id, l.partner_id, l.credit || 0, l.debit || 0]));
  })) return 'Registered payments cannot be changed without a posted reversing journal entry';
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
  const net = (fx?.line_ids ?? []).filter((l) => l.account_id === account && l.partner_id === invoice.partner_id).reduce((sum, l) => sum + (Number(l.debit) || 0) - (Number(l.credit) || 0), 0);
  const configured = exchangeAccount(db, invoice.company_id, difference);
  const offset = typeof configured === 'number' ? configured : accountId(db, configured, invoice.company_id ?? 1);
  const lines = fx?.line_ids ?? [];
  const other = lines.filter((l) => l.account_id === offset && !l.partner_id);
  const otherNet = other.reduce((sum, l) => sum + (Number(l.debit) || 0) - (Number(l.credit) || 0), 0);
  if (fx?.state !== 'posted' || fx.move_type !== 'entry' || fx.fx_payment_move_id !== p.move_id || fx.fx_invoice_id !== invoice.id || (fx.company_id ?? 1) !== (invoice.company_id ?? 1) || fx.invoice_date !== p.date || lines.length !== 2 || other.length !== 1 || companyRound(net) !== companyRound(difference) || companyRound(otherNet) !== companyRound(-difference)) return 'A dedicated posted exchange entry must match the settlement';
  return null;
}

/** Validate a synchronized newly-created FX entry against its staged settlement. */
export function fxProvenanceError(db, entry) {
  const invoice = read(db, 'account.move', entry.fx_invoice_id);
  const row = (invoice?.payments ?? []).find((p) => p.payment_fx_move_id === entry.id && p.move_id === entry.fx_payment_move_id);
  if (!row) return 'Exchange provenance requires its settlement';
  return settlementFxError(db, invoice, row);
}

/** A posted payment must have its own posted journal entry, booked for its partner. */
export function paymentInvariant(db, after) {
  if (after.check_number != null && (!Number.isSafeInteger(after.check_number) || after.check_number < 1 || !after.journal_id || after.payment_type !== 'outbound' || (after.voided_check_numbers ?? []).some((v) => v.check_number === after.check_number) || (db.records['account.payment'] ?? []).some((p) => p.id !== after.id && p.journal_id === after.journal_id && (p.check_number === after.check_number || (p.voided_check_numbers ?? []).some((v) => v.check_number === after.check_number))))) return 'Check number must be unique within its journal';
  if (after.state !== 'posted') return null;
  const entry = (db.records['account.move'] ?? []).find((m) => m.id === after.move_id);
  if (entry?.state !== 'posted' || entry.move_type !== 'entry') return 'A posted payment needs its posted journal entry';
  if (after.is_tax_payment || after.return_id) {
    const ret = (db.records['account.return'] ?? []).find((r) => r.id === after.return_id && r.state === 'paid');
    const closings = (ret?.closing_move_ids ?? []).map((id) => (db.records['account.move'] ?? []).find((m) => m.id === id));
    if (!ret || !closings.some((closing) => closing && settlementCapacity(db, entry, closing) >= round(Number(after.amount) || 0))) return 'The tax payment must settle its closing entry';
  } else {
  if (!after.partner_id || !Number.isFinite(Number(after.amount)) || !(Number(after.amount) > 0)) return 'A posted payment needs a partner and a positive amount';
  if ((entry.company_id ?? 1) !== (after.company_id ?? 1)) return 'The journal entry does not belong to this payment';
  const inbound = after.payment_type === 'inbound';
  const invoice = (db.records['account.move'] ?? []).find((m) => m.id === after.invoice_id);
  let account;
  try {
    account = invoice
      ? invoiceCounterpartAccount(db, invoice)
      : resolveCounterpartAccount(db, {
        companyId: after.company_id ?? 1,
        partnerId: after.partner_id,
        accountType: after.partner_type === 'supplier' ? 'liability_payable' : 'asset_receivable',
      });
  } catch (error) {
    return error.message;
  }
  const companyRound = (n) => roundCurrency(n, companyCurrencyRecord(db, after.company_id));
  const companyStep = Number(companyCurrencyRecord(db, after.company_id)?.rounding ?? 0.01);
  const net = (id) => companyRound((entry.line_ids ?? []).filter((l) => l.account_id === id && l.partner_id === after.partner_id).reduce((s, l) => s + (Number(l.debit) || 0) - (Number(l.credit) || 0), 0));
  const expected = invoice ? toCompany(db, invoice.currency_id, after.amount, after.date, invoice.company_id) : companyRound(Number(after.amount));
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
const isReturnEntry = (db, move) => !!move.tax_return_id && (read(db, 'account.return', move.tax_return_id)?.closing_move_ids ?? []).includes(move.id);

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
  return securedMoveRule(before, after) ?? lockRule(db, before, after, ctx) ?? accountsError(db, before, after) ?? postedMoveRule(db, before, after);
}

function lockRule(db, before, after, ctx) {
  if ((before?.closing_fiscal_year_id ?? null) !== (after.closing_fiscal_year_id ?? null)) {
    if (before || !after.closing_fiscal_year_id || read(db, 'account.fiscal.year', after.closing_fiscal_year_id)?.closing_move_id !== after.id) return 'Closing provenance is set only by closing the fiscal year';
  }
  if (before?.state === 'posted' && after.state !== 'posted' && bookedByBank(db, before.id)) return 'This entry is matched with a reconciled bank transaction and has to stay posted';
  if (db.settings?.audit_trail && before?.state === 'posted' && before.name !== after.name) return 'Posted entries keep their number while the audit trail is active';
  // The closing flag takes an entry out of the P&L, so only fiscal-year closing sets it, and nothing clears it.
  if (!!after.is_closing !== !!before?.is_closing && (before?.is_closing || !isYearEntry(db, after.id))) return 'Only fiscal year closing marks closing entries';
  // A year's own closing or reopening entry is booked into it once, as it is created.
  const companyId = before?.company_id ?? after.company_id ?? 1;
  const yearLock = !before && isYearEntry(db, after.id) ? '' : closedYearLock(db, companyId);
  const proposed = companyTaxLock(ctx?.settings, companyId);
  const current = companyTaxLock(db.settings, companyId);
  const remaining = returnTaxLock(db, companyId);
  const validDate = typeof proposed === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(proposed) && !Number.isNaN(Date.parse(proposed)) && new Date(proposed).toISOString().slice(0, 10) === proposed;
  const lowered = current && (proposed === null || validDate) && (proposed ?? '') < current;
  const adjusted = [proposed, remaining].filter(Boolean).sort().at(-1) ?? null;
  const taxSettings = !lowered ? db.settings : { ...db.settings, tax_lock_dates: { ...db.settings?.tax_lock_dates, [companyId]: adjusted } };
  const beforeLock = before ? [companyLockDate(db, before), taxLockFor(db, before, taxSettings), yearLock].sort().at(-1) : '';
  const afterLock = [companyLockDate(db, after), taxLockFor(db, after, taxSettings), yearLock].sort().at(-1);
  const beforeLocked = before && beforeLock && moveDate(before) <= beforeLock;
  const afterLocked = after.state === 'posted' && afterLock && moveDate(after) <= afterLock;
  if (!beforeLocked && !afterLocked) return null;
  const lock = [beforeLocked && beforeLock, afterLocked && afterLock].filter(Boolean).sort().at(-1);
  const changed = !before || changedFields(before, after, LOCKED_FIELDS)
    || (beforeLocked && changedFields(before, after, SETTLEMENT_FIELDS) && !settlesAfterLock(db, before, after, beforeLock));
  return changed ? `The period up to ${lock} is locked` : null;
}

/**
 * Checked once the whole change set is applied: payments that settle a locked entry must point at posted journal
 * entries dated after the lock that book something for the entry's partner, so a forged object cannot mark it paid.
 */
export function lockedSettlementInvariant(db, after, before) {
  const lock = before && [companyLockDate(db, before), taxLockFor(db, before), closedYearLock(db, before.company_id ?? 1)].sort().at(-1);
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
export const datedLockGuard = (fields, booked) => (db, before, after) => {
  const locks = [before, after].filter((r) => r && booked(r))
    .map((r) => ({ record: r, lock: [companyLockDate(db, r), closedYearLock(db, r.company_id ?? 1)].sort().at(-1) }))
    .filter(({ record, lock }) => lock && String(record.date ?? today()) <= lock)
    .map(({ lock }) => lock);
  if (!locks.length) return null;
  const lock = locks.sort().at(-1);
  return !before || changedFields(before, after, fields) ? `The period up to ${lock} is locked` : null;
};

/** Delete guard to pair with datedLockGuard: booked records dated inside the lock stay. */
export const datedLockDelete = (booked) => (db, r) => {
  const lock = [companyLockDate(db, r), closedYearLock(db, r.company_id ?? 1)].sort().at(-1);
  return lock && booked(r) && String(r.date ?? today()) <= lock ? `The period up to ${lock} is locked` : null;
};

/** With the audit trail on, numbered entries are kept forever (they can be cancelled, not deleted). */
export function moveDeleteGuard(db, move, staged = db) {
  if (move.inalterable_hash || staged?.inalterable_hash) return 'Secured entries with an inalterability hash cannot be deleted';
  // `staged` is the database as the change set leaves it: a year that starts naming this entry in the same set counts.
  if (isYearEntry(db, move.id) || isYearEntry(staged, move.id)) return 'Fiscal year closing entries are kept; reopen the fiscal year instead';
  if (isReturnEntry(db, move) || isReturnEntry(staged, move)) return 'Tax return closing entries are kept';
  if (bookedByBank(db, move.id) || bookedByBank(staged, move.id)) return 'This entry is matched with a reconciled bank transaction and cannot be deleted';
  const lock = [companyLockDate(db, move), taxLockFor(db, move), closedYearLock(db, move.company_id ?? 1)].sort().at(-1);
  if (lock && moveDate(move) <= lock) return `The period up to ${lock} is locked`;
  if (db.settings?.audit_trail && move.name && move.name !== '/') return 'Numbered entries cannot be deleted while the audit trail is active; cancel them instead';
  if (move.state === 'posted') return 'Posted entries cannot be deleted; reset them to draft first';
  if (backsSettlement(db, move.id) || backsSettlement(staged, move.id)) return 'This entry records a payment; reverse the payment instead';
  return null;
}

/** Tax accounts per side: the default VAT accounts plus every account a sale / purchase tax books to. */
export function taxAccounts(db, companyId) {
  const of = (use, code) => new Set([
    accountId(db, code, companyId),
    ...search(db, 'account.tax')
      .filter((x) => x.type_tax_use === use && (!companyId || !x.company_id || (x.company_id ?? 1) === companyId))
      .map((x) => x.account_id),
  ].filter(Boolean));
  return { sale: of('sale', '251000'), purchase: of('purchase', '131000') };
}

/** Posted journal items on tax accounts in the period, with their side and signed tax (output credit / input debit positive). */
function taxItems(db, period) {
  if (period?.tax_unit_id) return returnCompanies(db, period).flatMap((company_id) => taxItems(db, { ...period, tax_unit_id: null, company_id }));
  const accounts = taxAccounts(db, period?.company_id ?? period?.company);
  const moves = new Map((db.records['account.move'] ?? []).map((m) => [m.id, m]));
  const transitions = new Set([accountId(db, TRANSITION.sale), accountId(db, TRANSITION.purchase)]);
  return journalItems(db, period).flatMap((l) => {
    if (l.is_closing || l.is_tax_closing || l.is_tax_payment) return [];
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
  const report = validateTaxReturnPeriod(db, ret);
  const accounts = taxAccounts(db, ret.company_id);
  const taxIds = new Set([...accounts.sale, ...accounts.purchase]);
  const balances = new Map();
  for (const line of journalItems(db, { from: ret.date_from, to: ret.date_to, company_id: ret.company_id })) {
    if (line.is_closing || line.is_tax_closing || line.is_tax_payment) continue;
    if (taxIds.has(line.account_id)) balances.set(line.account_id, (balances.get(line.account_id) ?? 0) + (Number(line.debit) || 0) - (Number(line.credit) || 0));
  }
  const lines = [];
  let netClosed = 0;
  for (const [id, raw] of balances) {
    const balance = round(raw);
    if (!balance) continue;
    lines.push(balance > 0 ? { account_id: id, credit: balance } : { account_id: id, debit: -balance });
    netClosed = round(netClosed - balance);
  }
  if (round(netClosed - report.payable)) throw new Error('Unbalanced tax account: ledger balance does not match tax report');
  const payableAccount = resolveCompanyTaxAccount(db, type, 'tax_payable_account_id', 'Tax Payable Account', companyId);
  const receivableAccount = resolveCompanyTaxAccount(db, type, 'tax_receivable_account_id', 'Tax Receivable Account', companyId);
  const partner = read(db, 'res.partner', type?.payment_partner_id);
  if (!partner) {
    throw new Error(`Tax return type "${type?.name ?? ''}" needs a Payment Partner configured (payment_partner_id)`);
  }
  if (report.payable > 0) {
    lines.push({ account_id: payableAccount.id, credit: report.payable, partner_id: partner.id });
  } else if (report.payable < 0) {
    lines.push({ account_id: receivableAccount.id, debit: -report.payable, partner_id: partner.id });
  }
  if (!lines.length) {
    lines.push({ account_id: payableAccount.id, debit: 0, credit: 0 }, { account_id: receivableAccount.id, debit: 0, credit: 0 });
  }
  return { lines, payable: report.payable, payableAccount, receivableAccount, partner: partner.id };
}

/** Validate a submitted closing against its linked return and the posted ledger. */
export function taxClosingMatchesReturn(db, ret) {
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
      payable = round(payable + spec.payable);
      const expected = spec.lines.map((line) => {
        const net = round((line.debit ?? 0) - (line.credit ?? 0));
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
  for (const { company, lines } of specs) {
    const entry = postEntry(next, { journal: 'MISC', date: ret.date_to, ref: `Tax Closing: ${ret.name}`, lines, company, tax_return_id: ret.id });
    next = entry.db;
    ids.push(entry.id);
  }
  return { db: next, ids, payable: round(specs.reduce((s, spec) => s + spec.payable, 0)) };
}

const BUCKETS = [['current', 'Not due', -Infinity, 0], ['1_30', '1-30', 1, 30], ['31_60', '31-60', 31, 60], ['61_90', '61-90', 61, 90], ['older', 'Older', 91, Infinity]];

/**
 * Base and tax per tax from the same journal items as the totals, so the rows always add up to them:
 * invoices, POS, expenses and cash-basis releases alike, in company currency; refunds come out negative.
 */
export function taxesByTax(db, period = {}) {
  const rows = new Map();
  for (const l of taxItems(db, period)) {
    const name = l.tax_name || 'Untagged';
    const key = JSON.stringify([l.side, l.tax_id ?? null, l.tax_id == null ? name : null]);
    const row = rows.get(key) ?? { side: l.side, tax_id: l.tax_id ?? null, name, base: 0, tax: 0 };
    const base = l.invoiceBase ?? (l.tax_base_signed ? (Number(l.tax_base) || 0) : (l.tax ? Math.sign(l.tax) : 1) * (Number(l.tax_base) || 0));
    rows.set(key, { ...row, base: round(row.base + base), tax: round(row.tax + l.tax) });
  }
  return [...rows.values()].sort((a, b) => a.side.localeCompare(b.side) || a.name.localeCompare(b.name));
}

/** Tax grid amounts from tags on posted journal items. */
export function taxesByGrid(db, period = {}) {
  const rows = new Map();
  const moves = new Map((db.records['account.move'] ?? []).map((m) => [m.id, m]));
  const items = period.tax_unit_id
    ? returnCompanies(db, period).flatMap((company_id) => journalItems(db, { ...period, tax_unit_id: null, company_id }))
    : journalItems(db, period);
  for (const line of items) {
    if (line.is_closing || line.is_tax_closing || line.is_tax_payment) continue;
    const move = moves.get(line.move_id);
    const side = line.tax_side || (['out_invoice', 'out_refund'].includes(move?.move_type) ? 'sale' : ['in_invoice', 'in_refund'].includes(move?.move_type) ? 'purchase' : null);
    if (!side) continue;
    const balance = (Number(line.debit) || 0) - (Number(line.credit) || 0);
    const value = side === 'sale' ? -balance : balance;
    for (const id of line.tax_tag_ids ?? []) {
      const tag = read(db, 'account.account.tag', id);
      if (!tag) continue;
      const row = rows.get(id) ?? { id, name: tag.name, base: 0, tax: 0 };
      if (line.tax_grid_base) row.base = round(row.base + value);
      else if (line.tax_name && !line.tax_zero && line.tax_side) {
        row.tax = round(row.tax + value);
        if (line.tax_grid_release) row.base = round(row.base + (Number(line.tax_base) || 0));
      }
      rows.set(id, row);
    }
  }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
}

/** Open installments in company currency, using the schedule recorded when the document was posted. */
function openInstallments(db, m, kind, at, { includeBlocked = true } = {}) {
  const companyRound = (n) => roundCurrency(n, companyCurrencyRecord(db, m.company_id));
  const payments = m.payments ?? [];
  const accountType = kind === 'receivable' ? 'asset_receivable' : 'liability_payable';
  const allItems = (m.line_ids ?? []).filter((l) => read(db, 'account.account', l.account_id)?.account_type === accountType);
  const items = allItems;
  const counterpart = items.reduce((sum, l) => sum + (Number(l.debit) || 0) - (Number(l.credit) || 0), 0);
  const booked = Math.abs(counterpart) || Number(m.amount_total) || 0;
  const active = payments.filter((p) => !p.reversed).reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
  const legacy = Math.max(0, (Number(m.amount_paid) || 0) - active);
  const allocations = settlementCompanyAllocations(db, m);
  let paid = (m.payment_date && m.payment_date <= at ? companyRound(booked * legacy / (Number(m.amount_total) || 1)) : 0) + allocations.filter(({ row: p }) => applicationActiveAt(db, p, m, at)).reduce((sum, allocation) => sum + allocation.value, 0);
  let dues = items.map((l) => ({ date: l.date_maturity ?? m.invoice_date_due ?? m.invoice_date, amount: Math.abs((Number(l.debit) || 0) - (Number(l.credit) || 0)), blocked: l.blocked }));
  if (!items.length) {
    const term = read(db, 'account.payment.term', m.invoice_payment_term_id);
    const docDues = term?.line_ids?.length ? installments(term, m.amount_total, m.invoice_date, documentCurrency(db, m)) : [{ date: m.invoice_date_due ?? m.invoice_date, amount: m.amount_total }];
    let assigned = 0;
    dues = docDues.map((d, i) => {
      const amount = i === docDues.length - 1 ? companyRound(booked - assigned) : companyRound(booked * d.amount / (Number(m.amount_total) || 1));
      assigned = companyRound(assigned + amount);
      return { ...d, amount };
    });
  }
  dues.sort((a, b) => a.date.localeCompare(b.date));
  return dues.map((due) => {
    const applied = Math.min(paid, due.amount);
    paid -= applied;
    return { date: due.date, amount: companyRound(due.amount - applied), blocked: due.blocked };
  }).filter((due) => due.amount > 0 && (includeBlocked || !due.blocked));
}

/** Add the open installments of posted invoices and refunds. */
function ageDocumentInstallments(db, kind, at, moves, add) {
  const types = kind === 'receivable' ? ['out_invoice', 'out_refund'] : ['in_invoice', 'in_refund'];
  for (const m of moves.filter((x) => x.state === 'posted' && types.includes(x.move_type) && (x.date ?? x.invoice_date) <= at)) {
    for (const due of openInstallments(db, m, kind, at)) add(m.partner_id, due.date, (m.move_type.endsWith('refund') ? -1 : 1) * due.amount, m);
  }
}

/** Add each payment's unallocated portion until it is applied or reversed. */
function ageUnappliedCredits(db, kind, at, moves, add) {
  for (const payment of search(db, 'account.payment')) {
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
    if (remaining > 0) add(payment.partner_id, payment.date, sign * remaining, null, entry);
  }
}

/** The reporting cutoff is never later than the day the report is run. */
export const agedReportDate = (end, now = today()) => end && end < now ? end : now;

/** Aged receivable/payable per partner, bucketed by days past due. */
export function agedBalance(db, kind = 'receivable', at = today()) {
  const rows = new Map();
  const add = (partner, date, amount, document = null, source = document) => {
    amount = reportingBookedAmount(db, source, amount);
    const days = Math.floor((new Date(at) - new Date(date)) / 864e5);
    const bucket = BUCKETS.find(([, , from, to]) => days >= from && days <= to)[0];
    const row = rows.get(partner) ?? { partner_id: partner, total: 0, invoices: [], ...Object.fromEntries(BUCKETS.map(([k]) => [k, 0])) };
    row[bucket] = round(row[bucket] + amount);
    row.total = round(row.total + amount);
    if (document) {
      let detail = row.invoices.find((item) => item.move_id === document.id);
      if (!detail) {
        detail = { move_id: document.id, name: document.name, total: 0, ...Object.fromEntries(BUCKETS.map(([k]) => [k, 0])) };
        row.invoices.push(detail);
      }
      detail[bucket] = round(detail[bucket] + amount);
      detail.total = round(detail.total + amount);
    }
    rows.set(partner, row);
  };
  const moves = search(db, 'account.move');
  ageDocumentInstallments(db, kind, at, moves, add);
  ageUnappliedCredits(db, kind, at, moves, add);
  return { buckets: BUCKETS.map(([k, label]) => [k, label]), rows: [...rows.values()].sort((a, b) => b.total - a.total) };
}

/**
 * One summary card per journal, as on the accounting dashboard: documents to validate, unpaid and late
 * for sales/purchase journals; balance and lines to reconcile for bank/cash journals.
 */
export function journalCards(db, at = today()) {
  const moves = search(db, 'account.move');
  const companyByMove = new Map(moves.map((m) => [m.id, m.company_id]));
  const items = journalItems(db);
  // Draft invoices get their journal on posting, so they count on the default INV/BILL journal meanwhile.
  const draftJournal = (m) => (m.move_type === 'entry' ? null : ['in_invoice', 'in_refund'].includes(m.move_type) ? 'BILL' : 'INV');
  return search(db, 'account.journal').map((j) => {
    const own = moves.filter((m) => m.journal_id === j.id || (m.state === 'draft' && !m.journal_id && draftJournal(m) === j.code));
    if (['sale', 'purchase'].includes(j.type)) {
      const unpaid = own.filter((m) => m.state === 'posted' && m.amount_residual > 0);
      return {
        journal: j, kind: j.type, draft: own.filter((m) => m.state === 'draft').length, unpaid: unpaid.length,
        unpaidAmount: companySum(db, unpaid, 'amount_residual', at), unratedCount: unratedCount(db, unpaid, at), late: unpaid.filter((m) => m.invoice_date_due < at).length,
      };
    }
    if (['bank', 'cash'].includes(j.type)) {
      const balances = items.filter((l) => l.account_id === j.default_account_id).map((l) => ({ company_id: companyByMove.get(l.move_id), balance: (Number(l.debit) || 0) - (Number(l.credit) || 0) }));
      const balance = companySum(db, balances, 'balance', at);
      const toCheck = j.type === 'bank' ? search(db, 'account.bank.statement.line').filter((l) => l.state === 'to_check' && l.journal_id === j.id) : [];
      return { journal: j, kind: j.type, balance, unratedCount: unratedCount(db, [...balances, ...toCheck], at), toReconcile: toCheck.length, toReconcileAmount: companySum(db, toCheck, 'amount', at) };
    }
    return { journal: j, kind: 'general', entries: own.filter((m) => m.state === 'posted').length, draft: own.filter((m) => m.state === 'draft').length };
  });
}

/** Partners with overdue invoices, for payment reminders. */
export function followUps(db, at = today(), { ignoreNextActionDate = false } = {}) {
  const overdue = search(db, 'account.move').filter((m) => m.state === 'posted' && m.move_type === 'out_invoice' && (!m.invoice_date || m.invoice_date <= at)).flatMap((m) => {
    if (m.exclude_from_followup) return [];
    const partner = read(db, 'res.partner', m.partner_id);
    if (!partner) return [];
    const compLine = partnerFollowUp(partner, m.company_id ?? 1);
    if (compLine?.no_followup || compLine?.followup_status === 'no_action_needed') return [];
    if (!ignoreNextActionDate && compLine?.followup_next_action_date && compLine.followup_next_action_date > at) return [];

    if (!m.invoice_date || !(m.line_ids ?? []).length) return m.amount_residual > 0 && m.invoice_date_due < at ? [m] : [];
    const dues = openInstallments(db, m, 'receivable', at, { includeBlocked: false }).filter((due) => due.date < at);
    if (!dues.length) return [];
    const booked = (m.line_ids ?? []).filter((l) => read(db, 'account.account', l.account_id)?.account_type === 'asset_receivable').reduce((sum, l) => sum + (Number(l.debit) || 0) - (Number(l.credit) || 0), 0);
    const amount = round(dues.reduce((sum, due) => sum + due.amount, 0) * (Number(m.amount_total) || 0) / (Math.abs(booked) || Number(m.amount_total) || 1));
    return [{ ...m, invoice_date_due: dues[0].date, amount_residual: amount }];
  });
  const by = new Map();
  for (const m of overdue) (by.get(m.partner_id) ?? by.set(m.partner_id, []).get(m.partner_id)).push(m);
  return [...by].map(([partner_id, invoices]) => ({ partner_id, invoices, total: round(invoices.reduce((s, m) => s + m.amount_residual, 0)), oldest: invoices.map((m) => m.invoice_date_due).sort()[0] }));
}

// A shared contact can have invoices in several companies; never combine their private notes.
export const followUpCompanies = (f) => {
  const groups = new Map();
  for (const invoice of f.invoices) {
    const cId = invoice.company_id ?? 1;
    if (!groups.has(cId)) groups.set(cId, []);
    groups.get(cId).push(invoice);
  }
  return [...groups.entries()].map(([company_id, invoices]) => ({
    ...f, company_id, invoices, total: round(invoices.reduce((s, m) => s + m.amount_residual, 0)), oldest: invoices.map((m) => m.invoice_date_due).sort()[0],
  }));
};
const reminderSource = (f) => ({ model: 'account.move', id: f.invoices[0].id, company_id: f.company_id ?? f.invoices[0].company_id ?? 1 });

/**
 * Automatic reminders: for each overdue customer, the highest follow-up level reached by its oldest overdue
 * invoice is logged on the contact once (the contact remembers the last level sent).
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
    followup_level: vals.followup_level !== undefined ? vals.followup_level : current?.followup_level ?? null,
    followup_last_level: vals.followup_last_level !== undefined ? vals.followup_last_level : current?.followup_last_level ?? null,
    followup_channel: vals.followup_channel !== undefined ? vals.followup_channel : current?.followup_channel ?? null,
    followup_delivery_state: vals.followup_delivery_state !== undefined ? vals.followup_delivery_state : current?.followup_delivery_state ?? null,
    followup_next_action_date: vals.followup_next_action_date !== undefined ? vals.followup_next_action_date : current?.followup_next_action_date ?? null,
    followup_status: vals.followup_status !== undefined ? vals.followup_status : current?.followup_status ?? null,
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

/**
 * Automatic reminders: for each overdue customer, the highest follow-up level reached by its oldest overdue
 * invoice is logged on the contact once (the contact remembers the last level sent).
 */
export function runFollowUps(db, at = today(), deliver = null) {
  const levels = search(db, 'account.followup.level').sort((a, b) => (Number(a.delay) || 0) - (Number(b.delay) || 0));
  if (!levels.length) return db;
  const overdue = followUps(db, at);
  const overdueGroups = overdue.flatMap(followUpCompanies);
  const activeLate = new Set( followUps(db, at, { ignoreNextActionDate: true }).flatMap(followUpCompanies).map((f) => `${f.partner_id}:${f.invoices[0].company_id ?? 1}`));

  const partners = new Map((db.records['res.partner'] ?? []).map((p) => [p.id, p]));
  let nextDb = db;

  for (const partner of partners.values()) {
    const lines = partner.followup_lines ?? [];
    for (const line of lines) {
      const hasProgress = line.followup_level_delay != null || line.followup_date != null || line.followup_level != null || line.followup_delivery_state != null;
      if (hasProgress && !activeLate.has(`${partner.id}:${line.company_id}`)) {
        const current = read(nextDb, 'res.partner', partner.id) ?? partner;
        nextDb = write(nextDb, 'res.partner', partner.id, {
          followup_lines: updatePartnerFollowUp(current, line.company_id, {
            followup_level_delay: null, followup_level: null, followup_date: null,
            followup_last_level: null, followup_channel: null, followup_delivery_state: null,
            followup_next_action_date: null,
          }).followup_lines,
        });
      }
    }
  }

  const processReminder = (state, f) => {
    nextDb = state;
    const companyId = f.invoices[0].company_id ?? 1;
    const level = followUpLevel(nextDb, f, at);
    const partner = partners.get(f.partner_id);
    if (!level || !partner) return nextDb;

    const currentPartner = read(nextDb, 'res.partner', partner.id) ?? partner;
    const progress = partnerFollowUp(currentPartner, companyId);
    const currentDelay = progress?.followup_level_delay != null ? Number(progress.followup_level_delay) : -1;

    if (currentDelay >= Number(level.delay)) return nextDb;
    if (!deliver && progress?.followup_delivery_state !== 'sent' && progress?.followup_date === at) return nextDb;

    const channel = level.channel;
    const recordFailure = (reason) => {
      const deliveryState = channel ? 'not_sent' : 'not_configured';
      const invoiceList = f.invoices.map((move) => `${move.name} (${move.invoice_date_due}): ${round(move.amount_residual)}`).join('; ');
      nextDb = postNote(nextDb, 'res.partner', partner.id,
        `${level.name}: ${round(f.total)} overdue — ${invoiceList}. ${reason} The follow-up level was not advanced.`, reminderSource(f));
      const current = read(nextDb, 'res.partner', partner.id) ?? currentPartner;
      const updated = updatePartnerFollowUp(current, companyId, {
        followup_date: at,
        followup_channel: channel ?? null,
        followup_delivery_state: deliveryState,
        followup_next_action_date: null,
      });
      return write(nextDb, 'res.partner', partner.id, { followup_lines: updated.followup_lines });
    };
    if (channel === 'email' && partner.email?.trim() && deliver) {
      const message = { to: partner.email.trim(), subject: level.name, text: `${level.message ?? ''}\n${followUpText(nextDb, f)}`.trim() };
      // Validate the bookkeeping before attempting an irreversible delivery.
      const sent = logManualFollowUp(nextDb, partner.id, at, { scope: nextDb, reminder: f, companyId, channel, nextLevelBaseDate: f.oldest });
      try {
        const result = deliver(message);
        if (result && typeof result.then === 'function') return result.then(() => sent, (error) => recordFailure(`Email delivery failed: ${error?.message ?? String(error)}`));
        return sent;
      } catch (error) {
        return recordFailure(`Email delivery failed: ${error?.message ?? String(error)}`);
      }
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
  return search(db, 'account.followup.level').filter((level) => days >= (Number(level.delay) || 0))
    .sort((a, b) => (Number(b.delay) || 0) - (Number(a.delay) || 0))[0];
}

const currencyOf = (db, move) => read(db, 'res.currency', move.currency_id)?.name ?? db.settings?.currency ?? '';

/** Reminder text for one customer's overdue invoices, each amount with its currency. */
export const followUpText = (db, f) => f.invoices.map((m) => `${m.name} (${m.invoice_date_due}): ${round(m.amount_residual)} ${currencyOf(db, m)}`.trim()).join('\n');

const manualFollowUpGroups = (db, scope, partnerId, at, reminder, companyId) => {
  const allowed = new Set(search(scope, 'account.move').map((move) => move.id));
  const f = followUps(db, at).find((x) => x.partner_id === partnerId);
  if (!f) throw new Error('This customer has no overdue invoices');
  const allGroups = followUpCompanies({ ...f, invoices: f.invoices.filter((invoice) => allowed.has(invoice.id)) });
  const targetCompany = companyId ?? reminder?.company_id ?? null;
  const groups = targetCompany ? allGroups.filter((g) => g.company_id === targetCompany) : allGroups;
  if (!groups.length) throw new Error('This customer has no overdue invoices');
  return groups;
};

/** Record preparation without claiming that the email was sent. */
export function openManualFollowUp(db, partnerId, at = today(), { scope = db, reminder = null, companyId = null } = {}) {
  const groups = manualFollowUpGroups(db, scope, partnerId, at, reminder, companyId);
  return groups.reduce((next, part) => postNote(next, 'res.partner', partnerId,
    `Payment reminder opened in mail app:\n${followUpText(scope, part)}`, reminderSource(part)), db);
}

/** Record a reminder confirmed sent by hand. */
export function logManualFollowUp(db, partnerId, at = today(), { scope = db, reminder = null, companyId = null, channel = 'email', nextLevelBaseDate = null } = {}) {
  if (!['email', 'phone', 'letter'].includes(channel)) throw new Error('Invalid reminder channel');
  if (channel === 'email' && !read(db, 'res.partner', partnerId)?.email?.trim()) {
    throw new Error('A customer email address is required to send an email reminder');
  }
  const groups = manualFollowUpGroups(db, scope, partnerId, at, reminder, companyId);
  const levels = search(scope, 'account.followup.level').sort((a, b) => (Number(b.delay) || 0) - (Number(a.delay) || 0));

  let nextDb = db;
  let partner = read(db, 'res.partner', partnerId);

  for (const part of groups) {
    const cId = part.company_id;
    const level = followUpLevel(scope, part, at);

    const invoices = part.invoices.map((move) => `${move.name} (${move.invoice_date_due}): ${round(move.amount_residual)}`).join('; ');
    const detail = `${level?.name ?? 'Payment reminder'}: ${round(part.total)} overdue — ${invoices}. ${level?.message ?? ''}`.trim();
    const noteBody = `Payment reminder sent by ${channel}${level ? ` (${level.name})` : ''}:\n${followUpText(scope, part)}\n${detail}`;
    nextDb = postNote(nextDb, 'res.partner', partnerId, noteBody, reminderSource(part));

    const previous = partnerFollowUp(partner, cId)?.followup_level_delay;
    if (level && (previous == null || Number(level.delay) > Number(previous))) {
      partner = updatePartnerFollowUp(partner, cId, {
        followup_level_delay: Number(level.delay),
        followup_date: at,
        followup_level: level.id,
        followup_delivery_state: 'sent',
        ...reminderDetails(levels, level, at, channel, nextLevelBaseDate),
      });
    } else {
      partner = updatePartnerFollowUp(partner, cId, {
        followup_date: at,
        followup_delivery_state: 'sent',
        ...reminderDetails(levels, level, at, channel, nextLevelBaseDate),
      });
    }
  }

  return write(nextDb, 'res.partner', partnerId, {
    followup_lines: partner.followup_lines,
  });
}


/** Analytic entries included in an actuals calculation. */
export function analyticActualLines(db, period = {}) {
  return search(db, 'account.analytic.line').filter((line) => {
    if (!line.account_id || (period.from && line.date < period.from) || (period.to && line.date > period.to)) return false;
    if (period.company_id != null && (line.company_id ?? 1) !== period.company_id) return false;
    if (period.account_id != null && line.account_id !== period.account_id) return false;
    if (period.general_account && !(line.general_account ?? '').startsWith(period.general_account)) return false;
    const move = line.move_id && read(db, 'account.move', line.move_id);
    return !line.move_id || (move?.state === 'posted' && (move.company_id ?? 1) === (line.company_id ?? 1));
  });
}

/** Actual amount per analytic account from posted invoice/bill lines (income positive, costs negative). */
export function analyticActuals(db, period = {}) {
  const totals = new Map();
  for (const line of analyticActualLines(db, period)) {
    totals.set(line.account_id, round((totals.get(line.account_id) ?? 0) + (Number(line.amount) || 0)));
  }
  return totals;
}

export const financeModels = {
  'account.journal.group': {
    label: 'Multi-Ledger',
    fields: {
      name: { type: 'char', label: 'Name', required: true },
      sequence: { type: 'integer', label: 'Sequence' },
      company_id: { type: 'many2one', relation: 'res.company', label: 'Company', required: true },
      journal_ids: { type: 'many2many', relation: 'account.journal', label: 'Included Journals', domain: (journal, record) => !journal.company_id || journal.company_id === record.company_id },
    },
    defaults: () => ({ sequence: 10, journal_ids: [] }),
    createDefaults: (db) => ({ company_id: db.settings?.current_company_id ?? 1 }),
    guard: (db, before, record) => (record.journal_ids ?? []).some((id) => {
      const journal = read(db, 'account.journal', id);
      return !journal || (journal.company_id && journal.company_id !== record.company_id);
    }) ? 'Select journals belonging to this company or shared journals' : null,
    list: ['name', 'sequence', 'company_id', 'journal_ids'],
    form: { title: 'name', groups: [['sequence', 'company_id'], ['journal_ids']] },
  },
  'account.followup.level': {
    label: 'Follow-up Levels',
    fields: {
      name: { type: 'char', label: 'Level', required: true },
      delay: { type: 'integer', label: 'Days Overdue' },
      channel: { type: 'selection', label: 'Automatic Delivery', options: [['email', 'Email'], ['phone', 'Phone'], ['letter', 'Letter']] },
      message: { type: 'text', label: 'Message' },
    },
    defaults: () => ({ delay: 15 }),
    kanban: { title: 'name', lines: ['delay'] },
    list: ['delay', 'name', 'channel'],
    form: { title: 'name', groups: [['delay', 'channel'], []], tabs: [{ label: 'Message', fields: ['message'] }] },
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
      name: { type: 'char', label: 'Budget Name', required: true },
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
    defaults: () => ({ state: 'draft', date_from: today().slice(0, 4) + '-01-01', date_to: today().slice(0, 4) + '-12-31', lines: [] }),
    kanban: { title: 'name', lines: ['date_from', 'date_to'], badge: 'state' },
    list: ['name', 'date_from', 'date_to', 'state'],
    form: {
      statusbar: 'state',
      statusbarClickable: true,
      buttons: [{ label: 'Budget vs Actual', run: (db) => ({ db, go: '#/accounting/budget-report' }) }],
      title: 'name',
      groups: [['date_from'], ['date_to']],
      tabs: [{ label: 'Budget Lines', fields: ['lines'] }],
      chatter: true,
    },
  },
};
