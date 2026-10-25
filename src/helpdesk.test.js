import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, postNote, read, search, write } from './orm.js';
import { models } from './models/index.js';
import { assignTicket, autoCloseStale, mergeTickets, rateTicket, slaStatus, teamStats } from './models/helpdesk.js';
import { addDays, today } from './models/common.js';
import { seed } from './seed.js';

test('the strictest matching SLA sets the deadline; solving late fails it', () => {
  const db0 = seed();
  const team = search(db0, 'helpdesk.team')[0].id;
  const { db, id } = create(db0, 'helpdesk.ticket', { name: 'Broken chair', create_date: addDays(today(), -5) });
  const normal = write(db, 'helpdesk.ticket', id, { team_id: team });
  assert.equal(read(normal, 'helpdesk.ticket', id).sla_deadline, addDays(today(), -2));
  assert.equal(read(normal, 'helpdesk.ticket', id).sla_status, 'failed');
  const urgent = write(normal, 'helpdesk.ticket', id, { priority: 3 });
  assert.equal(read(urgent, 'helpdesk.ticket', id).sla_deadline, addDays(today(), -5));
  const solved = write(urgent, 'helpdesk.ticket', id, { stage_id: 'solved' });
  assert.equal(read(solved, 'helpdesk.ticket', id).close_date, today());
  assert.equal(slaStatus({ sla_deadline: today(), stage_id: 'solved', close_date: addDays(today(), -1) }, addDays(today(), 9)), 'ok');
});

test('planning an intervention creates a linked field service task', () => {
  const db0 = seed();
  const ticket = search(db0, 'helpdesk.ticket')[0];
  const out = models['helpdesk.ticket'].form.buttons.find((b) => b.label === 'Plan Intervention').run(db0, ticket);
  const task = read(out.db, 'fsm.task', read(out.db, 'helpdesk.ticket', ticket.id).fsm_task_id);
  assert.equal(task.name, ticket.name);
  assert.equal(task.partner_id, ticket.partner_id ?? null);
});

test('balanced assignment picks the lightest member and breaks ties by employee id', () => {
  const { db: teamDb, id: teamId } = create(seed(), 'helpdesk.team', {
    name: 'Balanced Pool', assign_method: 'balanced', member_ids: [{ employee_id: 9 }, { employee_id: 4 }],
  });
  const first = create(teamDb, 'helpdesk.ticket', { name: 'Assigned to nine', team_id: teamId, user_id: 9, stage_id: 'progress' });
  const second = create(first.db, 'helpdesk.ticket', { name: 'Waiting one', team_id: teamId, stage_id: 'new' });
  const assigned = assignTicket(second.db, read(second.db, 'helpdesk.ticket', second.id));
  assert.equal(read(assigned, 'helpdesk.ticket', second.id).user_id, 4);

  const third = create(assigned, 'helpdesk.ticket', { name: 'Waiting two', team_id: teamId, stage_id: 'new' });
  const tied = assignTicket(third.db, read(third.db, 'helpdesk.ticket', third.id));
  assert.equal(read(tied, 'helpdesk.ticket', third.id).user_id, 4);
});

test('round-robin assignment uses ticket id modulo the sorted team members and manual teams stay unchanged', () => {
  const { db: teamDb, id: teamId } = create(seed(), 'helpdesk.team', {
    name: 'Round Robin', assign_method: 'random', member_ids: [{ employee_id: 8 }, { employee_id: 3 }],
  });
  const first = create(teamDb, 'helpdesk.ticket', { name: 'First round robin', team_id: teamId });
  const assigned = assignTicket(first.db, read(first.db, 'helpdesk.ticket', first.id));
  assert.equal(read(assigned, 'helpdesk.ticket', first.id).user_id, [3, 8][first.id % 2]);

  const second = create(assigned, 'helpdesk.ticket', { name: 'Second round robin', team_id: teamId });
  const next = assignTicket(second.db, read(second.db, 'helpdesk.ticket', second.id));
  assert.equal(read(next, 'helpdesk.ticket', second.id).user_id, [3, 8][second.id % 2]);

  const manual = create(next, 'helpdesk.team', {
    name: 'Manual Queue', assign_method: 'manual', member_ids: [{ employee_id: 3 }],
  });
  const unassigned = create(manual.db, 'helpdesk.ticket', { name: 'Manual ticket', team_id: manual.id });
  assert.equal(assignTicket(unassigned.db, read(unassigned.db, 'helpdesk.ticket', unassigned.id)), unassigned.db);
  assert.equal(read(unassigned.db, 'helpdesk.ticket', unassigned.id).user_id, undefined);
});

test('merging combines descriptions, moves chatter and cancels sources; self and customer mismatches are refused', () => {
  const target = create(seed(), 'helpdesk.ticket', {
    name: 'Main ticket', partner_id: 1, description: 'Original details', priority: 3, stage_id: 'progress',
  });
  const source = create(target.db, 'helpdesk.ticket', {
    name: 'Related issue', partner_id: 1, description: 'Second details', stage_id: 'progress',
  });
  const withMessage = postNote(source.db, 'helpdesk.ticket', source.id, 'Source customer update');
  const sourceMessage = withMessage.messages.at(-1);
  const merged = mergeTickets(withMessage, target.id, [source.id]);
  const mergedTarget = read(merged, 'helpdesk.ticket', target.id);
  const mergedSource = read(merged, 'helpdesk.ticket', source.id);

  assert.match(mergedTarget.description, /Original details/);
  assert.match(mergedTarget.description, /--- Merged from Related issue ---\nSecond details/);
  assert.equal(mergedTarget.priority, 3);
  assert.equal(mergedSource.stage_id, 'cancelled');
  assert.equal(mergedSource.merged_into, target.id);
  assert.equal(merged.messages.find((message) => message.id === sourceMessage.id).res_id, target.id);
  assert.throws(() => mergeTickets(withMessage, target.id, [target.id]), /itself/);

  const otherCustomer = create(withMessage, 'helpdesk.ticket', { name: 'Other customer', partner_id: 2 });
  assert.throws(() => mergeTickets(otherCustomer.db, target.id, [otherCustomer.id]), /different customers/);
});

test('automatic closing honors team age, enablement, eligible stage, and write-date freshness', () => {
  const { db: teamDb, id: teamId } = create(seed(), 'helpdesk.team', {
    name: 'Auto Close', auto_close: true,
  });
  const { db: offDb, id: offTeamId } = create(teamDb, 'helpdesk.team', {
    name: 'Keep Open', auto_close: false, auto_close_days: 1,
  });
  let db = offDb;
  const addTicket = (vals) => {
    const result = create(db, 'helpdesk.ticket', { name: 'Auto-close candidate', team_id: teamId, ...vals });
    db = result.db;
    return result.id;
  };
  const stale = addTicket({ stage_id: 'hold', create_date: addDays(today(), -8) });
  const fresh = addTicket({ stage_id: 'hold', create_date: addDays(today(), -6) });
  const wrongStage = addTicket({ stage_id: 'progress', create_date: addDays(today(), -30) });
  const recentlyChanged = addTicket({ stage_id: 'hold', create_date: addDays(today(), -30), write_date: addDays(today(), -1) });
  const disabled = create(db, 'helpdesk.ticket', { name: 'Disabled team ticket', team_id: offTeamId, stage_id: 'hold', create_date: addDays(today(), -30) });
  db = disabled.db;

  const closed = autoCloseStale(db, today());
  assert.equal(read(closed, 'helpdesk.ticket', stale).stage_id, 'solved');
  assert.equal(read(closed, 'helpdesk.ticket', stale).close_date, today());
  assert.equal(read(closed, 'helpdesk.ticket', fresh).stage_id, 'hold');
  assert.equal(read(closed, 'helpdesk.ticket', wrongStage).stage_id, 'progress');
  assert.equal(read(closed, 'helpdesk.ticket', recentlyChanged).stage_id, 'hold');
  assert.equal(read(closed, 'helpdesk.ticket', disabled.id).stage_id, 'hold');
  assert.ok(closed.messages.some((message) => message.model === 'helpdesk.ticket' && message.res_id === stale && message.kind === 'note'));

  const overrideTeam = create(seed(), 'helpdesk.team', { name: 'Explicit Threshold', auto_close: true, auto_close_days: 30 });
  const overrideTicket = create(overrideTeam.db, 'helpdesk.ticket', {
    name: 'Override threshold candidate', team_id: overrideTeam.id, stage_id: 'hold', create_date: addDays(today(), -6),
  });
  assert.equal(read(autoCloseStale(overrideTicket.db, today(), 5), 'helpdesk.ticket', overrideTicket.id).stage_id, 'solved');
});

test('ratings require a solved ticket, an integer from one to five, and a single submission', () => {
  const solved = create(seed(), 'helpdesk.ticket', { name: 'Solved request', stage_id: 'solved' });
  const rated = rateTicket(solved.db, solved.id, 5, 'Quick and helpful');
  assert.equal(read(rated, 'helpdesk.ticket', solved.id).rating, 5);
  assert.equal(read(rated, 'helpdesk.ticket', solved.id).rating_comment, 'Quick and helpful');
  assert.throws(() => rateTicket(rated, solved.id, 4, 'Second rating'), /once/);
  assert.throws(() => rateTicket(solved.db, solved.id, 5.5, 'Not an integer'), /integer/);
  assert.throws(() => rateTicket(solved.db, solved.id, 0, 'Out of range'), /integer/);

  const open = create(solved.db, 'helpdesk.ticket', { name: 'Still open', stage_id: 'progress' });
  assert.throws(() => rateTicket(open.db, open.id, 4, 'Too early'), /closed or solved/);
});

test('team stats count open, unassigned, urgent, failed SLA, average rating, and close days', () => {
  const { db: teamDb, id: teamId } = create(seed(), 'helpdesk.team', { name: 'Metrics Team', assign_method: 'manual' });
  const sla = create(teamDb, 'helpdesk.sla', { name: 'Two day target', team_id: teamId, priority: '0', days: 2 });
  let db = sla.db;
  const addTicket = (vals) => {
    const created = create(db, 'helpdesk.ticket', { name: 'Metrics sample', ...vals });
    db = write(created.db, 'helpdesk.ticket', created.id, { team_id: teamId });
    return created.id;
  };
  addTicket({ stage_id: 'progress', priority: 3, create_date: addDays(today(), -10) });
  addTicket({ stage_id: 'solved', priority: 1, user_id: 1, rating: 4, create_date: addDays(today(), -8), close_date: addDays(today(), -7) });
  addTicket({ stage_id: 'solved', priority: 1, user_id: 1, rating: 2, create_date: addDays(today(), -4), close_date: addDays(today(), -2) });

  assert.deepEqual(teamStats(db, teamId), {
    open: 1,
    unassigned: 1,
    urgent: 1,
    failedSla: 1,
    avgRating: 3,
    avgCloseDays: 1.5,
  });
});
