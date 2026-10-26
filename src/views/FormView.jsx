import { useState } from 'react';
import { models } from '../models/index.js';
import { aggregate, create, messagesOf, nextId, postNote, read, search, unlink, write } from '../orm.js';
import { ACTIVITY_TYPES, activityState, markDone } from '../models/mail.js';
import { today } from '../models/common.js';
import { commit, getDb, getUser, isServer, serverAction, useDb } from '../store.js';
import { t } from '../i18n.js';
import { Avatar, display, FieldInput, money } from '../ui.jsx';
import { actionRecords, parseRel } from './ActionView.jsx';
import { viewRecords } from '../companyView.js';

function PortalLink({ model, id }) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const share = async () => {
    setLoading(true);
    setError('');
    setUrl('');
    try {
      const response = await fetch(`/api/portal-link/${model}/${id}`, { credentials: 'same-origin' });
      if (!response.ok) throw new Error(t('The customer link could not be generated. Check your access and try again.'));
      const out = await response.json();
      setUrl(new URL(out.url, location.origin).href);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };
  return <span>
    <button type="button" className="btn" disabled={loading} onClick={share}>{t('Share / Customer Preview')}</button>
    {url && <span role="status"><label>{t('Customer link')} <input aria-label={t('Customer link')} value={url} readOnly onFocus={(e) => e.target.select()} /></label> <a href={url} target="_blank" rel="noopener noreferrer">{t('Customer Preview')}</a></span>}
    {error && <span role="alert">{error}</span>}
  </span>;
}

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
        // `key`: match on one of this record's fields (e.g. same customer) instead of its id.
        const value = rec[s.key ?? 'id'];
        const recs = value == null ? [] : viewRecords(db, s.model).filter((r) => r[s.field] === value);
        return (
          <a key={s.label} className="smart" href={`#/${s.target}?view=list&rel=${s.field}:${value}`}>
            <b>{s.sum ? (s.format === 'number' ? aggregate(recs, s.sum).toLocaleString('en-US') : money(aggregate(recs, s.sum))) : recs.length}</b>
            <span>{t(s.label)}</span>
          </a>
        );
      })}
    </div>
  );
}

function Activities({ db, model, id, name }) {
  const [form, setForm] = useState(null);
  const acts = search(db, 'mail.activity').filter((a) => a.res_model === model && a.res_id === id && !a.done);
  const save = () => {
    if (!form.date_deadline) return;
    commit(create(getDb(), 'mail.activity', { ...form, res_model: model, res_id: id, res_name: name }).db);
    setForm(null);
  };
  return (
    <div className="activities">
      {acts.map((a) => (
        <div key={a.id} className={`activity ${activityState(a)}`}>
          <span className="activity-dot" aria-hidden="true" />
          <div className="grow">
            <b>{t(ACTIVITY_TYPES.find((x) => x[0] === a.activity_type)?.[1])}</b> {a.summary}
            <div className="muted">{t(activityState(a) === 'overdue' ? 'Overdue' : activityState(a) === 'today' ? 'Today' : 'Planned')} · {a.date_deadline}</div>
          </div>
          <button type="button" className="btn sm" onClick={() => commit(markDone(getDb(), a))}>{t('Mark Done')}</button>
        </div>
      ))}
      {form ? (
        <div className="activity-form">
          <select aria-label={t('Activity Type')} value={form.activity_type} onChange={(e) => setForm({ ...form, activity_type: e.target.value })}>
            {ACTIVITY_TYPES.map(([k, l]) => <option key={k} value={k}>{t(l)}</option>)}
          </select>
          <input aria-label={t('Summary')} placeholder={t('Summary')} value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} />
          <input aria-label={t('Due Date')} type="date" value={form.date_deadline} onChange={(e) => setForm({ ...form, date_deadline: e.target.value })} />
          <div className="row">
            <button type="button" className="btn primary sm" onClick={save}>{t('Schedule')}</button>
            <button type="button" className="btn sm" onClick={() => setForm(null)}>{t('Discard')}</button>
          </div>
        </div>
      ) : (
        <button type="button" className="btn sm" onClick={() => setForm({ activity_type: 'todo', summary: '', date_deadline: today(), user_id: 1 })}>
          🕓 {t('Schedule Activity')}
        </button>
      )}
    </div>
  );
}

function ActionsMenu({ model, rec, backHash, base, query }) {
  const [open, setOpen] = useState(false);
  const run = (fn) => { setOpen(false); fn(); };
  const duplicate = () => {
    const { id: _id, name, ...vals } = rec;
    const copy = { ...vals, ...(models[model].fields.name?.readonly ? {} : { name: `${name ?? ''} (copy)` }) };
    const res = create(getDb(), model, models[model].fields.name?.readonly ? { ...copy, ...models[model].defaults?.(nextId(getDb(), model)) } : copy);
    commit(res.db);
    location.hash = `${base}/${res.id}${query}`;
  };
  const archived = rec.active === false;
  return (
    <div className="nav-group actions-menu">
      <button type="button" className="btn sm" aria-expanded={open} aria-label={t('Actions')} onClick={() => setOpen(!open)}>⚙</button>
      {open && (
        <div className="nav-dropdown" role="menu">
          <button type="button" role="menuitem" onClick={() => run(duplicate)}>{t('Duplicate')}</button>
          <button type="button" role="menuitem" onClick={() => run(() => commit(write(getDb(), model, rec.id, { active: archived })))}>{t(archived ? 'Unarchive' : 'Archive')}</button>
          <button type="button" role="menuitem" className="danger" onClick={() => run(() => {
            if (!confirm(t('Delete {n} record(s)?', { n: 1 }))) return;
            commit(unlink(getDb(), model, [rec.id]));
            location.hash = backHash;
          })}>{t('Delete')}</button>
        </div>
      )}
    </div>
  );
}

function Chatter({ db, model, id, name }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const messages = messagesOf(db, model, id);
  const send = () => {
    if (!note.trim()) return;
    commit(postNote(getDb(), model, id, note.trim()));
    setNote('');
  };
  return (
    <aside className="chatter" aria-label="Chatter">
      <Activities db={db} model={model} id={id} name={name} />
      <div className="chatter-compose">
        <textarea value={note} placeholder={t('Log an internal note…')} onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(); }} />
        <div className="row">
          {isServer() && getUser()?.integrations?.ai && (
            <button type="button" className="btn" disabled={busy} onClick={async () => {
              const instruction = prompt(t('What should the AI write?'), t('Summarize this record and suggest the next step.'));
              if (instruction == null) return;
              setBusy(true);
              try {
                const res = await serverAction('/api/ai/draft', { model, id, instruction });
                setNote(res.text ?? '');
              } catch (e) {
                alert(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            }}>✨ {t(busy ? 'Thinking…' : 'AI Draft')}</button>
          )}
          <button type="button" className="btn primary" onClick={send} disabled={!note.trim()}>{t('Log note')}</button>
        </div>
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
  const set = (k) => (v) => {
    setChanges((c) => {
      const next = { ...c, [k]: v };
      const extra = def.onchange?.({ ...(isNew ? initial : rec), ...next }, k, getDb()) ?? {};
      return { ...next, ...extra };
    });
    setError(null);
  };
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
    const endpoint = b.server ?? (b.email === 'mailing' ? '/api/mail/mailing' : b.email ? '/api/mail/document' : null);
    const need = b.requires ?? (b.email ? 'smtp' : 'server');
    if (endpoint && isServer() && (need === 'server' || getUser()?.integrations?.[need])) {
      const savedId = save();
      if (savedId == null) return;
      const send = (extra = {}) => serverAction(endpoint, { model, id: savedId, ...extra })
        .then((res) => { setError(null); if (res?.message) alert(res.message); }, (e) => fail(e));
      if (b.prompt) {
        const text = prompt(t(b.prompt), '');
        if (text != null && text.trim()) send({ text });
        return;
      }
      if (!b.upload) { send(); return; }
      const input = Object.assign(document.createElement('input'), { type: 'file', accept: b.upload });
      input.onchange = () => {
        const f = input.files[0];
        if (!f) return;
        const reader = new FileReader();
        reader.onload = () => send({ file: { name: f.name, type: f.type, data: String(reader.result).split(',')[1] } });
        reader.readAsDataURL(f);
      };
      input.click();
      return;
    }
    if (b.upload) { fail(new Error(t('This needs the server with AI enabled'))); return; }
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
  const buttons = [...(def.form.buttons ?? []), ...(current.id ? def.form.ruleButtons?.(getDb(), current.id) ?? [] : [])].filter((b) => (!b.admin || !isServer() || getUser()?.isAdmin) && (!b.when || b.when(current)));
  const ribbon = current.active === false ? 'Archived' : def.form.ribbon?.(current);
  const titleField = def.fields[def.form.title];
  const resolve = (v) => (typeof v === 'function' ? v(current) : v);
  const tabs = resolve(def.form.tabs);
  const footer = [].concat(resolve(def.form.footer) ?? []);
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
          {!isNew && <ActionsMenu model={model} rec={rec} backHash={backHash} base={base} query={query} />}
          {!isNew && isServer() && (model === 'sale.order' || (model === 'account.move' && current.move_type === 'out_invoice')) && <PortalLink key={`${model}:${rec.id}`} model={model} id={rec.id} />}
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
              {titleField.readonly || titleField.compute
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
            {tabs && (
              <>
                <div className="tabs" role="tablist">
                  {tabs.map((tb, i) => (
                    <button key={tb.label} type="button" role="tab" aria-selected={tab === i} onClick={() => setTab(i)}>{t(tb.label)}</button>
                  ))}
                </div>
                <div className="tab-panel" role="tabpanel">
                  {(tabs[tab] ?? tabs[0]).fields.map((f) => (['one2many', 'text'].includes(def.fields[f].type)
                    ? (
                      <FieldInput key={f} db={db} field={def.fields[f]} value={current[f]} onChange={set(f)} id={`f-${f}`} record={current}
                        readonly={(tabs[tab] ?? tabs[0]).readonly || (locked && def.fields[f].type === 'one2many')} />
                    )
                    // Plain fields in a tab get a label, like fields in the header groups.
                    : <Field key={f} db={db} model={model} name={f} value={current[f]} onChange={set(f)} readonly={locked || (tabs[tab] ?? tabs[0]).readonly} />))}
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
        {def.form.chatter && !isNew && <Chatter db={db} model={model} id={rec.id} name={rec[def.form.title]} />}
      </div>
    </main>
  );
}
