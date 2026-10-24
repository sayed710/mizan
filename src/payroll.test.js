import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from './orm.js';
import { models } from './models/index.js';
import { computeLines } from './models/payroll.js';
import { balanceSheet, isBalanced, profitAndLoss } from './models/ledger.js';
import { seed } from './seed.js';

const run = (db, model, id, label) => models[model].form.buttons.find((b) => b.label === label).run(db, read(db, model, id)).db;

test('salary rules: net = gross − social insurance − tax', () => {
  const lines = Object.fromEntries(computeLines(1000).map((l) => [l.code, l.amount]));
  assert.deepEqual(lines, { BASIC: 1000, ALW: 100, GROSS: 1100, SI: -110, TAX: -99, NET: 891 });
});

test('a payroll batch generates, confirms and pays every employee with balanced entries', () => {
  const base = seed();
  const { db: withBatch, id } = create(base, 'hr.payslip.run', {});
  let db = run(withBatch, 'hr.payslip.run', id, 'Generate Payslips');
  const slips = search(db, 'hr.payslip').filter((p) => p.run_id === id);
  assert.equal(slips.length, search(db, 'hr.employee').length);
  db = run(db, 'hr.payslip.run', id, 'Confirm All');
  db = run(db, 'hr.payslip.run', id, 'Pay All');
  assert.ok(search(db, 'hr.payslip').filter((p) => p.run_id === id).every((p) => p.state === 'paid'));
  for (const m of search(db, 'account.move').filter((x) => x.state === 'posted')) assert.ok(isBalanced(m.line_ids), m.name);
  const gross = slips.reduce((s, p) => s + p.gross_wage, 0);
  assert.equal(Math.round(profitAndLoss(db, {}).expense - profitAndLoss(base, {}).expense), Math.round(gross));
  const b = balanceSheet(db);
  assert.equal(Math.round(b.totalAssets * 100), Math.round((b.totalLiabilities + b.totalEquity) * 100));
});

test('running contracts drive wage and structure; custom rules and accounts are honoured', () => {
  const db0 = seed();
  const interns = db0.records['hr.payroll.structure'].find((s) => s.name === 'Interns');
  const { db: withContract } = create(db0, 'hr.contract', { name: 'Intern', employee_id: 6, structure_id: interns.id, wage: 2000, state: 'running', date_start: '2000-01-01' });
  const { db: withSlip, id } = create(withContract, 'hr.payslip', { employee_id: 6 });
  const slip = read(run(withSlip, 'hr.payslip', id, 'Compute Sheet'), 'hr.payslip', id);
  assert.deepEqual(slip.line_ids.map((l) => [l.code, l.amount]), [['BASIC', 2000], ['TRANS', 300], ['GROSS', 2300], ['NET', 2300]]);
  const done = run(withSlip, 'hr.payslip', id, 'Confirm');
  assert.ok(search(done, 'account.move').filter((m) => m.state === 'posted').every((m) => isBalanced(m.line_ids)));
  const contractSlip = create(seed(), 'hr.payslip', { employee_id: 2 });
  const s2 = read(run(contractSlip.db, 'hr.payslip', contractSlip.id, 'Compute Sheet'), 'hr.payslip', contractSlip.id);
  assert.equal(s2.basic_wage, 6000); // contract wage wins over employee wage
});
