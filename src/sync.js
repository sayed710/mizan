// Record-level diff between two db snapshots, applied server-side so concurrent edits
// to different records don't overwrite each other.
import { models } from './models/index.js';
import { validate } from './orm.js';
import { cleanCustomField, installCustomFields } from './models/studio.js';
import { cleanFavorites, cleanMessage, cleanRecord } from './validate.js';

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

const MAX_DB_CHARS = 200 * 1024 * 1024; // ponytail: whole-db size cap for the single JSON blob; move to per-model tables beyond this

/** Apply an untrusted diff to the authoritative db. Throws on invalid input. */
export function applyDiff(db, d, { author, isAdmin = true, allowed = null } = {}) {
  if (!d || typeof d !== 'object') throw new Error('Invalid change set');
  const check = (model) => {
    if (!models[model]) throw new Error(`Unknown model ${model}`);
    if (allowed && !allowed.has(model)) throw new Error(`No access to ${model}`);
  };
  installCustomFields(db.settings?.customFields);
  let records = { ...db.records };
  for (const [model, recs] of Object.entries(d.upserts ?? {})) {
    check(model);
    if (!Array.isArray(recs)) throw new Error(`Invalid ${model} records`);
    const current = byId(records[model]);
    for (const raw of recs) {
      if (!raw || !Number.isInteger(raw.id) || raw.id < 1) throw new Error(`Invalid ${model} record`);
      const rec = cleanRecord(model, raw);
      const err = validate(model, rec) ?? models[model].guard?.(db, current.get(rec.id) ?? null, rec);
      if (err) throw new Error(err);
      current.set(rec.id, rec);
    }
    records = { ...records, [model]: [...current.values()].sort((a, b) => a.id - b.id) };
  }
  for (const [model, ids] of Object.entries(d.deletes ?? {})) {
    check(model);
    if (!Array.isArray(ids)) throw new Error(`Invalid ${model} ids`);
    const drop = new Set(ids);
    const blocked = (records[model] ?? []).filter((r) => drop.has(r.id)).map((r) => models[model].protectDelete?.(db, r)).find(Boolean);
    if (blocked) throw new Error(blocked);
    records = { ...records, [model]: (records[model] ?? []).filter((r) => !drop.has(r.id)) };
  }
  const seq = { ...db.seq };
  for (const [model, n] of Object.entries(d.seq ?? {})) {
    if (models[model] && Number.isInteger(n)) seq[model] = Math.max(seq[model] ?? 0, n, ...(records[model] ?? []).map((r) => r.id));
  }
  const known = new Set(db.messages.map((m) => m.id));
  const kept = new Set(db.messages.filter((m) => models[m.model]?.audited?.(db)).map((m) => m.id));
  const removed = new Set((Array.isArray(d.removedMessages) ? d.removedMessages : []).filter((id) => !kept.has(id)));
  const incoming = (Array.isArray(d.messages) ? d.messages : [])
    .map(cleanMessage)
    .filter((m) => m && !known.has(m.id) && (!allowed || allowed.has(m.model)))
    .map((m) => ({ ...m, author: author ?? m.author }));
  // Company, installed apps and Studio fields are admin-only; any user may save favorites.
  const s = d.settings && typeof d.settings === 'object' ? d.settings : null;
  const settings = !s ? db.settings : {
    ...db.settings,
    favorites: s.favorites === undefined ? db.settings.favorites : cleanFavorites(s.favorites, db.settings.favorites),
    ...(isAdmin ? {
      company: String(s.company ?? db.settings.company).slice(0, 200),
      currency: /^[A-Z]{3}$/.test(s.currency ?? '') ? s.currency : db.settings.currency,
      companies: Array.isArray(s.companies)
        ? s.companies.filter((c) => c && Number.isInteger(c.id) && c.id > 0 && typeof c.name === 'string').slice(0, 20)
          .map((c) => ({ id: c.id, name: c.name.slice(0, 200), currency: /^[A-Z]{3}$/.test(c.currency ?? '') ? c.currency : 'USD' }))
        : db.settings.companies,
      lock_date: s.lock_date === null || /^d{4}-d{2}-d{2}$/.test(s.lock_date ?? '') ? s.lock_date : db.settings.lock_date,
      audit_trail: db.settings.audit_trail === true || s.audit_trail === true,
      uninstalled: Array.isArray(s.uninstalled) ? s.uninstalled.filter((x) => typeof x === 'string').slice(0, 200) : db.settings.uninstalled,
      customFields: Array.isArray(s.customFields) ? s.customFields.map(cleanCustomField).filter(Boolean).slice(0, 500) : db.settings.customFields,
    } : {}),
  };
  installCustomFields(settings.customFields);
  const next = { ...db, records, seq, settings, messages: [...db.messages.filter((m) => !removed.has(m.id)), ...incoming] };
  if (JSON.stringify(next).length > MAX_DB_CHARS) throw new Error('Database size limit reached');
  return next;
}
