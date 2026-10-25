// Spreadsheet editor: a grid with a formula bar; formulas are evaluated with live ERP data.
import { useState } from 'react';
import { create, read, search, write } from '../orm.js';
import { colName, evaluateSheet } from '../models/spreadsheet.js';
import { commit, getDb, useDb } from '../store.js';
import { t } from '../i18n.js';

const parseCells = (doc) => {
  try { return JSON.parse(doc?.cells ?? '{}') ?? {}; } catch { return {}; }
};
const display = (v) => (typeof v === 'number' ? (Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6)) : v === true ? 'TRUE' : v === false ? 'FALSE' : String(v ?? ''));

export function Spreadsheet() {
  const db = useDb();
  const id = Number(new URLSearchParams(location.hash.split('?')[1] ?? '').get('id'));
  const docs = search(db, 'spreadsheet.document');
  const doc = read(db, 'spreadsheet.document', id) ?? docs[0];
  const [active, setActive] = useState('A1');
  const [draft, setDraft] = useState(null);
  if (!doc) {
    const add = () => {
      const res = create(getDb(), 'spreadsheet.document', { name: t('New Spreadsheet') });
      commit(res.db);
      location.hash = `#/spreadsheet/sheet?id=${res.id}`;
    };
    return <main className="action"><p className="empty">{t('No spreadsheet yet.')}</p><button type="button" className="btn primary" onClick={add}>{t('New Spreadsheet')}</button></main>;
  }
  const cells = parseCells(doc);
  const values = evaluateSheet(cells, db);
  const rows = Math.min(Number(doc.rows) || 30, 200);
  const cols = Math.min(Number(doc.cols) || 10, 52);
  const save = (ref, raw) => {
    const next = { ...cells };
    if (raw === '') delete next[ref];
    else next[ref] = raw;
    commit(write(getDb(), 'spreadsheet.document', doc.id, { cells: JSON.stringify(next) }));
  };
  const editing = draft ?? cells[active] ?? '';
  return (
    <main className="action spreadsheet">
      <div className="control-panel">
        <h1 className="cp-title">{doc.name}</h1>
        <select aria-label={t('Spreadsheets')} value={doc.id} onChange={(e) => { location.hash = `#/spreadsheet/sheet?id=${e.target.value}`; }}>
          {docs.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </div>
      <div className="sheet-bar">
        <b className="sheet-ref">{active}</b>
        <input aria-label={t('Formula')} value={editing} placeholder={t('Value or =formula, e.g. =SUM(A1:A5) or =MIZAN.COUNT("res.partner")')}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { save(active, editing); setDraft(null); } if (e.key === 'Escape') setDraft(null); }}
          onBlur={() => { if (draft != null) { save(active, draft); setDraft(null); } }} />
      </div>
      <div className="sheet-grid" role="grid" aria-label={doc.name}>
        <table>
          <thead><tr><th />{Array.from({ length: cols }, (_, c) => <th key={c} scope="col">{colName(c)}</th>)}</tr></thead>
          <tbody>
            {Array.from({ length: rows }, (_, r) => (
              <tr key={r}>
                <th scope="row">{r + 1}</th>
                {Array.from({ length: cols }, (_, c) => {
                  const ref = `${colName(c)}${r + 1}`;
                  const v = values[ref];
                  const error = typeof v === 'string' && v.startsWith('#');
                  return (
                    <td key={ref} role="gridcell" tabIndex={0} aria-selected={ref === active}
                      className={`${ref === active ? 'active' : ''} ${typeof v === 'number' ? 'num' : ''} ${error ? 'error' : ''}`}
                      title={cells[ref]?.startsWith?.('=') ? cells[ref] : undefined}
                      onClick={() => { setActive(ref); setDraft(null); }}
                      onKeyDown={(e) => { if (e.key === 'Enter') { setActive(ref); setDraft(cells[ref] ?? ''); } }}>
                      {display(v)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
