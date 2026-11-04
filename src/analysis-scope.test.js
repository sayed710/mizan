import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { seed } from './seed.js';
import { createCompany } from './models/company.js';
import { create } from './orm.js';
register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

test('the shared analysis renderer scopes both calculations and related names to selected companies', async () => {
  const company = createCompany(seed(), { name: 'Branch' });
  const hidden = create(company.db, 'hr.employee', { name: 'Hidden branch employee', company_id: company.id });
  const db = { ...hidden.db, settings: { ...hidden.db.settings, current_company_id: 1, allowed_company_ids: [1] } };
  const { AnalysisResult } = await import('./views/Analysis.jsx');
  let executed = false;
  const html = renderToStaticMarkup(createElement(AnalysisResult, { db, run: (view) => {
    executed = true;
    assert.ok(!view.records['hr.employee'].some((e) => e.id === hidden.id));
    return [{ employee_id: hidden.id, count: 1 }];
  } }));
  assert.ok(executed);
  assert.doesNotMatch(html, /Hidden branch employee/);
  assert.doesNotMatch(html, /alert/);
});

test('appraisal analysis adapts manager groups to rows with resolved names and unassigned label', async () => {
  let db = seed();
  const mgr = create(db, 'hr.employee', { name: 'Sarah Connor', company_id: 1 });
  db = mgr.db;
  const emp1 = create(db, 'hr.employee', { name: 'John Connor', company_id: 1 });
  db = emp1.db;
  const emp2 = create(db, 'hr.employee', { name: 'Kyle Reese', company_id: 1 });
  db = emp2.db;

  // Appraisal 1: has manager
  db = create(db, 'hr.appraisal', {
    employee_id: emp1.id,
    manager_id: mgr.id,
    stage_id: 'done',
    date_close: '2026-05-01',
    final_rating: 4,
    employee_feedback_published: true,
    manager_feedback_published: true,
    company_id: 1,
  }).db;

  // Appraisal 2: unassigned manager
  db = create(db, 'hr.appraisal', {
    employee_id: emp2.id,
    manager_id: null,
    stage_id: 'pending',
    date: '2026-05-01',
    company_id: 1,
  }).db;

  const { appAnalyses } = await import('./models/analysis.js');
  const appraisalA = appAnalyses.find((a) => a.key === 'appraisal-analysis');
  assert.ok(appraisalA);
  const rows = appraisalA.run(db, { from: '2026-01-01', to: '2026-12-31' });
  assert.ok(Array.isArray(rows));
  const assigned = rows.find((r) => r.manager_id === mgr.id);
  const unassigned = rows.find((r) => r.manager_id === null);
  assert.ok(assigned, 'found assigned manager row');
  assert.ok(unassigned, 'found unassigned manager row');

  const { AnalysisResult } = await import('./views/Analysis.jsx');
  const html = renderToStaticMarkup(createElement(AnalysisResult, { db, run: (view) => appraisalA.run(view, { from: '2026-01-01', to: '2026-12-31' }) }));
  assert.match(html, /Sarah Connor/);
  assert.match(html, /Unassigned/);
  assert.match(html, /<table/);
});
