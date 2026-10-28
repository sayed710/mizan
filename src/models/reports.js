// Pure accounting reports over the posted journal: trial balance, partner ledgers, cash flow, executive KPIs, customer statements.
import { read, search } from '../orm.js';
import { balances, balanceSheet, journalItems, profitAndLoss } from './ledger.js';
import { round } from '../money.js';

const netOf = (l) => (Number(l.debit) || 0) - (Number(l.credit) || 0);
const accountIds = (db, type) => new Set(search(db, 'account.account').filter((a) => a.account_type === type).map((a) => a.id));

/** Journal items dated strictly before `from` (none without a `from`): the opening column of every report. */
const itemsBefore = (db, from) => (from ? journalItems(db).filter((l) => l.date < from) : []);

/** Trial balance: opening balance per account, movement inside the period, ending balance; rows sorted by code, all-zero rows omitted. */
export function trialBalance(db, { from, to } = {}) {
  const opening = new Map(balances(db, itemsBefore(db, from)).map((b) => [b.account.id, b.balance]));
  const rows = new Map();
  const row = (id) => {
    if (!rows.has(id)) rows.set(id, { account: read(db, 'account.account', id), initial: round(opening.get(id) ?? 0), debit: 0, credit: 0 });
    return rows.get(id);
  };
  for (const id of opening.keys()) row(id);
  for (const l of journalItems(db, { from, to })) {
    const r = row(l.account_id);
    r.debit += Number(l.debit) || 0;
    r.credit += Number(l.credit) || 0;
  }
  const list = [...rows.values()]
    .filter((r) => r.account)
    .map((r) => ({ account: r.account, initial: r.initial, debit: round(r.debit), credit: round(r.credit), end: round(r.initial + r.debit - r.credit) }))
    .filter((r) => r.initial || r.debit || r.credit || r.end)
    .sort((a, b) => a.account.code.localeCompare(b.account.code));
  const total = (key) => round(list.reduce((s, r) => s + r[key], 0));
  return { rows: list, totals: { initial: total('initial'), debit: total('debit'), credit: total('credit'), end: total('end') } };
}

/** Receivable or payable ledger per partner: opening balance, the period's lines with a running balance, sorted by partner name. */
export function partnerLedger(db, { from, to } = {}, kind = 'receivable') {
  const accounts = accountIds(db, kind === 'payable' ? 'liability_payable' : 'asset_receivable');
  const rows = new Map();
  const row = (id) => {
    if (!rows.has(id)) rows.set(id, { partner_id: id, initial: 0, debit: 0, credit: 0, lines: [] });
    return rows.get(id);
  };
  for (const l of itemsBefore(db, from).filter((x) => accounts.has(x.account_id))) {
    const r = row(l.partner_id);
    r.initial += netOf(l);
  }
  const items = journalItems(db, { from, to }).filter((x) => accounts.has(x.account_id)).sort((a, b) => a.date.localeCompare(b.date));
  for (const l of items) {
    const r = row(l.partner_id);
    const debit = round(Number(l.debit) || 0);
    const credit = round(Number(l.credit) || 0);
    r.debit += debit;
    r.credit += credit;
    r.lines.push({ date: l.date, move_name: l.move_name, debit, credit });
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

/**
 * Direct-method cash flow over the cash accounts: every posted move touching cash attributes its movement to its
 * non-cash counterpart lines (a credit on the counterpart is cash in); fixed-asset counterparts are investing,
 * equity is financing, everything else operating.
 */
export function cashFlow(db, { from, to } = {}) {
  const cash = accountIds(db, 'asset_cash');
  const sum = (items) => round(balances(db, items.filter((l) => cash.has(l.account_id))).reduce((s, b) => s + b.balance, 0));
  const all = journalItems(db);
  const opening = sum(itemsBefore(db, from));
  const closing = sum(all.filter((l) => !to || l.date <= to));
  const SECTION = { asset_fixed: 'investing', equity: 'financing' };
  const totals = { operating: 0, investing: 0, financing: 0 };
  const attributed = new Map();
  const byMove = new Map();
  for (const l of journalItems(db, { from, to })) byMove.set(l.move_id, [...(byMove.get(l.move_id) ?? []), l]);
  for (const items of byMove.values()) {
    if (!items.some((l) => cash.has(l.account_id))) continue;
    for (const l of items.filter((x) => !cash.has(x.account_id))) {
      const account = read(db, 'account.account', l.account_id);
      if (!account) continue;
      const section = SECTION[account.account_type] ?? 'operating';
      const amount = -netOf(l);
      totals[section] += amount;
      attributed.set(account.id, (attributed.get(account.id) ?? 0) + amount);
    }
  }
  const ORDER = ['operating', 'investing', 'financing'];
  const lines = [...attributed]
    .map(([id, amount]) => {
      const account = read(db, 'account.account', id);
      return { section: SECTION[account.account_type] ?? 'operating', account, amount: round(amount) };
    })
    .sort((a, b) => ORDER.indexOf(a.section) - ORDER.indexOf(b.section) || a.account.code.localeCompare(b.account.code));
  return {
    opening, closing, net: round(closing - opening),
    operating: round(totals.operating), investing: round(totals.investing), financing: round(totals.financing),
    lines,
  };
}

/** Executive KPIs for a period: P&L figures and margins, liquidity at the period end, days sales outstanding. */
export function executiveSummary(db, { from, to } = {}) {
  const pl = profitAndLoss(db, { from, to });
  const bs = balanceSheet(db, to);
  const sum = (rows, types) => round(rows.filter((r) => types.includes(r.account.account_type)).reduce((s, r) => s + r.balance, 0));
  const cash = sum(bs.assets, ['asset_cash']);
  const receivables = sum(bs.assets, ['asset_receivable']);
  const payables = sum(bs.liabilities, ['liability_payable']);
  const currentAssets = sum(bs.assets, ['asset_receivable', 'asset_cash', 'asset_current']);
  const currentLiabilities = sum(bs.liabilities, ['liability_payable', 'liability_current']);
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
export function customerStatement(db, partnerId, { from, to } = {}) {
  const receivable = accountIds(db, 'asset_receivable');
  const mine = (l) => receivable.has(l.account_id) && l.partner_id === partnerId;
  const opening = round(itemsBefore(db, from).filter(mine).reduce((s, l) => s + netOf(l), 0));
  let run = opening;
  const lines = journalItems(db, { from, to }).filter(mine)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((l) => {
      run += netOf(l);
      const ref = read(db, 'account.move', l.move_id)?.ref;
      return { date: l.date, move_name: l.move_name, ...(ref ? { ref } : {}), debit: round(Number(l.debit) || 0), credit: round(Number(l.credit) || 0), balance: round(run) };
    });
  return { opening, lines, closing: round(run) };
}
