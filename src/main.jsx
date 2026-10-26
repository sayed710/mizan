import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';
import { Login } from './Login.jsx';
import { PublicSite } from './views/PublicSite.jsx';
import { initStore } from './store.js';
import { isRtl, lang, resolvedTheme } from './i18n.js';
import './styles.css';
import './views.css';
import './theme.css';

document.documentElement.lang = lang;
document.documentElement.dir = isRtl ? 'rtl' : 'ltr';
document.documentElement.dataset.theme = resolvedTheme();

const root = createRoot(document.getElementById('root'));
initStore().then(({ mode, user }) => {
  // Visitors without an account can browse the public website at #/shop.
  const anonymous = mode === 'server' && !user;
  const isPublic = () => anonymous && location.hash.startsWith('#/shop');
  const startedPublic = isPublic();
  const page = startedPublic ? <PublicSite /> : anonymous ? <Login /> : <App />;
  root.render(<StrictMode>{page}</StrictMode>);
  // The public site routes inside #/shop… itself: reload only when switching between it and the login page.
  window.addEventListener('hashchange', () => { if (anonymous && isPublic() !== startedPublic) location.reload(); });
}).catch((e) => {
  // The server is there but the database did not load: show the error instead of working on stale or demo data.
  root.render(
    <div role="alert" style={{ padding: 24 }}>
      <p>{`Mizan could not load your data: ${e.message}`}</p>
      <button type="button" onClick={() => location.reload()}>Retry</button>
    </div>,
  );
});
