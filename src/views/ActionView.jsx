import { useEffect, useState } from 'react';
import { models, viewsOf } from '../models/index.js';
import { applyFilters, matches, read, search as searchRecords, unlink } from '../orm.js';
import { display, SimulatedNote } from '../ui.jsx';
import { toCsv } from '../csv.js';
import { commit, getDb, useDb } from '../store.js';
import { importAccept, importModelFile } from './importModelFile.js';
import { t } from '../i18n.js';
import { ControlPanel, emptySearch } from './ControlPanel.jsx';
import { Kanban } from './Kanban.jsx';
import { colLabel, List } from './List.jsx';
import { Graph } from './Graph.jsx';
import { Pivot } from './Pivot.jsx';
import { CalendarView } from './CalendarView.jsx';
import { Gantt } from './Gantt.jsx';
import { actionRecords } from '../companyView.js';
import { pageWindow } from './paging.js';
import { statementImportJournalChoices, withSelectedStatementJournal } from '../models/statements.js';

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

export function ActionView({ leaf, base, params }) {
  const db = useDb();
  const model = leaf.model;
  const def = models[model];
  const views = viewsOf(model);
  const view = views.includes(params.get('view')) ? params.get('view') : views.includes(leaf.view) ? leaf.view : views[0];
  const relRaw = params.get('rel');
  // ?filter=<id> (repeatable) preselects the model's named filters, e.g. links from dashboard tiles.
  const urlFilters = params.getAll('filter').filter((id) => (models[model].filters ?? []).flat().some((f) => f.id === id));
  const [search, setSearch] = useState(() => {
    const initial = emptySearch(model, parseRel(db, model, relRaw));
    const defaultFilters = leaf.defaultFilters ?? models[model].defaultFilters ?? [];
    return { ...initial, filters: urlFilters.length ? urlFilters : defaultFilters, groupBy: leaf.groupBy ?? [] };
  });
  const [selected, setSelected] = useState(() => new Set());
  const [selectedImportJournalId, setSelectedImportJournalId] = useState('');
  const companyScope = db.settings?.allowed_company_ids?.join(',') ?? db.settings?.current_company_id ?? 1;
  useEffect(() => setSelected(new Set()), [companyScope]);

  // Back to the first page whenever the search, grouping or view changes.
  const pageKey = JSON.stringify([search, view]);
  const [page, setPage] = useState({ key: pageKey, offset: 0 });
  const offset = page.key === pageKey ? page.offset : 0;
  const goTo = (to) => setPage({ key: pageKey, offset: to });

  const relQ = search.rel ? `&rel=${search.rel.field}:${search.rel.id}` : '';
  const filtered = applyFilters(model, actionRecords(db, leaf, search.rel, search.archived), search.filters)
    .filter((r) => matches(db, model, r, search.terms));
  const records = def.sort ? [...filtered].sort(def.sort) : filtered;
  const open = (id) => { location.hash = `${base}/${id}?view=${view}${relQ}`; };
  const newHref = `${base}/new?view=${view}${relQ}`;
  const defaults = { ...leaf.defaults, ...(search.rel ? { [search.rel.field]: search.rel.id } : {}) };
  const statementImport = model === 'account.bank.statement.line' && !!def.importFile;
  const importJournals = statementImport && !defaults.journal_id
    ? statementImportJournalChoices(db, defaults.company_id ?? null)
    : [];
  const selectedImportJournal = importJournals.find((journal) => String(journal.id) === selectedImportJournalId);
  const importDefaults = statementImport && !defaults.journal_id
    ? withSelectedStatementJournal(defaults, selectedImportJournal?.id)
    : defaults;

  const deleteSelected = () => {
    if (!confirm(t('Delete {n} record(s)?', { n: selected.size }))) return;
    commit(unlink(getDb(), model, [...selected]));
    setSelected(new Set());
  };
  const exportCsv = () => {
    const rows = selected.size ? records.filter((r) => selected.has(r.id)) : records;
    download(`${model}.csv`, toCsv([
      def.list.map((f) => colLabel(def.fields, f, leaf.listLabels)),
      ...rows.map((r) => def.list.map((f) => {
        const field = def.fields[f];
        return field.type === 'many2one' ? r[f] ?? '' : ['monetary', 'float', 'integer'].includes(field.type) && typeof r[f] === 'number' && Number.isFinite(r[f]) ? r[f] : display(db, field, r[f]);
      })),
    ]));
  };
  const importCsv = (file) => importModelFile(model, importDefaults, file);
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
      {(def.listActions ?? []).map((action) => <button key={action.label} type="button" className="btn sm" onClick={() => {
        try {
          const ids = selected.size ? records.filter((r) => selected.has(r.id)).map((r) => r.id) : records.map((r) => r.id);
          if (!ids.length && !action.noSelection) return;
          let options;
          if (action.ask) {
            const promptDefault = typeof action.ask.default === 'function' ? action.ask.default() : (action.ask.default ?? '');
            const val = prompt(t(action.ask.label), promptDefault);
            if (val == null) return;
            options = val;
          } else if (action.label === 'Request a count') {
            const date = prompt(t('Scheduled Count Date'), new Date().toISOString().slice(0, 10));
            if (date == null) return;
            const name = prompt(t('Counter (name, optional)'), '');
            if (name == null) return;
            const users = name ? searchRecords(getDb(), 'hr.employee').filter((u) => u.name === name) : [];
            if (name && users.length !== 1) throw new Error(t(users.length ? 'Enter a unique counter name' : 'Select an existing counter'));
            const user = users[0] ?? null;
            options = { date, user_id: user?.id ?? null };
          } else if (action.label === 'Snooze') {
            const duration = prompt(t('Snooze for (1 day, 1 week, 1 month, or YYYY-MM-DD)'), '1 day');
            if (duration == null) return;
            options = duration;
          }
          const res = action.run(getDb(), ids, options, { defaults: leaf?.defaults ?? {} });
          if (res?.go) {
            if (res.db) commit(res.db);
            location.hash = res.go;
            return;
          }
          if (res) commit(res.db ?? res);
        } catch (e) { alert(t(e.message)); }
      }}>{t(action.label)}</button>)}
      <button type="button" className="btn sm" onClick={exportCsv}>⬇ {t('Export')}</button>
      {statementImport && !defaults.journal_id && <label className="import-journal-picker">
        <span>{t('Bank Journal')}</span>
        <select aria-label={t('Bank Journal')} value={selectedImportJournalId} onChange={(e) => setSelectedImportJournalId(e.target.value)}>
          <option value="">{t('Choose a bank or cash journal')}</option>
          {importJournals.map((journal) => <option key={journal.id} value={journal.id}>{journal.name}</option>)}
        </select>
      </label>}
      <label className="btn sm">⬆ {t('Import')}<input type="file" accept={importAccept(model)} hidden onChange={(e) => { if (e.target.files[0]) importCsv(e.target.files[0]); e.target.value = ''; }} /></label>
      {selected.size > 0 && <button type="button" className="btn danger" onClick={deleteSelected}>{t('Delete')} ({selected.size})</button>}
      {pager}
    </>
  ) : pager;
  return (
    <main className="action">
      <ControlPanel model={model} title={leaf.label} newHref={newHref} base={`${base}?${relQ.slice(1)}`.replace(/\?$/, '')}
        view={view} search={search} setSearch={setSearch} extra={extra} />
      <SimulatedNote text={def.simulated} />
      {view === 'kanban' && <Kanban db={db} model={model} records={kanbanGroup ? records : records.slice(win.start, win.end)} open={open} groupBy={kanbanGroup} defaults={defaults} />}
      {view === 'list' && <List db={db} model={model} records={records} open={open} selected={selected} setSelected={setSelected} groupBy={groupBy} page={win} listLabels={leaf.listLabels} emptyHelp={leaf.emptyHelp ?? def.emptyHelp} />}
      {view === 'graph' && <Graph db={db} model={model} records={records} groupBy={groupBy} />}
      {view === 'pivot' && <Pivot key={groupBy.join()} db={db} model={model} records={records} groupBy={groupBy} />}
      {view === 'calendar' && <CalendarView db={db} model={model} records={records} open={open} newHref={newHref} />}
      {view === 'gantt' && <Gantt db={db} model={model} records={records} open={open} />}
    </main>
  );
}
