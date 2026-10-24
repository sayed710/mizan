import { useEffect, useRef, useState } from 'react';
import { companiesOf, currentCompany, switchCompany, useDb } from './store.js';
import { search } from './orm.js';
import { activityState } from './models/mail.js';
import { t } from './i18n.js';
import { Avatar, Icon } from './ui.jsx';

function MenuGroup({ app, menu, active }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const isActive = menu.children.some((c) => c.key === active);
  return (
    <div className="nav-group" ref={ref}>
      <button type="button" className={isActive ? 'active' : ''} aria-expanded={open} onClick={() => setOpen(!open)}>{t(menu.label)}</button>
      {open && (
        <div className="nav-dropdown" role="menu">
          {menu.children.map((c) => (
            <a key={c.key} role="menuitem" href={`#/${app.id}/${c.key}`} className={c.key === active ? 'active' : ''} onClick={() => setOpen(false)}>{t(c.label)}</a>
          ))}
        </div>
      )}
    </div>
  );
}

function ActivityCounter({ db }) {
  const due = search(db, 'mail.activity').filter((a) => ['overdue', 'today'].includes(activityState(a))).length;
  return (
    <a className="systray" href="#/discuss/activities" aria-label={`${t('Activities')}: ${due}`} title={t('Activities')}>
      <Icon name="timesheets" size={18} />
      {due > 0 && <span className="systray-badge">{due}</span>}
    </a>
  );
}

export function Navbar({ app, active }) {
  const db = useDb();
  return (
    <header className="navbar">
      <a href="#/" className="nav-home" aria-label={t('Home menu')}><Icon name="grid" size={18} /></a>
      <a href={`#/${app.id}`} className="nav-app">{t(app.name)}</a>
      <nav className="nav-menus" aria-label={t(app.name)}>
        {app.menus.map((m) => (m.children
          ? <MenuGroup key={m.label} app={app} menu={m} active={active} />
          : <a key={m.key} href={`#/${app.id}/${m.key}`} className={m.key === active ? 'active' : ''}>{t(m.label)}</a>))}
      </nav>
      <span className="spacer" />
      <a className="systray" href="#/studio/fields" aria-label={t('Toggle Studio')} title={t('Studio')}><Icon name="studio" size={18} /></a>
      <ActivityCounter db={db} />
      {companiesOf(db).length > 1
        ? (
          <select className="company-switch" aria-label={t('Company')} value={currentCompany(db).id} onChange={(e) => switchCompany(e.target.value)}>
            {companiesOf(db).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )
        : <a className="company" href="#/settings/general">{db.settings?.company}</a>}
      <Avatar name="Admin" />
    </header>
  );
}
