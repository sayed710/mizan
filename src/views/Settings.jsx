import { useEffect, useState } from 'react';
import { updateSettings } from '../orm.js';
import { companiesOf, currentCompany, addUser, commit, createKey, getDb, getUser, isServer, listKeys, listUsers, logout, resetDemo, revokeKey, useDb } from '../store.js';
import { lang, setLang, setTheme, t, theme } from '../i18n.js';
import { CURRENCIES } from '../ui.jsx';
import { createCompany, renameCompany, setCompanyCurrency } from '../models/company.js';

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
    const current = getDb();
    if (current.records['res.company']?.length) return commit(setCompanyCurrency(createCompany(current, { name: name.trim() }).db, (current.seq['res.company'] ?? 0) + 1, current.settings?.currency ?? 'USD'));
    const next = [...list, { id: Math.max(...list.map((c) => c.id)) + 1, name: name.trim(), currency: db.settings?.currency ?? 'USD' }];
    commit(updateSettings(current, { companies: next }));
  };
  const setCurrencyOf = (id, currency) => commit(getDb().records['res.company']?.length ? setCompanyCurrency(getDb(), id, currency)
    : updateSettings(getDb(), { companies: list.map((c) => (c.id === id ? { ...c, currency } : c)) }));
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
  const company = (db.records['res.company'] ?? []).find((c) => c.id === currentCompany(db).id);
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
            {/* One source of truth: the current company record, which the navbar, documents and QR codes all read. */}
            {company
              ? <input id="company" key={`${company.id}:${company.name}`} defaultValue={company.name}
                  onBlur={(e) => { const name = e.target.value.trim(); if (!name) e.target.value = company.name; else if (name !== company.name) commit(renameCompany(getDb(), company.id, name)); }} />
              : <input id="company" value={db.settings?.company ?? ''} onChange={(e) => commit(updateSettings(getDb(), { company: e.target.value }))} />}
          </div>
        </div>
        <div className="field">
          <label htmlFor="currency">{t('Currency')}</label>
          <div className="field-value">
            {company
              ? (
                <>
                  <span id="currency" className="readonly">{currentCompany(db).currency}</span>
                  <p className="muted">{t('The company currency is part of its accounting: amounts are not converted, so it is set on the company record before posting.')} <a href={`#/open/res.company/${company.id}`}>{t('Open the company')}</a></p>
                </>
              )
              : (
                <select id="currency" value={db.settings?.currency ?? 'USD'} onChange={(e) => commit(updateSettings(getDb(), { currency: e.target.value }))}>
                  {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              )}
          </div>
        </div>
        <div className="field">
          <label htmlFor="theme">{t('Theme')}</label>
          <div className="field-value">
            <select id="theme" value={theme} onChange={(e) => setTheme(e.target.value)}>
              <option value="auto">{t('Auto')}</option>
              <option value="light">{t('Light')}</option>
              <option value="dark">{t('Dark')}</option>
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
        <div className="field">
          <label htmlFor="lock_date">{t('Lock Date')}</label>
          <div className="field-value">
            <input id="lock_date" type="date" value={db.settings?.lock_date ?? ''} onChange={(e) => commit(updateSettings(getDb(), { lock_date: e.target.value || null }))} />
          </div>
        </div>
        {[['sale_lock_date', 'Sales Lock Date'], ['purchase_lock_date', 'Purchase Lock Date']].map(([key, label]) => (
          <div className="field" key={key}>
            <label htmlFor={key}>{t(label)}</label>
            <div className="field-value">
              <input id={key} type="date" value={db.settings?.[key] ?? ''} onChange={(e) => commit(updateSettings(getDb(), { [key]: e.target.value || null }))} />
            </div>
          </div>
        ))}
        <div className="field">
          <label htmlFor="hard_lock_date">{t('Hard Lock Date')}</label>
          <div className="field-value">
            <input id="hard_lock_date" type="date" min={db.settings?.hard_lock_date ?? undefined} value={db.settings?.hard_lock_date ?? ''}
              onChange={(e) => e.target.value && e.target.value > (db.settings?.hard_lock_date ?? '') && confirm(t('The hard lock date cannot be moved back or removed. Continue?')) && commit(updateSettings(getDb(), { hard_lock_date: e.target.value }))} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="invoice_qr">{t('Payment QR Codes')}</label>
          <div className="field-value">
            <select id="invoice_qr" value={db.settings?.invoice_qr ?? ''} onChange={(e) => commit(updateSettings(getDb(), { invoice_qr: e.target.value || null }))}>
              <option value="">{t('None')}</option>
              <option value="zatca">{t('ZATCA (Saudi e-invoicing)')}</option>
              <option value="epc">{t('SEPA Credit Transfer (EPC)')}</option>
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor="company_vat">{t('Company Tax ID')}</label>
          <div className="field-value">
            <input id="company_vat" value={db.settings?.company_vat ?? ''} onChange={(e) => commit(updateSettings(getDb(), { company_vat: e.target.value }))} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="company_iban">{t('Bank Account (IBAN)')}</label>
          <div className="field-value">
            <input id="company_iban" value={db.settings?.company_iban ?? ''} onChange={(e) => commit(updateSettings(getDb(), { company_iban: e.target.value }))} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="audit_trail">{t('Restrictive Audit Trail')}</label>
          <div className="field-value">
            <input id="audit_trail" type="checkbox" checked={!!db.settings?.audit_trail} disabled={!!db.settings?.audit_trail}
              onChange={(e) => e.target.checked && confirm(t('The audit trail cannot be disabled once enabled. Continue?')) && commit(updateSettings(getDb(), { audit_trail: true }))} />
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
          {(!isServer() || getUser()?.canReset) && <button type="button" className="btn danger" onClick={() => { if (prompt(t('This deletes all data and loads the demo database. Type RESET to continue.')) === 'RESET') resetDemo(); }}>
            {t('Reset demo')}
          </button>}
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
