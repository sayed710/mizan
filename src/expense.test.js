import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { models } from './models/index.js';
import { accountId, isBalanced } from './models/ledger.js';
import { seed } from './seed.js';

const run = (db, id, label) => models['hr.expense'].form.buttons.find((b) => b.label === label).run(db, read(db, 'hr.expense', id)).db;
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
