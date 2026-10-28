// Record-level diff between two db snapshots, applied server-side so concurrent edits
// to different records don't overwrite each other.
import { models } from './models/index.js';
import { validate } from './orm.js';
import { cleanCustomField, installCustomFields } from './models/studio.js';
import { cleanFavorites, cleanMessage, cleanRecord } from './validate.js';
import { setCompanies } from './models/company.js';
import { authorityDeleteRules, authorityRules } from './models/authority.js';

const byId = (list = []) => new Map(list.map((r) => [r.id, r]));
const same = (v) => JSON.stringify(v ?? null);

/** Fields the server keeps (computed and undeclared ones are dropped, so they never conflict). */
const persisted = (model, k) => k === 'active' || k === 'company_id' || Boolean(models[model]?.fields[k] && !models[model].fields[k].compute);

/** Thrown when an edit was made on top of a value someone else has changed since. */
export class ConflictError extends Error {
  conflict = true;
}
/** A submitted lock date if it is a date or null (cleared), else the current one. */
const isRealDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v ?? '') && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
const lockValue = (value, current) => (value === null || isRealDate(value) ? value ?? null : current ?? null);

/**
 * `bases` holds, for each edited record, the values its changed fields had before the edit, so the server can
 * keep other users' changes to other fields and refuse an edit made on top of an outdated value.
 * @returns {{upserts: Record<string, object[]>, deletes: Record<string, number[]>, bases: Record<string, Record<number, object>>, messages: object[], removedMessages: string[], seq: object, settings: object}} */
export function diffDb(prev, next) {
  const upserts = {};
  const deletes = {};
  const bases = {};
  const created = {};
  for (const model of new Set([...Object.keys(prev.records), ...Object.keys(next.records)])) {
    const before = byId(prev.records[model]);
    const after = byId(next.records[model]);
    const changed = [...after.values()].filter((r) => before.get(r.id) !== r);
    const removed = [...before.keys()].filter((id) => !after.has(id));
    const added = changed.filter((r) => !before.has(r.id)).map((r) => r.id);
    if (changed.length) upserts[model] = changed;
    if (added.length) created[model] = added;
    for (const r of changed) {
      const b = before.get(r.id);
      if (!b) continue;
      const fields = [...new Set([...Object.keys(b), ...Object.keys(r)])].filter((k) => persisted(model, k) && same(b[k]) !== same(r[k]));
      (bases[model] ??= {})[r.id] = Object.fromEntries(fields.map((k) => [k, b[k] ?? null]));
    }
    if (removed.length) deletes[model] = removed;
  }
  const prevMsg = new Set(prev.messages.map((m) => m.id));
  const nextMsg = new Set(next.messages.map((m) => m.id));
  return {
    upserts,
    deletes,
    created,
    bases,
    messages: next.messages.filter((m) => !prevMsg.has(m.id)),
    removedMessages: [...prevMsg].filter((id) => !nextMsg.has(id)),
    seq: next.seq,
    settings: prev.settings === next.settings ? null : next.settings,
  };
}

export const isEmptyDiff = (d) =>
  !Object.keys(d.upserts).length && !Object.keys(d.deletes).length && !d.messages.length && !d.removedMessages.length && !d.settings;

/** A new id this far out is always refused on a fresh database (kept for callers and tests). */
export const MAX_ID = 2 ** 40;
/** How far past a model's counter a client may pick a new id (queued offline creates), so one record can't burn the id space. */
export const ID_WINDOW = 1_000_000;
/**
 * Apply only the fields an edit changed onto the stored record, refusing it when one of them no longer has the value
 * the edit started from. Without a base (a new record, or an older client) the record is taken as sent.
 */
function merge(model, stored, raw, base) {
  if (!base || typeof base !== 'object' || Array.isArray(base)) return raw;
  const label = models[model].label ?? model;
  if (!stored) throw new ConflictError(`${label} #${raw.id} was deleted by someone else; reload and try again`);
  const stale = Object.keys(base).find((k) => same(stored[k]) !== same(base[k]));
  if (stale) throw new ConflictError(`${label} #${raw.id} was changed by someone else (${stale}); your edit was not saved, reload and try again`);
  const out = { ...stored };
  for (const k of Object.keys(base)) {
    if (k in raw) out[k] = raw[k];
    else delete out[k];
  }
  return out;
}


/** Highest id in a list of records, without spreading the list into Math.max (argument limits on large models). */
export const maxId = (recs = []) => { let top = 0; for (const r of recs) if (r.id > top) top = r.id; return top; };

/** Reset id counters that are corrupt, behind the stored records, or absurdly far past them (e.g. poisoned by an old client). */
export function repairSeq(db) {
  if (!db) return db;
  let changed = false;
  const seq = { ...db.seq };
  for (const [model, n] of Object.entries(seq)) {
    const top = maxId(db.records[model]);
    if (!Number.isSafeInteger(n) || n < top || n > top + ID_WINDOW) { seq[model] = top; changed = true; }
  }
  return changed ? { ...db, seq } : db;
}

/** Point many2one, line and res_model/res_id references in a record at remapped ids. */
function remapRefs(model, rec, remapped) {
  const to = (relation, v) => (Number.isInteger(v) && remapped[relation]?.[v]) || v;
  const out = { ...rec };
  for (const [key, f] of Object.entries(models[model]?.fields ?? {})) {
    if (!(key in out)) continue;
    if (f.type === 'many2one' && f.relation) out[key] = to(f.relation, out[key]);
    else if (f.type === 'one2many' && Array.isArray(out[key])) {
      out[key] = out[key].map((line) => {
        if (f.relation && !f.fields) return to(f.relation, line);
        if (!line || typeof line !== 'object') return line;
        const target = (s) => (s.type === 'many2one' ? s.relation : s.ref);
        const subs = Object.entries(f.fields ?? {}).filter(([k, s]) => target(s) && k in line);
        return subs.length ? { ...line, ...Object.fromEntries(subs.map(([k, s]) => [k, to(target(s), line[k])])) } : line;
      });
    }
  }
  if (typeof out.res_model === 'string') out.res_id = to(out.res_model, out.res_id);
  return out;
}

/**
 * The server owns record ids: a record the client marks as created, or one the store does not hold yet, gets the
 * next free id for its model, so two users creating from the same snapshot cannot overwrite each
 * other. References inside the same change set follow the new ids.
 * @returns {{ diff: object, remapped: Record<string, Record<number, number>> }}
 */
export function assignIds(db, d) {
  if (!d || typeof d !== 'object' || !d.upserts || typeof d.upserts !== 'object') return { diff: d, remapped: {} };
  const remapped = {};
  for (const [model, recs] of Object.entries(d.upserts)) {
    if (!models[model] || !Array.isArray(recs)) continue;
    const stored = new Set((db.records[model] ?? []).map((r) => r.id));
    const flagged = new Set(Array.isArray(d.created?.[model]) ? d.created[model] : []);
    const fresh = [...new Set(recs.filter((r) => Number.isSafeInteger(r?.id) && r.id > 0 && (flagged.has(r.id) || (!stored.has(r.id) && !d.bases?.[model]?.[r.id]))).map((r) => r.id))].sort((a, b) => a - b);
    let next = db.seq?.[model] ?? 0;
    for (const id of stored) if (id > next) next = id;
    for (const id of fresh) {
      next += 1;
      if (next !== id) (remapped[model] ??= {})[id] = next;
    }
  }
  return { diff: remapDiff(d, remapped), remapped };
}

/** Rewrite a change set's record ids and references through `remapped` ({ model: { oldId: newId } }). */
export function remapDiff(d, remapped) {
  if (!d || typeof d !== 'object' || !Object.keys(remapped ?? {}).length) return d;
  const upserts = Object.fromEntries(Object.entries(d.upserts ?? {}).map(([model, recs]) => [model, !Array.isArray(recs) ? recs
    : recs.map((r) => (r && typeof r === 'object' ? remapRefs(model, { ...r, id: remapped[model]?.[r.id] ?? r.id }, remapped) : r))]));
  const deletes = Object.fromEntries(Object.entries(d.deletes ?? {}).map(([model, ids]) => [model,
    Array.isArray(ids) ? ids.map((id) => remapped[model]?.[id] ?? id) : ids]));
  const messages = Array.isArray(d.messages)
    ? d.messages.map((m) => (m && remapped[m.model]?.[m.res_id] ? { ...m, res_id: remapped[m.model][m.res_id] } : m)) : d.messages;
  const created = Object.fromEntries(Object.entries(d.created ?? {}).map(([model, ids]) => [model,
    Array.isArray(ids) ? ids.map((id) => remapped[model]?.[id] ?? id) : ids]));
  const company = (id) => remapped['res.company']?.[id] ?? id;
  const s = d.settings;
  const settings = s && typeof s === 'object' && remapped['res.company'] ? {
    ...s,
    ...('current_company_id' in s ? { current_company_id: company(s.current_company_id) } : {}),
    ...(Array.isArray(s.allowed_company_ids) ? { allowed_company_ids: s.allowed_company_ids.map(company) } : {}),
  } : s;
  const bases = Object.fromEntries(Object.entries(d.bases ?? {}).map(([model, rows]) => [model,
    Object.fromEntries(Object.entries(rows).map(([id, base]) => [remapped[model]?.[id] ?? id, remapRefs(model, base, remapped)]))]));
  return { ...d, upserts, deletes, created, bases, messages, settings };
}

/**
 * Rewrite a change set that was queued before an earlier save came back with `remapped`. Its own new records may
 * have picked ids that the earlier remap now uses for other records; those move out of the way first, so a
 * reference to the earlier record and the queued record's own id never end up as the same number.
 */
export function rebaseDiff(d, remapped) {
  if (!d || !Object.keys(remapped ?? {}).length) return d;
  const map = Object.fromEntries(Object.entries(remapped).map(([model, m]) => [model, { ...m }]));
  for (const [model, ids] of Object.entries(d.created ?? {})) {
    const taken = new Set(Object.values(remapped[model] ?? {}));
    if (!Array.isArray(ids) || !ids.some((id) => taken.has(id))) continue;
    let free = Math.max(0, ...taken, ...ids);
    for (const id of ids) if (taken.has(id)) map[model] = { ...map[model], [id]: ++free };
  }
  return remapDiff(d, map);
}

const MAX_DB_CHARS =200 * 1024 * 1024; // ponytail: whole-db size cap for the single JSON blob; move to per-model tables beyond this

/**
 * Apply an untrusted diff to the authoritative db. Throws on invalid input. `login` is the acting user, used with
 * `author` (their name) by the approval rules in authority.js.
 */
export function applyDiff(db, d, { author, isAdmin = true, allowed = null, login = null } = {}) {
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
    const newIdLimit = Math.min(Number.MAX_SAFE_INTEGER, Math.max(db.seq?.[model] ?? 0, maxId(db.records[model])) + ID_WINDOW);
    for (const raw of recs) {
      if (!raw || !Number.isSafeInteger(raw.id) || raw.id < 1) throw new Error(`Invalid ${model} record`);
      if (!current.has(raw.id) && raw.id > newIdLimit) throw new Error(`Invalid ${model} record`);
      const rec = cleanRecord(model, merge(model, current.get(raw.id), raw, d.bases?.[model]?.[raw.id]));
      const seen = { ...db, records: { ...records, [model]: [...current.values()] } };
      const before = current.get(rec.id) ?? null;
      // Authority rules judge the stored record, not one an earlier step of this same change set already rewrote.
      const err = validate(model, rec) ?? models[model].guard?.(seen, before, rec, { isAdmin }) ?? authorityRules[model]?.(seen, (db.records[model] ?? []).find((x) => x.id === rec.id) ?? null, rec, { isAdmin, login, name: author });
      if (err) throw new Error(err);
      current.set(rec.id, rec);
    }
    records = { ...records, [model]: [...current.values()].sort((a, b) => a.id - b.id) };
  }
  for (const [model, ids] of Object.entries(d.deletes ?? {})) {
    check(model);
    if (!Array.isArray(ids)) throw new Error(`Invalid ${model} ids`);
    const drop = new Set(ids);
    // Judge deletes on the stored version too, so a diff cannot first rewrite a record into a deletable one.
    const blocked = [...(db.records[model] ?? []), ...(records[model] ?? [])].filter((r) => drop.has(r.id)).map((r) => models[model].protectDelete?.(db, r, { ...db, records })).find(Boolean);
    if (blocked) throw new Error(blocked);
    const unauthorized = (db.records[model] ?? []).filter((r) => drop.has(r.id)).map((r) => authorityDeleteRules[model]?.(db, r, { isAdmin, login, name: author })).find(Boolean);
    if (unauthorized) throw new Error(unauthorized);
    records = { ...records, [model]: (records[model] ?? []).filter((r) => !drop.has(r.id)) };
  }
  // Whole-record rules that look across models run once every change is in place.
  const final = { ...db, records };
  for (const [model, recs] of Object.entries(d.upserts ?? {})) {
    const stored = byId(db.records[model]);
    const kept = byId(records[model]);
    for (const raw of recs) {
      const rec = kept.get(raw.id);
      const err = rec && models[model].invariant?.(final, rec, stored.get(rec.id) ?? null);
      if (err) throw new Error(err);
    }
  }
  // Id counters follow the records actually stored; the client's own counters (d.seq) are ignored so they cannot be poisoned.
  const seq = { ...db.seq };
  for (const model of Object.keys(d.upserts ?? {})) seq[model] = Math.max(seq[model] ?? 0, maxId(records[model]));
  const known = new Set(db.messages.map((m) => m.id));
  const kept = new Set(db.messages.filter((m) => models[m.model]?.audited?.(db)).map((m) => m.id));
  const modelOf = new Map(db.messages.map((m) => [m.id, m.model]));
  const removed = new Set((Array.isArray(d.removedMessages) ? d.removedMessages : [])
    .filter((id) => !kept.has(id) && (!allowed || allowed.has(modelOf.get(id)))));
  const incoming = (Array.isArray(d.messages) ? d.messages : [])
    .map(cleanMessage)
    .filter((m) => m && !known.has(m.id) && (!allowed || allowed.has(m.model)))
    .map((m) => ({ ...m, author: author ?? m.author }));
  // Company details, installed apps and Studio fields are admin-only; selections and favorites are not.
  const s = d.settings && typeof d.settings === 'object' ? d.settings : null;
  const company = s && ('current_company_id' in s || 'allowed_company_ids' in s)
    ? setCompanies({ ...db, records }, { current: s.current_company_id, allowed: s.allowed_company_ids }).settings : null;
  const settings = !s ? db.settings : {
    ...db.settings,
    ...(company ? { current_company_id: company.current_company_id, allowed_company_ids: company.allowed_company_ids } : {}),
    favorites: s.favorites === undefined ? db.settings.favorites : cleanFavorites(s.favorites, db.settings.favorites),
    ...(isAdmin ? {
      company: String(s.company ?? db.settings.company).slice(0, 200),
      currency: /^[A-Z]{3}$/.test(s.currency ?? '') ? s.currency : db.settings.currency,
      companies: Array.isArray(s.companies)
        ? s.companies.filter((c) => c && Number.isInteger(c.id) && c.id > 0 && typeof c.name === 'string').slice(0, 20)
          .map((c) => ({ id: c.id, name: c.name.slice(0, 200), currency: /^[A-Z]{3}$/.test(c.currency ?? '') ? c.currency : 'USD' }))
        : db.settings.companies,
      lock_date: lockValue(s.lock_date, db.settings.lock_date),
      sale_lock_date: lockValue(s.sale_lock_date, db.settings.sale_lock_date),
      purchase_lock_date: lockValue(s.purchase_lock_date, db.settings.purchase_lock_date),
      // The hard lock only ever moves forward.
      hard_lock_date: [lockValue(s.hard_lock_date, db.settings.hard_lock_date), db.settings.hard_lock_date].filter(Boolean).sort().at(-1) ?? null,
      audit_trail: db.settings.audit_trail === true || s.audit_trail === true,
      invoice_qr: [null, 'zatca', 'epc'].includes(s.invoice_qr ?? null) ? s.invoice_qr ?? null : db.settings.invoice_qr,
      company_vat: String(s.company_vat ?? db.settings.company_vat ?? '').slice(0, 40),
      company_iban: String(s.company_iban ?? db.settings.company_iban ?? '').slice(0, 40),
      uninstalled: Array.isArray(s.uninstalled) ? s.uninstalled.filter((x) => typeof x === 'string').slice(0, 200) : db.settings.uninstalled,
      customFields: Array.isArray(s.customFields) ? s.customFields.map(cleanCustomField).filter(Boolean).slice(0, 500) : db.settings.customFields,
    } : {}),
  };
  installCustomFields(settings.customFields);
  const next = { ...db, records, seq, settings, messages: [...db.messages.filter((m) => !removed.has(m.id)), ...incoming] };
  if (JSON.stringify(next).length > MAX_DB_CHARS) throw new Error('Database size limit reached');
  return next;
}
