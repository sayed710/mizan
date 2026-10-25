import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from './orm.js';
import { models } from './models/index.js';
import { computeLines, DEFAULT_RULES, workedDays } from './models/payroll.js';
import { balanceSheet, isBalanced, profitAndLoss } from './models/ledger.js';
import { seed } from './seed.js';

const run = (db, model, id, label) => models[model].form.buttons.find((b) => b.label === label).run(db, read(db, model, id)).db;

test('salary rules: net = gross − social insurance − tax', () => {
  const lines = Object.fromEntries(computeLines(1000).map((l) => [l.code, l.amount]));
  assert.deepEqual(lines, { BASIC: 1000, ALW: 100, GROSS: 1100, SI: -110, TAX: -99, NET: 891 });
});

test('default structure keeps the existing wage-based rules', () => {
  assert.equal(DEFAULT_RULES[0].amount_type, 'wage');
  assert.deepEqual(models['hr.payroll.structure'].defaults().rules, DEFAULT_RULES);
  assert.equal(models['hr.contract'].defaults().work_days, '0,1,2,3,4');
  assert.deepEqual(computeLines(1000).map((line) => [line.code, line.amount]), [
    ['BASIC', 1000], ['ALW', 100], ['GROSS', 1100], ['SI', -110], ['TAX', -99], ['NET', 891],
  ]);
});

test('worked days follow a Sun–Thu contract schedule and count validated unpaid leave', () => {
  const base = seed();
  const { db: withContract } = create(base, 'hr.contract', {
    name: 'Sun–Thu Contract', employee_id: 1, wage: 5000, state: 'running', date_start: '2000-01-01', work_days: '0,1,2,3,4',
  });
  const { db: withLeave } = create(withContract, 'hr.leave', {
    name: 'Unpaid Leave', employee_id: 1, leave_type: 'unpaid', date_from: '2026-10-26', date_to: '2026-10-27', state: 'validate',
  });
  const { db: withAttendance } = create(withLeave, 'hr.attendance', {
    employee_id: 1, date: '2026-10-26', check_in: '09:00', check_out: '19:00',
  });
  const { db } = create(withAttendance, 'hr.attendance', {
    employee_id: 1, date: '2026-10-30', check_in: '09:00', check_out: '20:00',
  });

  assert.deepEqual(workedDays(db, { employee_id: 1, date_from: '2026-10-25', date_to: '2026-10-29' }), {
    working_days: 5, worked_days: 3, unpaid_days: 2, overtime_hours: 2,
  });
});

test('prorata rules pay the wage for the worked share of scheduled days', () => {
  const lines = computeLines(3000, [{ sequence: 1, code: 'BASIC', name: 'Basic', category: 'basic', amount_type: 'prorata' }], {
    worked: { working_days: 5, worked_days: 4 },
  });
  assert.deepEqual(lines.map((line) => line.amount), [2400]);
});

test('input rules sum slip inputs with the matching code', () => {
  const lines = computeLines(3000, [{ sequence: 1, code: 'BONUS', name: 'Bonus', category: 'allowance', amount_type: 'input', base: 'BONUS' }], {
    inputs: [{ code: 'BONUS', amount: 125 }, { code: 'BONUS', amount: 75 }, { code: 'OTHER', amount: 500 }],
  });
  assert.deepEqual(lines.map((line) => line.amount), [200]);
});

test('overtime rules apply the wage hourly rate and multiplier', () => {
  const lines = computeLines(4000, [{ sequence: 1, code: 'OT', name: 'Overtime', category: 'allowance', amount_type: 'overtime', value: 1.5 }], {
    worked: { working_days: 20, worked_days: 20, overtime_hours: 10 },
  });
  assert.deepEqual(lines.map((line) => line.amount), [375]);
});

test('bracket rules calculate progressive annual tax and return the monthly deduction', () => {
  const lines = computeLines(5000, [
    { sequence: 1, code: 'BASE', name: 'Tax Base', category: 'basic', amount_type: 'fixed', value: 5000 },
    { sequence: 2, code: 'TAX', name: 'Tax', category: 'deduction', amount_type: 'brackets', base: 'BASE', brackets: '0-40000:0;40000-55000:10;55000-70000:15;70000-:20' },
  ]);
  assert.deepEqual(lines.map((line) => line.amount), [5000, -187.5]);
});

test('payslip compute passes worked days and inputs to the new salary rule types', () => {
  const rules = [
    { sequence: 1, code: 'BASIC', name: 'Basic', category: 'basic', amount_type: 'prorata' },
    { sequence: 2, code: 'BONUS', name: 'Bonus', category: 'allowance', amount_type: 'input', base: 'BONUS' },
    { sequence: 3, code: 'OT', name: 'Overtime', category: 'allowance', amount_type: 'overtime', value: 1.5 },
    { sequence: 4, code: 'GROSS', name: 'Gross', category: 'gross', amount_type: 'wage' },
    { sequence: 5, code: 'TAX', name: 'Tax', category: 'deduction', amount_type: 'brackets', base: 'GROSS', brackets: '0-40000:0;40000-55000:10;55000-70000:15;70000-:20', account: '250100' },
    { sequence: 6, code: 'NET', name: 'Net', category: 'net', amount_type: 'wage' },
  ];
  const base = seed();
  const { db: withStructure, id: structureId } = create(base, 'hr.payroll.structure', { name: 'Parity Structure', rules });
  const { db: withContract } = create(withStructure, 'hr.contract', {
    name: 'Parity Contract', employee_id: 1, structure_id: structureId, wage: 5000, state: 'running', date_start: '2000-01-01', work_days: '0,1,2,3,4',
  });
  const { db: withLeave } = create(withContract, 'hr.leave', {
    name: 'Unpaid Day', employee_id: 1, leave_type: 'unpaid', date_from: '2026-10-27', date_to: '2026-10-27', state: 'validate',
  });
  const { db: withAttendance } = create(withLeave, 'hr.attendance', {
    employee_id: 1, date: '2026-10-29', check_in: '09:00', check_out: '19:00',
  });
  const { db: withSlip, id } = create(withAttendance, 'hr.payslip', {
    employee_id: 1, date_from: '2026-10-25', date_to: '2026-10-29', input_line_ids: [{ code: 'BONUS', name: 'Bonus', amount: 200 }],
  });
  const slip = read(run(withSlip, 'hr.payslip', id, 'Compute Sheet'), 'hr.payslip', id);

  assert.deepEqual(slip.line_ids.map((line) => [line.code, line.amount]), [
    ['BASIC', 4000], ['BONUS', 200], ['OT', 375], ['GROSS', 4575], ['TAX', -124.17], ['NET', 4450.83],
  ]);
  assert.deepEqual(slip.worked_days_ids.map(({ code, days, hours }) => [code, days, hours]), [
    ['WORK100', 4, 32], ['UNPAID', 1, 8], ['OVERTIME', 0, 2],
  ]);
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
