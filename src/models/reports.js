// Pure accounting reports over the posted journal: trial balance, partner ledgers, cash flow, executive KPIs, customer statements.
import { read, search } from '../orm.js';
import { balances, balanceSheet, analyticMoveItems, filterByAnalytic, journalItems, profitAndLoss } from './ledger.js';
import { round } from '../money.js';
import { appliedValue } from './finance.js';
import { toCompany } from './currency.js';
import { applicationEffectiveDate } from './settlement.js';
import { currentCompany } from './company.js';
import { reportingBookedAmount } from './money.js';
import { isLiquidityJournal } from './ledger.js';

const netOf = (l) => (Number(l.debit) || 0) - (Number(l.credit) || 0);
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
const itemsBefore = (db, from, company_id, analyticAccountIds) => (from ? filterByAnalytic(journalItems(db, { company_id }), analyticAccountIds).filter((l) => l.date < from) : []);

/** Trial balance: opening balance per account, movement inside the period, ending balance; rows sorted by code, all-zero rows omitted. */
export function trialBalance(db, { from, to, company_id, analyticAccountIds } = {}) {
  const opening = new Map(balances(db, itemsBefore(db, from, company_id, analyticAccountIds)).map((b) => [b.account.id, b.balance]));
  const rows = new Map();
  const row = (id) => {
    if (!rows.has(id)) rows.set(id, { account: read(db, 'account.account', id), initial: round(opening.get(id) ?? 0), debit: 0, credit: 0 });
    return rows.get(id);
  };
  for (const id of opening.keys()) row(id);
  for (const l of filterByAnalytic(journalItems(db, { from, to, company_id }), analyticAccountIds)) {
    const r = row(l.account_id);
    r.debit += reportingBookedAmount(db, l, l.debit);
    r.credit += reportingBookedAmount(db, l, l.credit);
  }
  const list = [...rows.values()]
    .filter((r) => r.account)
    .map((r) => ({ account: r.account, initial: r.initial, debit: round(r.debit), credit: round(r.credit), end: round(r.initial + r.debit - r.credit) }))
    .filter((r) => r.initial || r.debit || r.credit || r.end)
    .sort((a, b) => a.account.code.localeCompare(b.account.code));
  const total = (key) => round(list.reduce((s, r) => s + r[key], 0));
  return { rows: list, totals: { initial: total('initial'), debit: total('debit'), credit: total('credit'), end: total('end') } };
}

/** Period movements grouped by the explicit fiscal category on each trial-balance account. */
export function fiscalReport(db, { from, to, company_id, analyticAccountIds } = {}) {
  const trial = trialBalance(db, { from, to, company_id, analyticAccountIds });
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
    const booked = Math.sign(Number(line.amount)) * toCompany(db, journal.currency_id, Math.abs(Number(line.amount)), line.date, line.company_id ?? 1);
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
export function partnerLedger(db, { from, to, company_id, analyticAccountIds } = {}, kind = 'receivable') {
  const accounts = accountIds(db, kind === 'payable' ? 'liability_payable' : 'asset_receivable');
  const rows = new Map();
  const row = (id) => {
    if (!rows.has(id)) rows.set(id, { partner_id: id, initial: 0, debit: 0, credit: 0, lines: [] });
    return rows.get(id);
  };
  for (const l of itemsBefore(db, from, company_id, analyticAccountIds).filter((x) => accounts.has(x.account_id))) {
    const r = row(l.partner_id);
    r.initial += reportingBookedAmount(db, l, netOf(l));
  }
  const items = filterByAnalytic(journalItems(db, { from, to, company_id }), analyticAccountIds).filter((x) => accounts.has(x.account_id)).sort((a, b) => a.date.localeCompare(b.date));
  for (const l of items) {
    const r = row(l.partner_id);
    const debit = reportingBookedAmount(db, l, l.debit);
    const credit = reportingBookedAmount(db, l, l.credit);
    r.debit += debit;
    r.credit += credit;
    r.lines.push({ date: l.date, move_id: l.move_id, move_name: l.move_name, debit, credit, currency_id: l.currency_id ?? null, amount_currency: l.amount_currency ?? null });
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

/** Determine the cash flow activity (operating, investing, financing) for an account. */
export function accountCashFlowActivity(db, account) {
  if (!account) return 'unclassified';
  if (Array.isArray(account.tag_ids)) {
    const tags = account.tag_ids.map((tag) => typeof tag === 'object' ? tag : read(db, 'account.account.tag', tag));
    const explicit = tags.find((tag) => ['operating', 'investing', 'financing'].includes(tag?.cash_flow_activity));
    if (explicit) return explicit.cash_flow_activity;
  }
  return 'unclassified';
}

/**
 * Direct-method cash flow over the cash accounts: every posted move touching cash attributes its movement to its
 * non-cash counterpart lines (a credit on the counterpart is cash in); fixed-asset counterparts are investing,
 * equity and loans financing, everything else operating.
 */
export function cashFlow(db, { from, to, company_id, analyticAccountIds } = {}) {
  const targetCompany = company_id;
  const cash = accountIds(db, 'asset_cash');
  const sum = (items) => round(balances(db, items.filter((l) => cash.has(l.account_id))).reduce((s, b) => s + b.balance, 0));
  const all = analyticMoveItems(journalItems(db, { company_id: targetCompany }), analyticAccountIds);
  const opening = sum(all.filter((l) => from && l.date < from));
  const closing = sum(all.filter((l) => !to || l.date <= to));
  const totals = { operating: 0, investing: 0, financing: 0, unclassified: 0 };
  const attributed = new Map();
  const byMove = new Map();
  for (const l of analyticMoveItems(journalItems(db, { from, to, company_id: targetCompany }), analyticAccountIds)) byMove.set(l.move_id, [...(byMove.get(l.move_id) ?? []), l]);
  const documents = search(db, 'account.move').filter((m) => m.state === 'posted'
    && (!targetCompany || (m.company_id ?? 1) === targetCompany)
    && ['out_invoice', 'in_invoice', 'out_refund', 'in_refund'].includes(m.move_type));
  const documentSources = new Map(documents.map((document) => {
    const allSources = cashFlowDocumentSources(db, document);
    const selectedLines = analyticAccountIds?.length
      ? analyticMoveItems(document.line_ids ?? [], analyticAccountIds)
      : (document.line_ids ?? []);
    const selectedSources = selectedLines.map((line) => ({ line, account: read(db, 'account.account', line.account_id) }))
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
            const available = Math.max(0, Math.abs(appliedValue(db, doc, settlement)) - (consumed.get(settlement) ?? 0));
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
    const original = read(db, 'account.move', moveId);
    const payment = (db.records['account.payment'] ?? []).find((p) => p.move_id === moveId || (original?.reversed_entry_id && p.move_id === original.reversed_entry_id));
    if (!payment?.invoice_id) continue;
    const doc = read(db, 'account.move', payment.invoice_id);
    const settlement = (doc?.payments ?? []).find((p) => p.move_id === payment.move_id);
    if (!settlement) continue;
    const source = cashFlowSelectedSources(documentSources.get(doc.id), analyticAccountIds);
    const denominator = cashFlowSourceTotal(source);
    const fullDenominator = cashFlowSourceTotal(documentSources.get(doc.id)?.all ?? []);
    const cashNet = items.filter((l) => cash.has(l.account_id)).reduce((sum, l) => sum + netOf(l), 0);
    if (!denominator || !fullDenominator || !cashNet) continue;
    const share = analyticAccountIds?.length ? denominator / fullDenominator : 1;
    const delta = round((toCompany(db, doc.currency_id, settlement.amount, settlement.date, doc.company_id) - appliedValue(db, doc, settlement)) * Math.sign(cashNet) * share);
    if (!delta) continue;
    const counterpartAccounts = new Set((doc.line_ids ?? []).filter((line) => ['asset_receivable', 'liability_payable'].includes(read(db, 'account.account', line.account_id)?.account_type)).map((line) => line.account_id));
    const fxItems = items.filter((line) => !cash.has(line.account_id) && !counterpartAccounts.has(line.account_id)).map((line) => ({ line, account: read(db, 'account.account', line.account_id) }));
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
    const amount = Math.sign(-netOf(counterpart.line)) * Math.abs(appliedValue(db, doc, payment)) * share;
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

/** Executive KPIs for a period: P&L figures and margins, liquidity at the period end, days sales outstanding. */
export function executiveSummary(db, { from, to, analyticAccountIds } = {}) {
  const pl = profitAndLoss(db, { from, to }, { analyticAccountIds });
  const bs = balanceSheet(db, to, { analyticAccountIds });
  const sum = (rows, types) => round(rows.filter((r) => types.includes(r.account.account_type)).reduce((s, r) => s + r.balance, 0));
  const cash = sum(bs.assets, ['asset_cash']);
  const receivables = sum(bs.assets, ['asset_receivable']);
  const payables = sum(bs.liabilities, ['liability_payable']);
  const currentAssets = sum(bs.assets, ['asset_receivable', 'asset_cash', 'asset_current', 'asset_prepayments']);
  const currentLiabilities = sum(bs.liabilities, ['liability_payable', 'liability_current', 'liability_credit_card']);
  const pct = (n) => (pl.revenue ? round((n / pl.revenue) * 100) : null);
  // Days counted inclusive on both ends; an open-ended period falls back to a single day.
  const days = from && to ? Math.round((new Date(to) - new Date(from)) / 864e5) + 1 : 1;
  return {
    revenue: pl.revenue, grossProfit: pl.gross, netProfit: pl.net,
    cash, receivables, payables,
    currentRatio: currentLiabilities ? currentAssets / currentLiabilities : null,
    grossMargin: pct(pl.gross), netMargin: pct(pl.net),
    dso: pl.revenue ? Math.round((receivables / pl.revenue) * days) : null,
  };
}

/** Receivable statement of one partner: opening balance, the period's lines with a running balance and the move reference, closing balance. */
export function customerStatement(db, partnerId, { from, to, company_id } = {}) {
  const company = Number(company_id ?? currentCompany(db));
  const receivable = accountIds(db, 'asset_receivable');
  const mine = (l) => receivable.has(l.account_id) && l.partner_id === partnerId && (l.company_id ?? 1) === company;
  const opening = round(itemsBefore(db, from, company).filter(mine).reduce((s, l) => s + reportingBookedAmount(db, l, netOf(l)), 0));
  let run = opening;
  const lines = journalItems(db, { from, to, company_id: company }).filter(mine)
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
