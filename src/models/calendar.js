// Resource calendar, attendance lines, and public holidays / closures.
import { create, read, write } from '../orm.js';
import { today } from './common.js';

export function standard40AttendanceLines() {
  const lines = [];
  for (let d = 0; d < 5; d++) {
    lines.push({
      dayofweek: String(d),
      day_period: 'morning',
      hour_from: 8,
      hour_to: 12,
      duration_hours: 4,
    });
    lines.push({
      dayofweek: String(d),
      day_period: 'afternoon',
      hour_from: 13,
      hour_to: 17,
      duration_hours: 4,
    });
  }
  return lines;
}

export function standard40Calendar(companyId = 1) {
  return {
    id: 1,
    name: 'Standard 40 hours/week',
    company_id: companyId,
    active: true,
    calendar_type: 'fixed',
    hours_per_day: 8,
    hours_per_week: 40,
    full_time_required_hours: 40,
    work_time_rate: 100,
    attendance_ids: standard40AttendanceLines(),
    leave_ids: [],
  };
}

export function getAttendances(calendar, db) {
  if (!calendar) return standard40AttendanceLines();
  if (Array.isArray(calendar.attendance_ids) && calendar.attendance_ids.length > 0) {
    return calendar.attendance_ids;
  }
  if (calendar.id && db?.records?.['resource.calendar.attendance']) {
    const lines = db.records['resource.calendar.attendance'].filter((a) => a.calendar_id === calendar.id);
    if (lines.length > 0) return lines;
  }
  return standard40AttendanceLines();
}

export function isPublicHoliday(calendar, date, db) {
  if (!db?.records?.['resource.calendar.leaves']) return false;
  const d = typeof date === 'string' ? date.slice(0, 10) : date;
  const calCompany = calendar?.company_id ?? 1;
  const leaves = db.records['resource.calendar.leaves'];
  return leaves.some((l) => {
    if (l.count_as === 'working_time') return false;
    const start = (l.date_from || '').slice(0, 10);
    const end = (l.date_to || '').slice(0, 10);
    if (!start || !end || d < start || d > end) return false;
    if (l.company_id && l.company_id !== calCompany) return false;
    if (l.calendar_id && calendar?.id && l.calendar_id !== calendar.id) return false;
    return true;
  });
}

export function isWorkingDay(calendar, date, db) {
  const cal = typeof calendar === 'number' && db ? read(db, 'resource.calendar', calendar) : calendar;
  if (isPublicHoliday(cal, date, db)) return false;
  const jsDay = new Date(`${date}T00:00:00Z`).getUTCDay();
  const odooDay = String((jsDay + 6) % 7);
  const attendances = getAttendances(cal, db).filter((a) => String(a.dayofweek) === odooDay);
  return attendances.length > 0;
}

export function workingHoursForDay(calendar, date, db, fallbackHours) {
  const cal = typeof calendar === 'number' && db ? read(db, 'resource.calendar', calendar) : calendar;
  if (!isWorkingDay(cal, date, db)) return 0;
  const jsDay = new Date(`${date}T00:00:00Z`).getUTCDay();
  const odooDay = String((jsDay + 6) % 7);
  const attendances = getAttendances(cal, db).filter((a) => String(a.dayofweek) === odooDay);
  const hours = attendances.reduce(
    (s, a) => s + (Number(a.duration_hours) || Math.max(0, (Number(a.hour_to) || 0) - (Number(a.hour_from) || 0))),
    0,
  );
  return hours > 0 ? hours : (fallbackHours ?? (Number(cal?.hours_per_day) || 8));
}

export function workingHours(calendar, from, to, db) {
  if (!from || !to || from > to) return 0;
  let total = 0;
  for (let cursor = new Date(`${from}T00:00:00Z`); cursor.toISOString().slice(0, 10) <= to; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const date = cursor.toISOString().slice(0, 10);
    total += workingHoursForDay(calendar, date, db);
  }
  return Math.round(total * 100) / 100;
}

export function calendarFor(db, employeeId, date) {
  if (!db) return standard40Calendar();
  if (employeeId) {
    const employee = (db.records['hr.employee'] ?? []).find((e) => e.id === employeeId);
    const contract = (db.records['hr.contract'] ?? []).find(
      (r) => r.employee_id === employeeId && r.state === 'running' && (!date || ((!r.date_start || r.date_start <= date) && (!r.date_end || r.date_end >= date))),
    );
    if (contract?.resource_calendar_id) {
      const cal = (db.records['resource.calendar'] ?? []).find((c) => c.id === contract.resource_calendar_id);
      if (cal) return cal;
    }
    if (contract?.work_days != null) {
      const jsDays = String(contract.work_days).split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
      const hours = Number(contract.hours_per_day) || (Number(employee?.daily_hours) > 0 ? Number(employee.daily_hours) : 8);
      const from = Number(contract.hour_from) || 9;
      const odooDays = jsDays.map((js) => String((js + 6) % 7));
      const lines = odooDays.map((d) => ({
        dayofweek: d,
        day_period: 'full_day',
        hour_from: from,
        hour_to: from + hours,
        duration_hours: hours,
      }));
      return {
        id: 0,
        name: contract.name || 'Contract Schedule',
        company_id: contract.company_id ?? employee?.company_id ?? 1,
        hours_per_day: hours,
        hours_per_week: hours * odooDays.length,
        attendance_ids: lines,
        calendar_type: 'fixed',
      };
    }
    if (employee?.resource_calendar_id) {
      const cal = (db.records['resource.calendar'] ?? []).find((c) => c.id === employee.resource_calendar_id);
      if (cal) return cal;
    }
    const companyId = employee?.company_id ?? 1;
    const company = (db.records['res.company'] ?? []).find((c) => c.id === companyId);
    if (company?.resource_calendar_id) {
      const cal = (db.records['resource.calendar'] ?? []).find((c) => c.id === company.resource_calendar_id);
      if (cal) return cal;
    }
    const companyCal = (db.records['resource.calendar'] ?? []).find((c) => c.active !== false && (c.company_id ?? 1) === companyId);
    if (companyCal) return companyCal;
  }
  const defaultCal = (db.records['resource.calendar'] ?? []).find((c) => c.active !== false);
  return defaultCal || standard40Calendar();
}

export function ensureCalendars(db) {
  let next = db;
  const companies = next.records['res.company'] ?? [];
  const calendars = next.records['resource.calendar'] ?? [];
  const calRecords = [...calendars];

  const targetCompanies = companies.length ? companies : [{ id: 1, name: 'Main Company' }];
  for (const company of targetCompanies) {
    let cal = calRecords.find((c) => (c.company_id ?? 1) === company.id && c.name === 'Standard 40 hours/week');
    if (!cal) {
      const made = create(next, 'resource.calendar', {
        name: 'Standard 40 hours/week',
        company_id: company.id,
        active: true,
        calendar_type: 'fixed',
        hours_per_day: 8,
        hours_per_week: 40,
        full_time_required_hours: 40,
        work_time_rate: 100,
        attendance_ids: standard40AttendanceLines(),
        leave_ids: [],
      });
      next = made.db;
      cal = read(next, 'resource.calendar', made.id);
      calRecords.push(cal);
    }
    if (company.id && !read(next, 'res.company', company.id)?.resource_calendar_id) {
      next = write(next, 'res.company', company.id, { resource_calendar_id: cal.id });
    }
  }

  const employees = next.records['hr.employee'] ?? [];
  for (const emp of employees) {
    if (!emp.resource_calendar_id) {
      const coId = emp.company_id ?? 1;
      const coCal = calRecords.find((c) => (c.company_id ?? 1) === coId) || calRecords[0];
      if (coCal) {
        next = write(next, 'hr.employee', emp.id, { resource_calendar_id: coCal.id });
      }
    }
  }

  const contracts = next.records['hr.contract'] ?? [];
  for (const c of contracts) {
    if (!c.resource_calendar_id) {
      const coId = c.company_id ?? 1;
      const coCal = calRecords.find((cal) => (cal.company_id ?? 1) === coId) || calRecords[0];
      if (coCal) {
        next = write(next, 'hr.contract', c.id, { resource_calendar_id: coCal.id });
      }
    }
  }
  return next;
}

const attendanceFields = {
  calendar_id: { type: 'many2one', relation: 'resource.calendar', label: 'Working Schedule', required: true },
  dayofweek: {
    type: 'selection',
    label: 'Day of Week',
    required: true,
    options: [
      ['0', 'Monday'],
      ['1', 'Tuesday'],
      ['2', 'Wednesday'],
      ['3', 'Thursday'],
      ['4', 'Friday'],
      ['5', 'Saturday'],
      ['6', 'Sunday'],
    ],
  },
  day_period: {
    type: 'selection',
    label: 'Day Period',
    options: [
      ['morning', 'Morning'],
      ['afternoon', 'Afternoon'],
      ['full_day', 'Full Day'],
    ],
  },
  hour_from: { type: 'float', label: 'Work from', required: true },
  hour_to: { type: 'float', label: 'Work to', required: true },
  duration_hours: { type: 'float', label: 'Duration (Hours)' },
};

export const calendarModels = {
  'resource.calendar': {
    label: 'Working Schedules',
    fields: {
      name: { type: 'char', label: 'Name', required: true },
      active: { type: 'boolean', label: 'Active' },
      company_id: { type: 'many2one', relation: 'res.company', label: 'Company' },
      calendar_type: {
        type: 'selection',
        label: 'Calendar Type',
        required: true,
        options: [
          ['fixed', 'Fixed'],
          ['variable', 'Variable'],
        ],
      },
      hours_per_day: { type: 'float', label: 'Average Hour per Day' },
      hours_per_week: { type: 'float', label: 'Total Hours per Week' },
      full_time_required_hours: { type: 'float', label: 'Full Time Required Hours' },
      work_time_rate: { type: 'float', label: 'Work Time Rate' },
      attendance_ids: {
        type: 'one2many',
        relation: 'resource.calendar.attendance',
        label: 'Working Hours',
        fields: {
          dayofweek: attendanceFields.dayofweek,
          day_period: attendanceFields.day_period,
          hour_from: attendanceFields.hour_from,
          hour_to: attendanceFields.hour_to,
          duration_hours: attendanceFields.duration_hours,
        },
        onchange: (line, key) => {
          if (key === 'hour_from' || key === 'hour_to') {
            const from = Number(line.hour_from) || 0;
            const to = Number(line.hour_to) || 0;
            return { duration_hours: Math.max(0, Math.round((to - from) * 100) / 100) };
          }
          return {};
        },
        newLine: () => ({ dayofweek: '0', day_period: 'morning', hour_from: 8, hour_to: 12, duration_hours: 4 }),
      },
      leave_ids: {
        type: 'one2many',
        relation: 'resource.calendar.leaves',
        label: 'Leaves',
        fields: {
          name: { type: 'char', label: 'Reason' },
          date_from: { type: 'date', label: 'Start Date' },
          date_to: { type: 'date', label: 'End Date' },
        },
      },
    },
    defaults: () => ({
      active: true,
      calendar_type: 'fixed',
      hours_per_day: 8,
      hours_per_week: 40,
      full_time_required_hours: 40,
      work_time_rate: 100,
      attendance_ids: standard40AttendanceLines(),
      leave_ids: [],
    }),
    onchange: (r, key) => {
      if (key === 'attendance_ids') {
        const lines = r.attendance_ids ?? [];
        const totalWeek = Math.round(lines.reduce((s, l) => s + (Number(l.duration_hours) || Math.max(0, Number(l.hour_to) - Number(l.hour_from))), 0) * 100) / 100;
        const uniqueDays = new Set(lines.map((l) => l.dayofweek)).size;
        const hoursPerDay = uniqueDays ? Math.round((totalWeek / uniqueDays) * 100) / 100 : 8;
        const fullTime = Number(r.full_time_required_hours) || 40;
        const rate = fullTime ? Math.round((totalWeek / fullTime) * 10000) / 100 : 100;
        return { hours_per_week: totalWeek, hours_per_day: hoursPerDay, work_time_rate: rate };
      }
      return {};
    },
    list: ['name', 'company_id', 'hours_per_day', 'hours_per_week', 'full_time_required_hours', 'work_time_rate', 'active'],
    form: {
      title: 'name',
      groups: [
        ['company_id', 'calendar_type', 'active'],
        ['hours_per_day', 'hours_per_week', 'full_time_required_hours', 'work_time_rate'],
      ],
      tabs: [{ label: 'Working Hours', fields: ['attendance_ids'] }],
    },
  },

  'resource.calendar.attendance': {
    label: 'Working Hours',
    fields: attendanceFields,
    defaults: () => ({ dayofweek: '0', day_period: 'morning', hour_from: 8, hour_to: 12, duration_hours: 4 }),
    list: ['calendar_id', 'dayofweek', 'day_period', 'hour_from', 'hour_to', 'duration_hours'],
    form: {
      title: 'calendar_id',
      groups: [
        ['calendar_id', 'dayofweek', 'day_period'],
        ['hour_from', 'hour_to', 'duration_hours'],
      ],
    },
  },

  'resource.calendar.leaves': {
    label: 'Public Holidays',
    fields: {
      name: { type: 'char', label: 'Reason' },
      company_id: { type: 'many2one', relation: 'res.company', label: 'Company' },
      calendar_id: { type: 'many2one', relation: 'resource.calendar', label: 'Working Schedule' },
      date_from: { type: 'date', label: 'Start Date', required: true },
      date_to: { type: 'date', label: 'End Date', required: true },
      count_as: {
        type: 'selection',
        label: 'Count as',
        options: [
          ['absence', 'Absence'],
          ['working_time', 'Working Time'],
        ],
      },
    },
    defaults: () => ({ date_from: today(), date_to: today(), count_as: 'absence' }),
    list: ['name', 'calendar_id', 'date_from', 'date_to', 'count_as'],
    form: {
      title: 'name',
      groups: [
        ['name', 'calendar_id', 'company_id'],
        ['date_from', 'date_to', 'count_as'],
      ],
    },
  },
};
