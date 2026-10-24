import { useState } from 'react';
import { models, today } from '../models/index.js';
import { formatDate } from '../ui.jsx';
import { t } from '../i18n.js';

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Six-week month grid starting on Sunday. */
function monthDays(year, month) {
  const first = new Date(year, month, 1);
  const start = new Date(year, month, 1 - first.getDay());
  return Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
}

export function CalendarView({ model, records, open, newHref }) {
  const cal = models[model].calendar;
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    return { y: d.getFullYear(), m: d.getMonth() };
  });
  const move = (n) => setCursor(({ y, m }) => ({ y: y + Math.floor((m + n) / 12), m: (((m + n) % 12) + 12) % 12 }));
  const days = monthDays(cursor.y, cursor.m);
  const byDay = records.reduce((acc, r) => {
    const d = r[cal.date];
    return d ? { ...acc, [d]: [...(acc[d] ?? []), r] } : acc;
  }, {});
  const now = today();
  const weekdays = days.slice(0, 7).map((d) => formatDate(iso(d), { weekday: 'short' }));

  return (
    <div className="calendar-view">
      <div className="view-toolbar">
        <button type="button" className="btn sm" aria-label="Previous month" onClick={() => move(-1)}>‹</button>
        <button type="button" className="btn sm" aria-label="Next month" onClick={() => move(1)}>›</button>
        <button type="button" className="btn sm" onClick={() => setCursor({ y: new Date().getFullYear(), m: new Date().getMonth() })}>{t('Today')}</button>
        <h2 className="cal-title">{formatDate(iso(new Date(cursor.y, cursor.m, 1)), { month: 'long', year: 'numeric' })}</h2>
      </div>
      <div className="cal-grid" role="grid">
        {weekdays.map((w) => <div key={w} className="cal-head" role="columnheader">{w}</div>)}
        {days.map((d) => {
          const key = iso(d);
          const items = byDay[key] ?? [];
          return (
            <div key={key} role="gridcell" className={`cal-day ${d.getMonth() !== cursor.m ? 'other' : ''} ${key === now ? 'today' : ''}`}>
              <div className="cal-day-head">
                <span className="cal-num">{d.getDate()}</span>
                {newHref && <a className="cal-add" href={`${newHref}&default_${cal.date}=${key}`} aria-label={`${t('New')} ${key}`}>+</a>}
              </div>
              {items.map((r) => (
                <button key={r.id} type="button" className="cal-event" onClick={() => open(r.id)} title={r.name}>
                  {cal.time && r[cal.time] && <b>{r[cal.time]} </b>}{r.name}
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
