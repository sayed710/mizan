import { useState } from 'react';
import { models } from '../models/index.js';
import { aggregate, create, messagesOf, nextId, postNote, read, search, write } from '../orm.js';
import { commit, getDb, useDb } from '../store.js';
import { t } from '../i18n.js';
import { Avatar, display, FieldInput, money } from '../ui.jsx';
import { actionRecords, parseRel } from './ActionView.jsx';

function withComputed(model, vals) {
  const computed = Object.entries(models[model].fields).filter(([, f]) => f.compute);
  return { ...vals, ...Object.fromEntries(computed.map(([k, f]) => [k, f.compute(vals)])) };
}

/** Defaults for a new record: model defaults < menu defaults < smart-button parent < `default_<field>` URL params. */
function newDefaults(db, model, leaf, params) {
  const def = models[model];
  const fromUrl = Object.fromEntries(
    [...params].filter(([k]) => k.startsWith('default_') && def.fields[k.slice(8)]).map(([k, v]) => [k.slice(8), v]),
  );
  const rel = parseRel(db, model, params.get('rel'));
  return { ...(def.defaults?.(nextId(db, model)) ?? {}), ...leaf.defaults, ...(rel ? { [rel.field]: rel.id } : {}), ...fromUrl };
}

function Field({ db, model, name, value, onChange, readonly }) {
  const field = models[model].fields[name];
  const id = `f-${name}`;
  return (
    <div className="field">
      <label htmlFor={id}>{t(field.label)}{field.required && <span className="req" aria-hidden="true">*</span>}</label>
      <div className="field-value"><FieldInput db={db} field={field} value={value} onChange={onChange} id={id} readonly={readonly} /></div>
    </div>
  );
}

function SmartButtons({ db, rec, smart }) {
  return (
    <div className="smart-buttons">
      {smart.map((s) => {
        const recs = search(db, s.model).filter((r) => r[s.field] === rec.id);
        return (
          <a key={s.label} className="smart" href={`#/${s.target}?view=list&rel=${s.field}:${rec.id}`}>
            <b>{s.sum ? (s.format === 'number' ? aggregate(recs, s.sum).toLocaleString('en-US') : money(aggregate(recs, s.sum))) : recs.length}</b>
            <span>{t(s.label)}</span>
          </a>
        );
      })}
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
        <textarea value={note} placeholder={t('Log an internal note…')} onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(); }} />
        <button type="button" className="btn primary" onClick={send} disabled={!note.trim()}>{t('Log note')}</button>
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
        {!messages.length && <li className="muted">{t('No messages yet.')}</li>}
      </ol>
    </aside>
  );
}

export function FormView({ leaf, id, base, params }) {
  const db = useDb();
  const model = leaf.model;
  const def = models[model];
  const isNew = id === 'new';
  const rec = isNew ? null : read(db, model, Number(id));
  const [changes, setChanges] = useState({});
  const [error, setError] = useState(null);
  const [tab, setTab] = useState(0);
  const [initial] = useState(() => (isNew ? newDefaults(db, model, leaf, params) : null));

  const view = params.get('view') ?? '';
  const relRaw = params.get('rel');
  const query = `?view=${view}${relRaw ? `&rel=${relRaw}` : ''}`;
  const backHash = `${base}${query}`;

  if (!isNew && !rec) {
    return <main className="form-page"><p className="empty">{t('Record not found.')} <a href={backHash}>{t('Back to')} {t(leaf.label)}</a></p></main>;
  }

  const current = withComputed(model, { ...(isNew ? initial : rec), ...changes });
  const dirty = Object.keys(changes).length > 0;
  const set = (k) => (v) => { setChanges((c) => ({ ...c, [k]: v })); setError(null); };
  const fail = (e) => setError(e instanceof Error ? e.message : t('Could not save'));

  /** Persist pending changes (+ extra vals). Returns the record id, or null on validation error. */
  const save = (extra = {}) => {
    try {
      if (isNew) {
        const res = create(getDb(), model, { ...current, ...extra });
        commit(res.db);
        setChanges({});
        location.hash = `${base}/${res.id}${query}`;
        return res.id;
      }
      const vals = { ...changes, ...extra };
      if (Object.keys(vals).length) commit(write(getDb(), model, rec.id, vals));
      setChanges({});
      return rec.id;
    } catch (e) {
      fail(e);
      return null;
    }
  };
  const leave = (hash) => { if (!dirty || save() != null) location.hash = hash; };

  const runButton = (b) => {
    if (!b.run) {
      if (save(b.vals) != null && b.vals.active === false) location.hash = backHash;
      return;
    }
    const savedId = save();
    if (savedId == null) return;
    try {
      const res = b.run(getDb(), read(getDb(), model, savedId));
      commit(res.db);
      if (res.go) location.hash = res.go;
    } catch (e) {
      fail(e);
    }
  };

  const ids = actionRecords(db, leaf, parseRel(db, model, relRaw)).map((r) => r.id);
  const idx = rec ? ids.indexOf(rec.id) : -1;
  const pageTo = (step) => leave(`${base}/${ids[(idx + step + ids.length) % ids.length]}${query}`);

  const statusKey = def.form.statusbar;
  const statusField = statusKey && def.fields[statusKey];
  const buttons = (def.form.buttons ?? []).filter((b) => !b.when || b.when(current));
  const ribbon = current.active === false ? 'Archived' : def.form.ribbon?.(current);
  const titleField = def.fields[def.form.title];
  const footer = [].concat(def.form.footer ?? []);
  const locked = !isNew && !!def.form.lockedWhen?.(current);

  return (
    <main className="form-page">
      <div className="control-panel">
        <div className="cp-left">
          <button type="button" className="btn" onClick={() => leave(`${base}/new${query}`)}>{t('New')}</button>
          <nav className="breadcrumb" aria-label="Breadcrumb">
            <a href={backHash} onClick={(e) => { e.preventDefault(); leave(backHash); }}>{t(leaf.label)}</a>
            <span>{isNew ? t('New') : current[def.form.title]}</span>
          </nav>
          {dirty && (
            <span className="dirty">
              <button type="button" className="btn primary sm" onClick={() => save()}>{t('Save')}</button>
              <button type="button" className="btn sm" onClick={() => { setChanges({}); setError(null); if (isNew) location.hash = backHash; }}>{t('Discard')}</button>
            </span>
          )}
        </div>
        <div className="cp-right">
          {idx >= 0 && (
            <div className="pager">
              <span>{idx + 1} / {ids.length}</span>
              <button type="button" className="btn sm" aria-label={t('Previous record')} onClick={() => pageTo(-1)}>‹</button>
              <button type="button" className="btn sm" aria-label={t('Next record')} onClick={() => pageTo(1)}>›</button>
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
                  <button key={b.label} type="button" className={`btn ${b.primary ? 'primary' : ''}`} onClick={() => runButton(b)}>{t(b.label)}</button>
                ))}
              </div>
              {statusField && (
                <ol className="statusbar" aria-label={t(statusField.label)}>
                  {statusField.options
                    .filter(([k]) => !(def.form.statusbarHide ?? []).includes(k) || current[statusKey] === k)
                    .map(([k, label]) => (
                      <li key={k}>
                        <button type="button" aria-current={current[statusKey] === k ? 'step' : undefined}
                          disabled={!def.form.statusbarClickable}
                          onClick={() => save({ [statusKey]: k })}>{t(label)}</button>
                      </li>
                    ))}
                </ol>
              )}
            </div>
          )}

          {error && <div className="alert" role="alert">{error}</div>}

          <section className="sheet">
            {ribbon && <div className={`ribbon ribbon-${ribbon.toLowerCase()}`}>{t(ribbon)}</div>}
            {!isNew && def.form.smart && <SmartButtons db={db} rec={current} smart={def.form.smart} />}
            {def.form.subtitle && <div className="subtitle">{t(def.form.subtitle(current))}</div>}
            <div className="title-field">
              {titleField.readonly
                ? <h2>{isNew || current[def.form.title] === '/' ? t('Draft') : current[def.form.title]}</h2>
                : <input aria-label={t(titleField.label)} placeholder={t(titleField.label)} readOnly={locked}
                    value={current[def.form.title] ?? ''} onChange={(e) => set(def.form.title)(e.target.value)} />}
            </div>
            <div className="groups">
              {def.form.groups.map((g, i) => (
                <div key={i} className="group">
                  {g.map((f) => <Field key={f} db={db} model={model} name={f} value={current[f]} onChange={set(f)} readonly={locked} />)}
                </div>
              ))}
            </div>
            {def.form.tabs && (
              <>
                <div className="tabs" role="tablist">
                  {def.form.tabs.map((tb, i) => (
                    <button key={tb.label} type="button" role="tab" aria-selected={tab === i} onClick={() => setTab(i)}>{t(tb.label)}</button>
                  ))}
                </div>
                <div className="tab-panel" role="tabpanel">
                  {def.form.tabs[tab].fields.map((f) => (
                    <FieldInput key={f} db={db} field={def.fields[f]} value={current[f]} onChange={set(f)} id={`f-${f}`}
                      readonly={locked && def.fields[f].type === 'one2many'} />
                  ))}
                  {footer.length > 0 && tab === 0 && (
                    <dl className="totals">
                      {footer.map((f) => (
                        <div key={f} className={f === 'amount_total' ? 'grand' : ''}>
                          <dt>{t(def.fields[f].label)}</dt>
                          <dd>{display(db, def.fields[f], current[f]) || money(0)}</dd>
                        </div>
                      ))}
                    </dl>
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
