import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { skillsPlusModels, setSkill, skillMatrix, employeesWithSkill, certificationsExpiring, referralLink, referFromLink, syncFromApplicant, points, buyReward, leaderboard } from './models/skillsplus.js';
import { acceptOffer, scheduleInterview, sendOffer } from './models/recruitplus.js';

const type = (db) => create(db, 'hr.skill.type', {
  name: 'Engineering', skill_ids: [{ name: 'JavaScript' }, { name: 'SQL' }],
  level_ids: [{ name: 'Learning', level_progress: 25, default_level: true }, { name: 'Expert', level_progress: 100, default_level: false }],
});
const referred = (db, employeeId = 1, email = 'candidate@example.test', jobId = 1) => {
  const token = new URL(referralLink(db, employeeId, jobId), 'https://mizan.test').searchParams.get('ref');
  return referFromLink(db, { token, jobId, name: 'New Candidate', email });
};
const reward = (db, vals = {}) => create(db, 'hr.referral.reward', { name: 'Gift', cost: 30, quantity: 2, ...vals });

test('skill types validate levels and setSkill creates then updates one immutable row', () => {
  const initial = seed();
  const { db, id } = type(initial);
  const snapshot = structuredClone(db);
  const assigned = setSkill(db, 1, { typeId: id, skill: 'JavaScript', level: 'Learning' });
  const updated = setSkill(assigned, 1, { typeId: id, skill: 'JavaScript', level: 'Expert' });
  assert.deepEqual(db, snapshot);
  assert.equal(search(assigned, 'hr.employee.skill')[0].level_progress, 25);
  assert.deepEqual(search(updated, 'hr.employee.skill').map((r) => [r.skill, r.level, r.level_progress]), [['JavaScript', 'Expert', 100]]);
  assert.throws(() => setSkill(db, 1, { typeId: id, skill: 'Python', level: 'Expert' }), /skill belonging/);
  assert.throws(() => setSkill(db, 1, { typeId: id, skill: 'SQL', level: 'Native' }), /level belonging/);
  assert.throws(() => setSkill(db, 99999, { typeId: id, skill: 'SQL', level: 'Expert' }), /not found/);
  assert.throws(() => create(db, 'hr.skill.type', { name: 'Bad', level_ids: [{ name: 'Bad', level_progress: 101 }] }), /between 0 and 100/);
  assert.throws(() => create(db, 'hr.skill.type', { name: 'Bad', level_ids: [{ name: 'Bad', level_progress: -1 }] }), /between 0 and 100/);
  assert.throws(() => create(db, 'hr.skill.type', { name: 'Bad', level_ids: [{ name: 'A', level_progress: 0, default_level: true }, { name: 'B', level_progress: 100, default_level: true }] }), /one level/);
  assert.throws(() => create(db, 'hr.skill.type', { name: 'Bad', skill_ids: [{ name: 'SQL' }, { name: 'SQL' }] }), /unique/);
  const row = search(updated, 'hr.employee.skill')[0];
  assert.throws(() => create(updated, 'hr.employee.skill', { employee_id: 1, skill_type_id: id, skill: 'JavaScript', level: 'Expert', level_progress: 100 }), /already has/);
  assert.throws(() => write(updated, 'hr.employee.skill', row.id, { level: 'Invalid' }), /level belonging/);
  assert.throws(() => write(updated, 'hr.skill.type', id, { skill_ids: [] }), /used by an employee/);
  assert.throws(() => write(updated, 'hr.employee.skill', row.id, { level_progress: 42 }), /match the selected level/);
  assert.throws(() => write(updated, 'hr.skill.type', id, { level_ids: [{ name: 'Learning', level_progress: 25 }, { name: 'Expert', level_progress: 90 }] }), /used by an employee/);
  const downgraded = write(updated, 'hr.employee.skill', row.id, { level: 'Learning' });
  assert.equal(read(downgraded, 'hr.employee.skill', row.id).level_progress, 25);
  assert.equal(skillsPlusModels['hr.skill.type'].form.tabs.length, 2);
});

test('matrix includes unskilled employees and minimum-progress search requires a real skill row', () => {
  const { db, id } = type(seed());
  const first = setSkill(db, 1, { typeId: id, skill: 'JavaScript', level: 'Expert' });
  const second = setSkill(first, 2, { typeId: id, skill: 'JavaScript', level: 'Learning' });
  const rows = skillMatrix(second, id);
  assert.equal(rows.length, search(db, 'hr.employee').length);
  assert.deepEqual(rows.find((r) => r.employee_id === 1).skills, { JavaScript: 100, SQL: 0 });
  assert.deepEqual(rows.find((r) => r.employee_id === 3).skills, { JavaScript: 0, SQL: 0 });
  assert.deepEqual(employeesWithSkill(second, { typeId: id, skill: 'JavaScript', minProgress: 25 }).map((e) => e.id), [1, 2]);
  assert.deepEqual(employeesWithSkill(second, { typeId: id, skill: 'JavaScript', minProgress: 26 }).map((e) => e.id), [1]);
  assert.deepEqual(employeesWithSkill(second, { typeId: id, skill: 'SQL', minProgress: 0 }), []);
  assert.throws(() => employeesWithSkill(second, { typeId: id, skill: 'SQL', minProgress: NaN }), /Minimum progress/);
});

test('certification expiry is inclusive and excludes expired, undated and non-certification resume lines', () => {
  let db = seed();
  for (const [name, date_end, line_type] of [['Today', '2026-01-01', 'certification'], ['Boundary', '2026-01-31', 'certification'], ['Expired', '2025-12-31', 'certification'], ['Later', '2026-02-01', 'certification'], ['No expiry', null, 'certification'], ['Education', '2026-01-10', 'education']]) {
    db = create(db, 'hr.resume.line', { employee_id: 1, name, date_start: '2025-01-01', date_end, line_type }).db;
  }
  assert.deepEqual(certificationsExpiring(db, '2026-01-01', 30).map((r) => r.name), ['Today', 'Boundary']);
  assert.deepEqual(certificationsExpiring(db, '2026-01-01', 0).map((r) => r.name), ['Today']);
  assert.throws(() => certificationsExpiring(db, '2026-02-30', 30), /valid date/);
  assert.throws(() => certificationsExpiring(db, '2026-01-01', -1), /non-negative/);
  assert.throws(() => create(db, 'hr.resume.line', { employee_id: 1, name: 'Backwards', date_start: '2026-01-01', date_end: '2025-01-01' }), /resume dates/);
});

test('referral links round-trip with stable per-employee attribution and normalized duplicate protection', () => {
  const db = seed();
  const before = structuredClone(db);
  const link = referralLink(db, 1, 1);
  assert.equal(referralLink(db, 1, 1), link);
  assert.equal(new URL(link, 'https://mizan.test').search, new URL(referralLink(db, 1, 2), 'https://mizan.test').search);
  assert.notEqual(link, referralLink(db, 2, 1));
  const result = referred(db, 1, '  Candidate@Example.Test ');
  const referral = read(result.db, 'hr.referral', result.referralId);
  const applicant = read(result.db, 'hr.applicant', result.applicantId);
  assert.deepEqual(db, before);
  assert.equal(referral.link, link);
  assert.equal(referral.applicant_id, applicant.id);
  assert.equal(referral.referrer_id, 1);
  assert.equal(applicant.email, 'candidate@example.test');
  assert.equal(applicant.name, 'New Candidate');
  assert.equal(applicant.source, 'referral');
  assert.equal(applicant.job_id, 1);
  assert.equal(referral.points, 10);
  assert.throws(() => referFromLink(db, { token: 'unknown', jobId: 1, name: 'Bad', email: 'bad@example.test' }), /Unknown referral token/);
  assert.throws(() => referred(result.db, 2, 'CANDIDATE@example.test'), /already applied/);
  const archived = write(result.db, 'hr.applicant', applicant.id, { active: false });
  assert.throws(() => referred(archived), /already applied/);
  assert.ok(referred(result.db, 1, 'candidate@example.test', 2).applicantId);
  const direct = create(db, 'hr.applicant', { name: 'Direct', job_id: 1, email: 'candidate@example.test' });
  assert.throws(() => referred(direct.db), /already applied/);
  assert.throws(() => referred(db, 1, 'not-an-email'), /valid email/);
  assert.throws(() => referralLink(db, 1, 99999), /not found/);
});

test('sync follows recruitment interviews, offers, employee creation, refusals and restoration idempotently', () => {
  const result = referred(seed());
  let db = scheduleInterview(result.db, read(result.db, 'hr.applicant', result.applicantId), { date: '2026-01-15', time: '10:00', interviewer: 'Hiring Manager' });
  db = syncFromApplicant(db, result.applicantId);
  assert.equal(read(db, 'hr.referral', result.referralId).stage_id, 'interview');
  assert.equal(syncFromApplicant(db, result.applicantId), db);
  db = syncFromApplicant(write(db, 'hr.applicant', result.applicantId, { stage_id: 'interview2' }), result.applicantId);
  assert.equal(read(db, 'hr.referral', result.referralId).points, 30);
  db = sendOffer(db, read(db, 'hr.applicant', result.applicantId), { salary: 5000, date: '2026-01-16' });
  db = syncFromApplicant(db, result.applicantId);
  assert.equal(read(db, 'hr.referral', result.referralId).stage_id, 'interview');
  db = syncFromApplicant(acceptOffer(db, read(db, 'hr.applicant', result.applicantId)), result.applicantId);
  assert.ok(read(db, 'hr.applicant', result.applicantId).emp_id);
  assert.equal(read(db, 'hr.referral', result.referralId).points, 100);
  const other = referred(db, 2, 'other@example.test');
  db = syncFromApplicant(write(other.db, 'hr.applicant', other.applicantId, { active: false }), other.applicantId);
  assert.equal(read(db, 'hr.referral', other.referralId).stage_id, 'refused');
  assert.equal(read(db, 'hr.referral', other.referralId).points, 0);
  db = syncFromApplicant(write(db, 'hr.applicant', other.applicantId, { active: true, stage_id: 'screening' }), other.applicantId);
  assert.equal(read(db, 'hr.referral', other.referralId).stage_id, 'new');
  assert.throws(() => syncFromApplicant(db, 99999), /not found/);
});

test('reward spending is durable and immutable, checks points, stock and activity before redemption', () => {
  const result = referred(seed());
  const hired = syncFromApplicant(write(result.db, 'hr.applicant', result.applicantId, { stage_id: 'hired' }), result.applicantId);
  const item = reward(hired);
  const before = structuredClone(item.db);
  const bought = buyReward(item.db, 1, item.id);
  assert.deepEqual(item.db, before);
  assert.deepEqual(points(item.db, 1), { earned: 100, spent: 0, available: 100 });
  assert.deepEqual(points(bought, 1), { earned: 100, spent: 30, available: 70 });
  assert.equal(read(bought, 'hr.referral.reward', item.id).quantity, 1);
  const twice = buyReward(bought, 1, item.id);
  assert.deepEqual(points(twice, 1), { earned: 100, spent: 60, available: 40 });
  assert.throws(() => buyReward(twice, 1, item.id), /out of stock/);
  assert.throws(() => buyReward(item.db, 2, item.id), /Insufficient/);
  assert.throws(() => buyReward(write(item.db, 'hr.referral.reward', item.id, { active: false }), 1, item.id), /inactive/);
  assert.throws(() => reward(hired, { cost: -1 }), /positive integer/);
  assert.throws(() => reward(hired, { quantity: 0.5 }), /non-negative integer/);
  const refused = syncFromApplicant(write(twice, 'hr.applicant', result.applicantId, { active: false }), result.applicantId);
  assert.deepEqual(points(refused, 1), { earned: 0, spent: 60, available: -60 });
});

test('reward spending can span referrals and leaderboard ranks gross stage points by inclusive referral dates', () => {
  let db = seed();
  for (const [referrer_id, stage_id, date] of [[1, 'new', '2026-01-01'], [1, 'interview', '2026-01-31'], [2, 'hired', '2026-01-15'], [1, 'hired', '2025-12-31'], [2, 'hired', '2026-02-01']]) {
    db = create(db, 'hr.referral', { name: 'Candidate', referrer_id, stage_id, date }).db;
  }
  const item = reward(db, { cost: 35 });
  const bought = buyReward(item.db, 1, item.id);
  assert.equal(points(bought, 1).spent, 35);
  assert.deepEqual(leaderboard(bought, { from: '2026-01-01', to: '2026-01-31' }).map((r) => [r.employee_id, r.earned]), [[2, 100], [1, 40]]);
  assert.throws(() => leaderboard(bought, { from: '2026-02-01', to: '2026-01-01' }), /date range/);
});

test('seed keeps legacy skills, referrals, stages and views intact', () => {
  const db = seed();
  assert.ok(search(db, 'hr.skill').length > 0);
  assert.ok(search(db, 'hr.skill').every((r) => r.progress > 0));
  const legacy = search(db, 'hr.referral').find((r) => r.name === 'Omar Sherif');
  assert.equal(legacy.points, 30);
  assert.equal(legacy.stage_id, 'interview');
  assert.equal(legacy.reward_points_spent, 0);
  assert.ok(legacy.link.startsWith('/jobs/1?ref='));
  assert.deepEqual(skillsPlusModels['hr.referral'].views, ['kanban', 'list', 'graph']);
  assert.deepEqual(skillsPlusModels['hr.skill'].views, ['list', 'kanban', 'pivot']);
  assert.deepEqual(skillsPlusModels['hr.referral'].fields.stage_id.options.map(([id]) => id), ['new', 'interview', 'hired', 'refused']);
});
