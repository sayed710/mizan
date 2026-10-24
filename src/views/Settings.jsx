import { useEffect, useState } from 'react';
import { updateSettings } from '../orm.js';
import { companiesOf, addUser, commit, createKey, getDb, getUser, isServer, listKeys, listUsers, logout, resetDemo, revokeKey, useDb } from '../store.js';
import { lang, setLang, t } from '../i18n.js';
import { CURRENCIES } from '../ui.jsx';

const isDb = (x) => x && typeof x === 'object' && x.records && typeof x.records === 'object' && x.seq && Array.isArray(x.messages);

function Users() {
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState({ login: '', name: '', password: '', apps: '' });
  const [error, setError] = useState(null);
  const refresh = () => listUsers().then(setUsers);
  useEffect(() => { refresh(); }, []);
  const submit = async (e) => {
    e.preventDefault();
    try {
      await addUser(form);
      setForm({ login: '', name: '', password: '', apps: '' });
      setError(null);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error');
    }
  };
  const input = (key, extra = {}) => (
    <input aria-label={t(extra.label)} placeholder={t(extra.label)} required value={form[key]} type={extra.type ?? 'text'}
      autoComplete="off" onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
  );
  return (
    <>
      <h3>{t('Users')}</h3>
      <table className="list">
        <tbody>
          {users.map((u) => <tr key={u.id}><td>{u.name}</td><td>{u.login}</td><td>{u.isAdmin ? t('Administrator') : ''}</td><td className="muted">{u.apps || t('All apps')}</td></tr>)}
        </tbody>
      </table>
      <form className="row user-form" onSubmit={submit}>
        {input('name', { label: 'Name' })}
        {input('login', { label: 'Login' })}
        {input('password', { label: 'Password', type: 'password' })}
        <input aria-label={t('Allowed apps')} placeholder={t('Allowed apps (e.g. crm,sales) — empty = all')} value={form.apps} onChange={(e) => setForm({ ...form, apps: e.target.value })} />
        <button type="submit" className="btn primary">{t('Add user')}</button>
      </form>
      {error && <div className="alert" role="alert">{error}</div>}
    </>
  );
}

function Companies({ db }) {
  const list = companiesOf(db);
  const add = () => {
    const name = prompt(t('Company Name'));
    if (!name?.trim()) return;
    const next = [...list, { id: Math.max(...list.map((c) => c.id)) + 1, name: name.trim(), currency: db.settings?.currency ?? 'USD' }];
    commit(updateSettings(getDb(), { companies: next }));
  };
  const setCurrencyOf = (id, currency) => commit(updateSettings(getDb(), { companies: list.map((c) => (c.id === id ? { ...c, currency } : c)) }));
  return (
    <>
      <h3>{t('Companies')}</h3>
      <table className="list">
        <tbody>
          {list.map((c) => (
            <tr key={c.id}>
              <td>{c.name}</td>
              <td>
                <select aria-label={t('Currency')} value={c.currency} onChange={(e) => setCurrencyOf(c.id, e.target.value)}>
                  {CURRENCIES.map((x) => <option key={x} value={x}>{x}</option>)}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" className="btn" onClick={add}>{t('Add Company')}</button>
    </>
  );
}

function ApiKeys() {
  const [keys, setKeys] = useState([]);
  const [fresh, setFresh] = useState(null);
  const refresh = () => listKeys().then(setKeys);
  useEffect(() => { refresh(); }, []);
  const add = async () => {
    const name = prompt(t('Key name'), 'Integration');
    if (!name) return;
    setFresh(await createKey(name));
    refresh();
  };
  return (
    <>
      <h3>{t('API Keys')}</h3>
      <p className="muted">{t('Use with')} <code>Authorization: Bearer &lt;key&gt;</code> {t('on')} <code>/api/v1/&lt;model&gt;</code></p>
      <ul>{keys.map((k) => <li key={k.created}>{k.name} · {new Date(k.created).toLocaleDateString()} <button type="button" className="link danger" onClick={() => revokeKey(k.created).then(refresh)}>{t('Revoke')}</button></li>)}</ul>
      {fresh && <div className="alert info-box" role="status">{t('Copy this key now, it will not be shown again')}: <code>{fresh}</code></div>}
      <button type="button" className="btn" onClick={add}>{t('New API Key')}</button>
    </>
  );
}

export function Settings() {
  const db = useDb();
  const [status, setStatus] = useState(null);
  const total = Object.values(db.records).reduce((s, recs) => s + recs.length, 0);

  const download = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(getDb(), null, 2)], { type: 'application/json' }));
    a.download = `mizan-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const restore = async (file) => {
    try {
      const data = JSON.parse(await file.text());
      if (!isDb(data)) throw new Error('shape');
      commit(data);
      setStatus(t('Backup restored.'));
    } catch {
      setStatus(t('Invalid backup file.'));
    }
  };

  return (
    <main className="action settings">
      <div className="control-panel"><h1 className="cp-title">{t('General Settings')}</h1></div>
      <section className="sheet settings-sheet">
        <div className="field">
          <label htmlFor="company">{t('Company Name')}</label>
          <div className="field-value">
            <input id="company" value={db.settings?.company ?? ''} onChange={(e) => commit(updateSettings(getDb(), { company: e.target.value }))} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="currency">{t('Currency')}</label>
          <div className="field-value">
            <select id="currency" value={db.settings?.currency ?? 'USD'} onChange={(e) => commit(updateSettings(getDb(), { currency: e.target.value }))}>
              {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor="lang">{t('Language')}</label>
          <div className="field-value">
            <select id="lang" value={lang} onChange={(e) => setLang(e.target.value)}>
              <option value="en">English</option>
              <option value="ar">العربية</option>
            </select>
          </div>
        </div>
        <h3>{t('Data')}</h3>
        <p className="muted">{t('Records stored')}: {total}</p>
        <div className="row">
          <button type="button" className="btn" onClick={download}>⬇ {t('Download backup')}</button>
          <label className="btn">
            ⬆ {t('Restore backup')}
            <input type="file" accept="application/json" hidden onChange={(e) => e.target.files[0] && restore(e.target.files[0])} />
          </label>
          <button type="button" className="btn danger" onClick={() => { if (confirm(t('Reset all data to the demo database?'))) resetDemo(); }}>
            {t('Reset demo')}
          </button>
        </div>
        {status && <p role="status">{status}</p>}
        {!isServer() && <p className="muted">{t('Browser-only demo mode: data is stored in this browser.')}</p>}
        {(!isServer() || getUser()?.isAdmin) && <Companies db={db} />}
        {isServer() && getUser()?.isAdmin && <Users />}
        {isServer() && <ApiKeys />}
        {isServer() && <p><button type="button" className="btn" onClick={logout}>{t('Log out')}</button></p>}
      </section>
    </main>
  );
}
