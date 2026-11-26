import { useState } from 'react';
import { models } from '../models/index.js';
import { create, read, unlink } from '../orm.js';
import { commit, getDb, getUser } from '../store.js';
import { display } from '../ui.jsx';
import { t } from '../i18n.js';
import { downloadCsv } from '../csv.js';
import { downloadXlsx } from '../xlsx.js';

export function exportFields(model) {
  const fields = models[model].fields;
  return Object.entries(fields).flatMap(([name, field]) => {
    const entry = { path: name, label: field.label ?? name, field };
    if (field.type !== 'many2one' || !models[field.relation]) return [entry];
    return [entry, ...Object.entries(models[field.relation].fields).map(([sub, child]) => ({ path: `${name}/${sub}`, label: `${field.label ?? name}/${child.label ?? sub}`, field: child }))];
  });
}

const translateLabel = (label) => label.split('/').map((part) => t(part)).join('/');

export function exportTable(db, model, records, paths, compatible, labels = {}) {
  const fields = exportFields(model);
  const effective = compatible && !paths.includes('.id') ? ['.id', ...paths] : paths;
  const info = effective.map((path) => path === '.id' ? { path, label: 'Database ID', field: { type: 'integer' } } : fields.find((entry) => entry.path === path));
  if (info.some((item) => !item)) throw new Error('Invalid export fields');
  const rows = records.map((record) => info.map(({ path, field }) => {
    if (path === '.id') return record.id;
    const [first, second] = path.split('/');
    const parent = second ? read(db, models[model].fields[first].relation, record[first]) : record;
    const value = parent?.[second ?? first];
    if (value == null) return '';
    if (compatible) return Array.isArray(value) && ['many2many', 'tags'].includes(field.type) ? value.join(',') : typeof value === 'object' ? JSON.stringify(value) : value;
    if (['integer', 'float', 'monetary', 'priority'].includes(field.type) && typeof value === 'number') return value;
    return display(db, field, value, parent);
  }));
  return { rows: [info.map(({ path, label }) => compatible ? path : translateLabel(labels?.[path] ?? label)), ...rows],
    columnTypes: info.map(({ field }) => ['integer', 'float', 'monetary', 'priority'].includes(field.type) ? 'number' : 'text') };
}

export function ExportDialog({ db, model, records, columns, labels, title, onClose }) {
  const [chosen, setChosen] = useState(columns);
  const [query, setQuery] = useState('');
  const [compatible, setCompatible] = useState(false);
  const [format, setFormat] = useState('csv');
  const [templateId, setTemplateId] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const owner = getUser()?.login ?? 'local';
  const company = db.settings?.current_company_id ?? 1;
  const templates = (db.records['ir.exports'] ?? []).filter((r) => r.resource === model && r.owner_login === owner && (r.company_id ?? 1) === company);
  const available = exportFields(model);
  const label = (path) => translateLabel(labels?.[path] ?? available.find((f) => f.path === path)?.label ?? path);
  const change = (paths) => { setChosen(paths); setTemplateId(''); };
  const move = (index, delta) => {
    const next = [...chosen];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    change(next);
  };
  const save = () => {
    try {
      const result = create(getDb(), 'ir.exports', { name: name.trim(), resource: model, owner_login: owner, company_id: company, export_fields: chosen.map((path, index) => ({ name: path, sequence: (index + 1) * 10 })) });
      commit(result.db);
      setTemplateId(String(result.id));
      setError('');
    } catch (e) { setError(t(e.message)); }
  };
  const remove = () => {
    try { commit(unlink(getDb(), 'ir.exports', [Number(templateId)])); setTemplateId(''); setError(''); }
    catch (e) { setError(t(e.message)); }
  };
  const download = () => {
    try {
      if (!chosen.length) throw new Error('Please select fields to export');
      const table = exportTable(db, model, records, chosen, compatible, labels);
      if (format === 'csv') downloadCsv(`${model}.csv`, table.rows);
      else downloadXlsx(`${model}.xlsx`, table.rows, { sheetName: t(title), columnTypes: table.columnTypes });
      onClose();
    } catch (e) { setError(t(e.message)); }
  };
  return <div className="wizard-backdrop"><div className="wizard" role="dialog" aria-modal="true" aria-label={t('Export Data')}>
    <h2>{t('Export Data')}</h2>
    <label>{t('Saved exports')}<select aria-label={t('Saved exports')} value={templateId} onChange={(e) => {
      const id = e.target.value; setTemplateId(id);
      const template = templates.find((r) => String(r.id) === id);
      if (template) setChosen([...template.export_fields].sort((a, b) => a.sequence - b.sequence).map((line) => line.name));
    }}><option value="">{t('Select a template')}</option>{templates.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
    <label>{t('Export template name')}<input aria-label={t('Export template name')} value={name} onChange={(e) => setName(e.target.value)} /></label>
    <button type="button" onClick={save}>{t('Save template')}</button><button type="button" disabled={!templateId} onClick={remove}>{t('Delete template')}</button>
    <label><input type="checkbox" checked={compatible} onChange={(e) => setCompatible(e.target.checked)} />{t('I want to update data (import-compatible export)')}</label>
    <label>{t('Format')}<select aria-label={t('Format')} value={format} onChange={(e) => setFormat(e.target.value)}><option value="csv">{t('CSV')}</option><option value="xlsx">{t('XLSX')}</option></select></label>
    <div style={{ display: 'flex', gap: 16 }}><section style={{ flex: 1 }}><h3>{t('Available fields')}</h3><input aria-label={t('Search fields')} value={query} onChange={(e) => setQuery(e.target.value)} />
      <div style={{ maxHeight: 240, overflow: 'auto' }}>{available.filter((f) => `${f.path} ${translateLabel(f.label)}`.toLowerCase().includes(query.toLowerCase())).map((f) => <button type="button" key={f.path} disabled={chosen.includes(f.path)} onClick={() => change([...chosen, f.path])}>{label(f.path)}</button>)}</div></section>
      <section style={{ flex: 1 }}><h3>{t('Fields to export')}</h3>{chosen.map((path, i) => <div key={path}>{label(path)} <button type="button" aria-label={`${t('Move up')}: ${label(path)}`} disabled={!i} onClick={() => move(i, -1)}>?</button><button type="button" aria-label={`${t('Move down')}: ${label(path)}`} disabled={i === chosen.length - 1} onClick={() => move(i, 1)}>?</button><button type="button" aria-label={`${t('Remove field')}: ${label(path)}`} onClick={() => change(chosen.filter((p) => p !== path))}>?</button></div>)}</section></div>
    {error && <p role="alert">{error}</p>}<button type="button" onClick={download}>{t('Export')}</button><button type="button" onClick={onClose}>{t('Cancel')}</button>
  </div></div>;
}
