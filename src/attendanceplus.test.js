import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from './orm.js';
import { seed } from './seed.js';
import { attendancePlusModels, kioskScan, checkIn, checkOut, overtimeFor, approveOvertime, refuseOvertime, autoCheckout, attendanceReport, workedDaysForPayslip } from './models/attendanceplus.js';

const period = { from: '2025-01-06', to: '2025-01-12' };
const setup = () => {
  const { db, id } = create(seed(), 'hr.employee', { name: 'Attendance Tester', pin: '0071', badge_id: 'BADGE-71' });
  return { db: create(db, 'hr.leave.allocation', { employee_id: id, name: 'Test Allocation', leave_type: 'paid', number_of_days: 10, state: 'validate' }).db, id };
};
const shift = (db, employeeId, date, start = '09:00', end = '17:00') => checkOut(checkIn(db, employeeId, `${date}T${start}`, 'systray').db, employeeId, `${date}T${end}`, 'systray');

test('attendance seed and legacy computes, filters and views remain available', () => {
  const db = seed();
  assert.equal(search(db, 'hr.attendance').length, 3);
  assert.equal(read(db, 'hr.attendance', 1).worked_hours, 8.17);
  assert.equal(read(db, 'hr.attendance', 2).overtime, -0.5);
  const model = attendancePlusModels['hr.attendance'];
  assert.deepEqual(model.views, ['list', 'kanban', 'pivot', 'graph']);
  assert.ok(model.filters[0].find((f) => f.id === 'open').fn(read(db, 'hr.attendance', 3)));
  assert.ok(model.list.includes('overtime_status'));
  const rule = create(db, 'hr.attendance.overtime.rule', {});
  assert.equal(read(rule.db, 'hr.attendance.overtime.rule', rule.id).rate, 1.5);
  assert.throws(() => create(db, 'hr.attendance.overtime.rule', { tolerance_minutes: -1 }), /nonnegative/);
});

test('PIN and badge scans toggle the same employee immutably with kiosk modes', () => {
  const { db, id } = setup();
  const before = structuredClone(db);
  const entry = kioskScan(db, { pin: '0071' }, '2025-01-06T09:00:00Z');
  assert.equal(entry.action, 'check_in');
  assert.equal(entry.employee.id, id);
  assert.equal(read(entry.db, 'hr.attendance', entry.attendanceId).check_in_mode, 'kiosk');
  const exit = kioskScan(entry.db, { barcode: 'BADGE-71' }, '2025-01-06T17:30:00Z');
  assert.equal(exit.action, 'check_out');
  assert.equal(exit.attendanceId, entry.attendanceId);
  assert.equal(read(exit.db, 'hr.attendance', exit.attendanceId).worked_hours, 8.5);
  assert.equal(read(exit.db, 'hr.attendance', exit.attendanceId).check_out_mode, 'kiosk');
  const second = kioskScan(exit.db, { barcode: 'BADGE-71' }, '2025-01-07T09:00');
  assert.equal(second.action, 'check_in');
  assert.equal(kioskScan(second.db, { pin: '0071' }, '2025-01-07T17:00').action, 'check_out');
  assert.deepEqual(db, before);
  assert.equal(read(entry.db, 'hr.attendance', entry.attendanceId).check_out, undefined);
});

test('unknown, empty and ambiguous credentials, invalid times and double opens are refused', () => {
  const { db, id } = setup();
  assert.throws(() => kioskScan(db, { barcode: 'UNKNOWN' }, '2025-01-06T09:00'), /Unknown/);
  assert.throws(() => kioskScan(db, {}, '2025-01-06T09:00'), /one badge/);
  assert.throws(() => kioskScan(db, { pin: '0071', barcode: 'BADGE-71' }, '2025-01-06T09:00'), /one badge/);
  const duplicate = create(db, 'hr.employee', { name: 'Duplicate', pin: '0071' }).db;
  assert.throws(() => kioskScan(duplicate, { pin: '0071' }, '2025-01-06T09:00'), /multiple employees/);
  assert.throws(() => checkIn(db, id, '2025-02-30T09:00'), /valid date/);
  assert.throws(() => checkIn(db, id, '2025-01-06T25:00'), /valid ISO/);
  assert.throws(() => checkIn(db, id, '2025-01-06T09:00', 'invalid'), /valid attendance mode/);
  assert.throws(() => checkOut(db, id, '2025-01-06T10:00'), /no open/);
  const opened = checkIn(db, id, '2025-01-06T09:00');
  assert.throws(() => checkIn(opened.db, id, '2025-01-06T10:00'), /already.*open/);
  assert.throws(() => create(opened.db, 'hr.attendance', { employee_id: id, date: '2025-01-07', check_in: '09:00' }), /already.*open/);
  assert.throws(() => checkOut(opened.db, id, '2025-01-06T08:59'), /after check-in/);
  const corrupt = { ...opened.db, records: { ...opened.db.records, 'hr.attendance': [...opened.db.records['hr.attendance'], { employee_id: id, date: '2025-01-06', check_in: '10:00', id: 999 }] } };
  assert.throws(() => kioskScan(corrupt, { pin: '0071' }, '2025-01-06T18:00'), /multiple open/);
});

test('worked hours aggregate split shifts and retain overnight checkouts across midnight', () => {
  const { db, id } = setup();
  const morning = shift(db, id, '2025-01-06', '09:00', '12:00');
  const afternoon = shift(morning.db, id, '2025-01-06', '13:00', '18:00');
  assert.equal(overtimeFor(afternoon.db, id, period).daily[0].worked, 8);
  const night = checkIn(afternoon.db, id, '2025-01-07T22:00');
  const closed = checkOut(night.db, id, '2025-01-08T06:00');
  assert.equal(read(closed.db, 'hr.attendance', closed.attendanceId).worked_hours, 8);
  const days = overtimeFor(closed.db, id, period).daily;
  assert.equal(days[1].worked, 2);
  assert.equal(days[2].worked, 6);
  assert.throws(() => checkIn(closed.db, id, '2025-01-08T05:00'), /overlaps/);
});

test('daily overtime uses tolerance, approved leave and weekend expectations without double counting', () => {
  let { db, id } = setup();
  db = create(db, 'hr.attendance.overtime.rule', {}).db;
  db = create(db, 'hr.leave', { employee_id: id, date_from: '2025-01-08', date_to: '2025-01-08', state: 'validate' }).db;
  for (const [date, end] of [['2025-01-06', '17:10'], ['2025-01-07', '17:15'], ['2025-01-08', '11:00'], ['2025-01-11', '12:00']]) db = shift(db, id, date, '09:00', end).db;
  const overtime = overtimeFor(db, id, period);
  assert.deepEqual(overtime.daily[0], { date: '2025-01-06', worked: 8.17, expected: 8, overtime: 0 });
  assert.equal(overtime.daily[1].overtime, 0.25);
  assert.deepEqual(overtime.daily[2], { date: '2025-01-08', worked: 2, expected: 0, overtime: 2 });
  assert.equal(overtime.daily[5].overtime, 3);
  assert.equal(overtime.total, 5.25);
  assert.equal(overtime.weekly.length, 1);
});

test('weekly thresholds add only overtime not already included in daily excess', () => {
  let { db, id } = setup();
  db = create(db, 'hr.attendance.overtime.rule', { weekly_threshold_hours: 35 }).db;
  for (const date of ['2025-01-06', '2025-01-07', '2025-01-08', '2025-01-09', '2025-01-10']) db = shift(db, id, date).db;
  const overtime = overtimeFor(db, id, period);
  assert.equal(overtime.daily.reduce((sum, d) => sum + d.overtime, 0), 0);
  assert.equal(overtime.weekly[0].worked, 40);
  assert.equal(overtime.total, 5);
  db = shift(db, id, '2025-01-11', '09:00', '11:00').db;
  assert.equal(overtimeFor(db, id, period).total, 7);
  assert.equal(overtimeFor(db, id, { from: '2025-01-13', to: '2025-01-19' }).total, 0);
  assert.throws(() => overtimeFor(db, id, { from: period.to, to: period.from }), /end date/);
});

test('weekly tolerance is applied before rounding individual daily hours', () => {
  let { db, id } = setup();
  for (const [date, end] of [['2025-01-06', '17:05'], ['2025-01-07', '17:05'], ['2025-01-08', '17:05'], ['2025-01-09', '17:00'], ['2025-01-10', '17:00']]) db = shift(db, id, date, '09:00', end).db;
  assert.equal(overtimeFor(db, id, period).total, 0.25);
  assert.equal(attendanceReport(db, period).find((r) => r.employee_id === id).worked, 40.25);
});

test('approval and refusal store reviewed hours, reject invalid actions and expose form actions', () => {
  const { db, id } = setup();
  const opened = checkIn(db, id, '2025-01-06T09:00');
  assert.throws(() => approveOvertime(opened.db, opened.attendanceId, 1), /Check out/);
  assert.throws(() => refuseOvertime(db, 999), /not found/);
  const closed = checkOut(opened.db, id, '2025-01-06T19:00');
  for (const hours of [-1, NaN, Infinity, 11]) assert.throws(() => approveOvertime(closed.db, closed.attendanceId, hours), /between zero/);
  const approved = approveOvertime(closed.db, closed.attendanceId, 1.5);
  assert.equal(read(approved, 'hr.attendance', closed.attendanceId).validated_overtime, 1.5);
  assert.equal(read(closed.db, 'hr.attendance', closed.attendanceId).overtime_status, 'to_approve');
  const refused = refuseOvertime(approved, closed.attendanceId);
  assert.equal(read(refused, 'hr.attendance', closed.attendanceId).overtime_status, 'refused');
  assert.equal(read(refused, 'hr.attendance', closed.attendanceId).validated_overtime, 0);
  const buttons = attendancePlusModels['hr.attendance'].form.buttons;
  const accepted = buttons.find((b) => b.label === 'Approve Overtime').run(closed.db, read(closed.db, 'hr.attendance', closed.attendanceId)).db;
  assert.equal(read(accepted, 'hr.attendance', closed.attendanceId).validated_overtime, 2);
  assert.equal(buttons.find((b) => b.label === 'Refuse Overtime').run(accepted, read(accepted, 'hr.attendance', closed.attendanceId)).db.records['hr.attendance'].at(-1).overtime_status, 'refused');
});

test('rules without approval automatically validate qualifying overtime on checkout', () => {
  const { db, id } = setup();
  const configured = create(db, 'hr.attendance.overtime.rule', { requires_approval: false }).db;
  const closed = shift(configured, id, '2025-01-06', '09:00', '18:00');
  assert.equal(read(closed.db, 'hr.attendance', closed.attendanceId).overtime_status, 'approved');
  assert.equal(read(closed.db, 'hr.attendance', closed.attendanceId).validated_overtime, 1);
});

test('automatic approval and form proposals attribute weekly excess to the threshold-crossing shift', () => {
  let { db, id } = setup();
  db = create(db, 'hr.attendance.overtime.rule', { weekly_threshold_hours: 35, requires_approval: false }).db;
  for (const date of ['2025-01-06', '2025-01-07', '2025-01-08', '2025-01-09', '2025-01-10']) db = shift(db, id, date).db;
  assert.deepEqual(workedDaysForPayslip(db, id, period), { days: 5, hours: 40, overtimeHours: 5 });
  const friday = search(db, 'hr.attendance').find((r) => r.employee_id === id && r.date === '2025-01-10');
  assert.equal(friday.overtime_status, 'approved');
  assert.equal(friday.validated_overtime, 5);
  const button = attendancePlusModels['hr.attendance'].form.buttons.find((b) => b.label === 'Approve Overtime');
  assert.throws(() => button.run(db, friday), /not available/);
});

test('automatic checkout caps long shifts across midnight, flags them and is repeatable', () => {
  const { db, id } = setup();
  const opened = checkIn(db, id, '2025-01-06T18:00');
  const exact = autoCheckout(opened.db, '2025-01-07T06:00');
  assert.equal(read(exact, 'hr.attendance', opened.attendanceId).check_out, undefined);
  const closed = autoCheckout(opened.db, '2025-01-07T07:00');
  const attendance = read(closed, 'hr.attendance', opened.attendanceId);
  assert.equal(attendance.check_out, '06:00');
  assert.equal(attendance.check_out_date, '2025-01-07');
  assert.equal(attendance.worked_hours, 12);
  assert.equal(attendance.out_of_hours, true);
  assert.equal(read(opened.db, 'hr.attendance', opened.attendanceId).out_of_hours, false);
  assert.deepEqual(autoCheckout(closed, '2025-01-07T07:00'), closed);
  assert.throws(() => autoCheckout(db, '2025-01-07T07:00', 0), /positive/);
});

test('reports count late first check-ins, absences and approved leave; payroll uses only approved overtime', () => {
  let { db, id } = setup();
  const monday = shift(db, id, '2025-01-06', '09:16', '18:16');
  db = approveOvertime(monday.db, monday.attendanceId, 1);
  db = shift(db, id, '2025-01-07', '09:15', '12:00').db;
  db = shift(db, id, '2025-01-07', '13:00', '18:15').db;
  db = create(db, 'hr.leave', { employee_id: id, date_from: '2025-01-08', date_to: '2025-01-08', state: 'validate' }).db;
  db = create(db, 'hr.leave', { employee_id: id, date_from: '2025-01-09', date_to: '2025-01-09', state: 'confirm' }).db;
  db = create(db, 'hr.leave', { employee_id: id, date_from: '2025-01-10', date_to: '2025-01-10', state: 'refuse' }).db;
  const report = attendanceReport(db, period).find((r) => r.employee_id === id);
  assert.deepEqual(report, { employee_id: id, name: 'Attendance Tester', days: 2, worked: 17, expected: 32, overtime: 1, late: 1, absences: 2 });
  assert.deepEqual(workedDaysForPayslip(db, id, period), { days: 2, hours: 17, overtimeHours: 1 });
  assert.deepEqual(workedDaysForPayslip(refuseOvertime(db, monday.attendanceId), id, period), { days: 2, hours: 17, overtimeHours: 0 });
  assert.throws(() => workedDaysForPayslip(db, 999, period), /Employee not found/);
});
