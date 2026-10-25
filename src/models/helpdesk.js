// Helpdesk teams and SLA policies: a ticket's deadline comes from the strictest matching policy.
import { addDays } from './common.js';

const PRIORITIES = [['0', 'Low'], ['1', 'Medium'], ['2', 'High'], ['3', 'Urgent']];

/** Strictest SLA of the ticket's team that covers its priority (and type, when the policy names one). */
export function matchingSla(db, ticket) {
  return (db.records['helpdesk.sla'] ?? [])
    .filter((s) => s.team_id === ticket.team_id && Number(ticket.priority || 0) >= Number(s.priority || 0) && (!s.ticket_type || s.ticket_type === ticket.ticket_type))
    .sort((a, b) => (Number(a.days) || 0) - (Number(b.days) || 0))[0] ?? null;
}

/** Deadline in whole days from the ticket's creation; null when no policy applies. */
export const slaDeadline = (db, ticket) => {
  const sla = matchingSla(db, ticket);
  return sla && ticket.create_date ? addDays(ticket.create_date, Number(sla.days) || 0) : null;
};

/** ok / failed / null, judged at `at` for open tickets and at the close date for solved ones. */
export function slaStatus(r, at) {
  if (!r.sla_deadline) return null;
  const when = r.stage_id === 'solved' ? r.close_date ?? at : at;
  return when > r.sla_deadline ? 'failed' : 'ok';
}

export const helpdeskModels = {
  'helpdesk.team': {
    label: 'Helpdesk Teams',
    fields: {
      name: { type: 'char', label: 'Team', required: true },
      email: { type: 'char', label: 'Email Alias' },
      assignment: { type: 'selection', label: 'Assignment', options: [['manual', 'Manual'], ['balanced', 'Balanced workload'], ['random', 'Randomly']] },
      use_sla: { type: 'boolean', label: 'SLA Policies' },
      use_fsm: { type: 'boolean', label: 'Field Service' },
    },
    defaults: () => ({ assignment: 'manual', use_sla: true }),
    kanban: { title: 'name', lines: ['email', 'assignment'] },
    list: ['name', 'email', 'assignment', 'use_sla'],
    form: { title: 'name', groups: [['email', 'assignment'], ['use_sla', 'use_fsm']], chatter: true },
  },

  'helpdesk.sla': {
    label: 'SLA Policies',
    fields: {
      name: { type: 'char', label: 'SLA Policy', required: true },
      team_id: { type: 'many2one', relation: 'helpdesk.team', label: 'Team', required: true },
      priority: { type: 'selection', label: 'Minimum Priority', options: PRIORITIES },
      ticket_type: { type: 'selection', label: 'Type', options: [['question', 'Question'], ['issue', 'Issue'], ['request', 'Request']] },
      days: { type: 'integer', label: 'Days to Solve' },
    },
    defaults: () => ({ priority: '0', days: 2 }),
    kanban: { title: 'name', lines: ['team_id', 'days'] },
    list: ['name', 'team_id', 'priority', 'ticket_type', 'days'],
    form: { title: 'name', groups: [['team_id', 'priority', 'ticket_type'], ['days']], chatter: true },
  },
};
