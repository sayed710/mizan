// Type checks for untrusted record values, so one bad write can't break rendering for every user.
import { models } from './models/index.js';

const MAX_TEXT = 20000;
const MAX_ITEMS = 500;
const MAX_FILE = 3 * 1024 * 1024; // data URL of a ≤ 2 MB file
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const fail = (where) => { throw new Error(`Invalid value for ${where}`); };

/** Returns a clean copy of `value` for `field`, or throws. null/undefined/'' are always allowed (empty). */
export function cleanValue(field, value, where) {
  if (value === null || value === undefined || value === '') return value ?? null;
  switch (field.type) {
    case 'char': case 'text':
      if (typeof value !== 'string') fail(where);
      return value.slice(0, field.type === 'char' ? 1000 : MAX_TEXT);
    case 'selection':
      if (typeof value !== 'string' || !field.options.some((o) => o[0] === value)) fail(where);
      return value;
    case 'integer': case 'float': case 'monetary': case 'priority':
      if (typeof value !== 'number' || !Number.isFinite(value)) fail(where);
      return value;
    case 'many2one':
      if (!Number.isInteger(value) || value < 1) fail(where);
      return value;
    case 'boolean':
      if (typeof value !== 'boolean') fail(where);
      return value;
    case 'date':
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(where);
      return value;
    case 'tags':
      if (!Array.isArray(value) || value.length > 50 || !value.every((x) => typeof x === 'string')) fail(where);
      return value.map((x) => x.slice(0, 50));
    case 'binary':
      if (!isPlain(value) || typeof value.data !== 'string' || !value.data.startsWith('data:') || value.data.length > MAX_FILE) fail(where);
      return { name: String(value.name ?? 'file').slice(0, 200), type: String(value.type ?? '').slice(0, 100), size: Number(value.size) || 0, data: value.data };
    case 'one2many':
      if (!Array.isArray(value) || value.length > MAX_ITEMS || !value.every(isPlain)) fail(where);
      return value.map((line, i) => Object.fromEntries(
        Object.entries(field.fields).filter(([k]) => k in line).map(([k, sub]) => [k, cleanValue(sub, line[k], `${where}[${i}].${k}`)]),
      ));
    default:
      fail(where);
  }
  return null;
}

/** Declared, non-computed fields only, each type-checked. */
export function cleanRecord(model, rec) {
  const fields = models[model].fields;
  const out = { id: rec.id };
  if ('active' in rec) {
    if (typeof rec.active !== 'boolean') fail(`${model}.active`);
    out.active = rec.active;
  }
  if (rec.company_id != null) {
    if (!Number.isInteger(rec.company_id) || rec.company_id < 1) fail(`${model}.company_id`);
    out.company_id = rec.company_id;
  }
  for (const [k, v] of Object.entries(rec)) {
    const f = fields[k];
    if (f && !f.compute) out[k] = cleanValue(f, v, `${model}.${k}`);
  }
  return out;
}

export const cleanMessage = (m) => (isPlain(m) && typeof m.id === 'string' && models[m.model] && Number.isInteger(m.res_id) ? {
  id: m.id.slice(0, 64), model: m.model, res_id: m.res_id, body: String(m.body ?? '').slice(0, 10000),
  kind: m.kind === 'note' ? 'note' : 'tracking', author: String(m.author ?? '').slice(0, 100), date: String(m.date ?? '').slice(0, 40),
} : null);

/** favorites: { model: [{ name, search }] } with bounded size. */
export function cleanFavorites(v, fallback) {
  if (!isPlain(v)) return fallback;
  const out = {};
  for (const [model, list] of Object.entries(v)) {
    if (!models[model] || !Array.isArray(list)) continue;
    out[model] = list.filter((f) => isPlain(f) && typeof f.name === 'string' && isPlain(f.search)).slice(0, 50).map((f) => ({
      name: f.name.slice(0, 80),
      search: {
        terms: (Array.isArray(f.search.terms) ? f.search.terms : []).filter((x) => typeof x === 'string').slice(0, 20),
        filters: (Array.isArray(f.search.filters) ? f.search.filters : []).filter((x) => typeof x === 'string').slice(0, 20),
        groupBy: (Array.isArray(f.search.groupBy) ? f.search.groupBy : []).filter((x) => typeof x === 'string' && models[model].fields[x]).slice(0, 5),
        archived: !!f.search.archived,
        rel: null,
      },
    }));
  }
  return out;
}
