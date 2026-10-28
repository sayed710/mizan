// Scheduled actions the server runs periodically (Odoo's cron jobs): recurring invoices, time-off accruals, preventive maintenance, replenishment, follow-ups, asset depreciation, bank auto-reconciliation, marketing automation, scheduled social posts, lead assignment and scoring, helpdesk assignment and auto-close, recurring project tasks, signature request expiry and blanket order expiry.
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
import { expireQuotes } from './quoteplus.js';
import { autoCheckout } from './attendanceplus.js';
import { syncFromApplicant } from './skillsplus.js';
import { expireRequests } from './signplus.js';
import { blanketExpiryCheck } from './purchaseplus.js';

/** New helpdesk tickets of teams that assign automatically get an owner; stale solved/waiting tickets close. */
const helpdeskJobs = (db, at) => autoCloseStale((db.records['helpdesk.ticket'] ?? []).filter((t) => !t.user_id && t.team_id && t.stage_id === 'new')
  .reduce((acc, t) => assignTicket(acc, acc.records['helpdesk.ticket'].find((x) => x.id === t.id)), db), at);

/**
 * Apply every scheduled action due at `at`; returns the same db object when nothing changed. A job that throws
 * (e.g. a locked period) leaves db unchanged so the other jobs still run, and is reported through `onError`.
 */
export function runScheduledJobs(db, at = today(), { onError = () => {} } = {}) {
  const tolerant = (step) => (d, ...args) => {
    try {
      return step(d, ...args);
    } catch (e) {
      try {
        onError(step.name || 'job', e);
      } catch (reporter) {
        console.error(`Scheduler error reporter failed for ${step.name || 'job'}:`, reporter);
      }
      return d;
    }
  };
  const accrued = (db.records['hr.leave.allocation'] ?? [])
    .filter((a) => a.state === 'validate' && a.allocation_type === 'accrual')
    .reduce((acc, a) => accrue(acc, a, at), db);
  const depreciated = (db.records['account.asset'] ?? []).filter((a) => a.state === 'open')
    .reduce((acc, a) => tolerant(postDepreciation)(acc, acc.records['account.asset'].find((x) => x.id === a.id), at), accrued);
  const ran = tolerant(appraisalJobs)(tolerant(generateRecurringTasks)(tolerant(helpdeskJobs)(refreshProbabilities(assignAllTeams(publishDue(tolerant(processDue)(autoReconcile(runFollowUps(replenish(schedulePreventive(tolerant(subscriptionJobs)(depreciated, at), at)), at)), at), at), at)), at), at), at);
  const expired = tolerant(blanketExpiryCheck)(tolerant(expireRequests)(tolerant(expireQuotes)(ran, at), at), at);
  const autoCheckoutAt = (d) => autoCheckout(d, `${at}T00:00`);
  const checkedOut = tolerant(autoCheckoutAt)(expired);
  // Referral stages follow their applicants (recruitment has no after-write hook).
  return (checkedOut.records['hr.referral'] ?? []).filter((r) => r.applicant_id).reduce((d, r) => tolerant(syncFromApplicant)(d, r.applicant_id), checkedOut);
}
