// SQLite persistence: one row per record and per message, plus a meta row (sequences, settings).
// Saves are incremental (only the records that changed), inside one transaction.
import { diffDb } from '../src/sync.js';

export function openStorage(sql) {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS records (model TEXT NOT NULL, id INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (model, id));
    CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, model TEXT NOT NULL, res_id INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS messages_record ON messages (model, res_id);
  `);
  const q = {
    meta: sql.prepare("SELECT value FROM kv WHERE key = 'meta'"),
    setMeta: sql.prepare("INSERT INTO kv (key, value) VALUES ('meta', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
    legacy: sql.prepare("SELECT value FROM kv WHERE key = 'db'"),
    dropLegacy: sql.prepare("DELETE FROM kv WHERE key = 'db'"),
    allRecords: sql.prepare('SELECT model, data FROM records ORDER BY model, id'),
    allMessages: sql.prepare('SELECT data FROM messages ORDER BY rowid'),
    upsert: sql.prepare('INSERT INTO records (model, id, data) VALUES (?, ?, ?) ON CONFLICT(model, id) DO UPDATE SET data = excluded.data'),
    remove: sql.prepare('DELETE FROM records WHERE model = ? AND id = ?'),
    addMessage: sql.prepare('INSERT OR REPLACE INTO messages (id, model, res_id, data) VALUES (?, ?, ?, ?)'),
    removeMessage: sql.prepare('DELETE FROM messages WHERE id = ?'),
    clearRecords: sql.prepare('DELETE FROM records'),
    clearMessages: sql.prepare('DELETE FROM messages'),
  };

  const transaction = (fn) => {
    sql.exec('BEGIN');
    try {
      fn();
      sql.exec('COMMIT');
    } catch (e) {
      sql.exec('ROLLBACK');
      throw e;
    }
  };

  const writeAll = (db, alongside = () => {}) => transaction(() => {
    alongside();
    q.clearRecords.run();
    q.clearMessages.run();
    for (const [model, recs] of Object.entries(db.records)) for (const r of recs) q.upsert.run(model, r.id, JSON.stringify(r));
    for (const m of db.messages) q.addMessage.run(m.id, m.model, m.res_id, JSON.stringify(m));
    q.setMeta.run(JSON.stringify({ seq: db.seq, settings: db.settings }));
  });

  return {
    /** Load the database; migrates the old single-blob format on first start. Returns null when empty. */
    load() {
      const legacy = q.legacy.get();
      if (legacy && !q.meta.get()) {
        const db = JSON.parse(legacy.value);
        writeAll(db);
        q.dropLegacy.run();
        return db;
      }
      const meta = q.meta.get();
      if (!meta) return null;
      const { seq, settings } = JSON.parse(meta.value);
      const records = {};
      for (const row of q.allRecords.all()) (records[row.model] ??= []).push(JSON.parse(row.data));
      return { records, seq, settings, messages: q.allMessages.all().map((row) => JSON.parse(row.data)) };
    },

    /** Persist the transition prev → next (full rewrite when prev is null); `alongside` runs in the same transaction. */
    save(prev, next, alongside = () => {}) {
      if (!prev) return writeAll(next, alongside);
      const d = diffDb(prev, next);
      transaction(() => {
        alongside();
        for (const [model, recs] of Object.entries(d.upserts)) for (const r of recs) q.upsert.run(model, r.id, JSON.stringify(r));
        for (const [model, ids] of Object.entries(d.deletes)) for (const id of ids) q.remove.run(model, id);
        for (const m of d.messages) q.addMessage.run(m.id, m.model, m.res_id, JSON.stringify(m));
        for (const id of d.removedMessages) q.removeMessage.run(id);
        if (prev.seq !== next.seq || prev.settings !== next.settings) q.setMeta.run(JSON.stringify({ seq: next.seq, settings: next.settings }));
      });
    },
  };
}
