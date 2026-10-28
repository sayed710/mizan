// Time off allocations (regular and accrual) and the balance check on requests.
import { search, write } from '../orm.js';
import { today } from './common.js';
import { round } from '../money.js';

const LEAVE_TYPES = [['paid', 'Paid Time Off'], ['sick', 'Sick Time Off'], ['unpaid', 'Unpaid'], ['comp', 'Compensatory Days']];
export const REQUIRES_ALLOCATION = new Set(['paid', 'comp']);

const days = (from, to) => (from && to ? Math.max(0, Math.round((new Date(to) - new Date(from)) / 864e5) + 1) : 0);

/** Completed months from `from` to `to` (a month completes on the same day of month). */
function monthsBetween(from, to) {
  if (!from || !to || to < from) return 0;
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  return Math.max(0, (ty - fy) * 12 + (tm - fm) - (td < fd ? 1 : 0));
}

/** Accrual allocations earn `accrual_days_per_month` per completed month since their start (up to their end). */
export function accrue(db, a, at = today()) {
  if (a.allocation_type !== 'accrual') return db;
  const until = a.date_to && a.date_to < at ? a.date_to : at;
  const number_of_days = round((Number(a.accrual_days_per_month) || 0) * monthsBetween(a.date_from, until));
  return number_of_days === Number(a.number_of_days) ? db : write(db, 'hr.leave.allocation', a.id, { number_of_days });
}

export const allocated = (db, employeeId, type) => round(search(db, 'hr.leave.allocation')
  .filter((a) => a.state === 'validate' && a.employee_id === employeeId && a.leave_type === type)
  .reduce((s, a) => s + (Number(a.number_of_days) || 0), 0));

/** Days requested (pending or approved) of a type; pending requests count, as they would once approved. */
export const taken = (db, employeeId, type, { excludeId } = {}) => round(search(db, 'hr.leave')
  .filter((l) => l.id !== excludeId && l.employee_id === employeeId && l.leave_type === type && ['confirm', 'validate'].includes(l.state))
  .reduce((s, l) => s + days(l.date_from, l.date_to), 0));

export const remaining = (db, employeeId, type, opts) => round(allocated(db, employeeId, type) - taken(db, employeeId, type, opts));

/** Requests of allocation-based types cannot exceed the remaining balance. */
export function leaveGuard(db, before, after) {
  if (after.date_from && after.date_to && after.date_to < after.date_from) return 'The end date must be on or after the start date';
  if (!REQUIRES_ALLOCATION.has(after.leave_type) || after.state === 'refuse') return null;
  const left = remaining(db, after.employee_id, after.leave_type, { excludeId: after.id });
  const label = LEAVE_TYPES.find(([k]) => k === after.leave_type)[1];
  return days(after.date_from, after.date_to) > left ? `Not enough ${label} left: ${left} day(s)` : null;
}

export const timeoffModels = {
  'hr.leave.allocation': {
    label: 'Allocations',
    fields: {
      name: { type: 'char', label: 'Description', required: true },
      employee_id: { type: 'many2one', relation: 'hr.employee', label: 'Employee', required: true },
      leave_type: { type: 'selection', label: 'Time Off Type', options: LEAVE_TYPES },
      allocation_type: { type: 'selection', label: 'Allocation Type', options: [['regular', 'Regular Allocation'], ['accrual', 'Accrual Allocation']] },
      number_of_days: { type: 'float', label: 'Allocated Days' },
      accrual_days_per_month: { type: 'float', label: 'Days Accrued per Month' },
      date_from: { type: 'date', label: 'Start Date' },
      date_to: { type: 'date', label: 'End Date' },
      state: { type: 'selection', label: 'Status', tracking: true, options: [['confirm', 'To Approve'], ['validate', 'Approved'], ['refuse', 'Refused']] },
    },
    defaults: () => ({ leave_type: 'paid', allocation_type: 'regular', number_of_days: 0, accrual_days_per_month: 0, date_from: today(), state: 'confirm' }),
    groupBys: ['employee_id', 'leave_type', 'state'],
    kanban: { title: 'name', lines: ['employee_id', 'leave_type', 'number_of_days'], badge: 'state' },
    list: ['employee_id', 'name', 'leave_type', 'allocation_type', 'number_of_days', 'state'],
    pivot: { row: 'employee_id', col: 'leave_type', measure: 'number_of_days' },
    views: ['list', 'kanban', 'pivot'],
    form: {
      statusbar: 'state',
      buttons: [
        { label: 'Approve', primary: true, vals: { state: 'validate' }, when: (r) => r.state === 'confirm' },
        { label: 'Refuse', vals: { state: 'refuse' }, when: (r) => r.state === 'confirm' },
        { label: 'Run Accrual', when: (r) => r.state === 'validate' && r.allocation_type === 'accrual', run: (db, r) => ({ db: accrue(db, r) }) },
      ],
      title: 'name',
      groups: [['employee_id', 'leave_type', 'allocation_type'], ['number_of_days', 'accrual_days_per_month', 'date_from', 'date_to']],
      chatter: true,
    },
  },
};
