import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write, unlink } from './orm.js';
import { seed } from './seed.js';
import { accountingCompany, assertEntryCompany } from './test-support/accounting-company.js';
import { applyDiff, diffDb } from './sync.js';
import { accountId, isBalanced } from './models/ledger.js';
import { expensePlusModels, createSheet, submitSheet, approveSheet, refuseSheet, postSheet, registerPayment, reinvoiceExpenses, duplicates, expenseAnalysis } from './models/expenseplus.js';

const date = '2026-06-01';
const addExpense = (db, vals = {}) => create(db, 'hr.expense', { name: 'Client travel', employee_id: 2, date, total_amount: 114, tax: 14, ...vals });
const report = (vals = {}) => {
  const made = addExpense(seed(), vals);
  return createSheet(made.db, [made.id], { name: 'June expenses' });
};
const approved = (db, id) => approveSheet(submitSheet(db, id), id, read(db, 'hr.expense.sheet', id).manager_id || 1);
const entry = (db, id) => read(db, 'account.move', read(db, 'hr.expense.sheet', id).move_id);
const accountLines = (db, move) => move.line_ids.map((l) => ({ code: read(db, 'account.account', l.account_id)?.code, debit: l.debit, credit: l.credit, partner: l.partner_id }));

test('expense reports reject empty, missing, non-draft, mixed employee, mixed payer and already reported expenses', () => {
  const a = addExpense(seed());
  const b = addExpense(a.db, { employee_id: 3 });
  assert.throws(() => createSheet(b.db, [], {}), /at least one/);
  assert.throws(() => createSheet(b.db, [99999], {}), /not found/);
  assert.throws(() => createSheet(b.db, [a.id, b.id], {}), /same employee/);
  assert.throws(() => createSheet(write(b.db, 'hr.expense', a.id, { state: 'approved' }), [a.id], {}), /draft/);
  const c = addExpense(b.db, { payment_mode: 'company_account' });
  assert.throws(() => createSheet(c.db, [a.id, c.id], {}), /agree/);
  const made = createSheet(b.db, [a.id, a.id], { name: 'Travel' });
  assert.throws(() => createSheet(made.db, [a.id], {}), /another report/);
  assert.equal(read(b.db, 'hr.expense', a.id).sheet_id, undefined);
  assert.equal(read(made.db, 'hr.expense', a.id).sheet_id, made.id);
  assert.equal(read(made.db, 'hr.expense.sheet', made.id).expense_line_ids.length, 1);
  assert.equal(read(made.db, 'hr.expense.sheet', made.id).total_amount, 114);
  assert.equal(read(made.db, 'hr.expense.sheet', made.id).manager_id, read(b.db, 'hr.employee', 2).parent_id);
});

test('only the assigned manager approves, or any existing employee if no manager is assigned', () => {
  const { db, id } = report();
  assert.throws(() => approveSheet(db, id, 1), /status/);
  assert.throws(() => postSheet(db, id, date), /status/);
  const submitted = submitSheet(db, id);
  const manager = read(submitted, 'hr.expense.sheet', id).manager_id;
  assert.throws(() => approveSheet(submitted, id, manager === 2 ? 3 : 2), /manager/);
  assert.throws(() => approveSheet(submitted, id, 99999), /approver/);
  const next = approveSheet(submitted, id, manager);
  assert.equal(read(next, 'hr.expense.sheet', id).state, 'approve');
  assert.equal(search(next, 'hr.expense').find((r) => r.sheet_id === id).state, 'approved');
  const unmanaged = write(submitted, 'hr.expense.sheet', id, { manager_id: null });
  assert.equal(read(approveSheet(unmanaged, id, 3), 'hr.expense.sheet', id).state, 'approve');
  assert.throws(() => approveSheet(next, id, manager), /status/);
});

test('refusal records a reason and note, resets lines, permits resubmission; reset cannot undo posting', () => {
  const { db, id } = report();
  const accepted = approved(db, id);
  assert.throws(() => refuseSheet(accepted, id, '  '), /reason/);
  const refused = refuseSheet(accepted, id, ' Missing receipt ');
  assert.equal(read(refused, 'hr.expense.sheet', id).state, 'draft');
  assert.equal(read(refused, 'hr.expense.sheet', id).refuse_reason, 'Missing receipt');
  assert.ok(search(refused, 'hr.expense').filter((r) => r.sheet_id === id).every((r) => r.state === 'draft'));
  assert.ok(refused.messages.some((m) => m.model === 'hr.expense.sheet' && m.res_id === id && m.body.includes('Missing receipt')));
  const submitted = submitSheet(refused, id);
  assert.equal(read(submitted, 'hr.expense.sheet', id).refuse_reason, '');
  const reset = expensePlusModels['hr.expense.sheet'].form.buttons.find((b) => b.label === 'Reset to Draft');
  assert.equal(read(reset.run(submitted, read(submitted, 'hr.expense.sheet', id)).db, 'hr.expense.sheet', id).state, 'draft');
  const posted = postSheet(accepted, id, date);
  assert.throws(() => reset.run(posted, read(posted, 'hr.expense.sheet', id)), /status|not available/);
  assert.throws(() => refuseSheet(posted, id, 'Too late'), /status/);
});

test('employee-paid posting splits included tax, honors product accounts, resolves employee contact and stays immutable', () => {
  const original = seed();
  const custom = write(original, 'product', 1, { property_account_expense_id: accountId(original, '610000') });
  const a = addExpense(custom, { product_id: 1 });
  const b = addExpense(a.db, { name: 'Supplies', total_amount: 50, tax: 0, category: 'office' });
  const made = createSheet(b.db, [a.id, b.id], {});
  const accepted = approved(made.db, made.id);
  const before = JSON.stringify(accepted);
  const count = search(accepted, 'account.move').length;
  const posted = postSheet(accepted, made.id, date);
  assert.equal(JSON.stringify(accepted), before);
  assert.equal(search(posted, 'account.move').length, count + 1);
  const move = entry(posted, made.id);
  assert.ok(isBalanced(move.line_ids));
  const lines = accountLines(posted, move);
  assert.deepEqual(lines.map((l) => [l.code, l.debit, l.credit]), [['610000', 100, 0], ['131000', 14, 0], ['600000', 50, 0], ['211000', 0, 164]]);
  const person = read(posted, 'hr.employee', 2);
  assert.equal(read(posted, 'res.partner', lines.at(-1).partner).email, person.work_email);
  assert.equal(move.invoice_date, date);
  assert.equal(read(posted, 'hr.expense.sheet', made.id).state, 'post');
  assert.equal(read(posted, 'hr.expense', a.id).move_id, move.id);
  assert.throws(() => postSheet(posted, made.id, date), /status/);
  assert.throws(() => write(posted, 'hr.expense', a.id, { total_amount: 999 }), /cannot be changed/);
  assert.throws(() => unlink(posted, 'hr.expense', [a.id]), /cannot be deleted/);
  assert.throws(() => unlink(posted, 'hr.expense.sheet', [made.id]), /cannot be deleted/);
});

test('company-paid report credits the bank and completes immediately without reimbursement', () => {
  const { db, id } = report({ payment_mode: 'company_account' });
  const posted = postSheet(approved(db, id), id, date);
  const move = entry(posted, id);
  assert.ok(isBalanced(move.line_ids));
  assert.deepEqual(accountLines(posted, move).map((l) => [l.code, l.debit, l.credit]), [['600000', 100, 0], ['131000', 14, 0], ['101401', 0, 114]]);
  assert.equal(read(posted, 'hr.expense.sheet', id).state, 'done');
  assert.equal(search(posted, 'hr.expense').find((r) => r.sheet_id === id).state, 'paid');
  assert.throws(() => registerPayment(posted, id, 114, date), /status/);
});

test('expense report posting and reimbursement use the report company accounts and journals', () => {
  const branch = accountingCompany(seed());
  const expense = addExpense(branch.db, { company_id: branch.id });
  const other = addExpense(expense.db, { company_id: 1 });
  assert.throws(() => createSheet(other.db, [expense.id, other.id]), /same company/);
  const report = createSheet(other.db, [expense.id]);
  assert.equal(read(report.db, 'hr.expense.sheet', report.id).company_id, branch.id);
  const accepted = approved(report.db, report.id);
  const buttons = expensePlusModels['hr.expense.sheet'].form.buttons;
  const post = buttons.find((b) => b.label === 'Post Journal Entries');
  const posted = post.run(accepted, read(accepted, 'hr.expense.sheet', report.id)).db;
  assertEntryCompany(assert, posted, entry(posted, report.id), branch.id);
  const savedPrompt = globalThis.prompt;
  try {
    globalThis.prompt = () => '114';
    const reimburse = buttons.find((b) => b.label === 'Register Payment');
    const paid = reimburse.run(posted, read(posted, 'hr.expense.sheet', report.id)).db;
    const newMoves = paid.records['account.move'].filter((m) => !posted.records['account.move'].some((old) => old.id === m.id));
    assert.equal(newMoves.length, 1);
    assertEntryCompany(assert, paid, newMoves[0], branch.id);
    const savedPost = applyDiff(accepted, diffDb(accepted, posted), { isAdmin: true });
    const saved = applyDiff(savedPost, diffDb(posted, paid), { isAdmin: true });
    assertEntryCompany(assert, saved, read(saved, 'account.move', newMoves[0].id), branch.id);
  } finally { globalThis.prompt = savedPrompt; }
});

test('reimbursement supports partial and full payment, keeps the partner, rejects invalid and excessive amounts', () => {
  const { db, id } = report();
  const posted = postSheet(approved(db, id), id, date);
  for (const amount of [0, -1, NaN, Infinity, 115]) assert.throws(() => registerPayment(posted, id, amount, date), /amount|exceeds/);
  const count = search(posted, 'account.move').length;
  const partial = registerPayment(posted, id, 40, date);
  assert.equal(read(partial, 'hr.expense.sheet', id).state, 'post');
  assert.equal(read(partial, 'hr.expense.sheet', id).amount_paid, 40);
  assert.throws(() => registerPayment(partial, id, 75, date), /exceeds/);
  const paid = registerPayment(partial, id, 74, date);
  assert.equal(read(paid, 'hr.expense.sheet', id).state, 'done');
  assert.equal(read(paid, 'hr.expense.sheet', id).amount_paid, 114);
  const payments = search(paid, 'account.move').slice(count);
  assert.equal(payments.length, 2);
  for (const move of payments) {
    assert.ok(isBalanced(move.line_ids));
    assert.deepEqual(accountLines(paid, move).map((l) => l.code), ['211000', '101401']);
    assert.equal(move.line_ids[0].partner_id, read(paid, 'hr.expense.sheet', id).partner_id);
  }
  assert.throws(() => registerPayment(paid, id, 1, date), /status/);
  assert.equal(read(posted, 'hr.expense.sheet', id).amount_paid, 0);
});

test('re-invoicing appends untaxed cost per unit or product sales price exactly once, preserving existing order lines', () => {
  const order = create(seed(), 'sale.order', { partner_id: 1, order_line: [{ product_id: 2, qty: 1, price_unit: 25, tax: 0 }] });
  const a = addExpense(order.db, { product_id: 1, quantity: 2, sale_order_id: order.id, reinvoice: 'cost' });
  const b = addExpense(a.db, { product_id: 2, quantity: 3, sale_order_id: order.id, reinvoice: 'sales_price' });
  const c = addExpense(b.db, { product_id: 3, sale_order_id: order.id, reinvoice: 'no' });
  const made = createSheet(c.db, [a.id, b.id, c.id], {});
  assert.throws(() => reinvoiceExpenses(made.db, made.id), /status/);
  const posted = postSheet(approved(made.db, made.id), made.id, date);
  const next = reinvoiceExpenses(posted, made.id);
  const lines = read(next, 'sale.order', order.id).order_line;
  assert.equal(lines.length, 3);
  assert.deepEqual(lines[0], read(order.db, 'sale.order', order.id).order_line[0]);
  assert.deepEqual([lines[1].product_id, lines[1].qty, lines[1].price_unit], [1, 2, 50]);
  assert.deepEqual([lines[2].product_id, lines[2].qty, lines[2].price_unit], [2, 3, read(next, 'product', 2).list_price]);
  assert.deepEqual(read(reinvoiceExpenses(next, made.id), 'sale.order', order.id).order_line, lines);
  assert.equal(read(next, 'hr.expense', a.id).reinvoiced, true);
  assert.equal(read(next, 'hr.expense', c.id).reinvoiced, false);
});

test('duplicates exclude self and match employee, date and rounded total; onchange preserves pricing and updates warning', () => {
  const a = addExpense(seed());
  const b = addExpense(a.db);
  const c = addExpense(b.db, { employee_id: 3 });
  const d = addExpense(c.db, { date: '2026-06-02' });
  const e = addExpense(d.db, { total_amount: 115 });
  assert.deepEqual(duplicates(e.db, read(e.db, 'hr.expense', a.id)).map((r) => r.id), [b.id]);
  const warned = write(e.db, 'hr.expense', a.id, { notes: 'Receipt attached' });
  assert.match(read(warned, 'hr.expense', a.id).duplicate_warning, /Possible duplicate/);
  const changed = write(warned, 'hr.expense', a.id, { total_amount: 117 });
  assert.equal(read(changed, 'hr.expense', a.id).duplicate_warning, '');
  const model = expensePlusModels['hr.expense'];
  const pricing = model.onchange({ product_id: 1, quantity: 2 }, 'product_id', changed);
  const product = read(changed, 'product', 1);
  assert.equal(pricing.unit_amount, product.cost);
  assert.equal(pricing.total_amount, Math.round(2 * product.cost * (1 + product.purchase_tax / 100) * 100) / 100);
});

test('expense analysis includes date boundaries and reports independent employee and category totals', () => {
  const a = addExpense(seed(), { date: '2001-01-01', category: 'travel', total_amount: 10 });
  const b = addExpense(a.db, { date: '2001-01-02', category: 'meals', total_amount: 20 });
  const c = addExpense(b.db, { date: '2001-01-02', employee_id: 3, category: 'travel', total_amount: 30 });
  const d = addExpense(c.db, { date: '2001-01-03', total_amount: 100 });
  assert.deepEqual(expenseAnalysis(d.db, { from: '2001-01-01', to: '2001-01-02' }), {
    employees: [{ employee_id: 2, total_amount: 30 }, { employee_id: 3, total_amount: 30 }],
    categories: [{ category: 'travel', total_amount: 40 }, { category: 'meals', total_amount: 20 }],
  });
  assert.deepEqual(expenseAnalysis(d.db, { from: '1900-01-01', to: '1900-01-02' }), { employees: [], categories: [] });
});

test('posting reuses an existing work-email contact and invalid amounts or taxes cannot enter a report', () => {
  let db = seed();
  const person = read(db, 'hr.employee', 2);
  const contact = create(db, 'res.partner', { name: person.name, email: person.work_email.toUpperCase() });
  const made = addExpense(contact.db);
  const grouped = createSheet(made.db, [made.id], {});
  const posted = postSheet(approved(grouped.db, grouped.id), grouped.id, date);
  assert.equal(read(posted, 'hr.expense.sheet', grouped.id).partner_id, contact.id);
  assert.equal(search(posted, 'res.partner').length, search(contact.db, 'res.partner').length);
  for (const vals of [{ total_amount: 0 }, { total_amount: -1 }, { total_amount: NaN }, { tax: -1 }, { tax: Infinity }]) {
    const invalid = addExpense(db, vals);
    assert.throws(() => createSheet(invalid.db, [invalid.id], {}), /amounts/);
  }
});

test('report prompts cancel safely and approval and refusal buttons enforce their function rules', () => {
  const made = report();
  const submitted = submitSheet(made.db, made.id);
  const r = read(submitted, 'hr.expense.sheet', made.id);
  const buttons = expensePlusModels['hr.expense.sheet'].form.buttons;
  const oldPrompt = globalThis.prompt;
  try {
    globalThis.prompt = () => null;
    assert.equal(buttons.find((b) => b.label === 'Approve').run(submitted, r).db, submitted);
    assert.equal(buttons.find((b) => b.label === 'Refuse').run(submitted, r).db, submitted);
    globalThis.prompt = () => String(r.manager_id);
    const accepted = buttons.find((b) => b.label === 'Approve').run(submitted, r).db;
    assert.equal(read(accepted, 'hr.expense.sheet', made.id).state, 'approve');
    const posted = postSheet(accepted, made.id, date);
    globalThis.prompt = () => null;
    assert.equal(buttons.find((b) => b.label === 'Register Payment').run(posted, read(posted, 'hr.expense.sheet', made.id)).db, posted);
    globalThis.prompt = () => 'Receipt unclear';
    const refused = buttons.find((b) => b.label === 'Refuse').run(submitted, r).db;
    assert.equal(read(refused, 'hr.expense.sheet', made.id).refuse_reason, 'Receipt unclear');
  } finally {
    if (oldPrompt === undefined) delete globalThis.prompt;
    else globalThis.prompt = oldPrompt;
  }
});

test('seed loads and standalone expense buttons retain the existing posting and reimbursement workflow', () => {
  const base = seed();
  assert.ok(search(base, 'hr.expense').length > 0);
  const made = addExpense(base);
  const buttons = expensePlusModels['hr.expense'].form.buttons;
  let db = made.db;
  for (const label of ['Submit', 'Approve', 'Post Journal Entries', 'Register Payment']) {
    const button = buttons.find((b) => b.label === label);
    const r = read(db, 'hr.expense', made.id);
    assert.ok(button.when(r));
    db = button.run ? button.run(db, r).db : write(db, 'hr.expense', made.id, button.vals);
  }
  assert.equal(read(db, 'hr.expense', made.id).state, 'paid');
  const draft = addExpense(db);
  const created = buttons.find((b) => b.label === 'Create Report').run(draft.db, read(draft.db, 'hr.expense', draft.id));
  assert.equal(read(created.db, 'hr.expense', draft.id).sheet_id, created.id);
  assert.ok(buttons.filter((b) => b.label !== 'Create Report').every((b) => !b.when(read(created.db, 'hr.expense', draft.id))));
});
