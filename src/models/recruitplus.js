// Recruitment interviews, offers and pipeline analysis.
import { create, postNote, read, search, write } from '../orm.js';
import { moreModels } from './more.js';
import { today } from './common.js';

const base = moreModels['hr.applicant'];
const stages = base.fields.stage_id.options;
const normalize = (s) => String(s ?? '').trim().toLowerCase();
const dateStamp = (date) => {
  const stamp = Date.parse(`${date}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(date ?? '') && Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === date ? stamp : NaN;
};
const slot = (date, time) => Number.isFinite(dateStamp(date)) && /^([01]\d|2[0-3]):[0-5]\d$/.test(time ?? '') ? dateStamp(date) + (Number(time.slice(0, 2)) * 60 + Number(time.slice(3))) * 60000 : NaN;
const current = (db, applicant) => {
  const r = read(db, 'hr.applicant', applicant.id);
  if (!r) throw new Error('Applicant not found');
  if (r.active === false || r.emp_id) throw new Error('This applicant is already hired or refused');
  return r;
};

/** Book an interviewer slot and advance the applicant to the first interview. */
export function scheduleInterview(db, applicant, { date, time, interviewer, durationMin = 60 }) {
  const r = current(db, applicant);
  const start = slot(date, time);
  const duration = Number(durationMin);
  const person = String(interviewer ?? '').trim();
  if (!Number.isFinite(start) || !person || !Number.isFinite(duration) || duration <= 0) throw new Error('Enter a valid interview date, HH:MM time, interviewer and positive duration');
  const end = start + duration * 60000;
  const busy = search(db, 'calendar.event').some((e) => {
    const names = [e.interviewer, ...(e.description ?? '').split('\n').filter((s) => s.startsWith('Interviewer: ')).map((s) => s.slice(13))];
    if (!names.some((name) => normalize(name) === normalize(person))) return false;
    const from = slot(e.start, e.start_time);
    return from < end && from + Number(e.duration) * 3600000 > start;
  });
  if (busy) throw new Error(`${person} already has an overlapping calendar event`);
  const job = read(db, 'hr.job', r.job_id);
  const next = create(db, 'calendar.event', {
    name: `Interview: ${r.name} — ${job?.name ?? 'Unspecified position'}`,
    start: date, start_time: time, duration: duration / 60,
    interviewer: person, description: `Interviewer: ${person}`,
  }).db;
  return write(next, 'hr.applicant', r.id, {
    interview_date: date, interview_time: time, interviewer: person,
    ...(stages.some(([id]) => id === 'interview') ? { stage_id: 'interview' } : {}),
  });
}

/** Record a dated salary offer in the applicant's chatter. */
export function sendOffer(db, applicant, { salary, date }) {
  const r = current(db, applicant);
  const amount = Number(salary);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Offer salary must be greater than zero');
  if (!Number.isFinite(dateStamp(date))) throw new Error('Enter a valid offer date');
  const next = write(db, 'hr.applicant', r.id, {
    salary_proposed: amount, offer_sent_on: date, offer_accepted: false,
    ...(stages.some(([id]) => id === 'contract') ? { stage_id: 'contract' } : {}),
  });
  return postNote(next, 'hr.applicant', r.id, `Offer sent on ${date}: salary ${amount}`);
}

/** Accept a sent offer using the existing Create Employee action. */
export function acceptOffer(db, applicant) {
  const r = current(db, applicant);
  if (!r.offer_sent_on || !(Number(r.salary_proposed) > 0)) throw new Error('Send an offer before accepting it');
  const next = write(db, 'hr.applicant', r.id, { offer_accepted: true });
  return base.form.buttons.find((b) => b.label === 'Create Employee').run(next, read(next, 'hr.applicant', r.id)).db;
}

/** Count all job applications, including refusals, and elapsed calendar days to hire. */
export function jobPipeline(db, jobId) {
  const records = search(db, 'hr.applicant', { includeArchived: true }).filter((r) => r.job_id === jobId);
  const counts = Object.fromEntries(stages.map(([id]) => [id, 0]));
  for (const r of records) counts[r.stage_id] = (counts[r.stage_id] ?? 0) + 1;
  const hired = records.filter((r) => r.emp_id || r.stage_id === 'hired');
  const days = hired.map((r) => (dateStamp(r.date_closed) - dateStamp(r.create_date)) / 86400000).filter((n) => Number.isFinite(n) && n >= 0);
  return { stages: counts, applicants: records.length, hired: hired.length, refused: records.filter((r) => r.active === false).length, avgDaysToHire: days.length ? days.reduce((a, b) => a + b, 0) / days.length : 0 };
}

/** Return connected duplicate groups by normalized email or digits-only phone. */
export function duplicateApplicants(db) {
  const groups = [];
  for (const r of search(db, 'hr.applicant', { includeArchived: true })) {
    const email = normalize(r.email);
    const phone = String(r.phone ?? '').replace(/\D/g, '');
    const matches = groups.filter((g) => g.some((a) => (email && normalize(a.email) === email) || (phone && String(a.phone ?? '').replace(/\D/g, '') === phone)));
    const merged = [...matches.flat(), r];
    for (const g of matches) groups.splice(groups.indexOf(g), 1);
    groups.push(merged);
  }
  return groups.filter((g) => g.length > 1);
}

/** Score three evaluation stars, required-skill coverage and salary budget fit. */
export function applicantScore(applicant, job) {
  const required = [...new Set((job.skills ?? []).map(normalize).filter(Boolean))];
  const skills = new Set((applicant.skills ?? []).map(normalize));
  const priority = Math.max(0, Math.min(3, Number(applicant.priority) || 0)) / 3;
  const coverage = required.length ? required.filter((s) => skills.has(s)).length / required.length : 0;
  const salary = Number(applicant.salary_expected ?? applicant.expected_salary);
  const budget = Number(job.salary_max);
  return Math.round(priority * 40 + coverage * 40 + (salary > 0 && budget > 0 && salary <= budget ? 20 : 0));
}

export const recruitPlusModels = {
  'hr.job': {
    ...moreModels['hr.job'],
    fields: { ...moreModels['hr.job'].fields, skills: { type: 'tags', label: 'Required Skills' }, salary_max: { type: 'monetary', label: 'Salary Budget' } },
    form: { ...moreModels['hr.job'].form, groups: [...moreModels['hr.job'].form.groups, ['skills', 'salary_max']] },
  },
  'hr.applicant': {
    ...base,
    fields: {
      ...base.fields,
      interviewer: { type: 'char', label: 'Interviewer' },
      interview_date: { type: 'date', label: 'Interview Date' },
      interview_time: { type: 'char', label: 'Interview Time (HH:MM)' },
      salary_expected: { type: 'monetary', label: 'Expected Salary' },
      offer_sent_on: { type: 'date', label: 'Offer Sent on', readonly: true },
      offer_accepted: { type: 'boolean', label: 'Offer Accepted', readonly: true },
      skills: { type: 'tags', label: 'Skills' },
      create_date: { type: 'date', label: 'Applied on', readonly: true },
      degree: { ...base.fields.degree, options: [...base.fields.degree.options, ['none', 'None'], ['doctorate', 'Doctorate']] },
      refuse_reason: { ...base.fields.refuse_reason, options: [...base.fields.refuse_reason.options, ['does_not_fit', 'Does Not Fit'], ['other_offer', 'Other Offer'], ['no_answer', 'No Answer']] },
    },
    defaults: (id) => ({ ...base.defaults(id), skills: [], offer_accepted: false, create_date: today() }),
    form: {
      ...base.form,
      groups: [...base.form.groups, ['interviewer', 'interview_date', 'interview_time', 'create_date']],
      tabs: [...base.form.tabs, { label: 'Offer', fields: ['salary_expected', 'salary_proposed', 'availability', 'offer_sent_on', 'offer_accepted'] }, { label: 'Skills', fields: ['skills', 'degree'] }],
      buttons: [...base.form.buttons, {
        label: 'Schedule Interview', when: (r) => !r.emp_id && r.active !== false,
        run: (db, r) => {
          const date = prompt('Interview date (YYYY-MM-DD)', r.interview_date || today());
          if (date == null) return { db };
          const time = prompt('Interview time (HH:MM)', r.interview_time || '10:00');
          if (time == null) return { db };
          const interviewer = prompt('Interviewer', r.interviewer || '');
          return { db: interviewer == null ? db : scheduleInterview(db, r, { date, time, interviewer }) };
        },
      }, {
        label: 'Send Offer', when: (r) => !r.emp_id && r.active !== false,
        run: (db, r) => {
          const salary = prompt('Proposed salary', String(r.salary_proposed || r.salary_expected || r.expected_salary || ''));
          return { db: salary == null ? db : sendOffer(db, r, { salary, date: today() }) };
        },
      }, { label: 'Accept Offer', when: (r) => !r.emp_id && r.active !== false && !!r.offer_sent_on && !r.offer_accepted, run: (db, r) => ({ db: acceptOffer(db, r) }) }],
    },
  },
};
