// Templates, two-sided feedback, goals and calendar-based appraisal scheduling.
import { create, postNote, read, search, write } from '../orm.js';
import { apps2Models } from './apps2.js';
import { today } from './common.js';

const MODEL = 'hr.appraisal';
const INTERVAL_MONTHS = 12;
const FIRST_MONTHS = 6;
const stages = [['new', 'To Start'], ['pending', 'Appraisal Sent'], ['done', 'Done'], ['cancel', 'Cancelled']];
const employee = (label) => ({ type: 'many2one', relation: 'hr.employee', label });
const status = (r) => r.stage_id ?? 'new';
const open = (r) => ['new', 'pending'].includes(status(r));
const validRating = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 5;
const validDate = (date) => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;

function monthsAfter(date, months) {
  if (!validDate(date)) throw new Error('Enter a valid appraisal date');
  const d = new Date(`${date}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, end));
  return d.toISOString().slice(0, 10);
}

function appraisal(db, id) {
  const r = read(db, MODEL, id);
  if (!r) throw new Error('Appraisal not found');
  return r;
}

const goalLinks = (db, employeeId) => search(db, 'hr.appraisal.goal').filter((g) => g.employee_id === employeeId).map((g) => ({ goal_id: g.id }));
const feedbackLines = (questions) => (questions ?? []).map((q) => ({ question: q.question, type: q.type ?? 'text', answer: '', rating: 0 }));

/** Create an appraisal with independent question snapshots and the employee's manager. */
export function createFromTemplate(db, { employeeId, templateId, date = today() }) {
  const person = read(db, 'hr.employee', employeeId);
  const template = read(db, 'hr.appraisal.template', templateId);
  if (!person) throw new Error('Select an employee');
  if (!template || template.active === false) throw new Error('Select an active appraisal template');
  if (search(db, MODEL).some((r) => r.employee_id === employeeId && open(r))) throw new Error('This employee already has an open appraisal');
  monthsAfter(date, 0);
  return create(db, MODEL, {
    employee_id: employeeId, manager_id: person.parent_id ?? null, template_id: templateId, date, date_close: date,
    employee_feedback: feedbackLines(template.employee_questions), manager_feedback: feedbackLines(template.manager_questions),
    goal_ids: goalLinks(db, employeeId),
  });
}

/** Send a new appraisal and notify both participants through employee chatter. */
export function sendAppraisal(db, id) {
  const r = appraisal(db, id);
  if (status(r) !== 'new') throw new Error('Only a new appraisal can be sent');
  if (!read(db, 'hr.employee', r.employee_id)) throw new Error('Select an employee');
  if (r.manager_id && !read(db, 'hr.employee', r.manager_id)) throw new Error('Select a valid manager');
  let next = write(db, MODEL, id, { stage_id: 'pending' });
  for (const personId of new Set([r.employee_id, r.manager_id].filter(Boolean))) {
    next = postNote(next, 'hr.employee', personId, `Appraisal sent: ${r.name}`);
  }
  return next;
}

/** Publish one participant's answers, preserving the original questions. */
export function submitFeedback(db, id, side, answers) {
  const r = appraisal(db, id);
  if (!['employee', 'manager'].includes(side)) throw new Error('Choose employee or manager feedback');
  if (status(r) !== 'pending') throw new Error('Send the appraisal before publishing feedback');
  const key = `${side}_feedback`;
  const questions = r[key] ?? [];
  if (!Array.isArray(answers) || answers.length !== questions.length) throw new Error('Answer count must match the question count');
  const lines = questions.map((q, i) => {
    const a = answers[i];
    if (!a || (a.question != null && a.question !== q.question)) throw new Error('Answers must match the original questions in order');
    if ((q.type === 'rating' || a.rating != null) && !validRating(a.rating)) throw new Error('Feedback ratings must be between 0 and 5');
    return { ...q, answer: a.answer ?? '', rating: a.rating ?? 0 };
  });
  return write(db, MODEL, id, { [key]: lines, [`${key}_published`]: true });
}

/** Close a published appraisal and suggest the next annual review date. */
export function completeAppraisal(db, id, { finalRating, date = today() }) {
  const r = appraisal(db, id);
  if (status(r) !== 'pending') throw new Error('Only a pending appraisal can be completed');
  if (!r.employee_feedback_published || !r.manager_feedback_published) throw new Error('Both sides must publish feedback before completion');
  if (!validRating(finalRating)) throw new Error('Final rating must be between 0 and 5');
  monthsAfter(date, INTERVAL_MONTHS);
  return write(db, MODEL, id, { stage_id: 'done', final_rating: finalRating, rating: finalRating, date_close: date });
}

/** Employees due for their first six-month review or a subsequent annual review. */
export function dueAppraisals(db, date = today()) {
  monthsAfter(date, 0);
  const reviews = search(db, MODEL);
  return search(db, 'hr.employee').filter((e) => {
    const own = reviews.filter((r) => r.employee_id === e.id);
    if (own.some(open)) return false;
    const last = own.filter((r) => status(r) === 'done' && validDate(r.date_close)).sort((a, b) => b.date_close.localeCompare(a.date_close))[0];
    const start = e.join_date ?? e.start_date;
    const due = last ? monthsAfter(last.date_close, INTERVAL_MONTHS) : validDate(start) ? monthsAfter(start, FIRST_MONTHS) : null;
    return !!due && due <= date;
  });
}

/** Schedule one new appraisal per due employee; repeated runs leave open reviews alone. */
export function scheduleDue(db, date, templateId) {
  return dueAppraisals(db, date).reduce((next, e) => createFromTemplate(next, { employeeId: e.id, templateId, date }).db, db);
}

/** Scheduler entry point using the first active template, or the unchanged database. */
export function appraisalJobs(db, date = today()) {
  const template = search(db, 'hr.appraisal.template')[0];
  return template ? scheduleDue(db, date, template.id) : db;
}

/** Count an employee's goals and average their progress percentages. */
export function goalProgress(db, employeeId) {
  const goals = search(db, 'hr.appraisal.goal').filter((g) => g.employee_id === employeeId);
  return { total: goals.length, done: goals.filter((g) => g.done).length, average: goals.length ? goals.reduce((sum, g) => sum + Number(g.progress), 0) / goals.length : 0 };
}

/** Per-manager completed/pending counts and mean final rating in an inclusive date range. */
export function appraisalAnalysis(db, { from, to } = {}) {
  const groups = new Map();
  for (const r of search(db, MODEL)) {
    if (!['done', 'pending'].includes(status(r))) continue;
    const date = status(r) === 'done' ? r.date_close : r.date ?? r.date_close;
    if ((from && (!date || date < from)) || (to && (!date || date > to))) continue;
    const key = r.manager_id ?? null;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return Object.fromEntries([...groups].map(([managerId, reviews]) => {
    const done = reviews.filter((r) => status(r) === 'done');
    return [managerId, { done: done.length, pending: reviews.length - done.length, averageRating: done.length ? done.reduce((sum, r) => sum + (r.final_rating ?? r.rating ?? 0), 0) / done.length : 0 }];
  }));
}

function changeStage(db, r, stage) {
  const current = appraisal(db, r.id);
  if (stage === 'cancel' ? !open(current) : !['done', 'cancel'].includes(status(current))) throw new Error('This appraisal cannot make that status change');
  return write(db, MODEL, r.id, { stage_id: stage, ...(stage === 'new' ? { employee_feedback_published: false, manager_feedback_published: false, final_rating: null, rating: 0 } : {}) });
}

const questions = (label) => ({
  type: 'one2many', label,
  fields: { question: { type: 'char', label: 'Question' }, type: { type: 'selection', label: 'Answer Type', options: [['text', 'Text'], ['rating', 'Rating']] } },
  newLine: () => ({ question: '', type: 'text' }),
});
const feedback = (label) => ({
  type: 'one2many', label,
  fields: { question: { type: 'char', label: 'Question', readonly: true }, answer: { type: 'text', label: 'Answer' }, rating: { type: 'float', label: 'Rating (0–5)' } },
  newLine: () => ({ question: '', answer: '', rating: 0 }),
});
const base = apps2Models[MODEL];

export const appraisalPlusModels = {
  'hr.appraisal.template': {
    label: 'Appraisal Templates',
    fields: { name: { type: 'char', label: 'Name', required: true }, employee_questions: questions('Employee Questions'), manager_questions: questions('Manager Questions'), active: { type: 'boolean', label: 'Active' } },
    defaults: () => ({ employee_questions: [], manager_questions: [], active: true }),
    kanban: { title: 'name' }, list: ['name', 'active'],
    form: { title: 'name', groups: [['active']], tabs: [{ label: 'Employee', fields: ['employee_questions'] }, { label: 'Manager', fields: ['manager_questions'] }] },
  },
  [MODEL]: {
    ...base,
    fields: {
      ...base.fields,
      stage_id: { ...base.fields.stage_id, options: stages },
      state: { type: 'selection', label: 'Status', options: stages, readonly: true, compute: status },
      date: { type: 'date', label: 'Scheduled Date' },
      template_id: { type: 'many2one', relation: 'hr.appraisal.template', label: 'Template' },
      employee_feedback: feedback('Employee Feedback'), manager_feedback: feedback('Manager Feedback'),
      employee_feedback_published: { type: 'boolean', label: 'Employee Feedback Published', readonly: true },
      manager_feedback_published: { type: 'boolean', label: 'Manager Feedback Published', readonly: true },
      goal_ids: { type: 'one2many', label: 'Employee Goals', fields: { goal_id: { type: 'many2one', relation: 'hr.appraisal.goal', label: 'Goal' } }, newLine: () => ({ goal_id: null }) },
      final_rating: { type: 'float', label: 'Final Rating', readonly: true },
      next_appraisal_date: { type: 'date', label: 'Next Appraisal Date', compute: (r) => status(r) === 'done' && validDate(r.date_close) ? monthsAfter(r.date_close, INTERVAL_MONTHS) : null },
      note: { type: 'text', label: 'Private Notes' },
    },
    defaults: () => ({ ...base.defaults(), date: today(), employee_feedback: [], manager_feedback: [], employee_feedback_published: false, manager_feedback_published: false, goal_ids: [], final_rating: null }),
    onchange: (r, key, db) => key === 'employee_id' ? { manager_id: read(db, 'hr.employee', r.employee_id)?.parent_id ?? null, goal_ids: goalLinks(db, r.employee_id) }
      : key === 'template_id' ? { employee_feedback: feedbackLines(read(db, 'hr.appraisal.template', r.template_id)?.employee_questions), manager_feedback: feedbackLines(read(db, 'hr.appraisal.template', r.template_id)?.manager_questions), employee_feedback_published: false, manager_feedback_published: false }
      : ['employee_feedback', 'manager_feedback'].includes(key) ? { [`${key}_published`]: false } : {},
    guard: (db, before, r) => {
      if (!stages.some(([key]) => key === status(r))) return 'Choose a valid appraisal stage';
      if (open(r) && search(db, MODEL).some((a) => a.id !== r.id && a.employee_id === r.employee_id && open(a))) return 'This employee already has an open appraisal';
      if (status(r) === 'done' && (!r.employee_feedback_published || !r.manager_feedback_published)) return 'Both sides must publish feedback before completion';
      if (status(r) === 'done' && (!validRating(r.final_rating) || !validDate(r.date_close))) return 'Set a final rating between 0 and 5 and a valid closing date';
      return null;
    },
    form: {
      ...base.form, statusbarClickable: false, lockedWhen: (r) => ['done', 'cancel'].includes(status(r)),
      buttons: [
        { label: 'Send', primary: true, when: (r) => status(r) === 'new', run: (db, r) => ({ db: sendAppraisal(db, r.id) }) },
        ...['employee', 'manager'].map((side) => ({ label: `Submit ${side === 'employee' ? 'Employee' : 'Manager'} Feedback`, when: (r) => status(r) === 'pending' && !r[`${side}_feedback_published`], run: (db, r) => ({ db: submitFeedback(db, r.id, side, r[`${side}_feedback`] ?? []) }) })),
        { label: 'Complete', primary: true, when: (r) => status(r) === 'pending', run: (db, r) => {
          const answer = prompt('Final rating (0–5)', '');
          if (answer == null) return { db };
          if (!answer.trim()) throw new Error('Enter a final rating between 0 and 5');
          return { db: completeAppraisal(db, r.id, { finalRating: Number(answer), date: today() }) };
        } },
        { label: 'Cancel', when: open, run: (db, r) => ({ db: changeStage(db, r, 'cancel') }) },
        { label: 'Reopen', when: (r) => ['done', 'cancel'].includes(status(r)), run: (db, r) => ({ db: changeStage(db, r, 'new') }) },
      ],
      groups: [['employee_id', 'manager_id', 'template_id'], ['date', 'date_close', 'final_rating', 'next_appraisal_date']],
      tabs: [{ label: 'Employee Feedback', fields: ['employee_feedback', 'employee_feedback_published'] }, { label: 'Manager Feedback', fields: ['manager_feedback', 'manager_feedback_published'] }, { label: 'Goals', fields: ['goal_ids'] }, { label: 'Notes', fields: ['feedback', 'note'] }],
    },
  },
  'hr.appraisal.goal': {
    label: 'Goals',
    fields: {
      name: { type: 'char', label: 'Goal', required: true }, employee_id: { ...employee('Employee'), required: true }, manager_id: employee('Manager'),
      deadline: { type: 'date', label: 'Deadline' }, progress: { type: 'selection', label: 'Progress (%)', options: ['0', '25', '50', '75', '100'].map((n) => [n, `${n}%`]) },
      description: { type: 'text', label: 'Description' }, done: { type: 'boolean', label: 'Done', compute: (r) => Number(r.progress) === 100 },
    },
    defaults: () => ({ progress: '0' }),
    guard: (db, before, r) => r.progress != null && r.progress !== '' && [0, 25, 50, 75, 100].includes(Number(r.progress)) ? null : 'Choose a valid goal progress percentage',
    onchange: (r, key, db) => key === 'employee_id' ? { manager_id: read(db, 'hr.employee', r.employee_id)?.parent_id ?? null } : {},
    groupBys: ['employee_id', 'manager_id', 'progress'], views: ['list', 'kanban'],
    kanban: { groupBy: 'employee_id', title: 'name', lines: ['manager_id', 'deadline', 'progress'], badge: 'done' },
    list: ['employee_id', 'name', 'manager_id', 'deadline', 'progress', 'done'],
    form: { title: 'name', groups: [['employee_id', 'manager_id'], ['deadline', 'progress', 'done']], tabs: [{ label: 'Description', fields: ['description'] }], chatter: true },
  },
};
