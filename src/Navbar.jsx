import { Avatar, Icon } from './ui.jsx';

export function Navbar({ app, menuIndex }) {
  return (
    <header className="navbar">
      <a href="#/" className="nav-home" aria-label="Home menu"><Icon name="grid" size={18} /></a>
      <a href={`#/${app.id}/0`} className="nav-app">{app.name}</a>
      <nav className="nav-menus" aria-label={`${app.name} menus`}>
        {app.menus.map((m, i) => (
          <a key={m.label} href={`#/${app.id}/${i}`} className={i === menuIndex ? 'active' : ''}>{m.label}</a>
        ))}
      </nav>
      <span className="spacer" />
      <span className="company">My Company</span>
      <Avatar name="Admin" />
    </header>
  );
}
