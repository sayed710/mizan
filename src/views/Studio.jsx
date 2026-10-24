import { useState } from 'react';
import { models } from '../models/index.js';
import { CUSTOM_TYPES, cleanCustomField, installCustomFields, technicalName } from '../models/studio.js';
import { updateSettings } from '../orm.js';
import { commit, getDb, useDb } from '../store.js';
import { t } from '../i18n.js';

const MODEL_OPTIONS = Object.entries(models).map(([k, m]) => [k, m.label]).sort((a, b) => a[1].localeCompare(b[1]));

/** Add fields to any model without code; they appear in a "Custom" group on the form (and optionally in lists). */
export function Studio() {
  const db = useDb();
  const [form, setForm] = useState({ model: 'crm.lead', label: '', type: 'char', options: '', inList: false });
  const [error, setError] = useState(null);
  const fields = db.settings?.customFields ?? [];

  const add = (e) => {
    e.preventDefault();
    const clean = cleanCustomField(form);
    if (!clean) { setError(t('Check the label, type and options')); return; }
    if (models[clean.model].fields[clean.name] && !models[clean.model].fields[clean.name].custom) { setError(t('A field with this name already exists')); return; }
    const next = [...fields.filter((f) => !(f.model === clean.model && technicalName(f.label) === clean.name)), clean];
    installCustomFields(next);
    commit(updateSettings(getDb(), { customFields: next }));
    setForm({ ...form, label: '', options: '' });
    setError(null);
  };

  return (
    <main className="action studio">
      <div className="control-panel"><h1 className="cp-title">{t('Studio')}</h1><span className="muted">{t('Customize your apps without code')}</span></div>
      <div className="studio-body">
        <form className="sheet studio-form" onSubmit={add}>
          <h2>{t('Add a field')}</h2>
          <label>{t('Model')}
            <select value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })}>
              {MODEL_OPTIONS.map(([k, l]) => <option key={k} value={k}>{t(l)} ({k})</option>)}
            </select>
          </label>
          <label>{t('Field Label')}<input required value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} /></label>
          <label>{t('Field Type')}
            <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
              {CUSTOM_TYPES.map(([k, l]) => <option key={k} value={k}>{t(l)}</option>)}
            </select>
          </label>
          {form.type === 'selection' && (
            <label>{t('Options (comma separated)')}<input required value={form.options} onChange={(e) => setForm({ ...form, options: e.target.value })} /></label>
          )}
          <label className="check"><input type="checkbox" checked={form.inList} onChange={(e) => setForm({ ...form, inList: e.target.checked })} /> {t('Show in list view')}</label>
          {form.label && <p className="muted">{t('Technical name')}: <code>{technicalName(form.label)}</code></p>}
          {error && <div className="alert" role="alert">{error}</div>}
          <button type="submit" className="btn primary">{t('Add Field')}</button>
        </form>
        <section className="sheet">
          <h2>{t('Custom Fields')}</h2>
          <table className="list">
            <thead><tr><th>{t('Model')}</th><th>{t('Field Label')}</th><th>{t('Field Type')}</th><th>{t('Technical name')}</th></tr></thead>
            <tbody>
              {fields.map((f) => (
                <tr key={`${f.model}.${f.name}`}>
                  <td>{t(models[f.model]?.label)}</td><td>{f.label}</td><td>{t(CUSTOM_TYPES.find((x) => x[0] === f.type)?.[1])}</td><td><code>{f.name}</code></td>
                </tr>
              ))}
              {!fields.length && <tr><td colSpan={4} className="empty">{t('No custom field yet.')}</td></tr>}
            </tbody>
          </table>
        </section>
      </div>
    </main>
  );
}
