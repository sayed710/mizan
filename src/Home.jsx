import { useState } from 'react';
import { apps } from './models/index.js';
import { useDb } from './store.js';
import { t } from './i18n.js';
import { Avatar, Icon } from './ui.jsx';

export function Home() {
  const db = useDb();
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const shown = apps.filter((a) => !q || a.name.toLowerCase().includes(q) || t(a.name).toLowerCase().includes(q));
  return (
    <main className="home">
      <header className="home-top">
        <span className="brand">Mizan</span>
        <span className="spacer" />
        <a className="company" href="#/settings/general">{db.settings?.company}</a>
        <Avatar name="Admin" />
      </header>
      <input
        className="menu-search"
        autoFocus
        placeholder={t('Search for a menu...')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && shown[0]) location.hash = `#/${shown[0].id}`; }}
        aria-label={t('Search for a menu...')}
      />
      <nav className="app-grid" aria-label={t('Applications')}>
        {shown.map((a) => (
          <a key={a.id} className="app-tile" href={`#/${a.id}`}>
            <span className="app-icon" style={{ background: `linear-gradient(135deg, ${a.color[0]}, ${a.color[1]})` }}>
              <Icon name={a.id} size={34} />
            </span>
            <span>{t(a.name)}</span>
          </a>
        ))}
        {!shown.length && <p className="muted">{t('No app matches')} “{query}”.</p>}
      </nav>
    </main>
  );
}
