import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from './orm.js';
import { scoreAnswers, submitSurvey, surveyResults, validateAnswers, visibleQuestions } from './models/surveys.js';
import { seed } from './seed.js';

const quiz = {
  id: 0, stage_id: 'open', scoring_type: 'scoring_with_answers', passing_percent: 60, certification: true, attempts_limit: 2,
  questions: [
    { question: 'Capital of Egypt?', kind: 'single', choices: 'Cairo, Giza, Luxor', correct: 'Cairo', score: 2, mandatory: true },
    { question: 'Pick the primes', kind: 'multiple', choices: '2, 3, 4, 9', correct: '2, 3', score: 2 },
    { question: 'Why?', kind: 'textarea' },
    { question: 'Only if Giza', kind: 'text', trigger_question: 1, trigger_answer: 'Giza', mandatory: true },
    { question: 'Age', kind: 'number' },
  ],
};

test('conditional questions show only for the triggering answer', () => {
  assert.deepEqual(visibleQuestions(quiz, { 0: 'Cairo' }), [0, 1, 2, 4]);
  assert.deepEqual(visibleQuestions(quiz, { 0: 'Giza' }), [0, 1, 2, 3, 4]);
});

test('validation: mandatory, numbers, offered choices; hidden mandatory questions are skipped', () => {
  assert.deepEqual(validateAnswers(quiz, {}), { 0: 'This question requires an answer' });
  assert.deepEqual(validateAnswers(quiz, { 0: 'Giza' }), { 3: 'This question requires an answer' });
  assert.deepEqual(validateAnswers(quiz, { 0: 'Paris', 4: 'abc', 1: ['5'] }), { 0: 'Choose one of the answers', 1: 'Choose among the answers', 4: 'This is not a number' });
});

test('scoring: exact matches earn the points and the pass mark decides', () => {
  assert.deepEqual(scoreAnswers(quiz, { 0: 'Cairo', 1: ['3', '2'] }), { score: 4, max: 4, percent: 100, passed: true });
  assert.deepEqual(scoreAnswers(quiz, { 0: 'Cairo', 1: ['2', '3', '4'] }), { score: 2, max: 4, percent: 50, passed: false });
  assert.equal(scoreAnswers({ ...quiz, scoring_type: 'no_scoring' }, { 0: 'Cairo', 1: ['2', '3'] }).passed, false);
});

test('submissions record score, certification and attempts; the limit is enforced per email', () => {
  const { db, id } = create(seed(), 'survey.survey', { ...quiz, name: 'Quiz' });
  const survey = read(db, 'survey.survey', id);
  const first = submitSurvey(db, survey, { name: 'Mona', email: 'mona@x.example', answers: { 0: 'Cairo', 1: ['2'] } });
  const a1 = read(first.db, 'survey.answer', first.result.id);
  assert.equal(a1.score_percent, 50);
  assert.equal(a1.passed, false);
  const second = submitSurvey(first.db, read(first.db, 'survey.survey', id), { name: 'Mona', email: 'MONA@x.example', answers: { 0: 'Cairo', 1: ['2', '3'] } });
  const a2 = read(second.db, 'survey.answer', second.result.id);
  assert.equal(a2.attempt, 2);
  assert.equal(a2.certified, true);
  assert.equal(read(second.db, 'survey.survey', id).responses, 2);
  assert.throws(() => submitSurvey(second.db, survey, { name: 'Mona', email: 'mona@x.example', answers: { 0: 'Cairo' } }), /all your attempts/);
  assert.throws(() => submitSurvey(db, { ...survey, stage_id: 'closed' }, { name: 'X', answers: { 0: 'Cairo' } }), /not open/);
  assert.throws(() => submitSurvey(db, survey, { name: 'X', answers: {} }), /Question 1/);
});

test('results count choices, average numbers and list texts; the seed survey still works', () => {
  const { db, id } = create(seed(), 'survey.survey', { ...quiz, name: 'Quiz', attempts_limit: 0 });
  const s = read(db, 'survey.survey', id);
  const one = submitSurvey(db, s, { name: 'A', answers: { 0: 'Cairo', 1: ['2', '3'], 2: 'fun', 4: '30' } }).db;
  const two = submitSurvey(one, s, { name: 'B', answers: { 0: 'Luxor', 1: ['2'], 4: '40' } }).db;
  const r = surveyResults(two, s);
  assert.deepEqual(r[0].counts, { Cairo: 1, Giza: 0, Luxor: 1 });
  assert.deepEqual(r[1].counts, { 2: 2, 3: 1, 4: 0, 9: 0 });
  assert.deepEqual(r[2].texts, ['fun']);
  assert.equal(r[4].avg, 35);
  const legacy = search(seed(), 'survey.survey').find((x) => x.name === 'Customer Satisfaction');
  const done = submitSurvey(seed(), legacy, { name: 'C', answers: { 0: 4, 1: 'Desk' } });
  assert.deepEqual(surveyResults(done.db, legacy)[0].counts, { 1: 0, 2: 0, 3: 0, 4: 1, 5: 0 });
});
