// Activities (scheduled follow-ups on any record) and Discuss channels.
import { postNote, read, write } from '../orm.js';
import { today } from './common.js';

export const ACTIVITY_TYPES = [['todo', 'To-Do'], ['call', 'Call'], ['email', 'Email'], ['meeting', 'Meeting'], ['upload', 'Upload Document']];

export const activityState = (r) => {
  if (r.done) return 'done';
  if (!r.date_deadline) return 'planned';
  if (r.date_deadline < today()) return 'overdue';
  return r.date_deadline === today() ? 'today' : 'planned';
};

/** Close an activity and leave a trace in the related record's chatter. */
export function markDone(db, act) {
  const label = ACTIVITY_TYPES.find((x) => x[0] === act.activity_type)?.[1] ?? 'Activity';
  const next = write(db, 'mail.activity', act.id, { done: true, date_done: today() });
  return read(next, act.res_model, act.res_id)
    ? postNote(next, act.res_model, act.res_id, `${label} done: ${act.summary || ''}`.trim())
    : next;
}

export const mailModels = {
  'mail.activity': {
    label: 'Activities',
    fields: {
      summary: { type: 'char', label: 'Summary' },
      activity_type: { type: 'selection', label: 'Activity Type', options: ACTIVITY_TYPES },
      date_deadline: { type: 'date', label: 'Due Date', required: true },
      user_id: { type: 'many2one', relation: 'hr.employee', label: 'Assigned to' },
      res_model: { type: 'char', label: 'Document Model', readonly: true },
      res_id: { type: 'integer', label: 'Document ID', readonly: true },
      res_name: { type: 'char', label: 'Document', readonly: true },
      note: { type: 'text', label: 'Note' },
      done: { type: 'boolean', label: 'Done', readonly: true },
      date_done: { type: 'date', label: 'Done on', readonly: true },
      state: {
        type: 'selection',
        label: 'State',
        compute: activityState,
        options: [['overdue', 'Overdue'], ['today', 'Today'], ['planned', 'Planned'], ['done', 'Done']],
      },
    },
    defaults: () => ({ activity_type: 'todo', date_deadline: today(), user_id: 1, done: false }),
    defaultFilters: ['open'],
    filters: [
      [{ id: 'open', label: 'Open', fn: (r) => !r.done }, { id: 'closed', label: 'Done', fn: (r) => r.done }],
      [{ id: 'late', label: 'Overdue', fn: (r) => activityState(r) === 'overdue' }, { id: 'today', label: 'Today', fn: (r) => activityState(r) === 'today' }],
    ],
    groupBys: ['state', 'activity_type', 'user_id', 'res_model', 'date_deadline'],
    kanban: { groupBy: 'state', title: 'summary', lines: ['res_name', 'activity_type', 'date_deadline'], badge: 'user_id' },
    list: ['date_deadline', 'res_name', 'activity_type', 'summary', 'user_id', 'state'],
    listDecoration: (r) => ({ overdue: 'danger', today: 'info' })[activityState(r)] ?? null,
    views: ['list', 'kanban', 'calendar'],
    calendar: { date: 'date_deadline' },
    form: {
      buttons: [
        { label: 'Mark Done', primary: true, when: (r) => !r.done, run: (db, r) => ({ db: markDone(db, r) }) },
        { label: 'Open Document', when: (r) => r.res_model, run: (db, r) => ({ db, go: `#/open/${r.res_model}/${r.res_id}` }) },
      ],
      title: 'summary',
      groups: [['activity_type', 'date_deadline', 'user_id'], ['res_name', 'state', 'date_done']],
      tabs: [{ label: 'Note', fields: ['note'] }],
    },
  },

  'discuss.channel': {
    label: 'Channels',
    fields: {
      name: { type: 'char', label: 'Channel Name', required: true },
      description: { type: 'char', label: 'Description' },
    },
    kanban: { title: 'name', lines: ['description'] },
    list: ['name', 'description'],
    form: { title: 'name', groups: [['description'], []], chatter: true },
  },
};
