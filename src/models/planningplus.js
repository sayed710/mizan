// Planning depth: recurring shifts, auto-plan, availability, swaps, analysis.
import { create, read, search, write, postNote } from '../orm.js';
import { addDays, today } from './common.js';
import { extraModels, shiftConflict } from './extra.js';

const base = extraModels['planning.slot'];
const day = (value) => value?.slice(0, 10);
const dailyHours = (employee) => Number(employee?.daily_hours) > 0 ? Number(employee.daily_hours) : (Number(employee?.working_hours) || 40) / 5;
const inPeriod = (slot, from, to) => slot.start <= to && (slot.end || slot.start) >= from;
const dates = (from, to) => {
  const result = [];
  for (let d = from; d <= to; d = addDays(d, 1)) result.push(d);
  return result;
};
const workingDay = (date) => ![0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay());

function period(from, to) {
  for (const value of [from, to]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '') || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error('Select valid planning dates');
  }
  if (to < from) throw new Error('The end date must be on or after the start date');
}

const bounds = (s) => [
  `${day(s.start)}T${s.start_time || s.start?.slice(11, 16) || '00:00'}`,
  `${day(s.end || s.start)}T${s.end_time || s.end?.slice(11, 16) || '24:00'}`,
];
const overlaps = (a, b) => {
  const [as, ae] = bounds(a);
  const [bs, be] = bounds(b);
  return as < be && bs < ae;
};

function conflict(db, slot) {
  const normalized = { ...slot, start: day(slot.start), end: day(slot.end || slot.start) };
  const records = { ...db.records, 'planning.slot': (db.records['planning.slot'] ?? []).filter((s) => overlaps(s, slot)) };
  return shiftConflict({ ...db, records }, normalized);
}

function matchesRole(employee, role) {
  const wanted = String(role ?? '').toLowerCase();
  return !role || employee.role === role || (employee.tag_ids ?? []).some((tag) => String(tag).toLowerCase() === wanted)
    || String(employee.job_title ?? '').toLowerCase().includes(wanted);
}

function slotById(db, id) {
  const slot = read(db, 'planning.slot', id);
  if (!slot) throw new Error('Select an existing shift');
  return slot;
}

/** Generate bounded weekly/monthly drafts, keyed by source and occurrence date. */
export function generateRecurringSlots(db, slot, horizonDate) {
  const source = slotById(db, slot.id);
  if (!source.repeat) return db;
  const interval = Number(source.repeat_interval);
  if (!Number.isInteger(interval) || interval < 1 || !['week', 'month'].includes(source.repeat_unit)) throw new Error('Choose a positive repeat interval and week or month');
  const until = [source.repeat_until, horizonDate].filter(Boolean).sort()[0];
  period(source.start, until);
  const duration = Math.round((Date.parse(source.end || source.start) - Date.parse(source.start)) / 864e5);
  let next = db;
  for (let n = 1; ; n++) {
    let start;
    if (source.repeat_unit === 'week') start = addDays(source.start, n * interval * 7);
    else {
      const anchor = new Date(`${source.start}T00:00:00Z`);
      const target = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + n * interval, 1));
      const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
      target.setUTCDate(Math.min(anchor.getUTCDate(), last));
      start = target.toISOString().slice(0, 10);
    }
    if (start > until) break;
    if (search(next, 'planning.slot').some((s) => s.recurring_source_id === source.id && s.start === start)) continue;
    const { id, ...values } = source;
    next = create(next, 'planning.slot', { ...values, start, end: addDays(start, duration), recurring_source_id: id, repeat: false, was_copied: true, swap_requested: false, state: 'draft', conflict: '' }).db;
  }
  return next;
}

/** Active, role-compatible employees without overlapping shifts or approved time off. */
export function availableEmployees(db, { start, end: endDate, role, start_time, end_time }) {
  // Single-day shifts store end as null (copyNextWeek), not undefined.
  const end = endDate || start;
  period(day(start), day(end));
  return search(db, 'hr.employee').filter((e) => matchesRole(e, role) && !conflict(db, { start, end, start_time, end_time, employee_id: e.id }));
}

/** Assign open shifts chronologically to the available resource with the lowest planned hours. */
export function autoPlan(db, { from, to }) {
  period(from, to);
  let next = db;
  const open = search(db, 'planning.slot').filter((s) => !s.employee_id && inPeriod(s, from, to)).sort((a, b) => bounds(a)[0].localeCompare(bounds(b)[0]) || a.id - b.id);
  for (const slot of open) {
    const totals = planningAnalysis(next, from, to);
    const employees = availableEmployees(next, slot).filter((e) => !slot.department_id || e.department_id === slot.department_id)
      .sort((a, b) => totals[a.id].planned - totals[b.id].planned || a.id - b.id);
    if (employees.length) next = write(next, 'planning.slot', slot.id, { employee_id: employees[0].id, allocated_daily_hours: dailyHours(employees[0]) });
  }
  return next;
}

/** Monday to Sunday around a date, the period the week buttons act on. */
const weekOf = (date) => {
  const from = addDays(date, -((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7));
  return { from, to: addDays(from, 6) };
};

function publishSlots(db, slots, from, to) {
  let next = db;
  for (const slot of slots) next = write(next, 'planning.slot', slot.id, { state: 'published' });
  for (const id of new Set(slots.map((s) => s.employee_id).filter(Boolean))) next = postNote(next, 'hr.employee', id, `Planning published: ${from} → ${to}`);
  return next;
}

/** Publish overlapping drafts and notify each assigned employee once per publication. */
export function publishPeriod(db, from, to) {
  period(from, to);
  return publishSlots(db, search(db, 'planning.slot').filter((s) => s.state === 'draft' && inPeriod(s, from, to)), from, to);
}

/** The assigned employee asks another resource to take a published shift. */
export function requestSwap(db, slotId, employeeId) {
  const slot = slotById(db, slotId);
  if (slot.state !== 'published' || !slot.employee_id || slot.employee_id !== employeeId) throw new Error('Only the assigned employee can ask to switch a published shift');
  if (slot.swap_requested) throw new Error('This shift is already awaiting a switch');
  return postNote(write(db, 'planning.slot', slotId, { swap_requested: true }), 'planning.slot', slotId, 'Asked to switch this shift');
}

/** Transfer a requested shift to a different, available, role-compatible employee. */
export function acceptSwap(db, slotId, newEmployeeId) {
  const slot = slotById(db, slotId);
  if (!slot.swap_requested || slot.state !== 'published') throw new Error('This shift is not awaiting a switch');
  const employee = read(db, 'hr.employee', newEmployeeId);
  if (!employee || employee.active === false || newEmployeeId === slot.employee_id || !matchesRole(employee, slot.role)) throw new Error('Choose a different employee matching the shift role');
  if (conflict(db, { ...slot, employee_id: newEmployeeId })) throw new Error('This employee is not available for the shift');
  return postNote(write(db, 'planning.slot', slotId, { employee_id: newEmployeeId, allocated_daily_hours: dailyHours(employee), swap_requested: false }), 'planning.slot', slotId, `${employee.name} accepted the switch`);
}

/** Employee-keyed planned hours and weekday capacity, excluding approved leave days. */
export function planningAnalysis(db, from, to) {
  period(from, to);
  const workdays = dates(from, to).filter(workingDay);
  const leaves = search(db, 'hr.leave').filter((l) => l.state === 'validate');
  const slots = search(db, 'planning.slot').filter((s) => inPeriod(s, from, to));
  return Object.fromEntries(search(db, 'hr.employee').map((e) => {
    const capacity = workdays.filter((d) => !leaves.some((l) => l.employee_id === e.id && l.date_from <= d && l.date_to >= d)).length * dailyHours(e);
    const planned = slots.filter((s) => s.employee_id === e.id).reduce((sum, s) => {
      const allDays = dates(s.start, s.end || s.start);
      const share = allDays.filter((d) => d >= from && d <= to).length / allDays.length;
      return sum + (Number(s.allocated_hours) || 0) * share;
    }, 0);
    return [e.id, { planned, capacity, ratio: capacity ? planned / capacity : 0 }];
  }));
}

export const planningPlusModels = {
  'planning.slot': {
    ...base,
    fields: {
      ...base.fields,
      start_time: { type: 'char', label: 'Start (HH:MM)' },
      end_time: { type: 'char', label: 'End (HH:MM)' },
      allocated_daily_hours: { type: 'float', label: 'Daily Hours', readonly: true },
      allocated_percentage: { type: 'float', label: 'Allocated (%)', compute: (r) => (Number(r.allocated_hours) || 0) / (Number(r.allocated_daily_hours) || 8) * 100 },
      repeat: { type: 'boolean', label: 'Repeat' },
      repeat_interval: { type: 'integer', label: 'Repeat Every' },
      repeat_unit: { type: 'selection', label: 'Repeat Unit', options: [['week', 'Weeks'], ['month', 'Months']] },
      repeat_until: { type: 'date', label: 'Repeat Until' },
      recurring_source_id: { type: 'many2one', relation: 'planning.slot', label: 'Recurring Source', readonly: true },
      project_id: { type: 'many2one', relation: 'project.project', label: 'Project' },
      sale_line_ref: { type: 'char', label: 'Sales Line Reference' },
      department_id: { type: 'many2one', relation: 'hr.department', label: 'Department' },
      was_copied: { type: 'boolean', label: 'Copied', readonly: true },
      swap_requested: { type: 'boolean', label: 'Switch Requested', readonly: true },
      swap_employee_id: { type: 'many2one', relation: 'hr.employee', label: 'Accepting Employee' },
    },
    defaults: () => ({ ...base.defaults(), repeat: false, repeat_interval: 1, repeat_unit: 'week', was_copied: false, swap_requested: false, allocated_daily_hours: 8 }),
    guard: (db, before, r) => {
      try { period(r.start, r.end || r.start); } catch (error) { return error.message; }
      if ([r.start_time, r.end_time].some((t) => t && !/^([01]\d|2[0-3]):[0-5]\d$/.test(t))) return 'Enter times as HH:MM';
      if (r.start_time && r.end_time && bounds(r)[1] <= bounds(r)[0]) return 'The shift must end after it starts';
      if (!Number.isFinite(Number(r.allocated_hours)) || Number(r.allocated_hours) < 0) return 'Allocated hours must be non-negative';
      return null;
    },
    onchange: (r, key, db) => {
      const filled = base.onchange(r, key, db);
      const template = key === 'template_id' ? read(db, 'planning.template', r.template_id) : null;
      return { ...filled, ...(template?.start_time ? { start_time: template.start_time } : {}),
        ...(['employee_id', 'allocated_hours', 'template_id'].includes(key) ? { allocated_daily_hours: dailyHours(read(db, 'hr.employee', r.employee_id)) } : {}),
        ...(['employee_id', 'start', 'end', 'start_time', 'end_time', 'template_id'].includes(key) ? { conflict: conflict(db, { ...r, ...filled }) } : {}) };
    },
    form: {
      ...base.form,
      buttons: [
        ...base.form.buttons.filter((b) => b.label !== 'Publish').map((b) => b.label !== 'Copy to Next Week' ? b : { ...b, run: (db, r) => {
          const copied = b.run(db, r);
          const id = copied.db.seq['planning.slot'];
          return { ...copied, db: write(copied.db, 'planning.slot', id, { was_copied: true, swap_requested: false }) };
        } }),
        { label: 'Publish', primary: true, when: (r) => r.state === 'draft', run: (db, r) => ({ db: publishSlots(db, [r], r.start, r.end || r.start) }) },
        { label: 'Auto Plan Week', when: (r) => !!r.start, run: (db, r) => ({ db: autoPlan(db, weekOf(r.start)) }) },
        { label: 'Publish Week', when: (r) => !!r.start, run: (db, r) => { const w = weekOf(r.start); return { db: publishPeriod(db, w.from, w.to) }; } },
        { label: 'Ask to Switch', when: (r) => r.state === 'published' && !!r.employee_id && !r.swap_requested, run: (db, r) => ({ db: requestSwap(db, r.id, r.employee_id) }) },
        { label: 'Accept Switch', when: (r) => r.swap_requested, run: (db, r) => ({ db: acceptSwap(db, r.id, r.swap_employee_id) }) },
        { label: 'Repeat', when: (r) => r.repeat, run: (db, r) => ({ db: generateRecurringSlots(db, r, r.repeat_until || addDays(today(), 90)) }) },
      ],
      groups: [...base.form.groups, ['start_time', 'end_time', 'allocated_percentage'], ['project_id', 'sale_line_ref', 'department_id'], ['repeat', 'repeat_interval', 'repeat_unit', 'repeat_until'], ['swap_requested', 'swap_employee_id', 'was_copied']],
    },
  },
  'planning.template': extraModels['planning.template'],
};
