// General-ledger reconciliation: account.partial.reconcile model, FIFO matching, write-off, and non-reversing unreconcile.
import { create, read, search, write } from '../orm.js';
import { companyCurrencyRecord, documentCurrency, isCurrencyZero, round, roundCurrency } from '../money.js';
import { sameCommercialPartner, today, validDate } from './common.js';
import {
  installmentSettlementState,
  isReconcilableAccount,
  journalItemIdentity,
  postEntry,
  reconciledJournalItems,
  statementPaymentIds,
} from './ledger.js';
import { appendDocumentSettlement, isInvoice, residual } from './accounting.js';
import { recordLockDate } from './finance.js';
import {
  paymentUnapplication,
  reconcileJournalItems,
  reverseEntry,
  selectedItems,
  unapplyPaymentCredit,
  unreconcileJournalItems,
} from './pay.js';
import { exchangeAccount } from './exchange-account.js';

const DOCUMENT_TYPES = ['out_invoice', 'out_refund', 'in_invoice', 'in_refund'];
const RECEIVABLE_PAYABLE = ['asset_receivable', 'liability_payable'];
const EXCEEDED_AMOUNT_ERROR = 'The applied amount cannot exceed the open balance available to reconcile';
const IMMUTABLE_LINK_FIELDS = [
  'debit_move_id',
  'debit_line_index',
  'credit_move_id',
  'credit_line_index',
  'account_id',
  'company_id',
  'amount',
  'amount_currency',
  'currency_id',
  'exchange_move_id',
  'date',
];

/** Resolve the effective currency of a journal item, defaulting to company currency. */
function resolveItemCurrency(db, it, ownCurrency) {
  if (it.line?.currency_id) return it.line.currency_id;
  if (DOCUMENT_TYPES.includes(it.move?.move_type) && it.move?.currency_id) return it.move.currency_id;
  return ownCurrency?.id ?? null;
}

/** Return the error message when reconciled items violate currency or receivable/payable partner rules. */
function reconcileItemsCompatibilityError(db, items, account, ownCurrency) {
  const itemCurrencies = new Set(items.map((it) => resolveItemCurrency(db, it, ownCurrency)).filter(Boolean));
  if (itemCurrencies.size > 1) {
    return 'General-ledger reconciliation requires items in the company currency; reconcile foreign-currency documents from their payment or credit-note workflow';
  }
  const isArAp = RECEIVABLE_PAYABLE.includes(account?.account_type);
  if (isArAp && items.some((it) => !partnersCompatible(db, items[0].line.partner_id, it.line.partner_id))) {
    return 'Selected receivable or payable items must have the same partner';
  }
  return null;
}

/** Validate structural fields, posted moves, reconcilable account, currency, partner compatibility, sign direction, and amount on a partial link. */
function partialReconcileStructureError(db, rec) {
  const debitMove = read(db, 'account.move', rec.debit_move_id);
  const creditMove = read(db, 'account.move', rec.credit_move_id);
  if (debitMove?.state !== 'posted' || creditMove?.state !== 'posted') {
    return 'Partial reconciliation requires posted debit and credit journal entries';
  }
  const companyId = rec.company_id ?? 1;
  if ((debitMove.company_id ?? 1) !== companyId || (creditMove.company_id ?? 1) !== companyId) {
    return 'Partial reconciliation entries must belong to the same company';
  }
  if (!Number.isInteger(rec.debit_line_index) || rec.debit_line_index < 0
    || !Number.isInteger(rec.credit_line_index) || rec.credit_line_index < 0) {
    return 'Partial reconciliation requires valid debit and credit line indexes';
  }
  const debitLine = debitMove.line_ids?.[rec.debit_line_index];
  const creditLine = creditMove.line_ids?.[rec.credit_line_index];
  if (!debitLine || !creditLine) return 'Partial reconciliation line index does not exist';
  if (debitLine.account_id !== rec.account_id || creditLine.account_id !== rec.account_id) {
    return 'Partial reconciliation lines must match the link account';
  }
  const account = read(db, 'account.account', rec.account_id);
  if (!isReconcilableAccount(account)) return 'Partial reconciliation requires a reconcilable account';
  const ownCurrency = companyCurrencyRecord(db, companyId);
  const compatError = reconcileItemsCompatibilityError(db, [
    { move: debitMove, line: debitLine },
    { move: creditMove, line: creditLine },
  ], account, ownCurrency);
  if (compatError) return compatError;
  const roundOwn = (v) => (ownCurrency ? roundCurrency(v, ownCurrency) : round(v));
  const debitBal = roundOwn((Number(debitLine.debit) || 0) - (Number(debitLine.credit) || 0));
  const creditBal = roundOwn((Number(creditLine.credit) || 0) - (Number(creditLine.debit) || 0));
  if (!(debitBal > 0) || isCurrencyZero(debitBal, ownCurrency) || !(creditBal > 0) || isCurrencyZero(creditBal, ownCurrency)) {
    return 'Partial reconciliation requires a debit balance on the debit line and a credit balance on the credit line';
  }
  const amount = Number(rec.amount);
  if (!Number.isFinite(amount) || !(roundOwn(amount) > 0) || isCurrencyZero(amount, ownCurrency)) {
    return 'Partial reconciliation amount must be greater than zero';
  }
  if (!validDate(rec.date)) return 'Partial reconciliation requires a valid date';
  if (rec.currency_id != null) {
    const curr = read(db, 'res.currency', rec.currency_id);
    if (!curr || curr.active === false) return 'Partial reconciliation requires an active currency';
  }
  if (rec.amount_currency != null) {
    const amtCurr = Number(rec.amount_currency);
    if (!Number.isFinite(amtCurr) || amtCurr < 0) return 'Partial reconciliation currency amount must be non-negative';
  }
  if (rec.exchange_move_id != null) {
    const fxMove = read(db, 'account.move', rec.exchange_move_id);
    if (!fxMove || fxMove.state !== 'posted' || fxMove.move_type !== 'entry' || (fxMove.company_id ?? 1) !== companyId) {
      return 'Partial reconciliation exchange entry must be a posted general entry belonging to this company';
    }
  }
  return null;
}

/** Server-side guard enforcing creation integrity, immutability, reversal transitions, and lock dates on partial links. */
function partialReconcileGuard(db, before, after) {
  const err = partialReconcileStructureError(db, after);
  if (err) return err;
  const debitMove = read(db, 'account.move', after.debit_move_id);
  const creditMove = read(db, 'account.move', after.credit_move_id);
  const lockOn = (date) => [
    recordLockDate(db, { ...debitMove, date, invoice_date: date }),
    recordLockDate(db, { ...creditMove, date, invoice_date: date }),
  ].filter(Boolean).sort().at(-1);

  if (!before) {
    if (after.reversed || after.active === false || after.reversal_date) {
      return 'New partial reconciliations must be active';
    }
    const lock = lockOn(after.date);
    if (lock && after.date <= lock) return `The period up to ${lock} is locked`;
    return null;
  }

  if (IMMUTABLE_LINK_FIELDS.some((f) => (after[f] ?? null) !== (before[f] ?? null))) {
    return 'Partial reconciliations cannot be edited after creation; unreconcile instead';
  }
  if (before.reversed || before.active === false) {
    if (Boolean(after.reversed) !== Boolean(before.reversed)
      || (after.active !== false) !== (before.active !== false)
      || (after.reversal_date ?? null) !== (before.reversal_date ?? null)) {
      return 'Reversed partial reconciliations cannot be restored or edited';
    }
    return null;
  }
  const untouched = !after.reversed && after.active !== false && !after.reversal_date;
  if (untouched) return null;
  if (after.reversed !== true || after.active !== false || !validDate(after.reversal_date) || after.reversal_date < before.date) {
    return 'Unreconciling a partial reconciliation requires setting reversed/inactive state and a valid reversal date';
  }
  const revLock = lockOn(after.reversal_date);
  if (revLock && after.reversal_date <= revLock) return `The period up to ${revLock} is locked`;
  return null;
}

/**
 * Build a baseline snapshot with active `account.partial.reconcile` links and their document settlement
 * deductions stripped, so `reconciledJournalItems` yields each line's pre-GL open amount.
 */
function dbWithoutActivePartialLinks(db) {
  const activePartials = (db.records['account.partial.reconcile'] ?? []).filter((g) => g && g.active !== false && !g.reversed);
  if (!activePartials.length) return db;
  const activeIds = new Set(activePartials.map((g) => g.id));
  const payRestored = new Map();
  const nextMoves = (db.records['account.move'] ?? []).map((move) => {
    const rows = move.payments ?? [];
    const removed = rows.filter((p) => !p.reversed && p.partial_reconcile_id != null && activeIds.has(p.partial_reconcile_id));
    if (!removed.length) return move;
    const docCurr = documentCurrency(db, move);
    const removedDoc = removed.reduce((s, p) => s + (Number(p.amount) || 0), 0);
    for (const r of removed) {
      if (r.payment_company_amount != null && Number(r.payment_company_amount) > 0) {
        payRestored.set(r.move_id, (payRestored.get(r.move_id) ?? 0) + Number(r.payment_company_amount));
      }
    }
    return {
      ...move,
      payments: rows.filter((p) => p.reversed || p.partial_reconcile_id == null || !activeIds.has(p.partial_reconcile_id)),
      amount_paid: Math.max(0, roundCurrency((Number(move.amount_paid) || 0) - removedDoc, docCurr)),
    };
  });
  const nextPayments = (db.records['account.payment'] ?? []).map((p) => {
    const add = p.state === 'posted' ? payRestored.get(p.move_id) : 0;
    if (!add) return p;
    const ownCurr = companyCurrencyRecord(db, p.company_id ?? 1);
    return { ...p, unapplied: roundCurrency((Number(p.unapplied) || 0) + add, ownCurr) };
  });
  return {
    ...db,
    records: {
      ...db.records,
      'account.partial.reconcile': [],
      'account.move': nextMoves,
      'account.payment': nextPayments,
    },
  };
}

/** Whole-database invariant checking that active link totals never exceed open line residuals and document rows agree. */
function partialReconcileInvariant(db, after) {
  const err = partialReconcileStructureError(db, after);
  if (err) return err;
  const ownCurrency = companyCurrencyRecord(db, after.company_id ?? 1);
  const roundOwn = (v) => (ownCurrency ? roundCurrency(v, ownCurrency) : round(v));
  const partials = (db.records['account.partial.reconcile'] ?? []).filter((g) => g && g.active !== false && !g.reversed);

  if (after.active !== false && !after.reversed) {
    const baseDb = dbWithoutActivePartialLinks(db);
    const debitMove = read(baseDb, 'account.move', after.debit_move_id);
    const creditMove = read(baseDb, 'account.move', after.credit_move_id);
    const debitItem = debitMove && reconciledJournalItems(baseDb, debitMove)[after.debit_line_index];
    const creditItem = creditMove && reconciledJournalItems(baseDb, creditMove)[after.credit_line_index];
    const debitCap = debitItem && !debitItem.reconciled && Number(debitItem.amount_residual) > 0
      ? roundOwn(Number(debitItem.amount_residual))
      : 0;
    const creditCap = creditItem && !creditItem.reconciled && Number(creditItem.amount_residual) < 0
      ? roundOwn(-Number(creditItem.amount_residual))
      : 0;
    const debitSum = roundOwn(partials
      .filter((g) => g.debit_move_id === after.debit_move_id && g.debit_line_index === after.debit_line_index)
      .reduce((s, g) => s + (Number(g.amount) || 0), 0));
    const creditSum = roundOwn(partials
      .filter((g) => g.credit_move_id === after.credit_move_id && g.credit_line_index === after.credit_line_index)
      .reduce((s, g) => s + (Number(g.amount) || 0), 0));
    if (debitSum > debitCap + 1e-9 || creditSum > creditCap + 1e-9) {
      return 'Total partial reconciliations cannot exceed the open journal line balance';
    }
  } else if (after.reversed) {
    const hasActiveDocRow = (db.records['account.move'] ?? []).some((m) => (
      (m.payments ?? []).some((p) => !p.reversed && p.partial_reconcile_id === after.id)
    ));
    if (hasActiveDocRow) return 'Reversing a partial reconciliation must also unapply its document settlement row';
  }
  return null;
}

/** Block deletion of active `account.partial.reconcile` records. */
function partialReconcileDeleteGuard(_db, r) {
  return r && r.active !== false && !r.reversed
    ? 'Active partial reconciliations cannot be deleted; unreconcile instead'
    : null;
}

export const glReconcileModels = {
  'account.partial.reconcile': {
    label: 'Partial Reconciliation',
    guardLast: true,
    fields: {
      debit_move_id: { type: 'many2one', relation: 'account.move', label: 'Debit Entry', required: true },
      debit_line_index: { type: 'integer', label: 'Debit Line Index', required: true },
      credit_move_id: { type: 'many2one', relation: 'account.move', label: 'Credit Entry', required: true },
      credit_line_index: { type: 'integer', label: 'Credit Line Index', required: true },
      account_id: { type: 'many2one', relation: 'account.account', label: 'Account', required: true },
      amount: { type: 'monetary', label: 'Amount', currency: 'company', required: true },
      amount_currency: { type: 'monetary', label: 'Amount in Currency' },
      currency_id: { type: 'many2one', relation: 'res.currency', label: 'Currency' },
      exchange_move_id: { type: 'many2one', relation: 'account.move', label: 'Exchange Entry' },
      date: { type: 'date', label: 'Date', required: true },
      active: { type: 'boolean', label: 'Active', default: true },
      reversed: { type: 'boolean', label: 'Unreconciled', default: false },
      reversal_date: { type: 'date', label: 'Unreconcile Date' },
    },
    guard: partialReconcileGuard,
    invariant: partialReconcileInvariant,
    protectDelete: partialReconcileDeleteGuard,
  },
};

/** Compare two resolved journal items oldest first for FIFO debit/credit matching. */
function compareOldestFirst(a, b) {
  const dateA = a.line?.date || a.moveDate || '';
  const dateB = b.line?.date || b.moveDate || '';
  return dateA.localeCompare(dateB)
    || ((a.move?.id ?? 0) - (b.move?.id ?? 0))
    || ((a.lineIndex ?? 0) - (b.lineIndex ?? 0));
}

/** Check whether two partner references belong to the same commercial entity (or are both unset). */
function partnersCompatible(db, p1, p2) {
  const a = p1 ?? null;
  const b = p2 ?? null;
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return a === b || sameCommercialPartner(db, a, b);
}

/** Determine whether a selection of 2 non-writeoff items represents an existing invoice+payment or invoice+credit-note pair. */
function delegatesToJournalItems(db, items) {
  if (items.length !== 2) return false;
  const docs = items.filter((it) => ['out_invoice', 'in_invoice'].includes(it.move.move_type));
  const refunds = items.filter((it) => ['out_refund', 'in_refund'].includes(it.move.move_type));
  if (docs.length === 1 && refunds.length === 1) return true;
  const invoices = items.filter((it) => isInvoice(it.move));
  if (invoices.length !== 1) return false;
  const other = items.find((it) => it !== invoices[0]);
  return (db.records['account.payment'] ?? []).some((p) => p.move_id === other.move.id && p.state === 'posted');
}

/** Validate write-off parameters and return resolved journal, account, date, label, and partner. */
function validateWriteoffOptions(db, writeoff, { companyId, accountId, net, ownCurrency, groupPartnerId, defaultDate }) {
  if (isCurrencyZero(net, ownCurrency)) throw new Error('Selected items already net to zero; no write-off is needed');
  const woDate = writeoff.date || defaultDate;
  if (!validDate(woDate)) throw new Error('Enter a valid write-off date');
  const companyLock = recordLockDate(db, { company_id: companyId, date: woDate, invoice_date: woDate });
  if (companyLock && woDate <= companyLock) throw new Error(`The period up to ${companyLock} is locked`);
  if (!writeoff.journalId) throw new Error('Select a write-off journal');
  const woJournal = read(db, 'account.journal', Number(writeoff.journalId));
  if (!woJournal || woJournal.active === false || (woJournal.company_id && woJournal.company_id !== companyId)
    || !['general', 'bank', 'cash', 'credit'].includes(woJournal.type)) {
    throw new Error('Select an active journal belonging to this company for the write-off');
  }
  if (!writeoff.accountId) throw new Error('Select a write-off account');
  const woAccount = read(db, 'account.account', Number(writeoff.accountId));
  if (!woAccount || woAccount.active === false || woAccount.deprecated
    || (woAccount.company_id && woAccount.company_id !== companyId)
    || woAccount.id === accountId
    || ['asset_receivable', 'liability_payable', 'off_balance'].includes(woAccount.account_type)) {
    throw new Error('Select an active write-off counterpart account belonging to this company');
  }
  const label = String(writeoff.label ?? '').trim();
  if (!label) throw new Error('Set a write-off label');
  return { woJournal, woAccount, woDate, label, groupPartnerId };
}

/** Determine whether `move` is an invoice/bill/refund whose counterpart line is settled on the opposite side. */
function documentSettledByCounterSide(move, line) {
  if (!DOCUMENT_TYPES.includes(move?.move_type)) return false;
  const lineNet = (Number(line.debit) || 0) - (Number(line.credit) || 0);
  return (['out_invoice', 'in_refund'].includes(move.move_type) && lineNet > 0)
    || (['in_invoice', 'out_refund'].includes(move.move_type) && lineNet < 0);
}

/** Partition open items into debit and credit lists with rounded positive remaining balances. */
function splitDebitCreditItems(items, matchCurrency, ownCurrency, isForeignCurrency) {
  const roundMatch = (v) => (matchCurrency ? roundCurrency(v, matchCurrency) : round(v));
  const roundOwn = (v) => (ownCurrency ? roundCurrency(v, ownCurrency) : round(v));
  const debits = [];
  const credits = [];
  for (const it of items) {
    const compVal = Number(it.reconciledLine?.amount_residual) || 0;
    const matchVal = isForeignCurrency ? (Number(it.reconciledLine?.amount_residual_currency) || 0) : compVal;
    if (isCurrencyZero(matchVal, matchCurrency)) continue;
    const matchRemaining = roundMatch(Math.abs(matchVal));
    const compRemaining = roundOwn(Math.abs(compVal));
    const entry = {
      ...it,
      remainingMatch: matchRemaining,
      remainingCompany: compRemaining,
      originalMatch: matchRemaining,
      originalCompany: compRemaining,
      remaining: matchRemaining,
    };
    if (matchVal > 0 || compVal > 0) debits.push(entry);
    else if (matchVal < 0 || compVal < 0) credits.push(entry);
  }
  return { debits, credits };
}

/** Validate selection consistency, currency, partners, locks, write-off options, and explicit amount. */
function validateReconcileSelection(db, items, { date, amount, writeoff }) {
  const companies = new Set(items.map((it) => it.move.company_id ?? 1));
  if (companies.size > 1) throw new Error('Selected journal items must belong to the same company');
  const companyId = [...companies][0];
  const ownCurrency = companyCurrencyRecord(db, companyId);
  const roundOwn = (v) => (ownCurrency ? roundCurrency(v, ownCurrency) : round(v));

  const accounts = new Set(items.map((it) => it.line.account_id));
  if (accounts.size > 1) throw new Error('Selected journal items must be on the same account');
  const account = items[0].account;
  if (!isReconcilableAccount(account)) throw new Error('Selected journal items must be on a reconcilable account');

  const compatError = reconcileItemsCompatibilityError(db, items, account, ownCurrency);
  if (compatError) throw new Error(compatError);

  const sharedCurrencyId = resolveItemCurrency(db, items[0], ownCurrency);
  const isForeignCurrency = Boolean(sharedCurrencyId && ownCurrency && sharedCurrencyId !== ownCurrency.id);
  const matchCurrency = isForeignCurrency ? read(db, 'res.currency', sharedCurrencyId) : ownCurrency;
  const roundMatch = (v) => (matchCurrency ? roundCurrency(v, matchCurrency) : round(v));

  if (items.some((it) => it.reconciledLine?.reconciled === true
    || (isForeignCurrency
      ? isCurrencyZero(Number(it.reconciledLine?.amount_residual_currency) || 0, matchCurrency)
      : isCurrencyZero(Number(it.reconciledLine?.amount_residual) || 0, ownCurrency)))) {
    throw new Error('Selected journal items must not already be fully reconciled');
  }

  for (const it of items) {
    const lock = recordLockDate(db, it.move);
    if (lock && date <= lock) throw new Error(`The period up to ${lock} is locked`);
  }

  const net = isForeignCurrency
    ? roundMatch(items.reduce((s, it) => s + (Number(it.reconciledLine?.amount_residual_currency) || 0), 0))
    : roundOwn(items.reduce((s, it) => s + Number(it.reconciledLine?.amount_residual), 0));
  const distinctPartners = new Set(items.map((it) => it.line.partner_id ?? null));
  const isArAp = RECEIVABLE_PAYABLE.includes(account.account_type);
  const groupPartnerId = isArAp
    ? (items[0].line.partner_id ?? null)
    : (distinctPartners.size === 1 ? [...distinctPartners][0] : null);

  const { debits, credits } = splitDebitCreditItems(items, matchCurrency, ownCurrency, isForeignCurrency);

  let validatedWriteoff = null;
  if (writeoff) {
    if (amount != null) {
      throw new Error('An explicit reconciliation amount is only supported when reconciling one debit item with one credit item');
    }
    validatedWriteoff = validateWriteoffOptions(db, writeoff, {
      companyId,
      accountId: account.id,
      net,
      ownCurrency: matchCurrency,
      groupPartnerId,
      defaultDate: date,
    });
  } else {
    if (items.length < 2) throw new Error('Select at least two journal items to reconcile');
    if (!debits.length || !credits.length) throw new Error('Select at least one debit item and one credit item to reconcile');
  }

  let requestedAmount = null;
  if (amount != null) {
    const num = Number(amount);
    if (!Number.isFinite(num) || !(num > 0)) throw new Error('The applied amount must be a positive number');
    requestedAmount = roundMatch(num);
    if (!(requestedAmount > 0) || isCurrencyZero(requestedAmount, matchCurrency)) throw new Error('The applied amount must be a positive number');
    if (debits.length !== 1 || credits.length !== 1) {
      throw new Error('An explicit reconciliation amount is only supported when reconciling one debit item with one credit item');
    }
    const maxAbsorbable = roundMatch(Math.min(debits[0].remainingMatch, credits[0].remainingMatch));
    const excess = roundMatch(requestedAmount - maxAbsorbable);
    if (excess > 0 && !isCurrencyZero(excess, matchCurrency)) {
      throw new Error(EXCEEDED_AMOUNT_ERROR);
    }
  }

  return {
    companyId,
    ownCurrency,
    roundOwn,
    matchCurrency,
    roundMatch,
    isForeignCurrency,
    account,
    net,
    groupPartnerId,
    validatedWriteoff,
    requestedAmount,
  };
}

/** Post the balancing write-off journal entry and append its counterpart item to the working selection. */
function postReconcileWriteoff(db, items, { companyId, account, net, groupPartnerId, roundOwn, validatedWriteoff }) {
  const { woJournal, woAccount, woDate, label } = validatedWriteoff;
  const absNet = roundOwn(Math.abs(net));
  const woLines = net > 0
    ? [
        { account: account.id, credit: absNet, debit: 0, partner_id: groupPartnerId, name: label },
        { account: woAccount.id, debit: absNet, credit: 0, partner_id: groupPartnerId, name: label },
      ]
    : [
        { account: account.id, debit: absNet, credit: 0, partner_id: groupPartnerId, name: label },
        { account: woAccount.id, credit: absNet, debit: 0, partner_id: groupPartnerId, name: label },
      ];
  const booked = postEntry(db, {
    journal: woJournal.code,
    journal_id: woJournal.id,
    company: companyId,
    date: woDate,
    ref: label,
    archivedOriginIds: items.map((it) => it.move.id),
    lines: woLines,
  });
  const woMove = read(booked.db, 'account.move', booked.id);
  const woItems = selectedItems(
    booked.db,
    [{ move_id: woMove.id, line_identity: journalItemIdentity(woMove.line_ids[0]) }],
    { allowMultipleEntryLines: true },
  );
  return { db: booked.db, items: [...items, ...woItems] };
}

/** Settle a document (`account.move`) counterpart line when matched through a partial reconciliation link. */
function settleDocumentSide(db, docItem, otherItem, { matchAmt, pairDate, partialReconcileId }) {
  if (!documentSettledByCounterSide(docItem.move, docItem.line)) return db;
  const doc = read(db, 'account.move', docItem.move.id);
  const docCurr = documentCurrency(db, doc);
  const roundDoc = (v) => roundCurrency(v, docCurr);
  const openDoc = docItem.multiInstallment
    ? roundDoc(installmentSettlementState(db, doc).remainingByIndex.get(docItem.lineIndex) ?? residual(doc, db))
    : roundDoc(residual(doc, db));
  const docAmt = roundDoc(Math.min(openDoc, matchAmt));
  if (!(docAmt > 0)) return db;
  return appendDocumentSettlement(db, doc.id, {
    amount: docAmt,
    moveId: otherItem.move.id,
    date: pairDate,
    lineIndex: docItem.multiInstallment ? docItem.lineIndex : null,
    partialReconcileId,
    consumePayment: true,
  }).db;
}

/** Match debits against credits oldest first, creating `account.partial.reconcile` links and document settlements. */
function matchDebitCreditPairs(db, workingItems, {
  account,
  companyId,
  matchDate,
  requestedAmount,
  ownCurrency,
  roundOwn,
  matchCurrency,
  roundMatch,
  isForeignCurrency,
}) {
  const { debits, credits } = splitDebitCreditItems(workingItems, matchCurrency, ownCurrency, isForeignCurrency);
  debits.sort(compareOldestFirst);
  credits.sort(compareOldestFirst);

  if (requestedAmount != null && (debits.length !== 1 || credits.length !== 1)) {
    throw new Error('An explicit reconciliation amount is only supported when reconciling one debit item with one credit item');
  }

  let next = db;
  let di = 0;
  let ci = 0;
  let budget = requestedAmount;
  while (di < debits.length && ci < credits.length) {
    if (budget != null && (budget <= 0 || isCurrencyZero(budget, matchCurrency))) break;
    const d = debits[di];
    const c = credits[ci];
    const matchAmt = roundMatch(Math.min(d.remainingMatch, c.remainingMatch, ...(budget != null ? [budget] : [])));
    if (matchAmt > 0 && !isCurrencyZero(matchAmt, matchCurrency)) {
      const pairDate = [matchDate, d.moveDate, c.moveDate].sort().at(-1);

      let dCompShare;
      if (d.remainingMatch === matchAmt || isCurrencyZero(d.remainingMatch - matchAmt, matchCurrency)) {
        dCompShare = d.remainingCompany;
      } else {
        dCompShare = Math.min(d.remainingCompany, roundOwn(d.originalCompany * (matchAmt / d.originalMatch)));
      }

      let cCompShare;
      if (c.remainingMatch === matchAmt || isCurrencyZero(c.remainingMatch - matchAmt, matchCurrency)) {
        cCompShare = c.remainingCompany;
      } else {
        cCompShare = Math.min(c.remainingCompany, roundOwn(c.originalCompany * (matchAmt / c.originalMatch)));
      }

      const fxDiff = isForeignCurrency ? roundOwn(dCompShare - cCompShare) : 0;
      let fxMoveId = null;

      if (fxDiff !== 0) {
        const absDiff = roundOwn(Math.abs(fxDiff));
        const counterpartPartnerId = d.line.partner_id ?? c.line.partner_id ?? null;
        const fxAccount = exchangeAccount(next, companyId, -fxDiff);

        const fxLines = fxDiff > 0
          ? [
              {
                account_id: account.id,
                credit: absDiff,
                debit: 0,
                partner_id: counterpartPartnerId,
                currency_id: matchCurrency.id,
                amount_currency: 0,
                name: 'Exchange Difference',
              },
              {
                account_id: fxAccount,
                debit: absDiff,
                credit: 0,
                name: 'Exchange Difference',
              },
            ]
          : [
              {
                account_id: account.id,
                debit: absDiff,
                credit: 0,
                partner_id: counterpartPartnerId,
                currency_id: matchCurrency.id,
                amount_currency: 0,
                name: 'Exchange Difference',
              },
              {
                account_id: fxAccount,
                credit: absDiff,
                debit: 0,
                name: 'Exchange Difference',
              },
            ];

        const bookedFx = postEntry(next, {
          // Same journal as the other exchange-difference entries (credit notes, payments).
          journal: 'MISC',
          company: companyId,
          date: pairDate,
          ref: 'Exchange Difference',
          archivedOriginIds: [d.move.id, c.move.id],
          lines: fxLines,
        });
        next = bookedFx.db;
        fxMoveId = bookedFx.id;
      }

      const baseLinkAmt = roundOwn(Math.min(dCompShare, cCompShare));
      const primaryCreated = create(next, 'account.partial.reconcile', {
        debit_move_id: d.move.id,
        debit_line_index: d.lineIndex,
        credit_move_id: c.move.id,
        credit_line_index: c.lineIndex,
        account_id: account.id,
        company_id: companyId,
        amount: baseLinkAmt,
        amount_currency: isForeignCurrency ? matchAmt : null,
        currency_id: isForeignCurrency ? matchCurrency.id : null,
        exchange_move_id: fxMoveId,
        date: pairDate,
        active: true,
        reversed: false,
      });
      next = primaryCreated.db;

      if (fxMoveId != null) {
        const absDiff = roundOwn(Math.abs(fxDiff));
        const secLinkVals = fxDiff > 0
          ? {
              debit_move_id: d.move.id,
              debit_line_index: d.lineIndex,
              credit_move_id: fxMoveId,
              credit_line_index: 0,
              account_id: account.id,
              company_id: companyId,
              amount: absDiff,
              amount_currency: 0,
              currency_id: matchCurrency.id,
              exchange_move_id: fxMoveId,
              date: pairDate,
              active: true,
              reversed: false,
            }
          : {
              debit_move_id: fxMoveId,
              debit_line_index: 0,
              credit_move_id: c.move.id,
              credit_line_index: c.lineIndex,
              account_id: account.id,
              company_id: companyId,
              amount: absDiff,
              amount_currency: 0,
              currency_id: matchCurrency.id,
              exchange_move_id: fxMoveId,
              date: pairDate,
              active: true,
              reversed: false,
            };
        const secCreated = create(next, 'account.partial.reconcile', secLinkVals);
        next = secCreated.db;
      }

      next = settleDocumentSide(next, d, c, { matchAmt, pairDate, partialReconcileId: primaryCreated.id });
      next = settleDocumentSide(next, c, d, { matchAmt, pairDate, partialReconcileId: primaryCreated.id });

      d.remainingMatch = roundMatch(d.remainingMatch - matchAmt);
      c.remainingMatch = roundMatch(c.remainingMatch - matchAmt);
      d.remainingCompany = roundOwn(Math.max(0, d.remainingCompany - dCompShare));
      c.remainingCompany = roundOwn(Math.max(0, c.remainingCompany - cCompShare));
      d.remaining = d.remainingMatch;
      c.remaining = c.remainingMatch;
      if (budget != null) budget = roundMatch(budget - matchAmt);
    }
    if (d.remainingMatch <= 0 || isCurrencyZero(d.remainingMatch, matchCurrency)) di += 1;
    if (c.remainingMatch <= 0 || isCurrencyZero(c.remainingMatch, matchCurrency)) ci += 1;
  }
  if (budget != null && budget > 0 && !isCurrencyZero(budget, matchCurrency)) {
    throw new Error(EXCEEDED_AMOUNT_ERROR);
  }
  return next;
}

/**
 * Reconcile two or more posted journal items on the same reconcilable account and company:
 * - Two-item invoice + payment or invoice + credit note delegates directly to `reconcileJournalItems`
 *   (preserving partial `amount`, installment targeting, and exchange-difference handling).
 * - General GL selections match debits against credits oldest first through `account.partial.reconcile`
 *   records (and optional posted write-off), settling document sides via `appendDocumentSettlement`.
 */
export function reconcileLedgerItems(db, selections, { date = today(), amount = null, writeoff = null } = {}) {
  const items = selectedItems(db, selections, { allowMultipleEntryLines: true });
  if (!validDate(date)) throw new Error('Enter a valid reconciliation date');

  if (!writeoff && delegatesToJournalItems(db, items)) {
    return reconcileJournalItems(db, selections, { date, amount });
  }

  const ctx = validateReconcileSelection(db, items, { date, amount, writeoff });
  const { db: withWriteoff, items: workingItems } = ctx.validatedWriteoff
    ? postReconcileWriteoff(db, items, ctx)
    : { db, items };

  return matchDebitCreditPairs(withWriteoff, workingItems, {
    ...ctx,
    matchDate: ctx.validatedWriteoff?.woDate ?? date,
  });
}

/** Determine whether a selected item has active non-GL settlements (ordinary payments, write-offs, or bank matches). */
function itemHasLegacySettlement(db, item, activePartialIds) {
  const { move, line, lineIndex, counterpart, multiInstallment } = item;
  const isLegacyRow = (row) => !row.reversed && !(row.partial_reconcile_id != null && activePartialIds.has(row.partial_reconcile_id));
  if (isInvoice(move)) {
    if (!counterpart) return false;
    const nonGlRows = (move.payments ?? []).filter(isLegacyRow);
    if (!nonGlRows.length) return false;
    if (!multiInstallment) return true;
    const hasTargeted = nonGlRows.some((r) => !r.discount && r.line_index === lineIndex);
    const hasUntargeted = installmentSettlementState(db, { ...move, payments: nonGlRows }).untargetedTouched.has(lineIndex);
    return hasTargeted || hasUntargeted;
  }
  const payments = (db.records['account.payment'] ?? []).filter((p) => p.state === 'posted' && p.move_id === move.id);
  const isPaymentOutstanding = payments.some((p) => p.outstanding_account_id === line.account_id);
  const hasApp = (db.records['account.move'] ?? []).some((inv) => (
    sameCommercialPartner(db, inv.partner_id, line.partner_id)
    && (isPaymentOutstanding || (inv.line_ids ?? []).some((l) => l.account_id === line.account_id))
    && (inv.payments ?? []).some((row) => isLegacyRow(row) && row.move_id === move.id)
  ));
  const hasBank = (db.records['account.bank.statement.line'] ?? []).some((b) => b.bank_move_id && (
    b.bank_move_id === move.id
    || b.payment_move_id === move.id
    || payments.some((p) => statementPaymentIds(db, b).includes(p.id))
    || (b.allocations ?? []).some((a) => a.payment_move_id === move.id || a.writeoff_move_id === move.id)
  ));
  return hasApp || hasBank;
}

/** Collect and fully validate all partial links, document settlements, and legacy selections before writing. */
function collectAndValidateUnreconcile(db, items, date) {
  const activePartials = (db.records['account.partial.reconcile'] ?? []).filter((g) => g && g.active !== false && !g.reversed);
  const activePartialIds = new Set(activePartials.map((g) => g.id));
  const partialIds = new Set();
  const legacySelections = [];

  for (const it of items) {
    const lock = recordLockDate(db, it.move);
    if (lock && date <= lock) throw new Error(`The period up to ${lock} is locked`);
    const touched = activePartials.filter((g) => (
      (g.debit_move_id === it.move.id && g.debit_line_index === it.lineIndex)
      || (g.credit_move_id === it.move.id && g.credit_line_index === it.lineIndex)
    ));
    for (const g of touched) partialIds.add(g.id);
    const hasLegacy = itemHasLegacySettlement(db, it, activePartialIds);
    if (hasLegacy) legacySelections.push({ move_id: it.move.id, line_identity: journalItemIdentity(it.line) });
    if (!touched.length && !hasLegacy) {
      throw new Error('The selected item has no active reconciliation to remove');
    }
  }

  const fxMoveIds = new Set();
  for (const g of activePartials) {
    if (partialIds.has(g.id) && g.exchange_move_id) {
      fxMoveIds.add(g.exchange_move_id);
    }
  }
  if (fxMoveIds.size) {
    for (const g of activePartials) {
      if (g.exchange_move_id && fxMoveIds.has(g.exchange_move_id)) {
        partialIds.add(g.id);
      }
    }
  }

  const touchedLinks = activePartials.filter((g) => partialIds.has(g.id));
  for (const g of touchedLinks) {
    if (g.date && date < g.date) throw new Error('Enter an unreconciliation date on or after the matching date');
    for (const mId of [g.debit_move_id, g.credit_move_id]) {
      const move = read(db, 'account.move', mId);
      const lock = move && recordLockDate(db, move);
      if (lock && date <= lock) throw new Error(`The period up to ${lock} is locked`);
    }
  }

  for (const fxId of fxMoveIds) {
    const fxMove = read(db, 'account.move', fxId);
    if (fxMove) {
      const lock = recordLockDate(db, fxMove);
      if (lock && date <= lock) throw new Error(`The period up to ${lock} is locked`);
      const sourceDate = fxMove.invoice_date ?? fxMove.date ?? '';
      if (sourceDate && date < sourceDate) {
        throw new Error('Enter an unreconciliation date on or after the matching date');
      }
    }
  }

  const docRows = [];
  if (partialIds.size) {
    for (const move of db.records['account.move'] ?? []) {
      const rows = (move.payments ?? []).filter((p) => !p.reversed && partialIds.has(p.partial_reconcile_id));
      if (!rows.length) continue;
      const lock = recordLockDate(db, move);
      if (lock && date <= lock) throw new Error(`The period up to ${lock} is locked`);
      for (const row of rows) {
        const lineIndex = Number.isInteger(row.line_index) ? row.line_index : null;
        paymentUnapplication(db, move.id, row.move_id, date, { lineIndex, partialReconcileId: row.partial_reconcile_id });
        docRows.push({ moveId: move.id, row, lineIndex });
      }
    }
  }

  return { touchedLinks, docRows, legacySelections, fxMoveIds };
}

/**
 * Remove reconciliations on selected journal items. Active `account.partial.reconcile` links are marked
 * reversed/inactive without reversing their underlying journal entries (including write-offs created by
 * Reconcile with write-off), while document residuals, cash-basis releases, and unapplied payment credits are restored.
 */
export function unreconcileLedgerItems(db, selections, { date = today() } = {}) {
  const items = selectedItems(db, selections, { allowMultipleEntryLines: true });
  if (!validDate(date)) throw new Error('Enter a valid reversal date');

  const { touchedLinks, docRows, legacySelections, fxMoveIds } = collectAndValidateUnreconcile(db, items, date);

  let next = db;
  for (const g of touchedLinks) {
    next = write(next, 'account.partial.reconcile', g.id, {
      reversed: true,
      active: false,
      reversal_date: date,
    });
  }
  for (const { moveId, row, lineIndex } of docRows) {
    next = unapplyPaymentCredit(next, moveId, row.move_id, date, {
      lineIndex,
      partialReconcileId: row.partial_reconcile_id,
    });
  }
  for (const fxId of fxMoveIds) {
    const fxMove = read(next, 'account.move', fxId);
    const alreadyReversed = search(next, 'account.move').some((m) => m.state !== 'cancel' && m.reversed_entry_id === fxId);
    if (fxMove && fxMove.state === 'posted' && !alreadyReversed) {
      const reversed = reverseEntry(next, fxMove, date, { reconciliation_reversal: true });
      next = reversed.db;
    }
  }
  if (legacySelections.length) {
    next = unreconcileJournalItems(next, legacySelections, { date });
  }
  return next;
}
