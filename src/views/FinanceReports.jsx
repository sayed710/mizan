import { useState } from 'react';
import { read, search } from '../orm.js';
import { cashFlow, customerStatement, executiveSummary, fiscalReport, partnerLedger, reportAmountsVisible, trialBalance } from '../models/reports.js';
import { currentCompany } from '../models/company.js';
import { t } from '../i18n.js';
import { money } from '../ui.jsx';
import { formatCurrency } from '../money.js';
import { toggleReportFold, toggleAllReportFolds } from './reportFold.js';
import { ReportFoldAll } from './FinancialReportPrint.jsx';
import { reportMoney } from './reportCompany.jsx';
import { statementUrl } from '../statementNavigation.js';

const num = (v, fmtMoney = money) => <td className="num">{fmtMoney(v)}</td>;
const pct = (v) => (v == null ? '—' : `${v}%`);

export function TrialBalance({ db, period, periods, companyId, analyticAccountIds, showInitialBalance = true, showEndBalance = true, hideZeroLines = false, money: moneyProp }) {
  const fmtMoney = moneyProp ?? reportMoney(db, companyId);
  const company_id = companyId && companyId !== 'all' ? Number(companyId) : null;
  const reports = (periods ?? [period]).map((p) => trialBalance(db, { ...p, reviewMode: period.reviewMode, company_id, analyticAccountIds, includeZeroRows: true }));
  const rowsByReport = reports.map((report) => new Map(report.rows.map((row) => [row.account.id, row])));
  const accounts = new Map(reports.flatMap((report) => report.rows.map((row) => [row.account.id, row.account])));
  const rows = [...accounts.values()].sort((a, b) => a.code.localeCompare(b.code));
  const keys = [
    ...(showInitialBalance ? ['initial'] : []),
    'debit',
    'credit',
    ...(showEndBalance ? ['end'] : []),
  ];
  const visibleRows = rows.filter((account) => reportAmountsVisible(rowsByReport.flatMap((byAccount) => keys.map((key) => byAccount.get(account.id)?.[key] ?? 0)), hideZeroLines));
  return (
    <tbody>
      {visibleRows.map((r) => (
        <tr key={r.id} className="rep-detail"><td><a href={`#/open/account.account/${r.id}`}>{r.code} {r.name}</a></td>{rowsByReport.flatMap((byAccount, index) => { const row = byAccount.get(r.id); return keys.map((key) => <td key={`${index}-${key}`} className="num">{fmtMoney(row?.[key] ?? 0)}</td>); })}</tr>
      ))}
      <tr className="rep-total strong"><td>{t('Total')}</td>{reports.flatMap((report, index) => keys.map((key) => <td key={`${index}-${key}`} className="num">{fmtMoney(report.totals[key])}</td>))}</tr>
    </tbody>
  );
}

function FiscalCategoryRows({ rows, money: fmtMoney = money }) {
  const [open, setOpen] = useState(false);
  const row = rows.find(Boolean);
  const name = row.category ? row.category.name : t('Uncategorized');
  const accounts = new Map(rows.flatMap((group) => (group?.accounts ?? []).map((line) => [line.account.id, line.account])));
  const accountsByPeriod = rows.map((group) => new Map((group?.accounts ?? []).map((line) => [line.account.id, line])));
  const cells = (values) => values.flatMap((value, index) => ['debit', 'credit', 'balance'].map((key) => <td key={`${index}-${key}`} className="num">{fmtMoney(value?.[key] ?? 0)}</td>));
  return <>
    <tr className="rep-section"><td><button type="button" className="btn sm" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? '▾' : '▸'} {name}</button></td>{cells(rows)}</tr>
    {open && [...accounts.values()].map((account) => <tr key={account.id} className="rep-detail"><td><a href={`#/open/account.account/${account.id}`}>{account.code} {account.name}</a></td>{cells(accountsByPeriod.map((byAccount) => byAccount.get(account.id)))}</tr>)}
  </>;
}

export function FiscalReport({ db, period, periods, companyId, analyticAccountIds, money: moneyProp }) {
  const effectiveCompanyId = companyId && companyId !== 'all' ? Number(companyId) : (period?.company_id ?? null);
  const fmtMoney = moneyProp ?? reportMoney(db, effectiveCompanyId);
  const reports = (periods ?? [period]).map((p) => fiscalReport(db, { ...p, reviewMode: period?.reviewMode, company_id: effectiveCompanyId, analyticAccountIds }));
  const rowsByReport = reports.map((report) => new Map(report.rows.map((row) => [row.category?.id ?? 'uncategorized', row])));
  const groups = new Map(reports.flatMap((report) => report.rows.map((row) => [row.category?.id ?? 'uncategorized', row])));
  return <tbody>
    {[...groups.keys()].map((id) => <FiscalCategoryRows key={id} rows={rowsByReport.map((byCategory) => byCategory.get(id))} money={fmtMoney} />)}
    <tr className="rep-total strong"><td>{t('Total')}</td>{reports.flatMap((report, index) => ['debit', 'credit', 'balance'].map((key) => <td key={`${index}-${key}`} className="num">{fmtMoney(report.totals[key])}</td>))}</tr>
  </tbody>;
}

/** One partner: a clickable summary row that unfolds its entries with the running balance. */
function PartnerRows({ db, p, period, companyId, kind, showJournalAccount = false, money: fmtMoney = money }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr className="rep-section" onClick={() => setOpen(!open)} aria-expanded={open}>
        <td><span className="caret">{p.lines.length ? (open ? '▾' : '▸') : ''}</span> {p.partner_id ? read(db, 'res.partner', p.partner_id)?.name : t('Unknown')} {kind === 'receivable' && p.partner_id && companyId && <a href={statementUrl([p.partner_id], { companyId, ...period })} onClick={(e) => e.stopPropagation()}>{t('Customer Statement')}</a>}</td>
        {showJournalAccount && <><td /><td /></>}
        <td /><td /><td />
        {num(p.initial, fmtMoney)}{num(p.debit, fmtMoney)}{num(p.credit, fmtMoney)}{num(p.end, fmtMoney)}<td />
      </tr>
      {open && p.lines.map((l, i) => {
        const journal = l.journal_id ? read(db, 'account.journal', l.journal_id) : null;
        const account = l.account_id ? read(db, 'account.account', l.account_id) : null;
        return (
          <tr key={i} className="rep-detail">
            <td><a href={`#/open/account.move/${l.move_id}`}>{l.date} · {l.move_name}</a></td>
            {showJournalAccount && (
              <>
                <td>{journal?.code ?? ''}</td>
                <td>{account ? `${account.code} ${account.name}` : ''}</td>
              </>
            )}
            <td>{l.dueDate}</td>
            <td>{l.matchingNumber ?? ''}</td>
            <td>{l.label}{l.ref ? ` · ${l.ref}` : ''}</td>
            <td />
            {num(l.debit, fmtMoney)}{num(l.credit, fmtMoney)}{num(l.balance, fmtMoney)}
            <td className="num">{l.currency_id ? formatCurrency(l.amount_currency, read(db, 'res.currency', l.currency_id)) : ''}</td>
          </tr>
        );
      })}
    </>
  );
}

export const PartnerLedger = (kind) => function PartnerLedgerBody({ db, period, companyId, analyticAccountIds, partnerIds, unreconciledOnly, showJournalAccount = false, money: moneyProp }) {
  const fmtMoney = moneyProp ?? reportMoney(db, companyId);
  const company_id = companyId && companyId !== 'all' ? Number(companyId) : null;
  const rows = partnerLedger(db, { ...period, company_id, analyticAccountIds, partnerIds, unreconciledOnly }, kind);
  return (
    <tbody>
      {rows.map((p) => <PartnerRows key={p.partner_id ?? 'none'} db={db} p={p} period={period} companyId={company_id} kind={kind} showJournalAccount={showJournalAccount} money={fmtMoney} />)}
      <tr className="rep-total strong"><td>{t('Total')}</td>{showJournalAccount && <><td /><td /></>}<td /><td /><td />{['initial', 'debit', 'credit', 'end'].map((k) => <td key={k} className="num">{fmtMoney(rows.reduce((s, r) => s + r[k], 0))}</td>)}<td /></tr>
    </tbody>
  );
};

export function CustomerStatement({ db, period, companyId, initialPartnerId, fixedPartner = false, money: moneyProp }) {
  const [partnerId, setPartnerId] = useState(initialPartnerId ?? '');
  const partners = search(db, 'res.partner', { includeArchived: true }).sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  const selected = partners.some((p) => p.id === Number(partnerId)) ? Number(partnerId) : null;
  const currentCo = (companyId && companyId !== 'all') ? Number(companyId) : (period?.company_id ?? currentCompany(db));
  const fmtMoney = moneyProp ?? reportMoney(db, currentCo);
  const statementDb = (db.settings?.current_company_id ?? 1) === currentCo ? db : { ...db, settings: { ...db.settings, current_company_id: currentCo } };
  const statement = selected ? customerStatement(statementDb, selected, { ...period, company_id: currentCo }) : null;
  return <tbody>
    <tr><td colSpan={4}>{fixedPartner ? <b>{partners.find((p) => p.id === selected)?.name}</b> : <label>{t('Customer')} <select aria-label={t('Customer')} value={selected ?? ''} onChange={(e) => setPartnerId(e.target.value)}>
      <option value="">{t('Select a customer')}</option>
      {partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
    </select></label>}</td></tr>
    {statement && <>
      <tr className="rep-section"><td>{t('Opening Balance')}</td><td /><td />{num(statement.opening, fmtMoney)}</tr>
      {statement.lines.map((line, i) => <tr key={i} className="rep-detail"><td>{line.date} · {line.move_name}{line.ref ? ` · ${line.ref}` : ''}</td>{num(line.debit, fmtMoney)}{num(line.credit, fmtMoney)}{num(line.balance, fmtMoney)}</tr>)}
      <tr className="rep-total strong"><td>{t('Closing Balance')}</td><td /><td />{num(statement.closing, fmtMoney)}</tr>
    </>}
  </tbody>;
}

export function CashFlow({ db, period, companyId, analyticAccountIds, money: moneyProp }) {
  const currentCo = (companyId && companyId !== 'all') ? Number(companyId) : period?.company_id;
  const fmtMoney = moneyProp ?? reportMoney(db, currentCo);
  const [open, setOpen] = useState(() => new Set());
  const r = cashFlow(db, currentCo ? { ...period, company_id: currentCo, analyticAccountIds } : { ...period, analyticAccountIds });
  const keys = ['operating', 'investing', 'financing', ...((r.unclassified !== 0 || r.lines.some((l) => l.section === 'unclassified')) ? ['unclassified'] : [])];
  const section = (key, title) => (
    <>
      <tr className="rep-section"><td><button type="button" className="btn sm" aria-expanded={open.has(key)} onClick={() => setOpen((prev) => toggleReportFold(prev, key))}><span className="caret">{open.has(key) ? '▾' : '▸'}</span> {t(title)}</button></td>{num(r[key], fmtMoney)}</tr>
      {r.lines.filter((l) => l.section === key).map((l) => (
        <tr key={`${key}-${l.account.id}`} className={open.has(key) ? "rep-detail" : "rep-detail report-folded-row"}><td><a href={`#/open/account.account/${l.account.id}`}>{l.account.code} {l.account.name}</a></td>{num(l.amount, fmtMoney)}</tr>
      ))}
    </>
  );
  return (
    <tbody>
      <tr className="no-export"><td colSpan={2}><ReportFoldAll keys={keys} open={open} onToggle={() => setOpen((prev) => toggleAllReportFolds(prev, keys))} /></td></tr>
      <tr className="rep-total"><td>{t('Cash at the beginning of the period')}</td>{num(r.opening, fmtMoney)}</tr>
      {section('operating', 'Operating Activities')}
      {section('investing', 'Investing Activities')}
      {section('financing', 'Financing Activities')}
      {(r.unclassified !== 0 || r.lines.some((l) => l.section === 'unclassified')) && section('unclassified', 'Unclassified')}
      <tr className="rep-total"><td>{t('Net Change in Cash')}</td>{num(r.net, fmtMoney)}</tr>
      <tr className="rep-total strong"><td>{t('Cash at the end of the period')}</td>{num(r.closing, fmtMoney)}</tr>
    </tbody>
  );
}

export function ExecutiveSummary({ db, period, companyId, analyticAccountIds, money: moneyProp }) {
  const currentCo = (companyId && companyId !== 'all') ? Number(companyId) : period?.company_id;
  const fmtMoney = moneyProp ?? reportMoney(db, currentCo);
  const s = executiveSummary(db, { ...period, ...(currentCo ? { company_id: currentCo } : {}), analyticAccountIds });
  const rows = [
    ['Revenue', fmtMoney(s.revenue)], ['Gross Profit', fmtMoney(s.grossProfit)], ['Net Profit', fmtMoney(s.netProfit)],
    ['Cash', fmtMoney(s.cash)], ['Receivables', fmtMoney(s.receivables)], ['Payables', fmtMoney(s.payables)],
    ['Current Ratio', s.currentRatio == null ? '—' : s.currentRatio.toFixed(2)], ['Gross Margin', pct(s.grossMargin)], ['Net Margin', pct(s.netMargin)],
    ['Days Sales Outstanding', s.dso ?? '—'],
  ];
  return <tbody>{rows.map(([label, value]) => <tr key={label} className="rep-detail"><td>{t(label)}</td><td className="num">{value}</td></tr>)}</tbody>;
}
