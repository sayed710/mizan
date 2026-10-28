import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { moreModels } from './models/more.js';
import { acceptOffer, applicantScore, duplicateApplicants, jobPipeline, recruitPlusModels, scheduleInterview, sendOffer } from './models/recruitplus.js';

const candidate = (db = seed(), vals = {}) => create(db, 'hr.applicant', { name: 'Rana Ali', job_id: 1, email: 'rana@example.com', ...vals });

test('interviews create calendar slots, reject overlaps, and allow adjacent or other-interviewer slots immutably', () => {
  const { db, id } = candidate();
  const snapshot = JSON.stringify(db);
  const r = read(db, 'hr.applicant', id);
  const options = { date: '2026-12-01', time: '10:00', interviewer: 'Mona' };
  const next = scheduleInterview(db, r, options);
  assert.equal(JSON.stringify(db), snapshot);
  const event = search(next, 'calendar.event').at(-1);
  assert.deepEqual([event.name, event.start, event.start_time, event.duration, event.description], ['Interview: Rana Ali — Sales Representative', options.date, '10:00', 1, 'Interviewer: Mona']);
  assert.deepEqual([read(next, 'hr.applicant', id).stage_id, read(next, 'hr.applicant', id).interviewer], ['interview', 'Mona']);
  for (const time of ['09:30', '10:00', '10:30']) assert.throws(() => scheduleInterview(next, r, { ...options, time, interviewer: ' mona ' }), /overlapping/);
  assert.doesNotThrow(() => scheduleInterview(next, r, { ...options, time: '11:00' }));
  assert.doesNotThrow(() => scheduleInterview(next, r, { ...options, interviewer: 'Omar' }));
  for (const invalid of [{ date: '2026-02-30' }, { date: '2026-99-99' }, { time: '25:00' }, { interviewer: '' }, { durationMin: 0 }]) {
    assert.throws(() => scheduleInterview(db, r, { ...options, ...invalid }), /valid interview/);
  }
  const overnight = scheduleInterview(db, r, { ...options, time: '23:30', durationMin: 120 });
  assert.throws(() => scheduleInterview(overnight, r, { ...options, date: '2026-12-02', time: '00:30' }), /overlapping/);
});

test('offers record salary and chatter, acceptance reuses hiring and cannot create a second employee', () => {
  const { db, id } = candidate(seed(), { phone: '12345', availability: '2026-12-15' });
  const r = read(db, 'hr.applicant', id);
  assert.throws(() => acceptOffer(db, r), /Send an offer/);
  for (const salary of [0, -1, Infinity, 'invalid']) assert.throws(() => sendOffer(db, r, { salary, date: '2026-12-01' }), /salary/);
  assert.throws(() => sendOffer(db, r, { salary: 9000, date: 'invalid' }), /valid offer date/);
  const offered = sendOffer(db, r, { salary: 9000, date: '2026-12-01' });
  assert.deepEqual([read(offered, 'hr.applicant', id).stage_id, read(offered, 'hr.applicant', id).salary_proposed], ['contract', 9000]);
  assert.ok(offered.messages.some((m) => m.model === 'hr.applicant' && m.res_id === id && m.kind === 'note' && m.body.includes('9000')));
  const hired = acceptOffer(offered, r);
  const applicant = read(hired, 'hr.applicant', id);
  const emp = read(hired, 'hr.employee', applicant.emp_id);
  assert.equal(search(hired, 'hr.employee').length, search(db, 'hr.employee').length + 1);
  assert.deepEqual([emp.name, emp.wage, emp.work_email, emp.mobile_phone, emp.job_title, emp.department_id, emp.join_date], ['Rana Ali', 9000, r.email, '12345', 'Sales Representative', 2, '2026-12-15']);
  assert.equal(applicant.offer_accepted, true);
  assert.equal(applicant.stage_id, 'hired');
  assert.ok(applicant.date_closed);
  assert.throws(() => acceptOffer(hired, r), /already hired/);
  assert.equal(read(db, 'hr.applicant', id).offer_sent_on, undefined);
  const refused = write(db, 'hr.applicant', id, { active: false });
  assert.throws(() => sendOffer(refused, r, { salary: 100, date: '2026-12-01' }), /refused/);
});

test('job pipeline includes archived refusals and averages valid elapsed days for hired applicants only', () => {
  const { db: withJob, id: jobId } = create(seed(), 'hr.job', { name: 'Pipeline test' });
  let db = withJob;
  for (const vals of [
    { stage_id: 'new' }, { stage_id: 'interview' }, { stage_id: 'screening', active: false },
    { stage_id: 'hired', create_date: '2026-01-01', date_closed: '2026-01-11' },
    { stage_id: 'hired', create_date: '2026-01-01', date_closed: '2026-01-21' },
    { stage_id: 'hired', create_date: null },
  ]) db = candidate(db, { job_id: jobId, ...vals }).db;
  assert.deepEqual(jobPipeline(db, jobId), { stages: { new: 1, screening: 1, interview: 1, interview2: 0, contract: 0, hired: 3 }, applicants: 6, hired: 3, refused: 1, avgDaysToHire: 15 });
  assert.equal(jobPipeline(db, -1).avgDaysToHire, 0);
  assert.equal(jobPipeline(db, -1).applicants, 0);
});

test('duplicates normalize email and phone, merge transitive matches and ignore empty contacts', () => {
  let db = seed();
  const ids = [];
  for (const vals of [
    { email: ' DUP@example.com ', phone: '111' },
    { email: 'dup@example.com', phone: '+20 (555)-123' },
    { email: 'other@example.com', phone: '20555123', active: false },
    { email: '', phone: '' }, { email: '', phone: '---' },
  ]) {
    const result = candidate(db, vals);
    db = result.db;
    ids.push(result.id);
  }
  assert.deepEqual(duplicateApplicants(db).map((g) => g.map((r) => r.id).sort((a, b) => a - b)), [ids.slice(0, 3)]);
});

test('score weighs three stars, unique required skills and positive expected salary within budget', () => {
  const job = { skills: ['JS', 'SQL', 'sql'], salary_max: 1000 };
  assert.equal(applicantScore({}, job), 0);
  assert.equal(applicantScore({ priority: 3, skills: ['js', ' SQL '], salary_expected: 1000 }, job), 100);
  assert.equal(applicantScore({ priority: 0, skills: ['js'], salary_expected: 1001 }, job), 20);
  assert.equal(applicantScore({ priority: 99, skills: ['js', 'sql'], expected_salary: 999 }, job), 100);
  assert.equal(applicantScore({ priority: -2, salary_expected: 0 }, job), 0);
  assert.equal(applicantScore({ priority: 3 }, {}), 40);
});

test('model extension preserves seed, legacy fields, stages and actions while adding offer and skills forms', () => {
  const model = recruitPlusModels['hr.applicant'];
  const original = moreModels['hr.applicant'];
  for (const key of Object.keys(original.fields)) assert.ok(model.fields[key], key);
  assert.deepEqual(model.fields.stage_id.options, original.fields.stage_id.options);
  assert.deepEqual(model.form.buttons.slice(0, 3), original.form.buttons);
  assert.ok(model.form.tabs.some((t) => t.label === 'Offer'));
  assert.ok(model.form.tabs.some((t) => t.label === 'Skills'));
  assert.ok(model.fields.degree.options.some(([id]) => id === 'doctoral'));
  const db = seed();
  assert.ok(search(db, 'hr.applicant').length > 0);
  assert.ok(search(db, 'hr.job').some((j) => j.is_published));
  assert.ok(search(db, 'hr.applicant').every((r) => original.fields.stage_id.options.some(([id]) => id === r.stage_id)));
});
