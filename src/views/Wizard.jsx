// In-app dialog for buttons that need input: a button declares `wizard(db, rec)` returning
// { title, fields: [{ name, type, label, required?, relation?, domain?, options?, default? }] } (or null to skip),
// and its `run(db, rec, values)` receives what was entered. Replaces native prompt(): translated, validated, keyboard-friendly.
import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n.js';
import { FieldInput } from '../ui.jsx';
import { viewRecords } from '../companyView.js';

export const wizardDefaults = (spec) => Object.fromEntries(spec.fields.map((f) => [f.name, f.default ?? (f.type === 'many2many' ? [] : null)]));

/** Fields left empty that the wizard requires, by label. */
export const missingFields = (spec, values) => spec.fields
  .filter((f) => f.required && (values[f.name] == null || values[f.name] === '' || (Array.isArray(values[f.name]) && !values[f.name].length)))
  .map((f) => t(f.label));

function WizardField({ db, field, value, values, onChange, id }) {
  if (field.type === 'many2one' || field.type === 'many2many') {
    const candidates = viewRecords(db, field.relation).filter((r) => !field.domain || field.domain(r));
    if (field.type === 'many2one') {
      return (
        <select id={id} value={value ?? ''} onChange={(e) => onChange(Number(e.target.value) || null)}>
          <option value="" />
          {candidates.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
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
    const options = typeof field.options === 'function' ? field.options(db, values) : field.options;
    return (
      <select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
        <option value="" />
        {options.map(([k, l]) => <option key={k} value={k}>{t(l)}</option>)}
      </select>
    );
  }
  return <FieldInput db={db} field={field} value={value} onChange={onChange} id={id} />;
}

export function Wizard({ db, spec, onConfirm, onCancel, error }) {
  const [values, setValues] = useState(() => wizardDefaults(spec));
  const [missing, setMissing] = useState([]);
  const box = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    box.current?.querySelector('input, select, textarea, button')?.focus();
    return () => previous?.focus?.();
  }, []);
  const submit = (e) => {
    e.preventDefault();
    const empty = missingFields(spec, values);
    setMissing(empty);
    if (!empty.length) onConfirm(values);
  };
  // Escape closes; Tab stays inside the dialog.
  const onKeyDown = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); onCancel(); }
    if (e.key !== 'Tab') return;
    const focusable = [...box.current.querySelectorAll('input, select, textarea, button')].filter((el) => !el.disabled);
    const [first, last] = [focusable[0], focusable.at(-1)];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  return (
    <div className="wizard-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <form ref={box} className="wizard" role="dialog" aria-modal="true" aria-labelledby="wizard-title" onSubmit={submit} onKeyDown={onKeyDown}>
        <h2 id="wizard-title">{t(spec.title)}</h2>
        {spec.fields.map((f) => (
          <div className="field" key={f.name}>
            <label htmlFor={`w-${f.name}`}>{t(f.label)}{f.required && <span className="req" aria-hidden="true">*</span>}</label>
            <div className="field-value">
              <WizardField db={db} field={f} id={`w-${f.name}`} value={values[f.name]} values={values} onChange={(v) => setValues((s) => ({ ...s, [f.name]: v, ...Object.fromEntries(spec.fields.filter((dependent) => dependent.dependsOn === f.name).map((dependent) => [dependent.name, null])) }))} />
            </div>
          </div>
        ))}
        {(missing.length > 0 || error) && (
          <div className="alert" role="alert">{missing.length ? `${t('Fill in')}: ${missing.join(', ')}` : error}</div>
        )}
        <div className="row">
          <button type="submit" className="btn primary">{t('Confirm')}</button>
          <button type="button" className="btn" onClick={onCancel}>{t('Cancel')}</button>
        </div>
      </form>
    </div>
  );
}
