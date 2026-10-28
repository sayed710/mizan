// Versioned data migrations. The database records the last version applied (`schema_version`), so each migration
// runs once per database and its result is saved like any other change. Append new steps; never edit old ones.
import { models } from './models/index.js';
import { create, search, write } from './orm.js';
import { migrateAppointments } from './models/appointments.js';
import { migrateDocumentTags } from './models/signplus.js';
import { migrateWorkorderTimes } from './models/workorder.js';
import { ensureQuants } from './models/quant.js';
import { migrateTimeOff } from './models/timeoff.js';
import { journalId } from './models/ledger.js';

/** Preserve old tender names and amounts while assigning stable method records. */
export function migratePosMethods(db) {
  let next = db;
  const companies = new Set([1, ...(db.records['res.company'] ?? []).map((c) => c.id), ...(db.records['pos.config'] ?? []).map((c) => c.company_id ?? 1)]);

  for (const company_id of companies) {
    for (const [name, type, journal] of [['Cash', 'cash', 'CSH1'], ['Card', 'bank', 'BNK1']]) {
      if (!(next.records['pos.payment.method'] ?? []).some((m) => (m.company_id ?? 1) === company_id && m.type === type && m.name === name)) {
        next = create(next, 'pos.payment.method', { name, type, company_id, journal_id: journalId(next, journal), config_ids: [] }).db;
      }
    }
  }

  for (const c of (next.records['pos.config'] ?? [])) {
    const compId = c.company_id ?? 1;
    for (const p of (c.payment_method_ids ?? [])) {
      if (typeof p === 'object' && p !== null) {
        const name = p.name || (p.journal === 'cash' ? 'Cash' : 'Card');
        const type = p.type || (p.journal === 'cash' ? 'cash' : 'bank');
        const journal = journalId(next, p.journal === 'cash' ? 'CSH1' : 'BNK1');
        let existing = (next.records['pos.payment.method'] ?? []).find((m) => (m.company_id ?? 1) === compId && m.name === name && m.type === type);
        if (!existing) {
          const res = create(next, 'pos.payment.method', { name, type, company_id: compId, journal_id: journal, config_ids: [c.id] });
          next = res.db;
        } else if (!existing.config_ids?.includes(c.id)) {
          next = write(next, 'pos.payment.method', existing.id, { config_ids: [...(existing.config_ids ?? []), c.id] });
        }
      }
    }
  }

  for (const c of (next.records['pos.config'] ?? [])) {
    const compId = c.company_id ?? 1;
    for (const type of ['cash', 'bank']) {
      const defMethod = (next.records['pos.payment.method'] ?? []).find((m) => (m.company_id ?? 1) === compId && m.type === type);
      if (defMethod && !defMethod.config_ids?.includes(c.id)) {
        next = write(next, 'pos.payment.method', defMethod.id, { config_ids: [...(defMethod.config_ids ?? []), c.id] });
      }
    }
  }

  const method = (company, typeOrName) => (next.records['pos.payment.method'] ?? []).find((m) => (m.company_id ?? 1) === company && (m.name === typeOrName || m.type === (typeOrName === 'cash' ? 'cash' : 'bank')))?.id;

  const configs = (next.records['pos.config'] ?? []).map((c) => {
    const compId = c.company_id ?? 1;
    return {
      ...c,
      payment_method_ids: (c.payment_method_ids ?? []).map((p) => (typeof p === 'object' && p !== null ? { ...p, payment_method_id: p.payment_method_id ?? method(compId, p.name) ?? method(compId, p.journal) } : p)),
      available_preset_ids: c.available_preset_ids ?? [],
      cash_rounding: c.cash_rounding ?? false,
      only_round_cash_method: c.only_round_cash_method ?? false,
    };
  });

  const orders = (next.records['pos.order'] ?? []).map((o) => {
    const compId = o.company_id ?? 1;
    const defaultMethod = method(compId, o.payment_method ?? 'cash');
    return {
      ...o,
      payment_method_id: o.payment_method_id ?? defaultMethod,
      payment_ids: (o.payment_ids ?? []).map((p) => ({
        ...p,
        payment_method_id: p.payment_method_id ?? method(compId, p.method ?? p.name ?? 'cash'),
      })),
    };
  });

  return { ...next, records: { ...next.records, ...(next.records['pos.config'] ? { 'pos.config': configs } : {}), ...(next.records['pos.order'] ? { 'pos.order': orders } : {}) } };
}

/** Tag lists stored as names (['Tax']) become lines pointing at documents.tag records, creating missing tags. */
function documentTagLines(db) {
  let next = db;
  const tagId = (name) => {
    const found = search(next, 'documents.tag').find((t) => t.name === name);
    if (found) return found.id;
    const made = create(next, 'documents.tag', { name });
    next = made.db;
    return made.id;
  };
  for (const [model, def] of Object.entries(models)) {
    const keys = Object.entries(def.fields ?? {})
      .filter(([, f]) => f.type === 'one2many' && f.fields?.tag_id?.relation === 'documents.tag').map(([k]) => k);
    const recs = next.records[model];
    if (!keys.length || !recs?.some((r) => keys.some((k) => r[k]?.some?.((x) => typeof x === 'string')))) continue;
    const records = recs.map((r) => {
      const fixed = Object.fromEntries(keys.filter((k) => Array.isArray(r[k]) && r[k].some((x) => typeof x === 'string'))
        .map((k) => [k, r[k].map((x) => (typeof x === 'string' ? { tag_id: tagId(x) } : x))]));
      return Object.keys(fixed).length ? { ...r, ...fixed } : r;
    });
    next = { ...next, records: { ...next.records, [model]: records } };
  }
  return next;
}

export const MIGRATIONS = [
  { version: 1, name: 'Appointments: minutes, staff lines, start/end', up: migrateAppointments },
  { version: 2, name: 'Documents: tag names to documents.tag lines', up: (db) => documentTagLines(migrateDocumentTags(db)) },
  { version: 3, name: 'Work orders: date-only times to datetimes', up: migrateWorkorderTimes },
  { version: 4, name: 'Stock: initialize located quants from done transfers and opening stock', up: ensureQuants },
  { version: 5, name: 'Time off: request units and leave types', up: migrateTimeOff },
  { version: 6, name: 'POS: migrate payment methods', up: migratePosMethods },
];
export const SCHEMA_VERSION = MIGRATIONS.at(-1).version;

/** Bring a database up to SCHEMA_VERSION. Returns the same object when nothing ran. */
export function migrate(db) {
  if (!db?.records) return db;
  const from = db.schema_version ?? 0;
  if (from > SCHEMA_VERSION) throw new Error(`Database schema ${from} is newer than this version of Mizan (${SCHEMA_VERSION})`);
  const pending = MIGRATIONS.filter((m) => m.version > from);
  if (!pending.length) return db;
  return { ...pending.reduce((acc, m) => m.up(acc), db), schema_version: SCHEMA_VERSION };
}
