import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, write } from './orm.js';
import { seed } from './seed.js';
import { applyDiff, diffDb } from './sync.js';
import { createSheet } from './models/expenseplus.js';

const clerk = { isAdmin: false, author: 'Clerk' };

test('a change spanning models is validated against the whole change, not half of it', () => {
  // "Create Report" writes the expense (hr.expense) and its new report (hr.expense.sheet) together; the expense
  // guard needs the report, which the server used to apply only after checking the expense.
  const made = create(seed(), 'hr.expense', { name: 'Taxi', employee_id: 2, total_amount: 10, tax: 0 });
  const report = createSheet(made.db, [made.id], { name: 'June' });
  const saved = applyDiff(made.db, diffDb(made.db, report.db), clerk);
  assert.equal(read(saved, 'hr.expense', made.id).sheet_id, report.id);
  assert.equal(read(saved, 'hr.expense.sheet', report.id).expense_line_ids.length, 1);
});

test('guards still see the stored record as "before", and still refuse invalid results', () => {
  const made = create(seed(), 'hr.expense', { name: 'Taxi', employee_id: 2, total_amount: 10, tax: 0 });
  const report = createSheet(made.db, [made.id], { name: 'June' });
  const saved = applyDiff(made.db, diffDb(made.db, report.db), clerk);
  // Changing a reported expense's amount is refused even when sent together with other records.
  const other = create(saved, 'hr.expense', { name: 'Lunch', employee_id: 2, total_amount: 5, tax: 0 }).db;
  const tampered = write(other, 'hr.expense', made.id, { name: 'Taxi' });
  const raw = diffDb(saved, tampered);
  raw.upserts['hr.expense'] = raw.upserts['hr.expense'].map((r) => (r.id === made.id ? { ...r, total_amount: 999 } : r));
  assert.throws(() => applyDiff(saved, raw, clerk), /cannot be changed/);
});
