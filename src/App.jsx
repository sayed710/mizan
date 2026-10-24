import { useEffect, useState } from 'react';
import { apps, findLeaf, targetOf } from './models/index.js';
import { Home } from './Home.jsx';
import { Navbar } from './Navbar.jsx';
import { ActionView } from './views/ActionView.jsx';
import { FormView } from './views/FormView.jsx';
import { Dashboard } from './views/Dashboard.jsx';
import { Settings } from './views/Settings.jsx';
import { Pos } from './views/Pos.jsx';
import { Discuss } from './views/Discuss.jsx';
import { Reports } from './views/Reports.jsx';
import { Barcode, Overview, ShopFloor } from './views/Pages.jsx';
import { Website } from './views/Website.jsx';
import { AppStore, Kiosk, SurveyTake } from './views/AppStore.jsx';
import { Studio } from './views/Studio.jsx';
import { Kitchen } from './views/Kitchen.jsx';
import { PrintDoc } from './views/PrintDoc.jsx';

// Routes: #/                          home
//         #/<app>/<menu>?view=v&rel=   action (kanban | list | graph | pivot | calendar)
//         #/<app>/<menu>/<id|new>      form
function parseHash() {
  const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const [app, menu, id] = path.split('/').filter(Boolean);
  return { app, menu, id, query, params: new URLSearchParams(query) };
}

const PAGES = { dashboard: Dashboard, settings: Settings, pos: Pos, discuss: Discuss, report: Reports, barcode: Barcode, shopfloor: ShopFloor, overview: Overview, website: Website, appstore: AppStore, kiosk: Kiosk, surveytake: SurveyTake, studio: Studio, kitchen: Kitchen };

export function App() {
  const [route, setRoute] = useState(parseHash);
  useEffect(() => {
    const onHash = () => { setRoute(parseHash()); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  if (route.app === 'print') return <PrintDoc model={route.menu} id={route.id} />;
  if (route.app === 'open') {
    // #/open/<model>/<id>: jump to the record inside whichever app shows that model.
    location.replace(`${targetOf(route.menu)}/${route.id}`);
    return null;
  }
  const app = apps.find((a) => a.id === route.app);
  if (!app) return <Home />;
  const leaf = findLeaf(app, route.menu);
  const base = `#/${app.id}/${leaf.key}`;
  const Page = PAGES[leaf.type];

  let content;
  if (Page) content = <Page key={leaf.key} leaf={leaf} />;
  else if (route.id) content = <FormView key={`${leaf.model}:${route.id}`} leaf={leaf} id={route.id} base={base} params={route.params} />;
  else content = <ActionView key={`${base}?${route.params.get('rel') ?? ''}`} leaf={leaf} base={base} params={route.params} />;

  return (
    <div className="shell">
      <Navbar app={app} active={leaf.key} />
      {content}
    </div>
  );
}
