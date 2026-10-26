// Whole-database backups: checked here, restored only by an admin through the server.
import { models } from './models/index.js';
import { cleanMessage } from './validate.js';

/**
 * A backup file reduced to a database the server can store: known models, unique positive ids, counters at least
 * as high as the ids, clean messages. Field values are kept as saved, so backups from older versions still restore.
 * Throws with the first problem found.
 */
export function checkBackup(data) {
  if (!data || typeof data !== 'object' || !data.records || typeof data.records !== 'object' || !Array.isArray(data.messages)) throw new Error('This is not a Mizan backup file');
  const records = {};
  for (const [model, list] of Object.entries(data.records)) {
    if (!models[model]) throw new Error(`Unknown model ${model} in the backup`);
    if (!Array.isArray(list)) throw new Error(`Invalid ${model} records in the backup`);
    const ids = new Set();
    for (const r of list) {
      if (!r || typeof r !== 'object' || !Number.isSafeInteger(r.id) || r.id < 1) throw new Error(`Invalid ${model} record in the backup`);
      if (ids.has(r.id)) throw new Error(`Duplicate ${model} #${r.id} in the backup`);
      ids.add(r.id);
    }
    records[model] = [...list].sort((a, b) => a.id - b.id);
  }
  const given = data.seq && typeof data.seq === 'object' ? data.seq : {};
  const seq = Object.fromEntries(Object.keys(records).map((m) => [m, Math.max(Number.isSafeInteger(given[m]) ? given[m] : 0, ...records[m].map((r) => r.id), 0)]));
  return {
    records,
    seq,
    messages: data.messages.map(cleanMessage).filter(Boolean),
    settings: data.settings && typeof data.settings === 'object' && !Array.isArray(data.settings) ? data.settings : {},
  };
}

/** What restoring `next` over `current` would do, for the confirmation shown before it happens. */
export function backupSummary(current, next) {
  const count = (db) => Object.values(db.records).reduce((n, list) => n + list.length, 0);
  let removed = 0;
  let added = 0;
  for (const model of new Set([...Object.keys(current.records), ...Object.keys(next.records)])) {
    const now = new Set((current.records[model] ?? []).map((r) => r.id));
    const then = new Set((next.records[model] ?? []).map((r) => r.id));
    removed += [...now].filter((id) => !then.has(id)).length;
    added += [...then].filter((id) => !now.has(id)).length;
  }
  return { current: count(current), restored: count(next), removed, added };
}
