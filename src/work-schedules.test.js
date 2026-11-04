import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, emptyDb, read } from './orm.js';
import { seed } from './seed.js';
import {
  calendarFor,
  isWorkingDay,
  workingHours,
  workingHoursForDay,
  standard40AttendanceLines,
} from './models/calendar.js';
import { leaveDuration } from './models/timeoff.js';

test('helper: full days schedule calculates working days and hours', () => {
  let db = emptyDb();
  // 5 full days (Mon-Fri), 8 hours/day from 09:00 to 17:00
  const lines = [0, 1, 2, 3, 4].map((d) => ({
    dayofweek: String(d),
    day_period: 'full_day',
    hour_from: 9,
    hour_to: 17,
    duration_hours: 8,
  }));
  const calRes = create(db, 'resource.calendar', {
    name: 'Full Days 40h',
    attendance_ids: lines,
    hours_per_day: 8,
    hours_per_week: 40,
    calendar_type: 'fixed',
  });
  db = calRes.db;
  const calendar = read(db, 'resource.calendar', calRes.id);

  // 2026-11-02 is Monday, 2026-11-06 is Friday
  assert.equal(isWorkingDay(calendar, '2026-11-02', db), true);
  assert.equal(isWorkingDay(calendar, '2026-11-06', db), true);
  assert.equal(isWorkingDay(calendar, '2026-11-07', db), false); // Saturday
  assert.equal(isWorkingDay(calendar, '2026-11-08', db), false); // Sunday

  assert.equal(workingHoursForDay(calendar, '2026-11-02', db), 8);
  assert.equal(workingHoursForDay(calendar, '2026-11-07', db), 0);

  // Monday to Friday = 40 hours
  assert.equal(workingHours(calendar, '2026-11-02', '2026-11-06', db), 40);
  // Friday to Sunday = 8 hours
  assert.equal(workingHours(calendar, '2026-11-06', '2026-11-08', db), 8);
});

test('helper: half-day morning and afternoon periods sum correctly', () => {
  let db = emptyDb();
  // Standard split: morning 08:00-12:00 (4h), afternoon 13:00-17:00 (4h)
  const lines = standard40AttendanceLines();
  assert.equal(lines.length, 10);
  const calRes = create(db, 'resource.calendar', {
    name: 'Standard Split 40h',
    attendance_ids: lines,
    hours_per_day: 8,
    hours_per_week: 40,
    calendar_type: 'fixed',
  });
  db = calRes.db;
  const calendar = read(db, 'resource.calendar', calRes.id);

  assert.equal(isWorkingDay(calendar, '2026-11-02', db), true);
  assert.equal(workingHoursForDay(calendar, '2026-11-02', db), 8);
  assert.equal(workingHours(calendar, '2026-11-02', '2026-11-06', db), 40);
});

test('helper: 4-day week excludes non-working weekdays', () => {
  let db = emptyDb();
  // Mon-Thu: 10h/day = 40h/week. Friday is off.
  const lines = [0, 1, 2, 3].map((d) => ({
    dayofweek: String(d),
    day_period: 'full_day',
    hour_from: 8,
    hour_to: 18,
    duration_hours: 10,
  }));
  const calRes = create(db, 'resource.calendar', {
    name: '4-Day Week 40h',
    attendance_ids: lines,
    hours_per_day: 10,
    hours_per_week: 40,
    calendar_type: 'fixed',
  });
  db = calRes.db;
  const calendar = read(db, 'resource.calendar', calRes.id);

  assert.equal(isWorkingDay(calendar, '2026-11-02', db), true); // Mon
  assert.equal(isWorkingDay(calendar, '2026-11-05', db), true); // Thu
  assert.equal(isWorkingDay(calendar, '2026-11-06', db), false); // Fri
  assert.equal(isWorkingDay(calendar, '2026-11-07', db), false); // Sat

  assert.equal(workingHoursForDay(calendar, '2026-11-05', db), 10);
  assert.equal(workingHoursForDay(calendar, '2026-11-06', db), 0);
  assert.equal(workingHours(calendar, '2026-11-02', '2026-11-08', db), 40);
});

test('helper: public holidays subtract working days and hours unless count_as working_time', () => {
  let db = emptyDb();
  const lines = standard40AttendanceLines();
  const calRes = create(db, 'resource.calendar', {
    name: 'Standard',
    attendance_ids: lines,
    hours_per_day: 8,
    hours_per_week: 40,
    calendar_type: 'fixed',
    company_id: 1,
  });
  db = calRes.db;
  const calendar = read(db, 'resource.calendar', calRes.id);

  // 2026-11-04 is Wednesday. Add a public holiday on that date.
  db = create(db, 'resource.calendar.leaves', {
    name: 'National Holiday',
    company_id: 1,
    calendar_id: null, // applies to all company calendars
    date_from: '2026-11-04',
    date_to: '2026-11-04',
    count_as: 'absence',
  }).db;

  assert.equal(isWorkingDay(calendar, '2026-11-03', db), true); // Tue
  assert.equal(isWorkingDay(calendar, '2026-11-04', db), false); // Wed is public holiday!
  assert.equal(workingHoursForDay(calendar, '2026-11-04', db), 0);
  // Mon-Fri: 5 days - 1 holiday = 4 working days = 32 hours
  assert.equal(workingHours(calendar, '2026-11-02', '2026-11-06', db), 32);

  // If a holiday is set to count_as 'working_time', it does not subtract working time
  db = create(db, 'resource.calendar.leaves', {
    name: 'Special Working Event',
    company_id: 1,
    calendar_id: null,
    date_from: '2026-11-05',
    date_to: '2026-11-05',
    count_as: 'working_time',
  }).db;
  assert.equal(isWorkingDay(calendar, '2026-11-05', db), true);
  assert.equal(workingHoursForDay(calendar, '2026-11-05', db), 8);
});

test('time off duration excludes weekends and public holidays', () => {
  let db = emptyDb();
  const calRes = create(db, 'resource.calendar', {
    name: 'Standard',
    attendance_ids: standard40AttendanceLines(),
    hours_per_day: 8,
    hours_per_week: 40,
    calendar_type: 'fixed',
    company_id: 1,
  });
  db = calRes.db;
  const empRes = create(db, 'hr.employee', {
    name: 'Ahmad',
    company_id: 1,
    resource_calendar_id: calRes.id,
  });
  db = empRes.db;

  // Add a public holiday on Monday 2026-11-09
  db = create(db, 'resource.calendar.leaves', {
    name: 'Public Holiday Monday',
    company_id: 1,
    calendar_id: null,
    date_from: '2026-11-09',
    date_to: '2026-11-09',
    count_as: 'absence',
  }).db;

  // Leave request from Friday 2026-11-06 to Tuesday 2026-11-10 (5 calendar days)
  // Fri 11-06: working day (1 day, 8h)
  // Sat 11-07: weekend (0)
  // Sun 11-08: weekend (0)
  // Mon 11-09: public holiday (0)
  // Tue 11-10: working day (1 day, 8h)
  // Total: 2 days, 16 hours.
  const leave = {
    employee_id: empRes.id,
    request_date_from: '2026-11-06',
    request_date_to: '2026-11-10',
    request_unit: 'day',
    company_id: 1,
  };
  const duration = leaveDuration(db, leave);
  assert.equal(duration.number_of_days, 2);
  assert.equal(duration.number_of_hours, 16);
});

test('per-employee calendar customizes schedule and time off duration', () => {
  let db = emptyDb();
  const stdCal = create(db, 'resource.calendar', {
    name: 'Standard 5-Day',
    attendance_ids: standard40AttendanceLines(),
    hours_per_day: 8,
    hours_per_week: 40,
    company_id: 1,
  });
  db = stdCal.db;

  // Custom 4-day calendar (Mon-Thu, 8h/day, Fri off)
  const fourDayCal = create(db, 'resource.calendar', {
    name: '4-Day Mon-Thu',
    attendance_ids: [0, 1, 2, 3].map((d) => ({
      dayofweek: String(d),
      day_period: 'full_day',
      hour_from: 9,
      hour_to: 17,
      duration_hours: 8,
    })),
    hours_per_day: 8,
    hours_per_week: 32,
    company_id: 1,
  });
  db = fourDayCal.db;

  // Employee 1 has custom 4-day calendar
  const emp1 = create(db, 'hr.employee', {
    name: 'Employee 4-Day',
    company_id: 1,
    resource_calendar_id: fourDayCal.id,
  });
  db = emp1.db;

  // Employee 2 uses standard calendar
  const emp2 = create(db, 'hr.employee', {
    name: 'Employee 5-Day',
    company_id: 1,
    resource_calendar_id: stdCal.id,
  });
  db = emp2.db;

  // Both ask for time off on Friday 2026-11-06
  const leave1 = { employee_id: emp1.id, request_date_from: '2026-11-06', request_date_to: '2026-11-06', request_unit: 'day', company_id: 1 };
  const leave2 = { employee_id: emp2.id, request_date_from: '2026-11-06', request_date_to: '2026-11-06', request_unit: 'day', company_id: 1 };

  assert.equal(leaveDuration(db, leave1).number_of_days, 0); // Friday is off for Emp1
  assert.equal(leaveDuration(db, leave2).number_of_days, 1); // Friday is working day for Emp2
});

test('seeded default calendar exists for company and employees', () => {
  const db = seed();
  const calendars = db.records['resource.calendar'] ?? [];
  assert.ok(calendars.length >= 1, 'At least one calendar is seeded');
  const std = calendars.find((c) => c.name === 'Standard 40 hours/week');
  assert.ok(std, 'Standard 40 hours/week calendar is seeded');
  assert.equal(std.hours_per_day, 8);
  assert.equal(std.hours_per_week, 40);
  assert.equal(std.attendance_ids.length, 10);

  const company = (db.records['res.company'] ?? [])[0];
  assert.ok(company.resource_calendar_id, 'Company has resource_calendar_id');
  assert.equal(company.resource_calendar_id, std.id);

  const employees = db.records['hr.employee'] ?? [];
  assert.ok(employees.length > 0);
  for (const emp of employees) {
    const cal = calendarFor(db, emp.id);
    assert.ok(cal, `Employee ${emp.name} has a resolved calendar`);
    assert.equal(cal.id, std.id);
  }
});
