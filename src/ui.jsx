// Shared widgets: field display/input, icons, avatar, tags.
import { useState } from 'react';
import { models } from './models/index.js';
import { read, search } from './orm.js';
import { lang, t } from './i18n.js';

const dateLocale = lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-US';
const moneyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
export const money = (n) => moneyFmt.format(Math.abs(Number(n) || 0) < 0.005 ? 0 : Number(n));
export const formatDate = (iso, opts = { month: 'short', day: 'numeric', year: 'numeric' }) =>
  new Date(iso + 'T00:00').toLocaleDateString(dateLocale, opts);
export const isNumeric = (field) => ['monetary', 'float', 'integer'].includes(field?.type);

export function display(db, field, value) {
  if (value == null || value === '') return '';
  switch (field.type) {
    case 'monetary': return money(value);
    case 'float': return Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    case 'selection': return t(field.options.find((o) => o[0] === value)?.[1] ?? value);
    case 'many2one': return read(db, field.relation, Number(value))?.name ?? '';
    case 'boolean': return value ? t('Yes') : '';
    case 'tags': return value.join(', ');
    case 'date': return formatDate(value);
    default: return String(value);
  }
}

const TAG_COLORS = ['#fee2e2', '#dbeafe', '#dcfce7', '#fef3c7', '#ede9fe', '#cffafe', '#fce7f3'];
const hash = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

export const Tag = ({ name, onRemove }) => (
  <span className="tag" style={{ background: TAG_COLORS[hash(name) % TAG_COLORS.length] }}>
    {name}
    {onRemove && <button type="button" aria-label={`${t('Remove filter')} ${name}`} onClick={onRemove}>×</button>}
  </span>
);

export const Avatar = ({ name = '?', size = 28 }) => (
  <span className="avatar" title={name} style={{ width: size, height: size, fontSize: size * 0.42, background: `hsl(${hash(name) % 360} 45% 42%)` }}>
    {String(name).split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase()}
  </span>
);

export function Stars({ value = 0, onChange }) {
  return (
    <span className="stars" aria-label={t('Priority')}>
      {[1, 2, 3].map((n) => (
        <button
          key={n}
          type="button"
          className={n <= value ? 'on' : ''}
          disabled={!onChange}
          aria-label={`${n} ★`}
          aria-pressed={n <= value}
          onClick={(e) => { e.stopPropagation(); onChange?.(value === n ? 0 : n); }}
        >★</button>
      ))}
    </span>
  );
}

function TagsInput({ value = [], onChange }) {
  const [text, setText] = useState('');
  const add = () => {
    const tag = text.trim();
    if (tag && !value.includes(tag)) onChange([...value, tag]);
    setText('');
  };
  return (
    <div className="tags-input">
      {value.map((tag) => <Tag key={tag} name={tag} onRemove={() => onChange(value.filter((x) => x !== tag))} />)}
      <input
        value={text}
        placeholder={value.length ? '' : t('Add a tag…')}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
        onBlur={add}
      />
    </div>
  );
}

const lineSubtotal = (l) => (Number(l.qty) || 0) * (Number(l.price_unit) || 0);

/** Editable one2many table driven by `field.fields`; `field.onchange` reacts to sub-field edits. */
function Lines({ db, field, value = [], onChange, readonly }) {
  const cols = Object.entries(field.fields);
  const priced = 'price_unit' in field.fields;
  const set = (i, key, v) => {
    const next = value.map((l, j) => (j === i ? { ...l, [key]: v } : l));
    onChange(next.map((l, j) => (j === i && field.onchange ? field.onchange(l, key, db) : l)));
  };
  return (
    <div className="lines-wrap">
      <table className="lines">
        <thead>
          <tr>
            {cols.map(([k, f]) => <th key={k} className={isNumeric(f) ? 'num' : ''}>{t(f.label)}</th>)}
            {priced && <th className="num">{t('Subtotal')}</th>}
            {!readonly && <th aria-label={t('Delete')} />}
          </tr>
        </thead>
        <tbody>
          {value.map((l, i) => (
            <tr key={i}>
              {cols.map(([k, f]) => (
                <td key={k} className={isNumeric(f) ? 'num' : ''}>
                  {readonly
                    ? display(db, f, l[k])
                    : <FieldInput db={db} field={f} value={l[k]} onChange={(v) => set(i, k, v)} placeholder={k === 'product_id' ? t('Select a product…') : undefined} />}
                </td>
              ))}
              {priced && <td className="num">{money(lineSubtotal(l))}</td>}
              {!readonly && (
                <td>
                  <button type="button" className="link danger" aria-label={t('Delete')} onClick={() => onChange(value.filter((_, j) => j !== i))}>✕</button>
                </td>
              )}
            </tr>
          ))}
          {!readonly && (
            <tr>
              <td colSpan={cols.length + 2}>
                <button type="button" className="link" onClick={() => onChange([...value, field.newLine?.() ?? {}])}>{t('Add a line')}</button>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function FieldInput({ db, field, value, onChange, id, readonly, placeholder }) {
  if (field.type === 'one2many') return <Lines db={db} field={field} value={value} onChange={onChange} readonly={readonly} />;
  if (readonly || field.readonly || field.compute) return <span className="readonly">{display(db, field, value)}</span>;
  const text = (type = 'text', extra = {}) => (
    <input id={id} type={type} value={value ?? ''} onChange={(e) => onChange(e.target.value)} {...extra} />
  );
  switch (field.type) {
    case 'text': return <textarea id={id} value={value ?? ''} placeholder={t('Add a description…')} onChange={(e) => onChange(e.target.value)} />;
    case 'integer': return text('number', { step: '1', onChange: (e) => onChange(e.target.value === '' ? null : Number(e.target.value)) });
    case 'monetary':
    case 'float': return text('number', { step: '0.01', onChange: (e) => onChange(e.target.value === '' ? null : Number(e.target.value)) });
    case 'date': return text('date');
    case 'boolean': return <input id={id} type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />;
    case 'selection':
      return (
        <select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
          {field.options.map(([k, l]) => <option key={k} value={k}>{t(l)}</option>)}
        </select>
      );
    case 'many2one':
      return (
        <select id={id} value={value ?? ''} onChange={(e) => onChange(Number(e.target.value) || null)}>
          <option value="">{placeholder ?? ''}</option>
          {search(db, field.relation).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      );
    case 'priority': return <Stars value={value} onChange={onChange} />;
    case 'tags': return <TagsInput value={value} onChange={onChange} />;
    default: return text();
  }
}

export const fieldOf = (model, name) => models[model].fields[name];

// Own icon set (simple geometric glyphs on a 48×48 grid).
const ICONS = {
  crm: <path d="M6 10h36l-13 15v11l-10 5V25z" />,
  sales: <><rect x="8" y="26" width="8" height="14" rx="2" /><rect x="20" y="16" width="8" height="24" rx="2" /><rect x="32" y="8" width="8" height="32" rx="2" /></>,
  contacts: <><circle cx="24" cy="17" r="8" /><path d="M9 41c1-9 7-14 15-14s14 5 15 14z" /></>,
  inventory: <path d="M24 5l17 9v20l-17 9-17-9V14zm0 4L11 16l13 7 13-7z" />,
  accounting: <path d="M12 5h18l8 8v30H12zm17 2v8h8M17 24h14v3H17zm0 7h14v3H17zm0 7h9v3h-9z" fillRule="evenodd" />,
  purchase: <><path d="M4 8h7l5 21h22l4-15H14l-1-3" stroke="currentColor" strokeWidth="4" fill="none" strokeLinejoin="round" /><circle cx="19" cy="38" r="4" /><circle cx="35" cy="38" r="4" /></>,
  calendar: <path d="M8 10h32v30H8zm0 8h32M16 5v9m16-9v9M14 24h6v5h-6zm10 0h6v5h-6zm-10 8h6v5h-6z" stroke="currentColor" strokeWidth="3.5" fill="none" />,
  project: <><rect x="6" y="6" width="36" height="36" rx="6" fill="none" stroke="currentColor" strokeWidth="4" /><path d="M14 24l7 7 13-14" stroke="currentColor" strokeWidth="5" fill="none" strokeLinecap="round" strokeLinejoin="round" /></>,
  helpdesk: <><circle cx="24" cy="24" r="16" fill="none" stroke="currentColor" strokeWidth="7" /><path d="M12 12l7 7m10 10l7 7m0-24l-7 7M19 29l-7 7" stroke="currentColor" strokeWidth="4" /></>,
  employees: <><circle cx="17" cy="16" r="6" /><circle cx="33" cy="18" r="5" /><path d="M5 38c1-8 6-12 12-12s11 4 12 12zm25 0c0-5-1-8-3-10 6-1 13 2 15 10z" /></>,
  settings: <path d="M21 4h6l1 6 4 2 5-4 4 4-4 5 2 4 6 1v6l-6 1-2 4 4 5-4 4-5-4-4 2-1 6h-6l-1-6-4-2-5 4-4-4 4-5-2-4-6-1v-6l6-1 2-4-4-5 4-4 5 4 4-2zm3 13a7 7 0 100 14 7 7 0 000-14z" fillRule="evenodd" />,
  payroll: <path d="M6 12h36v24H6zm18 5a7 7 0 100 14 7 7 0 000-14zM10 16v4h4v-4zm24 12v4h4v-4z" fillRule="evenodd" />,
  discuss: <path d="M6 8h36v24H20l-9 8v-8H6z" />,
  manufacturing: <path d="M5 42V20l10 6v-6l10 6v-6l10 6V8h8v34z" />,
  pos: <path d="M8 6h32v14H8zm4 4v6h24v-6zM6 24h36l-3 18H9zm8 5v3h4v-3zm8 0v3h4v-3zm8 0v3h4v-3zm-16 6v3h4v-3zm8 0v3h4v-3zm8 0v3h4v-3z" fillRule="evenodd" />,
  expenses: <path d="M10 6h28v36l-5-3-5 3-4-3-4 3-5-3-5 3zm6 9v3h16v-3zm0 7v3h16v-3zm0 7v3h10v-3z" fillRule="evenodd" />,
  timeoff: <><circle cx="24" cy="18" r="12" /><path d="M24 30v12M14 42h20" stroke="currentColor" strokeWidth="4" /></>,
  recruitment: <><circle cx="20" cy="20" r="11" fill="none" stroke="currentColor" strokeWidth="5" /><path d="M28 28l12 12" stroke="currentColor" strokeWidth="6" strokeLinecap="round" /></>,
  timesheets: <><circle cx="24" cy="24" r="17" fill="none" stroke="currentColor" strokeWidth="5" /><path d="M24 13v12l8 5" stroke="currentColor" strokeWidth="5" fill="none" strokeLinecap="round" /></>,
  events: <path d="M24 4l5 12 13 1-10 8 3 13-11-7-11 7 3-13-10-8 13-1z" />,
  subscriptions: <path d="M38 18A15 15 0 0011 15l-3-4v12h12l-4-4a10 10 0 0117 1zM10 30a15 15 0 0027 3l3 4V25H28l4 4a10 10 0 01-17-1z" />,
  todo: <><rect x="6" y="8" width="10" height="10" rx="2" /><rect x="20" y="10" width="22" height="6" rx="3" /><rect x="6" y="30" width="10" height="10" rx="2" /><rect x="20" y="32" width="22" height="6" rx="3" /></>,
  knowledge: <path d="M8 8h13c2 0 3 1 3 3v30c0-2-1-3-3-3H8zm32 0H27c-2 0-3 1-3 3v30c0-2 1-3 3-3h13z" />,
  kanban: <><rect x="6" y="8" width="10" height="32" rx="2" /><rect x="19" y="8" width="10" height="22" rx="2" /><rect x="32" y="8" width="10" height="14" rx="2" /></>,
  list: <><rect x="6" y="9" width="36" height="5" rx="2" /><rect x="6" y="21" width="36" height="5" rx="2" /><rect x="6" y="33" width="36" height="5" rx="2" /></>,
  graph: <><rect x="7" y="24" width="8" height="17" rx="2" /><rect x="20" y="12" width="8" height="29" rx="2" /><rect x="33" y="18" width="8" height="23" rx="2" /></>,
  pivot: <path d="M6 6h36v36H6zm0 10h36M18 6v36M6 26h36M6 34h36M30 16v26" stroke="currentColor" strokeWidth="3.5" fill="none" />,
  grid: <><rect x="6" y="6" width="10" height="10" rx="2" /><rect x="19" y="6" width="10" height="10" rx="2" /><rect x="32" y="6" width="10" height="10" rx="2" /><rect x="6" y="19" width="10" height="10" rx="2" /><rect x="19" y="19" width="10" height="10" rx="2" /><rect x="32" y="19" width="10" height="10" rx="2" /><rect x="6" y="32" width="10" height="10" rx="2" /><rect x="19" y="32" width="10" height="10" rx="2" /><rect x="32" y="32" width="10" height="10" rx="2" /></>,
  filter: <path d="M6 9h36L28 25v12l-8 4V25z" />,
  chevron: <path d="M14 18l10 10 10-10" stroke="currentColor" strokeWidth="5" fill="none" strokeLinecap="round" />,
};

export const Icon = ({ name, size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 48 48" fill="currentColor" aria-hidden="true">{ICONS[name] ?? ICONS.grid}</svg>
);
