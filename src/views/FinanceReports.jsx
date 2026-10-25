import { useState } from 'react';
import { read } from '../orm.js';
import { cashFlow, executiveSummary, partnerLedger, trialBalance } from '../models/reports.js';
import { t } from '../i18n.js';
import { money } from '../ui.jsx';

const num = (v) => <td className="num">{money(v)}</td>;
const pct = (v) => (v == null ? '—' : `${v}%`);

export function TrialBalance({ db, period }) {
  const { rows, totals } = trialBalance(db, period);
  return (
    <tbody>
      {rows.map((r) => (
        <tr key={r.account.id} className="rep-detail"><td>{r.account.code} {r.account.name}</td>{num(r.initial)}{num(r.debit)}{num(r.credit)}{num(r.end)}</tr>
      ))}
      <tr className="rep-total strong"><td>{t('Total')}</td>{num(totals.initial)}{num(totals.debit)}{num(totals.credit)}{num(totals.end)}</tr>
    </tbody>
  );
}

/** One partner: a clickable summary row that unfolds its entries with the running balance. */
function PartnerRows({ db, p }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr className="rep-section" onClick={() => setOpen(!open)} aria-expanded={open}>
        <td><span className="caret">{p.lines.length ? (open ? '▾' : '▸') : ''}</span> {p.partner_id ? read(db, 'res.partner', p.partner_id)?.name : t('Unknown')}</td>
        {num(p.initial)}{num(p.debit)}{num(p.credit)}{num(p.end)}
      </tr>
      {open && p.lines.map((l, i) => (
        <tr key={i} className="rep-detail"><td>{l.date} · {l.move_name}</td><td />{num(l.debit)}{num(l.credit)}{num(l.balance)}</tr>
      ))}
    </>
  );
}

export const PartnerLedger = (kind) => function PartnerLedgerBody({ db, period }) {
  const rows = partnerLedger(db, period, kind);
  return (
    <tbody>
      {rows.map((p) => <PartnerRows key={p.partner_id ?? 'none'} db={db} p={p} />)}
      <tr className="rep-total strong"><td>{t('Total')}</td>{['initial', 'debit', 'credit', 'end'].map((k) => <td key={k} className="num">{money(rows.reduce((s, r) => s + r[k], 0))}</td>)}</tr>
    </tbody>
  );
};

export function CashFlow({ db, period }) {
  const r = cashFlow(db, period);
  const section = (key, title) => (
    <>
      <tr className="rep-section"><td>{t(title)}</td>{num(r[key])}</tr>
      {r.lines.filter((l) => l.section === key).map((l) => (
        <tr key={`${key}-${l.account.id}`} className="rep-detail"><td>{l.account.code} {l.account.name}</td>{num(l.amount)}</tr>
      ))}
    </>
  );
  return (
    <tbody>
      <tr className="rep-total"><td>{t('Cash at the beginning of the period')}</td>{num(r.opening)}</tr>
      {section('operating', 'Operating Activities')}
      {section('investing', 'Investing Activities')}
      {section('financing', 'Financing Activities')}
      <tr className="rep-total"><td>{t('Net Change in Cash')}</td>{num(r.net)}</tr>
      <tr className="rep-total strong"><td>{t('Cash at the end of the period')}</td>{num(r.closing)}</tr>
    </tbody>
  );
}

export function ExecutiveSummary({ db, period }) {
  const s = executiveSummary(db, period);
  const rows = [
    ['Revenue', money(s.revenue)], ['Gross Profit', money(s.grossProfit)], ['Net Profit', money(s.netProfit)],
    ['Cash', money(s.cash)], ['Receivables', money(s.receivables)], ['Payables', money(s.payables)],
    ['Current Ratio', s.currentRatio ?? '—'], ['Gross Margin', pct(s.grossMargin)], ['Net Margin', pct(s.netMargin)],
    ['Days Sales Outstanding', s.dso ?? '—'],
  ];
  return <tbody>{rows.map(([label, value]) => <tr key={label} className="rep-detail"><td>{t(label)}</td><td className="num">{value}</td></tr>)}</tbody>;
}
