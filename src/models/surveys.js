// Surveys: question types, conditional questions, scoring with a pass mark, attempt limits and results analysis.
import { create, search, write } from '../orm.js';
import { today } from './common.js';

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const list = (s) => String(s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
// Older surveys used 'choice' (one answer) and 'rating' (1-5).
const kindOf = (q) => ({ choice: 'single', rating: 'scale' })[q.kind] ?? q.kind ?? 'text';
const isEmpty = (v) => v == null || v === '' || (Array.isArray(v) && !v.length);

export const QUESTION_TYPES = [
  ['text', 'Single Line Text'], ['textarea', 'Multiple Lines Text'], ['number', 'Numerical Value'], ['date', 'Date'],
  ['single', 'Multiple choice: only one answer'], ['multiple', 'Multiple choice: multiple answers allowed'], ['scale', 'Scale (1-5)'],
];

/** Choices offered by a choice question (scale questions offer 1..5). */
export const choicesOf = (q) => (kindOf(q) === 'scale' ? ['1', '2', '3', '4', '5'] : list(q.choices));

/**
 * Indices of the questions shown for the answers given so far: a question with a trigger shows only when the
 * triggering question (1-based number) was answered with the trigger answer, and that question is itself shown.
 */
export function visibleQuestions(survey, answers = {}) {
  const shown = new Set();
  (survey.questions ?? []).forEach((q, i) => {
    const t = Number(q.trigger_question) - 1;
    if (!(t >= 0 && t < i)) { shown.add(i); return; }
    const given = answers[t];
    const hit = Array.isArray(given) ? given.map(String).includes(String(q.trigger_answer)) : String(given ?? '') === String(q.trigger_answer ?? '');
    if (shown.has(t) && hit) shown.add(i);
  });
  return [...shown];
}

/** Validation errors per question index: required answers, numbers, dates and offered choices. */
export function validateAnswers(survey, answers = {}) {
  const errors = {};
  for (const i of visibleQuestions(survey, answers)) {
    const q = survey.questions[i];
    const v = answers[i];
    if (isEmpty(v)) {
      if (q.mandatory) errors[i] = 'This question requires an answer';
      continue;
    }
    const kind = kindOf(q);
    if (kind === 'number' && !Number.isFinite(Number(v))) errors[i] = 'This is not a number';
    if (kind === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(String(v))) errors[i] = 'This is not a date';
    if (['single', 'scale'].includes(kind) && !choicesOf(q).includes(String(v))) errors[i] = 'Choose one of the answers';
    if (kind === 'multiple' && !(Array.isArray(v) && v.every((x) => choicesOf(q).includes(String(x))))) errors[i] = 'Choose among the answers';
  }
  return errors;
}

/**
 * Score of the answers: a scored question (with correct answers and points) earns its points when the answer
 * matches exactly (every correct choice and nothing else, for multiple answers).
 */
export function scoreAnswers(survey, answers = {}) {
  const scored = (survey.questions ?? []).map((q, i) => ({ q, i })).filter(({ q }) => list(q.correct).length && Number(q.score) > 0);
  const max = scored.reduce((s, { q }) => s + Number(q.score), 0);
  const score = scored.reduce((s, { q, i }) => {
    const given = (Array.isArray(answers[i]) ? answers[i] : isEmpty(answers[i]) ? [] : [answers[i]]).map((x) => String(x).trim().toLowerCase()).sort();
    const correct = list(q.correct).map((x) => x.toLowerCase()).sort();
    return s + (JSON.stringify(given) === JSON.stringify(correct) ? Number(q.score) : 0);
  }, 0);
  const percent = max ? round((score / max) * 100) : 0;
  return { score: round(score), max: round(max), percent, passed: survey.scoring_type !== 'no_scoring' && max > 0 && percent >= (Number(survey.passing_percent) || 0) };
}

/** Record a participation; returns { db, result }. Enforces the survey being open, required answers and the attempt limit per email. */
export function submitSurvey(db, survey, { name, email = '', answers = {}, date = today() }) {
  if (survey.stage_id !== 'open') throw new Error('This survey is not open');
  if (!String(name ?? '').trim()) throw new Error('Enter your name');
  const errors = validateAnswers(survey, answers);
  if (Object.keys(errors).length) throw new Error(`Question ${Number(Object.keys(errors)[0]) + 1}: ${Object.values(errors)[0]}`);
  const key = String(email).trim().toLowerCase();
  const previous = search(db, 'survey.answer').filter((a) => a.survey_id === survey.id && key && String(a.email ?? '').toLowerCase() === key);
  if (Number(survey.attempts_limit) > 0 && previous.length >= Number(survey.attempts_limit)) throw new Error('You have used all your attempts for this survey');
  const shown = new Set(visibleQuestions(survey, answers));
  const result = scoreAnswers(survey, answers);
  const lines = (survey.questions ?? []).map((q, i) => ({ question: q.question, answer: shown.has(i) ? [answers[i] ?? ''].flat().join(', ') : '', index: i }));
  const { db: next, id } = create(db, 'survey.answer', {
    survey_id: survey.id, name: String(name).trim(), email: key, date, answers: lines, raw: JSON.stringify(answers),
    attempt: previous.length + 1, score: result.score, score_percent: result.percent, passed: result.passed,
    certified: !!survey.certification && result.passed,
  });
  return { db: write(next, 'survey.survey', survey.id, { responses: (Number(survey.responses) || 0) + 1 }), result: { ...result, id } };
}

/** Per-question results: choice counts, numeric average/min/max, or the text answers. */
export function surveyResults(db, survey) {
  const parts = search(db, 'survey.answer').filter((a) => a.survey_id === survey.id).map((a) => {
    try { return JSON.parse(a.raw ?? '{}'); } catch { return {}; }
  });
  return (survey.questions ?? []).map((q, i) => {
    const given = parts.map((p) => p[i]).filter((v) => !isEmpty(v));
    const kind = kindOf(q);
    if (['single', 'multiple', 'scale'].includes(kind)) {
      const counts = Object.fromEntries(choicesOf(q).map((c) => [c, given.flat().filter((v) => String(v) === c).length]));
      return { question: q.question, kind, answered: given.length, counts };
    }
    if (kind === 'number') {
      const nums = given.map(Number).filter(Number.isFinite);
      return { question: q.question, kind, answered: nums.length, avg: nums.length ? round(nums.reduce((s, n) => s + n, 0) / nums.length) : null, min: nums.length ? Math.min(...nums) : null, max: nums.length ? Math.max(...nums) : null };
    }
    return { question: q.question, kind, answered: given.length, texts: given.map(String) };
  });
}

const employee = (label) => ({ type: 'many2one', relation: 'hr.employee', label });

export const surveyModels = {
  'survey.survey': {
    label: 'Surveys',
    fields: {
      name: { type: 'char', label: 'Survey Title', required: true },
      description: { type: 'text', label: 'Description' },
      user_id: employee('Responsible'),
      stage_id: { type: 'selection', label: 'Status', tracking: true, options: [['draft', 'Draft'], ['open', 'In Progress'], ['closed', 'Closed']] },
      questions: {
        type: 'one2many',
        label: 'Questions',
        fields: {
          section: { type: 'char', label: 'Section' },
          question: { type: 'char', label: 'Question' },
          kind: { type: 'selection', label: 'Question Type', options: [...QUESTION_TYPES, ['choice', 'Multiple choice (legacy)'], ['rating', 'Rating 1-5 (legacy)']] },
          choices: { type: 'char', label: 'Choices (comma separated)' },
          mandatory: { type: 'boolean', label: 'Mandatory' },
          correct: { type: 'char', label: 'Correct Answers' },
          score: { type: 'float', label: 'Score' },
          trigger_question: { type: 'integer', label: 'Show if Question #' },
          trigger_answer: { type: 'char', label: 'Is Answered' },
        },
        newLine: () => ({ question: '', kind: 'text', choices: '', mandatory: false, correct: '', score: 0 }),
      },
      scoring_type: { type: 'selection', label: 'Scoring', options: [['no_scoring', 'No scoring'], ['scoring_with_answers', 'Scoring with answers at the end'], ['scoring_without_answers', 'Scoring without answers']] },
      passing_percent: { type: 'float', label: 'Required Score (%)' },
      certification: { type: 'boolean', label: 'Is a Certification' },
      attempts_limit: { type: 'integer', label: 'Attempts Limit (0 = unlimited)' },
      time_limit: { type: 'integer', label: 'Time Limit (minutes)' },
      responses: { type: 'integer', label: 'Responses', readonly: true },
      question_count: { type: 'integer', label: 'Questions', compute: (r) => (r.questions ?? []).length },
    },
    defaults: () => ({ stage_id: 'draft', questions: [], responses: 0, scoring_type: 'no_scoring', passing_percent: 80, attempts_limit: 0, time_limit: 0 }),
    groupBys: ['stage_id', 'user_id'],
    filters: [[{ id: 'open', label: 'In Progress', fn: (r) => r.stage_id === 'open' }, { id: 'cert', label: 'Certifications', fn: (r) => r.certification }]],
    kanban: { groupBy: 'stage_id', title: 'name', lines: ['user_id', 'question_count', 'responses'] },
    list: ['name', 'user_id', 'question_count', 'responses', 'stage_id'],
    form: {
      statusbar: 'stage_id',
      statusbarClickable: true,
      buttons: [
        { label: 'Start Survey', primary: true, when: (r) => r.stage_id === 'draft', vals: { stage_id: 'open' } },
        { label: 'Take Survey', primary: true, when: (r) => r.stage_id === 'open', run: (db, r) => ({ db, go: `#/surveys/take?survey=${r.id}` }) },
        { label: 'See Results', when: (r) => r.responses > 0, run: (db, r) => ({ db, go: `#/surveys/results?survey=${r.id}` }) },
        { label: 'Close', when: (r) => r.stage_id === 'open', vals: { stage_id: 'closed' } },
      ],
      title: 'name',
      groups: [['user_id', 'responses'], ['question_count']],
      tabs: [
        { label: 'Questions', fields: ['questions'] },
        { label: 'Options', fields: ['scoring_type', 'passing_percent', 'certification', 'attempts_limit', 'time_limit'] },
        { label: 'Description', fields: ['description'] },
      ],
      smart: [{ label: 'Participations', model: 'survey.answer', field: 'survey_id', target: 'surveys/answers' }],
      chatter: true,
    },
  },

  'survey.answer': {
    label: 'Participations',
    fields: {
      survey_id: { type: 'many2one', relation: 'survey.survey', label: 'Survey', required: true },
      name: { type: 'char', label: 'Respondent', required: true },
      email: { type: 'char', label: 'Email' },
      date: { type: 'date', label: 'Date', readonly: true },
      attempt: { type: 'integer', label: 'Attempt', readonly: true },
      score: { type: 'float', label: 'Score', readonly: true },
      score_percent: { type: 'float', label: 'Score (%)', readonly: true },
      passed: { type: 'boolean', label: 'Passed', readonly: true },
      certified: { type: 'boolean', label: 'Certified', readonly: true },
      raw: { type: 'text', label: 'Raw Answers', readonly: true, hidden: true },
      answers: {
        type: 'one2many',
        label: 'Answers',
        fields: { question: { type: 'char', label: 'Question' }, answer: { type: 'char', label: 'Answer' }, index: { type: 'integer', label: '#', hidden: true } },
        newLine: () => ({ question: '', answer: '' }),
      },
    },
    defaults: () => ({ date: today(), answers: [] }),
    groupBys: ['survey_id', 'passed', 'date'],
    filters: [[{ id: 'passed', label: 'Passed', fn: (r) => r.passed }, { id: 'failed', label: 'Failed', fn: (r) => r.score_percent != null && !r.passed }]],
    kanban: { title: 'name', lines: ['survey_id', 'date', 'score_percent'] },
    list: ['date', 'survey_id', 'name', 'email', 'attempt', 'score_percent', 'passed'],
    views: ['list', 'kanban', 'graph', 'pivot'],
    graph: { groupBy: 'survey_id', measure: 'score_percent' },
    form: { lockedWhen: () => true, title: 'name', groups: [['survey_id', 'email', 'attempt'], ['date', 'score_percent', 'passed', 'certified']], tabs: [{ label: 'Answers', fields: ['answers'] }] },
  },
};
