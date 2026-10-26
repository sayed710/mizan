import { read, search } from './orm.js';
import { companyFilter } from './models/company.js';

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
export const companyViewDb = (db) => ({
  ...db,
  records: Object.fromEntries(Object.entries(db.records).map(([model, records]) => [model, companyFilter(db, records)])),
});
