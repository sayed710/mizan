// Pure ORM over a plain db object: { records: {model: [rec]}, seq: {model: n}, messages: [] }.
// Every function returns a new db; nothing is mutated.
import { models } from './models/index.js';

export const emptyDb = () => ({ records: {}, seq: {}, messages: [], settings: { company: 'My Company', currency: 'USD' } });

export const nextId = (db, model) => (db.seq[model] ?? 0) + 1;

// ---- multi-company: records of company-scoped models carry company_id (missing = company 1) ----
/** Master data shared by all companies (Odoo shares these by default). */
export const SHARED_MODELS = new Set(['res.partner', 'product', 'account.account', 'account.journal', 'res.currency', 'product.pricelist', 'discuss.channel',
  'mail.activity', 'hr.department', 'website.page', 'mailing.list', 'mailing.contact', 'lunch.product', 'room.room', 'appointment.type']);
let activeCompany = null; // null = no filtering (server, tests)
export const setActiveCompany = (id) => { activeCompany = Number(id) || null; };
const inCompany = (model, r) => !activeCompany || SHARED_MODELS.has(model) || (r.company_id ?? 1) === activeCompany;

const withComputed = (fields, r) => {
  const computed = Object.entries(fields).filter(([, f]) => f.compute);
  return computed.length ? { ...r, ...Object.fromEntries(computed.map(([k, f]) => [k, f.compute(r)])) } : r;
};

/** Records of a model in the active company, with computed fields. Archived (active === false) hidden by default. */
export function search(db, model, { includeArchived = false } = {}) {
  const fields = models[model].fields;
  return (db.records[model] ?? [])
    .filter((r) => (includeArchived || r.active !== false) && inCompany(model, r))
    .map((r) => withComputed(fields, r));
}

/** One record by id regardless of company (cross-company links still display). */
export function read(db, model, id) {
  const r = (db.records[model] ?? []).find((x) => x.id === id);
  return r && withComputed(models[model].fields, r);
}

/** @returns {string|null} error message when a required field is empty */
export function validate(model, vals) {
  const missing = Object.entries(models[model].fields).find(
    ([k, f]) => f.required && (vals[k] == null || vals[k] === ''),
  );
  return missing ? `${missing[1].label} is required` : null;
}

function stripComputed(model, vals) {
  const fields = models[model].fields;
  return Object.fromEntries(Object.entries(vals).filter(([k]) => !fields[k]?.compute));
}

let author = 'Admin';
/** Name stamped on chatter messages created by this client/process. */
export const setAuthor = (name) => { author = name; };

const message = (model, resId, body, kind) => ({
  id: crypto.randomUUID(),
  model,
  res_id: resId,
  body,
  kind,
  author,
  date: new Date().toISOString(),
});

export function create(db, model, vals) {
  const id = nextId(db, model);
  const rec = {
    ...(models[model].defaults?.(id) ?? {}),
    ...(SHARED_MODELS.has(model) ? {} : { company_id: activeCompany ?? 1 }),
    ...stripComputed(model, vals),
    id,
  };
  const err = validate(model, rec);
  if (err) throw new Error(err);
  return {
    db: {
      ...db,
      records: { ...db.records, [model]: [...(db.records[model] ?? []), rec] },
      seq: { ...db.seq, [model]: id },
      messages: [...db.messages, message(model, id, `${models[model].label}: record created`, 'tracking')],
    },
    id,
  };
}

function trackingMessages(db, model, before, vals) {
  const fields = models[model].fields;
  return Object.entries(vals)
    .filter(([k, v]) => fields[k]?.tracking && before[k] !== v)
    .map(([k, v]) => {
      const label = (x) => fields[k].options.find((o) => o[0] === x)?.[1] ?? x;
      return message(model, before.id, `${fields[k].label}: ${label(before[k])} → ${label(v)}`, 'tracking');
    });
}

export function write(db, model, id, vals) {
  const before = (db.records[model] ?? []).find((r) => r.id === id);
  if (!before) throw new Error(`${model} #${id} not found`);
  const base = stripComputed(model, vals);
  // Model onchange also runs for programmatic writes (kanban drag, status bar), so dependent fields stay consistent.
  const clean = { ...base, ...Object.fromEntries(Object.keys(base).flatMap((k) => Object.entries(models[model].onchange?.({ ...before, ...base }, k, db) ?? {})).filter(([k]) => !(k in base))) };
  const after = { ...before, ...clean };
  const err = validate(model, after);
  if (err) throw new Error(err);
  return {
    ...db,
    records: { ...db.records, [model]: db.records[model].map((r) => (r.id === id ? after : r)) },
    messages: [...db.messages, ...trackingMessages(db, model, before, clean)],
  };
}

export function unlink(db, model, ids) {
  const drop = new Set(ids);
  return {
    ...db,
    records: { ...db.records, [model]: (db.records[model] ?? []).filter((r) => !drop.has(r.id)) },
    messages: db.messages.filter((m) => !(m.model === model && drop.has(m.res_id))),
  };
}

export const postNote = (db, model, id, body) => ({ ...db, messages: [...db.messages, message(model, id, body, 'note')] });

export const messagesOf = (db, model, id) =>
  db.messages.filter((m) => m.model === model && m.res_id === id).sort((a, b) => b.date.localeCompare(a.date));

export const updateSettings = (db, vals) => ({ ...db, settings: { ...db.settings, ...vals } });

const groupKey = (field, v) => {
  if (field.type === 'date') return v ? v.slice(0, 7) : false;
  if (field.type === 'boolean') return !!v;
  return v ?? false;
};

export function groupLabel(db, field, key) {
  if (key === false || key == null || key === '') return field.type === 'boolean' ? 'No' : 'None';
  switch (field.type) {
    case 'date': return new Date(key + '-01T00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    case 'selection': return field.options.find((o) => o[0] === key)?.[1] ?? key;
    case 'many2one': return read(db, field.relation, key)?.name ?? 'None';
    case 'boolean': return 'Yes';
    default: return String(key);
  }
}

/**
 * Group records by a field. Selection groups follow option order and include empty options;
 * dates group by month (chronological); others sort by label with "None" last.
 * @returns {{key: any, label: string, records: object[]}[]}
 */
export function groupRecords(db, model, records, name) {
  const field = models[model].fields[name];
  const buckets = new Map(field.type === 'selection' ? field.options.map(([k]) => [k, []]) : []);
  for (const r of records) {
    const k = groupKey(field, r[name]);
    buckets.set(k, [...(buckets.get(k) ?? []), r]);
  }
  const groups = [...buckets].map(([key, recs]) => ({ key, label: groupLabel(db, field, key), records: recs }));
  if (field.type === 'selection') return groups;
  const rank = (g) => (g.key === false ? '￿' : field.type === 'date' ? String(g.key) : g.label.toLowerCase());
  return groups.sort((a, b) => rank(a).localeCompare(rank(b)));
}

/** Sum of a numeric field, or the record count for the pseudo-measure "__count". */
export const aggregate = (records, measure) =>
  measure === '__count' ? records.length : records.reduce((s, r) => s + (Number(r[measure]) || 0), 0);

/** Filters in the same group are OR-ed, groups are AND-ed (search-panel semantics). */
export function applyFilters(model, records, activeIds) {
  const groups = (models[model].filters ?? [])
    .map((g) => g.filter((f) => activeIds.includes(f.id)))
    .filter((g) => g.length);
  return records.filter((r) => groups.every((g) => g.some((f) => f.fn(r))));
}

/** Text search: every term must match some char/text/many2one display value. */
export function matches(db, model, rec, terms) {
  const fields = models[model].fields;
  const haystack = Object.entries(fields)
    .map(([k, f]) => {
      if (f.type === 'many2one') return read(db, f.relation, rec[k])?.name ?? '';
      if (f.type === 'tags') return (rec[k] ?? []).join(' ');
      return ['char', 'text', 'selection'].includes(f.type) ? String(rec[k] ?? '') : '';
    })
    .join(' ')
    .toLowerCase();
  return terms.every((t) => haystack.includes(t.toLowerCase()));
}
