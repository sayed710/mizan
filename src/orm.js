// Pure ORM over a plain db object: { records: {model: [rec]}, seq: {model: n}, messages: [] }.
// Every function returns a new db; nothing is mutated.
import { models } from './models.js';

export const emptyDb = () => ({ records: {}, seq: {}, messages: [] });

export const nextId = (db, model) => (db.seq[model] ?? 0) + 1;

/** Records of a model with computed fields applied. Archived (active === false) hidden by default. */
export function search(db, model, { includeArchived = false } = {}) {
  const fields = models[model].fields;
  const computed = Object.entries(fields).filter(([, f]) => f.compute);
  return (db.records[model] ?? [])
    .filter((r) => includeArchived || r.active !== false)
    .map((r) => (computed.length ? { ...r, ...Object.fromEntries(computed.map(([k, f]) => [k, f.compute(r)])) } : r));
}

export const read = (db, model, id) => search(db, model, { includeArchived: true }).find((r) => r.id === id);

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

const message = (model, resId, body, kind) => ({
  id: crypto.randomUUID(),
  model,
  res_id: resId,
  body,
  kind,
  author: 'Admin',
  date: new Date().toISOString(),
});

export function create(db, model, vals) {
  const err = validate(model, vals);
  if (err) throw new Error(err);
  const id = nextId(db, model);
  const rec = { ...(models[model].defaults?.(id) ?? {}), ...stripComputed(model, vals), id };
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
  const clean = stripComputed(model, vals);
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
