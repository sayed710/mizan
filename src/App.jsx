import { useEffect, useState } from 'react';
import { useDb } from './store.js';
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
import { AppStore, CapTable, Kiosk } from './views/AppStore.jsx';
import { SurveyResults, SurveyTake } from './views/Survey.jsx';
import { ErrorBoundary } from './ui.jsx';
import { Spreadsheet } from './views/Spreadsheet.jsx';
import { Studio } from './views/Studio.jsx';
import { Kitchen } from './views/Kitchen.jsx';
import { Knowledge } from './views/Knowledge.jsx';
import { PrintDoc } from './views/PrintDoc.jsx';
import { AnalysisPage } from './views/Analysis.jsx';

// Routes: #/                          home
//         #/<app>/<menu>?view=v&rel=   action (kanban | list | graph | pivot | calendar)
//         #/<app>/<menu>/<id|new>      form
function parseHash() {
  const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const [app, menu, id] = path.split('/').filter(Boolean);
  return { app, menu, id, query, params: new URLSearchParams(query) };
}

const PAGES = { analysis: AnalysisPage, dashboard: Dashboard, settings: Settings, pos: Pos, discuss: Discuss, report: Reports, barcode: Barcode, shopfloor: ShopFloor, overview: Overview, website: Website, appstore: AppStore, kiosk: Kiosk, surveytake: SurveyTake, surveyresults: SurveyResults, studio: Studio, kitchen: Kitchen, captable: CapTable, knowledge: Knowledge, spreadsheet: Spreadsheet };

export function App() {
  const db = useDb();
  const [route, setRoute] = useState(parseHash);
  useEffect(() => {
    const onHash = () => { setRoute(parseHash()); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    const follow = (e) => {
      const { app: appId, menu, id, query } = parseHash();
      const app = apps.find((a) => a.id === appId);
      const model = app && findLeaf(app, menu)?.model;
      const moved = model && e.detail[model]?.[Number(id)];
      if (moved) location.replace(`#/${appId}/${menu}/${moved}${query ? `?${query}` : ''}`);
    };
    window.addEventListener('mizan:remapped', follow);
    return () => window.removeEventListener('mizan:remapped', follow);
  }, []);

  if (route.app === 'print') return <PrintDoc model={route.menu} id={route.id} />;
  if (route.app === 'open') {
    // #/open/<model>/<id>: jump to the record inside whichever app shows that model.
    location.replace(`${targetOf(route.menu, db.settings?.uninstalled)}/${route.id}`);
    return null;
  }
  const app = apps.find((a) => a.id === route.app);
  // An uninstalled app's menus are closed too, not only its home icon.
  if (!app || (db.settings?.uninstalled ?? []).includes(app.id)) return <Home />;
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
      <ErrorBoundary key={location.hash.split('?')[0]}>{content}</ErrorBoundary>
    </div>
  );
}
