import { useEffect, useState } from 'react';
import { models, viewsOf } from '../models/index.js';
import { applyFilters, create, matches, read, search as searchRecords, unlink } from '../orm.js';
import { display } from '../ui.jsx';
import { fromCsv, toCsv } from '../csv.js';
import { commit, getDb, useDb } from '../store.js';
import { t } from '../i18n.js';
import { ControlPanel, emptySearch } from './ControlPanel.jsx';
import { Kanban } from './Kanban.jsx';
import { List } from './List.jsx';
import { Graph } from './Graph.jsx';
import { Pivot } from './Pivot.jsx';
import { CalendarView } from './CalendarView.jsx';
import { Gantt } from './Gantt.jsx';
import { actionRecords } from '../companyView.js';
import { pageWindow } from './paging.js';

export { actionRecords } from '../companyView.js';

/** `rel=field:id` narrows an action to records linked to one parent (smart buttons). */
export function parseRel(db, model, raw) {
  if (!raw) return null;
  const [field, id] = raw.split(':');
  const f = models[model].fields[field];
  if (!f || f.type !== 'many2one') return null;
  return { field, id: Number(id), label: read(db, f.relation, Number(id))?.name ?? `#${id}` };
}

const download = (name, text) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
};

/** Import rows whose headers match field labels (or technical names); many2one by record name. */
function importRows(db, model, defaults, rows) {
  const fields = models[model].fields;
  const keyOf = (h) => Object.keys(fields).find((k) => k === h || fields[k].label.toLowerCase() === h.trim().toLowerCase());
  const [header, ...body] = rows;
  const keys = header.map(keyOf);
  let next = db;
  let count = 0;
  for (const row of body.filter((r) => r.some((c) => c.trim()))) {
    const vals = { ...defaults };
    keys.forEach((k, i) => {
      if (!k || fields[k].readonly || fields[k].compute) return;
      const raw = (row[i] ?? '').trim();
      const f = fields[k];
      if (f.type === 'many2one') vals[k] = searchRecords(next, f.relation).find((r) => r.name?.toLowerCase() === raw.toLowerCase())?.id ?? null;
      else if (['monetary', 'float', 'integer', 'priority'].includes(f.type)) vals[k] = raw === '' ? null : Number(raw);
      else if (f.type === 'boolean') vals[k] = /^(1|true|yes|نعم)$/i.test(raw);
      else if (f.type === 'tags') vals[k] = raw ? raw.split(/[;,]/).map((x) => x.trim()).filter(Boolean) : [];
      else if (f.type === 'selection') vals[k] = f.options.find((o) => o[0] === raw || o[1].toLowerCase() === raw.toLowerCase())?.[0] ?? undefined;
      else vals[k] = raw;
    });
    next = create(next, model, vals).db;
    count += 1;
  }
  return { db: next, count };
}

export function ActionView({ leaf, base, params }) {
  const db = useDb();
  const model = leaf.model;
  const def = models[model];
  const views = viewsOf(model);
  const view = views.includes(params.get('view')) ? params.get('view') : views.includes(leaf.view) ? leaf.view : views[0];
  const relRaw = params.get('rel');
  const [search, setSearch] = useState(() => ({ ...emptySearch(model, parseRel(db, model, relRaw)), groupBy: leaf.groupBy ?? [] }));
  const [selected, setSelected] = useState(() => new Set());
  const companyScope = db.settings?.allowed_company_ids?.join(',') ?? db.settings?.current_company_id ?? 1;
  useEffect(() => setSelected(new Set()), [companyScope]);

  // Back to the first page whenever the search, grouping or view changes.
  const pageKey = JSON.stringify([search, view]);
  const [page, setPage] = useState({ key: pageKey, offset: 0 });
  const offset = page.key === pageKey ? page.offset : 0;
  const goTo = (to) => setPage({ key: pageKey, offset: to });

  const relQ = search.rel ? `&rel=${search.rel.field}:${search.rel.id}` : '';
  const records = applyFilters(model, actionRecords(db, leaf, search.rel, search.archived), search.filters)
    .filter((r) => matches(db, model, r, search.terms));
  const open = (id) => { location.hash = `${base}/${id}?view=${view}${relQ}`; };
  const newHref = `${base}/new?view=${view}${relQ}`;

  const deleteSelected = () => {
    if (!confirm(t('Delete {n} record(s)?', { n: selected.size }))) return;
    commit(unlink(getDb(), model, [...selected]));
    setSelected(new Set());
  };
  const exportCsv = () => {
    const rows = selected.size ? records.filter((r) => selected.has(r.id)) : records;
    download(`${model}.csv`, toCsv([def.list.map((f) => t(def.fields[f].label)), ...rows.map((r) => def.list.map((f) => display(db, def.fields[f], r[f])))]));
  };
  const importCsv = async (file) => {
    try {
      const text = await file.text();
      const res = def.importFile && !/\.csv$/i.test(file.name) ? def.importFile.run(getDb(), file.name, text) : importRows(getDb(), model, defaults, fromCsv(text));
      commit(res.db);
      alert(t('{n} record(s) imported.', { n: res.count }));
    } catch (e) {
      alert(e instanceof Error ? e.message : t('Import failed'));
    }
  };
  const groupBy = search.groupBy;
  const kanbanGroup = groupBy[0] ?? def.kanban?.groupBy;
  const win = pageWindow(records.length, offset);
  const paged = (view === 'list' && !groupBy.length) || (view === 'kanban' && !kanbanGroup);
  const pager = paged && (
    <span className="pager" role="group" aria-label={t('Pager')}>
      <span aria-live="polite">{win.label} / {win.total}</span>
      <button type="button" className="btn sm" aria-label={t('Previous page')} disabled={win.prev == null} onClick={() => goTo(win.prev)}>‹</button>
      <button type="button" className="btn sm" aria-label={t('Next page')} disabled={win.next == null} onClick={() => goTo(win.next)}>›</button>
    </span>
  );
  const extra = view === 'list' ? (
    <>
      <button type="button" className="btn sm" onClick={exportCsv}>⬇ {t('Export')}</button>
      <label className="btn sm">⬆ {t('Import')}<input type="file" accept={['.csv,text/csv', def.importFile?.accept].filter(Boolean).join(',')} hidden onChange={(e) => { if (e.target.files[0]) importCsv(e.target.files[0]); e.target.value = ''; }} /></label>
      {selected.size > 0 && <button type="button" className="btn danger" onClick={deleteSelected}>{t('Delete')} ({selected.size})</button>}
      {pager}
    </>
  ) : pager;
  const defaults = { ...leaf.defaults, ...(search.rel ? { [search.rel.field]: search.rel.id } : {}) };

  return (
    <main className="action">
      <ControlPanel model={model} title={leaf.label} newHref={newHref} base={`${base}?${relQ.slice(1)}`.replace(/\?$/, '')}
        view={view} search={search} setSearch={setSearch} extra={extra} />
      {view === 'kanban' && <Kanban db={db} model={model} records={kanbanGroup ? records : records.slice(win.start, win.end)} open={open} groupBy={kanbanGroup} defaults={defaults} />}
      {view === 'list' && <List db={db} model={model} records={records} open={open} selected={selected} setSelected={setSelected} groupBy={groupBy} page={win} />}
      {view === 'graph' && <Graph db={db} model={model} records={records} groupBy={groupBy} />}
      {view === 'pivot' && <Pivot key={groupBy.join()} db={db} model={model} records={records} groupBy={groupBy} />}
      {view === 'calendar' && <CalendarView model={model} records={records} open={open} newHref={newHref} />}
      {view === 'gantt' && <Gantt db={db} model={model} records={records} open={open} />}
    </main>
  );
}
