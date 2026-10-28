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
 * Apply every installed app's scheduled action due at `at`; returns the same db object when nothing changed. A job that throws
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
  const autoCheckoutAt = (d) => autoCheckout(d, `${at}T00:00`);
  // [app, job] in run order; a job runs only while its app is installed.
  const JOBS = [
    ['timeoff', (db, at) => (db.records['hr.leave.allocation'] ?? []).filter((a) => a.state === 'validate' && a.allocation_type === 'accrual').reduce((acc, a) => accrue(acc, a, at), db)],
    ['accounting', (db, at) => (db.records['account.asset'] ?? []).filter((a) => a.state === 'open')
      .reduce((acc, a) => tolerant(postDepreciation)(acc, acc.records['account.asset'].find((x) => x.id === a.id), at), db)],
    ['subscriptions', tolerant(subscriptionJobs)],
    ['maintenance', schedulePreventive],
    ['inventory', (db) => replenish(db)],
    ['accounting', runFollowUps],
    ['accounting', (db) => autoReconcile(db)],
    ['automation', tolerant(processDue)],
    ['social', publishDue],
    ['crm', (db) => assignAllTeams(db)],
    ['crm', refreshProbabilities],
    ['helpdesk', tolerant(helpdeskJobs)],
    ['project', tolerant(generateRecurringTasks)],
    ['appraisals', tolerant(appraisalJobs)],
    ['sales', tolerant(expireQuotes)],
    ['sign', tolerant(expireRequests)],
    ['purchase', tolerant(blanketExpiryCheck)],
    ['attendances', tolerant(autoCheckoutAt)],
    // Referral stages follow their applicants (recruitment has no after-write hook).
    ['referral', (db) => (db.records['hr.referral'] ?? []).filter((r) => r.applicant_id).reduce((d, r) => tolerant(syncFromApplicant)(d, r.applicant_id), db)],
  ];

  const uninstalled = new Set(db.settings?.uninstalled ?? []);
  return JOBS.filter(([app]) => !uninstalled.has(app)).reduce((acc, [, job]) => job(acc, at), db);
}
