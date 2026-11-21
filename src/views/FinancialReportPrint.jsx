import { ReportPrintView as BaseReportPrintView } from './ReportPrintView.jsx';
import { reportPrintFooters } from './reportFold.js';
import { t } from '../i18n.js';

export function ReportFoldAll({ keys, open, onToggle }) {
  const allUnfolded = keys.length > 0 && keys.every((key) => open.has(key));
  return keys.length > 0 && <button type="button" className="btn sm no-print" aria-pressed={allUnfolded} onClick={onToggle}>{t(allUnfolded ? 'Collapse All' : 'Unfold All')}</button>;
}

export function ReportPrintView({ children, company, companies, active, ...props }) {
  const list = Array.isArray(companies) && companies.length ? companies : (company ? [company] : []);
  const footers = reportPrintFooters(list);
  const companyTitle = list.map((item) => item?.name).filter(Boolean).join(', ');
  return <BaseReportPrintView active={active} company={company} companies={companies} {...props}>
    {active && <style>{'.report-repeat-header { display: none; } @media print { @page { margin-top: 2.5cm; margin-bottom: 3cm; } .report-repeat-header { display: block; position: fixed; top: -1.5cm; left: 0; right: 0; font-weight: bold; } .paper-company { visibility: hidden; } .report-legal-footer { position: fixed; bottom: -2cm; left: 0; right: 0; white-space: pre-wrap; } .paper > .paper-foot { display: none; } }'}</style>}
    {active && <div className="report-repeat-header">{companyTitle}</div>}
    {children}
    {active && footers.length > 0 && <footer className="report-legal-footer muted">{footers.map((footer, i) => <div key={i}>{footer}</div>)}</footer>}
  </BaseReportPrintView>;
}
