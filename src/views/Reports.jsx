import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { read, search, write } from '../orm.js';
import { today, validDate } from '../models/common.js';
import { depreciationReport } from '../models/assets.js';
import { deferredReport, trialOpeningItems } from '../models/reports.js';
import { deferredSettings, generateGroupedEntries } from '../models/deferred.js';
import { filterByAnalytic, journalItems } from '../models/ledger.js';
import { FollowUpWizard } from './FollowUpLetter.jsx';
import { BUCKETS, agedBalance, agedReportDate, analyticActualLines, analyticActuals, analyticReportAmount, followUps, followUpCompanies, followUpLevel, followUpText, formatFollowUpTotals, levelChannel, logManualFollowUp, openManualFollowUp, taxReport, taxItemKey, taxesByTax, taxesByGrid } from '../models/finance.js';
import { AgedDetailRow } from './aged-detail-row.js';
import { reportingBookedAmount } from '../models/money.js';
import { budgetReport, rootPlanMap, rootAnalyticPlans } from '../models/analyticplus.js';
import { currentCompany, documentCompany } from '../models/company.js';
import { checkInalterability } from '../models/hash_chain.js';
import { journalAudit } from '../models/journal_audit.js';
import { commit, companiesOf, getDb, isServer, listAuditAll, serverAction, useDb } from '../store.js';
import { AUDIT_MODELS, auditTrailToCsv, collectAuditTrailRows } from '../models/auditTrail.js';
import { PAGE_SIZE, pageWindow } from './paging.js';
import { valuationReport } from '../models/valuation.js';
import { CashFlow, CustomerStatement, ExecutiveSummary, FiscalReport, PartnerLedger, TrialBalance } from './FinanceReports.jsx';
import { dateLocale, t } from '../i18n.js';
import { money, PagerButtons } from '../ui.jsx';
import { companyCurrencyRecord, findCompanyCurrencyRecord } from '../money.js';
import { downloadCsv, downloadXml, tableToRows } from '../csv.js';
import { downloadXlsx } from '../xlsx.js';
import { ReportPrintView, ReportFoldAll } from './FinancialReportPrint.jsx';
import { toggleReportFold, toggleAllReportFolds } from './reportFold.js';
import { TAX_RETURN_TEMPLATES, resolveTaxReturnTemplate, genericTaxRows, taxBoxItems, taxReturnBoxes, taxReturnToCsv, taxReturnToXml } from '../models/taxExport.js';
import { budgetCurrency, BudgetMoneyCell } from './budget-currency.js';
import { cashflowAnalyticColumns, cashflowColumns, detailReportColumns, executiveColumns, periodsFor, selectedOptionIds } from './reportCompare.js';
import { DEFAULT_REPORT_PERIOD, PERIODS, reportPage } from './reportNavigation.js';
import { statementUrl } from '../statementNavigation.js';
export { PERIODS };
import { UnrealizedCurrencies } from './UnrealizedCurrencies.jsx';
import { SalesReview } from './SalesReview.jsx';
import { JournalItems } from './JournalItems.jsx';
import { LoansAnalysis } from './LoansAnalysis.jsx';
import { Checks } from './Checks.jsx';
import { CashflowAnalysis } from './CashflowAnalysis.jsx';
import { CompanySelect, reportCompanyScope, reportMoney } from './reportCompany.jsx';
import { ConfigurableReportPage } from './ConfigurableReport.jsx';

// Periods are defined in reportNavigation.js and re-exported above.

function ComparisonCells({ values, variance, showVariance = true, format = null, money: fmtMoney = money }) {
  const formatVal = (v) => {
    if (v == null) return '—';
    if (format === 'ratio') return Number(v).toFixed(2);
    if (format === 'pct') return `${v}${t('%')}`;
    if (format === 'int') return String(v);
    return fmtMoney(v);
  };
  const formatDiff = (amt) => {
    if (amt == null) return '';
    if (format === 'ratio') return `${amt > 0 ? '+' : ''}${Number(amt).toFixed(2)}`;
    if (format === 'pct') return `${amt > 0 ? '+' : ''}${amt}${t('%')}`;
    if (format === 'int') return `${amt > 0 ? '+' : ''}${amt}`;
    return fmtMoney(amt);
  };
  const cells = values.map((value, i) => <td key={i} className="num">{formatVal(value)}</td>);
  if (!showVariance) return <>{cells}</>;
  const previous = values.at(-2);
  const current = values.at(-1);
  const amount = variance?.amount ?? (previous == null || current == null ? null : Math.round((current - previous) * 100) / 100);
  const pct = variance ? variance.pct : (amount != null && previous ? Math.round(amount / Math.abs(previous) * 10000) / 100 : null);
  return <>{cells}<td className="num">{formatDiff(amount)}</td><td className="num">{pct == null ? t('n/a') : `${pct}${t('%')}`}</td></>;
}

function Section({ title, total, rows, sign = 1, totals, variance, showVariance = true, preserveRows = false, isOpen, onToggle, money: fmtMoney = money }) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = isOpen !== undefined ? isOpen : localOpen;
  const toggle = () => {
    if (onToggle) onToggle();
    else setLocalOpen(!localOpen);
  };
  return (
    <>
      <tr className="rep-section" onClick={toggle} aria-expanded={open}>
        <td><span className="caret">{rows?.length ? (open ? '▾' : '▸') : ''}</span> {t(title)}</td>
        {totals ? <ComparisonCells values={totals} variance={variance} showVariance={showVariance} money={fmtMoney} /> : <td className="num">{fmtMoney(sign * total)}</td>}
      </tr>
      {(open || preserveRows) && rows?.map((r) => (
        <tr key={r.account.id} className={!open && preserveRows ? "rep-detail report-folded-row" : "rep-detail"}>
          <td><a href={`#/open/account.account/${r.account.id}`}>{r.account.code} {r.account.name}</a></td>
          {totals ? <ComparisonCells values={r.values} showVariance={showVariance} money={fmtMoney} /> : <td className="num">{fmtMoney(r.balance)}</td>}
        </tr>
      ))}
    </>
  );
}

const Total = ({ label, value, strong, values, variance, showVariance = true, format = null, money: fmtMoney = money }) => (
  <tr className={`rep-total ${strong ? 'strong' : ''}`}>
    <td>{t(label)}</td>
    {values ? <ComparisonCells values={values} variance={variance} showVariance={showVariance} format={format} money={fmtMoney} /> : <td className="num">{fmtMoney(value)}</td>}
  </tr>
);

function Comparison({ data, report, money: fmtMoney = money }) {
  const isCashFlow = report === 'cashflow';
  const showVariance = Boolean(data.variance);
  const [open, setOpen] = useState(() => new Set());
  const keys = isCashFlow ? data.sections.map((s) => s.title) : [];
  const colSpan = 1 + (data.headers?.length ?? 0) + (showVariance ? 2 : 0);
  const section = (i) => {
    const s = data.sections[i];
    return (
      <Section
        key={s.title}
        {...s}
        variance={data.variance?.[i]}
        showVariance={showVariance}
        preserveRows={isCashFlow}
        isOpen={isCashFlow ? open.has(s.title) : undefined}
        onToggle={isCashFlow ? () => setOpen((prev) => toggleReportFold(prev, s.title)) : undefined}
        money={fmtMoney}
      />
    );
  };
  const total = (i) => <Total key={data.totals[i].label} {...data.totals[i]} variance={data.variance?.[data.sections.length + i]} showVariance={showVariance} money={fmtMoney} />;
  return (
    <tbody>
      {isCashFlow && keys.length > 0 && (
        <tr className="no-export">
          <td colSpan={colSpan}>
            <ReportFoldAll keys={keys} open={open} onToggle={() => setOpen((prev) => toggleAllReportFolds(prev, keys))} />
          </td>
        </tr>
      )}
      {data.sections.map((_, i) => section(i))}
      {data.totals.map((_, i) => total(i))}
    </tbody>
  );
}

function Ledger({ db, period, analyticAccountIds, money: moneyProp }) {
  const fmtMoney = moneyProp ?? reportMoney(db, period?.company_id);
  const items = filterByAnalytic(journalItems(db, { ...period, includeClosing: false }), analyticAccountIds);
  // Same opening as the Trial Balance: accounts that do not carry forward restart at the fiscal-year start.
  const opening = period.from ? trialOpeningItems(db, filterByAnalytic(journalItems(db, { to: period.from, ...(period.reviewMode ? { reviewMode: period.reviewMode } : {}) }), analyticAccountIds).filter((l) => l.date < period.from), period.from) : [];
  const accounts = [...new Set([...items, ...opening].map((l) => l.account_id))]
    .map((id) => read(db, 'account.account', id)).filter(Boolean).sort((a, b) => a.code.localeCompare(b.code));
  const [open, setOpen] = useState(() => new Set());
  const toggle = (id) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  // Lines of every allowed company are translated into the active company's currency before being shown.
  const booked = (l, amount) => reportingBookedAmount(db, l, amount);
  const debitOf = (l) => booked(l, Number(l.debit) || 0);
  const creditOf = (l) => booked(l, Number(l.credit) || 0);
  const bal = (ls) => ls.reduce((s, l) => s + debitOf(l) - creditOf(l), 0);
  return (
    <tbody>
      {accounts.map((a) => {
        const lines = items.filter((l) => l.account_id === a.id).sort((x, y) => x.date.localeCompare(y.date));
        const start = bal(opening.filter((l) => l.account_id === a.id));
        let running = start;
        return [
          <tr key={a.id} className="rep-section" onClick={() => toggle(a.id)} aria-expanded={open.has(a.id)}>
            <td><span className="caret">{open.has(a.id) ? '▾' : '▸'}</span> {a.code} {a.name}</td>
            <td className="num">{fmtMoney(lines.reduce((s, l) => s + debitOf(l), 0))}</td>
            <td className="num">{fmtMoney(lines.reduce((s, l) => s + creditOf(l), 0))}</td>
            <td className="num">{fmtMoney(start + bal(lines))}</td>
          </tr>,
          ...(open.has(a.id) ? [
            <tr key={`${a.id}-open`} className="rep-detail"><td>{t('Initial Balance')}</td><td /><td /><td className="num">{fmtMoney(start)}</td></tr>,
            ...lines.map((l, i) => {
              running += debitOf(l) - creditOf(l);
              return (
                <tr key={`${a.id}-${i}`} className="rep-detail">
                  <td><a href={`#/open/account.move/${l.move_id}`}>{l.date} · {l.move_name}</a> <span className="muted">{l.name}</span></td>
                  <td className="num">{l.debit ? fmtMoney(debitOf(l)) : ''}</td>
                  <td className="num">{l.credit ? fmtMoney(creditOf(l)) : ''}</td>
                  <td className="num">{fmtMoney(running)}</td>
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

export function resolveTaxReportTemplate(db, companyId, companies = null) {
  if (companyId && companyId !== 'all') {
    const template = resolveTaxReturnTemplate(db, { company_id: Number(companyId) });
    return TAX_RETURN_TEMPLATES[template]?.mode === 'boxes' ? template : null;
  }
  const scopeCompanies = companies ?? (db.settings?.allowed_company_ids
    ? companiesOf(db).filter((c) => db.settings.allowed_company_ids.includes(c.id))
    : companiesOf(db));
  const templates = new Set(scopeCompanies.map((c) => resolveTaxReturnTemplate(db, { company_id: c.id })));
  if (templates.size === 1) {
    const single = [...templates][0];
    return TAX_RETURN_TEMPLATES[single]?.mode === 'boxes' ? single : null;
  }
  return null;
}

export function TaxReportTable({ db, period, returnRecord = null }) {
  const safeBase = String(returnRecord?.name || 'tax-return').replace(/[^a-zA-Z0-9_-]+/g, '-');
  const template = returnRecord?.tax_return_template;
  const isStatutory = Boolean(template && Object.hasOwn(TAX_RETURN_TEMPLATES, template) && TAX_RETURN_TEMPLATES[template].mode === 'boxes');
  const variant = isStatutory ? template : 'generic';
  const fmtMoney = reportMoney(db, returnRecord?.company_id ?? period?.company_id);
  return (
    <div className="list-wrap">
      {returnRecord && (
        <div className="row" style={{ marginBottom: 8 }}>
          <button type="button" className="btn sm" onClick={() => downloadCsv(`${safeBase}.csv`, taxReturnToCsv(db, returnRecord))}>{t('Export CSV')}</button>
          <button type="button" className="btn sm" onClick={() => downloadXlsx(`${safeBase}.xlsx`, taxReturnToCsv(db, returnRecord), { sheetName: safeBase, columnTypes: ['text', 'text', 'number', 'number'] })}>{t('Export XLSX')}</button>
          <button type="button" className="btn sm" onClick={() => downloadXml(`${safeBase}.xml`, taxReturnToXml(db, returnRecord))}>{t('Export XML')}</button>
        </div>
      )}
      <table className="list report">
        <thead>
          {isStatutory ? (
            <tr>
              <th>{t('Box')}</th>
              <th>{t('Description')}</th>
              <th className="num">{t('Base')}</th>
              <th className="num">{t('Tax')}</th>
            </tr>
          ) : (
            <tr>
              <th />
              <th className="num">{t('Base')}</th>
              <th className="num">{t('Tax')}</th>
            </tr>
          )}
        </thead>
        <Tax key={variant} db={db} period={period} variant={variant} money={fmtMoney} />
      </table>
    </div>
  );
}

/** The posted journal items behind one tax return box, shown under its row. */
function TaxBoxDetailRow({ db, returnOrPeriod, code, colSpan, money: fmtMoney = money }) {
  const { items, tax, base } = taxBoxItems(db, returnOrPeriod, code);
  const accountDisplay = (accId) => {
    const acc = read(db, 'account.account', accId);
    return acc ? `${acc.code} ${acc.name}` : '—';
  };
  return (
    <tr className="tax-drill no-export">
      <td colSpan={colSpan}>
        <table className="list report">
          <thead>
            <tr>
              <th>{t('Date')}</th>
              <th>{t('Journal Entry')}</th>
              <th>{t('Account')}</th>
              <th>{t('Partner')}</th>
              <th>{t('Label')}</th>
              <th className="num">{t('Tax')}</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0
              ? <tr><td colSpan={6}>{t('No records found.')}</td></tr>
              : items.map((it, idx) => (
                <tr key={`${it.move_id}-${it.account_id}-${idx}`}>
                  <td>{it.date}</td>
                  <td><a href={`#/open/account.move/${it.move_id}`}>{it.move_name}</a></td>
                  <td>{accountDisplay(it.account_id)}</td>
                  <td>{partnerName(db, it.partner_id)}</td>
                  <td>{it.name || '—'}</td>
                  <td className="num">{fmtMoney(it.tax)}</td>
                </tr>
              ))}
          </tbody>
          <tfoot>
            <tr className="rep-total"><td colSpan={5}>{t('Total')}</td><td className="num">{fmtMoney(tax)}</td></tr>
            <tr><td colSpan={5}>{t('Base')}</td><td className="num">{fmtMoney(base)}</td></tr>
          </tfoot>
        </table>
      </td>
    </tr>
  );
}

/** A box amount that toggles its drill-down row. */
function TaxAmountToggle({ value, open, onToggle, money: fmtMoney = money }) {
  return <button type="button" className="tax-drill-toggle" aria-expanded={open} onClick={onToggle}>{fmtMoney(value)}</button>;
}

export function Tax({ db, period, periods, companyId = 'all', variant = null, money: moneyProp }) {
  const effectiveCompanyId = companyId && companyId !== 'all' ? Number(companyId) : (period?.company_id ?? null);
  const fmtMoney = moneyProp ?? reportMoney(db, effectiveCompanyId);
  const effectivePeriod = effectiveCompanyId ? { ...period, company_id: effectiveCompanyId } : period;
  const countryTemplateKey = resolveTaxReportTemplate(db, companyId);
  const activeVariant = variant ?? (countryTemplateKey ?? 'generic');
  const [openBoxes, setOpenBoxes] = useState(() => new Set());
  const toggleBox = (code) => setOpenBoxes((prev) => {
    const next = new Set(prev);
    if (next.has(code)) next.delete(code);
    else next.add(code);
    return next;
  });

  if (periods) {
    const specs = periods.map((p) => ({ ...p, ...(effectiveCompanyId ? { company_id: effectiveCompanyId } : {}), tax_return_template: activeVariant }));
    const reports = specs.map((spec) => activeVariant === 'generic' ? genericTaxRows(taxesByTax(db, spec)) : taxReturnBoxes(db, spec).boxes);
    const rowKey = (row) => activeVariant === 'generic' ? taxItemKey({ ...row, tax_name: row.name }) : row.code;
    const rowsByReport = reports.map((rows) => new Map(rows.map((row) => [rowKey(row), row])));
    const keys = new Map(reports.flatMap((rows) => rows.map((row) => [rowKey(row), row])));
    const gridReports = activeVariant === 'generic' ? specs.map((spec) => taxesByGrid(db, spec)) : [];
    const gridsByReport = gridReports.map((rows) => new Map(rows.map((row) => [row.id, row])));
    const grids = new Map(gridReports.flatMap((rows) => rows.map((row) => [row.id, row])));
    const totals = specs.map((spec) => taxReport(db, spec));
    const renderRows = (rows) => rows.map((row) => <tr key={rowKey(row)} className="rep-detail">{activeVariant !== 'generic' && <td>{row.code}</td>}<td>{t(row.label ?? row.name)}</td>{rowsByReport.flatMap((byKey, index) => { const value = byKey.get(rowKey(row)); return ['base', 'tax'].map((key) => <td key={`${index}-${key}`} className="num">{fmtMoney(value?.[key] ?? 0)}</td>); })}</tr>);
    const section = (title) => <tr className="rep-section"><td>{t(title)}</td>{periods.flatMap((_, index) => [<td key={`${index}-base`} />, <td key={`${index}-tax`} />])}</tr>;
    const mergedRows = [...keys.values()];
    return <tbody>
      {activeVariant === 'generic' ? <>{section('Sales')}{renderRows(mergedRows.filter((row) => row.side === 'sale'))}{section('Purchases')}{renderRows(mergedRows.filter((row) => row.side === 'purchase'))}</> : renderRows(mergedRows)}
      {grids.size > 0 && section('Tax Grids')}
      {[...grids.values()].map((row) => <tr key={`grid-${row.id}`} className="rep-detail"><td>{row.name}</td>{gridsByReport.flatMap((byId, index) => { const value = byId.get(row.id); return ['base', 'tax'].map((key) => <td key={`${index}-${key}`} className="num">{fmtMoney(value?.[key] ?? 0)}</td>); })}</tr>)}
      {activeVariant === 'generic' && ['output', 'input', 'payable'].map((key) => <tr key={key} className={`rep-total ${key === 'payable' ? 'strong' : ''}`}><td>{t(key === 'output' ? 'Output Tax' : key === 'input' ? 'Input Tax' : 'Tax Payable')}</td>{totals.flatMap((total, index) => [<td key={`${index}-base`} />, <td key={`${index}-tax`} className="num">{fmtMoney(total[key])}</td>])}</tr>)}
    </tbody>;
  }

  if (activeVariant !== 'generic') {
    const returnSpec = { ...effectivePeriod, tax_return_template: activeVariant };
    const { boxes } = taxReturnBoxes(db, returnSpec);
    const templateSpec = TAX_RETURN_TEMPLATES[activeVariant];
    const payableCode = templateSpec?.boxes?.find((b) => b.kind === 'net_payable')?.code;
    return (
      <tbody>
        {boxes.map((b) => (
          <Fragment key={b.code}>
            <tr className={b.kind === 'total' ? `rep-total ${b.code === payableCode ? 'strong' : ''}` : 'rep-detail'}>
              <td>{b.code}</td>
              <td>{t(b.label)}</td>
              <td className="num">
                <TaxAmountToggle value={b.base} open={openBoxes.has(b.code)} onToggle={() => toggleBox(b.code)} money={fmtMoney} />
              </td>
              <td className="num">
                <TaxAmountToggle value={b.tax} open={openBoxes.has(b.code)} onToggle={() => toggleBox(b.code)} money={fmtMoney} />
              </td>
            </tr>
            {openBoxes.has(b.code) && (
              <TaxBoxDetailRow db={db} returnOrPeriod={returnSpec} code={b.code} colSpan={4} money={fmtMoney} />
            )}
          </Fragment>
        ))}
      </tbody>
    );
  }

  const r = taxReport(db, effectivePeriod);
  const byTax = taxesByTax(db, effectivePeriod);
  const grids = taxesByGrid(db, effectivePeriod);
  const genericReturnSpec = { ...effectivePeriod, tax_return_template: 'generic' };

  const rows = genericTaxRows(byTax);

  const renderSection = (title, rows) => (
    <>
      <tr className="rep-section"><td>{t(title)}</td><td /><td /></tr>
      {rows.map((x) => (
        <Fragment key={x.code}>
          <tr className="rep-detail">
            <td>{x.name}</td>
            <td className="num">
              <TaxAmountToggle value={x.base} open={openBoxes.has(x.code)} onToggle={() => toggleBox(x.code)} money={fmtMoney} />
            </td>
            <td className="num">
              <TaxAmountToggle value={x.tax} open={openBoxes.has(x.code)} onToggle={() => toggleBox(x.code)} money={fmtMoney} />
            </td>
          </tr>
          {openBoxes.has(x.code) && (
            <TaxBoxDetailRow db={db} returnOrPeriod={genericReturnSpec} code={x.code} colSpan={3} money={fmtMoney} />
          )}
        </Fragment>
      ))}
    </>
  );

  const renderTotalLine = (label, code, value, strong) => (
    <Fragment key={code}>
      <tr className={`rep-total ${strong ? 'strong' : ''}`}>
        <td>{t(label)}</td>
        <td />
        <td className="num">
          <TaxAmountToggle value={value} open={openBoxes.has(code)} onToggle={() => toggleBox(code)} money={fmtMoney} />
        </td>
      </tr>
      {openBoxes.has(code) && (
        <TaxBoxDetailRow db={db} returnOrPeriod={genericReturnSpec} code={code} colSpan={3} money={fmtMoney} />
      )}
    </Fragment>
  );

  return (
    <tbody>
      {renderSection('Sales', rows.filter((x) => x.side === 'sale'))}
      {renderSection('Purchases', rows.filter((x) => x.side === 'purchase'))}
      {grids.length > 0 && <tr className="rep-section"><td>{t('Tax Grids')}</td><td /><td /></tr>}
      {grids.map((x) => <tr key={x.id} className="rep-detail"><td>{x.name}</td><td className="num">{fmtMoney(x.base)}</td><td className="num">{fmtMoney(x.tax)}</td></tr>)}
      {renderTotalLine('Output Tax', 'TOTAL-OUT', r.output)}
      {renderTotalLine('Input Tax', 'TOTAL-IN', r.input)}
      {renderTotalLine('Tax Payable', 'PAYABLE', r.payable, true)}
    </tbody>
  );
}

function DetailComparison({ db, data, report, companyId, variant, money: fmtMoney = money }) {
  const [open, setOpen] = useState(null);
  const isStatutoryTax = report === 'tax' && variant !== 'generic';
  const width = (isStatutoryTax ? 2 : 1) + data.periods.length * (report === 'tax' ? 2 : 3);
  return <tbody>{data.rows.map((row) => <Fragment key={row.id}>
    <tr className={row.kind === 'total' ? 'rep-total' : row.kind === 'section' ? 'rep-section' : 'rep-detail'}>
      {isStatutoryTax && <td>{row.code ?? ''}</td>}
      <td>{row.accountId ? <a href={`#/open/account.account/${row.accountId}`}>{row.label}</a> : t(row.label)}</td>
      {row.kind === 'section' && row.columns.every((c) => !c?.values || c.values.every((v) => v == null))
        ? data.periods.flatMap((_, index) => (report === 'tax' ? [<td key={`${index}-0`} />, <td key={`${index}-1`} />] : [<td key={`${index}-0`} />, <td key={`${index}-1`} />, <td key={`${index}-2`} />]))
        : row.columns.flatMap((column, index) => (column?.values ?? Array(report === 'tax' ? 2 : 3).fill(0)).map((value, j) => (
            <td key={`${index}-${j}`} className="num">
              {report === 'tax' && column?.code ? (
                <TaxAmountToggle value={value} open={open === `${row.id}:${index}`} onToggle={() => setOpen(open === `${row.id}:${index}` ? null : `${row.id}:${index}`)} money={fmtMoney} />
              ) : (
                value == null ? '' : fmtMoney(value)
              )}
            </td>
          ))
      )}
    </tr>
    {report === 'tax' && row.columns.map((column, index) => column?.code && open === `${row.id}:${index}` ? (
      <TaxBoxDetailRow key={index} db={db} returnOrPeriod={{ ...data.periods[index], company_id: companyId === 'all' ? null : Number(companyId), tax_return_template: variant }} code={column.code} colSpan={width} money={fmtMoney} />
    ) : null)}
  </Fragment>)}</tbody>;
}

const Aged = (kind) => function AgedBody({ db, period, companyId, agingOptions, partnerIds, agedData = null, money: moneyProp }) {
  const fmtMoney = moneyProp ?? reportMoney(db, companyId);
  const company = companyId && companyId !== 'all' ? Number(companyId) : null;
  const result = agedData ?? agedBalance(db, kind, agedReportDate(period.to), company, agingOptions);
  const { buckets } = result;
  const allRows = result.rows;
  const rows = partnerIds?.length ? allRows.filter((row) => partnerIds.includes(row.partner_id)) : allRows;
  const [open, setOpen] = useState(() => new Set());
  const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
  return (
    <tbody>
      {rows.map((r) => <Fragment key={r.partner_id ?? 'unknown'}>
        <tr className="rep-detail">
          <td>
            <button type="button" className="btn sm" aria-expanded={open.has(r.partner_id)} onClick={() => setOpen((prev) => { const next = new Set(prev); if (next.has(r.partner_id)) next.delete(r.partner_id); else next.add(r.partner_id); return next; })}>{open.has(r.partner_id) ? '▾' : '▸'}</button>{' '}
            {r.partner_id != null ? (
              <a href={`#/open/res.partner/${r.partner_id}`}>{partnerName(db, r.partner_id)}</a>
            ) : (
              <span>{t('Unknown Partner')}</span>
            )}{' '}
            {kind === 'receivable' && r.partner_id && company && <a href={statementUrl([r.partner_id], { companyId: company, ...period })}>{t('Customer Statement')}</a>}
          </td>
          <td />
          {buckets.map(([k]) => <td key={k} className="num">{r[k] ? fmtMoney(r[k]) : ''}</td>)}
          <td className="num">{fmtMoney(r.total)}</td>
        </tr>
        {open.has(r.partner_id) && r.invoices.map((detail) => (
          <AgedDetailRow key={detail.move_id} buckets={buckets} detail={detail} money={fmtMoney} />
        ))}
      </Fragment>)}
      <tr className="rep-total strong"><td>{t('Total')}</td><td />{buckets.map(([k]) => <td key={k} className="num">{fmtMoney(sum(k))}</td>)}<td className="num">{fmtMoney(sum('total'))}</td></tr>
    </tbody>
  );
};

function FollowUpActions({ db, reminder, companyId }) {
  const [open, setOpen] = useState(false);
  const partner = read(db, 'res.partner', reminder.partner_id);
  const email = partner?.email?.trim();
  const channel = levelChannel(followUpLevel(db, reminder));
  const isManual = partner?.followup_reminder_type === 'manual';
  const fallbackChannel = partner?.phone?.trim() ? 'phone' : 'letter';
  const manualChannel = ['sms', 'phone', 'letter'].includes(channel) ? channel : (isManual && !email ? fallbackChannel : 'email');
  const options = { scope: db, reminder, companyId };
  return <><button type="button" className="btn sm" onClick={() => setOpen(true)}>{t('Send')}</button>{' '}
    {open && <FollowUpWizard partnerId={reminder.partner_id} companyId={companyId} onClose={() => setOpen(false)} />}
    {email && <><a className="btn sm" href={`mailto:${email}?subject=${encodeURIComponent(t('Payment reminder'))}&body=${encodeURIComponent(followUpText(db, reminder))}`}
      onClick={() => commit(openManualFollowUp(getDb(), reminder.partner_id, today(), options))}>{t('Open Reminder in Mail App')}</a>{' '}</>}
    {(manualChannel !== 'email' || email) && <button type="button" className="btn sm" onClick={() => commit(logManualFollowUp(getDb(), reminder.partner_id, today(), { ...options, channel: manualChannel }))}>{t('Confirm Sent')}</button>}
  </>;
}

export function FollowUps({ db, sourceDb, companyId = 'all' }) {
  const settingsAllowed = (sourceDb ?? db).settings?.allowed_company_ids ?? [currentCompany(sourceDb ?? db)];
  const allowed = companyId === 'all'
    ? settingsAllowed
    : settingsAllowed.filter((id) => id === Number(companyId));
  const multiCompany = allowed.length > 1;

  const allFollowUps = followUps(db);
  const companyGroups = new Map();
  for (const f of allFollowUps) {
    for (const part of followUpCompanies(f)) {
      const cId = part.company_id ?? part.invoices[0]?.company_id ?? 1;
      if (!companyGroups.has(cId)) companyGroups.set(cId, []);
      companyGroups.get(cId).push(part);
    }
  }

  if (multiCompany) {
    const sections = allowed
      .map((cId) => ({
        company: read(sourceDb ?? db, 'res.company', cId) ?? { id: cId, name: `Company ${cId}` },
        items: companyGroups.get(cId) ?? [],
      }))
      .filter((sec) => sec.items.length > 0);

    return (
      <tbody>
        {sections.map(({ company, items }) => (
          <Fragment key={company.id}>
            <tr className="rep-section">
              <td colSpan={3}><strong>{company.name}</strong></td>
            </tr>
            {items.map((f) => {
              return (
                <tr key={`${company.id}-${f.partner_id}`} className="rep-detail">
                  <td>
                    <a href={`#/open/res.partner/${f.partner_id}`}>{partnerName(db, f.partner_id)}</a>{' '}
                    <span className="muted">{f.invoices.map((m) => m.name).join(', ')}</span>{' '}
                    <FollowUpActions db={db} reminder={f} companyId={company.id} />
                  </td>
                  <td className="num">{f.oldest}</td>
                  <td className="num">{formatFollowUpTotals(f)}</td>
                </tr>
              );
            })}
          </Fragment>
        ))}
      </tbody>
    );
  }

  const singleCompanyId = allowed[0] ?? currentCompany(db);
  const singleItems = companyGroups.get(singleCompanyId) ?? [];

  return (
    <tbody>
      {singleItems.map((f) => {
        return (
          <tr key={f.partner_id} className="rep-detail">
            <td>
              <a href={`#/open/res.partner/${f.partner_id}`}>{partnerName(db, f.partner_id)}</a>{' '}
              <span className="muted">{f.invoices.map((m) => m.name).join(', ')}</span>{' '}
              <FollowUpActions db={db} reminder={f} companyId={singleCompanyId} />
            </td>
            <td className="num">{f.oldest}</td>
            <td className="num">{formatFollowUpTotals(f)}</td>
          </tr>
        );
      })}
    </tbody>
  );
}

export function Budget({ db, period, companyId = 'all' }) {
  const availableCompanies = companiesOf(db);
  const lineLabel = (l) => {
    const analytic = read(db, 'account.analytic.account', l.analytic_account_id)?.name;
    const acc = read(db, 'account.account', l.account_id);
    const general = acc ? `${acc.code} ${acc.name}` : l.general_account;
    return [analytic, general].filter(Boolean).join(' · ') || '—';
  };
  const selectCompany = (budgetId, value) => {
    const companyId = Number(value);
    if (!companyId || !availableCompanies.some((company) => company.id === companyId)) return;
    commit(write(getDb(), 'account.budget', budgetId, { company_id: companyId }));
  };
  return (
    <tbody>
      {search(db, 'account.budget').filter((b) => (companyId === 'all' || b.company_id === Number(companyId)) && !['draft', 'cancel'].includes(b.state) && (!period.from || !b.date_to || b.date_to >= period.from) && (!period.to || !b.date_from || b.date_from <= period.to)).flatMap((b) => {
        const company = b.company_id ? read(db, 'res.company', b.company_id) : null;
        const companyMissing = !company;
        let currency = null;
        let reportLines = [];
        let reportError = null;
        if (!companyMissing) {
          try {
            currency = budgetCurrency(db, company.id);
            if (b.lines?.length) reportLines = budgetReport(db, b.id, today(), { period, company_id: company.id });
          } catch (error) {
            reportError = error instanceof Error ? error.message : String(error);
          }
        }
        return [
          <tr key={b.id} className="rep-section"><td colSpan={6}>
            <a href={`#/open/account.budget/${b.id}`}>{b.name}</a>
            {companyMissing
              ? <label className="inline-select">{t('Company')}
                <select aria-label={`${t('Company')} for ${b.name}`} value="" onChange={(event) => selectCompany(b.id, event.target.value)}>
                  <option value="">{t('Select a company')}</option>
                  {availableCompanies.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              </label>
              : <span className="muted"> · {company.name}</span>}
          </td></tr>,
          ...(companyMissing ? [<tr key={`${b.id}-company-required`}><td colSpan={6} className="muted">{t('Select a company to show this budget report.')}</td></tr>] : []),
          ...(reportError ? [<tr key={`${b.id}-report-error`}><td colSpan={6} className="muted" role="alert">{reportError}</td></tr>] : []),
          ...reportLines.map((l, i) => (
            <Fragment key={`${b.id}-${i}`}>
              <tr className="rep-detail">
                <td>{lineLabel(l)}</td>
                <BudgetMoneyCell value={l.planned_amount ?? l.planned} currency={currency} money={money} />
                <BudgetMoneyCell value={l.achieved_amount} currency={currency} money={money} />
                <BudgetMoneyCell value={l.committed_amount} currency={currency} money={money} />
                <BudgetMoneyCell value={l.budget_variance} currency={currency} money={money} />
                <td className="num">{(l.budget_theoretical ?? l.theoretical) ? `${l.budget_achievement}%` : ''}</td>
              </tr>
              {l.analytic_lines.map((item) => <tr className="rep-detail" key={item.id}>
                <td>{Number.isInteger(item.id) ? <a href={`#/open/account.analytic.line/${item.id}`}>{item.name || item.date}</a> : (item.name || item.date)}{item.move_id && <>{' · '}<a href={`#/open/account.move/${item.move_id}`}>{read(db, 'account.move', item.move_id)?.name ?? item.move_id}</a></>}</td>
                <td /><BudgetMoneyCell value={item.amount * l.budgetSign} currency={currency} money={money} /><td /><td /><td />
              </tr>)}
              {l.commitment_lines.map((item, index) => <tr className="rep-detail" key={`purchase-${item.purchase_id}-${index}`}>
                <td><a href={`#/open/purchase.order/${item.purchase_id}`}>{read(db, 'purchase.order', item.purchase_id)?.name}</a></td>
                <td /><td /><BudgetMoneyCell value={item.amount * l.budgetSign} currency={currency} money={money} /><td /><td />
              </tr>)}
            </Fragment>
          )),
        ];
      })}
    </tbody>
  );
}

function Analytic({ db, period, money: moneyProp, rootPlans: rootPlansProp, hasUnassigned: hasUnassignedProp }) {
  const fmtMoney = moneyProp ?? reportMoney(db, period?.company_id);
  const actual = analyticActuals(db, period);
  const lines = analyticActualLines(db, period);
  const rootPlans = rootPlansProp ?? rootAnalyticPlans(db);
  const hasRootPlans = rootPlans.length > 0;
  const rootPlanIds = useMemo(() => new Set(rootPlans.map((p) => p.id)), [rootPlans]);
  const rootPlanByPlanId = useMemo(() => rootPlanMap(db), [db]);
  const movesById = useMemo(() => {
    const map = new Map();
    for (const m of db.records?.['account.move'] ?? []) {
      map.set(m.id, m);
    }
    return map;
  }, [db]);
  const displayedAccounts = useMemo(() => {
    return (db.records?.['account.analytic.account'] ?? [])
      .filter((a) => a.active !== false || actual.has(a.id));
  }, [db, actual]);
  const hasUnassigned = hasUnassignedProp ?? (hasRootPlans && displayedAccounts.some((a) => !a.plan_id || !rootPlanIds.has(rootPlanByPlanId.get(a.plan_id))));

  return (
    <tbody>
      {displayedAccounts.map((a) => {
        const rootId = a.plan_id ? (rootPlanByPlanId.get(a.plan_id) ?? null) : null;
        const isAssigned = rootId != null && rootPlanIds.has(rootId);
        const accountLines = lines.filter((line) => line.account_id === a.id);
        return (
          <Fragment key={a.id}>
            <tr className="rep-total">
              <td>{a.name}</td>
              {hasRootPlans ? (
                <>
                  {rootPlans.map((rp) => (
                    <td key={rp.id} className="num">
                      {isAssigned && rootId === rp.id ? fmtMoney(actual.get(a.id) ?? 0) : ''}
                    </td>
                  ))}
                  {hasUnassigned && (
                    <td key="unassigned" className="num">
                      {!isAssigned ? fmtMoney(actual.get(a.id) ?? 0) : ''}
                    </td>
                  )}
                </>
              ) : (
                <td className="num">{fmtMoney(actual.get(a.id) ?? 0)}</td>
              )}
            </tr>
            {accountLines.map((line) => (
              <tr key={line.id} className="rep-detail">
                <td>
                  <a href={`#/open/account.analytic.line/${line.id}`}>{line.name || line.date}</a>
                  {line.move_id && (
                    <>
                      {' · '}
                      <a href={`#/open/account.move/${line.move_id}`}>
                        {movesById.get(line.move_id)?.name ?? line.move_id}
                      </a>
                    </>
                  )}
                </td>
                {hasRootPlans ? (
                  <>
                    {rootPlans.map((rp) => (
                      <td key={rp.id} className="num">
                        {isAssigned && rootId === rp.id ? fmtMoney(analyticReportAmount(db, line)) : ''}
                      </td>
                    ))}
                    {hasUnassigned && (
                      <td key="unassigned" className="num">
                        {!isAssigned ? fmtMoney(analyticReportAmount(db, line)) : ''}
                      </td>
                    )}
                  </>
                ) : (
                  <td className="num">{fmtMoney(analyticReportAmount(db, line))}</td>
                )}
              </tr>
            ))}
          </Fragment>
        );
      })}
    </tbody>
  );
}

function AuditTrail({ db, rows, loading, denied }) {
  if (loading) return <tbody><tr><td className="muted">{t('Loading…')}</td></tr></tbody>;
  if (denied) return <tbody><tr><td className="muted">{t('Only administrators can read the audit trail')}</td></tr></tbody>;
  return <AuditRows db={db} rows={rows} />;
}

function AuditRows({ db, rows }) {
  return (
    <tbody>
      {rows.map((m) => (
        <tr key={m.id} className="rep-detail">
          <td><a href={`#/open/${m.model || 'account.move'}/${m.res_id}`}>{m.recordName ?? read(db, m.model || 'account.move', m.res_id)?.name ?? `#${m.res_id}`}</a> <span className="muted">{m.body}</span></td>
          <td className="num">{m.author}</td>
          <td className="num">{String(m.date ?? '').slice(0, 16).replace('T', ' ')}</td>
        </tr>
      ))}
    </tbody>
  );
}

/** Stock value per product from its valuation layers (revaluations and landed costs included), largest first. */
function Valuation({ db, period, money: fmtMoney = money }) {
  const report = valuationReport(db, { at: period.to || today() });
  const rows = Object.entries(report).filter(([, v]) => v.qty)
    .map(([id, v]) => ({ p: { ...read(db, 'product', Number(id)), qty_available: v.qty, cost: v.unitCost }, value: v.value })).sort((a, b) => b.value - a.value);
  return (
    <tbody>
      {rows.map(({ p, value }) => (
        <tr key={p.id} className="rep-detail">
          <td><a href={`#/open/product/${p.id}`}>{p.default_code ? `[${p.default_code}] ` : ''}{p.name}</a></td>
          <td className="num">{p.qty_available}</td>
          <td className="num">{fmtMoney(p.cost)}</td>
          <td className="num">{fmtMoney(value)}</td>
        </tr>
      ))}
      <tr className="rep-total strong"><td>{t('Total')}</td><td /><td /><td className="num">{fmtMoney(rows.reduce((s, r) => s + r.value, 0))}</td></tr>
    </tbody>
  );
}

// Per asset: depreciation posted in the period, accumulated to its end, and the resulting book value.
function Depreciation({ db, period, companyId, money: moneyProp }) {
  const fmtMoney = moneyProp ?? reportMoney(db, companyId);
  const { rows, totals } = depreciationReport(db, period, companyId);
  return (
    <tbody>
      {rows.map(({ a, original, inPeriod, accumulated, book }) => (
        <tr key={a.id} className="rep-detail">
          <td><a href={`#/open/account.asset/${a.id}`}>{a.name}</a></td>
          <td>{a.acquisition_date}</td>
          <td className="num">{fmtMoney(original)}</td>
          <td className="num">{fmtMoney(inPeriod)}</td>
          <td className="num">{fmtMoney(accumulated)}</td>
          <td className="num">{fmtMoney(book)}</td>
        </tr>
      ))}
      <tr className="rep-total strong"><td>{t('Total')}</td><td /><td className="num">{fmtMoney(totals.original)}</td><td className="num">{fmtMoney(totals.inPeriod)}</td><td className="num">{fmtMoney(totals.accumulated)}</td><td className="num">{fmtMoney(totals.book)}</td></tr>
    </tbody>
  );
}

function JournalAudit({ db, period, companyId, sort = 'date', money: moneyProp }) {
  const fmtMoney = moneyProp ?? reportMoney(db, companyId);
  const groups = journalAudit(db, { ...period, companyId: companyId === 'all' ? null : Number(companyId), sort });
  if (!groups.length) return <tbody><tr><td colSpan={7} className="muted">{t('No posted entries for this period.')}</td></tr></tbody>;
  return <tbody>{groups.map(({ journal, items, debit, credit, taxes }) => <Fragment key={journal.id}>
    <tr className="rep-section"><td colSpan={5}><strong>{journal.name} ({journal.code})</strong></td><td className="num">{fmtMoney(debit)}</td><td className="num">{fmtMoney(credit)}</td></tr>
    {items.map(({ move, line, date }, i) => {
      const account = read(db, 'account.account', line.account_id);
      return <tr key={`${move.id}-${i}`} className="rep-detail"><td>{date}</td><td><a href={`#/open/account.move/${move.id}`}>{move.name}</a></td><td>{read(db, 'res.partner', line.partner_id ?? move.partner_id)?.name ?? ''}</td><td>{account ? `${account.code} ${account.name}` : ''}</td><td>{line.name}</td><td className="num">{line.debit ? fmtMoney(line.debit) : ''}</td><td className="num">{line.credit ? fmtMoney(line.credit) : ''}</td></tr>;
    })}
    <tr className="rep-total strong"><td colSpan={5}>{t('Total')} - {journal.name}</td><td className="num">{fmtMoney(debit)}</td><td className="num">{fmtMoney(credit)}</td></tr>
    {taxes.length > 0 && <><tr className="rep-section"><td colSpan={3}>{t('Tax Summary')} - {journal.name}</td><td>{t('Tax')}</td><td>{t('Base')}</td><td colSpan={2}>{t('Tax Amount')}</td></tr>{taxes.map((tax) => <tr key={tax.tax_id ?? 'unidentified-tax'}><td colSpan={3} /><td>{tax.name}</td><td className="num">{fmtMoney(tax.base)}</td><td colSpan={2} className="num">{fmtMoney(tax.tax)}</td></tr>)}</>}
  </Fragment>)}</tbody>;
}

function InalterabilityCheck({ db, companyId, journalId }) {
  const allowed = db.settings?.allowed_company_ids ?? [currentCompany(db)];
  const selected = companyId === 'all' ? allowed : allowed.filter((id) => id === Number(companyId));
  const results = selected.flatMap((id) => checkInalterability(db, { companyId: id, journalId: journalId ? Number(journalId) : null }));

  if (!results.length) {
    return <tbody><tr><td colSpan={4} className="muted">{t('No restricted journals configured.')}</td></tr></tbody>;
  }

  return (
    <tbody>
      {results.map((r) => (
        <tr key={`${r.journal_id}-${r.company_id}`} className={`rep-detail ${r.status === 'corrupted' ? 'rep-corrupted' : ''}`}>
          <td><strong>{r.journal_name} ({r.journal_code})</strong>{r.company_id && companiesOf(db).length > 1 ? ` \u2014 ${read(db, 'res.company', r.company_id)?.name ?? r.company_id}` : ''}</td>
          <td>{r.first_move ?? '—'}</td>
          <td>{r.last_move ?? '—'}</td>
          <td>
            {r.status === 'ok' ? (
              <span className="badge badge-success" style={{ color: '#16a34a', fontWeight: 600 }}>{t(r.message)}</span>
            ) : (
              <span className="badge badge-danger" style={{ color: '#dc2626', fontWeight: 600 }}>{r.status === 'unanchored' ? t('Secure chain has no independent head') : t('Corrupted at entry {name}', { name: r.corrupted_move?.name ?? r.last_move ?? '' })}</span>
            )}
          </td>
        </tr>
      ))}
    </tbody>
  );
}

export function DeferredBody({ db, period, companyId, kind }) {
  const rows = deferredReport(db, { ...period, company_id: Number(companyId) }, kind);
  const currency = findCompanyCurrencyRecord(db, Number(companyId)) ?? companyCurrencyRecord(db, Number(companyId));
  return <tbody>{rows.map((row) => {
    const account = read(db, 'account.account', row.account_id);
    return <tr key={row.account_id}><td><a href={`#/accounting/journal-items?account=${row.account_id}${companyId ? `&company=${companyId}` : ''}`}>{account ? `${account.code} ${account.name}` : row.account_id} - {t('Journal Items')}</a></td>{['total', 'not_started', 'before', 'current', 'recognized', 'within_year', 'after_year'].map((key) => <td className="num" key={key}>{money(row[key], currency?.name, currency)}</td>)}</tr>;
  })}</tbody>;
}

export const REPORTS = {
  deferredRevenue: { title: 'Deferred Revenue', Body: DeferredBody, firstCol: 'Account', cols: ['Total', 'Not Started', 'Before', 'Current', 'Recognized', '<= 12 Months', '> 12 Months'] },
  deferredExpense: { title: 'Deferred Expense', Body: DeferredBody, firstCol: 'Account', cols: ['Total', 'Not Started', 'Before', 'Current', 'Recognized', '<= 12 Months', '> 12 Months'] },
  trial: { title: 'Trial Balance', Body: TrialBalance, cols: ['Initial Balance', 'Debit', 'Credit', 'End Balance'] },
  fiscal: { title: 'Fiscal Report', Body: FiscalReport, cols: ['Debit', 'Credit', 'Balance'] },
  partnerReceivable: { title: 'Partner Ledger', Body: PartnerLedger('receivable'), cols: ['Due Date', 'Matching', 'Label', 'Initial Balance', 'Debit', 'Credit', 'End Balance', 'Amount Currency'] },
  customerStatement: { title: 'Customer Statement', Body: CustomerStatement, cols: ['Debit', 'Credit', 'Balance'] },
  partnerPayable: { title: 'Partner Ledger (Payable)', Body: PartnerLedger('payable'), cols: ['Due Date', 'Matching', 'Label', 'Initial Balance', 'Debit', 'Credit', 'End Balance', 'Amount Currency'] },
  cashflow: { title: 'Cash Flow Statement', Body: CashFlow, cols: ['Balance'] },
  executive: { title: 'Executive Summary', Body: ExecutiveSummary, cols: ['Value'] },
  depreciation: { title: 'Depreciation Schedule', Body: Depreciation, cols: ['Acquisition Date', 'Original Value', 'Depreciation', 'Cumulative Depreciation', 'Book Value'] },
  valuation: { title: 'Stock Valuation', Body: Valuation, cols: ['On Hand', 'Unit Cost', 'Total Value'] },
  audit: { title: 'Audit Trail', Body: AuditTrail, cols: ['Author', 'Date'] },
  tax: { title: 'Tax Report', Body: Tax, cols: ['Base', 'Tax'] },
  agedReceivable: { title: 'Aged Receivable', Body: Aged('receivable'), cols: [] },
  agedPayable: { title: 'Aged Payable', Body: Aged('payable'), cols: [] },
  followups: { title: 'Follow-up Reports', Body: FollowUps, cols: ['Oldest Due', 'Overdue'] },
  budget: { title: 'Budget vs Actual', Body: Budget, cols: ['Planned', 'Actual', 'Committed', 'Variance', 'Achievement'] },
  analytic: { title: 'Analytic Report', Body: Analytic, cols: ['Balance'] },
  pnl: { title: 'Profit and Loss', cols: ['Balance'] },
  balance: { title: 'Balance Sheet', cols: ['Balance'] },
  ledger: { title: 'General Ledger', Body: Ledger, cols: ['Debit', 'Credit', 'Balance'] },
  journalAudit: { title: 'Journal Audit', Body: JournalAudit, firstCol: 'Date', cols: ['Number', 'Partner', 'Account', 'Label', 'Debit', 'Credit'] },
  inalterability: { title: 'Data Inalterability Check', Body: InalterabilityCheck, firstCol: 'Journal', cols: ['First Secured Entry', 'Last Secured Entry', 'Status'] },
};

/** Financial reports computed live from posted journal items. */
export function Reports({ leaf, id, params }) {
  if (leaf.report === 'configurable') return <ConfigurableReportPage id={id} />;
  if (leaf.report === 'pnl' || leaf.report === 'balance') {
    return <ConfigurableReportPage key={leaf.report} statementKind={leaf.report} title={REPORTS[leaf.report].title} />;
  }
  const component = ['journalItems', 'unreconciledItems'].includes(leaf.report) ? JournalItems
    : leaf.report === 'unrealizedCurrencies' ? UnrealizedCurrencies
    : leaf.report === 'checks' ? Checks
    : leaf.report === 'loansAnalysis' ? LoansAnalysis
    : leaf.report === 'cashflowAnalysis' ? CashflowAnalysis
      : ['invoicesToBeIssued', 'invoicedNotDelivered'].includes(leaf.report) ? SalesReview : ReportPage;
  return reportPage(leaf, component, params);
}

const LEDGER_REPORTS = ['pnl', 'balance', 'ledger', 'trial', 'journalAudit', 'cashflow', 'executive'];

function ReportPage({ leaf, params }) {
  const sourceDb = useDb();
  const isDeferred = ['deferredRevenue', 'deferredExpense'].includes(leaf.report);
  const deferredKind = leaf.report === 'deferredRevenue' ? 'revenue' : 'expense';
  const [generationError, setGenerationError] = useState('');
  const [companyId, setCompanyId] = useState(params?.get('company') || 'all');
  const allowAllCompanies = !isDeferred && !['customerStatement', 'valuation'].includes(leaf.report);
  const { companyDb, availableCompanies, companies, selectedCompany } = useMemo(
    () => reportCompanyScope(sourceDb, companyId, { allowAll: allowAllCompanies }),
    [sourceDb, companyId, allowAllCompanies],
  );
  const [periodKey, setPeriodKey] = useState(params?.has('from') && params?.get('to') ? 'custom' : DEFAULT_REPORT_PERIOD);
  const [asOf, setAsOf] = useState(today());
  const isAged = ['agedReceivable', 'agedPayable'].includes(leaf.report);
  const [comparison, setComparison] = useState('none');
  const [ledgerId, setLedgerId] = useState('');
  const [journalIds, setJournalIds] = useState([]);
  const [includeUnposted, setIncludeUnposted] = useState(false);
  const [horizontalGroupId, setHorizontalGroupId] = useState('');
  const [analyticAccountIds, setAnalyticAccountIds] = useState([]);
  const [partnerFilterIds, setPartnerFilterIds] = useState([]);
  const [unreconciledOnly, setUnreconciledOnly] = useState(false);
  const [auditSort, setAuditSort] = useState('date');
  const [agingInterval, setAgingInterval] = useState(30);
  const [agingBasis, setAgingBasis] = useState('base_on_maturity_date');
  const agingOptions = useMemo(() => ({ aging_interval: agingInterval, aging_based_on: agingBasis }), [agingInterval, agingBasis]);
  const [inalterabilityJournalId, setInalterabilityJournalId] = useState('');
  const { ledgers, ledger, availableJournals, selectedJournalIds, targetJournalIds } = useMemo(() => {
    const allLedgers = search(companyDb, 'account.journal.group').sort((a, b) => (a.sequence ?? 10) - (b.sequence ?? 10));
    const activeLedger = LEDGER_REPORTS.includes(leaf.report) ? allLedgers.find((item) => item.id === Number(ledgerId)) : null;
    const journals = (activeLedger ? search(companyDb, 'account.journal').filter((j) => (activeLedger.journal_ids ?? []).includes(j.id)) : search(companyDb, 'account.journal'))
      .filter((j) => selectedCompany === 'all' || !j.company_id || j.company_id === Number(selectedCompany));
    const chosenIds = LEDGER_REPORTS.includes(leaf.report)
      ? journalIds.filter((jId) => journals.some((j) => j.id === jId))
      : [];
    const targetIds = chosenIds.length
      ? chosenIds
      : activeLedger
        ? (activeLedger.journal_ids ?? [])
        : null;
    return { ledgers: allLedgers, ledger: activeLedger, availableJournals: journals, selectedJournalIds: chosenIds, targetJournalIds: targetIds };
  }, [companyDb, leaf.report, ledgerId, selectedCompany, journalIds]);
  const selectedCompanyId = selectedCompany !== 'all' ? Number(selectedCompany) : null;
  const scopedCompanyDb = useMemo(() => (
    selectedCompanyId != null
      ? reportCompanyScope({
          ...sourceDb,
          settings: {
            ...sourceDb.settings,
            current_company_id: selectedCompanyId,
            allowed_company_ids: [selectedCompanyId],
          },
        }, selectedCompany).companyDb
      : companyDb
  ), [sourceDb, selectedCompanyId, selectedCompany, companyDb]);
  const fmtMoney = useMemo(() => reportMoney(scopedCompanyDb, selectedCompany), [scopedCompanyDb, selectedCompany]);
  const db = useMemo(() => (
    targetJournalIds
      ? {
          ...scopedCompanyDb,
          unfilteredDb: scopedCompanyDb,
          records: {
            ...scopedCompanyDb.records,
            'account.move': (scopedCompanyDb.records['account.move'] ?? []).filter((move) =>
              (!ledger || (move.company_id ?? 1) === ledger.company_id) && targetJournalIds.includes(move.journal_id)
            ),
          },
        }
      : scopedCompanyDb
  ), [scopedCompanyDb, targetJournalIds, ledger]);
  const [customPeriod, setCustomPeriod] = useState({ from: params?.get('from') ?? today().slice(0, 4) + '-01-01', to: params?.get('to') || today() });
  const { title, Body, cols, firstCol } = REPORTS[leaf.report];
  const countryTemplateKey = leaf.report === 'tax' ? resolveTaxReportTemplate(companyDb, selectedCompany, companies) : null;
  const countryTemplate = countryTemplateKey ? TAX_RETURN_TEMPLATES[countryTemplateKey] : null;
  const [taxVariant, setTaxVariant] = useState(null);
  const [taxVariantCompany, setTaxVariantCompany] = useState(selectedCompany);
  if (taxVariantCompany !== selectedCompany) {
    setTaxVariantCompany(selectedCompany);
    setTaxVariant(null);
  }
  const activeTaxVariant = (taxVariant && (taxVariant === 'generic' || taxVariant === countryTemplateKey))
    ? taxVariant
    : (countryTemplateKey ?? 'generic');
  const isTaxBoxes = leaf.report === 'tax' && activeTaxVariant !== 'generic';
  const period = useMemo(
    () => (isAged ? { from: '', to: agedReportDate(asOf) } : periodKey === 'custom' ? customPeriod : PERIODS[periodKey]()),
    [isAged, asOf, periodKey, customPeriod],
  );
  const periodName = periodKey === 'month'
    ? new Intl.DateTimeFormat(dateLocale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${period.to}T00:00:00Z`))
    : periodKey === 'year' ? period.to.slice(0, 4) : `${period.from} - ${period.to}`;
  const comparable = ['pnl', 'balance', 'cashflow', 'executive', 'trial', 'tax', 'fiscal'].includes(leaf.report) && periodKey !== 'all';
  const showUnpostedOption = ['pnl', 'balance', 'cashflow', 'executive', 'ledger', 'trial', 'fiscal', 'partnerReceivable', 'partnerPayable', 'customerStatement'].includes(leaf.report);
  const effectivePeriod = useMemo(
    () => (showUnpostedOption && includeUnposted ? { ...period, reviewMode: 'all' } : period),
    [showUnpostedOption, includeUnposted, period]
  );
  const rootPlans = useMemo(() => {
    if (leaf.report !== 'analytic') return [];
    return rootAnalyticPlans(db);
  }, [db, leaf.report]);
  const hasUnassigned = useMemo(() => {
    if (leaf.report !== 'analytic' || rootPlans.length === 0) return false;
    const actual = analyticActuals(db, effectivePeriod);
    const rootPlanIds = new Set(rootPlans.map((p) => p.id));
    const planRoots = rootPlanMap(db);
    const accounts = (db.records?.['account.analytic.account'] ?? [])
      .filter((a) => a.active !== false || actual.has(a.id));
    return accounts.some((a) => !a.plan_id || !rootPlanIds.has(planRoots.get(a.plan_id)));
  }, [db, leaf.report, rootPlans, effectivePeriod]);
  const reportCols = isTaxBoxes
    ? ['Description', 'Base', 'Tax']
    : isAged
      ? ['Date', ...BUCKETS(agingInterval).map(([, label]) => label), 'Total']
    : isDeferred
      ? cols.map((col) => col === 'Current' ? periodName : col)
      : leaf.report === 'analytic' && rootPlans.length > 0
        ? [...rootPlans.map((p) => ({ label: p.name, raw: true })), ...(hasUnassigned ? ['Unassigned'] : [])]
        : cols;
  const reportFirstCol = isTaxBoxes ? 'Box' : firstCol;
  const showAnalyticFilter = ['pnl', 'balance', 'cashflow', 'ledger', 'partnerReceivable', 'partnerPayable', 'trial', 'fiscal', 'executive'].includes(leaf.report);
  const isPartnerLedger = ['partnerReceivable', 'partnerPayable'].includes(leaf.report);
  const primaryCompanyId = selectedCompany === 'all' ? (companyDb.settings?.current_company_id ?? 1) : Number(selectedCompany);
  // Like the statement reports, the cash flow offers the groups not limited to specific reports.
  const horizontalGroups = leaf.report === 'cashflow'
    ? search(companyDb, 'account.report.horizontal.group').filter((g) => (g.company_id ?? 1) === primaryCompanyId && !(g.report_ids ?? []).length)
    : [];
  const canComputePeriods = periodKey !== 'custom' || (validDate(period.from) && validDate(period.to) && period.from <= period.to);
  const periods = comparable && comparison !== 'none' && canComputePeriods ? periodsFor(periodKey, comparison, period) : null;
  const analyticAccounts = showAnalyticFilter ? search(companyDb, 'account.analytic.account') : [];
  const agedKind = leaf.report === 'agedPayable' ? 'payable' : 'receivable';
  const agedData = useMemo(
    () => (isAged ? agedBalance(db, agedKind, period.to, selectedCompanyId, agingOptions) : null),
    [isAged, db, agedKind, period.to, selectedCompanyId, agingOptions],
  );
  const agedPartnerIds = agedData ? new Set(agedData.rows.map((row) => row.partner_id)) : null;
  const partnerChoices = isPartnerLedger || isAged ? search(scopedCompanyDb, 'res.partner', { includeArchived: true }).filter((p) => !isAged || !agedPartnerIds || agedPartnerIds.has(p.id)).sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '')) : [];
  const horizontalGroup = horizontalGroups.find((g) => g.id === Number(horizontalGroupId));
  const data = periods && leaf.report === 'cashflow'
    ? cashflowColumns(db, periods, {
      analyticAccountIds, ...(selectedCompany !== 'all' ? { company_id: Number(selectedCompany) } : {}), includeUnposted,
    })
    : periods && leaf.report === 'executive'
      ? executiveColumns(db, periods, {
        analyticAccountIds, ...(selectedCompany !== 'all' ? { company_id: Number(selectedCompany) } : {}), includeUnposted,
      })
      : horizontalGroup && leaf.report === 'cashflow'
        ? cashflowAnalyticColumns(db, horizontalGroup, period, {
          analyticAccountIds, ...(selectedCompany !== 'all' ? { company_id: Number(selectedCompany) } : {}), includeUnposted,
        })
        : null;
  const detailComparison = periods && ['tax', 'fiscal'].includes(leaf.report)
    ? detailReportColumns(db, leaf.report, periods, { company_id: selectedCompany === 'all' ? null : Number(selectedCompany), analyticAccountIds, includeUnposted, variant: activeTaxVariant }) : null;
  const tableRef = useRef(null);
  const isAudit = leaf.report === 'audit';
  const [serverAuditLog, setServerAuditLog] = useState(undefined);
  const [auditPage, setAuditPage] = useState({ key: '', offset: 0 });
  const [isPrinting, setIsPrinting] = useState(false);
  const [sentState, setSentState] = useState({ key: '', ids: [] });
  const [sendError, setSendError] = useState('');
  const [sending, setSending] = useState(false);
  const requestedIds = leaf.report === 'customerStatement' ? (params?.get('partners') ?? '').split(',').filter((id) => /^[1-9]\d*$/.test(id)).map(Number) : [];
  const statementIds = [...new Set(requestedIds)].filter((id) => read(db, 'res.partner', id));
  const auditScopeKey = JSON.stringify(sourceDb.settings?.allowed_company_ids ?? [sourceDb.settings?.current_company_id ?? 1]);
  useEffect(() => {
    let active = true;
    if (isAudit && isServer()) {
      setServerAuditLog(undefined);
      listAuditAll(AUDIT_MODELS).then((rows) => { if (active) setServerAuditLog(rows); });
    }
    return () => { active = false; };
  }, [isAudit, auditScopeKey]);
  const auditAllRows = isAudit && (!isServer() || Array.isArray(serverAuditLog))
    ? collectAuditTrailRows(db, sourceDb, period, isServer() ? serverAuditLog : null)
    : [];
  const auditPageKey = `${auditScopeKey}:${periodKey}:${period.from ?? ''}:${period.to ?? ''}`;
  const auditOffset = auditPage.key === auditPageKey ? auditPage.offset : 0;
  const auditWin = pageWindow(auditAllRows.length, auditOffset, PAGE_SIZE);
  const auditPagedRows = auditAllRows.slice(auditWin.start, auditWin.end);
  const exportCsv = () => {
    if (isAudit) {
      downloadCsv('audit.csv', auditTrailToCsv(auditAllRows));
      return;
    }
    downloadCsv(`${leaf.report || 'report'}.csv`, tableToRows(tableRef.current));
  };
  const exportXlsx = () => {
    if (isAudit) {
      downloadXlsx('audit.xlsx', auditTrailToCsv(auditAllRows), { sheetName: 'Audit Trail', columnTypes: Array(8).fill('text') });
      return;
    }
    const name = leaf.report || 'report';
    const sheetName = title || name;
    downloadXlsx(`${name}.xlsx`, tableRef.current, { sheetName });
  };
  const activeCompanyId = selectedCompany === 'all' ? currentCompany(companyDb) : Number(selectedCompany);
  const sendKey = JSON.stringify([statementIds, activeCompanyId, period.from, period.to, includeUnposted]);
  const sentPartners = sentState.key === sendKey ? sentState.ids : [];
  const printCompany = isPrinting ? documentCompany(companyDb, { company_id: activeCompanyId }) : null;
  const printCompanies = isPrinting
    ? (selectedCompany === 'all'
        ? companies.map((c) => documentCompany(companyDb, { company_id: c.id }) || c)
        : (printCompany ? [printCompany] : []))
    : null;
  const subtitle = isAged
    ? `${t('As of Date')}: ${period.to} · ${t('Aging period length (days)')}: ${agingInterval} · ${t('Based on')}: ${t(agingBasis === 'base_on_invoice_date' ? 'Invoice Date' : 'Due Date')}`
    : leaf.report === 'inalterability'
      ? t('Chain verification always covers all secured entries.')
      : (period.from ? `${period.from} → ${period.to}` : `≤ ${period.to}`);
  const controls = (
    <div className="control-panel">
      <h1 className="cp-title">{t(title)}</h1>
      {isAged && <>
        <label>{t('As of Date')}<input aria-label={t('As of')} type="date" value={asOf} onChange={(e) => { if (validDate(e.target.value)) setAsOf(e.target.value); }} /></label>
        <label className="inline-select">{t('Aging period length (days)')}<input type="number" min="1" step="1" value={agingInterval} onChange={(e) => { const n = Number(e.target.value); if (Number.isSafeInteger(n) && n > 0) setAgingInterval(n); }} /></label>
        <label className="inline-select">{t('Based on')}<select value={agingBasis} onChange={(e) => setAgingBasis(e.target.value)}><option value="base_on_maturity_date">{t('Due Date')}</option><option value="base_on_invoice_date">{t('Invoice Date')}</option></select></label>
      </>}
      {leaf.report !== 'inalterability' && !isAged && <label className="inline-select">
        {t('Period')}
        <select value={periodKey} onChange={(e) => setPeriodKey(e.target.value)}>
          <option value="month">{t('This Month')}</option>
          <option value="quarter">{t('This Quarter')}</option>
          <option value="year">{t('This Year')}</option>
          {!isDeferred && <option value="all">{t('All Dates')}</option>}
          {['journalAudit', 'customerStatement', 'fiscal', 'pnl', 'balance', 'ledger', 'trial', 'tax', 'cashflow', 'executive', 'depreciation', 'analytic', 'valuation', 'budget', 'deferredRevenue', 'deferredExpense'].includes(leaf.report) && <option value="custom">{t('Custom Period')}</option>}
        </select>
      </label>}
      {!isAged && periodKey === 'custom' && <><label>{t('From')}<input type="date" value={customPeriod.from} onChange={(e) => setCustomPeriod({ ...customPeriod, from: e.target.value })} /></label><label>{t('To')}<input type="date" value={customPeriod.to} onChange={(e) => setCustomPeriod({ ...customPeriod, to: e.target.value })} /></label></>}
      {LEDGER_REPORTS.includes(leaf.report) && <label className="inline-select">{t('Ledger')}
        <select aria-label={t('Ledger')} value={ledger ? String(ledger.id) : ''} onChange={(e) => { setLedgerId(e.target.value); setJournalIds([]); }}>
          <option value="">{t('All Ledgers')}</option>
          {ledgers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>}
      {LEDGER_REPORTS.includes(leaf.report) && <label className="inline-select">{t('Journals')}
        <select aria-label={t('Journals')} multiple value={selectedJournalIds.map(String)} onChange={(e) => setJournalIds(selectedOptionIds(e))}>
          {availableJournals.map((item) => <option key={item.id} value={item.id}>{item.name} ({item.code})</option>)}
        </select>
      </label>}
      {leaf.report === 'inalterability' && <label className="inline-select">{t('Journal')}
        <select aria-label={t('Journal')} value={availableJournals.some((j) => j.id === Number(inalterabilityJournalId)) ? inalterabilityJournalId : ''} onChange={(e) => setInalterabilityJournalId(e.target.value)}>
          <option value="">{t('All Journals')}</option>
          {availableJournals.map((j) => <option key={j.id} value={j.id}>{j.name} ({j.code})</option>)}
        </select>
      </label>}
      {leaf.report === 'journalAudit' && <label className="inline-select">{t('Sort by')}
        <select aria-label={t('Sort by')} value={auditSort} onChange={(e) => setAuditSort(e.target.value)}>
          <option value="date">{t('Date')}</option>
          <option value="number">{t('Journal Entry Number')}</option>
        </select>
      </label>}
      {(isDeferred || ['ledger', 'trial', 'partnerReceivable', 'partnerPayable', 'agedReceivable', 'agedPayable', 'fiscal', 'analytic', 'valuation'].includes(leaf.report) ? companies.length > 1 : ['journalAudit', 'inalterability', 'cashflow', 'executive', 'depreciation', 'tax', 'budget'].includes(leaf.report) ? availableCompanies.length > 1 : leaf.report === 'customerStatement' && companies.length > 1) && (
        <CompanySelect companies={companies} value={selectedCompany} onChange={setCompanyId} allowAll={allowAllCompanies} />
      )}
      {leaf.report === 'tax' && countryTemplate && (
        <label className="inline-select">
          {t('Variant')}
          <select aria-label={t('Variant')} value={activeTaxVariant} onChange={(e) => setTaxVariant(e.target.value)}>
            <option value={countryTemplateKey}>{t(countryTemplate.label)}</option>
            <option value="generic">{t('Generic')}</option>
          </select>
        </label>
      )}
      {showAnalyticFilter && analyticAccounts.length > 0 && (
        <label className="inline-select">
          {t('Analytic Accounts')}
          <select aria-label={t('Analytic Accounts')} multiple value={analyticAccountIds} onChange={(e) => {
            const selected = Array.from(e.target.selectedOptions).map((o) => Number(o.value));
            setAnalyticAccountIds(selected);
          }}>
            {analyticAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
      )}
      {isPartnerLedger && <>
        <label className="inline-select">
          <input type="checkbox" checked={unreconciledOnly} onChange={(e) => setUnreconciledOnly(e.target.checked)} /> {t('Unreconciled entries only')}
        </label>
      </>}
      {(isPartnerLedger || isAged) && <>
        <label className="inline-select">
          {t('Partners')}
          <select aria-label={t('Partners')} multiple value={partnerFilterIds} onChange={(e) => setPartnerFilterIds(Array.from(e.target.selectedOptions).map((o) => Number(o.value)))}>
            {partnerChoices.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
      </>}
      {comparable && <label className="inline-select">
        {t('Comparison')}
        <select value={comparison} onChange={(e) => { setComparison(e.target.value); if (e.target.value !== 'none') setHorizontalGroupId(''); }}>
          <option value="none">{t('No comparison')}</option>
          <option value="previous">{t('Previous Period')}</option>
          <option value="lastYear">{t('Same Period Last Year')}</option>
          <option value="last3">{t('Last 3 Periods')}</option>
        </select>
      </label>}
      {horizontalGroups.length > 0 && <label className="inline-select">
        {t('Horizontal Group')}
        <select aria-label={t('Horizontal Group')} value={horizontalGroupId} onChange={(e) => { setHorizontalGroupId(e.target.value); if (e.target.value) setComparison('none'); }}>
          <option value="">{t('None')}</option>
          {horizontalGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
      </label>}
      {showUnpostedOption && <label className="inline-select">
        <input type="checkbox" checked={includeUnposted} onChange={(e) => setIncludeUnposted(e.target.checked)} /> {t('Include Unposted Entries')}
      </label>}
      <span className="muted">{subtitle}</span>
      <span className="spacer" />
      {isDeferred && <button type="button" className="btn sm" disabled={!deferredSettings(db, Number(selectedCompany) || 1, deferredKind).isGrouped} title={!deferredSettings(db, Number(selectedCompany) || 1, deferredKind).isGrouped ? t('Grouped deferral generation requires a company configured for grouped posting') : undefined} onClick={() => {
        if (!deferredSettings(getDb(), Number(selectedCompany) || 1, deferredKind).isGrouped) return;
        setGenerationError('');
        try { commit(generateGroupedEntries(getDb(), { date: period.to, company_id: Number(selectedCompany), kind: deferredKind })); }
        catch (error) { setGenerationError(error.message); }
      }}>{t('Generate Entries')}</button>}
      {generationError && <span role="alert">{t(generationError)}</span>}
      {isAudit && (
        <span className="pager" role="group" aria-label={t('Pager')}>
          <span aria-live="polite">{auditWin.label} / {auditWin.total}</span>
          <PagerButtons prevLabel={t('Previous page')} nextLabel={t('Next page')} prevDisabled={auditWin.prev == null} nextDisabled={auditWin.next == null} onPrev={() => setAuditPage({ key: auditPageKey, offset: auditWin.prev })} onNext={() => setAuditPage({ key: auditPageKey, offset: auditWin.next })} />
        </span>
      )}
      {statementIds.length > 0 && <button type="button" className="btn sm" disabled={sending || sentPartners.length === statementIds.length} onClick={async () => {
        setSending(true); setSendError('');
        try {
          if (!isServer()) throw new Error('Email requires the server.');
          for (const id of statementIds.filter((value) => !sentPartners.includes(value))) {
            const result = await serverAction('/api/mail/statement', { partnerId: id, companyId: activeCompanyId, from: period.from, to: period.to, reviewMode: includeUnposted ? 'all' : 'posted' });
            if (!result.ok) throw new Error(result.error ?? 'Action failed');
            setSentState((previous) => ({ key: sendKey, ids: [...(previous.key === sendKey ? previous.ids : []), id] }));
            if (result.refreshError) throw new Error(result.refreshError);
          }
        } catch (error) { setSendError(error.message ?? ''); } finally { setSending(false); }
      }}>{t('Send')}</button>}
      {sentPartners.length > 0 && <span aria-live="polite">{t('Sent')}: {sentPartners.length} / {statementIds.length}</span>}
      {sendError && <span role="alert">{t(sendError)}</span>}
      <button type="button" className="btn sm" onClick={() => setIsPrinting(true)}>{t('Print')}</button>
      <button type="button" className="btn sm" onClick={exportCsv}>{t('Download CSV')}</button>
      <button type="button" className="btn sm" onClick={exportXlsx}>{t('Export XLSX')}</button>
    </div>
  );
  return (
    <ReportPrintView
      active={isPrinting}
      company={printCompany}
      companies={printCompanies}
      title={t(title)}
      subtitle={subtitle}
      controls={controls}
      onBack={() => setIsPrinting(false)}
      documents={isPrinting && statementIds.length ? statementIds.map((partnerId) => ({ key: partnerId, content: <table className="list report"><thead><tr><th /><th>{t('Debit')}</th><th>{t('Credit')}</th><th>{t('Balance')}</th></tr></thead><CustomerStatement db={db} period={effectivePeriod} companyId={selectedCompany} initialPartnerId={partnerId} fixedPartner money={fmtMoney} /></table> })) : null}
    >
      <div className="list-wrap">
        <table className="list report" ref={tableRef}>
          <thead>
            <tr>
              <th>{t(reportFirstCol ?? '')}</th>
              {isTaxBoxes && detailComparison && <th>{t('Description')}</th>}
              {(detailComparison
                ? periods.flatMap((p) => (leaf.report === 'tax' ? ['Base', 'Tax'] : ['Debit', 'Credit', 'Balance']).map((label) => `${p.label} - ${t(label)}`))
                : periods && ['trial', 'fiscal', 'tax'].includes(leaf.report)
                  ? (isTaxBoxes ? ['Description', ...periods.flatMap((p) => ['Base', 'Tax'].map((c) => `${p.label} - ${t(c)}`))] : periods.flatMap((p) => reportCols.map((c) => `${p.label} - ${t(typeof c === 'object' && c ? c.label : c)}`)))
                  : data
                    ? [...data.headers, ...(data.variance ? ['Variance', '%'] : [])]
                    : reportCols
              ).map((c) => {
                const isRaw = typeof c === 'object' && c !== null && c.raw;
                const label = typeof c === 'object' && c !== null ? c.label : c;
                const text = isRaw ? label : (data ? label.split(' ').map((part) => t(part)).join(' ') : t(label));
                return <th key={label} className={label === 'Description' ? undefined : 'num'}>{text}</th>;
              })}
            </tr>
          </thead>
          {detailComparison ? (
            <DetailComparison db={db} data={detailComparison} report={leaf.report} companyId={selectedCompany} variant={activeTaxVariant} money={fmtMoney} />
          ) : periods && ['trial', 'fiscal', 'tax'].includes(leaf.report) ? (
            <Body db={db} period={effectivePeriod} periods={periods} companyId={selectedCompany} analyticAccountIds={analyticAccountIds} variant={activeTaxVariant} money={fmtMoney} />
          ) : data ? (
            <Comparison key={leaf.report} data={data} report={leaf.report} money={fmtMoney} />
          ) : isAudit ? (
            <AuditTrail db={db} rows={auditPagedRows} loading={isServer() && serverAuditLog === undefined} denied={isServer() && serverAuditLog === null} />
          ) : statementIds.length ? (
            statementIds.map((partnerId) => <CustomerStatement key={partnerId} db={db} period={effectivePeriod} companyId={selectedCompany} initialPartnerId={partnerId} fixedPartner money={fmtMoney} />)
          ) : (
            <Body
              db={db}
              sourceDb={sourceDb}
              period={effectivePeriod}
              companyId={selectedCompany}
              analyticAccountIds={analyticAccountIds}
              partnerIds={partnerFilterIds}
              unreconciledOnly={unreconciledOnly}
              variant={activeTaxVariant}
              sort={auditSort}
              kind={deferredKind}
              journalId={availableJournals.some((j) => j.id === Number(inalterabilityJournalId)) ? inalterabilityJournalId : ''}
              agedData={agedData}
              agingOptions={agingOptions}
              rootPlans={rootPlans}
              hasUnassigned={hasUnassigned}
              money={fmtMoney}
            />
          )}
        </table>
      </div>
    </ReportPrintView>
  );
}
