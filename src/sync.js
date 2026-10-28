// Record-level diff between two db snapshots, applied server-side so concurrent edits
// to different records don't overwrite each other.
import { models } from './models/index.js';
import { postTracking, validate } from './orm.js';
import { cleanCustomField, installCustomFields } from './models/studio.js';
import { cleanFavorites, cleanMessage, cleanRecord } from './validate.js';
import { setCompanies } from './models/company.js';

const byId = (list = []) => new Map(list.map((r) => [r.id, r]));
/** A submitted lock date if it is a date or null (cleared), else the current one. */
const isRealDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v ?? '') && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
const lockValue = (value, current) => (value === null || isRealDate(value) ? value ?? null : current ?? null);

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

/** Models whose `name` is a legal document number from `nextName`. */
const SEQUENCED = ['account.move', 'account.payment', 'account.batch.payment', 'pos.session', 'stock.inventory.count', 'stock.picking.batch'];
const SEQUENCE_NAME = /^(.*\D)(\d+)$/;

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
      const seen = { ...db, records: { ...records, [model]: [...current.values()] } };
      const err = validate(model, rec) ?? models[model].guard?.(seen, current.get(rec.id) ?? null, rec, { isAdmin });
      if (err) throw new Error(err);
      current.set(rec.id, rec);
    }
    records = { ...records, [model]: [...current.values()].sort((a, b) => a.id - b.id) };
  }
  const marks = highWater(db.numbering, db.records);
  const numbered = uniqueNumbers(records, d.upserts, db.records, marks);
  records = numbered.records;
  for (const [model, ids] of Object.entries(d.deletes ?? {})) {
    check(model);
    if (!Array.isArray(ids)) throw new Error(`Invalid ${model} ids`);
    const drop = new Set(ids);
    // Judge deletes on the stored version too, so a diff cannot first rewrite a record into a deletable one.
    const blocked = [...(db.records[model] ?? []), ...(records[model] ?? [])].filter((r) => drop.has(r.id)).map((r) => models[model].protectDelete?.(db, r)).find(Boolean);
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
  if (JSON.stringify(next).length > MAX_DB_CHARS) throw new Error('Database size limit reached');
  return next;
}
