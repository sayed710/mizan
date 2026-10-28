// Segregation of duties: who may approve. A user is linked to an employee through hr.employee.user_login; approving
// time off, allocations, expenses, timesheets and approval requests then needs that employee to be a manager of the
// requester (never the requester themselves), checked on the server for every non-admin change.
import { leaveAuthorization } from './timeoff.js';

let actor = null;
/** The signed-in user ({ login, name }) on the client; null in local mode. */
export const setActor = (value) => { actor = value?.login ? { login: value.login, name: value.name ?? value.login } : null; };
export const currentActor = () => actor;

const employees = (db) => db.records['hr.employee'] ?? [];
const employee = (db, id) => employees(db).find((e) => e.id === id) ?? null;

/** The employee linked to a user login, or null. */
export const employeeFor = (db, login) => (login ? employees(db).find((e) => e.user_login === login) ?? null : null);

/** Whether `managerId` is `employeeId`'s manager, directly or further up the chain. */
export function manages(db, managerId, employeeId) {
  const seen = new Set();
  for (let e = employee(db, employeeId); e?.parent_id && !seen.has(e.id); e = employee(db, e.parent_id)) {
    seen.add(e.id);
    if (e.parent_id === managerId) return true;
  }
  return false;
}

/**
 * Why the acting user may not approve for `employeeId`, or null when they may: admins always may; others need a linked
 * employee that manages the requester and, when the record names its approver, is that approver.
 */
export function approvalError(db, ctx, employeeId, approverId = null) {
  if (!ctx || ctx.isAdmin !== false) return null;
  const me = employeeFor(db, ctx.login);
  if (!me) return 'Only a manager linked to your user can approve this; ask an administrator to link your user to your employee';
  if (me.id === employeeId) return 'You cannot approve your own request';
  if (!manages(db, me.id, employeeId) || (approverId && approverId !== me.id)) return "Only the employee's manager can approve this";
  return null;
}

const actingEmployee = (db, ctx) => employeeFor(db, ctx?.login);
const deciding = (ctx) => ctx && ctx.isAdmin === false;

/**
 * Time off and allocations. Rules judge the stored record, never the values being submitted: a new one starts as
 * "To Approve"; deciding one, or editing an approved one, needs the manager of its stored employee (and of the new
 * employee when the owner changes in the same step, so a leave cannot be moved onto the approver).
 */
function leaveRule(db, before, r, ctx) {
  if (!deciding(ctx)) return null;
  if (!before) return ['validate', 'refuse'].includes(r.state) ? 'New time off must start as To Approve; a manager approves it afterwards' : null;
  if (!(r.state !== before.state && ['validate', 'refuse'].includes(r.state)) && before.state !== 'validate') return null;
  return approvalError(db, ctx, before.employee_id) ?? (r.employee_id !== before.employee_id ? approvalError(db, ctx, r.employee_id) : null);
}

/** Deleting approved time off or an approved allocation needs the same manager as editing it. */
const leaveDeleteRule = (db, stored, ctx) => (deciding(ctx) && stored.state === 'validate' ? approvalError(db, ctx, stored.employee_id) : null);

// Expense reports may only move along these steps; the ones marked need the report's manager.
const SHEET_STEPS = {
  draft: ['submit', 'cancel'], submit: ['draft', 'approve', 'cancel'], approve: ['draft', 'post', 'done', 'cancel'],
  post: ['done'], done: [], cancel: ['draft'],
};
const SHEET_MANAGER_STEPS = new Set(['submit>approve', 'approve>draft']);

/** Expense reports: judged on the stored report, one step at a time; approving or refusing needs its manager. */
function sheetRule(db, before, r, ctx) {
  if (!deciding(ctx)) return null;
  if (!before) return ['draft', 'submit'].includes(r.state) ? null : 'New expense reports start as draft or submitted';
  if (r.state === before.state) return null;
  if (!SHEET_STEPS[before.state]?.includes(r.state)) return `An expense report cannot go from ${before.state} to ${r.state} directly`;
  if (r.employee_id !== before.employee_id || r.manager_id !== before.manager_id) return 'The employee and manager of a report cannot change while its status does';
  const owner = actingEmployee(db, ctx)?.id === before.employee_id;
  // The employee may take their own submitted report back; any other refusal, and every approval, is the manager's.
  if (before.state === 'submit' && r.state === 'draft') return owner ? null : approvalError(db, ctx, before.employee_id, before.manager_id);
  return SHEET_MANAGER_STEPS.has(`${before.state}>${r.state}`) ? approvalError(db, ctx, before.employee_id, before.manager_id) : null;
}

/** Single expenses: approving or refusing needs the manager of the stored employee, and they cannot start decided. */
function expenseRule(db, before, r, ctx) {
  if (!deciding(ctx)) return null;
  if (!before) return ['approved', 'refused'].includes(r.state) ? 'New expenses must be approved by a manager afterwards' : null;
  const decision = r.state !== before.state && ['approved', 'refused'].includes(r.state);
  if (!decision && !['approved', 'refused'].includes(before.state)) return null;
  return approvalError(db, ctx, before.employee_id) ?? (r.employee_id !== before.employee_id ? approvalError(db, ctx, r.employee_id) : null);
}

/** Timesheets: validating needs the manager of the stored employee and records who did it; only admins reset it. */
function timesheetRule(db, before, r, ctx) {
  if (!deciding(ctx)) return null;
  if (before?.validated && !r.validated) return 'Only administrators can reset validated timesheets';
  if (before?.validated && r.employee_id !== before.employee_id) return 'Validated timesheets cannot be moved to another employee';
  if (!r.validated || before?.validated) return null;
  return approvalError(db, ctx, before ? before.employee_id : r.employee_id) ?? (before && r.employee_id !== before.employee_id ? approvalError(db, ctx, r.employee_id) : null)
    ?? (r.validated_by !== ctx.name ? 'Validated By must be your own name' : null);
}

const requestStatus = (x) => x?.request_status ?? x?.state ?? 'new';
const DECIDED = ['approved', 'refused'];

/** Whether the approvals on `lines` satisfy the category (minimum approvals and every required approver). */
function complete(category, lines) {
  const minimum = category?.approval_minimum ?? 1;
  return lines.filter((a) => a.status === 'approved').length >= minimum && lines.every((a) => !a.required || a.status === 'approved');
}

/**
 * Approval requests, judged on the stored request. Submitting may only name the category's approvers (or the owner's
 * manager). Deciding means the signed-in approver moves their own pending line, nothing else about the roster or owner
 * changes, a later sequential approver may only be opened by that decision, and the request is approved only once
 * the category's minimum and required approvers are met.
 */
function requestRule(db, before, r, ctx) {
  if (!deciding(ctx)) return null;
  const lines = r.approver_ids ?? [];
  const status = requestStatus(r);
  const category = (db.records['approval.category'] ?? []).find((c) => c.id === (before?.category_id ?? r.category_id));
  if (!before) return status !== 'new' || lines.some((a) => a.status !== 'new') ? 'A new approval request starts as To Submit' : null;
  const was = requestStatus(before);
  if (was === 'new') {
    if (status === 'new') return null;
    if (status !== 'pending' || lines.some((a) => !['new', 'pending'].includes(a.status))) return 'Submit the request to its approvers; it cannot be decided yet';
    const owner = employee(db, r.request_owner_id);
    const allowed = new Set([...(category?.approver_ids ?? []).map((a) => a.employee_id), owner?.parent_id].filter(Boolean));
    return lines.every((a) => allowed.has(a.employee_id)) ? null : 'Only the approvers of the approval type (or the owner\'s manager) can be on the request';
  }
  if (was === 'pending' && status === 'new' && !lines.length && !(before.approver_ids ?? []).some((a) => a.status === 'approved')) return null;
  if (DECIDED.includes(was) || status === 'cancel') {
    const same = status === was && JSON.stringify(lines) === JSON.stringify(before.approver_ids ?? []) && r.request_owner_id === before.request_owner_id;
    return same ? null : 'A decided request cannot be changed';
  }
  if (was !== 'pending') return null;
  if (r.request_owner_id !== before.request_owner_id || r.category_id !== before.category_id) return 'The owner and type of a submitted request cannot change';
  const stored = before.approver_ids ?? [];
  if (lines.length !== stored.length || lines.some((a, i) => a.employee_id !== stored[i].employee_id)) return 'The approvers of a submitted request cannot change';
  const me = actingEmployee(db, ctx);
  const changed = lines.map((a, i) => [a, stored[i]]).filter(([a, old]) => a.status !== old.status);
  const mine = changed.find(([a]) => a.employee_id === me?.id);
  const others = changed.filter(([a]) => a.employee_id !== me?.id);
  if (!mine && (changed.length || status !== was)) return 'Approve or refuse through your approver line';
  if (mine && (mine[1].status !== 'pending' || !DECIDED.includes(mine[0].status) || me.id === before.request_owner_id)) return 'Only the pending approver can approve or refuse their own line, never the request owner';
  if (others.some(([a, old]) => !(old.status === 'new' && a.status === 'pending' && mine[0].status === 'approved'))) return 'Only the next approver in the sequence can be opened by your approval';
  if (mine?.[0].status === 'refused' ? status !== 'refused' : status === 'refused') return 'A refusal refuses the request';
  if (status === 'approved' && !complete(category, lines)) return 'The request needs more approvals before it is approved';
  if (status === 'pending' && mine && complete(category, lines)) return 'The approvals are complete: the request is approved';
  return null;
}

/** Employees: only admins link users to employees (one user to one employee) or change who reports to whom. */
function employeeRule(db, before, r, ctx) {
  if (deciding(ctx) && (r.parent_id ?? null) !== (before?.parent_id ?? null)) return 'Only administrators can change who an employee reports to';
  if ((r.user_login ?? '') === (before?.user_login ?? '')) return null;
  if (ctx && ctx.isAdmin === false) return 'Only administrators can link users to employees';
  if (r.user_login && employees(db).some((e) => e.id !== r.id && e.user_login === r.user_login)) return 'This user is already linked to another employee';
  return null;
}

/** Server-side authorization rules per model: (db, stored, after, { isAdmin, login, name }) => error or null. */
export const authorityRules = {
  'hr.leave': leaveAuthorization,
  'hr.leave.allocation': leaveRule,
  'hr.expense.sheet': sheetRule,
  'hr.expense': expenseRule,
  'account.analytic.line': timesheetRule,
  'approval.request': requestRule,
  'hr.employee': employeeRule,
};

/** Rules for deleting a stored record: (db, stored, { isAdmin, login, name }) => error or null. */
export const authorityDeleteRules = {
  'hr.leave': leaveDeleteRule,
  'hr.leave.allocation': leaveDeleteRule,
};
