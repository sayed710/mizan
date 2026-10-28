// Time off allocations (regular and accrual) and the balance check on requests.
import { create, search, write } from '../orm.js';
import { today } from './common.js';
import { round } from '../money.js';
import { moreModels } from './more.js';
import { currentActor, employeeFor, approvalError } from './authority.js';

const LEAVE_TYPES = [['paid', 'Paid Time Off'], ['sick', 'Sick Time Off'], ['unpaid', 'Unpaid'], ['comp', 'Compensatory Days']];
export const REQUIRES_ALLOCATION = new Set(['paid', 'comp']);

const UNITS = [['day', 'Days'], ['half_day', 'Half Days'], ['hour', 'Hours']];
const VALIDATIONS = [['no_validation', 'No Validation'], ['hr', 'By Time Off Officer'], ['manager', "By Employee's Manager"], ['both', 'By Both Approvers']];
const live = (r) => ['confirm', 'validate1', 'validate'].includes(r.state);
const start = (r) => r.request_date_from || r.date_from;
const end = (r) => r.request_date_to || r.date_to;
const typeOf = (db, r) => (db.records['hr.work.entry.type'] ?? []).find((t) => r.work_entry_type_id ? t.id === r.work_entry_type_id : t.legacy_code === r.leave_type && company(t, r));
const policy = (db, r) => typeOf(db, r)?.validation_type || 'manager';
const sameType = (db, r, type) => typeof type === 'number' ? typeOf(db, r)?.id === type : (r.work_entry_type_id ? typeOf(db, r)?.legacy_code === type : r.leave_type === type);
const company = (a, b) => (a.company_id ?? 1) === (b.company_id ?? 1);

/** Contract weekdays use JS weekday numbers, as payroll does. An unconfigured employee retains legacy calendar days. */
export function leaveSchedule(db, employeeId, date) {
  const employee = (db.records['hr.employee'] ?? []).find((e) => e.id === employeeId);
  const c = (db.records['hr.contract'] ?? []).find((r) => r.employee_id === employeeId && (!employee || company(r, employee)) && r.state === 'running' && (!r.date_start || r.date_start <= date) && (!r.date_end || r.date_end >= date));
  const weekdays = String(c?.work_days ?? '0,1,2,3,4,5,6').split(',').map(Number);
  const hours = Number(c?.hours_per_day ?? employee?.daily_hours ?? ((Number(employee?.working_hours) || 40) / 5));
  const from = Number(c?.hour_from ?? 9);
  return { working: weekdays.includes(new Date(`${date}T00:00:00Z`).getUTCDay()), hours, from };
}

/** Actual occupied work intervals, shared by duration and overlap checks; half-day edges apply only at the endpoints. */
export function leaveIntervals(db, r) {
  const a = start(r), b = end(r);
  if (!a || !b || a > b || !Number.isFinite(Date.parse(a)) || !Number.isFinite(Date.parse(b))) return [];
  const result = [];
  for (let cursor = new Date(`${a}T00:00:00Z`); cursor.toISOString().slice(0, 10) <= b; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const date = cursor.toISOString().slice(0, 10);
    const s = leaveSchedule(db, r.employee_id, date);
    if (!s.working) continue;
    let from = s.from, to = s.from + s.hours;
    if (r.request_unit === 'hour') {
      from = Math.max(from, Number(r.request_hour_from));
      to = Math.min(to, Number(r.request_hour_to));
    } else if (r.request_unit === 'half_day') {
      if (date === a && r.request_date_from_period === 'pm') from += s.hours / 2;
      if (date === b && r.request_date_to_period === 'am') to -= s.hours / 2;
    }
    if (to > from) result.push({ date, from, to, dayHours: s.hours });
  }
  return result;
}
export const leaveDuration = (db, r) => {
  const intervals = leaveIntervals(db, r);
  return { number_of_days: round(intervals.reduce((s, i) => s + (i.to - i.from) / i.dayHours, 0)), number_of_hours: round(intervals.reduce((s, i) => s + i.to - i.from, 0)) };
};

const actorContext = () => currentActor() ? { ...currentActor(), isAdmin: false } : null;
function decisionError(db, r, ctx, second = false) {
  if (!ctx || ctx.isAdmin === true) return null;
  const me = employeeFor(db, ctx.login);
  if (!me) return 'Only a manager linked to your user can approve this; ask an administrator to link your user to your employee';
  if (me.id === r.employee_id) return 'You cannot approve your own request';
  const p = policy(db, r);
  if (p === 'hr' || (p === 'both' && second)) return typeOf(db, r)?.time_off_officer_id === me.id ? null : 'Only the time off officer can approve this';
  return approvalError(db, ctx, r.employee_id);
}

/** Also used by sync with the server actor; submitted values never choose the approver or change the policy. */
export function leaveAuthorization(db, before, r, ctx = actorContext()) {
  const p = policy(db, before || r);
  if (!before) return ctx?.isAdmin === false && r.state !== 'confirm' ? 'New time off must start as To Approve; a manager approves it afterwards' : null;
  const changed = before.state !== r.state;
  if (changed && ctx && (r.employee_id !== before.employee_id || r.work_entry_type_id !== before.work_entry_type_id || r.leave_type !== before.leave_type)) return decisionError(db, r, ctx) ?? 'The employee and type cannot change during approval';
  if (changed) {
    const steps = { confirm: [p === 'both' ? 'validate1' : 'validate', 'refuse', 'cancel'], validate1: ['validate', 'refuse', 'cancel'], validate: ['confirm', 'refuse', 'cancel'], refuse: ['confirm'], cancel: [] };
    if (!steps[before.state]?.includes(r.state)) return 'Invalid time off approval transition';
    if (r.state === 'cancel') {
      if (start(before) <= today()) return 'Cancel is only available before the start date';
      return ctx && employeeFor(db, ctx.login)?.id !== before.employee_id ? 'Only the employee can cancel this request' : null;
    }
    if (p === 'no_validation' && before.state === 'confirm' && r.state === 'validate') {
      return ctx && employeeFor(db, ctx.login)?.id !== before.employee_id ? 'Only the employee can submit this request' : null;
    }
  }
  if (changed || ['validate', 'validate1'].includes(before.state)) {
    return decisionError(db, before, ctx, before.state === 'validate1' || (before.state === 'validate' && p === 'both'))
      ?? (r.employee_id !== before.employee_id ? decisionError(db, r, ctx) : null);
  }
  return null;
}

const capability = (db, r, state) => !leaveAuthorization(db, r, { ...r, state });

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

const hourly = (db, type) => typeof type === 'number' && typeOf(db, { work_entry_type_id: type })?.request_unit === 'hour';
const allocationAmount = (db, a, type) => hourly(db, type)
  ? (a.request_unit === 'hour' ? Number(a.number_of_hours) || 0 : (Number(a.number_of_days) || 0) * leaveSchedule(db, a.employee_id, a.date_from || today()).hours)
  : (a.request_unit === 'hour' ? (Number(a.number_of_hours) || 0) / leaveSchedule(db, a.employee_id, a.date_from || today()).hours : Number(a.number_of_days) || 0);
export const allocated = (db, employeeId, type) => round(search(db, 'hr.leave.allocation')
  .filter((a) => a.state === 'validate' && a.employee_id === employeeId && sameType(db, a, type))
  .reduce((s, a) => s + allocationAmount(db, a, type), 0));

/** Days requested (pending or approved) of a type; pending requests count, as they would once approved. */
export const taken = (db, employeeId, type, { excludeId } = {}) => round(search(db, 'hr.leave')
  .filter((l) => l.id !== excludeId && l.employee_id === employeeId && sameType(db, l, type) && live(l))
  .reduce((s, l) => s + leaveDuration(db, l)[hourly(db, type) ? 'number_of_hours' : 'number_of_days'], 0));

export const remaining = (db, employeeId, type, opts) => round(allocated(db, employeeId, type) - taken(db, employeeId, type, opts));

/** Requests of allocation-based types cannot exceed the remaining balance. */
export function leaveGuard(db, before, after, ctx = actorContext()) {
  const denied = leaveAuthorization(db, before, after, ctx);
  if (denied) return denied;
  if (start(after) && end(after) && end(after) < start(after)) return 'The end date must be on or after the start date';
  const type = typeOf(db, after);
  if (after.work_entry_type_id && (!type || !company(type, after))) return 'Select a time off type in the same company';
  const unit = after.request_unit || 'day';
  if (!UNITS.some(([key]) => key === unit)) return 'Invalid request unit';
  if (unit !== 'day' && !(type?.request_unit === unit || (type?.request_unit === 'hour' && unit === 'half_day'))) return 'The time off type does not permit this request unit';
  if (unit === 'half_day') {
    if (![after.request_date_from_period, after.request_date_to_period].every((x) => ['am', 'pm'].includes(x))) return 'Select the morning or afternoon period';
    if (start(after) === end(after) && after.request_date_from_period === 'pm' && after.request_date_to_period === 'am') return 'The end period must follow the start period';
  }
  if (unit === 'hour' && (start(after) !== end(after) || !Number.isFinite(Number(after.request_hour_from)) || !Number.isFinite(Number(after.request_hour_to)) || Number(after.request_hour_from) < 0 || Number(after.request_hour_to) > 24 || Number(after.request_hour_to) <= Number(after.request_hour_from))) return 'Enter valid hours on the same date';
  if (!live(after)) return null;
  const intervals = leaveIntervals(db, after);
  const overlap = (db.records['hr.leave'] ?? []).some((l) => l.id !== after.id && company(l, after) && l.employee_id === after.employee_id && live(l) && leaveIntervals(db, l).some((a) => intervals.some((b) => a.date === b.date && a.from < b.to && b.from < a.to)));
  if (overlap) return 'This request overlaps another time off request';
  if (!(type ? type.requires_allocation : REQUIRES_ALLOCATION.has(after.leave_type))) return null;
  const key = type?.id || after.leave_type;
  const left = remaining(db, after.employee_id, key, { excludeId: after.id });
  const label = type?.name || LEAVE_TYPES.find(([k]) => k === after.leave_type)?.[1] || 'Time Off';
  const amount = leaveDuration(db, after)[hourly(db, key) ? 'number_of_hours' : 'number_of_days'];
  return amount > left ? `Not enough ${label} left: ${left} ${hourly(db, key) ? 'hour(s)' : 'day(s)'}` : null;
}

const baseLeave = moreModels['hr.leave'];
const selection = (label, options) => ({ type: 'selection', label, options });
const typeField = () => ({ type: 'many2one', relation: 'hr.work.entry.type', label: 'Time Off Type' });
const durationField = (key, label) => ({ type: 'float', label, compute: (r, db) => leaveDuration(db, r)[key] });
const action = (label, state, when, primary = false) => ({ label, primary, when, run: (db, r) => ({ db: write(db, 'hr.leave', r.id, { state: typeof state === 'function' ? state(db, r) : state }) }) });

/** Add request defaults and map the legacy selection to company-specific types without replaying approval guards. */
export function migrateTimeOff(db) {
  let next = db;
  const typeId = (r) => {
    if (r.work_entry_type_id) return r.work_entry_type_id;
    const code = r.leave_type || 'paid';
    const found = (next.records['hr.work.entry.type'] ?? []).find((t) => t.legacy_code === code && company(t, r));
    if (found) return found.id;
    const made = create(next, 'hr.work.entry.type', { name: LEAVE_TYPES.find(([k]) => k === code)?.[1] || code, legacy_code: code, company_id: r.company_id ?? 1, requires_allocation: REQUIRES_ALLOCATION.has(code) });
    next = made.db;
    return made.id;
  };
  for (const model of ['hr.leave', 'hr.leave.allocation']) {
    const records = (db.records[model] ?? []).map((r) => ({
      request_unit: 'day', ...(model === 'hr.leave' ? { request_date_from: r.date_from, request_date_to: r.date_to, request_date_from_period: 'am', request_date_to_period: 'pm', request_hour_from: 9, request_hour_to: 17, supporting_document: null } : { number_of_hours: 0 }),
      ...r, work_entry_type_id: typeId(r),
    }));
    next = { ...next, records: { ...next.records, [model]: records } };
  }
  return next;
}

export const timeoffModels = {
  'hr.work.entry.type': {
    label: 'Time Off Types',
    fields: {
      name: { type: 'char', label: 'Name', required: true },
      request_unit: selection('Request Unit', UNITS),
      validation_type: selection('Validation Type', VALIDATIONS),
      requires_allocation: { type: 'boolean', label: 'Requires Allocation' },
      time_off_officer_id: { type: 'many2one', relation: 'hr.employee', label: 'Time Off Officer' },
      legacy_code: { type: 'char', label: 'Legacy Type Code' },
    },
    defaults: () => ({ request_unit: 'day', validation_type: 'manager', requires_allocation: false }),
    list: ['name', 'request_unit', 'validation_type', 'requires_allocation', 'time_off_officer_id'],
    form: { title: 'name', groups: [['request_unit', 'validation_type'], ['requires_allocation', 'time_off_officer_id']] },
  },
  'hr.leave': {
    ...baseLeave,
    fields: {
      ...baseLeave.fields,
      work_entry_type_id: typeField(),
      request_date_from: { type: 'date', label: 'Request Start Date' },
      request_date_to: { type: 'date', label: 'Request End Date' },
      effective_date_from: { type: 'date', label: 'Start Date', compute: start },
      effective_date_to: { type: 'date', label: 'End Date', compute: end },
      request_unit: selection('Request Unit', UNITS),
      request_date_from_period: selection('Start Period', [['am', 'Morning'], ['pm', 'Afternoon']]),
      request_date_to_period: selection('End Period', [['am', 'Morning'], ['pm', 'Afternoon']]),
      request_hour_from: { type: 'float', label: 'Start Hour' },
      request_hour_to: { type: 'float', label: 'End Hour' },
      number_of_days: durationField('number_of_days', 'Duration (days)'),
      request_duration: durationField('number_of_days', 'Requested Duration'),
      number_of_hours: durationField('number_of_hours', 'Duration (hours)'),
      supporting_document: { type: 'binary', label: 'Supporting Document' },
      validation_type: { ...selection('Validation Type', VALIDATIONS), compute: (r, db) => policy(db, r) },
      can_approve: { type: 'boolean', label: 'Can Approve', compute: (r, db) => policy(db, r) !== 'no_validation' && r.state === 'confirm' && capability(db, r, policy(db, r) === 'both' ? 'validate1' : 'validate') },
      can_validate: { type: 'boolean', label: 'Can Validate', compute: (r, db) => r.state === 'validate1' && capability(db, r, 'validate') },
      can_refuse: { type: 'boolean', label: 'Can Refuse', compute: (r, db) => ['confirm', 'validate1', 'validate'].includes(r.state) && capability(db, r, 'refuse') },
      can_cancel: { type: 'boolean', label: 'Can Cancel', compute: (r, db) => live(r) && capability(db, r, 'cancel') },
      state: { ...baseLeave.fields.state, options: [['confirm', 'To Approve'], ['validate1', 'Second Approval'], ['validate', 'Approved'], ['refuse', 'Refused'], ['cancel', 'Cancelled']] },
    },
    defaults: (id) => ({ ...baseLeave.defaults(id), request_unit: 'day', request_date_from_period: 'am', request_date_to_period: 'pm', request_hour_from: 9, request_hour_to: 17, supporting_document: null }),
    onchange: (r, key, db) => {
      if (key === 'request_date_from') return { date_from: r.request_date_from };
      if (key === 'request_date_to') return { date_to: r.request_date_to };
      if (key === 'date_from') return { request_date_from: r.date_from };
      if (key === 'date_to') return { request_date_to: r.date_to };
      if (key === 'work_entry_type_id') return { request_unit: typeOf(db, r)?.request_unit || 'day', leave_type: typeOf(db, r)?.legacy_code || r.leave_type };
      return {};
    },
    guard: leaveGuard,
    list: ['employee_id', 'work_entry_type_id', 'name', 'effective_date_from', 'effective_date_to', 'number_of_days', 'number_of_hours', 'state'],
    calendar: { date: 'effective_date_from' },
    gantt: { ...baseLeave.gantt, start: 'effective_date_from', stop: 'effective_date_to' },
    form: {
      ...baseLeave.form,
      prepare: (r) => ({ ...r, request_date_from: start(r), request_date_to: end(r) }),
      groups: [['employee_id', 'work_entry_type_id', 'leave_type', 'request_unit', 'validation_type'], ['request_date_from', 'request_date_to', 'request_date_from_period', 'request_date_to_period', 'request_hour_from', 'request_hour_to', 'number_of_days', 'number_of_hours', 'supporting_document']],
      buttons: [
        action('Submit Request', 'validate', (r, db) => r.state === 'confirm' && policy(db, r) === 'no_validation' && capability(db, r, 'validate'), true),
        action('Approve', (db, r) => policy(db, r) === 'both' ? 'validate1' : 'validate', (r) => r.can_approve, true),
        action('Validate', 'validate', (r) => r.can_validate, true),
        action('Back to Approval', 'confirm', (r, db) => ['validate', 'refuse'].includes(r.state) && capability(db, r, 'confirm')),
        action('Refuse', 'refuse', (r) => r.can_refuse),
        action('Cancel', 'cancel', (r) => r.can_cancel),
      ],
      smart: [
        { label: 'Employee Calendar', model: 'hr.leave', field: 'employee_id', key: 'employee_id', target: 'timeoff/leaves', view: 'calendar' },
        { label: 'Payslips', model: 'hr.payslip', field: 'employee_id', key: 'employee_id', target: 'payroll/payslips' },
      ],
    },
  },
  'hr.leave.allocation': {
    label: 'Allocations',
    fields: {
      name: { type: 'char', label: 'Description', required: true },
      employee_id: { type: 'many2one', relation: 'hr.employee', label: 'Employee', required: true },
      leave_type: { type: 'selection', label: 'Time Off Type', options: LEAVE_TYPES },
      work_entry_type_id: typeField(),
      request_unit: selection('Request Unit', UNITS),
      number_of_hours: { type: 'float', label: 'Allocated Hours' },
      allocation_type: { type: 'selection', label: 'Allocation Type', options: [['regular', 'Regular Allocation'], ['accrual', 'Accrual Allocation']] },
      number_of_days: { type: 'float', label: 'Allocated Days' },
      accrual_days_per_month: { type: 'float', label: 'Days Accrued per Month' },
      date_from: { type: 'date', label: 'Start Date' },
      date_to: { type: 'date', label: 'End Date' },
      state: { type: 'selection', label: 'Status', tracking: true, options: [['confirm', 'To Approve'], ['validate', 'Approved'], ['refuse', 'Refused']] },
    },
    defaults: () => ({ leave_type: 'paid', request_unit: 'day', number_of_hours: 0, allocation_type: 'regular', number_of_days: 0, accrual_days_per_month: 0, date_from: today(), state: 'confirm' }),
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
      groups: [['employee_id', 'work_entry_type_id', 'leave_type', 'allocation_type', 'request_unit'], ['number_of_days', 'number_of_hours', 'accrual_days_per_month', 'date_from', 'date_to']],
      chatter: true,
    },
  },
};
