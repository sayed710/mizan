// Scheduled actions the server runs periodically (Odoo's cron jobs): recurring invoices, time-off accruals, preventive maintenance, replenishment, follow-ups, asset depreciation, bank auto-reconciliation, marketing automation, scheduled social posts, lead assignment and scoring, helpdesk assignment and auto-close, recurring project tasks.
import { today } from './common.js';
import { subscriptionJobs } from './subscriptionplus.js';
import { accrue } from './timeoff.js';
import { schedulePreventive } from './maintplus.js';
import { replenish } from './routes.js';
import { runFollowUps } from './finance.js';
import { postDepreciation } from './assets.js';
import { autoReconcile } from './reconcile.js';
import { processDue } from './automation.js';
import { publishDue } from './social.js';
import { assignAllTeams, refreshProbabilities } from './crmteams.js';
import { assignTicket, autoCloseStale } from './helpdesk.js';
import { generateRecurringTasks } from './projectplus.js';
import { appraisalJobs } from './appraisalplus.js';

/** New helpdesk tickets of teams that assign automatically get an owner; stale solved/waiting tickets close. */
const helpdeskJobs = (db, at) => autoCloseStale((db.records['helpdesk.ticket'] ?? []).filter((t) => !t.user_id && t.team_id && t.stage_id === 'new')
  .reduce((acc, t) => assignTicket(acc, acc.records['helpdesk.ticket'].find((x) => x.id === t.id)), db), at);

/** Apply `step` to db, keeping db unchanged when it throws (e.g. a locked period), so other jobs still run. */
const tolerant = (step) => (db, ...args) => {
  try {
    return step(db, ...args);
  } catch {
    return db;
  }
};

/** Apply every scheduled action due at `at`; returns the same db object when nothing changed. */
export function runScheduledJobs(db, at = today()) {
  const accrued = (db.records['hr.leave.allocation'] ?? [])
    .filter((a) => a.state === 'validate' && a.allocation_type === 'accrual')
    .reduce((acc, a) => accrue(acc, a, at), db);
  const depreciated = (db.records['account.asset'] ?? []).filter((a) => a.state === 'open')
    .reduce((acc, a) => tolerant(postDepreciation)(acc, acc.records['account.asset'].find((x) => x.id === a.id), at), accrued);
  return tolerant(appraisalJobs)(tolerant(generateRecurringTasks)(tolerant(helpdeskJobs)(refreshProbabilities(assignAllTeams(publishDue(tolerant(processDue)(autoReconcile(runFollowUps(replenish(schedulePreventive(tolerant(subscriptionJobs)(depreciated, at), at)), at)), at), at), at)), at), at), at);
}
