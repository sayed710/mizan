import { useState } from 'react';
import { read, search } from '../orm.js';
import { cashFlow, customerStatement, executiveSummary, fiscalReport, partnerLedger, trialBalance } from '../models/reports.js';
import { currentCompany } from '../models/company.js';
import { t } from '../i18n.js';
import { money } from '../ui.jsx';
import { formatCurrency } from '../money.js';

const num = (v) => <td className="num">{money(v)}</td>;
const pct = (v) => (v == null ? '—' : `${v}%`);

export function TrialBalance({ db, period }) {
  const { rows, totals } = trialBalance(db, period);
  return (
    <tbody>
      {rows.map((r) => (
        <tr key={r.account.id} className="rep-detail"><td><a href={`#/open/account.account/${r.account.id}`}>{r.account.code} {r.account.name}</a></td>{num(r.initial)}{num(r.debit)}{num(r.credit)}{num(r.end)}</tr>
      ))}
      <tr className="rep-total strong"><td>{t('Total')}</td>{num(totals.initial)}{num(totals.debit)}{num(totals.credit)}{num(totals.end)}</tr>
    </tbody>
  );
}

function FiscalCategoryRows({ row }) {
  const [open, setOpen] = useState(false);
  const name = row.category ? row.category.name : t('Uncategorized');
  return <>
    <tr className="rep-section"><td><button type="button" className="btn sm" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? '▾' : '▸'} {name}</button></td>{num(row.debit)}{num(row.credit)}{num(row.balance)}</tr>
    {open && row.accounts.map((line) => <tr key={line.account.id} className="rep-detail"><td><a href={`#/open/account.account/${line.account.id}`}>{line.account.code} {line.account.name}</a></td>{num(line.debit)}{num(line.credit)}{num(line.balance)}</tr>)}
  </>;
}

export function FiscalReport({ db, period }) {
  const { rows, totals } = fiscalReport(db, period);
  return <tbody>
    {rows.map((row) => <FiscalCategoryRows key={row.category?.id ?? 'uncategorized'} row={row} />)}
    <tr className="rep-total strong"><td>{t('Total')}</td>{num(totals.debit)}{num(totals.credit)}{num(totals.balance)}</tr>
  </tbody>;
}

/** One partner: a clickable summary row that unfolds its entries with the running balance. */
function PartnerRows({ db, p }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr className="rep-section" onClick={() => setOpen(!open)} aria-expanded={open}>
        <td><span className="caret">{p.lines.length ? (open ? '▾' : '▸') : ''}</span> {p.partner_id ? read(db, 'res.partner', p.partner_id)?.name : t('Unknown')}</td>
        {num(p.initial)}{num(p.debit)}{num(p.credit)}{num(p.end)}<td />
      </tr>
      {open && p.lines.map((l, i) => (
        <tr key={i} className="rep-detail"><td><a href={`#/open/account.move/${l.move_id}`}>{l.date} · {l.move_name}</a></td><td />{num(l.debit)}{num(l.credit)}{num(l.balance)}<td className="num">{l.currency_id ? formatCurrency(l.amount_currency, read(db, 'res.currency', l.currency_id)) : ''}</td></tr>
      ))}
    </>
  );
}

export const PartnerLedger = (kind) => function PartnerLedgerBody({ db, period }) {
  const rows = partnerLedger(db, period, kind);
  return (
    <tbody>
      {rows.map((p) => <PartnerRows key={p.partner_id ?? 'none'} db={db} p={p} />)}
      <tr className="rep-total strong"><td>{t('Total')}</td>{['initial', 'debit', 'credit', 'end'].map((k) => <td key={k} className="num">{money(rows.reduce((s, r) => s + r[k], 0))}</td>)}<td /></tr>
    </tbody>
  );
};

export function CustomerStatement({ db, period, companyId }) {
  const [partnerId, setPartnerId] = useState('');
  const partners = search(db, 'res.partner').sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  const selected = partners.some((p) => p.id === Number(partnerId)) ? Number(partnerId) : null;
  const currentCo = (companyId && companyId !== 'all') ? Number(companyId) : (period?.company_id ?? currentCompany(db));
  const statement = selected ? customerStatement(db, selected, { ...period, company_id: currentCo }) : null;
  return <tbody>
    <tr><td colSpan={4}><label>{t('Customer')} <select aria-label={t('Customer')} value={selected ?? ''} onChange={(e) => setPartnerId(e.target.value)}>
      <option value="">{t('Select a customer')}</option>
      {partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
    </select></label></td></tr>
    {statement && <>
      <tr className="rep-section"><td>{t('Opening Balance')}</td><td /><td />{num(statement.opening)}</tr>
      {statement.lines.map((line, i) => <tr key={i} className="rep-detail"><td>{line.date} · {line.move_name}{line.ref ? ` · ${line.ref}` : ''}</td>{num(line.debit)}{num(line.credit)}{num(line.balance)}</tr>)}
      <tr className="rep-total strong"><td>{t('Closing Balance')}</td><td /><td />{num(statement.closing)}</tr>
    </>}
  </tbody>;
}

export function CashFlow({ db, period, companyId }) {
  const currentCo = (companyId && companyId !== 'all') ? Number(companyId) : period?.company_id;
  const r = cashFlow(db, currentCo ? { ...period, company_id: currentCo } : period);
  const section = (key, title) => (
    <>
      <tr className="rep-section"><td>{t(title)}</td>{num(r[key])}</tr>
      {r.lines.filter((l) => l.section === key).map((l) => (
        <tr key={`${key}-${l.account.id}`} className="rep-detail"><td><a href={`#/open/account.account/${l.account.id}`}>{l.account.code} {l.account.name}</a></td>{num(l.amount)}</tr>
      ))}
    </>
  );
  return (
    <tbody>
      <tr className="rep-total"><td>{t('Cash at the beginning of the period')}</td>{num(r.opening)}</tr>
      {section('operating', 'Operating Activities')}
      {section('investing', 'Investing Activities')}
      {section('financing', 'Financing Activities')}
      {(r.unclassified !== 0 || r.lines.some((l) => l.section === 'unclassified')) && section('unclassified', 'Unclassified')}
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
