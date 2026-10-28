// Uploaded files live in their own table: records keep { name, type, size, blob } instead of the data URL,
// so attachments do not count toward the in-memory database or its size limit.
import { randomBytes } from 'node:crypto';
import { models } from '../src/models/index.js';

const DATA_URL = /^data:([^;,]*)(;base64)?,(.*)$/s;
export const RASTER = /^image\/(png|jpeg|gif|webp)$/;

const binaryFields = () => Object.entries(models)
  .map(([model, def]) => [model, Object.entries(def.fields).filter(([, f]) => f.type === 'binary').map(([k]) => k)])
  .filter(([, keys]) => keys.length);

export function openBlobs(sql) {
  sql.exec('CREATE TABLE IF NOT EXISTS blobs (id TEXT PRIMARY KEY, type TEXT NOT NULL, data BLOB NOT NULL)');
  const insert = sql.prepare('INSERT INTO blobs (id, type, data) VALUES (?, ?, ?)');
  const select = sql.prepare('SELECT type, data FROM blobs WHERE id = ?');

  const store = (value) => {
    const m = DATA_URL.exec(value.data);
    if (!m) return value;
    const id = randomBytes(16).toString('hex');
    const bytes = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]));
    insert.run(id, value.type || m[1] || 'application/octet-stream', bytes);
    const { data: _data, ...rest } = value;
    return { ...rest, size: rest.size || bytes.length, blob: id };
  };

  /** `db` with every inline file moved to the blobs table; records without inline data are kept as they are. */
  const externalize = (db) => {
    if (!db) return db; // empty database before the first save
    let records = db.records;
    for (const [model, keys] of binaryFields()) {
      const list = records[model] ?? [];
      if (!list.some((r) => keys.some((k) => r[k]?.data))) continue;
      records = { ...records, [model]: list.map((r) => (keys.some((k) => r[k]?.data)
        ? { ...r, ...Object.fromEntries(keys.filter((k) => r[k]?.data).map((k) => [k, store(r[k])])) }
        : r)) };
    }
    return records === db.records ? db : { ...db, records };
  };

  return { externalize, get: (id) => (/^[0-9a-f]{32}$/.test(id) ? select.get(id) : undefined) };
}
