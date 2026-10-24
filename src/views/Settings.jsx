import { useState } from 'react';
import { updateSettings } from '../orm.js';
import { commit, getDb, resetDemo, useDb } from '../store.js';
import { lang, setLang, t } from '../i18n.js';

const isDb = (x) => x && typeof x === 'object' && x.records && typeof x.records === 'object' && x.seq && Array.isArray(x.messages);

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
      </section>
    </main>
  );
}
