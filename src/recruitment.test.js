import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read } from './orm.js';
import { models } from './models/index.js';
import { seed } from './seed.js';

test('hiring an applicant creates the employee with job, department and proposed wage', () => {
  const db0 = seed();
  const job = db0.records['hr.job'][0];
  const { db, id } = create(db0, 'hr.applicant', { name: 'Rana Ali', job_id: job.id, email: 'rana@example.com', stage_id: 'contract', salary_proposed: 9000, availability: '2026-12-01' });
  const out = models['hr.applicant'].form.buttons.find((b) => b.label === 'Create Employee').run(db, read(db, 'hr.applicant', id));
  const applicant = read(out.db, 'hr.applicant', id);
  const emp = read(out.db, 'hr.employee', applicant.emp_id);
  assert.deepEqual([emp.name, emp.job_title, emp.department_id ?? null, emp.wage, emp.join_date], ['Rana Ali', job.name, job.department_id ?? null, 9000, '2026-12-01']);
  assert.equal(applicant.stage_id, 'hired');
});
