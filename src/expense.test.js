import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { models } from './models/index.js';
import { accountId, isBalanced } from './models/ledger.js';
import { seed } from './seed.js';
import { createCompany } from './models/company.js';

const run = (db, id, label) => models['hr.expense'].form.buttons.find((b) => b.label === label).run(db, read(db, 'hr.expense', id)).db;
test('selecting a taxable product carries its tax through posting and rejects multiple taxes', () => {
  let db = seed();
  const payable = accountId(db, '230100');
  db = write(db, 'account.account', payable, { account_type: 'liability_payable', company_id: 1 });
  db = write(db, 'res.company', 1, { account_default_payable_id: payable });
  const taxes = search(db, 'account.tax').filter((t) => t.type_tax_use === 'purchase' && t.amount_type === 'percent' && t.active !== false && (!t.company_id || t.company_id === 1));
  const tax = taxes.find((t) => t.amount === 14);
  const product = create(db, 'product', { name: 'Taxable expense', type: 'service', cost: 100, supplier_taxes_id: [tax.id], property_account_expense_id: accountId(db, '610000') });
  db = product.db;
  const values = models['hr.expense'].onchange({ product_id: product.id, quantity: 1 }, 'product_id', db);
  assert.equal(values.tax_id, tax.id);
  const expense = create(db, 'hr.expense', { ...values, product_id: product.id, state: 'approved' });
  db = run(expense.db, expense.id, 'Post Journal Entries');
  const move = read(db, 'account.move', read(db, 'hr.expense', expense.id).move_id);
  assert.ok(isBalanced(move.line_ids));
  assert.ok(move.line_ids.some((line) => line.tax_id === tax.id));
  const other = taxes.find((t) => t.id !== tax.id);
  assert.ok(other);
  db = write(db, 'product', product.id, { supplier_taxes_id: [tax.id, other.id] });
  assert.equal(models['hr.expense'].onchange({ product_id: product.id }, 'product_id', db).tax_id, null);
  assert.match(models['hr.expense'].guard(db, { state: 'draft' }, { state: 'submitted', product_id: product.id }), /multiple product taxes/);
});
const flow = (vals) => {
  let base = seed();
  const payable = accountId(base, '230100');
  base = write(base, 'account.account', payable, { account_type: 'liability_payable', company_id: 1 });
  base = write(base, 'res.company', 1, { account_default_payable_id: payable });
  const product = create(base, 'product', { name: 'Taxi expense', type: 'service', property_account_expense_id: accountId(base, '610000') });
  const tax = search(product.db, 'account.tax').find((tax) => tax.type_tax_use === 'purchase' && tax.amount === 14);
  const { db, id } = create(product.db, 'hr.expense', { name: 'Taxi', state: 'approved', category: 'travel', product_id: product.id, tax_id: tax.id, total_amount: 114, tax: 14, ...vals });
  return { db: run(db, id, 'Post Journal Entries'), id };
};

test('an employee-paid expense posts net + VAT against the employee, then is reimbursed', () => {
  const { db, id } = flow({});
  const exp = read(db, 'hr.expense', id);
  assert.equal(exp.state, 'posted');
  const move = read(db, 'account.move', exp.move_id);
  assert.ok(isBalanced(move.line_ids));
  const by = (code) => move.line_ids.find((l) => l.account_id === accountId(db, code));
  assert.equal(by('610000').debit, 100);
  assert.equal(by('131000').debit, 14);
  assert.equal(by('230100').credit, 114);
  assert.equal(read(run(db, id, 'Register Payment'), 'hr.expense', id).state, 'paid');
});

test('a company-paid expense is paid straight from the bank', () => {
  const { db, id } = flow({ payment_mode: 'company_account', tax: 0, total_amount: 50 });
  const exp = read(db, 'hr.expense', id);
  assert.equal(exp.state, 'paid');
  assert.equal(read(db, 'account.move', exp.move_id).line_ids.find((l) => l.credit).account_id, accountId(db, '101401'));
});

test('quantity × unit price with tax included gives the total', () => {
  const vals = models['hr.expense'].onchange({ quantity: 3, unit_amount: 10, tax: 14 }, 'quantity', seed());
  assert.equal(vals.total_amount, 34.2);
});

test('editing an expense retains the selected tax price-inclusion configuration', () => {
  let db = seed();
  const tax = search(db, 'account.tax').find((t) => t.type_tax_use === 'purchase' && t.amount === 14);
  db = write(db, 'account.tax', tax.id, { price_include_override: 'tax_included' });
  const product = create(db, 'product', { name: 'Included expense', type: 'service', cost: 100, supplier_taxes_id: [tax.id] });
  db = product.db;
  const selected = models['hr.expense'].onchange({ product_id: product.id, quantity: 1 }, 'product_id', db);
  assert.equal(selected.total_amount, 100);
  const expense = { ...selected, product_id: product.id, quantity: 2 };
  assert.equal(models['hr.expense'].onchange(expense, 'quantity', db).total_amount, 200);
  assert.equal(models['hr.expense'].onchange({ ...expense, unit_amount: 150 }, 'unit_amount', db).total_amount, 300);
});

test('multiple product taxes are rejected at approval and posting', () => {
  let db = seed();
  const taxes = search(db, 'account.tax').filter((t) => t.type_tax_use === 'purchase' && t.active !== false && (!t.company_id || t.company_id === 1));
  const product = create(db, 'product', { name: 'Multiple taxes', type: 'service', cost: 100, supplier_taxes_id: taxes.slice(0, 2).map((t) => t.id) });
  db = product.db;
  const error = /Expenses do not support multiple product taxes/;
  assert.throws(() => create(db, 'hr.expense', { name: 'Direct approval', product_id: product.id, state: 'approved' }), error);
  const submitted = create(db, 'hr.expense', { name: 'Changed product', state: 'submitted' });
  assert.throws(() => write(submitted.db, 'hr.expense', submitted.id, { product_id: product.id, state: 'approved' }), error);
  const approved = create(db, 'hr.expense', { name: 'Product changed later', state: 'approved', total_amount: 114, tax: 14 });
  const modified = write(approved.db, 'product', product.id, { supplier_taxes_id: [] });
  const expense = write(modified, 'hr.expense', approved.id, { product_id: product.id });
  const changedTax = write(expense, 'product', product.id, { supplier_taxes_id: taxes.slice(0, 2).map((t) => t.id) });
  assert.throws(() => run(changedTax, approved.id, 'Post Journal Entries'), error);
});

test('the multi-tax check uses the employee company when the expense has none', () => {
  let db = seed();
  const second = createCompany(db, { name: 'Expense branch' });
  db = second.db;
  const expenseAccount = create(db, 'account.account', { name: 'Branch expenses', code: '699901', account_type: 'expense', company_id: second.id });
  const journal = create(expenseAccount.db, 'account.journal', { name: 'Branch expenses', code: 'BEXP', type: 'purchase', company_id: second.id, default_account_id: expenseAccount.id });
  db = write(journal.db, 'res.company', second.id, { default_purchase_journal_id: journal.id });
  const c1Taxes = [];
  for (const amount of [10, 4]) {
    const tax = create(db, 'account.tax', { name: `Main purchase ${amount}%`, amount, amount_type: 'percent', type_tax_use: 'purchase', company_id: 1 });
    db = tax.db;
    c1Taxes.push(read(db, 'account.tax', tax.id));
  }
  const c2Tax = create(db, 'account.tax', { name: 'Branch purchase 5%', amount: 5, amount_type: 'percent', type_tax_use: 'purchase', company_id: second.id });
  db = c2Tax.db;
  const product = create(db, 'product', { name: 'Branch expense', type: 'service', cost: 100, supplier_taxes_id: [...c1Taxes.map((t) => t.id), c2Tax.id] });
  const emp = create(product.db, 'hr.employee', { name: 'Branch employee', company_id: second.id });
  db = emp.db;
  const expense = { name: 'Branch approval', product_id: product.id, employee_id: emp.id, company_id: null, state: 'approved' };
  assert.ok(!models['hr.expense'].guard(db, null, expense));
  assert.match(models['hr.expense'].guard(db, null, { ...expense, employee_id: null }) ?? '', /multiple product taxes/);
  const selected = models['hr.expense'].onchange({ ...expense, quantity: 1 }, 'product_id', db);
  assert.equal(selected.tax_id, c2Tax.id);
  const created = create(db, 'hr.expense', { ...expense, ...selected, state: 'draft' });
  db = write(created.db, 'hr.expense', created.id, { state: 'submitted' });
  db = write(db, 'hr.expense', created.id, { state: 'approved' });
  db = run(db, created.id, 'Post Journal Entries');
  const posted = read(db, 'hr.expense', created.id);
  const move = read(db, 'account.move', posted.move_id);
  assert.equal(posted.state, 'posted');
  assert.equal(move.company_id, second.id);
  assert.ok(isBalanced(move.line_ids));
  assert.ok(move.line_ids.some((line) => line.tax_id === c2Tax.id));
});
