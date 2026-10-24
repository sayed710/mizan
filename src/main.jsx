import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';
import { Login } from './Login.jsx';
import { initStore } from './store.js';
import { isRtl, lang } from './i18n.js';
import './styles.css';
import './views.css';

document.documentElement.lang = lang;
document.documentElement.dir = isRtl ? 'rtl' : 'ltr';

const root = createRoot(document.getElementById('root'));
initStore().then(({ mode, user }) => {
  root.render(<StrictMode>{mode === 'server' && !user ? <Login /> : <App />}</StrictMode>);
});
