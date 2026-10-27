import { useState } from 'react';
import { read, search } from '../orm.js';
import { today } from '../models/common.js';
import { balanceSheet, journalItems, profitAndLoss } from '../models/ledger.js';
import { agedBalance, analyticActuals, followUps, taxReport, taxesByTax } from '../models/finance.js';
import { useDb } from '../store.js';
import { CashFlow, ExecutiveSummary, PartnerLedger, TrialBalance } from './FinanceReports.jsx';
import { t } from '../i18n.js';
import { money } from '../ui.jsx';
import { balanceColumns, periodsFor, pnlColumns } from './reportCompare.js';

// Periods cover the whole month/quarter/year (entries dated later in the period, e.g. month-end payroll, count).
const monthEnd = (y, m) => `${y}-${String(m).padStart(2, '0')}-${new Date(y, m, 0).getDate()}`;
export const PERIODS = {
  month: () => {
    const d = new Date();
    return { from: today().slice(0, 7) + '-01', to: monthEnd(d.getFullYear(), d.getMonth() + 1) };
  },
  quarter: () => {
    const d = new Date();
    const q = Math.floor(d.getMonth() / 3) * 3;
    return { from: `${d.getFullYear()}-${String(q + 1).padStart(2, '0')}-01`, to: monthEnd(d.getFullYear(), q + 3) };
  },
  year: () => ({ from: today().slice(0, 4) + '-01-01', to: today().slice(0, 4) + '-12-31' }),
  all: () => ({ from: '', to: '9999-12-31' }),
};

function ComparisonCells({ values, variance }) {
  const previous = values.at(-2);
  const amount = variance?.amount ?? Math.round((values.at(-1) - previous) * 100) / 100;
  const pct = variance ? variance.pct : previous ? Math.round(amount / Math.abs(previous) * 10000) / 100 : null;
  return <>{values.map((value, i) => <td key={i} className="num">{money(value)}</td>)}<td className="num">{money(amount)}</td><td className="num">{pct == null ? t('n/a') : `${pct}${t('%')}`}</td></>;
}

function Section({ title, total, rows, sign = 1, totals, variance }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr className="rep-section" onClick={() => setOpen(!open)} aria-expanded={open}>
        <td><span className="caret">{rows?.length ? (open ? '▾' : '▸') : ''}</span> {t(title)}</td>
        {totals ? <ComparisonCells values={totals} variance={variance} /> : <td className="num">{money(sign * total)}</td>}
      </tr>
      {open && rows?.map((r) => (
        <tr key={r.account.id} className="rep-detail">
          <td>{r.account.code} {r.account.name}</td>
          {totals ? <ComparisonCells values={r.values} /> : <td className="num">{money(r.balance)}</td>}
        </tr>
      ))}
    </>
  );
}

const Total = ({ label, value, strong, values, variance }) => (
  <tr className={`rep-total ${strong ? 'strong' : ''}`}><td>{t(label)}</td>{values ? <ComparisonCells values={values} variance={variance} /> : <td className="num">{money(value)}</td>}</tr>
);

function Comparison({ data, report }) {
  const section = (i) => <Section key={data.sections[i].title} {...data.sections[i]} variance={data.variance[i]} />;
  const total = (i) => <Total key={data.totals[i].label} {...data.totals[i]} variance={data.variance[data.sections.length + i]} />;
  return <tbody>{report === 'pnl'
    ? [section(0), section(1), total(0), section(2), total(1), section(3), section(4), total(2)]
    : [section(0), total(0), section(1), section(2), section(3), total(1)]}</tbody>;
}

function Pnl({ db, period }) {
  const p = profitAndLoss(db, period);
  return (
    <tbody>
      <Section title="Revenue" total={p.revenue} rows={p.detail.revenue} />
      <Section title="Cost of Revenue" total={p.cost} rows={p.detail.cost} />
      <Total label="Gross Profit" value={p.gross} />
      <Section title="Expenses" total={p.expense} rows={p.detail.expense} />
      <Total label="Net Operating Income" value={p.operating} />
      <Section title="Other Income" total={p.otherIncome} />
      <Section title="Other Expenses" total={p.otherExpense} />
      <Total label="Net Income" value={p.net} strong />
    </tbody>
  );
}

function Balance({ db, period }) {
  const b = balanceSheet(db, period.to);
  return (
    <tbody>
      <Section title="Assets" total={b.totalAssets} rows={b.assets} />
      <Total label="Total Assets" value={b.totalAssets} strong />
      <Section title="Liabilities" total={b.totalLiabilities} rows={b.liabilities} />
      <Section title="Equity" total={b.totalEquity - b.earnings} rows={b.equity} />
      <Section title="Current Year Earnings" total={b.earnings} />
      <Total label="Liabilities + Equity" value={b.totalLiabilities + b.totalEquity} strong />
    </tbody>
  );
}

function Ledger({ db, period }) {
  const items = journalItems(db, period);
  const opening = period.from ? journalItems(db, { to: period.from }).filter((l) => l.date < period.from) : [];
  const accounts = [...new Set([...items, ...opening].map((l) => l.account_id))]
    .map((id) => read(db, 'account.account', id)).filter(Boolean).sort((a, b) => a.code.localeCompare(b.code));
  const [open, setOpen] = useState(() => new Set());
  const toggle = (id) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const bal = (ls) => ls.reduce((s, l) => s + (Number(l.debit) || 0) - (Number(l.credit) || 0), 0);
  return (
    <tbody>
      {accounts.map((a) => {
        const lines = items.filter((l) => l.account_id === a.id).sort((x, y) => x.date.localeCompare(y.date));
        const start = bal(opening.filter((l) => l.account_id === a.id));
        let running = start;
        return [
          <tr key={a.id} className="rep-section" onClick={() => toggle(a.id)} aria-expanded={open.has(a.id)}>
            <td><span className="caret">{open.has(a.id) ? '▾' : '▸'}</span> {a.code} {a.name}</td>
            <td className="num">{money(lines.reduce((s, l) => s + (Number(l.debit) || 0), 0))}</td>
            <td className="num">{money(lines.reduce((s, l) => s + (Number(l.credit) || 0), 0))}</td>
            <td className="num">{money(start + bal(lines))}</td>
          </tr>,
          ...(open.has(a.id) ? [
            <tr key={`${a.id}-open`} className="rep-detail"><td>{t('Initial Balance')}</td><td /><td /><td className="num">{money(start)}</td></tr>,
            ...lines.map((l, i) => {
              running += (Number(l.debit) || 0) - (Number(l.credit) || 0);
              return (
                <tr key={`${a.id}-${i}`} className="rep-detail">
                  <td><a href={`#/open/account.move/${l.move_id}`}>{l.date} · {l.move_name}</a> <span className="muted">{l.name}</span></td>
                  <td className="num">{l.debit ? money(l.debit) : ''}</td>
                  <td className="num">{l.credit ? money(l.credit) : ''}</td>
                  <td className="num">{money(running)}</td>
                </tr>
              );
            }),
          ] : []),
        ];
      })}
    </tbody>
  );
}

const partnerName = (db, id) => read(db, 'res.partner', id)?.name ?? '—';

function Tax({ db, period }) {
  const r = taxReport(db, period);
  const byTax = taxesByTax(db, period);
  const side = (key, title) => (
    <>
      <tr className="rep-section"><td>{t(title)}</td><td /><td /></tr>
      {byTax.filter((x) => x.side === key).map((x) => (
        <tr key={x.name} className="rep-detail"><td>{x.name}</td><td className="num">{money(x.base)}</td><td className="num">{money(x.tax)}</td></tr>
      ))}
    </>
  );
  const line = (label, value, strong) => <tr className={`rep-total ${strong ? 'strong' : ''}`}><td>{t(label)}</td><td /><td className="num">{money(value)}</td></tr>;
  return (
    <tbody>
      {side('sale', 'Sales')}
      {side('purchase', 'Purchases')}
      {line('Output Tax', r.output)}
      {line('Input Tax', r.input)}
      {line('Tax Payable', r.payable, true)}
    </tbody>
  );
}

const Aged = (kind) => function AgedBody({ db }) {
  const { buckets, rows } = agedBalance(db, kind);
  const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
  return (
    <tbody>
      {rows.map((r) => (
        <tr key={r.partner_id} className="rep-detail">
          <td><a href={`#/open/res.partner/${r.partner_id}`}>{partnerName(db, r.partner_id)}</a></td>
          {buckets.map(([k]) => <td key={k} className="num">{r[k] ? money(r[k]) : ''}</td>)}
          <td className="num">{money(r.total)}</td>
        </tr>
      ))}
      <tr className="rep-total strong"><td>{t('Total')}</td>{buckets.map(([k]) => <td key={k} className="num">{money(sum(k))}</td>)}<td className="num">{money(sum('total'))}</td></tr>
    </tbody>
  );
};

function FollowUps({ db }) {
  return (
    <tbody>
      {followUps(db).map((f) => {
        const email = read(db, 'res.partner', f.partner_id)?.email;
        const body = f.invoices.map((m) => `${m.name} (${m.invoice_date_due}): ${Number(m.amount_residual).toFixed(2)}`).join('\n');
        return (
          <tr key={f.partner_id} className="rep-detail">
            <td>
              <a href={`#/open/res.partner/${f.partner_id}`}>{partnerName(db, f.partner_id)}</a>{' '}
              <span className="muted">{f.invoices.map((m) => m.name).join(', ')}</span>{' '}
              {email && <a className="btn sm" href={`mailto:${email}?subject=${encodeURIComponent(t('Payment reminder'))}&body=${encodeURIComponent(body)}`}>{t('Send Reminder')}</a>}
            </td>
            <td className="num">{f.oldest}</td>
            <td className="num">{money(f.total)}</td>
          </tr>
        );
      })}
    </tbody>
  );
}

function Budget({ db }) {
  return (
    <tbody>
      {search(db, 'account.budget').filter((b) => b.state !== 'draft').flatMap((b) => {
        const actual = analyticActuals(db, { from: b.date_from, to: b.date_to });
        return [
          <tr key={b.id} className="rep-section"><td colSpan={4}><a href={`#/open/account.budget/${b.id}`}>{b.name}</a></td></tr>,
          ...(b.lines ?? []).map((l, i) => {
            const a = actual.get(l.analytic_account_id) ?? 0;
            return (
              <tr key={`${b.id}-${i}`} className="rep-detail">
                <td>{read(db, 'account.analytic.account', l.analytic_account_id)?.name ?? '—'}</td>
                <td className="num">{money(l.planned)}</td>
                <td className="num">{money(a)}</td>
                <td className="num">{l.planned ? `${Math.round((a / l.planned) * 100)}%` : ''}</td>
              </tr>
            );
          }),
        ];
      })}
    </tbody>
  );
}

function Analytic({ db, period }) {
  const actual = analyticActuals(db, period);
  return (
    <tbody>
      {search(db, 'account.analytic.account').map((a) => <Total key={a.id} label={a.name} value={actual.get(a.id) ?? 0} />)}
    </tbody>
  );
}

const AUDIT_ROWS = 500;

function AuditTrail({ db, period }) {
  const rows = db.messages
    .filter((m) => m.model === 'account.move' && (!period.from || m.date.slice(0, 10) >= period.from) && m.date.slice(0, 10) <= period.to)
    .sort((a, b) => b.date.localeCompare(a.date)).slice(0, AUDIT_ROWS);
  return (
    <tbody>
      {rows.map((m) => (
        <tr key={m.id} className="rep-detail">
          <td><a href={`#/open/account.move/${m.res_id}`}>{read(db, 'account.move', m.res_id)?.name ?? `#${m.res_id}`}</a> <span className="muted">{m.body}</span></td>
          <td className="num">{m.author}</td>
          <td className="num">{m.date.slice(0, 16).replace('T', ' ')}</td>
        </tr>
      ))}
    </tbody>
  );
}

/** Current stock value per product (on hand × cost), largest first. */
function Valuation({ db }) {
  const rows = search(db, 'product').filter((p) => p.type === 'goods' && Number(p.qty_available))
    .map((p) => ({ p, value: (Number(p.qty_available) || 0) * (Number(p.cost) || 0) })).sort((a, b) => b.value - a.value);
  return (
    <tbody>
      {rows.map(({ p, value }) => (
        <tr key={p.id} className="rep-detail">
          <td><a href={`#/open/product/${p.id}`}>{p.default_code ? `[${p.default_code}] ` : ''}{p.name}</a></td>
          <td className="num">{p.qty_available}</td>
          <td className="num">{money(p.cost)}</td>
          <td className="num">{money(value)}</td>
        </tr>
      ))}
      <tr className="rep-total strong"><td>{t('Total')}</td><td /><td /><td className="num">{money(rows.reduce((s, r) => s + r.value, 0))}</td></tr>
    </tbody>
  );
}

// Per asset: depreciation posted in the period, accumulated to its end, and the resulting book value.
function Depreciation({ db, period }) {
  const rows = search(db, 'account.asset').filter((a) => a.state !== 'cancel' && a.state !== 'draft').map((a) => {
    const posted = (a.depreciation_ids ?? []).filter((l) => l.posted);
    const sum = (list) => list.reduce((s, l) => s + (Number(l.amount) || 0), 0);
    const accumulated = (Number(a.already_depreciated) || 0) + sum(posted.filter((l) => l.date <= period.to));
    const inPeriod = sum(posted.filter((l) => (!period.from || l.date >= period.from) && l.date <= period.to));
    return { a, inPeriod, accumulated, book: (Number(a.original_value) || 0) - accumulated };
  });
  const total = (k) => rows.reduce((s, r) => s + (k === 'original' ? Number(r.a.original_value) || 0 : r[k]), 0);
  return (
    <tbody>
      {rows.map(({ a, inPeriod, accumulated, book }) => (
        <tr key={a.id} className="rep-detail">
          <td><a href={`#/open/account.asset/${a.id}`}>{a.name}</a></td>
          <td>{a.acquisition_date}</td>
          <td className="num">{money(a.original_value)}</td>
          <td className="num">{money(inPeriod)}</td>
          <td className="num">{money(accumulated)}</td>
          <td className="num">{money(book)}</td>
        </tr>
      ))}
      <tr className="rep-total strong"><td>{t('Total')}</td><td /><td className="num">{money(total('original'))}</td><td className="num">{money(total('inPeriod'))}</td><td className="num">{money(total('accumulated'))}</td><td className="num">{money(total('book'))}</td></tr>
    </tbody>
  );
}

const REPORTS = {
  trial: { title: 'Trial Balance', Body: TrialBalance, cols: ['Initial Balance', 'Debit', 'Credit', 'End Balance'] },
  partnerReceivable: { title: 'Partner Ledger', Body: PartnerLedger('receivable'), cols: ['Initial Balance', 'Debit', 'Credit', 'End Balance'] },
  partnerPayable: { title: 'Partner Ledger (Payable)', Body: PartnerLedger('payable'), cols: ['Initial Balance', 'Debit', 'Credit', 'End Balance'] },
  cashflow: { title: 'Cash Flow Statement', Body: CashFlow, cols: ['Balance'] },
  executive: { title: 'Executive Summary', Body: ExecutiveSummary, cols: ['Value'] },
  depreciation: { title: 'Depreciation Schedule', Body: Depreciation, cols: ['Acquisition Date', 'Original Value', 'Depreciation', 'Cumulative Depreciation', 'Book Value'] },
  valuation: { title: 'Stock Valuation', Body: Valuation, cols: ['On Hand', 'Unit Cost', 'Total Value'] },
  audit: { title: 'Audit Trail', Body: AuditTrail, cols: ['Author', 'Date'] },
  tax: { title: 'Tax Return', Body: Tax, cols: ['Base', 'Tax'] },
  agedReceivable: { title: 'Aged Receivable', Body: Aged('receivable'), cols: ['Not due', '1-30', '31-60', '61-90', 'Older', 'Total'] },
  agedPayable: { title: 'Aged Payable', Body: Aged('payable'), cols: ['Not due', '1-30', '31-60', '61-90', 'Older', 'Total'] },
  followups: { title: 'Follow-up Reports', Body: FollowUps, cols: ['Oldest Due', 'Overdue'] },
  budget: { title: 'Budget vs Actual', Body: Budget, cols: ['Planned', 'Actual', 'Achievement'] },
  analytic: { title: 'Analytic Report', Body: Analytic, cols: ['Balance'] },
  pnl: { title: 'Profit and Loss', Body: Pnl, cols: ['Balance'] },
  balance: { title: 'Balance Sheet', Body: Balance, cols: ['Balance'] },
  ledger: { title: 'General Ledger', Body: Ledger, cols: ['Debit', 'Credit', 'Balance'] },
};

/** Financial reports computed live from posted journal items. */
export function Reports({ leaf }) {
  const db = useDb();
  const [periodKey, setPeriodKey] = useState('year');
  const [comparison, setComparison] = useState('none');
  const { title, Body, cols } = REPORTS[leaf.report];
  const period = PERIODS[periodKey]();
  const comparable = ['pnl', 'balance'].includes(leaf.report) && periodKey !== 'all';
  const periods = comparable && comparison !== 'none' ? periodsFor(periodKey, comparison, today()) : null;
  const data = periods ? (leaf.report === 'pnl' ? pnlColumns(db, periods) : balanceColumns(db, periods)) : null;
  return (
    <main className="action report-page">
      <div className="control-panel">
        <h1 className="cp-title">{t(title)}</h1>
        <label className="inline-select">
          {t('Period')}
          <select value={periodKey} onChange={(e) => setPeriodKey(e.target.value)}>
            <option value="month">{t('This Month')}</option>
            <option value="quarter">{t('This Quarter')}</option>
            <option value="year">{t('This Year')}</option>
            <option value="all">{t('All Dates')}</option>
          </select>
        </label>
        {comparable && <label className="inline-select">
          {t('Comparison')}
          <select value={comparison} onChange={(e) => setComparison(e.target.value)}>
            <option value="none">{t('No comparison')}</option>
            <option value="previous">{t('Previous Period')}</option>
            <option value="lastYear">{t('Same Period Last Year')}</option>
            <option value="last3">{t('Last 3 Periods')}</option>
          </select>
        </label>}
        <span className="muted">{period.from ? `${period.from} → ${period.to}` : `≤ ${period.to}`}</span>
        <span className="spacer" />
        <button type="button" className="btn sm" onClick={() => window.print()}>{t('Print')}</button>
      </div>
      <div className="list-wrap">
        <table className="list report">
          <thead><tr><th />{(data ? [...data.headers, 'Variance', '%'] : cols).map((c) => <th key={c} className="num">{data ? c.split(' ').map((part) => t(part)).join(' ') : t(c)}</th>)}</tr></thead>
          {data ? <Comparison key={leaf.report} data={data} report={leaf.report} /> : <Body db={db} period={period} />}
        </table>
      </div>
    </main>
  );
}
