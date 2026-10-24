import { useState } from 'react';
import { models } from '../models/index.js';
import { aggregate, groupRecords } from '../orm.js';
import { t } from '../i18n.js';
import { formatMeasure, MeasureSelect } from './Graph.jsx';

function FieldSelect({ model, label, value, onChange, allowNone }) {
  const def = models[model];
  return (
    <label className="inline-select">
      {t(label)}
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
        {allowNone && <option value="">—</option>}
        {(def.groupBys ?? []).map((g) => <option key={g} value={g}>{t(def.fields[g].label)}</option>)}
      </select>
    </label>
  );
}

export function Pivot({ db, model, records, groupBy }) {
  const def = models[model].pivot ?? {};
  const [rowField, setRow] = useState(groupBy[0] ?? def.row ?? models[model].groupBys?.[0]);
  const [colField, setCol] = useState(groupBy[1] ?? def.col ?? null);
  const [measure, setMeasure] = useState(def.measure ?? '__count');
  const fmt = (v) => formatMeasure(model, measure, v);

  const rows = rowField ? groupRecords(db, model, records, rowField).filter((g) => g.records.length) : [];
  const cols = colField ? groupRecords(db, model, records, colField).filter((g) => g.records.length) : [];
  const cell = (recs) => fmt(aggregate(recs, measure));
  const inCol = (recs, col) => recs.filter((r) => col.records.includes(r));

  const exportCsv = () => {
    const head = [t(models[model].fields[rowField]?.label ?? ''), ...cols.map((c) => t(c.label)), t('Total')];
    const body = rows.map((r) => [t(r.label), ...cols.map((c) => aggregate(inCol(r.records, c), measure)), aggregate(r.records, measure)]);
    const csv = [head, ...body].map((line) => line.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `${model}-pivot.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="pivot-view">
      <div className="view-toolbar">
        <MeasureSelect model={model} value={measure} onChange={setMeasure} />
        <FieldSelect model={model} label="Rows" value={rowField} onChange={setRow} />
        <FieldSelect model={model} label="Columns" value={colField} onChange={setCol} allowNone />
        <span className="spacer" />
        <button type="button" className="btn sm" onClick={exportCsv}>⬇ {t('Export')}</button>
      </div>
      <div className="list-wrap">
        <table className="list pivot">
          <thead>
            <tr>
              <th />
              {cols.map((c) => <th key={String(c.key)} className="num">{t(c.label)}</th>)}
              <th className="num">{t('Total')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.key)}>
                <th scope="row">{t(r.label)}</th>
                {cols.map((c) => <td key={String(c.key)} className="num">{cell(inCol(r.records, c))}</td>)}
                <td className="num"><b>{cell(r.records)}</b></td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">{t('Total')}</th>
              {cols.map((c) => <td key={String(c.key)} className="num">{cell(c.records)}</td>)}
              <td className="num">{cell(records)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
