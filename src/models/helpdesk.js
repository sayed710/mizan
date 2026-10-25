// Helpdesk teams and SLA policies: a ticket's deadline comes from the strictest matching policy.
import { postNote, read, search, write } from '../orm.js';
import { addDays, today } from './common.js';

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

const CLOSED_STAGES = new Set(['solved', 'cancelled', 'closed']);
const WAITING_STAGES = new Set(['hold', 'waiting', 'solved']);
const DAY_MS = 24 * 60 * 60 * 1000;

const timestamp = (value) => {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
};

/** Assigns an unassigned ticket from its team's balanced or deterministic round-robin policy. */
export function assignTicket(db, ticket) {
  const current = read(db, 'helpdesk.ticket', ticket.id) ?? ticket;
  if (current.user_id != null || current.team_id == null) return db;

  const team = read(db, 'helpdesk.team', current.team_id);
  const method = team?.assign_method ?? team?.assignment ?? 'manual';
  if (!team || method === 'manual') return db;

  const members = [...new Set((team.member_ids ?? [])
    .map((line) => line.employee_id)
    .filter((id) => id != null))]
    .sort((a, b) => Number(a) - Number(b));
  if (!members.length) return db;

  let employeeId;
  if (method === 'random') {
    employeeId = members[(Number(current.id) || 0) % members.length];
  } else if (method === 'balanced') {
    const counts = new Map(members.map((id) => [id, 0]));
    (db.records['helpdesk.ticket'] ?? []).forEach((record) => {
      if (record.team_id === current.team_id && !CLOSED_STAGES.has(record.stage_id) && counts.has(record.user_id)) {
        counts.set(record.user_id, counts.get(record.user_id) + 1);
      }
    });
    employeeId = members.sort((a, b) => counts.get(a) - counts.get(b) || Number(a) - Number(b))[0];
  } else {
    return db;
  }

  return write(db, 'helpdesk.ticket', current.id, { user_id: employeeId });
}

/** Merges same-customer tickets into a target, preserving source chatter and marking sources cancelled. */
export function mergeTickets(db, targetId, sourceIds) {
  const target = read(db, 'helpdesk.ticket', targetId);
  if (!target) throw new Error(`helpdesk.ticket #${targetId} not found`);
  const ids = [...new Set(sourceIds ?? [])];
  if (ids.includes(targetId)) throw new Error('A ticket cannot be merged into itself');

  const sources = ids.map((id) => read(db, 'helpdesk.ticket', id));
  if (sources.some((source) => !source)) throw new Error('A source ticket was not found');
  const customers = new Set([target, ...sources].map((t) => t.partner_id).filter((p) => p != null).map(String));
  if (customers.size > 1) {
    throw new Error('Tickets with different customers cannot be merged');
  }

  const description = [target.description, ...sources.map((source) =>
    `--- Merged from ${source.name} ---\n${source.description ?? ''}`)]
    .filter((part) => part != null && part !== '')
    .join('\n\n');
  const partnerId = target.partner_id ?? sources.find((s) => s.partner_id != null)?.partner_id ?? null;
  let next = write(db, 'helpdesk.ticket', targetId, { description, partner_id: partnerId });
  sources.forEach((source) => {
    next = write(next, 'helpdesk.ticket', source.id, {
      stage_id: 'cancelled',
      close_date: today(),
      merged_into: targetId,
    });
  });
  const sourceSet = new Set(ids);
  next = {
    ...next,
    messages: next.messages.map((message) =>
      message.model === 'helpdesk.ticket' && sourceSet.has(message.res_id)
        ? { ...message, res_id: targetId }
        : message),
  };
  return next;
}

/** Closes stale waiting or solved tickets for teams with auto-close enabled. */
export function autoCloseStale(db, at, days) {
  const atTime = timestamp(at);
  if (atTime == null) return db;
  let next = db;
  search(db, 'helpdesk.ticket').forEach((ticket) => {
    const team = read(db, 'helpdesk.team', ticket.team_id);
    if (!team?.auto_close || !WAITING_STAGES.has(ticket.stage_id) || (ticket.stage_id === 'solved' && ticket.close_date)) return;
    const ageDays = Number(days ?? team.auto_close_days ?? 7);
    const lastChange = timestamp(ticket.write_date || ticket.create_date);
    if (!Number.isFinite(ageDays) || lastChange == null || lastChange > atTime - ageDays * DAY_MS) return;

    const closeDate = ticket.stage_id === 'solved' ? ticket.close_date ?? at : at;
    next = write(next, 'helpdesk.ticket', ticket.id, { stage_id: 'solved', close_date: closeDate });
    next = postNote(next, 'helpdesk.ticket', ticket.id, `Automatically closed after ${ageDays} days without an update.`);
  });
  return next;
}

/** Adds a one-time 1–5 rating to a solved ticket. */
export function rateTicket(db, ticketId, rating, comment) {
  const ticket = read(db, 'helpdesk.ticket', ticketId);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new Error('Rating must be an integer from 1 to 5');
  if (!ticket || !['solved', 'closed'].includes(ticket.stage_id)) throw new Error('Only closed or solved tickets can be rated');
  if (ticket.rating != null) throw new Error('A ticket can only be rated once');
  return write(db, 'helpdesk.ticket', ticketId, { rating, rating_comment: comment ?? '' });
}

/** Summarizes open, urgent, SLA, rating, and close-time metrics for one team. */
export function teamStats(db, teamId) {
  const tickets = search(db, 'helpdesk.ticket').filter((ticket) => ticket.team_id === teamId);
  const open = tickets.filter((ticket) => !CLOSED_STAGES.has(ticket.stage_id));
  const ratings = tickets.map((ticket) => ticket.rating).filter((rating) => Number.isInteger(rating) && rating >= 1 && rating <= 5);
  const closeDays = tickets.map((ticket) => {
    const created = timestamp(ticket.create_date);
    const closed = timestamp(ticket.close_date);
    return created == null || closed == null ? null : (closed - created) / DAY_MS;
  }).filter((days) => days != null && days >= 0);
  const average = (values) => values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;

  return {
    open: open.length,
    unassigned: open.filter((ticket) => ticket.user_id == null).length,
    urgent: tickets.filter((ticket) => Number(ticket.priority) >= 3).length,
    failedSla: tickets.filter((ticket) => slaStatus(ticket, today()) === 'failed').length,
    avgRating: average(ratings),
    avgCloseDays: average(closeDays),
  };
}

export const ticketExtraFields = {
  user_id: { type: 'many2one', relation: 'hr.employee', label: 'Assigned to' },
  rating: { type: 'integer', label: 'Customer Rating' },
  rating_comment: { type: 'text', label: 'Rating Comment' },
  merged_into: { type: 'many2one', relation: 'helpdesk.ticket', label: 'Merged Into', readonly: true },
};

export const helpdeskModels = {
  'helpdesk.team': {
    label: 'Helpdesk Teams',
    fields: {
      name: { type: 'char', label: 'Team', required: true },
      email: { type: 'char', label: 'Email Alias' },
      assignment: { type: 'selection', label: 'Assignment', options: [['manual', 'Manual'], ['balanced', 'Balanced workload'], ['random', 'Randomly']] },
      assign_method: { type: 'selection', label: 'Assignment Method', options: [['manual', 'Manual'], ['random', 'Round Robin'], ['balanced', 'Balanced Workload']] },
      member_ids: {
        type: 'one2many', label: 'Team Members',
        fields: { employee_id: { type: 'many2one', relation: 'hr.employee', label: 'Employee', required: true } },
        newLine: () => ({ employee_id: null }),
      },
      auto_close: { type: 'boolean', label: 'Automatic Closing' },
      auto_close_days: { type: 'integer', label: 'Close After (Days)' },
      use_rating: { type: 'boolean', label: 'Customer Ratings' },
      use_sla: { type: 'boolean', label: 'SLA Policies' },
      use_fsm: { type: 'boolean', label: 'Field Service' },
    },
    defaults: () => ({ assignment: 'manual', member_ids: [], auto_close: false, auto_close_days: 7, use_rating: true, use_sla: true }),
    kanban: { title: 'name', lines: ['email', 'assignment'] },
    list: ['name', 'email', 'assignment', 'use_sla'],
    form: { title: 'name', groups: [['email', 'assign_method', 'assignment'], ['use_sla', 'use_fsm', 'auto_close', 'auto_close_days', 'use_rating']], tabs: [{ label: 'Members', fields: ['member_ids'] }], chatter: true },
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
