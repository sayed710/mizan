import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';
import { isRtl, lang } from './i18n.js';
import './styles.css';
import './views.css';

document.documentElement.lang = lang;
document.documentElement.dir = isRtl ? 'rtl' : 'ltr';

createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>);
