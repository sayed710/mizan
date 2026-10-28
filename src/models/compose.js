// ARCH-003: models are assembled from modules in a fixed order, and a later module may extend an earlier
// definition of the same model. compose() makes that order explicit and reports every override, so a test can
// check that an extension never silently drops what it replaces.

/** Merge module model maps in order (later wins), like the object spread it replaces. */
export const composeModels = (modules) => Object.assign({}, ...Object.values(modules));

const labels = (def) => (Array.isArray(def.form?.buttons) ? def.form.buttons.map((b) => b.label) : []);
const filterIds = (def) => (Array.isArray(def.filters) ? def.filters.flat().map((f) => f?.id).filter(Boolean) : []);
const HOOKS = ['guard', 'onchange', 'invariant', 'protectDelete', 'defaults'];

/**
 * Every model defined by more than one module, with what the later definition drops from the earlier one:
 * fields, form buttons (by label), hooks, views and filters. An extension should drop nothing.
 * @returns {{model: string, from: string, by: string, drops: object}[]}
 */
export function modelOverrides(modules) {
  const seen = {};
  const out = [];
  for (const [module, defs] of Object.entries(modules)) {
    for (const [model, def] of Object.entries(defs)) {
      const prev = seen[model];
      if (prev) {
        const drops = {
          fields: Object.keys(prev.def.fields ?? {}).filter((f) => !(f in (def.fields ?? {}))),
          buttons: labels(prev.def).filter((l) => !labels(def).includes(l)),
          hooks: HOOKS.filter((h) => prev.def[h] && !def[h]),
          views: (prev.def.views ?? []).filter((v) => !(def.views ?? []).includes(v)),
          filters: filterIds(prev.def).filter((id) => !filterIds(def).includes(id)),
        };
        out.push({ model, from: prev.module, by: module, drops: Object.fromEntries(Object.entries(drops).filter(([, v]) => v.length)) });
      }
      seen[model] = { def, module };
    }
  }
  return out;
}
