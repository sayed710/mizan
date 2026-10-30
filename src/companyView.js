import { read, search } from './orm.js';
import { companyFilter, currentCompany, restrictRecords, scopeAuditChanges, visibleTo } from './models/company.js';

/** Search UI records in the allowed companies, keeping shared records. */
export const viewRecords = (db, model, options) => companyFilter(db, search(db, model, options));

/** Records visible in an action before search-panel filtering. */
export const actionRecords = (db, leaf, rel, archived = false) =>
  viewRecords(db, leaf.model, { includeArchived: archived })
    .filter((r) => (!archived || r.active === false) && (!leaf.domain || leaf.domain(r)) && (!rel || r[rel.field] === rel.id));

/** Allowed many2one choices plus the current value, even if foreign or archived. */
export function relationCandidates(db, model, value) {
  const records = viewRecords(db, model);
  const current = value && read(db, model, Number(value));
  return current && !records.some((r) => r.id === current.id) ? [...records, current] : records;
}

/** Read-only dashboard input for calculations that search several models. */
export function companyViewDb(db) {
  const allowed = new Set(db.settings?.allowed_company_ids ?? [currentCompany(db)]);
  const view = { ...db, records: restrictRecords(db, allowed).records };
  // Legacy product quantities have no company field and belong to company 1; valuation uses them as a fallback.
  if (!allowed.has(1) && view.records.product) view.records.product = view.records.product.map((product) => ({ ...product, qty_available: 0 }));
  return { ...view, messages: scopeAuditRows(db, db.messages ?? []) };
}

// Legacy rows resolve through the current record; unresolved ownership is not visible to restricted views.
export const scopeAuditRows = (db, rows) => {
  const allowed = new Set(db.settings?.allowed_company_ids ?? [currentCompany(db)]);
  return rows.filter((row) => {
    if (Number.isInteger(row.company_id) && row.company_id > 0) return allowed.has(row.company_id);
    const record = (db.records[row.model] ?? []).find((r) => r.id === row.res_id);
    return record ? visibleTo(allowed, row.model, record, db) : false;
  }).map((row) => (row.changes && typeof row.changes === 'object' ? { ...row, changes: scopeAuditChanges(row.model, row.changes, allowed) } : row));
};
