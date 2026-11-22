// Shared widgets: field display/input, icons, avatar, tags.
import { Component, useEffect, useRef, useState } from 'react';
import { models, targetOf } from './models/index.js';
import { isMultiCompany, read } from './orm.js';
import { relationCandidates } from './companyView.js';
import { LANGUAGES, dateLocale, lang, setLang, t } from './i18n.js';
import { currencyCode } from './models/money.js';
import { companyCurrencyRecord, documentCurrency, findCompanyCurrencyRecord, formatCurrency, roundCurrency } from './money.js';
import { currentCompany } from './models/company.js';
import { parseAmount, today } from './models/common.js';
import { replaceTaxSnapshot, taxSnapshot } from './models/taxes.js';
import {
  analyticAccountKey,
  distributionError,
  distributionRowsError,
  distributionToRows,
  normalizeDistribution,
  parseDistributionInput,
  planTotals,
  remainingInPlan,
  rowsToDistribution,
  storedLineDistribution,
} from './analytic_distribution.js';
import { fieldReadonly, fieldRequired } from './field-metadata.js';
import { HtmlEditor, SafeHtml, sanitizeHtml } from './HtmlEditor.jsx';

export { HtmlEditor, SafeHtml, sanitizeHtml } from './HtmlEditor.jsx';

export const CURRENCIES = ['USD', 'EGP', 'SAR', 'AED', 'KWD', 'QAR', 'MAD', 'EUR', 'GBP'];
let moneyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
let activeCurrency = null;
let activeCode = 'USD';
let currencyConfigured = true;
/** Switch the company currency used by every amount on screen. */
export function setCurrency(code, currency = null) {
  activeCurrency = currency;
  activeCode = code;
  if (!code) {
    currencyConfigured = false;
    moneyFmt = null;
    return;
  }
  currencyConfigured = true;
  try { moneyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: code }); } catch { currencyConfigured = false; moneyFmt = null; }
}
const docFmts = new Map();
// In Arabic, amounts are wrapped in a left-to-right isolate (LRI ... PDI) so a minus sign stays in front of the
// number and the run does not reorder the surrounding right-to-left text.
const ltr = (s) => (lang === 'ar' ? `⁦${s}⁩` : s);
/** An amount whose currency is not configured: the number, marked as such, never a borrowed currency symbol. */
function unconfiguredMoney(n) {
  const val = Math.abs(Number(n) || 0) < 0.005 ? 0 : Number(n);
  return `${ltr(val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))} (${t('currency not configured')})`;
}
/** Format an amount in the company currency, or in `code` (a document's own currency) when given. */
export const money = (n, code = null, currency = null) => {
  const activeCurrencyCode = activeCode || (moneyFmt ? moneyFmt.resolvedOptions().currency : null);
  if (currency) return ltr(formatCurrency(n, currency, code || activeCurrencyCode || undefined));
  if (code) {
    const fmt = docFmts.get(code) ?? docFmts.set(code, safeFormat(code)).get(code);
    return ltr(fmt.format(Math.abs(Number(n) || 0) < 0.005 ? 0 : Number(n)));
  }
  if (!currencyConfigured) return unconfiguredMoney(n);
  if (activeCurrency) return ltr(formatCurrency(n, activeCurrency));
  const fmt = moneyFmt ?? safeFormat('USD');
  return ltr(fmt.format(Math.abs(Number(n) || 0) < 0.005 ? 0 : Number(n)));
};
function safeFormat(code) {
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: code }); } catch { return new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
}
export const formatDate = (iso, opts = { month: 'short', day: 'numeric', year: 'numeric' }) =>
  new Date(iso + 'T00:00').toLocaleDateString(dateLocale, opts);
/** An ISO instant as a datetime-local input value (local time, minutes). */
const localInput = (iso) => { const d = new Date(iso); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
export const isNumeric = (field) => ['monetary', 'float', 'integer'].includes(field?.type);

const utcDayMs = (iso) => {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};

/** Format an ISO date relative to `refDate` (e.g. "Today", "In 5 days", "3 days ago"). */
export function formatRelativeDate(iso, refDate = today()) {
  if (!iso) return '';
  const diff = Math.round((utcDayMs(iso) - utcDayMs(refDate)) / 86400000);
  if (diff === 0) return t('Today');
  if (diff === 1) return t('In 1 day');
  if (diff > 1) return t('In {n} days', { n: diff });
  if (diff === -1) return t('1 day ago');
  return t('{n} days ago', { n: -diff });
}

/** Canonical formatter for analytic distribution tags ("Account 60%, Account 40%"). */
export function formatDistribution(db, value, field = { type: 'distribution', label: 'Analytic Distribution' }) {
  if (value == null || Number.isNaN(value)) return '';
  if (distributionError({ analytic_distribution: field }, { analytic_distribution: value }, db)) {
    return typeof value === 'string' ? value : JSON.stringify(value);
  }
  return formatDistributionEntries(db, Object.entries(normalizeDistribution(value, db)).map(([id, percent]) => [analyticAccountKey(id), percent]));
}

/** "Account 60%, Account 40%" for [accountId, percent] pairs; a non-numeric percent is shown as typed. */
function formatDistributionEntries(db, entries) {
  return entries.map(([accountId, percent]) => {
    const account = read(db, 'account.analytic.account', accountId);
    const name = account?.display_name ?? account?.name ?? accountId;
    return `${name} ${typeof percent === 'number' && Number.isFinite(percent) ? Number(percent.toFixed(2)) : percent}%`;
  }).join(', ');
}

/** Display text of a field value; `rec` (or its parent document) gives monetary amounts their own currency. */
export function display(db, field, value, rec = null) {
  if (rec && field.hideWhen?.(rec, db)) return '';
  if (value == null || value === '') {
    // A line with only a legacy analytic account shows it as the 100% allocation the ledger books.
    if (field?.type === 'distribution' && rec) return formatDistribution(db, storedLineDistribution(rec), field);
    if (field?.type === 'many2one' && field?.emptyAsCompanyCurrency && rec) {
      const compId = rec?.company_id ?? currentCompany(db);
      const compCurr = findCompanyCurrencyRecord(db, compId);
      return compCurr?.display_name ?? compCurr?.name ?? '';
    }
    return '';
  }
  switch (field.type) {
    case 'monetary': {
      const context = { ...rec, company_id: rec?.company_id ?? db?.settings?.current_company_id ?? 1 };
      let currency;
      try {
        currency = field.currency === 'company' ? companyCurrencyRecord(db, context.company_id) : documentCurrency(db, context);
      } catch {
        // Company amounts never borrow the record's own currency: an unresolved company currency is shown as such.
        if (field.currency === 'company') return unconfiguredMoney(value);
        currency = null;
      }
      return money(value, currency?.name ?? currencyCode(db, rec), currency);
    }
    case 'float': {
      const min = Array.isArray(field.digits) ? field.digits[0] : (field.digits == null ? 2 : 0);
      const max = Array.isArray(field.digits) ? field.digits[1] : (field.digits ?? 2);
      return ltr(Number(value).toLocaleString('en-US', { minimumFractionDigits: min, maximumFractionDigits: max }));
    }
    case 'selection': return t(field.options.find((o) => o[0] === value)?.[1] ?? value);
    case 'many2one': { const r = read(db, field.relation, Number(value)); return r?.display_name ?? r?.name ?? ''; }
    case 'many2many': return (Array.isArray(value) ? value : []).map((id) => { const r = read(db, field.relation, Number(id)); return r?.display_name ?? r?.name ?? ''; }).filter(Boolean).join(', ');
    case 'boolean': return value ? t('Yes') : '';
    case 'tags': return value.join(', ');
    // Validated exactly as on save (per-plan totals need the db); a value outside that contract still shows as written rather than breaking the view.
    case 'distribution': return formatDistribution(db, value, field);
    case 'binary': return value?.name ?? '';
    case 'html': return String(value ?? '');
    case 'date': return field.widget === 'remaining_days' ? formatRelativeDate(value) : formatDate(value);
    case 'datetime': return new Date(value).toLocaleString(dateLocale, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
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

/** Closes a popup on an outside click, on Escape (focus returns to its toggle) and when focus leaves it. */
export function useDismiss(open, close, ref) {
  useEffect(() => {
    const el = ref.current;
    if (!open || !el) return undefined;
    const outside = (e) => { if (!el.contains(e.target)) close(); };
    const escape = (e) => { if (e.key === 'Escape') { close(); el.querySelector('[aria-expanded]')?.focus(); } };
    const leave = (e) => { if (e.relatedTarget && !el.contains(e.relatedTarget)) close(); };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', escape);
    el.addEventListener('focusout', leave);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', escape);
      el.removeEventListener('focusout', leave);
    };
  }, [open, close, ref]);
}

/** Arrow-key movement between the items of a role="menu". */
export function menuKeys(e) {
  const items = [...e.currentTarget.querySelectorAll('[role=menuitem],[role=menuitemcheckbox]')];
  const i = items.indexOf(document.activeElement);
  const to = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: items.length - 1 }[e.key];
  if (to === undefined || !items.length) return;
  e.preventDefault();
  items[(to + items.length) % items.length].focus();
}

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

function TagsInput({ id, value = [], onChange }) {
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
        id={id}
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
/** Link to an uploaded file: inline data URL, or the server's stored copy. */
const fileUrl = (v) => (/^data:/.test(v?.data ?? '') ? v.data : /^[0-9a-f]{32}$/.test(v?.blob ?? '') ? `/api/blob/${v.blob}` : null);

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
      {fileUrl(value) && <a href={fileUrl(value)} download={value.name}>⬇ {value.name}</a>}
      <input id={id} type="file" onChange={(e) => pick(e.target.files[0])} />
      {error && <span className="req">{error}</span>}
    </div>
  );
}

import { subtotal as lineSubtotal, pickedInstant } from './models/common.js';

function o2mStorageKey(model, fieldName, field, id) {
  if (model && fieldName) return `mizan-o2m-cols:${model}.${fieldName}`;
  for (const [mName, mDef] of Object.entries(models)) {
    const match = Object.entries(mDef.fields || {}).find(([, f]) => f === field);
    if (match) return `mizan-o2m-cols:${mName}.${match[0]}`;
  }
  return `mizan-o2m-cols:${fieldName || id || field?.label || 'lines'}`;
}

export function readOptionalCols(key) {
  if (!key) return {};
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function writeOptionalCols(key, state) {
  if (!key) return;
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(state));
  } catch { /* ignore disabled or full storage */ }
}

export function useOptionalColumns(storageKey) {
  const [optionalState, setOptionalState] = useState(() => readOptionalCols(storageKey));
  useEffect(() => {
    setOptionalState(readOptionalCols(storageKey));
  }, [storageKey]);
  const isVisible = (key, defaultVisible = false) => optionalState[key] ?? defaultVisible;
  const toggleCol = (key, defaultVisible = false) => {
    const next = { ...optionalState, [key]: !(optionalState[key] ?? defaultVisible) };
    setOptionalState(next);
    writeOptionalCols(storageKey, next);
  };
  return [optionalState, isVisible, toggleCol];
}

const MENU_GAP = 4;
const MENU_MIN_HEIGHT = 160;

/**
 * Fixed-position style for a dropdown anchored to `rect` (the toggle's client rect) inside a
 * `viewport` of {width, height}. It aligns to the toggle's end edge, stays inside the viewport
 * horizontally, opens upward when there is more room above, and caps its height to the room it has.
 */
export function anchoredMenuStyle(rect, { width, height }, { rtl = false, menuWidth = 190 } = {}) {
  const maxLeft = Math.max(MENU_GAP, width - menuWidth - MENU_GAP);
  const preferredLeft = rtl ? rect.left : rect.right - menuWidth;
  const left = Math.min(Math.max(preferredLeft, MENU_GAP), maxLeft);
  const below = height - rect.bottom - MENU_GAP;
  const above = rect.top - MENU_GAP;
  const openUp = below < MENU_MIN_HEIGHT && above > below;
  return openUp
    ? { left, bottom: height - rect.top, maxHeight: above }
    : { left, top: rect.bottom, maxHeight: below };
}

export function OptionalColsMenu({ items, optionalState, onToggle }) {
  const [colsOpen, setColsOpen] = useState(null);
  const menuRef = useRef(null);
  const dropdownRef = useRef(null);
  useDismiss(Boolean(colsOpen), () => setColsOpen(null), menuRef);
  // The menu is fixed-positioned so a scrolling table wrapper cannot clip it; close it when the page
  // or a table scrolls, but not when the menu itself scrolls.
  useEffect(() => {
    if (!colsOpen) return undefined;
    const close = (event) => { if (!dropdownRef.current?.contains(event.target)) setColsOpen(null); };
    document.addEventListener('scroll', close, true);
    return () => document.removeEventListener('scroll', close, true);
  }, [colsOpen]);
  const toggleRef = useRef(null);
  const toggleMenu = () => {
    if (colsOpen) { setColsOpen(null); return; }
    const button = toggleRef.current;
    const rect = button?.getBoundingClientRect?.();
    if (!rect) { setColsOpen({}); return; }
    const rtl = getComputedStyle(button).direction === 'rtl';
    setColsOpen(anchoredMenuStyle(rect, { width: globalThis.innerWidth, height: globalThis.innerHeight }, { rtl }));
  };
  if (!items.length) return null;
  return (
    <div className="o2m-cols-menu" ref={menuRef}>
      <button
        type="button"
        ref={toggleRef}
        className="o2m-cols-toggle"
        aria-label={t('Optional columns')}
        aria-expanded={Boolean(colsOpen)}
        aria-haspopup="menu"
        onClick={toggleMenu}
      >⋯</button>
      {colsOpen && (
        <div className="o2m-cols-dropdown" role="menu" ref={dropdownRef} style={colsOpen} onKeyDown={menuKeys}>
          {items.map(({ key, label, defaultVisible = false }) => {
            const checked = optionalState[key] ?? defaultVisible;
            return (
              <button
                key={key}
                type="button"
                role="menuitemcheckbox"
                aria-checked={checked}
                onClick={() => onToggle(key, defaultVisible)}
              >
                <span aria-hidden="true">{checked ? '✓' : ''}</span>
                <span>{t(label)}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Editable one2many table driven by `field.fields`; `field.onchange` reacts to sub-field edits. */
function Lines({ db, model, fieldName, id, field, value = [], onChange, readonly, record }) {
  const multiCompany = isMultiCompany(db);
  const allCols = (field.columnsFor?.(record, db) ?? Object.entries(field.fields)).filter(([, f]) => !f.hidden && (!f.multiCompanyOnly || multiCompany));
  const optionalCols = allCols.filter(([, f]) => f.optional === 'show' || f.optional === 'hide');
  const storageKey = o2mStorageKey(model, fieldName, field, id);
  const [optionalState, isVisible, toggleCol] = useOptionalColumns(storageKey);

  const cols = allCols.filter(([k, f]) => !f.optional || isVisible(k, f.optional !== 'hide'));
  const totalCols = field.totalColumns?.(record, db) ?? [];
  const priced = 'price_unit' in field.fields;
  const displayOpts = field.fields?.display_type?.options || [];
  const hasSection = displayOpts.some(([v]) => v === 'line_section');
  const hasNote = displayOpts.some(([v]) => v === 'line_note');
  const hasActionCol = !readonly || optionalCols.length > 0;
  const rows = field.sort
    ? value.map((l, idx) => [l, idx]).sort((a, b) => field.sort(a[0], b[0]))
    : value.map((l, idx) => [l, idx]);

  const set = (i, key, v) => {
    const isComputed = Boolean(field.fields[key]?.compute);
    const prevLine = value[i];
    const next = value.map((l, j) => (j === i && !isComputed ? { ...l, [key]: v } : l));
    onChange(next.map((l, j) => (j === i && field.onchange ? field.onchange(isComputed ? { ...l, [key]: v } : l, key, db, record, { previous: prevLine }) : l)));
  };
  const addSpecialLine = (displayType) => {
    const base = field.newLine?.(record, db) ?? {};
    onChange([...value, { ...base, ...replaceTaxSnapshot(taxSnapshot(null)), tax_source_id: null, tax_ids: [], display_type: displayType, name: '', qty: 0, price_unit: 0 }]);
  };

  return (
    <div className="lines-wrap">
      <table className="lines">
        <thead>
          <tr>
            {cols.map(([k, f]) => <th key={k} className={isNumeric(f) ? 'num' : ''}>{f.hideHeader ? '' : t(f.label)}</th>)}
            {priced && <th className="num">{t('Subtotal')}</th>}
            {hasActionCol && (
              <th className="o2m-cols-th" aria-label={optionalCols.length > 0 ? undefined : t('Delete')}>
                <OptionalColsMenu
                  items={optionalCols.map(([k, f]) => ({ key: k, label: f.label, defaultVisible: f.optional !== 'hide' }))}
                  optionalState={optionalState}
                  onToggle={toggleCol}
                />
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map(([l, i], rowIdx) => {
            const isSection = l.display_type === 'line_section';
            const isNote = l.display_type === 'line_note';
            if (isSection || isNote) {
              const nameField = field.fields.name || { type: 'char', label: 'Label' };
              return (
                <tr key={i} className={isSection ? 'o2m-section' : 'o2m-note'}>
                  <td colSpan={cols.length + (priced ? 1 : 0)}>
                    {readonly
                      ? <span className="readonly">{l.name ?? ''}</span>
                      : <FieldInput db={db} field={nameField} value={l.name} record={l} onChange={(v) => set(i, 'name', v)} label={`${t(nameField.label)} ${rowIdx + 1}`} placeholder={isSection ? t('Add a section') : t('Add a note')} />}
                  </td>
                  {!readonly ? (
                    <td>
                      <button type="button" className="link danger" aria-label={t('Delete')} onClick={() => onChange(value.filter((_, j) => j !== i))}>✕</button>
                    </td>
                  ) : optionalCols.length > 0 && <td />}
                </tr>
              );
            }
            const cellRec = { ...l, parent_journal_id: record?.journal_id, move_type: l.move_type ?? record?.move_type, company_id: l.company_id ?? record?.company_id, currency_id: l.currency_id ?? record?.currency_id };
            return (
              <tr key={i}>
                {cols.map(([k, f]) => {
                  const rawVal = f.compute ? f.compute(cellRec, db, record) : l[k];
                  const cellVal = f.valueFallback && !(rawVal?.length) ? f.valueFallback(l) : rawVal;
                  // A field may explain a value it has no record for (e.g. a tax rate with no tax record).
                  const rateText = (Array.isArray(cellVal) ? !cellVal.length : !cellVal) ? f.rateOnlyText?.(l) : null;
                  const cellPlaceholder = k === 'product_id' ? t('Select a product…') : (f.placeholder ? t(f.placeholder) : undefined);
                  return (
                    <td key={k} className={isNumeric(f) ? 'num' : ''}>
                      {f.hideWhen?.(cellRec, db)
                        ? null
                        : readonly
                          ? (rateText ?? display(db, f, cellVal, cellRec))
                          : <><FieldInput db={db} field={f} value={cellVal} record={cellRec} onChange={(v) => set(i, k, v)} label={`${t(f.label)} ${rowIdx + 1}`} placeholder={cellPlaceholder} />{rateText && <span className="readonly rate-only">{rateText}</span>}</>}
                    </td>
                  );
                })}
                {priced && <td className="num">{money(lineSubtotal(l), currencyCode(db, record), documentCurrency(db, record))}</td>}
                {!readonly ? (
                  <td>
                    <button type="button" className="link danger" aria-label={t('Delete')} onClick={() => onChange(value.filter((_, j) => j !== i))}>✕</button>
                  </td>
                ) : optionalCols.length > 0 && <td />}
              </tr>
            );
          })}
          {!readonly && (
            <tr>
              <td colSpan={cols.length + (priced ? 1 : 0) + 1}>
                <div className="o2m-add-actions">
                  <button type="button" className="link" onClick={() => onChange([...value, field.newLine?.(record, db) ?? {}])}>{t('Add a line')}</button>
                  {hasSection && (
                    <button type="button" className="link" onClick={() => addSpecialLine('line_section')}>{t('Add a section')}</button>
                  )}
                  {hasNote && (
                    <button type="button" className="link" onClick={() => addSpecialLine('line_note')}>{t('Add a note')}</button>
                  )}
                </div>
              </td>
            </tr>
          )}
        </tbody>
        {totalCols.length > 0 && cols.some(([k]) => totalCols.includes(k)) && (
          <tfoot>
            <tr>
              {cols.map(([k, f], idx) => {
                if (totalCols.includes(k)) {
                  const ownCurrency = companyCurrencyRecord(db, record?.company_id ?? db?.settings?.current_company_id ?? 1);
                  const sum = roundCurrency(value.reduce((acc, l) => acc + (Number(l?.[k]) || 0), 0), ownCurrency);
                  return <td key={k} className="num"><strong>{display(db, { ...f, currency: f.currency ?? 'company' }, sum, record)}</strong></td>;
                }
                return <td key={k}>{idx === 0 ? <strong>{t('Total')}</strong> : null}</td>;
              })}
              {priced && <td />}
              {hasActionCol && <td />}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

/**
 * Numeric input that accepts Arabic-Indic digits and separators (a type="number" input silently drops them).
 * The typed text is kept while it is being edited; an entry that is not a number is flagged instead of ignored.
 */
function NumberInput({ id, value, onChange, integer, ...rest }) {
  const [draft, setDraft] = useState(null);
  const [prevValue, setPrevValue] = useState(value);
  if (value !== prevValue) {
    setPrevValue(value);
    setDraft(null);
  }
  const parsed = draft == null ? null : parseAmount(draft);
  const invalid = draft != null && draft.trim() !== '' && (Number.isNaN(parsed) || (integer && !Number.isInteger(parsed)));
  return (
    <input id={id} {...rest} type="text" inputMode="decimal" dir="ltr" value={draft ?? (value ?? '')} aria-invalid={invalid || undefined}
      title={invalid ? t('Enter a number') : undefined} className={invalid ? 'invalid' : undefined}
      onChange={(e) => {
        const raw = e.target.value;
        setDraft(raw);
        const n = parseAmount(raw);
        if (raw.trim() === '') onChange(null);
        else if (!Number.isNaN(n) && (!integer || Number.isInteger(n))) onChange(n);
        else onChange(NaN);
      }}
      onBlur={() => { if (!invalid) setDraft(null); }} />
  );
}

/** True when FieldInput renders a single form control that a <label htmlFor> can point at. */
export const isLabelable = (field, readonly, record, db) => {
  const isReadonly = readonly || fieldReadonly(field, record, db);
  return !(isReadonly || (field?.compute && !field?.editable)) && !['one2many', 'priority'].includes(field?.type) && field?.widget !== 'radio';
};

export function DistributionInput({ value, onChange, db = null, record = null, field = null, placeholder = null, id = null, disabled = false, ...props }) {
  const [popoverStyle, setPopoverStyle] = useState(null);
  const containerRef = useRef(null);
  const dropdownRef = useRef(null);
  const triggerRef = useRef(null);
  const nextIdRef = useRef(1);

  const initRows = (stored) => {
    // Imported text that holds a valid distribution opens as rows; other text stays visible on the trigger until replaced.
    const val = typeof stored === 'string' ? parseDistributionInput(stored) : stored;
    if (val && typeof val === 'object' && !Array.isArray(val) && !Number.isNaN(val)) {
      return distributionToRows(val).map((r) => ({
        _id: nextIdRef.current++,
        accountId: r.accountId,
        percent: r.percent,
        percentDraft: String(r.percent),
      }));
    }
    return [];
  };

  const [rows, setRows] = useState(() => initRows(value));
  const [lastPropValue, setLastPropValue] = useState(value);
  const [emitted, setEmitted] = useState(value);

  // A value this widget emitted keeps the rows (and the focused input); an outside change reloads them.
  if (!Object.is(value, lastPropValue)) {
    setLastPropValue(value);
    if (!Object.is(value, emitted)) setRows(initRows(value));
  }

  useDismiss(Boolean(popoverStyle), () => {
    setPopoverStyle(null);
    triggerRef.current?.focus();
  }, containerRef);

  useEffect(() => {
    if (!popoverStyle) return undefined;
    const close = (event) => {
      if (!dropdownRef.current?.contains(event.target)) {
        setPopoverStyle(null);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('scroll', close, true);
    return () => document.removeEventListener('scroll', close, true);
  }, [popoverStyle]);

  const togglePopover = () => {
    if (disabled) return;
    if (popoverStyle) {
      setPopoverStyle(null);
      return;
    }
    const button = triggerRef.current;
    const rect = button?.getBoundingClientRect?.();
    if (!rect) {
      setPopoverStyle({});
      return;
    }
    const rtl = document.documentElement.dir === 'rtl' || (button && getComputedStyle(button).direction === 'rtl');
    setPopoverStyle(anchoredMenuStyle(rect, { width: globalThis.innerWidth, height: globalThis.innerHeight }, { rtl, menuWidth: 340 }));
  };

  const handlePopoverKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setPopoverStyle(null);
      triggerRef.current?.focus();
    }
  };

  const candidates = relationCandidates(db, 'account.analytic.account', null).filter((r) => !field?.domain || field.domain(r, record, db));

  const inlineError = distributionRowsError(rows, db);

  const propagateChange = (nextRows) => {
    const next = rowsToDistribution(nextRows, db);
    setEmitted(next);
    onChange(next);
  };

  const handleUpdateRow = (idToUpdate, key, val) => {
    const nextRows = rows.map((r) => {
      if (r._id !== idToUpdate) return r;
      if (key === 'accountId') {
        const accountId = val ? Number(val) : '';
        const account = accountId && read(db, 'account.analytic.account', accountId);
        if (!r.autoPercent || !account) return { ...r, accountId };
        const percent = remainingInPlan(rows.filter((o) => o._id !== r._id), account, db);
        return { ...r, accountId, percent, percentDraft: String(percent) };
      }
      if (key === 'percentDraft') {
        const parsed = parseAmount(val);
        const numVal = val.trim() === '' ? NaN : (Number.isFinite(parsed) && parsed >= 0 ? parsed : NaN);
        return { ...r, percentDraft: val, percent: numVal, autoPercent: false };
      }
      return r;
    });
    setRows(nextRows);
    propagateChange(nextRows);
  };

  const handleRemoveRow = (idToRemove) => {
    const nextRows = rows.filter((r) => r._id !== idToRemove);
    setRows(nextRows);
    propagateChange(nextRows);
  };

  const handleAddLine = () => {
    // The plan is known only once an account is picked; selecting one sets what is left of that plan.
    const newRow = { _id: nextIdRef.current++, accountId: '', percent: 100, percentDraft: '100', autoPercent: true };
    const nextRows = [...rows, newRow];
    setRows(nextRows);
    propagateChange(nextRows);
  };

  const usedAccountIds = new Set(rows.map((r) => Number(r.accountId)).filter((id) => Number.isSafeInteger(id) && id > 0));

  const planGroups = planTotals(rows, db);
  const unassignedRows = rows.filter((r) => !planGroups.some((g) => g.rows.includes(r)));
  const planName = (account) => account.plan_id
    ? display(db, models['account.analytic.account'].fields.plan_id, account.plan_id)
    : display(db, models['account.analytic.account'].fields.plan, account.plan || 'project');


  const invalid = Number.isNaN(value);
  const displayText = invalid
    ? formatDistributionEntries(db, rows.filter((r) => r.accountId).map((r) => [Number(r.accountId), r.percentDraft]))
    : formatDistribution(db, value, field ?? { type: 'distribution', label: 'Analytic Distribution' });
  const placeholderText = placeholder ?? t(field?.label ?? 'Analytic Distribution');

  const renderRowItem = (row) => {
    const choices = candidates.filter((c) => !usedAccountIds.has(c.id) || c.id === Number(row.accountId));
    if (row.accountId && !choices.some((c) => c.id === Number(row.accountId))) {
      const current = read(db, 'account.analytic.account', Number(row.accountId));
      if (current) choices.unshift(current);
    }
    return (
      <div key={row._id} className="distribution-row">
        <select
          className="distribution-account-select"
          value={row.accountId ?? ''}
          aria-label={t('Analytic Account')}
          onChange={(e) => handleUpdateRow(row._id, 'accountId', e.target.value)}
        >
          <option value="">{t('Select an analytic account…')}</option>
          {choices.map((acc) => (
            <option key={acc.id} value={acc.id}>
              {acc.display_name ?? acc.name ?? acc.id}
            </option>
          ))}
        </select>
        <div className="distribution-percent-cell">
          <input
            type="text"
            inputMode="decimal"
            dir="ltr"
            className="distribution-percent-input"
            value={row.percentDraft ?? (row.percent ?? '')}
            aria-label={t('Percentage')}
            onChange={(e) => handleUpdateRow(row._id, 'percentDraft', e.target.value)}
          />
          <span className="distribution-percent-unit">%</span>
        </div>
        <button
          type="button"
          className="distribution-remove-btn link danger"
          aria-label={t('Remove')}
          onClick={() => handleRemoveRow(row._id)}
        >
          ×
        </button>
      </div>
    );
  };

  return (
    <div className="distribution-widget" ref={containerRef}>
      <button
        type="button"
        id={id}
        ref={triggerRef}
        className={`distribution-trigger${invalid ? ' invalid' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={Boolean(popoverStyle)}
        disabled={disabled}
        onClick={togglePopover}
        {...props}
        // The accessible name carries the current tags, not only the field label.
        aria-label={[props['aria-label'], displayText || placeholderText].filter(Boolean).join(': ')}
        aria-invalid={invalid || undefined}
        title={invalid && inlineError ? t(inlineError) : undefined}
      >
        <span className="distribution-trigger-text">
          {displayText || <span className="muted">{placeholderText}</span>}
        </span>
      </button>

      {popoverStyle && (
        <div
          className="distribution-popover"
          ref={dropdownRef}
          style={popoverStyle}
          role="dialog"
          aria-label={t(field?.label ?? 'Analytic Distribution')}
          onKeyDown={handlePopoverKeyDown}
        >
          {planGroups.map((group) => (
            <div key={group.key} className="distribution-plan-group">
              <div className="distribution-plan-header">
                <span className="distribution-plan-name">{planName(group.account)}</span>
                <span className={`distribution-plan-total ${group.over ? 'danger bold' : 'muted'}`}>
                  {Number(group.total.toFixed(2))}%
                </span>
              </div>
              <div className="distribution-plan-rows">
                {group.rows.map(renderRowItem)}
              </div>
            </div>
          ))}

          {unassignedRows.length > 0 && (
            <div className="distribution-plan-group distribution-unassigned-group">
              <div className="distribution-plan-rows">
                {unassignedRows.map(renderRowItem)}
              </div>
            </div>
          )}

          <div className="distribution-actions">
            <button type="button" className="link distribution-add-line" onClick={handleAddLine}>
              + {t('Add a line')}
            </button>
          </div>

          {inlineError && (
            <div className="distribution-error danger" role="alert">
              {t(inlineError)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function FieldInput({ db, model, fieldName, field, value, onChange, id, readonly, disabled = false, placeholder, record, label, isNew = false }) {
  const isReadonly = readonly || fieldReadonly(field, record, db);
  const isRequired = fieldRequired(field, record, db, isNew);
  if (field.type === 'one2many') return <Lines db={db} model={model} fieldName={fieldName} id={id} field={field} value={value} onChange={onChange} readonly={isReadonly} record={record} />;
  if (field.type === 'many2many' && field.openDirect && (isReadonly || field.compute)) {
    return <span className="readonly">{(Array.isArray(value) ? value : []).map((valId, i) => {
      const related = read(db, field.relation, valId);
      return <span key={valId}>{i > 0 && ', '}<a href={`#/open/${field.relation}/${valId}`}>{related?.display_name ?? related?.name ?? `#${valId}`}</a></span>;
    })}</span>;
  }
  if (field.type === 'many2many') {
    const ids = (Array.isArray(value) ? value : []).map((item) => Number(item && typeof item === 'object' ? item.id : item)).filter((item) => Number.isSafeInteger(item) && item > 0);
    const locked = isReadonly || field.compute;
    const target = targetOf(field.relation, db.settings?.uninstalled ?? []);
    const candidates = relationCandidates(db, field.relation, null).filter((r) => !ids.includes(r.id) && (!field.domain || field.domain(r, record, db)));
    return (
      <div className="many2many-tags">
        {ids.map((item) => {
          const related = read(db, field.relation, item);
          const name = related?.display_name ?? related?.name ?? `#${item}`;
          return <span key={item} className="tag">
            {target !== '#/' && related ? <a href={`${target}/${item}`} className="tag-link">{name}</a> : name}
            {!locked && <button type="button" aria-label={`${t('Remove')} ${name}`} onClick={() => onChange(ids.filter((i) => i !== item))}>×</button>}
          </span>;
        })}
        {!locked && <select id={id} aria-label={label} aria-required={isRequired || undefined} value="" onChange={(e) => {
          const selected = Number(e.target.value);
          if (candidates.some((candidate) => candidate.id === selected)) onChange([...ids, selected]);
        }}>
          <option value="">{t('Add')}</option>
          {candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.display_name ?? candidate.name ?? `#${candidate.id}`}</option>)}
        </select>}
      </div>
    );
  }
  if (isReadonly || (field.compute && !field.editable)) {
    if (field.type === 'html') return <SafeHtml html={value} />;
    return <span className="readonly">{display(db, field, value, record)}</span>;
  }
  // aria-required rather than required: saving is validated by the app, not by native form validation.
  const a11y = { id, 'aria-label': label, 'aria-required': isRequired || undefined, ...(disabled ? { disabled: true } : {}) };
  const text = (type = 'text', extra = {}) => (
    <input {...a11y} type={type} placeholder={placeholder} value={value ?? ''} onChange={(e) => onChange(e.target.value)} {...extra} />
  );
  switch (field.type) {
    case 'distribution': return <DistributionInput {...a11y} value={value ?? storedLineDistribution(record)} onChange={onChange} db={db} record={record} field={field} placeholder={placeholder} />;
    case 'html': {
      const htmlLabel = label ?? (field ? (field.custom ? field.label : t(field.label)) : '');
      if (sanitizeHtml('') === null) {
        return <textarea {...a11y} aria-label={htmlLabel} value={value ?? ''} placeholder={placeholder ?? t('Report content…')} onChange={(e) => onChange(e.target.value)} />;
      }
      return <HtmlEditor id={id} label={htmlLabel} required={isRequired} value={value} placeholder={placeholder} onChange={onChange} />;
    }
    case 'text': return <textarea {...a11y} value={value ?? ''} placeholder={placeholder ?? t('Add a description…')} onChange={(e) => onChange(e.target.value)} />;
    case 'integer': return <NumberInput {...a11y} placeholder={placeholder} value={value} onChange={onChange} integer />;
    case 'monetary':
    case 'float': return <NumberInput {...a11y} placeholder={placeholder} value={value} onChange={onChange} />;
    case 'date': return text('date');
    case 'datetime': return text('datetime-local', { value: value ? localInput(value) : '', onChange: (e) => onChange(pickedInstant(e.target.value, value)) });
    case 'boolean':
      return field.widget === 'toggle'
        ? <input {...a11y} type="checkbox" role="switch" className="toggle-switch" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
        : <input {...a11y} type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />;
    case 'selection':
      if (field.widget === 'radio') {
        return (
          <div id={id} role="radiogroup" aria-label={label} aria-required={isRequired || undefined} className="radio-group">
            {field.options.map(([k, l]) => (
              <label key={k} className="radio-option">
                <input type="radio" name={id || fieldName} value={k} checked={value === k} onChange={() => onChange(k)} />
                <span>{t(l)}</span>
              </label>
            ))}
          </div>
        );
      }
      return (
        <select {...a11y} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
          {!isRequired && <option value="" />}
          {field.options.filter(([k]) => !field.legacyOptions?.includes(k) || k === value).map(([k, l]) => <option key={k} value={k}>{t(l)}</option>)}
        </select>
      );
    case 'many2one': {
      const optCompanyCurrency = !!field?.emptyAsCompanyCurrency;
      const compCurr = optCompanyCurrency ? findCompanyCurrencyRecord(db, record?.company_id ?? currentCompany(db)) : null;
      const selectValue = optCompanyCurrency && (value == null || value === '') ? (compCurr?.id ?? '') : (value ?? '');
      return (
        <select
          {...a11y}
          value={selectValue}
          onChange={(e) => {
            const raw = Number(e.target.value) || null;
            const next = optCompanyCurrency && compCurr && raw === compCurr.id ? null : raw;
            onChange(next);
          }}
        >
          {!optCompanyCurrency && <option value="">{placeholder ?? ''}</option>}
          {relationCandidates(db, field.relation, value).filter((r) => !field.domain || r.id === Number(value) || field.domain(r, record, db)).map((r) => <option key={r.id} value={r.id}>{r.display_name ?? r.name}</option>)}
        </select>
      );
    }
    case 'priority': return <Stars value={value} onChange={onChange} />;
    case 'binary': return <FileInput id={id} value={value} onChange={onChange} />;
    case 'tags': return <TagsInput id={id} value={value} onChange={onChange} />;
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

/** Previous/next pager buttons as one joined group; the chevrons follow the text direction. */
export const PagerButtons = ({ prevLabel, nextLabel, onPrev, onNext, prevDisabled = false, nextDisabled = false }) => (
  <span className="pager-buttons">
    <button type="button" className="pager-btn pager-prev" aria-label={prevLabel} disabled={prevDisabled} onClick={onPrev}><span className="pager-chevron" /></button>
    <button type="button" className="pager-btn pager-next" aria-label={nextLabel} disabled={nextDisabled} onClick={onNext}><span className="pager-chevron" /></button>
  </span>
);

/** One button per other interface language, each labelled in its own language. */
export const LanguageSwitch = ({ className, role }) => LANGUAGES.filter(([code]) => code !== lang).map(([code, label]) => (
  <button key={code} type="button" role={role} className={className} lang={code} onClick={() => setLang(code)}>{label}</button>
));

/** Keeps one broken screen from blanking the whole app; resets when the route (key) changes. React needs a class for this. */
/** Placeholder while the data or a screen's code is loading. */
export const Loading = () => <div className="boot" role="status" aria-live="polite">{t('Loading…')}</div>;

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
