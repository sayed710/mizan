import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { appraisalPlusModels, createFromTemplate, sendAppraisal, submitFeedback, completeAppraisal, dueAppraisals, scheduleDue, appraisalJobs, goalProgress, appraisalAnalysis } from './models/appraisalplus.js';

function fixture() {
  const person = create(seed(), 'hr.employee', { name: 'Review Employee', parent_id: 2, join_date: '2023-08-31' });
  const template = create(person.db, 'hr.appraisal.template', {
    name: 'Annual Review', employee_questions: [{ question: 'Achievements?', type: 'text' }, { question: 'Satisfaction?', type: 'rating' }],
    manager_questions: [{ question: 'Performance?', type: 'rating' }],
  });
  return { db: template.db, employeeId: person.id, templateId: template.id };
}
const draft = (f = fixture()) => ({ ...createFromTemplate(f.db, { ...f, date: '2024-02-29' }), employeeId: f.employeeId, templateId: f.templateId });
const employeeAnswers = [{ answer: 'Delivered the project' }, { rating: 4 }];
const managerAnswers = [{ rating: 5, answer: 'Excellent' }];
const publish = (db, id) => submitFeedback(submitFeedback(sendAppraisal(db, id), id, 'employee', employeeAnswers), id, 'manager', managerAnswers);
const button = (db, id, label) => appraisalPlusModels['hr.appraisal'].form.buttons.find((b) => b.label === label).run(db, read(db, 'hr.appraisal', id)).db;

test('appraisal templates snapshot questions, derive the manager from parent_id and refuse duplicate open reviews', () => {
  const f = fixture();
  const before = structuredClone(f.db);
  const { db, id } = draft(f);
  const r = read(db, 'hr.appraisal', id);
  assert.equal(r.manager_id, 2);
  assert.equal(r.template_id, f.templateId);
  assert.deepEqual(r.employee_feedback.map((a) => a.question), ['Achievements?', 'Satisfaction?']);
  assert.deepEqual(r.manager_feedback.map((a) => a.question), ['Performance?']);
  assert.equal(r.state, 'new');
  assert.equal(r.stage_id, 'new');
  assert.equal(r.employee_feedback_published, false);
  assert.notEqual(r.employee_feedback[0], read(db, 'hr.appraisal.template', f.templateId).employee_questions[0]);
  assert.throws(() => createFromTemplate(db, f), /already has an open/);
  assert.deepEqual(f.db, before);
  const changed = write(db, 'hr.appraisal.template', f.templateId, { employee_questions: [] });
  assert.equal(read(changed, 'hr.appraisal', id).employee_feedback.length, 2);
});

test('sending an appraisal notifies employee and manager without modifying the input', () => {
  const { db, id, employeeId, templateId } = draft();
  const before = structuredClone(db);
  const next = sendAppraisal(db, id);
  assert.equal(read(next, 'hr.appraisal', id).state, 'pending');
  assert.equal(read(next, 'hr.appraisal', id).stage_id, 'pending');
  const notes = next.messages.filter((m) => m.kind === 'note' && m.body.startsWith('Appraisal sent:'));
  assert.deepEqual(notes.map((m) => [m.model, m.res_id]), [['hr.employee', employeeId], ['hr.employee', 2]]);
  assert.throws(() => sendAppraisal(next, id), /Only a new/);
  assert.throws(() => createFromTemplate(next, { employeeId, templateId }), /already has an open/);
  assert.deepEqual(db, before);
});

test('feedback validates side, pending state, question count, order and finite 0–5 ratings', () => {
  const { db, id } = draft();
  assert.throws(() => submitFeedback(db, id, 'employee', employeeAnswers), /Send the appraisal/);
  const next = sendAppraisal(db, id);
  assert.throws(() => submitFeedback(next, id, 'other', []), /employee or manager/);
  for (const answers of [null, [], [{ answer: 'One' }], [...employeeAnswers, {}]]) {
    assert.throws(() => submitFeedback(next, id, 'employee', answers), /question count/);
  }
  assert.throws(() => submitFeedback(next, id, 'manager', [{ question: 'Wrong', rating: 3 }]), /original questions/);
  for (const rating of [-1, 6, NaN, Infinity, '4', null, undefined]) {
    assert.throws(() => submitFeedback(next, id, 'manager', [{ rating }]), /between 0 and 5/);
  }
  const zero = submitFeedback(next, id, 'manager', [{ rating: 0 }]);
  assert.equal(read(zero, 'hr.appraisal', id).manager_feedback[0].rating, 0);
  assert.equal(read(zero, 'hr.appraisal', id).manager_feedback_published, true);
  assert.equal(read(next, 'hr.appraisal', id).manager_feedback_published, false);
  const five = submitFeedback(next, id, 'manager', managerAnswers);
  assert.equal(read(five, 'hr.appraisal', id).manager_feedback[0].rating, 5);
  const edited = write(five, 'hr.appraisal', id, { manager_feedback: [{ question: 'Performance?', rating: 3 }] });
  assert.equal(read(edited, 'hr.appraisal', id).manager_feedback_published, false);
});

test('completion requires both publications, validates final rating/date and clamps leap-year anniversaries', () => {
  const { db, id } = draft();
  const sent = sendAppraisal(db, id);
  assert.throws(() => completeAppraisal(sent, id, { finalRating: 4 }), /Both sides/);
  const one = submitFeedback(sent, id, 'employee', employeeAnswers);
  assert.throws(() => completeAppraisal(one, id, { finalRating: 4 }), /Both sides/);
  const both = submitFeedback(one, id, 'manager', managerAnswers);
  for (const finalRating of [-1, 6, NaN, Infinity, '5', null]) {
    assert.throws(() => completeAppraisal(both, id, { finalRating }), /between 0 and 5/);
  }
  assert.throws(() => completeAppraisal(both, id, { finalRating: 4, date: '2024-02-30' }), /valid appraisal date/);
  const done = completeAppraisal(both, id, { finalRating: 4.5, date: '2024-02-29' });
  const r = read(done, 'hr.appraisal', id);
  assert.deepEqual([r.state, r.stage_id, r.date_close, r.next_appraisal_date, r.final_rating, r.rating], ['done', 'done', '2024-02-29', '2025-02-28', 4.5, 4.5]);
  assert.equal(read(both, 'hr.appraisal', id).state, 'pending');
  assert.throws(() => completeAppraisal(done, id, { finalRating: 5 }), /Only a pending/);
  assert.throws(() => submitFeedback(done, id, 'manager', managerAnswers), /Send the appraisal/);
});

test('due appraisals include first six-month and last-completed yearly boundaries, excluding open reviews', () => {
  const f = fixture();
  const includes = (db, date) => dueAppraisals(db, date).some((e) => e.id === f.employeeId);
  assert.equal(includes(f.db, '2024-02-28'), false);
  assert.equal(includes(f.db, '2024-02-29'), true);
  const { db, id } = draft(f);
  assert.equal(includes(db, '2026-01-01'), false);
  const done = completeAppraisal(publish(db, id), id, { finalRating: 5, date: '2024-02-29' });
  assert.equal(includes(done, '2025-02-27'), false);
  assert.equal(includes(done, '2025-02-28'), true);
  const second = createFromTemplate(done, { ...f, date: '2025-02-28' });
  const later = completeAppraisal(publish(second.db, second.id), second.id, { finalRating: 3, date: '2025-03-15' });
  assert.equal(includes(later, '2026-03-14'), false);
  assert.equal(includes(later, '2026-03-15'), true);
  const undated = create(f.db, 'hr.employee', { name: 'No start date', join_date: null });
  assert.ok(!dueAppraisals(undated.db, '2030-01-01').some((e) => e.id === undated.id));
});

test('scheduleDue is idempotent and appraisalJobs uses the first active template or returns the same db', () => {
  const f = fixture();
  const before = structuredClone(f.db);
  const scheduled = scheduleDue(f.db, '2024-02-29', f.templateId);
  const own = search(scheduled, 'hr.appraisal').filter((r) => r.employee_id === f.employeeId);
  assert.equal(own.length, 1);
  assert.equal(own[0].template_id, f.templateId);
  assert.equal(scheduleDue(scheduled, '2024-02-29', f.templateId), scheduled);
  assert.equal(appraisalJobs(scheduled, '2024-02-29'), scheduled);
  assert.deepEqual(f.db, before);
  const disabled = write(f.db, 'hr.appraisal.template', f.templateId, { active: false });
  assert.equal(appraisalJobs(disabled, '2024-02-29'), disabled);
  assert.throws(() => createFromTemplate(disabled, f), /active appraisal template/);
  const active = create(disabled, 'hr.appraisal.template', { name: 'Second Template' });
  const jobs = appraisalJobs(active.db, '2024-02-29');
  assert.equal(search(jobs, 'hr.appraisal').find((r) => r.employee_id === f.employeeId).template_id, active.id);
  assert.equal(appraisalJobs(seed(), '2024-02-29').records['hr.appraisal'].length, 2);
});

test('goals aggregate only the selected employee, expose computed completion and link to appraisals', () => {
  const f = fixture();
  assert.deepEqual(goalProgress(f.db, f.employeeId), { total: 0, done: 0, average: 0 });
  let next = f.db;
  const ids = [];
  for (const progress of ['0', '50', '100']) {
    const goal = create(next, 'hr.appraisal.goal', { name: 'Goal', employee_id: f.employeeId, progress });
    next = goal.db;
    ids.push(goal.id);
  }
  next = create(next, 'hr.appraisal.goal', { name: 'Other goal', employee_id: 1, progress: '100' }).db;
  assert.deepEqual(goalProgress(next, f.employeeId), { total: 3, done: 1, average: 50 });
  assert.equal(read(next, 'hr.appraisal.goal', ids[2]).done, true);
  assert.throws(() => write(next, 'hr.appraisal.goal', ids[0], { progress: '80' }), /valid goal progress/);
  const created = draft({ ...f, db: next });
  assert.deepEqual(read(created.db, 'hr.appraisal', created.id).goal_ids, ids.map((goal_id) => ({ goal_id })));
  assert.equal(appraisalPlusModels['hr.appraisal.goal'].kanban.groupBy, 'employee_id');
});

test('analysis groups by manager, filters inclusive dates and averages completed ratings only', () => {
  const first = draft();
  const done = completeAppraisal(publish(first.db, first.id), first.id, { finalRating: 0, date: '2024-02-29' });
  const second = createFromTemplate(done, { employeeId: first.employeeId, templateId: first.templateId, date: '2025-02-28' });
  const pending = sendAppraisal(second.db, second.id);
  assert.deepEqual(appraisalAnalysis(pending, { from: '2024-02-29', to: '2025-02-28' })[2], { done: 1, pending: 1, averageRating: 0 });
  const completed = completeAppraisal(submitFeedback(submitFeedback(pending, second.id, 'employee', employeeAnswers), second.id, 'manager', managerAnswers), second.id, { finalRating: 4, date: '2025-02-28' });
  assert.deepEqual(appraisalAnalysis(completed, { from: '2024-02-29', to: '2025-02-28' })[2], { done: 2, pending: 0, averageRating: 2 });
  assert.deepEqual(appraisalAnalysis(completed, { from: '2025-02-28', to: '2025-02-28' })[2], { done: 1, pending: 0, averageRating: 4 });
  assert.deepEqual(appraisalAnalysis(completed, { from: '2000-01-01', to: '2000-01-02' }), {});
});

test('form actions publish feedback, cancel/reopen safely and prevent reopening a duplicate', () => {
  const { db, id, employeeId, templateId } = draft();
  const cancelled = button(db, id, 'Cancel');
  assert.equal(read(cancelled, 'hr.appraisal', id).state, 'cancel');
  const reopened = button(cancelled, id, 'Reopen');
  assert.equal(read(reopened, 'hr.appraisal', id).state, 'new');
  const sent = button(reopened, id, 'Send');
  const both = button(button(sent, id, 'Submit Employee Feedback'), id, 'Submit Manager Feedback');
  assert.equal(read(both, 'hr.appraisal', id).employee_feedback_published, true);
  assert.equal(read(both, 'hr.appraisal', id).manager_feedback_published, true);
  const done = completeAppraisal(both, id, { finalRating: 3, date: '2024-06-01' });
  const again = button(done, id, 'Reopen');
  assert.equal(read(again, 'hr.appraisal', id).employee_feedback_published, false);
  const another = createFromTemplate(cancelled, { employeeId, templateId });
  assert.throws(() => button(another.db, id, 'Reopen'), /already has an open/);
  assert.throws(() => write(sent, 'hr.appraisal', id, { stage_id: 'done' }), /Both sides/);
});

test('Complete form prompt accepts zero, rejects invalid input and leaves cancellation unchanged', (t) => {
  const { db, id } = draft();
  const ready = publish(db, id);
  const original = Object.getOwnPropertyDescriptor(globalThis, 'prompt');
  t.after(() => { if (original) Object.defineProperty(globalThis, 'prompt', original); else delete globalThis.prompt; });
  globalThis.prompt = () => null;
  assert.equal(button(ready, id, 'Complete'), ready);
  globalThis.prompt = () => '';
  assert.throws(() => button(ready, id, 'Complete'), /Enter a final rating/);
  globalThis.prompt = () => '6';
  assert.throws(() => button(ready, id, 'Complete'), /between 0 and 5/);
  globalThis.prompt = () => '0';
  assert.equal(read(button(ready, id, 'Complete'), 'hr.appraisal', id).final_rating, 0);
});

test('seeded appraisals preserve legacy fields and pending/new stages in the registered override', () => {
  const db = seed();
  const reviews = search(db, 'hr.appraisal');
  assert.equal(reviews.length, 2);
  assert.deepEqual(reviews.map((r) => r.state), ['pending', 'new']);
  for (const key of ['name', 'employee_id', 'manager_id', 'date_close', 'rating', 'feedback', 'stage_id']) assert.ok(appraisalPlusModels['hr.appraisal'].fields[key]);
  assert.equal(read(sendAppraisal(db, reviews[1].id), 'hr.appraisal', reviews[1].id).state, 'pending');
  assert.throws(() => sendAppraisal(db, 99999), /Appraisal not found/);
});
