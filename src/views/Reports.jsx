import { useState } from 'react';
import { read } from '../orm.js';
import { today } from '../models/common.js';
import { balanceSheet, journalItems, profitAndLoss } from '../models/ledger.js';
import { useDb } from '../store.js';
import { t } from '../i18n.js';
import { money } from '../ui.jsx';

// Periods cover the whole month/quarter/year (entries dated later in the period, e.g. month-end payroll, count).
const monthEnd = (y, m) => `${y}-${String(m).padStart(2, '0')}-${new Date(y, m, 0).getDate()}`;
const PERIODS = {
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

function Section({ title, total, rows, sign = 1 }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr className="rep-section" onClick={() => setOpen(!open)} aria-expanded={open}>
        <td><span className="caret">{rows?.length ? (open ? '▾' : '▸') : ''}</span> {t(title)}</td>
        <td className="num">{money(sign * total)}</td>
      </tr>
      {open && rows?.map((r) => (
        <tr key={r.account.id} className="rep-detail">
          <td>{r.account.code} {r.account.name}</td>
          <td className="num">{money(r.balance)}</td>
        </tr>
      ))}
    </>
  );
}

const Total = ({ label, value, strong }) => (
  <tr className={`rep-total ${strong ? 'strong' : ''}`}><td>{t(label)}</td><td className="num">{money(value)}</td></tr>
);

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

const REPORTS = {
  pnl: { title: 'Profit and Loss', Body: Pnl, cols: ['Balance'] },
  balance: { title: 'Balance Sheet', Body: Balance, cols: ['Balance'] },
  ledger: { title: 'General Ledger', Body: Ledger, cols: ['Debit', 'Credit', 'Balance'] },
};

/** Financial reports computed live from posted journal items. */
export function Reports({ leaf }) {
  const db = useDb();
  const [periodKey, setPeriodKey] = useState('year');
  const { title, Body, cols } = REPORTS[leaf.report];
  const period = PERIODS[periodKey]();
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
        <span className="muted">{period.from ? `${period.from} → ${period.to}` : `≤ ${period.to}`}</span>
        <span className="spacer" />
        <button type="button" className="btn sm" onClick={() => window.print()}>{t('Print')}</button>
      </div>
      <div className="list-wrap">
        <table className="list report">
          <thead><tr><th />{cols.map((c) => <th key={c} className="num">{t(c)}</th>)}</tr></thead>
          <Body db={db} period={period} />
        </table>
      </div>
    </main>
  );
}
