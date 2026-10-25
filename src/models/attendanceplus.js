// Attendances depth: kiosk scanning, overtime approval, automatic checkout and reporting.
import { create, read, search, write } from '../orm.js';
import { apps2Models, workedHours } from './apps2.js';

const HOUR = 3600000;
const DAY = 24 * HOUR;
const round = (n) => Math.round(n * 100) / 100;
const modes = [['kiosk', 'Kiosk'], ['manual', 'Manual'], ['systray', 'Systray']];
const defaultRule = { daily_threshold_hours: 8, weekly_threshold_hours: 40, tolerance_minutes: 15, requires_approval: true, rate: 1.5 };
const ruleFor = (db) => search(db, 'hr.attendance.overtime.rule')[0] ?? defaultRule;
const weekend = (date) => [0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay());
const onLeave = (db, employeeId, date) => search(db, 'hr.leave').some((l) => l.employee_id === employeeId && l.state === 'validate' && l.date_from <= date && l.date_to >= date);

function dateValue(date) {
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') || !Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== date) throw new Error('Enter a valid date');
  return ms;
}

function datesBetween(from, to) {
  const start = dateValue(from);
  const end = dateValue(to);
  if (start > end) throw new Error('The end date must not precede the start date');
  const dates = [];
  for (let ms = start; ms <= end; ms += DAY) dates.push(new Date(ms).toISOString().slice(0, 10));
  return dates;
}

// The legacy model stores wall-clock minutes, not instants; offsets do not change its displayed date.
function timestamp(at) {
  if (typeof at !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/.test(at)) throw new Error('Enter a valid ISO date and time');
  const date = at.slice(0, 10);
  dateValue(date);
  return { date, time: at.slice(11, 16), ms: Date.parse(`${at.slice(0, 16)}:00Z`) };
}

const startOf = (r) => Date.parse(`${r.date}T${r.check_in}:00Z`);
const endOf = (r) => Date.parse(`${r.check_out_date || r.date}T${r.check_out}:00Z`);
const hoursOf = (r) => r.check_out_date ? round(Math.max(0, (endOf(r) - startOf(r)) / HOUR)) : workedHours(r);
const attendances = (db, employeeId) => search(db, 'hr.attendance').filter((r) => r.employee_id === employeeId);

function employeeFor(db, employeeId) {
  const employee = read(db, 'hr.employee', employeeId);
  if (!employee || employee.active === false) throw new Error('Employee not found');
  return employee;
}

function openFor(db, employeeId) {
  const open = attendances(db, employeeId).filter((r) => !r.check_out);
  if (open.length > 1) throw new Error('Employee has multiple open attendances; correct them before scanning');
  return open[0];
}

function validMode(mode) {
  if (!modes.some(([key]) => key === mode)) throw new Error('Select a valid attendance mode');
}

/** Open an attendance; return { db, attendanceId, action, employee }. */
export function checkIn(db, employeeId, at, mode = 'manual') {
  const employee = employeeFor(db, employeeId);
  const stamp = timestamp(at);
  validMode(mode);
  if (openFor(db, employeeId)) throw new Error('Employee already has an open attendance');
  if (attendances(db, employeeId).some((r) => r.check_out && endOf(r) > stamp.ms)) throw new Error('Check-in overlaps an existing attendance');
  const created = create(db, 'hr.attendance', { employee_id: employeeId, date: stamp.date, check_in: stamp.time, check_in_mode: mode });
  return { db: created.db, attendanceId: created.id, action: 'check_in', employee };
}

/** Close the employee's open attendance, preserving overnight duration. */
export function checkOut(db, employeeId, at, mode = 'manual') {
  const employee = employeeFor(db, employeeId);
  const stamp = timestamp(at);
  validMode(mode);
  const open = openFor(db, employeeId);
  if (!open) throw new Error('Employee has no open attendance');
  if (stamp.ms <= startOf(open)) throw new Error('Check-out must be after check-in');
  let next = write(db, 'hr.attendance', open.id, { check_out: stamp.time, check_out_date: stamp.date, check_out_mode: mode });
  if (!ruleFor(db).requires_approval) {
    next = write(next, 'hr.attendance', open.id, { overtime_status: 'approved', validated_overtime: proposedOvertime(next, read(next, 'hr.attendance', open.id)) });
  }
  return { db: next, attendanceId: open.id, action: 'check_out', employee };
}

/** Toggle attendance using exactly one employee PIN or badge barcode. */
export function kioskScan(db, { pin, barcode }, at) {
  const credentials = [pin, barcode].filter((v) => v != null && String(v) !== '');
  if (credentials.length !== 1) throw new Error('Scan one badge or enter one PIN');
  const matches = search(db, 'hr.employee').filter((e) => pin != null && String(pin) !== ''
    ? e.pin != null && String(e.pin) === String(pin)
    : [e.badge_id, e.barcode].some((v) => v != null && String(v) === String(barcode)));
  if (matches.length !== 1) throw new Error(matches.length ? 'Badge or PIN matches multiple employees' : 'Unknown badge or PIN');
  return openFor(db, matches[0].id) ? checkOut(db, matches[0].id, at, 'kiosk') : checkIn(db, matches[0].id, at, 'kiosk');
}

function workedOn(records, date) {
  const start = dateValue(date);
  return records.filter((r) => r.check_out).reduce((sum, r) => sum + Math.max(0, Math.min(endOf(r), start + DAY) - Math.max(startOf(r), start)) / HOUR, 0);
}

const tolerated = (hours, rule) => hours > 0 && hours * 60 >= Number(rule.tolerance_minutes) ? round(hours) : 0;
const weekStart = (date) => {
  const ms = dateValue(date);
  const weekday = new Date(ms).getUTCDay();
  return new Date(ms - ((weekday + 6) % 7) * DAY).toISOString().slice(0, 10);
};

/** Daily and Monday-based weekly overtime; total never counts the same hours twice. */
export function overtimeFor(db, employeeId, { from, to }) {
  employeeFor(db, employeeId);
  return overtimeSummary(db, employeeId, attendances(db, employeeId), { from, to });
}

function overtimeSummary(db, employeeId, records, { from, to }) {
  const rule = ruleFor(db);
  const daily = datesBetween(from, to).map((date) => {
    const worked = workedOn(records, date);
    const expected = weekend(date) || onLeave(db, employeeId, date) ? 0 : Number(rule.daily_threshold_hours);
    return { date, worked: round(worked), expected, overtime: tolerated(Math.max(0, worked - expected), rule) };
  });
  const weeks = new Map();
  for (const day of daily) {
    const key = weekStart(day.date);
    weeks.set(key, [...(weeks.get(key) ?? []), day]);
  }
  const weekly = [...weeks].map(([from, days]) => {
    const worked = round(days.reduce((sum, d) => sum + workedOn(records, d.date), 0));
    const dailyOvertime = round(days.reduce((sum, d) => sum + d.overtime, 0));
    return { from, to: days.at(-1).date, worked, expected: Number(rule.weekly_threshold_hours), overtime: Math.max(dailyOvertime, tolerated(Math.max(0, worked - Number(rule.weekly_threshold_hours)), rule)) };
  });
  return { daily, weekly, total: round(weekly.reduce((sum, w) => sum + w.overtime, 0)) };
}

// Attribute threshold crossings in chronological order, including split shifts and weekly excess.
function proposedOvertime(db, attendance) {
  const records = attendances(db, attendance.employee_id).filter((r) => r.check_out)
    .sort((a, b) => startOf(a) - startOf(b) || a.id - b.id);
  const index = records.findIndex((r) => r.id === attendance.id);
  const period = { from: weekStart(attendance.date), to: attendance.check_out_date || attendance.date };
  const total = (rows) => overtimeSummary(db, attendance.employee_id, rows, period).total;
  return round(Math.min(hoursOf(attendance), Math.max(0, total(records.slice(0, index + 1)) - total(records.slice(0, index)))));
}

function closedAttendance(db, attendanceId) {
  const attendance = read(db, 'hr.attendance', attendanceId);
  if (!attendance) throw new Error('Attendance not found');
  if (!attendance.check_out) throw new Error('Check out before reviewing overtime');
  return attendance;
}

/** Approve a nonnegative number of overtime hours, bounded by the attendance duration. */
export function approveOvertime(db, attendanceId, hours) {
  const attendance = closedAttendance(db, attendanceId);
  if (typeof hours !== 'number' || !Number.isFinite(hours) || hours < 0 || hours > hoursOf(attendance)) throw new Error('Approved overtime must be between zero and worked hours');
  return write(db, 'hr.attendance', attendanceId, { overtime_status: 'approved', validated_overtime: round(hours) });
}

/** Refuse overtime and clear any previously approved hours. */
export function refuseOvertime(db, attendanceId) {
  closedAttendance(db, attendanceId);
  return write(db, 'hr.attendance', attendanceId, { overtime_status: 'refused', validated_overtime: 0 });
}

/** Close overdue open attendances at the hour limit and flag them for review. */
export function autoCheckout(db, at, maxHours = 12) {
  const stamp = timestamp(at);
  if (!Number.isFinite(maxHours) || maxHours <= 0) throw new Error('Maximum attendance hours must be positive');
  return search(db, 'hr.attendance').filter((r) => !r.check_out && stamp.ms - startOf(r) > maxHours * HOUR).reduce((next, r) => {
    const end = new Date(startOf(r) + maxHours * HOUR).toISOString();
    const closed = checkOut(next, r.employee_id, end, 'manual');
    return write(closed.db, 'hr.attendance', r.id, { out_of_hours: true });
  }, db);
}

/** Per-employee attendance days, hours, late days and unexplained working-day absences. */
export function attendanceReport(db, { from, to }) {
  const dates = datesBetween(from, to);
  return search(db, 'hr.employee').map((employee) => {
    const records = attendances(db, employee.id);
    const summary = overtimeFor(db, employee.id, { from, to });
    const present = dates.filter((date) => records.some((r) => r.date === date) || workedOn(records, date) > 0);
    const late = dates.filter((date) => {
      const starts = records.filter((r) => r.date === date).map((r) => r.check_in).sort();
      return starts.length && starts[0] > '09:15';
    }).length;
    return { employee_id: employee.id, name: employee.name, days: present.length,
      worked: round(dates.reduce((sum, date) => sum + workedOn(records, date), 0)), expected: round(summary.daily.reduce((sum, d) => sum + d.expected, 0)), overtime: summary.total, late,
      absences: dates.filter((date) => !weekend(date) && !present.includes(date) && !onLeave(db, employee.id, date)).length };
  });
}

/** Actual attendance days/hours and approved overtime eligible for payroll. */
export function workedDaysForPayslip(db, employeeId, { from, to }) {
  const report = attendanceReport(db, { from, to }).find((r) => r.employee_id === employeeFor(db, employeeId).id);
  const overtimeHours = attendances(db, employeeId).filter((r) => r.date >= from && r.date <= to && r.check_out && r.overtime_status === 'approved')
    .reduce((sum, r) => sum + Number(r.validated_overtime || 0), 0);
  return { days: report.days, hours: report.worked, overtimeHours: round(overtimeHours) };
}

const base = apps2Models['hr.attendance'];
export const attendancePlusModels = {
  'hr.attendance': {
    ...base,
    fields: {
      ...base.fields,
      check_out_date: { type: 'date', label: 'Check Out Date' },
      worked_hours: { ...base.fields.worked_hours, compute: hoursOf },
      overtime: { ...base.fields.overtime, compute: (r) => r.check_out ? round(hoursOf(r) - 8) : 0 },
      check_in_mode: { type: 'selection', label: 'Check In Mode', options: modes },
      check_out_mode: { type: 'selection', label: 'Check Out Mode', options: modes },
      in_latitude: { type: 'float', label: 'Check In Latitude' },
      in_longitude: { type: 'float', label: 'Check In Longitude' },
      overtime_status: { type: 'selection', label: 'Overtime Status', tracking: true, options: [['to_approve', 'To Approve'], ['approved', 'Approved'], ['refused', 'Refused']] },
      validated_overtime: { type: 'float', label: 'Approved Overtime', readonly: true },
      out_of_hours: { type: 'boolean', label: 'Out of Hours', readonly: true },
    },
    defaults: () => ({ ...base.defaults(), check_in_mode: 'manual', check_out_mode: 'manual', overtime_status: 'to_approve', validated_overtime: 0, out_of_hours: false }),
    guard: (db, before, r) => !r.check_out && attendances(db, r.employee_id).some((a) => a.id !== r.id && !a.check_out) ? 'Employee already has an open attendance' : null,
    list: [...base.list, 'overtime_status', 'validated_overtime', 'out_of_hours'],
    form: {
      ...base.form,
      buttons: [
        { label: 'Approve Overtime', primary: true, when: (r) => !!r.check_out && r.overtime_status === 'to_approve', run: (db, r) => ({ db: approveOvertime(db, r.id, proposedOvertime(db, r)) }) },
        { label: 'Refuse Overtime', when: (r) => !!r.check_out && r.overtime_status !== 'refused', run: (db, r) => ({ db: refuseOvertime(db, r.id) }) },
      ],
      groups: [...base.form.groups, ['check_out_date', 'check_in_mode', 'check_out_mode'], ['in_latitude', 'in_longitude'], ['overtime_status', 'validated_overtime', 'out_of_hours']],
    },
  },
  'hr.attendance.overtime.rule': {
    label: 'Overtime Rules',
    fields: {
      name: { type: 'char', label: 'Name', required: true },
      daily_threshold_hours: { type: 'float', label: 'Daily Threshold (hours)' },
      weekly_threshold_hours: { type: 'float', label: 'Weekly Threshold (hours)' },
      tolerance_minutes: { type: 'float', label: 'Tolerance (minutes)' },
      requires_approval: { type: 'boolean', label: 'Requires Approval' },
      rate: { type: 'float', label: 'Overtime Rate' },
    },
    defaults: () => ({ name: 'Standard Overtime', ...defaultRule }),
    guard: (db, before, r) => ['daily_threshold_hours', 'weekly_threshold_hours', 'tolerance_minutes', 'rate'].some((key) => !Number.isFinite(Number(r[key])) || Number(r[key]) < 0) ? 'Overtime thresholds, tolerance and rate must be nonnegative numbers' : null,
    list: ['name', 'daily_threshold_hours', 'weekly_threshold_hours', 'tolerance_minutes', 'requires_approval', 'rate'],
    form: { title: 'name', groups: [['daily_threshold_hours', 'weekly_threshold_hours'], ['tolerance_minutes', 'requires_approval', 'rate']] },
  },
};
