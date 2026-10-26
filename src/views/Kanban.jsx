import { useState } from 'react';
import { models } from '../models/index.js';
import { aggregate, create, groupRecords, write } from '../orm.js';
import { viewRecords as search } from '../companyView.js';
import { commit, getDb } from '../store.js';
import { canDropOn } from './kanbanDrop.js';
import { t } from '../i18n.js';
import { Avatar, display, money, Stars, Tag } from '../ui.jsx';

function Card({ db, model, rec, open, draggable }) {
  const k = models[model].kanban;
  const fields = models[model].fields;
  const counter = k.counter && search(db, k.counter.model).filter((r) => r[k.counter.field] === rec.id).length;
  return (
    <article
      className="card"
      tabIndex={0}
      draggable={draggable}
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
        <div className="card-tags">{rec[k.tags].map((tag) => <Tag key={tag} name={tag} />)}</div>
      )}
      {counter !== false && counter != null && <div className="card-counter"><b>{counter}</b> {t(k.counter.label)}</div>}
      {(k.priority || k.badge) && (
        <div className="card-foot">
          {k.priority && <Stars value={rec[k.priority]} onChange={(v) => commit(write(getDb(), model, rec.id, { [k.priority]: v }))} />}
          <span className="spacer" />
          {k.badge && rec[k.badge] != null && (
            fields[k.badge].type === 'many2one'
              ? <Avatar name={display(db, fields[k.badge], rec[k.badge])} size={24} />
              : <span className="badge">{display(db, fields[k.badge], rec[k.badge])}</span>
          )}
        </div>
      )}
    </article>
  );
}

function QuickCreate({ model, vals, onDone }) {
  const [name, setName] = useState('');
  const submit = () => {
    if (!name.trim()) return onDone();
    commit(create(getDb(), model, { ...vals, name: name.trim() }).db);
    setName('');
  };
  return (
    <div className="card quick-create">
      <input autoFocus value={name} placeholder={t('e.g. Product pricing')} onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onDone(); }} />
      <div className="row">
        <button type="button" className="btn primary" onClick={submit}>{t('Add')}</button>
        <button type="button" className="btn" onClick={onDone}>{t('Discard')}</button>
      </div>
    </div>
  );
}

export function Kanban({ db, model, records, open, groupBy, defaults }) {
  const k = models[model].kanban;
  const [quick, setQuick] = useState(null);
  const [over, setOver] = useState(null);
  const field = groupBy && models[model].fields[groupBy];
  if (!field) {
    return (
      <div className="kanban-grid">
        {records.map((r) => <Card key={r.id} db={db} model={model} rec={r} open={() => open(r.id)} draggable={false} />)}
        {!records.length && <p className="empty">{t('No record found. Create one with “New”.')}</p>}
      </div>
    );
  }
  const canDrop = canDropOn(model, groupBy);
  const groups = groupRecords(db, model, records, groupBy);
  return (
    <div className="kanban">
      {groups.map(({ key, label, records: recs }) => {
        const pr = k.priority ? [3, 2, 1, 0].map((p) => recs.filter((r) => (r[k.priority] ?? 0) === p).length) : null;
        const value = key === false ? null : key;
        return (
          <section
            key={String(key)}
            className={`column ${over === key ? 'drop' : ''}`}
            aria-label={t(label)}
            onDragOver={(e) => { if (canDrop) { e.preventDefault(); setOver(key); } }}
            onDragLeave={() => setOver(null)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(null);
              const id = Number(e.dataTransfer.getData('text/plain'));
              if (id && canDrop) commit(write(getDb(), model, id, { [groupBy]: value }));
            }}
          >
            <header className="column-head">
              <h2>{t(label)}</h2>
              <span className="count">{recs.length}</span>
              <span className="spacer" />
              {k.quickCreate && (
                <button type="button" className="round" aria-label={`${t('New')} — ${t(label)}`} onClick={() => setQuick(key)}>+</button>
              )}
            </header>
            <div className="column-bar">
              <div className="progress" aria-hidden="true">
                {pr && recs.length > 0 && pr.map((n, i) => <span key={i} className={`p${3 - i}`} style={{ flexGrow: n }} />)}
              </div>
              {k.sum && <b>{money(aggregate(recs, k.sum))}</b>}
            </div>
            {quick === key && <QuickCreate model={model} vals={{ ...defaults, [groupBy]: value }} onDone={() => setQuick(null)} />}
            {recs.map((r) => <Card key={r.id} db={db} model={model} rec={r} open={() => open(r.id)} draggable={canDrop} />)}
          </section>
        );
      })}
    </div>
  );
}
