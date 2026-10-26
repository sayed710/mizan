// Timesheet validation, timers and service delivery, preserving invoice analytics.
import { create, read, search, write } from '../orm.js';
import { addDays, today } from './common.js';
import { analyticPlusModels } from './analyticplus.js';

const model = 'account.analytic.line';
const base = analyticPlusModels[model];
const isTimesheet = (r) => !r.move_id && (!r.category || r.category === 'timesheet');
const round = (n) => Math.round(n * 100) / 100 || 0;
const cost = (db, r) => {
  const employee = read(db, 'hr.employee', r.employee_id);
  return -Number(r.unit_amount || 0) * Number(employee?.timesheet_cost ?? employee?.hourly_cost ?? 0) || 0;
};
const day = (date) => {
  const value = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T00:00:00Z`) : NaN;
  if (!Number.isFinite(value) || new Date(value).toISOString().slice(0, 10) !== date) throw new Error('Enter a valid date');
  return value;
};
const timestamp = (now) => {
  const value = typeof now === 'string' && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(now) ? Date.parse(now) : NaN;
  if (!Number.isFinite(value)) throw new Error('Enter a valid timer timestamp with a timezone');
  return value;
};
const getTimesheet = (db, id) => {
  const line = read(db, model, id);
  if (!line || !isTimesheet(line)) throw new Error('Select a timesheet entry');
  return line;
};

/** Enforce validation locks, valid hours, sales links and one running timer per employee. */
export function timesheetGuard(db, before, after) {
  const inherited = base.guard?.(db, before, after);
  if (inherited) return inherited;
  if (before && isTimesheet(before) && before.validated) {
    const changed = Object.keys({ ...before, ...after }).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
    const reset = after.validated === false && changed.every((key) => ['validated', 'validated_by', 'validated_on'].includes(key));
    if (changed.length && !reset) return 'Validated timesheets are read-only; reset to draft first';
  }
  if (!isTimesheet(after)) return null;
  if (!Number.isFinite(Number(after.unit_amount)) || Number(after.unit_amount) < 0) return 'Hours must be a non-negative number';
  if (after.billable && !['billable_time', 'billable_fixed', 'non_billable'].includes(after.billable)) return 'Select a valid billing type';
  const task = after.task_id && read(db, 'project.task', after.task_id);
  if (after.task_id && !task) return 'Task not found';
  if (after.project_id && !read(db, 'project.project', after.project_id)) return 'Project not found';
  if (task && task.project_id !== after.project_id) return 'The task must belong to the selected project';
  if (after.so_id) {
    const order = read(db, 'sale.order', after.so_id);
    if (!order || !Number.isInteger(after.so_line_index) || !order.order_line?.[after.so_line_index]) return 'Select a valid sale order line';
  }
  if (after.timer_start) {
    if (after.validated) return 'Stop the timer before validating the timesheet';
    if (!read(db, 'hr.employee', after.employee_id)) return 'Select an employee before starting a timer';
    try { timestamp(after.timer_start); } catch (error) { return error.message; }
    if (search(db, model).some((r) => r.id !== after.id && isTimesheet(r) && r.employee_id === after.employee_id && r.timer_start)) return 'This employee already has a running timer';
  }
  return null;
}

/** Start a new employee timer; return { db, id } without changing the input database. */
export function startTimer(db, { employeeId, projectId, taskId, now }) {
  const time = timestamp(now);
  if (!read(db, 'hr.employee', employeeId)) throw new Error('Employee not found');
  const task = taskId && read(db, 'project.task', taskId);
  return create(db, model, {
    employee_id: employeeId, project_id: projectId ?? task?.project_id ?? null, task_id: taskId ?? null,
    date: new Date(time).toISOString().slice(0, 10), unit_amount: 0, amount: 0,
    timer_start: new Date(time).toISOString(),
  });
}

/** Stop a timer, adding elapsed hours rounded to the nearest quarter hour (minimum one). */
export function stopTimer(db, lineId, now) {
  const line = getTimesheet(db, lineId);
  if (!line.timer_start) throw new Error('This timer is not running');
  const elapsed = timestamp(now) - timestamp(line.timer_start);
  if (elapsed < 0) throw new Error('The stop time cannot be before the start time');
  const hours = Number(line.unit_amount || 0) + Math.max(1, Math.round(elapsed / 900000)) / 4;
  return write(db, model, lineId, { unit_amount: hours, timer_start: null, amount: cost(db, { ...line, unit_amount: hours }) });
}

/** Validate stopped timesheets and snapshot their employee cost and approver. */
export function validateTimesheets(db, ids, { user, date = today() }) {
  if (typeof user !== 'string' || !user.trim()) throw new Error('Enter the validating user');
  day(date);
  const validated = [...new Set(ids)].reduce((next, id) => {
    const line = getTimesheet(next, id);
    if (line.timer_start) throw new Error('Stop the timer before validating the timesheet');
    if (line.validated) return next;
    return write(next, model, id, { validated: true, validated_by: user, validated_on: date, amount: cost(next, line) });
  }, db);
  // Validated billable time becomes the delivered quantity on the linked sales orders.
  const orders = new Set(ids.map((id) => read(validated, model, id)?.so_id).filter(Boolean));
  return [...orders].reduce((next, soId) => syncDelivered(next, soId), validated);
}

/** Return project/task rows with seven day-hour columns and a weekly total. */
export function weeklyGrid(db, employeeId, weekStart) {
  day(weekStart);
  const dates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const rows = new Map();
  for (const r of search(db, model).filter((r) => isTimesheet(r) && r.employee_id === employeeId && dates.includes(r.date))) {
    const key = `${r.project_id ?? ''}:${r.task_id ?? ''}`;
    const row = rows.get(key) ?? { project_id: r.project_id ?? null, task_id: r.task_id ?? null, days: Array(7).fill(0), total: 0 };
    const hundredths = (n) => Math.round(n * 100) / 100;
    const days = row.days.map((hours, i) => hundredths(hours + (dates[i] === r.date ? Number(r.unit_amount) || 0 : 0)));
    rows.set(key, { ...row, days, total: hundredths(days.reduce((sum, hours) => sum + hours, 0)) });
  }
  return [...rows.values()];
}

/** Return validated time-billed hours per zero-based eligible sale order line. */
export function billableHours(db, saleOrderId) {
  const order = read(db, 'sale.order', saleOrderId);
  if (!order) throw new Error('Sale order not found');
  const lines = search(db, model).filter((r) => isTimesheet(r) && r.validated && r.billable === 'billable_time' && r.so_id === saleOrderId);
  return (order.order_line ?? []).map((line, index) => {
    const product = read(db, 'product', line.product_id);
    return product && product.type !== 'goods' && product.invoice_policy === 'delivery'
      ? lines.filter((r) => r.so_line_index === index).reduce((sum, r) => sum + (Number(r.unit_amount) || 0), 0) : 0;
  });
}

/** Replace eligible service delivered quantities with validated timesheet hours. */
export function syncDelivered(db, saleOrderId) {
  const hours = billableHours(db, saleOrderId);
  const order = read(db, 'sale.order', saleOrderId);
  const order_line = (order.order_line ?? []).map((line, index) => {
    const product = read(db, 'product', line.product_id);
    return product && product.type !== 'goods' && product.invoice_policy === 'delivery' ? { ...line, qty_delivered: hours[index] } : line;
  });
  return write(db, 'sale.order', saleOrderId, { order_line });
}

/** Report logged/billable hours and percentages against inclusive Monday–Friday capacity. */
export function employeeUtilization(db, employeeId, { from, to }, dailyHours = 8) {
  const start = day(from);
  const end = day(to);
  if (end < start) throw new Error('The period end date must not precede its start');
  if (!Number.isFinite(dailyHours) || dailyHours < 0) throw new Error('Daily hours must be a non-negative number');
  const lines = search(db, model).filter((r) => isTimesheet(r) && r.employee_id === employeeId && r.date >= from && r.date <= to);
  const logged = lines.reduce((sum, r) => sum + (Number(r.unit_amount) || 0), 0);
  const billable = lines.filter((r) => ['billable_time', 'billable_fixed'].includes(r.billable)).reduce((sum, r) => sum + (Number(r.unit_amount) || 0), 0);
  let capacity = 0;
  for (let date = start; date <= end; date += 86400000) {
    if (![0, 6].includes(new Date(date).getUTCDay())) capacity += dailyHours;
  }
  return { logged, billable, capacity, utilization: capacity ? round(logged / capacity * 100) : 0, billableRate: logged ? round(billable / logged * 100) : 0 };
}

export const timesheetPlusModels = {
  [model]: {
    ...base,
    fields: {
      ...base.fields,
      validated: { type: 'boolean', label: 'Validated', readonly: true },
      validated_by: { type: 'char', label: 'Validated By', readonly: true },
      validated_on: { type: 'date', label: 'Validated On', readonly: true },
      billable: { type: 'selection', label: 'Billing Type', options: [['billable_time', 'Billable Time'], ['billable_fixed', 'Fixed Price'], ['non_billable', 'Non-billable']] },
      so_id: { type: 'many2one', relation: 'sale.order', label: 'Sale Order' },
      so_line_index: { type: 'integer', label: 'Sale Order Line Index' },
      invoiced: { type: 'boolean', label: 'Invoiced' },
      timer_start: { type: 'char', label: 'Timer Started', readonly: true },
      amount: { ...base.fields.amount, readonly: true },
    },
    defaults: (id) => ({ ...base.defaults(id), validated: false, validated_by: '', validated_on: null, billable: 'non_billable', so_id: null, so_line_index: 0, invoiced: false, timer_start: null }),
    guard: timesheetGuard,
    onchange: (r, key, db) => ({
      ...base.onchange?.(r, key, db),
      ...(isTimesheet(r) && ['unit_amount', 'employee_id'].includes(key) ? { amount: cost(db, r) } : {}),
    }),
    list: [...base.list, 'billable', 'validated', 'amount'],
    form: {
      ...base.form,
      lockedWhen: (r) => !!r.validated || !!base.form.lockedWhen?.(r),
      groups: [...base.form.groups, ['billable', 'so_id', 'so_line_index', 'invoiced'], ['validated', 'validated_by', 'validated_on', 'timer_start']],
      buttons: [
        ...(base.form.buttons ?? []),
        { label: 'Validate', primary: true, when: (r) => isTimesheet(r) && !r.validated && !r.timer_start, run: (db, r) => {
          const user = prompt('Validating user', '');
          return { db: user === null ? db : validateTimesheets(db, [r.id], { user, date: today() }) };
        } },
        { label: 'Reset to Draft', admin: true, when: (r) => isTimesheet(r) && r.validated, run: (db, r) => {
          // Un-validated hours stop counting as delivered on the sales order.
          const reset = write(db, model, r.id, { validated: false, validated_by: '', validated_on: null });
          return { db: r.so_id ? syncDelivered(reset, r.so_id) : reset };
        } },
        { label: 'Start Timer', when: (r) => isTimesheet(r) && !r.validated && !r.timer_start, run: (db, r) => ({ db: write(db, model, r.id, { timer_start: new Date().toISOString(), amount: cost(db, r) }) }) },
        { label: 'Stop Timer', when: (r) => isTimesheet(r) && !!r.timer_start, run: (db, r) => ({ db: stopTimer(db, r.id, new Date().toISOString()) }) },
      ],
    },
  },
};
