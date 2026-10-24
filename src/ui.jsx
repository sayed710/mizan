// Shared widgets: field display/input, icons, avatar, tags.
import { useState } from 'react';
import { models } from './models.js';
import { read, search } from './orm.js';

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export function display(db, field, value) {
  if (value == null || value === '') return '';
  switch (field.type) {
    case 'monetary': return money.format(Number(value));
    case 'float': return Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    case 'selection': return field.options.find((o) => o[0] === value)?.[1] ?? value;
    case 'many2one': return read(db, field.relation, Number(value))?.name ?? '';
    case 'boolean': return value ? 'Yes' : '';
    case 'tags': return value.join(', ');
    case 'date': return new Date(value + 'T00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    default: return String(value);
  }
}

const TAG_COLORS = ['#fee2e2', '#dbeafe', '#dcfce7', '#fef3c7', '#ede9fe', '#cffafe', '#fce7f3'];
const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

export const Tag = ({ name, onRemove }) => (
  <span className="tag" style={{ background: TAG_COLORS[hash(name) % TAG_COLORS.length] }}>
    {name}
    {onRemove && <button type="button" aria-label={`Remove ${name}`} onClick={onRemove}>×</button>}
  </span>
);

export const Avatar = ({ name = '?', size = 28 }) => (
  <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.42, background: `hsl(${hash(name) % 360} 45% 45%)` }}>
    {name.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase()}
  </span>
);

export function Stars({ value = 0, onChange }) {
  return (
    <span className="stars" role={onChange ? 'radiogroup' : undefined} aria-label="Priority">
      {[1, 2, 3].map((n) => (
        <button
          key={n}
          type="button"
          className={n <= value ? 'on' : ''}
          disabled={!onChange}
          aria-label={`${n} star${n > 1 ? 's' : ''}`}
          onClick={(e) => { e.stopPropagation(); onChange?.(value === n ? 0 : n); }}
        >★</button>
      ))}
    </span>
  );
}

function TagsInput({ value = [], onChange }) {
  const [text, setText] = useState('');
  const add = () => {
    const t = text.trim();
    if (t && !value.includes(t)) onChange([...value, t]);
    setText('');
  };
  return (
    <div className="tags-input">
      {value.map((t) => <Tag key={t} name={t} onRemove={() => onChange(value.filter((x) => x !== t))} />)}
      <input
        value={text}
        placeholder={value.length ? '' : 'Add a tag…'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
        onBlur={add}
      />
    </div>
  );
}

function Lines({ db, field, value = [], onChange }) {
  const set = (i, k, v) => {
    const next = value.map((l, j) => (j === i ? { ...l, [k]: v } : l));
    if (k === 'product_id') next[i] = { ...next[i], price_unit: read(db, 'product', Number(v))?.list_price ?? 0 };
    onChange(next);
  };
  const products = search(db, 'product');
  return (
    <table className="lines">
      <thead>
        <tr>
          {Object.values(field.fields).map((f) => <th key={f.label}>{f.label}</th>)}
          <th className="num">Subtotal</th>
          <th aria-label="Actions" />
        </tr>
      </thead>
      <tbody>
        {value.map((l, i) => (
          <tr key={i}>
            <td>
              <select value={l.product_id ?? ''} onChange={(e) => set(i, 'product_id', Number(e.target.value) || null)}>
                <option value="">Select a product…</option>
                {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </td>
            <td><input type="number" min="0" value={l.qty ?? ''} onChange={(e) => set(i, 'qty', e.target.value)} /></td>
            <td><input type="number" min="0" step="0.01" value={l.price_unit ?? ''} onChange={(e) => set(i, 'price_unit', e.target.value)} /></td>
            <td className="num">{money.format((Number(l.qty) || 0) * (Number(l.price_unit) || 0))}</td>
            <td><button type="button" className="link danger" aria-label="Delete line" onClick={() => onChange(value.filter((_, j) => j !== i))}>🗑</button></td>
          </tr>
        ))}
        <tr>
          <td colSpan={5}>
            <button type="button" className="link" onClick={() => onChange([...value, { product_id: null, qty: 1, price_unit: 0 }])}>Add a line</button>
          </td>
        </tr>
      </tbody>
    </table>
  );
}

export function FieldInput({ db, field, value, onChange, id }) {
  if (field.readonly || field.compute) return <span className="readonly">{display(db, field, value)}</span>;
  const text = (type = 'text', extra = {}) => (
    <input id={id} type={type} value={value ?? ''} onChange={(e) => onChange(e.target.value)} {...extra} />
  );
  switch (field.type) {
    case 'text': return <textarea id={id} value={value ?? ''} placeholder="Add a description…" onChange={(e) => onChange(e.target.value)} />;
    case 'monetary':
    case 'float': return text('number', { step: '0.01', onChange: (e) => onChange(e.target.value === '' ? null : Number(e.target.value)) });
    case 'date': return text('date');
    case 'boolean': return <input id={id} type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />;
    case 'selection':
      return (
        <select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
          {field.options.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      );
    case 'many2one':
      return (
        <select id={id} value={value ?? ''} onChange={(e) => onChange(Number(e.target.value) || null)}>
          <option value="" />
          {search(db, field.relation).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      );
    case 'priority': return <Stars value={value} onChange={onChange} />;
    case 'tags': return <TagsInput value={value} onChange={onChange} />;
    case 'one2many': return <Lines db={db} field={field} value={value} onChange={onChange} />;
    default: return text();
  }
}

export const fieldOf = (model, name) => models[model].fields[name];

// Own icon set (simple geometric glyphs) — no third-party artwork.
const ICONS = {
  crm: <path d="M6 10h36l-13 15v11l-10 5V25z" />,
  sales: <><rect x="8" y="26" width="8" height="14" rx="2" /><rect x="20" y="16" width="8" height="24" rx="2" /><rect x="32" y="8" width="8" height="32" rx="2" /></>,
  contacts: <><circle cx="24" cy="17" r="8" /><path d="M9 41c1-9 7-14 15-14s14 5 15 14z" /></>,
  inventory: <path d="M24 5l17 9v20l-17 9-17-9V14zm0 4L11 16l13 7 13-7z" />,
  kanban: <><rect x="6" y="8" width="10" height="32" rx="2" /><rect x="19" y="8" width="10" height="22" rx="2" /><rect x="32" y="8" width="10" height="14" rx="2" /></>,
  list: <><rect x="6" y="9" width="36" height="5" rx="2" /><rect x="6" y="21" width="36" height="5" rx="2" /><rect x="6" y="33" width="36" height="5" rx="2" /></>,
  grid: <><rect x="6" y="6" width="10" height="10" rx="2" /><rect x="19" y="6" width="10" height="10" rx="2" /><rect x="32" y="6" width="10" height="10" rx="2" /><rect x="6" y="19" width="10" height="10" rx="2" /><rect x="19" y="19" width="10" height="10" rx="2" /><rect x="32" y="19" width="10" height="10" rx="2" /><rect x="6" y="32" width="10" height="10" rx="2" /><rect x="19" y="32" width="10" height="10" rx="2" /><rect x="32" y="32" width="10" height="10" rx="2" /></>,
};

export const Icon = ({ name, size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 48 48" fill="currentColor" aria-hidden="true">{ICONS[name]}</svg>
);
