import { Fragment, useRef, useState } from 'react';
import { models } from '../models/index.js';
import { fieldReadonly, fieldRequired } from '../field-metadata.js';
import { aggregate, create, isMultiCompany, messagesOf, postNote, read, search, unlink, write } from '../orm.js';
import { ACTIVITY_TYPES, activityState, markDone } from '../models/mail.js';
import { today } from '../models/common.js';
import { commit, getDb, getUser, isServer, serverAction, useDb } from '../store.js';
import { myEmployeeId } from '../access.js';
import { t } from '../i18n.js';
import { Avatar, display, FieldInput, isLabelable, money, SimulatedNote } from '../ui.jsx';
import { currencyCode } from '../models/money.js';
import { companyCurrencyRecord } from '../money.js';
import { actionRecords, parseRel } from './ActionView.jsx';
import { viewRecords } from '../companyView.js';
import { duplicateValues } from '../duplicate.js';
import { saveFormRecord } from './formSave.js';
import { changeFormValue, newDefaults } from './formDefaults.js';
import { RecordAnalysis } from './Analysis.jsx';

/** Integrations whose buttons fall back to only recording a send when not configured. */
const SENDING = { smtp: 'Email', sms: 'SMS' };
import { Wizard } from './Wizard.jsx';
import { TaxReportTable } from './Reports.jsx';

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

function withComputed(model, vals, db) {
  const computed = Object.entries(models[model].fields).filter(([, f]) => f.compute);
  return { ...vals, ...Object.fromEntries(computed.map(([k, f]) => [k, f.compute(vals, db)])) };
}

function Field({ db, model, name, label: labelOverride, value, onChange, readonly, record, isNew = false }) {
  const field = models[model].fields[name];
  const id = `f-${name}`;
  const label = labelOverride ? t(labelOverride) : (field.custom ? field.label : t(field.label));
  const required = fieldRequired(field, record, db, isNew);
  const text = <>{label}{required && <span className="req" aria-hidden="true">*</span>}</>;
  const isReadonly = readonly || fieldReadonly(field, record, db);
  return (
    <div className="field">
      {isLabelable(field, isReadonly, record, db) ? <label htmlFor={id}>{text}</label> : <span className="field-label">{text}</span>}
      <div className="field-value">
        <FieldInput db={db} model={model} fieldName={name} field={field} value={value} onChange={onChange} id={id} readonly={isReadonly} placeholder={field.placeholder ? t(field.placeholder) : undefined} record={record} label={typeof label === 'string' ? label : undefined} isNew={isNew} />
        {field.help && <div className="field-help">{t(field.help)}</div>}
      </div>
    </div>
  );
}

// `unlockedFields` may depend on the record (e.g. a posted payment's memo outside a locked period).
const lockFor = (def, readonly, name, record, db) => readonly
  && !((typeof def.form?.unlockedFields === 'function' ? def.form.unlockedFields(record, db) : def.form?.unlockedFields) ?? []).includes(name);

function renderGroupItem(item, { db, model, def, current, set, readonly, titled, isNew }) {
  const multiCompany = isMultiCompany(db);
  if (typeof item === 'string') {
    const field = def.fields[item];
    if (field?.multiCompanyOnly && !multiCompany) return null;
    const itemReadonly = lockFor(def, readonly, item, current, db);
    if (titled && ['one2many', 'text', 'html'].includes(field.type)) {
      const isReadonly = itemReadonly || fieldReadonly(field, current, db);
      return <FieldInput key={item} db={db} model={model} fieldName={item} field={field} value={current[item]} onChange={set(item)} id={`f-${item}`} readonly={isReadonly} placeholder={field.placeholder ? t(field.placeholder) : undefined} record={current} label={t(field.label)} isNew={isNew} />;
    }
    return <Field key={item} db={db} model={model} name={item} value={current[item]} onChange={set(item)} readonly={itemReadonly} record={current} isNew={isNew} />;
  }
  if (item && Array.isArray(item.fields)) {
    const first = def.fields[item.fields[0]];
    const firstReadonly = lockFor(def, readonly, item.fields[0], current, db) || fieldReadonly(first, current, db);
    const labelText = t(item.label ?? first.label);
    return (
      <div key={item.key ?? item.fields[0]} className="field">
        {isLabelable(first, firstReadonly, current, db) ? <label htmlFor={`f-${item.fields[0]}`}>{labelText}</label> : <span className="field-label">{labelText}</span>}
        <div className={`field-value field-pair${item.inline ? ' field-inline' : ''}`}>
          {item.fields.map((f, idx) => {
            const fd = def.fields[f];
            const isRo = lockFor(def, readonly, f, current, db) || fieldReadonly(fd, current, db);
            const sep = idx > 0 ? (item.joins ? item.joins[idx - 1] : item.join) : null;
            return (
              <Fragment key={f}>
                {sep && <span className="field-join">{t(sep)}</span>}
                <FieldInput db={db} model={model} fieldName={f} field={fd} value={current[f]} onChange={set(f)} id={`f-${f}`} readonly={isRo} record={current} label={t(fd.label)} placeholder={fd.placeholder ? t(fd.placeholder) : (idx > 0 && !item.inline ? t(fd.label) : undefined)} isNew={isNew} />
              </Fragment>
            );
          })}
          {item.suffix && <span className="field-join">{t(item.suffix)}</span>}
        </div>
      </div>
    );
  }
  if (def.fields[item.field]?.multiCompanyOnly && !multiCompany) return null;
  return <Field key={item.field} db={db} model={model} name={item.field} label={item.label} value={current[item.field]} onChange={set(item.field)} readonly={lockFor(def, readonly, item.field, current, db)} record={current} isNew={isNew} />;
}

function renderGroups(groups, opts) {
  return (
    <div className="groups">
      {groups.map((g, i) => {
        const title = Array.isArray(g) ? null : g.title;
        const fullWidth = !Array.isArray(g) && g.fullWidth;
        const items = Array.isArray(g) ? g : (g.fields ?? []);
        return (
          <div key={title ?? i} className={fullWidth ? 'group group-full' : 'group'}>
            {title && <h3 className="group-title">{t(title)}</h3>}
            {items.map((item) => renderGroupItem(item, { ...opts, titled: Boolean(title) }))}
          </div>
        );
      })}
    </div>
  );
}

function SmartButtons({ db, model, rec, smart }) {
  return (
    <div className="smart-buttons">
      {smart.map((s) => {
        if (s.when && !s.when(rec, db)) return null;
        if (s.valueField || s.value) {
          const field = s.valueField && model ? models[model]?.fields?.[s.valueField] : null;
          const value = s.value ? s.value(db, rec) : rec[s.valueField];
          const text = field ? display(db, field, value ?? 0, rec) : String(value ?? '');
          const rawLabel = typeof s.label === 'function' ? s.label(rec, db) : s.label;
          const label = t(rawLabel ?? field?.label);
          const target = typeof s.target === 'function' ? s.target(rec, db) : s.target;
          const inner = <>{text !== '' && <b>{text}</b>}<span>{label}</span></>;
          return target
            ? <a key={rawLabel ?? s.valueField} className="smart" href={`#/${target}`}>{inner}</a>
            : <div key={rawLabel ?? s.valueField} className="smart">{inner}</div>;
        }
        // `key`: match on one of this record's fields (e.g. same customer) instead of its id.
        const value = rec[s.key ?? 'id'];
        const recs = value == null ? [] : viewRecords(db, s.model).filter((r) => r[s.field] === value);
        return (
          <a key={s.label} className="smart" href={`#/${s.target}?view=${s.view ?? 'list'}&rel=${s.field}:${value}`}>
            <b>{s.sum ? (s.format === 'number' ? aggregate(recs, s.sum).toLocaleString('en-US') : money(aggregate(recs, s.sum))) : recs.length}</b>
            <span>{t(s.label)}</span>
          </a>
        );
      })}
    </div>
  );
}

/** Model-driven widget (def.form.outstandingCredits): lists the posted payments with unapplied credit and applies a chosen one in full. */
function OutstandingCredits({ db, spec, current, onApply }) {
  const rows = spec.list(db, current);
  if (!rows?.length) return null;
  return (
    <section className="outstanding-credits" aria-label={t(spec.title)}>
      <h3>{t(spec.title)}</h3>
      <table className="list">
        <thead><tr>
          {spec.fields.map((f) => <th key={f.name}>{t(f.label)}</th>)}
          <th><span className="sr-only">{t('Actions')}</span></th>
        </tr></thead>
        <tbody>
          {rows.map((row) => {
            const currency = spec.fields.some((f) => f.money) ? (read(db, 'res.currency', row.display_currency_id) ?? companyCurrencyRecord(db, row.company_id ?? 1)) : null;
            return (
              <tr key={row.id}>
                {spec.fields.map((f) => (
                  <td key={f.name} className={f.money ? 'num' : ''}>
                    {f.money ? money(row[f.name] ?? 0, currency?.name ?? null, currency) : String(row[f.name] ?? '')}
                  </td>
                ))}
                <td><button type="button" className="btn sm" onClick={() => onApply(row)}>{t(spec.applyLabel)}</button></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
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
          <select aria-label={t('Assigned to')} value={form.user_id ?? ''} onChange={(e) => setForm({ ...form, user_id: e.target.value ? Number(e.target.value) : null })}>
            <option value="">—</option>
            {search(db, 'hr.employee').map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
          <div className="row">
            <button type="button" className="btn primary sm" onClick={save}>{t('Schedule')}</button>
            <button type="button" className="btn sm" onClick={() => setForm(null)}>{t('Discard')}</button>
          </div>
        </div>
      ) : (
        <button type="button" className="btn sm" onClick={() => setForm({ activity_type: 'todo', summary: '', date_deadline: today(), user_id: myEmployeeId(db, getUser()) })}>
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
    const res = create(getDb(), model, duplicateValues(model, rec));
    commit(res.db);
    location.hash = `${base}/${res.id}${query}`;
  };
  const archived = rec.active === false;
  return (
    <div className="nav-group actions-menu">
      <button type="button" className="btn sm" aria-expanded={open} aria-label={t('Actions')} onClick={() => setOpen(!open)}>⚙</button>
      {open && (
        <div className="nav-dropdown" role="menu">
          <button type="button" role="menuitem" disabled={models[model].duplicate === false} onClick={() => run(duplicate)}>{t('Duplicate')}</button>
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

// A new record the server refused: its values (and the reason) come back to the "new" form instead of being lost.
let refusedNew = null;

export function FormView({ leaf, id, base, params }) {
  const db = useDb();
  const model = leaf.model;
  const def = models[model];
  const isNew = id === 'new';
  const rec = isNew ? null : read(db, model, Number(id));
  const [restored] = useState(() => {
    const draft = isNew && refusedNew?.base === base ? refusedNew : null;
    if (draft) refusedNew = null;
    return draft;
  });
  const [changes, setChanges] = useState(() => restored?.values ?? {});
  const [error, setError] = useState(() => restored?.error ?? null);
  const [wizard, setWizard] = useState(null);
  const [tab, setTab] = useState(0);
  const [initial] = useState(() => (isNew ? newDefaults(db, model, leaf, params, parseRel(db, model, params.get('rel'))) : null));
  const stageExplicit = useRef(!isNew || Object.hasOwn(restored?.values ?? {}, 'stage_id') || Object.hasOwn(leaf.defaults ?? {}, 'stage_id') || params.has('default_stage_id'));
  const revRef = useRef(0);

  const view = params.get('view') ?? '';
  const relRaw = params.get('rel');
  const query = `?view=${view}${relRaw ? `&rel=${relRaw}` : ''}`;
  const backHash = `${base}${query}`;

  // A record outside this menu's domain (e.g. a journal entry id under Invoices) is not shown under the wrong breadcrumb.
  if (!isNew && (!rec || (leaf.domain && !leaf.domain(rec, db)))) {
    return <main className="form-page"><p className="empty">{t('Record not found.')} <a href={backHash}>{t('Back to')} {t(leaf.label)}</a></p></main>;
  }

  const values = { ...(isNew ? initial : rec), ...changes };
  const current = withComputed(model, def.form.prepare?.(values, db) ?? values, db);
  const dirty = Object.keys(changes).length > 0;
  const set = (k) => (v) => {
    if (k === 'stage_id') stageExplicit.current = true;
    setChanges((c) => changeFormValue(model, isNew ? initial : rec, c, k, v, getDb(), stageExplicit.current));
    setError(null);
  };
  const fail = (e) => setError(e instanceof Error ? t(e.message) : t('Could not save'));

  /**
   * Persist pending changes (+ extra vals). Returns the record id, or null on validation error. The save is shown
   * at once; if the server then refuses it, the typed values come back and its reason is shown on the form.
   */
  const save = (extra = {}) => {
    try {
      const curRev = ++revRef.current;
      if (isNew) {
        const values = { ...changes, ...extra };
        const res = saveFormRecord(getDb(), model, null, { ...current, ...extra });
        const expectedHash = `${base}/${res.id}${query}`;
        commit(res.db, { quiet: true }).then((r) => {
          if (r.ok || curRev !== revRef.current) return;
          if (location.hash === expectedHash) {
            refusedNew = { base, values, error: r.error };
            location.hash = `${base}/new${query}`;
          }
        });
        setChanges({});
        location.hash = `${base}/${res.id}${query}`;
        return res.id;
      }
      const vals = { ...changes, ...extra };
      if (Object.keys(vals).length) {
        commit(saveFormRecord(getDb(), model, rec.id, vals).db, { quiet: true }).then((r) => {
          if (r.ok || curRev !== revRef.current) return;
          setChanges((c) => ({ ...vals, ...c }));
          setError(r.error);
        });
      }
      setChanges({});
      return rec.id;
    } catch (e) {
      fail(e);
      return null;
    }
  };
  const leave = (hash) => { if (!dirty || save() != null) location.hash = hash; };

  const runButton = async (b) => {
    const endpoint = b.server ?? (b.email === 'mailing' ? '/api/mail/mailing' : b.email ? '/api/mail/document' : null);
    const need = b.requires ?? (b.email ? 'smtp' : 'server');
    const live = endpoint && isServer() && (need === 'server' || getUser()?.integrations?.[need]);
    // Without the integration the button only records the send: say so, ask first and leave a trace.
    const channel = !live && endpoint && SENDING[need];
    if (channel && !confirm(t('{channel} is not configured, so nothing will be sent. Mark it as sent anyway?', { channel: t(channel) }))) return;
    const noteUnsent = (id) => { if (channel) commit(postNote(getDb(), model, id, t('Not sent: {channel} is not configured.', { channel: t(channel) }))); };
    if (live) {
      if (b.prompt) {
        // With a wizard the amount is asked in the in-app dialog and sent as the same text the prompt would have.
        const spec = b.wizard?.(getDb(), current);
        if (spec) {
          setWizard({
            b, spec, error: null,
            live: (values) => {
              const savedId = save();
              if (savedId == null) return;
              serverAction(endpoint, { model, id: savedId, text: String(values[spec.fields[0].name] ?? '').trim() })
                .then((res) => { setError(null); if (res?.message) alert(res.message); if (res?.go) location.hash = res.go; }, (e) => fail(e));
            },
          });
          return;
        }
        const savedId = save();
        if (savedId == null) return;
        const text = prompt(t(b.prompt), b.promptDefault?.(read(getDb(), model, savedId)) ?? '');
        if (text != null && text.trim()) {
          serverAction(endpoint, { model, id: savedId, text })
            .then((res) => { setError(null); if (res?.message) alert(res.message); if (res?.go) location.hash = res.go; }, (e) => fail(e));
        }
        return;
      }
      const savedId = save();
      if (savedId == null) return;
      const send = (extra = {}) => serverAction(endpoint, { model, id: savedId, ...extra })
        .then((res) => { setError(null); if (res?.message) alert(res.message); if (res?.go) location.hash = res.go; }, (e) => fail(e));
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
      const id = save(b.vals);
      if (id != null) noteUnsent(id);
      if (id != null && b.vals.active === false) location.hash = backHash;
      return;
    }
    // Buttons that need input open an in-app dialog; the button runs with what was entered.
    const spec = b.wizard?.(getDb(), current);
    if (spec) { setWizard({ b, spec, error: null }); return; }
    const answers = [];
    for (const q of b.ask ?? []) {
      const text = prompt(t(q.label), q.default?.(current) ?? '');
      if (text == null) return;
      answers.push(q.type === 'number' ? Number(text) : text.trim());
    }
    const savedId = save();
    if (savedId == null) return;
    try {
      if (b.posts && isServer()) {
        const out = await serverAction('/api/button', { model, id: savedId, label: b.label });
        if (out.go) location.hash = out.go;
        return;
      }
      const res = b.run(getDb(), read(getDb(), model, savedId), answers);
      commit(res.db);
      noteUnsent(savedId);
      if (res.message) alert(res.message);
      if (res.go) location.hash = res.go;
    } catch (e) {
      fail(e);
    }
  };
  const confirmWizard = (values) => {
    if (wizard.live) { setWizard(null); wizard.live(values); return; }
    try {
      const savedId = wizard.id ?? save();
      if (savedId == null) return;
      const res = wizard.b.run(getDb(), read(getDb(), model, savedId), values);
      commit(res.db);
      setWizard(null);
      setError(null);
      if (res.go) location.hash = res.go;
    } catch (e) {
      setWizard((w) => ({ ...w, error: t(e.message) }));
    }
  };

  const ids = actionRecords(db, leaf, parseRel(db, model, relRaw)).map((r) => r.id);
  const idx = rec ? ids.indexOf(rec.id) : -1;
  const pageTo = (step) => leave(`${base}/${ids[(idx + step + ids.length) % ids.length]}${query}`);

  const resolve = (v) => (typeof v === 'function' ? v(current, db, { leaf, isNew }) : v);
  const statusKey = resolve(def.form.statusbarFor ?? def.form.statusbar);
  const statusField = statusKey && def.fields[statusKey];
  const buttons = [...(def.form.buttons ?? []), ...(current.id ? def.form.ruleButtons?.(getDb(), current.id) ?? [] : [])].filter((b) => (!b.admin || !isServer() || getUser()?.isAdmin) && (!b.when || b.when(current, getDb())) && (!b.visible || b.visible(current, getDb())));
  const ribbon = current.active === false ? 'Archived' : def.form.ribbon?.(current);
  const titleField = def.fields[def.form.title];
  const tabs = resolve(def.form.tabs);
  const groups = resolve(def.form.groups) ?? def.form.groups ?? [];
  // A non-blocking warning shown above the form, such as an exceeded credit limit.
  const warning = def.form.warning?.(current, db) ?? null;
  const banner = def.form.banner?.(current, db) ?? null;
  const footer = [].concat(resolve(def.form.footer) ?? []);
  const locked = !isNew && !!def.form.lockedWhen?.(current, db);

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
              <button type="button" className="btn sm" onClick={() => { revRef.current++; setChanges({}); setError(null); if (isNew) location.hash = backHash; }}>{t('Discard')}</button>
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
              {statusField && (() => {
                const rawOptions = statusField.type === 'selection'
                  ? (statusField.options ?? [])
                  : (statusField.type === 'many2one' && statusField.relation
                    ? (() => {
                        let relRecs = [...(db.records[statusField.relation] ?? [])];
                        if (model === 'crm.lead' && current.team_id) {
                          relRecs = relRecs.filter((s) => !s.team_ids?.length || s.team_ids.includes(current.team_id));
                        } else if (model === 'project.task' && current.project_id) {
                          relRecs = relRecs.filter((s) => !s.project_ids?.length || s.project_ids.includes(current.project_id));
                        }
                        return relRecs
                          .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0) || a.id - b.id)
                          .map((s) => [s.id, s.name]);
                      })()
                    : []);
                return (
                  <ol className="statusbar" aria-label={t(statusField.label)}>
                    {rawOptions
                      .filter(([k]) => !(def.form.statusbarHide ?? []).includes(k) || current[statusKey] === k)
                      .map(([k, label]) => (
                        <li key={k}>
                          <button type="button" aria-current={current[statusKey] === k ? 'step' : undefined}
                            disabled={!def.form.statusbarClickable}
                            onClick={() => save({ [statusKey]: k })}>{t(label)}</button>
                        </li>
                      ))}
                  </ol>
                );
              })()}
            </div>
          )}

          {error && <div className="alert" role="alert">{error}</div>}
          {warning && <div className="alert alert-warning" role="status">{warning}</div>}
          {banner && <div className="alert alert-info" role="status">{t(banner)}</div>}
          <SimulatedNote text={def.simulated} />
          {wizard && <Wizard db={db} spec={wizard.spec} error={wizard.error} onConfirm={confirmWizard} onCancel={() => setWizard(null)} />}

          <section className="sheet">
            {ribbon && <div className={`ribbon ribbon-${ribbon.toLowerCase()}`}>{t(ribbon)}</div>}
            {!isNew && def.form.smart && <SmartButtons db={db} model={model} rec={current} smart={def.form.smart} />}
            {def.form.subtitle && <div className="subtitle">{t(def.form.subtitle(current))}</div>}
            {!def.form.hideTitle && <div className="title-field">
              {def.form.titleLabel && <label className="title-label" htmlFor={`f-${def.form.title}`}>{t(typeof def.form.titleLabel === 'string' ? def.form.titleLabel : titleField.label)}</label>}
              {Array.isArray(def.form.titleFields)
                ? <div className="field-pair">{def.form.titleFields.map((f) => {
                    const fd = def.fields[f];
                    return <FieldInput key={f} db={db} model={model} fieldName={f} field={fd} value={current[f]} onChange={set(f)} id={`f-${f}`} readonly={locked || fieldReadonly(fd, current, db)} record={current} label={t(fd.label)} placeholder={t(fd.placeholder ?? fd.label)} />;
                  })}</div>
                : titleField.readonly || titleField.compute
                  ? <h2>{isNew || current[def.form.title] === '/' ? t('Draft') : current[def.form.title]}</h2>
                  : <input id={`f-${def.form.title}`} aria-label={t(titleField.label)} placeholder={t(titleField.placeholder ?? titleField.label)} readOnly={locked}
                      value={current[def.form.title] ?? ''} onChange={(e) => set(def.form.title)(e.target.value)} />}
            </div>}
            {renderGroups(groups, { db, model, def, current, set, readonly: locked, isNew })}
            {def.form.outstandingCredits && !isNew && (
              <OutstandingCredits
                db={db}
                spec={def.form.outstandingCredits}
                current={current}
                onApply={(row) => {
                  const savedId = current.id && !dirty ? current.id : save();
                  if (savedId == null) return;
                  try {
                    const res = def.form.outstandingCredits.apply(getDb(), read(getDb(), model, savedId), row.id);
                    commit(res.db);
                    setError(null);
                  } catch (e) { fail(e); }
                }}
              />
            )}
            {tabs?.length > 0 && (
              <>
                <div className="tabs" role="tablist">
                  {tabs.map((tb, i) => (
                    <button key={tb.label} type="button" role="tab" aria-selected={tab === i} onClick={() => setTab(i)}>{t(tb.label)}</button>
                  ))}
                </div>
                <div className="tab-panel" role="tabpanel">
                  {(() => {
                    const activeTab = tabs[tab] ?? tabs[0];
                    const tabReadonly = locked || activeTab.readonly;
                    const renderTabField = (f, placeholder) => (['one2many', 'text', 'html'].includes(def.fields[f].type)
                      ? (
                        <FieldInput key={f} db={db} model={model} fieldName={f} field={def.fields[f]} value={current[f]} onChange={set(f)} id={`f-${f}`} record={current} label={t(def.fields[f].label)}
                          placeholder={placeholder} readonly={activeTab.readonly || (locked && ['one2many', 'text', 'html'].includes(def.fields[f].type))} />
                      )
                      // Plain fields in a tab get a label, like fields in the header groups.
                      : <Field key={f} db={db} model={model} name={f} value={current[f]} onChange={set(f)} readonly={tabReadonly} record={current} isNew={isNew} />);
                    return (
                      <>
                        {model === 'account.return' && activeTab.label === 'Tax Report' ? (
                          <TaxReportTable
                            db={db}
                            period={{
                              from: current.date_from,
                              to: current.date_to,
                              company_id: current.company_id,
                              tax_unit_id: current.tax_unit_id && (read(db, 'account.tax.unit', current.tax_unit_id)?.company_ids ?? []).includes(current.company_id ?? 1)
                                ? current.tax_unit_id
                                : null,
                            }}
                          />
                        ) : (
                          <>
                            {(activeTab.fields ?? []).map((f) => renderTabField(f))}
                            {activeTab.groups && renderGroups(activeTab.groups, { db, model, def, current, set, readonly: tabReadonly, isNew })}
                          </>
                        )}
                        {(activeTab.aside?.length > 0 || (footer.length > 0 && tab === 0)) && (
                          <div className="tab-footer">
                            {activeTab.aside?.length > 0 && (
                              <div className="tab-aside">
                                {activeTab.aside.map((f) => renderTabField(f, t(def.fields[f].label)))}
                              </div>
                            )}
                            {footer.length > 0 && tab === 0 && (
                              <dl className="totals">
                                {footer.map((f) => (
                                  <div key={f} className={f === 'amount_total' ? 'grand' : ''}>
                                    <dt>{t(def.fields[f].label)}</dt>
                                    <dd>{display(db, def.fields[f], current[f], current) || money(0, currencyCode(db, current))}</dd>
                                  </div>
                                ))}
                              </dl>
                            )}
                          </div>
                        )}
                      </>
                    );
                  })()}
                </div>
              </>
            )}
          </section>
          {!isNew && <RecordAnalysis db={db} model={model} rec={current} />}
        </div>
        {def.form.chatter && !isNew && <Chatter db={db} model={model} id={rec.id} name={rec[def.form.title]} />}
      </div>
    </main>
  );
}
