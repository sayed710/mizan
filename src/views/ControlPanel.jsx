import { useRef, useState } from 'react';
import { models, viewsOf } from '../models/index.js';
import { updateSettings } from '../orm.js';
import { commit, getDb } from '../store.js';
import { t } from '../i18n.js';
import { Icon, useDismiss } from '../ui.jsx';

/** Search state: { terms: string[], filters: string[], groupBy: string[], rel: {field,id,label}|null } */
export const emptySearch = (model, rel = null) => ({ terms: [], filters: models[model].defaultFilters ?? [], groupBy: [], rel, archived: false });

const filterLabel = (model, id) => t((models[model].filters ?? []).flat().find((f) => f.id === id)?.label ?? id);

function Facets({ model, search, setSearch }) {
  const fields = models[model].fields;
  const facets = [
    ...(search.rel ? [{ key: 'rel', icon: '⇢', label: `${t(fields[search.rel.field]?.label)}: ${search.rel.label}`, clear: { rel: null } }] : []),
    ...(search.filters.length ? [{ key: 'f', icon: <Icon name="filter" size={11} />, label: search.filters.map((id) => filterLabel(model, id)).join(` ${t('or')} `), clear: { filters: [] } }] : []),
    ...(search.archived ? [{ key: 'a', icon: <Icon name="filter" size={11} />, label: t('Archived'), clear: { archived: false } }] : []),
    ...(search.groupBy.length ? [{ key: 'g', icon: '≡', label: search.groupBy.map((g) => t(fields[g].label)).join(' › '), clear: { groupBy: [] } }] : []),
    ...search.terms.map((term, i) => ({ key: `s${i}`, icon: t('Search'), label: term, clear: { terms: search.terms.filter((_, j) => j !== i) } })),
  ];
  return facets.map((f) => (
    <span key={f.key} className="facet">
      <b className="facet-icon">{f.icon}</b> {f.label}
      <button type="button" aria-label={`${t('Remove filter')} ${f.label}`} onClick={() => setSearch({ ...search, ...f.clear })}>×</button>
    </span>
  ));
}

function SearchPanel({ model, search, setSearch, onClose }) {
  const def = models[model];
  const fields = def.fields;
  const favorites = getDb().settings?.favorites?.[model] ?? [];
  const toggle = (key, value) => {
    const list = search[key];
    setSearch({ ...search, [key]: list.includes(value) ? list.filter((x) => x !== value) : [...list, value] });
  };
  const saveFavorite = () => {
    const name = prompt(t('Saved search name'));
    if (!name) return;
    const db = getDb();
    const all = db.settings?.favorites ?? {};
    commit(updateSettings(db, { favorites: { ...all, [model]: [...(all[model] ?? []), { name, search: { ...search, rel: null } }] } }));
    onClose();
  };
  return (
    <div className="search-panel" role="dialog" aria-label={t('Filters')}>
      <section>
        <h3><Icon name="filter" size={14} /> {t('Filters')}</h3>
        {(def.filters ?? []).map((group, i) => (
          <ul key={i}>
            {group.map((f) => (
              <li key={f.id}>
                <button type="button" aria-pressed={search.filters.includes(f.id)} onClick={() => toggle('filters', f.id)}>{t(f.label)}</button>
              </li>
            ))}
          </ul>
        ))}
        <ul>
          <li>
            <button type="button" aria-pressed={!!search.archived} onClick={() => setSearch({ ...search, archived: !search.archived })}>{t('Archived')}</button>
          </li>
        </ul>
      </section>
      <section>
        <h3>≡ {t('Group By')}</h3>
        <ul>
          {(def.groupBys ?? []).map((g) => (
            <li key={g}>
              <button type="button" aria-pressed={search.groupBy.includes(g)} onClick={() => toggle('groupBy', g)}>{t(fields[g].label)}</button>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h3>★ {t('Favorites')}</h3>
        <ul>
          {favorites.map((f) => (
            <li key={f.name}>
              <button type="button" onClick={() => { setSearch({ ...f.search, rel: search.rel }); onClose(); }}>{f.name}</button>
            </li>
          ))}
          <li><button type="button" className="link" onClick={saveFavorite}>{t('Save current search')}</button></li>
        </ul>
      </section>
    </div>
  );
}

export function ControlPanel({ model, title, newHref, base, view, search, setSearch, extra }) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useDismiss(open, () => setOpen(false), ref);

  const addTerm = () => {
    const term = text.trim();
    if (term) setSearch({ ...search, terms: [...search.terms, term] });
    setText('');
  };
  const removeLast = () => {
    if (search.terms.length) return setSearch({ ...search, terms: search.terms.slice(0, -1) });
    if (search.groupBy.length) return setSearch({ ...search, groupBy: [] });
    if (search.filters.length) return setSearch({ ...search, filters: [] });
    return setSearch({ ...search, rel: null });
  };

  return (
    <div className="control-panel">
      <div className="cp-left">
        {newHref && <a className="btn primary" href={newHref}>{t('New')}</a>}
        <h1 className="cp-title">{t(title)}</h1>
      </div>
      <div className="search-wrap" ref={ref}>
        <div className="search" role="search">
          <span className="search-icon" aria-hidden="true">⌕</span>
          <Facets model={model} search={search} setSearch={setSearch} />
          <input
            value={text}
            placeholder={t('Search...')}
            aria-label={`${t('Search')} ${t(models[model].label)}`}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addTerm();
              if (e.key === 'Backspace' && !text) removeLast();
              if (e.key === 'Escape') setOpen(false);
            }}
          />
          <button type="button" className="search-toggle" aria-expanded={open} aria-label={t('Toggle search panel')} onClick={() => setOpen(!open)}>
            <Icon name="chevron" size={14} />
          </button>
        </div>
        {open && <SearchPanel model={model} search={search} setSearch={setSearch} onClose={() => setOpen(false)} />}
      </div>
      <div className="cp-right">
        {extra}
        <div className="switcher" role="group" aria-label={t('Switch view')}>
          {viewsOf(model).map((v) => (
            <a key={v} href={`${base}${base.includes('?') ? '&' : '?'}view=${v}`} className={v === view ? 'active' : ''} aria-label={t(v)} title={t(v)}>
              <Icon name={v} size={16} />
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}
