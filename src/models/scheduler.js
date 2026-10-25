// Scheduled actions the server runs periodically (Odoo's cron jobs): recurring invoices, time-off accruals, preventive maintenance, replenishment, follow-ups, asset depreciation, bank auto-reconciliation.
import { today } from './common.js';
import { runRecurring } from './more.js';
import { accrue } from './timeoff.js';
import { schedulePreventive } from './apps2.js';
import { replenish } from './routes.js';
import { runFollowUps } from './finance.js';
import { postDepreciation } from './assets.js';
import { autoReconcile } from './reconcile.js';

/** Apply every scheduled action due at `at`; returns the same db object when nothing changed. */
export function runScheduledJobs(db, at = today()) {
  const accrued = (db.records['hr.leave.allocation'] ?? [])
    .filter((a) => a.state === 'validate' && a.allocation_type === 'accrual')
    .reduce((acc, a) => accrue(acc, a, at), db);
  const depreciated = (db.records['account.asset'] ?? []).filter((a) => a.state === 'open')
    .reduce((acc, a) => postDepreciation(acc, acc.records['account.asset'].find((x) => x.id === a.id), at), accrued);
  return autoReconcile(runFollowUps(replenish(schedulePreventive(runRecurring(depreciated, at), at)), at));
}
