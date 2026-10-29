// Versioned data migrations. The database records the last version applied (`schema_version`), so each migration
// runs once per database and its result is saved like any other change. Append new steps; never edit old ones.
import { models } from './models/index.js';
import { create, search } from './orm.js';
import { migrateAppointments } from './models/appointments.js';
import { migrateDocumentTags } from './models/signplus.js';
import { migrateWorkorderTimes } from './models/workorder.js';
import { ensureQuants } from './models/quant.js';
import { migrateTimeOff } from './models/timeoff.js';
import { sanitizeAccountNumber } from './models/partnerbank.js';

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

/** Free-text bank_account on partners becomes res.partner.bank records. */
export function migratePartnerBankAccounts(db) {
  if (!db?.records) return db;
  const partners = db.records['res.partner'] ?? [];
  const existingBanks = db.records['res.partner.bank'] ?? [];
  const banks = [...existingBanks];
  let maxId = Math.max(0, db.seq?.['res.partner.bank'] ?? 0, ...banks.map((b) => b.id ?? 0));

  const updatedPartners = partners.map((p) => {
    if (!p.bank_account || !sanitizeAccountNumber(p.bank_account)) return p;
    const { bank_account, ...rest } = p;
    const sanitized = sanitizeAccountNumber(bank_account);
    const existingIndex = banks.findIndex((b) => b.partner_id === p.id && (b.sanitized_account_number === sanitized || sanitizeAccountNumber(b.account_number) === sanitized));
    if (existingIndex >= 0) {
      const existing = banks[existingIndex];
      if (existing.account_number !== bank_account) {
        banks[existingIndex] = { ...existing, legacy_account_numbers: [...new Set([...(existing.legacy_account_numbers ?? []), bank_account])] };
      }
    } else {
      maxId += 1;
      banks.push({
        id: maxId,
        partner_id: p.id,
        account_number: bank_account,
        sanitized_account_number: sanitized,
        allow_out_payment: true,
        active: true,
      });
    }
    return rest;
  });

  const nextSeq = Math.max(db.seq?.['res.partner.bank'] ?? 0, maxId);

  return {
    ...db,
    records: {
      ...db.records,
      'res.partner': updatedPartners,
      'res.partner.bank': banks,
    },
    seq: {
      ...(db.seq ?? {}),
      'res.partner.bank': nextSeq,
    },
  };
}

export const MIGRATIONS = [
  { version: 1, name: 'Appointments: minutes, staff lines, start/end', up: migrateAppointments },
  { version: 2, name: 'Documents: tag names to documents.tag lines', up: (db) => documentTagLines(migrateDocumentTags(db)) },
  { version: 3, name: 'Work orders: date-only times to datetimes', up: migrateWorkorderTimes },
  { version: 4, name: 'Stock: initialize located quants from done transfers and opening stock', up: ensureQuants },
  { version: 5, name: 'Time off: request units and leave types', up: migrateTimeOff },
  { version: 6, name: 'Partners: migrate free-text bank accounts to res.partner.bank', up: migratePartnerBankAccounts },
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
