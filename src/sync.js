// Record-level diff between two db snapshots, applied server-side so concurrent edits
// to different records don't overwrite each other.
import { models } from './models/index.js';
import { validate } from './orm.js';
import { cleanCustomField, installCustomFields } from './models/studio.js';

const byId = (list = []) => new Map(list.map((r) => [r.id, r]));

/** @returns {{upserts: Record<string, object[]>, deletes: Record<string, number[]>, messages: object[], removedMessages: string[], seq: object, settings: object}} */
export function diffDb(prev, next) {
  const upserts = {};
  const deletes = {};
  for (const model of new Set([...Object.keys(prev.records), ...Object.keys(next.records)])) {
    const before = byId(prev.records[model]);
    const after = byId(next.records[model]);
    const changed = [...after.values()].filter((r) => before.get(r.id) !== r);
    const removed = [...before.keys()].filter((id) => !after.has(id));
    if (changed.length) upserts[model] = changed;
    if (removed.length) deletes[model] = removed;
  }
  const prevMsg = new Set(prev.messages.map((m) => m.id));
  const nextMsg = new Set(next.messages.map((m) => m.id));
  return {
    upserts,
    deletes,
    messages: next.messages.filter((m) => !prevMsg.has(m.id)),
    removedMessages: [...prevMsg].filter((id) => !nextMsg.has(id)),
    seq: next.seq,
    settings: prev.settings === next.settings ? null : next.settings,
  };
}

export const isEmptyDiff = (d) =>
  !Object.keys(d.upserts).length && !Object.keys(d.deletes).length && !d.messages.length && !d.removedMessages.length && !d.settings;

const ALWAYS = new Set(['id', 'active']);

/** Keep only declared fields (drops junk and prototype-polluting keys from untrusted input). */
function clean(model, rec) {
  const fields = models[model].fields;
  return Object.fromEntries(Object.entries(rec).filter(([k]) => ALWAYS.has(k) || (fields[k] && !fields[k].compute)));
}

/** Apply an untrusted diff to the authoritative db. Throws on invalid input. */
export function applyDiff(db, d, { author, isAdmin = true } = {}) {
  if (!d || typeof d !== 'object') throw new Error('Invalid change set');
  installCustomFields(db.settings?.customFields);
  let records = { ...db.records };
  for (const [model, recs] of Object.entries(d.upserts ?? {})) {
    if (!models[model] || !Array.isArray(recs)) throw new Error(`Unknown model ${model}`);
    const current = byId(records[model]);
    for (const raw of recs) {
      if (!raw || !Number.isInteger(raw.id) || raw.id < 1) throw new Error(`Invalid ${model} record`);
      const rec = clean(model, raw);
      const err = validate(model, rec);
      if (err) throw new Error(err);
      current.set(rec.id, rec);
    }
    records = { ...records, [model]: [...current.values()].sort((a, b) => a.id - b.id) };
  }
  for (const [model, ids] of Object.entries(d.deletes ?? {})) {
    if (!models[model] || !Array.isArray(ids)) throw new Error(`Unknown model ${model}`);
    const drop = new Set(ids);
    records = { ...records, [model]: (records[model] ?? []).filter((r) => !drop.has(r.id)) };
  }
  const seq = { ...db.seq };
  for (const [model, n] of Object.entries(d.seq ?? {})) {
    if (models[model] && Number.isInteger(n)) seq[model] = Math.max(seq[model] ?? 0, n, ...(records[model] ?? []).map((r) => r.id));
  }
  const known = new Set(db.messages.map((m) => m.id));
  const removed = new Set(Array.isArray(d.removedMessages) ? d.removedMessages : []);
  const incoming = (Array.isArray(d.messages) ? d.messages : [])
    .filter((m) => m && typeof m.id === 'string' && models[m.model] && !known.has(m.id))
    .map((m) => ({ id: m.id, model: m.model, res_id: m.res_id, body: String(m.body).slice(0, 10000), kind: m.kind === 'note' ? 'note' : 'tracking', author: author ?? m.author, date: m.date }));
  // Company, installed apps and Studio fields are admin-only; any user may save favorites.
  const s = d.settings && typeof d.settings === 'object' ? d.settings : null;
  const settings = !s ? db.settings : {
    ...db.settings,
    favorites: s.favorites ?? db.settings.favorites,
    ...(isAdmin ? {
      company: String(s.company ?? db.settings.company).slice(0, 200),
      uninstalled: Array.isArray(s.uninstalled) ? s.uninstalled.filter((x) => typeof x === 'string').slice(0, 200) : db.settings.uninstalled,
      customFields: Array.isArray(s.customFields) ? s.customFields.map(cleanCustomField).filter(Boolean).slice(0, 500) : db.settings.customFields,
    } : {}),
  };
  installCustomFields(settings.customFields);
  return { ...db, records, seq, settings, messages: [...db.messages.filter((m) => !removed.has(m.id)), ...incoming] };
}
