// Automatic journal entries from Journal Items: post draft entries, Move to Account (change_account), and Change Period (change_period).
import { postNote, read, search, write } from '../orm.js';
import { companyCurrencyRecord, isCurrencyZero, roundCurrency } from '../money.js';
import { today, validDate } from './common.js';
import { isInvoice, postMove } from './accounting.js';
import { installmentSettlementState, isIncomeOrExpenseAccount, isReconcilableAccount, journalItemIdentity, postEntry, reversalLine } from './ledger.js';
import { selectedItems } from './pay.js';
import { reconcileLedgerItems } from './glReconcile.js';

const accountSide = (account) => (['income', 'income_other'].includes(account?.account_type) ? 'income' : 'expense');

const itemMoveState = (it) => it?.move?.state ?? it?.move_state;
const itemCompanyId = (it) => it?.move?.company_id ?? it?.company_id ?? 1;
const itemAccount = (it, db = null) => (
  (it?.account && typeof it.account === 'object' ? it.account : null)
  ?? it?._account
  ?? (db && it?.account_id ? read(db, 'account.account', it.account_id) : null)
);
const itemIsReconciled = (it) => (it?.reconciledLine?.reconciled ?? it?.reconciled) === true;

/** Whether a line has an active reconciliation link, partial settlement, or legacy invoice payment application. */
function lineHasActiveSettlement(db, item) {
  if (!item) return false;
  if (item.reconciledLine?.reconciled || item.reconciled) return true;
  if (!db || !item.move || item.lineIndex == null) {
    return Boolean(item.matching_number && isReconcilableAccount(itemAccount(item, db)));
  }
  const activePartials = (db.records?.['account.partial.reconcile'] ?? []).some((g) => (
    g && g.active !== false && !g.reversed
    && ((g.debit_move_id === item.move.id && g.debit_line_index === item.lineIndex)
      || (g.credit_move_id === item.move.id && g.credit_line_index === item.lineIndex))
  ));
  if (activePartials) return true;
  if (isInvoice(item.move) && item.counterpart) {
    const activeRows = (item.move.payments ?? []).filter((p) => !p.reversed && !p.unapplied);
    if (activeRows.some((p) => !item.multiInstallment || p.line_index == null || p.line_index === item.lineIndex)) return true;
    if (item.multiInstallment && installmentSettlementState(db, item.move).untargetedTouched.has(item.lineIndex)) return true;
  }
  if (isReconcilableAccount(item.account) && item.reconciledLine?.amount_residual != null) {
    const ownCurr = companyCurrencyRecord(db, item.move.company_id ?? 1);
    const bal = Math.abs((Number(item.line.debit) || 0) - (Number(item.line.credit) || 0));
    if (Math.abs(Math.abs(item.reconciledLine.amount_residual) - bal) > (Number(ownCurr?.rounding) || 0.01) / 2) return true;
  }
  return false;
}

/** True when all selected items belong to draft parent moves and may be posted via Post action. */
export function canPostJournalItems(lines = []) {
  return lines.length > 0 && lines.every((it) => itemMoveState(it) === 'draft');
}

/** True when Move to Account wizard is available for the selected journal items per Odoo 20 rules. */
export function canMoveToAccount(lines = [], db = null) {
  if (!lines.length) return false;
  if (lines.some((it) => itemMoveState(it) !== 'posted')) return false;
  if (new Set(lines.map(itemCompanyId)).size > 1) return false;
  return lines.every((it) => !itemIsReconciled(it) && !(db ? lineHasActiveSettlement(db, it) : (it.matching_number && isReconcilableAccount(itemAccount(it, db)))));
}

/** True when Change Period wizard is available for the selected journal items per Odoo 20 rules. */
export function canChangePeriod(lines = [], db = null) {
  if (!lines.length) return false;
  if (lines.some((it) => itemMoveState(it) !== 'posted')) return false;
  if (new Set(lines.map(itemCompanyId)).size > 1) return false;
  if (lines.some((it) => !isIncomeOrExpenseAccount(itemAccount(it, db)))) return false;
  return new Set(lines.map((it) => accountSide(itemAccount(it, db)))).size === 1;
}

/** Default general journal for automatic entries in a company. */
export function defaultAutomaticJournalId(db, companyId, kind = 'general') {
  const company = read(db, 'res.company', companyId ?? 1);
  const candidates = [
    kind === 'expense' ? company?.deferred_expense_journal_id : kind === 'income' ? company?.deferred_revenue_journal_id : null,
    company?.default_general_journal_id,
    ...search(db, 'account.journal')
      .filter((j) => j.active !== false && j.type === 'general' && (j.company_id ?? 1) === (companyId ?? 1))
      .map((j) => j.id),
  ].filter(Boolean);
  for (const id of candidates) {
    const j = read(db, 'account.journal', id);
    if (j && j.active !== false && j.type === 'general' && (j.company_id ?? 1) === (companyId ?? 1)) return j.id;
  }
  return null;
}

/** Compute default wizard values (`date`, `journalId`, `accountId`, `percentage`) for the current selection. */
export function automaticEntryDefaults(db, lines = [], action = '') {
  const companyId = lines.length ? itemCompanyId(lines[0]) : (db?.settings?.current_company_id ?? 1);
  const company = read(db, 'res.company', companyId);
  const side = action === 'Change Period' && lines.length && isIncomeOrExpenseAccount(itemAccount(lines[0], db))
    ? accountSide(itemAccount(lines[0], db))
    : 'general';
  const accountId = action === 'Change Period' && (side === 'income' || side === 'expense')
    ? (company?.[side === 'income' ? 'deferred_revenue_account_id' : 'deferred_expense_account_id'] ?? '')
    : '';
  return {
    date: today(),
    journalId: defaultAutomaticJournalId(db, companyId, side) ?? '',
    accountId: accountId ? String(accountId) : '',
    percentage: '100',
  };
}

/** Validate and resolve an active miscellaneous journal belonging to `companyId`. */
function resolveGeneralJournal(db, journalId, companyId, kind = 'general') {
  const id = journalId ? Number(journalId) : defaultAutomaticJournalId(db, companyId, kind);
  const j = id ? read(db, 'account.journal', id) : null;
  if (!j || j.active === false || j.type !== 'general' || (j.company_id ?? 1) !== companyId) {
    throw new Error('Select an active miscellaneous journal for this company');
  }
  return j;
}

/** Validate and resolve an active, non-deprecated account valid for `companyId`. */
function resolveCompanyTargetAccount(db, accountId, companyId, errorMessage, { disallowTypes = [] } = {}) {
  const id = Number(accountId);
  const acc = Number.isInteger(id) && id > 0 ? read(db, 'account.account', id) : null;
  if (!acc || acc.active === false || acc.deprecated || disallowTypes.includes(acc.account_type)
    || (acc.company_id && acc.company_id !== companyId)) {
    throw new Error(errorMessage);
  }
  return acc;
}

/**
 * Resolve selected posted items from a single company for automatic-entry wizards.
 * Mirrors Odoo `account.automatic.entry.wizard` state & company constraints.
 */
function resolvePostedSingleCompanyItems(db, selections) {
  const items = selectedItems(db, selections, {
    allowMultipleEntryLines: true,
    requireReconcilable: false,
    allowedStates: ['draft', 'posted', 'cancel'],
  });
  if (items.some((it) => it.move.state !== 'posted')) {
    throw new Error('You can only use this wizard on posted journal items.');
  }
  const companyIds = [...new Set(items.map((it) => it.move.company_id ?? 1))];
  if (companyIds.length > 1) {
    throw new Error('You cannot create automatic entries for items from different companies.');
  }
  return { items, companyId: companyIds[0] };
}

/**
 * Post the draft parent journal entries of all selected journal items (`account.move.line` `action_post`).
 * Deduplicates by `move_id` and runs the standard `postMove` validations.
 */
export function postJournalItems(db, selections) {
  const items = selectedItems(db, selections, {
    allowMultipleEntryLines: true,
    requireReconcilable: false,
    allowedStates: ['draft', 'posted', 'cancel'],
  });
  if (items.some((it) => it.move.state !== 'draft')) {
    throw new Error('Only draft entries can be posted');
  }
  const moveIds = [];
  for (const it of items) {
    if (!moveIds.includes(it.move.id)) moveIds.push(it.move.id);
  }
  let next = db;
  for (const moveId of moveIds) {
    next = postMove(next, moveId);
  }
  return next;
}

/**
 * Transfer selected posted journal items' balance to `destinationAccountId` on `date` (`action = 'change_account'`).
 * Groups source lines per `(account_id, partner_id, currency_id)`, creates one posted transfer entry linked back
 * to source moves, and reconciles counter-lines on reconcilable source accounts.
 */
export function moveToAccount(db, selections, { destinationAccountId, date = today(), journalId = null } = {}) {
  const { items, companyId } = resolvePostedSingleCompanyItems(db, selections);
  if (items.some((it) => lineHasActiveSettlement(db, it))) {
    throw new Error('You cannot use this wizard on reconciled journal items.');
  }
  if (!validDate(date)) throw new Error('Enter a valid date');
  const destAcc = resolveCompanyTargetAccount(db, destinationAccountId, companyId, 'Select an active destination account for this company');
  const journal = resolveGeneralJournal(db, journalId, companyId);
  const ownCurrency = companyCurrencyRecord(db, companyId);

  const sourceGroups = new Map();
  for (const it of items) {
    if (it.line.account_id === destAcc.id) continue;
    const isForeign = Boolean(it.line.currency_id && ownCurrency && it.line.currency_id !== ownCurrency.id);
    const currId = isForeign ? it.line.currency_id : (ownCurrency?.id ?? null);
    const key = JSON.stringify([it.line.account_id, it.line.partner_id ?? null, currId]);
    const existing = sourceGroups.get(key) ?? {
      accountId: it.line.account_id,
      partnerId: it.line.partner_id ?? null,
      currencyId: currId,
      isForeign,
      balance: 0,
      amountCurrency: 0,
      items: [],
    };
    const bal = (Number(it.line.debit) || 0) - (Number(it.line.credit) || 0);
    existing.balance = roundCurrency(existing.balance + bal, ownCurrency);
    if (isForeign) {
      const fCurr = read(db, 'res.currency', currId);
      existing.amountCurrency = roundCurrency(existing.amountCurrency + (Number(it.line.amount_currency) || 0), fCurr);
    }
    existing.items.push(it);
    sourceGroups.set(key, existing);
  }

  const activeGroups = [...sourceGroups.values()].filter((g) => {
    const fCurr = g.isForeign ? read(db, 'res.currency', g.currencyId) : null;
    return !isCurrencyZero(g.balance, ownCurrency) || (g.isForeign && !isCurrencyZero(g.amountCurrency, fCurr));
  });
  if (!activeGroups.length) {
    throw new Error('Selected items already belong to the destination account or have zero balance');
  }

  const label = `Transfer to ${destAcc.code ? `${destAcc.code} ` : ''}${destAcc.name}`.trim();
  const destGroups = new Map();
  const lines = [];
  const reconcilePlans = [];
  const sourceMoveIds = [];

  for (const g of activeGroups) {
    const fCurr = g.isForeign ? read(db, 'res.currency', g.currencyId) : null;
    const counterIndex = lines.length;
    lines.push({
      account_id: g.accountId,
      partner_id: g.partnerId,
      name: label,
      debit: g.balance < 0 ? -g.balance : 0,
      credit: g.balance > 0 ? g.balance : 0,
      analytic_distribution: null,
      ...(g.isForeign ? {
        currency_id: g.currencyId,
        amount_currency: roundCurrency(-g.amountCurrency, fCurr),
      } : {}),
    });
    for (const it of g.items) {
      if (!sourceMoveIds.includes(it.move.id)) sourceMoveIds.push(it.move.id);
    }
    const srcAcc = read(db, 'account.account', g.accountId);
    if (isReconcilableAccount(srcAcc) && !isCurrencyZero(g.balance, ownCurrency)) {
      reconcilePlans.push({ items: g.items, counterIndex });
    }
    const destKey = JSON.stringify([g.partnerId, g.currencyId]);
    const destGroup = destGroups.get(destKey) ?? {
      partnerId: g.partnerId,
      currencyId: g.currencyId,
      isForeign: g.isForeign,
      balance: 0,
      amountCurrency: 0,
    };
    destGroup.balance = roundCurrency(destGroup.balance + g.balance, ownCurrency);
    if (g.isForeign) {
      destGroup.amountCurrency = roundCurrency(destGroup.amountCurrency + g.amountCurrency, fCurr);
    }
    destGroups.set(destKey, destGroup);
  }

  for (const dg of destGroups.values()) {
    const fCurr = dg.isForeign ? read(db, 'res.currency', dg.currencyId) : null;
    if (isCurrencyZero(dg.balance, ownCurrency) && (!dg.isForeign || isCurrencyZero(dg.amountCurrency, fCurr))) continue;
    lines.push({
      account_id: destAcc.id,
      partner_id: dg.partnerId,
      name: label,
      debit: dg.balance > 0 ? dg.balance : 0,
      credit: dg.balance < 0 ? -dg.balance : 0,
      analytic_distribution: null,
      ...(dg.isForeign ? {
        currency_id: dg.currencyId,
        amount_currency: roundCurrency(dg.amountCurrency, fCurr),
      } : {}),
    });
  }

  const created = postEntry(db, {
    journal_id: journal.id,
    company: companyId,
    date,
    ref: label,
    lines,
    automatic_entry_source_move_ids: sourceMoveIds,
    archivedOriginIds: sourceMoveIds,
  });
  let next = created.db;
  const createdMove = read(next, 'account.move', created.id);

  for (const plan of reconcilePlans) {
    const counterLine = createdMove.line_ids[plan.counterIndex];
    const sel = [
      ...plan.items.map((it) => ({
        move_id: it.move.id,
        line_index: it.lineIndex,
        line_identity: journalItemIdentity(it.line),
      })),
      {
        move_id: createdMove.id,
        line_index: plan.counterIndex,
        line_identity: journalItemIdentity(counterLine),
      },
    ];
    next = reconcileLedgerItems(next, sel, { date });
  }

  const sourceNames = sourceMoveIds.map((id) => read(next, 'account.move', id)?.name || `#${id}`).join(', ');
  next = postNote(next, 'account.move', createdMove.id, `Transfer entry created from ${sourceNames}`);
  for (const srcId of sourceMoveIds) {
    next = postNote(next, 'account.move', srcId, `Journal item transferred to ${destAcc.name} via ${createdMove.name}`);
  }
  return next;
}

/**
 * Defer or accrue selected posted income/expense lines to `date` (`action = 'change_period'`).
 * Creates the adjusting entry on each source date and its reversal/recognition entry on `date`,
 * using `percentage` (0 < percentage <= 100) and `accountId` (accrual/deferral account).
 */
export function changePeriod(db, selections, { date = today(), percentage = 100, accountId = null, journalId = null } = {}) {
  const { items, companyId } = resolvePostedSingleCompanyItems(db, selections);
  if (items.some((it) => !isIncomeOrExpenseAccount(it.account))) {
    throw new Error('This wizard is only meant for income and expense accounts.');
  }
  const sides = [...new Set(items.map((it) => accountSide(it.account)))];
  if (sides.length > 1) {
    throw new Error('You cannot mix income and expense accounts when changing the period.');
  }
  const side = sides[0];
  if (!validDate(date)) throw new Error('Enter a valid date');
  const pct = Number(percentage);
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
    throw new Error('Percentage must be greater than 0 and at most 100');
  }
  const company = read(db, 'res.company', companyId);
  const resolvedAccountId = accountId || company?.[side === 'income' ? 'deferred_revenue_account_id' : 'deferred_expense_account_id'];
  if (!resolvedAccountId) throw new Error('Select an accrual account');
  const accrualAcc = resolveCompanyTargetAccount(
    db,
    resolvedAccountId,
    companyId,
    'Select an active accrual account for this company',
    { disallowTypes: ['asset_receivable', 'liability_payable', 'off_balance'] },
  );
  if (isIncomeOrExpenseAccount(accrualAcc)) throw new Error('Select a balance sheet account as the accrual account');
  const journal = resolveGeneralJournal(db, journalId, companyId, side);
  const ownCurrency = companyCurrencyRecord(db, companyId);

  const bySourceDate = new Map();
  for (const it of items) {
    const srcDate = it.moveDate;
    bySourceDate.set(srcDate, [...(bySourceDate.get(srcDate) ?? []), it]);
  }
  const sortedDates = [...bySourceDate.keys()].sort();

  let next = db;
  const createdAdjIds = [];
  const allSourceMoveIds = [];
  const combinedReversalLines = [];

  for (const srcDate of sortedDates) {
    const dateItems = bySourceDate.get(srcDate);
    const lines = [];
    const dateSourceIds = [];
    for (const it of dateItems) {
      const rawBal = (Number(it.line.debit) || 0) - (Number(it.line.credit) || 0);
      const bal = roundCurrency(rawBal * (pct / 100), ownCurrency);
      const isForeign = Boolean(it.line.currency_id && ownCurrency && it.line.currency_id !== ownCurrency.id);
      const fCurr = isForeign ? read(next, 'res.currency', it.line.currency_id) : null;
      const foreignAmt = isForeign ? roundCurrency((Number(it.line.amount_currency) || 0) * (pct / 100), fCurr) : 0;
      if (isCurrencyZero(bal, ownCurrency) && (!isForeign || isCurrencyZero(foreignAmt, fCurr))) continue;

      if (!dateSourceIds.includes(it.move.id)) dateSourceIds.push(it.move.id);
      if (!allSourceMoveIds.includes(it.move.id)) allSourceMoveIds.push(it.move.id);

      const lineLabel = it.line.name || it.account.name;
      lines.push({
        account_id: it.line.account_id,
        partner_id: it.line.partner_id ?? null,
        name: lineLabel,
        debit: bal < 0 ? -bal : 0,
        credit: bal > 0 ? bal : 0,
        analytic_distribution: it.line.analytic_distribution ?? null,
        ...(isForeign ? { currency_id: it.line.currency_id, amount_currency: -foreignAmt } : {}),
      });
      lines.push({
        account_id: accrualAcc.id,
        partner_id: it.line.partner_id ?? null,
        name: accrualAcc.name,
        debit: bal > 0 ? bal : 0,
        credit: bal < 0 ? -bal : 0,
        analytic_distribution: null,
        ...(isForeign ? { currency_id: it.line.currency_id, amount_currency: foreignAmt } : {}),
      });
    }
    if (!lines.length) continue;

    const adj = postEntry(next, {
      journal_id: journal.id,
      company: companyId,
      date: srcDate,
      ref: `Period adjustment to ${date} (${pct}%)`,
      lines,
      automatic_entry_source_move_ids: dateSourceIds,
      archivedOriginIds: dateSourceIds,
    });
    next = adj.db;
    createdAdjIds.push(adj.id);
    const adjMove = read(next, 'account.move', adj.id);
    for (const line of adjMove.line_ids) {
      combinedReversalLines.push({
        ...reversalLine(line),
        name: line.name,
        analytic_distribution: line.analytic_distribution ?? null,
      });
    }
  }

  if (!createdAdjIds.length) {
    throw new Error('Selected items have zero balance');
  }

  const singleOriginId = createdAdjIds.length === 1 ? createdAdjIds[0] : null;
  const recognition = postEntry(next, {
    journal_id: journal.id,
    company: companyId,
    date,
    ref: `Period recognition (${pct}%)`,
    lines: combinedReversalLines,
    automatic_entry_source_move_ids: allSourceMoveIds,
    archivedOriginIds: allSourceMoveIds,
    ...(singleOriginId ? { reversed_entry_id: singleOriginId } : {}),
  });
  next = recognition.db;
  if (singleOriginId) {
    next = write(next, 'account.move', singleOriginId, { reversal_move_id: recognition.id });
  }

  const recMove = read(next, 'account.move', recognition.id);
  if (isReconcilableAccount(accrualAcc)) {
    const reconcileSelections = [];
    for (const adjId of createdAdjIds) {
      const m = read(next, 'account.move', adjId);
      m.line_ids.forEach((l, idx) => {
        if (l.account_id === accrualAcc.id) {
          reconcileSelections.push({ move_id: m.id, line_index: idx, line_identity: journalItemIdentity(l) });
        }
      });
    }
    recMove.line_ids.forEach((l, idx) => {
      if (l.account_id === accrualAcc.id) {
        reconcileSelections.push({ move_id: recMove.id, line_index: idx, line_identity: journalItemIdentity(l) });
      }
    });
    if (reconcileSelections.length >= 2) {
      const recDate = [date, ...sortedDates].sort().at(-1);
      next = reconcileLedgerItems(next, reconcileSelections, { date: recDate });
    }
  }

  const sourceNames = allSourceMoveIds.map((id) => read(next, 'account.move', id)?.name || `#${id}`).join(', ');
  for (const adjId of createdAdjIds) {
    next = postNote(next, 'account.move', adjId, `Period deferral entry for ${sourceNames} (${pct}% -> ${date})`);
  }
  next = postNote(next, 'account.move', recMove.id, `Period recognition entry for ${sourceNames} (${pct}% on ${date})`);
  const adjNames = createdAdjIds.map((id) => read(next, 'account.move', id)?.name || `#${id}`).join(', ');
  for (const srcId of allSourceMoveIds) {
    next = postNote(next, 'account.move', srcId, `Period changed to ${date} (${pct}%) via ${adjNames}, ${recMove.name}`);
  }
  return next;
}
