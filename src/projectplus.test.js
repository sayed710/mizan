import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { generateRecurringTasks, milestoneProgress, nextOccurrences, postUpdate, projectPlusModels, projectStatus, reachMilestone } from './models/projectplus.js';

const project = () => create(seed(), 'project.project', { name: 'Project Plus' });
const button = (label) => projectPlusModels['project.milestone'].form.buttons.find((b) => b.label === label);

test('milestone progress counts only linked tasks; reaching requires completion or force and reopening clears its date', () => {
  const { db: base, id: projectId } = project();
  const { db: empty, id } = create(base, 'project.milestone', { name: 'Beta', project_id: projectId });
  assert.deepEqual(milestoneProgress(empty, id), { tasks: 0, done: 0, percent: 0 });
  assert.equal(read(reachMilestone(empty, read(empty, 'project.milestone', id), { date: '2026-06-01' }), 'project.milestone', id).is_reached, true);
  const { db: one, id: taskId } = create(empty, 'project.task', { name: 'Build', milestone_id: id });
  const two = create(one, 'project.task', { name: 'Review', milestone_id: id, state: 'done' }).db;
  const db = create(two, 'project.task', { name: 'Elsewhere', milestone_id: id + 1, stage_id: 'done' }).db;
  const milestone = read(db, 'project.milestone', id);
  assert.deepEqual(milestoneProgress(db, id), { tasks: 2, done: 1, percent: 50 });
  assert.throws(() => reachMilestone(db, milestone), { message: 'Some tasks of this milestone are not done' });
  const reached = reachMilestone(db, milestone, { force: true, date: '2026-06-02' });
  assert.equal(read(reached, 'project.milestone', id).reached_date, '2026-06-02');
  assert.equal(read(db, 'project.milestone', id).is_reached, false);
  assert.equal(button('Reopen').when(read(reached, 'project.milestone', id)), true);
  const reopened = write(reached, 'project.milestone', id, button('Reopen').vals);
  assert.equal(read(reopened, 'project.milestone', id).reached_date, null);
  assert.equal(read(reopened, 'project.milestone', id).is_reached, false);
  const finished = write(reopened, 'project.task', taskId, { stage_id: 'done' });
  assert.deepEqual(milestoneProgress(finished, id), { tasks: 2, done: 2, percent: 100 });
  assert.equal(read(reachMilestone(finished, milestone), 'project.milestone', id).is_reached, true);
});

test('the milestone button asks before forcing and cancellation leaves the database unchanged', (t) => {
  const { db: base, id } = create(seed(), 'project.milestone', { name: 'Delivery' });
  const db = create(base, 'project.task', { name: 'Open', milestone_id: id }).db;
  const r = read(db, 'project.milestone', id);
  const original = Object.getOwnPropertyDescriptor(globalThis, 'confirm');
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'confirm', original);
    else delete globalThis.confirm;
  });
  let prompted = 0;
  globalThis.confirm = () => { prompted++; return false; };
  assert.strictEqual(button('Mark as Reached').run(db, r).db, db);
  assert.equal(prompted, 1);
  globalThis.confirm = () => true;
  const reached = button('Mark as Reached').run(db, r).db;
  assert.equal(read(reached, 'project.milestone', id).is_reached, true);
});

test('project status scopes tasks, counts done by stage or state, and selects the earliest unreached milestone', () => {
  const { db: base, id } = project();
  let db = base;
  for (const vals of [
    { name: 'Late', date_deadline: '2026-05-31', planned_hours: 3 },
    { name: 'Due today', date_deadline: '2026-06-01', planned_hours: 2 },
    { name: 'No deadline', planned_hours: 1 },
    { name: 'Stage done', stage_id: 'done', date_deadline: '2026-01-01', planned_hours: 4 },
    { name: 'State done', state: 'done', planned_hours: 5 },
  ]) db = create(db, 'project.task', { project_id: id, ...vals }).db;
  db = create(db, 'project.task', { name: 'Other project', project_id: id + 1, date_deadline: '2026-01-01', planned_hours: 100 }).db;
  for (const vals of [
    { name: 'Undated' }, { name: 'Release', deadline: '2026-08-01' },
    { name: 'Already reached', deadline: '2026-01-01', is_reached: true },
  ]) db = create(db, 'project.milestone', { project_id: id, ...vals }).db;
  const { db: withBeta, id: beta } = create(db, 'project.milestone', { name: 'Beta', project_id: id, deadline: '2026-07-01' });
  const final = create(withBeta, 'project.milestone', { name: 'Other', project_id: id + 1, deadline: '2026-01-01' }).db;
  assert.deepEqual(projectStatus(final, id, '2026-06-01'), {
    open: 3, done: 2, late: 1, percentDone: 40, hoursPlanned: 15, nextMilestone: read(final, 'project.milestone', beta),
  });
  assert.deepEqual(projectStatus(base, id), { open: 0, done: 0, late: 0, percentDone: 0, hoursPlanned: 0, nextMilestone: null });
});

test('posting an update snapshots task health and records project status without changing the original database', () => {
  const { db: base, id } = project();
  let db = create(base, 'project.task', { name: 'Done', project_id: id, stage_id: 'done' }).db;
  db = create(db, 'project.task', { name: 'Late', project_id: id, date_deadline: '2026-05-31' }).db;
  db = create(db, 'project.milestone', { name: 'Beta', project_id: id, deadline: '2026-07-01' }).db;
  const vals = { name: 'Weekly update', status: 'at_risk', progress: 60, author: 'Ada', description: 'Waiting for review', date: '2026-06-01' };
  const posted = postUpdate(db, id, vals);
  const update = search(posted, 'project.update').find((r) => r.project_id === id);
  assert.equal(update.summary, '2 tasks, 1 done (50%), 1 late; next milestone: Beta (2026-07-01)');
  for (const [key, value] of Object.entries(vals)) assert.equal(update[key], value);
  assert.equal(read(posted, 'project.project', id).last_update_status, 'at_risk');
  assert.equal(read(db, 'project.project', id).last_update_status, undefined);
  assert.equal(search(db, 'project.update').length, 0);
  for (const progress of [-1, 101, 1.5, NaN, '50']) assert.throws(() => postUpdate(db, id, { ...vals, progress }), /Progress/);
  assert.throws(() => postUpdate(db, id, { ...vals, status: 'unknown' }), /valid project status/);
  assert.throws(() => postUpdate(db, -1, vals), /existing project/);
  for (const progress of [0, 100]) {
    const next = postUpdate(base, id, { ...vals, progress });
    assert.equal(search(next, 'project.update')[0].summary, '0 tasks, 0 done (0%), 0 late; next milestone: None');
  }
});

test('daily and weekly occurrences include the start and cutoff but exclude last_date', () => {
  const r = { start_date: '2026-01-01', interval: 2, unit: 'day' };
  assert.deepEqual(nextOccurrences(r, '2026-01-05'), ['2026-01-01', '2026-01-03', '2026-01-05']);
  assert.deepEqual(nextOccurrences({ ...r, last_date: '2026-01-03' }, '2026-01-05'), ['2026-01-05']);
  assert.deepEqual(nextOccurrences({ ...r, unit: 'week' }, '2026-01-29'), ['2026-01-01', '2026-01-15', '2026-01-29']);
  assert.deepEqual(nextOccurrences(r, '2025-12-31'), []);
});

test('monthly occurrences clamp from the original day, including leap years and year boundaries', () => {
  const r = { start_date: '2026-01-31', interval: 1, unit: 'month' };
  assert.deepEqual(nextOccurrences(r, '2026-04-30'), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
  assert.deepEqual(nextOccurrences({ ...r, start_date: '2028-01-31' }, '2028-03-31'), ['2028-01-31', '2028-02-29', '2028-03-31']);
  assert.deepEqual(nextOccurrences({ ...r, start_date: '2026-12-31', interval: 2 }, '2027-04-30'), ['2026-12-31', '2027-02-28', '2027-04-30']);
  assert.equal(r.start_date, '2026-01-31');
});

test('until is inclusive and count caps the whole schedule, not each generation batch', () => {
  const r = { start_date: '2026-01-01', interval: 1, unit: 'day' };
  assert.deepEqual(nextOccurrences({ ...r, until: '2026-01-03' }, '2026-02-01'), ['2026-01-01', '2026-01-02', '2026-01-03']);
  assert.deepEqual(nextOccurrences({ ...r, count: 3, last_date: '2026-01-02' }, '2026-02-01'), ['2026-01-03']);
  assert.deepEqual(nextOccurrences({ ...r, count: 3, last_date: '2026-01-03' }, '2026-02-01'), []);
  assert.deepEqual(nextOccurrences({ ...r, count: 5, until: '2026-01-02' }, '2026-02-01'), ['2026-01-01', '2026-01-02']);
  for (const interval of [0, -1, 1.5]) assert.throws(() => nextOccurrences({ ...r, interval }, '2026-02-01'), /interval/);
  assert.throws(() => nextOccurrences({ ...r, count: -1 }, '2026-02-01'), /count/);
  assert.throws(() => nextOccurrences({ ...r, unit: 'year' }, '2026-02-01'), /unit/);
  assert.throws(() => nextOccurrences({ ...r, start_date: '2026-02-30' }, '2026-03-01'), /valid recurrence dates/);
});

test('generation copies schedule values, skips inactive and future schedules, and is idempotent across batches', () => {
  const { db: base, id: projectId } = project();
  const { db: scheduled, id } = create(base, 'project.recurrence', {
    name: 'Inspection', project_id: projectId, user_id: 1, planned_hours: 2,
    interval: 1, unit: 'day', start_date: '2026-06-01', count: 3,
  });
  let db = create(scheduled, 'project.recurrence', { name: 'Inactive', active: false, start_date: '2026-01-01' }).db;
  db = create(db, 'project.recurrence', { name: 'Future', start_date: '2027-01-01' }).db;
  const once = generateRecurringTasks(db, '2026-06-02');
  const tasks = search(once, 'project.task').filter((r) => r.recurrence_id === id);
  assert.deepEqual(tasks.map((r) => [r.name, r.date_deadline, r.project_id, r.user_id, r.planned_hours, r.stage_id]), [
    ['Inspection (2026-06-01)', '2026-06-01', projectId, 1, 2, 'todo'],
    ['Inspection (2026-06-02)', '2026-06-02', projectId, 1, 2, 'todo'],
  ]);
  assert.equal(search(once, 'project.task').length - search(db, 'project.task').length, 2);
  assert.equal(read(once, 'project.recurrence', id).last_date, '2026-06-02');
  assert.equal(read(db, 'project.recurrence', id).last_date, undefined);
  assert.strictEqual(generateRecurringTasks(once, '2026-06-02'), once);
  const final = generateRecurringTasks(once, '2026-06-30');
  assert.equal(search(final, 'project.task').filter((r) => r.recurrence_id === id).length, 3);
  assert.equal(read(final, 'project.recurrence', id).last_date, '2026-06-03');
  assert.strictEqual(generateRecurringTasks(final, '2026-06-30'), final);
});

test('all project depth models expose grouped kanban, list and chatter forms', () => {
  assert.equal(Object.keys(projectPlusModels).length, 3);
  for (const model of Object.values(projectPlusModels)) {
    assert.deepEqual(model.groupBys, ['project_id']);
    assert.equal(model.form.chatter, true);
    assert.ok(model.fields[model.kanban.title]);
    assert.ok(model.list.every((name) => model.fields[name]));
  }
  assert.equal(projectPlusModels['project.milestone'].fields.reached_date.readonly, true);
  assert.equal(projectPlusModels['project.update'].fields.summary.readonly, true);
  assert.equal(projectPlusModels['project.recurrence'].fields.last_date.readonly, true);
});
