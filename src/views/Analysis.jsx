import { useState } from 'react';
import { read } from '../orm.js';
import { appAnalyses, recordAnalyses } from '../models/analysis.js';
import { useDb } from '../store.js';
import { t } from '../i18n.js';
import { PERIODS } from './Reports.jsx';
import { companyViewDb } from '../companyView.js';

// Ids in analysis results are shown by name when the key says which model they point at.
const RELATIONS = {
  product_id: 'product', partner_id: 'res.partner', employee_id: 'hr.employee', technician_id: 'hr.employee', manager_id: 'hr.employee',
  host_id: 'hr.employee', supplier_id: 'lunch.supplier', project_id: 'project.project', task_id: 'project.task', category_id: 'product.category',
  account_id: 'account.account', move_id: 'account.move', vehicle_id: 'fleet.vehicle', job_id: 'hr.job', team_id: 'helpdesk.team',
};
/** "averageRating" / "amount_total" -> "Average Rating" / "Amount Total". */
const label = (key) => t(String(key).replace(/_id$/, '').replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\b\w/g, (c) => c.toUpperCase()));

function Value({ db, k, v }) {
  if (v == null || v === '') {
    if (k === 'manager_id') return <span className="muted">{t('Unassigned')}</span>;
    return <span className="muted">—</span>;
  }
  if (Array.isArray(v) || typeof v === 'object') return <DataView db={db} value={v} />;
  if (typeof v === 'number') {
    const model = RELATIONS[k];
    if (model && Number.isInteger(v)) return <>{read(db, model, v)?.name ?? v}</>;
    return <>{v.toLocaleString(undefined, { maximumFractionDigits: 2 })}</>;
  }
  if (typeof v === 'boolean') return <>{v ? '✓' : '—'}</>;
  return <>{String(v)}</>;
}

/** Renders whatever an analysis returns: a list of rows as a table, an object as label/value pairs. */
export function DataView({ db, value }) {
  if (value == null) return <p className="empty">{t('No data for this period.')}</p>;
  if (Array.isArray(value)) {
    if (!value.length) return <p className="empty">{t('No data for this period.')}</p>;
    if (value.every((r) => r && typeof r === 'object' && !Array.isArray(r))) {
      // Skip ids that a readable sibling already names (product_id beside product) and columns empty in every row.
      const keys = [...new Set(value.flatMap(Object.keys))];
      const cols = keys.filter((c) => c !== 'id' && !(c.endsWith('_id') && keys.includes(c.slice(0, -3)))
        && (c === 'manager_id' || value.some((r) => r[c] != null && r[c] !== '')));
      return (
        <div className="list-wrap">
          <table className="list analysis">
            <thead><tr>{cols.map((c) => <th key={c}>{label(c)}</th>)}</tr></thead>
            <tbody>{value.map((r, i) => <tr key={i}>{cols.map((c) => <td key={c} className={typeof r[c] === 'number' ? 'num' : ''}><Value db={db} k={c} v={r[c]} /></td>)}</tr>)}</tbody>
          </table>
        </div>
      );
    }
    return <ul>{value.map((v, i) => <li key={i}><Value db={db} k="" v={v} /></li>)}</ul>;
  }
  if (typeof value !== 'object') return <p><Value db={db} k="" v={value} /></p>;
  return (
    <dl className="analysis-dl">
      {Object.entries(value).map(([k, v]) => (
        <div key={k}><dt>{label(k)}</dt><dd><Value db={db} k={k} v={v} /></dd></div>
      ))}
    </dl>
  );
}

export function AnalysisResult({ db, run }) {
  try {
    const view = companyViewDb(db);
    return <DataView db={view} value={run(view)} />;
  } catch (e) {
    return <p className="alert" role="alert">{t(e.message)}</p>;
  }
}

/** Analyses of one record, computed only when opened. */
export function RecordAnalysis({ db, model, rec }) {
  const [open, setOpen] = useState(() => new Set());
  const list = (recordAnalyses[model] ?? []).filter((a) => !a.when || a.when(rec));
  if (!list.length) return null;
  return (
    <section className="record-analysis" aria-label={t('Analysis')}>
      <h2>{t('Analysis')}</h2>
      {list.map((a) => (
        <details key={a.label} onToggle={(e) => { const next = new Set(open); if (e.currentTarget.open) next.add(a.label); else next.delete(a.label); setOpen(next); }}>
          <summary>{t(a.label)}</summary>
          {open.has(a.label) && <AnalysisResult db={db} run={(view) => a.run(view, rec)} />}
        </details>
      ))}
    </section>
  );
}

/** Menu page for an app-level analysis (leaf.analysis). */
export function AnalysisPage({ leaf }) {
  const db = useDb();
  const [periodKey, setPeriodKey] = useState('year');
  const entry = appAnalyses.find((a) => a.key === leaf.analysis);
  if (!entry) return <main className="action"><p className="empty">{t('Record not found.')}</p></main>;
  return (
    <main className="action report-page">
      <div className="control-panel">
        <h1 className="cp-title">{t(entry.label)}</h1>
        {entry.period !== false && (
          <label className="inline-select">
            {t('Period')}
            <select value={periodKey} onChange={(e) => setPeriodKey(e.target.value)}>
              <option value="month">{t('This Month')}</option>
              <option value="quarter">{t('This Quarter')}</option>
              <option value="year">{t('This Year')}</option>
              <option value="all">{t('All Dates')}</option>
            </select>
          </label>
        )}
      </div>
      <AnalysisResult db={db} run={(view) => entry.run(view, PERIODS[periodKey]())} />
    </main>
  );
}
