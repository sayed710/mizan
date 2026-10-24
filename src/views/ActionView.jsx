import { useState } from 'react';
import { models, viewsOf } from '../models/index.js';
import { applyFilters, matches, read, search as searchRecords, unlink } from '../orm.js';
import { commit, getDb, useDb } from '../store.js';
import { t } from '../i18n.js';
import { ControlPanel, emptySearch } from './ControlPanel.jsx';
import { Kanban } from './Kanban.jsx';
import { List } from './List.jsx';
import { Graph } from './Graph.jsx';
import { Pivot } from './Pivot.jsx';
import { CalendarView } from './CalendarView.jsx';

/** `rel=field:id` narrows an action to records linked to one parent (smart buttons). */
export function parseRel(db, model, raw) {
  if (!raw) return null;
  const [field, id] = raw.split(':');
  const f = models[model].fields[field];
  if (!f || f.type !== 'many2one') return null;
  return { field, id: Number(id), label: read(db, f.relation, Number(id))?.name ?? `#${id}` };
}

/** Records visible in an action before search-panel filtering. */
export const actionRecords = (db, leaf, rel) =>
  searchRecords(db, leaf.model).filter((r) => (!leaf.domain || leaf.domain(r)) && (!rel || r[rel.field] === rel.id));

export function ActionView({ leaf, base, params }) {
  const db = useDb();
  const model = leaf.model;
  const def = models[model];
  const views = viewsOf(model);
  const view = views.includes(params.get('view')) ? params.get('view') : views.includes(leaf.view) ? leaf.view : views[0];
  const relRaw = params.get('rel');
  const [search, setSearch] = useState(() => emptySearch(model, parseRel(db, model, relRaw)));
  const [selected, setSelected] = useState(() => new Set());

  const relQ = search.rel ? `&rel=${search.rel.field}:${search.rel.id}` : '';
  const records = applyFilters(model, actionRecords(db, leaf, search.rel), search.filters)
    .filter((r) => matches(db, model, r, search.terms));
  const open = (id) => { location.hash = `${base}/${id}?view=${view}${relQ}`; };
  const newHref = `${base}/new?view=${view}${relQ}`;

  const deleteSelected = () => {
    if (!confirm(t('Delete {n} record(s)?', { n: selected.size }))) return;
    commit(unlink(getDb(), model, [...selected]));
    setSelected(new Set());
  };
  const extra = view === 'list' && (
    <>
      {selected.size > 0 && <button type="button" className="btn danger" onClick={deleteSelected}>{t('Delete')} ({selected.size})</button>}
      <span className="pager">{records.length ? `1-${records.length}` : '0'} / {records.length}</span>
    </>
  );
  const groupBy = search.groupBy;
  const defaults = { ...leaf.defaults, ...(search.rel ? { [search.rel.field]: search.rel.id } : {}) };

  return (
    <main className="action">
      <ControlPanel model={model} title={leaf.label} newHref={newHref} base={`${base}?${relQ.slice(1)}`.replace(/\?$/, '')}
        view={view} search={search} setSearch={setSearch} extra={extra} />
      {view === 'kanban' && <Kanban db={db} model={model} records={records} open={open} groupBy={groupBy[0] ?? def.kanban?.groupBy} defaults={defaults} />}
      {view === 'list' && <List db={db} model={model} records={records} open={open} selected={selected} setSelected={setSelected} groupBy={groupBy} />}
      {view === 'graph' && <Graph db={db} model={model} records={records} groupBy={groupBy} />}
      {view === 'pivot' && <Pivot key={groupBy.join()} db={db} model={model} records={records} groupBy={groupBy} />}
      {view === 'calendar' && <CalendarView model={model} records={records} open={open} newHref={newHref} />}
    </main>
  );
}
