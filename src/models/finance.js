// Credit limits, lock date, audit trail, tax report, aged balances, follow-ups, analytic accounting and budgets.
import { postNote, postNotes, read, search, write, writeMany } from '../orm.js';
import { today } from './common.js';
import { accountId, isBalanced, journalItems } from './ledger.js';
import { toCompany } from './currency.js';
import { companySum } from './money.js';
import { round } from '../money.js';

const accountByCode = (db, code) => (db.records['account.account'] ?? []).find((a) => a.code === code);

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

const LOCKED_FIELDS = ['name', 'invoice_line_ids', 'line_ids', 'invoice_date', 'date', 'state', 'partner_id', 'currency_id', 'move_type', 'journal_id', 'company_id', 'fiscal_position_id', 'active'];
/** Paid status of a locked entry, which only payments dated after the lock may move. */
const SETTLEMENT_FIELDS = ['amount_paid', 'payments', 'payment_date'];
const moveDate = (m) => m?.invoice_date ?? m?.date ?? today();
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

/** A reconciled bank transaction points at this entry: it has to stay posted and in place. */
const bookedByBank = (db, id) => (db.records['account.bank.statement.line'] ?? []).some((l) => l.state === 'reconciled' && l.move_id === id);

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
const POSTED_FIELDS = ['name', 'line_ids', 'invoice_line_ids', 'partner_id', 'currency_id', 'move_type', 'journal_id', 'invoice_date', 'invoice_date_due', 'date', 'company_id', 'fiscal_position_id', 'active'];

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

const settlementAccounts = (db) => [accountId(db, '121000'), accountId(db, '211000')];
/** Whether invoice `inv` is settled by the credit (customer invoice, vendor refund) or the debit side of its partner's balance. */
const settledByCredit = (inv) => !['in_invoice', 'out_refund'].includes(inv.move_type);
/** In company currency; the lower of face value and the invoice-date rate, as payments from the payment form apply at face value. */
const appliedValue = (db, inv, p) => Math.min(Number(p.amount) || 0, toCompany(db, inv.currency_id, p.amount, inv.invoice_date ?? p.date, inv.company_id));

/** What a payment or discount entry can settle for `inv`: its partner's receivable/payable on the settling side. */
function settlementCapacity(db, entry, inv) {
  if (!entry || entry.state !== 'posted' || entry.id === inv.id || (entry.company_id ?? 1) !== (inv.company_id ?? 1)) return 0;
  // A credit note and its original invoice settle each other through their opposite receivable/payable lines.
  const creditPair = (note, original) => note.reversed_entry_id === original.id
    && note.move_type === (original.move_type === 'out_invoice' ? 'out_refund' : original.move_type === 'in_invoice' ? 'in_refund' : null)
    && note.partner_id === original.partner_id && (note.currency_id ?? null) === (original.currency_id ?? null);
  if (entry.move_type !== 'entry' && !creditPair(entry, inv) && !creditPair(inv, entry)) return 0;
  const accounts = settlementAccounts(db);
  return round((entry.line_ids ?? []).filter((l) => l.partner_id === inv.partner_id && accounts.includes(l.account_id))
    .reduce((s, l) => s + (Number(settledByCredit(inv) ? l.credit : l.debit) || 0), 0));
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
  const accounts = settlementAccounts(db);
  if (after.partner_id && !(entry.line_ids ?? []).some((l) => l.partner_id === after.partner_id && accounts.includes(l.account_id))) return 'The journal entry does not belong to this payment';
  if ((db.records['account.payment'] ?? []).some((p) => p.id !== after.id && p.state === 'posted' && p.move_id === entry.id)) return 'The journal entry already records another payment';
  return null;
}

/** Whether a fiscal year names this entry as its closing or reopening entry. */
const isYearEntry = (db, id) => (db.records?.['account.fiscal.year'] ?? []).some((y) => y.closing_move_id === id || y.opening_move_id === id);

/** A closed fiscal year locks its period whoever closed it. */
export function closedYearLock(db) {
  return (db.records?.['account.fiscal.year'] ?? []).filter((y) => y.state === 'closed').map((y) => y.date_to).sort().at(-1) ?? '';
}

export function moveGuard(db, before, after) {
  return lockRule(db, before, after) ?? accountsError(db, before, after) ?? postedMoveRule(before, after);
}


function lockRule(db, before, after) {
  if (before?.state === 'posted' && after.state !== 'posted' && bookedByBank(db, before.id)) return 'This entry is matched with a reconciled bank transaction and has to stay posted';
  if (db.settings?.audit_trail && before?.state === 'posted' && before.name !== after.name) return 'Posted entries keep their number while the audit trail is active';
  // The closing flag takes an entry out of the P&L, so only fiscal-year closing sets it, and nothing clears it.
  if (!!after.is_closing !== !!before?.is_closing && (before?.is_closing || !isYearEntry(db, after.id))) return 'Only fiscal year closing marks closing entries';
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
  if (bookedByBank(db, move.id)) return 'This entry is matched with a reconciled bank transaction and cannot be deleted';
  const lock = [lockDateFor(db.settings, move), closedYearLock(db)].sort().at(-1);
  if (lock && moveDate(move) <= lock) return `The period up to ${lock} is locked`;
  if (db.settings?.audit_trail && move.name && move.name !== '/') return 'Numbered entries cannot be deleted while the audit trail is active; cancel them instead';
  if (move.state === 'posted') return 'Posted entries cannot be deleted; reset them to draft first';
  if (backsSettlement(db, move.id)) return 'This entry records a payment; reverse the payment instead';
  return null;
}

/** Tax accounts per side: the default VAT accounts plus every account a sale / purchase tax books to. */
function taxAccounts(db) {
  const of = (use, code) => new Set([accountByCode(db, code)?.id, ...search(db, 'account.tax').filter((x) => x.type_tax_use === use).map((x) => x.account_id)].filter(Boolean));
  return { sale: of('sale', '251000'), purchase: of('purchase', '131000') };
}

/** Posted journal items on tax accounts in the period, with their side and signed tax (output credit / input debit positive). */
function taxItems(db, period) {
  const accounts = taxAccounts(db);
  return journalItems(db, period).flatMap((l) => {
    const side = accounts.sale.has(l.account_id) ? 'sale' : accounts.purchase.has(l.account_id) ? 'purchase' : null;
    if (!side) return [];
    const balance = (Number(l.debit) || 0) - (Number(l.credit) || 0);
    return [{ ...l, side, tax: side === 'sale' ? -balance : balance }];
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
    rows.set(key, { ...row, base: round(row.base + Math.sign(l.tax) * (Number(l.tax_base) || 0)), tax: round(row.tax + l.tax) });
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
  const items = journalItems(db);
  // Draft invoices get their journal on posting, so they count on the default INV/BILL journal meanwhile.
  const draftJournal = (m) => (m.move_type === 'entry' ? null : ['in_invoice', 'in_refund'].includes(m.move_type) ? 'BILL' : 'INV');
  return search(db, 'account.journal').map((j) => {
    const own = moves.filter((m) => m.journal_id === j.id || (m.state === 'draft' && !m.journal_id && draftJournal(m) === j.code));
    if (['sale', 'purchase'].includes(j.type)) {
      const unpaid = own.filter((m) => m.state === 'posted' && m.amount_residual > 0);
      return {
        journal: j, kind: j.type, draft: own.filter((m) => m.state === 'draft').length, unpaid: unpaid.length,
        unpaidAmount: companySum(db, unpaid, 'amount_residual'), late: unpaid.filter((m) => m.invoice_date_due < at).length,
      };
    }
    if (['bank', 'cash'].includes(j.type)) {
      const balance = round(items.filter((l) => l.account_id === j.default_account_id).reduce((s, l) => s + (Number(l.debit) || 0) - (Number(l.credit) || 0), 0));
      const toCheck = j.type === 'bank' ? search(db, 'account.bank.statement.line').filter((l) => l.state === 'to_check') : [];
      return { journal: j, kind: j.type, balance, toReconcile: toCheck.length, toReconcileAmount: round(toCheck.reduce((s, l) => s + (Number(l.amount) || 0), 0)) };
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
  return write(noted, 'res.partner', partnerId, { followup_date: at, ...(level ? { followup_level_delay: Number(level.delay) } : {}) });
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
