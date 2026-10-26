import { useState } from 'react';
import { models } from '../models/index.js';
import { groupRecords, write } from '../orm.js';
import { addDays, isoDate } from '../models/common.js';
import { commit, getDb } from '../store.js';
import { t } from '../i18n.js';
import { formatDate } from '../ui.jsx';

const DAY = 864e5;
const parse = (s) => new Date(String(s).slice(0, 10) + 'T00:00'); // dates, or the day of a datetime
const diffDays = (a, b) => Math.round((parse(b) - parse(a)) / DAY);
const weekStart = (d) => { const x = new Date(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return new Date(x.getFullYear(), x.getMonth(), x.getDate()); };

/**
 * Timeline (week or month): one row per resource, bars from start to stop.
 * Drag a bar to another day (dates shift, duration kept) and/or another row (resource changes);
 * drag an item from "to schedule" onto a cell to plan it.
 */
export function Gantt({ db, model, records, open }) {
  const g = models[model].gantt;
  const rowField = models[model].fields[g.row];
  const [scale, setScale] = useState('week');
  const [cursor, setCursor] = useState(() => weekStart(new Date()));
  const [over, setOver] = useState(null);

  const start = scale === 'week' ? weekStart(cursor) : new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const days = scale === 'week' ? 7 : new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
  const first = isoDate(start);
  const last = addDays(first, days - 1);
  const dates = Array.from({ length: days }, (_, i) => addDays(first, i));
  const todayIso = isoDate(new Date());
  const move = (n) => setCursor(scale === 'week' ? new Date(start.getTime() + n * 7 * DAY) : new Date(start.getFullYear(), start.getMonth() + n, 1));

  const stopOf = (r) => r[g.stop] ?? r[g.start];
  const visible = records.filter((r) => r[g.start] && stopOf(r) >= first && r[g.start] <= last);
  const unplanned = records.filter((r) => !r[g.row] || !r[g.start]);
  const rows = groupRecords(db, model, visible.filter((r) => r[g.row]), g.row).filter((x) => x.records.length);
  const openRow = visible.filter((r) => !r[g.row]);
  const col = (date) => Math.min(days, Math.max(1, diffDays(first, date) + 1));
  const hours = (recs) => (g.hours ? recs.reduce((s, r) => s + (Number(r[g.hours]) || 0), 0) : null);

  const drop = (e, rowKey, date) => {
    e.preventDefault();
    setOver(null);
    const id = Number(e.dataTransfer.getData('text/plain'));
    const rec = records.find((r) => r.id === id);
    if (!rec) return;
    const vals = { [g.row]: rowKey === false ? null : rowKey };
    if (rec[g.start]) {
      const grab = Number(e.dataTransfer.getData('application/x-offset')) || 0; // day of the bar that was grabbed
      const shift = diffDays(rec[g.start], date) - grab;
      vals[g.start] = addDays(rec[g.start], shift);
      if (rec[g.stop]) vals[g.stop] = addDays(rec[g.stop], shift);
    } else {
      vals[g.start] = date;
      if (g.stop in models[model].fields) vals[g.stop] = date;
    }
    commit(write(getDb(), model, id, vals));
  };

  const Row = ({ label, rowKey, recs }) => (
    <div className="gantt-row" role="row">
      <div className="gantt-label" role="rowheader">
        <span>{label}</span>
        {hours(recs) != null && <span className="gantt-hours">{hours(recs)}h</span>}
      </div>
      <div className="gantt-track" style={{ gridColumn: `2 / span ${days}` }}>
        {dates.map((d, i) => (
          <div
            key={d}
            className={`gantt-cell ${[0, 6].includes(parse(d).getDay()) ? 'weekend' : ''} ${over === `${String(rowKey)}|${d}` ? 'drop' : ''}`}
            style={{ gridColumn: `${i + 1} / ${i + 2}`, gridRow: '1 / -1' }}
            onDragOver={(e) => { e.preventDefault(); setOver(`${String(rowKey)}|${d}`); }}
            onDragLeave={() => setOver(null)}
            onDrop={(e) => drop(e, rowKey, d)}
          />
        ))}
        {recs.map((r) => {
          const from = col(r[g.start] < first ? first : r[g.start]);
          const to = col(stopOf(r) > last ? last : stopOf(r));
          return (
            <button
              key={r.id}
              type="button"
              draggable
              className={`gantt-bar state-${r[g.color] ?? ''}`}
              title={`${r[g.title ?? 'name'] ?? ''} · ${r[g.start]} → ${stopOf(r)}`}
              style={{ gridColumn: `${from} / ${to + 1}` }}
              onDragStart={(e) => {
                e.dataTransfer.setData('text/plain', String(r.id));
                const rect = e.currentTarget.getBoundingClientRect();
                const dayWidth = rect.width / (to - from + 1);
                // Days between the record's real start and the grabbed day (bars may start before the visible range).
                const grabbedDay = Math.floor((e.clientX - rect.left) / dayWidth) + (from - 1) - diffDays(first, r[g.start]);
                e.dataTransfer.setData('application/x-offset', String(Math.max(0, grabbedDay)));
              }}
              onClick={() => open(r.id)}
            >
              {r[g.title ?? 'name']}
            </button>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="gantt-view">
      <div className="view-toolbar">
        <button type="button" className="btn sm" aria-label="Previous" onClick={() => move(-1)}>‹</button>
        <button type="button" className="btn sm" aria-label="Next" onClick={() => move(1)}>›</button>
        <div className="seg" role="group">
          {['week', 'month'].map((s) => <button key={s} type="button" aria-pressed={scale === s} onClick={() => setScale(s)}>{t(s === 'week' ? 'Week' : 'Month')}</button>)}
        </div>
        <button type="button" className="btn sm" onClick={() => setCursor(weekStart(new Date()))}>{t('Today')}</button>
        <h2 className="cal-title">{scale === 'week' ? `${formatDate(first, { day: 'numeric', month: 'short' })} – ${formatDate(last, { day: 'numeric', month: 'short', year: 'numeric' })}` : formatDate(first, { month: 'long', year: 'numeric' })}</h2>
      </div>
      <div className="gantt-layout">
        <div className="gantt" style={{ '--days': days }} role="table">
          <div className="gantt-head" role="row">
            <div className="gantt-label" role="columnheader">{t(rowField.label)}</div>
            {dates.map((d) => (
              <div key={d} role="columnheader" className={`gantt-day ${d === todayIso ? 'today' : ''} ${[0, 6].includes(parse(d).getDay()) ? 'weekend' : ''}`}>
                {scale === 'week' ? formatDate(d, { weekday: 'short', day: 'numeric' }) : parse(d).getDate()}
              </div>
            ))}
          </div>
          {(openRow.length > 0 || unplanned.length > 0) && <Row label={t(g.openLabel ?? 'Open Shifts')} rowKey={false} recs={openRow} />}
          {rows.map((row) => <Row key={String(row.key)} label={t(row.label)} rowKey={row.key} recs={row.records} />)}
          {!rows.length && !openRow.length && <p className="empty">{t('No record found. Create one with “New”.')}</p>}
        </div>
        {unplanned.length > 0 && (
          <aside className="gantt-side" aria-label={t('To schedule')}>
            <h3>{unplanned.length} {t('to schedule')}</h3>
            {unplanned.map((r) => (
              <button key={r.id} type="button" draggable className="gantt-chip"
                onDragStart={(e) => e.dataTransfer.setData('text/plain', String(r.id))} onClick={() => open(r.id)}>
                ⠿ {r[g.title ?? 'name']}
              </button>
            ))}
          </aside>
        )}
      </div>
    </div>
  );
}
