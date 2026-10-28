import { models } from './models/index.js';

const editable = (fields, vals) => Object.fromEntries(Object.entries(vals).filter(([k]) => !fields[k]?.readonly));

/** Values for a copy of `rec`: readonly and workflow fields are left out so the model defaults apply, as on a new record. */
export function duplicateValues(model, rec) {
  const def = models[model];
  const { id: _id, ...vals } = rec;
  const kept = Object.fromEntries(Object.entries(editable(def.fields, vals))
    .filter(([k]) => k !== def.form?.statusbar)
    .map(([k, v]) => [k, def.fields[k]?.type === 'one2many' && Array.isArray(v) ? v.map((line) => editable(def.fields[k].fields ?? {}, line)) : v]));
  return def.fields.name && !def.fields.name.readonly ? { ...kept, name: `${rec.name ?? ''} (copy)` } : kept;
}
