// Pure ORM over a plain db object: { records: {model: [rec]}, seq: {model: n}, messages: [] }.
// Every function returns a new db; nothing is mutated.
import { models } from './registry.js';

export const emptyDb = () => ({ records: {}, seq: {}, messages: [], settings: { company: 'My Company', currency: 'USD' } });

export const nextId = (db, model) => (db.seq[model] ?? 0) + 1;

// ---- multi-company: records of company-scoped models carry company_id (missing = company 1) ----
/** Master data shared by all companies (Odoo shares these by default). */
export const SHARED_MODELS = new Set(['res.partner', 'product', 'account.account', 'account.journal', 'res.currency', 'product.pricelist', 'discuss.channel',
  'mail.activity', 'hr.department', 'website.page', 'mailing.list', 'mailing.contact', 'lunch.product', 'room.room', 'appointment.type']);
let activeCompany = null; // null = no filtering (server, tests)
export const setActiveCompany = (id) => { activeCompany = Number(id) || null; };
const inCompany = (model, r) => !activeCompany || SHARED_MODELS.has(model) || (r.company_id ?? 1) === activeCompany;

const withComputed = (fields, r, db) => {
  const computed = Object.entries(fields).filter(([, f]) => f.compute);
  return computed.length ? { ...r, ...Object.fromEntries(computed.map(([k, f]) => [k, f.compute(r, db)])) } : r;
};

/** Records of a model in the active company, with computed fields. Archived (active === false) hidden by default. */
export function search(db, model, { includeArchived = false } = {}) {
  const fields = models[model].fields;
  return (db.records[model] ?? [])
    .filter((r) => (includeArchived || r.active !== false) && inCompany(model, r))
    .map((r) => withComputed(fields, r, db));
}

// id -> position per records array. Arrays are never mutated (writes copy them), so an index stays valid for the
// array it was built from; it is built on the second lookup so one-off reads after a write stay a plain scan.
const positions = new WeakMap();
function locate(list, id) {
  const seen = positions.get(list);
  if (seen instanceof Map) {
    const at = seen.get(id);
    // The position is checked against the array, so even an in-place change can only cost a scan, never a wrong record.
    if (at !== undefined && list[at]?.id === id) return list[at];
    return seen.size === list.length && at === undefined ? undefined : list.find((x) => x.id === id);
  }
  if (seen) positions.set(list, new Map(list.map((x, i) => [x.id, i])));
  else positions.set(list, true);
  return list.find((x) => x.id === id);
}

/** One record by id regardless of company (cross-company links still display). */
export function read(db, model, id) {
  const r = locate(db.records[model] ?? [], id);
  return r && withComputed(models[model].fields, r, db);
}

/** @returns {string|null} error message when a required field is empty */
export function validate(model, vals) {
  const missing = Object.entries(models[model].fields).find(
    ([k, f]) => f.required && (vals[k] == null || vals[k] === ''),
  );
  return missing ? `${missing[1].label} is required` : null;
}

/**
 * Field paths in `rec` that the server's sanitizer (validate.js cleanRecord) would silently drop: keys the model does
 * not declare, top level or inside one2many lines. Logic must only write declared fields, or client and server diverge.
 */
export function undeclaredFields(model, rec) {
  const fields = models[model].fields;
  const out = Object.keys(rec).filter((k) => !['id', 'active', 'company_id'].includes(k) && !fields[k]);
  for (const [k, f] of Object.entries(fields)) {
    if (f.type !== 'one2many' || !Array.isArray(rec[k]) || !f.fields) continue;
    for (const line of rec[k]) out.push(...Object.keys(line ?? {}).filter((sub) => !f.fields[sub]).map((sub) => `${k}.${sub}`));
  }
  return [...new Set(out)];
}
const STRICT_FIELDS = globalThis.process?.env?.MIZAN_STRICT_FIELDS;
const checkDeclared = (model, rec) => {
  if (!STRICT_FIELDS) return;
  const bad = undeclaredFields(model, rec);
  if (!bad.length) return;
  if (STRICT_FIELDS === 'log') globalThis.process.stderr.write(`UNDECLARED ${model}: ${bad.join(',')} @ ${new Error().stack.split('\n').slice(3).find((l) => !l.includes('orm.js'))?.trim()}\n`);
  else throw new Error(`Undeclared fields on ${model}: ${bad.join(', ')}`);
};

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
  const err = validate(model, rec) ?? models[model].guard?.(db, null, rec);
  if (err) throw new Error(err);
  checkDeclared(model, rec);
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
  const audited = models[model].audited?.(db);
  return Object.entries(vals)
    .filter(([k, v]) => fields[k] && (fields[k].tracking || audited) && JSON.stringify(before[k]) !== JSON.stringify(v))
    .map(([k, v]) => {
      if (typeof v === 'object' && v !== null) return message(model, before.id, `${fields[k].label}: updated`, 'tracking');
      const label = (x) => fields[k].options?.find((o) => o[0] === x)?.[1] ?? x;
      return message(model, before.id, `${fields[k].label}: ${label(before[k])} → ${label(v)}`, 'tracking');
    });
}

/** Onchange, validation and guard for one write; returns the updated record and the values actually written. */
function prepareWrite(db, model, before, vals) {
  const base = stripComputed(model, vals);
  // Model onchange also runs for programmatic writes (kanban drag, status bar), so dependent fields stay consistent.
  const clean = { ...base, ...Object.fromEntries(Object.keys(base).flatMap((k) => Object.entries(models[model].onchange?.({ ...before, ...base }, k, db) ?? {})).filter(([k]) => !(k in base))) };
  const after = { ...before, ...clean };
  const err = validate(model, after) ?? models[model].guard?.(db, before, after);
  if (err) throw new Error(err);
  checkDeclared(model, after);
  return { after, clean };
}

export function write(db, model, id, vals) {
  const before = (db.records[model] ?? []).find((r) => r.id === id);
  if (!before) throw new Error(`${model} #${id} not found`);
  const { after, clean } = prepareWrite(db, model, before, vals);
  return {
    ...db,
    records: { ...db.records, [model]: db.records[model].map((r) => (r.id === id ? after : r)) },
    messages: [...db.messages, ...trackingMessages(db, model, before, clean)],
  };
}

/**
 * Write several records of one model in one pass: `updates` maps id -> vals. Each record gets the same onchange,
 * validation, guard and tracking as write(), checked against `db`; the array and the chatter are copied once, so
 * batch jobs stay linear instead of copying everything per record.
 */
export function writeMany(db, model, updates) {
  if (!updates.size) return db;
  const list = db.records[model] ?? [];
  const byId = new Map(list.map((r) => [r.id, r]));
  const written = new Map();
  const tracked = [];
  for (const [id, vals] of updates) {
    const before = byId.get(id);
    if (!before) throw new Error(`${model} #${id} not found`);
    const { after, clean } = prepareWrite(db, model, before, vals);
    written.set(id, after);
    tracked.push(...trackingMessages(db, model, before, clean));
  }
  return {
    ...db,
    records: { ...db.records, [model]: list.map((r) => written.get(r.id) ?? r) },
    messages: tracked.length ? [...db.messages, ...tracked] : db.messages,
  };
}

/** Add several chatter notes at once: `notes` are [model, id, body]. */
export const postNotes = (db, notes) => (notes.length
  ? { ...db, messages: [...db.messages, ...notes.map(([model, id, body]) => message(model, id, body, 'note'))] } : db);

/**
 * The first record that still points at one of `ids` of `model` (a many2one, or a many2one inside one2many lines),
 * described for an error message, or null. Records being deleted themselves don't count.
 */
export function referenceTo(db, model, ids) {
  const drop = new Set(ids);
  for (const [source, def] of Object.entries(models)) {
    for (const [key, f] of Object.entries(def.fields)) {
      const direct = f.type === 'many2one' && f.relation === model && !f.compute;
      const sub = f.type === 'one2many' && f.fields ? Object.keys(f.fields).filter((k) => f.fields[k].type === 'many2one' && f.fields[k].relation === model) : [];
      if (!direct && !sub.length) continue;
      const hit = (db.records[source] ?? []).find((r) => !(source === model && drop.has(r.id))
        && (direct ? drop.has(r[key]) : Array.isArray(r[key]) && r[key].some((l) => sub.some((k) => drop.has(l?.[k])))));
      if (hit) return `${def.label} ${hit.name ?? `#${hit.id}`}`;
    }
  }
  return null;
}

export function unlink(db, model, ids) {
  const drop = new Set(ids);
  const blocked = (db.records[model] ?? []).filter((r) => drop.has(r.id)).map((r) => models[model].protectDelete?.(db, r)).find(Boolean);
  if (blocked) throw new Error(blocked);
  const removed = (db.records[model] ?? []).filter((r) => drop.has(r.id));
  const next = {
    ...db,
    records: { ...db.records, [model]: (db.records[model] ?? []).filter((r) => !drop.has(r.id)) },
    messages: db.messages.filter((m) => !(m.model === model && drop.has(m.res_id))),
  };
  const result = removed.reduce((acc, r) => models[model].onUnlink?.(acc, r) ?? acc, next);
  // Checked after onUnlink, so records it removes along with these don't block the delete.
  const used = referenceTo(result, model, ids);
  if (used) throw new Error(`This record is still used by ${used}; archive it instead`);
  return result;
}

/** A tracking (audit) message, as `write` posts for a changed tracked field. */
export const postTracking = (db, model, id, body) => ({ ...db, messages: [...db.messages, message(model, id, body, 'tracking')] });
export const postNote = (db, model, id, body) => ({ ...db, messages: [...db.messages, message(model, id, body, 'note')] });

export const messagesOf = (db, model, id) =>
  db.messages.filter((m) => m.model === model && m.res_id === id).sort((a, b) => b.date.localeCompare(a.date));

export const updateSettings = (db, vals) => ({ ...db, settings: { ...db.settings, ...vals } });

const groupKey = (field, v) => {
  if (field.type === 'date' || field.type === 'datetime') return v ? v.slice(0, 7) : false;
  if (field.type === 'boolean') return !!v;
  return v ?? false;
};

export function groupLabel(db, field, key) {
  if (key === false || key == null || key === '') return field.type === 'boolean' ? 'No' : 'None';
  switch (field.type) {
    case 'date': case 'datetime': return new Date(key + '-01T00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
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
  const rank = (g) => (g.key === false ? '￿' : ['date', 'datetime'].includes(field.type) ? String(g.key) : g.label.toLowerCase());
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
