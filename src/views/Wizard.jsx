// In-app dialog for buttons that need input: a button declares `wizard(db, rec)` returning
// { title, fields: [{ name, type, label, required?, relation?, domain?, options?, default? }] } (or null to skip),
// and its `run(db, rec, values)` receives what was entered. Replaces native prompt(): translated, validated, keyboard-friendly.
import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n.js';
import { FieldInput } from '../ui.jsx';
import { viewRecords } from '../companyView.js';

export const wizardDefaults = (spec) => Object.fromEntries(spec.fields.map((f) => [f.name, f.default ?? (f.type === 'many2many' ? [] : null)]));

export const isFieldVisible = (f, values) => (typeof f.invisible === 'function' ? !f.invisible(values) : !f.invisible);

export const isFieldRequired = (f, values) => {
  if (!isFieldVisible(f, values)) return false;
  if (typeof f.required === 'function') return Boolean(f.required(values));
  return Boolean(f.required);
};

export const isFieldDisabled = (f, values, readOnly = false) => {
  if (readOnly || f.disabled) return true;
  if (typeof f.readonly === 'function') return Boolean(f.readonly(values));
  return Boolean(f.readonly);
};

/** Fields left empty that the wizard requires, by label. */
export const missingFields = (spec, values) => spec.fields
  .filter((f) => isFieldRequired(f, values) && (values[f.name] == null || values[f.name] === '' || (Array.isArray(values[f.name]) && !values[f.name].length)))
  .map((f) => t(f.label));

const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 3 * 1024 * 1024;

function attachmentByteSize(att) {
  if (!att || att.kind === 'invoice_pdf') return 0;
  if (Number.isFinite(Number(att.size)) && Number(att.size) > 0) return Number(att.size);
  if (typeof att.data === 'string') {
    const comma = att.data.indexOf(',');
    if (comma >= 0) {
      const meta = att.data.slice(0, comma);
      const body = att.data.slice(comma + 1);
      if (meta.includes(';base64')) return Math.floor((body.length * 3) / 4);
      return body.length;
    }
  }
  return 0;
}

function AttachmentsField({ id, value, onChange, disabled }) {
  const [fileError, setFileError] = useState(null);
  const items = Array.isArray(value) ? value : [];
  const addFile = (file) => {
    if (!file) return;
    const fileSize = Number(file.size) || attachmentByteSize(file);
    if (fileSize > MAX_ATTACHMENT_BYTES) {
      setFileError(t('File is larger than 2 MB'));
      return;
    }
    const existingTotal = items.reduce((sum, item) => sum + attachmentByteSize(item), 0);
    if (existingTotal + fileSize > MAX_TOTAL_ATTACHMENT_BYTES) {
      setFileError(t('Attachments exceed the 3 MB limit'));
      return;
    }
    if (typeof FileReader === 'undefined' || file.data) {
      setFileError(null);
      onChange([...items, {
        id: `custom_${Date.now()}_${items.length}`,
        kind: 'custom',
        name: file.name || 'attachment',
        type: file.type || 'application/octet-stream',
        size: fileSize,
        ...(file.data ? { data: file.data } : {}),
      }]);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setFileError(null);
      onChange([...items, {
        id: `custom_${Date.now()}_${items.length}`,
        kind: 'custom',
        name: file.name || 'attachment',
        type: file.type || 'application/octet-stream',
        size: fileSize,
        data: reader.result,
      }]);
    };
    reader.readAsDataURL(file);
  };
  return (
    <div className="wizard-attachments">
      <div className="many2many-tags">
        {items.map((att, idx) => (
          <span key={att.id ?? `${att.name}-${idx}`} className="tag wizard-attachment">
            <span>{att.name}</span>
            {att.kind === 'invoice_pdf' && <span className="muted">({t('Invoice PDF')})</span>}
            {att.kind === 'template' && <span className="muted">({t('Template attachment')})</span>}
            {!disabled && (
              <button
                type="button"
                aria-label={`${t('Remove')} ${att.name}`}
                onClick={() => onChange(items.filter((_, j) => j !== idx))}
              >×</button>
            )}
          </span>
        ))}
      </div>
      {!disabled && (
        <label className="wizard-attachment-add">
          <span>{t('Add attachment')}</span>
          <input id={id} type="file" onChange={(e) => { addFile(e.target?.files?.[0]); if (e.target) e.target.value = ''; }} />
        </label>
      )}
      {fileError && <span className="req">{fileError}</span>}
    </div>
  );
}

function WizardField({ db, field, value, values, onChange, id, disabled = false }) {
  if (field.type === 'alerts') {
    const items = Array.isArray(value) ? value : [];
    return (
      <div id={id} className="wizard-alerts">
        {items.map((a, idx) => (
          <div key={a.code ?? idx} className={`alert wizard-alert wizard-alert-${a.level ?? 'warning'}`} role="alert">
            {t(a.message)}
          </div>
        ))}
      </div>
    );
  }
  if (field.type === 'send_summary') {
    const items = Array.isArray(value?.items) ? value.items : [];
    return (
      <div id={id} className="wizard-summary">
        {items.length ? items.map((item) => (
          <div key={item.method} className="wizard-summary-item">{t(`${item.label}: ${item.count} invoice(s)`)}</div>
        )) : <span className="muted">{t('No invoices selected.')}</span>}
      </div>
    );
  }
  if (field.type === 'attachments') {
    return <AttachmentsField id={id} value={value} onChange={onChange} disabled={disabled} />;
  }
  if (field.picker === 'asset_invoice_lines') {
    const options = field.options(db, values);
    const selected = new Set(value ?? []);
    return (
      <fieldset id={id} className="wizard-choices">
        <legend className="sr-only">{t(field.label)}</legend>
        {!options.length && <p className="muted">{t('Nothing to choose from.')}</p>}
        {options.map((option) => (
          <label key={option.key} className="check">
            <input type="checkbox" checked={selected.has(option.key)} disabled={disabled} onChange={(e) => onChange(e.target.checked ? [...selected, option.key] : [...selected].filter((key) => key !== option.key))} />
            {option.label}
          </label>
        ))}
      </fieldset>
    );
  }
  if (field.type === 'many2one' || field.type === 'many2many') {
    const candidates = viewRecords(db, field.relation).filter((r) => !field.domain || field.domain(r, values));
    if (field.type === 'many2one') {
      return (
        <select id={id} value={value ?? ''} disabled={disabled} onChange={(e) => onChange(Number(e.target.value) || null)}>
          <option value="" />
          {candidates.map((r) => <option key={r.id} value={r.id}>{r.display_name ?? r.name ?? r.account_number ?? `#${r.id}`}</option>)}
        </select>
      );
    }
    if (field.widget === 'many2many_tags') {
      const ids = (Array.isArray(value) ? value : []).map(Number).filter((x) => Number.isSafeInteger(x) && x > 0);
      const remaining = candidates.filter((r) => !ids.includes(r.id));
      const labelOf = (r) => (r?.email ? `${r.display_name ?? r.name} <${r.email}>` : (r?.display_name ?? r?.name ?? `#${r?.id}`));
      return (
        <div className="many2many-tags">
          {ids.map((rid) => {
            const rel = candidates.find((r) => r.id === rid) ?? (db.records?.[field.relation] ?? []).find((r) => r.id === rid);
            const name = rel ? labelOf(rel) : `#${rid}`;
            return (
              <span key={rid} className="tag">
                <span>{name}</span>
                {!disabled && (
                  <button type="button" aria-label={`${t('Remove')} ${name}`} onClick={() => onChange(ids.filter((x) => x !== rid))}>×</button>
                )}
              </span>
            );
          })}
          {!disabled && (
            <select id={id} aria-label={t(field.label)} value="" onChange={(e) => {
              const selected = Number(e.target.value);
              if (selected && candidates.some((r) => r.id === selected) && !ids.includes(selected)) {
                onChange([...ids, selected]);
              }
            }}>
              <option value="">{t('Add recipient…')}</option>
              {remaining.map((r) => <option key={r.id} value={r.id}>{labelOf(r)}</option>)}
            </select>
          )}
        </div>
      );
    }
    const chosen = new Set(value ?? []);
    return (
      <fieldset id={id} className="wizard-choices">
        <legend className="sr-only">{t(field.label)}</legend>
        {!candidates.length && <p className="muted">{t('Nothing to choose from.')}</p>}
        {candidates.map((r) => (
          <label key={r.id} className="check">
            <input type="checkbox" checked={chosen.has(r.id)} disabled={disabled} onChange={(e) => onChange(e.target.checked ? [...chosen, r.id] : [...chosen].filter((x) => x !== r.id))} />
            {r.name}
          </label>
        ))}
      </fieldset>
    );
  }
  if (field.type === 'selection') {
    const options = typeof field.options === 'function' ? field.options(db, values) : (field.options ?? []);
    return (
      <select id={id} value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value || null)}>
        <option value="" />
        {options.map(([k, l]) => <option key={k} value={k}>{t(l)}</option>)}
      </select>
    );
  }
  return <FieldInput db={db} field={field} value={value} onChange={onChange} id={id} label={t(field.label)} disabled={disabled} />;
}

/** Escape closes a modal dialog; Tab/Shift+Tab keeps keyboard focus inside `container`. */
export function handleDialogKeyDown(e, container, onClose) {
  if (e.key === 'Escape') {
    e.stopPropagation();
    onClose?.();
    return;
  }
  if (e.key !== 'Tab' || !container) return;
  const focusable = [...container.querySelectorAll('input, select, textarea, button')].filter((el) => !el.disabled);
  if (!focusable.length) return;
  const [first, last] = [focusable[0], focusable.at(-1)];
  if (e.shiftKey && (document.activeElement === first || !container.contains?.(document.activeElement))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (document.activeElement === last || !container.contains?.(document.activeElement))) {
    e.preventDefault();
    first.focus();
  }
}

export function Wizard({ db, spec, onConfirm, onCancel, error, pending = false }) {
  const [state, setState] = useState(() => {
    const init = wizardDefaults(spec);
    try {
      return { values: { ...init, ...spec.onchange?.(init, null, db) }, fieldError: null };
    } catch (e) {
      return { values: init, fieldError: t(e.message) };
    }
  });
  const { values, fieldError } = state;
  const [missing, setMissing] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const mountedRef = useRef(true);
  // A read-only wizard shows values without offering a write.
  const readOnly = !!spec.readOnly;
  const isSaving = Boolean(pending || submitting);
  const box = useRef(null);
  useEffect(() => {
    mountedRef.current = true;
    const previous = document.activeElement;
    box.current?.querySelector('input, select, textarea, button')?.focus();
    return () => {
      mountedRef.current = false;
      previous?.focus?.();
    };
  }, []);

  let renderError = null;
  const visibleFields = [];
  for (const f of spec.fields) {
    try {
      if (!isFieldVisible(f, values)) continue;
      const req = isFieldRequired(f, values);
      const disabled = isFieldDisabled(f, values, readOnly || isSaving);
      const val = f.compute ? f.compute(values, db) : values[f.name];
      if (f.type === 'alerts' && (!Array.isArray(val) || !val.length)) continue;
      visibleFields.push({ f, req, disabled, val });
    } catch (e) {
      renderError ??= t(e.message);
    }
  }
  const interactionError = fieldError || renderError;
  const displayedError = interactionError || error;
  const canSubmit = !readOnly && !interactionError && !isSaving;

  const requestCancel = () => {
    if (isSaving || submittingRef.current) return;
    onCancel?.();
  };

  const submit = (e) => {
    e.preventDefault();
    if (!canSubmit || submittingRef.current) return;
    let empty;
    try {
      empty = missingFields(spec, values);
    } catch (err) {
      setState((s) => ({ ...s, fieldError: t(err.message) }));
      return;
    }
    setMissing(empty);
    if (empty.length) return;
    submittingRef.current = true;
    let result;
    try {
      result = onConfirm(values);
    } catch (err) {
      submittingRef.current = false;
      throw err;
    }
    if (result && typeof result.then === 'function') {
      setSubmitting(true);
      return Promise.resolve(result).finally(() => {
        submittingRef.current = false;
        if (mountedRef.current) setSubmitting(false);
      });
    }
    submittingRef.current = false;
    return result;
  };
  // Escape closes unless a save is in progress; Tab stays inside the dialog.
  const onKeyDown = (e) => handleDialogKeyDown(e, box.current, requestCancel);
  return (
    <div className="wizard-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) requestCancel(); }}>
      <form ref={box} className="wizard" role="dialog" aria-modal="true" aria-labelledby="wizard-title" aria-busy={isSaving || undefined} onSubmit={submit} onKeyDown={onKeyDown}>
        <h2 id="wizard-title">{t(spec.title)}</h2>
        {visibleFields.map(({ f, req, disabled, val }) => (
          <div className="field" key={f.name}>
            <label htmlFor={`w-${f.name}`}>{t(f.label)}{req && <span className="req" aria-hidden="true">*</span>}</label>
            <div className="field-value">
              <WizardField db={db} field={f} id={`w-${f.name}`} disabled={disabled} value={val} values={values} onChange={(v) => {
                if (isSaving || submittingRef.current) return;
                setMissing([]);
                setState((s) => {
                  const next = { ...s.values, [f.name]: v, ...Object.fromEntries(spec.fields.filter((dependent) => dependent.dependsOn === f.name).map((dependent) => [dependent.name, null])) };
                  try {
                    return { values: { ...next, ...spec.onchange?.(next, f.name, db) }, fieldError: null };
                  } catch (err) {
                    return { values: next, fieldError: t(err.message) };
                  }
                });
              }} />
              {f.warning && <p className="muted setting-desc">{t(f.warning)}</p>}
              {f.help && <div className="field-help">{t(f.help)}</div>}
            </div>
          </div>
        ))}
        {(missing.length > 0 || displayedError) && (
          <div className="alert" role="alert">{missing.length && !interactionError ? `${t('Fill in')}: ${missing.join(', ')}` : displayedError}</div>
        )}
        <div className="row">
          <button type="submit" className="btn primary" disabled={!canSubmit}>{isSaving ? t('Saving...') : t(spec.confirmLabel ?? 'Confirm')}</button>
          <button type="button" className="btn" disabled={isSaving} onClick={requestCancel}>{t('Cancel')}</button>
        </div>
      </form>
    </div>
  );
}
