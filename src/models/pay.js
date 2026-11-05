// Customer and vendor payments: posted with their own bank entry and applied to the partner's open invoices.
import { create, postNote, read, search, write } from '../orm.js';
import { nextName, sameCommercialPartner, today, validDate } from './common.js';
import { invoiceCounterpartAccount, journalItemIdentity, journalId, outstandingAccount, partnerAccount, paymentJournal, postEntry } from './ledger.js';
import { isInvoice, payMove, releaseCashBasis, residual, settleWriteoff } from './accounting.js';
import { datedLockDelete, datedLockGuard, lockedSettlementInvariant, paymentInvariant, returnCompanies, settlementFxError, taxClosingSpec } from './finance.js';
import { postAnalytic } from './analyticplus.js';
import { companyCurrencyRecord, documentCurrency, round, roundCurrency } from '../money.js';
import { rateAt, toCompany } from './currency.js';
import { paymentCompanyAmount, settlementCompanyAmount } from './settlement.js';
import { resolveAndValidateRecipientBank } from './partnerbank.js';
import { exchangeAccount } from './exchange-account.js';
import { isPaymentMatched, unreconcile } from './bank.js';
import { shouldBePaid } from './billcontrol.js';

const money = (n) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

// Which open documents a payment settles, by direction and partner side.
const amountMismatch = (a, b) => round(Number(a) - b) !== 0;
export const SETTLES = { customer: { inbound: ['out_invoice'], outbound: ['out_refund'] }, supplier: { inbound: ['in_refund'], outbound: ['in_invoice'] } };

/** Resolve a selection against current records, never against list order or a caller's stale values. */
function selectedItems(db, selections) {
  if (!selections?.length) throw new Error('Select journal items first');
  const seen = new Set();
  return selections.map(({ move_id, line_identity }) => {
    const key = JSON.stringify([move_id, line_identity]);
    if (seen.has(key)) throw new Error('Select each journal item only once');
    seen.add(key);
    const move = read(db, 'account.move', move_id);
    const matches = (move?.line_ids ?? []).filter((line) => journalItemIdentity(line) === line_identity);
    if (move?.state !== 'posted' || matches.length !== 1) throw new Error('The selected journal item is missing, ambiguous or no longer posted; refresh the list');
    const [line] = matches;
    const account = read(db, 'account.account', line.account_id);
    const counterpart = ['asset_receivable', 'liability_payable'].includes(account?.account_type);
    if (!account || !(account.reconcile === true || counterpart)) throw new Error('Select items on a reconcilable account');
    if ((move.line_ids ?? []).filter((item) => item.account_id === line.account_id && item.partner_id === line.partner_id).length !== 1) throw new Error('This entry has multiple counterpart items; settle it from its document workflow');
    return { move, line, counterpart };
  });
}

/** Match exactly the chosen payment credit and document through the existing payment allocation model. */
export function reconcileJournalItems(db, selections, { date, amount = null } = {}) {
  const items = selectedItems(db, selections);
  if (!validDate(date)) throw new Error('Enter a valid reconciliation date');
  if (items.length !== 2) throw new Error('Select one invoice counterpart and one payment counterpart');
  const invoices = items.filter(({ move }) => isInvoice(move));
  if (invoices.length !== 1) throw new Error('Select one invoice counterpart and one payment counterpart');
  const [invoice] = invoices;
  const source = items.find((item) => item !== invoice);
  if (source.line.account_id !== invoice.line.account_id || source.line.partner_id !== invoice.line.partner_id) throw new Error('Selected items must have the same account and partner');
  if (!invoice.counterpart) throw new Error('Select the invoice receivable or payable item');
  const payments = search(db, 'account.payment').filter((p) => p.move_id === source.move.id && p.state === 'posted');
  if (payments.length !== 1) throw new Error('The selected entry must have an explicit posted payment link');
  if (date < (invoice.move.invoice_date ?? '')) throw new Error('Reconciliation date cannot be before the invoice date');
  return applyPaymentCredit(db, payments[0].id, invoice.move.id, date, amount);
}

/** Write off only an explicitly selected document counterpart, using explicit journal/account choices. */
export function writeoffJournalItem(db, selections, { date, amount, journalId, accountId, label } = {}) {
  const items = selectedItems(db, selections);
  if (items.length !== 1 || !isInvoice(items[0].move) || !items[0].counterpart) throw new Error('Select one invoice receivable or payable item to write off');
  const [{ move }] = items;
  if (!validDate(date) || date < (move.invoice_date ?? '')) throw new Error('Enter a valid write-off date on or after the invoice date');
  if (!journalId) throw new Error('Select a write-off journal');
  if (!accountId) throw new Error('Select a write-off account');
  const account = read(db, 'account.account', accountId);
  if (!account || account.active === false || account.deprecated || ['asset_receivable', 'liability_payable', 'off_balance'].includes(account.account_type) || accountId === items[0].line.account_id) throw new Error('Select an active write-off counterpart account, not a receivable or payable');
  if (!Number.isFinite(Number(amount)) || !(Number(amount) > 0) || Number(amount) > residual(move, db)) throw new Error('Enter a positive write-off amount within the remaining invoice balance');
  return settleWriteoff(db, move.id, Number(amount), toCompany(db, move.currency_id, Number(amount), date, move.company_id), date, { journalId, accountId, label }).db;
}

/** Release the selected settlements through their owning bank/payment reversal workflow. */
export function unreconcileJournalItems(db, selections, { date } = {}) {
  const items = selectedItems(db, selections);
  if (!validDate(date)) throw new Error('Enter a valid reversal date');
  const unapplications = new Map();
  const bankIds = new Set();
  const writeoffs = new Map();
  for (const { move, line, counterpart } of items) {
    if (isInvoice(move) && !counterpart) throw new Error('Select the invoice receivable or payable item');
    const rows = isInvoice(move) ? (move.payments ?? []).filter((row) => !row.reversed) : [];
    const sourceIds = new Set(isInvoice(move) ? rows.map((row) => row.move_id) : [move.id]);
    const payments = search(db, 'account.payment').filter((p) => p.state === 'posted' && sourceIds.has(p.move_id));
    const isPaymentOutstanding = !isInvoice(move) && payments.some((p) => p.outstanding_account_id === line.account_id);
    const applications = isInvoice(move) ? [] : search(db, 'account.move').filter((invoice) =>
      sameCommercialPartner(db, invoice.partner_id, line.partner_id)
      && (isPaymentOutstanding || (invoice.line_ids ?? []).some((l) => l.account_id === line.account_id))
      && (invoice.payments ?? []).some((row) => !row.reversed && row.move_id === move.id));
    // An invoice item only releases bank lines reconciled directly against it; a bank match of a payment belongs to the payment's items.
    const banks = search(db, 'account.bank.statement.line').filter((b) => b.bank_move_id && (isInvoice(move)
      ? (b.allocations ?? []).some((a) => a.invoice_id === move.id && (sourceIds.has(a.payment_move_id) || sourceIds.has(a.writeoff_move_id)))
      : sourceIds.has(b.bank_move_id) || sourceIds.has(b.payment_move_id) || payments.some((p) => b.payment_id === p.id || (b.payment_ids ?? []).includes(p.id))
        || (b.allocations ?? []).some((a) => sourceIds.has(a.payment_move_id) || sourceIds.has(a.writeoff_move_id))));
    if (!isInvoice(move) && !banks.length && !applications.length) throw new Error('The selected item has no active settlement');
    if (!isInvoice(move) && !counterpart && !isPaymentOutstanding && !banks.some((b) => read(db, 'account.journal', b.journal_id)?.suspense_account_id === line.account_id)) throw new Error('Select a linked receivable, payable, outstanding or suspense item');
    for (const bank of banks) bankIds.add(bank.id);
    const bankMatched = (moveId) => banks.some((b) => b.bank_move_id === moveId || b.payment_move_id === moveId || (b.allocations ?? []).some((a) => a.payment_move_id === moveId || a.writeoff_move_id === moveId));
    // Unreconcile only removes the matching: payments stay posted and their credit becomes available again.
    if ((counterpart || isPaymentOutstanding) && !isInvoice(move) && payments.length && !bankMatched(move.id)) for (const invoice of applications) unapplications.set(`${invoice.id}:${move.id}`, { invoiceId: invoice.id, moveId: move.id });
    for (const row of rows) {
      if (row.discount && payments.some((p) => p.move_id === row.payment_move_id)) continue;
      if (bankMatched(row.move_id)) continue;
      if (payments.some((p) => p.move_id === row.move_id)) { unapplications.set(`${move.id}:${row.move_id}`, { invoiceId: move.id, moveId: row.move_id }); continue; }
      const source = read(db, 'account.move', row.move_id);
      if (source?.move_type !== 'entry' || row.discount) throw new Error('This settlement must be reversed from its originating document workflow');
      writeoffs.set(`${move.id}:${row.move_id}`, { invoiceId: move.id, moveId: row.move_id });
    }
    if (!isInvoice(move) && !payments.length && !banks.length) {
      if (applications.length !== 1) throw new Error('No uniquely linked settlement can be unreconciled for this item');
      writeoffs.set(`${applications[0].id}:${move.id}`, { invoiceId: applications[0].id, moveId: move.id });
    }
    if (isInvoice(move) && !rows.length) throw new Error('The selected invoice has no active settlements');
  }
  // These functions return immutable snapshots: publish nothing unless the whole operation succeeds.
  let next = db;
  for (const id of bankIds) next = unreconcile(next, read(next, 'account.bank.statement.line', id), date).db;
  for (const { invoiceId, moveId } of unapplications.values()) next = unapplyPaymentCredit(next, invoiceId, moveId, date);
  for (const { invoiceId, moveId } of writeoffs.values()) next = reverseWriteoff(next, invoiceId, moveId, date);
  return next;
}

/**
 * Post a draft payment. With an invoice it pays that invoice; otherwise one entry is booked for the whole amount
 * and applied to the partner's open documents, oldest due first. Any rest stays as an outstanding credit.
 */
export function postPayment(db, p) {
  if (p.state !== 'draft') throw new Error('Only draft payments can be confirmed');
  if (!p.partner_id) throw new Error('Set the partner');
  if (!Number.isFinite(Number(p.amount)) || !(Number(p.amount) > 0)) throw new Error('The amount must be a finite positive number');
  let currentPayment = p;
  if (!p.invoice_id && p.payment_type === 'outbound' && p.partner_type === 'supplier') {
    const resolvedBankId = resolveAndValidateRecipientBank(db, p.partner_id, p.partner_bank_id, { companyId: p.company_id ?? 1 });
    if (resolvedBankId && resolvedBankId !== p.partner_bank_id) {
      currentPayment = { ...p, partner_bank_id: resolvedBankId };
      db = write(db, 'account.payment', p.id, { partner_bank_id: resolvedBankId });
    }
  }
  const date = currentPayment.date ?? today();
  if (currentPayment.invoice_id) return payMove(db, currentPayment.invoice_id, Number(currentPayment.amount), date, { paymentId: currentPayment.id, journalId: currentPayment.journal_id });
  const via = paymentJournal(db, currentPayment.journal_id, currentPayment.company_id ?? 1);
  const name = currentPayment.name && currentPayment.name !== '/' ? currentPayment.name : nextName(db, 'account.payment', `P${via.code}/${date.slice(0, 4)}/`);
  const isTaxOrDirect = currentPayment.is_tax_payment || currentPayment.return_id || currentPayment.destination_account_id || currentPayment.destination_account_code;
  const open = isTaxOrDirect
    ? []
    : search(db, 'account.move')
        .filter((m) => m.state === 'posted' && m.partner_id === currentPayment.partner_id && (m.company_id ?? 1) === (currentPayment.company_id ?? 1) && m.invoice_date <= date && m.amount_residual > 0 && SETTLES[currentPayment.partner_type]?.[currentPayment.payment_type]?.includes(m.move_type)
          && (!currentPayment.partner_bank_id || !m.partner_bank_id || m.partner_bank_id === currentPayment.partner_bank_id)
          && shouldBePaid(db, m) !== 'exception')
        .sort((a, b) => (a.invoice_date_due ?? '').localeCompare(b.invoice_date_due ?? ''));
  const inbound = currentPayment.payment_type === 'inbound';
  const journal = read(db, 'account.journal', via.id);
  const outstanding = outstandingAccount(db, journal, currentPayment.company_id ?? 1, inbound);
  const liquidity = outstanding ?? via.accountId;
  let taxClosing = null;
  if (currentPayment.return_id || currentPayment.is_tax_payment) {
    const ret = read(db, 'account.return', currentPayment.return_id);
    const payCompanyId = currentPayment.company_id ?? 1;
    let companies = [];
    try { if (ret) companies = returnCompanies(db, ret); } catch { companies = []; }
    if (!ret || ret.state !== 'submitted' || !companies.includes(payCompanyId)) throw new Error('A submitted tax return is required for settlement');
    const expected = taxClosingSpec(db, ret, payCompanyId).payable;
    if (!expected || inbound !== (expected < 0) || amountMismatch(currentPayment.amount, Math.abs(expected))) throw new Error('Payment must match the tax return obligation');
    const matches = (ret.closing_move_ids ?? []).flatMap((id) => {
      const move = read(db, 'account.move', id);
      if (!move || move.state !== 'posted' || (move.company_id ?? 1) !== payCompanyId) return [];
      return (move.line_ids ?? []).map((line, index) => ({ move, line, index })).filter(({ line }) =>
        line.account_id === currentPayment.destination_account_id && line.partner_id === currentPayment.partner_id
        && round((Number(line.credit) || 0) - (Number(line.debit) || 0)) === expected);
    });
    if (matches.length !== 1 || (matches[0].move.payments ?? []).some((p) => !p.reversed)) throw new Error('An unsettled tax closing obligation is required');
    taxClosing = matches[0];
  }
  let counterpart;
  if (currentPayment.destination_account_id) {
    counterpart = read(db, 'account.account', currentPayment.destination_account_id)?.id;
    if (!counterpart) throw new Error('The configured destination account does not exist');
  } else if (currentPayment.destination_account_code) {
    throw new Error('Select the destination account by record');
  } else {
    counterpart = partnerAccount(db, currentPayment.partner_id, currentPayment.company_id, currentPayment.partner_type === 'supplier' ? 'payable' : 'receivable');
  }
  const companyCurrency = companyCurrencyRecord(db, currentPayment.company_id);
  const companyRound = (n) => roundCurrency(n, companyCurrency);
  const amount = companyRound(Number(currentPayment.amount));
  const { db: booked, id: moveId } = postEntry(db, {
    journal: via.code, journal_id: journal.id, date, ref: currentPayment.memo || name,
    lines: inbound
      ? [{ account: liquidity, debit: amount, partner_id: currentPayment.partner_id }, { account: counterpart, credit: amount, partner_id: currentPayment.partner_id }]
      : [{ account: counterpart, debit: amount, partner_id: currentPayment.partner_id }, { account: liquidity, credit: amount, partner_id: currentPayment.partner_id }],
    company: currentPayment.company_id ?? 1,
    is_tax_payment: Boolean(currentPayment.is_tax_payment || currentPayment.return_id),
    tax_return_id: currentPayment.return_id ?? null,
  });
  // Register the source before allocations so all callers can derive its currency semantics.
  const registered = write(booked, 'account.payment', p.id, { name, state: 'posted', move_id: moveId, journal_id: via.id, outstanding_account_id: outstanding, unapplied: isTaxOrDirect ? 0 : amount });
  // Apply a company-currency payment against the recorded company balance of each document.
  const { db: applied, left } = open.reduce((acc, m) => {
    if (!(acc.left > 0)) return acc;
    const res = allocatePaymentToInvoice(acc.db, { ...currentPayment, name, move_id: moveId }, m, acc.left, date);
    return { db: res.db, left: res.left };
  }, { db: registered, left: amount });
  const settled = taxClosing ? write(applied, 'account.move', taxClosing.move.id, {
    amount_paid: amount, payment_date: date,
    payments: [...(taxClosing.move.payments ?? []), { date, amount, move_id: moveId, company_amount: amount, line_index: taxClosing.index }],
  }) : applied;
  return write(settled, 'account.payment', p.id, { name, state: 'posted', move_id: moveId, unapplied: isTaxOrDirect ? 0 : left });
}

/**
 * Allocate an available amount of payment credit against an invoice's residual balance.
 * Returns { db, left, taken }.
 */
export function allocatePaymentToInvoice(db, payment, invoice, availableCredit, date = today(), requestedAmount = null) {
  if (!(availableCredit > 0)) return { db, left: availableCredit, taken: 0 };
  const inbound = payment.payment_type === 'inbound';
  const companyCurrency = companyCurrencyRecord(db, invoice.company_id);
  const companyRound = (n) => roundCurrency(n, companyCurrency);
  const rate = rateAt(db, invoice.currency_id, date, invoice.company_id);
  const docCurrency = documentCurrency(db, invoice);
  const step = Number(docCurrency?.rounding ?? 0.01);
  const invResidual = residual(invoice, db);
  const maxTake = requestedAmount != null ? Math.min(invResidual, Number(requestedAmount)) : invResidual;
  const take = Math.min(maxTake, Number((Math.floor((availableCredit * rate / step) + 1e-9) * step).toPrecision(15)));
  const cashAmount = companyRound(take / rate);
  const companyAmount = settlementCompanyAmount(db, invoice, take);
  if (!(take > 0) || !(cashAmount > 0) || cashAmount > availableCredit) return { db, left: availableCredit, taken: 0 };
  const diff = companyRound((cashAmount - companyAmount) * (inbound ? 1 : -1));
  let withFx = db;
  let fxMove = null;
  const moveId = payment.move_id;
  if (diff) {
    const counterpart = payment.destination_account_code
      || (payment.destination_account_id ? read(db, 'account.account', payment.destination_account_id)?.code : null)
      || invoiceCounterpartAccount(db, invoice);
    const fx = postEntry(withFx, {
      journal: 'MISC', company: invoice.company_id ?? 1, date, ref: `Exchange difference ${payment.name}`,
      lines: diff > 0
        ? [{ account: counterpart, debit: diff, partner_id: payment.partner_id }, { account: exchangeAccount(withFx, invoice.company_id, diff), credit: diff }]
        : [{ account: counterpart, credit: -diff, partner_id: payment.partner_id }, { account: exchangeAccount(withFx, invoice.company_id, diff), debit: -diff }],
    });
    withFx = { ...fx.db, records: { ...fx.db.records, 'account.move': fx.db.records['account.move'].map((entry) => entry.id === fx.id ? { ...entry, fx_payment_move_id: moveId, fx_invoice_id: invoice.id } : entry) } };
    fxMove = fx.id;
  }
  const released = releaseCashBasis(withFx, invoice, take / invoice.amount_total, date, { final: take >= invResidual });
  const next = write(released.db, 'account.move', invoice.id, {
    amount_paid: roundCurrency((Number(invoice.amount_paid) || 0) + take, docCurrency),
    payment_date: date,
    payments: [...(invoice.payments ?? []), {
      date,
      amount: take,
      move_id: moveId,
      company_amount: companyAmount,
      payment_company_amount: cashAmount,
      cash_basis_move_id: released.id,
      ...(fxMove ? { payment_fx_move_id: fxMove } : {}),
    }],
    ...(!invoice.partner_bank_id && payment.partner_bank_id ? { partner_bank_id: payment.partner_bank_id } : {}),
  });
  return {
    db: postNote(next, 'account.move', invoice.id, `Payment ${payment.name} applied: ${take}`),
    left: companyRound(availableCredit - cashAmount),
    taken: take,
  };
}

/**
 * Apply an outstanding (unapplied) payment credit to an open invoice of the same commercial partner and company.
 */
export function applyPaymentCredit(db, paymentIdOrRec, invoiceIdOrRec, date = today(), amount = null) {
  const payment = typeof paymentIdOrRec === 'object' && paymentIdOrRec !== null ? paymentIdOrRec : read(db, 'account.payment', paymentIdOrRec);
  if (!payment || payment.state !== 'posted' || !payment.move_id) throw new Error('A posted payment is required');
  if (payment.destination_account_id || payment.destination_account_code || payment.is_tax_payment || payment.return_id) {
    throw new Error('A payment with a direct destination account or tax return cannot settle invoices');
  }
  const availableCredit = Number(payment.unapplied) || 0;
  if (!(availableCredit > 0)) throw new Error('This payment has no unapplied credit');

  const invoice = typeof invoiceIdOrRec === 'object' && invoiceIdOrRec !== null ? invoiceIdOrRec : read(db, 'account.move', invoiceIdOrRec);
  if (!invoice || invoice.state !== 'posted' || !isInvoice(invoice)) throw new Error('A posted invoice or bill is required');
  if (!(residual(invoice, db) > 0)) throw new Error('The invoice is already paid');
  if (shouldBePaid(db, invoice) === 'exception') {
    throw new Error('Resolve or approve the three-way matching exception before registering payment');
  }

  if (!sameCommercialPartner(db, payment.partner_id, invoice.partner_id)) {
    throw new Error('The payment and invoice must belong to the same commercial partner');
  }
  if ((payment.company_id ?? 1) !== (invoice.company_id ?? 1)) {
    throw new Error('The payment and invoice must belong to the same company');
  }
  if (!SETTLES[payment.partner_type]?.[payment.payment_type]?.includes(invoice.move_type)) {
    throw new Error('The payment cannot settle this document type');
  }
  if (payment.partner_bank_id && invoice.partner_bank_id && payment.partner_bank_id !== invoice.partner_bank_id) {
    throw new Error('The recipient bank account does not match');
  }

  const appDate = date ?? today();
  if (!validDate(appDate)) throw new Error('A valid application date is required');
  if (appDate < (payment.date ?? '')) throw new Error('Application date cannot be before the payment date');
  if (appDate < (invoice.invoice_date ?? '')) throw new Error('Application date cannot be before the invoice date');
  if (amount != null && (!Number.isFinite(Number(amount)) || Number(amount) <= 0)) {
    throw new Error('The applied amount must be a positive number');
  }

  const { db: nextDb, left, taken } = allocatePaymentToInvoice(db, payment, invoice, availableCredit, appDate, amount);
  if (!(taken > 0)) throw new Error('Could not allocate payment credit to invoice');

  const withPayment = write(nextDb, 'account.payment', payment.id, { unapplied: left });
  return postNote(withPayment, 'account.payment', payment.id, `Applied ${money(taken)} credit to ${invoice.name}`);
}

/** Validate an exact application inverse before any journal entry or balance is changed. */
function paymentUnapplication(db, invoiceId, paymentMoveId, date) {
  const invoice = read(db, 'account.move', invoiceId);
  const matches = (invoice?.payments ?? []).filter((row) => !row.reversed && row.move_id === paymentMoveId);
  const payments = search(db, 'account.payment').filter((p) => p.move_id === paymentMoveId && p.state === 'posted');
  if (!isInvoice(invoice) || invoice?.state !== 'posted' || matches.length !== 1 || payments.length !== 1) throw new Error('Select one active application of a posted payment');
  const [row] = matches;
  const [payment] = payments;
  if (!validDate(date) || date < row.date) throw new Error('Enter an unapplication date on or after the application date');
  if ((payment.company_id ?? 1) !== (invoice.company_id ?? 1) || !sameCommercialPartner(db, payment.partner_id, invoice.partner_id)) throw new Error('Payment and invoice must belong to the same company and partner');
  if (row.discount || payment.return_id || payment.is_tax_payment) throw new Error('Unapply this settlement from its originating document workflow');
  const bookedPayment = paymentCompanyAmount(db, invoice, row);
  if (!(bookedPayment > 0)) throw new Error('The application payment company amount cannot be determined from its booked entry; repair the settlement link first');
  const source = read(db, 'account.move', paymentMoveId);
  if (source?.state !== 'posted' || search(db, 'account.move').some((m) => m.state !== 'cancel' && m.reversed_entry_id === paymentMoveId)) throw new Error('The payment entry must remain posted and unreversed');
  const fxError = settlementFxError(db, invoice, row);
  if (fxError) throw new Error(fxError);
  for (const id of [row.payment_fx_move_id, row.cash_basis_move_id].filter(Boolean)) {
    const entry = read(db, 'account.move', id);
    if (entry?.state !== 'posted' || entry.move_type !== 'entry' || (entry.company_id ?? 1) !== (invoice.company_id ?? 1) || date < entry.invoice_date || search(db, 'account.move').some((m) => m.state !== 'cancel' && m.reversed_entry_id === id)) throw new Error('The linked exchange or cash-basis entry cannot be reversed on this date');
    const journal = read(db, 'account.journal', entry.journal_id);
    if (!journal) throw new Error('The linked settlement journal is missing');
  }
  const discounts = (invoice.payments ?? []).filter((r) => r.discount && !r.reversed && r.payment_move_id === paymentMoveId);
  for (const d of discounts) {
    const entry = read(db, 'account.move', d.move_id);
    if (entry?.state !== 'posted' || entry.move_type !== 'entry' || (entry.company_id ?? 1) !== (invoice.company_id ?? 1) || date < entry.invoice_date || search(db, 'account.move').some((m) => m.state !== 'cancel' && m.reversed_entry_id === d.move_id)) throw new Error('The linked discount entry cannot be reversed on this date');
    const journal = read(db, 'account.journal', entry.journal_id);
    if (!journal) throw new Error('The linked settlement journal is missing');
  }
  const discountAmount = discounts.reduce((sum, d) => sum + Number(d.amount), 0);
  const discountIds = new Set(discounts.map((d) => d.move_id));
  // An unapplied row is inactive like a reversed one, but the payment itself stays posted: no reversing entry exists.
  const paymentsAfter = invoice.payments.map((p) => {
    if (p === row) return { ...p, reversed: true, unapplied: true, reversal_date: date };
    if (discountIds.has(p.move_id)) return { ...p, reversed: true, reversal_date: date };
    return p;
  });
  const invoiceValues = { amount_paid: roundCurrency(Number(invoice.amount_paid) - Number(row.amount) - discountAmount, documentCurrency(db, invoice)), payments: paymentsAfter, payment_date: paymentsAfter.filter((p) => !p.reversed).at(-1)?.date ?? null };
  const unapplied = roundCurrency(Number(payment.unapplied) + bookedPayment, companyCurrencyRecord(db, invoice.company_id));
  const lockError = datedLockGuard(['unapplied'], (p) => p.state === 'posted')(db, payment, { ...payment, unapplied })
    ?? lockedSettlementInvariant(db, { ...invoice, ...invoiceValues }, invoice);
  if (lockError) throw new Error(lockError);
  return { invoice, row, payment, discounts, invoiceValues, unapplied };
}

/** Remove a matching, not its payment: restore credit and reverse only application-specific FX and cash basis. */
export function unapplyPaymentCredit(db, invoiceId, paymentMoveId, date = today()) {
  const { invoice, row, payment, discounts, invoiceValues, unapplied } = paymentUnapplication(db, invoiceId, paymentMoveId, date);
  let next = db;
  if (row.payment_fx_move_id) next = reverseEntry(next, read(next, 'account.move', row.payment_fx_move_id), date, { reconciliation_reversal: true }).db;
  next = reverseCashBasis(next, row, invoice, date);
  const discountReversals = new Map();
  for (const d of discounts ?? []) {
    const reversed = reverseEntry(next, read(next, 'account.move', d.move_id), date, { reconciliation_reversal: true });
    next = reversed.db;
    discountReversals.set(d.move_id, reversed.id);
  }
  const paymentsFinal = invoiceValues.payments.map((p) => {
    if (discountReversals.has(p.move_id)) return { ...p, reversal_move_id: discountReversals.get(p.move_id) };
    return p;
  });
  next = write(next, 'account.payment', payment.id, { unapplied });
  return write(next, 'account.move', invoice.id, { ...invoiceValues, payments: paymentsFinal });
}

/** Post a linked mirror of an existing entry (optionally in a chosen journal/date, or reverse-and-create a new draft). */
export function reverseEntry(db, source, dateOrOptions = today(), extraOptions = {}) {
  const opts = typeof dateOrOptions === 'object' && dateOrOptions !== null && !Array.isArray(dateOrOptions)
    ? dateOrOptions
    : { ...(extraOptions ?? {}), ...(typeof dateOrOptions === 'string' ? { date: dateOrOptions } : {}) };
  const date = opts.date ?? opts.invoice_date ?? today();
  const sourceDate = source?.invoice_date ?? source?.date ?? '';
  if (!source || source.state !== 'posted' || source.move_type !== 'entry' || !validDate(date) || date < sourceDate) {
    throw new Error('A posted entry and valid reversal date are required');
  }
  if (source.fx_payment_move_id && source.fx_invoice_id && !opts.reconciliation_reversal) {
    throw new Error('An exchange difference entry linked to a settlement cannot be reversed independently');
  }
  if (search(db, 'account.move').some((m) => m.state !== 'cancel' && m.reversed_entry_id === source.id)) {
    throw new Error('This entry has already been reversed');
  }
  const mode = opts.mode ?? (opts.reverse_and_create ? 'modify' : 'reverse');
  if (!['reverse', 'modify'].includes(mode)) throw new Error('Choose a valid reversal mode');
  const companyId = source.company_id ?? 1;
  let targetJournalId = opts.journal_id ?? source.journal_id ?? null;
  if (!targetJournalId && opts.journal) {
    targetJournalId = typeof opts.journal === 'number' ? opts.journal : (journalId(db, opts.journal, companyId) ?? journalId(db, opts.journal));
  }
  if (!targetJournalId) targetJournalId = paymentJournal(db, null, companyId).id;
  const journalRec = read(db, 'account.journal', targetJournalId);
  if (targetJournalId && !journalRec) throw new Error('Selected journal does not exist');
  if (journalRec?.company_id && journalRec.company_id !== companyId) throw new Error('Journal belongs to another company');
  const code = journalRec.code;
  const reason = String(opts.reason ?? '').trim();
  const ref = reason ? `Reversal of ${source.name}, ${reason}` : `Reversal of ${source.name}`;
  const created = create(db, 'account.move', {
    move_type: 'entry',
    state: opts.scheduled ? 'draft' : 'posted',
    ...(opts.scheduled ? { auto_post: 'at_date' } : {}),
    journal_id: targetJournalId,
    invoice_date: date,
    date,
    ref,
    reversed_entry_id: source.id,
    ...(source.cash_basis_origin_move_id ? { cash_basis_origin_move_id: source.cash_basis_origin_move_id } : {}),
    partner_id: source.partner_id ?? null,
    name: opts.scheduled ? '/' : nextName(db, 'account.move', `${code}/${date.slice(0, 4)}/`),
    company_id: companyId,
    line_ids: (source.line_ids ?? []).map((l) => ({
      ...l,
      debit: l.credit,
      credit: l.debit,
      ...(l.currency_id ? { amount_currency: -(Number(l.amount_currency) || 0) } : {}),
      ...(l.tax_zero ? { tax_base: -(Number(l.tax_base) || 0) } : {}),
      name: `Reversal: ${l.name ?? ''}`.trim(),
    })),
  });
  let next = opts.scheduled ? created.db : postAnalytic(created.db, created.id);
  const currentSource = read(next, 'account.move', source.id);
  if (currentSource && !currentSource.inalterable_hash) {
    next = write(next, 'account.move', source.id, { reversal_move_id: created.id });
  }
  next = postNote(next, 'account.move', source.id, opts.scheduled ? `Reversal scheduled for ${date}` : `Reversed by ${read(next, 'account.move', created.id).name}`);
  if (mode === 'modify') {
    const draft = create(next, 'account.move', {
      move_type: 'entry',
      state: 'draft',
      name: '/',
      journal_id: targetJournalId,
      invoice_date: date,
      date,
      ref: source.ref ?? '',
      partner_id: source.partner_id ?? null,
      company_id: companyId,
      ...(source.currency_id ? { currency_id: source.currency_id } : {}),
      line_ids: (source.line_ids ?? []).map((l) => ({ ...l })),
    });
    return { db: draft.db, id: draft.id, reversal_id: created.id, go: `#/accounting/entries/${draft.id}` };
  }
  return { db: next, id: created.id, go: `#/accounting/entries/${created.id}` };
}

/** Reverse the exact cash-basis entry released by a settlement. */
function reverseCashBasis(db, allocation, invoice, date) {
  if (!allocation.cash_basis_move_id) return db;
  const original = read(db, 'account.move', allocation.cash_basis_move_id);
  if (!original) throw new Error('Cash-basis release for payment not found');
  const lines = original.line_ids.map((l) => ({
    ...l, debit: l.credit, credit: l.debit,
    tax_base: (l.tax_base_signed || !(Number(l.debit) || Number(l.credit)) ? -1 : 1) * (Number(l.tax_base) || 0),
  }));
  const company = read(db, 'res.company', invoice.company_id ?? 1) ? (invoice.company_id ?? 1) : null;
  const reversal = postEntry(db, { journal: 'MISC', date, ref: `Cash basis taxes ${invoice.name}`, lines, company });
  return write(reversal.db, 'account.move', reversal.id, { reversed_entry_id: original.id, cash_basis_origin_move_id: invoice.id });
}

/** Reverse a write-off settlement without changing unrelated invoice applications. */
export function reverseWriteoff(db, invoiceId, moveId, date) {
  const invoice = read(db, 'account.move', invoiceId);
  const row = (invoice?.payments ?? []).find((p) => p.move_id === moveId && !p.reversed);
  if (!row) throw new Error('The linked write-off settlement is missing');
  const reversed = reverseEntry(db, read(db, 'account.move', moveId), date);
  const released = reverseCashBasis(reversed.db, row, invoice, date);
  const payments = invoice.payments.map((p) => p === row ? { ...p, reversed: true, reversal_move_id: reversed.id, reversal_date: date } : p);
  return write(released, 'account.move', invoiceId, { amount_paid: roundCurrency((Number(invoice.amount_paid) || 0) - Number(row.amount), documentCurrency(db, invoice)), payments, payment_date: payments.filter((p) => !p.reversed).at(-1)?.date ?? null });
}

/**
 * Reverse a posted payment (FLOW-017): a mirror entry is posted on `date`, and what the payment settled becomes due
 * again, cash-basis taxes included. Payments made by a bank reconciliation stay, since the bank line still matches them.
 */
export function reversePayment(db, p, date = today()) {
  if (p.state !== 'posted' || !p.move_id) throw new Error('Only posted payments can be reversed');
  if (p.return_id || p.is_tax_payment) throw new Error('Tax return payments cannot be reversed independently');
  const entry = read(db, 'account.move', p.move_id);
  const fromBank = isPaymentMatched(db, p);
  const missingBankLink = p.invoice_id && search(db, 'account.bank.statement.line').some((l) => l.state === 'reconciled' && l.move_id === p.invoice_id && !l.payment_move_id);
  if (missingBankLink) throw new Error('Cannot reverse payment: the reconciled bank transaction is missing its payment link; repair it first');
  if (fromBank) throw new Error('This payment is linked to a reconciled bank transaction; unreconcile the transaction before reversing it');
  // A posted legacy line without payment identity could represent any payment of its linked invoice.
  // Do not guess from amount or reference; require the missing link to be repaired first.
  const missingBatchLink = (db.records['account.batch.payment'] ?? []).some((batch) => batch.state === 'posted'
    && (batch.lines ?? []).some((line) => !line.cancelled && !line.payment_id
      && p.invoice_id && line.move_id === p.invoice_id));
  if (missingBatchLink) throw new Error('Cannot reverse payment: a posted batch line is missing its payment_id; repair the payment link first');
  if (date < (p.date ?? entry.invoice_date)) throw new Error('Reversal date cannot be before the payment date');
  for (const m of search(db, 'account.move')) for (const x of m.payments ?? []) {
    if (x.move_id === entry.id && !x.reversed) {
      const error = settlementFxError(db, m, x);
      if (error) throw new Error(error);
    }
  }
  const sources = new Set([entry.id]);
  for (const m of search(db, 'account.move')) for (const x of m.payments ?? []) {
    if (x.discount && !x.reversed && x.payment_move_id === p.move_id) sources.add(x.move_id);
    if (!x.reversed && x.move_id === p.move_id && x.payment_fx_move_id) sources.add(x.payment_fx_move_id);
  }
  if (search(db, 'account.move').some((m) => (m.payments ?? []).some((x) => sources.has(x.move_id) && !x.reversed && x.date > date))) throw new Error('Reversal date cannot be before an application date');
  let booked = db;
  const reversals = new Map();
  for (const id of sources) {
    const source = read(booked, 'account.move', id);
    const made = reverseEntry(booked, source, date, { reconciliation_reversal: true });
    booked = made.db;
    reversals.set(id, made.id);
  }
  const settled = search(booked, 'account.move').filter((m) => (m.payments ?? []).some((x) => sources.has(x.move_id) && !x.reversed));
  const reopened = settled.reduce((acc, m) => {
    const active = (m.payments ?? []).filter((x) => sources.has(x.move_id) && !x.reversed);
    const docCurrency = documentCurrency(acc, m);
    const amount = roundCurrency(active.reduce((sum, x) => sum + Number(x.amount), 0), docCurrency);
    const payments = m.payments.map((x) => sources.has(x.move_id) && !x.reversed ? { ...x, reversed: true, reversal_move_id: reversals.get(x.move_id), reversal_date: date } : x);
    let released = acc;
    for (const allocation of active) {
      if (Object.hasOwn(allocation, 'cash_basis_move_id')) {
        released = reverseCashBasis(released, allocation, m, date);
      }
    }
    const legacy = active.filter((x) => !Object.hasOwn(x, 'cash_basis_move_id') && !x.discount);
    const legacyAmount = roundCurrency(legacy.reduce((sum, x) => sum + Number(x.amount), 0), docCurrency);
    if (legacy.length && m.amount_total) {
      released = releaseCashBasis(released, m, -legacyAmount / m.amount_total, date).db;
    }
    const next = write(released, 'account.move', m.id, { amount_paid: roundCurrency((Number(m.amount_paid) || 0) - amount, docCurrency), payments, payment_date: payments.filter((x) => !x.reversed).at(-1)?.date ?? null });
    return postNote(next, 'account.move', m.id, `Payment ${p.name} reversed: ${amount}`);
  }, booked);
  const reversal = read(reopened, 'account.move', reversals.get(entry.id));
  let next = write(reopened, 'account.payment', p.id, { state: 'reversed', unapplied: 0 });
  if (p.sale_id) {
    const remaining = round(search(next, 'account.payment').filter((x) => x.sale_id === p.sale_id && x.state === 'posted').reduce((sum, x) => sum + Number(x.amount), 0));
    next = write(next, 'sale.order', p.sale_id, { amount_paid: remaining, payment_state: remaining > 0 ? 'paid' : 'pending' });
  }
  for (const batch of (next.records['account.batch.payment'] ?? []).filter((b) => b.state === 'posted' && b.lines?.some((l) => l.payment_id === p.id))) {
    next = write(next, 'account.batch.payment', batch.id, { lines: batch.lines.map((l) => l.payment_id === p.id ? { ...l, cancelled: true } : l) });
  }
  return postNote(next, 'account.payment', p.id, `Reversed by ${reversal.name}`);
}

/** Every check number a journal has ever consumed: issued, printed on a batch line, or voided by a reprint. */
const consumedCheckNumbers = (db, journalId) => {
  const payments = (db.records['account.payment'] ?? []).filter((p) => p.journal_id === journalId);
  const ids = new Set(payments.map((p) => p.id));
  const fromBatches = (db.records['account.batch.payment'] ?? []).flatMap((b) => (b.lines ?? []).filter((l) => ids.has(l.payment_id)).map((l) => l.check_number));
  return [...payments.map((p) => p.check_number), ...payments.flatMap((p) => (p.voided_check_numbers ?? []).map((v) => v.check_number)), ...fromBatches]
    .filter((n) => Number.isSafeInteger(n) && n > 0);
};

/** First check number a journal may print next: its "Next Check Number" setting, pushed past every number already consumed. */
export function nextCheckNumber(db, journalId, requested = 0) {
  const journal = read(db, 'account.journal', journalId);
  return consumedCheckNumbers(db, journalId).reduce((next, n) => Math.max(next, n + 1), Number(requested || journal?.check_next_number || 1));
}

/** Reprint an issued check on a fresh number: the old number is voided (kept on the payment, never reused). */
export function reprintCheck(db, payment) {
  const p = read(db, 'account.payment', payment.id) ?? payment;
  if (p.check_number == null || p.payment_type !== 'outbound') throw new Error('Only issued checks can be reprinted');
  if (p.state !== 'posted') throw new Error('Only posted checks can be reprinted');
  const number = nextCheckNumber(db, p.journal_id);
  const voided_check_numbers = [...(p.voided_check_numbers ?? []), { check_number: p.check_number, date: today() }];
  let next = writeReprintedCheck(db, p, number, voided_check_numbers);
  for (const batch of (next.records['account.batch.payment'] ?? []).filter((b) => b.lines?.some((l) => l.payment_id === p.id))) {
    next = write(next, 'account.batch.payment', batch.id, { lines: batch.lines.map((l) => l.payment_id === p.id ? { ...l, check_number: number } : l) });
  }
  next = write(next, 'account.journal', p.journal_id, { check_next_number: number + 1 });
  return postNote(next, 'account.payment', p.id, `Check ${p.check_number} voided, reprinted as ${number}`);
}

const trustedReprints = new WeakMap();

function writeReprintedCheck(db, payment, number, voidedCheckNumbers) {
  let transitions = trustedReprints.get(db);
  if (!transitions) {
    transitions = new Map();
    trustedReprints.set(db, transitions);
  }
  transitions.set(payment.id, { previous: payment.check_number, next: number });
  try {
    return write(db, 'account.payment', payment.id, { check_number: number, voided_check_numbers: voidedCheckNumbers });
  } finally {
    transitions.delete(payment.id);
    if (!transitions.size) trustedReprints.delete(db);
  }
}

const STATES = [['draft', 'Draft'], ['posted', 'Posted'], ['cancel', 'Cancelled'], ['reversed', 'Reversed']];

const validCheckWrite = (db, before, after) => {
  const priorVoided = before?.voided_check_numbers ?? [];
  const nextVoided = after.voided_check_numbers ?? [];
  if (!before) return !nextVoided.length && (after.check_number == null || after.state === 'posted');
  if (before.check_number == null) return !nextVoided.length && (after.check_number == null || (before.state === 'draft' && after.state === 'posted'));
  if (before.journal_id !== after.journal_id) return false;
  if (before.check_number === after.check_number) return JSON.stringify(priorVoided) === JSON.stringify(nextVoided);
  if (before.state !== 'posted' || after.state !== 'posted' || after.payment_type !== 'outbound') return false;
  const transition = trustedReprints.get(db)?.get(before.id);
  if (transition?.previous !== before.check_number || transition?.next !== after.check_number) return false;
  const restored = { ...db, records: { ...db.records, 'account.payment': (db.records['account.payment'] ?? []).map((p) => p.id === before.id ? before : p) } };
  return nextVoided.length === priorVoided.length + 1
    && JSON.stringify(nextVoided.slice(0, priorVoided.length)) === JSON.stringify(priorVoided)
    && nextVoided.at(-1)?.check_number === before.check_number
    && Boolean(nextVoided.at(-1)?.date)
    && after.check_number === nextCheckNumber(restored, before.journal_id);
};

export const payModels = {
  'account.payment': {
    label: 'Payments',
    guard: (db, before, after, ctx) => (!validCheckWrite(db, before, after) ? 'Issued check numbers cannot be changed' : null) ?? datedLockGuard(['name', 'amount', 'currency_id', 'date', 'state', 'partner_id', 'partner_bank_id', 'partner_type', 'journal_id', 'move_id', 'invoice_id', 'payment_type', 'memo', 'unapplied', 'company_id', 'active'], (p) => p.state === 'posted')(db, before, after, ctx),
    protectDelete: (db, payment, staged) => payment.check_number != null ? 'Issued checks cannot be deleted' : datedLockDelete((p) => p.state === 'posted')(db, payment, staged),
    invariant: paymentInvariant,
    fields: {
      name: { type: 'char', label: 'Number', readonly: true },
      payment_type: { type: 'selection', label: 'Payment Type', options: [['inbound', 'Receive'], ['outbound', 'Send']] },
      partner_type: { type: 'selection', label: 'Partner Type', options: [['customer', 'Customer'], ['supplier', 'Vendor']] },
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Partner' },
      partner_bank_id: { type: 'many2one', relation: 'res.partner.bank', label: 'Recipient Bank Account' },
      amount: { type: 'monetary', label: 'Amount' },
      currency_id: { type: 'many2one', relation: 'res.currency', label: 'Currency', readonly: true },
      journal_id: { type: 'many2one', relation: 'account.journal', label: 'Journal' },
      check_number: { type: 'integer', label: 'Check Number', readonly: true },
      voided_check_numbers: { type: 'one2many', label: 'Voided Checks', readonly: true, fields: { check_number: { type: 'integer', label: 'Check Number' }, date: { type: 'date', label: 'Date' } } },
      date: { type: 'date', label: 'Date' },
      memo: { type: 'char', label: 'Memo' },
      destination_account_id: { type: 'many2one', relation: 'account.account', label: 'Destination Account' },
      destination_account_code: { type: 'char', label: 'Destination Account Code', hidden: true },
      is_tax_payment: { type: 'boolean', label: 'Tax Payment', hidden: true },
      return_id: { type: 'many2one', relation: 'account.return', label: 'Tax Return', readonly: true },
      invoice_id: { type: 'many2one', relation: 'account.move', label: 'Invoice' },
      move_id: { type: 'many2one', relation: 'account.move', label: 'Journal Entry', readonly: true },
      outstanding_account_id: { type: 'many2one', relation: 'account.account', label: 'Outstanding Account', readonly: true, hidden: true },
      sale_id: { type: 'many2one', relation: 'sale.order', label: 'Sales Order', readonly: true },
      unapplied: { type: 'monetary', label: 'Outstanding Credit', readonly: true, currency: 'company' },
      state: { type: 'selection', label: 'Status', tracking: true, options: STATES },
    },
    defaults: () => ({ name: '/', payment_type: 'inbound', partner_type: 'customer', date: today(), state: 'draft', amount: 0 }),
    groupBys: ['partner_id', 'payment_type', 'state', 'date'],
    filters: [[{ id: 'in', label: 'Customer Payments', fn: (r) => r.payment_type === 'inbound' }, { id: 'out', label: 'Vendor Payments', fn: (r) => r.payment_type === 'outbound' }]],
    kanban: { title: 'name', lines: ['partner_id', 'amount', 'date'], badge: 'state' },
    list: ['date', 'name', 'partner_id', 'memo', 'payment_type', 'amount', 'state'],
    graph: { groupBy: 'date', measure: 'amount' },
    form: {
      statusbar: 'state',
      lockedWhen: (r) => r.state !== 'draft',
      buttons: [
        { label: 'Confirm', primary: true, when: (r) => r.state === 'draft', run: (db, r) => ({ db: postPayment(db, read(db, 'account.payment', r.id)) }) },
        {
          label: 'Apply Credit',
          when: (r) => r.state === 'posted' && Number(r.unapplied) > 0,
          wizard: (db, r) => ({
            title: 'Apply Credit to Invoice',
            fields: [
              {
                name: 'invoice_id',
                type: 'many2one',
                relation: 'account.move',
                label: 'Invoice / Bill',
                required: true,
                domain: (m) => m.state === 'posted'
                  && isInvoice(m)
                  && (m.company_id ?? 1) === (r.company_id ?? 1)
                  && sameCommercialPartner(db, m.partner_id, r.partner_id)
                  && SETTLES[r.partner_type]?.[r.payment_type]?.includes(m.move_type)
                  && residual(m, db) > 0
                  && shouldBePaid(db, m) !== 'exception'
                  && (!r.partner_bank_id || !m.partner_bank_id || r.partner_bank_id === m.partner_bank_id),
              },
              { name: 'date', type: 'date', label: 'Application Date', default: today(), required: true },
            ],
          }),
          run: (db, r, values = {}) => {
            if (!values.invoice_id) throw new Error('Select an invoice to apply credit to');
            return { db: applyPaymentCredit(db, r.id, values.invoice_id, values.date) };
          },
        },
        { label: 'Journal Entry', when: (r) => r.move_id, run: (db, r) => ({ db, go: `#/accounting/entries/${r.move_id}` }) },
        { label: 'Reverse', when: (r) => r.state === 'posted', run: (db, r) => ({ db: reversePayment(db, read(db, 'account.payment', r.id)) }) },
        { label: 'Reprint Check', when: (r) => r.state === 'posted' && r.check_number != null, run: (db, r) => ({ db: reprintCheck(db, r), go: `#/print/account.payment/${r.id}` }) },
        { label: 'Cancel', when: (r) => r.state === 'draft', vals: { state: 'cancel' } },
      ],
      title: 'name',
      groups: [['payment_type', 'partner_type', 'partner_id', 'amount', 'journal_id'], ['date', 'memo', 'invoice_id', 'move_id', 'unapplied']],
      chatter: true,
    },
  },
};
