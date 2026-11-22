// Bank reconciliation: statement lines matched to open invoices/bills, or booked directly to an account.
import { read, search, write } from '../orm.js';
import { monthFilters, shiftMonth, today } from './common.js';
import { bookedBankSuspenseAccountId, bookedStatementAmount, ensureBankSuspense, invoiceCounterpartAccount, isBookedToSuspense, isLiquidityAccount, isLiquidityJournal, isPaymentMatched, outstandingAccount, paymentJournal, postEntry, statementCompanyAmount, statementPaymentIds } from './ledger.js';
import { rateAt, toCompany } from './currency.js';
import { appendDocumentSettlement, bookEarlyDiscount, earlyDiscountForAmount, residual, settleWriteoff } from './accounting.js';
import { settlementCompanyAmount } from './settlement.js';
import { applyRule, counterpartTaxLines, sameCommercialPartner, suggestRule } from './reconcile.js';
import { importStatement } from './statements.js';
import { roundStatementAmount } from './bankstatement.js';
import { datedLockDelete, datedLockGuard, moveDate, recordLockDate, writeBankStatementMove } from './finance.js';
import { exchangeAccount } from './exchange-account.js';
import { companyCurrencyRecord, documentCurrency, roundCurrency } from '../money.js';
import { shouldBePaid } from './billcontrol.js';
import { reverseEntry, reverseWriteoff, unreconcileInvoicePayment } from './pay.js';
import { removeAnalytic } from './analyticplus.js';

/** The first active matching reconciliation model (by sequence), or null. */
const modelFor = (db, line) => suggestRule(db, line);
const suppliedBankMoveError = 'A bank entry cannot be supplied when creating a transaction';

const inboundTypes = ['out_invoice', 'in_refund'];
const outboundTypes = ['in_invoice', 'out_refund'];
export const eligibleCounterpart = (account, company) => Boolean(account && account.active !== false && (!account.company_id || account.company_id === company) && !['asset_cash', 'asset_receivable', 'liability_payable'].includes(account.account_type));

/** Why this line cannot settle this invoice/bill. */
export function matchError(db, line, move) {
  if (!move) return 'Select an invoice or bill to match';
  if ((line.company_id ?? 1) !== (move.company_id ?? 1)) return 'The invoice belongs to another company';
  if (line.partner_id && !sameCommercialPartner(db, line.partner_id, move.partner_id)) return 'The invoice belongs to a different commercial partner';
  if (!(Number(line.amount) > 0 || Number(line.amount) < 0)) return 'A bank transaction of 0 cannot be reconciled';
  if (move.state !== 'posted' || !(move.amount_residual > 0)) return `${move.name} has nothing left to pay`;
  const incoming = line.amount > 0;
  if (!(incoming ? inboundTypes : outboundTypes).includes(move.move_type)) {
    return incoming ? 'Money received can only settle a customer invoice or a vendor refund' : 'Money paid out can only settle a vendor bill or a customer refund';
  }
  return null;
}

/** Open posted invoices (money in) or bills (money out) whose amount due equals the line amount; same partner first. */
export function candidates(db, line) {
  const incoming = line.amount > 0;
  const lineDate = line?.date ?? today();
  const journalCurrency = line?.journal_id ? (read(db, 'account.journal', line.journal_id)?.currency_id ?? companyCurrencyRecord(db, line.company_id)?.id) : null;
  const lineAmount = Math.abs(Number(line?.amount) || 0);
  const targetResidual = (m) => {
    const disc = earlyDiscountForAmount(db, m, lineAmount, lineDate, journalCurrency);
    return disc > 0 ? m.amount_residual - disc : m.amount_residual;
  };
  return search(db, 'account.move')
    .filter((m) => m.state === 'posted' && (m.company_id ?? 1) === (line.company_id ?? 1) && m.amount_residual > 0 && (incoming ? inboundTypes : outboundTypes).includes(m.move_type)
      && (!line.partner_id || sameCommercialPartner(db, m.partner_id, line.partner_id)))
    .sort((a, b) => Number(sameCommercialPartner(db, b.partner_id, line.partner_id)) - Number(sameCommercialPartner(db, a.partner_id, line.partner_id))
      || Math.abs(targetResidual(a) - lineAmount) - Math.abs(targetResidual(b) - lineAmount));
}

/** Book the statement line's bank movement once into the bank suspense account and record it on the line
 * (bank_move_id, open_amount); each later allocation then clears part of that suspense. An already booked
 * line keeps its bank entry, so repeated matches or write-offs never post the bank movement twice. */
export function bookBankMovement(db, line, company, { date, openAmount }) {
  const compId = company ?? line.company_id ?? 1;
  const { db: suspenseDb, id: suspenseId } = ensureBankSuspense(db, compId, line.journal_id);
  const bankMoveId = line.bank_move_id;
  if (bankMoveId) return { db: suspenseDb, bankMoveId, suspense: suspenseId };
  const via = paymentJournal(suspenseDb, line.journal_id, compId);
  const incoming = line.amount > 0;
  const amount = statementCompanyAmount(suspenseDb, line);
  const currency = read(suspenseDb, 'account.journal', line.journal_id)?.currency_id;
  const foreign = currency && currency !== companyCurrencyRecord(suspenseDb, compId)?.id;
  const fx = (sign) => foreign ? { currency_id: currency, amount_currency: sign * Math.abs(line.amount) } : {};
  const moveDate = date ?? line.date ?? today();
  const booked = postEntry(suspenseDb, {
    journal: via.code,
    journal_id: line.journal_id,
    date: moveDate,
    ref: line.payment_ref || '/',
    company: compId,
    lines: incoming
      ? [{ account: via.accountId, debit: amount, ...fx(1) }, { account: suspenseId, credit: amount, ...fx(-1) }]
      : [{ account: suspenseId, debit: amount, ...fx(1) }, { account: via.accountId, credit: amount, ...fx(-1) }],
  });
  const updatedDb = line.id ? write(booked.db, 'account.bank.statement.line', line.id, { bank_move_id: booked.id, open_amount: openAmount }) : booked.db;
  return { db: updatedDb, bankMoveId: booked.id, suspense: suspenseId };
}

/** Apply the available statement balance to an invoice; an excess is held in bank suspense. */
const WRITEOFF_FIELDS = ['writeoff_account_id', 'writeoff_label', 'writeoff_amount', 'writeoff_analytic_distribution'];
const writeoffFieldsOf = (line) => Object.fromEntries(WRITEOFF_FIELDS.map((key) => [key, line?.[key] ?? null]));

export function reconcileWith(db, line, moveId) {
  if (Array.isArray(moveId)) {
    const ids = [...new Set(moveId.map(Number).filter(Boolean))];
    if (!ids.length) throw new Error('Select an invoice or bill to match');
    if (ids.length === 1) return reconcileWith(db, line, ids[0]);
    const currentLine = typeof line === 'object' && line ? line : read(db, 'account.bank.statement.line', line);
    // Only the last matched invoice carries the write-off typed on the statement line.
    const writeoffFields = writeoffFieldsOf(currentLine);
    const moves = ids.map((id) => read(db, 'account.move', id));
    for (const m of moves) {
      if (!m) throw new Error('Select an invoice or bill to match');
    }
    if (currentLine?.partner_id) {
      for (const m of moves) {
        if (!sameCommercialPartner(db, currentLine.partner_id, m.partner_id)) {
          throw new Error('All selected invoices must match the partner on the statement line');
        }
      }
    }
    for (let i = 1; i < moves.length; i++) {
      if (!sameCommercialPartner(db, moves[0].partner_id, moves[i].partner_id)) {
        throw new Error('All selected invoices must belong to the same commercial partner');
      }
    }
    let currentDb = db;
    let runningLine = currentLine;
    if (!runningLine.bank_move_id) {
      const company = runningLine.company_id ?? 1;
      const open = roundCurrency(runningLine.open_amount ?? statementCompanyAmount(currentDb, runningLine), companyCurrencyRecord(currentDb, company));
      const bookedBank = bookBankMovement(currentDb, runningLine, company, { date: runningLine.date ?? today(), openAmount: open });
      currentDb = bookedBank.db;
      runningLine = read(currentDb, 'account.bank.statement.line', runningLine.id);
    }
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const isLast = i === ids.length - 1;
      const currentWriteoff = isLast ? writeoffFields : writeoffFieldsOf(null);
      const lineToReconcile = { ...runningLine, ...currentWriteoff };
      currentDb = reconcileWith(currentDb, lineToReconcile, id);
      runningLine = read(currentDb, 'account.bank.statement.line', runningLine.id);
      if (runningLine.state === 'reconciled' || !(runningLine.open_amount > 0)) {
        if (!isLast) {
          throw new Error('The statement amount is fully used before all selected invoices are matched');
        }
        break;
      }
    }
    return currentDb;
  }
  const move = read(db, 'account.move', moveId);
  const err = matchError(db, line, move);
  if (err) throw new Error(err);
  if (shouldBePaid(db, move) === 'exception') throw new Error('Resolve or approve the three-way matching exception before paying this bill');
  if (line.state !== 'to_check') throw new Error('This bank transaction is already reconciled');
  const date = line.date ?? today();
  const company = line.company_id ?? 1;
  const round = (n) => roundCurrency(n, companyCurrencyRecord(db, company));
  const docCurrency = documentCurrency(db, move);
  const docRound = (n) => roundCurrency(n, docCurrency);
  const step = Number(docCurrency?.rounding ?? 0.01);
  const available = round(line.open_amount ?? statementCompanyAmount(db, line));
  const rate = rateAt(db, move.currency_id, date, company);
  const journalCurrency = read(db, 'account.journal', line.journal_id)?.currency_id ?? companyCurrencyRecord(db, company)?.id;
  const total = bookedStatementAmount(db, line);
  const foreignOpen = docRound(Math.abs(line.amount) * available / total);
  const sameCurrency = journalCurrency === (move.currency_id ?? companyCurrencyRecord(db, company)?.id);
  const payCurrency = read(db, 'res.currency', journalCurrency);
  const linePayAmount = total ? roundCurrency(Math.abs(line.amount) * available / total, payCurrency) : Math.abs(line.amount);
  const discount = earlyDiscountForAmount(db, move, linePayAmount, date, journalCurrency);
  if (discount > 0) {
    const sale = inboundTypes.includes(move.move_type);
    const comp = read(db, 'res.company', company);
    const discountAccount = sale ? comp?.expense_early_payment_discount_account_id : comp?.income_early_payment_discount_account_id;
    if (!discountAccount) throw new Error(`Configure the early payment discount ${sale ? 'expense' : 'income'} account on company ${comp?.name ?? company}`);
  }
  const value = discount > 0
    ? docRound(move.amount_residual - discount)
    : Math.min(docRound(move.amount_residual), sameCurrency ? foreignOpen : Number((Math.floor(available * rate / step + 1e-9) * step).toPrecision(15)));
  const used = discount > 0
    ? available
    : (sameCurrency && value === foreignOpen ? available : sameCurrency && line.bank_move_id ? round(total * value / Math.abs(line.amount)) : toCompany(db, move.currency_id, value, date, company));
  if (!(value > 0) || !(used > 0) || used > available) throw new Error('The open statement amount is too small to settle this invoice');
  const remaining = round(available - used);
  // The write-off fields describe the line's one write-off; once it is booked they are not a new request.
  const hasWriteoff = !line.writeoff_move_id && (line.writeoff_account_id != null || line.writeoff_amount != null || Boolean(line.writeoff_label));
  let writeoffValue = 0;
  if (hasWriteoff) {
    const amount = Number(line.writeoff_amount);
    const account = read(db, 'account.account', line.writeoff_account_id);
    if (!eligibleCounterpart(account, company)) throw new Error('Write-off account belongs to another company, is inactive, or is not a valid counterpart');
    if (!String(line.writeoff_label ?? '').trim()) throw new Error('Set a write-off label');
    const currency = read(db, 'res.currency', journalCurrency);
    if (!Number.isFinite(amount) || !(amount > 0) || roundCurrency(amount, currency) !== amount) throw new Error('Write-off amount must be a positive monetary amount');
    const companyAmount = statementCompanyAmount(db, line, amount);
    writeoffValue = sameCurrency ? amount : docRound(companyAmount * rate);
    if (!(writeoffValue > 0) || writeoffValue > docRound(move.amount_residual - value) || toCompany(db, move.currency_id, writeoffValue, date, company) !== companyAmount) throw new Error('Write-off amount exceeds the remaining invoice or cannot be represented in its currency');
    const receivable = invoiceCounterpartAccount(db, move);
    const bankAccount = paymentJournal(db, line.journal_id, company).accountId;
    if (account.id === receivable || account.id === bankAccount || account.id === ensureBankSuspense(db, company, line.journal_id).id) throw new Error('Write-off account must differ from the invoice, bank and suspense accounts');
  }
  let current = db;
  let bankMoveId = line.bank_move_id;
  if (!bankMoveId) {
    const bookedBank = bookBankMovement(db, line, company, { date, openAmount: available });
    current = bookedBank.db;
    bankMoveId = bookedBank.bankMoveId;
  }
  const bankMove = read(current, 'account.move', bankMoveId);
  const { db: suspDb, id: sId } = ensureBankSuspense(current, company, line.journal_id);
  current = suspDb;
  const suspenseId = bookedBankSuspenseAccountId(current, line, bankMove) ?? sId;
  const receivableAccount = invoiceCounterpartAccount(current, move);
  const incoming = line.amount > 0;
  const sale = inboundTypes.includes(move.move_type);
  const open = settlementCompanyAmount(current, move, value);
  const diff = round(sale ? used - open : open - used);
  const fx = diff ? [{ account: exchangeAccount(current, company, diff), ...(diff > 0 ? { credit: diff } : { debit: -diff }) }] : [];
  const foreign = !!move.currency_id && move.currency_id !== companyCurrencyRecord(current, company)?.id;
  const foreignAmount = (v) => foreign ? { currency_id: move.currency_id, amount_currency: docRound(v) } : {};

  // Build the rewritten lines for bankMove
  const otherLines = (bankMove.line_ids ?? []).filter((l) => l.account_id !== suspenseId);
  const counterpartLine = sale
    ? { account_id: receivableAccount, credit: open, debit: 0, partner_id: move.partner_id, name: move.name, ...foreignAmount(-value) }
    : { account_id: receivableAccount, debit: open, credit: 0, partner_id: move.partner_id, name: move.name, ...foreignAmount(value) };
  const fxLines = fx.map((f) => ({ account_id: f.account, debit: f.debit || 0, credit: f.credit || 0, partner_id: move.partner_id, name: 'Exchange Difference' }));

  const externalAllocated = (line.allocations ?? [])
    .filter((a) => a.payment_move_id && a.payment_move_id !== bankMoveId)
    .reduce((sum, a) => sum + (Number(a.amount) || 0), 0);
  const totalSuspense = round(remaining + externalAllocated);
  let remainingSuspenseLine = null;
  if (totalSuspense > 0) {
    const journalCurr = read(current, 'account.journal', line.journal_id)?.currency_id;
    const journalForeign = journalCurr && journalCurr !== companyCurrencyRecord(current, company)?.id;
    const foreignRemaining = journalForeign ? roundCurrency(Math.abs(line.amount) * totalSuspense / total, read(current, 'res.currency', journalCurr)) : null;
    const suspenseFx = (sign) => journalForeign ? { currency_id: journalCurr, amount_currency: sign * foreignRemaining } : {};
    remainingSuspenseLine = incoming
      ? { account_id: suspenseId, debit: 0, credit: totalSuspense, ...suspenseFx(-1), name: line.payment_ref }
      : { account_id: suspenseId, debit: totalSuspense, credit: 0, ...suspenseFx(1), name: line.payment_ref };
  }
  const newLines = [...otherLines, counterpartLine, ...fxLines, ...(remainingSuspenseLine ? [remainingSuspenseLine] : [])];

  current = writeBankStatementMove(current, bankMoveId, newLines);

  // Append document settlement to invoice
  const settled = appendDocumentSettlement(current, move.id, {
    amount: value,
    moveId: bankMoveId,
    date,
    companyAmount: open,
    paymentCompanyAmount: used,
    final: value >= residual(move, current),
  });
  current = settled.db;

  if (discount > 0) {
    current = bookEarlyDiscount(current, move.id, discount, date, bankMoveId);
  }

  const writeoff = hasWriteoff ? settleWriteoff(current, moveId, writeoffValue, statementCompanyAmount(db, line, Number(line.writeoff_amount)), date, { accountId: line.writeoff_account_id, label: line.writeoff_label, journalId: line.journal_id, analyticDistribution: line.writeoff_analytic_distribution ?? null }) : null;
  current = writeoff?.db ?? current;

  return write(current, 'account.bank.statement.line', line.id, {
    state: remaining ? 'to_check' : 'reconciled',
    move_id: moveId,
    payment_move_id: bankMoveId,
    writeoff_move_id: writeoff?.id ?? line.writeoff_move_id ?? null,
    bank_move_id: bankMoveId,
    open_amount: remaining,
    allocations: [...(line.allocations ?? []), { invoice_id: moveId, payment_move_id: bankMoveId, amount: used, ...(writeoff ? { writeoff_move_id: writeoff.id } : {}) }],
    partner_id: line.partner_id ?? move.partner_id,
    ...(hasWriteoff ? writeoffFieldsOf(line) : {}),
  });
}

/** A journal-less batch belongs to the common company of its active payments. */
const batchPaymentCompany = (db, batch) => {
  if (!batch) return null;
  if (batch.journal_id) return read(db, 'account.journal', batch.journal_id)?.company_id ?? 1;
  const lines = (batch.lines ?? []).filter((line) => !line.cancelled && line.payment_id);
  const payments = lines.map((line) => read(db, 'account.payment', line.payment_id));
  if (!payments.length || payments.some((payment) => !payment)) return null;
  const companies = new Set(payments.map((payment) => payment.company_id ?? 1));
  if (companies.size !== 1) return null;
  const common = companies.values().next().value;
  return (batch.company_id ?? 1) === common ? common : null;
};

export { bookedBankSuspenseAccountId, bookedStatementAmount, isPaymentMatched, statementCompanyAmount, unreconciledSuspenseTransactionsExist } from './ledger.js';

/**
 * Resolve the outstanding receipts or payments account ID of a payment, or null when booked directly to liquidity.
 */
export function paymentOutstandingAccountId(db, payment) {
  if (!payment) return null;
  if (payment.outstanding_account_id !== undefined) return payment.outstanding_account_id;
  const journalId = payment.journal_id ?? (payment.move_id ? read(db, 'account.move', payment.move_id)?.journal_id : null);
  const journal = journalId ? read(db, 'account.journal', journalId) : null;
  return outstandingAccount(db, journal, payment.company_id ?? 1, payment.payment_type === 'inbound');
}

/**
 * Pick the signed liquidity or outstanding move line from a posted payment entry.
 * @param {object} db - Immutable database.
 * @param {object} entry - The posted account.move of the payment.
 * @param {boolean} incoming - True for inbound (debit), false for outbound (credit).
 * @param {number|null} [targetAccountId] - Optional account ID filter.
 * @returns {object|null}
 */
export function paymentLiquidityLine(db, entry, incoming, targetAccountId = null) {
  const lines = (entry?.line_ids ?? []).filter((l) => {
    const signed = incoming
      ? Number(l.debit) > 0 && !Number(l.credit)
      : Number(l.credit) > 0 && !Number(l.debit);
    if (!signed) return false;
    if (targetAccountId != null) return l.account_id === targetAccountId;
    const account = read(db, 'account.account', l.account_id);
    return isLiquidityAccount(account);
  });
  return lines.length === 1 ? lines[0] : null;
}

const allocatedPaymentIds = (line) => new Set((line?.allocations ?? []).flatMap((a) => a.payment_ids ?? []));
const allocatedBatchIds = (line) => new Set((line?.allocations ?? []).map((a) => a.batch_payment_id).filter(Boolean));

/** Why this payment cannot be matched to the statement line (or null when eligible). */
export function paymentMatchError(db, line, payment, { journal = null, companyCurrency = null, allowMatched = false, allowLinePayments = false } = {}) {
  const company = line?.company_id ?? 1;
  const amount = Number(line?.amount);
  const incoming = amount > 0;
  if (!(amount > 0 || amount < 0) || !payment || (payment.payment_type === 'inbound') !== incoming) {
    return 'Statement amount and direction must match the payment';
  }
  if (payment.state !== 'posted' || !payment.move_id) return 'Select a posted payment';
  if ((payment.company_id ?? 1) !== company) return 'The payment belongs to another company';
  if (!allowMatched && (isPaymentMatched(db, payment, line?.id) || (!allowLinePayments && allocatedPaymentIds(line).has(payment.id)))) return 'Payment is already matched';
  const statementJournal = journal ?? (line?.journal_id ? read(db, 'account.journal', line.journal_id) : null);
  const compCurrency = companyCurrency ?? read(db, 'res.company', company)?.currency_id;
  if (statementJournal?.currency_id && (payment.currency_id ?? compCurrency) !== statementJournal.currency_id) {
    return 'Payment currency must match the bank journal currency';
  }
  const outstandingAccount = paymentOutstandingAccountId(db, payment);
  const statementJournalId = statementJournal?.id ?? line?.journal_id;
  if (!outstandingAccount && statementJournalId) {
    const entry = read(db, 'account.move', payment.move_id);
    if (!entry || entry.state !== 'posted' || (entry.company_id ?? 1) !== company) {
      return 'Payment entry must be posted in the same company';
    }
    const liquidityLine = paymentLiquidityLine(db, entry, incoming);
    if (!liquidityLine) return 'Cannot identify the payment outstanding item';
    const statementAccountId = paymentJournal(db, statementJournalId, company).accountId;
    const paymentAccountId = liquidityLine.account_id;
    if (statementAccountId !== paymentAccountId) {
      const paymentJournalId = payment.journal_id ?? entry.journal_id;
      const payJournal = paymentJournalId ? read(db, 'account.journal', paymentJournalId) : null;
      const journalName = payJournal?.name || payJournal?.code || paymentJournalId || 'Bank';
      return `This payment was booked directly on journal ${journalName}; match it from that journal's statement`;
    }
  }
  return null;
}

/** Posted, unmatched payments of the statement line's company and direction eligible for matching. */
export function eligiblePayments(db, line) {
  if (!line || !(Number(line.amount) > 0 || Number(line.amount) < 0)) return [];
  const company = line.company_id ?? 1;
  const journal = line.journal_id ? read(db, 'account.journal', line.journal_id) : null;
  if (journal && (journal.active === false || !isLiquidityJournal(journal))) return [];
  if (journal?.company_id && journal.company_id !== company) return [];
  const companyCurrency = read(db, 'res.company', company)?.currency_id;
  return search(db, 'account.payment')
    .filter((payment) => !paymentMatchError(db, line, payment, { journal, companyCurrency }))
    .sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')) || a.id - b.id);
}

function resolveAndValidatePayments(db, line) {
  const company = line.company_id ?? 1;
  const allocated = allocatedPaymentIds(line);
  const allocatedBatches = allocatedBatchIds(line);
  const batchPayments = (batchId) => {
    const batch = read(db, 'account.batch.payment', batchId);
    if (!batch || batch.state !== 'posted') throw new Error('Select a posted batch payment');
    if (batchPaymentCompany(db, batch) !== company) throw new Error('The payment belongs to another company');
    return (batch.lines ?? []).filter((l) => !l.cancelled && l.payment_id).map((l) => read(db, 'account.payment', l.payment_id));
  };
  const listIds = Array.isArray(line.payment_ids) ? line.payment_ids.filter(Boolean) : [];
  const unallocatedListIds = listIds.filter((id) => !allocated.has(id));
  const hasNewBatch = Boolean(line.batch_payment_id && !allocatedBatches.has(line.batch_payment_id));
  let payments = [];
  let usedBatchId = null;
  if (hasNewBatch) {
    payments = batchPayments(line.batch_payment_id);
    usedBatchId = line.batch_payment_id;
  } else if (unallocatedListIds.length > 0) {
    payments = unallocatedListIds.map((id) => read(db, 'account.payment', id));
  } else if (line.payment_id && !allocated.has(line.payment_id)) {
    const single = read(db, 'account.payment', line.payment_id);
    payments = single ? [single] : [];
  } else if (line.batch_payment_id) {
    payments = batchPayments(line.batch_payment_id);
  } else if (listIds.length > 0) {
    payments = listIds.map((id) => read(db, 'account.payment', id));
  } else if (line.payment_id) {
    const single = read(db, 'account.payment', line.payment_id);
    payments = single ? [single] : [];
  }
  if (!payments.length) throw new Error('Select a posted payment');

  const incoming = line.amount > 0;
  if (!line.amount || payments.some((p) => !p || (p.payment_type === 'inbound') !== incoming)) {
    throw new Error('Statement amount and direction must match the payment');
  }
  if (new Set(payments.map((payment) => payment.id)).size !== payments.length) throw new Error('A payment can only be selected once');
  if (new Set(payments.map((payment) => payment.move_id)).size !== payments.length) throw new Error('A payment can only be selected once');

  const via = paymentJournal(db, line.journal_id ?? payments[0].journal_id, company);
  const journal = read(db, 'account.journal', via.id);
  if (journal && !isLiquidityJournal(journal)) throw new Error('Bank transactions need a bank or cash journal');
  if (journal?.company_id && journal.company_id !== company) throw new Error('The bank journal belongs to another company or does not exist');
  // Amounts are compared in company currency; only a foreign-currency bank journal fixes the payment currency.
  const companyCurrency = read(db, 'res.company', company)?.currency_id;
  for (const payment of payments) {
    const err = paymentMatchError(db, line, payment, { journal, companyCurrency });
    if (err) throw new Error(err);
  }
  return { payments, via, journal, usedBatchId };
}

function paymentOutstandingItem(db, payment, line, via) {
  const company = line.company_id ?? 1;
  const round = (n) => roundCurrency(n, companyCurrencyRecord(db, company));
  const incoming = line.amount > 0;
  const entry = read(db, 'account.move', payment.move_id);
  if (!entry || entry.state !== 'posted' || (entry.company_id ?? 1) !== company) {
    throw new Error('Payment entry must be posted in the same company');
  }
  const outstanding = paymentOutstandingAccountId(db, payment);
  const liquidityLine = paymentLiquidityLine(db, entry, incoming, outstanding);
  if (!liquidityLine) throw new Error('Cannot identify the payment outstanding item');
  const targetAccount = outstanding ?? liquidityLine.account_id;
  if (!outstanding && targetAccount !== via.accountId) {
    throw new Error('Cannot identify the payment outstanding item');
  }
  if (outstanding && outstanding === via.accountId) throw new Error('Outstanding and bank accounts must differ');
  return {
    account: targetAccount,
    amount: round(incoming ? liquidityLine.debit : liquidityLine.credit),
    partner_id: payment.partner_id,
    name: payment.name || line.payment_ref,
    isDirect: !outstanding,
    currency_id: liquidityLine.currency_id ?? null,
  };
}

export function matchPayment(db, line) {
  if (line.state !== 'to_check') throw new Error('This bank transaction is already reconciled');
  const company = line.company_id ?? 1;
  const round = (n) => roundCurrency(n, companyCurrencyRecord(db, company));
  const { payments, via, journal, usedBatchId } = resolveAndValidatePayments(db, line);
  const outstandingItems = payments.map((p) => paymentOutstandingItem(db, p, line, via));
  const bookedTotal = line.bank_move_id ? bookedStatementAmount(db, line) : statementCompanyAmount(db, line);
  const amount = line.bank_move_id ? round(line.open_amount) : bookedTotal;
  const paymentsTotal = round(outstandingItems.reduce((sum, item) => sum + item.amount, 0));
  const incoming = line.amount > 0;
  const foreign = journal?.currency_id && journal.currency_id !== companyCurrencyRecord(db, company)?.id;
  const journalCurr = foreign ? read(db, 'res.currency', journal.currency_id) : null;
  const fxAmounts = foreign ? payments.map((p) => roundCurrency(p.amount, journalCurr)) : [];
  const foreignAmount = foreign
    ? (line.bank_move_id
        ? roundCurrency(Math.abs(line.amount) * amount / bookedTotal, journalCurr)
        : Math.abs(line.amount))
    : amount;
  const foreignPaymentsTotal = foreign
    ? roundCurrency(fxAmounts.reduce((a, b) => a + b, 0), journalCurr)
    : paymentsTotal;
  const foreignDifference = foreign
    ? roundCurrency(foreignPaymentsTotal - foreignAmount, journalCurr)
    : 0;
  const difference = round(paymentsTotal - amount);
  const isPartial = !line.writeoff_account_id && (foreign ? foreignDifference < 0 : difference < 0);
  const needsWriteoff = !isPartial && (foreign ? foreignDifference !== 0 : difference !== 0);
  let writeoffAccount = null;
  if (needsWriteoff) {
    if (!line.writeoff_account_id) throw new Error('The selected payments must total the bank transaction amount');
    writeoffAccount = read(db, 'account.account', line.writeoff_account_id);
    if (!eligibleCounterpart(writeoffAccount, company)) {
      throw new Error('Select a write-off account belonging to the payment company for the bank difference');
    }
    if (!String(line.writeoff_label ?? '').trim()) throw new Error('Set a write-off label for the bank difference');
    if (line.writeoff_amount != null) {
      const configuredAmount = Number(line.writeoff_amount);
      const currency = read(db, 'res.currency', journal?.currency_id) ?? companyCurrencyRecord(db, company);
      const expected = Math.abs(foreign ? foreignDifference : difference);
      if (!Number.isFinite(configuredAmount) || configuredAmount < 0 || roundCurrency(configuredAmount, currency) !== configuredAmount || configuredAmount !== expected) {
        throw new Error('Write-off amount must equal the payment difference in statement currency');
      }
    }
    const forbidden = new Set([via.accountId, ensureBankSuspense(db, company, line.journal_id).id, ...outstandingItems.map((item) => item.account)]);
    if (forbidden.has(writeoffAccount.id)) throw new Error('Write-off account must differ from the bank, suspense and outstanding accounts');
  }
  const usedForeign = isPartial ? foreignPaymentsTotal : foreignAmount;
  const usedAmount = isPartial
    ? (foreign ? round(bookedTotal * usedForeign / Math.abs(line.amount)) : paymentsTotal)
    : amount;
  if (!(usedAmount > 0) || (isPartial ? !(usedAmount < amount) : !(usedForeign > 0))) {
    throw new Error('The open statement amount is too small to match this payment');
  }
  let currentDb = db;
  let bankMoveId = line.bank_move_id;
  if (!bankMoveId) {
    const bookedBank = bookBankMovement(db, line, company, { date: line.date ?? today(), openAmount: amount });
    currentDb = bookedBank.db;
    bankMoveId = bookedBank.bankMoveId;
  }
  const bankMove = read(currentDb, 'account.move', bankMoveId);
  const { db: suspDb, id: suspenseId } = ensureBankSuspense(currentDb, company, line.journal_id);
  currentDb = suspDb;

  const fx = (value) => foreign ? { currency_id: journal.currency_id, amount_currency: value } : {};
  const writeoff = needsWriteoff ? (foreign ? statementCompanyAmount(db, line, foreignDifference) : difference) : 0;
  const writeoffLines = [];
  if (needsWriteoff) {
    const companyNet = incoming ? writeoff : -writeoff;
    const currencyNet = incoming ? foreignDifference : -foreignDifference;
    writeoffLines.push({ account_id: writeoffAccount.id, partner_id: line.partner_id ?? null, name: line.writeoff_label, debit: Math.max(0, companyNet), credit: Math.max(0, -companyNet), ...fx(currencyNet) });
  }
  const exchangeDifference = round((incoming ? 1 : -1) * (writeoff - (paymentsTotal - usedAmount)));
  const exchangeLines = exchangeDifference
    ? [{ account_id: exchangeAccount(currentDb, company, exchangeDifference), debit: exchangeDifference < 0 ? -exchangeDifference : 0, credit: exchangeDifference > 0 ? exchangeDifference : 0, partner_id: line.partner_id ?? null, name: 'Exchange Difference' }]
    : [];

  const paymentLines = outstandingItems.map((item, i) => (incoming
    ? { account_id: item.account, debit: 0, credit: item.amount, partner_id: item.partner_id, name: item.name, ...fx(-fxAmounts[i]) }
    : { account_id: item.account, debit: item.amount, credit: 0, partner_id: item.partner_id, name: item.name, ...fx(fxAmounts[i]) }));

  const otherLines = (bankMove.line_ids ?? []).filter((l) => l.account_id !== suspenseId);
  const remaining = isPartial ? round(amount - usedAmount) : 0;
  const externalAllocated = (line.allocations ?? [])
    .filter((a) => a.payment_move_id && a.payment_move_id !== bankMoveId)
    .reduce((sum, a) => sum + (Number(a.amount) || 0), 0);
  const totalSuspense = round(remaining + externalAllocated);
  let remainingSuspenseLine = null;
  if (totalSuspense > 0) {
    const foreignRemaining = foreign ? roundCurrency(Math.abs(line.amount) * totalSuspense / bookedTotal, journalCurr) : null;
    const remFx = (sign) => foreign ? { currency_id: journal.currency_id, amount_currency: sign * foreignRemaining } : {};
    remainingSuspenseLine = incoming
      ? { account_id: suspenseId, debit: 0, credit: totalSuspense, ...remFx(-1), name: line.payment_ref || '/' }
      : { account_id: suspenseId, debit: totalSuspense, credit: 0, ...remFx(1), name: line.payment_ref || '/' };
  }
  const newLines = [...otherLines, ...paymentLines, ...writeoffLines, ...exchangeLines, ...(remainingSuspenseLine ? [remainingSuspenseLine] : [])];
  currentDb = writeBankStatementMove(currentDb, bankMoveId, newLines);

  const state = remaining > 0 ? 'to_check' : 'reconciled';
  const allPaymentIds = [...new Set([...allocatedPaymentIds(line), ...payments.map((p) => p.id)])];
  const singlePayment = allPaymentIds.length === 1 ? read(currentDb, 'account.payment', allPaymentIds[0]) : null;
  const allocation = {
    payment_move_id: bankMoveId,
    amount: usedAmount,
    payment_ids: payments.map((p) => p.id),
    ...(usedBatchId ? { batch_payment_id: usedBatchId } : {}),
  };

  return {
    db: write(currentDb, 'account.bank.statement.line', line.id, {
      state,
      move_id: remaining > 0 ? null : bankMoveId,
      bank_move_id: bankMoveId,
      open_amount: remaining,
      allocations: [...(line.allocations ?? []), allocation],
      payment_move_id: singlePayment?.move_id ?? null,
      payment_id: singlePayment?.id ?? null,
      payment_ids: allPaymentIds,
      batch_payment_id: line.batch_payment_id ?? null,
      partner_id: line.partner_id ?? payments[0]?.partner_id ?? null,
      ...(writeoffAccount ? writeoffFieldsOf(line) : {}),
    }),
  };
}

function autoReconcile(db, line) {
  const round = (n) => roundCurrency(n, companyCurrencyRecord(db, line.company_id));
  const target = round(line.open_amount ?? statementCompanyAmount(db, line));
  const journalCurrency = line?.journal_id ? (read(db, 'account.journal', line.journal_id)?.currency_id ?? companyCurrencyRecord(db, line.company_id)?.id) : null;
  const lineAmount = Math.abs(Number(line?.amount) || 0);
  const exact = candidates(db, line).filter((m) => toCompany(db, m.currency_id, m.amount_residual, line.date ?? today(), m.company_id) === target
    || Boolean(earlyDiscountForAmount(db, m, lineAmount, line.date ?? today(), journalCurrency)));
  if (!line.partner_id) {
    if (exact.length) throw new Error('Select the statement partner, then review and confirm a matching invoice candidate');
    throw new Error('No open invoice or bill with this exact amount. Pick one in "Match with" or book it to an account.');
  }
  if (!exact.length) throw new Error('No open invoice or bill with this exact amount belongs to the statement partner. Pick one in "Match with" or book it to an account.');
  if (exact.length > 1) throw new Error('Multiple invoices match. Review and select one in "Match with".');
  return { db: reconcileWith(db, line, exact[0].id) };
}

/**
 * Book the remaining open statement amount (or a positive partial override `opts.amount`) to `line.counterpart_account_id`.
 * Reused by the bank statement form button and the two-pane bank reconciliation Manual Operation tab.
 */
export function bookToAccount(db, line, opts = {}) {
  const round = (n) => roundCurrency(n, companyCurrencyRecord(db, line.company_id));
  if (!(Number(line.amount) > 0 || Number(line.amount) < 0)) throw new Error('A bank transaction of 0 cannot be reconciled');
  paymentJournal(db, line.journal_id, line.company_id ?? 1); // refuses a journal without a liquidity account before anything else
  const account = read(db, 'account.account', line.counterpart_account_id);
  if (!eligibleCounterpart(account, line.company_id ?? 1)) throw new Error('Select a valid counterpart account for this company');
  const open = round(line.open_amount ?? statementCompanyAmount(db, line));
  if (!(open > 0)) throw new Error('This bank transaction has no open amount');
  const requested = opts?.amount != null ? round(Number(opts.amount)) : open;
  if (!Number.isFinite(requested) || !(requested > 0) || requested > open) throw new Error('Manual operation amount must be positive and within the open statement balance');
  const remaining = round(open - requested);
  let current = db;
  let bankMoveId = line.bank_move_id;
  if (!bankMoveId) {
    const bookedBank = bookBankMovement(current, line, line.company_id ?? 1, { date: line.date ?? today(), openAmount: open });
    current = bookedBank.db;
    bankMoveId = bookedBank.bankMoveId;
  }
  const bankMove = read(current, 'account.move', bankMoveId);
  const { db: suspDb, id: sId } = ensureBankSuspense(current, line.company_id ?? 1, line.journal_id);
  current = suspDb;
  const suspenseId = bookedBankSuspenseAccountId(current, line, bankMove) ?? sId;
  const currency = read(current, 'account.journal', line.journal_id)?.currency_id;
  const foreign = currency && currency !== companyCurrencyRecord(current, line.company_id)?.id;
  const foreignValue = foreign
    ? (requested === open && line.open_amount == null
        ? Math.abs(line.amount)
        : roundCurrency(Math.abs(line.amount) * requested / bookedStatementAmount(current, line), read(current, 'res.currency', currency)))
    : Math.abs(requested);

  const company = line.company_id ?? 1;
  const rawTaxIds = opts?.tax_ids ?? opts?.taxIds ?? line.tax_ids ?? [];
  const entryRef = String(opts?.label ?? line.payment_ref ?? '').trim() || line.payment_ref;

  const counterparts = counterpartTaxLines(current, {
    company,
    tax_ids: rawTaxIds,
    amount: foreign ? foreignValue : Math.abs(requested),
    account_id: account.id,
    incoming: line.amount > 0,
    currency: read(current, 'res.currency', currency),
    foreignCurrency: foreign ? currency : null,
    companyValue: Math.abs(requested),
    balance: foreign ? foreignValue : Math.abs(requested),
    date: line.date,
    partner_id: line.partner_id ?? null,
    name: entryRef,
  }).map((l) => ({ ...l, account_id: l.account_id ?? l.account, debit: l.debit ?? 0, credit: l.credit ?? 0 }));

  const otherLines = (bankMove.line_ids ?? []).filter((l) => l.account_id !== suspenseId);
  const externalAllocated = (line.allocations ?? [])
    .filter((a) => a.payment_move_id && a.payment_move_id !== bankMoveId)
    .reduce((sum, a) => sum + (Number(a.amount) || 0), 0);
  const totalSuspense = round(remaining + externalAllocated);
  let remSuspenseLine = null;
  if (totalSuspense > 0) {
    const foreignRem = foreign ? roundCurrency(Math.abs(line.amount) * totalSuspense / bookedStatementAmount(current, line), read(current, 'res.currency', currency)) : null;
    const remFx = (sign) => foreign ? { currency_id: currency, amount_currency: sign * foreignRem } : {};
    remSuspenseLine = (line.amount > 0)
      ? { account_id: suspenseId, debit: 0, credit: totalSuspense, ...remFx(-1), name: line.payment_ref || '/' }
      : { account_id: suspenseId, debit: totalSuspense, credit: 0, ...remFx(1), name: line.payment_ref || '/' };
  }
  const newLines = [...otherLines, ...counterparts, ...(remSuspenseLine ? [remSuspenseLine] : [])];
  current = writeBankStatementMove(current, bankMoveId, newLines);

  return {
    db: write(current, 'account.bank.statement.line', line.id, {
      state: remaining > 0 ? 'to_check' : 'reconciled',
      move_id: bankMoveId,
      bank_move_id: bankMoveId,
      counterpart_account_id: account.id,
      open_amount: remaining,
      allocations: [...(line.allocations ?? []), { payment_move_id: bankMoveId, amount: requested }],
    }),
  };
}

/** Reject unreconciling when the statement line date, or any bank or counterpart entry, is on or before a lock date. */
function unreconcileLockError(db, line, ctx = null) {
  if (!line) return null;
  const lineLock = recordLockDate(db, line, ctx);
  const violatedLocks = [];
  if (lineLock && String(line.date ?? today()) <= lineLock) {
    violatedLocks.push(lineLock);
  }
  const moveIds = new Set([
    line.bank_move_id,
    line.move_id,
    line.payment_move_id,
    line.writeoff_move_id,
    ...(line.allocations ?? []).flatMap((a) => [a.payment_move_id, a.writeoff_move_id, ...(a.payment_ids ?? []).map((id) => read(db, 'account.payment', id)?.move_id)]),
    ...(line.payment_id ? [read(db, 'account.payment', line.payment_id)?.move_id] : []),
    ...((line.payment_ids ?? []).map((id) => read(db, 'account.payment', id)?.move_id)),
    ...((line.batch_payment_id ? (read(db, 'account.batch.payment', line.batch_payment_id)?.lines ?? []).map((l) => read(db, 'account.payment', l.payment_id)?.move_id) : [])),
  ].filter(Boolean));
  for (const moveId of moveIds) {
    const move = read(db, 'account.move', moveId);
    if (!move) continue;
    const moveLock = recordLockDate(db, move, ctx);
    if (moveLock && moveDate(move) <= moveLock) {
      violatedLocks.push(moveLock);
    }
  }
  if (!violatedLocks.length) return null;
  const lock = violatedLocks.sort().at(-1);
  return `The period up to ${lock} is locked`;
}

/** Validate a release against restored suspense entry and unlinked settlements rather than trusting a client flag. */
function unreconcileError(db, before, after, ctx = null) {
  const lockError = unreconcileLockError(db, before, ctx);
  if (lockError) return lockError;
  if (before.statement_id) {
    const stmt = read(db, 'account.bank.statement', before.statement_id);
    if (stmt?.state === 'closed') return 'Cannot unreconcile lines of a closed statement';
  }
  if (after.state !== 'to_check' || after.move_id || after.payment_id || (after.payment_ids ?? []).length || after.batch_payment_id || after.payment_move_id || after.writeoff_move_id || (after.allocations ?? []).length || WRITEOFF_FIELDS.some((k) => after[k] != null)) {
    return 'Unreconciliation requires clearing the matched links';
  }
  const clearedFields = new Set(['state', 'move_id', 'payment_id', 'payment_ids', 'batch_payment_id', 'payment_move_id', 'writeoff_move_id', 'allocations', 'open_amount', 'bank_move_id', ...WRITEOFF_FIELDS, 'name']);
  if ([...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => !clearedFields.has(k)).some((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null))) {
    return 'A reconciled bank transaction cannot be changed';
  }
  const bankId = before.bank_move_id ?? (before.payment_id ? before.move_id : null);
  if (!bankId) return 'Cannot unreconcile a transaction without its bank entry link';
  const linkedPayments = statementPaymentIds(db, before).map((id) => read(db, 'account.payment', id));
  const isDirect = linkedPayments.length > 0 && linkedPayments.every((p) => p && !paymentOutstandingAccountId(db, p));
  if (isDirect && linkedPayments.some((payment) => payment?.move_id === bankId)) {
    if (after.bank_move_id || after.open_amount != null) {
      return 'Unreconciliation requires reversing entries and clearing the bank links';
    }
    for (const pid of before.payment_ids ?? (before.payment_id ? [before.payment_id] : [])) {
      if (read(db, 'account.payment', pid)?.state !== 'posted') return 'The matched payment must remain posted';
    }
    return null;
  }
  if (after.bank_move_id !== bankId) return 'Cannot unreconcile a transaction without its bank entry link';
  const company = after.company_id ?? 1;
  const expectedOpen = statementCompanyAmount(db, after);
  if (roundCurrency(Number(after.open_amount), companyCurrencyRecord(db, company)) !== expectedOpen) {
    return 'Unreconciliation must restore the open statement balance';
  }
  const bankEntry = read(db, 'account.move', bankId);
  if (!bankEntry || bankEntry.state !== 'posted') return 'The bank entry must be posted';
  const { id: suspenseId } = ensureBankSuspense(db, company, after.journal_id);
  const via = paymentJournal(db, after.journal_id, company);
  const bankLines = (bankEntry.line_ids ?? []).filter((l) => l.account_id === via.accountId);
  const suspLines = (bankEntry.line_ids ?? []).filter((l) => l.account_id === suspenseId);
  if (bankLines.length !== 1 || suspLines.length !== 1 || (bankEntry.line_ids ?? []).length !== 2) {
    return 'Unreconciliation requires restoring the bank suspense entry';
  }
  const sign = after.amount > 0 ? 1 : -1;
  const signed = (item) => roundCurrency(sign * (Number(item.debit || 0) - Number(item.credit || 0)), companyCurrencyRecord(db, company));
  if (signed(bankLines[0]) !== expectedOpen || signed(suspLines[0]) !== -expectedOpen) {
    return 'Unreconciliation requires restoring the bank suspense entry';
  }
  const allocations = before.allocations ?? [];
  for (const a of allocations) {
    if (a.partial_reconcile_id) {
      const pr = read(db, 'account.partial.reconcile', a.partial_reconcile_id);
      if (pr && (pr.active !== false || !pr.reversed)) return 'Unreconciliation must deactivate partial reconcile';
    }
    if (a.invoice_id) {
      const invoice = read(db, 'account.move', a.invoice_id);
      const rows = (invoice?.payments ?? []).filter((p) => p.move_id === bankId || p.move_id === a.payment_move_id || (a.writeoff_move_id && p.move_id === a.writeoff_move_id));
      if (rows.some((r) => !r.reversed)) return 'Unreconciliation must restore the invoice settlement';
    }
  }
  if (before.payment_id && read(db, 'account.payment', before.payment_id)?.state !== 'posted') return 'The matched payment must remain posted';
  if (before.payment_ids?.length) {
    for (const pid of before.payment_ids) {
      if (read(db, 'account.payment', pid)?.state !== 'posted') return 'The matched payment must remain posted';
    }
  }
  return null;
}

/** Release a match by restoring the suspense line on its entry and unlinking the matching; existing payments are not reversed. */
export function unreconcile(db, line, reversalDate = null, ctx = null) {
  const target = read(db, 'account.bank.statement.line', line.id) ?? line;
  const lockErr = unreconcileLockError(db, target, ctx);
  if (lockErr) throw new Error(lockErr);
  if (target.statement_id) {
    const stmt = read(db, 'account.bank.statement', target.statement_id);
    if (stmt?.state === 'closed') throw new Error('Cannot unreconcile lines of a closed statement');
  }
  const bankId = target.bank_move_id ?? (target.payment_id ? target.move_id : null);
  if (!bankId) throw new Error('Cannot unreconcile a transaction without its bank entry link');
  const allocations = target.allocations ?? [];
  const date = reversalDate ?? [today(), target.date ?? '', read(db, 'account.move', bankId)?.invoice_date ?? '', ...allocations.map((a) => read(db, 'account.move', a.payment_move_id)?.invoice_date ?? '')].sort().at(-1);

  let current = db;
  const linkedPayments = statementPaymentIds(db, target).map((id) => read(db, 'account.payment', id));
  const isDirect = linkedPayments.length > 0 && linkedPayments.every((p) => p && !paymentOutstandingAccountId(db, p));
  if (isDirect && linkedPayments.some((payment) => payment?.move_id === bankId)) {
    current = write(current, 'account.bank.statement.line', target.id, {
      state: 'to_check',
      move_id: null,
      payment_id: null,
      payment_ids: [],
      batch_payment_id: null,
      payment_move_id: null,
      writeoff_move_id: null,
      ...writeoffFieldsOf(null),
      bank_move_id: null,
      open_amount: null,
      allocations: [],
    });
    return { db: current };
  }
  const reversedMoveIds = new Set();
  for (const allocation of allocations) {
    if (allocation.invoice_id) {
      current = unreconcileInvoicePayment(current, allocation.invoice_id, allocation.payment_move_id ?? bankId, { date, ctx });
      if (allocation.writeoff_move_id) current = reverseWriteoff(current, allocation.invoice_id, allocation.writeoff_move_id, date);
    } else if (allocation.payment_move_id && allocation.payment_move_id !== bankId && !reversedMoveIds.has(allocation.payment_move_id)) {
      const move = read(current, 'account.move', allocation.payment_move_id);
      if (move && move.state === 'posted' && !move.reversed_entry_id) {
        current = reverseEntry(current, move, date).db;
        reversedMoveIds.add(allocation.payment_move_id);
      }
    }
  }
  if (target.move_id && target.move_id !== bankId && !reversedMoveIds.has(target.move_id)) {
    const move = read(current, 'account.move', target.move_id);
    if (move && move.state === 'posted' && move.move_type === 'entry' && !move.reversed_entry_id) {
      current = reverseEntry(current, move, date).db;
      reversedMoveIds.add(target.move_id);
    }
  }

  // Restore the bank move lines to bank vs suspense
  const bankMove = read(current, 'account.move', bankId);
  if (bankMove) {
    const compId = target.company_id ?? bankMove.company_id ?? 1;
    const { id: suspenseId } = ensureBankSuspense(current, compId, target.journal_id);
    const via = paymentJournal(current, target.journal_id, compId);
    const incoming = target.amount > 0;
    const amount = statementCompanyAmount(current, target);
    const currency = read(current, 'account.journal', target.journal_id)?.currency_id;
    const foreign = currency && currency !== companyCurrencyRecord(current, compId)?.id;
    const fx = (sign) => foreign ? { currency_id: currency, amount_currency: sign * Math.abs(target.amount) } : {};

    const existingLiq = (bankMove.line_ids ?? []).find((l) => l.account_id === via.accountId);
    const liqLine = existingLiq ? { ...existingLiq, debit: incoming ? amount : 0, credit: incoming ? 0 : amount, ...fx(incoming ? 1 : -1) } : (incoming
      ? { account_id: via.accountId, debit: amount, credit: 0, ...fx(1), name: target.payment_ref || '/' }
      : { account_id: via.accountId, debit: 0, credit: amount, ...fx(-1), name: target.payment_ref || '/' });
    const suspLine = incoming
      ? { account_id: suspenseId, debit: 0, credit: amount, ...fx(-1), name: target.payment_ref || '/' }
      : { account_id: suspenseId, debit: amount, credit: 0, ...fx(1), name: target.payment_ref || '/' };

    const restoredLines = incoming ? [liqLine, suspLine] : [suspLine, liqLine];
    current = writeBankStatementMove(current, bankId, restoredLines);
    current = removeAnalytic(current, bankId);
  }

  const restoredOpen = statementCompanyAmount(current, target);
  current = write(current, 'account.bank.statement.line', target.id, {
    state: 'to_check',
    move_id: null,
    payment_id: null,
    payment_ids: [],
    batch_payment_id: null,
    payment_move_id: null,
    writeoff_move_id: null,
    ...writeoffFieldsOf(null),
    bank_move_id: bankId,
    open_amount: restoredOpen,
    allocations: [],
  });
  return { db: current };
}

/** Assign or clear the partner of an unreconciled bank statement line. */
export function setStatementLinePartner(db, line, partnerId) {
  const lineId = typeof line === 'object' && line ? line.id : line;
  const target = read(db, 'account.bank.statement.line', lineId);
  if (!target) throw new Error('Bank transaction does not exist');
  if (target.state === 'reconciled') throw new Error('A reconciled bank transaction cannot be changed');
  const pid = partnerId ? Number(partnerId) : null;
  if (pid) {
    const partner = read(db, 'res.partner', pid);
    if (!partner) throw new Error('Partner does not exist');
    if (partner.company_id && target.company_id && partner.company_id !== target.company_id) {
      throw new Error('Partner belongs to another company');
    }
  }
  return write(db, 'account.bank.statement.line', lineId, { partner_id: pid });
}

/** Validate the booked bank entry and payment allocations against the statement line amount and journal. */
function bankEntryGuardError(db, after, { company, round, referenceAmount, via, bankAccount, allocations, ctx: ctxForBankEntryGuard }) {
  const bankEntry = read(db, 'account.move', after.bank_move_id);
  const incoming = after.amount > 0;
  const bankLines = (bankEntry?.line_ids ?? []).filter((l) => l.account_id === bankAccount);
  const sign = incoming ? 1 : -1;
  const signedNet = (lines) => round(sign * lines.reduce((sum, l) => sum + (Number(l.debit) || 0) - (Number(l.credit) || 0), 0));

  const previousLine = (ctxForBankEntryGuard?.originalDb?.records?.['account.bank.statement.line'] ?? []).find((line) => line.id === after.id);
  const addedAllocations = (after.allocations ?? []).slice((previousLine?.allocations ?? []).length);
  const addedBankAllocations = addedAllocations.filter((allocation) => allocation.payment_move_id === after.bank_move_id);
  const operationKinds = new Set(addedBankAllocations.map((allocation) => allocation.reconcile_model_id ? 'rule'
    : allocation.invoice_id || (allocation.payment_ids ?? []).length ? 'settlement' : 'manual'));
  if (previousLine && operationKinds.size > 1) return 'The matched counterpart must match the reconciliation operation';
  const addedPayments = addedBankAllocations.flatMap((allocation) => allocation.payment_ids ?? []).map((id) => read(db, 'account.payment', id));
  const addedInvoices = addedBankAllocations.filter((allocation) => allocation.invoice_id).map((allocation) => read(db, 'account.move', allocation.invoice_id));
  const previousEntry = previousLine && read(ctxForBankEntryGuard.originalDb, 'account.move', previousLine.bank_move_id);
  if (previousEntry && addedBankAllocations.length && addedBankAllocations.every((allocation) => allocation.reconcile_model_id)) {
    let replay = ctxForBankEntryGuard.originalDb;
    for (const allocation of addedBankAllocations) {
      const rule = read(replay, 'account.reconcile.model', allocation.reconcile_model_id);
      if (!rule) return 'The matched counterpart must match the reconciliation model';
      replay = applyRule(replay, rule, read(replay, 'account.bank.statement.line', after.id));
    }
    const replayed = read(replay, 'account.move', after.bank_move_id);
    const fields = ['account_id', 'debit', 'credit', 'partner_id', 'currency_id', 'amount_currency', 'tax_id', 'tax_tag_ids', 'tax_grid_base', 'tax_side', 'analytic_distribution'];
    const canonical = (entry) => (entry?.line_ids ?? []).map((item) => JSON.stringify(fields.map((field) => item[field] ?? null))).sort();
    if (JSON.stringify(canonical(replayed)) !== JSON.stringify(canonical(bankEntry))) return 'The matched counterpart must match the reconciliation model';
  }
  if (previousEntry && (addedPayments.length || addedInvoices.length) && addedBankAllocations.every((allocation) => allocation.invoice_id || (allocation.payment_ids ?? []).length)) {
    const companyRecord = read(db, 'res.company', company);
    const bookedSuspense = bookedBankSuspenseAccountId(db, after, previousEntry);
    const allowed = new Set([bankAccount, ensureBankSuspense(db, company, after.journal_id).id,
      ...(bookedSuspense ? [bookedSuspense] : []), after.writeoff_account_id,
      companyRecord?.income_currency_exchange_account_id, companyRecord?.expense_currency_exchange_account_id,
      ...addedPayments.map((payment) => paymentOutstandingAccountId(db, payment)),
      ...addedInvoices.filter(Boolean).map((invoice) => invoiceCounterpartAccount(db, invoice))]);
    const totals = (entry) => {
      const result = new Map();
      for (const item of entry.line_ids ?? []) {
        if (allowed.has(item.account_id)) continue;
        const old = result.get(item.account_id) ?? [0, 0];
        result.set(item.account_id, [round(old[0] + Number(item.debit || 0)), round(old[1] + Number(item.credit || 0))]);
      }
      return result;
    };
    const beforeTotals = totals(previousEntry);
    const afterTotals = totals(bankEntry);
    for (const id of new Set([...beforeTotals.keys(), ...afterTotals.keys()])) {
      if (JSON.stringify(beforeTotals.get(id) ?? [0, 0]) !== JSON.stringify(afterTotals.get(id) ?? [0, 0])) return 'The matched counterpart must match the selected payment';
    }
    const expectedPaymentTotals = new Map();
    for (const payment of addedPayments) {
      const item = paymentOutstandingItem(db, payment, after, via);
      const current = expectedPaymentTotals.get(item.account) ?? [0, 0];
      current[incoming ? 1 : 0] = round(current[incoming ? 1 : 0] + item.amount);
      expectedPaymentTotals.set(item.account, current);
    }
    for (const [id, expected] of expectedPaymentTotals) {
      if (id === after.writeoff_account_id || id === companyRecord?.income_currency_exchange_account_id || id === companyRecord?.expense_currency_exchange_account_id) continue;
      const amounts = (entry) => (entry.line_ids ?? []).filter((item) => item.account_id === id)
        .reduce((sum, item) => [round(sum[0] + Number(item.debit || 0)), round(sum[1] + Number(item.credit || 0))], [0, 0]);
      const beforeAmounts = amounts(previousEntry);
      const afterAmounts = amounts(bankEntry);
      if (round(afterAmounts[0] - beforeAmounts[0]) !== expected[0] || round(afterAmounts[1] - beforeAmounts[1]) !== expected[1]) return 'The matched counterpart must match the selected payment';
    }
    if (addedPayments.length && !addedInvoices.length) {
      const amounts = (entry, id) => (entry.line_ids ?? []).filter((item) => item.account_id === id)
        .reduce((sum, item) => [round(sum[0] + Number(item.debit || 0)), round(sum[1] + Number(item.credit || 0))], [0, 0]);
      const writeoffBefore = amounts(previousEntry, after.writeoff_account_id);
      const writeoffAfter = amounts(bankEntry, after.writeoff_account_id);
      const writeoff = round(sign * (writeoffAfter[0] - writeoffAfter[1] - writeoffBefore[0] + writeoffBefore[1]));
      const paid = round(addedPayments.reduce((sum, payment) => sum + paymentOutstandingItem(db, payment, after, via).amount, 0));
      const used = round(addedBankAllocations.reduce((sum, allocation) => sum + Number(allocation.amount || 0), 0));
      const difference = round(sign * (writeoff - (paid - used)));
      const exchangeId = difference ? exchangeAccount(db, company, difference) : null;
      for (const id of new Set([companyRecord?.income_currency_exchange_account_id, companyRecord?.expense_currency_exchange_account_id].filter(Boolean))) {
        if (id === after.writeoff_account_id || expectedPaymentTotals.has(id)) continue;
        const old = amounts(previousEntry, id);
        const current = amounts(bankEntry, id);
        const expectedDebit = id === exchangeId && difference < 0 ? -difference : 0;
        const expectedCredit = id === exchangeId && difference > 0 ? difference : 0;
        if (round(current[0] - old[0]) !== expectedDebit || round(current[1] - old[1]) !== expectedCredit) return 'The matched counterpart must match the selected payment';
      }
    }
    const expectedInvoiceTotals = new Map();
    for (const invoice of addedInvoices.filter(Boolean)) {
      const original = read(ctxForBankEntryGuard.originalDb, 'account.move', invoice.id);
      const oldIds = new Set((original?.payments ?? []).map((row) => row.id));
      const rows = (invoice.payments ?? []).filter((row) => row.move_id === after.bank_move_id && !row.reversed && !oldIds.has(row.id));
      const id = invoiceCounterpartAccount(db, invoice);
      const current = expectedInvoiceTotals.get(id) ?? [0, 0];
      current[incoming ? 1 : 0] = round(current[incoming ? 1 : 0] + rows.reduce((sum, row) => sum + Number(row.company_amount || 0), 0));
      expectedInvoiceTotals.set(id, current);
    }
    for (const [id, expected] of expectedInvoiceTotals) {
      if (expectedPaymentTotals.has(id) || id === after.writeoff_account_id || id === companyRecord?.income_currency_exchange_account_id || id === companyRecord?.expense_currency_exchange_account_id) continue;
      const amounts = (entry) => (entry.line_ids ?? []).filter((item) => item.account_id === id)
        .reduce((sum, item) => [round(sum[0] + Number(item.debit || 0)), round(sum[1] + Number(item.credit || 0))], [0, 0]);
      const beforeAmounts = amounts(previousEntry);
      const afterAmounts = amounts(bankEntry);
      if (round(afterAmounts[0] - beforeAmounts[0]) !== expected[0] || round(afterAmounts[1] - beforeAmounts[1]) !== expected[1]) return 'The matched counterpart must match the selected invoice';
    }
    if (addedInvoices.length && !addedPayments.length) {
      const difference = round(sign * addedInvoices.filter(Boolean).reduce((sum, invoice) => {
        const original = read(ctxForBankEntryGuard.originalDb, 'account.move', invoice.id);
        const oldIds = new Set((original?.payments ?? []).map((row) => row.id));
        return sum + (invoice.payments ?? []).filter((row) => row.move_id === after.bank_move_id && !row.reversed && !oldIds.has(row.id))
          .reduce((amount, row) => amount + Number(row.payment_company_amount || 0) - Number(row.company_amount || 0), 0);
      }, 0));
      const exchangeId = difference ? exchangeAccount(db, company, difference) : null;
      const amounts = (entry, id) => (entry.line_ids ?? []).filter((item) => item.account_id === id)
        .reduce((sum, item) => [round(sum[0] + Number(item.debit || 0)), round(sum[1] + Number(item.credit || 0))], [0, 0]);
      for (const id of new Set([companyRecord?.income_currency_exchange_account_id, companyRecord?.expense_currency_exchange_account_id].filter(Boolean))) {
        if (expectedInvoiceTotals.has(id) || id === after.writeoff_account_id) continue;
        const old = amounts(previousEntry, id);
        const current = amounts(bankEntry, id);
        if (round(current[0] - old[0]) !== (id === exchangeId && difference < 0 ? -difference : 0)
          || round(current[1] - old[1]) !== (id === exchangeId && difference > 0 ? difference : 0)) return 'The matched counterpart must match the selected invoice';
      }
    }
  }

  const manualAllocations = allocations.filter((allocation) => allocation.payment_move_id === after.bank_move_id
    && !allocation.invoice_id && !allocation.reconcile_model_id && !(allocation.payment_ids ?? []).length);
  const addedManual = addedAllocations.filter((allocation) => allocation.payment_move_id === after.bank_move_id
    && !allocation.invoice_id && !allocation.reconcile_model_id && !(allocation.payment_ids ?? []).length);
  if (previousLine && addedManual.length && !after.counterpart_account_id) return 'The matched counterpart must match the selected account';
  if (manualAllocations.length && after.counterpart_account_id) {
    const counterpart = (bankEntry?.line_ids ?? []).filter((item) => item.account_id === after.counterpart_account_id);
    if (!counterpart.length || signedNet(counterpart) >= 0) return 'The matched counterpart must match the selected account';
    const previous = (ctxForBankEntryGuard?.originalDb?.records?.['account.bank.statement.line'] ?? []).find((line) => line.id === after.id);
    const newlyAllocated = (after.allocations ?? []).slice((previous?.allocations ?? []).length).filter((allocation) => allocation.payment_move_id === after.bank_move_id);
    const newManual = newlyAllocated.filter((allocation) => allocation.payment_move_id === after.bank_move_id
      && !allocation.invoice_id && !allocation.reconcile_model_id && !(allocation.payment_ids ?? []).length);
    const priorEntry = previous && read(ctxForBankEntryGuard.originalDb, 'account.move', previous.bank_move_id);
    if (newManual.length && newManual.length === newlyAllocated.length && priorEntry) {
      const priorTaxLines = (priorEntry.line_ids ?? []).filter((item) => item.tax_id).map((item) => JSON.stringify(item));
      const addedTaxLines = (bankEntry.line_ids ?? []).filter((item) => {
        if (!item.tax_id) return false;
        const index = priorTaxLines.indexOf(JSON.stringify(item));
        if (index < 0) return true;
        priorTaxLines.splice(index, 1);
        return false;
      });
      const taxIds = [...new Set(addedTaxLines.map((item) => item.tax_id))];
      const journal = read(db, 'account.journal', after.journal_id);
      const currency = read(db, 'res.currency', journal?.currency_id);
      const foreign = currency && currency.id !== companyCurrencyRecord(db, company)?.id;
      const expected = newManual.flatMap((allocation) => {
        const requested = Number(allocation.amount);
        const foreignValue = foreign ? roundCurrency(Math.abs(after.amount) * requested / referenceAmount, currency) : requested;
        return counterpartTaxLines(db, { company, tax_ids: taxIds, amount: foreignValue, account_id: after.counterpart_account_id,
          incoming, currency, foreignCurrency: foreign ? currency.id : null, companyValue: requested, balance: foreignValue,
          date: after.date, partner_id: after.partner_id ?? null, name: after.payment_ref });
      });
      const bookedSuspense = bookedBankSuspenseAccountId(db, after, priorEntry);
      const allowed = new Set([bankAccount, ensureBankSuspense(db, company, after.journal_id).id, ...(bookedSuspense ? [bookedSuspense] : [])]);
      const totals = (entry) => {
        const result = new Map();
        for (const item of entry.line_ids ?? []) {
          const accountId = item.account_id ?? item.account;
          if (allowed.has(accountId)) continue;
          const old = result.get(accountId) ?? [0, 0];
          result.set(accountId, [round(old[0] + Number(item.debit || 0)), round(old[1] + Number(item.credit || 0))]);
        }
        return result;
      };
      const previousTotals = totals(priorEntry);
      const nextTotals = totals(bankEntry);
      const expectedTotals = totals({ line_ids: expected });
      for (const id of new Set([...previousTotals.keys(), ...nextTotals.keys(), ...expectedTotals.keys()])) {
        const old = previousTotals.get(id) ?? [0, 0];
        const current = nextTotals.get(id) ?? [0, 0];
        const required = expectedTotals.get(id) ?? [0, 0];
        if (round(current[0] - old[0]) !== required[0] || round(current[1] - old[1]) !== required[1]) return 'The matched counterpart must match the selected account';
      }
    }
  }

  const linkedPayments = statementPaymentIds(db, after).map((id) => read(db, 'account.payment', id));
  const directPayments = linkedPayments.filter((p) => p && !paymentOutstandingAccountId(db, p));
  const directMoveIds = new Set(directPayments.map((p) => p.move_id).filter(Boolean));
  const isDirectMatch = !isBookedToSuspense(db, after)
    && directPayments.length > 0
    && after.state === 'reconciled'
    && allocations.every((a) => !a.invoice_id && !a.reconcile_model_id);

  if (isDirectMatch) {
    if (linkedPayments.some((p) => !p || p.state !== 'posted' || (p.company_id ?? 1) !== company || (p.payment_type === 'inbound') !== incoming || !p.move_id)) {
      return 'The linked payment belongs to another company or does not exist';
    }
    if (directMoveIds.size !== directPayments.length) return 'A payment can only be selected once';
    if (!directMoveIds.has(after.bank_move_id)) {
      const allocatedIds = allocations.flatMap((allocation) => allocation.payment_ids ?? []);
      if (new Set(allocatedIds).size !== allocatedIds.length || allocatedIds.length !== linkedPayments.length
        || linkedPayments.some((payment) => !allocatedIds.includes(payment.id))) return 'Bank transaction allocations must match its amount';
    }
    let directSum = 0;
    const directBookedByMove = new Map();
    const directCurrencyLines = [];
    for (const payment of directPayments) {
      const entry = read(db, 'account.move', payment.move_id);
      const entryBankLines = (entry?.line_ids ?? []).filter((l) => l.account_id === bankAccount);
      const amt = signedNet(entryBankLines);
      if (entry?.state !== 'posted' || (entry.company_id ?? 1) !== company || entryBankLines.length !== 1 || !(amt > 0)) {
        return 'The bank entry must book the transaction amount once';
      }
      directBookedByMove.set(payment.move_id, amt);
      directCurrencyLines.push(entryBankLines[0]);
      directSum = round(directSum + amt);
    }
    if (referenceAmount !== statementCompanyAmount(db, after)) {
      return 'The bank entry must book the transaction amount once';
    }
    if (directMoveIds.has(after.bank_move_id)) {
      if (linkedPayments.length !== directPayments.length || allocations.length !== directPayments.length) {
        return 'Bank transaction allocations must match its amount';
      }
      for (const allocation of allocations) {
        if (!directBookedByMove.has(allocation.payment_move_id) || round(allocation.amount) !== directBookedByMove.get(allocation.payment_move_id)) {
          return 'Bank transaction allocations must match its amount';
        }
      }
      const journalCurrId = read(db, 'account.journal', after.journal_id)?.currency_id;
      if (journalCurrId && directCurrencyLines.every((l) => l.currency_id === journalCurrId)) {
        const curr = read(db, 'res.currency', journalCurrId);
        const sumFx = directCurrencyLines.reduce((sum, l) => sum + (Number(l.amount_currency) || 0), 0);
        if (roundCurrency(sumFx, curr) !== roundCurrency(after.amount, curr)) {
          return 'The bank entry must book the transaction amount once';
        }
      }
      return null;
    }
    const expectedDelta = round(referenceAmount - directSum);
    if (bankEntry?.state !== 'posted' || (after.journal_id && bankEntry.journal_id !== after.journal_id)) {
      return 'The bank entry must book the transaction amount once';
    }
    if (signedNet(bankLines) !== expectedDelta) {
      return 'The bank entry must book the transaction amount once';
    }
    const allocated = allocations.reduce((sum, a) => sum + (Number(a.amount) || 0), 0);
    if (allocations.some((a) => !(Number(a.amount) > 0) || !a.payment_move_id) || round(allocated) !== referenceAmount) {
      return 'Bank transaction allocations must match its amount';
    }
    return null;
  }

  const allocatedPaymentIds = new Set((after.allocations ?? []).flatMap((a) => a.payment_ids ?? []));
  const activeDirectPayments = after.state === 'reconciled'
    ? directPayments
    : directPayments.filter((p) => allocatedPaymentIds.has(p.id));

  if (activeDirectPayments.length && !directMoveIds.has(after.bank_move_id)) {
    const directTotal = round(activeDirectPayments.reduce((sum, payment) => sum + paymentOutstandingItem(db, payment, after, via).amount, 0));
    const clearingTotal = round((bankEntry?.line_ids ?? []).filter((l) => l.account_id === bankAccount)
      .reduce((sum, l) => sum + Number(incoming ? l.credit || 0 : l.debit || 0), 0));
    if (clearingTotal !== directTotal) return 'The settlement must clear the matched payment amount';
  }

  const primaryBankLines = bankLines.filter((item) => sign * (Number(item.debit || 0) - Number(item.credit || 0)) > 0);
  const bankLine = primaryBankLines[0];
  const bankCurrency = bankLine?.currency_id ? read(db, 'res.currency', bankLine.currency_id) : null;
  // A journal-currency statement is booked in its own units; an account-currency line converts the company amount.
  const currencyAmountMatches = !bankCurrency
    || roundCurrency(bankLine.amount_currency, bankCurrency) === roundCurrency(after.amount, bankCurrency)
    || toCompany(db, bankCurrency.id, bankLine.amount_currency, after.date ?? today(), company) === referenceAmount;
  if (bankEntry?.state !== 'posted' || (after.journal_id && bankEntry.journal_id !== after.journal_id) || primaryBankLines.length !== 1 || (!activeDirectPayments.length && bankLines.length !== 1) || round(incoming ? bankLine.debit : bankLine.credit) !== referenceAmount || !currencyAmountMatches) {
    return 'The bank entry must book the transaction amount once';
  }
  const suspense = allocations.some((a) => a.payment_move_id !== after.bank_move_id) ? ensureBankSuspense(db, company, via.id).id : null;
  for (const allocation of allocations) {
    const entry = read(db, 'account.move', allocation.payment_move_id);
    if (allocation.invoice_id && !(read(db, 'account.move', allocation.invoice_id)?.payments ?? []).some((p) => p.move_id === allocation.payment_move_id && !p.reversed)) return 'The matched document must link to its settlement entry';
    if (allocation.writeoff_move_id) {
      const invoice = read(db, 'account.move', allocation.invoice_id);
      const writeoff = read(db, 'account.move', allocation.writeoff_move_id);
      const account = read(db, 'account.account', after.writeoff_account_id);
      const items = (writeoff?.line_ids ?? []).filter((l) => l.account_id === after.writeoff_account_id && l.name === after.writeoff_label && l.partner_id === invoice?.partner_id);
      if (after.writeoff_move_id !== allocation.writeoff_move_id || !(invoice?.payments ?? []).some((p) => p.move_id === allocation.writeoff_move_id && !p.reversed) || !account || (account.company_id && account.company_id !== company) || writeoff?.journal_id !== bankEntry.journal_id || items.length !== 1 || round(incoming ? items[0].debit : items[0].credit) !== statementCompanyAmount(db, after, Number(after.writeoff_amount))) return 'The matched document must link to its write-off entry';
    }
    if (allocation.payment_move_id !== after.bank_move_id) {
      const items = (entry?.line_ids ?? []).filter((l) => l.account_id === suspense);
      if (entry?.journal_id !== bankEntry.journal_id || items.length !== 1 || round(incoming ? items[0].debit : items[0].credit) !== round(allocation.amount)) return 'The settlement must clear the bank suspense amount';
    }
  }
  if (after.writeoff_move_id && !allocations.some((a) => a.writeoff_move_id === after.writeoff_move_id)) return 'The matched document must link to its write-off entry';
  return null;
}

function untouchedBankEntry(db, line) {
  if (!line?.bank_move_id || line.state !== 'to_check' || (line.allocations ?? []).length || line.move_id) return false;
  const move = read(db, 'account.move', line.bank_move_id);
  const journal = read(db, 'account.journal', line.journal_id);
  const suspense = bookedBankSuspenseAccountId(db, line, move)
    ?? (journal?.suspense_account_id && journal.suspense_account_id !== journal.default_account_id
      ? journal.suspense_account_id : read(db, 'res.company', line.company_id ?? 1)?.account_journal_suspense_account_id);
  if (!move || move.state !== 'posted' || move.inalterable_hash || move.journal_id !== line.journal_id || !suspense) return false;
  const lines = move.line_ids ?? [];
  const bank = lines.filter((item) => item.account_id === journal.default_account_id);
  const susp = lines.filter((item) => item.account_id === suspense);
  const round = (n) => roundCurrency(n, companyCurrencyRecord(db, line.company_id ?? 1));
  const amount = statementCompanyAmount(db, line);
  const sign = line.amount > 0 ? 1 : -1;
  const net = (item) => round(sign * (Number(item.debit || 0) - Number(item.credit || 0)));
  return lines.length === 2 && bank.length === 1 && susp.length === 1 && net(bank[0]) === amount && net(susp[0]) === -amount;
}

function hasBankReversal(db, move) {
  return (db.records['account.move'] ?? []).some((reversal) => reversal.state === 'posted' && reversal.reversed_entry_id === move?.id
    && reversal.journal_id === move.journal_id && (reversal.company_id ?? 1) === (move.company_id ?? 1)
    && (reversal.line_ids ?? []).length === (move.line_ids ?? []).length
    && (move.line_ids ?? []).every((item, i) => {
      const opposite = reversal.line_ids[i];
      return opposite.account_id === item.account_id && Number(opposite.debit || 0) === Number(item.credit || 0)
        && Number(opposite.credit || 0) === Number(item.debit || 0) && (opposite.currency_id ?? null) === (item.currency_id ?? null)
        && Number(opposite.amount_currency || 0) === -Number(item.amount_currency || 0);
    }));
}

/** A reconciled line must point at a posted entry, and is frozen afterwards (amount, sign, date, partner, label, link). */
function lineGuard(db, before, after, ctx = null) {
  const clearingBooking = before?.bank_move_id && (!after.bank_move_id || after.open_amount == null || (after.allocations ?? []).length < (before.allocations ?? []).length);
  if (before && after.state === 'to_check' && !after.move_id && (before.state === 'reconciled' || clearingBooking)) return unreconcileError(db, before, after, ctx);

  if (before?.statement_id) {
    const prevStmt = read(db, 'account.bank.statement', before.statement_id);
    if (prevStmt?.state === 'closed') {
      if (after.statement_id !== before.statement_id) {
        return 'Cannot remove lines from a closed statement';
      }
      const changed = ['amount', 'date', 'journal_id', 'company_id', 'active', 'state'].find(
        (k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null)
      );
      if (changed) return 'Cannot change lines linked to a closed statement';
    }
  }

  if (after.statement_id) {
    const statement = read(db, 'account.bank.statement', after.statement_id);
    if (!statement) return 'The bank statement does not exist';
    const comp = (before?.state === 'reconciled' ? before.company_id : after.company_id) ?? 1;
    if (statement.journal_id !== after.journal_id || (statement.company_id ?? 1) !== comp) {
      return 'Statement lines must belong to the statement journal and company';
    }
    if (statement.state === 'closed' && (!before || before.statement_id !== after.statement_id)) {
      if (before) return 'Cannot add lines to a closed statement';
      const journal = read(db, 'account.journal', after.journal_id);
      const isCash = journal?.type === 'cash';
      const expectedAccount = after.amount > 0 ? journal?.profit_account_id : journal?.loss_account_id;
      const validAccount = expectedAccount && after.counterpart_account_id === expectedAccount;
      if (!isCash || !validAccount) return 'Cannot add lines to a closed statement';
      const otherLines = search(db, 'account.bank.statement.line').filter(
        (l) => l.statement_id === statement.id && l.id !== after.id
      );
      const hasExistingDiff = otherLines.some(
        (l) => l.counterpart_account_id === journal?.profit_account_id || l.counterpart_account_id === journal?.loss_account_id
      );
      if (hasExistingDiff) return 'Cannot add lines to a closed statement';
      const otherSum = otherLines.reduce((acc, l) => acc + (Number(l.amount) || 0), 0);
      const expectedDiff = roundStatementAmount(
        db,
        statement,
        Number(statement.balance_end_real || 0) - (Number(statement.balance_start || 0) + otherSum)
      );
      if (roundStatementAmount(db, statement, after.amount) !== expectedDiff) {
        return 'Cannot add lines to a closed statement';
      }
    }
  }

  if (before?.state === 'reconciled') {
    const changed = ['state', 'amount', 'date', 'partner_id', 'move_id', 'payment_move_id', 'payment_id', 'payment_ids', 'batch_payment_id', 'writeoff_account_id', 'writeoff_label', 'writeoff_analytic_distribution', 'writeoff_amount', 'writeoff_move_id', 'bank_move_id', 'open_amount', 'allocations', 'payment_ref', 'company_id', 'journal_id', 'currency_id', 'statement_id'].find((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null));
    return changed ? 'A reconciled bank transaction cannot be changed' : null;
  }
  if (before?.bank_move_id) {
    const rebooked = before.bank_move_id !== after.bank_move_id && before.state === 'to_check' && after.state === 'to_check'
      && !(before.allocations ?? []).length && !(after.allocations ?? []).length && untouchedBankEntry(db, before)
      && hasBankReversal(db, read(db, 'account.move', before.bank_move_id))
      && (!ctx?.originalDb || !read(ctx.originalDb, 'account.move', after.bank_move_id));
    const fields = after.state === 'reconciled'
      ? ['amount', 'date', 'payment_ref', 'company_id', 'journal_id']
      : ['amount', 'date', 'payment_ref', 'company_id', 'journal_id', 'bank_move_id'];
    const changed = fields.find((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null));
    if (changed && !rebooked) return 'A booked bank transaction cannot be changed';
    if (before.bank_move_id !== after.bank_move_id && !rebooked) return 'The bank entry link cannot be changed to an unrelated entry';
  }

  const company = after.company_id ?? 1;
  const round = (n) => roundCurrency(n, companyCurrencyRecord(db, company));
  if (!after.journal_id) return 'Bank Journal is required';
  const journal = read(db, 'account.journal', after.journal_id);
  if (!journal || (journal.company_id && journal.company_id !== company)) return 'The bank journal belongs to another company or does not exist';
  if (!isLiquidityJournal(journal)) return 'Bank transactions need a bank or cash journal';
  if (after.unique_import_id && (db.records['account.bank.statement.line'] ?? []).some((l) => l.id !== after.id && l.active !== false && l.journal_id === after.journal_id && l.unique_import_id === after.unique_import_id)) {
    return 'A bank transaction with this Import ID already exists on this journal';
  }
  if (after.payment_id) {
    const payment = read(db, 'account.payment', after.payment_id);
    if (!payment || (payment.company_id ?? 1) !== company) return 'The linked payment belongs to another company or does not exist';
    const err = paymentMatchError(db, after, payment, { journal, allowMatched: after.state !== 'reconciled', allowLinePayments: true });
    if (err) return err;
  }
  if (after.payment_ids?.length) {
    for (const pid of after.payment_ids) {
      const payment = read(db, 'account.payment', pid);
      if (!payment || (payment.company_id ?? 1) !== company) return 'The linked payment belongs to another company or does not exist';
      const err = paymentMatchError(db, after, payment, { journal, allowMatched: after.state !== 'reconciled', allowLinePayments: true });
      if (err) return err;
    }
  }
  if (after.batch_payment_id) {
    const batch = read(db, 'account.batch.payment', after.batch_payment_id);
    const batchCompany = batchPaymentCompany(db, batch);
    if (!batch || batchCompany !== company) return 'The linked payment belongs to another company or does not exist';
    for (const l of (batch.lines ?? []).filter((line) => !line.cancelled && line.payment_id)) {
      const payment = read(db, 'account.payment', l.payment_id);
      if (payment) {
        const err = paymentMatchError(db, after, payment, { journal, allowMatched: after.state !== 'reconciled', allowLinePayments: true });
        if (err) return err;
      }
    }
  }
  const referenceAmount = bookedStatementAmount(db, after);
  if (after.open_amount != null && (!Number.isFinite(Number(after.open_amount)) || after.open_amount < 0 || round(after.open_amount) > referenceAmount)) return 'Invalid open bank transaction amount';

  if (after.state === 'reconciled' && !after.move_id) return 'A bank transaction can only be reconciled against a posted journal entry';
  // The server validates bank lines after the entries of the same change set (guardLast).
  for (const id of [after.state === 'reconciled' ? after.move_id : null, after.payment_move_id, after.writeoff_move_id, after.bank_move_id, ...(after.allocations ?? []).flatMap((a) => [a.payment_move_id, a.writeoff_move_id])].filter(Boolean)) {
    const move = read(db, 'account.move', id);
    if (move?.state !== 'posted') return 'A bank transaction can only be reconciled against a posted journal entry';
    if ((move.company_id ?? 1) !== company) return 'The matched entry belongs to another company';
    const journal = read(db, 'account.journal', move.journal_id);
    if (journal?.company_id && journal.company_id !== company) return 'The matched entry journal belongs to another company';
    if ((move.line_ids ?? []).some((l) => {
      const account = read(db, 'account.account', l.account_id);
      return account?.company_id && account.company_id !== company;
    })) return 'A matched entry account belongs to another company';
    if ((db.records['account.payment'] ?? []).some((p) => p.move_id === id && (p.company_id ?? 1) !== company)) return 'The linked payment belongs to another company';
  }
  if (after.state === 'reconciled' && after.open_amount > 0) return 'A reconciled bank transaction cannot have an open amount';

  if (!before && after.bank_move_id && ctx?.originalDb && read(ctx.originalDb, 'account.move', after.bank_move_id)) {
    return 'The bank entry is already linked to another transaction';
  }
  if (after.bank_move_id && !(after.allocations ?? []).length) {
    if ((db.records['account.bank.statement.line'] ?? []).some((line) => line.id !== after.id && line.bank_move_id === after.bank_move_id)) {
      return 'The bank entry is already linked to another transaction';
    }
    const move = read(db, 'account.move', after.bank_move_id);
    const suspenseId = bookedBankSuspenseAccountId(db, after, move)
      ?? (journal.suspense_account_id && journal.suspense_account_id !== journal.default_account_id
        ? journal.suspense_account_id
        : read(db, 'res.company', company)?.account_journal_suspense_account_id);
    const lines = move?.line_ids ?? [];
    const bank = lines.filter((item) => item.account_id === journal.default_account_id);
    const suspense = lines.filter((item) => item.account_id === suspenseId);
    const sign = after.amount > 0 ? 1 : -1;
    const net = (item) => round(sign * (Number(item.debit || 0) - Number(item.credit || 0)));
    if (move?.journal_id !== after.journal_id || !suspenseId || lines.length !== 2 || bank.length !== 1 || suspense.length !== 1
      || net(bank[0]) !== referenceAmount || net(suspense[0]) !== -referenceAmount
      || round(Number(after.open_amount ?? referenceAmount)) !== referenceAmount) {
      return 'The bank entry must book the transaction amount in suspense';
    }
  }

  if (before?.bank_move_id && JSON.stringify((after.allocations ?? []).slice(0, (before.allocations ?? []).length)) !== JSON.stringify(before.allocations ?? [])) return 'Bank transaction allocations cannot be changed';
  if (after.bank_move_id && after.open_amount != null && (after.allocations ?? []).length > 0) {
    const allocations = after.allocations ?? [];
    const allocated = allocations.reduce((sum, a) => sum + (Number(a.amount) || 0), 0);
    const invoiceIds = allocations.map((a) => a.invoice_id).filter(Boolean);
    const externalMoves = allocations.map((a) => a.payment_move_id).filter((id) => id && id !== after.bank_move_id);
    if (
      allocations.some((a) => !(Number(a.amount) > 0) || !a.payment_move_id)
      || new Set(invoiceIds).size !== invoiceIds.length
      || new Set(externalMoves).size !== externalMoves.length
      || round(allocated + Number(after.open_amount)) !== referenceAmount
    ) return 'Bank transaction allocations must match its amount';
    const allocPaymentIds = allocations.flatMap((a) => a.payment_ids ?? []);
    if (new Set(allocPaymentIds).size !== allocPaymentIds.length) return 'A payment can only be selected once';
    for (const pid of allocPaymentIds) {
      const payment = read(db, 'account.payment', pid);
      if (!payment || (payment.company_id ?? 1) !== company) return 'The linked payment belongs to another company or does not exist';
      const err = paymentMatchError(db, after, payment, { journal, allowLinePayments: true });
      if (err) return err;
    }
    const via = paymentJournal(db, after.journal_id, company);
    const bankError = bankEntryGuardError(db, after, { company, round, referenceAmount, via, bankAccount: via.accountId, allocations, ctx });
    if (bankError) return bankError;
  }
  if (after.state !== 'reconciled' && !after.bank_move_id) return null;
  return null;
}

/** An unreconciled legacy statement line that still needs a user to choose its journal. */
export const isStatementLineWithoutJournal = (line) => line.state === 'to_check' && !line.journal_id;

/** Unreconciled statement lines saved before a journal was required; they count on no bank card until assigned one. */
export const statementLinesWithoutJournal = (db) => (db.records['account.bank.statement.line'] ?? []).filter(isStatementLineWithoutJournal);

/** Canonical display and running-balance order of bank statement lines: date, then sequence, then id. */
export const statementLineOrder = (a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')) || (a.sequence ?? 10) - (b.sequence ?? 10) || a.id - b.id;

const runningBalanceCache = new WeakMap();

/** Cumulative balance map (line id -> balance in journal currency) for one journal, computed and never stored. */
function journalRunningBalances(db, journalId) {
  if (!db?.records || !journalId) return null;
  let byJournal = runningBalanceCache.get(db.records);
  if (!byJournal) {
    byJournal = new Map();
    runningBalanceCache.set(db.records, byJournal);
  }
  let map = byJournal.get(journalId);
  if (map) return map;
  const journal = read(db, 'account.journal', journalId);
  const currency = (journal?.currency_id ? read(db, 'res.currency', journal.currency_id) : null)
    ?? (journal ? companyCurrencyRecord(db, journal.company_id ?? 1) : null);
  const lines = (db.records['account.bank.statement.line'] ?? [])
    .filter((l) => l.active !== false && l.journal_id === journalId)
    .sort(statementLineOrder);
  const statements = new Map((db.records['account.bank.statement'] ?? []).map((s) => [s.id, s]));
  map = new Map();
  const anchored = new Set();
  let balance = 0;
  for (const line of lines) {
    if (line.statement_id && !anchored.has(line.statement_id)) {
      anchored.add(line.statement_id);
      const stmt = statements.get(line.statement_id);
      if (stmt && stmt.journal_id === journalId && stmt.balance_start != null) {
        balance = Number(stmt.balance_start) || 0;
      }
    }
    balance += Number(line.amount) || 0;
    if (currency) balance = roundCurrency(balance, currency);
    map.set(line.id, balance);
  }
  byJournal.set(journalId, map);
  return map;
}

/** Computed cumulative balance of a statement line within its journal. */
function computeRunningBalance(r, db) {
  if (!db || !r?.journal_id || r.active === false) return null;
  const map = journalRunningBalances(db, r.journal_id);
  return map?.has(r.id) ? map.get(r.id) : (Number(r.amount) || 0);
}

/** Liquidity journal type ('bank', 'cash', or 'credit') for a statement line, or null when missing/non-liquidity. */
function statementJournalType(db, r) {
  const journal = db && r?.journal_id ? read(db, 'account.journal', r.journal_id) : null;
  return journal && isLiquidityJournal(journal) ? journal.type : null;
}

export const bankModels = {
  'account.bank.statement.line': {
    label: 'Bank Transactions',
    guard: (db, before, after, ctx) => datedLockGuard(['date', 'amount', 'partner_id', 'state', 'move_id', 'payment_move_id', 'payment_id', 'payment_ids', 'batch_payment_id', 'writeoff_account_id', 'writeoff_label', 'writeoff_analytic_distribution', 'writeoff_amount', 'writeoff_move_id', 'bank_move_id', 'open_amount', 'allocations', 'journal_id', 'counterpart_account_id', 'unique_import_id', 'payment_ref', 'company_id', 'active'], (l) => l.state === 'reconciled' || Boolean(l.bank_move_id) || Boolean(l.move_id))(db, before, after, ctx) ?? lineGuard(db, before, after, ctx),
    protectDelete: (db, l, staged, ctx) => {
      if (l.statement_id) {
        const stmt = read(db, 'account.bank.statement', l.statement_id);
        if (stmt?.state === 'closed') return 'Cannot remove lines from a closed statement';
      }
      const lock = datedLockDelete((r) => r.state === 'reconciled' || Boolean(r.bank_move_id) || Boolean(r.move_id))(db, l, staged, ctx);
      if (lock) return lock;
      if (l.bank_move_id && untouchedBankEntry(db, l) && (!staged || hasBankReversal(staged, read(db, 'account.move', l.bank_move_id)))) return null;
      return l.state === 'reconciled' || l.bank_move_id ? 'A reconciled or booked bank transaction cannot be deleted' : null;
    },
    onUnlink: (db, line) => line.bank_move_id ? reverseEntry(db, read(db, 'account.move', line.bank_move_id), [today(), line.date].sort().at(-1)).db : db,
    guardLast: true,
    // Statement files from the bank (beside the generic CSV import).
    importFile: { accept: '.ofx,.qfx,.xml,.qif', run: importStatement },
    fields: {
      sequence: { type: 'integer', label: 'Sequence', widget: 'handle' },
      date: { type: 'date', label: 'Date', required: true },
      payment_ref: { type: 'char', label: 'Label', required: true },
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Partner' },
      amount: { type: 'monetary', label: 'Amount', required: true },
      currency_id: { type: 'many2one', relation: 'res.currency', label: 'Currency', readonly: true },
      company_id: { type: 'many2one', relation: 'res.company', label: 'Company', readonly: true },
      statement_id: { type: 'many2one', relation: 'account.bank.statement', label: 'Statement' },
      running_balance: { type: 'monetary', label: 'Running Balance', readonly: true, sum: false, compute: computeRunningBalance },
      state: { type: 'selection', label: 'Status', tracking: true, optional: 'hide', badge: { to_check: 'info', reconciled: 'success' }, options: [['to_check', 'To Reconcile'], ['reconciled', 'Reconciled']] },
      journal_id: { type: 'many2one', relation: 'account.journal', label: 'Bank Journal', required: true, domain: (j) => isLiquidityJournal(j) },
      move_id: { type: 'many2one', relation: 'account.move', label: 'Matched with' },
      payment_id: { type: 'many2one', relation: 'account.payment', label: 'Existing Payment' },
      payment_ids: { type: 'many2many', relation: 'account.payment', label: 'Existing Payments' },
      batch_payment_id: { type: 'many2one', relation: 'account.batch.payment', label: 'Batch Payment' },
      payment_move_id: { type: 'many2one', relation: 'account.move', label: 'Journal Entry', readonly: true },
      writeoff_account_id: { type: 'many2one', relation: 'account.account', label: 'Write-off Account', domain: (account, record) => eligibleCounterpart(account, record?.company_id ?? 1) },
      writeoff_label: { type: 'char', label: 'Write-off Label' },
      writeoff_analytic_distribution: { type: 'distribution', label: 'Write-off Analytic Distribution', hidden: true },
      writeoff_amount: { type: 'monetary', label: 'Write-off Amount' },
      writeoff_move_id: { type: 'many2one', relation: 'account.move', label: 'Write-off Entry', readonly: true },
      bank_move_id: { type: 'many2one', relation: 'account.move', label: 'Bank Entry', readonly: true, optional: 'hide' },
      account_number: { type: 'char', label: 'Account Number', optional: 'hide' },
      narration: { type: 'char', label: 'Notes', optional: 'hide' },
      ref: { type: 'char', label: 'Reference', optional: 'hide' },
      transaction_type: { type: 'char', label: 'Transaction Type', optional: 'hide' },
      open_amount: { type: 'monetary', label: 'Open Amount', readonly: true },
      allocations: { type: 'one2many', label: 'Matched Documents', readonly: true, fields: {
        invoice_id: { type: 'many2one', relation: 'account.move', label: 'Invoice' },
        payment_move_id: { type: 'many2one', relation: 'account.move', label: 'Journal Entry' },
        payment_ids: { type: 'many2many', relation: 'account.payment', label: 'Existing Payments' },
        batch_payment_id: { type: 'many2one', relation: 'account.batch.payment', label: 'Batch Payment' },
        writeoff_move_id: { type: 'many2one', relation: 'account.move', label: 'Write-off Entry' },
        reconcile_model_id: { type: 'many2one', relation: 'account.reconcile.model', label: 'Reconciliation Model' },
        amount: { type: 'monetary', label: 'Amount' },
      } },
      unique_import_id: { type: 'char', label: 'Import ID', readonly: true },
      counterpart_account_id: { type: 'many2one', relation: 'account.account', label: 'Book to Account', domain: (account, record) => eligibleCounterpart(account, record?.company_id ?? 1) },
      name: { type: 'char', label: 'Name', compute: (r) => r.payment_ref },
    },
    prepareCreate: (db, vals) => {
      if (vals.bank_move_id) throw new Error(suppliedBankMoveError);
      if (!vals.journal_id || !Number(vals.amount)) return { db, vals };
      const compId = vals.company_id ?? read(db, 'account.journal', vals.journal_id)?.company_id ?? 1;
      const normalized = { ...vals, company_id: compId };
      const amount = statementCompanyAmount(db, normalized);
      if (vals.state === 'reconciled') {
        return { db, vals: { ...vals, open_amount: 0 } };
      }
      const journal = read(db, 'account.journal', vals.journal_id);
      if (!journal?.default_account_id) {
        return { db, vals: { ...vals, open_amount: amount } };
      }
      const booked = bookBankMovement(db, normalized, compId, { date: vals.date, openAmount: amount });
      return {
        db: booked.db,
        vals: {
          ...vals,
          company_id: compId,
          bank_move_id: booked.bankMoveId,
          open_amount: amount,
        },
      };
    },
    prepareWrite: (db, vals, before) => {
      if (before?.bank_move_id && ['amount', 'date', 'payment_ref', 'journal_id'].some((field) => field in vals && vals[field] !== before[field]) && untouchedBankEntry(db, before)) {
        const reversed = reverseEntry(db, read(db, 'account.move', before.bank_move_id), [today(), before.date].sort().at(-1));
        const candidate = { ...before, ...vals, id: null, bank_move_id: null };
        const amount = statementCompanyAmount(reversed.db, candidate);
        const booked = bookBankMovement(reversed.db, candidate, candidate.company_id ?? 1, { date: candidate.date, openAmount: amount });
        return { db: booked.db, vals: { ...vals, bank_move_id: booked.bankMoveId, open_amount: amount } };
      }
      if (vals.state === 'reconciled' && vals.open_amount === undefined) {
        return { db, vals: { ...vals, open_amount: 0 } };
      }
      return { db, vals };
    },
    defaults: () => ({ sequence: 10, date: today(), state: 'to_check' }),
    createDefaults: (db, vals) => ({ currency_id: read(db, 'account.journal', vals.journal_id)?.currency_id ?? companyCurrencyRecord(db, vals.company_id)?.id ?? null }),
    onchange: (r, key, db) => {
      if (key !== 'journal_id') return {};
      const journal = read(db, 'account.journal', r.journal_id);
      return { currency_id: journal?.currency_id ?? companyCurrencyRecord(db, journal?.company_id ?? r.company_id)?.id ?? null };
    },
    sort: statementLineOrder,
    // The handle orders transactions of the same day; the date always comes first.
    dropAllowed: (dragged, target) => Boolean(dragged && target) && dragged.date === target.date && dragged.journal_id === target.journal_id,
    dropRefusal: 'Transactions can only be reordered within the same date and journal',
    searchFields: ['payment_ref', 'partner_id', 'ref', 'account_number', 'narration', 'transaction_type', 'journal_id', 'bank_move_id', 'move_id'],
    defaultFilters: ['open'],
    filters: [
      [{ id: 'open', label: 'To Reconcile', fn: (r) => r.state === 'to_check' }, { id: 'done', label: 'Reconciled', fn: (r) => r.state === 'reconciled' }],
      [{ id: 'in', label: 'Cash In', fn: (r) => r.amount > 0 }, { id: 'out', label: 'Cash Out', fn: (r) => r.amount < 0 }],
      [
        { id: 'bank', label: 'Bank', fn: (r, db) => statementJournalType(db, r) === 'bank' },
        { id: 'cash', label: 'Cash', fn: (r, db) => statementJournalType(db, r) === 'cash' },
        { id: 'credit', label: 'Credit Card', fn: (r, db) => statementJournalType(db, r) === 'credit' },
      ],
      [
        ...monthFilters('date', 'Date'),
        { id: 'date_last_12_months', label: 'Last 12 Months', fn: (r) => Boolean(r.date) && r.date >= shiftMonth(today(), -12) && r.date <= today() },
      ],
      [{ id: 'unassigned', label: 'Without a Journal', fn: isStatementLineWithoutJournal }],
    ],
    groupBys: ['currency_id', 'company_id', 'journal_id', 'date'],
    kanban: { groupBy: 'state', title: 'payment_ref', lines: ['date', 'amount', 'partner_id'] },
    list: ['sequence', 'date', 'payment_ref', 'partner_id', 'amount', 'journal_id', 'running_balance', 'bank_move_id', 'account_number', 'narration', 'ref', 'transaction_type', 'state'],
    listLabels: { journal_id: 'Journal', bank_move_id: 'Journal Entry' },
    listDecoration: (r) => (r.state === 'to_check' ? 'info' : null),
    views: ['list', 'kanban'],
    form: {
      statusbar: 'state',
      lockedWhen: (r) => r.state === 'reconciled',
      buttons: [
        { label: 'Unreconcile', when: (r) => r.state === 'reconciled' || Boolean(r.bank_move_id), run: unreconcile },
        { label: 'Reconcile', primary: true, when: (r) => r.state === 'to_check' && !r.move_id, run: autoReconcile },
        { label: 'Match Payment', primary: true, when: (r) => r.state === 'to_check' && (r.payment_id || (r.payment_ids ?? []).length || r.batch_payment_id), run: matchPayment },
        { label: 'Match', primary: true, when: (r) => r.state === 'to_check' && r.move_id, run: (db, r) => ({ db: reconcileWith(db, r, r.move_id) }) },
        {
          label: 'Apply Reconciliation Model', when: (r) => r.state === 'to_check',
          run: (db, r) => {
            const model = modelFor(db, r);
            if (!model) throw new Error('No reconciliation model matches this transaction');
            return { db: applyRule(db, model, r) };
          },
        },
        { label: 'Book to Account', when: (r) => r.state === 'to_check', run: bookToAccount },
      ],
      title: 'payment_ref',
      groups: [['date', 'partner_id', 'amount', 'open_amount', 'journal_id'], ['move_id', 'payment_id', 'counterpart_account_id'], ['writeoff_account_id', 'writeoff_label', 'writeoff_amount']],
      chatter: true,
    },
  },
};
