import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, unlink } from './orm.js';
import { models } from './models/index.js';
import { today } from './models/common.js';
import { seed } from './seed.js';
import { channelStats, completeLesson, enroll, parseQuestions, submitQuiz } from './models/elearning.js';

// "Question? | answer | *correct | answer" lines; the starred answer is the right one.
const QUIZ = 'What is 2+2? | 3 | *4 | 5\nWhich one is a fruit? | *Apple | Chair | Table';
const video = (title) => ({ title, kind: 'video', duration: 10 });
const quiz = (title, questions = QUIZ) => ({ title, kind: 'quiz', duration: 5, questions });
const course = (db, name, lessons, extra = {}) => create(db, 'slide.channel', { name, stage_id: 'published', lessons, ...extra });
const attendee = (db, channelId, partnerId) => search(db, 'slide.channel.partner').find((a) => a.channel_id === channelId && a.partner_id === partnerId);
const button = (model, label) => models[model].form.buttons.find((b) => b.label === label);

test('quiz parsing keeps the starred answer as the correct index and skips unstarred lines', () => {
  assert.deepEqual(parseQuestions(`${QUIZ}\nNo star here | a | b\n\nMalformed line`), [
    { question: 'What is 2+2?', answers: ['3', '4', '5'], correct: 1 },
    { question: 'Which one is a fruit?', answers: ['Apple', 'Chair', 'Table'], correct: 0 },
  ]);
  assert.deepEqual(parseQuestions(''), []);
  assert.deepEqual(parseQuestions(null), []);
});

test('enrollment enforces the publish, payment and invitation rules, then is idempotent', () => {
  const db0 = seed();
  const draft = create(db0, 'slide.channel', { name: 'Draft course', lessons: [] });
  assert.throws(() => enroll(draft.db, read(draft.db, 'slide.channel', draft.id), 3), /published/);

  const paid = create(draft.db, 'slide.channel', { name: 'Paid course', stage_id: 'published', enroll: 'payment', product_id: 5, lessons: [] });
  assert.throws(() => enroll(paid.db, read(paid.db, 'slide.channel', paid.id), 3), /payment/);
  const invite = create(paid.db, 'slide.channel', { name: 'Invited course', stage_id: 'published', enroll: 'invite', lessons: [] });
  assert.throws(() => enroll(invite.db, read(invite.db, 'slide.channel', invite.id), 3), /invitation/);

  const open = create(invite.db, 'slide.channel', { name: 'Open course', stage_id: 'published', lessons: [video('Intro')] });
  let db = enroll(open.db, read(open.db, 'slide.channel', open.id), 3);
  const att = attendee(db, open.id, 3);
  assert.equal(att.state, 'joined');
  assert.equal(att.join_date, today());
  assert.deepEqual([read(db, 'slide.channel', open.id).members, read(db, 'slide.channel', open.id).members_count], [1, 1]);
  assert.equal(enroll(db, read(db, 'slide.channel', open.id), 3), db); // enrolling again changes nothing
  assert.throws(() => create(db, 'slide.channel.partner', { channel_id: open.id, partner_id: 3 }), /already enrolled/); // one seat per contact
  db = enroll(db, read(db, 'slide.channel', open.id), 5);
  assert.equal(read(db, 'slide.channel', open.id).members, 2);

  db = enroll(db, read(db, 'slide.channel', paid.id), 3, { paid: true });
  assert.equal(attendee(db, paid.id, 3).state, 'joined');
  db = enroll(db, read(db, 'slide.channel', invite.id), 3, { invited: true });
  assert.ok(attendee(db, invite.id, 3));
});

test('lesson completion tracks the percentage and state through to the end of the course', () => {
  const made = course(seed(), 'Two lessons', [video('Intro'), video('Wrap-up')], { karma_gain: 20 });
  let db = enroll(made.db, read(made.db, 'slide.channel', made.id), 3);
  let a = attendee(db, made.id, 3);
  db = completeLesson(db, a, 0);
  a = read(db, 'slide.channel.partner', a.id);
  assert.deepEqual([a.completion, a.state, a.completed_lessons], [50, 'ongoing', ['0']]);
  assert.throws(() => completeLesson(db, a, 0), /already/); // a lesson is completed once
  db = completeLesson(db, a, 1);
  a = read(db, 'slide.channel.partner', a.id);
  assert.deepEqual([a.completion, a.state, a.karma, a.certified], [100, 'completed', 20, false]);
  assert.equal(a.completed_date, today());

  const three = course(db, 'Three lessons', [video('A'), video('B'), video('C')]);
  db = three.db;
  db = enroll(db, read(db, 'slide.channel', three.id), 5);
  const part = attendee(db, three.id, 5);
  db = completeLesson(db, part, 0);
  assert.equal(read(db, 'slide.channel.partner', part.id).completion, 33); // rounds to whole percents

  const quizzed = course(db, 'Quizzed', [quiz('Final')]);
  db = quizzed.db;
  db = enroll(db, read(db, 'slide.channel', quizzed.id), 6);
  assert.throws(() => completeLesson(db, attendee(db, quizzed.id, 6), 0), /quiz/); // quizzes only complete via submitQuiz
});

test('quiz points follow the attempt number and failed attempts still count', () => {
  const made = course(seed(), 'Scoring', [quiz('Final quiz')], { karma_gain: 0 });
  let db = enroll(made.db, read(made.db, 'slide.channel', made.id), 3);
  let a = attendee(db, made.id, 3);
  const failed = submitQuiz(db, a, 0, [2, 2]); // both answers wrong
  assert.deepEqual([failed.passed, failed.points, failed.correct, failed.total], [false, 0, 0, 2]);
  a = read(failed.db, 'slide.channel.partner', a.id);
  assert.deepEqual(a.quiz_attempts, ['0:1']);
  assert.deepEqual([a.completion, a.state], [0, 'joined']); // a failed attempt does not start the course

  const passed = submitQuiz(failed.db, a, 0, [1, 0]); // second attempt, every answer right
  assert.deepEqual([passed.passed, passed.points, passed.correct, passed.total], [true, 7, 2, 2]);
  a = read(passed.db, 'slide.channel.partner', a.id);
  assert.deepEqual([a.karma, a.quiz_attempts, a.completed_lessons, a.completion], [7, ['0:2'], ['0'], 100]);
  assert.throws(() => submitQuiz(passed.db, a, 0, [1, 0]), /passed/); // already passed

  for (const [partner, attempt, points] of [[5, 1, 10], [6, 3, 5], [1, 4, 2]]) {
    db = enroll(db, read(db, 'slide.channel', made.id), partner);
    let me = attendee(db, made.id, partner);
    for (let i = 1; i < attempt; i++) {
      const miss = submitQuiz(db, me, 0, [2, 2]);
      assert.equal(miss.passed, false);
      db = miss.db;
      me = read(db, 'slide.channel.partner', me.id);
    }
    const hit = submitQuiz(db, me, 0, [1, 0]);
    db = hit.db;
    assert.deepEqual([hit.points, read(db, 'slide.channel.partner', me.id).karma], [points, points]);
    assert.deepEqual(read(db, 'slide.channel.partner', me.id).quiz_attempts, [`0:${attempt}`]);
  }
});

test('finishing grants the course karma once and certifies only with every quiz passed', () => {
  const made = course(seed(), 'Certified course',
    [video('Watch'), quiz('Quiz 1', 'First? | *yes | no'), quiz('Quiz 2', 'Second? | yes | *no')],
    { karma_gain: 25, certification: true });
  let db = enroll(made.db, read(made.db, 'slide.channel', made.id), 3);
  let a = attendee(db, made.id, 3);
  db = completeLesson(db, a, 0);
  a = read(db, 'slide.channel.partner', a.id);
  assert.deepEqual([a.completion, a.state, a.karma, a.certified], [33, 'ongoing', 0, false]);

  db = submitQuiz(db, a, 1, [0]).db; // Quiz 1 passed on the first attempt (+10)
  db = submitQuiz(db, read(db, 'slide.channel.partner', a.id), 2, [0]).db; // Quiz 2 failed
  a = read(db, 'slide.channel.partner', a.id);
  assert.deepEqual([a.completion, a.karma, a.certified], [67, 10, false]); // one quiz still failing

  db = submitQuiz(db, a, 2, [1]).db; // Quiz 2 passed on the second attempt (+7)
  a = read(db, 'slide.channel.partner', a.id);
  assert.deepEqual([a.completion, a.state, a.karma, a.certified], [100, 'completed', 42, true]); // 10 + 7 + course gain 25
  assert.deepEqual(a.completed_lessons, ['0', '1', '2']);
  assert.equal(a.completed_date, today());

  assert.throws(() => submitQuiz(db, a, 1, [0]), /passed/);
  assert.throws(() => completeLesson(db, a, 0), /already/);
  assert.equal(read(db, 'slide.channel.partner', a.id).karma, 42); // nothing re-grants the course karma
});

test('the seeded course still loads through the rebuilt model and computes its totals', () => {
  const db = seed();
  const ergo = search(db, 'slide.channel').find((c) => c.name === 'Ergonomics 101');
  assert.ok(ergo);
  assert.equal(ergo.stage_id, 'published');
  assert.equal(ergo.total_time, 25);
  assert.equal(ergo.lesson_count, 3);
  assert.equal(ergo.members, 14);
  assert.deepEqual(ergo.lessons.map((l) => l.kind), ['video', 'doc', 'quiz']);
  assert.deepEqual(channelStats(db, ergo), { attendees: 0, completed: 0, avgCompletion: 0 });

  assert.equal(models['slide.channel'].form.statusbar, 'stage_id'); // the override replaced the apps2 stub
  assert.ok(models['slide.channel'].fields.enroll);
  assert.ok(models['slide.channel'].fields.lessons.fields.url);
  assert.equal(models['slide.channel'].form.smart[0].target, 'elearning/attendees');
  assert.deepEqual(models['slide.channel'].kanban.lines, ['lesson_count', 'total_time', 'members']);
  const btns = Object.fromEntries(models['slide.channel'].form.buttons.map((b) => [b.label, b]));
  assert.deepEqual(btns.Publish.vals, { stage_id: 'published' });
  assert.deepEqual(btns.Unpublish.vals, { stage_id: 'draft' });

  const db2 = enroll(db, ergo, 3); // members syncs to the real attendee count
  assert.equal(read(db2, 'slide.channel', ergo.id).members, 1);
  assert.throws(() => submitQuiz(db2, attendee(db2, ergo.id, 3), 2, [0]), /questions/); // the seed quiz has no questions yet
});

test('channel statistics aggregate attendance, completions and average progress', () => {
  const made = course(seed(), 'Stats', [video('A'), video('B')]);
  let db = made.db;
  for (const partner of [3, 5, 6]) db = enroll(db, read(db, 'slide.channel', made.id), partner);
  let p3 = attendee(db, made.id, 3);
  db = completeLesson(db, p3, 0);
  p3 = read(db, 'slide.channel.partner', p3.id);
  db = completeLesson(db, p3, 1); // partner 3 finishes
  db = completeLesson(db, attendee(db, made.id, 5), 0); // partner 5 halfway, partner 6 has not started
  assert.deepEqual(channelStats(db, read(db, 'slide.channel', made.id)), { attendees: 3, completed: 1, avgCompletion: 50 });
});

test('the Enroll Contact button matches contacts case-insensitively and enrolls as staff', () => {
  const original = globalThis.prompt;
  const made = course(seed(), 'Paid', [], { enroll: 'payment' });
  const enrollBtn = button('slide.channel', 'Enroll Contact');
  try {
    globalThis.prompt = () => 'sara hassan'; // partner 3 is "Sara Hassan"
    const res = enrollBtn.run(made.db, read(made.db, 'slide.channel', made.id));
    assert.equal(attendee(res.db, made.id, 3).state, 'joined'); // staff entry implies the payment
    assert.equal(read(res.db, 'slide.channel', made.id).members, 1);

    globalThis.prompt = () => 'Nobody Here';
    assert.throws(() => enrollBtn.run(res.db, read(res.db, 'slide.channel', made.id)), /No contact/);

    globalThis.prompt = () => null; // cancelled prompt changes nothing
    assert.equal(enrollBtn.run(res.db, read(res.db, 'slide.channel', made.id)).db, res.db);
  } finally {
    if (original === undefined) delete globalThis.prompt; else globalThis.prompt = original;
  }
});

test('attendee buttons complete the next lesson and take the first open quiz', () => {
  const originalPrompt = globalThis.prompt;
  const originalAlert = globalThis.alert;
  let alertText = null;
  const made = course(seed(), 'Buttons', [video('Intro'), quiz('Final')]);
  try {
    globalThis.alert = (m) => { alertText = m; };
    let db = enroll(made.db, read(made.db, 'slide.channel', made.id), 3);
    let a = attendee(db, made.id, 3);

    db = button('slide.channel.partner', 'Complete Next Lesson').run(db, a).db;
    a = read(db, 'slide.channel.partner', a.id);
    assert.deepEqual([a.completed_lessons, a.completion, a.state], [['0'], 50, 'ongoing']);

    globalThis.prompt = () => '2,1'; // 1-based answers: "4" then "Apple"
    db = button('slide.channel.partner', 'Take Quiz').run(db, a).db;
    a = read(db, 'slide.channel.partner', a.id);
    assert.match(alertText, /Passed 2\/2/);
    assert.deepEqual([a.completion, a.state, a.karma, a.certified, a.quiz_attempts], [100, 'completed', 20, false, ['1:1']]); // 10 quiz + 10 course karma

    assert.throws(() => button('slide.channel.partner', 'Complete Next Lesson').run(db, a), /already completed/);
    assert.throws(() => button('slide.channel.partner', 'Take Quiz').run(db, a), /No quiz/);
  } finally {
    if (originalPrompt === undefined) delete globalThis.prompt; else globalThis.prompt = originalPrompt;
    if (originalAlert === undefined) delete globalThis.alert; else globalThis.alert = originalAlert;
  }
});

test('removing an attendee or its course keeps the member counts honest', () => {
  const made = course(seed(), 'Removal', [video('Intro')]);
  let db = enroll(made.db, read(made.db, 'slide.channel', made.id), 3);
  db = enroll(db, read(db, 'slide.channel', made.id), 5);
  db = unlink(db, 'slide.channel.partner', [attendee(db, made.id, 3).id]);
  assert.deepEqual([read(db, 'slide.channel', made.id).members, read(db, 'slide.channel', made.id).members_count], [1, 1]);
  db = unlink(db, 'slide.channel', [made.id]);
  assert.deepEqual(search(db, 'slide.channel.partner').filter((x) => x.channel_id === made.id), []);
});
