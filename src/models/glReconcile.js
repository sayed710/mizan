// General-ledger reconciliation: account.partial.reconcile model, FIFO matching, write-off, and non-reversing unreconcile.
import { create, read, write } from '../orm.js';
import { companyCurrencyRecord, documentCurrency, isCurrencyZero, round, roundCurrency } from '../money.js';
import { sameCommercialPartner, today, validDate } from './common.js';
import { exchangeAccount } from './exchange-account.js';
import {
  installmentSettlementState,
  isReconcilableAccount,
  journalItemIdentity,
  postEntry,
  valueOnlyCurrencyFields,
  exchangeJournal,
  reconciledJournalItems,
  statementPaymentIds,
} from './ledger.js';
import { appendDocumentSettlement, isInvoice, residual } from './accounting.js';
import { isExchangeEntry, recordLockDate } from './finance.js';
import {
  paymentUnapplication,
  reconcileJournalItems,
  reverseEntry,
  selectedItems,
  unapplyPaymentCredit,
  unreconcileJournalItems,
} from './pay.js';

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
  'date',
  'debit_amount_currency',
  'credit_amount_currency',
  'exchange_move_id',
];

export { isExchangeEntry };

/** Resolve the effective currency id for a journal item or document line. */
export function itemCurrencyId(db, it, ownCurrency) {
  if (it.line?.currency_id) return it.line.currency_id;
  if (DOCUMENT_TYPES.includes(it.move?.move_type) && it.move?.currency_id) return it.move.currency_id;
  return ownCurrency?.id ?? null;
}

/** Return the error message when reconciled items violate currency or receivable/payable partner rules. */
function reconcileItemsCompatibilityError(db, items, account, ownCurrency) {
  const ownId = ownCurrency?.id ?? null;
  const currencies = items.map((it) => itemCurrencyId(db, it, ownCurrency));
  const foreignCurrencies = new Set(currencies.filter((c) => c !== ownId));
  if (foreignCurrencies.size > 1) {
    return 'Selected items must be in the same currency';
  }
  const isArAp = RECEIVABLE_PAYABLE.includes(account?.account_type);
  if (isArAp && items.some((it) => !partnersCompatible(db, items[0].line.partner_id, it.line.partner_id))) {
    return 'Selected receivable or payable items must have the same partner';
  }
  return null;
}

/**
 * Validate that an exchange difference move is posted, 2-line, balanced, with counterpart on the reconciled
 * account and the offset on the company-configured gain/loss exchange account.
 */
function postedExchangeEntryError(db, fxMoveId, accountId, companyId, { expectedNet = null, expectedPartnerId = undefined } = {}) {
  const fx = read(db, 'account.move', fxMoveId);
  if (!fx || fx.state !== 'posted' || fx.move_type !== 'entry' || (fx.company_id ?? 1) !== (companyId ?? 1)) {
    return 'A dedicated posted exchange entry must match the settlement';
  }
  const fxLines = fx.line_ids ?? [];
  if (fxLines.length !== 2) return 'A dedicated posted exchange entry must match the settlement';
  const counterpartLine = fxLines.find((l) => l.account_id === accountId);
  if (!counterpartLine) return 'A dedicated posted exchange entry must match the settlement';
  if (expectedPartnerId !== undefined && counterpartLine.partner_id !== (expectedPartnerId ?? null)) {
    return 'Exchange entry lines do not match the reconciliation difference';
  }
  const ownCurrency = companyCurrencyRecord(db, companyId ?? 1);
  const roundOwn = (v) => (ownCurrency ? roundCurrency(v, ownCurrency) : round(v));
  const fxDiff = roundOwn((Number(counterpartLine.debit) || 0) - (Number(counterpartLine.credit) || 0));
  if (isCurrencyZero(fxDiff, ownCurrency)) return 'An exchange entry is not required for this settlement';
  if (expectedNet != null && fxDiff !== expectedNet) {
    return 'Exchange entry lines do not match the reconciliation difference';
  }
  const expectedOffset = exchangeAccount(db, companyId, fxDiff);
  const exchangeLine = fxLines.find((l) => l !== counterpartLine && l.account_id === expectedOffset && !l.partner_id);
  if (!exchangeLine) {
    return expectedNet != null
      ? 'Exchange entry account does not match the company exchange account'
      : 'A dedicated posted exchange entry must match the settlement';
  }
  const exDiff = roundOwn((Number(exchangeLine.debit) || 0) - (Number(exchangeLine.credit) || 0));
  if (roundOwn(fxDiff + exDiff) !== 0) return 'A dedicated posted exchange entry must match the settlement';
  return null;
}

/** Calculate the company-currency valuation of a line's foreign currency consumption, avoiding fractional drift on full settlement. */
export function lineCurrencyValuation(remainingCompany, remainingCurrency, commonCurr, ownCurrency) {
  if (remainingCurrency <= 0 || commonCurr <= 0) return 0;
  if (Math.abs(remainingCurrency - commonCurr) < 1e-9) {
    return ownCurrency ? roundCurrency(remainingCompany, ownCurrency) : round(remainingCompany);
  }
  const raw = remainingCompany * commonCurr / remainingCurrency;
  return ownCurrency ? roundCurrency(raw, ownCurrency) : round(raw);
}

/** Check whether a partial reconciliation is the legitimate clearing link between an exchange entry and its reversal created on unreconcile. */
export function isExchangeReversalClearingPartial(db, rec, debitMove, creditMove) {
  if (rec.exchange_move_id != null) return false;
  if (!debitMove || !creditMove) return false;
  const isDirectReversal = (debitMove.reversed_entry_id === creditMove.id && isExchangeEntry(db, creditMove))
    || (creditMove.reversed_entry_id === debitMove.id && isExchangeEntry(db, debitMove));
  if (!isDirectReversal) return false;
  const origMove = debitMove.reversed_entry_id === creditMove.id ? creditMove : debitMove;
  if (!isExchangeEntry(db, origMove)) return false;
  const origLineIdx = origMove === debitMove ? rec.debit_line_index : rec.credit_line_index;
  const origLine = origMove.line_ids?.[origLineIdx];
  if (!origLine || origLine.account_id !== rec.account_id) return false;
  const ownCurrency = companyCurrencyRecord(db, rec.company_id ?? 1);
  const roundOwn = (v) => (ownCurrency ? roundCurrency(v, ownCurrency) : round(v));
  const expectedAmount = roundOwn(Math.abs((Number(origLine.debit) || 0) - (Number(origLine.credit) || 0)));
  return Math.abs(roundOwn(rec.amount) - expectedAmount) < 1e-9
    && rec.debit_amount_currency == null
    && rec.credit_amount_currency == null;
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

  const isGapPartial = rec.exchange_move_id != null
    && (rec.debit_move_id === rec.exchange_move_id || rec.credit_move_id === rec.exchange_move_id);
  const isExchangeReversal = isExchangeReversalClearingPartial(db, rec, debitMove, creditMove);

  const ownCurrency = companyCurrencyRecord(db, companyId);
  const ownId = ownCurrency?.id ?? null;
  const roundOwn = (v) => (ownCurrency ? roundCurrency(v, ownCurrency) : round(v));

  if (!isGapPartial && !isExchangeReversal) {
    const compatError = reconcileItemsCompatibilityError(db, [
      { move: debitMove, line: debitLine },
      { move: creditMove, line: creditLine },
    ], account, ownCurrency);
    if (compatError) return compatError;

    const currD = itemCurrencyId(db, { move: debitMove, line: debitLine }, ownCurrency);
    const currC = itemCurrencyId(db, { move: creditMove, line: creditLine }, ownCurrency);
    if (currD === ownId && currC === ownId) {
      if (rec.exchange_move_id != null || rec.debit_amount_currency != null || rec.credit_amount_currency != null) {
        return 'Exchange difference and currency amounts are not valid for company-currency reconciliation';
      }
    } else if (currD === ownId && currC !== ownId) {
      if (rec.exchange_move_id != null || rec.debit_amount_currency != null) {
        return 'Exchange difference and currency amounts are not valid for company-currency reconciliation';
      }
    } else if (currD !== ownId && currC === ownId) {
      if (rec.exchange_move_id != null || rec.credit_amount_currency != null) {
        return 'Exchange difference and currency amounts are not valid for company-currency reconciliation';
      }
    }
  }

  if (isGapPartial) {
    if (rec.debit_move_id === rec.exchange_move_id && rec.credit_move_id === rec.exchange_move_id) {
      return 'Exchange entry cannot be reconciled with itself';
    }
    const nonExchangeMove = rec.debit_move_id === rec.exchange_move_id ? creditMove : debitMove;
    const nonExchangeLine = rec.debit_move_id === rec.exchange_move_id ? creditLine : debitLine;
    const nonExCurr = itemCurrencyId(db, { move: nonExchangeMove, line: nonExchangeLine }, ownCurrency);
    if (nonExCurr === ownId) {
      return 'Exchange difference and currency amounts are not valid for company-currency reconciliation';
    }
    if (rec.debit_move_id === rec.exchange_move_id) {
      if (rec.debit_amount_currency != null || rec.credit_amount_currency !== 0) {
        return 'Gap partial must have null exchange currency amount and zero counterpart currency amount';
      }
    } else {
      if (rec.credit_amount_currency != null || rec.debit_amount_currency !== 0) {
        return 'Gap partial must have null exchange currency amount and zero counterpart currency amount';
      }
    }
  }
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

  if (rec.debit_amount_currency != null) {
    const dAmt = Number(rec.debit_amount_currency);
    if (!Number.isFinite(dAmt) || dAmt < 0) return 'Debit amount in currency must be a non-negative number';
  }
  if (rec.credit_amount_currency != null) {
    const cAmt = Number(rec.credit_amount_currency);
    if (!Number.isFinite(cAmt) || cAmt < 0) return 'Credit amount in currency must be a non-negative number';
  }

  if (rec.exchange_move_id != null) {
    const fxErr = postedExchangeEntryError(db, rec.exchange_move_id, rec.account_id, companyId);
    if (fxErr) return fxErr;
  }

  return null;
}

/** Server-side guard enforcing creation integrity, immutability, reversal transitions, and lock dates on partial links. */
function partialReconcileGuard(db, before, after, ctx = null) {
  const err = partialReconcileStructureError(db, after);
  if (err) return err;
  const debitMove = read(db, 'account.move', after.debit_move_id);
  const creditMove = read(db, 'account.move', after.credit_move_id);
  const fxMove = after.exchange_move_id ? read(db, 'account.move', after.exchange_move_id) : null;
  const lockOn = (date) => [
    recordLockDate(db, { ...debitMove, date, invoice_date: date }, ctx),
    recordLockDate(db, { ...creditMove, date, invoice_date: date }, ctx),
    fxMove ? recordLockDate(db, { ...fxMove, date, invoice_date: date }, ctx) : null,
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
  const activeFxIds = new Set(activePartials.map((g) => g.exchange_move_id).filter(Boolean));
  const payRestored = new Map();
  const nextMoves = (db.records['account.move'] ?? []).filter((m) => !activeFxIds.has(m.id)).map((move) => {
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

/** Compute a line's residual (company and currency) before a specific partial by subtracting earlier active partials by id order. */
export function lineResidualBeforePartial(baseDb, db, moveId, lineIndex, partialId, ownCurrency, foreignCurrency) {
  const roundOwn = (v) => (ownCurrency ? roundCurrency(v, ownCurrency) : round(v));
  const roundCurr = (v) => (foreignCurrency ? roundCurrency(v, foreignCurrency) : round(v));
  const move = read(baseDb, 'account.move', moveId);
  const line = move && reconciledJournalItems(baseDb, move)[lineIndex];
  if (!line) return { remainingCompany: 0, remainingCurrency: 0 };
  const baseCompRes = Math.abs(Number(line.amount_residual) || 0);
  const baseCurrRes = Math.abs(Number(line.amount_residual_currency) || 0);

  const partials = (db.records['account.partial.reconcile'] ?? []).filter((g) => (
    g && g.active !== false && !g.reversed && g.id < partialId
    && ((g.debit_move_id === moveId && g.debit_line_index === lineIndex)
      || (g.credit_move_id === moveId && g.credit_line_index === lineIndex))
  ));

  let companyUsed = 0;
  let currencyUsed = 0;
  for (const g of partials) {
    companyUsed += Number(g.amount) || 0;
    if (g.debit_move_id === moveId && g.debit_line_index === lineIndex) {
      currencyUsed += Number(g.debit_amount_currency) || 0;
    } else if (g.credit_move_id === moveId && g.credit_line_index === lineIndex) {
      currencyUsed += Number(g.credit_amount_currency) || 0;
    }
  }

  return {
    remainingCompany: Math.max(0, roundOwn(baseCompRes - companyUsed)),
    remainingCurrency: Math.max(0, roundCurr(baseCurrRes - currencyUsed)),
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
    const isGapPartial = after.exchange_move_id != null
      && (after.debit_move_id === after.exchange_move_id || after.credit_move_id === after.exchange_move_id);
    const isExchangeReversal = isExchangeReversalClearingPartial(db, after, debitMove, creditMove);

    if (isExchangeReversal) {
      // The clearing link closes the exchange line and its reversal in full, so nothing else may touch either line.
      const touchesLine = (g, moveId, lineIndex) => (g.debit_move_id === moveId && g.debit_line_index === lineIndex)
        || (g.credit_move_id === moveId && g.credit_line_index === lineIndex);
      const shared = partials.some((g) => g.id !== after.id
        && (touchesLine(g, after.debit_move_id, after.debit_line_index) || touchesLine(g, after.credit_move_id, after.credit_line_index)));
      return shared ? 'Total partial reconciliations cannot exceed the open journal line balance' : null;
    }

    if (isGapPartial) {
      const fxId = after.exchange_move_id;
      const mainPartials = partials.filter((g) => (
        g && g.active !== false && !g.reversed
        && g.exchange_move_id === fxId
        && g.debit_move_id !== fxId
        && g.credit_move_id !== fxId
      ));
      if (mainPartials.length !== 1) {
        return 'Exchange reconciliation requires a matching main partial';
      }
      const mainP = mainPartials[0];
      const mDebitMove = read(baseDb, 'account.move', mainP.debit_move_id);
      const mCreditMove = read(baseDb, 'account.move', mainP.credit_move_id);
      if (!mDebitMove || !mCreditMove) return 'Exchange reconciliation requires a matching main partial';
      const mDLine = reconciledJournalItems(baseDb, mDebitMove)[mainP.debit_line_index];
      const mCLine = reconciledJournalItems(baseDb, mCreditMove)[mainP.credit_line_index];
      if (!mDLine || !mCLine) return 'Exchange reconciliation requires a matching main partial';
      const mCurrId = itemCurrencyId(baseDb, { move: mDebitMove, line: mDLine }, ownCurrency);
      const foreignCurr = read(baseDb, 'res.currency', mCurrId);
      const mResD = lineResidualBeforePartial(baseDb, db, mainP.debit_move_id, mainP.debit_line_index, mainP.id, ownCurrency, foreignCurr);
      const mResC = lineResidualBeforePartial(baseDb, db, mainP.credit_move_id, mainP.credit_line_index, mainP.id, ownCurrency, foreignCurr);
      const commonCurr = Number(mainP.debit_amount_currency);
      const mValD = lineCurrencyValuation(mResD.remainingCompany, mResD.remainingCurrency, commonCurr, ownCurrency);
      const mValC = lineCurrencyValuation(mResC.remainingCompany, mResC.remainingCurrency, commonCurr, ownCurrency);
      const diff = roundOwn(mValC - mValD);
      const gap = Math.abs(diff);

      if (roundOwn(after.amount) !== gap) {
        return 'Exchange reconciliation gap amount does not match the re-derived difference';
      }

      if (diff > 0) {
        if (after.debit_move_id !== fxId || after.credit_move_id !== mainP.credit_move_id || after.credit_line_index !== mainP.credit_line_index) {
          return 'Gap partial must match the overvalued line of the settlement';
        }
      } else {
        if (after.credit_move_id !== fxId || after.debit_move_id !== mainP.debit_move_id || after.debit_line_index !== mainP.debit_line_index) {
          return 'Gap partial must match the overvalued line of the settlement';
        }
      }

      const movesUsingFx = (db.records['account.move'] ?? []).filter((m) => (m.payments ?? []).some((p) => !p.reversed && p.payment_fx_move_id === fxId));
      if (movesUsingFx.length > 0) return 'Exchange entry is already used by another settlement';

      const otherSettlementUses = partials.filter((g) => (g.exchange_move_id === fxId || g.debit_move_id === fxId || g.credit_move_id === fxId)
        && g.id !== after.id && g.id !== mainP.id);
      if (otherSettlementUses.length > 0) {
        return 'Exchange entry is already used by another settlement';
      }

      const expectedNet = diff > 0 ? gap : -gap;
      const overvaluedPartnerId = diff > 0 ? mCLine.partner_id : mDLine.partner_id;
      const fxErr = postedExchangeEntryError(db, fxId, after.account_id, after.company_id, {
        expectedNet,
        expectedPartnerId: overvaluedPartnerId,
      });
      if (fxErr) return fxErr;

      return null;
    }

    const debitItem = debitMove && reconciledJournalItems(baseDb, debitMove)[after.debit_line_index];
    const creditItem = creditMove && reconciledJournalItems(baseDb, creditMove)[after.credit_line_index];

    let debitCap = debitItem && !debitItem.reconciled && Number(debitItem.amount_residual) > 0
      ? roundOwn(Number(debitItem.amount_residual))
      : 0;
    let creditCap = creditItem && !creditItem.reconciled && Number(creditItem.amount_residual) < 0
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

    const dLine = debitItem;
    const cLine = creditItem;
    const ownId = ownCurrency?.id ?? null;
    const currD = dLine ? itemCurrencyId(baseDb, { move: debitMove, line: dLine }, ownCurrency) : ownId;
    const currC = cLine ? itemCurrencyId(baseDb, { move: creditMove, line: cLine }, ownCurrency) : ownId;
    const hasForeign = currD !== ownId || currC !== ownId;

    if (hasForeign || after.debit_amount_currency != null || after.credit_amount_currency != null || after.exchange_move_id != null) {
      if (!debitMove || !creditMove) return 'Partial reconciliation entries must exist in base database';
      if (!dLine || !cLine) return 'Partial reconciliation lines must exist in base database';
      if (currD !== ownId && currC !== ownId) {
        if (currD !== currC) return 'Selected items must be in the same currency';
        if (after.debit_amount_currency == null || after.credit_amount_currency == null || after.debit_amount_currency !== after.credit_amount_currency || !(Number(after.debit_amount_currency) > 0)) {
          return 'Currency amounts on foreign partial reconciliation must match and be positive';
        }
        const foreignCurr = read(baseDb, 'res.currency', currD);
        const commonCurr = Number(after.debit_amount_currency);
        const resD = lineResidualBeforePartial(baseDb, db, after.debit_move_id, after.debit_line_index, after.id, ownCurrency, foreignCurr);
        const resC = lineResidualBeforePartial(baseDb, db, after.credit_move_id, after.credit_line_index, after.id, ownCurrency, foreignCurr);
        if (commonCurr > resD.remainingCurrency + 1e-9 || commonCurr > resC.remainingCurrency + 1e-9) {
          return 'The applied amount cannot exceed the open balance available to reconcile';
        }
        const companyValueD = lineCurrencyValuation(resD.remainingCompany, resD.remainingCurrency, commonCurr, ownCurrency);
        const companyValueC = lineCurrencyValuation(resC.remainingCompany, resC.remainingCurrency, commonCurr, ownCurrency);
        const expectedBase = Math.min(companyValueD, companyValueC);
        if (roundOwn(after.amount) !== expectedBase) {
          return 'Partial reconciliation amount does not match the re-derived base amount';
        }
        const difference = roundOwn(companyValueC - companyValueD);
        const gap = Math.abs(difference);
        if (gap === 0) {
          if (after.exchange_move_id != null) return 'An exchange entry is not required for this settlement';
        } else {
          if (!after.exchange_move_id) return 'An exchange entry is required for foreign reconciliation at different rates';
          const fxId = after.exchange_move_id;
          const expectedNet = difference > 0 ? gap : -gap;
          const overvaluedPartnerId = difference > 0 ? cLine.partner_id : dLine.partner_id;
          const fxErr = postedExchangeEntryError(db, fxId, after.account_id, after.company_id, {
            expectedNet,
            expectedPartnerId: overvaluedPartnerId,
          });
          if (fxErr) return fxErr;

          const movesUsingFx = (db.records['account.move'] ?? []).filter((m) => (m.payments ?? []).some((p) => !p.reversed && p.payment_fx_move_id === fxId));
          if (movesUsingFx.length > 0) return 'Exchange entry is already used by another settlement';

          const otherSettlementUses = partials.filter((g) => (g.exchange_move_id === fxId || g.debit_move_id === fxId || g.credit_move_id === fxId)
            && g.id !== after.id
            && g.debit_move_id !== after.debit_move_id
            && g.credit_move_id !== after.credit_move_id);
          if (otherSettlementUses.length > 0) {
            return 'Exchange entry is already used by another settlement';
          }

          const gapPartial = partials.find((g) => g && g.active !== false && !g.reversed
            && (g.exchange_move_id === fxId || g.debit_move_id === fxId || g.credit_move_id === fxId)
            && g.id !== after.id);
          if (!gapPartial || roundOwn(gapPartial.amount) !== gap || gapPartial.account_id !== after.account_id) {
            return 'Exchange reconciliation requires a matching gap partial';
          }
          if (difference > 0 && (gapPartial.debit_move_id !== fxId || gapPartial.credit_move_id !== after.credit_move_id || gapPartial.credit_line_index !== after.credit_line_index)) {
            return 'Gap partial must match the overvalued line of the settlement';
          }
          if (difference < 0 && (gapPartial.debit_move_id !== after.debit_move_id || gapPartial.debit_line_index !== after.debit_line_index || gapPartial.credit_move_id !== fxId)) {
            return 'Gap partial must match the overvalued line of the settlement';
          }

          const usesOfFx = partials.filter((g) => g.exchange_move_id === fxId || g.debit_move_id === fxId || g.credit_move_id === fxId);
          if (usesOfFx.length > 2 || usesOfFx.some((g) => g.id !== after.id && g.id !== gapPartial.id)) {
            return 'Exchange entry is already used by another settlement';
          }
        }
      } else if (currD !== ownId || currC !== ownId) {
        if (after.exchange_move_id != null) return 'An exchange entry is not required for this settlement';
        // Mixed company/foreign match: only the foreign side carries a currency amount, its proportional share.
        const foreignSide = currD !== ownId ? 'debit' : 'credit';
        const companySide = foreignSide === 'debit' ? 'credit' : 'debit';
        if (after[`${companySide}_amount_currency`] != null) {
          return 'Exchange difference and currency amounts are not valid for company-currency reconciliation';
        }
        const amountCurrency = after[`${foreignSide}_amount_currency`];
        if (amountCurrency == null || !(Number(amountCurrency) > 0)) {
          return 'Currency amounts on foreign partial reconciliation must match and be positive';
        }
        const foreignCurr = read(baseDb, 'res.currency', foreignSide === 'debit' ? currD : currC);
        const roundCurr = (v) => (foreignCurr ? roundCurrency(v, foreignCurr) : round(v));
        const res = lineResidualBeforePartial(baseDb, db, after[`${foreignSide}_move_id`], after[`${foreignSide}_line_index`], after.id, ownCurrency, foreignCurr);
        if (res.remainingCompany <= 0 || res.remainingCurrency <= 0) {
          return 'The applied amount cannot exceed the open balance available to reconcile';
        }
        const expectedCurr = roundOwn(after.amount) >= res.remainingCompany
          ? res.remainingCurrency
          : roundCurr(res.remainingCurrency * after.amount / res.remainingCompany);
        if (Math.abs(roundCurr(Number(amountCurrency)) - expectedCurr) > 1e-4) {
          return 'Partial reconciliation currency amount does not match the expected foreign residual';
        }
      }
    }
  } else if (after.reversed) {
    if (after.exchange_move_id) {
      const fx = read(db, 'account.move', after.exchange_move_id);
      const isReversed = fx && (fx.reversal_move_id != null || (db.records['account.move'] ?? []).some((m) => m.state === 'posted' && m.reversed_entry_id === fx.id));
      if (!isReversed) return 'Reversing a partial reconciliation must also reverse its exchange entry';
    }
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
      debit_amount_currency: { type: 'monetary', label: 'Debit Amount Currency' },
      credit_amount_currency: { type: 'monetary', label: 'Credit Amount Currency' },
      exchange_move_id: { type: 'many2one', relation: 'account.move', label: 'Exchange Difference Entry' },
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
  return (a.moveDate || '').localeCompare(b.moveDate || '')
    || (a.dueDate || '').localeCompare(b.dueDate || '')
    || a.move.id - b.move.id
    || a.lineIndex - b.lineIndex;
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
  if (docs.length === 1 && refunds.length === 1) {
    const ownCurrency = companyCurrencyRecord(db, docs[0].move.company_id ?? 1);
    const currDoc = itemCurrencyId(db, docs[0], ownCurrency);
    const currRef = itemCurrencyId(db, refunds[0], ownCurrency);
    if (currDoc !== currRef) return false;
    return true;
  }
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
function splitDebitCreditItems(items, ownCurrency, roundOwn) {
  const debits = [];
  const credits = [];
  for (const it of items) {
    const r = Number(it.reconciledLine.amount_residual) || 0;
    if (isCurrencyZero(r, ownCurrency)) continue;
    if (r > 0) debits.push({ ...it, remaining: roundOwn(r) });
    else if (r < 0) credits.push({ ...it, remaining: roundOwn(-r) });
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

  if (items.some((it) => isExchangeEntry(db, it.move))) {
    throw new Error('Exchange entries cannot be reconciled directly');
  }

  if (items.some((it) => it.reconciledLine?.reconciled === true || isCurrencyZero(Number(it.reconciledLine?.amount_residual) || 0, ownCurrency))) {
    throw new Error('Selected journal items must not already be fully reconciled');
  }

  const compatError = reconcileItemsCompatibilityError(db, items, account, ownCurrency);
  if (compatError) throw new Error(compatError);

  for (const it of items) {
    const currId = itemCurrencyId(db, it, ownCurrency);
    if (currId !== (ownCurrency?.id ?? null)) {
      const foreignCurr = read(db, 'res.currency', currId);
      const resCurr = Math.abs(Number(it.reconciledLine?.amount_residual_currency) || 0);
      if (isCurrencyZero(resCurr, foreignCurr)) {
        throw new Error('Selected foreign-currency items must have a non-zero currency balance');
      }
    }
  }

  for (const it of items) {
    const lock = recordLockDate(db, it.move);
    if (lock && date <= lock) throw new Error(`The period up to ${lock} is locked`);
  }

  const net = roundOwn(items.reduce((s, it) => s + Number(it.reconciledLine.amount_residual), 0));
  const distinctPartners = new Set(items.map((it) => it.line.partner_id ?? null));
  const isArAp = RECEIVABLE_PAYABLE.includes(account.account_type);
  const groupPartnerId = isArAp
    ? (items[0].line.partner_id ?? null)
    : (distinctPartners.size === 1 ? [...distinctPartners][0] : null);

  const { debits, credits } = splitDebitCreditItems(items, ownCurrency, roundOwn);

  let validatedWriteoff = null;
  if (writeoff) {
    if (amount != null) {
      throw new Error('An explicit reconciliation amount is only supported when reconciling one debit item with one credit item');
    }
    validatedWriteoff = validateWriteoffOptions(db, writeoff, {
      companyId,
      accountId: account.id,
      net,
      ownCurrency,
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
    requestedAmount = roundOwn(num);
    if (!(requestedAmount > 0) || isCurrencyZero(requestedAmount, ownCurrency)) throw new Error('The applied amount must be a positive number');
    if (debits.length !== 1 || credits.length !== 1) {
      throw new Error('An explicit reconciliation amount is only supported when reconciling one debit item with one credit item');
    }
    const maxAbsorbable = roundOwn(Math.min(debits[0].remaining, credits[0].remaining));
    const excess = roundOwn(requestedAmount - maxAbsorbable);
    if (excess > 0 && !isCurrencyZero(excess, ownCurrency)) {
      throw new Error(EXCEEDED_AMOUNT_ERROR);
    }
  }

  return { companyId, ownCurrency, roundOwn, account, net, groupPartnerId, validatedWriteoff, requestedAmount };
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
function settleDocumentSide(db, docItem, otherItem, { matchAmt, currencyAmt = null, pairDate, partialReconcileId }) {
  if (!documentSettledByCounterSide(docItem.move, docItem.line)) return db;
  const doc = read(db, 'account.move', docItem.move.id);
  const docCurr = documentCurrency(db, doc);
  const roundDoc = (v) => roundCurrency(v, docCurr);
  const ownCurr = companyCurrencyRecord(db, doc.company_id ?? 1);
  const isForeign = Boolean(docCurr && ownCurr && docCurr.id !== ownCurr.id);

  if (isForeign) {
    const docAmt = currencyAmt != null ? roundDoc(currencyAmt) : roundDoc(matchAmt);
    if (!(docAmt > 0)) return db;
    return appendDocumentSettlement(db, doc.id, {
      amount: docAmt,
      moveId: otherItem.move.id,
      date: pairDate,
      companyAmount: matchAmt,
      lineIndex: docItem.multiInstallment ? docItem.lineIndex : null,
      partialReconcileId,
      consumePayment: true,
    }).db;
  }

  const openDoc = docItem.multiInstallment
    ? roundDoc(installmentSettlementState(db, doc).remainingByIndex.get(docItem.lineIndex) ?? residual(doc, db))
    : roundDoc(residual(doc, db));
  const docAmt = roundDoc(Math.min(openDoc, matchAmt));
  if (!(docAmt > 0)) return db;
  return appendDocumentSettlement(db, doc.id, {
    amount: docAmt,
    moveId: otherItem.move.id,
    date: pairDate,
    companyAmount: docAmt,
    lineIndex: docItem.multiInstallment ? docItem.lineIndex : null,
    partialReconcileId,
    consumePayment: true,
  }).db;
}

/** Derive the common currency amount to match an explicit company budget, or throw if not exactly representable. */
export function deriveCommonCurrencyForBudget(budget, dRemaining, dCurrRemaining, cRemaining, cCurrRemaining, foreignCurr, ownCurrency) {
  const roundCurr = (v) => (foreignCurr ? roundCurrency(v, foreignCurr) : round(v));
  const rateD = dRemaining / dCurrRemaining;
  const rateC = cRemaining / cCurrRemaining;
  const minRate = Math.min(rateD, rateC);
  if (!(minRate > 0)) {
    throw new Error('The applied amount cannot be represented exactly after currency rounding');
  }
  const approxCurr = roundCurr(budget / minRate);
  const step = foreignCurr?.rounding || (foreignCurr?.decimal_places != null ? 10 ** -foreignCurr.decimal_places : 0.01);
  const maxCurr = roundCurr(Math.min(dCurrRemaining, cCurrRemaining));

  const candidates = [];
  for (let delta = 0; delta <= 10; delta++) {
    for (const sign of (delta === 0 ? [1] : [1, -1])) {
      const cand = roundCurr(approxCurr + sign * delta * step);
      if (cand > 0 && cand <= maxCurr + 1e-9 && !candidates.includes(cand)) {
        candidates.push(cand);
      }
    }
  }

  for (const cand of candidates) {
    const valD = lineCurrencyValuation(dRemaining, dCurrRemaining, cand, ownCurrency);
    const valC = lineCurrencyValuation(cRemaining, cCurrRemaining, cand, ownCurrency);
    const base = Math.min(valD, valC);
    if (Math.abs(base - budget) < 1e-9) {
      return cand;
    }
  }
  throw new Error('The applied amount cannot be represented exactly after currency rounding');
}

/** Match debits against credits oldest first, creating `account.partial.reconcile` links and document settlements. */
/**
 * Foreign amount a company-currency match of `matchAmt` consumes from a foreign-currency item (its proportional share,
 * or the whole remainder when the match clears the item), updating the item's running foreign remainder; null for
 * company-currency items.
 */
function consumeForeign(db, item, currencyId, matchAmt, ownCurrency) {
  if (currencyId === (ownCurrency?.id ?? null)) return null;
  const currency = read(db, 'res.currency', currencyId);
  const remaining = item.remainingCurrency ?? Math.abs(Number(item.reconciledLine.amount_residual_currency) || 0);
  const consumed = matchAmt >= item.remaining || Math.abs(matchAmt - item.remaining) < 1e-9
    ? remaining
    : roundCurrency(remaining * matchAmt / item.remaining, currency);
  item.remainingCurrency = roundCurrency(remaining - consumed, currency);
  return consumed;
}

function matchDebitCreditPairs(db, workingItems, { account, companyId, matchDate, requestedAmount, ownCurrency, roundOwn }) {
  const { debits, credits } = splitDebitCreditItems(workingItems, ownCurrency, roundOwn);
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
    if (budget != null && (budget <= 0 || isCurrencyZero(budget, ownCurrency))) break;
    const prevDi = di;
    const prevCi = ci;
    const prevBudget = budget;
    const d = debits[di];
    const c = credits[ci];
    const prevDRem = d.remaining;
    const prevCRem = c.remaining;

    const currD = itemCurrencyId(next, d, ownCurrency);
    const currC = itemCurrencyId(next, c, ownCurrency);
    const isForeignPair = currD !== (ownCurrency?.id ?? null) && currD === currC;

    if (isForeignPair) {
      const foreignCurr = read(next, 'res.currency', currD);
      const roundCurr = (v) => roundCurrency(v, foreignCurr);
      const remCurrD = d.remainingCurrency != null
        ? d.remainingCurrency
        : Math.abs(Number(d.reconciledLine.amount_residual_currency) || 0);
      const remCurrC = c.remainingCurrency != null
        ? c.remainingCurrency
        : Math.abs(Number(c.reconciledLine.amount_residual_currency) || 0);

      const uncappedCommonCurr = roundCurr(Math.min(remCurrD, remCurrC));
      if (uncappedCommonCurr > 0 && !isCurrencyZero(uncappedCommonCurr, foreignCurr)) {
        const uncappedCompanyValueD = lineCurrencyValuation(d.remaining, remCurrD, uncappedCommonCurr, ownCurrency);
        const uncappedCompanyValueC = lineCurrencyValuation(c.remaining, remCurrC, uncappedCommonCurr, ownCurrency);
        const uncappedBase = Math.min(uncappedCompanyValueD, uncappedCompanyValueC);

        let commonCurr = uncappedCommonCurr;
        // A budget above this pair's value settles the whole pair and carries over to the next pair.
        if (budget != null && budget < uncappedBase) {
          commonCurr = deriveCommonCurrencyForBudget(budget, d.remaining, remCurrD, c.remaining, remCurrC, foreignCurr, ownCurrency);
        }

        const companyValueD = lineCurrencyValuation(d.remaining, remCurrD, commonCurr, ownCurrency);
        const companyValueC = lineCurrencyValuation(c.remaining, remCurrC, commonCurr, ownCurrency);
        const baseAmount = Math.min(companyValueD, companyValueC);
        const difference = roundOwn(companyValueC - companyValueD);
        const gap = Math.abs(difference);
        const pairDate = [matchDate, d.moveDate, c.moveDate].sort().at(-1);

        let fxId = null;
        if (gap > 0 && !isCurrencyZero(gap, ownCurrency)) {
          const isGain = difference > 0;
          const gainLossAccount = exchangeAccount(next, companyId, difference);
          const partnerId = isGain ? c.line.partner_id : d.line.partner_id;
          const valueOnly = valueOnlyCurrencyFields(next, account.id, companyId ?? 1, foreignCurr?.id);
          const fxJournalId = exchangeJournal(next, companyId).id;
          const fx = postEntry(next, {
            journal_id: fxJournalId,
            journal: fxJournalId,
            company: companyId ?? 1,
            date: pairDate,
            ref: `Exchange difference ${d.move.name || ''} / ${c.move.name || ''}`.trim(),
            archivedOriginIds: [d.move.id, c.move.id],
            lines: isGain
              ? [
                  { account: account.id, debit: gap, credit: 0, partner_id: partnerId, ...valueOnly },
                  { account: gainLossAccount, debit: 0, credit: gap },
                ]
              : [
                  { account: account.id, debit: 0, credit: gap, partner_id: partnerId, ...valueOnly },
                  { account: gainLossAccount, debit: gap, credit: 0 },
                ],
          });
          next = fx.db;
          fxId = fx.id;
        }

        const p1 = create(next, 'account.partial.reconcile', {
          debit_move_id: d.move.id,
          debit_line_index: d.lineIndex,
          credit_move_id: c.move.id,
          credit_line_index: c.lineIndex,
          account_id: account.id,
          company_id: companyId,
          amount: baseAmount,
          debit_amount_currency: commonCurr,
          credit_amount_currency: commonCurr,
          exchange_move_id: fxId,
          date: pairDate,
          active: true,
          reversed: false,
        });
        next = p1.db;

        if (fxId) {
          if (difference > 0) {
            const p2 = create(next, 'account.partial.reconcile', {
              debit_move_id: fxId,
              debit_line_index: 0,
              credit_move_id: c.move.id,
              credit_line_index: c.lineIndex,
              account_id: account.id,
              company_id: companyId,
              amount: gap,
              debit_amount_currency: null,
              credit_amount_currency: 0,
              exchange_move_id: fxId,
              date: pairDate,
              active: true,
              reversed: false,
            });
            next = p2.db;
          } else {
            const p2 = create(next, 'account.partial.reconcile', {
              debit_move_id: d.move.id,
              debit_line_index: d.lineIndex,
              credit_move_id: fxId,
              credit_line_index: 0,
              account_id: account.id,
              company_id: companyId,
              amount: gap,
              debit_amount_currency: 0,
              credit_amount_currency: null,
              exchange_move_id: fxId,
              date: pairDate,
              active: true,
              reversed: false,
            });
            next = p2.db;
          }
        }

        next = settleDocumentSide(next, d, c, { matchAmt: companyValueD, currencyAmt: commonCurr, pairDate, partialReconcileId: p1.id });
        next = settleDocumentSide(next, c, d, { matchAmt: companyValueC, currencyAmt: commonCurr, pairDate, partialReconcileId: p1.id });

        d.remaining = roundOwn(d.remaining - companyValueD);
        d.remainingCurrency = roundCurr(remCurrD - commonCurr);
        c.remaining = roundOwn(c.remaining - companyValueC);
        c.remainingCurrency = roundCurr(remCurrC - commonCurr);
        if (budget != null) budget = roundOwn(budget - baseAmount);
      }
      if (d.remaining <= 0 || isCurrencyZero(d.remaining, ownCurrency) || (d.remainingCurrency != null && isCurrencyZero(d.remainingCurrency, foreignCurr))) di += 1;
      if (c.remaining <= 0 || isCurrencyZero(c.remaining, ownCurrency) || (c.remainingCurrency != null && isCurrencyZero(c.remainingCurrency, foreignCurr))) ci += 1;
    } else {
      const matchAmt = roundOwn(Math.min(d.remaining, c.remaining, ...(budget != null ? [budget] : [])));
      if (matchAmt > 0 && !isCurrencyZero(matchAmt, ownCurrency)) {
        const consumedD = consumeForeign(next, d, currD, matchAmt, ownCurrency);
        const consumedC = consumeForeign(next, c, currC, matchAmt, ownCurrency);
        const pairDate = [matchDate, d.moveDate, c.moveDate].sort().at(-1);
        const created = create(next, 'account.partial.reconcile', {
          debit_move_id: d.move.id,
          debit_line_index: d.lineIndex,
          credit_move_id: c.move.id,
          credit_line_index: c.lineIndex,
          account_id: account.id,
          company_id: companyId,
          amount: matchAmt,
          debit_amount_currency: consumedD,
          credit_amount_currency: consumedC,
          exchange_move_id: null,
          date: pairDate,
          active: true,
          reversed: false,
        });
        next = settleDocumentSide(created.db, d, c, { matchAmt, currencyAmt: consumedD, pairDate, partialReconcileId: created.id });
        next = settleDocumentSide(next, c, d, { matchAmt, currencyAmt: consumedC, pairDate, partialReconcileId: created.id });
        d.remaining = roundOwn(d.remaining - matchAmt);
        c.remaining = roundOwn(c.remaining - matchAmt);
        if (budget != null) budget = roundOwn(budget - matchAmt);
      }
      const isDoneD = d.remaining <= 0 || isCurrencyZero(d.remaining, ownCurrency)
        || (currD !== (ownCurrency?.id ?? null) && d.remainingCurrency != null && isCurrencyZero(d.remainingCurrency, read(next, 'res.currency', currD)));
      const isDoneC = c.remaining <= 0 || isCurrencyZero(c.remaining, ownCurrency)
        || (currC !== (ownCurrency?.id ?? null) && c.remainingCurrency != null && isCurrencyZero(c.remainingCurrency, read(next, 'res.currency', currC)));
      if (isDoneD) di += 1;
      if (isDoneC) ci += 1;
    }
    if (di === prevDi && ci === prevCi && budget === prevBudget && d.remaining === prevDRem && c.remaining === prevCRem) {
      throw new Error('Reconciliation matching stalled without progress');
    }
  }
  if (budget != null && budget > 0 && !isCurrencyZero(budget, ownCurrency)) {
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

  const fxMovesToReverse = [];
  const visitedFx = new Set();
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const pid of Array.from(partialIds)) {
      const g = activePartials.find((p) => p.id === pid);
      if (g?.exchange_move_id && !visitedFx.has(g.exchange_move_id)) {
        visitedFx.add(g.exchange_move_id);
        const fxMove = read(db, 'account.move', g.exchange_move_id);
        if (fxMove && fxMove.state === 'posted') {
          fxMovesToReverse.push(fxMove);
        }
        for (const sibling of activePartials) {
          if ((sibling.exchange_move_id === g.exchange_move_id
            || sibling.debit_move_id === g.exchange_move_id
            || sibling.credit_move_id === g.exchange_move_id)
            && !partialIds.has(sibling.id)) {
            partialIds.add(sibling.id);
            expanded = true;
          }
        }
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

  for (const fxMove of fxMovesToReverse) {
    const fxDate = fxMove.invoice_date ?? fxMove.date ?? '';
    if (fxDate && date < fxDate) throw new Error('Enter an unreconciliation date on or after the matching date');
    const lock = recordLockDate(db, fxMove);
    if (lock && date <= lock) throw new Error(`The period up to ${lock} is locked`);
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

  return { touchedLinks, docRows, legacySelections, fxMovesToReverse };
}

/**
 * Remove reconciliations on selected journal items. Active `account.partial.reconcile` links are marked
 * reversed/inactive without reversing their underlying journal entries (including write-offs created by
 * Reconcile with write-off), while document residuals, cash-basis releases, and unapplied payment credits are restored.
 */
export function unreconcileLedgerItems(db, selections, { date = today() } = {}) {
  const items = selectedItems(db, selections, { allowMultipleEntryLines: true });
  if (!validDate(date)) throw new Error('Enter a valid reversal date');

  const { touchedLinks, docRows, legacySelections, fxMovesToReverse } = collectAndValidateUnreconcile(db, items, date);

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
  for (const fxMove of fxMovesToReverse) {
    const reversed = reverseEntry(next, fxMove, date, { reconciliation_reversal: true });
    next = reversed.db;
    const revMove = read(next, 'account.move', reversed.id);
    // The exchange line sits on the account the settlement matched; pair it with the same line of the reversal.
    const matchedAccountId = touchedLinks.find((g) => g.exchange_move_id === fxMove.id)?.account_id;
    const fxAccountLineIdx = (fxMove.line_ids ?? []).findIndex((l) => l.account_id === matchedAccountId);
    if (fxAccountLineIdx >= 0) {
      const fxLine = fxMove.line_ids[fxAccountLineIdx];
      const revLine = revMove.line_ids?.[fxAccountLineIdx];
      if (revLine) {
        const debitBal = (Number(fxLine.debit) || 0) - (Number(fxLine.credit) || 0);
        const isFxDebit = debitBal > 0;
        const amount = Math.abs(debitBal);
        const pair = create(next, 'account.partial.reconcile', {
          debit_move_id: isFxDebit ? fxMove.id : revMove.id,
          debit_line_index: fxAccountLineIdx,
          credit_move_id: isFxDebit ? revMove.id : fxMove.id,
          credit_line_index: fxAccountLineIdx,
          account_id: fxLine.account_id,
          company_id: fxMove.company_id ?? 1,
          amount,
          debit_amount_currency: null,
          credit_amount_currency: null,
          exchange_move_id: null,
          date,
          active: true,
          reversed: false,
        });
        next = pair.db;
      }
    }
  }
  if (legacySelections.length) {
    next = unreconcileJournalItems(next, legacySelections, { date });
  }
  return next;
}
