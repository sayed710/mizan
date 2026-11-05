import { models } from '../models/index.js';
import { nextId } from '../orm.js';

/** Resolve values for the new-record form in the same order as the action context. */
export function newDefaults(db, model, leaf, params, rel) {
  const def = models[model];
  const fromUrl = Object.fromEntries(
    [...params].filter(([k]) => k.startsWith('default_') && def.fields[k.slice(8)]).map(([k, v]) => [k.slice(8), v]),
  );
  const context = { ...leaf.defaults, ...(rel ? { [rel.field]: rel.id } : {}), ...fromUrl };
  return { ...(def.defaults?.(nextId(db, model), db) ?? {}), ...(def.createDefaults?.(db, context) ?? {}), ...context };
}

/** Apply the same field onchange used by the form before saving. */
export function changeFormValue(model, base, changes, key, value, db, stageExplicit) {
  const next = { ...changes, [key]: value };
  const extra = models[model].onchange?.({ ...base, ...next }, key, db, { stageExplicit }) ?? {};
  return { ...next, ...extra };
}
