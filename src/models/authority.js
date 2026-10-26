// Segregation of duties: who may approve. A user is linked to an employee through hr.employee.user_login; approving
// time off, allocations, expenses, timesheets and approval requests then needs that employee to be a manager of the
// requester (never the requester themselves), checked on the server for every non-admin change.

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

const changedTo = (before, after, field, values) => after[field] !== (before?.[field] ?? undefined) && values.includes(after[field]);

/** Time off and allocations: deciding (approve or refuse) and editing an approved one need the manager. */
const leaveRule = (db, before, r, ctx) => (changedTo(before, r, 'state', ['validate', 'refuse']) || before?.state === 'validate'
  ? approvalError(db, ctx, before?.state === 'validate' ? before.employee_id : r.employee_id) : null);

/** Expense reports: approving, or refusing back to draft, needs the report's manager. */
function sheetRule(db, before, r, ctx) {
  const decided = before ? ['submit', 'approve'].includes(before.state) && ['approve', 'draft'].includes(r.state) && r.state !== before.state
    : !['draft', 'submit'].includes(r.state);
  return decided ? approvalError(db, ctx, r.employee_id, r.manager_id) : null;
}

/** Single expenses: approving or refusing needs the manager. */
const expenseRule = (db, before, r, ctx) => (changedTo(before, r, 'state', ['approved', 'refused']) ? approvalError(db, ctx, r.employee_id) : null);

/** Timesheets: validating needs the manager and records who did it; only admins reset validated time. */
function timesheetRule(db, before, r, ctx) {
  if (!ctx || ctx.isAdmin !== false) return null;
  if (before?.validated && !r.validated) return 'Only administrators can reset validated timesheets';
  if (!r.validated || before?.validated) return null;
  return approvalError(db, ctx, r.employee_id) ?? (r.validated_by !== ctx.name ? 'Validated By must be your own name' : null);
}

/** Approval requests: each approver line is approved or refused only by that approver, never by the request owner. */
function requestRule(db, before, r, ctx) {
  if (!ctx || ctx.isAdmin !== false) return null;
  const was = new Map((before?.approver_ids ?? []).map((a) => [a.employee_id, a.status]));
  const decided = (r.approver_ids ?? []).filter((a) => ['approved', 'refused'].includes(a.status) && was.get(a.employee_id) !== a.status);
  const me = employeeFor(db, ctx.login);
  if (decided.some((a) => !me || a.employee_id !== me.id || a.employee_id === r.request_owner_id)) return 'Only the pending approver can approve or refuse their own line';
  const status = (x) => x?.request_status ?? x?.state;
  if (status(r) !== status(before) && ['approved', 'refused'].includes(status(r)) && !decided.length) return 'Approve or refuse through your approver line';
  return null;
}

/** Employees: only admins link users to employees, and one user to one employee. */
function employeeRule(db, before, r, ctx) {
  if ((r.user_login ?? '') === (before?.user_login ?? '')) return null;
  if (ctx && ctx.isAdmin === false) return 'Only administrators can link users to employees';
  if (r.user_login && employees(db).some((e) => e.id !== r.id && e.user_login === r.user_login)) return 'This user is already linked to another employee';
  return null;
}

/** Server-side authorization rules per model: (db, before, after, { isAdmin, login, name }) => error or null. */
export const authorityRules = {
  'hr.leave': leaveRule,
  'hr.leave.allocation': leaveRule,
  'hr.expense.sheet': sheetRule,
  'hr.expense': expenseRule,
  'account.analytic.line': timesheetRule,
  'approval.request': requestRule,
  'hr.employee': employeeRule,
};
