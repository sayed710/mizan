import { Fragment, useRef, useState } from 'react';
import { search } from '../orm.js';
import { compareConfigurableReport, findStatementReport } from '../models/configurableReports.js';
import { currentCompany } from '../models/company.js';
import { today } from '../models/common.js';
import { useDb } from '../store.js';
import { t } from '../i18n.js';
import { money } from '../ui.jsx';
import { downloadCsv, tableToRows } from '../csv.js';
import { CompanySelect, reportCompanyScope } from './reportCompany.jsx';
import { periodsFor } from './reportCompare.js';
import { DEFAULT_REPORT_PERIOD, PERIODS } from './reportNavigation.js';

function RowCells({ values, variance, showVariance }) {
  return (
    <>
      {values.map((value, index) => <td className="num" key={index}>{money(value)}</td>)}
      {showVariance && (
        <>
          <td className="num">{variance?.amount == null ? '' : money(variance.amount)}</td>
          <td className="num">{variance?.pct == null ? t('n/a') : `${variance.pct}${t('%')}`}</td>
        </>
      )}
    </>
  );
}

/** Render an editable account.report either by record ID or by standard statement kind ('pnl' / 'balance'). */
export function ConfigurableReportPage({ id, statementKind = null, title = null }) {
  const sourceDb = useDb();
  const tableRef = useRef(null);
  const [companyId, setCompanyId] = useState('all');
  const [periodKey, setPeriodKey] = useState(DEFAULT_REPORT_PERIOD);
  const [comparison, setComparison] = useState('none');
  const [ledgerId, setLedgerId] = useState('');
  const [journalId, setJournalId] = useState('');
  const [analyticAccountIds, setAnalyticAccountIds] = useState([]);
  const [from, setFrom] = useState(`${today().slice(0, 4)}-01-01`);
  const [to, setTo] = useState(statementKind ? today() : `${today().slice(0, 4)}-12-31`);
  const [groupId, setGroupId] = useState('');
  const [openCodes, setOpenCodes] = useState(() => new Set());

  const { companyDb, availableCompanies, companies, selectedCompany } = reportCompanyScope(sourceDb, companyId, { allowAll: true });
  const primaryCompanyId = selectedCompany === 'all' ? currentCompany(companyDb) : Number(selectedCompany);
  const companyIds = statementKind
    ? (selectedCompany === 'all' ? companies.map((c) => c.id) : [Number(selectedCompany)])
    : null;

  const report = statementKind
    ? (findStatementReport(companyDb, statementKind, primaryCompanyId) ?? findStatementReport(companyDb, statementKind))
    : (companyDb.records['account.report'] ?? []).find((r) => r.id === Number(id) && r.active !== false);
  if (!report) {
    return (
      <main className="action">
        <h1>{t(title || 'Accounting Report')}</h1>
        <p>{t('Report not found')}</p>
      </main>
    );
  }

  const ledgers = statementKind ? search(companyDb, 'account.journal.group').sort((a, b) => (a.sequence ?? 10) - (b.sequence ?? 10)) : [];
  const ledger = statementKind ? ledgers.find((item) => item.id === Number(ledgerId)) : null;
  const availableJournals = statementKind
    ? (ledger ? search(companyDb, 'account.journal').filter((j) => (ledger.journal_ids ?? []).includes(j.id)) : search(companyDb, 'account.journal'))
    : [];
  const targetJournalIds = statementKind && (journalId || ledger)
    ? (journalId ? [Number(journalId)] : (ledger.journal_ids ?? []))
    : null;
  const db = targetJournalIds
    ? {
        ...companyDb,
        records: {
          ...companyDb.records,
          'account.move': (companyDb.records['account.move'] ?? []).filter((move) =>
            (!ledger || (move.company_id ?? 1) === ledger.company_id) && targetJournalIds.includes(move.journal_id),
          ),
        },
      }
    : companyDb;

  const period = statementKind ? (periodKey === 'custom' ? { from, to } : PERIODS[periodKey]()) : { from, to };
  const comparable = !statementKind || !['all', 'custom'].includes(periodKey);
  const reportCompany = report.company_id ?? 1;
  const groups = comparable
    ? search(companyDb, 'account.report.horizontal.group').filter((g) => (
      (g.company_id ?? 1) === (statementKind ? primaryCompanyId : reportCompany)
      && ((g.report_ids ?? []).includes(report.id) || (statementKind && !(g.report_ids ?? []).length))
    ))
    : [];
  const group = groups.find((g) => g.id === Number(groupId)) ?? null;
  const analyticAccounts = statementKind ? search(companyDb, 'account.analytic.account') : [];
  const periods = statementKind && comparable && comparison !== 'none'
    ? periodsFor(periodKey, comparison, today())
    : [{ ...period, label: '' }];
  const data = compareConfigurableReport(
    db,
    report,
    periods,
    period,
    group,
    { companyIds, analyticAccountIds: statementKind ? analyticAccountIds : [] },
  );

  const toggle = (code) => setOpenCodes((prev) => {
    const next = new Set(prev);
    if (next.has(code)) next.delete(code);
    else next.add(code);
    return next;
  });

  const exportCsv = () => {
    const baseName = statementKind || report.code || report.name || 'report';
    downloadCsv(`${String(baseName).toLowerCase().replace(/\s+/g, '_')}.csv`, tableToRows(tableRef.current));
  };

  return (
    <main className="action report-page">
      <div className="control-panel">
        <h1 className="cp-title">{statementKind ? t(title || report.name) : report.name}</h1>
        {statementKind ? (
          <>
            <label className="inline-select">
              {t('Period')}
              <select value={periodKey} onChange={(e) => setPeriodKey(e.target.value)}>
                <option value="month">{t('This Month')}</option>
                <option value="quarter">{t('This Quarter')}</option>
                <option value="year">{t('This Year')}</option>
                <option value="all">{t('All Dates')}</option>
                <option value="custom">{t('Custom Period')}</option>
              </select>
            </label>
            {periodKey === 'custom' && (
              <>
                <label>{t('From')}<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
                <label>{t('To')}<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
              </>
            )}
            <label className="inline-select">
              {t('Ledger')}
              <select aria-label={t('Ledger')} value={ledger ? String(ledger.id) : ''} onChange={(e) => { setLedgerId(e.target.value); setJournalId(''); }}>
                <option value="">{t('All Ledgers')}</option>
                {ledgers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>
            <label className="inline-select">
              {t('Journals')}
              <select aria-label={t('Journals')} value={journalId} onChange={(e) => setJournalId(e.target.value)}>
                <option value="">{t('All Journals')}</option>
                {availableJournals.map((item) => <option key={item.id} value={item.id}>{item.name} ({item.code})</option>)}
              </select>
            </label>
            {availableCompanies.length > 1 && (
              <CompanySelect companies={companies} value={selectedCompany} onChange={setCompanyId} allowAll />
            )}
            {analyticAccounts.length > 0 && (
              <label className="inline-select">
                {t('Analytic Accounts')}
                <select
                  aria-label={t('Analytic Accounts')}
                  multiple
                  value={analyticAccountIds}
                  onChange={(e) => setAnalyticAccountIds(Array.from(e.target.selectedOptions).map((o) => Number(o.value)))}
                >
                  {analyticAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </label>
            )}
            {comparable && (
              <label className="inline-select">
                {t('Comparison')}
                <select value={comparison} onChange={(e) => { setComparison(e.target.value); if (e.target.value !== 'none') setGroupId(''); }}>
                  <option value="none">{t('No comparison')}</option>
                  <option value="previous">{t('Previous Period')}</option>
                  <option value="lastYear">{t('Same Period Last Year')}</option>
                  <option value="last3">{t('Last 3 Periods')}</option>
                </select>
              </label>
            )}
            {comparable && groups.length > 0 && (
              <label className="inline-select">
                {t('Horizontal Group')}
                <select aria-label={t('Horizontal Group')} value={group?.id ?? ''} onChange={(e) => { setGroupId(e.target.value); if (e.target.value) setComparison('none'); }}>
                  <option value="">{t('None')}</option>
                  {groups.map((g) => <option value={g.id} key={g.id}>{g.name}</option>)}
                </select>
              </label>
            )}
            <span className="muted">{period.from ? `${period.from} → ${period.to}` : `≤ ${period.to}`}</span>
          </>
        ) : (
          <>
            <label>{t('From')}<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
            <label>{t('To')}<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
            <label>
              {t('Horizontal Group')}
              <select aria-label={t('Horizontal Group')} value={group?.id ?? ''} onChange={(e) => setGroupId(e.target.value)}>
                <option value="">{t('No Group')}</option>
                {groups.map((g) => <option value={g.id} key={g.id}>{g.name}</option>)}
              </select>
            </label>
          </>
        )}
        <span className="spacer" />
        <button type="button" className="btn sm" onClick={() => window.print()}>{t('Print')}</button>
        <button type="button" className="btn sm" onClick={exportCsv}>{t('Download CSV')}</button>
      </div>
      <div className="list-wrap">
        <table className="list report" ref={tableRef}>
          <thead>
            <tr>
              <th>{t('Report Lines')}</th>
              {[...data.headers, ...(data.showVariance ? ['Variance', '%'] : [])].map((header) => (
                <th className="num" key={header}>{header.split(' ').map((part) => t(part)).join(' ')}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((line) => {
              const canExpand = Boolean(line.foldable && line.accountRows.length);
              const isOpen = canExpand && openCodes.has(line.code);
              const rowClass = [line.strong ? 'rep-total strong' : canExpand ? 'rep-section' : ''].filter(Boolean).join(' ');
              return (
                <Fragment key={line.code}>
                  <tr
                    className={rowClass || undefined}
                    onClick={canExpand ? () => toggle(line.code) : undefined}
                    aria-expanded={canExpand ? isOpen : undefined}
                  >
                    <td style={{ paddingInlineStart: `${line.depth * 1.5 + 0.75}rem` }}>
                      {canExpand && <span className="caret">{isOpen ? '▾' : '▸'} </span>}
                      {t(line.name)}
                    </td>
                    <RowCells values={line.values} variance={line.variance} showVariance={data.showVariance} />
                  </tr>
                  {isOpen && line.accountRows.map((acc) => (
                    <tr key={`${line.code}:${acc.account.id}`} className="rep-detail">
                      <td style={{ paddingInlineStart: `${(line.depth + 1) * 1.5 + 0.75}rem` }}>
                        <a href={`#/open/account.account/${acc.account.id}`}>{acc.account.code} {acc.account.name}</a>
                      </td>
                      <RowCells values={acc.values} variance={acc.variance} showVariance={data.showVariance} />
                    </tr>
                  ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </main>
  );
}
