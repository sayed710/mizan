// Complete Audit Trail collection, lock-date filtering, and CSV export across financial models.
import { read, formatTrackingChange } from '../orm.js';
import { toCsv } from '../csv.js';
import { scopeAuditRows } from '../companyView.js';
import { auditSummary } from '../audit.js';
import { models } from '../registry.js';
import { AUDIT_MODELS, LOCK_DATE_FIELDS, isAuditTrackingMessage } from './auditRules.js';

export { AUDIT_MODELS, LOCK_DATE_FIELDS, isAuditTrackingMessage };

/** True when `date` falls within the inclusive `[period.from, period.to]` bounds. */
const inPeriod = (date, period) => (!period?.from || String(date ?? '').slice(0, 10) >= period.from)
  && (!period?.to || String(date ?? '').slice(0, 10) <= period.to);

/** Old/new display values and summary for a server-logged change; line collections get per-line detail. */
const changeDetailOf = (db, model, key, oldVal, newVal) => {
  const field = fieldLabelOf(model, key);
  if ((newVal && typeof newVal === 'object') || Array.isArray(oldVal)) {
    const d = formatTrackingChange(db, model, key, oldVal, newVal);
    if (d && d.new_value !== 'updated') {
      return {
        oldValue: d.old_value || '—',
        newValue: d.new_value || '—',
        body: d.body,
      };
    }
  }
  const a = shownValue(oldVal);
  const b = shownValue(newVal);
  return {
    oldValue: a,
    newValue: b,
    body: `${field}: ${a} → ${b}`,
  };
};

/** Format a tracked field value for audit-trail display. */
const shownValue = (v) => (v === null || v === undefined || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v).slice(0, 60) : String(v));

/** Display label for field `key` on `model`, falling back to the raw key. */
const fieldLabelOf = (model, key) => models[model]?.fields?.[key]?.label ?? key;

/** Display title for a record referenced by an audit entry. */
const recordTitleOf = (db, model, id) => {
  const rec = read(db, model, id);
  return rec?.name ?? rec?.code ?? `#${id}`;
};

/**
 * Collect all matching Audit Trail rows without any 500-row cap, normalizing server audit entries
 * or local tracking messages into `{ id, model, res_id, recordName, field, oldValue, newValue, body, author, date }`.
 */
export function collectAuditTrailRows(db, sourceDb, period, serverLog = null, filters = {}) {
  const matchRow = (r) => {
    if (filters.user && !String(r.author ?? '').toLowerCase().includes(filters.user.toLowerCase())) return false;
    if (filters.model && r.model !== filters.model) return false;
    if (filters.record != null && filters.record !== '') {
      const rec = String(filters.record).trim();
      if (String(r.res_id) !== rec && !String(r.recordName ?? '').toLowerCase().includes(rec.toLowerCase())) return false;
    }
    if (filters.field) {
      const f = filters.field.toLowerCase();
      const match = String(r.fieldKey ?? '').toLowerCase().includes(f)
        || String(r.field ?? '').toLowerCase().includes(f)
        || String(r.body ?? '').toLowerCase().includes(f);
      if (!match) return false;
    }
    return true;
  };

  if (serverLog !== null) {
    if (!Array.isArray(serverLog)) return [];
    const scoped = scopeAuditRows(sourceDb, serverLog).filter((e) => AUDIT_MODELS.includes(e.model) && inPeriod(e.at, period));
    const rows = [];
    for (const e of scoped) {
      const recordName = recordTitleOf(db, e.model, e.res_id);
      const entries = Object.entries(e.changes ?? {});
      if (e.model === 'res.company') {
        const lockChanges = entries.filter(([k]) => LOCK_DATE_FIELDS.includes(k));
        for (const [k, [oldVal, newVal]] of lockChanges) {
          const field = fieldLabelOf(e.model, k);
          const { oldValue, newValue, body } = changeDetailOf(db, e.model, k, oldVal, newVal);
          const row = {
            id: `${e.id}:${k}`,
            model: e.model,
            res_id: e.res_id,
            recordName,
            fieldKey: k,
            field,
            oldValue,
            newValue,
            body,
            author: e.actor,
            date: e.at,
          };
          if (matchRow(row)) rows.push(row);
        }
        continue;
      }
      if (e.action === 'write' && entries.length) {
        for (const [k, [oldVal, newVal]] of entries) {
          const field = fieldLabelOf(e.model, k);
          const { oldValue, newValue, body } = changeDetailOf(db, e.model, k, oldVal, newVal);
          const row = {
            id: `${e.id}:${k}`,
            model: e.model,
            res_id: e.res_id,
            recordName,
            fieldKey: k,
            field,
            oldValue,
            newValue,
            body,
            author: e.actor,
            date: e.at,
          };
          if (matchRow(row)) rows.push(row);
        }
      } else {
        const body = auditSummary(e);
        const row = {
          id: e.id,
          model: e.model,
          res_id: e.res_id,
          recordName,
          field: e.action === 'create' ? 'Created' : e.action === 'delete' ? 'Deleted' : '',
          oldValue: '',
          newValue: body,
          body,
          author: e.actor,
          date: e.at,
        };
        if (matchRow(row)) rows.push(row);
      }
    }
    return rows;
  }

  return (db.messages ?? [])
    .filter((m) => isAuditTrackingMessage(m) && inPeriod(m.date, period))
    .sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')))
    .map((m) => ({
      id: m.id,
      model: m.model,
      res_id: m.res_id,
      recordName: recordTitleOf(db, m.model, m.res_id),
      fieldKey: m.field ?? '',
      field: m.field ? fieldLabelOf(m.model, m.field) : '',
      oldValue: m.old_value ?? '',
      newValue: m.new_value ?? (m.field ? '' : (m.body ?? '')),
      body: m.body,
      author: m.author,
      date: m.date,
    }))
    .filter(matchRow);
}

/** Build RFC 4180 CSV text for ALL matching Audit Trail rows. */
export function auditTrailToCsv(rows) {
  return toCsv([
    ['Record', 'Model', 'Field', 'Old Value', 'New Value', 'Summary', 'Author', 'Date'],
    ...(rows ?? []).map((r) => [
      r.recordName ?? `#${r.res_id}`,
      r.model ?? '',
      r.field ?? '',
      r.oldValue ?? '',
      r.newValue ?? '',
      r.body ?? '',
      r.author ?? '',
      String(r.date ?? '').slice(0, 19).replace('T', ' '),
    ]),
  ]);
}
