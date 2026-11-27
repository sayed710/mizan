import { Fragment, useState } from 'react';
import { search } from '../orm.js';
import { accountJournalItemsHref, compareConfigurableReport, findStatementReport, isExpandableLine, reportAccountHierarchy, reportLineKey, targetCompanyIds } from '../models/configurableReports.js';
import { currentCompany, documentCompany } from '../models/company.js';
import { today } from '../models/common.js';
import { useDb } from '../store.js';
import { t } from '../i18n.js';
import { money } from '../ui.jsx';
import { downloadCsv } from '../csv.js';
import { downloadXlsx } from '../xlsx.js';
import { CompanySelect, reportCompanyScope } from './reportCompany.jsx';
import { periodsFor, selectedOptionIds } from './reportCompare.js';
import { customPeriodError, reportPeriodRange } from './reportNavigation.js';
import { ReportPrintView, ReportFoldAll } from './FinancialReportPrint.jsx';
import { toggleReportFold, toggleAllReportFolds } from './reportFold.js';

export function scaledReportAmount(value, unit = 'decimals') {
  if (value == null) return null;
  const divisor = unit === 'thousands' ? 1000 : unit === 'millions' ? 1000000 : 1;
  const precision = unit === 'decimals' ? 100 : 1;
  const scaled = Number(value) / divisor;
  return Math.sign(scaled) * Math.round((Math.abs(scaled) + Number.EPSILON) * precision) / precision;
}

export function linePercentage(value, base) {
  return value == null || base == null || base === 0 ? null : Math.round(value / base * 10000) / 100;
}

function RowCells({ values, variance, showVariance, showGrowth, growthDisplay, lineComparison, baseValue, unit, greenOnPositive }) {
  return (
    <>
      {values.map((value, index) => <td className="num" key={index}>{value == null ? '' : unit === 'decimals' ? money(value) : scaledReportAmount(value, unit).toLocaleString()}</td>)}
      {lineComparison && <td className="num">{linePercentage(values[0], baseValue) == null ? '' : `${linePercentage(values[0], baseValue)}${t('%')}`}</td>}
      {showVariance && (
        <>
          <td className="num">{variance?.amount == null ? '' : unit === 'decimals' ? money(variance.amount) : scaledReportAmount(variance.amount, unit).toLocaleString()}</td>
          {showGrowth && <td className="num" style={variance?.amount == null || greenOnPositive == null ? undefined : { color: (variance.amount >= 0) === greenOnPositive ? 'green' : 'red' }}>{growthDisplay === 'amount' ? (variance?.amount == null ? '' : unit === 'decimals' ? money(variance.amount) : scaledReportAmount(variance.amount, unit).toLocaleString()) : (variance?.pct == null ? '' : `${variance.pct}${t('%')}`)}</td>}
        </>
      )}
    </>
  );
}

/** Resolve the company IDs covered by a CompanySelect value. */
function selectedCompanyIds(companies, selectedCompany) {
  return selectedCompany === 'all' ? companies.map((c) => c.id) : [Number(selectedCompany)];
}

/** Filter ledgers (account.journal.group) to those belonging to the given company IDs. */
function scopedLedgers(db, companyIds) {
  return search(db, 'account.journal.group')
    .filter((item) => companyIds.includes(item.company_id ?? 1))
    .sort((a, b) => (a.sequence ?? 10) - (b.sequence ?? 10));
}

/** Filter journals to the selected company scope and optional active ledger. */
function scopedJournals(db, companyIds, ledger) {
  return search(db, 'account.journal').filter(
    (j) => (!j.company_id || companyIds.includes(j.company_id)) && (!ledger || j.journal_group_id === ledger.id),
  );
}

export { reportLineKey };

export function reportHierarchyRows(db, line, openCodes) {
  const rows = [];
  const visit = (nodes, depth) => {
    for (const node of nodes) {
      if (node.group) {
        const key = `${reportLineKey(line)}:group:${node.group.id}`;
        const previous = node.values.at(-2);
        const current = node.values.at(-1);
        const variance = node.values.length > 1 ? { amount: current - previous, pct: previous ? Math.round((current - previous) / Math.abs(previous) * 10000) / 100 : null } : null;
        rows.push({ ...node, key, depth, variance });
        if (openCodes.has(key)) visit(node.children, depth + 1);
      } else rows.push({ ...node, depth });
    }
  };
  visit(reportAccountHierarchy(db, line.accountRows), 1);
  return rows;
}

/** Build structured CSV/XLSX rows from computed report data (preserving hierarchy indentation and numeric values). */
export function configurableReportExportRows(data, openCodes = new Set(), unit = 'decimals') {
  if (!data) return [];
  const headerLabels = [...data.headers, ...(data.lineComparison ? ['%'] : []), ...(data.showVariance ? ['Variance', ...(data.showGrowth !== false ? [data.growthDisplay === 'amount' ? 'Amount' : '%'] : [])] : [])]
    .map((header) => header.split(' ').map((part) => t(part)).join(' '));
  if (data.unitLabel) for (let index = 0; index < data.headers.length; index++) headerLabels[index] += ` (${data.unitLabel})`;
  const rows = [[t('Report Lines'), ...headerLabels]];
  const formatVariance = (variance) => (
    data.showVariance
      ? [variance?.amount == null ? '' : scaledReportAmount(variance.amount, unit), ...(data.showGrowth !== false ? [data.growthDisplay === 'amount' ? (variance?.amount == null ? '' : scaledReportAmount(variance.amount, unit)) : (variance?.pct == null ? '' : `${variance.pct}${t('%')}`)] : [])]
      : []
  );
  const indent = (depth, label) => `${'  '.repeat(Math.max(0, Number(depth) || 0))}${label}`;
  for (const line of data.rows) {
    const depth = Number(line.depth) || 0;
    rows.push([
      indent(depth, t(line.name)),
      ...line.values.map((v) => (v == null ? '' : scaledReportAmount(v, unit))),
      ...(data.lineComparison ? [linePercentage(line.values[0], data.baseValue) == null ? '' : `${linePercentage(line.values[0], data.baseValue)}${t('%')}`] : []),
      ...formatVariance(line.variance),
    ]);
    if (isExpandableLine(line) && openCodes?.has(reportLineKey(line))) {
      for (const acc of data.hierarchyDb ? reportHierarchyRows(data.hierarchyDb, line, openCodes) : line.accountRows.map((item) => ({ ...item, depth: 1 }))) {
        rows.push([
          indent(depth + acc.depth, acc.group ? `${acc.group.code_prefix_start ?? ''} ${acc.group.name}` : `${acc.account.code} ${acc.account.name}`),
          ...acc.values.map((v) => (v == null ? '' : scaledReportAmount(v, unit))),
          ...(data.lineComparison ? [linePercentage(acc.values[0], data.baseValue) == null ? '' : `${linePercentage(acc.values[0], data.baseValue)}${t('%')}`] : []),
          ...formatVariance(acc.variance),
        ]);
      }
    }
  }
  return rows;
}

/** Render an editable account.report either by record ID or by standard statement kind ('pnl' / 'balance'). */
export function ConfigurableReportPage({ id, statementKind = null, title = null }) {
  const sourceDb = useDb();
  const initialReport = statementKind ? findStatementReport(sourceDb, statementKind) : (sourceDb.records['account.report'] ?? []).find((item) => item.id === Number(id));
  const initialFilter = initialReport?.default_opening_date_filter ?? (statementKind === 'balance' ? 'today' : 'this_year');
  const initialPeriodKey = ({ this_year: 'year', this_quarter: 'quarter', this_month: 'month', today: 'today', previous_month: 'previous_month', previous_quarter: 'previous_quarter', previous_year: 'previous_year' })[initialFilter] ?? 'year';
  const [companyId, setCompanyId] = useState('all');
  const [periodKey, setPeriodKey] = useState(initialPeriodKey);
  const [comparison, setComparison] = useState('none');
  const [roundingUnit, setRoundingUnit] = useState('decimals');
  const [hierarchy, setHierarchy] = useState(initialReport?.filter_hierarchy === 'by_default');
  const [baseLine, setBaseLine] = useState('');
  const [growthDisplay, setGrowthDisplay] = useState('percent');
  const [ledgerId, setLedgerId] = useState('');
  const [journalIds, setJournalIds] = useState([]);
  const [includeUnposted, setIncludeUnposted] = useState(false);
  const [hideZeroLines, setHideZeroLines] = useState(initialReport?.filter_hide_0_lines === 'by_default');
  const [analyticAccountIds, setAnalyticAccountIds] = useState([]);
  const [from, setFrom] = useState(`${today().slice(0, 4)}-01-01`);
  const [to, setTo] = useState(statementKind ? today() : `${today().slice(0, 4)}-12-31`);
  const [groupId, setGroupId] = useState('');
  const [openCodes, setOpenCodes] = useState(() => new Set());
  const [isPrinting, setIsPrinting] = useState(false);

  const { companyDb, availableCompanies, companies, selectedCompany } = reportCompanyScope(sourceDb, companyId, { allowAll: true });
  const primaryCompanyId = selectedCompany === 'all' ? currentCompany(companyDb) : Number(selectedCompany);
  const companyIds = statementKind ? selectedCompanyIds(companies, selectedCompany) : null;

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

  const ledgers = statementKind ? scopedLedgers(companyDb, companyIds) : [];
  const ledger = statementKind ? (ledgers.find((item) => item.id === Number(ledgerId)) ?? null) : null;
  const availableJournals = statementKind ? scopedJournals(companyDb, companyIds, ledger) : [];
  const selectedJournalIds = statementKind ? journalIds.filter((jId) => availableJournals.some((j) => j.id === jId)) : [];
  const targetJournalIds = statementKind && (selectedJournalIds.length || ledger)
    ? (selectedJournalIds.length ? selectedJournalIds : availableJournals.map((journal) => journal.id))
    : null;
  const onCompanyChange = (nextCompany) => {
    setCompanyId(nextCompany);
    if (!statementKind) return;
    const nextIds = selectedCompanyIds(companies, nextCompany);
    const nextPrimaryId = nextCompany === 'all' ? currentCompany(companyDb) : Number(nextCompany);
    const nextReport = findStatementReport(companyDb, statementKind, nextPrimaryId) ?? findStatementReport(companyDb, statementKind);
    const nextLedger = scopedLedgers(companyDb, nextIds).find((item) => item.id === Number(ledgerId)) ?? null;
    if (!nextLedger && ledgerId) setLedgerId('');
    const allowedJournalIds = new Set(scopedJournals(companyDb, nextIds, nextLedger).map((j) => j.id));
    setJournalIds((prev) => prev.filter((jId) => allowedJournalIds.has(jId)));
    const nextAnalytic = search(companyDb, 'account.analytic.account').filter((a) => !a.company_id || nextIds.includes(a.company_id));
    const allowedAnalyticIds = new Set(nextAnalytic.map((a) => a.id));
    setAnalyticAccountIds((prev) => prev.filter((id) => allowedAnalyticIds.has(id)));
    if (groupId && nextReport) {
      const nextGroups = search(companyDb, 'account.report.horizontal.group').filter((g) => (
        (g.company_id ?? 1) === nextPrimaryId
        && ((g.report_ids ?? []).includes(nextReport.id) || !(g.report_ids ?? []).length)
      ));
      if (!nextGroups.some((g) => g.id === Number(groupId))) setGroupId('');
    }
  };
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

  const preset = periodKey.startsWith('previous_') ? periodKey.slice(9) : periodKey;
  const period = periodKey === 'custom' ? { from: report.filter_date_range === false ? '' : from, to }
    : periodKey === 'today' ? { from: today(), to: today() }
      : reportPeriodRange(companyDb, preset, { companyId: primaryCompanyId, offset: periodKey.startsWith('previous_') ? -1 : 0 });
  const comparable = periodKey !== 'all';
  const activePeriodKey = ['month', 'quarter', 'year'].includes(periodKey) ? periodKey : 'custom';
  const periodError = customPeriodError(activePeriodKey, period, { requireFrom: report.filter_date_range !== false && comparable && comparison !== 'none' && comparison !== 'report_line' });
  const canComputePeriods = !periodError;
  const reportCompany = report.company_id ?? 1;
  const groups = comparable
    ? search(companyDb, 'account.report.horizontal.group').filter((g) => (
      (g.company_id ?? 1) === (statementKind ? primaryCompanyId : reportCompany)
      && ((g.report_ids ?? []).includes(report.id) || (statementKind && !(g.report_ids ?? []).length))
    ))
    : [];
  const hasGroupSelection = comparable && String(groupId ?? '').trim() !== '';
  const group = hasGroupSelection ? (groups.find((g) => g.id === Number(groupId)) ?? null) : null;
  const groupSelectionError = hasGroupSelection && !group ? 'Horizontal group is not available for this report' : null;
  const analyticAccounts = search(companyDb, 'account.analytic.account').filter(
    (a) => !a.company_id || (statementKind ? companyIds.includes(a.company_id) : a.company_id === reportCompany),
  );
  let data = null;
  let computeError = null;
  if (!periodError && !groupSelectionError) {
    try {
      const comparisonPeriod = period.from ? period : { ...period, from: period.to };
      const periods = comparable && comparison !== 'none' && comparison !== 'report_line' && canComputePeriods
        ? (statementKind && activePeriodKey !== 'custom'
          ? periodsFor(activePeriodKey, comparison, comparisonPeriod, { db: companyDb, companyId: primaryCompanyId })
          : periodsFor(activePeriodKey, comparison, comparisonPeriod))
        : [{ ...period, label: '' }];
      data = compareConfigurableReport(
        db,
        report,
        periods,
        period,
        group,
        { companyIds, analyticAccountIds, includeUnposted, hideZeroLines, includeZeroRows: Boolean(statementKind) },
      );
      data.showGrowth = report.filter_growth_comparison !== false && data.showVariance;
      data.growthDisplay = growthDisplay;
      data.lineComparison = comparison === 'report_line';
      data.baseValue = data.rows.find((line) => reportLineKey(line) === baseLine)?.values[0] ?? null;
      if (hierarchy && report.filter_hierarchy !== 'never') data.hierarchyDb = db;
    } catch (error) {
      console.error('Could not compute configurable report:', error, {
        reportId: report.id,
        statementKind,
        period,
        comparison,
      });
      computeError = error?.message || 'Could not compute report';
    }
  }
  const inlineError = periodError ?? groupSelectionError ?? computeError;

  const expandableCodes = data ? data.rows.filter(isExpandableLine).flatMap((line) => {
    const keys = [reportLineKey(line)];
    const visit = (nodes) => nodes.forEach((node) => { if (node.group) { keys.push(`${reportLineKey(line)}:group:${node.group.id}`); visit(node.children); } });
    if (data.hierarchyDb) visit(reportAccountHierarchy(db, line.accountRows));
    return keys;
  }) : [];
  const toggle = (code) => setOpenCodes((prev) => toggleReportFold(prev, code));

  const exportCsv = () => {
    if (!data) return;
    const baseName = statementKind || report.code || report.name || 'report';
    downloadCsv(`${String(baseName).toLowerCase().replace(/\s+/g, '_')}.csv`, configurableReportExportRows(data, openCodes, roundingUnit));
  };

  const exportXlsx = () => {
    if (!data) return;
    const baseName = statementKind || report.code || report.name || 'report';
    const sheetName = title || report.name || baseName;
    const columnTypes = [
      'text',
      ...data.headers.map(() => 'number'),
      ...(data.lineComparison ? ['text'] : []),
      ...(data.showVariance ? ['number', ...(data.showGrowth ? [growthDisplay === 'amount' ? 'number' : 'text'] : [])] : []),
    ];
    downloadXlsx(
      `${String(baseName).toLowerCase().replace(/\s+/g, '_')}.xlsx`,
      configurableReportExportRows(data, openCodes, roundingUnit),
      { sheetName, columnTypes },
    );
  };

  const printCompany = isPrinting ? documentCompany(companyDb, { company_id: statementKind ? primaryCompanyId : reportCompany }) : null;
  const currencyCompany = (companyDb.records['res.company'] ?? []).find((company) => company.id === (statementKind ? primaryCompanyId : reportCompany));
  const currency = (companyDb.records['res.currency'] ?? []).find((item) => item.id === (currencyCompany?.currency_id ?? companyDb.settings?.base_currency_id));
  const currencySymbol = currency?.symbol || currency?.name || '';
  const unitLabel = ({ decimals: `.${currencySymbol}`, units: currencySymbol, thousands: `k${currencySymbol}`, millions: `M${currencySymbol}` })[roundingUnit];
  if (data) data.unitLabel = unitLabel;
  const scopedCompanyIds = isPrinting
    ? targetCompanyIds(companyDb, { ...report, company_id: reportCompany }, group, { companyIds })
    : [];
  const printCompanies = isPrinting
    ? (scopedCompanyIds.length
        ? scopedCompanyIds.map((cId) => documentCompany(companyDb, { company_id: cId }) || companies.find((c) => c.id === cId)).filter(Boolean)
        : (printCompany ? [printCompany] : []))
    : null;
  const controls = (
    <>
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
                <option value="today">{t('Today')}</option>
                <option value="previous_month">{t('Last Month')}</option>
                <option value="previous_quarter">{t('Last Quarter')}</option>
                <option value="previous_year">{t('Last Year')}</option>
                <option value="all">{t('All Dates')}</option>
                <option value="custom">{t('Custom Period')}</option>
              </select>
            </label>
            {periodKey === 'custom' && (
              <>
                {report.filter_date_range !== false && <label>{t('From')}<input aria-label={t('From')} type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>}
                <label>{t('To')}<input aria-label={t('To')} type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
              </>
            )}
            <label className="inline-select">
              {t('Ledger')}
              <select aria-label={t('Ledger')} value={ledger ? String(ledger.id) : ''} onChange={(e) => { setLedgerId(e.target.value); setJournalIds([]); }}>
                <option value="">{t('All Ledgers')}</option>
                {ledgers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>
            <label className="inline-select">
              {t('Journals')}
              <select aria-label={t('Journals')} multiple value={selectedJournalIds.map(String)} onChange={(e) => setJournalIds(selectedOptionIds(e))}>
                {availableJournals.map((item) => <option key={item.id} value={item.id}>{item.name} ({item.code})</option>)}
              </select>
            </label>
            {availableCompanies.length > 1 && (
              <CompanySelect companies={companies} value={selectedCompany} onChange={onCompanyChange} allowAll />
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
            {comparable && (report.filter_period_comparison !== false || report.filter_line_comparison) && (
              <label className="inline-select">
                {t('Comparison')}
                <select value={comparison} onChange={(e) => { setComparison(e.target.value); if (e.target.value !== 'none') setGroupId(''); }}>
                  <option value="none">{t('No comparison')}</option>
                  {report.filter_period_comparison !== false && <><option value="previous">{t('Previous Period')}</option><option value="lastYear">{t('Same Period Last Year')}</option><option value="last3">{t('Last 3 Periods')}</option></>}
                  {report.filter_line_comparison && <option value="report_line">{t('Percentage of')}</option>}
                </select>
              </label>
            )}
            {comparable && (groups.length > 0 || hasGroupSelection) && (
              <label className="inline-select">
                {t('Horizontal Group')}
                <select aria-label={t('Horizontal Group')} value={group ? String(group.id) : String(groupId)} onChange={(e) => { setGroupId(e.target.value); if (e.target.value) setComparison('none'); }}>
                  <option value="">{t('None')}</option>
                  {groups.map((g) => <option value={g.id} key={g.id}>{g.name}</option>)}
                </select>
              </label>
            )}
            {!periodError && <span className="muted">{period.from ? `${period.from} → ${period.to}` : `≤ ${period.to}`}</span>}
          </>
        ) : (
          <>
            <label>
              {t('Horizontal Group')}
              <select aria-label={t('Horizontal Group')} value={group ? String(group.id) : String(groupId)} onChange={(e) => { setGroupId(e.target.value); if (e.target.value) setComparison('none'); }}>
                <option value="">{t('No Group')}</option>
                {groups.map((g) => <option value={g.id} key={g.id}>{g.name}</option>)}
              </select>
            </label>
            <label>{t('Period')}<select value={periodKey} onChange={(e) => setPeriodKey(e.target.value)}>
              <option value="year">{t('This Year')}</option><option value="quarter">{t('This Quarter')}</option><option value="month">{t('This Month')}</option><option value="today">{t('Today')}</option><option value="previous_month">{t('Last Month')}</option><option value="previous_quarter">{t('Last Quarter')}</option><option value="previous_year">{t('Last Year')}</option><option value="custom">{t('Custom Period')}</option>
            </select></label>
            {report.filter_date_range !== false && <label>{t('From')}<input aria-label={t('From')} type="date" value={periodKey === 'custom' ? from : period.from} onChange={(e) => { setFrom(e.target.value); setTo(period.to); setPeriodKey('custom'); }} /></label>}
            <label>{t('To')}<input aria-label={t('To')} type="date" value={periodKey === 'custom' ? to : period.to} onChange={(e) => { setFrom(period.from); setTo(e.target.value); setPeriodKey('custom'); }} /></label>
            {comparable && (report.filter_period_comparison !== false || report.filter_line_comparison) && (
              <label className="inline-select">
                {t('Comparison')}
                <select aria-label={t('Comparison')} value={comparison} onChange={(e) => { setComparison(e.target.value); if (e.target.value !== 'none') setGroupId(''); }}>
                  <option value="none">{t('No comparison')}</option>
                  {report.filter_period_comparison !== false && <><option value="previous">{t('Previous Period')}</option><option value="lastYear">{t('Same Period Last Year')}</option><option value="last3">{t('Last 3 Periods')}</option></>}
                  {report.filter_line_comparison && <option value="report_line">{t('Percentage of')}</option>}
                </select>
              </label>
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
          </>
        )}
        <label className="inline-select">
          <input type="checkbox" checked={includeUnposted} onChange={(e) => setIncludeUnposted(e.target.checked)} /> {t('Include Unposted Entries')}
        </label>
        <label>{t('Rounding Unit')}<select value={roundingUnit} onChange={(e) => setRoundingUnit(e.target.value)}>
          <option value="decimals">{t('Decimals')} (.{currencySymbol})</option><option value="units">{t('Units')} ({currencySymbol})</option><option value="thousands">{t('Thousands')} (k{currencySymbol})</option><option value="millions">{t('Millions')} (M{currencySymbol})</option>
        </select></label>
        {report.filter_hierarchy !== 'never' && <label><input type="checkbox" checked={hierarchy} onChange={(event) => setHierarchy(event.target.checked)} /> {t('Account Parents')}</label>}
        {comparison === 'report_line' && data && <label>{t('Percentage of')}<select aria-label={t('Percentage of')} value={baseLine} onChange={(event) => setBaseLine(event.target.value)}><option value="">{t('None')}</option>{data.rows.map((line) => <option key={reportLineKey(line)} value={reportLineKey(line)}>{t(line.name)}</option>)}</select></label>}
        {data?.showGrowth && <label>{t('Comparison in')}<select aria-label={t('Comparison in')} value={growthDisplay} onChange={(event) => setGrowthDisplay(event.target.value)}><option value="percent">{t('Percentage')}</option><option value="amount">{t('Amount')}</option></select></label>}
        {report.filter_hide_0_lines !== 'never' && <label className="inline-select">
          <input type="checkbox" checked={hideZeroLines} onChange={(e) => setHideZeroLines(e.target.checked)} /> {t('Hide lines at 0')}
        </label>}
        <span className="spacer" />
        {report.filter_unfold_all !== false && <ReportFoldAll keys={expandableCodes} open={openCodes} onToggle={() => setOpenCodes((prev) => toggleAllReportFolds(prev, expandableCodes))} />}
        <button type="button" className="btn sm" disabled={!data} onClick={() => setIsPrinting(true)}>{t('Print')}</button>
        <button type="button" className="btn sm" disabled={!data} onClick={exportCsv}>{t('Download CSV')}</button>
        <button type="button" className="btn sm" disabled={!data} onClick={exportXlsx}>{t('Export XLSX')}</button>
      </div>
      {inlineError && (
        <div className="alert" role="alert" style={{ margin: '0 16px 12px' }}>
          {t(inlineError)}
        </div>
      )}
    </>
  );

  return (
    <ReportPrintView
      active={isPrinting && Boolean(data)}
      company={printCompany}
      companies={printCompanies}
      title={statementKind ? t(title || report.name) : report.name}
      subtitle={periodError ? '' : `${period.from ? `${period.from} → ${period.to}` : `≤ ${period.to}`} · ${unitLabel}`}
      controls={controls}
      onBack={() => setIsPrinting(false)}
    >
      {data && (
        <div className="list-wrap">
          <table className="list report">
            <thead>
              <tr>
                <th>{t('Report Lines')}</th>
                {[...data.headers, ...(data.lineComparison ? ['%'] : []), ...(data.showVariance ? ['Variance', ...(data.showGrowth ? [growthDisplay === 'amount' ? 'Amount' : '%'] : [])] : [])].map((header) => (
                  <th className="num" key={header}>{header.split(' ').map((part) => t(part)).join(' ')}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((line) => {
                const lineKey = reportLineKey(line);
                const canExpand = isExpandableLine(line);
                const isOpen = canExpand && openCodes.has(lineKey);
                const rowClass = [line.strong ? 'rep-total strong' : canExpand ? 'rep-section' : ''].filter(Boolean).join(' ');
                return (
                  <Fragment key={lineKey}>
                    <tr
                      className={rowClass || undefined}
                      onClick={canExpand && !isPrinting ? () => toggle(lineKey) : undefined}
                      aria-expanded={canExpand && !isPrinting ? isOpen : undefined}
                    >
                      <td style={{ paddingInlineStart: `${line.depth * 1.5 + 0.75}rem` }}>
                        {canExpand && !isPrinting && <span className={isOpen ? 'caret fold-caret open' : 'caret fold-caret'} aria-hidden="true" />}
                        {t(line.name)}
                      </td>
                      <RowCells values={line.values} variance={line.variance} showVariance={data.showVariance} showGrowth={data.showGrowth} growthDisplay={growthDisplay} lineComparison={data.lineComparison} baseValue={data.baseValue} unit={roundingUnit} greenOnPositive={line.green_on_positive} />
                    </tr>
                    {isOpen && (data.hierarchyDb ? reportHierarchyRows(data.hierarchyDb, line, openCodes) : line.accountRows.map((item) => ({ ...item, depth: 1 }))).map((acc) => acc.group ? (
                      <tr key={acc.key} className="rep-section" onClick={isPrinting ? undefined : () => toggle(acc.key)} aria-expanded={openCodes.has(acc.key)}>
                        <td style={{ paddingInlineStart: `${(line.depth + acc.depth) * 1.5 + 0.75}rem` }}>{acc.group.code_prefix_start} {acc.group.name}</td>
                        <RowCells values={acc.values} variance={acc.variance} showVariance={data.showVariance} showGrowth={data.showGrowth} growthDisplay={growthDisplay} lineComparison={data.lineComparison} baseValue={data.baseValue} unit={roundingUnit} />
                      </tr>
                    ) : (
                      <tr
                        key={`${lineKey}:${acc.account.id}`}
                        className="rep-detail"
                        onClick={isPrinting ? undefined : () => { globalThis.location.hash = accountJournalItemsHref(acc.account.id); }}
                      >
                        <td style={{ paddingInlineStart: `${(line.depth + acc.depth) * 1.5 + 0.75}rem` }}>
                          {isPrinting ? `${acc.account.code} ${acc.account.name}` : (
                            <>
                              <a href={accountJournalItemsHref(acc.account.id)}>{acc.account.code} {acc.account.name}</a>
                              {' '}<a className="muted no-export" href={`#/open/account.account/${acc.account.id}`} aria-label={t('Open Account')} title={t('Open Account')} onClick={(e) => e.stopPropagation()}>↗</a>
                            </>
                          )}
                        </td>
                        <RowCells values={acc.values} variance={acc.variance} showVariance={data.showVariance} showGrowth={data.showGrowth} growthDisplay={growthDisplay} lineComparison={data.lineComparison} baseValue={data.baseValue} unit={roundingUnit} />
                      </tr>
                    ))}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </ReportPrintView>
  );
}
