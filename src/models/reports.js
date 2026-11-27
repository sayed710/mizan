// Pure accounting reports over the posted journal: trial balance, partner ledgers, cash flow, executive KPIs, customer statements.
import { read, search } from '../orm.js';
import { companyCurrencyRecord, round, roundCurrency } from '../money.js';
import { deferredSettings, lineCreditAdjustmentAmount, recognitionTargetThroughDate, scheduleAsOf } from './deferred.js';
import { ACCOUNT_TYPES, balances, balanceSheet, analyticMoveItems, filterByAnalytic, fiscalYearStart, isLiquidityAccount, isLiquidityJournal, journalItems, profitAndLoss, weighted } from './ledger.js';
import { appliedValue } from './finance.js';
import { toCompany } from './currency.js';
import { applicationEffectiveDate } from './settlement.js';
import { currentCompany } from './company.js';
import { reportingBookedAmount } from './money.js';
import { configuredEarningsAccount } from './earnings.js';
import { includeInitialBalance } from './accounting.js';

export const reportAmountsVisible = (values, hideZeroLines = false) => !hideZeroLines || values.some((value) => value != null && Number(value) !== 0);

const netOf = (l) => (Number(l.debit) || 0) - (Number(l.credit) || 0);

/**
 * Canonical review mode resolution for financial statements.
 * An explicit reviewMode wins, otherwise includeUnposted gives 'all',
 * otherwise the period's reviewMode, otherwise 'posted'.
 */
export function reportReviewMode(periodOrOptions, maybeOptions) {
  const options = maybeOptions ?? (periodOrOptions && typeof periodOrOptions === 'object' ? periodOrOptions : {});
  const period = maybeOptions ? (periodOrOptions && typeof periodOrOptions === 'object' ? periodOrOptions : {}) : options;
  return options?.reviewMode ?? (options?.includeUnposted ? 'all' : period?.reviewMode ?? 'posted');
}
const accountIds = (db, type) => new Set(search(db, 'account.account', { includeArchived: true }).filter((a) => a.account_type === type).map((a) => a.id));
/** Invoice counterpart lines used to classify cash flows, retaining their analytic allocation shares. */
function cashFlowDocumentSources(db, document) {
  return (document.line_ids ?? []).map((line) => ({ line, account: read(db, 'account.account', line.account_id) }))
    .filter((source) => source.account && !['asset_receivable', 'liability_payable', 'asset_cash'].includes(source.account.account_type));
}

const cashFlowSourceTotal = (sources) => sources.reduce((sum, source) => sum + netOf(source.line), 0);
const cashFlowSelectedSources = (sources, analyticAccountIds) => !analyticAccountIds?.length
  ? sources?.all ?? []
  : sources?.selected ?? [];

/** Journal items dated strictly before `from` (none without a `from`): the opening column of every report. */
const itemsBefore = (db, from, company_id, analyticAccountIds, reviewMode = 'posted') => (from ? filterByAnalytic(journalItems(db, { company_id, reviewMode }), analyticAccountIds).filter((l) => l.date < from) : []);

/** Accounts without include_initial_balance restart at their company's fiscal-year start; earlier results open on its earnings account (Odoo's undistributed profits), so the opening column stays balanced. */
export function trialOpeningItems(db, items, from) {
  return items.map((line) => {
    if (includeInitialBalance(read(db, 'account.account', line.account_id)) || line.date >= fiscalYearStart(db, from, line.company_id)) return line;
    const earnings = configuredEarningsAccount(db, line.company_id);
    return earnings ? { ...line, account_id: earnings.id } : line;
  });
}

/** Resolve the stored group derived from the account code. */
export function resolveAccountGroup(db, account) {
  return account?.group_id ? read(db, 'account.group', account.group_id) ?? null : null;
}

const ACCOUNT_TYPE_LABELS = new Map(ACCOUNT_TYPES);
const ACCOUNT_TYPE_ORDER = new Map(ACCOUNT_TYPES.map(([code], idx) => [code, idx]));

/** Group trial balance accounts across one or more period reports by 'account_type' or 'account_group' hierarchy. */
export function groupTrialBalanceRows(db, accounts, rowsByReport, keys, groupBy) {
  if (!groupBy) return [];
  const sumPeriodValues = (accountList) => rowsByReport.map((byAccount) => Object.fromEntries(
    keys.map((key) => [key, round(accountList.reduce((sum, acc) => sum + (byAccount.get(acc.id)?.[key] ?? 0), 0))]),
  ));

  if (groupBy === 'account_type') {
    const grouped = new Map();
    for (const acc of accounts) {
      const type = acc.account_type || 'undefined';
      if (!grouped.has(type)) grouped.set(type, []);
      grouped.get(type).push(acc);
    }
    return [...grouped.entries()]
      .sort(([a], [b]) => (ACCOUNT_TYPE_ORDER.get(a) ?? 999) - (ACCOUNT_TYPE_ORDER.get(b) ?? 999) || String(a).localeCompare(String(b)))
      .map(([type, items]) => ({
        key: `type:${type}`,
        id: type,
        name: ACCOUNT_TYPE_LABELS.get(type) ?? 'Undefined',
        depth: 0,
        accounts: items,
        periodTotals: sumPeriodValues(items),
      }));
  }

  if (groupBy === 'account_group') {
    const directAccounts = new Map();
    const ungrouped = [];
    const neededGroupIds = new Set();
    for (const acc of accounts) {
      const group = resolveAccountGroup(db, acc);
      if (!group) {
        ungrouped.push(acc);
        continue;
      }
      if (!directAccounts.has(group.id)) directAccounts.set(group.id, []);
      directAccounts.get(group.id).push(acc);
      const seen = new Set();
      let cur = group;
      while (cur && !seen.has(cur.id)) {
        seen.add(cur.id);
        neededGroupIds.add(cur.id);
        cur = cur.parent_id ? read(db, 'account.group', cur.parent_id) : null;
      }
    }
    const childrenByParent = new Map();
    for (const id of neededGroupIds) {
      const g = read(db, 'account.group', id);
      const parentId = g?.parent_id && neededGroupIds.has(g.parent_id) ? g.parent_id : null;
      if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
      childrenByParent.get(parentId).push(g);
    }
    for (const list of childrenByParent.values()) {
      list.sort((a, b) => String(a.code_prefix_start ?? '').localeCompare(String(b.code_prefix_start ?? '')) || String(a.name ?? '').localeCompare(String(b.name ?? '')) || a.id - b.id);
    }
    const collectSubtreeAccounts = (groupId, visited = new Set()) => {
      if (visited.has(groupId)) return [];
      visited.add(groupId);
      const own = directAccounts.get(groupId) ?? [];
      const childAccs = (childrenByParent.get(groupId) ?? []).flatMap((child) => collectSubtreeAccounts(child.id, visited));
      return [...own, ...childAccs];
    };
    const out = [];
    const walk = (parentId, depth, visited = new Set(), ancestors = []) => {
      for (const group of childrenByParent.get(parentId) ?? []) {
        if (visited.has(group.id)) continue;
        visited.add(group.id);
        const subtreeAccounts = collectSubtreeAccounts(group.id);
        out.push({
          key: `group:${group.id}`,
          id: group.id,
          name: group.code_prefix_start ? `${group.code_prefix_start} ${group.name}` : group.name,
          depth,
          ancestors,
          hasChildren: (childrenByParent.get(group.id) ?? []).length > 0,
          accounts: directAccounts.get(group.id) ?? [],
          periodTotals: sumPeriodValues(subtreeAccounts),
        });
        walk(group.id, depth + 1, visited, [...ancestors, `group:${group.id}`]);
      }
    };
    walk(null, 0);
    if (ungrouped.length) {
      out.push({
        key: 'group:none',
        id: null,
        name: 'Undefined',
        depth: 0,
        accounts: ungrouped,
        periodTotals: sumPeriodValues(ungrouped),
      });
    }
    return out;
  }

  return [];
}

/** Trial balance: opening balance per account, movement inside the period, ending balance; rows sorted by code, all-zero rows omitted. */
export function trialBalance(db, { from, to, company_id, analyticAccountIds, includeUnposted, reviewMode, includeClosing = false, includeZeroRows = false, groupBy = '' } = {}) {
  const mode = reportReviewMode({ reviewMode, includeUnposted });
  const opening = new Map(balances(db, trialOpeningItems(db, itemsBefore(db, from, company_id, analyticAccountIds, mode), from)).map((b) => [b.account.id, b.balance]));
  const rows = new Map();
  const row = (id) => {
    if (!rows.has(id)) rows.set(id, { account: read(db, 'account.account', id), initial: round(opening.get(id) ?? 0), debit: 0, credit: 0 });
    return rows.get(id);
  };
  for (const id of opening.keys()) row(id);
  for (const l of filterByAnalytic(journalItems(db, { from, to, company_id, reviewMode: mode, includeClosing }), analyticAccountIds)) {
    const r = row(l.account_id);
    r.debit += reportingBookedAmount(db, l, l.debit);
    r.credit += reportingBookedAmount(db, l, l.credit);
  }
  const list = [...rows.values()]
    .filter((r) => r.account)
    .map((r) => ({ account: r.account, initial: r.initial, debit: round(r.debit), credit: round(r.credit), end: round(r.initial + r.debit - r.credit) }))
    .filter((r) => includeZeroRows || reportAmountsVisible([r.initial, r.debit, r.credit, r.end], true))
    .sort((a, b) => a.account.code.localeCompare(b.account.code));
  const total = (key) => round(list.reduce((s, r) => s + r[key], 0));
  const totals = { initial: total('initial'), debit: total('debit'), credit: total('credit'), end: total('end') };
  if (groupBy) {
    const byAcc = new Map(list.map((r) => [r.account.id, r]));
    const groups = groupTrialBalanceRows(db, list.map((r) => r.account), [byAcc], ['initial', 'debit', 'credit', 'end'], groupBy);
    return { rows: list, totals, groups };
  }
  return { rows: list, totals };
}

/** General ledger: accounts with opening balance, movements inside the period, and ending balance, optionally grouped by partner. */
export function generalLedger(db, { from, to, company_id, analyticAccountIds, includeUnposted, reviewMode, groupByPartner = false, hideZeroLines = false } = {}) {
  const mode = reportReviewMode({ reviewMode, includeUnposted });
  const items = filterByAnalytic(journalItems(db, { from, to, company_id, reviewMode: mode, includeClosing: false }), analyticAccountIds);
  const opening = from ? trialOpeningItems(db, filterByAnalytic(journalItems(db, { to: from, company_id, reviewMode: mode }), analyticAccountIds).filter((l) => l.date < from), from) : [];

  // Convert each item to the reporting currency once, then group by key in a single pass (large ledgers stay linear).
  const converted = (ls) => ls.map((l) => ({ ...l, debit: reportingBookedAmount(db, l, Number(l.debit) || 0), credit: reportingBookedAmount(db, l, Number(l.credit) || 0) }));
  const groupBy = (ls, key) => { const map = new Map(); for (const l of ls) { const k = key(l); if (!map.has(k)) map.set(k, []); map.get(k).push(l); } return map; };
  const periodLines = groupBy(converted(items).sort((x, y) => x.date.localeCompare(y.date)), (l) => l.account_id);
  const openingLines = groupBy(converted(opening), (l) => l.account_id);

  /** Opening balance, totals and running balance of one account or one partner within it. */
  const section = (lines, openingOf) => {
    const start = openingOf.reduce((sum, l) => sum + l.debit - l.credit, 0);
    let run = start;
    const withBalance = lines.map((l) => { run += l.debit - l.credit; return { ...l, balance: round(run) }; });
    const debit = lines.reduce((sum, l) => sum + l.debit, 0);
    const credit = lines.reduce((sum, l) => sum + l.credit, 0);
    return { initial: round(start), debit: round(debit), credit: round(credit), end: round(start + debit - credit), lines: withBalance };
  };

  const accounts = [...new Set([...periodLines.keys(), ...openingLines.keys()])]
    .map((id) => read(db, 'account.account', id))
    .filter(Boolean)
    .sort((x, y) => x.code.localeCompare(y.code));

  const rows = accounts.map((account) => {
    const accLines = periodLines.get(account.id) ?? [];
    const accOpening = openingLines.get(account.id) ?? [];
    let partners = [];
    if (groupByPartner) {
      const partnerOf = (l) => l.partner_id ?? null;
      const byPartner = groupBy(accLines, partnerOf);
      const openingByPartner = groupBy(accOpening, partnerOf);
      partners = [...new Set([...byPartner.keys(), ...openingByPartner.keys()])].map((pId) => {
        const partner = pId ? read(db, 'res.partner', pId) : null;
        return { partner_id: pId, partner, name: partner?.name ?? '', ...section(byPartner.get(pId) ?? [], openingByPartner.get(pId) ?? []) };
      }).filter((p) => p.lines.length || p.initial)
        .sort((x, y) => (!x.partner_id ? 1 : !y.partner_id ? -1 : x.name.localeCompare(y.name)));
    }
    return { account, ...section(accLines, accOpening), partners };
  });

  const visibleRows = rows.filter((row) => reportAmountsVisible([row.initial, row.debit, row.credit, row.end], hideZeroLines)).map((row) => {
    const partnerList = hideZeroLines ? row.partners.filter((partner) => reportAmountsVisible([partner.initial, partner.debit, partner.credit, partner.end], true)) : row.partners;
    return {
      ...row,
      lines: row.lines.filter((line) => reportAmountsVisible([line.debit, line.credit, line.balance], hideZeroLines)),
      partners: partnerList.map((partner) => ({ ...partner, lines: partner.lines.filter((line) => reportAmountsVisible([line.debit, line.credit, line.balance], hideZeroLines)) })),
    };
  });
  return {
    rows: visibleRows,
    totals: {
      initial: round(rows.reduce((sum, r) => sum + r.initial, 0)),
      debit: round(rows.reduce((sum, r) => sum + r.debit, 0)),
      credit: round(rows.reduce((sum, r) => sum + r.credit, 0)),
      end: round(rows.reduce((sum, r) => sum + r.end, 0)),
    },
  };
}

/** Period movements grouped by the explicit fiscal category on each trial-balance account. */
export function fiscalReport(db, { from, to, company_id, analyticAccountIds, includeUnposted, reviewMode } = {}) {
  const trial = trialBalance(db, { from, to, company_id, analyticAccountIds, includeUnposted, reviewMode });
  const categories = search(db, 'account.fiscal.category', { includeArchived: true });
  const groups = new Map(categories.map((category) => [category.id, { category, accounts: [], debit: 0, credit: 0 }]));
  const uncategorized = { category: null, accounts: [], debit: 0, credit: 0 };
  for (const row of trial.rows) {
    if (!row.debit && !row.credit) continue;
    const group = groups.get(row.account.fiscal_category_id) ?? uncategorized;
    group.accounts.push({ account: row.account, debit: row.debit, credit: row.credit, balance: round(row.debit - row.credit) });
    group.debit += row.debit;
    group.credit += row.credit;
  }
  const finish = (group) => ({ ...group, debit: round(group.debit), credit: round(group.credit), balance: round(group.debit - group.credit) });
  const rows = [...groups.values()].sort((a, b) => a.category.name.localeCompare(b.category.name)).map(finish);
  rows.push(finish(uncategorized));
  return { rows, totals: { debit: trial.totals.debit, credit: trial.totals.credit, balance: round(trial.totals.debit - trial.totals.credit) } };
}

/** Aggregate statement-line amounts by month and journal without deriving transactions from the ledger. */
export function cashflowAnalysis(db, { from, to, company_id }) {
  const months = new Map();
  const journals = new Map();
  for (const line of search(db, 'account.bank.statement.line')) {
    if (company_id != null && (line.company_id ?? 1) !== company_id) continue;
    const journal = read(db, 'account.journal', line.journal_id);
    if (!journal || !isLiquidityJournal(journal) || (journal.company_id && journal.company_id !== (line.company_id ?? 1))) continue;
    if (!line.date || line.date < from || line.date > to || !Number.isFinite(Number(line.amount))) continue;
    const month = line.date.slice(0, 7);
    if (!months.has(month)) months.set(month, new Map());
    const amounts = months.get(month);
    const sums = amounts.get(journal.id) ?? { inflow: 0, outflow: 0 };
    const lineCurrency = line.currency_id ?? journal.currency_id;
    const booked = Math.sign(Number(line.amount)) * toCompany(db, lineCurrency, Math.abs(Number(line.amount)), line.date, line.company_id ?? 1);
    const amount = reportingBookedAmount(db, line, booked);
    sums.inflow += Math.max(amount, 0);
    sums.outflow += Math.max(-amount, 0);
    amounts.set(journal.id, sums);
    journals.set(journal.id, journal);
  }
  const finish = ({ inflow, outflow }) => ({ inflow: round(inflow), outflow: round(outflow), net: round(inflow - outflow) });
  const rows = [...months].sort(([a], [b]) => a.localeCompare(b)).map(([month, amounts]) => {
    const totals = [...amounts.values()].reduce((sum, current) => ({ inflow: sum.inflow + current.inflow, outflow: sum.outflow + current.outflow }), { inflow: 0, outflow: 0 });
    return { month, ...finish(totals), journals: new Map([...amounts].map(([id, value]) => [id, finish(value)])) };
  });
  return { rows, journals: [...journals.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id) };
}

/** Receivable or payable ledger per partner: opening balance, the period's lines with a running balance, sorted by partner name. */
export function partnerLedger(db, { from, to, company_id, analyticAccountIds, partnerIds, unreconciledOnly = false, includeUnposted, reviewMode } = {}, kind = 'receivable') {
  const mode = reportReviewMode({ reviewMode, includeUnposted });
  const accounts = accountIds(db, kind === 'payable' ? 'liability_payable' : 'asset_receivable');
  if (kind === 'both') for (const id of accountIds(db, 'liability_payable')) accounts.add(id);
  const partners = partnerIds?.length ? new Set(partnerIds.map(Number)) : null;
  // Odoo's "unreconciled entries only" keeps items with an open residual, in the period and in the opening alike.
  const keep = (l) => accounts.has(l.account_id) && (!partners || partners.has(l.partner_id)) && (!unreconciledOnly || Math.abs(l.amount_residual ?? 0) > 1e-9);
  const rows = new Map();
  const row = (id) => {
    if (!rows.has(id)) rows.set(id, { partner_id: id, initial: 0, debit: 0, credit: 0, lines: [] });
    return rows.get(id);
  };
  for (const l of itemsBefore(db, from, company_id, analyticAccountIds, mode).filter(keep)) {
    const r = row(l.partner_id);
    r.initial += reportingBookedAmount(db, l, netOf(l));
  }
  const items = filterByAnalytic(journalItems(db, { from, to, company_id, reviewMode: mode }), analyticAccountIds)
    .filter(keep)
    .sort((a, b) => a.date.localeCompare(b.date));
  for (const l of items) {
    const r = row(l.partner_id);
    const debit = reportingBookedAmount(db, l, l.debit);
    const credit = reportingBookedAmount(db, l, l.credit);
    r.debit += debit;
    r.credit += credit;
    // Reuse the journal item's derived reconciliation fields; never infer a matching number from labels or amounts.
    const dueDate = l.date_maturity ?? read(db, 'account.move', l.move_id)?.invoice_date_due ?? l.date;
    r.lines.push({
      date: l.date, dueDate, move_id: l.move_id, move_name: l.move_name,
      journal_id: l.journal_id, account_id: l.account_id,
      ...(l.matching_number ? { matchingNumber: l.matching_number } : {}),
      label: l.name ?? '', ...(l.ref ? { ref: l.ref } : {}),
      debit, credit, currency_id: l.currency_id ?? null, amount_currency: l.amount_currency ?? null,
    });
  }
  const name = (id) => read(db, 'res.partner', id)?.name ?? '';
  return [...rows.values()]
    .map((r) => {
      let run = r.initial;
      const lines = r.lines.map((l) => { run += l.debit - l.credit; return { ...l, balance: round(run) }; });
      return { partner_id: r.partner_id, initial: round(r.initial), debit: round(r.debit), credit: round(r.credit), end: round(r.initial + r.debit - r.credit), lines };
    })
    .filter((r) => r.lines.length || r.initial)
    .sort((a, b) => name(a.partner_id).localeCompare(name(b.partner_id)));
}

/** Default cash flow activity for an account from its account type (fixed assets invest, equity and long-term debt finance). */
export function defaultCashFlowActivity(account_type) {
  if (['asset_fixed', 'asset_non_current'].includes(account_type)) return 'investing';
  if (['equity', 'equity_unaffected', 'liability_non_current'].includes(account_type)) return 'financing';
  if (account_type === 'off_balance') return 'unclassified';
  return 'operating';
}

/** Determine the cash flow activity (operating, investing, financing, unclassified) for an account. */
export function accountCashFlowActivity(db, account) {
  if (!account) return 'unclassified';
  if (Array.isArray(account.tag_ids)) {
    const tags = account.tag_ids.map((tag) => typeof tag === 'object' ? tag : read(db, 'account.account.tag', tag));
    const explicit = tags.find((tag) => ['operating', 'investing', 'financing'].includes(tag?.cash_flow_activity));
    if (explicit) return explicit.cash_flow_activity;
  }
  return ['income', 'income_other', 'expense', 'expense_depreciation', 'expense_direct_cost', 'expense_other', 'asset_receivable', 'liability_payable'].includes(account.account_type) ? 'operating' : 'unclassified';
}

/**
 * Direct-method cash flow over the cash accounts: every posted move touching cash attributes its movement to its
 * non-cash counterpart lines (a credit on the counterpart is cash in); tagged accounts route to operating, investing
 * or financing, untagged receivable/payable and income/expense accounts count as operating, and all other untagged
 * accounts go to unclassified.
 */
export function cashFlow(db, { from, to, company_id, analyticAccountIds, includeUnposted, reviewMode, weight } = {}) {
  const targetCompany = company_id;
  const mode = reportReviewMode({ reviewMode, includeUnposted });
  // Journal-filtered report databases keep the unfiltered records for the source documents.
  const documentsDb = db.unfilteredDb ?? db;
  const cash = accountIds(db, 'asset_cash');
  const sum = (items) => round(balances(db, items.filter((l) => cash.has(l.account_id))).reduce((s, b) => s + b.balance, 0));
  const all = weighted(analyticMoveItems(journalItems(db, { company_id: targetCompany, reviewMode: mode }), analyticAccountIds), weight);
  const opening = sum(all.filter((l) => from && l.date < from));
  const closing = sum(all.filter((l) => !to || l.date <= to));
  const totals = { operating: 0, investing: 0, financing: 0, unclassified: 0 };
  const attributed = new Map();
  const byMove = new Map();
  for (const l of weighted(analyticMoveItems(journalItems(db, { from, to, company_id: targetCompany, reviewMode: mode }), analyticAccountIds), weight)) byMove.set(l.move_id, [...(byMove.get(l.move_id) ?? []), l]);
  const documents = search(documentsDb, 'account.move').filter((m) => m.state === 'posted'
    && (!targetCompany || (m.company_id ?? 1) === targetCompany)
    && ['out_invoice', 'in_invoice', 'out_refund', 'in_refund'].includes(m.move_type));
  const documentSources = new Map(documents.map((document) => {
    const allSources = cashFlowDocumentSources(documentsDb, document);
    const selectedLines = analyticAccountIds?.length
      ? analyticMoveItems(document.line_ids ?? [], analyticAccountIds)
      : (document.line_ids ?? []);
    const selectedSources = selectedLines.map((line) => ({ line, account: read(documentsDb, 'account.account', line.account_id) }))
      .filter((source) => source.account && !['asset_receivable', 'liability_payable', 'asset_cash'].includes(source.account.account_type));
    return [document.id, { all: allSources, selected: selectedSources }];
  }));
  const add = (account, amount, source) => {
    amount = reportingBookedAmount(db, source, amount);
    const section = accountCashFlowActivity(db, account);
    totals[section] += amount;
    attributed.set(account.id, (attributed.get(account.id) ?? 0) + amount);
  };
  for (const items of byMove.values()) {
    if (!items.some((l) => cash.has(l.account_id))) continue;
    const consumed = new Map();
    const moveDate = items[0].date;
    for (const l of items.filter((x) => !cash.has(x.account_id))) {
      const account = read(db, 'account.account', l.account_id);
      if (!account) continue;
      const amount = -netOf(l);
      let remaining = amount;
      if (['asset_receivable', 'liability_payable'].includes(account.account_type)) {
        for (const doc of documents.filter((m) => m.partner_id === l.partner_id)) {
          const settlements = (doc.payments ?? []).filter((p) => {
            const effDate = applicationEffectiveDate(p, doc);
            return (p.move_id === l.move_id && effDate <= moveDate) || (p.reversed && p.reversal_move_id === l.move_id && effDate <= moveDate);
          });
          const sourceData = documentSources.get(doc.id);
          const source = cashFlowSelectedSources(sourceData, analyticAccountIds);
          const denominator = cashFlowSourceTotal(source);
          if (!denominator) continue;
          for (const settlement of settlements) {
            const available = Math.max(0, Math.abs(appliedValue(documentsDb, doc, settlement)) - (consumed.get(settlement) ?? 0));
            const portion = Math.min(Math.abs(remaining), available) * Math.sign(amount);
            consumed.set(settlement, (consumed.get(settlement) ?? 0) + Math.abs(portion));
            for (const x of source) add(x.account, portion * netOf(x.line) / denominator, l);
            remaining -= portion;
          }
        }
      }
      if (remaining) add(account, remaining, l);
    }
  }
  // Reclassify realized exchange differences on invoice-linked payments with the cash settlement.
  for (const items of byMove.values()) {
    const moveId = items[0].move_id;
    const original = read(documentsDb, 'account.move', moveId) ?? read(db, 'account.move', moveId);
    const payment = (documentsDb.records['account.payment'] ?? db.records['account.payment'] ?? []).find((p) => p.move_id === moveId || (original?.reversed_entry_id && p.move_id === original.reversed_entry_id));
    if (!payment?.invoice_id) continue;
    const doc = read(documentsDb, 'account.move', payment.invoice_id);
    const settlement = (doc?.payments ?? []).find((p) => p.move_id === payment.move_id);
    if (!settlement) continue;
    const source = cashFlowSelectedSources(documentSources.get(doc.id), analyticAccountIds);
    const denominator = cashFlowSourceTotal(source);
    const fullDenominator = cashFlowSourceTotal(documentSources.get(doc.id)?.all ?? []);
    const cashNet = items.filter((l) => cash.has(l.account_id)).reduce((sum, l) => sum + netOf(l), 0);
    if (!denominator || !fullDenominator || !cashNet) continue;
    const share = analyticAccountIds?.length ? denominator / fullDenominator : 1;
    const delta = round((toCompany(documentsDb, doc.currency_id, settlement.amount, settlement.date, doc.company_id) - appliedValue(documentsDb, doc, settlement)) * Math.sign(cashNet) * share);
    if (!delta) continue;
    const counterpartAccounts = new Set((doc.line_ids ?? []).filter((line) => ['asset_receivable', 'liability_payable'].includes(read(documentsDb, 'account.account', line.account_id)?.account_type)).map((line) => line.account_id));
    const fxItems = items.filter((line) => !cash.has(line.account_id) && !counterpartAccounts.has(line.account_id)).map((line) => ({ line, account: read(documentsDb, 'account.account', line.account_id) }));
    // The exchange difference is the payment entry's single line that is neither cash nor the invoice counterpart; otherwise it stays unattributed.
    if (fxItems.length !== 1 || !fxItems[0].account) continue;
    const fxAmount = fxItems.reduce((sum, x) => sum - netOf(x.line), 0);
    if (!fxAmount) continue;
    for (const x of fxItems) add(x.account, delta * netOf(x.line) / fxAmount, items[0]);
    for (const x of source) add(x.account, delta * netOf(x.line) / denominator, items[0]);
  }
  // Applying an earlier advance reclassifies the cash already received, without changing net cash.
  for (const doc of documents) for (const payment of doc.payments ?? []) {
    const entry = read(db, 'account.move', payment.move_id);
    const effDate = applicationEffectiveDate(payment, doc);
    if (!entry || entry.state !== 'posted' || !effDate || effDate <= entry.invoice_date || (from && effDate < from) || (to && effDate > to)) continue;
    const reversal = payment.reversal_move_id && read(db, 'account.move', payment.reversal_move_id);
    if (reversal?.state === 'posted' && effDate > reversal.invoice_date) continue;
    if (!(entry.line_ids ?? []).some((l) => cash.has(l.account_id))) continue;
    const counterpart = (entry.line_ids ?? []).map((line) => ({ line, account: read(db, 'account.account', line.account_id) }))
      .find((x) => x.line.partner_id === doc.partner_id && ['asset_receivable', 'liability_payable'].includes(x.account?.account_type));
    const sourceData = documentSources.get(doc.id);
    const source = cashFlowSelectedSources(sourceData, analyticAccountIds);
    const denominator = cashFlowSourceTotal(source);
    const fullDenominator = cashFlowSourceTotal(sourceData.all);
    if (!counterpart || !denominator || !fullDenominator) continue;
    const share = analyticAccountIds?.length ? denominator / fullDenominator : 1;
    if (!share) continue;
    const counterpartItem = {
      ...counterpart.line,
      move_id: entry.id,
      journal_id: entry.journal_id,
      company_id: entry.company_id ?? 1,
      date: entry.date ?? entry.invoice_date,
    };
    const entryWeight = weight ? weight(counterpartItem) : 1;
    if (!entryWeight) continue;
    const amount = Math.sign(-netOf(counterpart.line)) * Math.abs(appliedValue(db, doc, payment)) * share * entryWeight;
    const attribution = { company_id: entry.company_id, date: effDate };
    add(counterpart.account, -amount, attribution);
    for (const x of source) add(x.account, amount * netOf(x.line) / denominator, attribution);
  }
  const ORDER = ['operating', 'investing', 'financing', 'unclassified'];
  const lines = [...attributed]
    .map(([id, amount]) => {
      const account = read(db, 'account.account', id);
      return { section: accountCashFlowActivity(db, account), account, amount: round(amount) };
    })
    .filter((l) => l.account && Math.abs(l.amount) > 1e-6)
    .sort((a, b) => ORDER.indexOf(a.section) - ORDER.indexOf(b.section) || a.account.code.localeCompare(b.account.code));
  return {
    opening, closing, net: round(closing - opening),
    operating: round(totals.operating), investing: round(totals.investing), financing: round(totals.financing), unclassified: round(totals.unclassified),
    lines,
  };
}

/** Canonical Odoo 20 Executive Summary sections and row metadata shared by single-period and comparison views. */
export const EXECUTIVE_SUMMARY_SECTIONS = [
  {
    key: 'cash',
    title: 'Cash',
    rows: [
      { key: 'cashReceived', label: 'Cash received', format: 'money' },
      { key: 'cashSpent', label: 'Cash spent', format: 'money' },
      { key: 'cashSurplus', label: 'Cash surplus', format: 'money', strong: true },
      { key: 'closingBankBalance', label: 'Closing bank balance', format: 'money', strong: true },
    ],
  },
  {
    key: 'profitability',
    title: 'Profitability',
    rows: [
      { key: 'revenue', label: 'Revenue', format: 'money' },
      { key: 'costOfRevenue', label: 'Cost of Revenue', format: 'money' },
      { key: 'grossProfit', label: 'Gross profit', format: 'money', strong: true },
      { key: 'expenses', label: 'Expenses', format: 'money' },
      { key: 'netProfit', label: 'Net Profit', format: 'money', strong: true },
    ],
  },
  {
    key: 'balanceSheet',
    title: 'Balance Sheet',
    rows: [
      { key: 'receivables', label: 'Receivables', format: 'money' },
      { key: 'payables', label: 'Payables', format: 'money' },
      { key: 'netAssets', label: 'Net assets', format: 'money', strong: true },
    ],
  },
  {
    key: 'performance',
    title: 'Performance',
    rows: [
      { key: 'grossProfitMargin', label: 'Gross profit margin (gross profit / operating income)', format: 'pct' },
      { key: 'netProfitMargin', label: 'Net profit margin (net profit / revenue)', format: 'pct' },
      { key: 'returnOnInvestments', label: 'Return on investments (net profit / assets)', format: 'pct' },
    ],
  },
  {
    key: 'position',
    title: 'Position',
    rows: [
      { key: 'averageDebtorsDays', label: 'Average debtors days', format: 'ratio' },
      { key: 'averageCreditorsDays', label: 'Average creditors days', format: 'ratio' },
      { key: 'shortTermCashForecast', label: 'Short term cash forecast', format: 'money' },
      { key: 'currentAssetsToLiabilities', label: 'Current assets to liabilities', format: 'ratio' },
    ],
  },
];

/**
 * Odoo 20 Executive Summary: Cash, Profitability, Balance Sheet, Performance, and Position.
 * Period-scoped flows cover `from`..`to`; balance-sheet positions accumulate to `to`.
 */
export function executiveSummary(db, { from, to, company_id, analyticAccountIds, includeUnposted, reviewMode } = {}) {
  const mode = reportReviewMode({ reviewMode, includeUnposted });
  const pl = profitAndLoss(db, { from, to, company_id, reviewMode: mode }, { analyticAccountIds });
  const bs = balanceSheet(db, { to, company_id, reviewMode: mode }, { analyticAccountIds });
  const cashAccounts = new Set(
    search(db, 'account.account', { includeArchived: true })
      .filter((a) => isLiquidityAccount(a))
      .map((a) => a.id),
  );
  const cashPeriodItems = analyticMoveItems(
    journalItems(db, { from, to, company_id, reviewMode: mode }),
    analyticAccountIds,
  ).filter((l) => cashAccounts.has(l.account_id));
  const cashReceived = round(
    cashPeriodItems
      .filter((l) => (Number(l.debit) || 0) > 0)
      .reduce((s, l) => s + reportingBookedAmount(db, l, netOf(l)), 0),
  );
  const cashSpent = round(
    cashPeriodItems
      .filter((l) => (Number(l.credit) || 0) > 0)
      .reduce((s, l) => s + reportingBookedAmount(db, l, netOf(l)), 0),
  );
  const cashSurplus = round(cashReceived + cashSpent);

  const sum = (rows, types) => round(rows.filter((r) => types.includes(r.account.account_type)).reduce((s, r) => s + r.balance, 0));
  const closingBankBalance = round(sum(bs.assets, ['asset_cash']) - sum(bs.liabilities, ['liability_credit_card']));
  const receivables = sum(bs.assets, ['asset_receivable']);
  const payables = round(-sum(bs.liabilities, ['liability_payable']));
  const netAssets = round(bs.totalAssets - bs.totalLiabilities);
  const currentAssets = sum(bs.assets, ['asset_receivable', 'asset_cash', 'asset_current', 'asset_prepayments']);
  const currentLiabilities = sum(bs.liabilities, ['liability_payable', 'liability_current', 'liability_credit_card']);

  const revenue = pl.revenue;
  const costOfRevenue = pl.cost;
  const grossProfit = pl.gross;
  const expenses = pl.expense;
  const netProfit = pl.net;

  // Odoo uses ignore_zero_division: a zero denominator yields 0, not null.
  const pct = (n, d) => (d ? round((n / d) * 100) : 0);
  const grossProfitMargin = pct(grossProfit, revenue);
  const netProfitMargin = pct(netProfit, revenue);
  const returnOnInvestments = pct(netProfit, bs.totalAssets);

  // NDays: Odoo computes this in a custom engine; use the inclusive day count from `from`..`to` (1 when open-ended).
  const periodDays = from && to ? Math.round((new Date(to) - new Date(from)) / 864e5) + 1 : null;
  const days = periodDays > 0 ? periodDays : 1;
  const averageDebtorsDays = revenue ? round((receivables / revenue) * days, 2) : 0;
  const creditorsDenominator = round(costOfRevenue + expenses);
  const averageCreditorsDays = creditorsDenominator ? round((-payables / creditorsDenominator) * days, 2) : 0;
  const shortTermCashForecast = round(receivables + payables);
  const currentAssetsToLiabilities = currentLiabilities ? currentAssets / currentLiabilities : 0;

  const figures = {
    cashReceived,
    cashSpent,
    cashSurplus,
    closingBankBalance,
    revenue,
    costOfRevenue,
    grossProfit,
    expenses,
    netProfit,
    receivables,
    payables,
    netAssets,
    grossProfitMargin,
    netProfitMargin,
    returnOnInvestments,
    averageDebtorsDays,
    averageCreditorsDays,
    shortTermCashForecast,
    currentAssetsToLiabilities,
  };
  const sections = EXECUTIVE_SUMMARY_SECTIONS.map((section) => ({
    ...section,
    rows: section.rows.map((row) => ({ ...row, value: figures[row.key] })),
  }));

  return {
    sections,
    ...figures,
    // Legacy aliases preserved for existing callers.
    cash: closingBankBalance,
    currentRatio: currentAssetsToLiabilities,
    grossMargin: grossProfitMargin,
    netMargin: netProfitMargin,
    dso: averageDebtorsDays,
  };
}

/** Receivable statement of one partner: opening balance, the period's lines with a running balance and the move reference, closing balance. */
export function customerStatement(db, partnerId, { from, to, company_id, includeUnposted, reviewMode } = {}) {
  const mode = reportReviewMode({ reviewMode, includeUnposted });
  const company = Number(company_id ?? currentCompany(db));
  const receivable = accountIds(db, 'asset_receivable');
  const mine = (l) => receivable.has(l.account_id) && l.partner_id === partnerId && (l.company_id ?? 1) === company;
  const opening = round(itemsBefore(db, from, company, undefined, mode).filter(mine).reduce((s, l) => s + reportingBookedAmount(db, l, netOf(l)), 0));
  let run = opening;
  const lines = journalItems(db, { from, to, company_id: company, reviewMode: mode }).filter(mine)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((l) => {
      const debit = reportingBookedAmount(db, l, l.debit);
      const credit = reportingBookedAmount(db, l, l.credit);
      run += debit - credit;
      const ref = read(db, 'account.move', l.move_id)?.ref;
      return { date: l.date, move_name: l.move_name, ...(ref ? { ref } : {}), debit, credit, balance: round(run) };
    });
  return { opening, lines, closing: round(run) };
}

/** Deferred recognition by original account for the selected company and period. */
export function deferredReport(db, { from, to, company_id } = {}, kind) {
  const rows = new Map();
  for (const rawSchedule of search(db, 'account.deferral')) {
    if (rawSchedule.kind !== kind || (company_id && (rawSchedule.company_id ?? 1) !== Number(company_id))) continue;
    const schedule = scheduleAsOf(db, rawSchedule, to);
    if (schedule.state === 'cancel' || schedule.state === 'draft') continue;
    const source = schedule.source_move_id ? read(db, 'account.move', schedule.source_move_id) : null;
    const sourceDate = source?.date ?? source?.invoice_date;
    if (schedule.source_move_id && (!source || source.state !== 'posted' || !sourceDate || (to && sourceDate > to))) continue;
    if (!schedule.recognition_account_id || !Array.isArray(schedule.board)) continue;
    const company = schedule.company_id ?? 1;
    const currency = companyCurrencyRecord(db, company);
    const method = deferredSettings(db, company, kind).computationMethod;
    const start = schedule.start_date ?? schedule.board[0]?.date;
    const previous = from ? new Date(Date.parse(from + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10) : null;
    const total = schedule.board.reduce((sum, line) => {
      if (line.cancelled) return sum;
      const amt = Number(line.amount) || 0;
      const credited = lineCreditAdjustmentAmount(db, schedule, line, to);
      return sum + (amt < 0 ? amt + credited : Math.max(0, amt - credited));
    }, 0);
    const through = (date) => date ? schedule.board.reduce((sum, line, index) => {
      if (line.cancelled) return sum;
      const target = recognitionTargetThroughDate(schedule, index, date, method, currency);
      const credited = lineCreditAdjustmentAmount(db, schedule, line, to && date > to ? to : date);
      return sum + (target < 0 ? target + credited : Math.max(0, target - credited));
    }, 0) : 0;
    const before = through(previous);
    const untilEnd = to ? through(to) : total;
    const notStarted = start && to && start > to ? total : 0;
    const current = untilEnd - before;
    const cutoff = to ? new Date(`${to}T00:00:00Z`) : null;
    if (cutoff) {
      const month = cutoff.getUTCMonth();
      cutoff.setUTCDate(1);
      cutoff.setUTCFullYear(cutoff.getUTCFullYear() + 1);
      cutoff.setUTCDate(Math.min(Number(to.slice(8, 10)), new Date(Date.UTC(cutoff.getUTCFullYear(), month + 1, 0)).getUTCDate()));
    }
    const withinEnd = cutoff ? through(cutoff.toISOString().slice(0, 10)) : total;
    const recognized = untilEnd;
    const within_year = withinEnd - recognized;
    const after_year = total - withinEnd;
    const row = rows.get(schedule.recognition_account_id) ?? { account_id: schedule.recognition_account_id, total: 0, not_started: 0, before: 0, current: 0, recognized: 0, within_year: 0, after_year: 0 };
    for (const [key, value] of Object.entries({ total, not_started: notStarted, before, current, recognized, within_year, after_year })) {
      row[key] = roundCurrency(row[key] + value, currency);
    }
    rows.set(row.account_id, row);
  }
  return [...rows.values()];
}
