import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { create, read, write } from './orm.js';
import { diffDb, applyDiff } from './sync.js';
import { createCompany } from './models/company.js';
import { findStatementReport } from './models/statementReports.js';
import { auditReportModels, annualReportToRows } from './models/auditreport.js';

test('annual report sections select and order reports and notes, scoped to the company and preserved through print and export', () => {
  const base = seed();
  const company = createCompany(base, { name: 'Second company', currency_id: base.records['res.company'][0].currency_id });
  const initial = company.db;
  const pnl = findStatementReport(initial, 'pnl', 1);
  const balance = findStatementReport(initial, 'balance', 1);
  const sections = [
    { type: 'report', report_id: balance.id, sequence: 30 },
    { type: 'note', note: 'A <note> & explanation', sequence: 20 },
    { type: 'report', report_id: pnl.id, sequence: 10 },
  ];
  const created = create(initial, 'audit.report', { title: 'Review', section_ids: sections });
  let db = applyDiff(initial, diffDb(initial, created.db), { isAdmin: true });
  let report = read(db, 'audit.report', created.id);
  assert.ok(report.body.indexOf('Profit and Loss') < report.body.indexOf('A &lt;note&gt;'));
  assert.ok(report.body.indexOf('A &lt;note&gt;') < report.body.indexOf('Balance Sheet'));
  assert.ok(annualReportToRows(report.body).some((row) => row.includes('A <note> & explanation')));
  const buttons = auditReportModels['audit.report'].form.buttons;
  assert.equal(buttons.find((b) => b.label === 'Print').run(db, report).go, `#/print/audit.report/${report.id}`);
  db = write(db, 'audit.report', report.id, { section_ids: [sections[1]] });
  report = read(db, 'audit.report', report.id);
  db = buttons.find((b) => b.label === 'Refresh').run(db, report).db;
  report = read(db, 'audit.report', report.id);
  assert.doesNotMatch(report.body, /Profit and Loss|Balance Sheet/);
  const otherReport = findStatementReport(db, 'pnl', company.id);
  const otherCreated = create(db, 'audit.report', { title: 'Other company', company_id: company.id, section_ids: [{ type: 'report', report_id: otherReport.id }] });
  assert.match(read(otherCreated.db, 'audit.report', otherCreated.id).body, /Profit and Loss/);
  const forged = structuredClone(db);
  forged.records['audit.report'].find((r) => r.id === report.id).section_ids = [{ type: 'report', report_id: otherReport.id }];
  assert.throws(() => applyDiff(db, diffDb(db, forged), { isAdmin: true }), /Select an active report for this company/);
  db = write(db, 'audit.report', report.id, { status: 'done' });
  const locked = structuredClone(db);
  locked.records['audit.report'].find((r) => r.id === report.id).section_ids = [];
  assert.throws(() => applyDiff(db, diffDb(db, locked), { isAdmin: true }), /Done reports are read-only/);
});
