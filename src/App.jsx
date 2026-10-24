import { useEffect, useState } from 'react';
import { apps, viewsOf } from './models.js';
import { Home } from './Home.jsx';
import { Navbar } from './Navbar.jsx';
import { ActionView } from './ActionView.jsx';
import { FormView } from './FormView.jsx';

// Routes: #/                      home
//         #/<app>/<menu>?view=v    action (kanban | list)
//         #/<app>/<menu>/<id|new>  form
function parseHash() {
  const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const [app, menu = '0', id] = path.split('/').filter(Boolean);
  return { app, menu: Number(menu), id, view: new URLSearchParams(query).get('view') };
}

export const go = (hash) => { location.hash = hash; };

export function App() {
  const [route, setRoute] = useState(parseHash);
  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const app = apps.find((a) => a.id === route.app);
  const menu = app?.menus[route.menu];
  if (!menu) return <Home />;

  const view = viewsOf(menu.model).includes(route.view) ? route.view : viewsOf(menu.model)[0];
  const base = `#/${app.id}/${route.menu}`;
  return (
    <div className="shell">
      <Navbar app={app} menuIndex={route.menu} />
      {route.id ? (
        <FormView key={`${menu.model}:${route.id}`} model={menu.model} id={route.id} menu={menu} base={base} view={view} />
      ) : (
        <ActionView key={`${base}`} model={menu.model} menu={menu} base={base} view={view} />
      )}
    </div>
  );
}
