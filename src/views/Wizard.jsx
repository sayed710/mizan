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

function WizardField({ db, field, value, values, onChange, id, disabled = false }) {
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
    const chosen = new Set(value ?? []);
    return (
      <fieldset id={id} className="wizard-choices">
        <legend className="sr-only">{t(field.label)}</legend>
        {!candidates.length && <p className="muted">{t('Nothing to choose from.')}</p>}
        {candidates.map((r) => (
          <label key={r.id} className="check">
            <input type="checkbox" checked={chosen.has(r.id)} onChange={(e) => onChange(e.target.checked ? [...chosen, r.id] : [...chosen].filter((x) => x !== r.id))} />
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

export function Wizard({ db, spec, onConfirm, onCancel, error }) {
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
  // A read-only wizard shows values without offering a write.
  const readOnly = !!spec.readOnly;
  const box = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    box.current?.querySelector('input, select, textarea, button')?.focus();
    return () => previous?.focus?.();
  }, []);

  let renderError = null;
  const visibleFields = [];
  for (const f of spec.fields) {
    try {
      if (!isFieldVisible(f, values)) continue;
      const req = isFieldRequired(f, values);
      const disabled = isFieldDisabled(f, values, readOnly);
      const val = f.compute ? f.compute(values, db) : values[f.name];
      visibleFields.push({ f, req, disabled, val });
    } catch (e) {
      renderError ??= t(e.message);
    }
  }
  const interactionError = fieldError || renderError;
  const displayedError = interactionError || error;
  const canSubmit = !readOnly && !interactionError;

  const submit = (e) => {
    e.preventDefault();
    if (!canSubmit) return;
    let empty;
    try {
      empty = missingFields(spec, values);
    } catch (err) {
      setState((s) => ({ ...s, fieldError: t(err.message) }));
      return;
    }
    setMissing(empty);
    if (!empty.length) return onConfirm(values);
  };
  // Escape closes; Tab stays inside the dialog.
  const onKeyDown = (e) => handleDialogKeyDown(e, box.current, onCancel);
  return (
    <div className="wizard-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <form ref={box} className="wizard" role="dialog" aria-modal="true" aria-labelledby="wizard-title" onSubmit={submit} onKeyDown={onKeyDown}>
        <h2 id="wizard-title">{t(spec.title)}</h2>
        {visibleFields.map(({ f, req, disabled, val }) => (
          <div className="field" key={f.name}>
            <label htmlFor={`w-${f.name}`}>{t(f.label)}{req && <span className="req" aria-hidden="true">*</span>}</label>
            <div className="field-value">
              <WizardField db={db} field={f} id={`w-${f.name}`} disabled={disabled} value={val} values={values} onChange={(v) => {
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
          <button type="submit" className="btn primary" disabled={!canSubmit}>{t(spec.confirmLabel ?? 'Confirm')}</button>
          <button type="button" className="btn" onClick={onCancel}>{t('Cancel')}</button>
        </div>
      </form>
    </div>
  );
}
