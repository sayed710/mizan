// Studio: user-defined fields stored in settings.customFields and merged into the model registry.
import { models } from '../registry.js';

export const CUSTOM_TYPES = [['char', 'Text'], ['text', 'Multiline Text'], ['float', 'Decimal'], ['monetary', 'Monetary'], ['date', 'Date'], ['boolean', 'Checkbox'], ['selection', 'Selection'], ['tags', 'Tags']];

/** Technical name for a custom field label: "Delivery Zone" → "x_delivery_zone". */
export const technicalName = (label) => `x_${String(label).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'field'}`;

/** Validate one untrusted custom-field definition; returns a clean copy or null. */
export function cleanCustomField(f) {
  if (!f || typeof f !== 'object' || !models[f.model]) return null;
  if (!CUSTOM_TYPES.some(([k]) => k === f.type)) return null;
  const label = String(f.label ?? '').trim().slice(0, 60);
  if (!label) return null;
  const name = technicalName(label);
  // Options arrive as "A, B" from the Studio form, or as [key, label] pairs once stored.
  const labels = Array.isArray(f.options) ? f.options.map((o) => (Array.isArray(o) ? o[1] : o)) : String(f.options ?? '').split(',');
  const options = f.type === 'selection'
    ? labels.map((o) => String(o).trim().slice(0, 60)).filter(Boolean).slice(0, 30).map((o) => [technicalName(o).slice(2), o])
    : undefined;
  if (f.type === 'selection' && !options.length) return null;
  return { model: f.model, name, label, type: f.type, ...(options ? { options } : {}), inList: !!f.inList };
}

const installed = new Map(); // "model.field" → true, so re-installing is idempotent

/**
 * Merge custom fields into the registry (fields + a "Custom" form group + optional list column).
 * ponytail: mutates the shared registry in place — fine for one tenant per process; key by tenant for multi-database hosting.
 */
export function installCustomFields(list = []) {
  for (const raw of list) {
    const f = cleanCustomField(raw);
    if (!f) continue;
    const def = models[f.model];
    def.fields[f.name] = { type: f.type, label: f.label, ...(f.options ? { options: f.options } : {}), custom: true };
    const key = `${f.model}.${f.name}`;
    if (installed.has(key)) continue;
    installed.set(key, true);
    const custom = def.form.groups.find((g) => g.custom);
    if (custom) custom.push(f.name);
    else def.form.groups = [...def.form.groups, Object.assign([f.name], { custom: true })];
    if (f.inList && !def.list.includes(f.name)) def.list = [...def.list, f.name];
  }
}
