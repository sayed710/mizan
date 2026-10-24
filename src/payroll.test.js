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
