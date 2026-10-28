import { models } from './models/index.js';

const editable = (fields, vals) => Object.fromEntries(Object.entries(vals).filter(([k]) => !fields[k]?.readonly));
const generated = { 'mrp.production': ['workorders', 'move_raw'], 'maintenance.request': ['stage', 'stage_id', 'kanban_state', 'close_date'] };

/** Values for a copy of `rec`: readonly and workflow fields are left out so the model defaults apply, as on a new record. */
export function duplicateValues(model, rec) {
  const def = models[model];
  if (def.duplicate === false) throw new Error(`${def.label} cannot be duplicated; use its payment workflow`);
  const excluded = new Set(model === 'account.move' && rec.move_type !== 'entry' ? ['line_ids'] : generated[model] ?? []);
  const { id: _id, ...vals } = rec;
  const kept = Object.fromEntries(Object.entries(editable(def.fields, vals))
    .filter(([k]) => k !== def.form?.statusbar && !excluded.has(k))
    .map(([k, v]) => [k, def.fields[k]?.type === 'one2many' && Array.isArray(v) ? v.map((line) => editable(def.fields[k].fields ?? {}, line)) : v]));
  return def.fields.name && !def.fields.name.readonly ? { ...kept, name: `${rec.name ?? ''} (copy)` } : kept;
}
