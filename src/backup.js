// Whole-database backups: checked here, restored only by an admin through the server.
import { models } from './models/index.js';
import { cleanMessage } from './validate.js';

/**
 * A backup file reduced to a database the server can store: known models, unique positive ids, field values of the
 * declared types, counters at least as high as the ids, clean messages and settings. Fields a model no longer
 * declares are kept as saved, so backups from older versions still restore. Throws with the first problem found.
 */
export function checkBackup(data) {
  if (!data || typeof data !== 'object' || !data.records || typeof data.records !== 'object' || !Array.isArray(data.messages)) throw new Error('This is not a Mizan backup file');
  const records = Object.create(null);
  const top = {};
  for (const [model, list] of Object.entries(data.records)) {
    if (!Object.hasOwn(models, model)) throw new Error(`Unknown model ${model} in the backup`);
    if (!Array.isArray(list)) throw new Error(`Invalid ${model} records in the backup`);
    const ids = new Set();
    top[model] = 0;
    for (const r of list) {
      if (!r || typeof r !== 'object' || !Number.isSafeInteger(r.id) || r.id < 1) throw new Error(`Invalid ${model} record in the backup`);
      if (ids.has(r.id)) throw new Error(`Duplicate ${model} #${r.id} in the backup`);
      ids.add(r.id);
      if (r.id > top[model]) top[model] = r.id;
      const bad = badShape(model, r);
      if (bad) throw new Error(`Invalid ${model} #${r.id} in the backup: ${bad} has the wrong structure`);
    }
    records[model] = [...list].sort((a, b) => a.id - b.id);
  }
  const given = data.seq && typeof data.seq === 'object' && !Array.isArray(data.seq) ? data.seq : {};
  // Counters of models with no record left must survive, or their next record would start again at 1.
  const seq = {};
  for (const model of new Set([...Object.keys(top), ...Object.keys(given).filter((m) => Object.hasOwn(models, m))])) {
    seq[model] = Math.max(Number.isSafeInteger(given[model]) ? given[model] : 0, top[model] ?? 0);
  }
  if (data.schema_version !== undefined && (!Number.isSafeInteger(data.schema_version) || data.schema_version < 0)) throw new Error('Invalid backup schema version');
  return {
    ...(data.schema_version === undefined ? {} : { schema_version: data.schema_version }),
    records: { ...records },
    seq,
    messages: data.messages.map(cleanMessage).filter(Boolean),
    settings: checkSettings(data.settings),
  };
}

const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The first declared field whose value has a structure the app cannot read. Only structure is checked (lists where
 * lists are read, plain values elsewhere), not the exact format, so backups written by older versions still restore.
 */
function badShape(model, rec) {
  for (const [name, field] of Object.entries(models[model].fields)) {
    const v = rec[name];
    if (v === undefined || v === null || field.compute) continue;
    const ok = ['one2many', 'many2many', 'tags'].includes(field.type) ? Array.isArray(v)
      : field.type === 'binary' ? plain(v)
      : typeof v !== 'object';
    if (!ok) return `${model}.${name}`;
  }
  return null;
}

/** Settings the server reads at start-up must have the shape it expects, or the next boot would fail. */
function checkSettings(settings) {
  if (settings === undefined || settings === null) return {};
  if (typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Invalid settings in the backup');
  for (const key of ['customFields', 'companies', 'allowed_company_ids', 'uninstalled']) {
    if (settings[key] != null && !Array.isArray(settings[key])) throw new Error(`Invalid settings.${key} in the backup`);
  }
  if (settings.customFields?.some((f) => !f || typeof f !== 'object')) throw new Error('Invalid settings.customFields in the backup');
  if (settings.companies?.some((c) => !c || typeof c !== 'object')) throw new Error('Invalid settings.companies in the backup');
  if (settings.favorites != null && (typeof settings.favorites !== 'object' || Array.isArray(settings.favorites))) throw new Error('Invalid settings.favorites in the backup');
  return settings;
}

/** What restoring `next` over `current` would do, for the confirmation shown before it happens. */
export function backupSummary(current, next) {
  const count = (db) => Object.values(db.records).reduce((n, list) => n + list.length, 0);
  let removed = 0;
  let added = 0;
  let changed = 0;
  for (const model of new Set([...Object.keys(current.records), ...Object.keys(next.records)])) {
    const now = new Map((current.records[model] ?? []).map((r) => [r.id, JSON.stringify(r)]));
    const then = new Map((next.records[model] ?? []).map((r) => [r.id, JSON.stringify(r)]));
    removed += [...now.keys()].filter((id) => !then.has(id)).length;
    added += [...then.keys()].filter((id) => !now.has(id)).length;
    changed += [...then].filter(([id, json]) => now.has(id) && now.get(id) !== json).length;
  }
  return {
    current: count(current), restored: count(next), removed, added, changed,
    messages: { current: current.messages?.length ?? 0, restored: next.messages.length },
    settingsChanged: JSON.stringify(current.settings ?? {}) !== JSON.stringify(next.settings),
  };
}
