import { StrictMode, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { initStore } from './store.js';
import { isRtl, lang, resolvedTheme, t } from './i18n.js';
import { ErrorBoundary, Loading } from './ui.jsx';
import './styles.css';
import './views.css';
import './theme.css';

// Each entry screen is its own chunk: visitors and the login page do not download the back office.
const App = lazy(() => import('./App.jsx').then((m) => ({ default: m.App })));
const Login = lazy(() => import('./Login.jsx').then((m) => ({ default: m.Login })));
const PublicSite = lazy(() => import('./views/PublicSite.jsx').then((m) => ({ default: m.PublicSite })));

document.documentElement.lang = lang;
document.documentElement.dir = isRtl ? 'rtl' : 'ltr';
document.documentElement.dataset.theme = resolvedTheme();

function StartupError({ error }) {
  return (
    <main className="boot" role="alert">
      <p>{t('Mizan could not start')}: {String(error?.message ?? error)}</p>
      <button type="button" className="btn primary" onClick={() => location.reload()}>{t('Try again')}</button>
    </main>
  );
}

const root = createRoot(document.getElementById('root'));
const render = (page) => root.render(<StrictMode><ErrorBoundary><Suspense fallback={<Loading />}>{page}</Suspense></ErrorBoundary></StrictMode>);
render(<Loading />);
initStore().then(({ mode, user }) => {
  // Visitors without an account can browse the public website at #/shop.
  const anonymous = mode === 'server' && !user;
  const isPublic = () => anonymous && location.hash.startsWith('#/shop');
  const startedPublic = isPublic();
  render(startedPublic ? <PublicSite /> : anonymous ? <Login /> : <App />);
  // The public site routes inside #/shop… itself: reload only when switching between it and the login page.
  window.addEventListener('hashchange', () => { if (anonymous && isPublic() !== startedPublic) location.reload(); });
}, (error) => render(<StartupError error={error} />));
