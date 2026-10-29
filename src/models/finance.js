// Credit limits, lock date, audit trail, tax report, aged balances, follow-ups, analytic accounting and budgets.
import { postNote, postNotes, read, search, updateSettings, write, writeMany } from '../orm.js';
import { today } from './common.js';
import { accountId, isBalanced, journalId, journalItems, paymentJournal, postEntry } from './ledger.js';
import { companyCurrency, rateAt, toCompany } from './currency.js';
import { taxGroups, TRANSITION } from './taxes.js';
import { companySum, unratedCount } from './money.js';
import { round } from '../money.js';

/** Open receivable (posted, unpaid invoices) of a partner. */
export const receivableOf = (db, partnerId) => round(search(db, 'account.move')
  .filter((m) => m.state === 'posted' && m.move_type === 'out_invoice' && m.partner_id === partnerId)
  .reduce((s, m) => s + m.amount_residual, 0));

/** Throws when confirming `amount` more would exceed the partner's credit limit (0 = no limit). */
export function checkCreditLimit(db, partnerId, amount) {
  const p = read(db, 'res.partner', partnerId);
  const limit = Number(p?.credit_limit) || 0;
  if (!limit) return;
  const exposure = receivableOf(db, partnerId) + (Number(amount) || 0);
  if (exposure > limit) throw new Error(`${p.name} would exceed the credit limit (${round(exposure)} > ${limit})`);
}

const LOCKED_FIELDS = ['name', 'invoice_line_ids', 'line_ids', 'invoice_date', 'date', 'state', 'partner_id', 'currency_id', 'tax_rate_at_posting', 'move_type', 'journal_id', 'company_id', 'fiscal_position_id', 'active'];
/** Paid status of a locked entry, which only payments dated after the lock may move. */
const SETTLEMENT_FIELDS = ['amount_paid', 'payments', 'payment_date'];
export const moveDate = (m) => (m?.move_type === 'entry' && m?.date ? m.date : m?.invoice_date ?? m?.date ?? today());
/** Archiving hides a record from every report, so `active` counts as changed only between kept and archived. */
const valueOf = (r, k) => JSON.stringify(k === 'active' ? r?.active !== false : r?.[k]);
const changedFields = (before, after, fields) => fields.some((k) => valueOf(before, k) !== valueOf(after, k));

/** True when the paid status moved only by appending payments dated after the lock, and by exactly their amount. */
function settlesAfterLock(before, after, lock) {
  const was = Array.isArray(before.payments) ? before.payments : [];
  const now = Array.isArray(after.payments) ? after.payments : [];
  if (now.length < was.length || JSON.stringify(now.slice(0, was.length)) !== JSON.stringify(was)) return false;
  const added = now.slice(was.length);
  if (!added.every((p) => p && typeof p.date === 'string' && p.date > lock && Number(p.amount) > 0)) return false;
  const paid = round((Number(before.amount_paid) || 0) + added.reduce((sum, p) => sum + Number(p.amount), 0));
  const date = added.length ? added.at(-1).date : before.payment_date;
  return Math.abs(paid - (Number(after.amount_paid) || 0)) < 0.005 && after.payment_date === date;
}

/**
 * Entries in a locked period cannot be created posted or have their accounting changed (payments dated after the
 * lock date may still settle them); with the audit trail on, a posted entry keeps its number.
 */
/**
 * The latest lock date that applies to a move: the global and hard locks always, the sales or purchase lock
 * by journal type. Empty when nothing is locked.
 */
export function lockDateFor(settings = {}, move = {}) {
  const side = String(move.move_type ?? '').startsWith('out_') ? settings.sale_lock_date : String(move.move_type ?? '').startsWith('in_') ? settings.purchase_lock_date : null;
  return [settings.lock_date, settings.hard_lock_date, side].filter(Boolean).sort().at(-1) ?? '';
}

/** Recompute the active global lock date across all active independent sources (manual, closed fiscal years, submitted/paid returns). */
export function activeLockDate(db, { excludeReturnId = null, excludeYearId = null } = {}) {
  const yearLocks = (db.records?.['account.fiscal.year'] ?? [])
    .filter((y) => y.id !== excludeYearId && y.state === 'closed')
    .map((y) => y.date_to);
  const returnLocks = (db.records?.['account.return'] ?? [])
    .filter((r) => r.id !== excludeReturnId && ['submitted', 'paid'].includes(r.state))
    .map((r) => r.date_to);
  const manual = db.settings?.lock_sources?.manual !== undefined
    ? db.settings.lock_sources.manual
    : (yearLocks.includes(db.settings?.lock_date) || returnLocks.includes(db.settings?.lock_date) ? null : db.settings?.lock_date ?? null);
  return [manual, ...yearLocks, ...returnLocks].filter(Boolean).sort().at(-1) ?? '';
}

/** Synchronize db.settings.lock_date and independent lock sources. */
export function syncLockDate(db, opts = {}) {
  const manual = db.settings?.lock_sources?.manual !== undefined
    ? db.settings.lock_sources.manual
    : (db.settings?.lock_date ?? null);
  const lock = activeLockDate(db, opts);
  const lock_sources = { ...(db.settings?.lock_sources ?? {}), manual };
  return updateSettings(db, { lock_date: lock || '', lock_sources });
}

/** A reconciled bank transaction points at this entry: it has to stay posted and in place. */
const bookedByBank = (db, id) => (db.records['account.bank.statement.line'] ?? []).some((l) => l.state === 'reconciled' && (l.move_id === id || l.payment_move_id === id));

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
const POSTED_FIELDS = ['name', 'line_ids', 'invoice_line_ids', 'partner_id', 'currency_id', 'tax_rate_at_posting', 'move_type', 'journal_id', 'invoice_date', 'invoice_date_due', 'date', 'company_id', 'fiscal_position_id', 'active'];

/** Workflow rules for posted entries that the browser's buttons follow and a forged change must follow too. */
function postedMoveRule(before, after) {
  if (before?.state === 'posted' && after.state === 'posted' && changedFields(before, after, POSTED_FIELDS)) return 'Posted entries cannot be edited; reset them to draft first';
  if (before?.state === 'posted' && after.state !== 'posted') {
    if (after.state !== 'draft') return 'Posted entries go back to draft before anything else';
    if (Number(before.amount_paid) > 0 || Number(after.amount_paid) > 0) return 'Paid entries cannot be reset to draft';
  }
  if (after.state === 'posted' && before?.state !== 'posted') {
    if (before && before.state !== 'draft') return 'Only draft entries can be posted';
    const lines = Array.isArray(after.line_ids) ? after.line_ids : [];
    if (lines.some((l) => Number(l.debit) < 0 || Number(l.credit) < 0)) return 'Debits and credits cannot be negative';
    if (!isBalanced(lines)) return 'A posted entry needs balanced journal items';
    if (!after.name || after.name === '/') return 'A posted entry needs a number';
  }
  return null;
}

/** Whether invoice `inv` is settled by the credit (customer invoice, vendor refund) or the debit side of its partner's balance. */
const settledByCredit = (inv) => !['in_invoice', 'out_refund'].includes(inv.move_type);
/** Standalone payment allocations are company currency; invoice-linked applications use the invoice-date rate. */
const appliedValue = (db, inv, p) => {
  const payment = (db.records['account.payment'] ?? []).find((x) => x.move_id === p.move_id && x.state === 'posted');
  return payment && !payment.invoice_id ? Number(p.amount) || 0 : toCompany(db, inv.currency_id, p.amount, inv.invoice_date ?? p.date, inv.company_id);
};

/** What a payment or discount entry can settle for `inv`: its partner's receivable/payable on the settling side. */
function settlementCapacity(db, entry, inv) {
  if (!entry || entry.state !== 'posted' || entry.id === inv.id || (entry.company_id ?? 1) !== (inv.company_id ?? 1)) return 0;
  const taxReturn = (db.records['account.return'] ?? []).find((r) => (r.closing_move_ids ?? []).includes(inv.id) && ['submitted', 'paid'].includes(r.state));
  if (taxReturn) {
    const payment = (db.records['account.payment'] ?? []).find((p) => p.state === 'posted' && p.is_tax_payment && p.return_id === taxReturn.id && p.move_id === entry.id);
    const settlement = (inv.payments ?? []).find((p) => p.move_id === entry.id && !p.reversed);
    const closingLine = Number.isInteger(settlement?.line_index) ? inv.line_ids?.[settlement.line_index] : null;
    if (!payment || !closingLine || closingLine.account_id !== payment.destination_account_id || closingLine.partner_id !== payment.partner_id
      || (taxReturn.company_id ?? 1) !== (inv.company_id ?? 1)) return 0;
    const signed = round((Number(closingLine.credit) || 0) - (Number(closingLine.debit) || 0));
    const paid = round((entry.line_ids ?? []).filter((line) => line.account_id === closingLine.account_id && line.partner_id === payment.partner_id)
      .reduce((sum, line) => sum + (Number(line.debit) || 0) - (Number(line.credit) || 0), 0));
    if (!signed || Math.sign(signed) !== Math.sign(paid) || Math.sign(signed) !== Math.sign(Number(taxReturn.total_amount_to_pay))) return 0;
    return Math.min(Math.abs(signed), Math.abs(paid));
  }
  // A credit note and its original invoice settle each other through their opposite receivable/payable lines.
  const creditPair = (note, original) => note.reversed_entry_id === original.id
    && note.move_type === (original.move_type === 'out_invoice' ? 'out_refund' : original.move_type === 'in_invoice' ? 'in_refund' : null)
    && note.partner_id === original.partner_id && (note.currency_id ?? null) === (original.currency_id ?? null);
  if (entry.move_type !== 'entry' && !creditPair(entry, inv) && !creditPair(inv, entry)) return 0;
  const account = accountId(db, ['in_invoice', 'in_refund'].includes(inv.move_type) ? '211000' : '121000');
  return round((entry.line_ids ?? []).filter((l) => l.partner_id === inv.partner_id && l.account_id === account)
    .reduce((s, l) => s + (settledByCredit(inv) ? 1 : -1) * ((Number(l.credit) || 0) - (Number(l.debit) || 0)), 0));
}

/** Whether entry `id` records a posted payment or settles another entry, so resetting or deleting it would orphan them. */
function backsSettlement(db, id) {
  return (db.records['account.payment'] ?? []).some((p) => p.state === 'posted' && p.move_id === id)
    || (db.records['account.move'] ?? []).some((m) => m.id !== id && (m.payments ?? []).some((p) => p?.move_id === id));
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
  if (Math.abs(paidAfter - paidBefore) < 0.005 && JSON.stringify(was) === JSON.stringify(now)) return null;
  const reversed = was.filter((p, i) => !p.reversed && now[i]?.reversed);
  if (now.length < was.length || was.some((p, i) => {
    const current = now[i];
    if (JSON.stringify(current) === JSON.stringify(p)) return false;
    if (p.reversed || !current?.reversed) return true;
    const { reversed: flag, reversal_move_id: reversalId, ...original } = current;
    const entry = (db.records['account.move'] ?? []).find((m) => m.id === reversalId);
    const source = (db.records['account.move'] ?? []).find((m) => m.id === p.move_id);
    return JSON.stringify(original) !== JSON.stringify(p) || !source || entry?.state !== 'posted' || entry.reversed_entry_id !== source.id
      || JSON.stringify((source.line_ids ?? []).map((l) => [l.account_id, l.partner_id, l.debit || 0, l.credit || 0]))
      !== JSON.stringify((entry.line_ids ?? []).map((l) => [l.account_id, l.partner_id, l.credit || 0, l.debit || 0]));
  })) return 'Registered payments cannot be changed without a posted reversing journal entry';
  const added = now.slice(was.length);
  const entries = new Map((db.records['account.move'] ?? []).map((m) => [m.id, m]));
  if (!added.every((p) => p && Number(p.amount) > 0 && settlementCapacity(db, entries.get(p.move_id), after) > 0)) return 'Payments must point at a posted journal entry';
  if (Math.abs(round(paidBefore - reversed.reduce((sum, p) => sum + Number(p.amount), 0) + added.reduce((sum, p) => sum + Number(p.amount), 0)) - paidAfter) >= 0.005) return 'The paid amount must match the registered payments';
  // One entry may settle several invoices (a payment applied oldest first), but never more than it booked.
  for (const moveId of new Set(added.map((p) => p.move_id))) {
    const used = [...entries.values()].reduce((sum, m) => sum + (m.payments ?? []).filter((p) => !p.reversed && p?.move_id === moveId).reduce((s, p) => s + appliedValue(db, m, p), 0), 0);
    // ponytail: a cent of slack for foreign-currency rounding on partial payments.
    if (used > settlementCapacity(db, entries.get(moveId), after) + 0.01) return 'A payment cannot settle more than its journal entry booked';
  }
  return null;
}

/** A posted payment must have its own posted journal entry, booked for its partner. */
export function paymentInvariant(db, after) {
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
    const account = accountId(db, after.partner_type === 'supplier' ? '211000' : '121000');
    const net = (id) => round((entry.line_ids ?? []).filter((l) => l.account_id === id && l.partner_id === after.partner_id).reduce((s, l) => s + (Number(l.debit) || 0) - (Number(l.credit) || 0), 0));
    const invoice = (db.records['account.move'] ?? []).find((m) => m.id === after.invoice_id);
    const expected = invoice ? toCompany(db, invoice.currency_id, after.amount, after.date, invoice.company_id) : round(Number(after.amount));
    const bank = accountId(db, paymentJournal(db, after.journal_id).account);
    if ((inbound ? -1 : 1) * net(account) <= 0 || Math.abs((inbound ? 1 : -1) * net(bank) - expected) > 0.01
      || (!invoice && Math.abs((inbound ? -1 : 1) * net(account) - expected) > 0.01)) return 'The journal entry must book this payment amount and direction';
  }
  if ((db.records['account.payment'] ?? []).some((p) => p.id !== after.id && p.state === 'posted' && p.move_id === entry.id)) return 'The journal entry already records another payment';
  return null;
}

/** Whether a fiscal year names this entry as its closing or reopening entry. */
const isYearEntry = (db, id) => (db.records?.['account.fiscal.year'] ?? []).some((y) => y.closing_move_id === id || y.opening_move_id === id);

/** A closed fiscal year locks its period whoever closed it. */
export function closedYearLock(db) {
  return (db.records?.['account.fiscal.year'] ?? []).filter((y) => y.state === 'closed').map((y) => y.date_to).sort().at(-1) ?? '';
}

// Only the synchronous, validated tax-closing operation below can grant this ephemeral permission. It is never
// stored in the database or accepted from an ORM record, request context, reference, or client-supplied flag.
const taxClosingAuthorization = new WeakMap();
const taxClosingProofByLines = new WeakMap();
const taxClosingProofDetails = new WeakMap();

/** Opaque proof objects for newly generated closing moves in a trusted server action's diff. */
export function taxClosingProofs(db, diff) {
  const ids = new Set((diff.upserts?.['account.move'] ?? []).map((move) => move.id));
  return (db.records['account.move'] ?? []).filter((move) => ids.has(move.id) && Array.isArray(move.line_ids)).map((move) => taxClosingProofByLines.get(move.line_ids)).filter(Boolean);
}

/** Only a genuine server-generated closing can attest a direct-pay transition collapsed into one sync. */
export function taxClosingProofMatchesReturn(ctx, ret) {
  return (ctx?.taxClosingProofs ?? []).some((token) => {
    const proof = taxClosingProofDetails.get(token);
    return proof && proof.returnId === ret.id && proof.company === ret.company_id && proof.date === ret.date_to
      && (ret.closing_move_ids ?? []).includes(proof.moveId) && round(Number(ret.total_amount_to_pay) || 0) === proof.payable;
  });
}

export function moveGuard(db, before, after, ctx) {
  return lockRule(db, before, after, ctx) ?? accountsError(db, before, after) ?? postedMoveRule(before, after);
}


function lockRule(db, before, after, ctx) {
  if (before?.state === 'posted' && after.state !== 'posted' && bookedByBank(db, before.id)) return 'This entry is matched with a reconciled bank transaction and has to stay posted';
  if (db.settings?.audit_trail && before?.state === 'posted' && before.name !== after.name) return 'Posted entries keep their number while the audit trail is active';
  // The closing flag takes an entry out of the P&L, so only fiscal-year closing sets it, and nothing clears it.
  if (!!after.is_closing !== !!before?.is_closing && (before?.is_closing || !isYearEntry(db, after.id))) return 'Only fiscal year closing marks closing entries';
  // An internally generated closing may post despite a pre-existing lock, but only for its exact validated entry.
  const local = !before && taxClosingAuthorization.get(db);
  const proof = !before && (ctx?.taxClosingProofs ?? []).map((token) => taxClosingProofDetails.get(token)).find((entry) => entry?.moveId === after.id);
  const authorized = local || proof;
  const relatedReturn = authorized && read(db, 'account.return', authorized.returnId);
  const linked = local ? relatedReturn?.state === 'reviewed'
    : ['submitted', 'paid'].includes(relatedReturn?.state) && (relatedReturn.closing_move_ids ?? []).includes(after.id);
  if (authorized && linked && after.move_type === 'entry' && after.state === 'posted' && after.company_id === authorized.company
    && after.date === authorized.date && after.invoice_date === authorized.date && after.journal_id === authorized.journal
    && after.ref === authorized.ref && JSON.stringify((after.line_ids ?? []).map((l) => [l.account_id, l.partner_id, l.debit, l.credit])) === authorized.lines) return null;
  // Existing return closings may be cancelled by the reset workflow.

  const isReturnClosing = (db.records?.['account.return'] ?? []).some((r) => (r.closing_move_ids ?? []).includes((before ?? after).id) && r.state !== 'paid');
  if (isReturnClosing && ['draft', 'cancel'].includes(after.state) && !changedFields(before, after, ['line_ids', 'invoice_line_ids', 'date', 'invoice_date', 'journal_id', 'company_id'])) {
    return null;
  }
  // A year's own closing or reopening entry is booked into it once, as it is created.
  const yearLock = !before && isYearEntry(db, after.id) ? '' : closedYearLock(db);
  const lock = [...[before, after].filter(Boolean).map((m) => lockDateFor(db.settings, m)), yearLock].sort().at(-1);
  if (!lock) return null;
  const touchesLocked = (before && moveDate(before) <= lock) || (after.state === 'posted' && moveDate(after) <= lock);
  if (!touchesLocked) return null;
  const changed = !before || changedFields(before, after, LOCKED_FIELDS)
    || (before && moveDate(before) <= lock && changedFields(before, after, SETTLEMENT_FIELDS) && !settlesAfterLock(before, after, lock));
  return changed ? `The period up to ${lock} is locked` : null;
}

/**
 * Checked once the whole change set is applied: payments that settle a locked entry must point at posted journal
 * entries dated after the lock that book something for the entry's partner, so a forged object cannot mark it paid.
 */
export function lockedSettlementInvariant(db, after, before) {
  const lock = before && [lockDateFor(db.settings, before), closedYearLock(db)].sort().at(-1);
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
  const lock = lockDateFor(db.settings, {});
  if (!lock) return null;
  const inLock = (r) => r && booked(r) && String(r.date ?? today()) <= lock;
  if (!inLock(before) && !inLock(after)) return null;
  return !before || changedFields(before, after, fields) ? `The period up to ${lock} is locked` : null;
};

/** Delete guard to pair with datedLockGuard: booked records dated inside the lock stay. */
export const datedLockDelete = (booked) => (db, r) => {
  const lock = lockDateFor(db.settings, {});
  return lock && booked(r) && String(r.date ?? today()) <= lock ? `The period up to ${lock} is locked` : null;
};

/** With the audit trail on, numbered entries are kept forever (they can be cancelled, not deleted). */
export function moveDeleteGuard(db, move, staged = db) {
  // `staged` is the database as the change set leaves it: a year that starts naming this entry in the same set counts.
  if (isYearEntry(db, move.id) || isYearEntry(staged, move.id)) return 'Fiscal year closing entries are kept; reopen the fiscal year instead';
  if (bookedByBank(db, move.id) || bookedByBank(staged, move.id)) return 'This entry is matched with a reconciled bank transaction and cannot be deleted';
  const lock = [lockDateFor(db.settings, move), closedYearLock(db)].sort().at(-1);
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
  const accounts = taxAccounts(db, period?.company_id ?? period?.company);
  const moves = new Map((db.records['account.move'] ?? []).map((m) => [m.id, m]));
  const transitions = new Set([accountId(db, TRANSITION.sale), accountId(db, TRANSITION.purchase)]);
  return journalItems(db, period).flatMap((l) => {
    if (l.is_closing || l.is_tax_closing || l.is_tax_payment) return [];
    const move = l.tax_name && moves.get(l.move_id);
    const documentSide = ['out_invoice', 'out_refund'].includes(move?.move_type) ? 'sale' : ['in_invoice', 'in_refund'].includes(move?.move_type) ? 'purchase' : null;
    const sale = accounts.sale.has(l.account_id), purchase = accounts.purchase.has(l.account_id);
    // Untagged manual items on a shared tax account use their debit/credit direction.
    const manualSide = sale && purchase ? (l.balance < 0 ? 'sale' : 'purchase') : sale ? 'sale' : purchase ? 'purchase' : null;
    const side = l.tax_side || (!transitions.has(l.account_id) && documentSide) || manualSide;
    if (!side) return [];
    const balance = (Number(l.debit) || 0) - (Number(l.credit) || 0);
    return [{ ...l, side, tax: l.tax_zero ? 0 : side === 'sale' ? -balance : balance }];
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

  // The tax report itself is ledger-based. Independently recompute invoice tax from the stored source lines,
  // then compare each tax/account group with its posted journal items (including refunds and currency rounding).
  // Cash-basis tax is booked to transition accounts on the invoice and enters the report on later payments.
  const invoices = search(db, 'account.move').filter((m) => m.state === 'posted'
    && ['out_invoice', 'out_refund', 'in_invoice', 'in_refund'].includes(m.move_type)
    && (m.company_id ?? 1) === (ret.company_id ?? 1) && moveDate(m) >= ret.date_from && moveDate(m) <= ret.date_to);
  for (const invoice of invoices) {
    const purchase = ['in_invoice', 'in_refund'].includes(invoice.move_type);
    const refund = ['out_refund', 'in_refund'].includes(invoice.move_type);
    const sign = (purchase ? 1 : -1) * (refund ? -1 : 1);
    const fallback = accountId(db, purchase ? '131000' : '251000');
    const ownCurrency = companyCurrency(db, invoice.company_id)
      ?? (db.records['res.currency'] ?? []).find((currency) => currency.name === db.settings?.currency)?.id ?? null;
    // Older foreign invoices did not save their posting rate. Their original currency amounts still provide an
    // independent control, without recalculating company values using a subsequently edited exchange rate.
    const legacyForeign = !(Number(invoice.tax_rate_at_posting) > 0) && invoice.currency_id && invoice.currency_id !== ownCurrency;
    const rate = legacyForeign ? 1 : Number(invoice.tax_rate_at_posting) > 0
      ? Number(invoice.tax_rate_at_posting) : rateAt(db, invoice.currency_id, invoice.invoice_date ?? today(), invoice.company_id);
    const expected = taxGroups((invoice.invoice_line_ids ?? []).filter((line) => !line.tax_cash_basis),
      (line) => line.tax_account_id || fallback, rate);
    const sums = new Map();
    const add = (account, name, amount) => {
      const key = JSON.stringify([account, name]);
      sums.set(key, (sums.get(key) ?? 0) + amount);
    };
    for (const group of expected) if (taxAccountIds.has(group.account_id)) add(group.account_id, group.tax_name, sign * group.amount);
    for (const line of invoice.line_ids ?? []) if (taxAccountIds.has(line.account_id)) {
      const postedAmount = legacyForeign ? Number(line.amount_currency) || 0 : (Number(line.debit) || 0) - (Number(line.credit) || 0);
      add(line.account_id, line.tax_name, -postedAmount);
    }
    if ([...sums.values()].some((amount) => Math.abs(round(amount)) > 0.005)) {
      throw new Error(`Unbalanced tax account: invoice ${invoice.name} tax differs from its journal items`);
    }
  }

  return taxReport(db, { from: ret.date_from, to: ret.date_to, company_id: ret.company_id });
}


/** Construct and post only the validated closing of a reviewed return, never a caller-supplied journal entry. */
export function postTaxReturnClosing(db, returnId) {
  const ret = read(db, 'account.return', returnId);
  if (!ret || ret.state !== 'reviewed') throw new Error('A reviewed tax return is required for closing');
  const type = read(db, 'account.return.type', ret.type_id);
  if (!type || (type.company_id ?? 1) !== (ret.company_id ?? 1)) throw new Error('Invalid tax return type or company');
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
    const account = read(db, 'account.account', id)?.code;
    lines.push(balance > 0 ? { account, credit: balance } : { account, debit: -balance });
    netClosed = round(netClosed - balance);
  }
  if (round(netClosed - report.payable)) throw new Error('Unbalanced tax account: ledger balance does not match tax report');
  const payable = (type.tax_payable_account_id && read(db, 'account.account', type.tax_payable_account_id)?.code) || '251000';
  const receivable = (type.tax_receivable_account_id && read(db, 'account.account', type.tax_receivable_account_id)?.code) || '131000';
  const partner = type.payment_partner_id || ret.payment_partner_id;
  if (report.payable > 0) lines.push({ account: payable, credit: report.payable, partner_id: partner });
  else if (report.payable < 0) lines.push({ account: receivable, debit: -report.payable, partner_id: partner });
  if (!lines.length) lines.push({ account: payable, debit: 0, credit: 0 }, { account: receivable, debit: 0, credit: 0 });
  const ref = `Tax Closing: ${ret.name}`;
  const expected = lines.map((line) => {
    const net = round((line.debit ?? 0) - (line.credit ?? 0));
    return [accountId(db, line.account, ret.company_id), line.partner_id ?? null, Math.max(0, net), Math.max(0, -net)];
  });
  if (taxClosingAuthorization.has(db)) throw new Error('A tax closing is already in progress');
  const authorization = { returnId: ret.id, company: ret.company_id, date: ret.date_to, journal: journalId(db, 'MISC'), ref, lines: JSON.stringify(expected), payable: report.payable };
  taxClosingAuthorization.set(db, authorization);
  try {
    const entry = postEntry(db, { journal: 'MISC', date: ret.date_to, ref, lines, company: ret.company_id, is_tax_closing: true, tax_return_id: ret.id });
    const proof = {};
    taxClosingProofDetails.set(proof, { ...authorization, moveId: entry.id });
    taxClosingProofByLines.set(entry.db.records['account.move'].find((move) => move.id === entry.id).line_ids, proof);
    return { ...entry, payable: report.payable };
  } finally {
    taxClosingAuthorization.delete(db);
  }
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
    const key = `${l.side}|${name}`;
    const row = rows.get(key) ?? { side: l.side, name, base: 0, tax: 0 };
    rows.set(key, { ...row, base: round(row.base + (l.tax ? Math.sign(l.tax) : 1) * (Number(l.tax_base) || 0)), tax: round(row.tax + l.tax) });
  }
  return [...rows.values()].sort((a, b) => a.side.localeCompare(b.side) || a.name.localeCompare(b.name));
}

/** Aged receivable/payable per partner, bucketed by days past due. */
export function agedBalance(db, kind = 'receivable', at = today()) {
  const type = kind === 'receivable' ? 'out_invoice' : 'in_invoice';
  const rows = new Map();
  for (const m of search(db, 'account.move').filter((x) => x.state === 'posted' && x.move_type === type && x.amount_residual > 0)) {
    const days = Math.floor((new Date(at) - new Date(m.invoice_date_due ?? m.invoice_date)) / 864e5);
    const bucket = BUCKETS.find(([, , from, to]) => days >= from && days <= to)[0];
    const row = rows.get(m.partner_id) ?? { partner_id: m.partner_id, total: 0, ...Object.fromEntries(BUCKETS.map(([k]) => [k, 0])) };
    row[bucket] = round(row[bucket] + m.amount_residual);
    row.total = round(row.total + m.amount_residual);
    rows.set(m.partner_id, row);
  }
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
      const toCheck = j.type === 'bank' ? search(db, 'account.bank.statement.line').filter((l) => l.state === 'to_check') : [];
      return { journal: j, kind: j.type, balance, unratedCount: unratedCount(db, [...balances, ...toCheck], at), toReconcile: toCheck.length, toReconcileAmount: companySum(db, toCheck, 'amount', at) };
    }
    return { journal: j, kind: 'general', entries: own.filter((m) => m.state === 'posted').length, draft: own.filter((m) => m.state === 'draft').length };
  });
}

/** Partners with overdue invoices, for payment reminders. */
export function followUps(db, at = today()) {
  const overdue = search(db, 'account.move').filter((m) => m.state === 'posted' && m.move_type === 'out_invoice' && m.amount_residual > 0 && m.invoice_date_due < at);
  const by = new Map();
  for (const m of overdue) (by.get(m.partner_id) ?? by.set(m.partner_id, []).get(m.partner_id)).push(m);
  return [...by].map(([partner_id, invoices]) => ({ partner_id, invoices, total: round(invoices.reduce((s, m) => s + m.amount_residual, 0)), oldest: invoices.map((m) => m.invoice_date_due).sort()[0] }));
}

/**
 * Automatic reminders: for each overdue customer, the highest follow-up level reached by its oldest overdue
 * invoice is logged on the contact once (the contact remembers the last level sent).
 */
export function runFollowUps(db, at = today()) {
  const levels = search(db, 'account.followup.level').sort((a, b) => (Number(a.delay) || 0) - (Number(b.delay) || 0));
  if (!levels.length) return db;
  const overdue = followUps(db, at);
  // Customers who caught up start again from the first level next time.
  const late = new Set(overdue.map((f) => f.partner_id));
  const partners = new Map((db.records['res.partner'] ?? []).map((p) => [p.id, p]));
  const updates = new Map(search(db, 'res.partner').filter((p) => p.followup_level_delay != null && !late.has(p.id))
    .map((p) => [p.id, { followup_level_delay: null }]));
  // Notes and level changes are collected, then written in one batch so the job stays linear in the data.
  const notes = [];
  for (const f of overdue) {
    const days = Math.floor((new Date(at) - new Date(f.oldest)) / 864e5);
    const level = [...levels].reverse().find((l) => days >= (Number(l.delay) || 0));
    const partner = partners.get(f.partner_id);
    if (!level || !partner || (Number(partner.followup_level_delay) || -1) >= Number(level.delay)) continue;
    const list = f.invoices.map((m) => `${m.name} (${m.invoice_date_due}): ${round(m.amount_residual)}`).join('; ');
    notes.push(['res.partner', partner.id, `${level.name}: ${round(f.total)} overdue — ${list}. ${level.message ?? ''}`.trim()]);
    updates.set(partner.id, { followup_level_delay: Number(level.delay), followup_date: at });
  }
  return writeMany(postNotes(db, notes), 'res.partner', updates);
}

const currencyOf = (db, move) => read(db, 'res.currency', move.currency_id)?.name ?? db.settings?.currency ?? '';

/** Reminder text for one customer's overdue invoices, each amount with its currency. */
export const followUpText = (db, f) => f.invoices.map((m) => `${m.name} (${m.invoice_date_due}): ${round(m.amount_residual)} ${currencyOf(db, m)}`.trim()).join('\n');

/** Record a reminder sent by hand: a note on the contact, the date, and the follow-up level it reached. */
export function logManualFollowUp(db, partnerId, at = today()) {
  const f = followUps(db, at).find((x) => x.partner_id === partnerId);
  if (!f) throw new Error('This customer has no overdue invoices');
  const late = Math.floor((new Date(at) - new Date(f.oldest)) / 864e5);
  const level = search(db, 'account.followup.level').sort((a, b) => (Number(b.delay) || 0) - (Number(a.delay) || 0)).find((l) => late >= (Number(l.delay) || 0));
  const noted = postNote(db, 'res.partner', partnerId, `Payment reminder sent by email${level ? ` (${level.name})` : ''}:\n${followUpText(db, f)}`);
  const previous = read(db, 'res.partner', partnerId).followup_level_delay;
  return write(noted, 'res.partner', partnerId, { followup_date: at, ...(level && (previous == null || Number(level.delay) > Number(previous)) ? { followup_level_delay: Number(level.delay) } : {}) });
}

/** Actual amount per analytic account from posted invoice/bill lines (income positive, costs negative). */
export function analyticActuals(db, period = {}) {
  const totals = new Map();
  for (const m of search(db, 'account.move').filter((x) => x.state === 'posted' && x.move_type !== 'entry' && (!period.from || x.invoice_date >= period.from) && (!period.to || x.invoice_date <= period.to))) {
    const sign = m.move_type === 'in_invoice' ? -1 : 1;
    for (const l of m.invoice_line_ids ?? []) {
      if (!l.analytic_account_id) continue;
      const amount = (Number(l.qty) || 0) * (Number(l.price_unit) || 0) * (1 - (Number(l.discount) || 0) / 100);
      totals.set(l.analytic_account_id, round((totals.get(l.analytic_account_id) ?? 0) + sign * amount));
    }
  }
  return totals;
}

export const financeModels = {
  'account.followup.level': {
    label: 'Follow-up Levels',
    fields: {
      name: { type: 'char', label: 'Level', required: true },
      delay: { type: 'integer', label: 'Days Overdue' },
      message: { type: 'text', label: 'Message' },
    },
    defaults: () => ({ delay: 15 }),
    kanban: { title: 'name', lines: ['delay'] },
    list: ['delay', 'name'],
    form: { title: 'name', groups: [['delay'], []], tabs: [{ label: 'Message', fields: ['message'] }] },
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
