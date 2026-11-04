// Project milestones, status snapshots and recurring task schedules.
import { create, read, search, write } from '../orm.js';
import { today } from './common.js';

const statuses = [['on_track', 'On Track'], ['at_risk', 'At Risk'], ['off_track', 'Off Track'], ['on_hold', 'On Hold'], ['done', 'Done']];
const isDone = (r) => r.stage_id === 'done' || r.state === 'done';
const percent = (done, total) => total ? Math.round(done * 100 / total) : 0;

/** Count linked tasks and their completion percentage. */
export function milestoneProgress(db, milestoneId) {
  const tasks = search(db, 'project.task').filter((r) => r.milestone_id === milestoneId);
  const done = tasks.filter(isDone).length;
  return { tasks: tasks.length, done, percent: percent(done, tasks.length) };
}

/** Reach a milestone, refusing unfinished tasks unless explicitly forced. */
export function reachMilestone(db, milestone, { force = false, date = today() } = {}) {
  const progress = milestoneProgress(db, milestone.id);
  if (!force && progress.done < progress.tasks) throw new Error('Some tasks of this milestone are not done');
  return write(db, 'project.milestone', milestone.id, { is_reached: true, reached_date: date });
}

/** Summarise project tasks and select the earliest unreached milestone. */
export function projectStatus(db, projectId, at = today()) {
  const tasks = search(db, 'project.task').filter((r) => r.project_id === projectId);
  const open = tasks.filter((r) => !isDone(r));
  const done = tasks.length - open.length;
  const nextMilestone = search(db, 'project.milestone').filter((r) => r.project_id === projectId && !r.is_reached)
    .sort((a, b) => (a.deadline || '9999-12-31').localeCompare(b.deadline || '9999-12-31') || a.id - b.id)[0] ?? null;
  return {
    open: open.length, done, late: open.filter((r) => r.date_deadline && r.date_deadline < at).length,
    percentDone: percent(done, tasks.length),
    hoursPlanned: tasks.reduce((sum, r) => sum + (Number(r.planned_hours) || 0), 0), nextMilestone,
  };
}

/** Create a dated status snapshot and publish its status on the project. */
export function postUpdate(db, projectId, { name, status, progress, author, description, date = today() }) {
  if (!read(db, 'project.project', projectId)) throw new Error('Select an existing project');
  const created = create(db, 'project.update', { project_id: projectId, name, status, progress, author, description, date });
  return publishUpdate(created.db, created.id);
}

/** Fill an update's task summary and publish its status on the project (the Publish button of updates made in the form). */
export function publishUpdate(db, updateId) {
  const u = read(db, 'project.update', updateId);
  if (!u || !read(db, 'project.project', u.project_id)) throw new Error('Select an existing project');
  if (!Number.isInteger(u.progress) || u.progress < 0 || u.progress > 100) throw new Error('Progress must be an integer from 0 to 100');
  if (!statuses.some(([value]) => value === u.status)) throw new Error('Select a valid project status');
  const s = projectStatus(db, u.project_id, u.date ?? today());
  const milestone = s.nextMilestone;
  const summary = `${s.open + s.done} tasks, ${s.done} done (${s.percentDone}%), ${s.late} late; next milestone: ${milestone ? `${milestone.name}${milestone.deadline ? ` (${milestone.deadline})` : ''}` : 'None'}`;
  return write(write(db, 'project.update', updateId, { summary }), 'project.project', u.project_id, { last_update_status: u.status });
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Return due dates anchored to the original start, with month-end clamping. */
export function nextOccurrences(recurrence, upTo) {
  const { start_date: start, last_date: last, until, unit = 'week' } = recurrence;
  const interval = Number(recurrence.interval ?? 1);
  const count = Number(recurrence.count ?? 0);
  if (!validDate(start) || !validDate(upTo) || (last && !validDate(last)) || (until && !validDate(until))) throw new Error('Set valid recurrence dates');
  if (!Number.isInteger(interval) || interval < 1) throw new Error('The interval must be at least 1');
  if (!Number.isInteger(count) || count < 0) throw new Error('The occurrence count must be a non-negative integer');
  if (!['day', 'week', 'month'].includes(unit)) throw new Error('Select a valid recurrence unit');
  const limit = until && until < upTo ? until : upTo;
  const dates = [];
  const origin = new Date(`${start}T00:00:00Z`);
  for (let k = 0; !count || k < count; k++) {
    const date = new Date(origin);
    if (unit === 'month') {
      date.setUTCDate(1);
      date.setUTCMonth(origin.getUTCMonth() + k * interval);
      const end = new Date(date);
      end.setUTCMonth(end.getUTCMonth() + 1, 0);
      date.setUTCDate(Math.min(origin.getUTCDate(), end.getUTCDate()));
    } else date.setUTCDate(origin.getUTCDate() + k * interval * (unit === 'week' ? 7 : 1));
    const iso = date.toISOString().slice(0, 10);
    if (iso > limit) break;
    if (!last || iso > last) dates.push(iso);
  }
  return dates;
}

/** Generate due tasks for active schedules and advance their exclusive cursor. */
export function generateRecurringTasks(db, upTo = today()) {
  let next = db;
  for (const r of search(db, 'project.recurrence').filter((r) => r.active)) {
    const dates = nextOccurrences(r, upTo);
    for (const date of dates) {
      next = create(next, 'project.task', {
        name: `${r.name} (${date})`, project_id: r.project_id, user_id: r.user_id,
        planned_hours: r.planned_hours, date_deadline: date, stage_id: 'todo', recurrence_id: r.id,
      }).db;
    }
    if (dates.length) next = write(next, 'project.recurrence', r.id, { last_date: dates.at(-1) });
  }
  return next;
}

export const projectPlusModels = {
  'project.milestone': {
    label: 'Milestones',
    fields: {
      name: { type: 'char', label: 'Name', required: true },
      project_id: { type: 'many2one', relation: 'project.project', label: 'Project' },
      deadline: { type: 'date', label: 'Deadline' },
      is_reached: { type: 'boolean', label: 'Reached', tracking: true },
      reached_date: { type: 'date', label: 'Reached Date', readonly: true },
    },
    defaults: () => ({ is_reached: false, reached_date: null }),
    groupBys: ['project_id'],
    kanban: { title: 'name', lines: ['project_id', 'deadline'], badge: 'is_reached' },
    list: ['name', 'project_id', 'deadline', 'is_reached', 'reached_date'],
    form: {
      title: 'name', groups: [['project_id', 'deadline'], ['is_reached', 'reached_date']],
      buttons: [
        { label: 'Mark as Reached', primary: true, when: (r) => !r.is_reached, run: (db, r) => {
          const p = milestoneProgress(db, r.id);
          const force = p.done < p.tasks && typeof confirm === 'function' && confirm('Some tasks of this milestone are not done. Mark as reached anyway?');
          if (p.done < p.tasks && !force) return { db };
          return { db: reachMilestone(db, r, { force }) };
        } },
        { label: 'Reopen', when: (r) => r.is_reached, vals: { is_reached: false, reached_date: null } },
      ],
      chatter: true,
    },
  },
  'project.update': {
    label: 'Project Updates',
    fields: {
      project_id: { type: 'many2one', relation: 'project.project', label: 'Project', required: true },
      name: { type: 'char', label: 'Title', required: true },
      status: { type: 'selection', label: 'Status', options: statuses, tracking: true },
      progress: { type: 'integer', label: 'Progress (%)' },
      date: { type: 'date', label: 'Date' },
      author: { type: 'char', label: 'Author' },
      description: { type: 'text', label: 'Description' },
      summary: { type: 'text', label: 'Summary', readonly: true },
    },
    defaults: () => ({ date: today(), status: 'on_track', progress: 0 }),
    groupBys: ['project_id'],
    kanban: { title: 'name', lines: ['project_id', 'date', 'progress'], badge: 'status' },
    list: ['date', 'name', 'project_id', 'status', 'progress', 'author'],
    form: {
      title: 'name', groups: [['project_id', 'status', 'progress'], ['date', 'author']],
      tabs: [{ label: 'Description', fields: ['description'] }, { label: 'Summary', fields: ['summary'] }], chatter: true,
      buttons: [{ label: 'Publish', primary: true, when: (r) => !r.summary, run: (db, r) => ({ db: publishUpdate(db, r.id) }) }],
    },
  },
  'project.recurrence': {
    label: 'Recurring Tasks',
    fields: {
      name: { type: 'char', label: 'Task Title', required: true },
      project_id: { type: 'many2one', relation: 'project.project', label: 'Project' },
      user_id: { type: 'many2one', relation: 'hr.employee', label: 'Assignee' },
      planned_hours: { type: 'float', label: 'Allocated Hours' },
      interval: { type: 'integer', label: 'Repeat Every' },
      unit: { type: 'selection', label: 'Unit', options: [['day', 'Days'], ['week', 'Weeks'], ['month', 'Months']] },
      start_date: { type: 'date', label: 'Start Date' },
      until: { type: 'date', label: 'Until' },
      count: { type: 'integer', label: 'Maximum Occurrences' },
      last_date: { type: 'date', label: 'Last Generated Date', readonly: true },
      active: { type: 'boolean', label: 'Active' },
    },
    defaults: () => ({ interval: 1, unit: 'week', start_date: today(), active: true, planned_hours: 0 }),
    groupBys: ['project_id'],
    kanban: { title: 'name', lines: ['project_id', 'interval', 'unit', 'last_date'], badge: 'active' },
    list: ['name', 'project_id', 'user_id', 'interval', 'unit', 'start_date', 'last_date', 'active'],
    form: {
      title: 'name', groups: [['project_id', 'user_id', 'planned_hours'], ['interval', 'unit', 'start_date'], ['until', 'count', 'last_date', 'active']], chatter: true,
    },
  },
};
