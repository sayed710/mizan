// Customer and vendor payments: posted with their own bank entry and applied to the partner's open invoices.
import { create, getActiveCompany, postNote, read, search, unlink, write } from '../orm.js';
import { monthFilters, nextName, promptedAmount, sameCommercialPartner, today, validDate } from './common.js';
import { defaultPaymentJournalId, exchangeJournal, installmentSettlementState, invoiceCounterpartAccount, isReconcilableAccount, journalItemIdentity, journalId, outstandingAccount, partnerAccount, paymentJournal, paymentName, postEntry, reconciledJournalItems, statementPaymentIds, stornoLine, valueOnlyCurrencyFields } from './ledger.js';
import { appendDocumentSettlement, applyCreditNote, bookEarlyDiscount, discountAvailable, isInvoice, isPurchase, isRefund, liquidityForeignFields, payWithDiscount, registerPayment, releaseCashBasis, residual, settleWriteoff, settlingEntries } from './accounting.js';
import { bookedByBank, datedLockDelete, datedLockGuard, isExchangeEntry, lockedSettlementInvariant, moveDate, moveDeleteGuard, recordLockDate, paymentInvariant, returnCompanies, settlementFxError, taxClosingSpec } from './finance.js';
import { postAnalytic } from './analyticplus.js';
import { companyCurrencyRecord, documentCurrency, round, roundCurrency } from '../money.js';
import { conversionRate, rateAt, toCompany } from './currency.js';
import { paymentCompanyAmount, settlementCompanyAmount } from './settlement.js';
import { resolveAndValidateRecipientBank } from './partnerbank.js';
import { exchangeAccount } from './exchange-account.js';
import { isPaymentMatched, unreconcile } from './bank.js';
import { reconcileLedgerItems, unreconcilePartialReconcile } from './glReconcile.js';
import { shouldBePaid } from './billcontrol.js';
import { companyFilter, currentCompany, recipientBankCompanyError } from './company.js';
import { defaultPaymentMethodLineId, isMethodLineJournal, paymentMethodLineError } from './paymentmethod.js';
import { openActivitiesText } from './mail.js';
import { hasMultiCurrency } from './money.js';

const money = (n) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const shared = (id) => id == null || id === false || id === '';

// Which open documents a payment settles, by direction and partner side.
const amountMismatch = (a, b) => round(Number(a) - b) !== 0;
export const SETTLES = { customer: { inbound: ['out_invoice'], outbound: ['out_refund'] }, supplier: { inbound: ['in_refund'], outbound: ['in_invoice'] } };

/** Resolve a selection against current records, never against list order or a caller's stale values. */
export function selectedItems(db, selections, { allowMultipleEntryLines = false } = {}) {
  if (!selections?.length) throw new Error('Select journal items first');
  const seen = new Set();
  const reconciledByMove = new Map();
  return selections.map(({ move_id, line_identity, line_index }) => {
    const key = JSON.stringify([move_id, line_index ?? line_identity]);
    if (seen.has(key)) throw new Error('Select each journal item only once');
    seen.add(key);
    const move = read(db, 'account.move', move_id);
    let line;
    let lineIndex;
    if (line_index != null && Number.isInteger(line_index)) {
      if (move?.state !== 'posted' || line_index < 0 || line_index >= (move?.line_ids ?? []).length) {
        throw new Error('The selected journal item is missing, ambiguous or no longer posted; refresh the list');
      }
      line = move.line_ids[line_index];
      if (line_identity && journalItemIdentity(line) !== line_identity) {
        throw new Error('The selected journal item is missing, ambiguous or no longer posted; refresh the list');
      }
      lineIndex = line_index;
    } else {
      const matches = (move?.line_ids ?? []).filter((l) => journalItemIdentity(l) === line_identity);
      if (move?.state !== 'posted' || matches.length !== 1) throw new Error('The selected journal item is missing, ambiguous or no longer posted; refresh the list');
      [line] = matches;
      lineIndex = (move.line_ids ?? []).indexOf(line);
    }
    const account = read(db, 'account.account', line.account_id);
    const counterpart = ['asset_receivable', 'liability_payable'].includes(account?.account_type);
    if (!account || !(account.reconcile === true || counterpart)) throw new Error('Select items on a reconcilable account');
    // Multi-installment invoices and bills legitimately split one receivable/payable total across dated counterpart lines.
    const sameCounterpart = (move.line_ids ?? []).filter((item) => item.account_id === line.account_id && item.partner_id === line.partner_id);
    if (!allowMultipleEntryLines && sameCounterpart.length !== 1 && !(isInvoice(move) && counterpart)) throw new Error('This entry has multiple counterpart items; settle it from its document workflow');
    const multiInstallment = isInvoice(move) && counterpart && sameCounterpart.length > 1;
    let lineResidual = isInvoice(move) ? residual(move, db) : 0;
    if (multiInstallment) {
      const { remainingByIndex } = installmentSettlementState(db, move);
      if (remainingByIndex.has(lineIndex)) lineResidual = remainingByIndex.get(lineIndex);
    }
    if (!reconciledByMove.has(move.id)) reconciledByMove.set(move.id, reconciledJournalItems(db, move));
    const reconciledLine = reconciledByMove.get(move.id)[lineIndex];
    const mDate = moveDate(move);
    return {
      move,
      line,
      lineIndex,
      account,
      counterpart,
      multiInstallment,
      lineResidual,
      reconciledLine,
      moveDate: mDate,
      dueDate: line.date_maturity ?? move.invoice_date_due ?? mDate,
    };
  });
}

/** Cap or validate requested settlement amount against an explicit installment line when multi-installment. */
function installmentTargetAmount(item, amount) {
  if (!item.multiInstallment) return amount;
  if (!(item.lineResidual > 0)) throw new Error('The selected installment has no remaining open balance');
  if (amount == null) return item.lineResidual;
  const num = Number(amount);
  return Number.isFinite(num) && num > 0 ? Math.min(num, item.lineResidual) : amount;
}

/** Match a payment credit or standalone credit note against an open invoice using the underlying workflow. */
export function reconcileJournalItems(db, selections, { date, amount = null } = {}) {
  const items = selectedItems(db, selections);
  if (!validDate(date)) throw new Error('Enter a valid reconciliation date');
  if (items.length !== 2) throw new Error('Select one invoice counterpart and one payment or credit note counterpart');
  const docs = items.filter(({ move }) => ['out_invoice', 'in_invoice'].includes(move.move_type));
  const refunds = items.filter(({ move }) => ['out_refund', 'in_refund'].includes(move.move_type));
  if (docs.length === 1 && refunds.length === 1) {
    const [doc] = docs;
    const [refund] = refunds;
    if (!doc.counterpart || !refund.counterpart) throw new Error('Select the invoice and credit note receivable or payable items');
    if (refund.line.account_id !== doc.line.account_id || refund.line.partner_id !== doc.line.partner_id) throw new Error('Selected items must have the same account and partner');
    const targetAmount = installmentTargetAmount(doc, amount);
    return applyCreditNote(db, refund.move.id, doc.move.id, date, targetAmount, doc.multiInstallment ? { lineIndex: doc.lineIndex } : {});
  }
  const invoices = items.filter(({ move }) => isInvoice(move));
  if (invoices.length !== 1) throw new Error('Select one invoice counterpart and one payment counterpart');
  const [invoice] = invoices;
  const source = items.find((item) => item !== invoice);
  if (source.line.account_id !== invoice.line.account_id || source.line.partner_id !== invoice.line.partner_id) throw new Error('Selected items must have the same account and partner');
  if (!invoice.counterpart) throw new Error('Select the invoice receivable or payable item');
  const payments = search(db, 'account.payment').filter((p) => p.move_id === source.move.id && p.state === 'posted');
  if (payments.length !== 1) throw new Error('The selected entry must have an explicit posted payment link');
  if (date < (invoice.move.invoice_date ?? '')) throw new Error('Reconciliation date cannot be before the invoice date');
  const targetAmount = installmentTargetAmount(invoice, amount);
  return applyPaymentCredit(db, payments[0].id, invoice.move.id, date, targetAmount, invoice.multiInstallment ? { lineIndex: invoice.lineIndex } : {});
}

/** Write off only an explicitly selected document counterpart, using explicit journal/account choices. */
export function writeoffJournalItem(db, selections, { date, amount, journalId, accountId, label } = {}) {
  const items = selectedItems(db, selections);
  if (items.length !== 1 || !isInvoice(items[0].move) || !items[0].counterpart) throw new Error('Select one invoice receivable or payable item to write off');
  const [{ move, line, lineIndex, multiInstallment, lineResidual }] = items;
  if (!validDate(date) || date < (move.invoice_date ?? '')) throw new Error('Enter a valid write-off date on or after the invoice date');
  if (!journalId) throw new Error('Select a write-off journal');
  if (!accountId) throw new Error('Select a write-off account');
  const account = read(db, 'account.account', accountId);
  if (!account || account.active === false || account.deprecated || ['asset_receivable', 'liability_payable', 'off_balance'].includes(account.account_type) || accountId === line.account_id) throw new Error('Select an active write-off counterpart account, not a receivable or payable');
  const maxAmount = multiInstallment ? lineResidual : residual(move, db);
  if (!Number.isFinite(Number(amount)) || !(Number(amount) > 0) || Number(amount) > maxAmount) throw new Error('Enter a positive write-off amount within the remaining invoice balance');
  return settleWriteoff(db, move.id, Number(amount), toCompany(db, move.currency_id, Number(amount), date, move.company_id), date, {
    journalId,
    accountId,
    label,
    lineIndex: multiInstallment ? lineIndex : null,
  }).db;
}

/**
 * Filter active invoice settlement rows matching a selected installment, rejecting ambiguous shared settlements.
 * @param {object} db
 * @param {object} move
 * @param {number} lineIndex
 * @param {Set<number>} selectedIndices
 * @returns {object[]}
 */
function installmentRowsForUnreconcile(db, move, lineIndex, selectedIndices) {
  const allRows = (move.payments ?? []).filter((row) => !row.reversed);
  const targetedRows = allRows.filter((row) => !row.discount && row.line_index === lineIndex);
  const targetedIds = new Set(targetedRows.map((row) => row.move_id));
  const matchedTargeted = allRows.filter((row) => row.line_index === lineIndex
    || (row.discount && targetedIds.has(row.payment_move_id) && (!Number.isInteger(row.line_index) || row.line_index === lineIndex)));
  const targetedPayMoves = new Set(allRows.filter((row) => !row.discount && Number.isInteger(row.line_index)).map((row) => row.move_id));
  const untargetedRows = allRows.filter((row) => !Number.isInteger(row.line_index) && !(row.discount && targetedPayMoves.has(row.payment_move_id)));
  const { untargetedTouched } = installmentSettlementState(db, move);
  const touchesUntargeted = untargetedTouched.has(lineIndex);
  const allUntargetedSelected = [...untargetedTouched].every((idx) => selectedIndices.has(idx));
  if (matchedTargeted.length) {
    return touchesUntargeted && allUntargetedSelected
      ? [...new Set([...matchedTargeted, ...untargetedRows])]
      : matchedTargeted;
  }
  if (touchesUntargeted) {
    if (!allUntargetedSelected) {
      throw new Error('This settlement covers multiple installments; unreconcile from the payment item or select all settled installments');
    }
    return untargetedRows;
  }
  throw new Error('The selected installment has no active settlements');
}

/** Release the selected settlements through their owning bank/payment reversal workflow. */
export function unreconcileJournalItems(db, selections, { date } = {}) {
  const items = selectedItems(db, selections);
  if (!validDate(date)) throw new Error('Enter a valid reversal date');
  const selectedIndicesByMove = new Map();
  for (const item of items) {
    if (!item.multiInstallment) continue;
    const set = selectedIndicesByMove.get(item.move.id) ?? new Set();
    set.add(item.lineIndex);
    selectedIndicesByMove.set(item.move.id, set);
  }
  const unapplications = new Map();
  const bankIds = new Set();
  const writeoffs = new Map();
  for (const { move, line, lineIndex, counterpart, multiInstallment } of items) {
    if (isInvoice(move) && !counterpart) throw new Error('Select the invoice receivable or payable item');
    const rows = isInvoice(move)
      ? (multiInstallment
        ? installmentRowsForUnreconcile(db, move, lineIndex, selectedIndicesByMove.get(move.id) ?? new Set())
        : (move.payments ?? []).filter((row) => !row.reversed))
      : [];
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
      : sourceIds.has(b.bank_move_id) || sourceIds.has(b.payment_move_id) || payments.some((p) => statementPaymentIds(db, b).includes(p.id))
        || (b.allocations ?? []).some((a) => sourceIds.has(a.payment_move_id) || sourceIds.has(a.writeoff_move_id))));
    if (!isInvoice(move) && !banks.length && !applications.length) throw new Error('The selected item has no active settlement');
    if (!isInvoice(move) && !counterpart && !isPaymentOutstanding && !banks.some((b) => read(db, 'account.journal', b.journal_id)?.suspense_account_id === line.account_id)) throw new Error('Select a linked receivable, payable, outstanding or suspense item');
    for (const bank of banks) bankIds.add(bank.id);
    const bankMatched = (moveId) => banks.some((b) => b.bank_move_id === moveId || b.payment_move_id === moveId
      || (b.allocations ?? []).some((a) => a.payment_move_id === moveId || a.writeoff_move_id === moveId)
      || statementPaymentIds(db, b).some((id) => payments.some((p) => p.id === id && p.move_id === moveId)));
    // Unreconcile only removes the matching: payments stay posted and their credit becomes available again.
    if ((counterpart || isPaymentOutstanding) && !isInvoice(move) && payments.length && !bankMatched(move.id)) {
      for (const invoice of applications) {
        for (const row of (invoice.payments ?? []).filter((r) => !r.reversed && r.move_id === move.id)) {
          const targetIndex = Number.isInteger(row.line_index) ? row.line_index : null;
          unapplications.set(`${invoice.id}:${move.id}:${targetIndex ?? ''}`, { invoiceId: invoice.id, moveId: move.id, lineIndex: targetIndex });
        }
      }
    }
    for (const row of rows) {
      if (row.discount && payments.some((p) => p.move_id === row.payment_move_id)) continue;
      if (bankMatched(row.move_id)) continue;
      const targetIndex = Number.isInteger(row.line_index) ? row.line_index : null;
      if (payments.some((p) => p.move_id === row.move_id)) {
        unapplications.set(`${move.id}:${row.move_id}:${targetIndex ?? ''}`, { invoiceId: move.id, moveId: row.move_id, lineIndex: targetIndex });
        continue;
      }
      const source = read(db, 'account.move', row.move_id);
      if (source?.move_type !== 'entry' || row.discount) throw new Error('This settlement must be reversed from its originating document workflow');
      writeoffs.set(`${move.id}:${row.move_id}:${targetIndex ?? ''}`, { invoiceId: move.id, moveId: row.move_id, lineIndex: targetIndex });
    }
    if (!isInvoice(move) && !payments.length && !banks.length) {
      if (applications.length !== 1) throw new Error('No uniquely linked settlement can be unreconciled for this item');
      const matchedRows = (applications[0].payments ?? []).filter((r) => !r.reversed && r.move_id === move.id);
      for (const row of matchedRows) {
        const targetIndex = Number.isInteger(row.line_index) ? row.line_index : null;
        writeoffs.set(`${applications[0].id}:${move.id}:${targetIndex ?? ''}`, { invoiceId: applications[0].id, moveId: move.id, lineIndex: targetIndex });
      }
    }
    if (isInvoice(move) && !rows.length) throw new Error('The selected invoice has no active settlements');
  }
  // These functions return immutable snapshots: publish nothing unless the whole operation succeeds.
  let next = db;
  for (const id of bankIds) next = unreconcile(next, read(next, 'account.bank.statement.line', id), date).db;
  for (const { invoiceId, moveId, lineIndex } of unapplications.values()) next = unapplyPaymentCredit(next, invoiceId, moveId, date, { lineIndex });
  for (const { invoiceId, moveId, lineIndex } of writeoffs.values()) next = reverseWriteoff(next, invoiceId, moveId, date, { lineIndex });
  return next;
}

/** Whether a document's invoice date is later than the payment date, so the payment cannot settle it. */
const invoiceAfterPayment = (move, date) => Boolean(move.invoice_date && move.invoice_date > date);

/**
 * Post a draft payment. With an invoice it pays that invoice; otherwise one entry is booked for the whole amount
 * and stays as unapplied credit (matching happens explicitly via reconciliation or credit widgets).
 */
export function postPayment(db, p) {
  if (p.state !== 'draft') throw new Error('Only draft payments can be confirmed');

  if (p.is_internal_transfer) {
    if (!Number.isFinite(Number(p.amount)) || !(Number(p.amount) > 0)) {
      throw new Error('The amount must be a finite positive number');
    }
    const companyId = p.company_id ?? 1;
    const company = read(db, 'res.company', companyId);
    if (!company?.transfer_account_id) {
      throw new Error('Internal transfer account is not set for this company');
    }
    const transferAccount = read(db, 'account.account', company.transfer_account_id);
    if (!transferAccount || transferAccount.active === false || (!shared(transferAccount.company_id) && transferAccount.company_id !== companyId) || transferAccount.account_type !== 'asset_current' || !transferAccount.reconcile) {
      throw new Error('Internal transfer account must be an active, reconcilable current-asset account of the company');
    }
    const companyCurrency = companyCurrencyRecord(db, companyId);
    if (transferAccount.currency_id && transferAccount.currency_id !== companyCurrency.id) {
      throw new Error('Internal transfer account currency must match the company currency');
    }
    if (!p.journal_id) throw new Error('Select a source journal');
    if (!p.destination_journal_id) throw new Error('Select a destination journal');
    if (p.journal_id === p.destination_journal_id) {
      throw new Error('The destination journal must be different from the source journal');
    }

    const sourceJournal = read(db, 'account.journal', p.journal_id);
    const destJournal = read(db, 'account.journal', p.destination_journal_id);
    if (!sourceJournal || !['bank', 'cash'].includes(sourceJournal.type)) {
      throw new Error('The source journal must be a bank or cash journal');
    }
    if (!destJournal || !['bank', 'cash'].includes(destJournal.type)) {
      throw new Error('The destination journal must be a bank or cash journal');
    }
    if ((sourceJournal.company_id ?? 1) !== companyId || (destJournal.company_id ?? 1) !== companyId) {
      throw new Error('The destination journal must belong to the same company');
    }

    const date = p.date ?? today();
    const companyRound = (n) => roundCurrency(n, companyCurrency);
    const isForeignCurrency = !!p.currency_id && p.currency_id !== companyCurrency.id;
    const rawAmount = Number(p.amount);
    const amount = isForeignCurrency
      ? toCompany(db, p.currency_id, rawAmount, date, companyId)
      : companyRound(rawAmount);

    const sourceVia = paymentJournal(db, sourceJournal.id, companyId);
    const sourceOutstanding = outstandingAccount(db, sourceJournal, companyId, false);
    const sourceLiquidity = sourceOutstanding ?? sourceVia.accountId;

    const destVia = paymentJournal(db, destJournal.id, companyId);
    const destOutstanding = outstandingAccount(db, destJournal, companyId, true);
    const destLiquidity = destOutstanding ?? destVia.accountId;

    const explicitName = p.name && p.name !== '/' ? p.name : null;
    const preName = explicitName ?? paymentName(db, sourceJournal, date);

    const payCurrency = isForeignCurrency ? read(db, 'res.currency', p.currency_id) : null;
    const foreignDocAmount = isForeignCurrency ? roundCurrency(rawAmount, payCurrency) : null;
    const transferFx = (sign) =>
      isForeignCurrency ? { currency_id: p.currency_id, amount_currency: sign * foreignDocAmount } : {};

    const sourceLiqCurrency = sourceJournal.currency_id ?? p.currency_id ?? null;
    const sourceLiqFx = (sign) => liquidityForeignFields(db, {
      currencyId: sourceLiqCurrency, companyAmount: amount * sign, date, companyId,
      docAmount: isForeignCurrency && sourceLiqCurrency === p.currency_id ? sign * foreignDocAmount : null,
    });

    const destLiqCurrency = destJournal.currency_id ?? p.currency_id ?? null;
    const destLiqFx = (sign) => liquidityForeignFields(db, {
      currencyId: destLiqCurrency, companyAmount: amount * sign, date, companyId,
      docAmount: isForeignCurrency && destLiqCurrency === p.currency_id ? sign * foreignDocAmount : null,
    });

    const { db: sourceBooked, id: sourceMoveId } = postEntry(db, {
      journal: sourceVia.code,
      journal_id: sourceJournal.id,
      date,
      ref: p.memo || preName,
      company: companyId,
      lines: [
        { account: transferAccount.id, debit: amount, credit: 0, partner_id: null, ...transferFx(1) },
        { account: sourceLiquidity, debit: 0, credit: amount, partner_id: null, ...sourceLiqFx(-1) },
      ],
    });

    const { db: destBooked, id: destMoveId } = postEntry(sourceBooked, {
      journal: destVia.code,
      journal_id: destJournal.id,
      date,
      ref: p.memo || preName,
      company: companyId,
      lines: [
        { account: destLiquidity, debit: amount, credit: 0, partner_id: null, ...destLiqFx(1) },
        { account: transferAccount.id, debit: 0, credit: amount, partner_id: null, ...transferFx(-1) },
      ],
    });

    let recDb = destBooked;

    const sourceEntry = read(recDb, 'account.move', sourceMoveId);
    const destEntry = read(recDb, 'account.move', destMoveId);
    const sourceLineIdx = sourceEntry.line_ids.findIndex((l) => l.account_id === transferAccount.id && Number(l.debit) > 0);
    const destLineIdx = destEntry.line_ids.findIndex((l) => l.account_id === transferAccount.id && Number(l.credit) > 0);

    recDb = reconcileLedgerItems(recDb, [
      { move_id: sourceMoveId, line_index: sourceLineIdx, line_identity: journalItemIdentity(sourceEntry.line_ids[sourceLineIdx]) },
      { move_id: destMoveId, line_index: destLineIdx, line_identity: journalItemIdentity(destEntry.line_ids[destLineIdx]) },
    ], { date });

    const name = explicitName ?? paymentName(recDb, sourceJournal, date, read(recDb, 'account.move', sourceMoveId).name);
    const destName = paymentName(recDb, destJournal, date, read(recDb, 'account.move', destMoveId).name);

    const existingPaired = p.paired_internal_transfer_payment_id ? read(recDb, 'account.payment', p.paired_internal_transfer_payment_id) : null;
    const existingDestLine = existingPaired?.payment_method_line_id ? read(recDb, 'account.payment.method.line', existingPaired.payment_method_line_id) : null;
    const destMethodLineId = (existingDestLine && existingDestLine.journal_id === destJournal.id && existingDestLine.payment_type === 'inbound')
      ? existingDestLine.id
      : defaultPaymentMethodLineId(recDb, destJournal.id, 'inbound');

    const destVals = {
      name: destName, payment_type: 'inbound', partner_type: null, partner_id: null, is_internal_transfer: true,
      journal_id: destJournal.id, destination_journal_id: sourceJournal.id, amount: p.amount, currency_id: p.currency_id ?? null,
      date, memo: p.memo || null, state: 'posted', move_id: destMoveId, destination_move_id: sourceMoveId,
      outstanding_account_id: destOutstanding, unapplied: 0, company_id: companyId, paired_internal_transfer_payment_id: p.id,
      payment_method_line_id: destMethodLineId,
    };
    const created = existingPaired?.state === 'draft' ? null : create(recDb, 'account.payment', destVals);
    const destPaymentId = created ? created.id : existingPaired.id;
    const withDestPayment = created ? created.db : write(recDb, 'account.payment', destPaymentId, destVals);

    const currentMethodLine = p.payment_method_line_id ? read(withDestPayment, 'account.payment.method.line', p.payment_method_line_id) : null;
    const sourceMethodLineId = (currentMethodLine && currentMethodLine.journal_id === sourceJournal.id && currentMethodLine.payment_type === 'outbound')
      ? currentMethodLine.id
      : defaultPaymentMethodLineId(withDestPayment, sourceJournal.id, 'outbound');

    return write(withDestPayment, 'account.payment', p.id, {
      name,
      state: 'posted',
      payment_type: 'outbound',
      partner_type: null,
      partner_id: null,
      move_id: sourceMoveId,
      destination_move_id: destMoveId,
      journal_id: sourceJournal.id,
      outstanding_account_id: sourceOutstanding,
      unapplied: 0,
      paired_internal_transfer_payment_id: destPaymentId,
      payment_method_line_id: sourceMethodLineId,
    });
  }

  if (!p.partner_id) throw new Error('Set the partner');
  if (!Number.isFinite(Number(p.amount)) || !(Number(p.amount) > 0)) throw new Error('The amount must be a finite positive number');
  const bankError = recipientBankCompanyError(db, p);
  if (bankError) throw new Error(bankError);
  let currentPayment = p;
  if (!p.invoice_id && p.payment_type === 'outbound' && p.partner_type === 'supplier') {
    const resolvedBankId = resolveAndValidateRecipientBank(db, p.partner_id, p.partner_bank_id, { companyId: p.company_id ?? 1 });
    if (resolvedBankId && resolvedBankId !== p.partner_bank_id) {
      currentPayment = { ...p, partner_bank_id: resolvedBankId };
      db = write(db, 'account.payment', p.id, { partner_bank_id: resolvedBankId });
    }
  }
  const date = currentPayment.date ?? today();
  if (currentPayment.currency_id) {
    const curr = read(db, 'res.currency', currentPayment.currency_id);
    if (!curr || curr.active === false) throw new Error('The payment currency must be active');
  }
  if (currentPayment.invoice_id) {
    const invoice = read(db, 'account.move', currentPayment.invoice_id);
    if (!invoice || invoice.state !== 'posted' || !isInvoice(invoice)) throw new Error('Only posted invoices and bills can be paid');
    if (invoiceAfterPayment(invoice, date)) throw new Error(`The payment date cannot be before the invoice date of ${invoice.name}`);
  }
  const resolvedJournal = paymentJournal(db, currentPayment.journal_id, currentPayment.company_id ?? 1);
  const resolvedJournalRec = read(db, 'account.journal', resolvedJournal.id);
  if (isMethodLineJournal(resolvedJournalRec)) {
    if (!currentPayment.payment_method_line_id) throw new Error('Payment Method is required');
    const lineErr = paymentMethodLineError(db, { ...currentPayment, journal_id: resolvedJournal.id });
    if (lineErr) throw new Error(lineErr);
  }
  if (currentPayment.invoice_id) {
    const invoice = read(db, 'account.move', currentPayment.invoice_id);
    return payWithDiscount(db, invoice.id, Number(currentPayment.amount), date, {
      paymentId: currentPayment.id,
      journalId: resolvedJournal.id,
      memo: currentPayment.memo,
      currencyId: currentPayment.currency_id ?? invoice.currency_id ?? companyCurrencyRecord(db, invoice.company_id)?.id,
      ...(currentPayment.check_number != null ? { checkNumber: currentPayment.check_number } : {}),
      ...(currentPayment.partner_bank_id ? { partnerBankId: currentPayment.partner_bank_id } : {}),
      ...(currentPayment.payment_method_line_id ? { paymentMethodLineId: currentPayment.payment_method_line_id } : {}),
    });
  }
  const via = resolvedJournal;
  const journalRecord = resolvedJournalRec;
  const explicitName = currentPayment.name && currentPayment.name !== '/' ? currentPayment.name : null;
  const preName = explicitName ?? paymentName(db, journalRecord, date);
  const isTaxOrDirect = currentPayment.is_tax_payment || currentPayment.return_id || currentPayment.destination_account_id || currentPayment.destination_account_code;
  const inbound = currentPayment.payment_type === 'inbound';
  const journal = read(db, 'account.journal', via.id);
  const outstanding = outstandingAccount(db, journal, currentPayment.company_id ?? 1, inbound, currentPayment.payment_method_line_id);
  const liquidity = outstanding ?? via.accountId;
  let taxClosing = null;
  if (currentPayment.return_id || currentPayment.is_tax_payment) {
    const ret = read(db, 'account.return', currentPayment.return_id);
    const payCompanyId = currentPayment.company_id ?? 1;
    let companies = [];
    try { if (ret) companies = returnCompanies(db, ret); } catch { companies = []; }
    if (!ret || ret.state !== 'submitted' || !companies.includes(payCompanyId)) throw new Error('A submitted tax return is required for settlement');
    const obligations = taxClosingSpec(db, ret, payCompanyId).obligations ?? [];
    const expectedObligation = obligations.find((o) => (
      o.account_id === currentPayment.destination_account_id && o.partner_id === currentPayment.partner_id
    ));
    if (!expectedObligation || inbound !== (expectedObligation.amount < 0) || amountMismatch(currentPayment.amount, Math.abs(expectedObligation.amount))) {
      throw new Error('Payment must match the tax return obligation');
    }
    const matches = (ret.closing_move_ids ?? []).flatMap((id) => {
      const move = read(db, 'account.move', id);
      if (!move || move.state !== 'posted' || (move.company_id ?? 1) !== payCompanyId) return [];
      return (move.line_ids ?? []).map((line, index) => ({ move, line, index })).filter(({ line }) =>
        line.account_id === currentPayment.destination_account_id && line.partner_id === currentPayment.partner_id
        && round((Number(line.credit) || 0) - (Number(line.debit) || 0)) === expectedObligation.amount);
    });
    if (matches.length !== 1 || (matches[0].move.payments ?? []).some((row) => !row.reversed && (row.line_index == null || row.line_index === matches[0].index))) {
      throw new Error('An unsettled tax closing obligation is required');
    }
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
  const isForeignCurrency = !!currentPayment.currency_id && currentPayment.currency_id !== companyCurrency.id;
  // For foreign-currency payments: debit/credit in company currency; lines also carry currency_id + amount_currency.
  const rawAmount = Number(currentPayment.amount);
  const amount = isForeignCurrency
    ? toCompany(db, currentPayment.currency_id, rawAmount, date, currentPayment.company_id)
    : companyRound(rawAmount);
  const payCurrency = isForeignCurrency ? read(db, 'res.currency', currentPayment.currency_id) : null;
  const foreignDocAmount = isForeignCurrency ? roundCurrency(rawAmount, payCurrency) : null;
  // Counterpart line keeps the payment currency; liquidity line derives from the journal currency.
  const counterpartFx = (sign) =>
    isForeignCurrency ? { currency_id: currentPayment.currency_id, amount_currency: sign * foreignDocAmount } : {};
  const liquidityCurrency = journal.currency_id ?? currentPayment.currency_id ?? null;
  const liquidityFx = (sign) => liquidityForeignFields(db, {
    currencyId: liquidityCurrency, companyAmount: amount * sign, date, companyId: currentPayment.company_id,
    docAmount: isForeignCurrency && liquidityCurrency === currentPayment.currency_id ? sign * foreignDocAmount : null,
  });
  const { db: booked, id: moveId } = postEntry(db, {
    journal: via.code, journal_id: journal.id, date, ref: currentPayment.memo || preName,
    lines: inbound
      ? [{ account: liquidity, debit: amount, partner_id: currentPayment.partner_id, ...liquidityFx(1) },
         { account: counterpart, credit: amount, partner_id: currentPayment.partner_id, ...counterpartFx(-1) }]
      : [{ account: counterpart, debit: amount, partner_id: currentPayment.partner_id, ...counterpartFx(1) },
         { account: liquidity, credit: amount, partner_id: currentPayment.partner_id, ...liquidityFx(-1) }],
    company: currentPayment.company_id ?? 1,
    is_tax_payment: Boolean(currentPayment.is_tax_payment || currentPayment.return_id),
    tax_return_id: currentPayment.return_id ?? null,
  });
  const name = explicitName ?? paymentName(booked, journal, date, read(booked, 'account.move', moveId).name);
  const registered = write(booked, 'account.payment', p.id, {
    name, state: 'posted', move_id: moveId, journal_id: via.id, outstanding_account_id: outstanding,
    payment_method_line_id: currentPayment.payment_method_line_id,
    unapplied: isTaxOrDirect ? 0 : amount,
  });
  const settled = taxClosing ? write(registered, 'account.move', taxClosing.move.id, {
    amount_paid: companyRound((Number(taxClosing.move.amount_paid) || 0) + amount), payment_date: date,
    payments: [...(taxClosing.move.payments ?? []), { date, amount, move_id: moveId, company_amount: amount, line_index: taxClosing.index }],
  }) : registered;
  return settled;
}

/**
 * Allocate an available amount of payment credit against an invoice's residual balance.
 * Returns { db, left, taken }.
 */
export function allocatePaymentToInvoice(db, payment, invoice, availableCredit, date = today(), requestedAmount = null, { lineIndex = null } = {}) {
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
    const counterpartForced = valueOnlyCurrencyFields(withFx, counterpart, invoice.company_id, invoice.currency_id);
    const fxJournalId = exchangeJournal(withFx, invoice.company_id).id;
    const fx = postEntry(withFx, {
      journal_id: fxJournalId, journal: fxJournalId, company: invoice.company_id ?? 1, date, ref: `Exchange difference ${payment.name}`,
      archivedOriginIds: [invoice.id, ...(payment.move_id ? [payment.move_id] : [])],
      lines: diff > 0
        ? [{ account: counterpart, debit: diff, partner_id: payment.partner_id, ...counterpartForced }, { account: exchangeAccount(withFx, invoice.company_id, diff), credit: diff }]
        : [{ account: counterpart, credit: -diff, partner_id: payment.partner_id, ...counterpartForced }, { account: exchangeAccount(withFx, invoice.company_id, diff), debit: -diff }],
    });
    withFx = { ...fx.db, records: { ...fx.db.records, 'account.move': fx.db.records['account.move'].map((entry) => entry.id === fx.id ? { ...entry, fx_payment_move_id: moveId, fx_invoice_id: invoice.id } : entry) } };
    fxMove = fx.id;
  }
  const settled = appendDocumentSettlement(withFx, invoice.id, {
    amount: take,
    moveId,
    date,
    companyAmount,
    paymentCompanyAmount: cashAmount,
    paymentFxMoveId: fxMove,
    lineIndex,
    partnerBankId: payment.partner_bank_id,
    final: take >= invResidual,
    note: `Payment ${payment.name} applied: ${take}`,
  }).db;
  return {
    db: settled,
    left: companyRound(availableCredit - cashAmount),
    taken: take,
  };
}

/**
 * Apply an outstanding (unapplied) payment credit to an open invoice of the same commercial partner and company.
 */
export function applyPaymentCredit(db, paymentIdOrRec, invoiceIdOrRec, date = today(), amount = null, options = {}) {
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
  if (['exception', 'no'].includes(shouldBePaid(db, invoice))) {
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

  const { db: nextDb, left, taken } = allocatePaymentToInvoice(db, payment, invoice, availableCredit, appDate, amount, options);
  if (!(taken > 0)) throw new Error('Could not allocate payment credit to invoice');

  const withPayment = write(nextDb, 'account.payment', payment.id, { unapplied: left });
  return postNote(withPayment, 'account.payment', payment.id, `Applied ${money(taken)} credit to ${invoice.name}`);
}

/** Validate an exact application inverse before any journal entry or balance is changed. */
export function paymentUnapplication(db, invoiceId, paymentMoveId, date, { lineIndex = null, partialReconcileId = null, rowId = null, ctx = null } = {}) {
  const invoice = read(db, 'account.move', invoiceId);
  const byPartial = partialReconcileId != null;
  const matches = (invoice?.payments ?? []).filter((row) => !row.reversed
    && (rowId != null ? row.id === rowId : true)
    && (byPartial ? row.partial_reconcile_id === partialReconcileId && (paymentMoveId == null || row.move_id === paymentMoveId) : row.move_id === paymentMoveId)
    && (!Number.isInteger(lineIndex) || row.line_index === lineIndex));
  const targetMoveId = byPartial ? (paymentMoveId ?? matches[0]?.move_id) : paymentMoveId;
  const payments = targetMoveId != null ? search(db, 'account.payment').filter((p) => p.move_id === targetMoveId && p.state === 'posted') : [];
  if (!isInvoice(invoice) || invoice?.state !== 'posted' || matches.length !== 1 || (byPartial ? payments.length > 1 : payments.length !== 1)) {
    throw new Error(byPartial ? 'Select one active partial reconciliation settlement' : 'Select one active application of a posted payment');
  }
  const [row] = matches;
  const payment = payments[0] ?? null;
  if (!validDate(date) || date < row.date) throw new Error('Enter an unapplication date on or after the application date');
  const source = read(db, 'account.move', targetMoveId);
  if (payment) {
    if ((payment.company_id ?? 1) !== (invoice.company_id ?? 1) || !sameCommercialPartner(db, payment.partner_id, invoice.partner_id)) {
      throw new Error('Payment and invoice must belong to the same company and partner');
    }
  } else if (!source || (source.company_id ?? 1) !== (invoice.company_id ?? 1)) {
    throw new Error('Reconciled entry and invoice must belong to the same company');
  }
  if (row.discount || payment?.return_id || payment?.is_tax_payment) throw new Error('Unapply this settlement from its originating document workflow');
  const bookedPayment = payment
    ? (byPartial && row.payment_company_amount == null ? 0 : paymentCompanyAmount(db, invoice, row))
    : 0;
  if (payment && (!byPartial || row.payment_company_amount != null) && !(bookedPayment > 0)) {
    throw new Error('The application payment company amount cannot be determined from its booked entry; repair the settlement link first');
  }
  if (source?.state !== 'posted' || (!byPartial && search(db, 'account.move').some((m) => m.state !== 'cancel' && m.reversed_entry_id === targetMoveId))) {
    throw new Error(byPartial ? 'The reconciled counterpart entry must remain posted' : 'The payment entry must remain posted and unreversed');
  }
  const fxError = settlementFxError(db, invoice, row);
  if (fxError) throw new Error(fxError);
  for (const id of [row.payment_fx_move_id, row.cash_basis_move_id].filter(Boolean)) {
    const entry = read(db, 'account.move', id);
    if (entry?.state !== 'posted' || entry.move_type !== 'entry' || (entry.company_id ?? 1) !== (invoice.company_id ?? 1) || date < entry.invoice_date || search(db, 'account.move').some((m) => m.state !== 'cancel' && m.reversed_entry_id === id)) throw new Error('The linked exchange or cash-basis entry cannot be reversed on this date');
    const journal = read(db, 'account.journal', entry.journal_id);
    if (!journal) throw new Error('The linked settlement journal is missing');
  }
  const discounts = byPartial ? [] : (invoice.payments ?? []).filter((r) => r.discount && !r.reversed && r.payment_move_id === targetMoveId && (!Number.isInteger(lineIndex) || !Number.isInteger(r.line_index) || r.line_index === lineIndex));
  for (const d of discounts) {
    const entry = read(db, 'account.move', d.move_id);
    if (entry?.state !== 'posted' || entry.move_type !== 'entry' || (entry.company_id ?? 1) !== (invoice.company_id ?? 1) || date < entry.invoice_date || search(db, 'account.move').some((m) => m.state !== 'cancel' && m.reversed_entry_id === d.move_id)) throw new Error('The linked discount entry cannot be reversed on this date');
    const journal = read(db, 'account.journal', entry.journal_id);
    if (!journal) throw new Error('The linked settlement journal is missing');
  }
  const discountAmount = discounts.reduce((sum, d) => sum + Number(d.amount), 0);
  const discountSet = new Set(discounts);
  // An unapplied row is inactive like a reversed one, but the payment itself stays posted: no reversing entry exists.
  const paymentsAfter = invoice.payments.map((p) => {
    if (p === row) return { ...p, reversed: true, unapplied: true, reversal_date: date };
    if (discountSet.has(p)) return { ...p, reversed: true, reversal_date: date };
    return p;
  });
  const invoiceValues = {
    amount_paid: Math.max(0, roundCurrency(Number(invoice.amount_paid) - Number(row.amount) - discountAmount, documentCurrency(db, invoice))),
    payments: paymentsAfter,
    payment_date: paymentsAfter.filter((p) => !p.reversed).at(-1)?.date ?? null,
  };
  const unapplied = payment && bookedPayment > 0
    ? roundCurrency(Number(payment.unapplied) + bookedPayment, companyCurrencyRecord(db, invoice.company_id))
    : null;
  const lockError = (unapplied != null ? datedLockGuard(['unapplied'], (p) => p.state === 'posted')(db, payment, { ...payment, unapplied }, ctx) : null)
    ?? lockedSettlementInvariant(db, { ...invoice, ...invoiceValues }, invoice, ctx)
    ?? (byPartial ? datedLockGuard(['reversal_date'], () => true)(db, { ...invoice, date: row.date }, { ...invoice, date, reversal_date: date }, ctx) : null);
  if (lockError) throw new Error(lockError);
  return { invoice, row, payment, discounts, invoiceValues, unapplied };
}

/** Remove a matching, not its payment: restore credit and reverse only application-specific FX and cash basis. */
export function unapplyPaymentCredit(db, invoiceId, paymentMoveId, date = today(), options = {}) {
  const { invoice, row, payment, discounts, invoiceValues, unapplied } = paymentUnapplication(db, invoiceId, paymentMoveId, date, options);
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
  if (payment && unapplied != null) next = write(next, 'account.payment', payment.id, { unapplied });
  return write(next, 'account.move', invoice.id, { ...invoiceValues, payments: paymentsFinal });
}

/**
 * Unreconcile one applied payment from one invoice or bill (invoice form, payments tab). The payment stays posted and its
 * credit is released through unapplyPaymentCredit, as unreconciling from journal items does: a bank match or a posted
 * batch stays on the payment, which simply becomes outstanding again. Nothing dated inside a lock period changes.
 */
export function unreconcileInvoicePayment(db, invoiceId, paymentMoveId, { date = null, lineIndex = null, rowId = null, ctx = null } = {}) {
  const invoice = read(db, 'account.move', invoiceId);
  if (!isInvoice(invoice) || invoice.state !== 'posted') throw new Error('Only posted invoices and bills have payments to unreconcile');
  const row = (invoice.payments ?? []).find((r) => !r.reversed
    && (rowId != null ? r.id === rowId : true)
    && (paymentMoveId != null ? r.move_id === paymentMoveId : true)
    && (!Number.isInteger(lineIndex) || r.line_index === lineIndex));
  if (!row) throw new Error('Select one active application of a posted payment');
  const on = date ?? [today(), row.date].filter(Boolean).sort().at(-1);
  if (row.partial_reconcile_id != null) {
    return unreconcilePartialReconcile(db, row.partial_reconcile_id, { date: on, rowId: row.id });
  }
  for (const move of [invoice, read(db, 'account.move', paymentMoveId)].filter(Boolean)) {
    const lock = recordLockDate(db, move, ctx);
    if (lock && on <= lock) throw new Error(`The period up to ${lock} is locked`);
  }
  return unapplyPaymentCredit(db, invoiceId, paymentMoveId, on, { lineIndex: Number.isInteger(lineIndex) ? lineIndex : null, rowId: row.id, ctx });
}

/** Open documents a grouped or single Register Payment can settle: customer invoices/refunds or vendor bills/refunds. */
const REGISTERABLE_TYPES = ['out_invoice', 'out_refund', 'in_invoice', 'in_refund'];

/** Resolve the selected invoices or bills for Register Payment, or refuse the selection with a clear message. */
export function paymentDocuments(db, ids) {
  const docs = [...new Set(ids ?? [])].map((id) => read(db, 'account.move', id));
  if (!docs.length || docs.some((d) => !d)) throw new Error('Select posted invoices or bills to register a payment');
  if (docs.some((d) => !REGISTERABLE_TYPES.includes(d.move_type))) throw new Error('Only customer invoices, credit notes and vendor bills can be paid together');
  if (new Set(docs.map((d) => isPurchase(d))).size > 1) throw new Error('Customer invoices and vendor bills cannot be paid together');
  if (docs.some((d) => d.state !== 'posted')) throw new Error('Only posted invoices and bills can be paid; remove drafts and cancelled documents from the selection');
  if (new Set(docs.map((d) => d.company_id ?? 1)).size > 1) throw new Error('Documents of different companies cannot be paid together');
  if (docs.some((d) => !(residual(d, db) > 0))) throw new Error('Remove fully paid documents from the selection');
  return docs;
}

/** Group documents according to the payment's partner and accounting constraints. */
export function paymentDocumentGroups(db, docs, grouped = true) {
  const groups = new Map();
  for (const doc of docs) {
    const key = grouped
      ? JSON.stringify([doc.partner_id, invoiceCounterpartAccount(db, doc), doc.currency_id ?? companyCurrencyRecord(db, doc.company_id)?.id ?? null, doc.partner_bank_id ?? null])
      : doc.id;
    groups.set(key, [...(groups.get(key) ?? []), doc]);
  }
  return groups;
}

/** Compute cash specs and requirements for a payment group after applying any selected credit notes. */
export function groupPaymentRequirement(db, group, date = today()) {
  const invoices = group.filter((d) => !isRefund(d));
  const creditNotes = group.filter((d) => isRefund(d));
  let next = db;
  for (const note of creditNotes) {
    const candidateInvoices = note.reversed_entry_id
      ? [...invoices.filter((i) => i.id === note.reversed_entry_id), ...invoices.filter((i) => i.id !== note.reversed_entry_id)]
      : invoices;
    for (const inv of candidateInvoices) {
      const noteOpen = residual(read(next, 'account.move', note.id), next);
      if (!(noteOpen > 0)) break;
      const invOpen = residual(read(next, 'account.move', inv.id), next);
      if (!(invOpen > 0)) continue;
      const take = Math.min(noteOpen, invOpen);
      next = applyCreditNote(next, note.id, inv.id, date, take);
    }
  }
  const openInvoices = invoices.filter((d) => residual(read(next, 'account.move', d.id), next) > 0);
  const invSpecs = openInvoices.map((inv) => {
    const currentInv = read(next, 'account.move', inv.id);
    const openAmount = residual(currentInv, next);
    const discount = Math.min(openAmount, discountAvailable(next, currentInv, date));
    const docCurr = documentCurrency(next, currentInv);
    const cash = roundCurrency(openAmount - discount, docCurr);
    return { id: inv.id, openAmount, discount, cash };
  });
  const unappliedNotes = creditNotes.reduce((sum, n) => sum + residual(read(next, 'account.move', n.id), next), 0);
  const leadDoc = openInvoices[0] || invoices[0] || group[0];
  const docCurr = leadDoc ? documentCurrency(next, leadDoc) : null;
  const totalCashAmount = roundCurrency(invSpecs.reduce((sum, s) => sum + s.cash, 0), docCurr);
  const net = totalCashAmount - unappliedNotes;
  return { db: next, invSpecs, totalCashAmount, net };
}

/** Net cash due for selected documents on a payment date. */
export function paymentDocumentsNetAmount(db, docs, date = today()) {
  const groups = paymentDocumentGroups(db, docs);
  let total = 0;
  for (const group of groups.values()) {
    total += groupPaymentRequirement(db, group, date).net;
  }
  return total;
}

/**
 * Register payments for several invoices or bills. Grouped: one payment per partner, receivable/payable account, currency
 * and recipient bank, paying all of that group's documents in full; ungrouped: one payment per document. Every payment is
 * created by the single-document registerPayment on the first document of its group; the others receive its credit
 * through applyPaymentCredit. Returns the new database, or throws without changing the given one.
 */
export function registerPayments(db, ids, values = {}) {
  const docs = paymentDocuments(db, ids);
  const grouped = values.group_payment !== false;
  if (!grouped && docs.some((d) => isRefund(d))) {
    throw new Error('Credit notes can only be paid when Group Payments is enabled');
  }
  const groups = paymentDocumentGroups(db, docs, grouped);
  const requestedAmount = groups.size === 1 && values.amount != null ? promptedAmount(values.amount) : null;
  if (groups.size === 1 && values.amount != null && requestedAmount == null) throw new Error('Enter a payment amount greater than zero');
  let next = db;
  for (const group of groups.values()) {
    const paymentDate = values.date || today();
    const { db: afterNotesDb, invSpecs, totalCashAmount, net } = groupPaymentRequirement(next, group, paymentDate);
    if (!(net > 0)) throw new Error('The net payment amount must be greater than zero');
    next = afterNotesDb;
    if (!invSpecs.length) continue;

    const [leadSpec, ...restSpecs] = invSpecs;
    const lead = read(next, 'account.move', leadSpec.id);
    const amount = requestedAmount ?? totalCashAmount;
    const partial = amount < totalCashAmount;
    const leadCash = Math.min(amount, leadSpec.cash);
    const restCash = roundCurrency(Math.max(0, amount - leadCash), documentCurrency(next, lead));
    const memo = values.memo || (group.length > 1 ? group.map((d) => d.name).join(', ') : undefined);
    next = registerPayment(next, lead, {
      amount: String(amount),
      date: values.date,
      journal_id: values.journal_id,
      currency_id: lead.currency_id ?? undefined,
      partner_bank_id: values.partner_bank_id ?? null,
      payment_method_line_id: values.payment_method_line_id,
      settleAmount: leadCash,
      excessAmount: restCash,
      ...(memo !== undefined ? { memo } : {}),
    }).db;
    if (restSpecs.length) {
      const moveId = read(next, 'account.move', lead.id).payments.filter((p) => !p.discount).at(-1).move_id;
      const payment = search(next, 'account.payment').find((p) => p.move_id === moveId && p.state === 'posted');
      for (const spec of restSpecs) {
        const paymentRec = read(next, 'account.payment', payment.id);
        const available = Number(paymentRec?.unapplied) || 0;
        let allocated = 0;
        const inv = read(next, 'account.move', spec.id);
        const docCurr = documentCurrency(next, inv);
        if (spec.cash > 0 && available > 0) {
          const rate = rateAt(next, inv.currency_id, paymentDate, inv.company_id);
          const step = Number(docCurr?.rounding ?? 0.01);
          if (Math.floor((available * rate / step) + 1e-9) * step > 0) {
            const openBefore = residual(inv, next);
            next = applyPaymentCredit(next, payment.id, spec.id, paymentDate, spec.cash);
            const openAfter = residual(read(next, 'account.move', spec.id), next);
            allocated = roundCurrency(openBefore - openAfter, docCurr);
          }
        }
        if (spec.discount > 0 && allocated >= spec.cash) {
          next = bookEarlyDiscount(next, spec.id, spec.discount, paymentDate, payment.move_id);
        }
      }
    }
    for (const doc of partial ? [] : group) {
      if (residual(read(next, 'account.move', doc.id), next) > 0) throw new Error('The payment could not settle every selected document; nothing was registered');
    }
  }
  return { db: next };
}

/** Reconcile each open line of a source entry on a reconcilable account with its mirror line on the reversal. */
export function reconcileReversalLines(db, sourceId, reversalId, date) {
  const source = read(db, 'account.move', sourceId);
  const reversal = read(db, 'account.move', reversalId);
  const reconciled = reconciledJournalItems(db, source);
  return source.line_ids.reduce((acc, line, i) => {
    const mirror = reversal.line_ids?.[i];
    const expected = stornoLine({ debit: line.credit, credit: line.debit }, reversal.is_storno);
    if (!mirror || mirror.account_id !== line.account_id || (Number(mirror.debit) || 0) !== (Number(expected.debit) || 0) || (Number(mirror.credit) || 0) !== (Number(expected.credit) || 0)) return acc;
    if (!isReconcilableAccount(read(acc, 'account.account', line.account_id)) || reconciled[i]?.reconciled) return acc;
    if (!(Number(line.debit) || Number(line.credit))) return acc;
    return reconcileLedgerItems(acc, [
      { move_id: source.id, line_index: i, line_identity: journalItemIdentity(line) },
      { move_id: reversal.id, line_index: i, line_identity: journalItemIdentity(mirror) },
    ], { date });
  }, db);
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
  const reachesSettlementFx = isExchangeEntry(db, source);
  if (reachesSettlementFx) {
    if (source.reversed_entry_id || !opts.reconciliation_reversal) {
      throw new Error('An exchange difference entry linked to a settlement cannot be reversed independently');
    }
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
    is_storno: Boolean(read(db, 'res.company', companyId)?.account_storno),
    ...(opts.scheduled && opts.reconciliation_reversal ? { reconciliation_reversal: true } : {}),
    ...(source.cash_basis_origin_move_id ? { cash_basis_origin_move_id: source.cash_basis_origin_move_id } : {}),
    ...(source.cash_basis_base_grid ? { cash_basis_base_grid: true } : {}),
    partner_id: source.partner_id ?? null,
    ...(source.currency_id ? { currency_id: source.currency_id } : {}),
    name: opts.scheduled ? '/' : nextName(db, 'account.move', `${code}/${date.slice(0, 4)}/`),
    company_id: companyId,
    line_ids: (source.line_ids ?? []).map((l) => stornoLine({
      ...l,
      debit: l.credit,
      credit: l.debit,
      ...(l.currency_id ? { amount_currency: -(Number(l.amount_currency) || 0) } : {}),
      ...(l.tax_zero || l.tax_base_signed ? { tax_base: -(Number(l.tax_base) || 0) } : {}),
      name: `Reversal: ${l.name ?? ''}`.trim(),
    }, Boolean(read(db, 'res.company', companyId)?.account_storno))),
  }, { archivedOriginIds: [source.id] });
  let next = opts.scheduled ? created.db : postAnalytic(created.db, created.id);
  const currentSource = read(next, 'account.move', source.id);
  if (currentSource && !currentSource.inalterable_hash) {
    next = write(next, 'account.move', source.id, { reversal_move_id: created.id });
  }
  next = postNote(next, 'account.move', source.id, opts.scheduled ? `Reversal scheduled for ${date}` : `Reversed by ${read(next, 'account.move', created.id).name}`);
  if (!opts.scheduled && !reachesSettlementFx && !opts.reconciliation_reversal) next = reconcileReversalLines(next, source.id, created.id, date);
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
  const reversal = postEntry(db, { journal: original.journal_id ?? 'MISC', date, ref: `Cash basis taxes ${invoice.name}`, lines, company, archivedOriginIds: [original.id, invoice.id], includeCashBasisTargets: true });
  return write(reversal.db, 'account.move', reversal.id, {
    reversed_entry_id: original.id,
    cash_basis_origin_move_id: invoice.id,
    ...(original.cash_basis_base_grid ? { cash_basis_base_grid: true } : {}),
  });
}

/** Reverse a write-off settlement without changing unrelated invoice applications. */
export function reverseWriteoff(db, invoiceId, moveId, date, { lineIndex = null } = {}) {
  const invoice = read(db, 'account.move', invoiceId);
  const row = (invoice?.payments ?? []).find((p) => p.move_id === moveId && !p.reversed && (!Number.isInteger(lineIndex) || p.line_index === lineIndex));
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
export function reversePayment(db, p, date = today(), options = {}) {
  if (p.state !== 'posted' || !p.move_id) throw new Error('Only posted payments can be reversed');
  if (p.return_id || p.is_tax_payment) throw new Error('Tax return payments cannot be reversed independently');

  if (p.is_internal_transfer) {
    if (!p.destination_move_id) throw new Error('Internal transfer destination entry is missing');
    const sourceEntry = read(db, 'account.move', p.move_id);
    const destEntry = read(db, 'account.move', p.destination_move_id);
    if (!sourceEntry || !destEntry) throw new Error('Transfer entries not found');

    const paired = p.paired_internal_transfer_payment_id ? read(db, 'account.payment', p.paired_internal_transfer_payment_id) : null;
    const fromBank = isPaymentMatched(db, p, options?.excludeLineId)
      || (paired && isPaymentMatched(db, paired, options?.excludeLineId))
      || bookedByBank(db, p.move_id)
      || bookedByBank(db, p.destination_move_id);
    if (fromBank) throw new Error('This payment is linked to a reconciled bank transaction; unreconcile the transaction before reversing it');
    if (date < (p.date ?? sourceEntry.invoice_date)) throw new Error('Reversal date cannot be before the payment date');

    const moveIds = new Set([sourceEntry.id, destEntry.id]);
    const partials = (db.records['account.partial.reconcile'] ?? []).filter(
      (g) => g && g.active !== false && !g.reversed
        && moveIds.has(g.debit_move_id) && moveIds.has(g.credit_move_id),
    );
    let next = db;
    for (const g of partials) {
      next = write(next, 'account.partial.reconcile', g.id, {
        reversed: true,
        active: false,
        reversal_date: date,
      });
    }

    const reversedSource = reverseEntry(next, sourceEntry, date);
    next = reversedSource.db;
    const reversedDest = reverseEntry(next, destEntry, date);
    next = reversedDest.db;

    next = write(next, 'account.payment', p.id, { state: 'reversed', unapplied: 0 });
    if (paired) {
      next = write(next, 'account.payment', paired.id, { state: 'reversed', unapplied: 0 });
      next = postNote(next, 'account.payment', paired.id, `Internal transfer reversed by ${read(next, 'account.move', reversedSource.id).name} and ${read(next, 'account.move', reversedDest.id).name}`);
    }
    return postNote(next, 'account.payment', p.id, `Internal transfer reversed by ${read(next, 'account.move', reversedSource.id).name} and ${read(next, 'account.move', reversedDest.id).name}`);
  }

  const entry = read(db, 'account.move', p.move_id);
  const fromBank = isPaymentMatched(db, p, options?.excludeLineId);
  const missingBankLink = p.invoice_id && search(db, 'account.bank.statement.line').some((l) => l.state === 'reconciled' && l.move_id === p.invoice_id && !l.payment_move_id && (!options?.excludeLineId || l.id !== options.excludeLineId));
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

const inPostedBatch = (db, payment) => (db.records['account.batch.payment'] ?? [])
  .some((b) => b.state === 'posted' && (b.lines ?? []).some((l) => !l.cancelled && l.payment_id === payment.id));

/** Entries of a payment that a reset to draft would undo. */
const paymentEntries = (db, payment) => [payment.move_id, payment.destination_move_id].filter(Boolean)
  .map((id) => read(db, 'account.move', id)).filter(Boolean);

/**
 * Why a payment cannot go back to draft, or null. Cancelled payments always can; posted ones only while
 * nothing is matched, batched, bank-matched, hashed or locked. Reconciled payments keep only Reverse.
 */
export function resetToDraftError(db, payment, ctx = null) {
  if (!payment) return 'Payment not found';
  const paired = payment.paired_internal_transfer_payment_id ? read(db, 'account.payment', payment.paired_internal_transfer_payment_id) : null;
  const isUnvoidedCheck = (p) => p && p.check_number != null && !(p.voided_check_numbers ?? []).some((v) => v.check_number === p.check_number);
  if (isUnvoidedCheck(payment) || (paired && isUnvoidedCheck(paired))) {
    return 'Void the check before resetting the payment to draft';
  }
  const entries = paymentEntries(db, payment);
  if (payment.state === 'cancel' && entries.every((m) => m.state !== 'posted')) return null;
  if (payment.state === 'reversed') return 'Reversed payments cannot be reset to draft';
  if (payment.state !== 'posted' && payment.state !== 'cancel') return 'Only posted or cancelled payments can be reset to draft';
  if (isPaymentMatched(db, payment) || (paired && isPaymentMatched(db, paired)) || entries.some((m) => bookedByBank(db, m.id))) {
    return 'A payment linked to a reconciled bank transaction cannot be reset to draft';
  }
  if (inPostedBatch(db, payment) || (paired && inPostedBatch(db, paired))) {
    return 'A payment in a posted batch cannot be reset to draft';
  }
  const lock = recordLockDate(db, payment, ctx);
  if (lock && String(payment.date ?? today()) <= lock) return `The period up to ${lock} is locked`;
  for (const move of entries) {
    if (move.inalterable_hash) return 'Secured entries cannot be reset to draft or cancelled';
    const moveLock = recordLockDate(db, move, ctx);
    if (moveLock && moveDate(move) <= moveLock) return `The period up to ${moveLock} is locked`;
  }
  const settling = settlingEntries(db);
  const ids = new Set(entries.map((m) => m.id));

  const isSelfPartial = (g) =>
    payment.is_internal_transfer
    && ids.has(g.debit_move_id)
    && ids.has(g.credit_move_id);

  const hasExternalPartial = (db.records['account.partial.reconcile'] ?? []).some(
    (g) => g && g.active !== false && !g.reversed
      && (ids.has(g.debit_move_id) || ids.has(g.credit_move_id))
      && !isSelfPartial(g),
  );

  const co = read(db, 'res.company', payment.company_id ?? 1);
  const transferAccId = co?.transfer_account_id;

  const hasExternalReconciledItem = entries.some((m) => {
    if (!payment.is_internal_transfer && settling.has(m.id)) return true;
    const items = reconciledJournalItems(db, m);
    return items.some((l) => {
      if (!l.reconciled) return false;
      if (payment.is_internal_transfer && transferAccId && l.account_id === transferAccId && !hasExternalPartial) {
        return false;
      }
      return true;
    });
  });

  const reconciled = paymentSettledMoves(db, payment).length > 0
    || hasExternalReconciledItem
    || hasExternalPartial;

  return reconciled ? 'Reconciled payments cannot be reset to draft' : null;
}

/** Reset a payment back to draft: its entries are deleted, or cancelled where the move rules keep them. */
export function resetPaymentToDraft(db, paymentOrId, ctx = null) {
  const payment = typeof paymentOrId === 'object' && paymentOrId !== null ? paymentOrId : read(db, 'account.payment', paymentOrId);
  if (payment?.state === 'draft') return db;
  const error = resetToDraftError(db, payment, ctx);
  if (error) throw new Error(error);

  const paired = payment.paired_internal_transfer_payment_id ? read(db, 'account.payment', payment.paired_internal_transfer_payment_id) : null;
  if (paired && paired.state !== 'draft') {
    const pairedError = resetToDraftError(db, paired, ctx);
    if (pairedError) throw new Error(pairedError);
  }

  let next = db;

  if (payment.is_internal_transfer) {
    const moveIds = new Set([payment.move_id, payment.destination_move_id].filter(Boolean));
    const partials = (next.records['account.partial.reconcile'] ?? []).filter(
      (g) => g && g.active !== false && !g.reversed && moveIds.has(g.debit_move_id) && moveIds.has(g.credit_move_id),
    );
    for (const g of partials) {
      next = write(next, 'account.partial.reconcile', g.id, {
        reversed: true,
        active: false,
        reversal_date: today(),
      });
      next = unlink(next, 'account.partial.reconcile', [g.id]);
    }
  }

  const movesToUndo = [payment.move_id, payment.destination_move_id].filter(Boolean);
  for (const moveId of movesToUndo) {
    const move = read(next, 'account.move', moveId);
    if (move && move.state === 'posted') {
      next = write(next, 'account.move', move.id, { state: 'draft' });
    }
  }

  next = write(next, 'account.payment', payment.id, {
    state: 'draft',
    move_id: null,
    destination_move_id: null,
    unapplied: 0,
  });
  if (paired && paired.state !== 'draft') {
    next = write(next, 'account.payment', paired.id, {
      state: 'draft',
      move_id: null,
      destination_move_id: null,
      unapplied: 0,
    });
  }

  for (const moveId of movesToUndo) {
    const move = read(next, 'account.move', moveId);
    if (!move) continue;
    const delErr = moveDeleteGuard(next, move, next, ctx);
    if (!delErr) {
      next = unlink(next, 'account.move', [move.id]);
    } else {
      next = write(next, 'account.move', move.id, { state: 'cancel' });
    }
  }

  next = postNote(next, 'account.payment', payment.id, 'Reset to draft');
  if (paired && paired.state !== 'draft') {
    next = postNote(next, 'account.payment', paired.id, 'Reset to draft');
  }
  return next;
}

/** Every check number a journal has ever consumed: issued, printed on a batch line, or voided by a reprint. */
const consumedCheckNumbers = (db, journalId) => {
  const payments = (db.records['account.payment'] ?? []).filter((p) => p.journal_id === journalId);
  const ids = new Set(payments.map((p) => p.id));
  const fromBatches = (db.records['account.batch.payment'] ?? [])
    .filter((b) => b.journal_id === journalId || (b.lines ?? []).some((l) => ids.has(l.payment_id)))
    .flatMap((b) => (b.lines ?? []).map((l) => l.check_number));
  return [...payments.map((p) => p.check_number), ...payments.flatMap((p) => (p.voided_check_numbers ?? []).map((v) => v.check_number)), ...fromBatches]
    .filter((n) => Number.isSafeInteger(n) && n > 0);
};

/** First check number a journal may print next: its "Next Check Number" setting, pushed past every number already consumed. */
export function nextCheckNumber(db, journalId, requested = 0) {
  const journal = read(db, 'account.journal', journalId);
  return consumedCheckNumbers(db, journalId).reduce((next, n) => Math.max(next, n + 1), Math.max(Number(requested || 1), Number(journal?.check_next_number || 1)));
}

/** True when payment pays by check (method code 'check_printing'). Never infer from names. */
export function paymentPaysByCheck(db, payment) {
  if (!payment?.payment_method_line_id || !db) return false;
  const line = read(db, 'account.payment.method.line', payment.payment_method_line_id);
  if (!line?.payment_method_id) return false;
  const method = read(db, 'account.payment.method', line.payment_method_id);
  return method?.code === 'check_printing';
}

/** Check whether check number is already used on this journal by another payment or voided check. */
export function isCheckNumberUsedOnJournal(db, journalId, checkNumber, excludePaymentId = null) {
  if (!checkNumber || !journalId || !db) return false;
  const payments = search(db, 'account.payment', { includeArchived: true }).filter((p) => p.journal_id === journalId);
  for (const p of payments) {
    if (p.id !== excludePaymentId && p.check_number === checkNumber) return true;
    if ((p.voided_check_numbers ?? []).some((v) => v.check_number === checkNumber)) return true;
  }
  const batches = search(db, 'account.batch.payment', { includeArchived: true }).filter((b) => b.journal_id === journalId);
  for (const b of batches) {
    for (const l of b.lines ?? []) {
      if (l.payment_id !== excludePaymentId && l.check_number === checkNumber) return true;
    }
  }
  return false;
}

/**
 * Canonical helper for check numbering: assigns check number at print or reprint time,
 * advances the journal sequence (unless manual), marks payment as printed,
 * and maintains void history on reprints.
 */
export function issueCheckNumber(db, payment, { number = null, isReprint = false } = {}) {
  const p = read(db, 'account.payment', typeof payment === 'object' && payment !== null ? payment.id : payment);
  if (!p || p.state !== 'posted' || p.payment_type !== 'outbound') {
    throw new Error(isReprint ? 'Only posted checks can be reprinted' : 'Only posted outbound payments can be printed');
  }
  if (!paymentPaysByCheck(db, p)) {
    throw new Error('Payment does not pay by check');
  }
  const journal = read(db, 'account.journal', p.journal_id);
  const isManual = Boolean(journal?.check_manual_sequencing);
  const isVoided = (p.voided_check_numbers ?? []).some((v) => v.check_number === p.check_number);

  if (isReprint) {
    if (p.check_number == null || (p.check_printed === false && !isVoided)) throw new Error('Only issued checks can be reprinted');
  } else {
    if (p.check_number != null && p.check_printed !== false && !isVoided) {
      throw new Error('Check has already been printed');
    }
    if (p.check_number != null && !isVoided && !isManual && number == null) {
      throw new Error('Check has already been printed');
    }
  }

  let finalNumber;
  if (isManual) {
    if (isReprint) {
      finalNumber = number;
      if (!Number.isSafeInteger(finalNumber) || finalNumber < 1) {
        throw new Error('Check number is required for manual numbering');
      }
      if (finalNumber === p.check_number || (p.voided_check_numbers ?? []).some((v) => v.check_number === finalNumber)) {
        throw new Error('The replacement check number must differ from the current and voided numbers');
      }
    } else {
      finalNumber = number != null ? Number(number) : (p.check_number != null && !isVoided ? p.check_number : null);
      if (finalNumber == null || !Number.isSafeInteger(finalNumber) || finalNumber < 1) {
        throw new Error('Check number is required for manual numbering');
      }
    }
  } else {
    finalNumber = number != null ? nextCheckNumber(db, p.journal_id, Number(number)) : nextCheckNumber(db, p.journal_id);
  }

  if (isCheckNumberUsedOnJournal(db, p.journal_id, finalNumber, p.id)) {
    throw new Error(`Check number ${finalNumber} is already used on this journal`);
  }

  let next = db;
  if (!isManual) {
    next = write(next, 'account.journal', p.journal_id, { check_next_number: finalNumber + 1 });
  }

  let voided_check_numbers = p.voided_check_numbers ?? [];
  if (isReprint) {
    const isAlreadyVoided = voided_check_numbers.some((v) => v.check_number === p.check_number);
    if (!isAlreadyVoided) {
      voided_check_numbers = [...voided_check_numbers, { check_number: p.check_number, date: today() }];
    }
  }

  next = write(next, 'account.payment', p.id, {
    check_number: finalNumber,
    check_printed: true,
    ...(isReprint ? { voided_check_numbers } : {}),
  });

  for (const batch of (next.records['account.batch.payment'] ?? []).filter((b) => b.lines?.some((l) => l.payment_id === p.id))) {
    next = write(next, 'account.batch.payment', batch.id, {
      lines: batch.lines.map((l) => (l.payment_id === p.id ? { ...l, check_number: finalNumber } : l)),
    });
  }

  const note = isReprint
    ? `Check ${p.check_number} voided, reprinted as ${finalNumber}`
    : `Check ${finalNumber} printed`;
  return postNote(next, 'account.payment', p.id, note);
}

/** Print single check on posted outbound payment: assigns next number from journal and increments check_next_number. */
export function printCheck(db, payment, requestedNumber = null) {
  return issueCheckNumber(db, payment, { number: requestedNumber, isReprint: false });
}

/** Void an issued check: records it in voided_check_numbers (number kept, visible in register). */
export function voidCheck(db, payment) {
  const p = typeof payment === 'object' && payment !== null ? payment : read(db, 'account.payment', payment);
  if (!p || p.state !== 'posted' || p.payment_type !== 'outbound' || p.check_number == null) {
    throw new Error('Only issued checks can be voided');
  }
  const isAlreadyVoided = (p.voided_check_numbers ?? []).some((v) => v.check_number === p.check_number);
  if (isAlreadyVoided) {
    throw new Error('Check is already voided');
  }
  const voided_check_numbers = [...(p.voided_check_numbers ?? []), { check_number: p.check_number, date: today() }];
  let next = write(db, 'account.payment', p.id, { voided_check_numbers, check_printed: false });
  return postNote(next, 'account.payment', p.id, `Check ${p.check_number} voided`);
}

/** Compute remittance stub lines for settled bills and credit notes with original, paid, and net amounts. */
export function paymentRemittanceLines(db, payment) {
  const p = typeof payment === 'object' && payment !== null ? payment : read(db, 'account.payment', payment);
  if (!p) return [];
  const settledMoves = paymentSettledMoves(db, p);
  if (!settledMoves.length) {
    if (p.invoice_id) {
      const inv = read(db, 'account.move', p.invoice_id);
      if (inv) {
        return [{
          move: inv,
          name: inv.name || inv.ref || '—',
          date: inv.invoice_date || inv.date,
          original_amount: Number(inv.amount_total) || 0,
          paid_amount: Number(p.amount) || 0,
          currency: documentCurrency(db, inv),
        }];
      }
    }
    return [];
  }
  return settledMoves.map((m) => {
    const isRefund = ['out_refund', 'in_refund'].includes(m.move_type);
    const sign = isRefund ? -1 : 1;
    const matchingRows = p.move_id
      ? (m.payments ?? []).filter((row) => !row.reversed && row.move_id === p.move_id)
      : [];
    const linePaid = matchingRows.length
      ? matchingRows.reduce((sum, row) => sum + (Number(row.amount) || 0), 0)
      : (p.amount ?? 0);
    return {
      move: m,
      name: m.name || m.ref || '—',
      date: m.invoice_date || m.date,
      original_amount: sign * (Number(m.amount_total) || 0),
      paid_amount: sign * (Number(linePaid) || 0),
      currency: documentCurrency(db, m),
    };
  });
}

/** Numbers check payments on an outbound batch payment when printed. */
export function printBatchChecks(db, batchOrId, requestedStartNumber = null) {
  const batch = typeof batchOrId === 'object' && batchOrId !== null ? batchOrId : read(db, 'account.batch.payment', batchOrId);
  if (!batch || batch.state !== 'posted' || batch.batch_type !== 'outbound') return db;
  // Batches posted before the batch kept its journal use their payments' journal.
  const journalId = batch.journal_id ?? (batch.lines?.[0]?.payment_id ? read(db, 'account.payment', batch.lines[0].payment_id)?.journal_id : null);
  const journal = journalId ? read(db, 'account.journal', journalId) : null;
  if (!journal) return db;

  let next = db;
  let nextLines = [...(batch.lines ?? [])];
  let changed = false;

  const isManual = Boolean(journal.check_manual_sequencing);
  let nextStartNumber = requestedStartNumber != null && typeof requestedStartNumber !== 'object' ? Number(requestedStartNumber) : null;

  for (let i = 0; i < nextLines.length; i++) {
    const line = nextLines[i];
    if (line.cancelled || !line.payment_id) continue;
    const payment = read(next, 'account.payment', line.payment_id);
    if (!payment || payment.state !== 'posted') continue;
    if (!paymentPaysByCheck(next, payment)) continue;

    const isVoided = (payment.voided_check_numbers ?? []).some((v) => v.check_number === payment.check_number);
    if (isManual) {
      const num = isVoided ? requestedStartNumber?.[payment.id] : (payment.check_number ?? requestedStartNumber?.[payment.id] ?? line.check_number);
      if (num == null) {
        throw new Error('Check number is required for manual numbering');
      }
      if (payment.check_printed === false || payment.check_number == null || isVoided) {
        next = issueCheckNumber(next, payment, { number: num, isReprint: false });
      }
      if (line.check_number !== num) {
        nextLines[i] = { ...line, check_number: num };
        changed = true;
      }
    } else {
      if (payment.check_number == null || isVoided) {
        const number = nextStartNumber != null ? nextCheckNumber(next, journal.id, nextStartNumber) : nextCheckNumber(next, journal.id);
        next = issueCheckNumber(next, payment, { number, isReprint: false });
        nextStartNumber = number + 1;
        nextLines[i] = { ...line, check_number: number };
        changed = true;
      }
    }
  }

  if (changed) {
    next = write(next, 'account.batch.payment', batch.id, { lines: nextLines });
  }
  return next;
}

/** Reprint an issued check on a fresh number: the old number is voided (kept on the payment, never reused). */
export function reprintCheck(db, payment, replacementNumber = null) {
  return issueCheckNumber(db, payment, { number: replacementNumber, isReprint: true });
}

const STATES = [['draft', 'Draft'], ['posted', 'Paid'], ['cancel', 'Canceled'], ['reversed', 'Reversed']];
const DISPLAY_STATES = [['draft', 'Draft'], ['posted', 'Paid'], ['reconciled', 'Reconciled'], ['cancel', 'Canceled'], ['reversed', 'Reversed']];

/** True when `move` is an invoice/bill/credit note actively settled by `payment`. */
export const isMoveSettledByPayment = (move, payment) => Boolean(
  payment?.move_id && isInvoice(move) && (move?.payments ?? []).some((p) => !p.reversed && p.move_id === payment.move_id),
);

/** Settled documents a smart button can open: refunds/credit notes, or invoices/bills. */
const settledOfType = (db, payment, refunds) => paymentSettledMoves(db, payment)
  .filter((m) => ['out_refund', 'in_refund'].includes(m.move_type) === refunds);

/** Invoices/bills actively settled by `payment` in the visible company scope. */
export const paymentSettledMoves = (db, payment) => (
  payment?.move_id
    ? companyFilter(db, search(db, 'account.move').filter((m) => isMoveSettledByPayment(m, payment)), 'account.move')
    : []
);

const paymentBankLabel = (r) => (r?.payment_type === 'outbound'
  ? (r?.partner_type === 'supplier' ? 'Vendor Bank Account' : 'Customer Bank Account')
  : 'Company Bank Account');

/** Company-currency signed payment amount (outbound negative), reusing posted liquidity lines when booked. */
function paymentCompanySignedAmount(r, db) {
  if (!r) return 0;
  const companies = db?.records?.['res.company'] ?? [];
  const companyCurr = companies.length ? companyCurrencyRecord(db, r.company_id) : null;
  const roundCo = (n) => {
    // Display-only: an amount too large to round has no company value; Confirm still rejects it.
    if (!Number.isFinite(Math.abs(n) / Number(companyCurr?.rounding ?? 0.01))) return null;
    const rounded = companyCurr ? roundCurrency(n, companyCurr) : round(n);
    return rounded === 0 ? 0 : rounded;
  };
  if (r.move_id) {
    const move = (db?.records?.['account.move'] ?? []).find((m) => m.id === r.move_id);
    if (move) {
      const journalIdUsed = r.journal_id ?? move.journal_id;
      const journal = journalIdUsed ? (db.records['account.journal'] ?? []).find((j) => j.id === journalIdUsed) : null;
      const liquidity = r.outstanding_account_id ?? journal?.default_account_id;
      const lines = (move.line_ids ?? []).filter((l) => (liquidity ? l.account_id === liquidity : false));
      if (lines.length) {
        return roundCo(lines.reduce((s, l) => s + (Number(l.debit) || 0) - (Number(l.credit) || 0), 0));
      }
    }
  }
  const raw = Number(r.amount) || 0;
  const sign = r.payment_type === 'outbound' ? -1 : 1;
  if (r.currency_id && companyCurr && r.currency_id !== companyCurr.id) {
    const at = r.date ?? today();
    const companyId = r.company_id ?? 1;
    const rate = conversionRate(db, r.currency_id, companyCurr.id, at, companyId);
    if (rate == null) return null;
    return roundCo(sign * toCompany(db, r.currency_id, raw, at, companyId));
  }
  return roundCo(sign * raw);
}

/** Signed payment amount in the payment's own currency (inbound positive, outbound negative). */
function paymentSignedAmount(r) {
  const signed = (r.payment_type === 'outbound' ? -1 : 1) * (Number(r.amount) || 0);
  return signed === 0 ? 0 : signed;
}

const PAYMENT_LIST = [
  'date', 'name', 'journal_id', 'company_id', 'partner_id',
  'amount_signed', 'currency_id', 'activities', 'amount_company_currency_signed', 'display_state',
];

const PAYMENT_LIST_FIELDS = {
  company_id: { optional: 'hide', multiCompanyOnly: true },
  amount_signed: { optional: (db) => (hasMultiCurrency(db) ? 'show' : 'hide'), sum: false },
  currency_id: { optional: 'hide', groupByWhen: hasMultiCurrency },
  activities: { optional: 'hide' },
  amount_company_currency_signed: { sum: 'Total' },
};

const PAYMENT_SEARCH_FIELDS = ['name', 'partner_id', 'memo', 'amount', 'journal_id'];

const PAYMENT_FILTERS = [
  [
    { id: 'customer', label: 'Customer Payments', fn: (r) => r.partner_type === 'customer' },
    { id: 'supplier', label: 'Vendor Payments', fn: (r) => r.partner_type === 'supplier' },
  ],
  [
    { id: 'draft', label: 'Draft', fn: (r) => r.state === 'draft' },
    { id: 'paid', label: 'Paid', fn: (r) => r.state === 'posted' },
  ],
  [
    { id: 'outstanding', label: 'Outstanding', fn: (r, db) => r.state === 'posted' && !(db && isPaymentMatched(db, r)) },
  ],
  monthFilters('date', 'Payment Date'),
];

const PAYMENT_GROUP_BYS = ['partner_id', 'journal_id', 'display_state', 'date', 'currency_id', 'company_id'];
const PAYMENT_GROUP_BY_LABELS = { partner_id: 'Partner', display_state: 'Status', date: 'Payment Date', currency_id: 'Currency' };

/** Highlight draft payments as info and cancelled payments as muted on payment lists. */
const paymentListDecoration = (r) => (r.state === 'draft' ? 'info' : r.state === 'cancel' ? 'muted' : null);

export const customerPaymentView = {
  list: PAYMENT_LIST,
  listFields: PAYMENT_LIST_FIELDS,
  listLabels: { partner_id: 'Customer', currency_id: 'Payment Currency' },
  groupByLabels: PAYMENT_GROUP_BY_LABELS,
  listDecoration: paymentListDecoration,
  searchFields: PAYMENT_SEARCH_FIELDS,
  filters: PAYMENT_FILTERS,
  groupBys: PAYMENT_GROUP_BYS,
};

export const vendorPaymentView = {
  list: PAYMENT_LIST,
  listFields: PAYMENT_LIST_FIELDS,
  listLabels: { partner_id: 'Vendor', currency_id: 'Payment Currency' },
  groupByLabels: PAYMENT_GROUP_BY_LABELS,
  listDecoration: paymentListDecoration,
  searchFields: PAYMENT_SEARCH_FIELDS,
  filters: PAYMENT_FILTERS,
  groupBys: PAYMENT_GROUP_BYS,
};

const appendsVoidOf = (prior, next, number) => next.length === prior.length + 1
  && JSON.stringify(next.slice(0, prior.length)) === JSON.stringify(prior)
  && next.at(-1)?.check_number === number
  && Boolean(next.at(-1)?.date);

/**
 * Issued check numbers are append-only and readable from the diff alone: a number is set once on a posted outbound
 * payment, voiding keeps it (listed in voided_check_numbers), and only a voided number may be replaced by a new one
 * (reprint, or print again after a void). Uniqueness per journal and the check method are checked by the guard.
 */
const validCheckWrite = (db, before, after) => {
  const priorVoided = before?.voided_check_numbers ?? [];
  const nextVoided = after.voided_check_numbers ?? [];
  const voidedUnchanged = JSON.stringify(priorVoided) === JSON.stringify(nextVoided);
  if (!before) return !nextVoided.length && (after.check_printed !== true || (after.check_number != null && after.state === 'posted' && after.payment_type === 'outbound')) && (after.check_number == null || after.state === 'posted');
  if (before.check_printed !== after.check_printed) {
    if (after.check_printed === true) {
      if (after.check_number == null || after.state !== 'posted' || after.payment_type !== 'outbound') return false;
    } else if (after.check_printed === false) {
      if (before.check_number == null || after.check_number !== before.check_number || !appendsVoidOf(priorVoided, nextVoided, before.check_number)) return false;
    } else return false;
  }
  if (before.check_number == null) {
    return voidedUnchanged && (after.check_number == null || (after.state === 'posted' && after.payment_type === 'outbound'));
  }
  const journal = (after.journal_id ?? before.journal_id) ? read(db, 'account.journal', after.journal_id ?? before.journal_id) : null;
  const isManual = Boolean(journal?.check_manual_sequencing);
  if (isManual && before.check_printed === false && after.check_printed === false && !priorVoided.some((v) => v.check_number === before.check_number)) {
    if (before.journal_id !== after.journal_id) return false;
    return voidedUnchanged && after.payment_type === 'outbound';
  }
  if (after.check_number == null) return false;
  if (before.journal_id !== after.journal_id) return false;
  const beforeVoided = priorVoided.some((v) => v.check_number === before.check_number);
  if (after.state === 'draft') return beforeVoided && after.check_number === before.check_number && voidedUnchanged;
  if (before.check_number === after.check_number) {
    return voidedUnchanged || (!beforeVoided && appendsVoidOf(priorVoided, nextVoided, before.check_number));
  }
  if (before.state !== 'posted' || after.state !== 'posted' || after.payment_type !== 'outbound') return false;
  const validVoidTransition = (beforeVoided && voidedUnchanged) || (!beforeVoided && appendsVoidOf(priorVoided, nextVoided, before.check_number));
  if (!validVoidTransition) return false;
  // An automatic replacement is the number the journal sequence just issued; uniqueness is checked by the journal guard.
  if (!journal?.check_manual_sequencing && journal?.check_next_number !== after.check_number + 1) return false;
  return true;
};

const paymentMethodGuard = (db, before, after) => {
  const err = paymentMethodLineError(db, after);
  if (err) return err;
  if (after.state === 'posted') {
    const journal = after.journal_id ? read(db, 'account.journal', after.journal_id) : null;
    const needsMethodLine = Boolean(journal && isMethodLineJournal(journal));
    const transitioningToPosted = !before || before.state !== 'posted';
    const clearedMethodLine = before?.payment_method_line_id != null && !after.payment_method_line_id;
    if (needsMethodLine && !after.payment_method_line_id && (transitioningToPosted || clearedMethodLine)) {
      return 'Payment Method is required';
    }
  }
  return null;
};

function internalTransferInvariant(db, after) {
  if (after.state !== 'posted') return null;
  if (!Number.isFinite(Number(after.amount)) || !(Number(after.amount) > 0)) {
    return 'An internal transfer needs a positive amount';
  }
  if (!after.move_id || !after.destination_move_id) {
    return 'A posted internal transfer needs source and destination journal entries';
  }
  const sourceEntry = (db.records['account.move'] ?? []).find((m) => m.id === after.move_id);
  const destEntry = (db.records['account.move'] ?? []).find((m) => m.id === after.destination_move_id);
  if (sourceEntry?.state !== 'posted' || sourceEntry.move_type !== 'entry' || destEntry?.state !== 'posted' || destEntry.move_type !== 'entry') {
    return 'A posted internal transfer needs its posted journal entries';
  }
  const co = read(db, 'res.company', after.company_id ?? 1);
  if (!co?.transfer_account_id) return 'Internal transfer account is not set for this company';
  const ta = read(db, 'account.account', co.transfer_account_id);
  if (!ta || ta.active === false || ta.account_type !== 'asset_current') {
    return 'Internal transfer account must be an active current-asset account of the company';
  }
  const partials = (db.records['account.partial.reconcile'] ?? []).filter(
    (g) => g && g.active !== false && !g.reversed
      && ((g.debit_move_id === sourceEntry.id && g.credit_move_id === destEntry.id)
        || (g.debit_move_id === destEntry.id && g.credit_move_id === sourceEntry.id)),
  );
  if (!partials.length) return 'Transfer account entries must be reconciled together';
  return null;
}

export const payModels = {
  'account.payment': {
    label: 'Payments',
    auditDelete: true,
    guard: (db, before, after, ctx) => {
      if (after.check_number != null && (!before || before.check_number !== after.check_number) && !paymentPaysByCheck(db, after)) {
        return 'Payments not paying by check cannot have a check number';
      }
      if (after.check_number != null && (!before || before.check_number !== after.check_number) && isCheckNumberUsedOnJournal(db, after.journal_id, after.check_number, after.id)) {
        return 'Check number must be unique per journal';
      }
      if (!validCheckWrite(db, before, after)) return 'Issued check numbers cannot be changed';
      if (before && before.state !== 'draft' && (after.state === 'draft' || (before.state === 'posted' && after.state === 'cancel'))) {
        const resetError = resetToDraftError(db, before, ctx);
        if (resetError) return resetError;
      }
      if (after.state === 'draft' && after.move_id) {
        const m = read(db, 'account.move', after.move_id);
        if (m?.state === 'posted') return 'A draft payment cannot be linked to a posted journal entry';
      }
      if (before && before.state === 'posted' && after.state === 'posted' && before.is_internal_transfer) {
        const transferFields = [
          'amount', 'currency_id', 'journal_id', 'destination_journal_id',
          'date', 'company_id', 'is_internal_transfer', 'move_id', 'destination_move_id',
          'paired_internal_transfer_payment_id',
        ];
        if (transferFields.some((f) => (
          f === 'amount'
            ? Number(before.amount) !== Number(after.amount)
            : (before[f] ?? null) !== (after[f] ?? null)
        ))) {
          return 'Accounting-defining fields of a posted transfer cannot be modified';
        }
      }
      const lockErr = datedLockGuard([
        'name', 'amount', 'currency_id', 'date', 'state', 'partner_id', 'partner_bank_id',
        'partner_type', 'journal_id', 'payment_method_line_id', 'move_id', 'destination_move_id', 'destination_journal_id',
        'is_internal_transfer', 'invoice_id', 'payment_type', 'memo', 'unapplied', 'company_id', 'active',
        'paired_internal_transfer_payment_id',
      ], (p) => p.state === 'posted')(db, before, after, ctx);
      if (lockErr) return lockErr;

      if (after.currency_id) {
        const curr = read(db, 'res.currency', after.currency_id);
        if (!curr || curr.active === false) return 'The payment currency must be active';
      }
      return paymentMethodGuard(db, before, after);
    },
    protectDelete: (db, payment, staged, ctx) => {
      const hasCheck = payment.check_number != null || (payment.voided_check_numbers ?? []).length > 0;
      return hasCheck
        ? 'Issued checks cannot be deleted'
        : datedLockDelete((p) => p.state === 'posted')(db, payment, staged, ctx);
    },
    invariant: (db, after, before, stored) => after.is_internal_transfer
      ? internalTransferInvariant(db, after)
      : paymentInvariant(db, after, before, stored),
    fields: {
      name: { type: 'char', label: 'Number', readonly: true, tracking: true },
      payment_type: { type: 'selection', label: 'Payment Type', tracking: true, widget: 'radio', options: [['outbound', 'Send'], ['inbound', 'Receive']] },
      partner_type: { type: 'selection', label: 'Partner Type', tracking: true, options: [['customer', 'Customer'], ['supplier', 'Vendor']] },
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Partner', tracking: true },
      partner_bank_id: { type: 'many2one', relation: 'res.partner.bank', label: 'Recipient Bank Account' },
      is_internal_transfer: { type: 'boolean', label: 'Internal Transfer', tracking: true },
      destination_journal_id: {
        type: 'many2one',
        relation: 'account.journal',
        label: 'Destination Journal',
        tracking: true,
        domain: (j, r) => ['bank', 'cash'].includes(j.type) && j.active !== false && (j.company_id ?? 1) === (r?.company_id ?? 1) && j.id !== r?.journal_id,
      },
      destination_move_id: { type: 'many2one', relation: 'account.move', label: 'Destination Entry', readonly: true },
      paired_internal_transfer_payment_id: { type: 'many2one', relation: 'account.payment', label: 'Paired Internal Transfer Payment', readonly: true },
      amount: { type: 'monetary', label: 'Amount', tracking: true },
      amount_signed: { type: 'monetary', label: 'Amount in Currency', compute: paymentSignedAmount },
      amount_company_currency_signed: { type: 'monetary', label: 'Amount', currency: 'company', compute: (r, db) => paymentCompanySignedAmount(r, db) },
      // A payment of an invoice can be made in any active currency.
      currency_id: { type: 'many2one', relation: 'res.currency', label: 'Currency', tracking: true, domain: (c) => c.active !== false },
      activities: { type: 'char', label: 'Activities', compute: (r, db) => openActivitiesText(db, 'account.payment', r.id) },
      journal_id: { type: 'many2one', relation: 'account.journal', label: 'Journal', tracking: true },
      payment_method_line_id: {
        type: 'many2one',
        relation: 'account.payment.method.line',
        label: 'Payment Method',
        domain: (line, r) => Boolean(r?.journal_id) && line.journal_id === r.journal_id && line.payment_type === r.payment_type,
        hideWhen: (r, db) => Boolean(r?.journal_id) && db && !isMethodLineJournal(read(db, 'account.journal', r.journal_id)),
      },
      check_printed: { type: 'boolean', label: 'Check Printed', readonly: true },
      check_number: {
        type: 'integer',
        label: 'Check Number',
        readonly: (r, db) => {
          if (!r?.journal_id || !db) return true;
          if (r.check_printed === true || (r.check_number != null && r.check_printed !== false)) return true;
          const j = read(db, 'account.journal', r.journal_id);
          return !j?.check_manual_sequencing;
        },
      },
      voided_check_numbers: { type: 'one2many', label: 'Voided Checks', readonly: true, fields: { check_number: { type: 'integer', label: 'Check Number' }, date: { type: 'date', label: 'Date' } } },
      date: { type: 'date', label: 'Date', tracking: true },
      memo: { type: 'char', label: 'Memo', tracking: true },
      destination_account_id: { type: 'many2one', relation: 'account.account', label: 'Destination Account' },
      destination_account_code: { type: 'char', label: 'Destination Account Code', hidden: true },
      is_tax_payment: { type: 'boolean', label: 'Tax Payment', hidden: true },
      return_id: { type: 'many2one', relation: 'account.return', label: 'Tax Return', readonly: true },
      invoice_id: {
        type: 'many2one', relation: 'account.move', label: 'Invoice',
        // An open posted document of this payment's partner, company and direction that posting accepts.
        domain: (m, r, db) => m.state === 'posted' && isInvoice(m) && Number(m.amount_residual) > 0
          && (m.company_id ?? 1) === (r?.company_id ?? 1)
          && (!r?.partner_id || m.partner_id === r.partner_id)
          && Boolean(SETTLES[r?.partner_type]?.[r?.payment_type]?.includes(m.move_type))
          && !invoiceAfterPayment(m, r?.date ?? today())
          && !['exception', 'no'].includes(shouldBePaid(db, m)),
      },
      move_id: { type: 'many2one', relation: 'account.move', label: 'Journal Entry', readonly: true },
      outstanding_account_id: { type: 'many2one', relation: 'account.account', label: 'Outstanding Account', readonly: true, hidden: true },
      sale_id: { type: 'many2one', relation: 'sale.order', label: 'Sales Order', readonly: true },
      unapplied: { type: 'monetary', label: 'Outstanding Credit', readonly: true, currency: 'company' },
      state: { type: 'selection', label: 'Status', tracking: true, options: STATES, badge: { draft: 'muted', posted: 'ok', cancel: 'muted', reversed: 'muted' } },
      display_state: {
        type: 'selection',
        label: 'Status',
        options: DISPLAY_STATES,
        badge: { draft: 'info', posted: 'warning', reconciled: 'success', cancel: 'muted', reversed: 'muted' },
        compute: (r, db) => (r.state === 'posted' && db && isPaymentMatched(db, r) ? 'reconciled' : r.state),
      },
    },
    defaults: () => ({ name: '/', payment_type: 'inbound', partner_type: 'customer', date: today(), state: 'draft', amount: 0, is_internal_transfer: false, check_printed: false }),
    createDefaults: (db, vals = {}) => {
      const companyId = vals.company_id ?? getActiveCompany() ?? currentCompany(db);
      const journalId = vals.journal_id !== undefined ? vals.journal_id : defaultPaymentJournalId(db, companyId);
      const paymentType = vals.payment_type ?? 'inbound';
      const lineId = vals.payment_method_line_id === undefined && journalId
        ? defaultPaymentMethodLineId(db, journalId, paymentType)
        : undefined;
      return {
        ...(vals.journal_id === undefined && journalId ? { journal_id: journalId } : {}),
        ...(lineId !== undefined ? { payment_method_line_id: lineId } : {}),
      };
    },
    onchange: (r, key, db) => {
      if (key === 'invoice_id' && r.invoice_id && db) {
        return { currency_id: documentCurrency(db, read(db, 'account.move', r.invoice_id))?.id ?? null };
      }
      if ((key === 'journal_id' || key === 'payment_type') && db) {
        return { payment_method_line_id: defaultPaymentMethodLineId(db, r.journal_id, r.payment_type) };
      }
      return {};
    },
    groupBys: PAYMENT_GROUP_BYS,
    groupByLabels: PAYMENT_GROUP_BY_LABELS,
    searchFields: PAYMENT_SEARCH_FIELDS,
    filters: PAYMENT_FILTERS,
    views: ['list', 'kanban', 'graph'],
    kanban: { title: 'name', lines: ['partner_id', 'amount_company_currency_signed', 'date'], badge: 'display_state' },
    list: PAYMENT_LIST,
    listFields: PAYMENT_LIST_FIELDS,
    listLabels: { currency_id: 'Payment Currency' },
    listDecoration: paymentListDecoration,
    graph: { groupBy: 'date', measure: 'amount' },
    form: {
      statusbar: 'state',
      statusbarFor: 'display_state',
      statusbarHide: ['reconciled', 'cancel', 'reversed'],
      // Memo stays editable on posted payments, except inside a locked period (the dated lock rejects it).
      unlockedFields: (r, db) => {
        const lock = r && db ? recordLockDate(db, r) : null;
        if (lock && String(r.date ?? today()) <= lock) return [];
        const res = ['memo'];
        if (r && db && r.payment_type === 'outbound' && (r.check_printed === false || (r.check_printed == null && r.check_number == null)) && r.journal_id) {
          const j = read(db, 'account.journal', r.journal_id);
          if (j?.check_manual_sequencing && paymentPaysByCheck(db, r)) {
            res.push('check_number');
          }
        }
        return res;
      },
      lockedWhen: (r) => r.state !== 'draft',
      smart: [
        {
          label: (r) => (r.partner_type === 'supplier' ? 'Bills' : 'Invoices'),
          when: (r, db) => settledOfType(db, r, false).length > 0,
          value: (db, r) => settledOfType(db, r, false).length,
          target: (r) => `${r.partner_type === 'supplier' ? 'accounting/bills' : 'accounting/invoices'}?view=list&rel=payment_id:${r.id}`,
        },
        {
          label: (r) => (r.partner_type === 'supplier' ? 'Refunds' : 'Credit Notes'),
          when: (r, db) => settledOfType(db, r, true).length > 0,
          value: (db, r) => settledOfType(db, r, true).length,
          target: (r) => `${r.partner_type === 'supplier' ? 'accounting/refunds' : 'accounting/credit-notes'}?view=list&rel=payment_id:${r.id}`,
        },
        {
          label: 'Journal Entry',
          when: (r) => Boolean(r.move_id),
          value: () => '',
          target: (r) => `accounting/entries/${r.move_id}`,
        },
        {
          label: 'Destination Entry',
          when: (r) => Boolean(r.destination_move_id),
          value: () => '',
          target: (r) => `accounting/entries/${r.destination_move_id}`,
        },
      ],
      buttons: [
        { label: 'Confirm', primary: true, when: (r) => r.state === 'draft', run: (db, r) => ({ db: postPayment(db, read(db, 'account.payment', r.id)) }) },
        {
          label: 'Reset to Draft',
          when: (r, db) => r.state !== 'draft' && Boolean(db) && !resetToDraftError(db, r),
          run: (db, r) => ({ db: resetPaymentToDraft(db, read(db, 'account.payment', r.id)) }),
        },
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
                  && !['exception', 'no'].includes(shouldBePaid(db, m))
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
        { label: 'Reverse', when: (r) => r.state === 'posted', run: (db, r) => ({ db: reversePayment(db, read(db, 'account.payment', r.id)) }) },
        {
          label: 'Print Check',
          when: (r, db) => {
            if (r.state !== 'posted' || r.payment_type !== 'outbound') return false;
            if (!db || !paymentPaysByCheck(db, r)) return false;
            const isVoided = (r.voided_check_numbers ?? []).some((v) => v.check_number === r.check_number);
            if (r.check_number != null && r.check_printed !== false && !isVoided) return false;
            const journal = r.journal_id ? read(db, 'account.journal', r.journal_id) : null;
            if (journal?.check_manual_sequencing && isVoided) {
              return false;
            }
            if (r.check_number != null && !isVoided) {
              return Boolean(journal?.check_manual_sequencing);
            }
            return true;
          },
          wizard: (db, r) => {
            const journalId = r?.journal_id;
            const journal = db && journalId ? read(db, 'account.journal', journalId) : null;
            if (journal?.check_manual_sequencing && r?.check_number != null) {
              return null;
            }
            const nextNum = db && journalId ? nextCheckNumber(db, journalId, r?.check_number || 0) : 1;
            return {
              title: 'Print Check',
              fields: [
                { name: 'next_check_number', type: 'integer', label: 'Next Check Number', default: nextNum, required: true },
              ],
            };
          },
          run: (db, r, values = {}) => {
            const requested = values?.next_check_number ?? values?.check_number ?? null;
            const nextDb = printCheck(db, r, requested);
            return { db: nextDb, go: `#/print/account.payment/${r.id}` };
          },
        },
        {
          label: 'Void Check',
          when: (r) => r.state === 'posted' && r.payment_type === 'outbound' && r.check_number != null
            && !(r.voided_check_numbers ?? []).some((v) => v.check_number === r.check_number),
          run: (db, r) => ({ db: voidCheck(db, r) }),
        },
        {
          label: 'Reprint Check',
          when: (r, db) => r.state === 'posted' && r.payment_type === 'outbound' && r.check_number != null && r.check_printed !== false
            && !(r.voided_check_numbers ?? []).some((v) => v.check_number === r.check_number)
            && !(db && r.journal_id && read(db, 'account.journal', r.journal_id)?.check_manual_sequencing),
          run: (db, r) => ({ db: reprintCheck(db, r), go: `#/print/account.payment/${r.id}` }),
        },
        {
          label: 'Reprint Check',
          when: (r, db) => r.state === 'posted' && r.payment_type === 'outbound' && r.check_number != null && r.check_printed !== false
            && !(r.voided_check_numbers ?? []).some((v) => v.check_number === r.check_number)
            && Boolean(db && r.journal_id && read(db, 'account.journal', r.journal_id)?.check_manual_sequencing),
          ask: [{ label: 'New Check Number', type: 'number' }],
          run: (db, r, answers) => ({ db: reprintCheck(db, r, answers?.[0] ?? null), go: `#/print/account.payment/${r.id}` }),
        },
        { label: 'Cancel', when: (r) => r.state === 'draft', vals: { state: 'cancel' } },
      ],
      title: 'name',
      groups: (r, db) => [
        [
          'payment_type',
          ...(!r?.state || r?.state === 'draft' ? ['is_internal_transfer'] : (r?.is_internal_transfer ? [{ field: 'is_internal_transfer', readonly: true }] : [])),
          ...(r?.is_internal_transfer ? [] : [{ field: 'partner_id', label: r?.partner_type === 'supplier' ? 'Vendor' : 'Customer' }]),
          { label: 'Amount', fields: ['amount', 'currency_id'] },
          'date',
          'memo',
        ],
        [
          { label: 'Journal', fields: ['journal_id', 'payment_method_line_id', ...(paymentPaysByCheck(db, r) || r?.check_number != null ? ['check_number'] : [])] },
          ...(r?.is_internal_transfer ? ['destination_journal_id'] : [{ field: 'partner_bank_id', label: paymentBankLabel(r) }]),
        ],
        ...(r?.invoice_id || r?.state === 'draft' || Number(r?.unapplied) > 0
          ? [[...(r?.invoice_id || r?.state === 'draft' ? ['invoice_id'] : []), ...(Number(r?.unapplied) > 0 ? ['unapplied'] : [])]]
          : []),
      ],
      chatter: true,
    },
  },
};
