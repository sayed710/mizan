import { useState } from 'react';
import { apps } from './models.js';
import { resetDemo } from './store.js';
import { Avatar, Icon } from './ui.jsx';

export function Home() {
  const [query, setQuery] = useState('');
  const shown = apps.filter((a) => a.name.toLowerCase().includes(query.toLowerCase()));
  return (
    <main className="home">
      <header className="home-top">
        <span className="brand">Mizan</span>
        <span className="spacer" />
        <button type="button" className="link" onClick={() => { if (confirm('Reset all data to the demo database?')) resetDemo(); }}>
          Reset demo
        </button>
        <span className="company">My Company</span>
        <Avatar name="Admin" />
      </header>
      <input
        className="menu-search"
        autoFocus
        placeholder="Search for a menu..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && shown[0]) location.hash = `#/${shown[0].id}/0`; }}
        aria-label="Search for a menu"
      />
      <nav className="app-grid" aria-label="Applications">
        {shown.map((a) => (
          <a key={a.id} className="app-tile" href={`#/${a.id}/0`}>
            <span className="app-icon" style={{ background: `linear-gradient(135deg, ${a.color[0]}, ${a.color[1]})` }}>
              <Icon name={a.id} size={34} />
            </span>
            <span>{a.name}</span>
          </a>
        ))}
        {!shown.length && <p className="muted">No app matches “{query}”.</p>}
      </nav>
    </main>
  );
}
