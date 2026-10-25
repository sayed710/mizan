import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { models } from './models/index.js';
import { slaStatus } from './models/helpdesk.js';
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
