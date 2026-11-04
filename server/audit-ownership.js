import { SHARED_MODELS } from '../src/orm.js';

const companyId = (value) => Number.isSafeInteger(value) && value > 0 ? value : null;
const keyOf = (model, id) => JSON.stringify([model, id]);

/** Backfill only unambiguous ownership; unknown or contradictory history stays restricted. */
export function backfillAuditOwnership(sql, db, assertWriter) {
  const marker = 'audit_ownership_backfill_v1';
  if (sql.prepare('SELECT 1 FROM kv WHERE key = ?').get(marker)) return;
  sql.exec('BEGIN IMMEDIATE');
  try {
    assertWriter();
    const rows = sql.prepare('SELECT id, model, res_id, action, changes, company_id FROM audit_log ORDER BY id').all();
    const owners = new Map();
    const remember = (model, id, company) => {
      if (!companyId(company)) return;
      const key = keyOf(model, id);
      if (!owners.has(key)) owners.set(key, new Set());
      owners.get(key).add(company);
    };
    for (const row of rows) {
      if (row.model === 'mail.message') continue;
      let changes;
      try { changes = JSON.parse(row.changes); } catch { continue; }
      remember(row.model, row.res_id, companyId(row.company_id));
      const pair = changes?.company_id;
      if (Array.isArray(pair)) for (const company of pair) remember(row.model, row.res_id, companyId(company));
    }
    for (const [model, records] of Object.entries(db?.records ?? {})) {
      for (const record of records) remember(model, record.id, model === 'res.company' ? companyId(record.id) : companyId(record.company_id));
    }
    const update = sql.prepare('UPDATE audit_log SET company_id = ? WHERE id = ? AND company_id IS NULL');
    for (const row of rows) {
      if (row.company_id != null) continue;
      let model = row.model;
      if (model === 'mail.message') {
        try { model = JSON.parse(row.changes)?.thread?.[0]; } catch { continue; }
        // A note on shared master data may originate from a different company-owned document.
        if (!model || SHARED_MODELS.has(model)) continue;
      }
      const candidates = owners.get(keyOf(model, row.res_id));
      if (candidates?.size === 1) update.run([...candidates][0], row.id);
    }
    sql.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run(marker, '1');
    sql.exec('COMMIT');
  } catch (error) {
    sql.exec('ROLLBACK');
    throw error;
  }
}
