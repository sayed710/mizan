// Skills, resume and employee referral rewards.
import { create, read, search, write } from '../orm.js';
import { apps3Models } from './apps3.js';
import { addDays, today } from './common.js';

const relation = (model, label) => ({ type: 'many2one', relation: model, label, required: true });
const char = (label) => ({ type: 'char', label, required: true });
const referral = apps3Models['hr.referral'];
const scale = (r) => ({ new: 10, interview: 30, hired: 100 })[r.stage_id] ?? 0;
const normalize = (s) => String(s ?? '').trim().toLowerCase();
const all = (db, model) => search(db, model, { includeArchived: true });
const get = (db, model, id) => {
  const r = read(db, model, id);
  if (!r) throw new Error(`${model} record not found`);
  return r;
};
const validDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s ?? '') && Number.isFinite(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const tokenFor = (id) => {
  let hash = 2166136261;
  for (const c of `mizan-referral-v1:${id}`) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619) >>> 0;
  return `${id}-${hash.toString(16).padStart(8, '0')}`;
};
// The public jobs page (PublicSite.jsx) reads job and ref from the hash and sends ref with the application.
const linkFor = (employeeId, jobId) => `/#/shop/jobs?job=${jobId}&ref=${tokenFor(employeeId)}`;
const skillLevel = (db, typeId, skill, level) => {
  const type = get(db, 'hr.skill.type', typeId);
  if (!(type.skill_ids ?? []).some((s) => s.name === skill)) throw new Error('Select a skill belonging to this skill type');
  const selected = (type.level_ids ?? []).find((l) => l.name === level);
  if (!selected) throw new Error('Select a level belonging to this skill type');
  return selected;
};

/** Set one employee/type/skill row, replacing its level on subsequent calls. */
export function setSkill(db, employeeId, { typeId, skill, level }) {
  get(db, 'hr.employee', employeeId);
  const selected = skillLevel(db, typeId, skill, level);
  const vals = { employee_id: employeeId, skill_type_id: typeId, skill, level, level_progress: selected.level_progress };
  const existing = all(db, 'hr.employee.skill').find((r) => r.employee_id === employeeId && r.skill_type_id === typeId && r.skill === skill);
  return existing ? write(db, 'hr.employee.skill', existing.id, vals) : create(db, 'hr.employee.skill', vals).db;
}

/** Every employee with named skill columns; missing skills have zero progress. */
export function skillMatrix(db, typeId) {
  const type = get(db, 'hr.skill.type', typeId);
  const records = search(db, 'hr.employee.skill').filter((r) => r.skill_type_id === typeId);
  return search(db, 'hr.employee').map((e) => ({ employee_id: e.id, name: e.name, skills: Object.fromEntries((type.skill_ids ?? []).map((s) => {
    const row = records.find((r) => r.employee_id === e.id && r.skill === s.name);
    return [s.name, row ? skillLevel(db, typeId, row.skill, row.level).level_progress : 0];
  })) }));
}

/** Employees actually possessing the skill at or above the inclusive threshold. */
export function employeesWithSkill(db, { typeId, skill, minProgress = 0 }) {
  const type = get(db, 'hr.skill.type', typeId);
  if (!(type.skill_ids ?? []).some((s) => s.name === skill)) throw new Error('Select a skill belonging to this skill type');
  if (!Number.isFinite(minProgress) || minProgress < 0 || minProgress > 100) throw new Error('Minimum progress must be between 0 and 100');
  const ids = new Set(search(db, 'hr.employee.skill').filter((r) => r.skill_type_id === typeId && r.skill === skill
    && skillLevel(db, typeId, skill, r.level).level_progress >= minProgress).map((r) => r.employee_id));
  return search(db, 'hr.employee').filter((e) => ids.has(e.id));
}

/** Certification resume lines expiring in the inclusive date-to-date+days window. */
export function certificationsExpiring(db, date, days) {
  if (!validDate(date) || !Number.isInteger(days) || days < 0) throw new Error('Enter a valid date and non-negative number of days');
  const end = addDays(date, days);
  return search(db, 'hr.resume.line').filter((r) => r.line_type === 'certification' && r.date_end && r.date_end >= date && r.date_end <= end)
    .sort((a, b) => a.date_end.localeCompare(b.date_end) || a.id - b.id);
}

/** Stable attribution link; the token is not an authentication credential. */
export function referralLink(db, employeeId, jobId) {
  get(db, 'hr.employee', employeeId);
  get(db, 'hr.job', jobId);
  return linkFor(employeeId, jobId);
}

/** Resolve attribution and create a referral plus its recruitment application. */
export function referFromLink(db, { token, jobId, name, email }) {
  const employee = search(db, 'hr.employee').find((e) => tokenFor(e.id) === token);
  if (!employee) throw new Error('Unknown referral token');
  get(db, 'hr.job', jobId);
  const candidate = String(name ?? '').trim();
  const address = normalize(email);
  if (!candidate || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new Error('Enter a candidate name and valid email');
  if (all(db, 'hr.applicant').some((r) => r.job_id === jobId && normalize(r.email) === address)
    || all(db, 'hr.referral').some((r) => r.job_id === jobId && normalize(r.email) === address)) throw new Error('This email has already applied for this job');
  const applicant = create(db, 'hr.applicant', { name: candidate, email: address, job_id: jobId, source: 'referral' });
  const result = create(applicant.db, 'hr.referral', { name: candidate, email: address, job_id: jobId, referrer_id: employee.id, applicant_id: applicant.id, source_token: token });
  return { db: result.db, referralId: result.id, applicantId: applicant.id };
}

/** Synchronize after applicant stage changes, hiring, refusal or restoration. */
export function syncFromApplicant(db, applicantId) {
  const applicant = get(db, 'hr.applicant', applicantId);
  const stage = applicant.active === false || applicant.stage_id === 'refused' ? 'refused'
    : applicant.emp_id || applicant.stage_id === 'hired' ? 'hired'
      : ['interview', 'interview2', 'contract'].includes(applicant.stage_id) ? 'interview' : 'new';
  return all(db, 'hr.referral').filter((r) => r.applicant_id === applicantId && r.stage_id !== stage)
    .reduce((next, r) => write(next, 'hr.referral', r.id, { stage_id: stage }), db);
}

/** Current stage points less lifetime reward spending, including archived referrals. */
export function points(db, employeeId) {
  get(db, 'hr.employee', employeeId);
  const records = all(db, 'hr.referral').filter((r) => r.referrer_id === employeeId);
  const earned = records.reduce((sum, r) => sum + scale(r), 0);
  const spent = records.reduce((sum, r) => sum + (r.reward_points_spent ?? 0), 0);
  return { earned, spent, available: earned - spent };
}

/** Redeem one stocked reward, allocating spending across the referrer's points rows. */
export function buyReward(db, employeeId, rewardId) {
  const balance = points(db, employeeId);
  const reward = get(db, 'hr.referral.reward', rewardId);
  if (reward.active === false) throw new Error('This reward is inactive');
  if (reward.quantity < 1) throw new Error('This reward is out of stock');
  if (balance.available < reward.cost) throw new Error('Insufficient referral points');
  let next = db;
  let remaining = reward.cost;
  for (const r of all(db, 'hr.referral').filter((r) => r.referrer_id === employeeId)) {
    const used = Math.min(remaining, Math.max(0, scale(r) - (r.reward_points_spent ?? 0)));
    if (used) next = write(next, 'hr.referral', r.id, { reward_points_spent: (r.reward_points_spent ?? 0) + used });
    remaining -= used;
  }
  return write(next, 'hr.referral.reward', rewardId, { quantity: reward.quantity - 1 });
}

/** Rank current stage earnings for referrals created within an inclusive period. */
export function leaderboard(db, { from, to }) {
  if (!validDate(from) || !validDate(to) || from > to) throw new Error('Enter a valid leaderboard date range');
  const totals = new Map();
  for (const r of all(db, 'hr.referral').filter((r) => r.referrer_id && r.date >= from && r.date <= to)) totals.set(r.referrer_id, (totals.get(r.referrer_id) ?? 0) + scale(r));
  return [...totals].map(([employee_id, earned]) => ({ employee_id, name: read(db, 'hr.employee', employee_id)?.name ?? '', earned }))
    .sort((a, b) => b.earned - a.earned || a.employee_id - b.employee_id);
}

export const skillsPlusModels = {
  'hr.skill': { ...apps3Models['hr.skill'] },
  'hr.skill.type': {
    label: 'Skill Types',
    fields: {
      name: char('Skill Type'),
      skill_ids: { type: 'one2many', label: 'Skills', fields: { name: char('Skill') }, newLine: () => ({ name: '' }) },
      level_ids: { type: 'one2many', label: 'Levels', fields: { name: char('Level'), level_progress: { type: 'integer', label: 'Progress (%)' }, default_level: { type: 'boolean', label: 'Default Level' } }, newLine: () => ({ name: '', level_progress: 0, default_level: false }) },
    },
    defaults: () => ({ skill_ids: [], level_ids: [] }),
    guard: (db, before, r) => {
      for (const lines of [r.skill_ids, r.level_ids]) {
        if (!Array.isArray(lines)) return 'Skills and levels must be lists';
        if (lines.some((l) => !String(l.name ?? '').trim()) || new Set(lines.map((l) => l.name)).size !== lines.length) return 'Enter unique non-empty skill and level names';
      }
      if (r.level_ids.some((l) => !Number.isFinite(l.level_progress) || l.level_progress < 0 || l.level_progress > 100)) return 'Level progress must be between 0 and 100';
      if (r.level_ids.filter((l) => l.default_level).length > 1) return 'Only one level can be the default';
      const assigned = before ? all(db, 'hr.employee.skill').filter((s) => s.skill_type_id === r.id) : [];
      if (assigned.some((s) => !r.skill_ids.some((l) => l.name === s.skill) || !r.level_ids.some((l) => l.name === s.level))) return 'Cannot remove a skill or level used by an employee';
      if (assigned.some((s) => r.level_ids.find((l) => l.name === s.level).level_progress !== s.level_progress)) return 'Cannot change progress of a level used by an employee; create a new level instead';
      return null;
    },
    list: ['name'],
    form: { title: 'name', groups: [], tabs: [{ label: 'Skills', fields: ['skill_ids'] }, { label: 'Levels', fields: ['level_ids'] }] },
  },
  'hr.employee.skill': {
    label: 'Employee Skills',
    fields: {
      employee_id: relation('hr.employee', 'Employee'), skill_type_id: relation('hr.skill.type', 'Skill Type'),
      skill: char('Skill'), level: char('Level'), level_progress: { type: 'integer', label: 'Progress (%)', readonly: true },
    },
    guard: (db, before, r) => {
      if (!read(db, 'hr.employee', r.employee_id)) return 'Select an employee';
      const type = read(db, 'hr.skill.type', r.skill_type_id);
      if (!type?.skill_ids.some((s) => s.name === r.skill)) return 'Select a skill belonging to this skill type';
      const level = type.level_ids.find((l) => l.name === r.level);
      if (!level) return 'Select a level belonging to this skill type';
      if (r.level_progress !== level.level_progress) return 'Skill progress must match the selected level';
      return all(db, 'hr.employee.skill').some((s) => s.id !== before?.id && s.employee_id === r.employee_id && s.skill_type_id === r.skill_type_id && s.skill === r.skill) ? 'This employee already has this skill' : null;
    },
    onchange: (r, key, db) => {
      const type = read(db, 'hr.skill.type', r.skill_type_id);
      const level = key === 'skill_type_id' ? type?.level_ids.find((l) => l.default_level)?.name : r.level;
      return { ...(key === 'skill_type_id' ? { level: level ?? '' } : {}), level_progress: type?.level_ids.find((l) => l.name === level)?.level_progress ?? 0 };
    },
    groupBys: ['employee_id', 'skill_type_id'],
    list: ['employee_id', 'skill_type_id', 'skill', 'level', 'level_progress'],
    views: ['list'],
    form: { title: 'skill', groups: [['employee_id', 'skill_type_id'], ['skill', 'level', 'level_progress']] },
  },
  'hr.resume.line': {
    label: 'Resume',
    fields: {
      employee_id: relation('hr.employee', 'Employee'), name: char('Title'), date_start: { type: 'date', label: 'Start Date' }, date_end: { type: 'date', label: 'End Date' },
      line_type: { type: 'selection', label: 'Type', options: [['experience', 'Experience'], ['education', 'Education'], ['internal', 'Internal'], ['certification', 'Certification']] },
      description: { type: 'text', label: 'Description' },
    },
    defaults: () => ({ line_type: 'experience', date_start: today() }),
    guard: (db, before, r) => !read(db, 'hr.employee', r.employee_id) ? 'Select an employee'
      : (r.date_start && !validDate(r.date_start)) || (r.date_end && !validDate(r.date_end)) || (r.date_start && r.date_end && r.date_end < r.date_start) ? 'Enter valid resume dates with end on or after start' : null,
    groupBys: ['employee_id', 'line_type'],
    list: ['employee_id', 'name', 'line_type', 'date_start', 'date_end'], views: ['list'],
    form: { title: 'name', groups: [['employee_id', 'line_type'], ['date_start', 'date_end']], tabs: [{ label: 'Description', fields: ['description'] }] },
  },
  'hr.referral': {
    ...referral,
    fields: {
      ...referral.fields,
      applicant_id: { type: 'many2one', relation: 'hr.applicant', label: 'Application' },
      source_token: { type: 'char', label: 'Source Token', readonly: true, compute: (r) => r.referrer_id ? tokenFor(r.referrer_id) : '' },
      link: { type: 'char', label: 'Referral Link', readonly: true, compute: (r) => r.referrer_id && r.job_id ? linkFor(r.referrer_id, r.job_id) : '' },
      reward_points_spent: { type: 'integer', label: 'Points Spent', readonly: true },
      date: { type: 'date', label: 'Referred on' },
    },
    defaults: (id) => ({ ...referral.defaults(id), date: today(), reward_points_spent: 0 }),
    guard: (db, before, r) => !Number.isInteger(r.reward_points_spent) || r.reward_points_spent < 0 ? 'Points spent must be a non-negative integer' : !validDate(r.date) ? 'Enter a valid referral date' : null,
    form: { ...referral.form, groups: [...referral.form.groups, ['email', 'applicant_id', 'date'], ['source_token', 'link', 'reward_points_spent']] },
  },
  'hr.referral.reward': {
    label: 'Rewards',
    fields: { name: char('Reward'), cost: { type: 'integer', label: 'Cost (Points)', required: true }, quantity: { type: 'integer', label: 'Stock', required: true }, active: { type: 'boolean', label: 'Active' } },
    defaults: () => ({ cost: 10, quantity: 1, active: true }),
    guard: (db, before, r) => !Number.isInteger(r.cost) || r.cost <= 0 || !Number.isInteger(r.quantity) || r.quantity < 0 ? 'Reward cost must be a positive integer and stock a non-negative integer' : null,
    list: ['name', 'cost', 'quantity', 'active'],
    form: {
      title: 'name', groups: [['cost', 'quantity'], ['active']],
      buttons: [{
        label: 'Redeem', primary: true, when: (r) => r.active !== false && r.quantity > 0,
        ask: [{ label: 'Employee name' }],
        run: (db, r, [name]) => {
          const employee = search(db, 'hr.employee').find((e) => e.name.toLowerCase() === name.toLowerCase());
          if (!employee) throw new Error('No employee with that name');
          return { db: buyReward(db, employee.id, r.id) };
        },
      }],
    },
  },
};
