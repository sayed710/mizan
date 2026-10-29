// @ts-check
// Record-level diff between two db snapshots, applied server-side so concurrent edits
// to different records don't overwrite each other.
import { models } from './registry.js';
import { postTracking, referenceTo, validate } from './orm.js';
import { cleanCustomField, installCustomFields } from './models/studio.js';
import { cleanFavorites, cleanMessage, cleanRecord } from './validate.js';
import { setCompanies, visibleTo } from './models/company.js';
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
 * @returns {{upserts: Record<string, object[]>, deletes: Record<string, number[]>, created: Record<string, number[]>, bases: Record<string, Record<number, object>>, messages: object[], removedMessages: string[], seq: object, settings: object}} */
export function diffDb(prev, next) {
  /** @type {Record<string, object[]>} */
  const upserts = {};
  /** @type {Record<string, number[]>} */
  const deletes = {};
  /** @type {Record<string, Record<number, object>>} */
  const bases = {};
  /** @type {Record<string, number[]>} */
  const created = {};
  for (const model of new Set([...Object.keys(prev.records), ...Object.keys(next.records)])) {
    // Untouched models keep the same array, so a save costs what changed rather than the whole database.
    if (prev.records[model] === next.records[model]) continue;
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

/**
 * The first many2one (top level or in lines) of an upserted record that points at a missing record, as an error
 * message, or null. Only values that differ from the stored record are checked, so old data never blocks an edit.
 */
function danglingLink(records, upserts, stored) {
  const ids = new Map();
  const exists = (model, id) => {
    if (!models[model]) return true;
    if (!ids.has(model)) ids.set(model, new Set((records[model] ?? []).map((r) => r.id)));
    return ids.get(model).has(id);
  };
  const before = (model, id) => (stored[model] ?? []).find((r) => r.id === id);
  for (const [model, recs] of Object.entries(upserts)) {
    const fields = models[model]?.fields ?? {};
    for (const raw of Array.isArray(recs) ? recs : []) {
      const old = before(model, raw?.id);
      for (const [key, f] of Object.entries(fields)) {
        const value = raw?.[key];
        if (f.compute || value == null || value === '' || JSON.stringify(value) === JSON.stringify(old?.[key])) continue;
        if (f.type === 'many2one' && !exists(f.relation, value)) return `${f.label}: ${models[f.relation].label} #${value} does not exist`;
        if (f.type !== 'one2many' || !Array.isArray(value) || !f.fields) continue;
        // Lines have no ids: a link is unchanged only if some stored line holds the same value in the same field.
        const known = new Set((old?.[key] ?? []).flatMap((l) => Object.entries(l ?? {}).map(([k, v]) => `${k}:${v}`)));
        for (const line of value) {
          for (const [sub, sf] of Object.entries(f.fields)) {
            const v = line?.[sub];
            if (sf.type === 'many2one' && v != null && v !== '' && !known.has(`${sub}:${v}`) && !exists(sf.relation, v)) return `${f.label} › ${sf.label}: ${models[sf.relation].label} #${v} does not exist`;
          }
        }
      }
    }
  }
  return null;
}

export const isEmptyDiff = (d) =>
  !Object.keys(d.upserts).length && !Object.keys(d.deletes).length && !d.messages.length && !d.removedMessages.length && !d.settings;

/** A new id this far out is always refused on a fresh database (kept for callers and tests). */
export const MAX_ID = 2 ** 40;
/** How far past a model's counter a client may pick a new id (queued offline creates), so one record can't burn the id space. */
export const ID_WINDOW = 1_000_000;
/**
 * Apply only the fields an edit changed onto the stored record, refusing it when one of them no longer has the value
 * the edit started from. Without a base the record is taken as sent, preserving omitted fields on locked records.
 */
function merge(model, stored, raw, base) {
  if (!base || typeof base !== 'object' || Array.isArray(base)) {
    // Legacy partial updates must not erase the state or content of a locked record.
    return stored && models[model].form?.lockedWhen?.(stored) ? { ...stored, ...raw } : raw;
  }
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
/** Models whose `name` is a legal document number from `nextName`. */
const SEQUENCED = ['account.move', 'account.payment', 'account.batch.payment', 'pos.session', 'stock.inventory.count', 'stock.picking.batch'];
const SEQUENCE_NAME = /^(.*\D)(\d+)$/;
// Serialized size per db snapshot, measured once and then carried forward by what each diff adds or removes.
const sizes = new WeakMap();
const json = (v) => (v === undefined ? 0 : JSON.stringify(v).length);
export const dbSize = (db) => {
  if (!sizes.has(db)) sizes.set(db, json(db));
  return sizes.get(db);
};

/** Highest number ever seen per model and prefix: the stored mark, raised by the records now in `records`. */
function highWater(numbering = {}, records) {
  const out = {};
  for (const model of SEQUENCED) {
    const marks = { ...numbering[model] };
    for (const r of records[model] ?? []) {
      const m = SEQUENCE_NAME.exec(r.name ?? '');
      if (m && Number.isSafeInteger(Number(m[2]))) marks[m[1]] = Math.max(marks[m[1]] ?? 0, Number(m[2]));
    }
    if (Object.keys(marks).length) out[model] = marks;
  }
  return out;
}

/**
 * Two browsers numbering from the same snapshot pick the same next number. Keep the stored record's number and give
 * an incoming record that collides with another one the next free number of its sequence.
 */
function uniqueNumbers(records, upserts = {}, stored = {}, marks = {}) {
  let out = records;
  const renamed = [];
  for (const model of SEQUENCED.filter((m) => Array.isArray(upserts[m]))) {
    const list = [...out[model] ?? []];
    const was = new Map((stored[model] ?? []).map((r) => [r.id, r.name]));
    // Only numbers this change set hands out can move; a record keeps the number it already had.
    const incoming = new Set(upserts[model].map((r) => r?.id).filter((id) => was.get(id) !== list.find((x) => x.id === id)?.name));
    const owner = new Map();
    // Records keeping their number claim it first.
    for (const r of [...list.filter((r) => !incoming.has(r.id)), ...list.filter((r) => incoming.has(r.id))]) {
      const m = SEQUENCE_NAME.exec(r.name ?? '');
      if (!m || !owner.has(r.name) || !incoming.has(r.id)) {
        if (!owner.has(r.name)) owner.set(r.name, r.id);
        continue;
      }
      const [, prefix, digits] = m;
      const top = Math.max(0, marks[model]?.[prefix] ?? 0, ...list.filter((x) => x.name?.startsWith(prefix)).map((x) => Number(x.name.slice(prefix.length))).filter(Number.isSafeInteger));
      const name = prefix + String(top + 1).padStart(digits.length, '0');
      const i = list.findIndex((x) => x.id === r.id);
      // Lines booked under the provisional number carry the final one.
      const renameLines = (ls) => (Array.isArray(ls) ? ls.map((l) => (l?.name === r.name ? { ...l, name } : l)) : ls);
      list[i] = { ...r, name, ...(r.line_ids ? { line_ids: renameLines(r.line_ids) } : {}) };
      renamed.push([model, r.id, r.name, name]);
      owner.set(name, r.id);
    }
    out = { ...out, [model]: list };
  }
  return { records: out, renamed };
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
        const distribution = line.analytic_distribution;
        const analytic = distribution && typeof distribution === 'object' && !Array.isArray(distribution)
          ? { analytic_distribution: Object.fromEntries(Object.entries(distribution).map(([id, share]) => [to('account.analytic.account', Number(id)), share])) }
          : null;
        return subs.length || analytic ? { ...line, ...Object.fromEntries(subs.map(([k, s]) => [k, to(target(s), line[k])])), ...analytic } : line;
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
  if (!d || typeof d !== 'object' || !d.upserts || typeof d.upserts !== 'object') return { diff: d, remapped: /** @type {Record<string, Record<number, number>>} */ ({}) };
  /** @type {Record<string, Record<number, number>>} */
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
 * @param {object} db
 * @param {any} d
 * @param {{ author?: string, isAdmin?: boolean, allowed?: Set<string> | null, login?: string | null, companies?: any, readOnly?: Set<string> | null }} [options]
 */
export function applyDiff(db, d, { author, isAdmin = false, allowed = null, login = null, companies = null, readOnly = null, taxClosingProofs = [] } = {}) {
  isAdmin = isAdmin === true;
  if (!d || typeof d !== 'object') throw new Error('Invalid change set');
  const companyError = (model, ...recs) => (recs.some((r) => r && !visibleTo(companies, model, r, db)) ? `No access to this company's ${model} records` : null);
  const storedRecord = (model, id) => (db.records[model] ?? []).find((r) => r.id === id);
  const check = (model) => {
    if (!models[model]) throw new Error(`Unknown model ${model}`);
    if (allowed && !allowed.has(model)) throw new Error(`No access to ${model}`);
    if (readOnly?.has(model)) throw new Error(`Only Accounting users can change ${models[model].label}`);
  };
  installCustomFields(db.settings?.customFields);
  // Apply every upsert first, then validate each record against the complete result: a change spanning models
  // (an expense and the report it joins) must not be judged against a half-applied diff.
  let records = { ...db.records };
  let growth = 0;
  /** @type {[string, any][]} */
  const changed = [];
  // Models that point at other records (guardLast) are validated after those records of the same change set.
  const upserts = Object.entries(d.upserts ?? {}).sort(([a], [b]) => (models[a]?.guardLast ? 1 : 0) - (models[b]?.guardLast ? 1 : 0));
  for (const [model, recs] of upserts) {
    check(model);
    if (!Array.isArray(recs)) throw new Error(`Invalid ${model} records`);
    const current = byId(records[model]);
    const newIdLimit = Math.min(Number.MAX_SAFE_INTEGER, Math.max(db.seq?.[model] ?? 0, maxId(db.records[model])) + ID_WINDOW);
    if (!(model in records)) growth += json(model) + 4;
    const list = [...current.values()];
    const position = new Map(list.map((r, i) => [r.id, i]));
    const sent = new Set();
    for (const raw of recs) {
      if (sent.has(raw?.id)) throw new Error(`${model} #${raw.id} appears twice in one change set`);
      sent.add(raw?.id);
      if (!raw || !Number.isSafeInteger(raw.id) || raw.id < 1) throw new Error(`Invalid ${model} record`);
      if (!current.has(raw.id) && raw.id > newIdLimit) throw new Error(`Invalid ${model} record`);
      const rec = cleanRecord(model, merge(model, current.get(raw.id), raw, d.bases?.[model]?.[raw.id]));
      const denied = companyError(model, rec, current.get(rec.id), storedRecord(model, rec.id));
      if (denied) throw new Error(denied);
      const old = current.get(rec.id);
      growth += json(rec) - json(old) + (old ? 0 : 1);
      current.set(rec.id, rec);
      if (position.has(rec.id)) list[position.get(rec.id)] = rec;
      else position.set(rec.id, list.push(rec) - 1);
      changed.push([model, rec]);
    }
    records = { ...records, [model]: list.sort((a, b) => a.id - b.id) };
  }
  const seen = { ...db, records };
  const stored = (model, id) => (db.records[model] ?? []).find((r) => r.id === id) ?? null;
  for (const [model, rec] of changed) {
    const before = stored(model, rec.id);
    // Keep specific authorization failures ahead of the generic locked-form error.
    const err = validate(model, rec) ?? authorityRules[model]?.(seen, before, rec, { isAdmin, login, name: author })
      ?? models[model].guard?.(seen, before, rec, { isAdmin, login, name: author, companies, taxClosingProofs });
    if (err) throw new Error(err);
  }
  const marks = highWater(db.numbering, db.records);
  const numbered = uniqueNumbers(records, d.upserts, db.records, marks);
  for (const [model, id] of numbered.renamed) {
    growth += json(numbered.records[model].find((r) => r.id === id)) - json(records[model].find((r) => r.id === id));
  }
  records = numbered.records;
  for (const [model, ids] of Object.entries(d.deletes ?? {})) {
    check(model);
    if (!Array.isArray(ids)) throw new Error(`Invalid ${model} ids`);
    const drop = new Set(ids);
    // Judge deletes on the stored version too, so a diff cannot first rewrite a record into a deletable one.
    const blocked = [...(db.records[model] ?? []), ...(records[model] ?? [])].filter((r) => drop.has(r.id)).map((r) => companyError(model, r) ?? models[model].protectDelete?.(db, r, { ...db, records })).find(Boolean);
    if (blocked) throw new Error(blocked);
    const unauthorized = (db.records[model] ?? []).filter((r) => drop.has(r.id)).map((r) => authorityDeleteRules[model]?.(db, r, { isAdmin, login, name: author })).find(Boolean);
    if (unauthorized) throw new Error(unauthorized);
    growth -= (records[model] ?? []).filter((r) => drop.has(r.id)).reduce((n, r) => n + json(r) + 1, 0);
    if (model in records) records = { ...records, [model]: records[model].filter((r) => !drop.has(r.id)) };
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
  // Referential integrity, on the result: nothing may still point at a deleted record, and changed links must
  // point at records that exist.
  for (const [model, ids] of Object.entries(d.deletes ?? {})) {
    const used = referenceTo({ records }, model, ids);
    if (used) throw new Error(`Cannot delete ${models[model].label}: still used by ${used}`);
  }
  const missing = danglingLink(records, d.upserts ?? {}, db.records);
  if (missing) throw new Error(missing);
  // Id counters follow the records actually stored; the client's own counters (d.seq) are ignored so they cannot be poisoned.
  const seq = { ...db.seq };
  for (const model of Object.keys(d.upserts ?? {})) seq[model] = Math.max(seq[model] ?? 0, maxId(records[model]));
  const known = new Set(db.messages.map((m) => m.id));
  const kept = new Set(db.messages.filter((m) => models[m.model]?.audited?.(db)).map((m) => m.id));
  // A limited user may only comment on a record that exists in the result and that they can see.
  const onVisibleRecord = (m) => {
    if (!companies) return true;
    const now = (records[m.model] ?? []).find((r) => r.id === m.res_id);
    return !!now && !companyError(m.model, storedRecord(m.model, m.res_id), now);
  };
  const hiddenMessages = new Set(db.messages.filter((m) => !onVisibleRecord(m)).map((m) => m.id));
  const modelOf = new Map(db.messages.map((m) => [m.id, m.model]));
  const removed = new Set((Array.isArray(d.removedMessages) ? d.removedMessages : [])
    .filter((id) => !kept.has(id) && !hiddenMessages.has(id) && (!allowed || allowed.has(modelOf.get(id)))));
  const incoming = (Array.isArray(d.messages) ? d.messages : [])
    .map(cleanMessage)
    .filter((m) => m && !known.has(m.id) && (!allowed || allowed.has(m.model)) && onVisibleRecord(m))
    // Who and when come from the server: a client cannot backdate a chatter entry or sign it as someone else.
    .map((m) => ({ ...m, author: author ?? m.author, date: author ? new Date().toISOString() : m.date }));
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
  let next = { ...db, records, seq, settings, numbering: highWater(marks, records), messages: [...db.messages.filter((m) => !removed.has(m.id)), ...incoming] };
  // The audit trail shows the number the server finally gave, not only the one the browser proposed.
  for (const [model, id, from, to] of numbered.renamed) {
    if (models[model].audited?.(db)) next = postTracking(next, model, id, `Number: ${from} → ${to} (assigned by the server)`);
  }
  growth += next.messages.slice(db.messages.length - db.messages.filter((m) => removed.has(m.id)).length).reduce((n, m) => n + json(m) + 1, 0) - db.messages.filter((m) => removed.has(m.id)).reduce((n, m) => n + json(m) + 1, 0);
  if (settings !== db.settings) growth += json(settings) - json(db.settings);
  if (seq !== db.seq) growth += json(seq) - json(db.seq);
  growth += json(next.numbering) - json(db.numbering) + (db.numbering === undefined ? json('numbering') + 1 : 0);
  const size = dbSize(db) + growth;
  if (size > MAX_DB_CHARS) throw new Error('Database size limit reached');
  sizes.set(next, size);
  return next;
}
