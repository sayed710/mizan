import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, write } from './orm.js';
import { seed } from './seed.js';
import { applyDiff, diffDb } from './sync.js';
import { approveSheet, createSheet, postSheet, registerPayment, submitSheet } from './models/expenseplus.js';

const save = (before, after) => applyDiff(before, diffDb(before, after), { isAdmin: false, login: 'mona', author: 'mona' });

function approvedReport() {
  const db = write(seed(), 'hr.employee', 2, { user_login: 'mona' });
  const expense = create(db, 'hr.expense', { name: 'Travel', employee_id: 3, total_amount: 100, tax: 0, payment_mode: 'own_account' });
  const sheet = createSheet(expense.db, [expense.id]);
  return { db: approveSheet(submitSheet(sheet.db, sheet.id), sheet.id, 2), id: sheet.id };
}

test('Qodo 2: expense posting rejects offsetting tagged journal lines', () => {
  const { db, id } = approvedReport();
  const account = create(db, 'account.account', { name: 'Other', code: '999812', account_type: 'expense', company_id: 1 });
  const tag = create(account.db, 'account.account.tag', { name: 'Injected grid' });
  const posted = postSheet(tag.db, id, '2026-10-01');
  const entry = read(posted, 'account.move', read(posted, 'hr.expense.sheet', id).move_id);
  const diff = diffDb(tag.db, posted);
  const forged = { ...entry, line_ids: [...entry.line_ids,
    { account_id: account.id, debit: 25, credit: 0, tax_side: 'purchase', tax_grid_base: true, tax_tag_ids: [tag.id] },
    { account_id: account.id, debit: 0, credit: 25 },
  ] };
  diff.upserts['account.move'] = diff.upserts['account.move'].map((move) => move.id === entry.id ? forged : move);
  assert.throws(() => applyDiff(tag.db, diff, { isAdmin: false, login: 'mona' }), /expense.*(accounts|lines)/i);
});

test('Qodo 2: reimbursement rejects additions to the original posted entry', () => {
  const { db, id } = approvedReport();
  const stored = save(db, postSheet(db, id, '2026-10-01'));
  const paid = registerPayment(stored, id, 100, '2026-10-02');
  const entry = read(paid, 'account.move', read(paid, 'hr.expense.sheet', id).move_id);
  const diff = diffDb(stored, paid);
  const forged = { ...entry, line_ids: [...entry.line_ids,
    { account_id: entry.line_ids[0].account_id, debit: 10, credit: 0 },
    { account_id: entry.line_ids[0].account_id, debit: 0, credit: 10 },
  ] };
  diff.upserts['account.move'].push(forged);
  assert.throws(() => applyDiff(stored, diff, { isAdmin: false, login: 'mona' }), /posted|expense/i);
});

test('Qodo 2: same-account reverse charge survives posting and later configuration changes', () => {
  let db = write(seed(), 'hr.employee', 2, { user_login: 'mona' });
  const account = create(db, 'account.account', { name: 'Reverse charge', code: '999813', account_type: 'expense', company_id: 1 });
  const rows = [
    { repartition_type: 'base', factor_percent: 100, tag_ids: [] },
    { repartition_type: 'tax', factor_percent: 100, account_id: account.id, tag_ids: [] },
    { repartition_type: 'tax', factor_percent: -100, account_id: account.id, tag_ids: [] },
  ];
  const tax = create(account.db, 'account.tax', { name: 'Reverse charge', type_tax_use: 'purchase', amount: 20, amount_type: 'percent', invoice_repartition_line_ids: rows, refund_repartition_line_ids: rows, company_id: 1 });
  const expense = create(tax.db, 'hr.expense', { name: 'Service', employee_id: 3, total_amount: 100, tax: 20, tax_id: tax.id, payment_mode: 'own_account' });
  const sheet = createSheet(expense.db, [expense.id]);
  db = approveSheet(submitSheet(sheet.db, sheet.id), sheet.id, 2);
  const stored = save(db, postSheet(db, sheet.id, '2026-10-01'));
  const entry = read(stored, 'account.move', read(stored, 'hr.expense.sheet', sheet.id).move_id);
  assert.equal(entry.line_ids.filter((line) => line.account_id === account.id).length, 2);
  const changed = write(stored, 'account.tax', tax.id, { amount: 10 });
  assert.equal(read(save(changed, registerPayment(changed, sheet.id, 100, '2026-10-02')), 'hr.expense.sheet', sheet.id).state, 'done');
});
