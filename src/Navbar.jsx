import { useEffect, useRef, useState } from 'react';
import { companiesOf, currentCompany, getUser, isServer, logout, switchCompany, useDb } from './store.js';
import { myEmployeeId } from './access.js';
import { viewRecords as search } from './companyView.js';
import { activityState } from './models/mail.js';
import { t } from './i18n.js';
import { Avatar, Icon, menuKeys, useDismiss } from './ui.jsx';

function MenuGroup({ app, menu, active }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useDismiss(open, () => setOpen(false), ref);
  // Opening from the keyboard moves focus into the menu, as in other menu buttons.
  useEffect(() => { if (open) ref.current?.querySelector('[role=menuitem]')?.focus({ preventScroll: true }); }, [open]);
  const hasKey = (item) => (item.children ? item.children.some(hasKey) : item.key === active);
  const isActive = menu.children.some(hasKey);
  const renderItem = (c) => {
    if (c.children) {
      return (
        <div key={c.label} className="nav-submenu-group">
          <div className="nav-dropdown-header muted" style={{ padding: '4px 10px', fontSize: '0.75rem', fontWeight: 600, textTransform: 'uppercase' }}>{t(c.label)}</div>
          {c.children.map(renderItem)}
        </div>
      );
    }
    return (
      <a key={c.key} role="menuitem" href={`#/${app.id}/${c.key}`} className={c.key === active ? 'active' : ''} onClick={() => setOpen(false)}>{t(c.label)}</a>
    );
  };
  return (
    <div className="nav-group" ref={ref}>
      <button type="button" className={isActive ? 'active' : ''} aria-expanded={open} onClick={() => setOpen(!open)}>{t(menu.label)}</button>
      {open && (
        <div className="nav-dropdown" role="menu" onKeyDown={menuKeys}>
          {menu.children.map(renderItem)}
        </div>
      )}
    </div>
  );
}

/** Avatar of the signed-in user, opening a menu with Settings and Log out. */
export function UserMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const user = getUser();
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const name = user?.name ?? 'Admin';
  return (
    <div className="nav-group user-menu" ref={ref}>
      <button type="button" aria-expanded={open} aria-label={`${t('User menu')}: ${name}`} onClick={() => setOpen(!open)}><Avatar name={name} /></button>
      {open && (
        <div className="nav-dropdown" role="menu">
          <span className="muted user-menu-name">{name}{user?.login ? ` (${user.login})` : ''}</span>
          <a role="menuitem" href="#/settings/general" onClick={() => setOpen(false)}>{t('Settings')}</a>
          {isServer() && <button type="button" role="menuitem" onClick={logout}>{t('Log out')}</button>}
        </div>
      )}
    </div>
  );
}

function ActivityCounter({ db }) {
  // Only the signed-in user's activities once their login is linked to an employee; everyone's otherwise.
  const mine = myEmployeeId(db, getUser());
  const due = search(db, 'mail.activity').filter((a) => (!mine || a.user_id === mine) && ['overdue', 'today'].includes(activityState(a))).length;
  return (
    <a className="systray" href="#/discuss/activities" aria-label={`${t('Activities')}: ${due}`} title={t('Activities')}>
      <Icon name="timesheets" size={18} />
      {due > 0 && <span className="systray-badge">{due}</span>}
    </a>
  );
}

export function Navbar({ app, active }) {
  const db = useDb();
  // On narrow screens the app's menus fold into a panel opened by a toggle; any navigation closes it.
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    const close = () => setMenuOpen(false);
    window.addEventListener('hashchange', close);
    return () => window.removeEventListener('hashchange', close);
  }, []);
  return (
    <header className="navbar">
      <a href="#/" className="nav-home" aria-label={t('Home menu')}><Icon name="grid" size={18} /></a>
      <a href={`#/${app.id}`} className="nav-app">{t(app.name)}</a>
      <button type="button" className="nav-toggle" aria-expanded={menuOpen} aria-controls="nav-menus" aria-label={t('Menu')}
        onClick={() => setMenuOpen(!menuOpen)}>☰</button>
      <nav id="nav-menus" className={`nav-menus${menuOpen ? ' open' : ''}`} aria-label={t(app.name)} onClick={() => setMenuOpen(false)}>
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
        : <a className="company" href="#/settings/general">{currentCompany(db).name}</a>}
      <UserMenu />
    </header>
  );
}
