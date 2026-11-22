import { useRef, useState } from 'react';
import { t } from '../i18n.js';
import { isoDate, today } from '../models/common.js';
import { currentCompany, documentCompany } from '../models/company.js';
import { cashflowAnalysis } from '../models/reports.js';
import { useDb } from '../store.js';
import { money } from '../ui.jsx';
import { downloadCsv, tableToRows } from '../csv.js';
import { downloadXlsx } from '../xlsx.js';
import { CompanySelect, reportCompanyScope } from './reportCompany.jsx';
import { ReportPrintView } from './FinancialReportPrint.jsx';

const measures = ['Inflow', 'Outflow', 'Net'];

/** Cashflow Analysis report view with date range, company filter, and journal pivot toggle. */
export function CashflowAnalysis() {
  const sourceDb = useDb();
  const tableRef = useRef(null);
  const [companyId, setCompanyId] = useState('all');
  const { companyDb: db, availableCompanies, companies, selectedCompany } = reportCompanyScope(sourceDb, companyId);
  const [to, setTo] = useState(today);
  const [from, setFrom] = useState(() => {
    const date = new Date();
    return isoDate(new Date(date.getFullYear(), date.getMonth() - 11, 1));
  });
  const [pivot, setPivot] = useState(false);
  const [isPrinting, setIsPrinting] = useState(false);

  const { rows, journals } = cashflowAnalysis(db, {
    from,
    to,
    company_id: selectedCompany === 'all' ? null : Number(selectedCompany),
  });

  const exportCsv = () => {
    if (!tableRef.current) return;
    downloadCsv('cashflow_analysis.csv', tableToRows(tableRef.current));
  };
  const exportXlsx = () => {
    if (!tableRef.current) return;
    downloadXlsx('cashflow_analysis.xlsx', tableRef.current, { sheetName: t('Cashflow Analysis') });
  };

  const subtitle = from ? `${from} → ${to}` : `≤ ${to}`;
  const controls = (
    <div className="control-panel"><h1 className="cp-title">{t('Cashflow Analysis')}</h1>
      <label>{t('From')} <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
      <label>{t('To')} <input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
      {availableCompanies.length > 1 && <CompanySelect companies={companies} value={selectedCompany} onChange={setCompanyId} />}
      <button type="button" className="btn sm" onClick={() => setPivot(!pivot)}>{t(pivot ? 'Monthly Summary' : 'Pivot by Journal')}</button>
      <span className="spacer" />
      <button type="button" className="btn sm" onClick={() => setIsPrinting(true)}>{t('Print')}</button>
      <button type="button" className="btn sm" onClick={exportCsv}>{t('Download CSV')}</button>
      <button type="button" className="btn sm" onClick={exportXlsx}>{t('Download XLSX')}</button>
    </div>
  );

  const activeCompanyId = selectedCompany === 'all' ? currentCompany(db) : Number(selectedCompany);
  const printCompany = isPrinting ? documentCompany(db, { company_id: activeCompanyId }) : null;
  const printCompanies = isPrinting
    ? (selectedCompany === 'all'
        ? companies.map((c) => documentCompany(db, { company_id: c.id }) || c)
        : (printCompany ? [printCompany] : []))
    : null;

  return (
    <ReportPrintView
      active={isPrinting}
      company={printCompany}
      companies={printCompanies}
      title={t('Cashflow Analysis')}
      subtitle={subtitle}
      controls={controls}
      onBack={() => setIsPrinting(false)}
    >
      <div className="list-wrap"><table className="list report" ref={tableRef}>
        <thead>{pivot ? <>
          <tr><th>{t('Month')}</th>{journals.map((journal) => <th key={journal.id} colSpan={3}>{journal.name}</th>)}</tr>
          <tr><th />{journals.flatMap((journal) => measures.map((label) => <th key={`${journal.id}-${label}`} className="num">{t(label)}</th>))}</tr>
        </> : <tr><th>{t('Month')}</th>{measures.map((label) => <th key={label} className="num">{t(label)}</th>)}</tr>}</thead>
        <tbody>{rows.map((row) => <tr key={row.month}><td>{row.month}</td>
          {(pivot ? journals.flatMap((journal) => { const sums = row.journals.get(journal.id); return [sums?.inflow ?? 0, sums?.outflow ?? 0, sums?.net ?? 0]; }) : [row.inflow, row.outflow, row.net]).map((amount, index) => <td key={index} className="num">{money(amount)}</td>)}
        </tr>)}</tbody>
      </table></div>
    </ReportPrintView>
  );
}
