import { useState } from 'react';
import { models } from '../models/index.js';
import { create, groupRecords, write } from '../orm.js';
import { viewRecords as search } from '../companyView.js';
import { commit, getDb } from '../store.js';
import { canDropOn } from './kanbanDrop.js';
import { t } from '../i18n.js';
import { Avatar, display, money, Stars, Tag } from '../ui.jsx';
import { companySum } from '../models/money.js';
import { COLUMN_SIZE } from './paging.js';

/** The model's kanban spec, or a generic title-only card when it has none. */
const kanbanOf = (model) => models[model].kanban ?? { title: typeof models[model].form?.title === 'string' ? models[model].form.title : 'name', lines: [] };

function Card({ db, model, rec, open, draggable }) {
  const k = kanbanOf(model);
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
        const v = display(db, fields[f], rec[f], rec);
        return v ? <div key={f} className="card-line">{v}</div> : null;
      })}
      {k.tags && rec[k.tags]?.length > 0 && (
        <div className="card-tags">{rec[k.tags].map((tag, i) => {
          // Tags are plain names, or lines whose first sub-field points at a tag record.
          const [sub, subField] = Object.entries(fields[k.tags].fields ?? {})[0] ?? [];
          const name = typeof tag === 'string' ? tag : display(db, subField, tag?.[sub]);
          return name ? <Tag key={`${i}-${name}`} name={name} /> : null;
        })}</div>
      )}
      {counter !== false && counter != null && <div className="card-counter"><b>{counter}</b> {t(k.counter.label)}</div>}
      {(k.priority || k.badge || rec.is_rotting) && (
        <div className="card-foot">
          {k.priority && <Stars value={rec[k.priority]} onChange={(v) => commit(write(getDb(), model, rec.id, { [k.priority]: v }))} />}
          {rec.is_rotting && <span className="badge badge-rotting">{t('Rotting')}</span>}
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
  const k = kanbanOf(model);
  const [quick, setQuick] = useState(null);
  const [over, setOver] = useState(null);
  const [shown, setShown] = useState(() => ({}));
  const field = groupBy && models[model].fields[groupBy];
  const isStageRel = field?.type === 'many2one' && ['crm.stage', 'project.task.type'].includes(field?.relation);
  const stageRecords = isStageRel ? (db.records[field.relation] ?? []) : [];
  const [collapsed, setCollapsed] = useState(() => {
    const init = {};
    for (const s of stageRecords) {
      if (s.fold) init[String(s.id)] = true;
    }
    return init;
  });
  if (!field) {
    return (
      <div className="kanban-grid">
        {records.map((r) => <Card key={r.id} db={db} model={model} rec={r} open={() => open(r.id)} draggable={false} />)}
        {!records.length && <p className="empty">{t('No record found. Create one with “New”.')}</p>}
      </div>
    );
  }
  const canDrop = canDropOn(model, groupBy);
  const groups = groupRecords(db, model, records, groupBy, defaults ?? {});
  return (
    <div className="kanban">
      {groups.map(({ key, label, records: recs }) => {
        const isFolded = Boolean(collapsed[String(key)]);
        const pr = k.priority ? [3, 2, 1, 0].map((p) => recs.filter((r) => (r[k.priority] ?? 0) === p).length) : null;
        const value = key === false ? null : key;
        const limit = shown[String(key)] ?? COLUMN_SIZE;
        const toggleFold = () => setCollapsed((c) => ({ ...c, [String(key)]: !c[String(key)] }));
        return (
          <section
            key={String(key)}
            className={`column ${isFolded ? 'folded' : ''} ${over === key ? 'drop' : ''}`}
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
            <header className="column-head" onClick={isFolded ? toggleFold : undefined}>
              <h2>{t(label)}</h2>
              <span className="count">{recs.length}</span>
              <span className="spacer" />
              {isStageRel && (
                <button type="button" className="round" aria-label={isFolded ? t('Unfold') : t('Fold')} onClick={(e) => { e.stopPropagation(); toggleFold(); }}>{isFolded ? '▸' : '▾'}</button>
              )}
              {!isFolded && k.quickCreate && (
                <button type="button" className="round" aria-label={`${t('New')} — ${t(label)}`} onClick={() => setQuick(key)}>+</button>
              )}
            </header>
            {!isFolded && (
              <>
                <div className="column-bar">
                  <div className="progress" aria-hidden="true">
                    {pr && recs.length > 0 && pr.map((n, i) => <span key={i} className={`p${3 - i}`} style={{ flexGrow: n }} />)}
                  </div>
                  {k.sum && <b>{money(companySum(db, recs, k.sum))}</b>}
                </div>
                {quick === key && <QuickCreate model={model} vals={{ ...defaults, [groupBy]: value }} onDone={() => setQuick(null)} />}
                {recs.slice(0, limit).map((r) => <Card key={r.id} db={db} model={model} rec={r} open={() => open(r.id)} draggable={canDrop} />)}
                {recs.length > limit && (
                  <button type="button" className="btn sm load-more" onClick={() => setShown({ ...shown, [String(key)]: limit + COLUMN_SIZE })}>
                    {t('Load more ({n} remaining)', { n: recs.length - limit })}
                  </button>
                )}
              </>
            )}
          </section>
        );
      })}
    </div>
  );
}
