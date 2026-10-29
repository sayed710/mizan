import { create, postNote, read, search, write } from '../orm.js';
import { amounts, nextName, productLines, promptedAmount, subtotal, today } from './common.js';
import { ACCOUNT_TYPES, accountId, badLineSign, invoiceLines, isBalanced, journalId, paymentJournal, postEntry } from './ledger.js';
import { accountDeleteGuard, lockedSettlementInvariant, moveDeleteGuard, moveGuard, moveInvariant } from './finance.js';
import { rateAt, toCompany } from './currency.js';
import { TRANSITION, cashBasisTaxes, fiscalPositionFor } from './taxes.js';
import { dueDate, earlyDiscount } from './terms.js';
import { syncInvoicedQty } from './sales.js';
import { checkMandatoryPlans, defaultDistributionForLine, distributionOfLine, postAnalytic, removeAnalytic } from './analyticplus.js';
import { checkBillMatch, priceDifferenceLines } from './billcontrol.js';
import { round as round2 } from '../money.js';
import { resolveAndValidateRecipientBank } from './partnerbank.js';

const isInvoice = (r) => r.move_type !== 'entry';
const isRefund = (r) => ['out_refund', 'in_refund'].includes(r.move_type);
export const isPurchase = (r) => ['in_invoice', 'in_refund'].includes(r.move_type);
/** Money comes in for customer invoices and vendor refunds, goes out for bills and credit notes. */
export const isInbound = (r) => ['out_invoice', 'in_refund'].includes(r.move_type);
const total = (r) => {
  if (!isInvoice(r)) return (r.line_ids ?? []).reduce((s, l) => s + (Number(l.debit) || 0), 0);
  const base = amounts(r.invoice_line_ids).total;
  if (r.invoice_cash_rounding_id && r.state === 'posted') {
    const main = (r.line_ids ?? []).find((l) => l.name === r.name);
    if (main) return main.amount_currency ? Math.abs(main.amount_currency) : Number(main.debit || main.credit) || base;
  }
  return base;
};
const residual = (r) => (isInvoice(r) ? Math.max(0, Math.round((total(r) - (Number(r.amount_paid) || 0)) * 100) / 100) : 0);
const paymentState = (r) => {
  if (r.state !== 'posted' || !isInvoice(r)) return 'not_paid';
  if (residual(r) === 0) return 'paid';
  return (Number(r.amount_paid) || 0) > 0 ? 'partial' : 'not_paid';
};
const money = (n) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const PREFIX = { out_invoice: 'INV', out_refund: 'RINV', in_invoice: 'BILL', in_refund: 'RBILL', entry: 'MISC' };

/** Ids of the entries that settle invoices (payments and early-payment discounts). */
const settlingEntries = (db) => new Set((db.records['account.move'] ?? []).flatMap((m) => (m.payments ?? []).map((p) => p.move_id)));

/**
 * The paid amount is the sum of the recorded payments and never above the total; a paid invoice and the
 * entries that pay it stay posted, so the books and the payment status cannot drift apart.
 */
export function paymentGuard(db, before, after) {
  if (after.correction_of_id && after.state !== 'cancel') {
    const note = read(db, 'account.move', after.correction_of_id);
    if (!note || note.state !== 'posted' || !isRefund(note) || after.move_type !== (note.move_type === 'out_refund' ? 'out_invoice' : 'in_invoice')
      || after.partner_id !== note.partner_id || after.company_id !== note.company_id || (after.currency_id ?? null) !== (note.currency_id ?? null)) return 'A correction must match its posted credit note';
    if ((db.records['account.move'] ?? []).some((m) => m.id !== after.id && m.correction_of_id === note.id && m.state !== 'cancel')) return 'This credit note already has a correction';
    if (after.state === 'posted' && round2(total(after)) !== round2(total(note))) return 'A correction must restore the full credit note amount';
  }
  if (after.state === 'posted' && isInvoice(after) && !(total(after) > 0)) return 'The total must be positive; use a credit note or refund instead';
  const leavesPosted = before?.state === 'posted' && after.state !== 'posted';
  if (leavesPosted && (Number(before.amount_paid) > 0)) return 'Paid invoices cannot be reset or cancelled; reverse the payment with a credit note instead';
  if (leavesPosted && settlingEntries(db).has(before.id)) return 'This entry settles an invoice payment and cannot be reset or cancelled';
  // The books of a settlement entry are fixed once an invoice records it as a payment.
  if (before?.state === 'posted' && settlingEntries(db).has(before.id)
    && ['line_ids', 'journal_id', 'partner_id'].some((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null))) {
    return 'This entry settles an invoice payment and cannot be changed';
  }
  const unchanged = before && JSON.stringify(before.payments ?? []) === JSON.stringify(after.payments ?? []) && Number(before.amount_paid || 0) === Number(after.amount_paid || 0);
  // Older data is left alone while its payments are untouched, unless the total moved below what was paid.
  if (unchanged) {
    const reduced = isInvoice(after) && round2(total(after)) !== round2(total(before)) && (Number(after.amount_paid) || 0) > round2(total(after)) + 0.005;
    return reduced ? 'The paid amount cannot exceed the invoice total' : null;
  }
  const payments = after.payments ?? [];
  if (!Array.isArray(payments) || payments.some((p) => !p || !(Number(p.amount) > 0))) return 'Invalid payments';
  const paid = Number(after.amount_paid) || 0;
  if (round2(payments.filter((p) => !p.reversed).reduce((s, p) => s + Number(p.amount), 0)) !== round2(paid)) return 'The paid amount must equal the recorded payments';
  if (isInvoice(after) && paid > 0 && paid > round2(total(after)) + 0.005) return 'The paid amount cannot exceed the invoice total';
  // A recorded payment keeps pointing at its posted settlement entry (so that entry stays protected); new ones must name one.
  const old = before?.payments ?? [];
  if (old.some((p, i) => p?.move_id && payments[i]?.move_id !== p.move_id)) return 'A recorded payment cannot be removed or re-linked';
  for (const [i, p] of payments.entries()) {
    const prior = old[i];
    if (prior?.reversed && (!p.reversed || p.reversal_move_id !== prior.reversal_move_id)) return 'A reversed payment cannot be restored';
    if (prior && Object.keys(prior).some((k) => !['reversed', 'reversal_move_id'].includes(k) && JSON.stringify(p[k]) !== JSON.stringify(prior[k]))) return 'A recorded payment cannot be changed';
    if (p.reversed) {
      const original = read(db, 'account.move', p.move_id);
      const reversal = read(db, 'account.move', p.reversal_move_id);
      if (!original || reversal?.state !== 'posted' || reversal.reversed_entry_id !== original.id
        || JSON.stringify((original.line_ids ?? []).map((l) => [l.account_id, l.partner_id, l.debit || 0, l.credit || 0]))
        !== JSON.stringify((reversal.line_ids ?? []).map((l) => [l.account_id, l.partner_id, l.credit || 0, l.debit || 0]))) return 'A reversed payment needs a posted reversing journal entry';
    }
  }
  const bad = payments.slice(old.length).find((p) => read(db, 'account.move', p.move_id)?.state !== 'posted');
  if (bad) return 'A payment must point at a posted journal entry';
  return null;
}

/** Post a draft move: invoices get their journal items generated; manual entries must balance. */
export function postMove(db, id) {
  const r = read(db, 'account.move', id);
  const year = (r.invoice_date ?? today()).slice(0, 4);
  const name = r.name && r.name !== '/' ? r.name : nextName(db, 'account.move', `${PREFIX[r.move_type]}/${year}/`);
  if (!isInvoice(r)) {
    if (badLineSign(r.line_ids)) throw new Error('Debits and credits cannot be negative');
    if (!isBalanced(r.line_ids)) throw new Error('Journal entry is not balanced: total debit must equal total credit');
    return write(db, 'account.move', id, { state: 'posted', name });
  }
  if (!r.partner_id) throw new Error('Partner is required');
  if (!(r.invoice_line_ids ?? []).length) throw new Error('Add at least one invoice line');
  if (!(total(r) > 0)) throw new Error('The total must be positive; use a credit note or refund instead');
  checkMandatoryPlans(db, r);
  // Vendor bills are matched against the PO and receipts; price differences leave the interim account.
  checkBillMatch(db, r);
  const resolvedLines = (r.invoice_line_ids ?? []).map((line) => {
    if (line.analytic_distribution && Object.keys(line.analytic_distribution).length > 0) return line;
    const dist = distributionOfLine(line, db, r);
    return Object.keys(dist).length ? { ...line, analytic_distribution: dist } : line;
  });
  const updatedR = { ...r, invoice_line_ids: resolvedLines };
  const journal = journalId(db, isPurchase(r) ? 'BILL' : 'INV');
  const line_ids = [...invoiceLines(db, { ...updatedR, name }), ...priceDifferenceLines(db, { ...updatedR, name })];
  if (isRefund(r) && r.reversed_entry_id) creditCheck(db, r);
  const posted = postAnalytic(write(db, 'account.move', id, { state: 'posted', name, journal_id: journal, line_ids, invoice_line_ids: resolvedLines,
    tax_rate_at_posting: rateAt(db, r.currency_id, r.invoice_date ?? today(), r.company_id) }), id);
  if (isRefund(r) && r.reversed_entry_id) return offsetCreditNote(posted, id);
  return r.move_type === 'in_invoice' ? draftAssetsFromBill(posted, { ...updatedR, name }) : posted;
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
  if (!(total(note) > 0)) throw new Error('A credit note must have a positive total');
  const credited = creditNotesOf(db, invoice.id, note.id).filter((m) => m.state === 'posted').reduce((s, m) => s + total(m), 0);
  if (round2(credited + total(note)) > round2(total(invoice))) throw new Error(`Credit notes would exceed ${invoice.name}: ${money(round2(total(invoice) - credited))} is left to credit`);
}

/**
 * A posted credit note settles what is still due on its invoice: both record the other in their payments and paid
 * amount, as a reconciliation would. Their receivable/payable lines already offset in the ledger.
 */
function offsetCreditNote(db, noteId) {
  const note = read(db, 'account.move', noteId);
  const invoice = read(db, 'account.move', note.reversed_entry_id);
  const value = Math.min(total(note), residual(invoice));
  if (!(value > 0)) return db;
  const date = note.invoice_date ?? today();
  const settle = (next, r, other) => write(next, 'account.move', r.id, {
    amount_paid: round2((Number(r.amount_paid) || 0) + value), payment_date: date, payments: [...(r.payments ?? []), { date, amount: value, move_id: other.id }],
  });
  let next = settle(settle(db, invoice, note), note, invoice);
  // Each document booked the amount at its own date's rate: the company-currency gap is an exchange difference.
  const sale = !isPurchase(invoice);
  const bookedPortion = (r) => {
    const account = accountId(db, isPurchase(r) ? '211000' : '121000');
    const booked = Math.abs((r.line_ids ?? []).filter((l) => l.account_id === account && l.partner_id === r.partner_id)
      .reduce((s, l) => s + Number(l.debit || 0) - Number(l.credit || 0), 0));
    const paid = Number(r.amount_paid) || 0;
    return round2(booked * (paid + value) / total(r)) - round2(booked * paid / total(r));
  };
  const gap = round2(bookedPortion(invoice) - bookedPortion(note));
  if (gap) {
    const account = sale ? '121000' : '211000';
    const amount = Math.abs(gap);
    // The receivable/payable balance left by the two rates is cleared against the exchange gain or loss.
    const clearsDebit = sale ? gap < 0 : gap > 0;
    const open = clearsDebit ? { account, debit: amount, partner_id: invoice.partner_id } : { account, credit: amount, partner_id: invoice.partner_id };
    const fxLine = clearsDebit ? { account: '450100', credit: amount } : { account: '690100', debit: amount };
    next = postEntry(next, { journal: 'MISC', date, ref: `Exchange difference ${note.name}`, lines: [open, fxLine] }).db;
  }
  return postNote(next, 'account.move', invoice.id, `${money(value)} settled by credit note ${note.name}`);
}

/** Bill lines booked on a fixed-asset account become draft assets (once per bill line). */
function draftAssetsFromBill(db, bill) {
  const fixed = new Set((db.records['account.account'] ?? []).filter((a) => a.account_type === 'asset_fixed').map((a) => a.id));
  const already = new Set((db.records['account.asset'] ?? []).filter((a) => a.bill_id === bill.id).map((a) => a.bill_line));
  return (bill.invoice_line_ids ?? []).reduce((acc, l, i) => {
    if (!fixed.has(l.account_id) || already.has(i)) return acc;
    const product = read(acc, 'product', l.product_id);
    return create(acc, 'account.asset', {
      name: l.name || product?.name || bill.name, original_value: Math.round(subtotal(l) * 100) / 100, acquisition_date: bill.invoice_date ?? today(),
      partner_id: bill.partner_id, bill_id: bill.id, bill_line: i,
    }).db;
  }, db);
}

/**
 * Record a payment: bank entry against receivable/payable, paid amount on the invoice, and a posted
 * payment record (or `paymentId`, an existing draft payment, gets posted with that entry).
 */
export function payMove(db, id, amount, date = today(), { paymentId, journalId: payJournal, statementLineId } = {}) {
  const r = read(db, 'account.move', id);
  if (r?.state !== 'posted' || !isInvoice(r)) throw new Error('Only posted invoices and bills can be paid');
  const value = Math.min(amount, residual(r));
  if (!(value > 0)) return db;
  const payRec = paymentId ? read(db, 'account.payment', paymentId) : null;
  if (paymentId && (!payRec || payRec.partner_id !== r.partner_id || payRec.payment_type !== (isInbound(r) ? 'inbound' : 'outbound') || payRec.partner_type !== (isPurchase(r) ? 'supplier' : 'customer'))) {
    throw new Error('Payment must match the invoice partner and direction');
  }
  // Matching an existing bank statement records money already sent, rather than authorizing a new payout.
  const statement = statementLineId ? read(db, 'account.bank.statement.line', statementLineId) : null;
  if (statementLineId && (!statement || statement.state !== 'to_check' || statement.amount >= 0 || isInbound(r)
    || round2(Math.abs(Number(statement.amount))) !== round2(Number(amount)) || (statement.date ?? today()) !== date)) {
    throw new Error('Invalid bank statement settlement');
  }
  let recipientBankId = null;
  if (isPurchase(r) && !isInbound(r) && !statement) {
    recipientBankId = resolveAndValidateRecipientBank(db, r.partner_id, payRec?.partner_bank_id, { invoiceBankId: r.partner_bank_id });
    if (!r.partner_bank_id) db = write(db, 'account.move', r.id, { partner_bank_id: recipientBankId });
  }
  // Anything paid above the amount due stays on the partner's account as an outstanding credit.
  const excess = Math.round((amount - value) * 100) / 100;
  const sale = isInbound(r);
  const counterpartCode = isPurchase(r) ? '211000' : '121000';
  const via = paymentJournal(db, payJournal);
  // Bank moves at today's rate, the receivable/payable at the invoice rate; the gap is an exchange difference.
  // ponytail: partial foreign payments can leave a cent of company-currency rounding on the receivable.
  const bank = toCompany(db, r.currency_id, value, date, r.company_id);
  // The last payment clears exactly what is left on the receivable/payable, so no cent stays behind.
  const final = value >= residual(r);
  const open = final ? openBalance(db, r) : toCompany(db, r.currency_id, value, r.invoice_date ?? date, r.company_id);
  const diff = Math.round((sale ? bank - open : open - bank) * 100) / 100;
  const fx = diff > 0 ? [{ account: '450100', credit: diff }] : diff < 0 ? [{ account: '690100', debit: -diff }] : [];
  // The bank line converts what was really received once; the credit is whatever remains after the settled part.
  const extra = excess > 0 ? Math.round((toCompany(db, r.currency_id, value + excess, date, r.company_id) - bank) * 100) / 100 : 0;
  const credit = extra ? [sale ? { account: counterpartCode, credit: extra, partner_id: r.partner_id, name: 'Outstanding credit' } : { account: counterpartCode, debit: extra, partner_id: r.partner_id, name: 'Outstanding credit' }] : [];
  const { db: withEntry, id: paymentMove } = postEntry(db, {
    journal: via.code, date, ref: `Payment ${r.name}`,
    lines: sale
      ? [{ account: via.account, debit: bank + extra, partner_id: r.partner_id }, { account: counterpartCode, credit: open, partner_id: r.partner_id }, ...credit, ...fx]
      : [{ account: counterpartCode, debit: open, partner_id: r.partner_id }, ...credit, { account: via.account, credit: bank + extra, partner_id: r.partner_id }, ...fx],
  });
  const record = { state: 'posted', move_id: paymentMove, journal_id: journalId(db, via.code), invoice_id: r.id, partner_id: r.partner_id, amount: Math.round((value + excess) * 100) / 100, unapplied: extra, date, payment_type: sale ? 'inbound' : 'outbound', partner_type: isPurchase(r) ? 'supplier' : 'customer', memo: r.name, ...(recipientBankId ? { partner_bank_id: recipientBankId } : {}) };
  const draftName = paymentId ? read(withEntry, 'account.payment', paymentId)?.name : null;
  const name = draftName && draftName !== '/' ? draftName : nextName(withEntry, 'account.payment', `P${via.code}/${date.slice(0, 4)}/`);
  const withPayment = paymentId
    ? write(withEntry, 'account.payment', paymentId, { ...record, name })
    : create(withEntry, 'account.payment', { ...record, name }).db;
  const payments = [...(r.payments ?? []), { date, amount: value, move_id: paymentMove, company_amount: open }];
  const next = write(releaseCashBasis(withPayment, r, value / total(r), date, { final }), 'account.move', id, { amount_paid: round2((Number(r.amount_paid) || 0) + value), payment_date: date, payments });
  const noted = postNote(next, 'account.move', id, `Payment of ${money(value)} registered`);
  return excess > 0 ? postNote(noted, 'account.move', id, `${money(excess)} paid above the amount due kept as an outstanding credit`) : noted;
}

/** What the invoice still has on its receivable/payable in company currency: its posted line minus the payments so far. */
function openBalance(db, r) {
  const account = accountId(db, isPurchase(r) ? '211000' : '121000');
  const booked = (r.line_ids ?? []).filter((l) => l.account_id === account).reduce((s, l) => s + (Number(l.debit) || 0) + (Number(l.credit) || 0), 0);
  const paid = (r.payments ?? []).filter((p) => !p.reversed).reduce((s, p) => s + (p.company_amount ?? toCompany(db, r.currency_id, p.amount, r.invoice_date ?? p.date, r.company_id)), 0);
  return round2(booked - paid);
}

/** Tax already released for an invoice, per tax account code. */
const releasedTaxes = (db, r) => {
  const released = new Map();
  for (const m of db.records['account.move'] ?? []) {
    if (m.ref !== `Cash basis taxes ${r.name}` || m.state !== 'posted') continue;
    for (const l of m.line_ids ?? []) {
      const code = read(db, 'account.account', l.account_id)?.code;
      const key = `${code}:${l.tax_name ?? ''}`;
      const previous = released.get(key) ?? { amount: 0, base: 0 };
      released.set(key, { amount: previous.amount + ((!isPurchase(r) !== isRefund(r)) ? 1 : -1) * ((Number(l.credit) || 0) - (Number(l.debit) || 0)), base: previous.base + (Number(l.tax_base) || 0) });
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
  const groups = cashBasisTaxes(r.invoice_line_ids, rateAt(db, r.currency_id, r.invoice_date ?? date, r.company_id))
    .map((g) => ({ ...g, account: read(db, 'account.account', g.account_id)?.code ?? (sale ? '251000' : '131000') }));
  const due = groups.map((g) => {
    const accountTotal = groups.filter((x) => x.account === g.account).reduce((s, x) => s + x.amount, 0);
    // Older releases were not tagged; allocate their account total across its taxes.
    const tagged = final ? released.get(`${g.account}:${g.tax_name}`) : null;
    const legacy = final ? released.get(`${g.account}:`) : null;
    const prior = (tagged?.amount ?? 0) + (legacy?.amount ?? 0) * g.amount / accountTotal;
    const priorBase = (tagged?.base ?? 0) + (legacy?.base ?? 0) * g.amount / accountTotal;
    return { ...g, amount: round2(final ? g.amount - prior : g.amount * Math.abs(share)), base: round2(final ? g.base - priorBase : g.base * share) };
  })
    .filter((g) => g.amount > 0);
  if (!due.length) return db;
  const transition = TRANSITION[sale ? 'sale' : 'purchase'];
  // The released tax lands on the tax account tagged with its tax and base, so the return counts it when paid.
  const lines = due.flatMap(({ account, amount, base, tax_name }) => {
    const tax = { account, partner_id: r.partner_id, name: tax_name, tax_name, tax_base: base, tax_side: sale ? 'sale' : 'purchase' };
    return (sale !== refund) === (share > 0)
      ? [{ account: transition, debit: amount, partner_id: r.partner_id }, { ...tax, credit: amount }]
      : [{ ...tax, debit: amount }, { account: transition, credit: amount, partner_id: r.partner_id }];
  });
  return postEntry(db, { journal: 'MISC', date, ref: `Cash basis taxes ${r.name}`, lines }).db;
}

/** Draft credit note (customer) or refund (vendor) reversing a posted invoice or bill, while some of it is left to credit. */
export function creditNote(db, r) {
  const purchase = isPurchase(r);
  const credited = creditNotesOf(db, r.id).reduce((s, m) => s + total(m), 0);
  if (round2(credited) >= round2(total(r))) throw new Error(`${r.name} is already fully credited`);
  const { db: next, id } = create(db, 'account.move', {
    move_type: purchase ? 'in_refund' : 'out_refund', partner_id: r.partner_id, invoice_origin: r.name, invoice_date: today(), invoice_date_due: today(), reversed_entry_id: r.id,
    invoice_line_ids: r.invoice_line_ids.map((l) => ({ ...l })), ref: `Reversal of ${r.name}`, currency_id: r.currency_id ?? null, fiscal_position_id: r.fiscal_position_id ?? null,
  });
  return { db: next, go: `#/accounting/${purchase ? 'refunds' : 'credit-notes'}/${id}` };
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
  return term && !(Number(r.amount_paid) > 0) ? earlyDiscount(term, total(r), r.invoice_date, date) : 0;
}

/** Pay `amount`; when it settles the invoice net of an early-payment discount, book the discount too. */
export function payWithDiscount(db, id, amount, date = today()) {
  const r = read(db, 'account.move', id);
  const due = residual(r);
  const paid = payMove(db, id, amount, date);
  const gap = Math.round((due - amount) * 100) / 100;
  const discount = Math.min(discountAvailable(db, r, date), gap);
  if (!(gap > 0) || discount < gap - 0.005) return paid;
  const sale = isInbound(r);
  const value = toCompany(db, r.currency_id, discount, r.invoice_date ?? date, r.company_id);
  const { db: booked, id: discountMove } = postEntry(paid, {
    journal: 'MISC', date, ref: `Early payment discount ${r.name}`,
    lines: sale
      ? [{ account: '690200', debit: value, partner_id: r.partner_id }, { account: '121000', credit: value, partner_id: r.partner_id }]
      : [{ account: '211000', debit: value, partner_id: r.partner_id }, { account: '450200', credit: value, partner_id: r.partner_id }],
  });
  const after = read(booked, 'account.move', id);
  // Recorded like a payment (dated, pointing at its entry), so locked-period checks can verify it.
  const paymentMove = after.payments.at(-1).move_id;
  const payments = [...(after.payments ?? []), { date, amount: discount, move_id: discountMove, payment_move_id: paymentMove, discount: true }];
  return postNote(write(booked, 'account.move', id, { amount_paid: round2((Number(after.amount_paid) || 0) + discount), payment_date: date, payments }), 'account.move', id, `Early payment discount of ${money(discount)} applied`);
}

function registerPayment(db, r) {
  const due = Math.round((residual(r) - discountAvailable(db, r)) * 100) / 100;
  const amount = promptedAmount(prompt(`Payment amount (due ${money(due)})`, String(due)));
  if (amount == null) return { db };
  return { db: payWithDiscount(db, r.id, amount) };
}

const termDue = (db, r) => {
  const term = read(db, 'account.payment.term', r.invoice_payment_term_id);
  return term && r.invoice_date ? { invoice_date_due: dueDate(term, r.invoice_date) } : {};
};

const invoiceLineBase = productLines('Invoice Lines', 'list_price');
const invoiceLineField = { ...invoiceLineBase, fields: { name: { type: 'char', label: 'Label' }, ...invoiceLineBase.fields, account_id: { type: 'many2one', relation: 'account.account', label: 'Account' } } };

const lineItem = {
  type: 'one2many',
  label: 'Journal Items',
  fields: {
    account_id: { type: 'many2one', relation: 'account.account', label: 'Account' },
    partner_id: { type: 'many2one', relation: 'res.partner', label: 'Partner' },
    name: { type: 'char', label: 'Label' },
    debit: { type: 'monetary', label: 'Debit' },
    credit: { type: 'monetary', label: 'Credit' },
    currency_id: { type: 'many2one', relation: 'res.currency', label: 'Currency' },
    amount_currency: { type: 'monetary', label: 'Amount in Currency' },
    // Tax lines name their tax and the base it was charged on (company currency) for the tax return.
    tax_name: { type: 'char', label: 'Tax', hidden: true },
    tax_base: { type: 'monetary', label: 'Tax Base', hidden: true },
    tax_zero: { type: 'boolean', label: 'Tax', hidden: true },
    tax_side: { type: 'selection', label: 'Tax', hidden: true, options: [['sale', 'Sales'], ['purchase', 'Purchases']] },
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
    },
    defaults: () => ({ account_type: 'expense' }),
    protectDelete: accountDeleteGuard,
    groupBys: ['account_type'],
    kanban: { title: 'name', lines: ['code', 'account_type'] },
    list: ['code', 'name', 'account_type'],
    views: ['list', 'kanban'],
    form: {
      title: 'name',
      groups: [['code', 'account_type'], ['reconcile']],
    },
  },

  'account.journal': {
    label: 'Journals',
    fields: {
      name: { type: 'char', label: 'Journal Name', required: true },
      code: { type: 'char', label: 'Short Code', required: true },
      type: { type: 'selection', label: 'Type', options: [['sale', 'Sales'], ['purchase', 'Purchase'], ['bank', 'Bank'], ['cash', 'Cash'], ['general', 'Miscellaneous']] },
      default_account_id: { type: 'many2one', relation: 'account.account', label: 'Default Account' },
    },
    defaults: () => ({ type: 'general' }),
    kanban: { title: 'name', lines: ['code', 'type'], counter: { label: 'Entries', model: 'account.move', field: 'journal_id' } },
    list: ['code', 'name', 'type', 'default_account_id'],
    form: {
      title: 'name',
      smart: [{ label: 'Entries', model: 'account.move', field: 'journal_id', target: 'accounting/entries' }],
      groups: [['code', 'type'], ['default_account_id']],
    },
  },

  'account.move': {
    label: 'Invoices',
    guard: (db, before, after, ctx) => moveGuard(db, before, after, ctx) ?? paymentGuard(db, before, after) ?? (after.state === 'posted' && badLineSign(after.line_ids) ? 'Debits and credits cannot be negative' : null),
    invariant: (db, after, before) => lockedSettlementInvariant(db, after, before) ?? moveInvariant(db, after, before),
    protectDelete: (db, m, staged) => moveDeleteGuard(db, m, staged) ?? settledByCreditNote(db, m) ?? (settlingEntries(db).has(m.id) || Number(m.amount_paid) > 0 ? 'Entries tied to a payment cannot be deleted' : null),
    audited: (db) => db.settings?.audit_trail === true,
    onUnlink: (db, r) => syncInvoicedQty(db, r),
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
          ? { invoice_line_ids: r.invoice_line_ids.map((line) => ({ ...line, analytic_distribution: defaultDistributionForLine(db, line, context) })) }
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
      journal_id: { type: 'many2one', relation: 'account.journal', label: 'Journal' },
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Partner' },
      partner_bank_id: { type: 'many2one', relation: 'res.partner.bank', label: 'Recipient Bank Account' },
      ref: { type: 'char', label: 'Reference' },
      date: { type: 'date', label: 'Accounting Date' },
      invoice_date: { type: 'date', label: 'Date' },
      invoice_date_due: { type: 'date', label: 'Due Date' },
      invoice_origin: { type: 'char', label: 'Source Document', readonly: true },
      payment_reference: { type: 'char', label: 'Payment Reference' },
      currency_id: { type: 'many2one', relation: 'res.currency', label: 'Currency' },
      tax_rate_at_posting: { type: 'float', label: 'Posting Exchange Rate', readonly: true, hidden: true },
      invoice_payment_term_id: { type: 'many2one', relation: 'account.payment.term', label: 'Payment Terms' },
      invoice_cash_rounding_id: { type: 'many2one', relation: 'account.cash.rounding', label: 'Cash Rounding' },
      fiscal_position_id: { type: 'many2one', relation: 'account.fiscal.position', label: 'Fiscal Position' },
      subscription_id: { type: 'many2one', relation: 'sale.subscription', label: 'Subscription', readonly: true },
      subscription_period: { type: 'date', label: 'Subscription Period', readonly: true },
      state: { type: 'selection', label: 'Status', tracking: true, options: [['draft', 'Draft'], ['posted', 'Posted'], ['cancel', 'Cancelled']] },
      invoice_line_ids: invoiceLineField,
      payments: {
        type: 'one2many', label: 'Payments', readonly: true,
        fields: { date: { type: 'date', label: 'Paid on' }, amount: { type: 'monetary', label: 'Amount' }, move_id: { type: 'many2one', relation: 'account.move', label: 'Payment' }, payment_move_id: { type: 'many2one', relation: 'account.move', label: 'Payment' }, company_amount: { type: 'monetary', label: 'Company Amount' }, line_index: { type: 'integer', label: 'Closing Line Index', hidden: true }, discount: { type: 'boolean', label: 'Early Payment Discount' }, reversed: { type: 'boolean', label: 'Reversed' }, reversal_move_id: { type: 'many2one', relation: 'account.move', label: 'Reversal Entry' } },
        newLine: () => ({ date: today(), amount: 0, move_id: null }),
      },
      line_ids: lineItem,
      amount_untaxed: { type: 'monetary', label: 'Tax Excluded', compute: (r) => amounts(r.invoice_line_ids).untaxed },
      amount_tax: { type: 'monetary', label: 'Taxes', compute: (r) => amounts(r.invoice_line_ids).tax },
      amount_total: { type: 'monetary', label: 'Total', compute: total },
      amount_paid: { type: 'monetary', label: 'Paid', readonly: true },
      amount_residual: { type: 'monetary', label: 'Amount Due', compute: residual },
      payment_state: {
        type: 'selection',
        label: 'Payment Status',
        compute: paymentState,
        options: [['not_paid', 'Not Paid'], ['partial', 'Partially Paid'], ['paid', 'Paid']],
      },
      payment_date: { type: 'date', label: 'Paid on', readonly: true },
      reversed_entry_id: { type: 'many2one', relation: 'account.move', label: 'Reversal of', readonly: true },
      // Set by fiscal closing and exchange revaluation only.
      is_closing: { type: 'boolean', label: 'Closing Entry', readonly: true, hidden: true },
      revaluation_date: { type: 'date', label: 'Revaluation Date', readonly: true },
      reversal_move_id: { type: 'many2one', relation: 'account.move', label: 'Reversal Entry', readonly: true },
      correction_of_id: { type: 'many2one', relation: 'account.move', label: 'Correction of', readonly: true },
      sale_id: { type: 'many2one', relation: 'sale.order', label: 'Sales Order', readonly: true },
      purchase_id: { type: 'many2one', relation: 'purchase.order', label: 'Purchase Order', readonly: true },
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
      lockedWhen: (r) => r.state !== 'draft',
      buttons: [
        { label: 'Confirm', primary: true, when: (r) => r.state === 'draft', run: (db, r) => ({ db: postMove(db, r.id) }) },
        // Server-only: Claude reads an uploaded bill (image/PDF) into this draft.
        { label: 'Digitize Document', upload: 'image/*,application/pdf', server: '/api/integrations/digitize', requires: 'ai', when: (r) => r.state === 'draft' && r.move_type === 'in_invoice' },
        { label: 'Register Payment', primary: true, when: (r) => r.state === 'posted' && isInvoice(r) && paymentState(r) !== 'paid', run: registerPayment },
        { label: 'Send by Email', email: 'document', when: (r) => r.state === 'posted' && isInvoice(r), run: (db) => ({ db }) },
        { label: 'Credit Note', when: (r) => r.state === 'posted' && ['out_invoice', 'in_invoice'].includes(r.move_type), run: creditNote },
        { label: 'Correct Credit Note', when: (r) => r.state === 'posted' && isRefund(r), run: correctCreditNote },
        { label: 'Print', when: (r) => r.state === 'posted' && isInvoice(r), run: (db, r) => ({ db, go: `#/print/account.move/${r.id}` }) },
        { label: 'Reset to Draft', when: (r, db) => r.state !== 'draft' && !(Number(r.amount_paid) > 0) && !(db && settlingEntries(db).has(r.id)), run: (db, r) => ({ db: removeAnalytic(write(db, 'account.move', r.id, { state: 'draft', ...(isInvoice(r) ? { line_ids: [] } : {}) }), r.id) }) },
        { label: 'Cancel', when: (r) => r.state === 'draft', run: (db, r) => ({ db: syncInvoicedQty(removeAnalytic(write(db, 'account.move', r.id, { state: 'cancel' }), r.id), r) }) },
      ],
      ribbon: (r) => (r.state === 'cancel' ? 'Cancelled' : paymentState(r) === 'paid' ? 'Paid' : paymentState(r) === 'partial' ? 'Partial' : null),
      subtitle: (r) => ({ in_invoice: 'Vendor Bill', in_refund: 'Vendor Refund', out_refund: 'Credit Note', entry: 'Journal Entry' })[r.move_type] ?? 'Customer Invoice',
      title: 'name',
      groups: [['partner_id', 'ref', 'invoice_origin'], ['invoice_date', 'invoice_payment_term_id', 'invoice_date_due', 'journal_id', 'currency_id', 'fiscal_position_id', 'payment_date']],
      tabs: (r) => (isInvoice(r)
        ? [{ label: 'Invoice Lines', fields: ['invoice_line_ids'] }, { label: 'Journal Items', fields: ['line_ids'], readonly: true }, { label: 'Payments', fields: ['payments'], readonly: true }, { label: 'Other Info', fields: ['narration'] }]
        : [{ label: 'Journal Items', fields: ['line_ids'] }]),
      footer: (r) => (isInvoice(r) ? ['amount_untaxed', 'amount_tax', 'amount_total', 'amount_residual'] : ['amount_total']),
      chatter: true,
    },
  },
};
