// Versioned data migrations. The database records the last version applied (`schema_version`), so each migration
// runs once per database and its result is saved like any other change. Append new steps; never edit old ones.
import { models } from './models/index.js';
import { create, search } from './orm.js';
import { migrateAppointments } from './models/appointments.js';
import { migrateDocumentTags } from './models/signplus.js';
import { migrateWorkorderTimes } from './models/workorder.js';
import { ensureQuants } from './models/quant.js';
import { migrateTimeOff } from './models/timeoff.js';
import { migrateOrderpoints } from './models/orderpoint.js';
import { migrateProductCategories } from './models/productconfig.js';

/** Tag lists stored as names (['Tax']) become lines pointing at documents.tag records, creating missing tags. */
function documentTagLines(db) {
  let next = db;
  const tagId = (name) => {
    const found = search(next, 'documents.tag', { includeArchived: true }).find((t) => t.name === name);
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
        .map((k) => [k, r[k].filter((x) => typeof x !== 'string' || x.trim()).map((x) => (typeof x === 'string' ? { tag_id: tagId(x) } : x))]));
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
  { version: 6, name: 'Stock: migrate product reorder_min and reorder_max into warehouse orderpoints', up: migrateOrderpoints },
  { version: 7, name: 'Employees: random referral tokens invalidate forgeable legacy links', up: (db) => ({
    ...db, records: { ...db.records, 'hr.employee': (db.records['hr.employee'] ?? []).map((e) => ({ ...e, referral_token: /^[0-9a-f]{32}$/.test(e.referral_token ?? '') ? e.referral_token : crypto.randomUUID().replaceAll('-', '') })) },
  }) },
  { version: 8, name: 'Product categories: preserve and link legacy names', up: migrateProductCategories },
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
