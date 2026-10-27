import { lazy, Suspense, useEffect, useState } from 'react';
import { apps, findLeaf, targetOf } from './models/index.js';
import { Home } from './Home.jsx';
import { Navbar } from './Navbar.jsx';
import { ActionView } from './views/ActionView.jsx';
import { FormView } from './views/FormView.jsx';
import { ErrorBoundary, Loading } from './ui.jsx';

// Screens outside the list/form views load on first visit.
const view = (load, name) => lazy(() => load().then((m) => ({ default: m[name] })));
const Dashboard = view(() => import('./views/Dashboard.jsx'), 'Dashboard');
const Settings = view(() => import('./views/Settings.jsx'), 'Settings');
const Pos = view(() => import('./views/Pos.jsx'), 'Pos');
const Discuss = view(() => import('./views/Discuss.jsx'), 'Discuss');
const Reports = view(() => import('./views/Reports.jsx'), 'Reports');
const Barcode = view(() => import('./views/Pages.jsx'), 'Barcode');
const Overview = view(() => import('./views/Pages.jsx'), 'Overview');
const ShopFloor = view(() => import('./views/Pages.jsx'), 'ShopFloor');
const Website = view(() => import('./views/Website.jsx'), 'Website');
const AppStore = view(() => import('./views/AppStore.jsx'), 'AppStore');
const CapTable = view(() => import('./views/AppStore.jsx'), 'CapTable');
const Kiosk = view(() => import('./views/AppStore.jsx'), 'Kiosk');
const SurveyResults = view(() => import('./views/Survey.jsx'), 'SurveyResults');
const SurveyTake = view(() => import('./views/Survey.jsx'), 'SurveyTake');
const Spreadsheet = view(() => import('./views/Spreadsheet.jsx'), 'Spreadsheet');
const Studio = view(() => import('./views/Studio.jsx'), 'Studio');
const Kitchen = view(() => import('./views/Kitchen.jsx'), 'Kitchen');
const Knowledge = view(() => import('./views/Knowledge.jsx'), 'Knowledge');
const PrintDoc = view(() => import('./views/PrintDoc.jsx'), 'PrintDoc');

// Routes: #/                          home
//         #/<app>/<menu>?view=v&rel=   action (kanban | list | graph | pivot | calendar)
//         #/<app>/<menu>/<id|new>      form
function parseHash() {
  const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const [app, menu, id] = path.split('/').filter(Boolean);
  return { app, menu, id, query, params: new URLSearchParams(query) };
}

const PAGES = { dashboard: Dashboard, settings: Settings, pos: Pos, discuss: Discuss, report: Reports, barcode: Barcode, shopfloor: ShopFloor, overview: Overview, website: Website, appstore: AppStore, kiosk: Kiosk, surveytake: SurveyTake, surveyresults: SurveyResults, studio: Studio, kitchen: Kitchen, captable: CapTable, knowledge: Knowledge, spreadsheet: Spreadsheet };

export function App() {
  const [route, setRoute] = useState(parseHash);
  useEffect(() => {
    const onHash = () => { setRoute(parseHash()); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  if (route.app === 'print') return <Suspense fallback={<Loading />}><PrintDoc model={route.menu} id={route.id} /></Suspense>;
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
      <ErrorBoundary key={location.hash.split('?')[0]}><Suspense fallback={<Loading />}>{content}</Suspense></ErrorBoundary>
    </div>
  );
}
