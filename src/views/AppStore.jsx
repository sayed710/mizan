// Apps (install/uninstall), the Attendance kiosk and the cap table.
import { useState } from 'react';
import { apps, APP_INFO } from '../models/index.js';
import { create, read, search, updateSettings, write } from '../orm.js';
import { workedHours } from '../models/apps2.js';
import { capTable } from '../models/apps4.js';
import { today } from '../models/common.js';
import { commit, getDb, useDb } from '../store.js';
import { t } from '../i18n.js';
import { Avatar, Icon } from '../ui.jsx';

const CORE = new Set(['settings', 'apps']);

export function AppStore() {
  const db = useDb();
  const [category, setCategory] = useState('All');
  const [query, setQuery] = useState('');
  const uninstalled = new Set(db.settings?.uninstalled ?? []);
  const categories = ['All', ...new Set(Object.values(APP_INFO).map(([c]) => c))];
  const shown = apps.filter((a) => !CORE.has(a.id)
    && (category === 'All' || APP_INFO[a.id]?.[0] === category)
    && t(a.name).toLowerCase().includes(query.toLowerCase()));
  const toggle = (id) => {
    const next = uninstalled.has(id) ? [...uninstalled].filter((x) => x !== id) : [...uninstalled, id];
    commit(updateSettings(getDb(), { uninstalled: next }));
  };
  return (
    <main className="action appstore">
      <div className="control-panel">
        <h1 className="cp-title">{t('Apps')}</h1>
        <div className="search"><span className="search-icon">⌕</span><input value={query} placeholder={t('Search...')} aria-label={t('Search')} onChange={(e) => setQuery(e.target.value)} /></div>
        <span className="pager">{shown.length}</span>
      </div>
      <div className="appstore-body">
        <aside className="appstore-side">
          <h3>{t('Categories')}</h3>
          {categories.map((c) => (
            <button key={c} type="button" aria-current={category === c ? 'true' : undefined} onClick={() => setCategory(c)}>
              {t(c)} <span className="count">{c === 'All' ? '' : Object.values(APP_INFO).filter(([x]) => x === c).length}</span>
            </button>
          ))}
        </aside>
        <div className="appstore-grid">
          {shown.map((a) => {
            const installed = !uninstalled.has(a.id);
            return (
              <article key={a.id} className="app-card">
                <span className="app-icon small" style={{ background: `linear-gradient(135deg, ${a.color[0]}, ${a.color[1]})` }}><Icon name={a.id} size={26} /></span>
                <div className="grow">
                  <h2>{t(a.name)}</h2>
                  <p className="muted">{t(APP_INFO[a.id]?.[1] ?? '')}</p>
                  <div className="row">
                    {installed
                      ? <><a className="btn sm" href={`#/${a.id}`}>{t('Open')}</a><button type="button" className="btn sm" onClick={() => toggle(a.id)}>{t('Uninstall')}</button></>
                      : <button type="button" className="btn primary sm" onClick={() => toggle(a.id)}>{t('Activate')}</button>}
                  </div>
                </div>
                {installed && <span className="badge installed">{t('Installed')}</span>}
              </article>
            );
          })}
        </div>
      </div>
    </main>
  );
}

const nowHM = () => new Date().toTimeString().slice(0, 5);

/** Tap your name to check in / out; open attendance = today's record without check-out. */
export function Kiosk() {
  const db = useDb();
  const [flash, setFlash] = useState(null);
  const open = (empId) => search(db, 'hr.attendance').find((a) => a.employee_id === empId && a.date === today() && !a.check_out);
  const tap = (emp) => {
    const current = open(emp.id);
    if (current) {
      const next = write(getDb(), 'hr.attendance', current.id, { check_out: nowHM() });
      commit(next);
      setFlash(t('Goodbye {name}! Worked {h} h today.', { name: emp.name, h: workedHours(read(next, 'hr.attendance', current.id)) }));
    } else {
      commit(create(getDb(), 'hr.attendance', { employee_id: emp.id, date: today(), check_in: nowHM() }).db);
      setFlash(t('Welcome {name}! Checked in at {time}.', { name: emp.name, time: nowHM() }));
    }
  };
  return (
    <main className="action kiosk">
      <div className="control-panel"><h1 className="cp-title">{t('Kiosk Mode')}</h1>{flash && <span role="status" className="kiosk-flash">{flash}</span>}</div>
      <div className="kiosk-grid">
        {search(db, 'hr.employee').map((e) => {
          const isIn = !!open(e.id);
          return (
            <button key={e.id} type="button" className={`kiosk-card ${isIn ? 'in' : ''}`} onClick={() => tap(e)}>
              <Avatar name={e.name} size={56} />
              <b>{e.name}</b>
              <span>{isIn ? t('Check Out') : t('Check In')}</span>
            </button>
          );
        })}
      </div>
    </main>
  );
}

/** Answer a published survey; submitting stores a survey.answer and bumps the response counter. */
/** Shareholders with their share count and ownership percentage. */
export function CapTable() {
  const db = useDb();
  const rows = capTable(db).sort((a, b) => b.shares - a.shares);
  return (
    <main className="action">
      <div className="control-panel"><h1 className="cp-title">{t('Cap Table')}</h1><a className="btn sm" href="#/equity/transactions/new">{t('New')}</a></div>
      <div className="list-wrap">
        <table className="list">
          <thead><tr><th>{t('Shareholder')}</th><th className="num">{t('Shares')}</th><th className="num">{t('Ownership')}</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.partner_id}><td>{read(db, 'res.partner', r.partner_id)?.name}</td><td className="num">{r.shares.toLocaleString('en-US')}</td><td className="num">{r.pct}%</td></tr>
            ))}
            {!rows.length && <tr><td colSpan={3} className="empty">{t('No record found. Create one with “New”.')}</td></tr>}
          </tbody>
        </table>
      </div>
    </main>
  );
}
