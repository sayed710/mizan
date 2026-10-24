import { useState } from 'react';
import { models } from '../models/index.js';
import { groupRecords } from '../orm.js';
import { isoDate } from '../models/common.js';
import { t } from '../i18n.js';
import { formatDate } from '../ui.jsx';

const DAY = 864e5;
const parse = (s) => new Date(s + 'T00:00');

/** Month timeline: one row per group (e.g. employee), one bar per record from start to stop (inclusive). */
export function Gantt({ db, model, records, open }) {
  const g = models[model].gantt;
  const [cursor, setCursor] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const days = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
  const first = isoDate(cursor);
  const last = isoDate(new Date(cursor.getFullYear(), cursor.getMonth(), days));
  const todayIdx = Math.floor((Date.now() - cursor.getTime()) / DAY);
  const move = (n) => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + n, 1));

  const visible = records.filter((r) => r[g.start] && (r[g.stop] ?? r[g.start]) >= first && r[g.start] <= last);
  const rows = groupRecords(db, model, visible, g.row).filter((x) => x.records.length);
  const col = (date) => Math.min(days, Math.max(1, Math.round((parse(date) - cursor) / DAY) + 1));

  return (
    <div className="gantt-view">
      <div className="view-toolbar">
        <button type="button" className="btn sm" aria-label="Previous month" onClick={() => move(-1)}>‹</button>
        <button type="button" className="btn sm" aria-label="Next month" onClick={() => move(1)}>›</button>
        <button type="button" className="btn sm" onClick={() => { const d = new Date(); setCursor(new Date(d.getFullYear(), d.getMonth(), 1)); }}>{t('Today')}</button>
        <h2 className="cal-title">{formatDate(first, { month: 'long', year: 'numeric' })}</h2>
      </div>
      <div className="gantt" style={{ '--days': days }} role="table">
        <div className="gantt-head" role="row">
          <div className="gantt-label" role="columnheader">{t(models[model].fields[g.row].label)}</div>
          {Array.from({ length: days }, (_, i) => (
            <div key={i} role="columnheader" className={`gantt-day ${i === todayIdx ? 'today' : ''}`}>{i + 1}</div>
          ))}
        </div>
        {rows.map((row) => (
          <div key={String(row.key)} className="gantt-row" role="row">
            <div className="gantt-label" role="rowheader">{t(row.label)}</div>
            <div className="gantt-track" style={{ gridColumn: `2 / span ${days}` }}>
              {row.records.map((r) => {
                const from = col(r[g.start] < first ? first : r[g.start]);
                const to = col((r[g.stop] ?? r[g.start]) > last ? last : (r[g.stop] ?? r[g.start]));
                return (
                  <button key={r.id} type="button" className={`gantt-bar state-${r[g.color] ?? ''}`} title={`${r.name ?? ''} · ${r[g.start]} → ${r[g.stop] ?? r[g.start]}`}
                    style={{ gridColumn: `${from} / ${to + 1}` }} onClick={() => open(r.id)}>
                    {r[g.title ?? 'name']}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        {!rows.length && <p className="empty">{t('No record found. Create one with “New”.')}</p>}
      </div>
    </div>
  );
}
