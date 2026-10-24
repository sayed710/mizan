import { useState } from 'react';
import { models } from './models.js';
import { create, messagesOf, nextId, postNote, read, search, write } from './orm.js';
import { commit, getDb, useDb } from './store.js';
import { Avatar, display, FieldInput } from './ui.jsx';

function withComputed(model, vals) {
  const computed = Object.entries(models[model].fields).filter(([, f]) => f.compute);
  return { ...vals, ...Object.fromEntries(computed.map(([k, f]) => [k, f.compute(vals)])) };
}

function Field({ db, model, name, value, onChange }) {
  const field = models[model].fields[name];
  const id = `f-${name}`;
  return (
    <div className="field">
      <label htmlFor={id}>{field.label}{field.required && <span className="req" aria-hidden="true">*</span>}</label>
      <div className="field-value"><FieldInput db={db} field={field} value={value} onChange={onChange} id={id} /></div>
    </div>
  );
}

function Chatter({ db, model, id }) {
  const [note, setNote] = useState('');
  const messages = messagesOf(db, model, id);
  const send = () => {
    if (!note.trim()) return;
    commit(postNote(getDb(), model, id, note.trim()));
    setNote('');
  };
  return (
    <aside className="chatter" aria-label="Chatter">
      <div className="chatter-compose">
        <textarea value={note} placeholder="Log an internal note…" onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(); }} />
        <button type="button" className="btn primary" onClick={send} disabled={!note.trim()}>Log note</button>
      </div>
      <ol className="messages">
        {messages.map((m) => (
          <li key={m.id} className={m.kind}>
            <Avatar name={m.author} size={30} />
            <div>
              <div className="msg-meta"><b>{m.author}</b> <time dateTime={m.date}>{new Date(m.date).toLocaleString()}</time></div>
              <div className="msg-body">{m.body}</div>
            </div>
          </li>
        ))}
        {!messages.length && <li className="muted">No messages yet.</li>}
      </ol>
    </aside>
  );
}

export function FormView({ model, id, menu, base, view }) {
  const db = useDb();
  const def = models[model];
  const isNew = id === 'new';
  const rec = isNew ? null : read(db, model, Number(id));
  const [changes, setChanges] = useState({});
  const [error, setError] = useState(null);
  const [tab, setTab] = useState(0);

  if (!isNew && !rec) {
    return <main className="form-page"><p className="empty">Record not found. <a href={`${base}?view=${view}`}>Back to {menu.label}</a></p></main>;
  }

  const baseVals = isNew ? def.defaults?.(nextId(db, model)) ?? {} : rec;
  const current = withComputed(model, { ...baseVals, ...changes });
  const dirty = Object.keys(changes).length > 0;
  const set = (k) => (v) => { setChanges((c) => ({ ...c, [k]: v })); setError(null); };
  const backHash = `${base}?view=${view}`;

  /** Persist pending changes (+ extra vals). Returns the record id, or null on validation error. */
  const save = (extra = {}) => {
    try {
      if (isNew) {
        const res = create(getDb(), model, { ...current, ...extra });
        commit(res.db);
        setChanges({});
        location.hash = `${base}/${res.id}?view=${view}`;
        return res.id;
      }
      const vals = { ...changes, ...extra };
      if (Object.keys(vals).length) commit(write(getDb(), model, rec.id, vals));
      setChanges({});
      return rec.id;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
      return null;
    }
  };
  const leave = (hash) => { if (!dirty || save() != null) location.hash = hash; };

  const ids = search(db, model).map((r) => r.id);
  const idx = rec ? ids.indexOf(rec.id) : -1;
  const pageTo = (step) => leave(`${base}/${ids[(idx + step + ids.length) % ids.length]}?view=${view}`);

  const statusField = def.form.statusbar && def.fields[def.form.statusbar];
  const buttons = (def.form.buttons ?? []).filter((b) => !b.when || b.when(current));
  const runButton = (b) => {
    const savedId = save(b.vals);
    if (savedId != null && b.vals.active === false) location.hash = backHash;
  };

  return (
    <main className="form-page">
      <div className="control-panel">
        <div className="cp-left">
          <button type="button" className="btn" onClick={() => leave(`${base}/new?view=${view}`)}>New</button>
          <nav className="breadcrumb" aria-label="Breadcrumb">
            <a href={backHash} onClick={(e) => { e.preventDefault(); leave(backHash); }}>{menu.label}</a>
            <span>{isNew ? 'New' : current[def.form.title]}</span>
          </nav>
          {dirty && (
            <span className="dirty">
              <button type="button" className="btn primary sm" onClick={() => save()}>Save</button>
              <button type="button" className="btn sm" onClick={() => { setChanges({}); setError(null); if (isNew) location.hash = backHash; }}>Discard</button>
            </span>
          )}
        </div>
        <div className="cp-right">
          {idx >= 0 && (
            <div className="pager">
              <span>{idx + 1} / {ids.length}</span>
              <button type="button" className="btn sm" aria-label="Previous record" onClick={() => pageTo(-1)}>‹</button>
              <button type="button" className="btn sm" aria-label="Next record" onClick={() => pageTo(1)}>›</button>
            </div>
          )}
        </div>
      </div>

      <div className="form-layout">
        <div className="form-main">
          {(buttons.length > 0 || statusField) && (
            <div className="form-header">
              <div className="row">
                {buttons.map((b) => (
                  <button key={b.label} type="button" className={`btn ${b.primary ? 'primary' : ''}`} onClick={() => runButton(b)}>{b.label}</button>
                ))}
              </div>
              {statusField && (
                <ol className="statusbar" aria-label={statusField.label}>
                  {statusField.options
                    .filter(([k]) => !(def.form.statusbarHide ?? []).includes(k) || current[def.form.statusbar] === k)
                    .map(([k, label]) => (
                      <li key={k}>
                        <button type="button" aria-current={current[def.form.statusbar] === k ? 'step' : undefined}
                          onClick={() => save({ [def.form.statusbar]: k })}>{label}</button>
                      </li>
                    ))}
                </ol>
              )}
            </div>
          )}

          {current.active === false && <div className="ribbon">Archived</div>}
          {error && <div className="alert" role="alert">{error}</div>}

          <section className="sheet">
            <div className="title-field">
              {def.fields[def.form.title].readonly
                ? <h2>{isNew ? 'New' : current[def.form.title]}</h2>
                : <input aria-label={def.fields[def.form.title].label} placeholder={`e.g. ${def.fields[def.form.title].label}`}
                    value={current[def.form.title] ?? ''} onChange={(e) => set(def.form.title)(e.target.value)} />}
            </div>
            <div className="groups">
              {def.form.groups.map((g, i) => (
                <div key={i} className="group">
                  {g.map((f) => <Field key={f} db={db} model={model} name={f} value={current[f]} onChange={set(f)} />)}
                </div>
              ))}
            </div>
            {def.form.tabs && (
              <>
                <div className="tabs" role="tablist">
                  {def.form.tabs.map((t, i) => (
                    <button key={t.label} type="button" role="tab" aria-selected={tab === i} onClick={() => setTab(i)}>{t.label}</button>
                  ))}
                </div>
                <div className="tab-panel" role="tabpanel">
                  {def.form.tabs[tab].fields.map((f) => (
                    <FieldInput key={f} db={db} field={def.fields[f]} value={current[f]} onChange={set(f)} id={`f-${f}`} />
                  ))}
                  {def.form.footer && (
                    <div className="total">
                      <span>{def.fields[def.form.footer].label}:</span>
                      <b>{display(db, def.fields[def.form.footer], current[def.form.footer])}</b>
                    </div>
                  )}
                </div>
              </>
            )}
          </section>
        </div>
        {def.form.chatter && !isNew && <Chatter db={db} model={model} id={rec.id} />}
      </div>
    </main>
  );
}
