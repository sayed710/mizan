import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDiff, diffDb } from './sync.js';
import { create, read, write } from './orm.js';
import { seed } from './seed.js';
import { models } from './models/index.js';
import { postMove } from './models/accounting.js';
import { approveSheet, createSheet, postSheet, submitSheet } from './models/expenseplus.js';

test('Revalue Foreign Currency form action saves both generated entries through diff and sync', () => {
  const currency = create(seed(), 'res.currency', {
    name: 'Q13-FX', rate_ids: [{ date: '2026-01-01', rate: 2 }, { date: '2026-02-01', rate: 1 }],
  });
  const invoice = create(currency.db, 'account.move', {
    move_type: 'out_invoice', partner_id: 1, currency_id: currency.id, invoice_date: '2026-01-15',
    invoice_line_ids: [{ name: 'Foreign currency receivable', qty: 1, price_unit: 100, tax: 0 }],
  });
  const posted = postMove(invoice.db, invoice.id);
  const year = create(posted, 'account.fiscal.year', { name: 'FY 2026 Q13', date_from: '2026-01-01', date_to: '2026-12-31' });
  const base = year.db;
  const yearRecord = read(base, 'account.fiscal.year', year.id);
  const button = models['account.fiscal.year'].form.buttons.find((item) => item.label === 'Revalue Foreign Currency');
  assert.ok(button);

  const next = button.run(base, yearRecord, ['2026-02-28']).db;
  const diff = diffDb(base, next);
  const createdIds = diff.created['account.move'];
  assert.equal(createdIds.length, 2);
  const createdMoves = createdIds.map((id) => read(next, 'account.move', id));
  const adjustments = createdMoves.filter((move) => move.revaluation_date === '2026-02-28');
  assert.equal(adjustments.length, 1);
  const adjustment = adjustments[0];
  const reversals = createdMoves.filter((move) => move.reversed_entry_id === adjustment.id);
  assert.equal(reversals.length, 1);
  const reversal = reversals[0];
  assert.equal(adjustment.reversal_move_id, reversal.id);

  const saved = applyDiff(base, diff);
  assert.equal(read(saved, 'account.move', adjustment.id).system_generated, true);
  assert.equal(read(saved, 'account.move', reversal.id).system_generated, true);
  assert.equal(read(saved, 'account.move', adjustment.id).reversal_move_id, reversal.id);
  assert.equal(read(saved, 'account.move', reversal.id).reversed_entry_id, adjustment.id);

  const forged = structuredClone(diff);
  forged.upserts['account.move'] = forged.upserts['account.move'].map((move) => (
    move.id === adjustment.id ? { ...move, line_ids: [] } : move
  ));
  assert.throws(() => applyDiff(base, forged), /System-generated status can only come from a generated accounting workflow/);
});

test('expense journal selector and posting allow only company general or purchase journals', () => {
  const initial = seed();
  const bank = create(initial, 'account.journal', { name: 'Q13 Expense Bank', code: 'Q13B', type: 'bank', company_id: 1 });
  const sales = create(bank.db, 'account.journal', { name: 'Q13 Expense Sales', code: 'Q13S', type: 'sale', company_id: 1 });
  const expense = create(sales.db, 'hr.expense', {
    name: 'Employee travel', employee_id: 2, company_id: 1, date: '2026-06-01', total_amount: 100,
    tax: 0, payment_mode: 'own_account',
  });
  const report = createSheet(expense.db, [expense.id]);
  const base = report.db;
  const reportRecord = read(base, 'hr.expense.sheet', report.id);
  const journalField = models['hr.expense.sheet'].fields.expense_journal_id;
  const company = read(base, 'res.company', 1);
  assert.equal(journalField.domain(read(base, 'account.journal', company.default_general_journal_id), reportRecord), true);
  assert.equal(journalField.domain(read(base, 'account.journal', company.default_purchase_journal_id), reportRecord), true);
  assert.equal(journalField.domain(read(base, 'account.journal', bank.id), reportRecord), false);
  assert.equal(journalField.domain(read(base, 'account.journal', sales.id), reportRecord), false);

  // Simulate an out-of-form value arriving at the server, then post that saved report.
  const selected = write(base, 'hr.expense.sheet', report.id, { expense_journal_id: bank.id });
  const saved = applyDiff(base, diffDb(base, selected));
  const submitted = submitSheet(saved, report.id);
  const managerId = read(submitted, 'hr.expense.sheet', report.id).manager_id;
  const approved = approveSheet(submitted, report.id, managerId);
  assert.throws(() => postSheet(approved, report.id, '2026-06-01'), /general or purchase expense journal/i);
});
