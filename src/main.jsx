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
  const page = anonymous && location.hash.startsWith('#/shop') ? <PublicSite /> : anonymous ? <Login /> : <App />;
  root.render(<StrictMode>{page}</StrictMode>);
  window.addEventListener('hashchange', () => { if (anonymous) location.reload(); });
});
