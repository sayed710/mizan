import { findCompanyCurrencyRecord, round } from '../money.js';
import { read } from '../orm.js';
import { isInvoice } from './accounting.js';
import { taxGridLineContributions } from './finance.js';
import { draftInvoiceLines, resolveDocumentJournal } from './ledger.js';
import { isNonZeroBaseGridLine } from './taxes.js';

const INCOMPLETE_DRAFT_POSTING_PATTERNS = [
  /^Configure (the |a valid )/,
  /^No (customer invoice|vendor bill|general) journal\b/,
  /^No .* (account found|exchange rate|rate on or before)\b/,
  /^No valid account for the invoice company$/,
  /^Journal .* has no default account configured/,
  /^Configured .* account does not exist/,
  /^Deferred account must belong to the document company$/,
  /^Set valid deferred start and end dates$/,
  /^Select an existing (currency|account currency)/,
  /^Selected (journal|tax) does not exist$/,
  /^(Tax|The .* account on .*|The cash basis tax|The cash rounding method) belongs to another company/,
  /^Invoice must have one receivable or payable account$/,
  /^Division tax rate cannot be 100%$/,
  /^Invalid cash rounding$/,
];

/** Whether an error from dynamic draft-invoice resolution reflects expected incomplete posting configuration. */
export function isIncompleteDraftPostingError(error) {
  return error instanceof Error
    && error.constructor === Error
    && INCOMPLETE_DRAFT_POSTING_PATTERNS.some((pattern) => pattern.test(error.message));
}

/** Collect payment entry IDs and their explicitly linked transfer, reversal, discount, and FX moves. */
function paymentRelatedMoveIds(db) {
  const ids = new Set();
  for (const payment of db.records['account.payment'] ?? []) {
    if (payment.move_id) ids.add(payment.move_id);
    if (payment.destination_move_id) ids.add(payment.destination_move_id);
  }
  const moves = db.records['account.move'] ?? [];
  const partials = db.records['account.partial.reconcile'] ?? [];
  let changed = true;
  while (changed) {
    changed = false;
    const add = (id) => {
      if (id && !ids.has(id)) {
        ids.add(id);
        changed = true;
      }
    };
    for (const move of moves) {
      if (ids.has(move.id) && move.reversal_move_id) add(move.reversal_move_id);
      if (move.reversed_entry_id && ids.has(move.reversed_entry_id)) add(move.id);
      if (move.fx_payment_move_id && ids.has(move.fx_payment_move_id)) add(move.id);
      for (const row of move.payments ?? []) {
        if (ids.has(row.move_id) || ids.has(row.payment_move_id)) {
          add(row.move_id);
          add(row.payment_fx_move_id);
          add(row.reversal_move_id);
        }
      }
    }
    for (const partial of partials) {
      if (partial?.exchange_move_id && (ids.has(partial.debit_move_id) || ids.has(partial.credit_move_id))) {
        add(partial.exchange_move_id);
      }
    }
  }
  return ids;
}

/** Derive report journal lines for a move without mutating stored records. */
function reportMoveLines(db, move) {
  try {
    return { line_ids: draftInvoiceLines(db, move, { name: move.name || '/' }), incomplete: false, error: null };
  } catch (error) {
    if (move.state === 'draft' && isIncompleteDraftPostingError(error)) {
      return { line_ids: [], incomplete: true, error: error.message };
    }
    throw error;
  }
}

/** Resolve a move's journal for Journal Audit, treating expected missing draft journal config explicitly. */
function resolveAuditJournal(db, journals, move) {
  const direct = journals.get(move.journal_id);
  if (direct) return direct;
  if (!isInvoice(move)) return null;
  try {
    return resolveDocumentJournal(db, move);
  } catch (error) {
    if (move.state === 'draft' && isIncompleteDraftPostingError(error)) return null;
    throw error;
  }
}

/** Journal items and signed tax totals in the requested period and company, ordered by date or by entry number. */
export function journalAudit(db, { from = '', to = '', companyId = null, ledgerCompanyId = null, journalIds = null, sort = 'date', includeDraft = false, includePayments = true } = {}) {
  const groups = new Map();
  const journals = new Map((db.records['account.journal'] ?? []).map((j) => [j.id, j]));
  const moves = new Map((db.records['account.move'] ?? []).map((m) => [m.id, m]));
  const returns = new Map((db.records?.['account.return'] ?? []).map((r) => [r.id, r]));
  const taxSettlementMoves = new Set((db.records?.['account.payment'] ?? []).filter((p) => p.is_tax_payment || p.return_id).map((p) => p.move_id).filter(Boolean));
  const byNumber = (a, b) => (a.move.name ?? '').localeCompare(b.move.name ?? '', undefined, { numeric: true });
  const byDate = (a, b) => a.date.localeCompare(b.date);
  const compareItems = (a, b) => (sort === 'number' ? byNumber(a, b) || byDate(a, b) : byDate(a, b) || (a.move.name ?? '').localeCompare(b.move.name ?? '')) || (a.move.id ?? 0) - (b.move.id ?? 0);
  const paymentMoves = includePayments ? null : paymentRelatedMoveIds(db);
  const targetJournals = Array.isArray(journalIds) && journalIds.length ? new Set(journalIds.map(Number)) : null;
  const eligible = [];
  const journalCurrencies = new Map();
  for (const move of db.records['account.move'] ?? []) {
    const date = move.date ?? move.invoice_date ?? '';
    if (!(move.state === 'posted' || (includeDraft && move.state === 'draft')) || (paymentMoves && paymentMoves.has(move.id)) || (from && date < from) || (to && date > to) || (companyId && (move.company_id ?? 1) !== companyId) || (ledgerCompanyId != null && (move.company_id ?? 1) !== ledgerCompanyId)) continue;
    const journal = resolveAuditJournal(db, journals, move);
    if (!journal || (targetJournals && !targetJournals.has(journal.id))) continue;
    const moveCompanyId = move.company_id ?? journal.company_id ?? 1;
    const currencyId = findCompanyCurrencyRecord(db, moveCompanyId)?.id ?? null;
    let curSet = journalCurrencies.get(journal.id);
    if (!curSet) { curSet = new Set(); journalCurrencies.set(journal.id, curSet); }
    curSet.add(currencyId);
    eligible.push({ move, date, journal, moveCompanyId });
  }
  const splitJournals = new Set([...journalCurrencies.entries()].filter(([, set]) => set.size > 1).map(([id]) => id));
  const journalOrder = new Map();
  for (const { move, date, journal, moveCompanyId } of eligible) {
    if (!journalOrder.has(journal.id)) journalOrder.set(journal.id, journalOrder.size);
    const isSplit = splitJournals.has(journal.id);
    const groupKey = isSplit ? `${journal.id}:${moveCompanyId}` : String(journal.id);
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        journal,
        splitCompanyId: isSplit ? moveCompanyId : null,
        items: [],
        incompleteMoves: [],
        incomplete: false,
        count: 0,
        to_review: 0,
        debit: 0,
        credit: 0,
        taxes: new Map(),
        grids: new Map(),
        byCompany: new Map(),
      };
      groups.set(groupKey, group);
    }
    const compTotal = group.byCompany.get(moveCompanyId) ?? { company_id: moveCompanyId, count: 0, to_review: 0, debit: 0, credit: 0, incomplete: false };
    group.count += 1;
    compTotal.count += 1;
    if (move.to_check) {
      group.to_review += 1;
      compTotal.to_review += 1;
    }
    const { line_ids: moveLines, incomplete, error: incompleteError } = reportMoveLines(db, move);
    if (incomplete) {
      group.incomplete = true;
      compTotal.incomplete = true;
      group.incompleteMoves.push({ move, date, error: incompleteError });
      group.byCompany.set(moveCompanyId, compTotal);
      continue;
    }
    const isTaxClosing = !!move.tax_return_id && (returns.get(move.tax_return_id)?.closing_move_ids ?? []).includes(move.id);
    const isTaxSettlement = taxSettlementMoves.has(move.id) || (!!move.is_tax_payment && !!move.tax_return_id);
    for (const line of moveLines) {
      const debit = Number(line.debit) || 0, credit = Number(line.credit) || 0;
      group.debit = round(group.debit + debit); group.credit = round(group.credit + credit);
      compTotal.debit = round(compTotal.debit + debit); compTotal.credit = round(compTotal.credit + credit);
      group.items.push({ move, line, date });
      const lineWithFlags = {
        ...line,
        is_closing: Boolean(line.is_closing || move.is_closing),
        is_tax_closing: Boolean(line.is_tax_closing || isTaxClosing),
        is_tax_payment: Boolean(line.is_tax_payment || isTaxSettlement),
      };
      for (const { id, name, base, tax } of taxGridLineContributions(db, moves, move, lineWithFlags)) {
        const grid = group.grids.get(id) ?? { id, name, amount: 0 };
        grid.amount = round(grid.amount + base + tax);
        group.grids.set(id, grid);
      }
      if (line.tax_name && !isNonZeroBaseGridLine(line)) {
        const side = line.tax_side || (String(move.move_type).startsWith('in_') ? 'purchase' : 'sale');
        const amount = line.tax_zero ? 0 : side === 'purchase' ? debit - credit : credit - debit;
        const taxId = line.tax_id ?? null;
        const taxKey = taxId == null ? JSON.stringify([null, line.tax_name]) : JSON.stringify([taxId]);
        const tax = group.taxes.get(taxKey) ?? { tax_id: taxId, name: line.tax_name, base: 0, tax: 0 };
        tax.base = round(tax.base + (amount < 0 ? -1 : 1) * (Number(line.tax_base) || 0));
        tax.tax = round(tax.tax + amount);
        group.taxes.set(taxKey, tax);
      }
    }
    group.byCompany.set(moveCompanyId, compTotal);
  }
  return [...groups.values()]
    .sort((a, b) => (journalOrder.get(a.journal.id) - journalOrder.get(b.journal.id)) || ((a.splitCompanyId ?? 0) - (b.splitCompanyId ?? 0)))
    .map(({ byCompany, splitCompanyId, incompleteMoves, incomplete, ...g }) => {
      const result = {
        ...g,
        debit: incomplete ? null : g.debit,
        credit: incomplete ? null : g.credit,
        balance: incomplete ? null : round(g.debit - g.credit),
        items: g.items.sort(compareItems),
        grids: [...g.grids.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id),
        taxes: [...g.taxes.values()].sort((a, b) => a.name.localeCompare(b.name) || (a.tax_id ?? 0) - (b.tax_id ?? 0)).map(({ tax_id, ...row }) => {
          Object.defineProperty(row, 'tax_id', { value: tax_id });
          return row;
        }),
      };
      const companyTotals = [...byCompany.values()].map((ct) => ({
        ...ct,
        debit: ct.incomplete ? null : ct.debit,
        credit: ct.incomplete ? null : ct.credit,
        balance: ct.incomplete ? null : round(ct.debit - ct.credit),
      }));
      Object.defineProperty(result, 'company_totals', { value: companyTotals });
      Object.defineProperty(result, 'incomplete', { value: Boolean(incomplete) });
      Object.defineProperty(result, 'incomplete_moves', { value: [...incompleteMoves].sort(compareItems) });
      if (splitCompanyId != null) Object.defineProperty(result, 'split_company_id', { value: splitCompanyId });
      return result;
    });
}

/** Aggregate per-company/currency totals and combined document counts across journal audit groups. */
export function journalAuditTotals(db, groups) {
  const byCompany = new Map();
  const totals = { count: 0, to_review: 0, debit: 0, credit: 0, balance: 0, incomplete: false };
  for (const group of groups) {
    totals.count += group.count;
    totals.to_review += group.to_review;
    if (group.incomplete || group.debit == null || group.credit == null) {
      totals.incomplete = true;
    } else if (!totals.incomplete) {
      totals.debit = round(totals.debit + group.debit);
      totals.credit = round(totals.credit + group.credit);
    }
    const entries = group.company_totals ?? [{
      company_id: group.split_company_id ?? group.journal?.company_id ?? group.items?.[0]?.move?.company_id ?? 1,
      count: group.count,
      to_review: group.to_review,
      debit: group.debit,
      credit: group.credit,
      incomplete: Boolean(group.incomplete),
    }];
    for (const entry of entries) {
      const cid = entry.company_id ?? 1;
      const cur = byCompany.get(cid) ?? {
        company_id: cid,
        company: read(db, 'res.company', cid),
        currency: findCompanyCurrencyRecord(db, cid),
        count: 0,
        to_review: 0,
        debit: 0,
        credit: 0,
        incomplete: false,
      };
      cur.count += entry.count;
      cur.to_review += entry.to_review;
      if (entry.incomplete || entry.debit == null || entry.credit == null) {
        cur.incomplete = true;
      } else if (!cur.incomplete) {
        cur.debit = round(cur.debit + entry.debit);
        cur.credit = round(cur.credit + entry.credit);
      }
      byCompany.set(cid, cur);
    }
  }
  if (totals.incomplete) {
    totals.debit = null;
    totals.credit = null;
    totals.balance = null;
  } else {
    totals.balance = round(totals.debit - totals.credit);
  }
  const companyTotals = [...byCompany.values()]
    .map((ct) => (ct.incomplete
      ? { ...ct, debit: null, credit: null, balance: null }
      : { ...ct, balance: round(ct.debit - ct.credit) }))
    .sort((a, b) => a.company_id - b.company_id);
  const currencyIds = new Set(companyTotals.map((ct) => ct.currency?.id ?? null));
  const multipleCurrencies = currencyIds.size > 1;
  const representedCompanyId = !multipleCurrencies && companyTotals.length > 0 ? companyTotals[0].company_id : null;
  const singleCurrency = !multipleCurrencies && companyTotals.length > 0 ? companyTotals[0].currency : null;
  return { totals, companyTotals, multipleCurrencies, representedCompanyId, singleCurrency };
}
