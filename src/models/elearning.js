// eLearning: courses, lessons and quizzes, enrollment rules, attendee progress, karma and certification.
import { create, read, search, unlink, write } from '../orm.js';
import { today } from './common.js';

/** Points earned by the 1st/2nd/3rd/later passing attempt when a quiz lesson sets none of its own. */
const QUIZ_POINTS = { points_first: 10, points_second: 7, points_third: 5, points_more: 2 };

/**
 * Quiz questions of a lesson, one per line as "Question? | answer | *correct answer | answer".
 * Lines without a starred answer are ignored; `correct` is the index in `answers`.
 */
export function parseQuestions(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.split('|').map((p) => p.trim()))
    .filter((parts) => parts.length >= 2 && parts[0])
    .map((parts) => {
      const correct = parts.findIndex((p, i) => i > 0 && p.startsWith('*'));
      return correct === -1 ? null : { question: parts[0], answers: parts.slice(1).map((p) => p.replace(/^\*/, '')), correct: correct - 1 };
    })
    .filter(Boolean);
}

const attendeesOf = (db, channelId) => search(db, 'slide.channel.partner').filter((a) => a.channel_id === channelId);
const isDone = (attendee, lessonIndex) => (attendee.completed_lessons ?? []).includes(String(lessonIndex));
const quizAttemptsOf = (attendee, lessonIndex) => Number((attendee.quiz_attempts ?? []).find((t) => t.startsWith(`${lessonIndex}:`))?.split(':')[1] ?? 0);
const withQuizAttempt = (attendee, lessonIndex, attempts) => [
  ...(attendee.quiz_attempts ?? []).filter((t) => !t.startsWith(`${lessonIndex}:`)),
  `${lessonIndex}:${attempts}`,
];

/**
 * Write an attendee's progress now that `lessonIndex` is done: completion %, state, certification, and on
 * the first full completion the course karma and completion date. `extra` merges into the write; `karmaDelta`
 * adds quiz points on top of the course karma.
 */
function markDone(db, attendee, lessonIndex, { date, karmaDelta = 0, extra = {} } = {}) {
  const channel = read(db, 'slide.channel', attendee.channel_id);
  const done = new Set(attendee.completed_lessons ?? []);
  done.add(String(lessonIndex));
  const lessons = channel?.lessons ?? [];
  const completion = lessons.length ? Math.round((lessons.filter((_, i) => done.has(String(i))).length / lessons.length) * 100) : 0;
  const quizzesPassed = lessons.every((l, i) => l.kind !== 'quiz' || done.has(String(i)));
  const vals = {
    ...extra,
    completed_lessons: [...done].sort((a, b) => Number(a) - Number(b)),
    completion,
    state: completion >= 100 ? 'completed' : 'ongoing',
    certified: completion >= 100 && !!channel?.certification && quizzesPassed,
  };
  if (completion >= 100 && !attendee.completed_date) { // karma and the date go to the first completion only
    vals.completed_date = date ?? today();
    karmaDelta += Number(channel?.karma_gain) || 0;
  }
  if (karmaDelta) vals.karma = (Number(attendee.karma) || 0) + karmaDelta;
  return write(db, 'slide.channel.partner', attendee.id, vals);
}

/**
 * Enroll a contact in a course. Only published courses accept enrollments; 'On Payment' courses need
 * `paid` and 'On Invitation' courses need `invited`. Enrolling an existing attendee changes nothing.
 */
export function enroll(db, channel, partnerId, { paid = false, invited = false, date = today() } = {}) {
  if (channel.stage_id !== 'published') throw new Error('Only published courses can be enrolled in');
  if (channel.enroll === 'payment' && !paid) throw new Error('This course requires a payment before enrolling');
  if (channel.enroll === 'invite' && !invited) throw new Error('This course is on invitation only');
  if (attendeesOf(db, channel.id).some((a) => a.partner_id === partnerId)) return db;
  const { db: next } = create(db, 'slide.channel.partner', { channel_id: channel.id, partner_id: partnerId, join_date: date });
  const members = attendeesOf(next, channel.id).length;
  return write(next, 'slide.channel', channel.id, { members, members_count: members });
}

/** Complete a lesson for an attendee. Quiz lessons only complete through submitQuiz. */
export function completeLesson(db, attendee, lessonIndex, { date } = {}) {
  const channel = read(db, 'slide.channel', attendee.channel_id);
  const lesson = (channel?.lessons ?? [])[Number(lessonIndex)];
  if (!channel) throw new Error('This course no longer exists');
  if (!lesson) throw new Error('Lesson not found');
  if (lesson.kind === 'quiz') throw new Error('Quiz lessons are completed by passing the quiz');
  if (isDone(attendee, lessonIndex)) throw new Error('This lesson is already completed');
  return markDone(db, attendee, lessonIndex, { date });
}

/**
 * Grade a quiz submission: every answer must be right to pass. Each submission counts as one attempt,
 * and a passing attempt earns its lesson points by attempt number (1st, 2nd, 3rd, later). Answers are
 * 0-based indices into each question's choices. Returns { db, passed, points, correct, total }.
 */
export function submitQuiz(db, attendee, lessonIndex, answers = []) {
  const channel = read(db, 'slide.channel', attendee.channel_id);
  const lesson = (channel?.lessons ?? [])[Number(lessonIndex)];
  if (!channel) throw new Error('This course no longer exists');
  if (!lesson) throw new Error('Lesson not found');
  if (lesson.kind !== 'quiz') throw new Error('This lesson is not a quiz');
  if (isDone(attendee, lessonIndex)) throw new Error('This quiz is already passed');
  const questions = parseQuestions(lesson.questions);
  if (!questions.length) throw new Error('This quiz has no questions yet');
  const attempt = quizAttemptsOf(attendee, lessonIndex) + 1;
  const correct = questions.filter((q, i) => Number(answers[i]) === q.correct).length;
  if (correct < questions.length) {
    return { db: write(db, 'slide.channel.partner', attendee.id, { quiz_attempts: withQuizAttempt(attendee, lessonIndex, attempt) }), passed: false, points: 0, correct, total: questions.length };
  }
  const key = ['points_first', 'points_second', 'points_third'][attempt - 1] ?? 'points_more';
  const points = Number(lesson[key] ?? QUIZ_POINTS[key]);
  const done = markDone(db, attendee, lessonIndex, { karmaDelta: points, extra: { quiz_attempts: withQuizAttempt(attendee, lessonIndex, attempt) } });
  return { db: done, passed: true, points, correct, total: questions.length };
}

/** Course statistics over its attendees: count, completed count and average completion. */
export function channelStats(db, channel) {
  const attendees = attendeesOf(db, channel.id);
  const completed = attendees.filter((a) => a.state === 'completed').length;
  return { attendees: attendees.length, completed, avgCompletion: attendees.length ? Math.round(attendees.reduce((s, a) => s + (Number(a.completion) || 0), 0) / attendees.length) : 0 };
}

const nextLesson = (channel, attendee) => (channel.lessons ?? []).findIndex((l, i) => l.kind !== 'quiz' && !isDone(attendee, i));
const nextQuiz = (channel, attendee) => (channel.lessons ?? []).findIndex((l, i) => l.kind === 'quiz' && !isDone(attendee, i));

export const elearningModels = {
  'slide.channel': {
    label: 'Courses',
    fields: {
      name: { type: 'char', label: 'Course Title', required: true },
      user_id: { type: 'many2one', relation: 'hr.employee', label: 'Responsible' },
      tag_ids: { type: 'tags', label: 'Tags' },
      stage_id: { type: 'selection', label: 'Status', tracking: true, options: [['draft', 'Draft'], ['published', 'Published']] },
      description: { type: 'text', label: 'Description' },
      enroll: { type: 'selection', label: 'Enroll Policy', options: [['public', 'Open'], ['invite', 'On Invitation'], ['payment', 'On Payment']] },
      product_id: { type: 'many2one', relation: 'product', label: 'Course Product' },
      visibility: { type: 'selection', label: 'Visibility', options: [['public', 'Everyone'], ['members', 'Members Only']] },
      karma_gain: { type: 'integer', label: 'Karma on completion' },
      certification: { type: 'boolean', label: 'Certification' },
      lessons: {
        type: 'one2many',
        label: 'Content',
        fields: {
          title: { type: 'char', label: 'Lesson' },
          kind: { type: 'selection', label: 'Type', options: [['video', 'Video'], ['doc', 'Document'], ['quiz', 'Quiz']] },
          duration: { type: 'float', label: 'Duration (min)' },
          description: { type: 'text', label: 'Description' },
          url: { type: 'char', label: 'Video/Document URL' },
          is_preview: { type: 'boolean', label: 'Preview' },
          points_first: { type: 'integer', label: 'Points (1st attempt)' },
          points_second: { type: 'integer', label: 'Points (2nd attempt)' },
          points_third: { type: 'integer', label: 'Points (3rd attempt)' },
          points_more: { type: 'integer', label: 'Points (later attempts)' },
          questions: { type: 'text', label: 'Questions' },
        },
        newLine: () => ({ title: '', kind: 'video', duration: 10, points_first: 10, points_second: 7, points_third: 5, points_more: 2 }),
      },
      members: { type: 'integer', label: 'Attendees', readonly: true },
      members_count: { type: 'integer', label: 'Enrolled', readonly: true },
      lesson_count: { type: 'integer', label: 'Lessons', compute: (r) => (r.lessons ?? []).length },
      total_time: { type: 'float', label: 'Duration (min)', compute: (r) => Math.round((r.lessons ?? []).reduce((s, l) => s + (Number(l.duration) || 0), 0) * 100) / 100 },
    },
    defaults: () => ({ stage_id: 'draft', enroll: 'public', visibility: 'public', karma_gain: 10, members: 0, members_count: 0, lessons: [], tag_ids: [] }),
    filters: [[
      { id: 'published', label: 'Published', fn: (r) => r.stage_id === 'published' },
      { id: 'open', label: 'Open Enrollment', fn: (r) => r.enroll === 'public' },
      { id: 'cert', label: 'Certifications', fn: (r) => r.certification },
    ]],
    groupBys: ['stage_id', 'user_id', 'enroll'],
    kanban: { groupBy: 'stage_id', quickCreate: true, title: 'name', lines: ['lesson_count', 'total_time', 'members'], tags: 'tag_ids' },
    list: ['name', 'user_id', 'lesson_count', 'total_time', 'members', 'stage_id'],
    form: {
      statusbar: 'stage_id',
      statusbarClickable: false,
      buttons: [
        { label: 'Publish', primary: true, when: (r) => r.stage_id === 'draft', vals: { stage_id: 'published' } },
        { label: 'Unpublish', when: (r) => r.stage_id === 'published', vals: { stage_id: 'draft' } },
        {
          label: 'Enroll Contact',
          run: (db, r) => {
            const name = prompt('Contact to enroll (name)');
            if (name == null) return { db };
            const partner = search(db, 'res.partner').find((p) => p.name?.toLowerCase() === String(name).trim().toLowerCase());
            if (!partner) throw new Error(`No contact named "${String(name).trim()}"`);
            return { db: enroll(db, r, partner.id, { paid: true, invited: true }) }; // staff entry implies payment/invitation
          },
        },
      ],
      title: 'name',
      smart: [{ label: 'Attendees', model: 'slide.channel.partner', field: 'channel_id', target: 'elearning/attendees' }],
      groups: [['user_id', 'tag_ids'], ['members', 'members_count', 'lesson_count', 'total_time']],
      tabs: [
        { label: 'Content', fields: ['lessons'] },
        { label: 'Description', fields: ['description'] },
        { label: 'Options', fields: ['enroll', 'product_id', 'visibility', 'karma_gain', 'certification'] },
      ],
      chatter: true,
    },
    // Deleting a course takes its attendees along instead of leaving orphan enrollments.
    onUnlink: (db, r) => {
      const ids = (db.records['slide.channel.partner'] ?? []).filter((a) => a.channel_id === r.id).map((a) => a.id);
      return ids.length ? unlink(db, 'slide.channel.partner', ids) : db;
    },
  },

  'slide.channel.partner': {
    label: 'Course Attendees',
    fields: {
      channel_id: { type: 'many2one', relation: 'slide.channel', label: 'Course', required: true },
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Contact', required: true },
      state: { type: 'selection', label: 'Status', tracking: true, readonly: true, options: [['joined', 'Joined'], ['ongoing', 'Ongoing'], ['completed', 'Completed']] },
      completion: { type: 'integer', label: 'Completion (%)', readonly: true },
      karma: { type: 'integer', label: 'Karma', readonly: true },
      certified: { type: 'boolean', label: 'Certified', readonly: true },
      completed_lessons: { type: 'tags', label: 'Completed Lessons', readonly: true },
      quiz_attempts: { type: 'tags', label: 'Quiz Attempts', readonly: true },
      join_date: { type: 'date', label: 'Joined on' },
      completed_date: { type: 'date', label: 'Completed on', readonly: true },
    },
    defaults: () => ({ state: 'joined', completion: 0, karma: 0, certified: false, completed_lessons: [], quiz_attempts: [], join_date: today() }),
    // Progress fields are driven by the lesson/quiz actions; a contact only enrolls once per course.
    guard: (db, before, after) => ((db.records['slide.channel.partner'] ?? []).some((a) => a.id !== after.id && a.channel_id === after.channel_id && a.partner_id === after.partner_id)
      ? 'This contact is already enrolled in this course'
      : null),
    filters: [[
      { id: 'ongoing', label: 'Ongoing', fn: (r) => r.state === 'ongoing' },
      { id: 'completed', label: 'Completed', fn: (r) => r.state === 'completed' },
      { id: 'certified', label: 'Certified', fn: (r) => r.certified },
    ]],
    groupBys: ['channel_id', 'state', 'partner_id'],
    list: ['channel_id', 'partner_id', 'state', 'completion', 'karma', 'certified', 'join_date'],
    views: ['list'],
    form: {
      title: 'partner_id',
      buttons: [
        {
          label: 'Complete Next Lesson', primary: true,
          run: (db, r) => {
            const channel = read(db, 'slide.channel', r.channel_id);
            const index = nextLesson(channel, r);
            if (index === -1) throw new Error(nextQuiz(channel, r) === -1 ? 'The course is already completed' : 'Only quizzes are left — take the quiz');
            return { db: completeLesson(db, r, index) };
          },
        },
        {
          label: 'Take Quiz',
          run: (db, r) => {
            const channel = read(db, 'slide.channel', r.channel_id);
            const index = nextQuiz(channel, r);
            if (index === -1) throw new Error('No quiz left to take');
            const questions = parseQuestions(channel.lessons[index].questions);
            if (!questions.length) throw new Error(`"${channel.lessons[index].title}" has no questions yet`);
            const sheet = questions.map((q, i) => `${i + 1}. ${q.question}\n${q.answers.map((a, j) => `   ${j + 1}) ${a}`).join('\n')}`).join('\n');
            const given = prompt(`"${channel.lessons[index].title}"\n${sheet}\n\nAnswer with comma-separated numbers`, '');
            if (given == null) return { db };
            const res = submitQuiz(db, r, index, String(given).split(',').map((x) => Number(x.trim()) - 1));
            alert(res.passed ? `Passed ${res.correct}/${res.total} — +${res.points} karma` : `Failed: ${res.correct}/${res.total} correct, try again`);
            return { db: res.db };
          },
        },
      ],
      groups: [['channel_id', 'partner_id', 'state'], ['join_date', 'completed_date', 'completion', 'karma', 'certified']],
      tabs: [{ label: 'Progress', fields: ['completed_lessons', 'quiz_attempts'] }],
      chatter: true,
    },
    // Removing an attendee by hand keeps the course member counts honest (their course may already be gone).
    onUnlink: (db, r) => {
      if (!(db.records['slide.channel'] ?? []).some((c) => c.id === r.channel_id)) return db;
      const members = (db.records['slide.channel.partner'] ?? []).filter((a) => a.channel_id === r.channel_id).length;
      return write(db, 'slide.channel', r.channel_id, { members, members_count: members });
    },
  },
};
