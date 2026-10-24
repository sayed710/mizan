import { useState } from 'react';
import { models, viewsOf } from './models.js';
import { create, matches, search, unlink, write } from './orm.js';
import { commit, getDb, useDb } from './store.js';
import { Avatar, display, Icon, Stars, Tag } from './ui.jsx';

const money = (n) => display(getDb(), { type: 'monetary' }, n);

function ControlPanel({ model, menu, base, view, facets, setFacets, extra }) {
  const [text, setText] = useState('');
  const addFacet = () => {
    const t = text.trim();
    if (t) setFacets([...facets, t]);
    setText('');
  };
  return (
    <div className="control-panel">
      <div className="cp-left">
        <a className="btn primary" href={`${base}/new?view=${view}`}>New</a>
        <h1 className="cp-title">{menu.label}</h1>
      </div>
      <div className="search" role="search">
        <span className="search-icon">⌕</span>
        {facets.map((f, i) => (
          <span key={i} className="facet">
            <b>Search</b> {f}
            <button type="button" aria-label={`Remove filter ${f}`} onClick={() => setFacets(facets.filter((_, j) => j !== i))}>×</button>
          </span>
        ))}
        <input
          value={text}
          placeholder="Search..."
          aria-label={`Search ${models[model].label}`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addFacet();
            if (e.key === 'Backspace' && !text && facets.length) setFacets(facets.slice(0, -1));
          }}
        />
      </div>
      <div className="cp-right">
        {extra}
        <div className="switcher" role="group" aria-label="Switch view">
          {viewsOf(model).map((v) => (
            <a key={v} href={`${base}?view=${v}`} className={v === view ? 'active' : ''} aria-label={`${v} view`} title={v}>
              <Icon name={v} size={16} />
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}

function Card({ db, model, rec, open }) {
  const k = models[model].kanban;
  const fields = models[model].fields;
  return (
    <article
      className="card"
      tabIndex={0}
      draggable={!!k.groupBy}
      onDragStart={(e) => e.dataTransfer.setData('text/plain', String(rec.id))}
      onClick={open}
      onKeyDown={(e) => { if (e.key === 'Enter') open(); }}
    >
      <div className="card-head">
        {k.avatar && <Avatar name={rec[k.title]} size={36} />}
        <strong>{rec[k.title]}</strong>
      </div>
      {k.lines.map((f) => {
        const v = display(db, fields[f], rec[f]);
        return v ? <div key={f} className="card-line">{v}</div> : null;
      })}
      {k.tags && rec[k.tags]?.length > 0 && (
        <div className="card-tags">{rec[k.tags].map((t) => <Tag key={t} name={t} />)}</div>
      )}
      {(k.priority || k.badge) && (
        <div className="card-foot">
          {k.priority && <Stars value={rec[k.priority]} onChange={(v) => commit(write(getDb(), model, rec.id, { [k.priority]: v }))} />}
          <span className="spacer" />
          {k.badge && <span className="badge">{display(db, fields[k.badge], rec[k.badge])}</span>}
        </div>
      )}
    </article>
  );
}

function QuickCreate({ model, groupKey, onDone }) {
  const [name, setName] = useState('');
  const k = models[model].kanban;
  const submit = () => {
    if (!name.trim()) return onDone();
    commit(create(getDb(), model, { name: name.trim(), [k.groupBy]: groupKey }).db);
    setName('');
  };
  return (
    <div className="card quick-create">
      <input autoFocus value={name} placeholder="e.g. Product pricing" onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onDone(); }} />
      <div className="row">
        <button type="button" className="btn primary" onClick={submit}>Add</button>
        <button type="button" className="btn" onClick={onDone}>Discard</button>
      </div>
    </div>
  );
}

function Kanban({ db, model, records, open }) {
  const k = models[model].kanban;
  const [quick, setQuick] = useState(null);
  const [over, setOver] = useState(null);
  if (!k.groupBy) {
    return <div className="kanban-grid">{records.map((r) => <Card key={r.id} db={db} model={model} rec={r} open={() => open(r.id)} />)}</div>;
  }
  const groupField = models[model].fields[k.groupBy];
  return (
    <div className="kanban">
      {groupField.options.map(([key, label]) => {
        const recs = records.filter((r) => r[k.groupBy] === key);
        const total = k.sum ? recs.reduce((s, r) => s + (Number(r[k.sum]) || 0), 0) : null;
        const pr = [3, 2, 1, 0].map((p) => recs.filter((r) => (r[k.priority] ?? 0) === p).length);
        return (
          <section
            key={key}
            className={`column ${over === key ? 'drop' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setOver(key); }}
            onDragLeave={() => setOver(null)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(null);
              const id = Number(e.dataTransfer.getData('text/plain'));
              if (id) commit(write(getDb(), model, id, { [k.groupBy]: key }));
            }}
          >
            <header className="column-head">
              <h2>{label}</h2>
              <span className="count">{recs.length}</span>
              <span className="spacer" />
              {k.quickCreate && <button type="button" className="round" aria-label={`Quick create in ${label}`} onClick={() => setQuick(key)}>+</button>}
            </header>
            <div className="column-bar">
              <div className="progress" aria-hidden="true">
                {recs.length > 0 && pr.map((n, i) => <span key={i} className={`p${3 - i}`} style={{ flexGrow: n }} />)}
              </div>
              {total != null && <b>{money(total)}</b>}
            </div>
            {quick === key && <QuickCreate model={model} groupKey={key} onDone={() => setQuick(null)} />}
            {recs.map((r) => <Card key={r.id} db={db} model={model} rec={r} open={() => open(r.id)} />)}
          </section>
        );
      })}
    </div>
  );
}

function List({ db, model, records, open, selected, setSelected }) {
  const cols = models[model].list;
  const fields = models[model].fields;
  const [sort, setSort] = useState(null); // [field, dir]
  const cell = (r, f) => display(db, fields[f], r[f]);
  const rows = sort
    ? [...records].sort((a, b) => {
        const x = a[sort[0]], y = b[sort[0]];
        const c = typeof x === 'number' && typeof y === 'number' ? x - y : cell(a, sort[0]).localeCompare(cell(b, sort[0]));
        return c * sort[1];
      })
    : records;
  const allOn = records.length > 0 && records.every((r) => selected.has(r.id));
  const isNum = (f) => ['monetary', 'float', 'integer'].includes(fields[f].type);
  return (
    <div className="list-wrap">
      <table className="list">
        <thead>
          <tr>
            <th className="check">
              <input type="checkbox" aria-label="Select all" checked={allOn}
                onChange={() => setSelected(allOn ? new Set() : new Set(records.map((r) => r.id)))} />
            </th>
            {cols.map((f) => (
              <th key={f} className={isNum(f) ? 'num' : ''} aria-sort={sort?.[0] === f ? (sort[1] > 0 ? 'ascending' : 'descending') : 'none'}>
                <button type="button" onClick={() => setSort(sort?.[0] === f ? [f, -sort[1]] : [f, 1])}>
                  {fields[f].label} {sort?.[0] === f ? (sort[1] > 0 ? '▲' : '▼') : ''}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} onClick={() => open(r.id)} className={selected.has(r.id) ? 'selected' : ''}>
              <td className="check" onClick={(e) => e.stopPropagation()}>
                <input type="checkbox" aria-label={`Select ${r.name}`} checked={selected.has(r.id)}
                  onChange={() => {
                    const next = new Set(selected);
                    next.has(r.id) ? next.delete(r.id) : next.add(r.id);
                    setSelected(next);
                  }} />
              </td>
              {cols.map((f) => <td key={f} className={isNum(f) ? 'num' : ''}>{cell(r, f)}</td>)}
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={cols.length + 1} className="empty">No record found. Create one with “New”.</td></tr>}
        </tbody>
        <tfoot>
          <tr>
            <td />
            {cols.map((f) => (
              <td key={f} className="num">
                {fields[f].type === 'monetary' ? money(rows.reduce((s, r) => s + (Number(r[f]) || 0), 0)) : ''}
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

export function ActionView({ model, menu, base, view }) {
  const db = useDb();
  const [facets, setFacets] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const records = search(db, model).filter((r) => matches(db, model, r, facets));
  const open = (id) => { location.hash = `${base}/${id}?view=${view}`; };

  const deleteSelected = () => {
    if (!confirm(`Delete ${selected.size} record(s)?`)) return;
    commit(unlink(getDb(), model, [...selected]));
    setSelected(new Set());
  };
  const extra = view === 'list' && (
    <>
      {selected.size > 0 && <button type="button" className="btn danger" onClick={deleteSelected}>Delete ({selected.size})</button>}
      <span className="pager">{records.length ? `1-${records.length}` : '0'} / {records.length}</span>
    </>
  );

  return (
    <main className="action">
      <ControlPanel model={model} menu={menu} base={base} view={view} facets={facets} setFacets={setFacets} extra={extra} />
      {view === 'kanban'
        ? <Kanban db={db} model={model} records={records} open={open} />
        : <List db={db} model={model} records={records} open={open} selected={selected} setSelected={setSelected} />}
    </main>
  );
}
