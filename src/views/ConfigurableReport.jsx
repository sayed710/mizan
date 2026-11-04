import { useState } from 'react';
import { companyViewDb } from '../companyView.js';
import { configurableReport } from '../models/configurableReports.js';
import { today } from '../models/common.js';
import { useDb } from '../store.js';
import { t } from '../i18n.js';
import { money } from '../ui.jsx';

export function ConfigurableReportPage({ id }) {
  const db = companyViewDb(useDb());
  const [from, setFrom] = useState(`${today().slice(0, 4)}-01-01`);
  const [to, setTo] = useState(`${today().slice(0, 4)}-12-31`);
  const [groupId, setGroupId] = useState('');
  const report = (db.records['account.report'] ?? []).find((r) => r.id === Number(id) && r.active !== false);
  if (!report) return <main className="action"><h1>{t('Accounting Report')}</h1><p>{t('Report not found')}</p></main>;
  const groups = (db.records['account.report.horizontal.group'] ?? []).filter((g) => (g.company_id ?? 1) === (report.company_id ?? 1) && (g.report_ids ?? []).includes(report.id));
  const group = groups.find((g) => g.id === Number(groupId));
  const result = configurableReport(db, report, { from, to }, group);
  return <main className="action report-page">
    <div className="control-panel"><h1 className="cp-title">{report.name}</h1>
      <label>{t('From')}<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
      <label>{t('To')}<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      <label>{t('Horizontal Group')}<select value={group?.id ?? ''} onChange={(e) => setGroupId(e.target.value)}>
        <option value="">{t('No Group')}</option>{groups.map((g) => <option value={g.id} key={g.id}>{g.name}</option>)}
      </select></label>
    </div>
    <div className="list-wrap"><table className="list report"><thead><tr><th>{t('Report Lines')}</th>
      {result.buckets.flatMap((bucket) => result.columns.map((column) => <th className="num" key={`${bucket.key}:${column}`}>{bucket.label ? `${t(bucket.label)} - ` : ''}{t(column === 'balance' ? 'Balance' : column === 'debit' ? 'Debit' : 'Credit')}</th>))}
    </tr></thead><tbody>{result.rows.map((line) => <tr key={line.code}><td style={{ paddingInlineStart: `${line.depth * 1.5 + 0.75}rem` }}>{line.name}</td>{line.values.map((value, index) => <td className="num" key={index}>{money(value)}</td>)}</tr>)}</tbody></table></div>
  </main>;
}
