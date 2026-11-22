import { ReportPrintView as BaseReportPrintView } from './ReportPrintView.jsx';
import { reportPrintFooters } from './reportFold.js';
import { t } from '../i18n.js';

export function ReportFoldAll({ keys, open, onToggle }) {
  const allUnfolded = keys.length > 0 && keys.every((key) => open.has(key));
  return keys.length > 0 && <button type="button" className="btn sm no-print" aria-pressed={allUnfolded} onClick={onToggle}>{t(allUnfolded ? 'Collapse All' : 'Unfold All')}</button>;
}

const FOOTER_CHARS_PER_LINE = 100;
const FOOTER_LINE_CM = 0.5;

export function ReportPrintView({ children, company, companies, active, ...props }) {
  const list = Array.isArray(companies) && companies.length ? companies : (company ? [company] : []);
  const footers = reportPrintFooters(list);
  const companyTitle = list.map((item) => item?.name).filter(Boolean).join(', ');
  const hideBaseFooter = footers.length > 0;
  // Reserve the page's bottom margin for the whole legal footer so a long footer never covers the figures.
  // ponytail: estimates wrapped lines at ~100 characters per printed line; measure the rendered footer if that proves too rough.
  const footerLines = footers.reduce((sum, footer) => sum + String(footer).split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / FOOTER_CHARS_PER_LINE)), 0), 0);
  const footerHeightCm = footerLines * FOOTER_LINE_CM;
  const bottomMarginCm = Math.max(3, footerHeightCm + 1);
  return <BaseReportPrintView active={active} company={company} companies={companies} {...props}>
    {active && <style>{`.report-repeat-header { display: none; } @media print { @page { margin-top: 2.5cm; margin-bottom: ${bottomMarginCm}cm; } .report-repeat-header { display: block; position: fixed; top: -1.5cm; left: 0; right: 0; font-weight: bold; } .paper-company { visibility: hidden; } .report-legal-footer { position: fixed; bottom: -${bottomMarginCm - 0.5}cm; left: 0; right: 0; white-space: pre-wrap; } ${hideBaseFooter ? '.paper > .paper-foot { display: none; }' : ''} }`}</style>}
    {active && <div className="report-repeat-header">{companyTitle}</div>}
    {children}
    {active && footers.length > 0 && <footer className="report-legal-footer muted">{footers.map((footer, i) => <div key={i}>{footer}</div>)}</footer>}
  </BaseReportPrintView>;
}
