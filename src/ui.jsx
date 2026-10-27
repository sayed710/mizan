// Shared widgets: field display/input, icons, avatar, tags.
import { Component, useState } from 'react';
import { models } from './models/index.js';
import { read } from './orm.js';
import { relationCandidates } from './companyView.js';
import { lang, t } from './i18n.js';

const dateLocale = lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-US';
export const CURRENCIES = ['USD', 'EGP', 'SAR', 'AED', 'KWD', 'QAR', 'MAD', 'EUR', 'GBP'];
let moneyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
/** Switch the company currency used by every amount on screen. */
export function setCurrency(code) {
  const c = CURRENCIES.includes(code) ? code : 'USD';
  if (moneyFmt.resolvedOptions().currency !== c) moneyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: c });
}
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
    case 'binary': return value?.name ?? '';
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

/** Honest notice for a model whose effects stay inside Mizan (no real network call); see `simulated` in the model. */
export const SimulatedNote = ({ text }) => (text ? <p className="simulated" role="note"><b>{t('Simulation')}:</b> {t(text)}</p> : null);

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

const MAX_FILE = 2 * 1024 * 1024;

/** File field stored inline as { name, type, size, data(URL) }; capped so the shared database stays small. */
function FileInput({ id, value, onChange }) {
  const [error, setError] = useState(null);
  const pick = (file) => {
    if (!file) return;
    if (file.size > MAX_FILE) { setError(t('File is larger than 2 MB')); return; }
    const reader = new FileReader();
    reader.onload = () => { setError(null); onChange({ name: file.name, type: file.type, size: file.size, data: reader.result }); };
    reader.readAsDataURL(file);
  };
  return (
    <div className="file-input">
      {/^data:/.test(value?.data ?? '') && <a href={value.data} download={value.name}>⬇ {value.name}</a>}
      <input id={id} type="file" onChange={(e) => pick(e.target.files[0])} />
      {error && <span className="req">{error}</span>}
    </div>
  );
}

import { subtotal as lineSubtotal } from './models/common.js';

/** Editable one2many table driven by `field.fields`; `field.onchange` reacts to sub-field edits. */
function Lines({ db, field, value = [], onChange, readonly, record }) {
  const cols = Object.entries(field.fields).filter(([, f]) => !f.hidden);
  const priced = 'price_unit' in field.fields;
  const set = (i, key, v) => {
    const next = value.map((l, j) => (j === i ? { ...l, [key]: v } : l));
    onChange(next.map((l, j) => (j === i && field.onchange ? field.onchange(l, key, db, record) : l)));
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

export function FieldInput({ db, field, value, onChange, id, readonly, placeholder, record }) {
  if (field.type === 'one2many') return <Lines db={db} field={field} value={value} onChange={onChange} readonly={readonly} record={record} />;
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
          {relationCandidates(db, field.relation, value).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      );
    case 'priority': return <Stars value={value} onChange={onChange} />;
    case 'binary': return <FileInput id={id} value={value} onChange={onChange} />;
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
  marketing: <path d="M4 10h40v28H4zm4 4v2l16 10 16-10v-2L24 24z" fillRule="evenodd" />,
  sign: <path d="M6 36c6-12 10-18 13-18 4 0-2 14 2 14s6-10 9-10c2 0 1 6 4 6s4-3 8-3v4c-3 0-5 3-8 3s-3-4-4-4-4 8-9 8c-6 0-1-12-2-12-2 0-6 8-9 15z" />,
  documents: <path d="M6 10h14l4 4h18v24H6z" />,
  planning: <><rect x="6" y="8" width="16" height="8" rx="2" /><rect x="14" y="20" width="22" height="8" rx="2" /><rect x="24" y="32" width="18" height="8" rx="2" /></>,
  rental: <path d="M17 6a11 11 0 016 20l-1 2h4v5h-4v4h-5V26a11 11 0 010-20zm0 6a5 5 0 100 10 5 5 0 000-10z" fillRule="evenodd" />,
  appointments: <path d="M8 10h32v30H8zm0 8h32M16 5v9m16-9v9M17 30l5 5 9-10" stroke="currentColor" strokeWidth="3.5" fill="none" />,
  website: <><circle cx="24" cy="24" r="17" fill="none" stroke="currentColor" strokeWidth="4" /><path d="M7 24h34M24 7c-9 9-9 25 0 34m0-34c9 9 9 25 0 34" stroke="currentColor" strokeWidth="3" fill="none" /></>,
  barcode: <path d="M6 8h4v32H6zm7 0h2v32h-2zm5 0h5v32h-5zm8 0h2v32h-2zm5 0h4v32h-4zm7 0h2v32h-2z" />,
  shopfloor: <path d="M24 4l4 7 8-2 1 8 7 4-4 7 4 7-7 4-1 8-8-2-4 7-4-7-8 2-1-8-7-4 4-7-4-7 7-4 1-8 8 2zm0 13a7 7 0 100 14 7 7 0 000-14z" fillRule="evenodd" />,
  dashboards: <><rect x="6" y="6" width="16" height="20" rx="3" /><rect x="26" y="6" width="16" height="12" rx="3" /><rect x="6" y="30" width="16" height="12" rx="3" /><rect x="26" y="22" width="16" height="20" rx="3" /></>,
  maintenance: <path d="M30 6a10 10 0 00-9 14L6 35l7 7 15-15a10 10 0 0013-12l-6 6-6-2-2-6z" />,
  quality: <path d="M24 4l16 6v12c0 10-7 18-16 22C15 40 8 32 8 22V10zm-8 20l6 6 11-12-3-3-8 9-3-3z" fillRule="evenodd" />,
  fleet: <path d="M8 22l5-10h22l5 10v14h-5v-4H13v4H8zm7-6l-3 6h24l-3-6zm-3 10a3 3 0 106 0 3 3 0 00-6 0zm18 0a3 3 0 106 0 3 3 0 00-6 0z" fillRule="evenodd" />,
  attendances: <><circle cx="24" cy="15" r="9" /><path d="M8 42c1-10 8-15 16-15s15 5 16 15zm24-20l4 4 8-9" stroke="currentColor" strokeWidth="3" /></>,
  appraisals: <path d="M24 4l6 13 14 1-11 9 4 14-13-8-13 8 4-14L4 18l14-1z" fillOpacity=".9" />,
  surveys: <path d="M10 6h28v36H10zm6 8v4h4v-4zm8 1v2h10v-2zm-8 7v4h4v-4zm8 1v2h10v-2zm-8 7v4h4v-4zm8 1v2h10v-2z" fillRule="evenodd" />,
  lunch: <path d="M8 26h32a16 16 0 01-32 0zm4-4a12 12 0 0124 0zM22 6h4v8h-4z" />,
  approvals: <path d="M24 4a20 20 0 110 40 20 20 0 010-40zm-9 20l6 6 12-13-3-3-9 10-3-3z" fillRule="evenodd" />,
  repairs: <path d="M33 5a10 10 0 00-10 13L7 34a4 4 0 006 6l16-16A10 10 0 0042 11l-6 6-5-1-1-5 6-6z" />,
  fieldservice: <path d="M24 4c8 0 14 6 14 14 0 10-14 26-14 26S10 28 10 18c0-8 6-14 14-14zm0 8a6 6 0 100 12 6 6 0 000-12z" fillRule="evenodd" />,
  frontdesk: <path d="M6 30h36v6H6zm4-4a14 14 0 0128 0zm12-16h4v6h-4z" />,
  elearning: <path d="M24 8l22 10-22 10L2 18zM10 24v10c4 4 10 6 14 6s10-2 14-6V24l-14 7z" />,
  studio: <path d="M34 4l10 10-22 22-12 2 2-12zM6 40h36v4H6z" />,
  apps: <><rect x="6" y="6" width="16" height="16" rx="4" /><rect x="26" y="6" width="16" height="16" rx="8" /><rect x="6" y="26" width="16" height="16" rx="8" /><rect x="26" y="26" width="16" height="16" rx="4" /></>,
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
  gantt: <><rect x="6" y="9" width="18" height="6" rx="2" /><rect x="14" y="21" width="24" height="6" rx="2" /><rect x="22" y="33" width="20" height="6" rx="2" /></>,
  pivot: <path d="M6 6h36v36H6zm0 10h36M18 6v36M6 26h36M6 34h36M30 16v26" stroke="currentColor" strokeWidth="3.5" fill="none" />,
  grid: <><rect x="6" y="6" width="10" height="10" rx="2" /><rect x="19" y="6" width="10" height="10" rx="2" /><rect x="32" y="6" width="10" height="10" rx="2" /><rect x="6" y="19" width="10" height="10" rx="2" /><rect x="19" y="19" width="10" height="10" rx="2" /><rect x="32" y="19" width="10" height="10" rx="2" /><rect x="6" y="32" width="10" height="10" rx="2" /><rect x="19" y="32" width="10" height="10" rx="2" /><rect x="32" y="32" width="10" height="10" rx="2" /></>,
  filter: <path d="M6 9h36L28 25v12l-8 4V25z" />,
  chevron: <path d="M14 18l10 10 10-10" stroke="currentColor" strokeWidth="5" fill="none" strokeLinecap="round" />,
};

// Apps without a dedicated glyph reuse the closest one.
const ALIAS = { phone: 'helpdesk', iot: 'shopfloor', livechat: 'discuss', sms: 'marketing', social: 'events', automation: 'subscriptions', plm: 'manufacturing', rooms: 'calendar', referral: 'recruitment', skills: 'appraisals', esg: 'quality' };

// equity / recycle glyphs
ICONS.equity = <path d="M24 4a20 20 0 1020 20H24z" />;
ICONS.recycle = <path d="M24 6l8 12h-5v6h-6v-6h-5zM10 30l6-10 4 6-3 5h12v6H10zm28 0l-6 6h-6v-6h7l-3-5 5-3z" />;

export const Icon = ({ name, size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 48 48" fill="currentColor" aria-hidden="true">{ICONS[name] ?? ICONS[ALIAS[name]] ?? ICONS.grid}</svg>
);

/** Keeps one broken screen from blanking the whole app; resets when the route (key) changes. React needs a class for this. */
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="action">
        <div className="alert" role="alert">{t('This screen could not be displayed')}: {String(this.state.error.message ?? this.state.error)}</div>
        <button type="button" className="btn" onClick={() => this.setState({ error: null })}>{t('Try again')}</button>
      </main>
    );
  }
}
