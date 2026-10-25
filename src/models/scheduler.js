// Scheduled actions the server runs periodically (Odoo's cron jobs): recurring invoices and time-off accruals.
import { today } from './common.js';
import { runRecurring } from './more.js';
import { accrue } from './timeoff.js';

/** Apply every scheduled action due at `at`; returns the same db object when nothing changed. */
export function runScheduledJobs(db, at = today()) {
  const accrued = (db.records['hr.leave.allocation'] ?? [])
    .filter((a) => a.state === 'validate' && a.allocation_type === 'accrual')
    .reduce((acc, a) => accrue(acc, a, at), db);
  return runRecurring(accrued, at);
}
