// Project, Helpdesk, Employees and Calendar.
import { create, read, write } from '../orm.js';
import { addDays, today } from './common.js';
import { assignTicket, mergeTickets, rateTicket, slaDeadline, slaStatus, ticketExtraFields } from './helpdesk.js';

const employee = (label) => ({ type: 'many2one', relation: 'hr.employee', label });

export const workModels = {
  'hr.department': {
    label: 'Departments',
    fields: {
      name: { type: 'char', label: 'Department Name', required: true },
      manager_id: employee('Manager'),
      parent_id: { type: 'many2one', relation: 'hr.department', label: 'Parent Department' },
      note: { type: 'text', label: 'Note' },
    },
    kanban: { title: 'name', lines: ['manager_id', 'parent_id'], avatar: true },
    list: ['name', 'parent_id', 'manager_id'],
    form: {
      title: 'name',
      smart: [{ label: 'Employees', model: 'hr.employee', field: 'department_id', target: 'employees/employees' }],
      groups: [['manager_id', 'parent_id'], []],
      tabs: [{ label: 'Note', fields: ['note'] }],
      chatter: true,
    },
  },

  'hr.employee': {
    label: 'Employees',
    fields: {
      name: { type: 'char', label: 'Employee Name', required: true },
      job_title: { type: 'char', label: 'Job Title' },
      department_id: { type: 'many2one', relation: 'hr.department', label: 'Department' },
      parent_id: employee('Manager'),
      work_email: { type: 'char', label: 'Work Email' },
      work_phone: { type: 'char', label: 'Work Phone' },
      mobile_phone: { type: 'char', label: 'Work Mobile' },
      work_location: { type: 'selection', label: 'Work Location', options: [['office', 'Office'], ['home', 'Home'], ['other', 'Other']] },
      coach_id: employee('Coach'),
      employee_type: { type: 'selection', label: 'Employee Type', options: [['employee', 'Employee'], ['worker', 'Worker'], ['student', 'Student'], ['trainee', 'Trainee'], ['contractor', 'Contractor'], ['freelance', 'Freelancer']] },
      working_hours: { type: 'selection', label: 'Working Hours', options: [['40', '40 hours/week'], ['35', '35 hours/week'], ['20', 'Part-time 20 hours/week'], ['flexible', 'Flexible']] },
      join_date: { type: 'date', label: 'Joined on' },
      wage: { type: 'monetary', label: 'Monthly Wage' },
      tag_ids: { type: 'tags', label: 'Tags' },
      resume_lines: {
        type: 'one2many', label: 'Resume',
        fields: {
          line_type: { type: 'selection', label: 'Type', options: [['experience', 'Experience'], ['education', 'Education'], ['internal', 'Internal Certification'], ['other', 'Other']] },
          name: { type: 'char', label: 'Title' }, date_start: { type: 'date', label: 'Start' }, date_end: { type: 'date', label: 'End' }, description: { type: 'char', label: 'Description' },
        },
        newLine: () => ({ line_type: 'experience', name: '', date_start: today(), date_end: null, description: '' }),
      },
      certification_lines: {
        type: 'one2many', label: 'Certifications',
        fields: { name: { type: 'char', label: 'Certification' }, date: { type: 'date', label: 'Obtained' }, expiration_date: { type: 'date', label: 'Expires' } },
        newLine: () => ({ name: '', date: today(), expiration_date: null }),
      },
      private_email: { type: 'char', label: 'Private Email' },
      private_phone: { type: 'char', label: 'Private Phone' },
      private_address: { type: 'char', label: 'Private Address' },
      birthday: { type: 'date', label: 'Date of Birth' },
      place_of_birth: { type: 'char', label: 'Place of Birth' },
      gender: { type: 'selection', label: 'Gender', options: [['male', 'Male'], ['female', 'Female'], ['other', 'Other']] },
      marital: { type: 'selection', label: 'Marital Status', options: [['single', 'Single'], ['married', 'Married'], ['cohabitant', 'Legal Cohabitant'], ['widower', 'Widower'], ['divorced', 'Divorced']] },
      children: { type: 'integer', label: 'Number of Dependent Children' },
      nationality: { type: 'char', label: 'Nationality (Country)' },
      identification_id: { type: 'char', label: 'Identification No' },
      passport_id: { type: 'char', label: 'Passport No' },
      visa_no: { type: 'char', label: 'Visa No' },
      permit_no: { type: 'char', label: 'Work Permit No' },
      visa_expire: { type: 'date', label: 'Visa Expiration Date' },
      bank_account: { type: 'char', label: 'Bank Account Number' },
      emergency_contact: { type: 'char', label: 'Emergency Contact' },
      emergency_phone: { type: 'char', label: 'Emergency Phone' },
      badge_id: { type: 'char', label: 'Badge ID' },
      pin: { type: 'char', label: 'PIN Code' },
      departure_date: { type: 'date', label: 'Departure Date' },
      departure_reason: { type: 'selection', label: 'Departure Reason', options: [['fired', 'Fired'], ['resigned', 'Resigned'], ['retired', 'Retired']] },
    },
    defaults: () => ({ work_location: 'office', employee_type: 'employee', working_hours: '40', tag_ids: [], join_date: today(), resume_lines: [], certification_lines: [] }),
    filters: [
      [{ id: 'remote', label: 'Remote', fn: (r) => r.work_location === 'home' }],
      [{ id: 'visa', label: 'Visa Expiring Soon', fn: (r) => r.visa_expire && r.visa_expire <= addDays(today(), 60) }, { id: 'departed', label: 'Departed', fn: (r) => !!r.departure_date }],
    ],
    groupBys: ['department_id', 'parent_id', 'work_location', 'employee_type', 'join_date'],
    kanban: { title: 'name', lines: ['job_title', 'work_email'], tags: 'tag_ids', avatar: true },
    list: ['name', 'job_title', 'department_id', 'parent_id', 'work_email', 'work_phone'],
    graph: { groupBy: 'department_id', measure: '__count' },
    pivot: { row: 'department_id', col: 'work_location', measure: '__count' },
    views: ['kanban', 'list', 'graph', 'pivot'],
    form: {
      title: 'name',
      subtitleField: 'job_title',
      smart: [
        { label: 'Tasks', model: 'project.task', field: 'user_id', target: 'project/tasks' },
        { label: 'Tickets', model: 'helpdesk.ticket', field: 'user_id', target: 'helpdesk/tickets' },
        { label: 'Payslips', model: 'hr.payslip', field: 'employee_id', target: 'payroll/payslips' },
      ],
      groups: [['work_email', 'work_phone', 'mobile_phone', 'tag_ids'], ['job_title', 'department_id', 'parent_id', 'coach_id']],
      tabs: [
        { label: 'Work Information', fields: ['work_location', 'working_hours', 'employee_type', 'join_date', 'wage'] },
        { label: 'Resume', fields: ['resume_lines'] },
        { label: 'Certifications', fields: ['certification_lines'] },
        { label: 'Private Information', fields: ['private_address', 'private_email', 'private_phone', 'bank_account', 'birthday', 'place_of_birth', 'gender', 'marital', 'children', 'nationality', 'identification_id', 'passport_id', 'visa_no', 'permit_no', 'visa_expire', 'emergency_contact', 'emergency_phone'] },
        { label: 'HR Settings', fields: ['badge_id', 'pin', 'departure_date', 'departure_reason'] },
      ],
      chatter: true,
    },
  },

  'project.project': {
    label: 'Projects',
    fields: {
      name: { type: 'char', label: 'Project Name', required: true },
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Customer' },
      user_id: employee('Project Manager'),
      date_start: { type: 'date', label: 'Start Date' },
      date: { type: 'date', label: 'End Date' },
      tag_ids: { type: 'tags', label: 'Tags' },
      description: { type: 'text', label: 'Description' },
    },
    defaults: () => ({ tag_ids: [], date_start: today() }),
    kanban: { title: 'name', lines: ['partner_id', 'user_id'], tags: 'tag_ids', counter: { label: 'Tasks', model: 'project.task', field: 'project_id' } },
    list: ['name', 'partner_id', 'user_id', 'date_start', 'date'],
    form: {
      title: 'name',
      smart: [{ label: 'Tasks', model: 'project.task', field: 'project_id', target: 'project/tasks' }],
      groups: [['partner_id', 'user_id', 'tag_ids'], ['date_start', 'date']],
      tabs: [{ label: 'Description', fields: ['description'] }],
      chatter: true,
    },
  },

  'project.task': {
    label: 'Tasks',
    fields: {
      name: { type: 'char', label: 'Task Title', required: true },
      project_id: { type: 'many2one', relation: 'project.project', label: 'Project' },
      user_id: employee('Assignee'),
      stage_id: {
        type: 'selection',
        label: 'Stage',
        tracking: true,
        options: [['todo', 'To Do'], ['progress', 'In Progress'], ['review', 'Review'], ['done', 'Done']],
      },
      date_start: { type: 'date', label: 'Start Date' },
      date_deadline: { type: 'date', label: 'Deadline' },
      planned_hours: { type: 'float', label: 'Allocated Hours' },
      priority: { type: 'priority', label: 'Priority' },
      tag_ids: { type: 'tags', label: 'Tags' },
      description: { type: 'text', label: 'Description' },
      state: { type: 'selection', label: 'Status', tracking: true, options: [['in_progress', 'In Progress'], ['changes_requested', 'Changes Requested'], ['approved', 'Approved'], ['waiting', 'Waiting'], ['canceled', 'Cancelled'], ['done', 'Done']] },
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Customer' },
      parent_id: { type: 'many2one', relation: 'project.task', label: 'Parent Task' },
      milestone_id: { type: 'many2one', relation: 'project.milestone', label: 'Milestone' },
      recurrence_id: { type: 'many2one', relation: 'project.recurrence', label: 'Recurrence', readonly: true },
      depend_on: {
        type: 'one2many', label: 'Blocked By',
        fields: { task_id: { type: 'many2one', relation: 'project.task', label: 'Task' } },
        newLine: () => ({ task_id: null }),
      },
    },
    defaults: () => ({ stage_id: 'todo', state: 'in_progress', priority: 0, tag_ids: [], planned_hours: 0, depend_on: [] }),
    // Customer follows the project; a task blocked by open tasks waits and cannot be closed.
    onchange: (r, key, db) => (key === 'project_id' && r.project_id && !r.partner_id ? { partner_id: (db.records['project.project'] ?? []).find((p) => p.id === r.project_id)?.partner_id ?? null } : {}),
    guard: (db, before, after) => {
      const closing = (after.stage_id === 'done' || after.state === 'done') && (!before || before.stage_id !== after.stage_id || before.state !== after.state);
      if (!closing) return null;
      const open = (after.depend_on ?? []).map((d) => (db.records['project.task'] ?? []).find((t) => t.id === d.task_id)).filter((t) => t && t.stage_id !== 'done' && t.state !== 'done' && t.state !== 'canceled');
      return open.length ? `Blocked by: ${open.map((t) => t.name).join(', ')}` : null;
    },
    filters: [
      [{ id: 'open', label: 'Open Tasks', fn: (r) => r.stage_id !== 'done' }, { id: 'done', label: 'Done', fn: (r) => r.stage_id === 'done' }],
      [{ id: 'late', label: 'Late', fn: (r) => r.stage_id !== 'done' && r.date_deadline && r.date_deadline < today() }],
    ],
    groupBys: ['stage_id', 'state', 'project_id', 'user_id', 'partner_id', 'date_deadline'],
    kanban: { groupBy: 'stage_id', title: 'name', lines: ['project_id', 'date_deadline'], tags: 'tag_ids', priority: 'priority', badge: 'user_id', quickCreate: true },
    list: ['name', 'project_id', 'user_id', 'date_deadline', 'planned_hours', 'stage_id'],
    graph: { groupBy: 'project_id', measure: '__count' },
    pivot: { row: 'project_id', col: 'stage_id', measure: 'planned_hours' },
    calendar: { date: 'date_deadline' },
    views: ['kanban', 'list', 'gantt', 'calendar', 'graph', 'pivot'],
    gantt: { start: 'date_start', stop: 'date_deadline', row: 'user_id', color: 'stage_id', hours: 'planned_hours', openLabel: 'Unassigned' },
    form: {
      statusbar: 'stage_id',
      statusbarClickable: true,
      title: 'name',
      smart: [
        { label: 'Hours Spent', model: 'account.analytic.line', field: 'task_id', target: 'timesheets/timesheets', sum: 'unit_amount', format: 'number' },
        { label: 'Sub-tasks', model: 'project.task', field: 'parent_id', target: 'project/tasks' },
      ],
      groups: [['project_id', 'user_id', 'tag_ids', 'partner_id', 'parent_id'], ['state', 'date_start', 'date_deadline', 'planned_hours', 'priority']],
      tabs: [{ label: 'Description', fields: ['description'] }, { label: 'Blocked By', fields: ['depend_on'] }],
      chatter: true,
    },
  },

  'helpdesk.ticket': {
    label: 'Tickets',
    fields: {
      name: { type: 'char', label: 'Subject', required: true },
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Customer' },
      user_id: employee('Assigned to'),
      ticket_type: { type: 'selection', label: 'Type', options: [['question', 'Question'], ['issue', 'Issue'], ['request', 'Request']] },
      stage_id: {
        type: 'selection',
        label: 'Stage',
        tracking: true,
        options: [['new', 'New'], ['progress', 'In Progress'], ['hold', 'On Hold'], ['solved', 'Solved'], ['cancelled', 'Cancelled']],
      },
      create_date: { type: 'date', label: 'Created on', readonly: true },
      priority: { type: 'priority', label: 'Priority' },
      tag_ids: { type: 'tags', label: 'Tags' },
      description: { type: 'text', label: 'Description' },
      team_id: { type: 'many2one', relation: 'helpdesk.team', label: 'Helpdesk Team' },
      email: { type: 'char', label: 'Email' },
      phone: { type: 'char', label: 'Phone' },
      sla_deadline: { type: 'date', label: 'SLA Deadline', readonly: true },
      sla_status: { type: 'selection', label: 'SLA Status', options: [['ok', 'On Track'], ['failed', 'Failed']], compute: (r) => slaStatus(r, today()) },
      close_date: { type: 'date', label: 'Closed on', readonly: true },
      fsm_task_id: { type: 'many2one', relation: 'fsm.task', label: 'Intervention', readonly: true },
      ...Object.fromEntries(Object.entries(ticketExtraFields).filter(([k]) => k !== 'user_id')),
    },
    defaults: () => ({ stage_id: 'new', ticket_type: 'question', priority: 0, tag_ids: [], create_date: today() }),
    // Customer contact fills in; team/priority/type recompute the SLA deadline; solving stamps the close date.
    onchange: (r, key, db) => {
      if (key === 'partner_id' && r.partner_id) {
        const p = read(db, 'res.partner', r.partner_id);
        return p ? { email: r.email || p.email || '', phone: r.phone || p.phone || '' } : {};
      }
      if (['team_id', 'priority', 'ticket_type'].includes(key)) return { sla_deadline: slaDeadline(db, r) };
      if (key === 'stage_id') return { close_date: r.stage_id === 'solved' ? today() : null };
      return {};
    },
    filters: [
      [{ id: 'mine', label: 'My Tickets', fn: (r) => r.user_id === 1 }, { id: 'unassigned', label: 'Unassigned', fn: (r) => !r.user_id }],
      [{ id: 'open', label: 'Open', fn: (r) => r.stage_id !== 'solved' }, { id: 'urgent', label: 'Urgent', fn: (r) => r.priority >= 3 }],
      [{ id: 'sla_failed', label: 'SLA Failed', fn: (r) => slaStatus(r, today()) === 'failed' }, { id: 'sla_ok', label: 'SLA On Track', fn: (r) => slaStatus(r, today()) === 'ok' }],
    ],
    groupBys: ['stage_id', 'team_id', 'user_id', 'ticket_type', 'partner_id', 'create_date'],
    kanban: { groupBy: 'stage_id', title: 'name', lines: ['partner_id', 'ticket_type'], tags: 'tag_ids', priority: 'priority', badge: 'user_id', quickCreate: true },
    list: ['name', 'partner_id', 'team_id', 'ticket_type', 'user_id', 'sla_deadline', 'stage_id'],
    listDecoration: (r) => (slaStatus(r, today()) === 'failed' && r.stage_id !== 'solved' ? 'danger' : null),
    graph: { groupBy: 'ticket_type', measure: '__count' },
    pivot: { row: 'user_id', col: 'stage_id', measure: '__count' },
    views: ['kanban', 'list', 'graph', 'pivot'],
    form: {
      statusbar: 'stage_id',
      statusbarClickable: true,
      title: 'name',
      statusbarHide: ['cancelled'],
      buttons: [{
        label: 'Assign', when: (r) => !r.user_id && r.team_id && !['solved', 'cancelled'].includes(r.stage_id), run: (db, r) => ({ db: assignTicket(db, r) }),
      }, {
        // Merge duplicates into this ticket: their descriptions and messages move here and they are cancelled.
        label: 'Merge Tickets', when: (r) => !['solved', 'cancelled'].includes(r.stage_id),
        wizard: (db, r) => ({ title: 'Merge Tickets', fields: [
          { name: 'ticket_ids', type: 'many2many', relation: 'helpdesk.ticket', label: 'Tickets to merge into this one', required: true,
            // Only tickets that can be merged: open ones of the same customer.
            domain: (x) => x.id !== r.id && x.partner_id === r.partner_id && !['solved', 'cancelled'].includes(x.stage_id) },
        ] }),
        run: (db, r, v = {}) => {
          const ids = (v.ticket_ids ?? []).map(Number).filter((x) => Number.isInteger(x) && x > 0);
          if (!ids.length) throw new Error('Choose the tickets to merge');
          return { db: mergeTickets(db, r.id, ids) };
        },
      }, {
        label: 'Record Rating', when: (r) => r.stage_id === 'solved' && !r.rating,
        wizard: () => ({ title: 'Record Rating', fields: [
          { name: 'rating', type: 'selection', label: 'Rating', required: true, default: '5', options: [['1', '1'], ['2', '2'], ['3', '3'], ['4', '4'], ['5', '5']] },
          { name: 'comment', type: 'text', label: 'Comment' },
        ] }),
        run: (db, r, v = {}) => {
          const rating = Number(v.rating);
          if (!(Number.isInteger(rating) && rating >= 1 && rating <= 5)) throw new Error('Choose a rating from 1 to 5');
          return { db: rateTicket(db, r.id, rating, v.comment ?? '') };
        },
      }, {
        label: 'Plan Intervention', when: (r) => !r.fsm_task_id && r.stage_id !== 'solved',
        run: (db, r) => {
          const { db: next, id } = create(db, 'fsm.task', { name: r.name, partner_id: r.partner_id ?? null, technician_id: r.user_id ?? null, date: today(), description: r.description ?? '' });
          return { db: write(next, 'helpdesk.ticket', r.id, { fsm_task_id: id }), go: `#/fieldservice/tasks/${id}` };
        },
      }],
      smart: [{ label: 'Customer Tickets', model: 'helpdesk.ticket', field: 'partner_id', key: 'partner_id', target: 'helpdesk/tickets' }],
      groups: [['team_id', 'user_id', 'priority', 'tag_ids'], ['partner_id', 'email', 'phone', 'ticket_type', 'sla_deadline', 'sla_status']],
      tabs: [{ label: 'Description', fields: ['description'] }, { label: 'Extra Info', fields: ['create_date', 'close_date', 'fsm_task_id', 'merged_into'] }, { label: 'Rating', fields: ['rating', 'rating_comment'] }],
      chatter: true,
    },
  },

  'calendar.event': {
    label: 'Meetings',
    fields: {
      name: { type: 'char', label: 'Meeting Subject', required: true },
      start: { type: 'date', label: 'Date', required: true },
      start_time: { type: 'char', label: 'Time' },
      duration: { type: 'float', label: 'Duration (hours)' },
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Attendee' },
      location: { type: 'char', label: 'Location' },
      description: { type: 'text', label: 'Description' },
    },
    defaults: () => ({ start: today(), start_time: '10:00', duration: 1 }),
    groupBys: ['partner_id', 'start'],
    kanban: { title: 'name', lines: ['start', 'start_time', 'location'] },
    list: ['name', 'start', 'start_time', 'duration', 'partner_id', 'location'],
    calendar: { date: 'start', time: 'start_time' },
    views: ['calendar', 'list', 'kanban'],
    form: {
      title: 'name',
      groups: [['start', 'start_time', 'duration'], ['partner_id', 'location']],
      tabs: [{ label: 'Description', fields: ['description'] }],
      chatter: true,
    },
  },
};
