// Pure accounting reports over the posted journal: trial balance, partner ledgers, cash flow, executive KPIs, customer statements.
import { read, search } from '../orm.js';
import { balances, balanceSheet, journalItems, profitAndLoss } from './ledger.js';
import { round } from '../money.js';
import { appliedValue } from './finance.js';
import { toCompany } from './currency.js';
import { applicationEffectiveDate } from './settlement.js';

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

/** Default cash flow activity for an account by code, type and name. */
export function defaultCashFlowActivity(code, account_type, name = '') {
  if (account_type === 'asset_fixed' || (code && String(code).startsWith('15'))) return 'investing';
  if (account_type === 'equity' || (code && String(code).startsWith('30')) || code === '260000' || account_type === 'liability_non_current' || /loan/i.test(name)) return 'financing';
  return 'operating';
}

/** Determine the cash flow activity (operating, investing, financing) for an account. */
export function accountCashFlowActivity(db, account) {
  if (!account) return 'operating';
  const checkTag = (val) => {
    if (!val) return null;
    const s = String(val).toLowerCase();
    if (s.includes('investing')) return 'investing';
    if (s.includes('financing')) return 'financing';
    if (s.includes('operating')) return 'operating';
    return null;
  };
  if (Array.isArray(account.tag_ids)) {
    for (const t of account.tag_ids) {
      const rec = typeof t === 'object' ? t : read(db, 'account.account.tag', t);
      const match = checkTag(rec?.name ?? t);
      if (match) return match;
    }
  }
  return defaultCashFlowActivity(account.code, account.account_type, account.name);
}

/**
 * Direct-method cash flow over the cash accounts: every posted move touching cash attributes its movement to its
 * non-cash counterpart lines (a credit on the counterpart is cash in); fixed-asset counterparts are investing,
 * equity and loans financing, everything else operating.
 */
export function cashFlow(db, { from, to } = {}) {
  const cash = accountIds(db, 'asset_cash');
  const sum = (items) => round(balances(db, items.filter((l) => cash.has(l.account_id))).reduce((s, b) => s + b.balance, 0));
  const all = journalItems(db);
  const opening = sum(itemsBefore(db, from));
  const closing = sum(all.filter((l) => !to || l.date <= to));
  const totals = { operating: 0, investing: 0, financing: 0 };
  const attributed = new Map();
  const byMove = new Map();
  for (const l of journalItems(db, { from, to })) byMove.set(l.move_id, [...(byMove.get(l.move_id) ?? []), l]);
  const documents = search(db, 'account.move').filter((m) => m.state === 'posted' && ['out_invoice', 'in_invoice', 'out_refund', 'in_refund'].includes(m.move_type));
  const add = (account, amount) => {
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
          const source = (doc.line_ids ?? []).map((line) => ({ line, account: read(db, 'account.account', line.account_id) }))
            .filter((x) => x.account && !['asset_receivable', 'liability_payable', 'asset_cash'].includes(x.account.account_type));
          const denominator = source.reduce((sum, x) => sum + netOf(x.line), 0);
          if (!denominator) continue;
          for (const settlement of settlements) {
            const available = Math.max(0, Math.abs(appliedValue(db, doc, settlement)) - (consumed.get(settlement) ?? 0));
            const portion = Math.min(Math.abs(remaining), available) * Math.sign(amount);
            consumed.set(settlement, (consumed.get(settlement) ?? 0) + Math.abs(portion));
            for (const x of source) add(x.account, portion * netOf(x.line) / denominator);
            remaining -= portion;
          }
        }
      }
      if (remaining) add(account, remaining);
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
    const source = (doc.line_ids ?? []).map((line) => ({ line, account: read(db, 'account.account', line.account_id) }))
      .filter((x) => x.account && !['asset_receivable', 'liability_payable', 'asset_cash'].includes(x.account.account_type));
    const denominator = source.reduce((sum, x) => sum + netOf(x.line), 0);
    const cashNet = items.filter((l) => cash.has(l.account_id)).reduce((sum, l) => sum + netOf(l), 0);
    if (!denominator || !cashNet) continue;
    const delta = round((toCompany(db, doc.currency_id, settlement.amount, settlement.date, doc.company_id) - appliedValue(db, doc, settlement)) * Math.sign(cashNet));
    const fxItems = items.map((line) => ({ line, account: read(db, 'account.account', line.account_id) })).filter((x) => ['450100', '690100'].includes(x.account?.code));
    const fxAmount = fxItems.reduce((sum, x) => sum - netOf(x.line), 0);
    if (!fxAmount || !delta) continue;
    for (const x of fxItems) add(x.account, delta * netOf(x.line) / fxAmount);
    for (const x of source) add(x.account, delta * netOf(x.line) / denominator);
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
    const source = (doc.line_ids ?? []).map((line) => ({ line, account: read(db, 'account.account', line.account_id) }))
      .filter((x) => x.account && !['asset_receivable', 'liability_payable', 'asset_cash'].includes(x.account.account_type));
    const denominator = source.reduce((sum, x) => sum + netOf(x.line), 0);
    if (!counterpart || !denominator) continue;
    const amount = Math.sign(-netOf(counterpart.line)) * Math.abs(appliedValue(db, doc, payment));
    add(counterpart.account, -amount);
    for (const x of source) add(x.account, amount * netOf(x.line) / denominator);
  }
  const ORDER = ['operating', 'investing', 'financing'];
  const lines = [...attributed]
    .map(([id, amount]) => {
      const account = read(db, 'account.account', id);
      return { section: accountCashFlowActivity(db, account), account, amount: round(amount) };
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
