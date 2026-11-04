import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, updateSettings } from './orm.js';
import { seed } from './seed.js';
import { createCompany } from './models/company.js';
import { postEntry } from './models/ledger.js';
import { configurableReport } from './models/configurableReports.js';

test('configurable reports and horizontal groups use the report company, not all allowed companies', () => {
  const branch = createCompany(seed(), { name: 'Branch' });
  let db = updateSettings(branch.db, { current_company_id: 1, allowed_company_ids: [1, branch.id] });
  const a = create(db, 'account.account', { name: 'Main expense', code: '987650', company_id: 1, account_type: 'expense' }); db = a.db;
  const b = create(db, 'account.account', { name: 'Branch expense', code: '987650', company_id: branch.id, account_type: 'expense' }); db = b.db;
  const date = '2027-02-01';
  for (const [company, account, amount, partner] of [[1, a.id, 100, 1], [branch.id, b.id, 300, 2]]) {
    db = postEntry(db, { journal: 'MISC', company, date, lines: [{ account, debit: amount, partner_id: partner }, { account: '301000', credit: amount }] }).db;
  }
  const reportA = create(db, 'account.report', { name: 'Main', company_id: 1, show_debit: true, show_credit: true, line_ids: [{ name: 'Expense', code: 'EXP', formula: '987650' }] }); db = reportA.db;
  const reportB = create(db, 'account.report', { name: 'Branch', company_id: branch.id, line_ids: [{ name: 'Expense', code: 'EXP', formula: '987650' }] }); db = reportB.db;
  const group = create(db, 'account.report.horizontal.group', { name: 'Partners', company_id: 1, report_ids: [reportA.id], rule_ids: [{ field: 'partner', ids: '' }] }); db = group.db;
  const period = { from: date, to: date };
  assert.deepEqual(configurableReport(db, read(db, 'account.report', reportA.id), period).rows[0].values, [100, 100, 0]);
  assert.deepEqual(configurableReport(db, read(db, 'account.report', reportB.id), { ...period, company_id: 1 }).rows[0].values, [300]);
  const currentBranch = updateSettings(db, { current_company_id: branch.id, allowed_company_ids: [1, branch.id] });
  assert.deepEqual(configurableReport(currentBranch, { ...read(db, 'account.report', reportB.id), company_id: null }, period).rows[0].values, [300]);
  const grouped = configurableReport(db, read(db, 'account.report', reportA.id), period, read(db, 'account.report.horizontal.group', group.id));
  assert.equal(grouped.buckets.length, 2);
  assert.deepEqual(grouped.rows[0].values, [100, 100, 0, 0, 0, 0]);
});
