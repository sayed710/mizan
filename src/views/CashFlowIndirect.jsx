import { useMemo, useState } from 'react';
import { cashFlowIndirect, INDIRECT_FOLDABLE_CODES } from '../models/cashFlowIndirect.js';
import { t } from '../i18n.js';
import { reportMoney } from './reportCompany.jsx';
import { ReportFoldAll } from './FinancialReportPrint.jsx';
import { toggleAllReportFolds, toggleReportFold } from './reportFold.js';

export function CashFlowIndirect({ db, period, companyId, analyticAccountIds, money: moneyProp }) {
  const currentCo = (companyId && companyId !== 'all') ? Number(companyId) : period?.company_id;
  const fmtMoney = moneyProp ?? reportMoney(db, currentCo);
  const [open, setOpen] = useState(() => new Set(INDIRECT_FOLDABLE_CODES));
  const report = useMemo(
    () => cashFlowIndirect(
      db,
      currentCo ? { ...period, company_id: currentCo, analyticAccountIds } : { ...period, analyticAccountIds },
    ),
    [db, period, currentCo, analyticAccountIds],
  );
  return (
    <tbody>
      <tr className="no-export">
        <td colSpan={2}>
          <ReportFoldAll
            keys={INDIRECT_FOLDABLE_CODES}
            open={open}
            onToggle={() => setOpen((prev) => toggleAllReportFolds(prev, INDIRECT_FOLDABLE_CODES))}
          />
        </td>
      </tr>
      {report.lines.map((line) => {
        const folded = line.ancestors.some((code) => !open.has(code));
        const rowClass = line.strong
          ? 'rep-total strong'
          : line.isTotal
            ? 'rep-total'
            : line.hasChildren
              ? (folded ? 'rep-section report-folded-row' : 'rep-section')
              : (folded ? 'rep-detail report-folded-row' : 'rep-detail');
        const labelCellStyle = line.depth
          ? { paddingInlineStart: `${line.depth * 1.5 + 0.75}rem` }
          : (!line.hasChildren && !line.strong && !line.isTotal ? { paddingInlineStart: '0.75rem' } : undefined);
        return (
          <tr key={line.code} className={rowClass} data-code={line.code}>
            <td style={labelCellStyle}>
              {line.hasChildren ? (
                <button
                  type="button"
                  className="btn sm"
                  aria-expanded={open.has(line.code)}
                  onClick={() => setOpen((prev) => toggleReportFold(prev, line.code))}
                >
                  <span className="caret">{open.has(line.code) ? '▾' : '▸'}</span> {t(line.name)}
                </button>
              ) : t(line.name)}
            </td>
            <td className="num">{fmtMoney(line.amount)}</td>
          </tr>
        );
      })}
    </tbody>
  );
}
